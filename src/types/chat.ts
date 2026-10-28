import type { CustomParam } from '../lib/custom-params'
import type { AgentBlock } from './agent-mode'
import type { SamplingOverrides } from '../lib/sampling'

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ImageAttachment {
  data: string       // base64 while composing; lu-attachment:v1:<sha256> in saved chats
  mimeType: string   // e.g. 'image/png', 'image/jpeg'
  name: string       // filename
}

/** A clip or sound track attached for Create in chat. Only the facts live in
 *  the message; the bytes stay in the app session
 *  (lib/create/chat-attachments.ts) and never enter the chat store. */
export interface MediaAttachment {
  kind: 'video' | 'audio'
  mimeType: string
  name: string
  size: number
}

/**
 * A file of any kind attached to a user message (3.0.5).
 *
 * A language model cannot read bytes, so the file itself is NOT in the chat:
 * no base64, no reference to a stored copy. What is kept is what the model was
 * given in its place (`summary`, a few kilobytes at most) and, in Agent and
 * Code, where the file was put in the chat's working folder so the file tools
 * can work on it. See lib/chat-files.ts.
 */
export interface FileAttachment {
  name: string
  /** Size of the file in bytes. */
  size: number
  /** The type read from the first bytes, e.g. "Game Boy Advance ROM". */
  kind: string
  /** Lowercase hex SHA-256 of the whole file. */
  sha256: string
  /** What the model reads instead of the bytes: a hex dump of the start and
   *  the readable strings, or the start of the text for a text file. */
  summary: string
  /** Set when the file is not text, so the model got a binary summary
   *  (3.0.7). Absent on attachments stored before; see isBinaryAttachment. */
  binary?: boolean
  /** Path inside the chat's working folder, set once the file was put there
   *  (Agent and Code only). */
  workspacePath?: string
  /** The same file as a full path on this computer (3.0.8). Tools that do not
   *  work in the chat's folder, such as the REA plugin, need it. Absent on
   *  attachments stored before. */
  absolutePath?: string
  /** A text file: how many characters its text has (GH #171). Absent on a
   *  binary, on a text too long to be read in whole, and on attachments
   *  stored before 3.0.7. */
  textChars?: number
  /** Set when less than the whole text went to the model: how many of the
   *  `textChars` characters it got. The chip shows it. */
  includedChars?: number
}

/**
 * A chat-tools "artifact": a file the model produced in PLAIN chat. In chat
 * mode `file_write` does NOT touch disk (ChatGPT-style) — the content lands in
 * the message and renders inline with a preview + Download button. (The Coding
 * Agent still writes to its real working directory.)
 */
export interface ChatArtifact {
  id: string
  /** Filename the model chose, e.g. "report.md". */
  name: string
  /** The text content the model "wrote". */
  content: string
  /** MIME type, derived from the extension — drives the preview. */
  mime: string
}

/** Why a run ended in an error, by kind. The chat hook writes it; a screen
 *  reads it instead of guessing from the text of the answer. */
export type MessageErrorKind = 'credits' | 'session' | 'limit' | 'network' | 'engine' | 'interrupted' | 'generic'

/**
 * The error of an assistant turn, as a field (mobile round 2, audit L12).
 *
 * `content` still carries the sentence the desktop bubble shows, exactly as
 * before, so nothing on the desktop changes. `at` is the length of the text
 * that had arrived before the error sentence was appended: a reader that
 * draws its own error box shows `content.slice(0, at)` and the box.
 */
export interface MessageError {
  kind: MessageErrorKind
  /** The reason in plain words, empty when the kind says it all. */
  detail: string
  /** Characters of `content` that are the answer itself. */
  at: number
}

export interface Message {
  id: string
  role: Role
  content: string
  /** Written on the paired phone (shared chats, lib/remote-chats-bridge). */
  fromPhone?: true
  /** Set by the chat hook when the run failed. See MessageError. */
  error?: MessageError
  /** How long the model thought before its first word of answer, in
   *  milliseconds. Written once, when the answer starts or the run ends. */
  thinkingMs?: number
  /** When set, the UI renders THIS instead of `content` for a user message.
   *  Agent slash commands (v2.5.3): the user sees the short "/commit" they
   *  typed, while `content` holds the full expanded instruction the model
   *  actually receives. Display-only — never sent to the model. */
  displayContent?: string
  /** Clips and sound tracks attached for Create in chat. */
  media?: MediaAttachment[]
  /** Coding-Agent slash command that triggered this assistant turn (e.g.
   *  "review", "init"). When set, CodexView wraps the whole step transcript in a
   *  collapsible tool-call-style window — default collapsed, live-streams while
   *  running (2026-06-12). Undefined for normal coding instructions. */
  slashCommand?: string
  thinking?: string
  /** Which model produced this assistant turn. Set in group chats so the
   *  bubble can label the speaker and the payload builder can tag the other
   *  models' lines. Absent on single-model chats. */
  modelId?: string
  /** Group chat: the persona this turn was written as, when its model played
   *  one (GH #169). The persona decides who spoke, so the turn stays its
   *  author's after the persona moves to another model. Absent on turns from
   *  before 3.0.7 and on turns of a model without a persona of its own. */
  groupPersonaId?: string
  /** The name that persona had then, for when it has been deleted since. */
  groupSpeakerName?: string
  /** GH #180: written outside group chat in a thread that has been a group,
   *  by its model without any persona. Such a turn is its model's and never
   *  gets a persona stamped on later, so turning group chat back on does not
   *  hand it to whichever persona that model plays then. */
  noGroupPersona?: true
  timestamp: number
  images?: ImageAttachment[]
  /** Files attached to this user message. `content` already carries their
   *  summaries for the model, `displayContent` holds what the user typed, and
   *  this list draws the chips and lets a resend rebuild the message. */
  files?: FileAttachment[]
  sources?: { documentName: string; chunkIndex: number; preview: string }[]
  // Agent Mode fields
  agentBlocks?: AgentBlock[]
  toolCallSummary?: string
  /** Chat-tools artifacts — files "written" in plain chat, rendered inline
   *  with preview + Download (never touch disk). See ChatArtifact. */
  artifacts?: ChatArtifact[]
  // Continue capability — tool-call history persisted between turns so
  // the model sees what it did before (parity with original Codex CLI).
  // Hidden messages are included in the API payload but not rendered.
  hidden?: boolean
  tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[]
  /** OpenAI tool-result linkage on role:'tool' messages. Persisted so id-based
   *  providers (lu-cloud, OpenAI) can match a tool result to its call
   *  ACROSS turns. Without it, once a tool call is in the history the upstream 422s
   *  "tool_call_id: Field required" on every follow-up turn (Bug 4, 2026-07-11). */
  tool_call_id?: string
  // Real token usage reported by the model (Ollama prompt_eval_count/eval_count,
  // OpenAI/LM-Studio usage.*). promptTokens = the FULL consumed context for that
  // turn (system prompt + tools + RAG + history + input), so it powers a
  // 100%-real context readout instead of a char/4 estimate.
  // promptTokens = the FULL consumed context (system prompt + tools + RAG +
  // history + input). `estimated` is true for the provisional value the agent
  // loop sets BEFORE the model replies (so the counter isn't a tiny char/4 guess
  // of only the visible messages); it flips to false once the model reports the
  // exact prompt_eval_count / usage.prompt_tokens.
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean }
  /** What this one request cost, for the line under the answer and `/usage`.
   *  `usage` above is the context anchor and keeps only the LAST model call;
   *  an agent answer makes several, so this is their sum. Real provider
   *  counts only, never an estimate: absent when the backend reported none.
   *  See lib/request-usage.ts. */
  requestUsage?: RequestUsage
  /** An app notice, not a model turn: the coding view renders it as a plain
   *  line instead of an assistant bubble, because putting it in a bubble would
   *  claim the model said it. 'warn' is for a notice the user has to act on,
   *  today the one that says the bytes on disk are NOT the diff they approved.
   *  Carried on role:'system' messages, which the payload builder drops, so a
   *  notice never reaches the model. */
  notice?: 'info' | 'warn'
  /** Why generation ended, when the model did NOT stop on its own terms:
   *  'length' (token budget) or 'disconnect'. Drives the small cut-off badge so
   *  a truncated answer is not shown as if it were complete (parity with the
   *  benchmark screen). Absent or 'stop' on a clean finish. */
  finishReason?: string
  /** Phone only (round 10, lib/continue-answer.ts): this answer is the direct
   *  continuation of the answer before it. The engine wrote it inside that
   *  answer's open turn, so the two join without anything between them.
   *  Absent everywhere else. */
  continuation?: 'exact'
  /** Z36 finding 3: URLs in this agent answer that appear nowhere in what the
   *  model was shown this run (system prompt, history, tool results), so no
   *  tool returned them. Set only after the one corrective steer was ignored.
   *  Drives a labelled notice under the bubble instead of rewriting the
   *  model's text (G14-2). Absent when every link was backed. */
  unbackedLinks?: string[]
  /** The opening message of a character card chat (3.0.7): every greeting
   *  the card offers, `content` is the one at `greetingIndex`. Switching only
   *  happens before the user writes. */
  greetings?: string[]
  greetingIndex?: number
}

/**
 * One compaction of this conversation (2.6.8).
 *
 * WHY THE ANCHOR IS AN ID AND NOT AN INDEX. The cut has to survive everything
 * that happens to the array afterwards: new turns appended, a message deleted,
 * the payload builders filtering stored `role:'system'` notices out. An index
 * survives none of those — it would silently start covering the wrong turns,
 * and a summary standing in front of material it does not describe is worse
 * than no summary. An id that is gone means the record is stale, which is a
 * state the reader can detect and ignore.
 *
 * The summary itself is stored RENDERED, exactly as it goes into the payload,
 * so what the transcript block shows and what the model receives cannot drift.
 */
export interface CompactionRecord {
  id: string
  /** The rendered summary, byte-identical to what the payload carries. */
  summary: string
  /** Id of the LAST message this summary stands in for — the cut point. */
  upToMessageId: string
  /** How many messages it stands in for. Display only. */
  replaced: number
  /** Messages in the conversation when it ran. The auto-compact cooldown anchor. */
  atMessageCount: number
  /** Estimated tokens of the replaced turns, and of the summary. */
  tokensBefore: number
  tokensAfter: number
  /** Who asked: the user typing /compact, or the threshold firing. */
  trigger: 'manual' | 'auto'
  at: number
  /**
   * True when `summary` is a merged state (3.0.7, issue #151): it stands for
   * everything up to its anchor, the earlier records included, and the payload
   * starts from it instead of sending the whole chain. Absent on older records
   * and on a run whose merge failed and fell back to a plain link.
   */
  merged?: boolean
}

/**
 * The kept versions of one point in a chat (GH #172, #174).
 *
 * A resend after an edit, and a regenerate, start a new continuation after
 * one message. The old continuation is not deleted any more: it moves in here
 * and stays one click away ("< 1/2 >"). `null` marks the version that is in
 * `Conversation.messages` right now, so every message lives in exactly one
 * place and a version costs no copy.
 */
export interface ChatFork {
  /** Every continuation after the key message, oldest first. */
  versions: (Message[] | null)[]
}

export interface Conversation {
  id: string
  /** Stable user-assigned project ID for memory retrieval and extraction. */
  memoryScope?: string
  title: string
  messages: Message[]
  model: string
  systemPrompt: string
  mode?: 'lu' | 'codex' | 'openclaw' | 'remote'
  /** Shared with the paired phones ("Continue on phone", CHATS-V1.md): the
   *  phone lists it, reads it live and writes into it. */
  remoteShared?: boolean
  /** Per-chat persona toggle. Mirrors the mobile chat's `personaEnabled`
   *  flag so the user can flip the persona on/off for each chat
   *  individually without losing the selection in Settings. Undefined
   *  on legacy chats and treated as enabled. */
  personaEnabled?: boolean
  /** GH #170: the persona this chat speaks as, written when the chat is
   *  created with one and whenever a persona is picked in the Plugins menu
   *  of this chat. Read through lib/chat-persona.ts, which also covers chats
   *  from before this field (they keep `systemPrompt`). */
  personaId?: string
  /** Group chat v1: two to four models that answer in turn on every user
   *  message. Fewer than two entries means a normal single-model chat. */
  groupModels?: string[]
  /** Group chat: the persona each participant speaks as, model name to
   *  persona id (3.0.5, a user on Discord). A model without an entry
   *  follows the chat's own persona setting, which is how every group worked
   *  before this field existed. */
  groupPersonas?: Record<string, string>
  /**
   * Compactions that have happened in this chat, oldest first. The payload
   * carries the newest merged state and any plain links after it; a chat from
   * before 3.0.7 has no merged state and sends the whole chain, because each
   * plain link only covers the turns since the one before it. The earlier
   * records stay stored because the transcript shows them where they happened.
   *
   * Absent on every chat from before 2.6.8, and on every chat that has never
   * been compacted. Both read as "no compaction", which is what they are.
   */
  compactions?: CompactionRecord[]
  /** R5-10/R5-11 (3.0.1-Liste): sampling this chat has chosen for itself.
   *  Additive and optional, so a chat persisted before this field existed
   *  loads unchanged and needs no store migration. Absent means "follow the
   *  Settings page", not "use the app default"; src/lib/sampling.ts has the
   *  full rule. Reset in the popup deletes this field rather than writing the
   *  defaults into it, so a reset chat keeps following the Settings page even
   *  if its sliders move again afterwards. */
  sampling?: SamplingOverrides
  /** GH #198: this chat's own custom sampling parameters. They win over the
   *  speaker's persona rows with the same key; in a group they hold for every
   *  member. Absent on every chat from before. */
  customParams?: CustomParam[]
  /**
   * Kept versions (GH #172, #174), keyed by the id of the message they follow,
   * or FORK_ROOT (lib/chat-forks.ts) for a change of the very first message.
   * `messages` stays the one thread every reader works with: the payload,
   * the search, the export. Absent on every chat from before 3.0.7 and on
   * every chat that was never resent, which reads as "one version".
   */
  forks?: Record<string, ChatFork>
  /** D26 (3.0.8): set on a chat made from a chatbot export. `fingerprint`
   *  hashes the messages as imported; when the chat's messages no longer
   *  match it, the user went on in LU and a newer export must not replace
   *  the chat (see lib/chat-import.ts). `version` is the export's last
   *  change (epoch ms) at import. Absent on every other chat. */
  importedFrom?: { fingerprint: string; version: number }
  createdAt: number
  updatedAt: number
}

/** The sum of every model call one answer made. `calls` counts the calls
 *  that reported numbers. `billing` is LU Cloud's own word for the request:
 *  'flash' drew no credits, 'credits' did (one call on credits is enough). */
export interface RequestUsage {
  inputTokens: number
  outputTokens: number
  calls: number
  billing?: 'flash' | 'credits'
}
