/**
 * Token and headers of an MCP server reached by URL (M1).
 *
 * Kept the way provider API keys are kept (stores/providerStore.ts, H5): the
 * OS vault (Keychain, Credential Manager) through the parked namespace of the
 * Rust secret commands, which takes any slug of [a-z0-9-]{1,64}. Where the
 * vault does not work (a Linux desktop without one, the web build) the value
 * falls back to localStorage under the same light obfuscation the provider
 * keys use there. The server entry in mcpStore only carries `hasAuth`, so the
 * values never reach the persisted store, an export or a log line.
 */

import { secretParkDelete, secretParkGet, secretParkSet } from '../api/backend'
import type { McpHttpAuth } from '../api/mcp/http-client'

const FALLBACK_KEY = 'locally-uncensored-mcp-auth'

/** The vault account for one server entry. */
export function mcpSecretAccount(serverId: string): string {
  const slug = serverId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60)
  return `mcp-${slug}`
}

function obfuscate(v: string): string {
  try { return btoa(encodeURIComponent(v).split('').reverse().join('')) } catch { return '' }
}
function deobfuscate(v: string): string {
  try { return decodeURIComponent(atob(v).split('').reverse().join('')) } catch { return '' }
}

function readFallback(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(FALLBACK_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}
function writeFallback(all: Record<string, string>) {
  try {
    if (Object.keys(all).length) globalThis.localStorage?.setItem(FALLBACK_KEY, JSON.stringify(all))
    else globalThis.localStorage?.removeItem(FALLBACK_KEY)
  } catch {
    // Storage full or blocked: the value is then kept for this session only.
  }
}

/** Only a token or at least one named header counts as something to keep. */
export function hasMcpAuth(auth: McpHttpAuth | null | undefined): boolean {
  return !!auth && (!!auth.token?.trim() || Object.keys(auth.headers ?? {}).some((k) => k.trim()))
}

function parseAuth(raw: string | null | undefined): McpHttpAuth | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const r = v as Record<string, unknown>
    const headers: Record<string, string> = {}
    if (r.headers && typeof r.headers === 'object') {
      for (const [k, val] of Object.entries(r.headers as Record<string, unknown>)) {
        if (typeof val === 'string') headers[k] = val
      }
    }
    return { token: typeof r.token === 'string' ? r.token : undefined, headers }
  } catch {
    return null
  }
}

/** Store (or, for an empty value, remove) what one server signs in with. */
export async function saveMcpAuth(serverId: string, auth: McpHttpAuth | null): Promise<void> {
  if (!hasMcpAuth(auth)) return deleteMcpAuth(serverId)
  const value = JSON.stringify({ token: auth!.token?.trim() || undefined, headers: auth!.headers ?? {} })
  const account = mcpSecretAccount(serverId)
  try {
    await secretParkSet(account, value)
    const all = readFallback()
    if (account in all) { delete all[account]; writeFallback(all) }
  } catch {
    const all = readFallback()
    all[account] = obfuscate(value)
    writeFallback(all)
  }
}

/** What one server signs in with, or null. */
export async function loadMcpAuth(serverId: string): Promise<McpHttpAuth | null> {
  const account = mcpSecretAccount(serverId)
  try {
    const fromVault = parseAuth(await secretParkGet(account))
    if (fromVault) return fromVault
  } catch {
    // No vault here: the fallback below.
  }
  const stored = readFallback()[account]
  return stored ? parseAuth(deobfuscate(stored)) : null
}

export async function deleteMcpAuth(serverId: string): Promise<void> {
  const account = mcpSecretAccount(serverId)
  try { await secretParkDelete(account) } catch { /* nothing in the vault */ }
  const all = readFallback()
  if (account in all) { delete all[account]; writeFallback(all) }
}

/**
 * Headers from the form, one `Name: value` per line. Lines without a colon or
 * without a name are left out.
 */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    if (!name || /\s/.test(name)) continue
    out[name] = line.slice(at + 1).trim()
  }
  return out
}
