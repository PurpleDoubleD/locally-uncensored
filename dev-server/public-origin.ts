/** The administrator's exact browser URL, shared by every dev-server boundary.
 * Never populate this value from Origin, Host or forwarded request headers. */
export function configuredOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || parsed.hostname.includes('*') || parsed.hostname.startsWith('.')) {
    throw new Error('The browser app origin must be an HTTP(S) origin without credentials, a path, query, fragment or wildcard.')
  }
  return parsed.origin
}

/** Vite checks hostnames; application guards separately check the full origin. */
export function devServerAllowedHosts(publicOrigin?: string): string[] {
  const origin = configuredOrigin(publicOrigin)
  return Array.from(new Set(['localhost', '127.0.0.1', ...(origin ? [new URL(origin).hostname] : [])]))
}
