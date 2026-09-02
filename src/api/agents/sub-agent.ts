/**
 * Phase 13 (v2.4.0) — Sub-agent delegation.
 *
 * Exposes a `delegate_task` builtin tool that spawns a nested ReAct loop
 * with a sub-goal, its own isolated AgentBudget, and the same tool
 * registry minus `delegate_task` itself (so a sub-agent cannot fork-bomb
 * a tree of delegations).
 *
 * Depth is capped at 2 globally — a sub-agent that attempts to call
 * delegate_task returns a refusal string. Combined with the tool-list
 * filtering, the model has no syntactically valid path to recurse.
 */

import { settleThinking } from '../../lib/thinking-stripper'
// M7 / Audit W-T2: hier stand zweimal `await import('../mcp')`. Gesplittet hat
// das nie — die Tonne mcp/index.ts hängt über useAgentChat, useCodex und
// api/tool-registry.ts ohnehin statisch im Graph, also meldete Rolldown
// INEFFECTIVE_DYNAMIC_IMPORT. Der import() war auch nie fürs Splitten da,
// sondern um den Zyklus mcp/index → builtin-tools → sub-agent → mcp/index zu
// brechen.
//
// Die ehrliche Auflösung ist ein statischer Import auf das Modul, das hier
// wirklich gebraucht wird, statt auf die Tonne: `mcp/tool-registry` hält den
// Singleton und importiert selbst nichts aus diesem Cluster (seit die
// retired-Kante invertiert ist), der Zyklus entsteht also gar nicht erst.
// Die Registrierung der Builtins ist dabei garantiert schon gelaufen: beide
// Einstiegspunkte dieser Datei hängen am `delegate_task`-Executor, den erst
// registerBuiltinTools() verdrahtet.
import { toolRegistry } from '../mcp/tool-registry'
import type { MCPToolDefinition, ToolArgs } from '../mcp/types'
import type { ChatMessage } from '../providers/types'
import type { AgentToolCall } from '../../types/agent-mode'
import type { ApprovalEntry } from '../../lib/approval-queue'
import {
  executeParallel,
  type ExecutionRequest,
  type ApprovalGate,
  type AuditRecorder,
} from './tool-executor'
import type { AgentRunContext } from '../agent-context'
import { AgentBudget } from './budget'
import { explainError as explainToolError } from './error-hints'
import { platformPromptLine, hostClockLine } from '../../lib/host-platform'
import { clampTaskResult, describeToolCalls, makeTaskId } from '../../lib/agent-tasks'
import { MAX_EXPLICIT_FANOUT } from '../../lib/agent-fanout'

// NOTE: the toolRegistry import is done LAZILY inside defaultSubAgentRunner
// to avoid a circular dependency with src/api/mcp/builtin-tools.ts, which
// pulls DELEGATE_TASK_TOOL_DEF + buildDelegateExecutor from this file at
// module init.

// Recursion note: a sub-agent's tool list is filtered so it never SEES
// `delegate_task`, which is what discourages nesting in practice. It is not a
// hard block — the runner resolves over the full registry — but the in-flight
// concurrency cap below (SUB_AGENT_MAX_PARALLEL) plus each sub-agent's tight
// budget bound the blast radius. (A former SUB_AGENT_MAX_DEPTH constant claimed
// to enforce a depth limit but was never read; removed in 2.5.9. The design
// deliberately uses one in-flight counter as the concurrency gate rather than a
// separate nesting-depth counter, so parallel siblings are not throttled.)

/**
 * Max sub-agents in flight at the same time (Bonus, 2026-05). Parallel
 * siblings let the model fan out research tasks — e.g. "for each of these
 * 4 files, summarize the public surface" — without the historic serial
 * pressure from the depth counter doubling as a concurrency gate.
 */
export const SUB_AGENT_MAX_PARALLEL = 4

/**
 * Tight caps so a sub-agent cannot runaway inside the parent's budget.
 *
 * Ab 2.6.8 die VORGABE, nicht mehr das Gesetz: `resolveSubAgentBudget()` liest
 * die Einstellungen und faellt auf diese Zahlen zurueck. Sie bleiben trotzdem
 * hier stehen und werden nicht durch DEFAULT_SETTINGS ersetzt — dieses Modul
 * laeuft in Tests ohne Store, und ein Sub-Agent ohne Kappe ist genau das, was
 * die Kappe verhindern soll.
 */
export const SUB_AGENT_BUDGET = { maxToolCalls: 10, maxIterations: 5 } as const

/**
 * Die Kappen fuer EINEN delegierten Lauf.
 *
 * 0 heisst hier "nimm die Vorgabe" und nicht "unbegrenzt" — anders als bei den
 * Kappen des Hauptlaufs. Der Unterschied ist kein Versehen: beim Hauptlauf
 * sitzt der Nutzer davor und kann Stop druecken, ein Sub-Agent laeuft ohne
 * Zuschauer. Unbegrenztheit soll man dort nicht aus Versehen einstellen
 * koennen, indem man ein Feld leert.
 */
export function resolveSubAgentBudget(s?: {
  subAgentMaxToolCalls?: number
  subAgentMaxIterations?: number
}): { maxToolCalls: number; maxIterations: number } {
  const zahl = (v: unknown, vorgabe: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : vorgabe
  return {
    maxToolCalls: zahl(s?.subAgentMaxToolCalls, SUB_AGENT_BUDGET.maxToolCalls),
    maxIterations: zahl(s?.subAgentMaxIterations, SUB_AGENT_BUDGET.maxIterations),
  }
}

export const DELEGATE_TASK_TOOL_DEF: MCPToolDefinition = {
  name: 'delegate_task',
  description:
    'Spawn a focused sub-agent to work on a sub-goal autonomously. '
    + 'USE for self-contained research or analysis tasks that would pollute the main conversation with tool-call chatter. '
    // Die Zahlen sind seit 2.6.8 einstellbar, also duerfen sie hier nicht mehr
    // als Tatsache stehen. Eine Beschreibung, die "max 10" sagt, waehrend die
    // Einstellung auf 3 steht, ist keine Hilfe fuer das Modell, sondern eine
    // Falschauskunft — es plant dann Teilziele, die es nie zu Ende bringt.
    // Der echte Wert erreicht das Modell dort, wo er zaehlt: in
    // AgentBudget.haltMessage(), wenn die Kappe wirklich greift.
    // "Klein halten" stand hier frueher unmittelbar neben der neuen Bitte um
    // einen AUSFUEHRLICHEN Auftrag — fuer ein 3B-Modell zwei Anweisungen, die
    // sich widersprechen, und es befolgt dann die kuerzere. Die beiden meinen
    // verschiedene Achsen: der UMFANG bleibt schmal, die BESCHREIBUNG wird
    // lang. Genau so steht es jetzt da, in einem Satz statt in zweien.
    + 'Its tool budget is tight: keep the SCOPE narrow, the brief detailed. '
    + 'PARALLELIZE: emit multiple delegate_task tool calls in the SAME assistant turn '
    + 'to fan out (e.g. one sub-agent per file) — up to 4 run concurrently. '
    // Die Rueckgabeform wird ABSICHTLICH nicht mehr angekuendigt. Am
    // 02.09.2026 gemessen: ein 4B-Modell, dem gesagt wurde, der Aufruf liefere
    // „a task id at once", hat die Antwort ERFUNDEN statt das Werkzeug zu
    // rufen — „Task ID: t12345, Status: Background task initiated". Wer einem
    // schwachen Modell das Ergebnis beschreibt, gibt ihm eine Vorlage zum
    // Halluzinieren. Was der Aufruf zurueckgibt, erfaehrt es beim Aufrufen.
    + 'DO NOT call from inside another delegate_task — recursion is filtered by the harness. '
    + 'NOT a replacement for a regular tool call when one direct tool would do.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        // "Ein Satz" war die falsche Anweisung, und zwar aus dem Grund, der
        // hier am schwersten zu sehen ist: der Sub-Agent teilt das Gespraech
        // NICHT. Er sieht nicht, was der Nutzer wollte, nicht die Dateien, die
        // schon offen waren, nicht die drei Fehlversuche davor. Ein Satz ist
        // fuer den Aufrufer vollstaendig, weil er den Rest im Kopf hat — beim
        // Empfaenger kommt eine Aufgabe ohne Grundlage an, und er sucht sich
        // die Haelfte davon nochmal zusammen, aus einem Budget, das dafuer
        // nicht reicht. Die Task-Beschreibung der Claude-Code-Desktop-App
        // verlangt an genau dieser Stelle das Gegenteil von Kuerze.
        description:
          'A detailed, self-contained brief: what to do and what to report back. '
          + 'The sub-agent does NOT see this conversation — anything you leave out, '
          + 'it cannot look up. Several sentences are right here; one line is too little.',
      },
      context: {
        type: 'string',
        description:
          'Facts the sub-agent needs but should not spend tool calls rediscovering: '
          + 'file paths already found, values already read, what was already ruled out.',
      },
      model: {
        type: 'string',
        // "Use the exact id you were given" hat am 02.09.2026 im laufenden
        // Fenster genau das Gegenteil bewirkt: qwen2.5-coder:7b schickte den
        // PLATZHALTER `"your-model-id"` mit, die Delegation lief gar nicht
        // erst los und der Nutzer bekam statt einer Antwort eine Fehlermeldung
        // samt Modelliste. Ein Feld, das nach einer Kennung fragt, bekommt von
        // einem kleinen Modell eine erfundene — es sei denn, das Weglassen
        // steht ausdruecklich und zuerst da.
        description:
          'OMIT unless the user named another model. Never a placeholder — '
          + 'only an id copied verbatim from the user or your installed list.',
      },
      background: {
        type: 'boolean',
        description:
          'Run without waiting; the answer arrives on a later turn. '
          + 'USE for work that takes a while and is not needed for your very next sentence.',
      },
    },
    required: ['goal'],
  },
  category: 'workflow',
  source: 'builtin',
}

/**
 * In-flight counter — module-scoped so parallel siblings + nested
 * children share one bound. Reset only by successful return or thrown
 * error; see the try/finally in the executor.
 *
 * Pre-Bonus this was named `_depth` and doubled as a concurrency gate,
 * which made three parallel siblings impossible. Now strictly counts
 * concurrent sub-agents; the description forbids recursion and the
 * registry filter enforces it.
 */
let _inFlight = 0

/** Exposed for tests. */
export function _getDepth(): number {
  return _inFlight
}
/** Exposed for tests. */
export function _setDepth(n: number): void {
  _inFlight = n
}

export type SubAgentRunner = (
  goal: string,
  context: string,
  options: { budget: AgentBudget; run?: AgentRunContext; taskId?: string; model?: string }
) => Promise<string>

/**
 * The sub-agent system prompt, in the same two halves the main loops use
 * (2.6.6, plan A5 and E3).
 *
 * A sub-agent runs the same tool registry on the same machine, so it needs the
 * same environment block: the platform sentence tells it which shell
 * shell_execute will open and how to open a file, and the clock line replaces
 * the retired clock tool. Without them a delegated step spent its tiny budget
 * probing the machine, or guessed `explorer` on a Mac.
 *
 * The order is the point. The role text and the platform sentence read the
 * same on every delegation, so they stay in front and a prefix cache can match
 * them. The clock changes every minute and closes the message, where a miss
 * costs only the last line instead of the whole prompt.
 */
export function buildSubAgentSystemPrompt(
  platformLine: string = platformPromptLine(),
  clockLine: string = hostClockLine(),
): string {
  const stable =
    'You are a focused sub-agent. Work autonomously toward the goal. '
    + 'Be concise, return a direct final answer without filler. '
    + 'Do NOT attempt to call delegate_task; it is not available to you.'
  return `${stable}\n\n${platformLine}\n\n${clockLine}`
}

/**
 * The gates a delegated tool call has to pass. Same three the parent loop
 * installs on its own executeParallel call, resolved for the sub-run.
 */
export interface SubAgentGates {
  awaitApproval: ApprovalGate
  recordAudit?: AuditRecorder
  abortSignal?: AbortSignal
  /**
   * id → why the gate said no, for refusals that are NOT a user clicking
   * reject. The executor's generic 'User rejected tool call' would otherwise
   * tell the sub-agent's model a story that never happened.
   */
  refusals: Map<string, string>
}

/**
 * Build the gates for one delegated run (audit AGT-1).
 *
 * A sub-agent runs a full ReAct loop over the whole tool registry minus
 * delegate_task — shell_execute, file_write and file_edit included, all three
 * 'confirm' by default. Until 2.6.7 it called executeParallel with getTool +
 * execute + explainError and NOTHING else: no approval gate (the executor's
 * was optional and therefore skipped), no audit trail, no abort signal. One
 * approved delegate_task bought an unattended, unlogged, uninterruptible
 * shell. Threading `run` (plan 2.6.6 C1) did not fix that: the run context
 * carries the conversation, workspace, artifact and read-only flags, so it
 * scopes WHERE a tool writes and whether shell_execute is read-only — it never
 * asked the user anything.
 *
 * The gates are resolved here rather than handed down from the hook on
 * purpose. All three live in module-scoped, conversation-keyed state (the
 * approval FIFO, the audit store, the permission store), so the run's
 * conversation id is enough to reach the SAME queue the parent loop uses —
 * the pending approval surfaces in the same UI, the tool call lands in the
 * same audit list. The parent's own awaitApproval closure could not be reused:
 * it resolves a request id against the batch it was built for and answers
 * "true" for anything it does not recognise, so a sub-agent's id would sail
 * straight through it.
 *
 * Fail closed: with no conversation to ask in, a 'confirm' tool is refused
 * rather than run.
 */
export async function buildSubAgentGates(run?: AgentRunContext): Promise<SubAgentGates> {
  const convId = run?.conversationId ?? null
  const abortSignal = run?.abortSignal
  const refusals = new Map<string, string>()

  const [{ usePermissionStore }, approvals] = await Promise.all([
    import('../../stores/permissionStore'),
    import('../../lib/approval-queue'),
  ])

  const awaitApproval: ApprovalGate = async (req) => {
    if (abortSignal?.aborted) {
      refusals.set(req.id, 'Aborted: the user stopped the run before this delegated tool call ran.')
      return false
    }
    const perm = usePermissionStore.getState()
    const level = toolRegistry.getPermissionLevelWithOverrides(
      req.toolName,
      perm.getEffectivePermissions(convId ?? undefined),
      perm.perToolOverrides,
    )
    if (level === 'blocked') {
      refusals.set(req.id, `Blocked: ${req.toolName} is not permitted in this conversation.`)
      return false
    }
    if (level === 'auto') return true
    // 'confirm' — the user decides, in the conversation that owns this run.
    if (!convId) {
      refusals.set(
        req.id,
        `Blocked: ${req.toolName} needs confirmation and this delegated run has no conversation to ask in.`,
      )
      return false
    }
    return new Promise<boolean>((resolve) => {
      const toolCall: AgentToolCall = {
        id: req.id,
        toolName: req.toolName,
        args: req.args,
        status: 'pending_approval',
        timestamp: Date.now(),
      }
      const entry: ApprovalEntry = { toolCall, resolve }
      approvals.enqueueApproval(convId, entry)
      // Stop has to answer a question nobody clicked, or the delegation (and
      // with it the parent turn) waits forever — same lesson as audit A4.
      abortSignal?.addEventListener(
        'abort',
        () => {
          if (approvals.removeApproval(convId, entry)) {
            refusals.set(req.id, 'Aborted: the user stopped the run while this tool call awaited approval.')
            resolve(false)
          }
        },
        { once: true },
      )
    })
  }

  if (!convId) return { awaitApproval, abortSignal, refusals }

  const { useToolAuditStore } = await import('../../stores/toolAuditStore')
  const auditIds = new Map<string, string>()
  const recordAudit: AuditRecorder = (entry) => {
    if (entry.kind === 'start') {
      auditIds.set(
        entry.id,
        useToolAuditStore.getState().record({
          convId,
          toolCallId: entry.id,
          toolName: entry.toolName,
          args: entry.args,
          startedAt: entry.startedAt,
          parentToolCallId: entry.parentToolCallId,
        }),
      )
      return
    }
    const aid = auditIds.get(entry.id)
    if (!aid) return
    useToolAuditStore.getState().complete(aid, {
      status: entry.status,
      completedAt: entry.completedAt,
      resultPreview: entry.resultPreview,
      error: entry.error,
      errorHint: entry.errorHint,
      cacheHit: entry.cacheHit,
    })
  }

  return { awaitApproval, recordAudit, abortSignal, refusals }
}

/**
 * Default sub-agent runner. Pulls in the active provider + model via
 * dynamic import to keep this module standalone and testable with a
 * stub runner. The real hook wiring lives in buildDelegateExecutor().
 */
export async function defaultSubAgentRunner(
  goal: string,
  context: string,
  options: { budget: AgentBudget; run?: AgentRunContext; taskId?: string; model?: string }
): Promise<string> {
  const { useModelStore } = await import('../../stores/modelStore')
  const { getProviderForModel } = await import('../providers')
  const { resolveRequestedModel } = await import('../../lib/agent-fanout')
  const store = useModelStore.getState()
  const activeModel = store.activeModel

  // Ein anderes Modell als das eigene, wenn der Aufruf eines nennt.
  //
  // Der Auftrag vom 02.09.2026: "glm 5.3 aktiv und der prompt sagt nutze 5 glm
  // 5.2 agenten ... soll das genau so passieren". Bis dahin nahm ein
  // Sub-Agent immer das aktive Modell, ohne dass es irgendwo stand.
  //
  // Ein NICHT gefundener Wunsch faellt hier bewusst NICHT still auf das aktive
  // Modell zurueck, sondern bricht ab. "Nimm glm 5.2" mit qwen zu beantworten
  // und nichts zu sagen ist die schlimmste der drei moeglichen Antworten: es
  // sieht aus wie Erfolg, kostet volle Rechenzeit und liefert etwas anderes,
  // als der Nutzer angeordnet hat.
  let laufmodell = activeModel
  if (options.model) {
    const treffer = resolveRequestedModel(options.model, store.models)
    if (!treffer) {
      const da = store.models.slice(0, 6).map((m) => m.name).join(', ')
      return `Error: the model "${options.model}" is not installed here, so this sub-agent did not run.`
        + (da ? ` Installed: ${da}.` : '')
    }
    laufmodell = treffer.name
  }
  if (!laufmodell) return 'Error: No active model configured.'
  const { provider, modelId } = getProviderForModel(laufmodell)

  const tools: MCPToolDefinition[] = toolRegistry
    .getAll()
    .filter((t) => t.name !== DELEGATE_TASK_TOOL_DEF.name)

  const llmTools = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))

  // The sub-agent's own conversation — data this file writes, so it gets the
  // declared type `provider.chatWithTools` reads rather than a guard.
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSubAgentSystemPrompt(),
    },
    {
      role: 'user',
      content: context ? `Goal: ${goal}\n\nContext:\n${context}` : `Goal: ${goal}`,
    },
  ]

  // Approval + audit + Stop for every tool this sub-run fires (AGT-1).
  const gates = await buildSubAgentGates(options.run)

  // Der Store nur, wenn diese Delegation wirklich eine sichtbare Aufgabe ist.
  // Ein Vordergrundlauf aus einem Test hat keine, und dann darf hier auch
  // nichts danach greifen.
  const tasks = options.taskId
    ? (await import('../../stores/agentTaskStore')).useAgentTaskStore
    : null

  let finalContent = ''
  // Die Schleifengrenze kommt aus DEMSELBEN Budget, das auch zaehlt. Vorher
  // stand hier die Konstante, waehrend `options.budget` die eingestellte Kappe
  // trug — zwei Zahlen fuer eine Regel, und die stillere haette gewonnen.
  const maxIterations = options.budget.snapshot().caps.maxIterations || SUB_AGENT_BUDGET.maxIterations
  for (let i = 0; i < maxIterations; i++) {
    if (gates.abortSignal?.aborted) {
      return finalContent || '(sub-agent stopped by the user)'
    }

    // Post vom Hauptagenten, oben in der Iteration gelesen und als
    // NUTZER-Turn angehaengt. Nicht als System-Nachricht: die darf nur an
    // Index 0 stehen, sonst weisen strenge Jinja-Vorlagen sie ab. Und nicht
    // als Werkzeugantwort: die braeuchte eine echte tool_call_id.
    if (tasks && options.taskId) {
      const post = tasks.getState().drainInbox(options.taskId)
      for (const m of post) {
        messages.push({ role: 'user', content: `Message from the main agent:\n${m}` })
      }
    }

    options.budget.addIteration()
    if (tasks && options.taskId) {
      tasks.getState().update(options.taskId, { iterations: i + 1, activity: 'thinking' })
    }
    const ex = options.budget.exceeded()
    if (ex.kind !== 'none') {
      return `${options.budget.haltMessage()} ${finalContent || '(no partial answer)'}`
    }
    const turn = await provider.chatWithTools(modelId, messages, llmTools, {})
    // What a sub-agent returns becomes a TOOL RESULT in the parent's context,
    // so leaked reasoning floods the run it was supposed to shorten (2.6.7
    // Denk-Audit, Loch 11). Same settlement as every visible surface.
    const settled = settleThinking(turn.content || '', '', false).content
    finalContent = settled || finalContent
    if (!turn.toolCalls || turn.toolCalls.length === 0) break

    options.budget.addToolCalls(turn.toolCalls.length)
    if (tasks && options.taskId) {
      const bisher = tasks.getState().get(options.taskId)?.toolCalls ?? 0
      tasks.getState().update(options.taskId, {
        toolCalls: bisher + turn.toolCalls.length,
        // Die NAMEN, nicht die Argumente: siehe AgentTask.activity. Die drei
        // Regeln dahinter (doppelte zusammenfassen, namenlose nicht
        // verschweigen, kappen) stehen in describeToolCalls und werden dort
        // geprueft — hier liefe kein Test dagegen.
        activity: describeToolCalls(turn.toolCalls.map((tc) => tc.function?.name)),
      })
    }
    const requests: ExecutionRequest[] = turn.toolCalls.map((tc, idx) => ({
      id: `sub-${Date.now()}-${idx}`,
      toolName: tc.function.name,
      args: tc.function.arguments,
      parentToolCallId: 'sub-agent',
      // A sub-agent inherits its parent's run, so its tool calls are gated by
      // the same conversation and mode instead of whatever the process-wide
      // singleton happens to hold (plan 2.6.6 C1).
      run: options.run,
    }))
    const registry = toolRegistry
    const results = await executeParallel(
      requests,
      {
        getTool: (name) => registry.resolveExecutable(name),
        execute: (name: string, args: ToolArgs, callRun?: AgentRunContext) =>
          registry.execute(name, args, 1, callRun),
        explainError: (toolName, err) => explainToolError(toolName, err),
        // The three gates the nested loop used to run without.
        awaitApproval: gates.awaitApproval,
        recordAudit: gates.recordAudit,
      },
      { abortSignal: gates.abortSignal },
    )

    messages.push({ role: 'assistant', content: turn.content || '', tool_calls: turn.toolCalls })
    // Map each result back to its ORIGINATING call by index. executeParallel
    // preserves input order (results[i] <-> requests[i] <-> turn.toolCalls[i]),
    // so zipping by index gives every tool message the correct tool_call_id —
    // even when the turn fired the same tool twice. The previous find-by-name
    // matched the FIRST call for both duplicates, leaving the second call's id
    // with no result; strict OpenAI-compatible providers (lu-cloud/DeepInfra,
    // openai, anthropic) then 400/422'd on the next turn and delegate_task
    // aborted. The main loop already handles this the same way (useCodex.ts).
    results.forEach((r, i) => {
      messages.push({
        role: 'tool',
        // A gate refusal explains itself; only a real user rejection falls
        // through to the executor's own wording.
        //
        // GEKAPPT, seit 2.6.8: dieser Lauf legte Werkzeugergebnisse roh ab,
        // anders als beide Hauptschleifen (die fahren truncateToolResult).
        // Solange das Gespraech mit dem Zug starb, war das nur teuer; seit es
        // fuer eine Fortsetzung im Store liegen kann, waere ein 4-MB-Protokoll
        // aus einem file_read eine Zeile, die niemand mehr loswird.
        content: clampTaskResult(
          r.result ?? gates.refusals.get(r.id) ?? r.error ?? '(no output)',
        ),
        tool_call_id: turn.toolCalls[i]?.id,
      })
    })

    if (tasks && options.taskId) {
      tasks.getState().update(options.taskId, { messages: [...messages] })
    }
  }

  return finalContent || '(sub-agent produced no final answer)'
}

/**
 * Build a tool executor suitable for toolRegistry.registerBuiltin. The
 * runner is injectable so tests can stub the whole LLM round-trip.
 */
export function buildDelegateExecutor(
  runner: SubAgentRunner = defaultSubAgentRunner
): (args: ToolArgs, run?: AgentRunContext) => Promise<string> {
  return async (args: ToolArgs, run?: AgentRunContext) => {
    const kappe = effectiveParallelCap(run?.conversationId)
    if (_inFlight >= kappe) {
      return `Error: Maximum sub-agent concurrency (${kappe}) reached. Wait for a running sub-agent to finish, or continue the task yourself.`
    }
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
    if (!goal) return 'Error: delegate_task requires a "goal" argument.'
    const context = typeof args.context === 'string' ? args.context.trim() : ''
    const background = args.background === true
    const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined

    // ZWISCHEN Pruefung und Hochzaehlen darf kein `await` liegen.
    //
    // Genau das hatte die erste Fassung dieser Aenderung: sie holte erst die
    // Einstellungen (ein dynamisches import(), also ein Mikrotask) und zaehlte
    // danach hoch. Fuenf gleichzeitige Aufrufe kamen damit alle an der
    // Schranke vorbei, bevor der erste sie erhoehte, und die Kappe war weg.
    // Gefangen von 'a 5th parallel sibling is refused' — eine Sperrklinke,
    // die seit 2.5.x still gruen dastand und in dem Moment gebissen hat, in
    // dem sie gebraucht wurde. Die Reihenfolge hier ist die ganze Regel:
    // pruefen, zaehlen, DANN erst irgendetwas awaiten.
    _inFlight++

    let budget: AgentBudget
    try {
      const { useSettingsStore } = await import('../../stores/settingsStore')
      budget = new AgentBudget(resolveSubAgentBudget(useSettingsStore.getState().settings))
    } catch {
      // Ohne Einstellungen die Vorgabe, statt den Lauf zu verlieren.
      budget = new AgentBudget({ ...SUB_AGENT_BUDGET })
    }

    if (!background) {
      try {
        return await runner(goal, context, { budget, run, model })
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      } finally {
        _inFlight--
      }
    }

    // ── Hintergrund ──────────────────────────────────────────────────────
    const convId = run?.conversationId
    if (!convId) {
      _inFlight--
      // Fail closed: ohne Konversation gibt es kein Panel, keinen
      // Abbrechen-Knopf und keinen Weg, das Ergebnis je zu melden. Ein
      // unsichtbarer Hintergrundagent waere schlimmer als keiner.
      return 'Error: background delegation needs a conversation to report back to. Run this one in the foreground instead (omit background).'
    }

    const { useAgentTaskStore } = await import('../../stores/agentTaskStore')
    const id = makeTaskId(_taskSeq++)
    const controller = new AbortController()
    // ── Stopp auf die Hauptantwort laesst Hintergrundagenten LAUFEN ─────────
    //
    // Hier wurde das Abbruchsignal des Elternzugs durchgereicht. Fuer einen
    // Vordergrundagenten ist das richtig — der Elternzug wartet ja auf ihn —,
    // und dort passiert es weiterhin von selbst, weil der unveraenderte
    // `run` mitsamt seinem Signal weitergegeben wird. Dieser Block hier
    // gehoert aber ausschliesslich dem Hintergrundfall, und da war es falsch:
    //
    //   Der Nutzer bestellt drei Hintergrund-Recherchen, die Hauptantwort
    //   schweift ab, er drueckt Stopp — und bekommt drei abgebrochene Agenten
    //   samt halber Ergebnisse. Er wollte den Satz stoppen, nicht die Arbeit.
    //
    // Genau das trennt die Claude-Code-Desktop-App: Esc beendet die Antwort,
    // die Hintergrundagenten laufen weiter und werden einzeln in ihrer eigenen
    // Liste gestoppt. Beide Griffe dafuer gibt es hier: der Abbrechen-Knopf an
    // jeder Zeile im Panel und "Stop every running agent" im Kopf.
    //
    // Was WEITERHIN abbricht — und der Grund, warum diese Zeile ueberhaupt
    // gestrichen werden durfte: das Loeschen oder Schliessen des Chats.
    // `dropConversationSideState` ruft `clearConv`, und das bricht laufende
    // Aufgaben ab, bevor es sie vergisst. Ein Agent ohne Chat haette niemanden
    // mehr, dem er berichten koennte.

    useAgentTaskStore.getState().start({
      // `controller` MUSS mit. Die erste Fassung erzeugte ihn zwei Zeilen
      // weiter oben und uebergab ihn nicht — der Abbrechen-Knopf im Panel
      // waere fuer JEDE Hintergrundaufgabe tot gewesen, und nichts haette es
      // gemeldet: `cancel` gibt bei fehlendem Griff still `false` zurueck.
      // Gefunden, weil der Store ihn seither als Pflicht fuehrt.
      id, convId, goal, context, background: true, startedAt: Date.now(), controller,
    })
    // Der Lauf bekommt das AbortSignal der AUFGABE, nicht das des Elternzugs:
    // sonst liesse sich eine einzelne Aufgabe nicht abbrechen, ohne den
    // ganzen Zug mitzunehmen.
    const kindLauf: AgentRunContext | undefined = run
      ? { ...run, abortSignal: controller.signal }
      : undefined

    void runner(goal, context, { budget, run: kindLauf, taskId: id, model })
      .then((output) => {
        const abgebrochen = controller.signal.aborted
        useAgentTaskStore.getState().finish(id, {
          status: abgebrochen ? 'cancelled' : 'done',
          output,
          endedAt: Date.now(),
        })
        void meldeInDenVerlauf(convId, id, goal, abgebrochen ? 'cancelled' : 'done', output)
      })
      .catch((err) => {
        const grund = err instanceof Error ? err.message : String(err)
        useAgentTaskStore.getState().finish(id, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          error: grund,
          endedAt: Date.now(),
        })
        void meldeInDenVerlauf(convId, id, goal, controller.signal.aborted ? 'cancelled' : 'failed', grund)
      })
      // HIER faellt der Zaehler, nicht wenn der Aufruf zurueckkehrt — und
      // genau darin lag die zweite Falle, die eine Entwurfskritik am
      // 02.09.2026 aufgedeckt hat. Das urspruengliche try/finally umschloss
      // `await runner(...)`. Eine Hintergrundaufgabe kehrt sofort zurueck,
      // also waere der Platz freigegeben, waehrend der Agent noch rechnet —
      // SUB_AGENT_MAX_PARALLEL waere fuer genau den Pfad tot gewesen, der ihn
      // am noetigsten braucht. Der Zaehler gehoert an das Leben der AUFGABE.
      .finally(() => { _inFlight-- })

    return `Started background task ${id}. It runs on its own; its answer will reach you on a later turn. `
      + `Use check_tasks to look it up, or message_agent to send it more instructions. Carry on with something else in the meantime.`
  }
}

/**
 * Eine Zeile im Verlauf, wenn eine Hintergrundaufgabe fertig ist.
 *
 * DAS LOCH, DAS SIE STOPFT: die Meldung an das MODELL laeuft ueber
 * `appendTaskReport`, und das steht oben in der ReAct-Schleife. Endet eine
 * Aufgabe, NACHDEM der Elternzug vorbei ist — der Normalfall bei einer
 * Hintergrundaufgabe, sie laeuft ja laenger —, gibt es keine Schleife mehr,
 * die sie abholt. Bis zur naechsten Nachricht des Nutzers erfuhr niemand
 * etwas: nicht das Modell und, wenn das Panel zugeklappt war, auch nicht der
 * Mensch. Ein Agent hatte gearbeitet und niemand sah es.
 *
 * Als App-Hinweis (`role:'system'` mit `notice`) und NICHT als
 * Assistentenblase: das Modell hat diesen Satz nicht gesagt. Die Nutzlast
 * verwirft `role:'system'`, der Verlauf zeigt ihn — genau der Mechanismus,
 * den auch `/compact` benutzt.
 *
 * Was hier ABSICHTLICH NICHT passiert: es wird kein Modellzug gestartet. Die
 * Claude-Code-Desktop-App weckt ihren Hauptagenten von selbst; hier waere das
 * eine Inferenz, die der Nutzer nicht angefordert hat — auf einem Laptop mit
 * lokalem Modell eine spuerbare Minute Rechnerei ohne Frage. Der Mensch sieht
 * das Ergebnis sofort, das Modell bekommt es beim naechsten Zug ueber
 * `takeUnreported`, das die Aufgabe bis dahin als ungemeldet fuehrt.
 */
async function meldeInDenVerlauf(
  convId: string,
  taskId: string,
  goal: string,
  status: 'done' | 'failed' | 'cancelled',
  text: string,
): Promise<void> {
  try {
    const { useChatStore } = await import('../../stores/chatStore')
    const wort = status === 'done' ? 'finished' : status
    const leib = text.trim()
    useChatStore.getState().addMessage(convId, {
      id: `bg-${taskId}`,
      role: 'system',
      notice: status === 'failed' ? 'warn' : 'info',
      content: `Background agent [${taskId}] ${wort}: ${goal}${leib ? `\n${leib}` : ''}`,
      timestamp: Date.now(),
    })
  } catch {
    // Der Verlauf ist die Kuer, nicht die Pflicht: der Store hat das Ergebnis
    // schon, und das Panel zeigt es. Hier zu werfen hiesse, eine gelungene
    // Aufgabe an ihrer Benachrichtigung scheitern zu lassen.
  }
}

/** Laufende Nummer fuer Aufgaben-Kennungen. Modulzustand, wie _inFlight. */
let _taskSeq = 1

/**
 * Wie viele Agenten der NUTZER fuer diese Konversation ausdruecklich verlangt
 * hat. Leer, solange niemand eine Zahl genannt hat.
 *
 * SUB_AGENT_MAX_PARALLEL (4) bleibt die Vorgabe fuer das, was ein MODELL von
 * sich aus faechern darf — sie bremst eine Fan-out-Schleife, die niemand
 * bestellt hat. Sagt der Nutzer „nutze 5 agenten", ist dieselbe 4 keine
 * Sicherheitsgrenze mehr, sondern eine Bevormundung: er hat die Zahl genannt,
 * und die App weiss es nicht besser.
 *
 * Je Konversation und nicht global, damit ein „nutze 8" in einem Chat nicht
 * die Schranke eines anderen aufhebt. Nicht persistiert: es beschreibt einen
 * Satz, keine Vorliebe.
 */
const explizitesFaecher = new Map<string, number>()

export function setExplicitFanout(convId: string | undefined | null, count: number): void {
  if (!convId) return
  if (count > 0) explizitesFaecher.set(convId, count)
  else explizitesFaecher.delete(convId)
}

/** Nur fuer Tests. */
export function _clearExplicitFanout(): void {
  explizitesFaecher.clear()
}

/** Die Schranke, die fuer DIESEN Lauf gilt. */
export function effectiveParallelCap(convId?: string | null): number {
  const gewuenscht = convId ? explizitesFaecher.get(convId) ?? 0 : 0
  return Math.max(SUB_AGENT_MAX_PARALLEL, Math.min(gewuenscht, MAX_EXPLICIT_FANOUT))
}
