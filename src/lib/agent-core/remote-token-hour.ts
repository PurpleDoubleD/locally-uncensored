/**
 * The phone's hourly token limit for agent runs (CA, 14.11.2026). One
 * implementation for both phone loops, the app and the desktop's phone page:
 * mobile-client/agent-core.js, where the reasons are written down.
 */
import {
  AGENT_HOUR_KEY,
  AGENT_HOUR_TOKEN_LIMIT,
  countAgentHourTokens,
  estimateAgentTokens,
} from '../../../mobile-client/agent-core.js'

export const REMOTE_HOUR_TOKEN_LIMIT: number = AGENT_HOUR_TOKEN_LIMIT

export function estimateRemoteTokens(chars: number): number {
  return estimateAgentTokens(chars) as number
}

/** True when this step takes the hour over the limit and no pause came yet. */
export function countRemoteStep(tokens: number, now?: number, limit?: number): boolean {
  return countAgentHourTokens(tokens, now, limit) as boolean
}

/** Tests only. */
export function _resetRemoteTokenHour(): void {
  try { globalThis.localStorage?.removeItem(AGENT_HOUR_KEY as string) } catch { /* nothing */ }
}
