// The coding agent's shell/code approval, inline in the transcript.
//
// Three rewrites got it here. It started as `window.confirm`, an OS dialog with
// system chrome and the app origin in its title bar. The first replacement was
// a centred modal that covered the conversation. The second sat in the stream
// under its tool call but read like a debug line ("shell_execute needs your
// ok", then `command: …` and `timeout: 600000`). CA (13.11.2026) makes it a
// question a person reads: what will run, where, and three answers, one of
// them "always allow this here" (stores/commandRulesStore), like the large
// coding tools.
//
// What runs is never hidden: for a plain command the card shows the command,
// for anything with a script, stdin or more fields it shows every field that
// shapes the process (renderApprovalPreview), as before.
//
// "Stop asking" both allows the current command AND clears the setting that
// caused the prompt. Clearing without allowing would leave the task blocked on
// a question that will not be asked again, which is not what the phrase means.

import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'
import { useCodexConfirmStore } from '../../stores/codexConfirmStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCommandRulesStore } from '../../stores/commandRulesStore'
import { suggestRuleFor } from '../../lib/agent-core/command-rules'

/** Fields that only tune how a command runs, not what it does. */
const QUIET_FIELDS = new Set(['timeout', 'shell', 'background'])

/** The command alone when that is all that shapes the process. */
export function plainCommandOf(args: Record<string, unknown> | undefined): string | null {
  if (!args || typeof args.command !== 'string' || !args.command.trim()) return null
  const loud = Object.keys(args).filter((k) => k !== 'command' && k !== 'cwd' && !QUIET_FIELDS.has(k) && args[k] !== undefined && args[k] !== null && args[k] !== '')
  return loud.length === 0 ? args.command.trim() : null
}

export function CodexConfirmDialog() {
  const pending = useCodexConfirmStore((s) => s.pending)
  const answer = useCodexConfirmStore((s) => s.answer)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const allowRule = useCommandRulesStore((s) => s.allow)
  const card = useRef<HTMLDivElement>(null)

  // The card is the one thing the run waits for, so it must be on screen the
  // moment it exists. The transcript's auto-scroll only follows while the
  // reader sits near the bottom; a reader who scrolled up to check the plan
  // never saw the card and the run looked stuck (t10, 2026-09-06).
  useEffect(() => {
    if (pending) card.current?.scrollIntoView({ block: 'nearest' })
  }, [pending])

  if (!pending) return null

  const plain = plainCommandOf(pending.args)
  const cwd = typeof pending.args?.cwd === 'string' && pending.args.cwd.trim() ? pending.args.cwd.trim() : null
  const rule = pending.toolName === 'shell_execute' && pending.ruleScope && plain ? suggestRuleFor(plain) : null
  const isCommand = pending.toolName === 'shell_execute' || pending.toolName === 'code_execute' || pending.toolName === 'shell_execute_background'

  const stopAsking = () => {
    // Clear whichever arm is asking. When the cloud arm is the reason, the
    // general confirm is already off, so clearing that one would change nothing
    // and the prompt would return on the very next command.
    if (pending.cloudReason) updateSettings({ codexCloudConfirmOptIn: false })
    else updateSettings({ codexConfirmShell: false })
    answer(true)
  }

  const alwaysHere = () => {
    if (rule && pending.ruleScope) allowRule(pending.ruleScope, rule)
    answer(true)
  }

  return (
    <div ref={card} className="px-1 py-0.5" data-codex-confirm>
      <div className="rounded-lg border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.03] shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
          <Terminal size={14} className="text-gray-500 dark:text-gray-400 shrink-0" />
          <span className="t-body font-medium text-gray-800 dark:text-gray-100">
            {isCommand ? 'Run this command?' : 'Allow this step?'}
          </span>
          {pending.cloudReason && (
            <span className="ml-auto t-micro text-gray-500 dark:text-gray-400">asked because a cloud model is driving</span>
          )}
        </div>

        <div className="px-3">
          <pre
            data-testid="confirm-command"
            className="max-h-48 overflow-auto rounded-md bg-gray-950 dark:bg-black/50 px-3 py-2 t-mono leading-relaxed text-gray-100 whitespace-pre-wrap break-all"
          >
            {pending.command && !plain ? pending.command : plain ? <><span className="select-none text-gray-500">$ </span>{plain}</> : '(no command preview)'}
          </pre>
          {plain && cwd && (
            <div className="mt-1 t-micro text-gray-500 dark:text-gray-400 truncate" title={cwd}>in {cwd}</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 pb-2.5">
          <button
            onClick={() => answer(true)}
            autoFocus
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md t-control font-medium bg-gray-900 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 transition-colors"
          >
            Run <kbd className="t-micro opacity-60 font-sans">⏎</kbd>
          </button>
          {rule && (
            <button
              onClick={alwaysHere}
              data-testid="confirm-always-here"
              title="Runs this command, and from now on commands that start like this run without asking in this folder. You can remove the rule in Settings → Agent."
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md t-control text-gray-800 dark:text-gray-100 border border-gray-300 dark:border-white/15 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors max-w-full"
            >
              <span className="shrink-0">Always allow</span>
              <code className="font-mono t-micro truncate">{rule}</code>
              <span className="shrink-0">here</span>
            </button>
          )}
          <button
            onClick={() => answer(false)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md t-control text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
          >
            No <kbd className="t-micro opacity-60 font-sans">Esc</kbd>
          </button>
          <div className="flex-1" />
          <button
            onClick={stopAsking}
            // What the click does, not more: it allows this command and
            // clears a switch in Settings, which is kept and is not bound to
            // a session. The run that is going resolved its gate when it
            // started (useCodex, codexModeKnobs) and Ask mode asks whatever
            // the switch says, so neither stops asking with this click.
            title={pending.cloudReason
              ? 'Runs this command and switches off the confirm for LU Cloud models in Settings, for Code and Agent, until you switch it back on. The run that is going keeps asking.'
              : 'Runs this command and switches off "Confirm shell & code commands" in Settings for every chat, until you switch it back on. The run that is going keeps asking, and so does Ask mode.'}
            className="t-micro text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            Accept without asking
          </button>
        </div>
      </div>
    </div>
  )
}
