/**
 * Phase 10 (v2.4.0) — Agent turn budget tracker.
 *
 * Hard cap on tool calls and ReAct iterations within a single LOOP.
 *
 * Counts are per-instance, not global. This comment used to claim the
 * opposite — "global (not per-sub-agent-level) so a delegation fork-bomb
 * cannot sneak past the cap by nesting" — and the code has never done that:
 * buildDelegateExecutor in sub-agent.ts hands every delegation a fresh
 * `new AgentBudget({ ...SUB_AGENT_BUDGET })`, so a sub-agent's 10 tool calls
 * are counted against its own tight caps and never against the parent's.
 *
 * That is the intended design, not an oversight to be "fixed" by sharing one
 * counter: the sub-agent caps (10 calls / 5 iterations) exist precisely to
 * bound a delegation independently of how much budget the parent has left,
 * and delegate_task advertises them to the model. Sharing the parent's budget
 * would also make one runaway sub-agent silently starve its siblings. What
 * actually bounds a delegation fan-out is SUB_AGENT_MAX_PARALLEL (4 in
 * flight) plus the registry filter that hides delegate_task from a sub-agent
 * — see the notes in sub-agent.ts. Fixed in 2.6.7 (audit AGT-1).
 *
 * A budget is created at the start of each agent run. The hook increments
 * on each batch of tool calls and each loop iteration; exceed() returns
 * the first kind to exhaust, which the hook uses to synthesize a clean
 * halt message for the user.
 */

export type BudgetExceed =
  | { kind: 'none' }
  | { kind: 'tool_calls'; used: number; cap: number }
  | { kind: 'iterations'; used: number; cap: number }

export interface BudgetCaps {
  maxToolCalls: number
  maxIterations: number
}

export class AgentBudget {
  private toolCalls = 0
  private iterations = 0

  constructor(private caps: BudgetCaps) {}

  /** Record N new tool calls (accepts batch). */
  addToolCalls(n: number): void {
    if (n > 0) this.toolCalls += n
  }

  /** Record one more ReAct loop iteration. */
  addIteration(): void {
    this.iterations += 1
  }

  /**
   * Check whether any cap has been exceeded. A cap of 0 means "unlimited"
   * — callers can opt out entirely by setting both to 0 (discouraged).
   */
  exceeded(): BudgetExceed {
    if (this.caps.maxIterations > 0 && this.iterations >= this.caps.maxIterations) {
      return { kind: 'iterations', used: this.iterations, cap: this.caps.maxIterations }
    }
    if (this.caps.maxToolCalls > 0 && this.toolCalls >= this.caps.maxToolCalls) {
      return { kind: 'tool_calls', used: this.toolCalls, cap: this.caps.maxToolCalls }
    }
    return { kind: 'none' }
  }

  /**
   * Convert an exceed to a user-facing halt message. Returns '' when the
   * budget has not been exceeded.
   */
  haltMessage(): string {
    const ex = this.exceeded()
    if (ex.kind === 'none') return ''
    if (ex.kind === 'tool_calls') {
      return `[Agent halted: tool-call budget reached (${ex.used} / ${ex.cap}). Rephrase your request or raise the cap in Settings to continue.]`
    }
    // iterations
    return `[Agent halted: ReAct loop iteration cap reached (${ex.used} / ${ex.cap}). Either the task is too broad or the model is looping — rephrase and retry.]`
  }

  /** Snapshot — useful for UI badges ("used 12 of 50 tool calls"). */
  snapshot(): { toolCalls: number; iterations: number; caps: BudgetCaps } {
    return { toolCalls: this.toolCalls, iterations: this.iterations, caps: { ...this.caps } }
  }
}

/**
 * Build a budget from user settings. Accepts the relevant fields only so
 * tests do not need to construct a whole Settings object.
 */
export function budgetFromSettings(s: { agentMaxToolCalls: number; agentMaxIterations: number }): AgentBudget {
  return new AgentBudget({
    maxToolCalls: s.agentMaxToolCalls,
    maxIterations: s.agentMaxIterations,
  })
}
