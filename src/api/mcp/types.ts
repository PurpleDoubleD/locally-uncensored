// MCP-shaped tool definitions and permission types
import { isMobile } from '../../lib/device-kind'
import { mobilePermissionDefaults } from '../../lib/mobile-permission-defaults'

// 'mcp' holds every tool of an external MCP server (B12, 28.10.2026). Those
// tools used to be filed under 'workflow', so "Workflows: Auto" ran a shell or
// file MCP server unattended while "Terminal: Blocked" never saw it. A server
// can do anything, so its tools get a row of their own that asks first.
export type ToolCategory = 'filesystem' | 'terminal' | 'desktop' | 'web' | 'system' | 'image' | 'video' | 'workflow' | 'mcp'

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
  // I2V via SVD/FramePack — 2026-06-10 "T2V und I2V klappen beide
  // problemlos"). Same confirm-gate as image. permissionStore migrates the
  // old persisted 'blocked' (which was UI-locked, never a user choice) up.
  video: 'confirm',
  workflow: 'confirm',
  mcp: 'confirm',
}

/**
 * The defaults a fresh install starts with on THIS device. A desktop gets
 * DEFAULT_PERMISSIONS, value for value. A phone starts with the categories
 * blocked whose tools do not exist there (terminal, desktop, image, video).
 */
export function defaultPermissionsForDevice(): PermissionMap {
  return isMobile() ? mobilePermissionDefaults(DEFAULT_PERMISSIONS) : { ...DEFAULT_PERMISSIONS }
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
  /** The name the user gave the server, for `<server>: <tool>` in the UI. */
  serverName?: string
  /** One line, at most 150 characters, for a tool search that lists tools
   *  without their schema (C59/C60, 3.1.0). Never sent as the description. */
  brief?: string
}

/**
 * How LU reaches an external server: 'stdio' starts a local command (npx or
 * uvx) and talks over its stdin and stdout, 'http' posts to one URL
 * (Streamable HTTP, MCP 2025-03-26 and later). An entry from before M1 has no
 * transport and is 'stdio'.
 */
export type MCPTransport = 'stdio' | 'http'

export interface MCPServerConfig {
  id: string
  name: string
  /** Left out on every entry saved before M1, which means 'stdio'. */
  transport?: MCPTransport
  /** The endpoint of an 'http' server. */
  url?: string
  /**
   * True when a token or headers for this server sit in the vault
   * (lib/mcp-secrets.ts). The values themselves are never in this object, so
   * they never reach localStorage, a log line or an export.
   */
  hasAuth?: boolean
  /** Empty for an 'http' server. */
  command: string
  args: string[]
  env?: Record<string, string>
  /** The folder the server runs in; the app's own where it is left out. A
   *  plugin server (lib/plugins) works in its own folder. */
  cwd?: string
  /** How long the `initialize` handshake may take, in ms; 30 s when left
   *  out. A server that `npx` installs on its first start answers only once
   *  its packages are in, and that can take minutes (lib/plugins/rea.ts). */
  initializeTimeoutMs?: number
  enabled: boolean
}

/** Is this entry reached over a URL? */
export function isHttpServer(config: Pick<MCPServerConfig, 'transport'>): boolean {
  return config.transport === 'http'
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
