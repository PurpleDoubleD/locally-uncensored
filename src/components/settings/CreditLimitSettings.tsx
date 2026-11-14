// The two credit limits of agent runs (CA, 14.11.2026; lib/agent-cost-brake.ts).
//
// Customers lost hundreds of thousands of credits to agent runs nobody was
// watching. A run now pauses at a limit per task and at a limit per hour,
// says how much it used, and goes on when the user sends "continue".

import { useSettingsStore } from '../../stores/settingsStore'
import { HOUR_CREDIT_LIMIT, RUN_CREDIT_LIMIT } from '../../lib/agent-cost-brake'

const RUN_CHOICES = [25_000, 50_000, 100_000, 250_000, 500_000, 0]
const HOUR_CHOICES = [100_000, 250_000, 500_000, 1_000_000, 0]

const label = (n: number) => (n === 0 ? 'No limit' : `${n.toLocaleString('en-US')} credits`)

function Row({ id, title, value, choices, onPick }: { id: string; title: string; value: number; choices: number[]; onPick: (n: number) => void }) {
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
        {choices.map((n) => <option key={n} value={n}>{label(n)}</option>)}
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
