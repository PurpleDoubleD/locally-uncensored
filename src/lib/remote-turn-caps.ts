// Shared chats (mobile-docs/remote/CHATS-V1.md): a turn the paired phone
// started runs with the desktop's tools, but never with more than the
// device may use. While such a turn runs, the categories its rights do not
// cover are switched off for that chat, on top of every other setting
// (stores/permissionStore getEffectivePermissions). Kept in memory only: a
// cap belongs to a run, not to the chat.
import type { PermissionMap, ToolCategory } from '../api/mcp/types'

/** What the device may use, as Rust hands it over with the turn. */
export interface RemoteRights {
  agent: boolean
  files: boolean
  terminal: boolean
  create: boolean
}

const caps = new Map<string, Partial<PermissionMap>>()

/** The tool categories the rights leave out, as 'blocked'. */
export function capsFor(rights: RemoteRights): Partial<PermissionMap> {
  const off: ToolCategory[] = []
  if (!rights.files) off.push('filesystem')
  if (!rights.terminal) off.push('terminal', 'desktop', 'mcp')
  if (!rights.create) off.push('image', 'video', 'workflow')
  if (!rights.agent) off.push('web', 'system')
  return Object.fromEntries(off.map((c) => [c, 'blocked'])) as Partial<PermissionMap>
}

export function setTurnCaps(convId: string, rights: RemoteRights): void {
  caps.set(convId, capsFor(rights))
}

export function clearTurnCaps(convId: string): void {
  caps.delete(convId)
}

export function turnCaps(convId: string | undefined): Partial<PermissionMap> | undefined {
  return convId ? caps.get(convId) : undefined
}

/**
 * A turn the paired phone started is running in this chat. The cards of the
 * desktop (Open this address?, settings, workflow installs) are not drawn on
 * the phone, so such a run must not wait for one: nobody at the phone could
 * answer it, and the phone would hang until the card times out (M310).
 */
export function isPhoneTurn(convId: string | null | undefined): boolean {
  return !!convId && caps.has(convId)
}

/** What a card tool answers in a phone turn. */
export const PHONE_TURN_NO_CARD =
  'NOT DONE. Nothing changed. This message came from the paired phone, and LU only makes this change when the user asks for it at the computer itself. Tell the user so: nothing was changed, and they can ask for it again at the computer.'

/**
 * The category a tool counts as for the phone's rights. A tool of an
 * external MCP server can do anything its server does, so it needs the
 * strictest right, `terminal`, whatever category it is filed under.
 */
export function capCategory(def: { category: ToolCategory; source?: string }): ToolCategory {
  return def.source === 'external' ? 'terminal' : def.category
}
