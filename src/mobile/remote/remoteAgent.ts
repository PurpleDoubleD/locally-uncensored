/**
 * Agentenmodus im Remote-Chat: die Schleife, in der das Modell des Desktops
 * Werkzeuge AUF DEM DESKTOP benutzt.
 *
 * Das Protokoll kann es seit jeher (REMOTE-PROTOKOLL.md, 6.2): `POST
 * /api/chat` mit `tools`, dann je Aufruf `POST /remote-api/agent-tool`. Die
 * Handy-Webseite des Desktops (`mobile-client/client.js`, `runToolLoop`) macht
 * genau das. Diese Datei ist dieselbe Schleife fuer den Store der App und
 * stuetzt sich auf dieselben Bausteine (`mobile-client/agent-core.js`):
 * Werkzeugliste, Reparatur der Argumente, Aufrufe aus dem Fliesstext, Altern
 * und Kuerzen alter Ergebnisse, Erkennen eines nachgesprochenen Systemprompts.
 *
 * Was hier bewusst NICHT angeboten wird:
 *   - `todo_write`: fuellt auf der Webseite nur eine Planleiste, die es im
 *     Remote-Chat der App nicht gibt.
 *   - `screenshot`: schickt ein Bild des Desktop-Bildschirms an das Handy.
 *   - `image_generate` ueber `/remote-api/agent-tool`: der Desktop antwortet
 *     darauf nur mit einem Hinweis.
 * Uebrig bleiben Web, Dateien und Terminal.
 *
 * Seit A17 (3.0.8) kommen `image_generate` und `video_generate` dazu, aber
 * nicht ueber agent-tool: die App fuehrt sie selbst aus, als Auftrag an
 * Create des Rechners im versiegelten Kanal (wie der Create-Tab mit "My
 * computer"). Sie stehen nur in der Liste, wenn der Rechner `create-image`
 * bzw. `create-video` nennt (das Recht `create` dieses Handys) und die App
 * einen Ausfuehrer dafuer hat (`setRemoteCreateRunner`). Das Ergebnis haengt
 * als Bild oder Video am Schritt und liegt in der Galerie des Handys. Dateien und Terminal haengen an
 * den Schaltern des Desktops (`filesystem`, `shell`); ist ein Schalter aus,
 * steht das Werkzeug gar nicht erst in der Liste fuer das Modell.
 *
 * Kein Store, keine Oberflaeche, kein Text fuer den Nutzer. Der Aufrufer
 * bekommt die Schritte und das Ende als Daten.
 */
import { AgentLoopGuard } from '../../lib/agent-loop-guard'
import { countRemoteStep, estimateRemoteTokens } from '../../lib/agent-core/remote-token-hour'
import {
  AGENT_TOOLS,
  buildToolDefs,
  compactApiMessages,
  decayToolResults,
  extractToolCallsFromContent,
  isSystemPromptEcho,
  repairToolCallArgs,
  stripRanges,
} from '../../../mobile-client/agent-core.js'
import { CAVEMAN_PROMPTS, CAVEMAN_REMINDERS } from '../../../mobile-client/caveman.js'
import { hostClockLine } from '../../lib/host-platform'
import {
  RemoteAbortedError,
  isToolsUnsupported,
  type AgentToolResult,
  type RemoteApiMessage,
  type RemoteClient,
  type RemotePermissions,
  type RemoteToolCall,
} from './remoteClient'

// ── Werkzeuge ────────────────────────────────────────────────────

/** Welchen Schalter des Desktops ein Werkzeug braucht. null = keinen. */
export const REMOTE_TOOL_NEEDS: Readonly<Record<string, keyof RemotePermissions | null>> = {
  web_search: null,
  web_fetch: null,
  file_read: 'filesystem',
  file_write: 'filesystem',
  file_list: 'filesystem',
  file_search: 'filesystem',
  shell_execute: 'shell',
}

/** Alle Werkzeuge, die der Remote-Chat dem Modell anbieten kann, in fester Reihenfolge. */
export const REMOTE_AGENT_TOOLS: readonly string[] = Object.keys(REMOTE_TOOL_NEEDS)

/**
 * Werkzeuge, die die App selbst ausfuehrt (A17): Create des Rechners im
 * Kanal. Je Werkzeug das Merkmal im Status, das das Recht `create` zeigt.
 */
export const REMOTE_CREATE_TOOL_FEATURE: Readonly<Record<'image_generate' | 'video_generate', string>> = {
  image_generate: 'create-image',
  video_generate: 'create-video',
}

export type RemoteCreateToolName = keyof typeof REMOTE_CREATE_TOOL_FEATURE

export function isRemoteCreateTool(name: string): name is RemoteCreateToolName {
  return Object.prototype.hasOwnProperty.call(REMOTE_CREATE_TOOL_FEATURE, name)
}

/** Ein Bild oder Video, das ein Schritt gemacht hat: ein Eintrag der Galerie des Handys. */
export interface RemoteStepMedia {
  /** Kennung des Galerie-Eintrags (`pc_res_...`). */
  id: string
  kind: 'image' | 'video'
  mime: string
}

export interface RemoteCreateOutcome {
  ok: boolean
  /** Was das Modell als Ergebnis liest. */
  observation: string
  media?: RemoteStepMedia[]
}

/** Fuehrt image_generate oder video_generate auf dem Rechner aus. Wirft nicht; Abbruch ueber das Signal. */
export type RemoteCreateRunner = (tool: RemoteCreateToolName, args: Record<string, unknown>, signal?: AbortSignal) => Promise<RemoteCreateOutcome>

let createRunner: RemoteCreateRunner | null = null

/** Die App (Create, nur in Builds mit "My computer") meldet hier ihren Ausfuehrer an. null meldet ab. */
export function setRemoteCreateRunner(runner: RemoteCreateRunner | null): void {
  createRunner = runner
}

export function remoteCreateRunner(): RemoteCreateRunner | null {
  return createRunner
}

/**
 * Die Werkzeugbeschreibungen der App fuer das Modell. Eigene Texte statt
 * denen aus agent-core.js: dort beschreibt image_generate den Weg ueber den
 * Desktop mit Dateinamen, den es hier nicht gibt.
 */
const CREATE_TOOL_DEFS: Record<RemoteCreateToolName, unknown> = {
  image_generate: {
    type: 'function',
    function: {
      name: 'image_generate',
      description:
        'Generate an image from a text prompt with the image models of the user\'s computer. The image is shown to the user in this chat and saved on their phone. USE for "draw me", "make an image of", "generate a picture". Takes a while; call it at most once per turn.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Positive text description of the desired image' },
          negativePrompt: { type: 'string', description: 'Things to avoid (blurry, deformed, etc.)' },
        },
        required: ['prompt'],
      },
    },
  },
  video_generate: {
    type: 'function',
    function: {
      name: 'video_generate',
      description:
        'Generate a short video clip from a text prompt with the video models of the user\'s computer. The clip is shown to the user in this chat and saved on their phone. USE for "make a video of", "animate", "a clip of". Takes minutes; call it at most once per turn.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The scene and how it moves' },
          negativePrompt: { type: 'string', description: 'Things to avoid' },
        },
        required: ['prompt'],
      },
    },
  },
}

/**
 * Die Werkzeuge, die mit den Schaltern dieses Desktops wirklich laufen.
 * Unbekannte Schalter (null) zaehlen als aus: lieber ein Werkzeug weniger als
 * ein Lauf, der nur Ablehnungen sammelt. `features` (A17): nennt der Rechner
 * create-image oder create-video und hat die App einen Ausfuehrer, kommen
 * image_generate und video_generate dazu.
 */
export function remoteToolsFor(permissions: RemotePermissions | null, features: readonly string[] = [], canCreate = createRunner !== null): string[] {
  const out = REMOTE_AGENT_TOOLS.filter((name) => {
    const needs = REMOTE_TOOL_NEEDS[name]
    return needs === null || permissions?.[needs] === true
  })
  if (canCreate) for (const [name, feature] of Object.entries(REMOTE_CREATE_TOOL_FEATURE)) if (features.includes(feature)) out.push(name)
  return out
}

// ── Systemprompt ─────────────────────────────────────────────────

/**
 * Der Agentenvertrag, Wort fuer Wort der der Handy-Webseite (`AGENT_PROMPT`
 * in mobile-client/client.js). client.js ist ein Seitenskript ohne Exporte,
 * darum steht der Text hier ein zweites Mal. `remoteAgent.test.ts` liest
 * client.js und schlaegt an, sobald die beiden auseinanderlaufen.
 */
export const REMOTE_AGENT_PROMPT =
  'You are an autonomous AI agent inside LU. You execute tasks end-to-end via tools \u2014 you do NOT just describe what to do.\n\n=== HARD RULES ===\n\n1. AFTER EVERY TOOL RESULT, your very next message MUST be EITHER (a) another tool call to continue the work, OR (b) the final user-facing summary. There is no middle ground. Empty messages are a FAILURE.\n\n2. DO NOT stop after the FIRST tool. Real tasks take 3-10 tool calls. If the user said "build X" you write the files. If the user said "use every tool" you keep going through every tool. Stopping after one shell_execute or one web_search without producing a useful artefact = FAILURE.\n\n3. NEVER produce a code block followed by "save this as X". That is FAILURE \u2014 call file_write yourself.\n\n4. NEVER say "Now I will create X" / "Next I will write Y" as plain prose and stop. Do the next step right now as a concrete tool call.\n\n5. The ONLY reasons to stop calling tools: (a) the user task is FULLY done with concrete artefacts on disk / web results returned / etc., OR (b) you are stuck in a way that genuinely needs user input. "I have called one tool, that should be enough" is NOT a valid stop reason.\n\n=== WORKFLOW ===\n\n- Build / create tasks: file_write each artefact directly, chain ALL writes, then write a 1-3 sentence final answer.\n- Read / explore tasks: file_list / file_read first, then proceed.\n- Web tasks: web_search \u2192 web_fetch on the best URL \u2192 summarize.\n- Multi-tool / "use every tool" tasks: plan the order, then call each tool one at a time, recording the partial result in a final summary file before the visible reply.\n\n=== FILE RULES ===\n\n- file_write AUTOMATICALLY creates missing parent directories \u2014 do NOT shell out to mkdir / New-Item / md / os.makedirs first. Just file_write the target path.\n- Relative paths resolve to the current chat workspace folder. Use relative paths (e.g. `index.html`, `src/app.py`); do not hard-code absolute drive letters.\n- After 2-3 failures of the same approach, switch strategy \u2014 do not repeat the same broken command. Do not introduce yourself again.\n\nBe concise in prose. All real work happens in tool calls. Respond in the same language the user used in their message.'

export type CavemanLevel = 'off' | 'lite' | 'full' | 'ultra'

export function isCavemanLevel(value: unknown): value is CavemanLevel {
  return value === 'off' || value === 'lite' || value === 'full' || value === 'ultra'
}

const CAVEMAN_SYSTEM = CAVEMAN_PROMPTS as Record<string, string>
const CAVEMAN_BEFORE_USER = CAVEMAN_REMINDERS as Record<string, string>

/** Die Erinnerung, die vor jede Nutzernachricht gesetzt wird, oder ''. */
export function cavemanReminder(level: CavemanLevel): string {
  return level === 'off' ? '' : (CAVEMAN_BEFORE_USER[level] ?? '')
}

export interface SystemPromptInput {
  caveman: CavemanLevel
  /** Persona dieses Chats. null = keine gewaehlt. '' = die Persona ohne Prompt. */
  persona: string | null
  /** Der Prompt, den der Desktop beim Freigeben mitgegeben hat. */
  desktopPrompt: string
  agent: boolean
  /** Satz ueber das Betriebssystem des Desktops. */
  platformLine: string
  now?: Date
}

/**
 * Der Systemprompt in der Reihenfolge der Webseite (`buildSystemPrompt`):
 * Sprechweise, dann Persona ODER (nur im einfachen Chat) der Prompt vom
 * Desktop, dann der Agentenvertrag, dann Plattform und Uhr. Der Vertrag steht
 * hinter der Persona, damit seine Regeln das Letzte sind, was das Modell liest.
 */
export function buildRemoteSystemPrompt(input: SystemPromptInput): string {
  const parts: string[] = []
  if (input.caveman !== 'off' && CAVEMAN_SYSTEM[input.caveman]) parts.push(CAVEMAN_SYSTEM[input.caveman])
  if (input.persona !== null) {
    if (input.persona) parts.push(input.persona)
  } else if (input.desktopPrompt && !input.agent) {
    parts.push(input.desktopPrompt)
  }
  if (input.agent) {
    parts.push(REMOTE_AGENT_PROMPT)
    if (input.platformLine) parts.push(input.platformLine)
    // Dieselbe Uhrzeile wie Desktop und Webseite. Sie schliesst den Prompt, weil sie sich jede Minute aendert.
    parts.push(hostClockLine(input.now))
  }
  return parts.join('\n\n')
}

// ── Beobachtung ──────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Aus der Antwort des Desktops den Text machen, den das Modell als Ergebnis
 * liest. Dieselben Faelle wie `runAgentTool` in client.js.
 */
export function toolObservation(result: AgentToolResult, args: Record<string, unknown>): string {
  if (!result.ok) {
    if (result.needsPermission) return `Permission denied: ${result.error ?? ''}`
    return `Error: ${result.error ?? 'the tool failed'}`
  }
  const data = result.data
  if (typeof data === 'string') return data
  const obj = record(data)
  if (!obj) return JSON.stringify(data ?? null)
  if (Array.isArray(obj.results)) {
    if (obj.results.length === 0) return 'No results.'
    return obj.results
      .map((item, index) => {
        const it = record(item) ?? {}
        return `${index + 1}. ${String(it.title ?? '')}\n   ${String(it.url ?? '')}\n   ${String(it.snippet ?? '')}`
      })
      .join('\n\n')
  }
  if (typeof obj.text === 'string' && (obj.url || obj.status !== undefined)) {
    const parts: string[] = []
    if (obj.title) parts.push(`Title: ${String(obj.title)}`)
    if (obj.url) parts.push(`URL: ${String(obj.url)}`)
    if (obj.status !== undefined) parts.push(`Status: ${String(obj.status)}`)
    parts.push('', obj.text || '(empty body)')
    if (obj.truncated) parts.push('\n(truncated to 24 000 chars)')
    return parts.join('\n')
  }
  if (typeof obj.content === 'string') return obj.content
  if (obj.status === 'saved') return `File saved: ${String(obj.path ?? args.path ?? '')}`
  if (obj.exitCode !== undefined || obj.stdout !== undefined) {
    const out = typeof obj.stdout === 'string' ? obj.stdout : ''
    const err = typeof obj.stderr === 'string' ? obj.stderr : ''
    // T1: the desktop moved a command that outran its timeout into a
    // background task instead of killing it (same text as mobile-client/client.js).
    if (obj.timedOut && typeof obj.taskId === 'string' && obj.taskId) {
      let soFar = `${out}${err ? `\n[stderr]\n${err}` : ''}`.replace(/\s+$/, '')
      if (soFar.length > 2000) soFar = `…${soFar.slice(-2000)}`
      return `Still running after its timeout, so it was not stopped: it keeps running in the background as task ${obj.taskId}.\n`
        + (soFar ? `Output so far:\n${soFar}\n` : '')
        + `Use shell_execute with task "status" and task_id "${obj.taskId}" to read its output, or task "kill" to stop it.`
    }
    if (obj.timedOut) return 'Execution timed out.'
    if (typeof obj.exitCode === 'number' && obj.exitCode !== 0) return `Error (${obj.exitCode}):\n${err || out}`
    return out || (err ? `stderr: ${err}` : 'Done.')
  }
  return JSON.stringify(obj)
}

/** Ein Ergebnis, das der Lauf als gescheitert zaehlt (wie die Webseite: am Anfang des Textes abgelesen). */
export function observationFailed(observation: string): boolean {
  return /^(Error|Permission denied|Network error)/i.test(observation)
}

// ── Schleife ─────────────────────────────────────────────────────

/** Wie die Webseite: hoechstens so viele Runden. */
export const MAX_ITERATIONS = 50
/** Abbruch nach so vielen gescheiterten Werkzeugaufrufen in Folge. */
export const MAX_CONSECUTIVE_ERRORS = 5
/** So oft wird ein nachgesprochener Systemprompt still wiederholt. */
export const ECHO_RETRIES = 3
/** So oft wird ein Modell angestossen, das zu frueh aufhoert. */
export const STOP_NUDGES = 8
/** Zeichenbudget des Verlaufs fuer das Modell, wie die Webseite. */
export const HISTORY_CHAR_BUDGET = 24_000
/** So viel eines Ergebnisses behaelt ein Schritt fuer die Anzeige. */
export const STEP_RESULT_MAX = 4000
/** So viel der Argumente behaelt ein Schritt fuer die Anzeige. */
export const STEP_ARGS_MAX = 600

export interface RemoteAgentStep {
  id: string
  tool: string
  /** Die Argumente als JSON-Text, gekuerzt. */
  args: string
  state: 'running' | 'done' | 'failed'
  /** Das Ergebnis, gekuerzt. Leer, solange der Schritt laeuft. */
  result: string
  /** Name des Schalters, der am Desktop aus ist. */
  needsPermission?: string
  /** A17: was image_generate oder video_generate gemacht hat. */
  media?: RemoteStepMedia[]
}

export type RemoteAgentEnd =
  /** Das Modell hat eine Antwort ohne weiteren Werkzeugaufruf gegeben. */
  | 'done'
  /** Der Nutzer hat gestoppt oder die App ging in den Hintergrund. */
  | 'aborted'
  | 'max-iterations'
  | 'tool-errors'
  /** Der Loop-Guard hat den Lauf beendet: dieselben Aufrufe immer wieder
   *  (lib/agent-loop-guard.ts, derselbe Waechter wie am Desktop, CA 14.11.). */
  | 'looping'
  /** Die Stundengrenze fuer Agentenlaeufe vom Handy ist erreicht
   *  (lib/agent-core/remote-token-hour.ts, CA 14.11.). */
  | 'cost-limit'
  /** Das Modell kann keine Werkzeuge. */
  | 'no-tools'

export interface RemoteAgentResult {
  end: RemoteAgentEnd
  content: string
  thinking: string
  steps: RemoteAgentStep[]
}

export interface RemoteAgentRun {
  client: Pick<RemoteClient, 'chatWithTools' | 'runAgentTool'>
  model: string
  /** Der Verlauf fuer das Modell, mit Systemprompt an erster Stelle. Wird nicht veraendert. */
  messages: RemoteApiMessage[]
  /** Namen der Werkzeuge, die angeboten werden (aus `remoteToolsFor`). */
  tools: string[]
  chatId: string
  think?: boolean
  keepThinking?: boolean
  signal?: AbortSignal
  /** Nach jeder Aenderung an den Schritten, mit einer Kopie. */
  onSteps?: (steps: RemoteAgentStep[]) => void
  /** Zwischentext und Denktext, sobald eine Runde sie liefert. */
  onProgress?: (partial: { content: string; thinking: string }) => void
  /** Kennungen der Schritte, fuer Tests. */
  stepId?: () => string
  /** A17: fuehrt image_generate und video_generate aus. Ohne ihn laufen sie ueber agent-tool (nur ein Hinweis). */
  createRunner?: RemoteCreateRunner | null
  maxIterations?: number
}

type LoopMessage = RemoteApiMessage & { iter?: number }

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[...${text.length - max} more characters]` : text
}

function argsText(args: Record<string, unknown>): string {
  try {
    return clip(JSON.stringify(args), STEP_ARGS_MAX)
  } catch {
    return '{}'
  }
}

const ASKS_FOR_HELP = /^(how can i help|what (do you|would you like|task)|please (let me know|tell me|provide))/i
const PROMISES_ONLY =
  /(i will (provide|write|summarize|create|make|list|finish|complete|do|show|give|tell)|i'?ll (provide|write|summarize|create|list|now)|let me summarize|let me (provide|give|list)|here is the summary:?\s*$|now i'?ll|next i'?ll)/i

/** Der Anstoss fuer ein Modell, das ohne Werkzeugaufruf aufhoert, obwohl nichts Brauchbares dasteht. Leer = die Antwort gilt. */
export function stopNudge(content: string, stepsDone: number): string {
  const trimmed = content.trim()
  const promises = PROMISES_ONLY.test(trimmed.slice(-260))
  const emptyAfterColon = /(:\s*|-\s*)$/.test(trimmed) && trimmed.length > 0 && trimmed.length < 400
  if (promises || emptyAfterColon) {
    return 'You announced a summary but never wrote it. The user sees nothing useful. Write the actual summary RIGHT NOW in this turn: a concrete bullet list of what each tool returned, plus a 1-sentence conclusion. No more announcements, no more "I will".'
  }
  if (ASKS_FOR_HELP.test(trimmed) && stepsDone < 5) {
    return 'Do not ask the user "how can I help". The task was already given. Resume executing it now with the next tool call. The user already told you exactly what to do.'
  }
  if (!trimmed && stepsDone > 0) {
    if (stepsDone < 3) {
      return `You stopped after only ${stepsDone} tool call(s) and your last message was empty. The task is not finished. Call the NEXT tool to continue. Do not stop yet.`
    }
    return `You completed ${stepsDone} tool calls but your last message was empty, so the user sees nothing. Write the final user-facing summary right now: 1-3 sentences listing what you did and any concrete results. Do not introduce yourself again.`
  }
  return ''
}

/**
 * Einen Agentenlauf fahren. Wirft, was der Client wirft (Sitzung abgelaufen,
 * Desktop weg, Backend-Fehler), ausser Abbruch und "Modell kann keine
 * Werkzeuge": die beiden kommen als `end` zurueck. Die bis dahin gelaufenen
 * Schritte hat der Aufrufer ueber `onSteps` schon bekommen.
 */
export async function runRemoteAgentLoop(run: RemoteAgentRun): Promise<RemoteAgentResult> {
  const steps: RemoteAgentStep[] = []
  let counter = 0
  const nextId = run.stepId ?? (() => `s${++counter}`)
  const publish = () => run.onSteps?.(steps.map((step) => ({ ...step })))
  const known = [...run.tools]
  const local = run.createRunner ?? null
  const tools = [
    ...(buildToolDefs(known.filter((name) => !(local && isRemoteCreateTool(name)))) as unknown[]),
    ...(local ? known.filter(isRemoteCreateTool).map((name) => CREATE_TOOL_DEFS[name]) : []),
  ]
  const maxIterations = run.maxIterations ?? MAX_ITERATIONS
  let messages: LoopMessage[] = run.messages.map((message) => ({ ...message }))

  let thinking = ''
  let lastContent = ''
  let iter = 0
  let echoRetries = ECHO_RETRIES
  let nudges = STOP_NUDGES
  let consecutiveErrors = 0
  // CA (14.11.2026): the same loop guard as the desktop's agent loops. The
  // remote loop had only its step limit and five failures in a row, and the
  // model it drives may be a paid cloud model on the desktop.
  const guard = new AgentLoopGuard()
  let pendingSteer: string | null = null
  const finish = (end: RemoteAgentEnd, content: string): RemoteAgentResult => ({ end, content, thinking, steps: steps.map((step) => ({ ...step })) })
  const aborted = () => run.signal?.aborted === true

  try {
    for (;;) {
      if (aborted()) return finish('aborted', lastContent)
      if (iter >= maxIterations) return finish('max-iterations', lastContent)
      iter += 1

      // Erst altern, dann kuerzen: gemessen wird der gealterte Verlauf.
      decayToolResults(messages, iter)
      messages = compactApiMessages(messages, HISTORY_CHAR_BUDGET) as LoopMessage[]

      const sent = messages.map(({ iter: _iter, ...message }) => message)
      const answer = await run.client.chatWithTools({
        model: run.model,
        // `iter` ist Buchhaltung dieser Schleife und geht nicht an den Desktop.
        messages: sent,
        tools,
        think: run.think,
        signal: run.signal,
      })
      // Kosten: geschaetzt aus den Zeichen, die hin und zurueck gingen. Ueber
      // der Stundengrenze endet der Lauf hier, bevor weitere Werkzeuge laufen.
      {
        const chars = JSON.stringify(sent).length + JSON.stringify(tools).length
          + (answer.content?.length ?? 0) + (answer.thinking?.length ?? 0) + JSON.stringify(answer.toolCalls ?? []).length
        if (countRemoteStep(estimateRemoteTokens(chars))) {
          return finish('cost-limit', [lastContent, answer.content ?? ''].filter((x) => x.trim()).join('\n\n'))
        }
      }
      if (answer.thinking && run.keepThinking) thinking = thinking ? `${thinking}\n${answer.thinking}` : answer.thinking

      let content = answer.content
      let calls: RemoteToolCall[] = answer.toolCalls
      if (calls.length === 0 && content) {
        // Manche Modelle schreiben den Aufruf als JSON-Block in den Text.
        const pulled = extractToolCallsFromContent(content, known) as { calls: RemoteToolCall[]; ranges: Array<{ start: number; end: number }> }
        if (pulled.calls.length > 0) {
          calls = pulled.calls
          content = stripRanges(content, pulled.ranges) as string
        }
      }
      // Ein Werkzeug, das nicht angeboten wurde, wird nicht ausgefuehrt.
      calls = calls.filter((call) => known.includes(call.function.name))

      if (isSystemPromptEcho(content)) {
        if (echoRetries > 0) {
          echoRetries -= 1
          messages.push({ role: 'user', content: 'Continue the task. Do not introduce yourself again. Resume from the last successful step using the appropriate tool call.' })
          continue
        }
        content = ''
      }

      if (calls.length === 0) {
        const nudge = nudges > 0 ? stopNudge(content, steps.length) : ''
        if (nudge) {
          nudges -= 1
          if (content.trim()) messages.push({ role: 'assistant', content })
          messages.push({ role: 'user', content: nudge })
          continue
        }
        return finish('done', content)
      }

      lastContent = content || lastContent
      run.onProgress?.({ content: lastContent, thinking })
      {
        const said = guard.recordNarration(content || '')
        const verdict = said.action === 'halt'
          ? said
          : guard.recordBatch(calls.map((c) => ({ name: c.function.name, args: JSON.stringify(c.function.arguments ?? {}) })))
        if (verdict.action === 'halt') {
          // The search spiral ends with an honest "not found" as the answer.
          if (verdict.answer) return finish('done', [lastContent, verdict.answer].filter((x) => x.trim()).join('\n\n'))
          return finish('looping', lastContent)
        }
        pendingSteer = verdict.action === 'steer' ? verdict.message : said.action === 'steer' ? said.message : null
      }
      messages.push({
        role: 'assistant',
        content: content || '',
        tool_calls: calls.map((call) => ({ function: { name: call.function.name, arguments: call.function.arguments } })),
      })

      for (const call of calls) {
        if (aborted()) return finish('aborted', lastContent)
        const args = repairToolCallArgs(call.function.arguments) as Record<string, unknown>
        const step: RemoteAgentStep = { id: nextId(), tool: call.function.name, args: argsText(args), state: 'running', result: '' }
        steps.push(step)
        publish()

        const name = call.function.name
        let observation: string
        if (local && isRemoteCreateTool(name)) {
          const made = await local(name, args, run.signal)
          if (aborted()) {
            step.state = 'failed'
            step.result = 'Stopped.'
            publish()
            return finish('aborted', lastContent)
          }
          observation = made.ok ? made.observation : made.observation.startsWith('Error') ? made.observation : `Error: ${made.observation}`
          if (made.media && made.media.length > 0) step.media = made.media
        } else {
          const result = await run.client.runAgentTool({ tool: name, args, chatId: run.chatId, signal: run.signal })
          observation = toolObservation(result, args)
          if (result.needsPermission) step.needsPermission = result.needsPermission
        }
        const failed = observationFailed(observation)
        step.state = failed ? 'failed' : 'done'
        step.result = clip(observation, STEP_RESULT_MAX)
        publish()

        messages.push({ role: 'tool', content: observation, iter })
        consecutiveErrors = failed ? consecutiveErrors + 1 : 0
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return finish('tool-errors', lastContent)
      }
      // The steer goes after the results it is about.
      if (pendingSteer) {
        messages.push({ role: 'user', content: pendingSteer })
        pendingSteer = null
      }
    }
  } catch (err) {
    // Ein Schritt, der gerade lief, ist nicht fertig geworden.
    let open = false
    for (const step of steps) {
      if (step.state === 'running') {
        step.state = 'failed'
        open = true
      }
    }
    if (open) publish()
    if (err instanceof RemoteAbortedError || aborted()) return finish('aborted', lastContent)
    if (isToolsUnsupported(err)) return finish('no-tools', '')
    throw err
  }
}

/** Die Namen aller Werkzeuge, die agent-core.js beschreibt. Nur fuer den Abgleich im Test. */
export function describedToolNames(): string[] {
  return (AGENT_TOOLS as Array<{ name: string }>).map((tool) => tool.name)
}
