/**
 * The providers the phone lists under "Your own keys" (E12), and the pure
 * rules around them: which address is allowed, how a failed test reads.
 */
import { compatProviderId } from '../../../../api/providers/compat-id'
import { PROVIDER_PRESETS, type ProviderId } from '../../../../api/providers/types'

export type OwnProviderId = 'openrouter' | 'groq' | 'together' | 'deepseek' | 'mistral' | 'minimax' | 'openai' | 'anthropic' | 'custom'

export interface OwnProvider {
  id: OwnProviderId
  name: string
  /** 'anthropic' uses its own slot of the provider store; 'compat' speaks the OpenAI protocol. */
  kind: 'anthropic' | 'compat'
  /** Fixed address of a hosted provider; empty for the custom endpoint, which asks for one. */
  baseUrl: string
  keyPlaceholder: string
}

const HOSTED: ReadonlyArray<Exclude<OwnProviderId, 'custom' | 'anthropic'>> = ['openrouter', 'groq', 'together', 'deepseek', 'mistral', 'minimax', 'openai']

function preset(id: string) {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/** The list in the order of DESIGN.md E12. Names and addresses come from the presets of the logic layer. */
export function ownProviders(customName: string): OwnProvider[] {
  const hosted: OwnProvider[] = HOSTED.map((id) => {
    const p = preset(id)
    return { id, name: p?.name ?? id, kind: 'compat', baseUrl: p?.baseUrl ?? '', keyPlaceholder: p?.placeholder ?? '' }
  })
  const anthropic = preset('anthropic')
  return [
    ...hosted,
    { id: 'anthropic', name: anthropic?.name ?? 'Anthropic', kind: 'anthropic', baseUrl: anthropic?.baseUrl ?? '', keyPlaceholder: anthropic?.placeholder ?? '' },
    { id: 'custom', name: customName, kind: 'compat', baseUrl: '', keyPlaceholder: '' },
  ]
}

/**
 * The slot of the provider store a row of this list writes to. Anthropic has
 * its own fixed slot. Everything that speaks the OpenAI protocol gets an
 * extra slot of its own (`openai-<id>`), never the shared `openai` slot: on a
 * phone that one belongs to the on device engine.
 */
export function slotOf(provider: OwnProvider): ProviderId {
  if (provider.kind === 'anthropic') return 'anthropic'
  return compatProviderId(provider.id) ?? 'anthropic'
}

/** True for an address on the user's own network, where nobody is billed. */
export function isOwnNetworkAddress(baseUrl: string): boolean {
  try {
    return isPrivateHost(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

export function findOwnProvider(id: string | undefined, customName: string): OwnProvider | null {
  return ownProviders(customName).find((p) => p.id === id) ?? null
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  return h === '::1' || h.startsWith('fd') || h.startsWith('fe80:')
}

/**
 * E12.4: the address must start with https, or be a device on the user's own
 * network. Returns the cleaned address, or null when it is not allowed.
 */
export function cleanBaseUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  if (url.protocol === 'https:') return text.replace(/\/+$/, '')
  if (url.protocol === 'http:' && isPrivateHost(url.hostname)) return text.replace(/\/+$/, '')
  return null
}

export type TestFailure = 'bad-key' | 'unreachable' | 'offline'

/** Why a connection test failed, from what the provider client threw. */
export function testFailure(err: unknown, online: boolean): TestFailure {
  if (!online) return 'offline'
  const e = err as { code?: unknown; status?: unknown } | null
  if (e && (e.code === 'auth' || e.status === 401 || e.status === 403)) return 'bad-key'
  return 'unreachable'
}

/** A key is never shown. This is all the page ever says about a saved one. */
export function looksLikeKey(input: string): boolean {
  const text = input.trim()
  return text.length >= 8 && !/\s/.test(text)
}
