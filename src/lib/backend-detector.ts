/**
 * Local Backend Auto-Detection
 *
 * Probes all known local LLM backend ports in parallel on startup.
 * Returns which backends are currently running and reachable.
 */

import { PROVIDER_PRESETS } from '../api/providers/types'
import { localFetch, isTauri } from '../api/backend'

export interface DetectedBackend {
  id: string        // preset id: 'ollama', 'lmstudio', 'vllm', etc.
  name: string      // "LM Studio", "vLLM", etc.
  baseUrl: string   // "http://localhost:1234/v1"
  port: number
}

const PROBE_TIMEOUT = 2000 // 2 seconds — backend probe must be fast or skipped

/**
 * Probe a single backend URL. Returns true if reachable.
 *
 * Hardened against the "TCP connect succeeds, HTTP never replies" hang
 * (Discord report — onboarding stuck on "Searching for local backends..."
 * for 5 min when an unrelated service holds one of our default ports). Two
 * defenses, in order:
 *
 *  1. The Rust-side proxy honours `timeoutMs` and aborts the underlying
 *     reqwest call. In dev mode the equivalent AbortController is wired
 *     into the direct fetch.
 *  2. A frontend `Promise.race` against a hard deadline catches the
 *     pathological case where the proxy itself hangs (e.g. invoke()
 *     internally retries before surfacing the timeout) — the probe
 *     resolves to `false` no matter what.
 *
 * Both layers resolve to "not reachable", never reject, so the parent
 * `Promise.allSettled` always settles within PROBE_TIMEOUT regardless of
 * what the remote port is doing.
 */
async function probeBackend(baseUrl: string, isOllama: boolean): Promise<boolean> {
  const url = isOllama
    ? baseUrl.replace(/\/v1$/, '') + '/api/tags'  // Ollama uses /api/tags
    : baseUrl + '/models'                          // OpenAI-compat uses /v1/models

  const inner = (async (): Promise<boolean> => {
    try {
      let res: Response
      if (isTauri()) {
        res = await localFetch(url, { timeoutMs: PROBE_TIMEOUT })
      } else {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT)
        try {
          res = await fetch(url, { signal: controller.signal })
        } finally {
          clearTimeout(t)
        }
      }
      return res.ok
    } catch {
      return false
    }
  })()

  // Belt-and-suspenders: even if `inner` ignores its timeout (e.g. some
  // future invoke() code path swallows the abort), the race resolves to
  // false at deadline so the onboarding never blocks.
  const deadline = new Promise<boolean>(resolve => {
    setTimeout(() => resolve(false), PROBE_TIMEOUT + 500) // small grace over the inner timeout
  })

  return Promise.race([inner, deadline])
}

/**
 * Extract port from a URL string.
 */
function extractPort(url: string): number {
  const match = url.match(/:(\d+)/)
  return match ? parseInt(match[1]) : 80
}

/**
 * Detect all running local LLM backends by probing their default ports.
 * All probes run in parallel for speed.
 */
export async function detectLocalBackends(): Promise<DetectedBackend[]> {
  const localPresets = PROVIDER_PRESETS.filter(p => p.isLocal && p.baseUrl)

  const results = await Promise.allSettled(
    localPresets.map(async (preset) => {
      const isOllama = preset.providerId === 'ollama'
      const reachable = await probeBackend(preset.baseUrl, isOllama)

      if (reachable) {
        return {
          id: preset.id,
          name: preset.name,
          baseUrl: preset.baseUrl,
          port: extractPort(preset.baseUrl),
        } satisfies DetectedBackend
      }
      return null
    })
  )

  return results
    .filter((r): r is PromiseFulfilledResult<DetectedBackend | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((b): b is DetectedBackend => b !== null)
}
