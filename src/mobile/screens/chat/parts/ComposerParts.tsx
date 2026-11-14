/**
 * The small parts around the composer of C2: attachment chips (C2.15), the
 * dictation meter (C2.7), the command list (C2.3), the cloud chip (C2.13) and
 * the context figure (C2.14).
 */
import { useEffect, useMemo, useState } from 'react'
import { FileText, X } from 'lucide-react'
import type { ImageAttachment } from '../../../../types/chat'
import type { AgentCommand } from '../../../../lib/agent-commands'
import type { ChatFileInput } from '../../../../lib/chat-files'
import { isEngineModel, useEngineView } from '../../../../lib/engine-view'
import { PHONE_FIT_MAX_CTX, shownPhoneMeter, type PhoneMeter } from '../../../../lib/phone-context-fit'
import { isModelVisible } from '../../../../lib/run-compact-command'
import { usePhoneMeterStore } from '../../../../stores/phoneMeterStore'
import { computeContextFill } from '../../../../lib/token-usage'
import { useActiveContextWindow } from '../../../../hooks/useActiveContextWindow'
import { useVoiceLevel } from '../../../../hooks/useVoice'
import { useChatStore } from '../../../../stores/chatStore'
import { useModelStore } from '../../../../stores/modelStore'
import { useSendSizeStore } from '../../../../stores/sendSizeStore'
import { nav } from '../../../nav'
import { CHAT_STRINGS } from '../../../strings/chat'
import { Chip, Icon, Spinner } from '../../../ui'
import { contextLevel, contextPercent, formatClock } from './logic/messages'

const S = CHAT_STRINGS

export function AttachmentChips(props: {
  images: readonly ImageAttachment[]
  files: readonly ChatFileInput[]
  onOpenImage: (index: number) => void
  onOpenFile: (index: number) => void
  onRemoveImage: (index: number) => void
  onRemoveFile: (index: number) => void
  /** Names of files being read right now (a scan takes seconds): a chip without buttons for each. */
  reading?: readonly string[]
}) {
  const { images, files, onOpenImage, onOpenFile, onRemoveImage, onRemoveFile, reading = [] } = props
  return (
    <>
      {images.map((image, i) => {
        const name = image.name || `image ${i + 1}`
        return (
          <span className="m-chat-att" key={`image-${i}`} data-testid="m-chat-attachment" data-m-kind="image" data-el="C2.15">
            <button type="button" className="m-chat-att-open" aria-label={S.attach.openChip(name)} data-testid="m-chat-attachment-open" onClick={() => onOpenImage(i)}>
              <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
              <span className="m-chat-att-name">{name}</span>
            </button>
            <button type="button" className="m-ib" aria-label={S.attach.remove(name)} data-testid="m-chat-attachment-remove" onClick={() => onRemoveImage(i)}>
              <Icon icon={X} small />
            </button>
          </span>
        )
      })}
      {files.map((file, i) => (
        <span className="m-chat-att" key={`file-${file.attachment.sha256}-${i}`} data-testid="m-chat-attachment" data-m-kind="file" data-el="C2.15">
          <button type="button" className="m-chat-att-open" aria-label={S.attach.openChip(file.attachment.name)} data-testid="m-chat-attachment-open" onClick={() => onOpenFile(i)}>
            <Icon icon={FileText} small />
            <span className="m-chat-att-name">{file.attachment.name}</span>
          </button>
          <button type="button" className="m-ib" aria-label={S.attach.remove(file.attachment.name)} data-testid="m-chat-attachment-remove" onClick={() => onRemoveFile(i)}>
            <Icon icon={X} small />
          </button>
        </span>
      ))}
      {reading.map((name, i) => (
        <span className="m-chat-att m-chat-att--reading" key={`reading-${name}-${i}`} role="status" data-testid="m-chat-attachment-reading" data-m-kind="reading">
          <span className="m-chat-att-open">
            <Spinner label={S.attach.reading(name)} />
            <span className="m-chat-att-name">{S.attach.reading(name)}</span>
          </span>
        </span>
      ))}
    </>
  )
}

/** A clock that counts from `since`. Returns the text "0:07". */
export function useClock(since: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since])
  return formatClock(since === null ? 0 : Math.max(0, now - since))
}

/** How tall each of the five bars stands for one level: the middle ones lead, the outer ones follow. */
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.8, 0.5]
/** A bar never disappears: at silence it is a dot. */
const BAR_FLOOR = 0.14
/** Below this the microphone hears nothing worth showing. */
export const HEARD_LEVEL = 0.06
/** After this long without any sound the line says so. */
export const QUIET_AFTER_MS = 3000

/** Pure: the height of the five bars, 0 to 1 each, for a level from 0 to 1. */
export function barHeights(level: number): number[] {
  const l = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0))
  return BAR_WEIGHTS.map((w) => Math.max(BAR_FLOOR, Math.min(1, l * w * 1.6)))
}

/**
 * The five bars follow the level of the microphone (useVoice hands it out).
 * Their own component, so ten readings a second repaint five bars and
 * nothing else.
 */
function LevelBars({ since }: { since: number }) {
  const level = useVoiceLevel()
  const [heard, setHeard] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  if (!heard && level >= HEARD_LEVEL) setHeard(true)
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), QUIET_AFTER_MS + 50)
    return () => window.clearTimeout(timer)
  }, [since])
  const quiet = !heard && now - since >= QUIET_AFTER_MS
  return (
    <>
      <span className="m-chat-meter-bars" aria-hidden="true" data-testid="m-chat-dictation-level" data-m-level={Math.round(level * 100)} data-m-heard={heard ? '' : undefined}>
        {barHeights(level).map((height, i) => (
          <i key={i} style={{ transform: `scaleY(${height.toFixed(2)})` }} />
        ))}
      </span>
      {quiet ? (
        <span className="m-chat-meter-quiet" data-testid="m-chat-dictation-quiet">
          {S.voice.quiet}
        </span>
      ) : null}
    </>
  )
}

/** Shown instead of the text field while the microphone records. The whole area stops the take. */
export function DictationMeter(props: { since: number; transcribing: boolean; onStop: () => void }) {
  const { since, transcribing, onStop } = props
  const clock = useClock(transcribing ? null : since)
  if (transcribing) {
    return (
      <div className="m-chat-meter" role="status" data-testid="m-chat-dictation" data-state="transcribing">
        <Spinner label={S.voice.transcribing} />
        <span className="m-chat-meter-hint">{S.voice.transcribing}</span>
      </div>
    )
  }
  return (
    <button type="button" className="m-chat-meter" aria-label={S.voice.stop} data-testid="m-chat-dictation" data-state="recording" data-el="C2.7" onClick={onStop}>
      <LevelBars since={since} />
      <span className="m-chat-meter-clock">{clock}</span>
      <span className="m-chat-meter-hint">{S.voice.tapToStop}</span>
    </button>
  )
}

/** The commands that match what is typed after a slash, above the field (C2.3). */
export function CommandList(props: { commands: readonly AgentCommand[]; onPick: (command: AgentCommand) => void }) {
  const { commands, onPick } = props
  if (commands.length === 0) return null
  return (
    <div className="m-chat-cmds" role="group" aria-label={S.chat.commands} data-testid="m-chat-commands">
      {commands.map((command) => (
        <button type="button" key={command.name} className="m-chat-cmd" aria-label={S.chat.commandName(command.name, command.summary)} data-testid="m-chat-command" data-m-id={command.name} onClick={() => onPick(command)}>
          <code>/{command.name}</code>
          <span>{command.summary}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * How full the context window is (C2.14). Opens the chat options at the
 * context page; from 95 percent a second chip compacts at once.
 */
export function ContextChip(props: { chatId: string; onCompact: () => void; busy: boolean; warnOnly?: boolean }) {
  const activeModel = useModelStore((s) => s.activeModel)
  const engine = useEngineView()
  // The window of a model of this phone is a fact of the running engine. Asked before the engine
  // holds the model, the question goes to addresses nobody listens on yet (five failed requests in
  // the console of every first chat, seen on the devices). So the chip waits for the engine.
  if (isEngineModel(activeModel) && (engine.state === 'loading' || engine.state === 'not-loaded' || engine.state === 'error')) return null
  return <ContextChipWhenKnown {...props} />
}

/**
 * The figure of a chat with a model of this phone, or null where the window is not a phone's (a cloud model) or an
 * agent run measured the chat last. One calculation for the chip, the sheet behind it and the send path
 * (lib/phone-context-fit.ts, "the context figure of a plain chat").
 */
export function usePhoneMeter(chatId: string, window: number): PhoneMeter | null {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === chatId))
  const report = usePhoneMeterStore((s) => s.byConv[chatId])
  const agentSent = useSendSizeStore((s) => s.byConv[chatId])
  const activeModel = useModelStore((s) => s.activeModel)
  return useMemo(() => {
    if (!conversation || !(window > 0) || window > PHONE_FIT_MAX_CTX || !isEngineModel(activeModel)) return null
    // An agent run built the last request of this chat: its own measurement is the newer one.
    if (agentSent && (!report || agentSent.atMessageCount > report.atMessageCount)) return null
    const stored = conversation.messages.map((m) => ({ message: { role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id }, counts: isModelVisible(m) }))
    return shownPhoneMeter(report, stored, conversation.systemPrompt ?? '', window)
  }, [conversation, report, agentSent, activeModel, window])
}

function ContextChipWhenKnown(props: { chatId: string; onCompact: () => void; busy: boolean; warnOnly?: boolean }) {
  const { chatId, onCompact, busy, warnOnly } = props
  const messages = useChatStore((s) => s.conversations.find((c) => c.id === chatId)?.messages)
  const sent = useSendSizeStore((s) => s.byConv[chatId])
  const ctx = useActiveContextWindow()
  const window = ctx.sendWindow > 0 ? ctx.sendWindow : ctx.contextWindow
  const meter = usePhoneMeter(chatId, window)
  if (!messages || messages.length === 0) return null
  if (!(window > 0)) return null
  const fill = computeContextFill(messages, sent ? { tokens: sent.tokens + sent.toolsTokens, atMessageCount: sent.atMessageCount } : undefined)
  const percent = meter ? meter.percent : contextPercent(Math.min(fill.used, window), window)
  const state = meter?.state ?? 'fits'
  const level = contextLevel(percent)
  // Prompt v2: above the field only when it wants attention. The figure itself is in the chat settings.
  if (warnOnly && level === 'ok' && state === 'fits') return null
  return (
    <>
      <Chip
        mini
        kind="action"
        tone={level === 'ok' && state === 'fits' ? 'default' : 'warn'}
        label={state === 'trimmed' ? S.chat.contextNameTrimmed(percent) : state === 'too-long' ? S.chat.contextNameTooLong : S.chat.contextName(percent)}
        onPress={() => nav.openSheet('chat-options', { chatId, section: 'context' })}
        testid="m-chat-context"
        el="C2.14"
      >
        <span className="m-chat-ctx" data-m-fill={state}>{state === 'trimmed' ? S.chat.contextChipTrimmed(percent) : state === 'too-long' ? S.chat.contextChipTooLong : S.chat.contextChip(percent)}</span>
      </Chip>
      {/* Compacting keeps a summary of what would fall out. It does not make one message shorter. */}
      {(level === 'full' || state === 'trimmed') && state !== 'too-long' ? (
        <Chip mini kind="action" tone="warn" disabled={busy} onPress={onCompact} testid="m-chat-compact-now" el="C2.14">
          {S.chat.compactNow}
        </Chip>
      ) : null}
    </>
  )
}
