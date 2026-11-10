import { useState } from 'react'
import { Ban, Check, CircleAlert, Clock, FileText, Globe, ListTodo, Search, Square, Users, Workflow, Wrench } from 'lucide-react'
import type { AgentToolCall } from '../../../../types/agent-mode'
import { AGENT_STRINGS as T } from '../../../strings/agent'
import { Spinner, type IconType } from '../../../ui'
import { previewOf } from './blocks'
import { Fold } from './Fold'
import { argLines, callDuration, callFailure, callName, callState, CALL_STATE_TEXT, toolTarget, toolTitle, type CallState } from './tool-words'

const TOOL_ICON: Record<string, IconType> = {
  web_search: Search,
  web_fetch: Globe,
  web_research: Globe,
  file_read: FileText,
  file_write: FileText,
  file_edit: FileText,
  file_list: FileText,
  file_search: Search,
  run_workflow: Workflow,
  delegate_task: Users,
  check_tasks: Users,
  message_agent: Users,
  todo_write: ListTodo,
}

const STATE_ICON: Record<CallState, IconType> = {
  waiting: Clock,
  running: Clock,
  done: Check,
  failed: CircleAlert,
  denied: Ban,
  stopped: Square,
}

function Result({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const view = previewOf(text)
  return (
    <>
      <pre className="m-ag-pre" data-testid="m-chat-tool-result">
        {all ? text : view.shown}
      </pre>
      {view.more > 0 ? (
        <button type="button" className="m-ag-line-btn" style={{ marginLeft: 0, alignSelf: 'flex-start' }} aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="m-chat-tool-more">
          {all ? T.tools.showLess : T.tools.showMore}
        </button>
      ) : null}
    </>
  )
}

/** One tool call: what it did, on what, how it went. Opens to input and result (C2.21). */
export function ToolCallRow({ call, nested }: { call: AgentToolCall; nested?: boolean }) {
  const state = callState(call.status)
  const target = toolTarget(call.toolName, call.args)
  const duration = callDuration(call)
  const lines = argLines(call.args)
  const failed = state === 'failed' || state === 'denied'
  return (
    <Fold
      title={toolTitle(call.toolName)}
      sub={
        <>
          {target ? `${target} ` : null}
          {state === 'running' ? <Spinner label={CALL_STATE_TEXT.running} /> : state === 'done' ? null : <span className={failed ? 'm-ag-error' : undefined}>{CALL_STATE_TEXT[state]}</span>}
        </>
      }
      meta={duration || undefined}
      icon={state === 'done' || state === 'running' ? (TOOL_ICON[call.toolName] ?? Wrench) : STATE_ICON[state]}
      label={callName(call)}
      state={state}
      testid={nested ? 'm-chat-tool-nested' : 'm-chat-tool'}
      el="C2.21"
    >
      {() => (
        <>
          {failed ? (
            <span className="m-ag-error" role="alert" data-testid="m-chat-tool-error">
              {callFailure(call)}
              {call.errorHint ? ` ${call.errorHint}` : ''}
            </span>
          ) : null}
          <div className="m-ag-kv">
            <span>{T.tools.technicalName}</span>
            <span className="m-mono">{call.toolName}</span>
          </div>
          {lines.length > 0 ? (
            <div className="m-ag-kv">
              <span>{T.tools.input}</span>
              <pre className="m-ag-pre" data-testid="m-chat-tool-input">
                {lines.map((l) => `${l.key}: ${l.value}`).join('\n')}
              </pre>
            </div>
          ) : null}
          <div className="m-ag-kv">
            <span>{T.tools.result}</span>
            {call.diff ? <pre className="m-ag-pre">{call.diff}</pre> : call.result ? <Result text={call.result} /> : <span className="m-cap">{state === 'failed' || state === 'denied' ? CALL_STATE_TEXT[state] : T.tools.noResult}</span>}
          </div>
        </>
      )}
    </Fold>
  )
}
