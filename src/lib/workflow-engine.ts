/**
 * Workflow Engine — Executes agent workflow steps sequentially.
 *
 * Reuses the same tool execution and provider infrastructure as useAgentChat.
 * Supports: prompt, tool, condition, loop, user_input, memory_save steps.
 */

import { useModelStore } from '../stores/modelStore'
import { errorText } from '../types/json-guards'
import { useSettingsStore } from '../stores/settingsStore'
import { useChatStore } from '../stores/chatStore'
import { useMemoryStore } from '../stores/memoryStore'
import { buildSamplingRequest } from './sampling'
// Audit W-T2: hier stand `from '../api/tool-registry'` — der als @deprecated
// markierte Kompatibilitäts-Shim. Der zieht das ganze MCP-Barrel herein
// (api/mcp/index.ts, das registerBuiltinTools ausführt), und weil
// builtin-tools.ts umgekehrt diese Engine für sein run_workflow-Tool braucht,
// schloss sich der Kreis: mcp/index → builtin-tools → workflow-engine →
// tool-registry → mcp/index.
//
// Die Engine ist kein Altlast-Aufrufer. Sie braucht die Registry selbst, nicht
// den Kompositions-Einstiegspunkt, der die Builtins einhängt — also importiert
// sie jetzt genau die: das Registry-Modul und die Berechtigungs-Voreinstellung.
// Beides sind generische Module ohne Rückkante. Der Shim bleibt für seine
// verbliebenen Aufrufer bestehen.
import { toolRegistry } from '../api/mcp/tool-registry'
import { isSelfControlToolName } from './settings-tool-names'
import type { ToolArgs } from '../api/mcp/types'
import { streamProviderTurn } from './provider-stream'
import { runInLane, type HeldLocalLane } from './run-slot'
import { laneOf, currentLaneFacts } from './run-lane-of-model'
import type { AgentRunContext } from '../api/agent-context'
import { settleThinking } from './thinking-stripper'
import { buildHermesToolPrompt, parseHermesToolCalls, stripToolCallTags, hasToolCallTags } from '../api/hermes-tool-calling'
import { resolveToolCallingStrategy } from './agent-strategy'
import { isThinkingCompatible } from './model-compatibility'
import type { AgentWorkflow, WorkflowStep, StepResult, WorkflowEngineCallbacks } from '../types/agent-workflows'
import type { ChatMessage, ToolDefinition } from '../api/providers/types'
import { usePermissionStore } from '../stores/permissionStore'
// Nebenbefund, bau/review-wfplay.md Teil B: die Engine fuehrte Werkzeuge
// bisher direkt ueber `toolRegistry.execute` aus, ohne jede Freigabe, und bot
// Prompt-Schritten `DEFAULT_PERMISSIONS` an statt des echten Stores. Derselbe
// Fehler wie AGT-1 (sub-agent.ts), derselbe Fix: ein Pflicht-Gate im
// Konstruktor. Die ENTSCHEIDUNG selbst kommt aus derselben, bereits
// gehaerteten Tabelle wie beim Agenten-Chat und beim Sub-Agenten
// (`resolveApprovalLevel`, agent-approval-policy.ts), nur das VERDRAHTEN auf
// die Warteschlange baut `buildWorkflowApprovalGate` unten selbst, statt
// `sub-agent.ts`s `buildSubAgentGates` zu importieren: deren zwei
// `await import(...)` (Permission-Store, Warteschlange) haengen einen echten
// Tick ein, den `run_workflow`s bestehende Lane-Zeitmess-Tests (u.a.
// `heldLocalLane-wird-immer-weitergereicht.test.ts`) nicht vorhalten, vorher
// gruen, mit `buildSubAgentGates` dort zwei rot (Zahlen im Baubericht). Die
// Politik-TABELLE bleibt eine einzige Stelle, nur die Verdrahtung ist doppelt.
import { resolveApprovalLevel } from './agent-approval-policy'
import { enqueueApproval, removeApproval, type ApprovalEntry } from './approval-queue'
import type { AgentToolCall } from '../types/agent-mode'
import type { ApprovalGate, ExecutionRequest, ExecutorToolDef } from '../api/agents/tool-executor'

/**
 * Build a real `ApprovalGate` for a `run_workflow` tool call's nested engine
 * (builtin-tools.ts's `executeRunWorkflow`), synchronously wired (no
 * top-level dynamic `import()`) so it never adds a tick the lane-timing
 * tests do not expect. Same decision table as `buildSubAgentGates`
 * (sub-agent.ts): a `blocked` category refuses outright, `auto` runs
 * unattended, `confirm` asks on the surface that actually started this run
 * (`sub-agent.ts:380-393`, same reasoning): the Code tab's own
 * `codexConfirmStore` when `run.mode` is set (`run_workflow` sits in category
 * 'workflow', reachable there via `CODEX_CATEGORIES`, and a sub-agent
 * inherits its parent's `mode`, bau/review-wfgate.md Auflage 1), otherwise
 * the SAME conversation-keyed chat queue the rest of Agent mode reads
 * (`approval-queue.ts`). The dynamic imports for `codexConfirmStore` and
 * `codexShellGate` only happen inside that rare `confirm`+`mode` branch, not
 * at construction time, so the lane-timing tests this function was written
 * to protect (see the header comment above) stay unaffected. Fail closed: no
 * conversation to ask in, and no Code-tab surface either, refuses a
 * `confirm` tool rather than running it or hanging on a question nobody can
 * see.
 */
export function buildWorkflowApprovalGate(run: AgentRunContext | undefined): ApprovalGate {
  const convId = run?.conversationId ?? null
  const abortSignal = run?.abortSignal
  return async (req) => {
    if (abortSignal?.aborted) return false
    const perm = usePermissionStore.getState()
    const categoryLevel = toolRegistry.getPermissionLevelWithOverrides(
      req.toolName,
      perm.getEffectivePermissions(convId ?? undefined),
      {},
    )
    const level = resolveApprovalLevel(req.toolName, {
      categoryLevel,
      override: perm.perToolOverrides[req.toolName],
      codexMode: run?.mode ?? null,
      execConfirm: run?.execApproval?.confirmExec === true,
      readOnlyRun: run?.readOnlyShellTurn === true,
      external: toolRegistry.getAll().some((t) => t.name === req.toolName && t.source === 'external'),
    })
    if (level === 'blocked') return false
    if (level === 'auto') return true
    // Stufe 'confirm': ask on the surface that started this run. The Code
    // tab's own dialog, not the chat queue, once `run.mode` is set, or the
    // question ends up somewhere nobody is looking at it
    // (bau/review-wfgate.md Auflage 1).
    if (run?.mode) {
      const { useCodexConfirmStore } = await import('../stores/codexConfirmStore')
      const { renderApprovalPreview } = await import('../hooks/codexShellGate')
      return useCodexConfirmStore.getState().ask({
        toolName: req.toolName,
        command: renderApprovalPreview(req.toolName, req.args),
        args: req.args,
        cloudReason: run.execApproval?.cloudReason === true,
      }, abortSignal)
    }
    if (!convId) return false
    return new Promise<boolean>((resolve) => {
      const toolCall: AgentToolCall = {
        id: req.id,
        toolName: req.toolName,
        args: req.args,
        status: 'pending_approval',
        timestamp: Date.now(),
      }
      const entry: ApprovalEntry = { toolCall, resolve }
      enqueueApproval(convId, entry)
      abortSignal?.addEventListener(
        'abort',
        () => { if (removeApproval(convId, entry)) resolve(false) },
        { once: true },
      )
    })
  }
}

// ── Safety Limits ─────────────────────────────────────────────

export const MAX_LOOP_ITERATIONS = 100
export const MAX_WORKFLOW_DEPTH = 5
/**
 * Total steps one run may execute. A condition can branch backwards, which is
 * how a workflow expresses "not done yet, try again" — without a budget that
 * is an unbounded loop, and run_workflow gives the agent no way to cancel it.
 */
export const MAX_STEPS_EXECUTED = 500

/**
 * Fallback output cap for a `prompt` step when neither this chat nor the
 * Settings page has its own Max tokens set (`DEFAULT_SETTINGS.maxTokens` is
 * 0 = "auto", and `buildSamplingRequest` leaves the field off the wire at
 * that default: bau/wfprogress.md Runde 2, klein 1, for every user who
 * never touched that slider, `maxTokens` still went out `undefined`, and the
 * OpenAI-compatible provider's own fallback then asked for
 * `Math.min(headroom, 32768)`, practically the ENTIRE remaining context,
 * exactly the n_predict 31619 on a 32768 ctx the box measured). A user- or
 * chat-set value (`sampling.maxTokens > 0`) always wins over this; it only
 * fills the gap "auto" leaves. 8192 is not a new number invented for this:
 * it is the house's own long-standing default (`DEFAULT_SETTINGS.
 * builtinEngine.ctx`, constants.ts, "GH #129: die 8192 hier ist die
 * Voreinstellung des Hauses, keine Wahl"), reused here as a generous but
 * bounded ceiling for one step's answer rather than a fresh guess.
 */
export const DEFAULT_PROMPT_STEP_MAX_TOKENS = 8192

// ── Variable Interpolation ────────────────────────────────────

function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || '')
}

// ── Condition Evaluation ──────────────────────────────────────

function evaluateCondition(
  source: string,
  operator: string,
  value: string,
  variables: Record<string, string>
): boolean {
  const sourceValue = source === 'last_output'
    ? (variables['last_output'] || '')
    : (variables[source] || '')

  switch (operator) {
    case 'contains': return sourceValue.includes(value)
    case 'not_contains': return !sourceValue.includes(value)
    case 'equals': return sourceValue === value
    case 'not_equals': return sourceValue !== value
    case 'truthy': return Boolean(sourceValue && sourceValue !== 'false' && sourceValue !== '0')
    case 'falsy': return !sourceValue || sourceValue === 'false' || sourceValue === '0'
    default: return false
  }
}

// ── Completion Message ──────────────────────────────────────────

/**
 * B1 (lu-301/bau/klaerung-n7.md): what a SUCCESSFULLY finished run tells the
 * user (a run that stopped on a step failure never reaches this function;
 * see `describeWorkflowStepFailure` below, which is what `onStepError` now
 * shows instead).
 *
 * Both callers of this engine (`useAgentChat.ts`'s "run workflow" chat
 * trigger and `builtin-tools.ts`'s `run_workflow` tool) used to pick the
 * final message the same, slightly wrong way: `results.filter(r =>
 * r.output).pop()`, the LAST step with any output at all. For every
 * workflow that ends in `memory_save` (the built-in "Research Topic" among
 * them) that step's own receipt (`executeMemorySaveStep` below, "Saved to
 * memory: ...") is never empty by construction, so it always won `.pop()`
 * and buried the actual content, a `prompt` step's summary, the thing the
 * user sent the workflow to produce. A user who does not read the whole
 * chat history cannot tell that cryptic one-liner from a hang.
 *
 * This is the one place both callers now read the result from, instead of
 * each keeping its own near-identical copy. Rules:
 *   - Lead with a plain header naming how many of the workflow's steps ran,
 *     so "finished, short answer" never again looks like "stuck after one".
 *   - The content is the LAST step with non-empty output that is not a
 *     memory_save receipt: a receipt is shown ALONGSIDE the content, never
 *     INSTEAD of it.
 *   - No step produced any (non-receipt) output: say that plainly instead
 *     of ending on a bare header. This branch used to also cover a FAILED
 *     step (review-offload2.md Auflage 2.4 found that branch unreachable in
 *     production, since both callers already bail out of `onComplete`
 *     before this runs whenever a step failed; removed rather than kept
 *     alive only by its own test).
 */
export function describeWorkflowCompletion(workflow: AgentWorkflow, results: StepResult[]): string {
  const total = workflow.steps.length
  const ran = results.length
  const header = `Workflow complete (${ran}/${total} step${total === 1 ? '' : 's'}).`

  const stepTypeOf = (stepId: string) => workflow.steps.find((s) => s.id === stepId)?.type

  // Most recent first, so a later step's output wins over an earlier one's,
  // same as the old `.pop()` did, only now memory_save is excluded from
  // this pick rather than being the one type of step it always found first.
  const reversed = [...results].reverse()
  const content = reversed.find((r) => r.output && stepTypeOf(r.stepId) !== 'memory_save')
  const savedNote = reversed.find((r) => r.output && stepTypeOf(r.stepId) === 'memory_save')

  const lines = [header]
  if (content) {
    lines.push('', content.output)
  } else {
    lines.push('', 'No step produced any output to show.')
  }
  if (savedNote && savedNote !== content) {
    lines.push('', savedNote.output)
  }
  return lines.join('\n')
}

/**
 * B1 followup (Auflage 2.1, lu-301/bau/review-offload2.md): what a run that
 * STOPPED ON A FAILURE tells the user, said honestly with its position
 * ("Workflow stopped at step 2 of 6: ...") instead of the bare
 * "Workflow error: ..." both callers used to show, which read identically
 * whether step 1 or step 5 of a long chain had failed. `stepIndex` is
 * 0-based, as `onStepError` receives it; the message is 1-based, matching
 * how `describeWorkflowCompletion`'s own header counts steps.
 */
export function describeWorkflowStepFailure(workflow: AgentWorkflow, stepIndex: number, error: string): string {
  return `Workflow stopped at step ${stepIndex + 1} of ${workflow.steps.length}: ${error}`
}

// ── Engine ────────────────────────────────────────────────────

export class WorkflowEngine {
  private workflow: AgentWorkflow
  private conversationId: string
  private callbacks: WorkflowEngineCallbacks
  private variables: Record<string, string>
  private abortController: AbortController
  private inputResolver: ((input: string) => void) | null = null
  private depth: number
  private runsInHeldLane: HeldLocalLane | null
  /**
   * The gate every tool call this engine executes has to pass, whether from
   * a `tool` step or requested by the model inside a `prompt` step. Required,
   * with no default: a caller that forgets to wire one gets a compile error
   * instead of a silent, ungated `shell_execute` (same lesson as AGT-1's
   * `awaitApproval` on `ExecutorRuntime`, tool-executor.ts). A caller that
   * genuinely wants no gating passes `APPROVE_ALL` and thereby says so in
   * writing.
   */
  private approve: ApprovalGate
  /**
   * The proof this run itself hands to ITS OWN nested `run_workflow` or
   * (foreground) `delegate_task` tool step (second-degree nesting), set from
   * `runInLane`'s `held` callback argument once this run's own lane
   * admission resolves. `null` until then, and `null` forever on a cloud
   * lane, which never holds anything to ride along in. See run-slot.ts's
   * header, "DIE WEITERGABE DES ELTERNLAUF-TOKENS".
   */
  private heldLocalLane: HeldLocalLane | null = null
  /**
   * The REAL run this engine was started from, when one exists: the
   * `run_workflow` tool's own `AgentRunContext` (builtin-tools.ts), carrying
   * the actual conversation, `abortSignal`, `mode` and `readOnlyShellTurn` of
   * whoever called `run_workflow`. `undefined` for a top-level workflow
   * started from the "run workflow <name>" chat trigger, which already IS
   * the real conversation (`this.conversationId` itself is real there).
   * Without this, a nested `run_workflow` step used `this.conversationId`
   * (the fabricated lane-booking string `'tool-execution'`, see the `run()`
   * docstring below) as if it were a real conversation when building ITS OWN
   * child run context, so a further-nested `run_workflow` or `delegate_task`
   * step asked a question under a conversation id no window reads and lost
   * the parent's `abortSignal` entirely, a queued approval nobody could ever
   * answer or clean up (bau/review-wfgate.md Auflage 2). `effectiveOuterRun`
   * and `effectiveConversationId` below read this field instead of
   * hardcoding `this.conversationId` for that purpose.
   */
  private invokingRun?: AgentRunContext
  /**
   * A value for the FIRST `user_input` step to consume instead of waiting,
   * taken from `initialVariables.user_input` (see the constructor). Set once
   * at construction, consumed at most once, then cleared: only the first
   * `user_input` step in a run is meant to read the caller's own argument, a
   * second one still genuinely waits (bau/review-wfgate.md Auflage 6 /
   * ZUSATZFRAGE, `executeUserInputStep` below).
   */
  private prefilledUserInput?: string

  constructor(
    workflow: AgentWorkflow,
    conversationId: string,
    callbacks: WorkflowEngineCallbacks,
    /**
     * REQUIRED, see the field doc above. Pass tool-executor's `APPROVE_ALL`
     * to opt out explicitly; there is no implicit opt-out.
     */
    approve: ApprovalGate,
    initialVariables?: Record<string, string>,
    depth: number = 0,
    /**
     * This engine runs its steps INSIDE a parent run's already-booked lane
     * slot (the `run_workflow` tool, called from a tool step of an agent or
     * chat turn that already holds the lane, or from another workflow's own
     * tool step). See `run-slot.ts`'s header, section "DIE WEITERGABE DES
     * ELTERNLAUF-TOKENS": passed through unchanged to `runInLane`, which
     * checks it against the CURRENT lane holder at run time (Opus-Review
     * Runde 4, bau/review-w2lane.md, a boolean here used to be blind trust).
     * If the check fails, this run books its own place instead of hanging
     * behind a stale or fake proof. A top-level workflow (started from the
     * "run workflow <name>" chat trigger, the only surviving trigger since
     * the dead Settings play button was removed) is never nested, so it
     * leaves this at the default `null` and books its own slot from scratch.
     */
    runsInHeldLane: HeldLocalLane | null = null,
    /**
     * See the `invokingRun` field doc above. Only a `run_workflow` tool step
     * passes this (its own `AgentRunContext`, builtin-tools.ts); every other
     * caller leaves it `undefined` and this run's own `conversationId` is
     * already the real one.
     */
    invokingRun?: AgentRunContext,
  ) {
    if (!approve) {
      // Defense in depth behind the TS type: a caller reached from plain JS,
      // or one that spreads old positional args after a signature change,
      // gets a thrown error instead of `undefined` quietly skipping every
      // gate check below.
      throw new Error('WorkflowEngine requires an approve gate (ApprovalGate). Pass APPROVE_ALL from tool-executor.ts to opt out explicitly.')
    }
    this.workflow = workflow
    this.conversationId = conversationId
    this.callbacks = callbacks
    this.approve = approve
    this.variables = { ...workflow.variables, ...(initialVariables || {}) }
    this.abortController = new AbortController()
    this.depth = depth
    this.runsInHeldLane = runsInHeldLane
    this.invokingRun = invokingRun
    this.prefilledUserInput = initialVariables?.user_input
  }

  /**
   * The `AgentRunContext` to hand to a NESTED `run_workflow`/`delegate_task`
   * tool step (second-degree recursion). Built from `invokingRun` when this
   * engine itself was started from a real outer run, so the real
   * conversation, `mode`, `readOnlyShellTurn` and `abortSignal` reach a
   * further-nested call instead of this run's own lane-booking
   * `conversationId` (`'tool-execution'` on the `run_workflow` path, see the
   * `run()` docstring) standing in for a conversation no window reads
   * (bau/review-wfgate.md Auflage 2). Falls back to the pre-existing
   * `this.conversationId`-based shape for a top-level engine (the chat
   * trigger), where `this.conversationId` already IS the real conversation.
   */
  private effectiveOuterRun(): AgentRunContext {
    const base = this.invokingRun
    return {
      token: base?.token ?? `workflow-${this.conversationId}`,
      chatId: base?.chatId ?? null,
      conversationId: base?.conversationId ?? this.conversationId,
      workspace: base?.workspace ?? null,
      artifactMode: base?.artifactMode ?? false,
      readOnlyShellTurn: base?.readOnlyShellTurn ?? false,
      mode: base?.mode ?? null,
      execApproval: base?.execApproval,
      artifacts: base?.artifacts ?? [],
      // The real outer abortSignal when there is one, so Stop on the ORIGINAL
      // run reaches a call two levels deep too; this run's own controller
      // otherwise, so at least Stop on THIS run still reaches the child.
      abortSignal: base?.abortSignal ?? this.abortController.signal,
      heldLocalLane: this.heldLocalLane,
    }
  }

  /**
   * The conversation id to use for anything that should agree with the gate
   * (`buildWorkflowApprovalGate`, constructed from the same `invokingRun` by
   * `executeRunWorkflow`): the real outer conversation when this engine was
   * started from one, this run's own id otherwise. Fixes the split Auflage 5
   * describes: the prompt-step tool catalog used to read `this.conversationId`
   * ('tool-execution' on the `run_workflow` path) while the gate itself
   * already decided against the real conversation, so a per-conversation
   * override applied to one and not the other.
   */
  private effectiveConversationId(): string {
    return this.invokingRun?.conversationId ?? this.conversationId
  }

  /**
   * Gate one tool call through the same policy an agent-chat turn or a
   * delegated sub-agent already goes through (Nebenbefund,
   * bau/review-wfplay.md Teil B). Raced against this run's own abort signal
   * so Stop resolves a still-pending approval with `false` even if the
   * underlying gate's own promise (a real queued approval, say) never
   * settles on its own: the run must not hang on a click that is never
   * coming once Stop was pressed.
   */
  private async gatedApproval(
    toolName: string,
    args: ToolArgs,
    run: AgentRunContext | undefined,
  ): Promise<{ approved: true } | { approved: false; message: string }> {
    if (this.abortController.signal.aborted) {
      return { approved: false, message: `Cancelled: the run was stopped before ${toolName} could run.` }
    }
    const tool: ExecutorToolDef = toolRegistry.resolveExecutable(toolName) ?? { name: toolName }
    const req: ExecutionRequest = {
      id: `${this.conversationId}-${toolName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      toolName,
      args,
      run,
    }
    const approved = await Promise.race([
      this.approve(req, tool),
      new Promise<boolean>((resolve) => {
        this.abortController.signal.addEventListener('abort', () => resolve(false), { once: true })
      }),
    ])
    if (!approved) {
      return { approved: false, message: `Tool call rejected: ${toolName} was not approved.` }
    }
    return { approved: true }
  }

  /**
   * Run the workflow from start to finish.
   *
   * Lane admission (Folgeauftrag 1, review-lanes.md Runde 5): a prompt step
   * can run real inference against a local model (`executePromptStep` below),
   * same as any chat send, so an unbooked workflow used to run right next to
   * a local chat on the same one-slot engine. Booked ONCE for the whole run,
   * not per step: booking per step would have a workflow's own second step
   * queue behind its own first step's still-unreleased slot and lock the
   * workflow out of itself. Stop reaches both a WAITING and a RUNNING
   * workflow the same way `useChat`/`useAgentChat` do: `runInLane` registers
   * the abort handle before the body ever starts, so the queued case is
   * covered too, not just the running one.
   *
   * `conversationId: this.conversationId` DELIBERATELY, not a private
   * per-run identity (BLOCKER 3, Nachpruefung 2 von review-w2lane.md): a
   * workflow started from the "run workflow <name>" chat trigger shares its
   * visible conversation on purpose, it writes its step messages into that
   * same chat, so a queued workflow SHOULD show up there ("waiting for the local
   * lane") via `isRunQueued`/`runQueuePosition`. A private identity like the
   * sub-agent's would have fixed the abort-handle bug just as well but at
   * the cost of that legitimate wait-row attribution, per the review's own
   * comparison. The bug (a queued workflow's booking silently overwriting
   * and then erasing a live chat's own abort handle under the same
   * conversationId, so Stop on the chat killed the workflow instead) is
   * fixed at the root in `run-slot.ts` now: any normal booking there
   * remembers a foreign handle it finds already registered under the same
   * conversationId, chains Stop to reach both while they coexist, and
   * restores the foreign one instead of erasing it once this run ends. That
   * fix covers every caller sharing a conversationId, not just this one.
   */
  async run(): Promise<StepResult[]> {
    if (this.depth >= MAX_WORKFLOW_DEPTH) {
      throw new Error(`Maximum workflow nesting depth (${MAX_WORKFLOW_DEPTH}) exceeded`)
    }

    const results: StepResult[] = []
    const { activeModel } = useModelStore.getState()
    const lane = activeModel ? laneOf(activeModel, currentLaneFacts()) : 'cloud'

    const outcome = await runInLane(
      {
        conversationId: this.conversationId,
        lane,
        abort: () => this.abortController.abort(),
        runsInHeldLane: this.runsInHeldLane,
      },
      (held) => {
        // Own proof for a SECOND-degree nested run_workflow (a step of THIS
        // run calling run_workflow again): stored so executeToolStep can
        // hand it on, instead of that nested engine booking its own place
        // behind this one and hanging (see run-slot.ts's header).
        this.heldLocalLane = held
        return this.runSteps(results)
      },
    )

    if (outcome === 'cancelled-while-queued') {
      // The run never started: no step, no token, nothing to unwind.
      this.callbacks.onError('Cancelled before it could start: Stop was pressed while it was waiting for the local lane.')
    }

    return results
  }

  private async runSteps(results: StepResult[]): Promise<void> {
    let stepIndex = 0
    let executed = 0
    // B1 (bau/wfprogress.md Runde 2, Blocker): a run that Stop cancelled
    // BETWEEN two steps, or during a step that finished normally despite
    // the abort signal (a tool that does not itself watch it), used to
    // leave here with NO terminal callback at all: `onComplete` is gated
    // behind `!aborted` below, and `onError` only ever fired from the
    // `catch`. The chat trigger's progress block, which only ever leaves
    // 'running' inside `onStepComplete`/`onStepError`/`onComplete`/
    // `onError`, was measured staying on 'running' with its spinner
    // forever, persisted into the conversation as if the run were still
    // going (Final-Verifier repro: `CALLBACKS=["start0","complete0"]` after
    // `cancel()` mid step 1, nothing after). `stepLevelTerminalFired`
    // tracks whether THIS loop already reported a terminal outcome through
    // `onStepError` or the step-budget `onError` below; if the loop instead
    // ends because it was aborted and neither of those fired, `onStopped`
    // is the ONE remaining terminal callback, guaranteeing every run ends
    // in exactly one of onComplete / onStepError+onComplete / onError /
    // onStopped, never in silence.
    let stepLevelTerminalFired = false

    try {
      while (stepIndex < this.workflow.steps.length) {
        if (this.abortController.signal.aborted) break
        if (++executed > MAX_STEPS_EXECUTED) {
          this.callbacks.onError(`Workflow exceeded ${MAX_STEPS_EXECUTED} steps, check for a condition that branches back on itself`)
          stepLevelTerminalFired = true
          break
        }

        const step = this.workflow.steps[stepIndex]
        this.callbacks.onStepStart(stepIndex, step)

        const result = await this.executeStep(step, stepIndex)
        results.push(result)

        if (result.status === 'failed') {
          this.callbacks.onStepError(stepIndex, result.error || 'Unknown error')
          stepLevelTerminalFired = true
          break
        }

        this.callbacks.onStepComplete(stepIndex, result)

        // Set last_output for next step. A condition's "true"/"false" is a
        // branch marker, not data: letting it through replaced the previous
        // step's real output, so the next step's {{last_output}} interpolated
        // to the literal "true".
        if (result.output && step.type !== 'condition') {
          this.variables['last_output'] = result.output
        }

        // Handle branching, on the decision the step already made. Evaluating
        // the condition a second time here used to happen AFTER last_output had
        // been overwritten with that marker, so a condition reading last_output
        // (the default, and the only source the builder writes) compared
        // "true"/"false" against the user's value and always fell to the else
        // branch.
        if (step.type === 'condition' && step.condition) {
          const targetId = result.output === 'true' ? step.condition.thenStepId : step.condition.elseStepId
          const targetIndex = this.workflow.steps.findIndex(s => s.id === targetId)
          stepIndex = targetIndex >= 0 ? targetIndex : stepIndex + 1
        } else {
          stepIndex++
        }
      }

      if (this.abortController.signal.aborted) {
        if (!stepLevelTerminalFired) this.callbacks.onStopped?.(results)
      } else {
        this.callbacks.onComplete(results)
      }
    } catch (err) {
      const errorMsg = errorText(err) || 'Workflow execution failed'
      this.callbacks.onError(errorMsg)
    }
  }

  /**
   * Cancel the running workflow.
   */
  cancel() {
    this.abortController.abort()
  }

  /**
   * Provide user input for a waiting user_input step.
   *
   * bau/review-wfgate.md Runde 2, klein 3: neither surviving caller
   * (`run_workflow`'s `executeRunWorkflow`, the "run workflow <name>" chat
   * trigger) ever calls this, and both now refuse UP FRONT
   * (`executeUserInputStep` below, and the callers' own pre-checks) when a
   * workflow's FIRST `user_input` step has no prefilled answer, closing the
   * hang the review measured for all three built-in workflows. Kept rather
   * than deleted: a workflow with a SECOND `user_input` step still reaches
   * this exact wait after its first step consumes the one prefilled value
   * (see `workflow-user-input-vorbefuellt.test.ts`'s third case), a real,
   * if narrow, gap neither caller's up-front check catches, since it only
   * looks at whether the workflow has a question at all, not how many.
   * This method is the only way anything could ever answer that second
   * question; deleting it would turn a stoppable wait into a permanently
   * unanswerable one instead of closing it. It also still backs the lane
   * tests that use a `user_input` step purely as a controllable pause point
   * (`workflow-engine-lane.test.ts`, `background-shutdown-lanes.test.ts`),
   * unrelated to `user_input`'s own semantics: rebuilding those around a
   * different pausable step type instead is a fair follow-up, not done
   * here.
   */
  provideUserInput(input: string) {
    if (this.inputResolver) {
      this.inputResolver(input)
      this.inputResolver = null
    }
  }

  // ── Step Execution ────────────────────────────────────────

  private async executeStep(step: WorkflowStep, stepIndex: number): Promise<StepResult> {
    const startedAt = Date.now()

    try {
      switch (step.type) {
        case 'prompt':
          return await this.executePromptStep(step, startedAt, stepIndex)

        case 'tool':
          return await this.executeToolStep(step, startedAt)

        case 'condition':
          return this.executeConditionStep(step, startedAt)

        case 'loop':
          return await this.executeLoopStep(step, startedAt)

        case 'user_input':
          return await this.executeUserInputStep(step, stepIndex, startedAt)

        case 'memory_save':
          return this.executeMemorySaveStep(step, startedAt)

        default:
          return { stepId: step.id, status: 'failed', output: '', startedAt, error: `Unknown step type: ${step.type}` }
      }
    } catch (err) {
      return {
        stepId: step.id,
        status: 'failed',
        output: '',
        startedAt,
        completedAt: Date.now(),
        error: errorText(err) || 'Step execution failed',
      }
    }
  }

  // ── Prompt Step ───────────────────────────────────────────

  private async executePromptStep(step: WorkflowStep, startedAt: number, stepIndex: number): Promise<StepResult> {
    const { activeModel } = useModelStore.getState()
    if (!activeModel) throw new Error('No active model')

    const { strategy, modelToUse, provider } = await resolveToolCallingStrategy(activeModel)
    const prompt = interpolate(step.prompt || '', this.variables)

    const messages: ChatMessage[] = [
      { role: 'user', content: prompt },
    ]

    const { settings } = useSettingsStore.getState()
    // R5-10/R5-11: this run's own conversation may have its own sampling; a
    // field neither it nor the Settings page ever moved stays off the wire.
    const convSampling = useChatStore.getState().conversations.find(
      (c) => c.id === this.conversationId,
    )?.sampling
    const sampling = buildSamplingRequest(settings, convSampling)

    // Harter Befund von der Box (bau/wfprogress.md, 20.09.2026): a prompt step
    // sent none of `maxTokens`/`thinking`/`reasoningEffort`/`effortLevels`/
    // `effortDefault`, every field a normal chat/agent turn resolves before
    // calling the SAME provider (useAgentChat.ts's `chatOptions`, useCodex.ts's
    // `codexThinkMode`/`codexEffort`). Measured on the box: `llama-server`
    // /slots showed n_decoded 30090 at n_predict 31619 on a 32768 ctx, and the
    // run ended with "Workflow stopped at step 3 of 6: The model returned no
    // content for this prompt step.": the model spent the WHOLE budget
    // inside <think> and never reached an answer.
    //
    // klein 1 (Runde 2 review): `sampling.maxTokens` is 0/absent for every
    // user who never touched the Max tokens slider (`DEFAULT_SETTINGS.
    // maxTokens = 0`, and `buildSamplingRequest` omits a field still at the
    // app default): for THAT user, sending `maxTokens: sampling.maxTokens`
    // unchanged put `undefined` on the wire, same as before this fix, and
    // the OpenAI-compatible provider's own fallback
    // (`body.max_tokens = Math.min(headroom, 32768)`) would still ask for
    // the entire remaining context. `DEFAULT_PROMPT_STEP_MAX_TOKENS` (above)
    // is the real ceiling for that default case; a value the user or this
    // chat DID set always wins over it.
    //
    // klein 3 (Runde 2 review): a first version of this fix sent
    // `thinking: false` to EVERY model, including a catalogue "always
    // thinks" one, reasoning that a workflow step is mechanical, not a
    // conversation. But `openai-provider.ts`'s own measurement says
    // otherwise for that case: "on GLM 5.3 'none' does not stop the
    // thinking, it only stops the upstream from separating it ... costs
    // MORE than sending nothing". Asking an always-reasoning model to stop
    // cannot help it finish in time and can cost more while doing nothing.
    // The normal agent turn already has the right rule for this
    // (`canThinkAgent`/`thinkOpt`, useAgentChat.ts): an 'always'/'never'
    // model gets NO thinking wish at all (`undefined`), only a real
    // 'toggle' model gets an explicit true/false. Reused verbatim here,
    // with the workflow's own wish for a 'toggle' model always being "off",
    // since a step executes an instruction and does not hold a conversation that
    // benefits from visible deliberation. `DEFAULT_PROMPT_STEP_MAX_TOKENS`
    // plus the existing honest "no content" failure (below) are what still
    // catch a model that reasons regardless.
    const modelMeta = useModelStore.getState().models.find((m) => m.name === activeModel)
    const stepThinkMode = modelMeta && 'thinkMode' in modelMeta ? modelMeta.thinkMode : undefined
    const canThinkStep = stepThinkMode ? stepThinkMode === 'toggle' : isThinkingCompatible(activeModel)
    const effortLevels = modelMeta && 'effortLevels' in modelMeta ? modelMeta.effortLevels : undefined
    const effortDefault = modelMeta && 'effortDefault' in modelMeta ? modelMeta.effortDefault : undefined
    const userSetMaxTokens = sampling.maxTokens && sampling.maxTokens > 0
    const reasoningOptions = {
      thinking: canThinkStep ? false : undefined,
      reasoningEffort: settings.reasoningEffort,
      localEffortChosen: settings.localEffortChosen,
      effortLevels,
      effortDefault,
      maxTokens: userSetMaxTokens ? sampling.maxTokens : DEFAULT_PROMPT_STEP_MAX_TOKENS,
      // Runde 3 klein 1 (bau/wfprogress.md): tells openai-provider.ts's
      // unmeasured-context branch this is OUR fallback, not something the
      // user typed, so it stays off the wire there instead of being sent
      // uncapped to a server whose real window was never measured.
      maxTokensIsDefault: !userSetMaxTokens,
    }

    let output = ''

    if (step.allowedTools && step.allowedTools.length === 0) {
      // No tools — pure prompt. One transport for every strategy: without a
      // tool contract the hermes and native paths send the same plain chat,
      // and the provider abstraction routes it to the right server. The old
      // hermes branch here posted to Ollama unconditionally (G32b), which
      // 404s the moment the model lives on LM Studio.
      const stream = provider.chatStream(modelToUse, messages, {
        temperature: sampling.temperature,
        ...reasoningOptions,
        // A workflow runs in the agent window, in every step alike.
        window: 'agent',
        signal: this.abortController.signal,
      })
      for await (const chunk of stream) {
        if (chunk.content) {
          output += chunk.content
          // klein 3 (bau/wfprogress.md): relay the growing answer to whoever
          // is watching this run (the chat trigger's progress block), so a
          // long-thinking model shows LIVE text instead of a silent wait.
          this.callbacks.onStepProgress?.(stepIndex, output)
        }
        if (chunk.done) break
      }
    } else {
      // With tools. The catalog offered to the model is the user's OWN
      // permission store, not a fixed default (Nebenbefund, bau/review-
      // wfplay.md Teil B): `DEFAULT_PERMISSIONS` used to sit here, so a
      // category the user set to 'blocked' was invisible everywhere else in
      // the app yet still handed to the model in a workflow prompt step.
      // `effectiveConversationId()`, not `this.conversationId` (Auflage 5,
      // bau/review-wfgate.md): on the `run_workflow` path this run's own id
      // is the fabricated lane-booking string, so a per-conversation
      // override the user set on the REAL chat used to reach the gate's
      // decision but not this catalog, or the reverse.
      const permissions = usePermissionStore.getState().getEffectivePermissions(this.effectiveConversationId())
      // A workflow step has no card to confirm a settings change on (A11).
      const tools: ToolDefinition[] = toolRegistry.toOllamaTools(permissions).filter((t) => !isSelfControlToolName(t.function.name))
      const allowedTools = step.allowedTools
        ? tools.filter(t => step.allowedTools!.includes(t.function.name))
        : tools

      if (strategy === 'native') {
        const turn = await provider.chatWithTools(modelToUse, messages, allowedTools, {
          temperature: sampling.temperature,
          ...reasoningOptions,
          window: 'agent',
          signal: this.abortController.signal,
        })
        output = turn.content || ''
        // `chatWithTools` returns one turn, not a stream, so there is no
        // per-chunk progress to relay, but the field the block shows still updates
        // once this call resolves (onStepComplete carries the final output).

        // Execute any tool calls, gated the same as a tool step (see
        // executeToolStep below): the catalog above already hides a blocked
        // category from the model, but a model can still hallucinate a name
        // or ask for a 'confirm' tool the user has not approved yet.
        for (const tc of turn.toolCalls) {
          const gate = await this.gatedApproval(tc.function.name, tc.function.arguments, undefined)
          if (!gate.approved) throw new Error(gate.message)
          const result = await toolRegistry.execute(tc.function.name, tc.function.arguments)
          output += `\n[Tool: ${tc.function.name}] ${result}`
        }
      } else {
        // Hermes XML
        const hermesSystem = buildHermesToolPrompt(
          allowedTools.map(t => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            permission: 'auto' as const,
          }))
        )
        const hermesMessages = [{ role: 'system' as const, content: hermesSystem }, ...messages]
        // G32b: through the provider, not Ollama's /api/chat. hermes_xml is
        // reachable for LM Studio and friends now (a server-declared
        // tool-less model lands here), and those models are not installed in
        // Ollama, so the old chatNonStreaming call answered 404.
        const hermesTurn = await streamProviderTurn(
          provider,
          modelToUse,
          hermesMessages.map(m => ({ role: m.role, content: m.content })),
          {
            temperature: sampling.temperature,
            ...reasoningOptions,
            window: 'agent',
            signal: this.abortController.signal,
          },
          // klein 3: `streamProviderTurn` already streams under the hood
          // (it wraps `provider.chatStream`); relaying its cumulative
          // content is the same live-progress hookup the plain-prompt
          // branch above gets, just through this transport's own callback
          // instead of a hand-rolled for-await loop.
          (full) => this.callbacks.onStepProgress?.(stepIndex, full),
        )
        const rawContent = hermesTurn.content

        if (hasToolCallTags(rawContent)) {
          const toolCalls = parseHermesToolCalls(rawContent)
          output = stripToolCallTags(rawContent)
          for (const tc of toolCalls) {
            const gate = await this.gatedApproval(tc.name, tc.arguments, undefined)
            if (!gate.approved) throw new Error(gate.message)
            const result = await toolRegistry.execute(tc.name, tc.arguments)
            output += `\n[Tool: ${tc.name}] ${result}`
          }
        } else {
          output = rawContent
        }
      }
    }

    // Strip reasoning through the SHARED settlement (2.6.7 Denk-Audit,
    // Loch 5). This used to be a hand-written copy of the balanced-block
    // regex, so a pre-opened Qwen3 thought (closer without opener), a turn cut
    // off mid-thought and every non-canonical marker went straight into the
    // step output, which is not only shown: it becomes a workflow VARIABLE
    // and rides into every later step's prompt.
    output = settleThinking(output, '', false).content

    // Auflage 2.1 (lu-301/bau/review-offload2.md): a stream that ends with
    // no content (thinking stripped away, or the model answered nothing)
    // used to be `status: 'completed'` with `output: ''`. `runSteps` only
    // carries `last_output` forward on a non-empty output, so the NEXT step
    // silently kept working off whatever the step BEFORE this one produced,
    // with nothing to say a step had come up empty in between.
    if (!output.trim()) {
      return {
        stepId: step.id,
        status: 'failed',
        output: '',
        startedAt,
        completedAt: Date.now(),
        error: 'The model returned no content for this prompt step.',
      }
    }

    return {
      stepId: step.id,
      status: 'completed',
      output,
      startedAt,
      completedAt: Date.now(),
    }
  }

  // ── Tool Step ─────────────────────────────────────────────

  private async executeToolStep(step: WorkflowStep, startedAt: number): Promise<StepResult> {
    if (!step.toolName) throw new Error('Tool step missing toolName')

    // Build args from static + templates
    const args: ToolArgs = { ...(step.toolArgs || {}) }
    if (step.toolArgTemplates) {
      for (const [key, template] of Object.entries(step.toolArgTemplates)) {
        args[key] = interpolate(template, this.variables)
      }
    }

    // A tool step calling run_workflow OR delegate_task is second-degree
    // nesting: hand it the REAL outer run context (`effectiveOuterRun`, see
    // its doc above), not a context built from this run's own
    // `conversationId`, which is the fabricated lane-booking string
    // `'tool-execution'` on the `run_workflow` path (bau/review-wfgate.md
    // Auflage 2: a further-nested call used to ask under that fake id,
    // unreachable by any window and never cleaned up on Stop, since it also
    // carried no `abortSignal`). `effectiveOuterRun` still carries THIS run's
    // own `heldLocalLane` proof (null on a cloud lane, or before this run's
    // own admission resolved), so a FOREGROUND nested run rides along
    // instead of booking its own place behind this one and hanging
    // (Nachpruefung, bau/review-w2lane.md, "Sub-Agent im Workflow").
    // `delegate_task`'s BACKGROUND branch is `void`-fired and never awaited
    // by this step, so it cannot deadlock this loop either way. Every other
    // tool keeps its long-standing `run: undefined` (unchanged scope: only
    // these two recursive tools read `heldLocalLane`).
    const runForTool: AgentRunContext | undefined = step.toolName === 'run_workflow' || step.toolName === 'delegate_task'
      ? this.effectiveOuterRun()
      : undefined

    const gate = await this.gatedApproval(step.toolName, args, runForTool)
    if (!gate.approved) {
      return {
        stepId: step.id,
        status: 'failed',
        output: '',
        startedAt,
        completedAt: Date.now(),
        error: gate.message,
        toolCalls: [{ name: step.toolName, args, result: gate.message }],
      }
    }

    const result = await toolRegistry.execute(step.toolName, args, 1, runForTool)
    const isError = result.startsWith('Error:')

    return {
      stepId: step.id,
      status: isError ? 'failed' : 'completed',
      output: result,
      startedAt,
      completedAt: Date.now(),
      error: isError ? result : undefined,
      toolCalls: [{ name: step.toolName, args, result }],
    }
  }

  // ── Condition Step ────────────────────────────────────────

  private executeConditionStep(step: WorkflowStep, startedAt: number): StepResult {
    if (!step.condition) throw new Error('Condition step missing condition')

    const matches = evaluateCondition(
      step.condition.source,
      step.condition.operator,
      interpolate(step.condition.value, this.variables),
      this.variables
    )

    return {
      stepId: step.id,
      status: 'completed',
      output: matches ? 'true' : 'false',
      startedAt,
      completedAt: Date.now(),
    }
  }

  // ── Loop Step ─────────────────────────────────────────────

  private async executeLoopStep(step: WorkflowStep, startedAt: number): Promise<StepResult> {
    if (!step.loop) throw new Error('Loop step missing loop config')

    let iterations = 0
    const outputs: string[] = []

    while (iterations < Math.min(step.loop.maxIterations, MAX_LOOP_ITERATIONS)) {
      if (this.abortController.signal.aborted) break

      // Execute body steps
      for (const bodyStepId of step.loop.bodyStepIds) {
        const bodyStep = this.workflow.steps.find(s => s.id === bodyStepId)
        if (!bodyStep) continue

        const bodyResult = await this.executeStep(bodyStep, -1)
        if (bodyResult.output) {
          this.variables['last_output'] = bodyResult.output
          outputs.push(bodyResult.output)
        }
        if (bodyResult.status === 'failed') {
          return { stepId: step.id, status: 'failed', output: outputs.join('\n'), startedAt, completedAt: Date.now(), error: bodyResult.error }
        }
      }

      // Check exit condition
      const shouldContinue = evaluateCondition(
        step.loop.condition.source,
        step.loop.condition.operator,
        interpolate(step.loop.condition.value, this.variables),
        this.variables
      )
      if (!shouldContinue) break

      iterations++
    }

    return {
      stepId: step.id,
      status: 'completed',
      output: outputs.join('\n'),
      startedAt,
      completedAt: Date.now(),
    }
  }

  // ── User Input Step ───────────────────────────────────────

  private async executeUserInputStep(step: WorkflowStep, stepIndex: number, startedAt: number): Promise<StepResult> {
    // ZUSATZFRAGE / Auflage 6, bau/review-wfgate.md: all three built-in
    // workflows (Research Topic, Summarize URL, Code Review) begin with a
    // `user_input` step, and neither surviving caller ever calls
    // `provideUserInput` below (`onWaitingForInput: () => {}` in both
    // builtin-tools.ts's `executeRunWorkflow` and useAgentChat.ts's chat
    // trigger), so every one of them used to hang here forever, waiting on a
    // resolver nothing can reach except Stop. `run_workflow` already turns
    // its own `input` argument into the `user_input` variable
    // (builtin-tools.ts's `initialVars`), so the FIRST `user_input` step can
    // read it directly instead of waiting. Consumed at most once: a second
    // `user_input` step in a custom workflow still genuinely waits, since
    // only one caller-supplied value exists. Runde 2 fix (klein 1/2,
    // bau/review-wfgate.md): both callers now refuse UP FRONT, before this
    // engine even starts, when a workflow has a `user_input` step and no
    // answer was given at all, so THIS wait branch is unreachable through
    // either surviving caller for that case; only a workflow with a SECOND
    // `user_input` step (after the first already consumed the one supplied
    // value) still reaches it, see `provideUserInput`'s own doc comment.
    if (this.prefilledUserInput !== undefined) {
      const input = this.prefilledUserInput
      this.prefilledUserInput = undefined
      this.variables['user_input'] = input
      this.variables['last_output'] = input
      return {
        stepId: step.id,
        status: 'completed',
        output: input,
        startedAt,
        completedAt: Date.now(),
      }
    }

    const prompt = interpolate(step.userInputPrompt || 'Enter input:', this.variables)
    this.callbacks.onWaitingForInput(stepIndex, prompt)

    const input = await new Promise<string>((resolve) => {
      this.inputResolver = resolve

      // Also resolve on abort
      const onAbort = () => {
        resolve('')
        this.abortController.signal.removeEventListener('abort', onAbort)
      }
      this.abortController.signal.addEventListener('abort', onAbort)
    })

    if (this.abortController.signal.aborted) {
      return { stepId: step.id, status: 'failed', output: '', startedAt, error: 'Cancelled' }
    }

    this.variables['user_input'] = input
    this.variables['last_output'] = input

    return {
      stepId: step.id,
      status: 'completed',
      output: input,
      startedAt,
      completedAt: Date.now(),
    }
  }

  // ── Memory Save Step ──────────────────────────────────────

  private executeMemorySaveStep(step: WorkflowStep, startedAt: number): StepResult {
    if (!step.memorySave) throw new Error('Memory save step missing config')

    const title = interpolate(step.memorySave.titleTemplate, this.variables)
    const content = interpolate(step.memorySave.contentTemplate, this.variables)

    useMemoryStore.getState().addMemory({
      type: step.memorySave.type,
      title: title.substring(0, 60),
      description: content.substring(0, 120),
      content,
      tags: step.memorySave.tags || ['workflow'],
      source: this.conversationId,
    })

    return {
      stepId: step.id,
      status: 'completed',
      output: `Saved to memory: ${title}`,
      startedAt,
      completedAt: Date.now(),
    }
  }
}
