/**
 * Intelligent Tool Selection — reduce token usage by only including relevant tools.
 *
 * Instead of sending all 13 tools in every request (wasting context),
 * analyze the user message and only include tools likely to be needed.
 * Saves up to 80% of tool-definition tokens.
 */

import type { MCPToolDefinition, PermissionMap } from '../api/mcp/types'

interface ToolGroup {
  keywords: string[]
  tools: string[]
}

// Creative image/video. Surface BOTH generators for any creative request so
// the model can chain image → video in one conversation (David: "ein Video
// aus dem Bild soll die LLM auch machen können"). Without video_generate
// here the keyword path dropped it (it was in no group + not ALWAYS_INCLUDE),
// so a "now animate it" follow-up had no tool to call.
//
// Named constants rather than inline literals because gateCreateTools() below
// has to ask the SAME question on the cloud path. Two copies of this list would
// drift, and the failure mode of a drifted copy is a model that is told it can
// draw and then gets "unknown tool".
//
// The nouns beyond image/video (logo, icon, banner…) were added 2026-08-12 with
// the gate: on the local path a missed keyword only meant a slightly leaner
// list, on the cloud path it means a capability the user had yesterday is gone.
// A false positive here costs tokens, a false negative costs the feature, so
// the list leans generous.
// 'photo' and 'graphic' were missing next to their German twins 'foto' and
// 'grafik' (review 2026-08-14). The match is a substring test, so 'foto' does
// not cover 'photo' and 'grafik' does not cover 'graphic': the two commonest
// English words for the thing lost the capability on the paid path.
const MEDIA_KEYWORDS = [
  'image', 'picture', 'photo', 'generate image', 'draw', 'create image', 'bild', 'foto', 'zeichne',
  'logo', 'icon', 'thumbnail', 'banner', 'illustration', 'avatar', 'artwork', 'graphic', 'grafik', 'poster',
  'video', 'animate', 'animation', 'clip', 'mp4', 'make a video', 'turn into a video', 'movie', 'gif', 'animiere',
]
const WORKFLOW_KEYWORDS = ['workflow', 'run workflow', 'automate']

// A6: the two remaining ride-alongs. pr_resume only ever fires on a PR link or
// a "continue this PR", delegate_task only on an explicit fan-out, and both
// carry a schema on every step of every coding run that never asks for either.
// Same words the TOOL_GROUPS router already uses, so the local and the cloud
// path answer the question identically.
const PR_KEYWORDS = [
  'pull request', 'pull-request', 'open a pr', 'create a pr', 'the pr', 'this pr',
  'github', 'gh pr', '/resume', 'pick up review', '/pull/',
]
/**
 * Die Woerter, die `delegate_task` und seine zwei Begleiter ins Werkzeugregal
 * holen.
 *
 * ZWEI Befunde vom 02.09.2026 stecken in dieser Liste, beide von einem
 * Fable-Urteil gegen die Claude-Code-Desktop-App gefunden:
 *
 *  1. Sie war rein ENGLISCH. Der Nutzer schreibt Deutsch — „nutze 5 glm 5.2
 *     agenten" haette das Tor nicht geoeffnet, und das Werkzeug waere dem
 *     Modell nie angeboten worden. MEDIA_KEYWORDS hat aus genau diesem Grund
 *     am 14.08.2026 'bild', 'foto', 'zeichne' bekommen; hier ist es
 *     nachgeholt.
 *  2. Das blosse Wort „agent" fehlte. Wer „starte 3 agenten" sagt, sagt
 *     nicht „delegate" und nicht „fan out". Es ist das nachliegendste Wort
 *     ueberhaupt und war das einzige, das nicht drinstand.
 */
const DELEGATE_KEYWORDS = [
  // Englisch
  'delegate', 'sub-agent', 'subagent', 'sub agent', 'fan out', 'fan-out',
  'in parallel', 'parallel', 'parallelize', 'parallelise', 'split the work',
  'agents', 'agent',
  // Deutsch
  'agenten', 'unteragent', 'aufteilen', 'aufteilung', 'nebenlaeufig',
  'nebenläufig', 'gleichzeitig', 'im hintergrund', 'hintergrundaufgabe',
]

/**
 * The three tools that draw, film and automate. Everything else in the coding
 * catalog earns its place on every turn; these three cost 1.963 of the 6.186
 * tokens a coding step sends (measured 2026-08-12 through the real registry
 * against the model's own tokenizer) and a coding turn almost never wants them.
 */
export const CREATE_TOOLS = ['image_generate', 'video_generate', 'run_workflow']

/**
 * Every keyword-gated tool and the words that open its gate (A6).
 *
 * CREATE_TOOLS stays its own exported list because the Codex asset line keys
 * off exactly those three; this map is the superset the filter walks.
 */
const GATE_KEYWORDS: Record<string, readonly string[]> = {
  image_generate: MEDIA_KEYWORDS,
  video_generate: MEDIA_KEYWORDS,
  run_workflow: WORKFLOW_KEYWORDS,
  pr_resume: PR_KEYWORDS,
  delegate_task: DELEGATE_KEYWORDS,
  // Dieselben Woerter wie delegate_task, und das ist keine Sparsamkeit,
  // sondern die Bedeutung: beide Werkzeuge sprechen UEBER eine Delegation.
  // Ohne eine gibt es nichts nachzusehen und niemanden anzureden.
  //
  // Der Deckel in tool-catalog-tokens.test.ts hat das erzwungen: die zwei
  // Werkzeuge kosteten einen gewoehnlichen Refactor-Zug 844 Zeichen extra
  // (+11 %), obwohl auf demselben Zug delegate_task laengst nicht mitfaehrt.
  // Eine Sperre, die ein Budget haelt, hat hier einen Entwurfsfehler
  // gefunden, nicht nur eine Zahl.
  //
  // Der Selbstheilungspfad traegt mit: ruft ein Lauf im sechsten Schritt doch
  // delegate_task, oeffnet GATE_OPENING_TOOLS das Tor fuer den Rest des
  // Laufs — und dann kommen diese beiden mit, genau wenn sie gebraucht werden.
  check_tasks: DELEGATE_KEYWORDS,
  message_agent: DELEGATE_KEYWORDS,
}

/**
 * The names whose first real call must reopen the gate for the rest of the run
 * (the createGateOpened self-heal). A run that discovers at step six that it
 * needs a sub-agent, or that the task is a PR after all, gets the schema back
 * from the next step instead of calling blind for the remaining twenty.
 */
export const GATE_OPENING_TOOLS: readonly string[] = Object.keys(GATE_KEYWORDS)

/** True when this tool only ships when the turn asked for it. */
export function isGatedTool(name: string): boolean {
  return name in GATE_KEYWORDS
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    // Web search intents. Only EXPLICIT web cues route here. Bare 'search',
    // 'latest', 'current', 'aktuell', 'neueste', 'suche' were removed: they
    // collide head-on with coding intents ("search the codebase", "fix the
    // current bug", "the latest changes"), which used to pull web_search+
    // web_fetch, inflate the selection past 3, and silently skip the file-tool
    // booster below — leaving a coding turn with no file_search/file_list.
    // German phrases kept as multi-word cues ("such im internet", "im internet")
    // so a real "such im internet nach…" still surfaces web_search.
    keywords: ['find online', 'look up', 'look it up', 'google', 'bing', 'duckduckgo', 'internet',
      'news', 'web search', 'websearch', 'search online', 'search the web', 'browse', 'website', 'webseite',
      'url', 'http://', 'https://', 'weather', 'wetter',
      'such nach', 'such im', 'im internet', 'recherch', 'nachrichten', 'neueste'],
    tools: ['web_search', 'web_fetch'],
  },
  {
    keywords: ['read', 'open', 'show', 'cat', 'content of', 'what does', 'look at', 'check file'],
    tools: ['file_read'],
  },
  {
    keywords: ['write', 'create', 'save', 'make a file', 'put', 'generate file', 'output to',
      'edit', 'modify', 'change', 'replace', 'update', 'refactor', 'rename', 'fix', 'patch'],
    // file_edit (surgical) is preferred for changing existing files; file_write
    // for new files / full rewrites. Both surfaced so the model can pick.
    tools: ['file_write', 'file_edit'],
  },
  {
    keywords: ['list', 'ls', 'dir', 'files in', 'directory', 'folder', 'what files', 'tree'],
    tools: ['file_list'],
  },
  {
    keywords: ['search file', 'grep', 'find in', 'contains', 'where is', 'which file'],
    tools: ['file_search'],
  },
  {
    // Since the 2.6.6 merge shell_execute IS git, tests, background tasks
    // and scaffolding, so every keyword that used to route a typed wrapper
    // routes the one shell now (plan E4 point 7).
    keywords: ['run', 'execute', 'command', 'shell', 'terminal', 'bash', 'powershell', 'npm', 'pip', 'node', 'python', 'install', 'build', 'compile',
      'git', 'commit', 'push', 'branch', 'merge', 'rebase', 'stage', 'staged', 'diff', 'changelog', 'version control',
      'test', 'tests', 'spec', 'vitest', 'jest', 'pytest', 'cargo test', 'failing', 'make it green', 'suite',
      'background', 'long running', 'long-running', 'dataset', 'refactor everything', 'task status', 'still running',
      'scaffold', 'new project', 'init a', 'initialize', 'bootstrap', 'starter'],
    tools: ['shell_execute'],
  },
  {
    keywords: ['pull request', 'pull-request', 'open a pr', 'create a pr', 'the pr', 'github', 'gh pr'],
    tools: ['pr_resume', 'shell_execute'],
  },
  {
    // EINE Liste, nicht zwei. Hier stand bis 2.6.8 eine abgeschriebene Kopie,
    // und sie war schon auseinandergelaufen: 'sub agent', 'fan-out' und
    // 'parallelise' fehlten, obwohl der Kommentar bei DELEGATE_KEYWORDS
    // ausdruecklich verspricht, dass beide Wege „identisch antworten". Genau
    // so entsteht der Fehler, den niemand sieht — der lokale Pfad oeffnet das
    // Tor, der Cloud-Pfad nicht, und es haengt am Wort.
    keywords: DELEGATE_KEYWORDS,
    tools: ['delegate_task', 'check_tasks', 'message_agent'],
  },
  {
    // system_info / process_list retired (2.6.6): the environment block in
    // the system prompt covers OS and clock, the shell covers the rest.
    keywords: ['system', 'os', 'cpu', 'ram', 'memory', 'process', 'running', 'hostname'],
    tools: ['shell_execute'],
  },
  {
    keywords: ['screenshot', 'screen', 'desktop', 'capture', 'see my screen'],
    tools: ['screenshot'],
  },
  {
    keywords: MEDIA_KEYWORDS,
    tools: ['image_generate', 'video_generate'],
  },
  {
    keywords: WORKFLOW_KEYWORDS,
    tools: ['run_workflow'],
  },
]

// Tools that should always be available regardless of the prompt — they're
// cheap to include, commonly useful, and often needed mid-run (e.g. after
// a tool result reveals the user really wanted a file read). The clock lives
// in the system prompt's environment block now, so no time tool is needed.
// `todo_write` is here rather than in a keyword group on purpose: the moment a
// task turns out to need a plan is usually mid-run, several tool results after
// the prompt that routed the catalog. Keyword-gating it would mean the agent
// can only plan when the user happened to say "plan".
export const ALWAYS_INCLUDE = ['file_read', 'file_write', 'file_edit', 'todo_write']

/**
 * The tool cap Small-Model Mode sends to a 3B-8B model.
 *
 * Derived, not typed: ALWAYS_INCLUDE is a floor the cap cannot cut into, so a
 * fixed number silently shrinks the router every time that set grows. It was
 * 6 against 4 always-included tools, which left the semantic router 2 slots.
 * Adding todo_write (2026-08-05) cut that to 1 without anyone touching the
 * cap, and a coding turn with exactly one routed tool loses file_list AND
 * file_search AND shell_execute. Two free slots is the number the research
 * behind this mode was tuned on, so that is what is preserved.
 */
export const SMALL_MODEL_MAX_TOOLS = ALWAYS_INCLUDE.length + 2

/** Tool count at which embedding-based routing becomes worth the round trip. */
export const EMBEDDING_ROUTING_THRESHOLD = 15

import type { EmbeddingFn } from '../api/agents/embedding-router'
import { selectToolsByEmbedding } from '../api/agents/embedding-router'

/**
 * Select relevant tools based on user message content.
 * Returns a filtered list of tool names.
 */
export function selectRelevantTools(
  userMessage: string,
  allTools: MCPToolDefinition[],
  permissions: PermissionMap,
  maxTools?: number,
): MCPToolDefinition[] {
  const msg = userMessage.toLowerCase()
  const selectedNames = new Set<string>(ALWAYS_INCLUDE)

  // Match tool groups by keywords
  for (const group of TOOL_GROUPS) {
    if (group.keywords.some(kw => msg.includes(kw))) {
      group.tools.forEach(t => selectedNames.add(t))
    }
  }

  // External (MCP) tools can never match TOOL_GROUPS — the groups only know
  // the builtin names, so on this path a connected server's tools were
  // unreachable no matter what the user typed. Connecting the server is
  // itself the signal that its tools are wanted: always offer them.
  for (const t of allTools) {
    if (t.source === 'external') selectedNames.add(t.name)
  }

  // A tool the user names verbatim is always offered, builtin or external.
  for (const t of allTools) {
    if (msg.includes(t.name.toLowerCase())) selectedNames.add(t.name)
  }

  // If nothing beyond the always-included tools matched, include a broad set
  // (model might need flexibility). Handles generic messages like "help me with
  // this project". Threshold is ALWAYS_INCLUDE.length so adding an always-tool
  // (e.g. file_edit) doesn't silently disable this fallback.
  if (selectedNames.size <= ALWAYS_INCLUDE.length) {
    // Include common tools for generic requests
    selectedNames.add('shell_execute')
    selectedNames.add('file_list')
    selectedNames.add('file_search')
    selectedNames.add('web_search')
  }

  // Coding-discovery safety net (independent of the total count above). Any
  // message that surfaced a shell / code / file tool but lacks the file-
  // discovery pair cannot actually explore the codebase: "run the tests and
  // find the failing spec" matches shell_execute, pushes the count past 3, and
  // would otherwise skip the booster — leaving no file_search/file_list. Add
  // the discovery trio (never web_search) so coding intents can always locate
  // files, which is exactly what CODEX_SYSTEM_PROMPT tells the model to do.
  const hasCodeSignal =
    selectedNames.has('shell_execute') ||
    selectedNames.has('file_search') ||
    selectedNames.has('file_list')
  if (hasCodeSignal) {
    selectedNames.add('shell_execute')
    selectedNames.add('file_list')
    selectedNames.add('file_search')
  }

  // Filter by permissions (blocked categories excluded)
  const available = allTools.filter(t => permissions[t.category] !== 'blocked')

  // Return only selected tools that are available
  const selected = available.filter(t => selectedNames.has(t.name))

  // Safety: if nothing matched at all, return all available tools
  if (selected.length === 0) return applyMaxTools(available, maxTools)

  // Small-Model Mode (Knob 1): cap the catalog when maxTools is set. No-op
  // (returns `selected` unchanged) when unset — default behaviour preserved.
  return applyMaxTools(selected, maxTools, undefined, mentionedToolNames(userMessage, allTools))
}

/**
 * Drop the create tools unless this instruction actually asks for them.
 *
 * The keyword router already does this for local models. A CLOUD model gets
 * the coding catalog untouched (useCodex.ts: a hosted model handles 25+ tools
 * fine, and guessing its toolbox from message one starved long runs of
 * git_commit mid-way), so image_generate + video_generate + run_workflow rode
 * along on every step of every paid coding run: 2.160 tokens per step for
 * three tools a refactor never calls. This closes exactly that gap and leaves
 * the rest of the catalog alone.
 *
 * Gated per tool, not as a block, so the behaviour matches TOOL_GROUPS above:
 * a creative intent surfaces the two generators, a workflow intent surfaces
 * run_workflow, and naming a tool verbatim always wins.
 *
 * The decision starts from the run's instruction, and `opened` reopens it for
 * the rest of the run. That second half is not a nicety: "build me a landing
 * page for my bakery" hits no keyword, and at step six the model wants a hero
 * image. Before the gate it simply called image_generate and it worked, because
 * toolRegistry.execute resolves by name and never consults the offered list.
 * Without a way back the model instead writes a reference to a file that will
 * never exist and reports success. So the first real call is honoured, and from
 * the next step the schemas ride along openly.
 */
export function gateCreateTools<T extends { name: string }>(
  defs: T[],
  userMessage: string,
  opened: boolean | Iterable<string> = false,
): T[] {
  if (opened === true) return defs
  // A caller that tracks WHICH tool reopened the gate may pass the names; the
  // boolean form stays the run-wide "everything is open again" it always was.
  const reopened = opened === false ? null : new Set(opened)
  const msg = userMessage.toLowerCase()
  return defs.filter((t) => {
    const words = GATE_KEYWORDS[t.name]
    if (!words) return true
    if (reopened?.has(t.name)) return true
    if (msg.includes(t.name)) return true
    return words.some((k) => msg.includes(k))
  })
}

/** True when the instruction asks for a picture or a clip. Drives the asset
 *  line in the Codex system prompt so the prompt and the tool list agree. */
export function wantsMediaTools(userMessage: string): boolean {
  const msg = userMessage.toLowerCase()
  return (
    MEDIA_KEYWORDS.some((k) => msg.includes(k)) ||
    msg.includes('image_generate') ||
    msg.includes('video_generate')
  )
}

/** Names of tools the message mentions verbatim (case-insensitive). */
function mentionedToolNames(userMessage: string, tools: MCPToolDefinition[]): string[] {
  const msg = userMessage.toLowerCase()
  return tools.filter((t) => msg.includes(t.name.toLowerCase())).map((t) => t.name)
}

/**
 * Hard-cap a tool list to `maxTools` entries (Small-Model Mode, Knob 1).
 * ALWAYS_INCLUDE tools are kept first (cheap + often needed mid-run); the
 * remainder fills from the incoming order, or from `rankOrder` when supplied
 * (the embedding-ranked names from the async path) so the most semantically
 * relevant tools survive the cut. Strict no-op when `maxTools` is unset or
 * the list already fits — big models keep the exact original list + order.
 *
 * Evidence: tool-catalog length is the confirmed killer for small models
 * (LongFuncEval arXiv 2505.10570 — 8B models lose 7.6-85.6% as the catalog
 * grows). Fewer tools is the single biggest fine-tuning-free win.
 */
export function applyMaxTools(
  defs: MCPToolDefinition[],
  maxTools?: number,
  rankOrder?: string[],
  pinned?: string[],
): MCPToolDefinition[] {
  if (!maxTools || maxTools <= 0 || defs.length <= maxTools) return defs
  // Pinned tools (named verbatim by the user) rank with ALWAYS_INCLUDE and
  // may push past maxTools: an explicit mention outranks the budget.
  const keep = (t: MCPToolDefinition) =>
    ALWAYS_INCLUDE.includes(t.name) || (pinned?.includes(t.name) ?? false)
  const always = defs.filter(keep)
  let rest = defs.filter((t) => !keep(t))
  if (rankOrder && rankOrder.length > 0) {
    const idx = (name: string) => {
      const i = rankOrder.indexOf(name)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    rest = [...rest].sort((a, b) => idx(a.name) - idx(b.name))
  }
  const out = [...always]
  for (const t of rest) {
    if (out.length >= maxTools) break
    out.push(t)
  }
  return out
}

/**
 * Embedding-aware variant (Phase 9 v2.4.0). When `embed` is provided AND
 * the permission-filtered tool count exceeds EMBEDDING_ROUTING_THRESHOLD,
 * rank tools by semantic similarity to the user message and union the
 * result with the keyword-based selection (belt + braces). When `embed`
 * is absent, throws, or fails, silently falls back to the keyword-only
 * path.
 */
/**
 * Wie eng ein Small-Model-Zug die Werkzeugliste zieht.
 *
 * `topN` ist, wie viele der semantische Router hoechstens vorschlaegt;
 * `embeddingThreshold` ist die Katalogroesse, ab der ueberhaupt semantisch
 * geroutet statt nur nach Stichworten gefiltert wird. Beide standen bis
 * 2026-09-02 als nackte Zahlen im Aufruf in useAgentChat.ts — 5 und 6, ohne
 * Namen, ohne Begruendung, an genau einer von zwei Stellen, die sie brauchen.
 */
const SMALL_MODEL_TOP_N = 5
const SMALL_MODEL_EMBEDDING_THRESHOLD = 6

/**
 * Die Stellschrauben der Werkzeug-Vorauswahl, an EINER Stelle.
 *
 * ── WARUM DAS EINE FUNKTION IST UND KEIN OBJEKTLITERAL AM AUFRUF ───────────
 *
 * Weil die Abweichung, die sie behebt, genau so entstanden ist. Bis
 * 2026-09-02 stand dieses Objekt ausgeschrieben im NATIVEN Zweig von
 * useAgentChat.ts — und nur dort. Der hermes_xml-Zweig derselben Datei nahm
 * stattdessen `toolRegistry.toHermesToolDefs(permissions)`, also den ganzen
 * Katalog, ohne Vorauswahl und ohne Deckel.
 *
 * Nichts an dieser Auslassung war sichtbar: kein Fehler, kein Test, keine
 * Warnung. Sie fiel erst auf, als jemand nachrechnete. Gemessen an dem Tag:
 * 17 Werkzeuge ergaben einen Hermes-Prompt von 19.459 Zeichen (≈ 4.866 Token),
 * bei einem Sendefenster von 4.096 Token fuer die Modelle, die auf diesem
 * Rueckfallweg ueberhaupt landen — die Liste allein war 119 % des Fensters.
 *
 * Zwei Objektliterale koennen wieder auseinanderlaufen. Eine Funktion, die
 * beide Zweige rufen, kann es nicht. Eine Sperrklinke in
 * lib/__tests__/hermes-werkzeugauswahl.test.ts haelt fest, dass keiner der
 * beiden Zweige die Zahlen wieder selbst ausbuchstabiert.
 */
export function toolSelectionOpts(
  smallModelMode: boolean,
  embed?: EmbeddingFn,
): { embed?: EmbeddingFn; embeddingThreshold?: number; topN?: number; maxTools?: number } {
  return smallModelMode
    ? {
        embed,
        topN: SMALL_MODEL_TOP_N,
        embeddingThreshold: SMALL_MODEL_EMBEDDING_THRESHOLD,
        maxTools: SMALL_MODEL_MAX_TOOLS,
      }
    : { embed }
}

export async function selectRelevantToolsAsync(
  userMessage: string,
  allTools: MCPToolDefinition[],
  permissions: PermissionMap,
  opts?: { embed?: EmbeddingFn; embeddingThreshold?: number; topN?: number; maxTools?: number },
): Promise<MCPToolDefinition[]> {
  const threshold = opts?.embeddingThreshold ?? EMBEDDING_ROUTING_THRESHOLD
  const available = allTools.filter((t) => permissions[t.category] !== 'blocked')
  const pinned = mentionedToolNames(userMessage, available)
  if (!opts?.embed || available.length <= threshold) {
    return applyMaxTools(selectRelevantTools(userMessage, allTools, permissions), opts?.maxTools, undefined, pinned)
  }
  try {
    const semanticNames = await selectToolsByEmbedding(
      userMessage,
      available.map((t) => ({ name: t.name, description: t.description })),
      opts.embed,
      { topN: opts.topN ?? 10, alwaysInclude: ALWAYS_INCLUDE },
    )
    const keyword = selectRelevantTools(userMessage, allTools, permissions)
    const union = new Set<string>([...semanticNames, ...keyword.map((t) => t.name)])
    const selected = available.filter((t) => union.has(t.name))
    // Small-Model Mode (Knob 1): cap the union to maxTools, filling from
    // embedding-rank order so the most relevant tools survive. No-op when
    // maxTools is unset → `selected` (and its original order) is returned
    // byte-identical, so big-model behaviour is unchanged. Verbatim-named
    // tools are pinned past the cap on both paths.
    return applyMaxTools(selected, opts.maxTools, semanticNames, pinned)
  } catch {
    return applyMaxTools(selectRelevantTools(userMessage, allTools, permissions), opts?.maxTools, undefined, pinned)
  }
}
