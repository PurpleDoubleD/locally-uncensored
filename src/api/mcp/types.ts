// MCP-shaped tool definitions and permission types

export type ToolCategory = 'filesystem' | 'terminal' | 'desktop' | 'web' | 'system' | 'image' | 'video' | 'workflow'

export type PermissionLevel = 'blocked' | 'confirm' | 'auto'

export type PermissionMap = Record<ToolCategory, PermissionLevel>

export const DEFAULT_PERMISSIONS: PermissionMap = {
  filesystem: 'confirm',
  terminal: 'confirm',
  desktop: 'confirm',
  web: 'auto',
  system: 'auto',
  image: 'confirm',
  // Video generation went LIVE in v2.5.3 (T2V via Wan/Hunyuan/AnimateDiff,
  // I2V via SVD/FramePack — David 2026-06-10 "T2V und I2V klappen beide
  // problemlos"). Same confirm-gate as image. permissionStore migrates the
  // old persisted 'blocked' (which was UI-locked, never a user choice) up.
  video: 'confirm',
  workflow: 'confirm',
}

// A loose JSON-Schema-ish property shape. Deliberately recursive so tool inputs
// can model arrays (`items`), nested objects (`properties` / `additionalProperties`
// — e.g. the image/video `settings` pass-through), and numeric bounds. Kept
// permissive on purpose: this is forwarded verbatim to the model as the tool's
// `parameters`, not strictly validated here.
export interface JSONSchemaProp {
  /** Single JSON-Schema type or a union (e.g. ['string','array'] for the
   *  multi-LoRA param). The args-validator already understands unions. */
  type: string | string[]
  description?: string
  enum?: string[]
  items?: JSONSchemaProp
  properties?: Record<string, JSONSchemaProp>
  /** Required keys of a NESTED object schema. The type carried `properties` but
   *  not this, so a nested object could declare its fields and never mark any
   *  of them mandatory. `todo_write` (2026-08-05) is the first tool to need it:
   *  every plan item must have both a content and a status. */
  required?: string[]
  additionalProperties?: boolean | JSONSchemaProp
  default?: unknown
  minimum?: number
  maximum?: number
}

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, JSONSchemaProp>
    required: string[]
    additionalProperties?: boolean
  }
  category: ToolCategory
  source: 'builtin' | 'external'
  serverId?: string // for external MCP server tools
}

export interface MCPServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

/**
 * The argument object a tool executor receives.
 *
 * These values come from the MODEL, not from us: a JSON object the LLM emitted
 * (or a retried/repaired variant of it). Nothing about the declared
 * `inputSchema` is enforced before the executor runs, so every field is
 * genuinely of unknown type until the executor checks it — which is exactly
 * what `unknown` says and what `any` used to hide.
 */
export type ToolArgs = Record<string, unknown>
