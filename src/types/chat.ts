import type { AgentBlock } from './agent-mode'

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ImageAttachment {
  data: string       // base64 encoded
  mimeType: string   // e.g. 'image/png', 'image/jpeg'
  name: string       // filename
}

export interface Message {
  id: string
  role: Role
  content: string
  thinking?: string
  timestamp: number
  images?: ImageAttachment[]
  sources?: { documentName: string; chunkIndex: number; preview: string }[]
  // Agent Mode fields
  agentBlocks?: AgentBlock[]
  toolCallSummary?: string
  // Continue capability — tool-call history persisted between turns so
  // the model sees what it did before (parity with original Codex CLI).
  // Hidden messages are included in the API payload but not rendered.
  hidden?: boolean
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  model: string
  systemPrompt: string
  mode?: 'lu' | 'codex' | 'openclaw' | 'claude-code' | 'remote'
  createdAt: number
  updatedAt: number
}
