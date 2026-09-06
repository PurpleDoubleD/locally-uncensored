// The coding agent's shell/code approval, inline in the transcript.
//
// Two rewrites got it here. It started as `window.confirm`, an OS dialog with
// system chrome and the app origin in its title bar, which David called exactly
// what it looked like. The first replacement was a centred modal, which was
// small and tidy but still covered the conversation you were reading. This one
// sits in the stream under the tool call it belongs to, so the pending command
// reads as one more step of the run rather than an interruption of it.
//
// "Don't ask again" both allows the current command AND clears the setting that
// caused the prompt. Clearing without allowing would leave the task blocked on
// a question that will not be asked again, which is not what the phrase means.

import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'
import { useCodexConfirmStore } from '../../stores/codexConfirmStore'
import { useSettingsStore } from '../../stores/settingsStore'

export function CodexConfirmDialog() {
  const pending = useCodexConfirmStore((s) => s.pending)
  const answer = useCodexConfirmStore((s) => s.answer)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const card = useRef<HTMLDivElement>(null)

  // The card is the one thing the run waits for, so it must be on screen the
  // moment it exists. The transcript's auto-scroll only follows while the
  // reader sits near the bottom; a reader who scrolled up to check the plan
  // never saw the card and the run looked stuck (t10, 2026-09-06).
  useEffect(() => {
    if (pending) card.current?.scrollIntoView({ block: 'nearest' })
  }, [pending])

  if (!pending) return null

  const stopAsking = () => {
    // Clear whichever arm is asking. When the cloud arm is the reason, the
    // general confirm is already off, so clearing that one would change nothing
    // and the prompt would return on the very next command.
    if (pending.cloudReason) updateSettings({ codexCloudConfirmOptIn: false })
    else updateSettings({ codexConfirmShell: false })
    answer(true)
  }

  return (
    <div ref={card} className="px-1 py-0.5" data-codex-confirm>
      <div className="rounded-lg border border-purple-500/20 bg-purple-500/[0.04] px-2 py-1.5">
        <div className="flex items-center gap-1.5 t-micro text-gray-700 dark:text-gray-300">
          <Terminal size={10} className="text-purple-400 shrink-0" />
          <span className="font-mono">{pending.toolName}</span>
          <span className="text-gray-500">needs your ok</span>
        </div>

        <pre className="mt-1 max-h-20 overflow-auto rounded bg-black/5 dark:bg-black/30 px-1.5 py-1 t-micro font-mono text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-all">
          {pending.command || '(no command preview)'}
        </pre>

        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            onClick={() => answer(true)}
            autoFocus
            className="px-2 py-0.5 rounded t-micro font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25 transition-colors"
          >
            Run
          </button>
          <button
            onClick={() => answer(false)}
            className="px-2 py-0.5 rounded t-micro text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-white/5 transition-colors"
          >
            No
          </button>
          <div className="flex-1" />
          {pending.cloudReason && (
            <span className="text-[0.55rem] text-gray-500">cloud model</span>
          )}
          <button
            onClick={stopAsking}
            title="Run this and every later command in this session without asking"
            className="t-micro text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            Accept without asking
          </button>
        </div>
      </div>
    </div>
  )
}
