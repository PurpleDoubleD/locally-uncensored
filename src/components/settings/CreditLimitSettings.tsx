// The two credit limits of agent runs (CA, 14.11.2026; lib/agent-cost-brake.ts).
//
// Customers lost hundreds of thousands of credits to agent runs nobody was
// watching. A run now pauses at a limit per task and at a limit per hour,
// says how much it used, and goes on when the user sends "continue".

import { useSettingsStore } from '../../stores/settingsStore'
import { HOUR_CREDIT_LIMIT, RUN_CREDIT_LIMIT, RUN_HALT_CHOICES, RUN_HALT_TOKENS } from '../../lib/agent-cost-brake'

const RUN_CHOICES = [25_000, 50_000, 100_000, 250_000, 500_000, 0]
const HOUR_CHOICES = [100_000, 250_000, 500_000, 1_000_000, 0]

const label = (n: number) => (n === 0 ? 'No limit' : `${n.toLocaleString('en-US')} credits`)
const tokenLabel = (n: number) => (n === 0 ? 'No limit' : `${n / 1_000_000}M tokens`)

function Row({ id, title, value, choices, onPick, format = label }: { id: string; title: string; value: number; choices: readonly number[]; onPick: (n: number) => void; format?: (n: number) => string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <label htmlFor={id} className="t-control text-gray-700 dark:text-gray-300">{title}</label>
      <select
        id={id}
        data-testid={id}
        value={value}
        onChange={(e) => onPick(Number(e.target.value))}
        className="t-micro px-1.5 py-0.5 rounded bg-transparent border border-gray-300 dark:border-white/15 text-gray-700 dark:text-gray-300 focus:outline-none"
      >
        {choices.map((n) => <option key={n} value={n}>{format(n)}</option>)}
      </select>
    </div>
  )
}

export function CreditLimitSettings() {
  const run = useSettingsStore((s) => s.settings.agentRunCreditLimit ?? RUN_CREDIT_LIMIT)
  const hour = useSettingsStore((s) => s.settings.agentHourCreditLimit ?? HOUR_CREDIT_LIMIT)
  const update = useSettingsStore((s) => s.updateSettings)
  return (
    <div className="pt-1" data-testid="credit-limits">
      <Row id="credit-limit-task" title="Pause a task at" value={run} choices={RUN_CHOICES} onPick={(n) => update({ agentRunCreditLimit: n })} />
      <Row id="credit-limit-hour" title="Pause all agent runs per hour at" value={hour} choices={HOUR_CHOICES} onPick={(n) => update({ agentHourCreditLimit: n })} />
      <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed pt-0.5">
        LU Cloud only. The agent pauses, says how many credits it used, and goes on when you send &quot;continue&quot;. A Hosted plan has 900,000 credits a month.
      </div>
    </div>
  )
}

/**
 * 3.1.2 (A38, GitHub #256): how many tokens one agent run may send before it
 * stops. Any provider that bills per token, LU Cloud or an own key; a model on
 * this machine or in the LAN is never stopped. Visible without a LU Cloud
 * account, because the limit applies without one.
 */
export function RunTokenLimitSettings() {
  const tokens = useSettingsStore((s) => s.settings.agentRunHaltTokens ?? RUN_HALT_TOKENS)
  const update = useSettingsStore((s) => s.updateSettings)
  const value = RUN_HALT_CHOICES.includes(tokens) ? tokens : RUN_HALT_TOKENS
  return (
    <div className="pt-1" data-testid="run-token-limit-settings">
      <Row id="run-token-limit" title="Stop a run after" value={value} choices={RUN_HALT_CHOICES} format={tokenLabel} onPick={(n) => update({ agentRunHaltTokens: n })} />
      <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed pt-0.5">
        Paid APIs, your own key included. Every step resends the whole conversation, so a long run adds up. Local models are never stopped.
      </div>
    </div>
  )
}
