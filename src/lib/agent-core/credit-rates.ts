/**
 * The credit price a model's catalogue entry declares (LU Cloud), for the
 * cost brake. Null for every model without one: the brake then counts tokens
 * only, as before.
 */
import { useModelStore } from '../../stores/modelStore'
import type { CreditRates } from '../../api/providers/types'

export function creditRatesOf(model: string | null | undefined): CreditRates | null {
  if (!model) return null
  const meta = useModelStore.getState().models.find((m) => m.name === model) as { creditRates?: CreditRates } | undefined
  const r = meta?.creditRates
  if (!r || typeof r.inputPerMillion !== 'number' || typeof r.outputPerMillion !== 'number') return null
  return r
}

/** How LU Cloud billed one step ('flash' cost no credits), from any turn shape. */
export function billingOf(turn: unknown): 'flash' | 'credits' | undefined {
  const b = turn && typeof turn === 'object' ? (turn as { billing?: unknown }).billing : undefined
  return b === 'flash' || b === 'credits' ? b : undefined
}
