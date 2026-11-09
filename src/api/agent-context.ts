/**
 * Per-agent-run chat context — maps the currently executing agent loop
 * back to the conversation it belongs to. Lets the built-in tool
 * executors (`file_read`, `file_write`, `execute_code`, `shell_execute`)
 * thread a `chatId` through to the Rust side WITHOUT changing their
 * public args shape or polluting the tool JSON schema the model sees.
 *
 * How it flows:
 *   1. useAgentChat / useCodex → setActiveChatId(convId)
 *      at the start of their agent loop.
 *   2. Tool executors in `src/api/mcp/builtin-tools.ts` → backendCall
 *      includes `{ chatId: getActiveChatId() }` in the request body.
 *   3. Rust tool commands resolve relative paths against
 *      `~/agent-workspace/<chatId>/`, so every chat gets its own
 *      isolated workspace folder, created lazily on first write.
 *
 * When unset (standalone tool calls outside an agent loop), Rust falls
 * back to `~/agent-workspace/default/` so nothing ever lands in the
 * legacy shared folder.
 */

import type { AgentWorkspace } from '../types/agent-workspace'
import type { HeldLocalLane } from '../lib/run-lanes'
import { pathKey } from '../lib/dev-fs-jail'

/**
 * Duplication-proof state carrier (v2.5.3 live E2E find, 2026-06-11).
 *
 * The rolldown-based Vite 8 build DUPLICATES this small module: the App
 * chunk inlines its own copy (used by useAgentChat/useCodex) while the
 * async mcp/vram-handoff graph imports the separate agent-context chunk.
 * Proven live on the release build: the hook's setActiveAgentModel wrote
 * copy A while vramHandoffGenerate's getActiveAgentModel read copy B —
 * always null — so VRAM eviction silently never ran, and the builtin
 * tools' chatId/workspace scoping read nulls the same way (grep the dist
 * for the `noid` slug literal: it appears in TWO chunks).
 *
 * Plain `let` module state is therefore NOT a singleton here. Parking the
 * state on `globalThis` makes every bundled copy share one store, whatever
 * the chunker decides. Do not "simplify" this back to module-level lets.
 */
/** A file the model "wrote" in plain-chat artifact mode (never hit disk). */
export interface CapturedArtifact {
  name: string
  content: string
  mime: string
}
/**
 * The context of ONE agent run, threaded explicitly (plan 2.6.6 C1,
 * ERZWINGUNG / blocker S3).
 *
 * The singleton below is still here for callers outside a loop, but it can
 * never be the ENFORCEMENT point: two runs are reachable from the UI at once
 * (a Codex run survives the tab switch, a second Codex conversation frees the
 * send, the Chat/Agent send is not locked). With only the global, a Bypass run
 * B flipped the read-only flag of a Plan run A mid-run, B's cleanup nulled A's
 * workspace, A's todo_write landed in the wrong conversation, and a chat
 * artifact run captured Codex writes.
 *
 * So every run gets its own object, the hook hands it to the executor, the
 * executor hands it to the tool, and the tool's gate reads ITS run. Nothing
 * about run B can be observed by a tool call belonging to run A.
 */
export interface AgentRunContext {
  /** Unique per run. Ownership token for the singleton mirror below. */
  token: string
  /** Epoch ms of the start. A stop of computer control binds every run that was already going. */
  startedAt?: number
  chatId: string | null
  conversationId: string | null
  workspace: AgentWorkspace | null
  artifactMode: boolean
  readOnlyShellTurn: boolean
  /**
   * Coding-agent preset this run started under ('ask' | 'bypass' | 'plan'),
   * null off the Code tab. Carried so a gate can name the reason it refused.
   */
  mode: string | null
  /**
   * Die Freigabe-Entscheidung dieses Laufs, EINMAL beim Start aufgeloest
   * (Auftrag 2.3, 04.09.2026).
   *
   * `confirmExec` ist codexModeKnobs().confirmExec, also die Antwort auf "fragt
   * dieser Lauf vor Werkzeugen mit beliebiger Ausfuehrung nach". Alles, was der
   * Lauf delegiert, liest DIESEN Wert, statt die Rechnung mit eigenen Eingaben
   * noch einmal aufzumachen. Zwei Rechnungen fuer dieselbe Frage waren hier
   * schon zweimal die Fehlerursache.
   *
   * `cloudReason` ist die Begruendung, die auf der Freigabekarte steht, und sie
   * entscheidet mit, welche Einstellung ein "stop asking" ausschaltet. Sie
   * gehoert deshalb zum LAUF und nicht zum Unteragenten, der ein anderes
   * Modell fahren kann als der Hauptlauf.
   *
   * Wird wie `abortSignal` nach `beginAgentRun` gesetzt: die Knoepfe stehen
   * erst fest, wenn Provider und Einstellungen gelesen sind. Fehlt das Feld,
   * gilt "nicht fragen", was genau der Vorgabe von useCodex entspricht.
   */
  execApproval?: { confirmExec: boolean; cloudReason: boolean }
  artifacts: CapturedArtifact[]
  /**
   * Stop button of the run that owns this context (audit AGT-1).
   *
   * The hook creates its AbortController after beginAgentRun, so it assigns
   * this afterwards. Everything a NESTED loop starts — today that is
   * delegate_task's sub-agent — reads it from here, because a sub-agent that
   * keeps running tools after the user pressed Stop is the same bug as a tool
   * batch that keeps dispatching after Stop. Undefined on surfaces that do not
   * thread yet; those simply cannot be interrupted mid-delegation.
   */
  abortSignal?: AbortSignal
  /**
   * A run that stays open while the user decides what to ask next: a voice
   * session is one run from Start to Stop. That such a run is open does not
   * mean it is working on anything (see `isAgentRunOpen`).
   */
  standing?: boolean
  /**
   * Der Beweis fuer `run-slot.ts`s `runsInHeldLane` (Opus-Review Runde 4,
   * bau/review-w2lane.md): gesetzt, sobald DIESER Lauf die lokale Spur
   * wirklich haelt (`null` fuer einen Cloud-Lauf, der keine haelt). Ein
   * verschachtelter Aufruf, der in diesem Platz mitfahren will (der
   * `run_workflow`-Werkzeugaufruf, der Vordergrund-Sub-Agent), reicht genau
   * dieses Feld an `runInLane` weiter, statt zu behaupten, es gebe einen
   * Platz. `undefined` auf Flaechen, die noch nicht threaden (siehe
   * `abortSignal`): so ein Aufruf kann nur normal buchen, nie mitfahren.
   */
  heldLocalLane?: HeldLocalLane | null
  /**
   * This surface draws the confirmation card of set_setting in its tool calls
   * (A11): the chat, Agent and Code. Unset for a voice session, a workflow and
   * every caller outside a loop, so a change of an app setting there is
   * refused instead of waiting for a card nobody sees. A sub-agent inherits
   * its parent's run and is refused in sub-agent.ts by name.
   */
  settingsCard?: boolean
  /**
   * A long tool says how far it is, in one short line. Set by a surface that
   * can pass it on while the call runs (the voice session hands it to the
   * model's context). Undefined elsewhere; a tool calls it and never needs it.
   */
  onToolProgress?: (text: string) => void
  /**
   * The tool call that is running, as the surface knows it (the id of its card
   * in the conversation). Set per call by the executor, see `runForCall`.
   */
  toolCallId?: string
  /**
   * Who owns a generation this call starts, in vram-handoff's cancel book.
   * Unset: the conversation, so the turn's Stop reaches it. Set for a call
   * that may go on in the background (lib/background-tools.ts): a Stop of a
   * later turn in the same chat must not cancel it.
   */
  generationOwner?: string
  /**
   * C60 S3: the first tool of this run whose output came from outside LU (a
   * web page, a file, a sub-agent). Set by the executor (lib/run-taint.ts),
   * read by the self-control tools before they show a card.
   */
  taint?: { tool: string; at: number }
  /** C60: cards the self-control tools showed in this run, capped there. */
  selfControlCards?: number
}

/**
 * The run as one tool call sees it: the same object, plus the id of the call.
 * A view and not a copy, because tools write to the run (its workspace, its
 * artifacts) and read fields the hook sets after the start; both must reach
 * the one run object.
 */
export function runForCall(run: AgentRunContext, toolCallId: string): AgentRunContext {
  return new Proxy(run, {
    get: (target, key, receiver) => (key === 'toolCallId' ? toolCallId : Reflect.get(target, key, receiver)),
    has: (target, key) => key === 'toolCallId' || Reflect.has(target, key),
  })
}

interface AgentCtxState {
  /** Token of the run that currently owns the singleton mirror. */
  runToken: string | null
  chatId: string | null
  /** The conversation this loop belongs to, VERBATIM. Distinct from `chatId`,
   *  which is a filesystem-safe workspace SLUG derived from id + title. Any UI
   *  state a tool writes (the todo_write plan) has to be keyed by the real id,
   *  because that is what the components read from chatStore. Keying it by the
   *  slug means the tool writes somewhere nothing ever looks. */
  conversationId: string | null
  workspace: AgentWorkspace | null
  model: ActiveAgentModel | null
  /** Chat-tools artifact mode: when true, file_write captures instead of
   *  writing to disk, so plain chat shows files inline (ChatGPT-style). */
  artifactMode: boolean
  readOnlyShellTurn: boolean
  artifacts: CapturedArtifact[]
}
const _g = globalThis as typeof globalThis & { __LU_AGENT_CTX?: AgentCtxState }
const ctx: AgentCtxState = _g.__LU_AGENT_CTX ?? (_g.__LU_AGENT_CTX = { runToken: null, chatId: null, conversationId: null, workspace: null, model: null, artifactMode: false, readOnlyShellTurn: false, artifacts: [] })

let _runSeq = 0

/**
 * Open a run context and mirror it into the singleton for every caller that
 * does not thread (standalone tool calls, older surfaces). Returns the object
 * the caller must pass down to its tool calls.
 */
/** Runs between beginAgentRun and endAgentRun. */
const openRuns = new Set<string>()

/**
 * The last runs of each conversation, newest last (C60 S3). The self-control
 * tools ask whether the run BEFORE this one read foreign content: when the
 * user answers "ja" to the model's own question, the question must not have
 * come out of a web page. Only in memory: after a restart there is no earlier
 * run, and the answer is "unknown", which counts as foreign.
 */
const runsByConversation = new Map<string, AgentRunContext[]>()

function rememberRun(run: AgentRunContext): void {
  if (!run.conversationId) return
  const list = [...(runsByConversation.get(run.conversationId) ?? []), run].slice(-3)
  runsByConversation.set(run.conversationId, list)
}

/**
 * Work that has to wait until this run is over (C60): a model switch or an
 * engine restart in the middle of the agent's own run would take the engine
 * from under the run that asked for it. Runs at once when the run is already
 * closed, or when there is no run.
 */
const afterRunJobs = new Map<string, (() => unknown)[]>()

export function afterAgentRun(run: AgentRunContext | null | undefined, job: () => unknown): 'now' | 'after-run' {
  if (!run || !openRuns.has(run.token)) {
    void Promise.resolve().then(job).catch(() => {})
    return 'now'
  }
  afterRunJobs.set(run.token, [...(afterRunJobs.get(run.token) ?? []), job])
  return 'after-run'
}

/** The run of this conversation that started before `token`, if this app
 *  session saw it. */
export function previousRunOf(conversationId: string | null, token: string): AgentRunContext | undefined {
  if (!conversationId) return undefined
  const list = runsByConversation.get(conversationId) ?? []
  const i = list.findIndex((r) => r.token === token)
  return i > 0 ? list[i - 1] : undefined
}

/** Is this run still going? False for a token no run was opened with. */
export function isAgentRunOpen(token: string | null | undefined): boolean {
  return !!token && openRuns.has(token)
}

export function beginAgentRun(init: {
  chatId?: string | null
  conversationId?: string | null
  workspace?: AgentWorkspace | null
  artifactMode?: boolean
  readOnlyShellTurn?: boolean
  mode?: string | null
  settingsCard?: boolean
}): AgentRunContext {
  _runSeq += 1
  const run: AgentRunContext = {
    token: `run-${Date.now().toString(36)}-${_runSeq}`,
    startedAt: Date.now(),
    chatId: init.chatId ? String(init.chatId) : null,
    conversationId: init.conversationId ? String(init.conversationId) : null,
    workspace: normalizeWorkspace(init.workspace),
    artifactMode: init.artifactMode === true,
    readOnlyShellTurn: init.readOnlyShellTurn === true,
    mode: init.mode ?? null,
    artifacts: [],
    ...(init.settingsCard ? { settingsCard: true } : {}),
  }
  openRuns.add(run.token)
  rememberRun(run)
  ctx.runToken = run.token
  ctx.chatId = run.chatId
  ctx.conversationId = run.conversationId
  ctx.workspace = run.workspace
  ctx.artifactMode = run.artifactMode
  ctx.readOnlyShellTurn = run.readOnlyShellTurn
  ctx.artifacts = run.artifacts
  return run
}

/**
 * Close a run. The singleton is only cleared when THIS run still owns it, so a
 * short Bypass run that started and finished inside a long Plan run cannot
 * strip the Plan run's workspace or read-only flag on its way out.
 */
export function endAgentRun(run: AgentRunContext | null | undefined): void {
  if (!run) {
    clearActiveChatId()
    return
  }
  run.artifacts = []
  openRuns.delete(run.token)
  const after = afterRunJobs.get(run.token)
  if (after) {
    afterRunJobs.delete(run.token)
    // After the close, so a job that starts a new run (a model switch, an
    // engine restart) does not race the run that asked for it.
    for (const job of after) queueMicrotask(() => { void Promise.resolve().then(job).catch(() => {}) })
  }
  if (ctx.runToken !== run.token) return
  clearActiveChatId()
}

/** Read a field from the run when one was threaded, else from the singleton. */
function pick<K extends keyof AgentCtxState & keyof AgentRunContext>(
  run: AgentRunContext | null | undefined,
  key: K,
): AgentRunContext[K] | AgentCtxState[K] {
  return run ? run[key] : ctx[key]
}

/**
 * The text model driving the current agent loop. Pinned by useAgentChat right
 * after setActiveWorkspace, read by the VRAM hand-off orchestrator (Feature EE)
 * to know which model to evict-then-reload around a ComfyUI generation.
 *
 *   - `name`       — the resolved model id actually sent to the provider (the
 *                    `-agent` variant when one exists), so a reload hits the
 *                    same runner the chat was using.
 *   - `providerId` — 'ollama' | 'openai' | 'anthropic' | … Cloud providers hold
 *                    no local VRAM, so the orchestrator skips all juggling.
 *   - `remote`     — true when the Ollama base points at a non-local host (LAN /
 *                    Docker / cluster). A remote Ollama also holds no LOCAL VRAM,
 *                    so likewise skip.
 */
export interface ActiveAgentModel {
  name: string
  providerId: string
  remote: boolean
}

export function setActiveChatId(id: string | null | undefined): void {
  ctx.chatId = id ? String(id) : null
}

export function getActiveChatId(run?: AgentRunContext | null): string | null {
  return pick(run, 'chatId')
}

export function setActiveConversationId(id: string | null | undefined): void {
  ctx.conversationId = id ? String(id) : null
}

export function getActiveConversationId(run?: AgentRunContext | null): string | null {
  return pick(run, 'conversationId')
}

export function setActiveAgentModel(model: ActiveAgentModel | null | undefined): void {
  ctx.model = model && model.name ? { name: model.name, providerId: model.providerId, remote: !!model.remote } : null
}

export function getActiveAgentModel(): ActiveAgentModel | null {
  return ctx.model
}

export function clearActiveChatId(): void {
  ctx.runToken = null
  ctx.chatId = null
  ctx.conversationId = null
  ctx.workspace = null
  ctx.model = null
  ctx.artifactMode = false
  ctx.readOnlyShellTurn = false
  ctx.artifacts = []
}

// ── Read-only turn (2.6.6 tool merge, plan E4 point 1) ─────────
//
// /review and Code-Review Mode used to strip the mutating tools BY NAME and
// keep the typed inspectors (git_status, git_diff, …). Those names are gone;
// the one terminal stays in the catalog and this flag makes its EXECUTOR the
// gate: only commands the conservative read-only classifier accepts run while
// it is set. Set at run start by useCodex, cleared in its finally.

export function setReadOnlyShellTurn(on: boolean): void {
  ctx.readOnlyShellTurn = !!on
}

export function isReadOnlyShellTurn(run?: AgentRunContext | null): boolean {
  return pick(run, 'readOnlyShellTurn')
}

// ── Chat-tools artifact mode (2026-06-12) ────────────────
//
// In PLAIN chat, "file writes" must behave like ChatGPT: the content is shown
// IN the chat with a preview + download, never silently dumped to a folder.
// useChat flips this on for the chat-tools run; executeFileWrite then captures
// {name, content, mime} here instead of calling fs_write, and useAgentChat
// drains the captures into the assistant message as `artifacts`. The Coding
// Agent and full Agent mode leave this OFF and keep writing to disk.

export function setChatArtifactMode(on: boolean): void {
  ctx.artifactMode = !!on
  if (!on) ctx.artifacts = []
}

export function isChatArtifactMode(run?: AgentRunContext | null): boolean {
  return pick(run, 'artifactMode')
}

export function captureChatArtifact(
  name: string,
  content: string,
  mime: string,
  run?: AgentRunContext | null,
): void {
  const sink = run ? run.artifacts : ctx.artifacts
  sink.push({ name, content, mime })
}

/** Return the captured artifacts and clear the buffer (drain). */
export function takeChatArtifacts(run?: AgentRunContext | null): CapturedArtifact[] {
  if (run) {
    const taken = run.artifacts
    run.artifacts = []
    // The singleton mirrors the same array while this run owns it, so hand it
    // a fresh one instead of leaving the drained reference behind.
    if (ctx.runToken === run.token) ctx.artifacts = []
    return taken
  }
  const out = ctx.artifacts
  ctx.artifacts = []
  return out
}

// ── Multi-Repo Agent (Sprint C #8 from the web app) ──────────────────
//
// When the agent loop runs in a 'folder' workspace (vs the per-chat
// sandbox), the bridge resolves relative paths against `ws.path` and
// the system prompt advertises any additional repo paths in `extraPaths`
// so the model can address them by absolute path. Use case: "sync the
// API in repo-A with the client in repo-B" — primary = repo-A,
// extras = [repo-B].

/**
 * Pin the active workspace for the current agent loop. Called by
 * useAgentChat / useCodex right after setActiveChatId. Sandbox mode
 * passes null so the bridge falls back to ~/agent-workspace/<slug>/.
 */
export function normalizeWorkspace(ws: AgentWorkspace | null | undefined): AgentWorkspace | null {
  if (ws && ws.kind === 'folder' && ws.path) {
    // Defensive: filter out blanks + dedupe extras + drop the primary if
    // a caller accidentally listed it as both. Keeps the public shape
    // stable for downstream readers (system prompt + chatCtx).
    //
    // R2-41: the dedupe used to compare raw strings, so `D:\code` and
    // `d:/CODE/` counted as two different paths. `pathKey` (dev-fs-jail.ts)
    // is the same normalization the actual containment check uses.
    const primaryKey = pathKey(ws.path)
    const seenKeys = new Set<string>()
    const cleanedExtras = Array.isArray(ws.extraPaths)
      ? ws.extraPaths
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          .filter((p) => {
            const key = pathKey(p)
            if (key === primaryKey || seenKeys.has(key)) return false
            seenKeys.add(key)
            return true
          })
      : []
    return {
      kind: 'folder',
      path: ws.path,
      extraPaths: cleanedExtras.length > 0 ? cleanedExtras : undefined,
    }
  }
  // Sandbox (or unset) leaves the pointer null so the bridge falls back to its
  // own per-chat sandbox path. Setting it to { kind: 'sandbox' } would just
  // duplicate state the bridge already owns.
  return null
}

export function setActiveWorkspace(
  ws: AgentWorkspace | null | undefined,
  run?: AgentRunContext | null,
): void {
  const normalized = normalizeWorkspace(ws)
  if (run) {
    run.workspace = normalized
    // Mirror only while this run owns the singleton, so a second run cannot
    // repoint a first run's jail root (plan C1 ERZWINGUNG).
    if (ctx.runToken === run.token) ctx.workspace = normalized
    return
  }
  ctx.workspace = normalized
}

export function getActiveWorkspace(run?: AgentRunContext | null): AgentWorkspace | null {
  return pick(run, 'workspace')
}

/**
 * Render the workspace section appended to the agent / Codex system
 * prompt. Empty string when the loop is in sandbox mode (the bridge
 * already knows its own sandbox path — no need to tell the model).
 */
export function renderWorkspaceSection(ws: AgentWorkspace | null): string {
  if (!ws || ws.kind !== 'folder' || !ws.path) return ''
  const extras = ws.extraPaths ?? []
  if (extras.length === 0) {
    return `\n\nPrimary workspace: ${ws.path}`
  }
  const lines = [
    '',
    '',
    'Workspaces (relative paths resolve against the primary; address extras by absolute path):',
    `- Primary:  ${ws.path}`,
    ...extras.map((p) => `- Extra:    ${p}`),
  ]
  return lines.join('\n')
}

/**
 * The stable half of a workspace slug: the conversation id, hyphens removed,
 * first six characters. It is the ONLY part of a folder name that survives an
 * auto-rename, which is what makes it the key the fallback search in
 * `api/workspace-slug.ts` matches on. Empty id yields `noid`, which is a
 * shared bucket and therefore never a legitimate search key.
 */
export function workspaceIdPart(id: string): string {
  return (id || '').replace(/-/g, '').slice(0, 6) || 'noid'
}

/**
 * Build a human-readable workspace slug for a chat.
 *
 * Folders used to be named after the conversation UUID
 * (`~/agent-workspace/8f7c2a1b-…/`), which is technically unique but
 * useless to a human opening Explorer. Per user feedback, slug is now
 * `<title-kebabbed>-<6-char-id>` so the user can find their work.
 *
 * The 6-char id suffix keeps two chats with the same title from
 * colliding (e.g. two "Untitled" chats started in a row).
 *
 * Sanitisation: lowercase, ASCII alphanumerics + hyphen only, capped
 * at 40 chars. Empty / unprintable titles fall back to the UUID
 * suffix alone, which still gives a stable folder name. The Rust side
 * has its own paranoia layer (agent.rs::agent_workspace) so this is
 * defence in depth.
 */
export function chatWorkspaceSlug(id: string, title?: string | null): string {
  const idPart = workspaceIdPart(id)
  const rawTitle = (title || '').toLowerCase().trim()
  if (!rawTitle) return idPart
  const slug = rawTitle
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug ? `${slug}-${idPart}` : idPart
}
