/**
 * Jaeger B, B9: the desktop sub-agent fields had no upper bound and
 * resolveSubAgentBudget took any value above 0, so a sub-agent that runs
 * unattended could be given 99999999 tool calls. Now the budget is clamped
 * to SUB_AGENT_LIMIT_MAX, the same bound set_setting from the chat uses,
 * and 0 still means "use the default".
 *
 * Run: npx vitest run src/api/agents/__tests__/sub-agent-limits-are-bounded.test.ts
 */
import { describe, it, expect } from 'vitest'
import { resolveSubAgentBudget, SUB_AGENT_BUDGET } from '../sub-agent'
import { SUB_AGENT_LIMIT_MAX } from '../../../lib/number-limits'
import { findEntry } from '../../../lib/settings-catalog'

describe('B9: sub-agent limits have an upper bound', () => {
  it('a huge value is clamped, 0 is the default, a normal value passes', () => {
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: 99_999_999, subAgentMaxIterations: 99_999_999 }))
      .toEqual({ maxToolCalls: SUB_AGENT_LIMIT_MAX, maxIterations: SUB_AGENT_LIMIT_MAX })
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: 0, subAgentMaxIterations: 0 }))
      .toEqual({ maxToolCalls: SUB_AGENT_BUDGET.maxToolCalls, maxIterations: SUB_AGENT_BUDGET.maxIterations })
    expect(resolveSubAgentBudget({ subAgentMaxToolCalls: 25, subAgentMaxIterations: 7 }))
      .toEqual({ maxToolCalls: 25, maxIterations: 7 })
  })

  it('the chat command uses the same bound', () => {
    expect(findEntry('subAgentMaxToolCalls')?.parse(SUB_AGENT_LIMIT_MAX + 1).ok).toBe(false)
    expect(findEntry('subAgentMaxIterations')?.parse(SUB_AGENT_LIMIT_MAX).ok).toBe(true)
  })
})
