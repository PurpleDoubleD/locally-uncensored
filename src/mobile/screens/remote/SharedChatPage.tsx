/**
 * A shared chat of the computer (A17, CHATS-V1.md). Route /remote/shared/:id,
 * strand 6.
 *
 * The chat runs on the computer; this page is a second window onto it: the
 * history (older messages above with "Load earlier messages"), the answer
 * live as it comes, tool cards, approval cards with "Allow once", "Always in
 * this chat" and "Deny", Stop, photos and PDF or text files as attachments.
 * A message written without a connection waits under the thread ("Waiting
 * to send") and goes by itself once the computer is there again.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, FileText, ListTodo, Monitor, Paperclip, Wrench, X } from 'lucide-react'
import { nav, useParams } from '../../nav'
import { pickFiles } from '../../platform/files'
import { attachmentMime, MAX_ATTACHMENT_BYTES, sharesChats, FEATURE_TASKS, type SharedMessage } from '../../remote/sharedChats'
import {
  closeSharedChat,
  decideShared,
  dropOutbox,
  loadOlder,
  modelShown,
  openSharedChat,
  refreshChatModels,
  retryFailedTurn,
  retryOutbox,
  sendShared,
  stopSharedAnswer,
  useSharedChats,
  type ApprovalCard,
  type ChatView,
  type OutboxEntry,
  type ToolCard,
} from '../../remote/sharedChatStore'
import { REMOTE_STRINGS as S } from '../../strings/remote'
import { Button, Composer, EmptyState, Icon, IconButton, Notice, Page, SkeletonRows, Spinner, toast } from '../../ui'
import { Markdown } from '../../ui/Markdown'
import { ConnectionLine } from './parts/ConnectionLine'
import { offerRemoteNotices } from './parts/notices'
import { remote, useRemote } from './parts/session'
import { RemoteVoiceLine, useRemoteVoice } from './parts/RemoteVoice'
import { FEATURE_VOICE } from '../../remote/remoteVoice'
import { remoteModelLabel, stepTitle } from './parts/view'
import './parts/remote.css'

interface PickedAttachment {
  name: string
  mime: string
  bytes: Uint8Array
}

function Files({ files }: { files: ReadonlyArray<{ name: string; mime: string }> }) {
  if (files.length === 0) return null
  return (
    <div className="m-remote-files" data-testid="m-remote-shared-files">
      {files.map((f, i) => (
        <span key={i} className="m-remote-file">
          <Icon icon={FileText} small />
          {S.shared.attachment(f.name || f.mime)}
        </span>
      ))}
    </div>
  )
}

function toolState(state: ToolCard['state']): string {
  return state === 'running' ? S.shared.toolRunning : state === 'done' ? S.shared.toolDone : S.shared.toolFailed
}

function ToolLine({ name, summary, state }: { name: string; summary: string; state: ToolCard['state'] }) {
  if (state === 'running') {
    return (
      <div className="m-remote-msg-foot" data-testid="m-remote-shared-tool" data-m-state={state} data-m-tool={name}>
        <Spinner label={S.shared.toolRunning} />
        <span className="m-grow">
          <strong>{stepTitle({ tool: name })}</strong>
          {summary ? ` ${summary}` : ''}
        </span>
        <span className="m-cap">{toolState(state)}</span>
      </div>
    )
  }
  // Done or failed: one closed line ("Ran: Terminal command" and what it ran), open for the details.
  return (
    <details className="m-remote-step m-remote-tool-line" data-testid="m-remote-shared-tool" data-m-state={state} data-m-tool={name}>
      <summary data-testid="m-remote-shared-tool-head">
        <Icon icon={Wrench} small />
        <span className="m-remote-tool-line-text">
          <strong>{state === 'failed' ? S.shared.toolFailedLine(stepTitle({ tool: name })) : S.shared.toolRan(stepTitle({ tool: name }))}</strong>
          {summary ? <span className="m-remote-tool-line-summary"> {summary}</span> : null}
        </span>
      </summary>
      <div className="m-remote-step-body" data-testid="m-remote-shared-tool-detail">
        <span className="m-remote-step-label">{S.shared.toolName}</span>
        <code>{name}</code>
        {summary ? (
          <>
            <span className="m-remote-step-label">{S.steps.input}</span>
            <pre>{summary}</pre>
          </>
        ) : null}
        <span className={`m-remote-step-state m-remote-step-state--${state}`}>{toolState(state)}</span>
      </div>
    </details>
  )
}

function ToolLines({ tools }: { tools: ReadonlyArray<{ name: string; summary: string; state: ToolCard['state'] }> }) {
  if (tools.length === 0) return null
  return (
    <div className="m-remote-tool-lines">
      {tools.map((t, i) => (
        <ToolLine key={i} name={t.name} summary={t.summary} state={t.state} />
      ))}
    </div>
  )
}

function Approval({ chatId, card }: { chatId: string; card: ApprovalCard }) {
  if (card.state === 'resolved') {
    const said = card.decision === 'chat' ? S.shared.approvedChat : card.decision === 'once' ? S.shared.approvedOnce : S.shared.denied
    return (
      <div className="m-remote-msg-foot" data-testid="m-remote-shared-approval" data-state="resolved" data-m-decision={card.decision}>
        <span className="m-grow">
          <strong>{stepTitle({ tool: card.tool })}</strong> {said}
          {card.by === 'desktop' ? `, ${S.shared.decidedOnDesktop}` : ''}
        </span>
      </div>
    )
  }
  const busy = card.state === 'sending'
  return (
    <div className="m-remote-card" role="group" aria-label={S.shared.approvalTitle(stepTitle({ tool: card.tool }))} data-testid="m-remote-shared-approval" data-state="open">
      <span className="m-remote-card-title">
        <Icon icon={AlertTriangle} small /> {S.shared.approvalTitle(stepTitle({ tool: card.tool }))}
      </span>
      <span className="m-cap">{card.summary || S.shared.approvalText}</span>
      {card.detail ? <pre data-testid="m-remote-shared-approval-detail">{card.detail}</pre> : null}
      {card.error ? (
        <Notice variant="error" testid="m-remote-shared-approval-error">
          {card.error}
        </Notice>
      ) : null}
      <div className="m-remote-card-actions">
        <Button variant="primary" compact busy={busy} onPress={() => void decideShared(chatId, card.approvalId, 'once')} testid="m-remote-shared-allow-once">
          {S.shared.allowOnce}
        </Button>
        <Button compact disabled={busy} onPress={() => void decideShared(chatId, card.approvalId, 'chat')} testid="m-remote-shared-allow-chat">
          {S.shared.allowChat}
        </Button>
        <Button compact variant="danger" risk="destructive" disabled={busy} onPress={() => void decideShared(chatId, card.approvalId, 'deny')} testid="m-remote-shared-deny">
          {S.shared.deny}
        </Button>
      </div>
    </div>
  )
}

function Message({ m }: { m: SharedMessage }) {
  if (m.role === 'tool') return <ToolLines tools={m.tools.length > 0 ? m.tools : m.tool ? [m.tool] : []} />
  if (m.role === 'user') {
    const local = m.id.startsWith('local_')
    return (
      <div className="m-remote-msg m-remote-msg--user" data-testid="m-remote-shared-question" data-m-from={m.from} data-m-id={m.id} aria-label={S.chat.you}>
        <Files files={m.attachments} />
        {m.content ? <div className="m-remote-bubble">{m.content}</div> : null}
        {local ? <span className="m-remote-out" data-testid="m-remote-shared-sending">{S.shared.sending}</span> : null}
        {m.from === 'desktop' ? <span className="m-remote-out">{S.shared.fromDesktop}</span> : null}
      </div>
    )
  }
  return (
    <div className="m-remote-msg" data-testid="m-remote-shared-answer" data-m-id={m.id} aria-label={S.chat.desktop}>
      <ToolLines tools={m.tools} />
      <Files files={m.attachments} />
      {m.content ? <Markdown content={m.content} idPrefix="m-remote" /> : null}
    </div>
  )
}

function Outbox({ entry }: { entry: OutboxEntry }) {
  return (
    <div className="m-remote-msg m-remote-msg--user" data-testid="m-remote-shared-outbox" data-state={entry.state}>
      <Files files={entry.files} />
      {entry.content ? <div className="m-remote-bubble">{entry.content}</div> : null}
      {entry.state === 'failed' ? (
        <Notice
          variant="error"
          title={S.shared.failed}
          testid="m-remote-shared-outbox-error"
          actions={
            <>
              <Button compact onPress={() => retryOutbox(entry.clientId)} testid="m-remote-shared-outbox-retry">
                {S.shared.retry}
              </Button>
              <Button compact variant="quiet" onPress={() => dropOutbox(entry.clientId)} testid="m-remote-shared-outbox-remove">
                {S.shared.remove}
              </Button>
            </>
          }
        >
          {entry.error}
        </Notice>
      ) : (
        <span className="m-remote-out" data-testid="m-remote-shared-outbox-state">
          {entry.state === 'sending' ? S.shared.sending : S.shared.waiting}
        </span>
      )}
    </div>
  )
}

function Thread({ chatId, view, outbox }: { chatId: string; view: ChatView; outbox: OutboxEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const keep = useRef<number | null>(null)
  const last = view.messages.at(-1)
  const signature = `${view.messages.length}:${last?.id ?? ''}:${view.live?.text.length ?? 0}:${view.tools.length}:${view.approvals.length}:${outbox.length}`
  useLayoutEffect(() => {
    const body = ref.current?.closest('.m-body') as HTMLElement | null
    if (!body) return
    if (keep.current !== null) {
      // Older messages came in above: the place the user looked at stays.
      body.scrollTop = body.scrollHeight - keep.current
      keep.current = null
      return
    }
    body.scrollTop = body.scrollHeight
  }, [signature])

  const older = () => {
    const body = ref.current?.closest('.m-body') as HTMLElement | null
    keep.current = body ? body.scrollHeight - body.scrollTop : null
    void loadOlder(chatId)
  }

  // The tools of the turn that runs; with the answer they move into it and stay there.
  const currentTools = view.live || view.busy ? view.tools : []
  if (view.messages.length === 0 && outbox.length === 0 && !view.live) {
    return (
      <EmptyState title={S.chat.emptyTitle} testid="m-remote-shared-empty">
        {S.shared.empty}
      </EmptyState>
    )
  }
  return (
    <div className="m-remote-thread" ref={ref} data-testid="m-remote-shared-thread" data-m-count={view.messages.length}>
      {view.hasOlder ? (
        <Button block variant="quiet" busy={view.loading === 'older'} onPress={older} testid="m-remote-shared-older">
          {view.loading === 'older' ? S.shared.loadingOlder : S.shared.loadOlder}
        </Button>
      ) : null}
      {view.messages.map((m) => (
        <Message key={m.id} m={m} />
      ))}
      <ToolLines tools={currentTools} />
      {view.approvals
        .filter((a) => a.state !== 'resolved' || view.busy)
        .map((a) => (
          <Approval key={a.approvalId} chatId={chatId} card={a} />
        ))}
      {view.live ? (
        <div className="m-remote-msg" data-testid="m-remote-shared-live" aria-live="polite">
          <Markdown content={view.live.text} idPrefix="m-remote" />
        </div>
      ) : view.waiting ? (
        <div className="m-remote-working" role="status" data-testid="m-remote-shared-waiting">
          <Spinner label={S.shared.waitingDesk} />
          <span>{S.shared.waitingDesk}</span>
        </div>
      ) : view.busy && !view.approvals.some((a) => a.state === 'open') ? (
        <div className="m-remote-working" role="status" data-testid="m-remote-shared-working">
          <Spinner label={S.shared.working} />
          <span>{S.shared.working}</span>
        </div>
      ) : null}
      {view.turnError ? (
        <Notice
          variant="error"
          title={S.shared.turnErrorTitle}
          testid="m-remote-shared-turn-error"
          actions={
            view.turnErrorContent ? (
              <Button compact onPress={() => void retryFailedTurn(chatId)} testid="m-remote-shared-turn-retry">
                {S.shared.tryAgain}
              </Button>
            ) : undefined
          }
        >
          {view.turnError}
        </Notice>
      ) : null}
      {outbox.map((e) => (
        <Outbox key={e.clientId} entry={e} />
      ))}
    </div>
  )
}

function Tray({ files, onRemove }: { files: PickedAttachment[]; onRemove: (i: number) => void }) {
  return (
    <div className="m-remote-tray" data-testid="m-remote-shared-tray">
      {files.map((f, i) => (
        <span key={i} className="m-remote-tray-item">
          <span className="m-remote-file">
            <Icon icon={FileText} small />
            {f.name}
          </span>
          <IconButton icon={X} label={S.shared.removeFile(f.name)} onPress={() => onRemove(i)} testid={`m-remote-shared-tray-remove-${i}`} />
        </span>
      ))}
    </div>
  )
}

const EMPTY_OUTBOX: OutboxEntry[] = []

export default function SharedChatPage() {
  const { id } = useParams<{ id: string }>()
  const view = useSharedChats((s) => s.chats[id])
  const summary = useSharedChats((s) => s.list.find((c) => c.id === id))
  const allOutbox = useSharedChats((s) => s.outbox)
  const outbox = allOutbox.some((e) => e.chatId === id) ? allOutbox.filter((e) => e.chatId === id) : EMPTY_OUTBOX
  const features = useRemote((s) => s.features)
  const picked = useSharedChats((s) => s.chatModels[id])
  const modelList = useSharedChats((s) => s.modelList)
  const tags = useRemote((s) => s.models)
  const model = picked ?? (view?.model || summary?.model || '')
  const hydrated = useRemote((s) => s.hydrated)
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<PickedAttachment[]>([])
  const status = useRemote((s) => s.status)
  const lastAnswer = view ? [...view.messages].reverse().find((m) => m.role === 'assistant') : undefined
  // Voice over remote (#212): hold the microphone to talk, tap it for hands free.
  const voice = useRemoteVoice({
    channel: () => remote().desktopChannel(),
    ready: status === 'connected' && sharesChats(features) && features.includes(FEATURE_VOICE) && remote().desktopChannel() !== null,
    send: (text) => sendShared(id, text, []) !== null,
    busy: !!view?.busy,
    lastAnswer: lastAnswer ? { id: lastAnswer.id, text: lastAnswer.content } : null,
  })

  useEffect(() => {
    if (!hydrated) return
    void openSharedChat(id)
    return () => closeSharedChat(id)
  }, [id, hydrated])
  useEffect(() => {
    if (hydrated) void refreshChatModels(tags)
  }, [hydrated, tags])
  // The first shared chat: once "Get notified when your computer is done?" (if pairing did not ask already).
  useEffect(() => {
    if (hydrated) void offerRemoteNotices(nav.confirm)
  }, [hydrated])

  const attach = async () => {
    const picked = await pickFiles({ accept: 'image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown,.md,.txt', multiple: true })
    const next: PickedAttachment[] = []
    for (const p of picked.slice(0, 4)) {
      const bytes = new Uint8Array(await p.file.arrayBuffer())
      const mime = attachmentMime(bytes, p.file.name, p.file.type)
      if (!mime) {
        toast(S.shared.fileTypes, { tone: 'error', testid: 'remote-shared-file-type' })
        continue
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        toast(S.shared.fileTooLarge, { tone: 'error', testid: 'remote-shared-file-large' })
        continue
      }
      next.push({ name: p.file.name || mime, mime, bytes })
    }
    setFiles((list) => [...list, ...next].slice(0, 4))
  }

  const send = () => {
    if (!draft.trim() && files.length === 0) return
    sendShared(id, draft, files)
    setDraft('')
    setFiles([])
  }

  const stop = () => {
    void stopSharedAnswer(id).then((problem) => {
      if (problem) toast(`${S.shared.stopFailed} ${problem}`, { tone: 'error', testid: 'remote-shared-stop-failed' })
    })
  }

  const title = summary?.title ?? S.chat.title
  const busy = !!view?.busy
  return (
    <Page
      title={title}
      subtitle={summary ? S.shared.mode[summary.mode] : undefined}
      screen="remote-shared"
      flush
      bareFooter
      actions={
        sharesChats(features) && features.includes(FEATURE_TASKS) ? (
          <IconButton icon={ListTodo} label={S.shared.menuTasks} onPress={() => nav.openSheet('remote-tasks')} testid="m-remote-shared-tasks" />
        ) : (
          <Icon icon={Monitor} />
        )
      }
      banner={<ConnectionLine />}
      footer={
        <Composer
          value={draft}
          onChange={setDraft}
          label={S.chat.message}
          placeholder={S.shared.placeholder}
          onSend={send}
          running={busy}
          onStop={stop}
          hasAttachment={files.length > 0}
          attachments={files.length > 0 ? <Tray files={files} onRemove={(i) => setFiles((list) => list.filter((_, j) => j !== i))} /> : undefined}
          idPrefix="m-remote-shared"
          testid="m-remote-shared-composer"
          tune={{
            summary: <b>{model ? modelShown(model, modelList, remoteModelLabel) : S.chat.modelNone}</b>,
            label: S.shared.modelName(model ? modelShown(model, modelList, remoteModelLabel) : S.chat.modelNone),
            onPress: () => nav.openSheet('remote-shared-model', { chatId: id }),
            testid: 'm-remote-shared-model',
          }}
          attach={<IconButton icon={Paperclip} label={S.shared.attach} onPress={() => void attach()} risk="sensor" testid="m-remote-shared-attach" />}
          micHold={voice.micHold}
          dictation={voice.dictation}
          replaceField={voice.phase !== 'off' ? <RemoteVoiceLine voice={voice} /> : undefined}
        />
      }
    >
      {!view || (view.loading === 'loading' && view.messages.length === 0) ? (
        <SkeletonRows rows={4} label={S.shared.loading} testid="m-remote-shared-loading" />
      ) : view.loading === 'error' && view.messages.length === 0 ? (
        <Notice
          variant="error"
          testid="m-remote-shared-error"
          actions={
            <Button compact onPress={() => void openSharedChat(id)} testid="m-remote-shared-error-retry">
              {S.shared.tryAgain}
            </Button>
          }
        >
          {view.error}
        </Notice>
      ) : (
        <Thread chatId={id} view={view} outbox={outbox} />
      )}
    </Page>
  )
}
