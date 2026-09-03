import type { AgentBlock } from './agent-mode'

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ImageAttachment {
  data: string       // base64 encoded
  mimeType: string   // e.g. 'image/png', 'image/jpeg'
  name: string       // filename
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

export interface Message {
  id: string
  role: Role
  content: string
  /** When set, the UI renders THIS instead of `content` for a user message.
   *  Agent slash commands (v2.5.3): the user sees the short "/commit" they
   *  typed, while `content` holds the full expanded instruction the model
   *  actually receives. Display-only — never sent to the model. */
  displayContent?: string
  /** Coding-Agent slash command that triggered this assistant turn (e.g.
   *  "review", "init"). When set, CodexView wraps the whole step transcript in a
   *  collapsible tool-call-style window — default collapsed, live-streams while
   *  running (David 2026-06-12). Undefined for normal coding instructions. */
  slashCommand?: string
  thinking?: string
  /** Which model produced this assistant turn. Set in group chats so the
   *  bubble can label the speaker and the payload builder can tag the other
   *  models' lines. Absent on single-model chats. */
  modelId?: string
  timestamp: number
  images?: ImageAttachment[]
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
   *  providers (lu-cloud/DeepInfra, OpenAI) can match a tool result to its call
   *  ACROSS turns. Without it, once a tool call is in the history DeepInfra 422s
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
  /** Z36 finding 3: URLs in this agent answer that appear nowhere in what the
   *  model was shown this run (system prompt, history, tool results), so no
   *  tool returned them. Set only after the one corrective steer was ignored.
   *  Drives a labelled notice under the bubble instead of rewriting the
   *  model's text (G14-2). Absent when every link was backed. */
  unbackedLinks?: string[]
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
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  model: string
  systemPrompt: string
  mode?: 'lu' | 'codex' | 'openclaw' | 'remote'
  /** Per-chat persona toggle. Mirrors the mobile chat's `personaEnabled`
   *  flag so the user can flip the persona on/off for each chat
   *  individually without losing the selection in Settings. Undefined
   *  on legacy chats and treated as enabled. */
  personaEnabled?: boolean
  /** Group chat v1: two to four models that answer in turn on every user
   *  message. Fewer than two entries means a normal single-model chat. */
  groupModels?: string[]
  /**
   * Compactions that have happened in this chat, oldest first. Only the NEWEST
   * one shapes the payload — each summary already covers everything before its
   * own cut, so applying two would send the older material twice. The earlier
   * ones are kept because the transcript shows them where they happened.
   *
   * Absent on every chat from before 2.6.8, and on every chat that has never
   * been compacted. Both read as "no compaction", which is what they are.
   */
  compactions?: CompactionRecord[]
  createdAt: number
  updatedAt: number
}
