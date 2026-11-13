/**
 * C9 Compare. Route /chat/:id/compare, kind page, tab chat, strand 2 (Agent and knowledge).
 *
 * The same prompt to two models. The sending is the desktop hook
 * (hooks/useABCompare with stores/compareStore): one local and one cloud
 * model answer side by side, two local models one after the other. The page
 * only draws it for a phone: one answer list at a time with a segment A/B,
 * both next to each other in landscape.
 */
import { useEffect, useState } from 'react'
import { Flag, RotateCcw } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { useABCompare } from '../../../hooks/useABCompare'
import { useChatStore } from '../../../stores/chatStore'
import { useCompareStore } from '../../../stores/compareStore'
import { useModelStore } from '../../../stores/modelStore'
import type { Message } from '../../../types/chat'
import { nav, useParams } from '../../nav'
import { AGENT_STRINGS as T } from '../../strings/agent'
import { Button, Composer, EmptyState, IconButton, ModelChip, Notice, Page, Segmented, Spinner, toast } from '../../ui'
import './parts/agent.css'
import { NEW_CHAT } from './parts/chat-ref'
import { compareFailureText } from '../../../lib/compare-failure'
import { compareBlock, formatRate, keptPair, rateIsMeaningful, type Side } from './parts/compare-logic'
import { localCount, modelLabel, whereOf } from './parts/model-names'
import { consentFor, isCloudModel, reportAnswer } from './parts/policy'

const S = T.compare

export default function ComparePage() {
  const { id } = useParams<{ id: string }>()
  const { sendCompare, stopCompare } = useABCompare()
  const modelA = useCompareStore((s) => s.modelA)
  const modelB = useCompareStore((s) => s.modelB)
  const messagesA = useCompareStore((s) => s.messagesA)
  const messagesB = useCompareStore((s) => s.messagesB)
  const statsA = useCompareStore((s) => s.statsA)
  const statsB = useCompareStore((s) => s.statsB)
  const streamingA = useCompareStore((s) => s.isStreamingA)
  const streamingB = useCompareStore((s) => s.isStreamingB)
  const models = useModelStore((s) => s.models)
  const activeModel = useModelStore((s) => s.activeModel)
  const [view, setView] = useState<Side>('a')
  const [text, setText] = useState('')
  const running = streamingA || streamingB

  // A is the model of the chat until the user picks another one.
  useEffect(() => {
    if (!useCompareStore.getState().modelA && activeModel) useCompareStore.getState().setModelA(activeModel)
  }, [activeModel])

  // The run belongs to this page: leaving it ends the run, as Stop would.
  useEffect(() => {
    return () => {
      const state = useCompareStore.getState()
      if (state.isStreamingA || state.isStreamingB) stopCompare()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const block = compareBlock(modelA, modelB)
  const paid = isCloudModel(modelA) || isCloudModel(modelB)

  const pick = (side: Side) => {
    nav.openSheet('model', {
      onPick: (name: string) => {
        if (side === 'a') useCompareStore.getState().setModelA(name)
        else useCompareStore.getState().setModelB(name)
      },
    })
  }

  const send = async () => {
    const prompt = text.trim()
    if (!prompt || block || running) return
    if (!(await consentFor([modelA, modelB]))) return
    setText('')
    void sendCompare(prompt)
  }

  const keep = (side: Side, index: number) => {
    const list = side === 'a' ? messagesA : messagesB
    const model = side === 'a' ? modelA : modelB
    const pair = keptPair(list, index, model, uuid, Date.now())
    if (pair.length === 0) return
    const chats = useChatStore.getState()
    let chatId = id
    const fresh = id === NEW_CHAT || !chats.conversations.some((c) => c.id === id)
    if (fresh) chatId = chats.createConversation(model, '')
    for (const message of pair) useChatStore.getState().addMessage(chatId, message)
    useCompareStore.getState().reset()
    toast(S.kept, { testid: 'compare-kept' })
    nav.back()
    if (fresh) nav.replace('/chat/:id', { id: chatId })
  }

  const startOver = async () => {
    const yes = await nav.confirm({ title: S.clearTitle, text: S.clearText, confirmLabel: S.clear, tone: 'danger', testid: 'compare-clear' })
    if (!yes) return
    stopCompare()
    useCompareStore.getState().reset()
  }

  const column = (side: Side) => {
    const list = side === 'a' ? messagesA : messagesB
    const model = side === 'a' ? modelA : modelB
    const streaming = side === 'a' ? streamingA : streamingB
    const stats = side === 'a' ? statsA : statsB
    const name = modelLabel(model, models) || (side === 'a' ? S.modelA : S.modelB)
    const queued = side === 'b' && streamingA && streamingB && localCount([modelA, modelB]) === 2
    return (
      <div className="m-ag-cmp-col" data-side={side} data-testid={`m-compare-col-${side}`}>
        <span className="m-ag-cmp-head">{`${side === 'a' ? S.a : S.b}: ${name}`}</span>
        {list.map((message: Message, index) => {
          if (message.role === 'user') {
            return (
              <div className="m-ag-ask" key={message.id}>
                <span className="m-sr">{S.you}: </span>
                {message.content}
              </div>
            )
          }
          const last = index === list.length - 1
          const live = last && streaming
          const empty = !message.content.trim()
          return (
            <div className="m-ag-answer" key={message.id} role="article" aria-label={S.answerOf(side === 'a' ? S.a : S.b, name)} data-testid={`m-compare-answer-${side}`}>
              <span className="m-cap">{name}</span>
              {empty && live ? (
                <span className="m-rowh m-cap" role="status">
                  <Spinner label={queued ? S.waitingTurn : S.waiting} />
                  {queued ? S.waitingTurn : S.waiting}
                </span>
              ) : empty ? (
                <span className="m-ag-error" role="alert" style={{ whiteSpace: 'pre-wrap' }} data-testid={`m-compare-noanswer-${side}`}>
                  {message.error ? compareFailureText(message.error) : S.noAnswer}
                </span>
              ) : (
                <div className="m-ag-answer-text">{message.content}</div>
              )}
              {last && !live && stats && !empty ? <span className="m-mono m-cap">{rateIsMeaningful(stats.tokens) ? S.stats(stats.tokens, formatRate(stats.tokensPerSec)) : S.statsShort(stats.tokens)}</span> : null}
              {!empty && !live ? (
                <div className="m-rowh">
                  <Button compact disabled={running} disabledReason={S.keepBlocked} onPress={() => keep(side, index)} testid={`m-compare-keep-${side}`} el="C9.6">
                    {S.keep}
                  </Button>
                  <Button compact icon={Flag} onPress={() => reportAnswer({ id: message.id, model, text: message.content })} testid={`m-compare-report-${side}`}>
                    {T.common.report}
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    )
  }

  const hasRounds = messagesA.length > 0 || messagesB.length > 0
  const sendBlocked = block === 'need-two' ? S.needTwo : block === 'same' ? S.same : undefined

  return (
    <Page
      title={S.title}
      screen="chat-compare"
      needsNetwork={paid}
      actions={hasRounds ? <IconButton icon={RotateCcw} label={S.clear} onPress={() => void startOver()} testid="m-compare-clear" /> : null}
      bareFooter
      footer={
        <Composer
          value={text}
          onChange={setText}
          onSend={() => void send()}
          running={running}
          onStop={stopCompare}
          label={S.inputLabel}
          placeholder={S.placeholder}
          sendBlocked={sendBlocked}
          cloud={paid}
          risk={paid ? 'paid' : undefined}
          idPrefix="m-compare"
          el="C9.4"
        />
      }
    >
      <div className="m-ag-cmp-models">
        <div className="m-ag-cmp-model">
          <span>{S.modelA}</span>
          <ModelChip name={modelA ? modelLabel(modelA, models) : null} where={whereOf(modelA)} onPress={() => pick('a')} emptyText={S.choose} disabled={running} testid="m-compare-model-a" el="C9.1" />
        </div>
        <div className="m-ag-cmp-model">
          <span>{S.modelB}</span>
          <ModelChip name={modelB ? modelLabel(modelB, models) : null} where={whereOf(modelB)} onPress={() => pick('b')} emptyText={S.choose} disabled={running} testid="m-compare-model-b" el="C9.2" />
        </div>
      </div>
      {block === 'same' ? (
        <Notice variant="warn" testid="m-compare-same">
          {S.same}
        </Notice>
      ) : null}
      {!block && localCount([modelA, modelB]) === 2 ? (
        <Notice variant="info" testid="m-compare-both-local">
          {S.bothLocal}
        </Notice>
      ) : null}
      {!block && paid ? <p className="m-ag-text">{S.paidHint}</p> : null}
      {hasRounds ? (
        <>
          <div className="m-ag-cmp-switch">
            <Segmented
              label={S.viewLabel}
              value={view}
              onChange={setView}
              options={[
                { value: 'a', label: S.a, testid: 'm-compare-view-a' },
                { value: 'b', label: S.b, testid: 'm-compare-view-b' },
              ]}
              testid="m-compare-view"
              el="C9.3"
            />
          </div>
          <div className="m-ag-cmp" data-view={view} data-testid="m-compare-answers">
            {column('a')}
            {column('b')}
          </div>
        </>
      ) : (
        <EmptyState title={S.empty} testid="m-compare-empty">
          {block === 'need-two' ? S.needTwo : S.emptyText}
        </EmptyState>
      )}
    </Page>
  )
}
