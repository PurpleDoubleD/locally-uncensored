/**
 * What went wrong in a coding run, in words, and which kind it is (CA U7).
 *
 * The Code tab ended every connection failure with "Is `ollama serve` running
 * on localhost:11434?", also for LM Studio, the LU Engine and every cloud
 * provider. It now names the backend the run actually used, and records the
 * error as a field on the message (types/chat.ts MessageError), the way the
 * Agent tab already does, so the transcript can offer Try again.
 */
import type { MessageErrorKind } from '../../types/chat'

export function networkHint(opts: { providerId: string; name?: string; baseUrl?: string; local: boolean }): string {
  const name = opts.name?.trim() || (opts.providerId === 'ollama' ? 'Ollama' : opts.providerId)
  const where = opts.baseUrl?.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '')
  if (opts.providerId === 'lu-cloud') return 'No connection to LU Cloud. Check your internet connection, then try again.'
  if (opts.local) return `LU can't reach ${name}${where ? ` at ${where}` : ''}. Is it running?`
  return `No connection to ${name}. Check your internet connection, then try again.`
}

export function runErrorKind(opts: { message: string; status?: number; code?: string }): MessageErrorKind {
  if (opts.code === 'credits_exhausted') return 'credits'
  if (opts.code === 'signed_out' || opts.status === 401) return 'session'
  if (opts.status === 429) return 'limit'
  if (/Failed to fetch|NetworkError|net::ERR|ECONNREFUSED|Connection refused/i.test(opts.message)) return 'network'
  if (opts.status && opts.status >= 500) return 'engine'
  return 'generic'
}
