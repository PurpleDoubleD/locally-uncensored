/**
 * Local Backend Auto-Detection
 *
 * Probes all known local LLM backend ports in parallel on startup.
 * Returns which backends are currently running and reachable.
 */

import { PROVIDER_PRESETS } from '../api/providers/types'
import { localFetch, isTauri } from '../api/backend'
import { ollamaProbeBase } from './ollama-host-sync'
import { hasForeignBackends } from './capabilities'

export interface DetectedBackend {
  id: string        // preset id: 'ollama', 'lmstudio', 'vllm', etc.
  name: string      // "LM Studio", "vLLM", etc.
  baseUrl: string   // "http://localhost:1234/v1"
  port: number
}

/**
 * Which detected backend the selection dialog has marked, given the user's own
 * pick (null until they click) and the list as it currently stands.
 *
 * AppShell mounts the dialog with an EMPTY list and fills it seconds later,
 * once the idle-time detection has run, so a position taken from the list
 * before the list exists is the bug this exists to prevent: the dialog opened
 * with no row marked, and "Use selected" found nothing under that name,
 * dismissed itself and configured nothing (same class as the picker bug of
 * R10). The rule has two halves and always had: keep the user's pick while the
 * list still holds it, otherwise fall to the first row there is.
 *
 * It lives here, as a pure function, because the repo has no render harness —
 * this is the part worth testing, and it is the part that used to be an effect
 * writing the answer back into state one render after it was knowable.
 */
export function selectedBackendId(picked: string | null, backends: { id: string }[]): string {
  if (picked !== null && backends.some((b) => b.id === picked)) return picked
  return backends[0]?.id || ''
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
 * Die Eintraege, die ein Scan wirklich abklopft.
 *
 * Warum das exportiert ist: der Assistent schrieb waehrend des Scans
 * "Checking 12 backends on their default ports" und zaehlte dafuer seine
 * EIGENE Liste (`BackendsStep.tsx`, `LOCAL_BACKENDS`), die Hilfeliste mit den
 * Downloadlinks fuer den Fall, dass nichts gefunden wurde. Geklopft wird aber
 * an dieser Liste hier, und in ihr steht unter anderem die eingebaute Maschine
 * auf 8127, die in jener gar nicht vorkommt. Die Zahl auf dem Bildschirm war
 * damit schlicht eine andere als die Zahl der Sonden. Jetzt zaehlt der Satz
 * das, was er behauptet.
 */
export const PROBE_TARGETS = PROVIDER_PRESETS.filter(p => p.isLocal && p.baseUrl)

/**
 * Detect all running local LLM backends by probing their default ports.
 * All probes run in parallel for speed.
 */
export async function detectLocalBackends(): Promise<DetectedBackend[]> {
  // A phone has none of them. Fifteen probes on loopback ports would find
  // nothing, or worse, find the app's own engine and rewrite the provider slot.
  if (!hasForeignBackends()) return []
  // Ollama wird an SEINER Adresse geklopft, nicht am Preset: wer OLLAMA_HOST
  // auf eine LAN-Box oder einen Container zeigen laesst, hat auf 11434
  // entweder nichts oder ein anderes Ollama (Issue #31). Die Adresse kommt
  // aus Rust, im Assistentenfenster genauso wie im Hauptfenster. Der Scan
  // meldet sie zurueck, und AppShell schreibt sie als baseUrl fest: das
  // Preset darf dort nie eine eingestellte Adresse ersetzen.
  const ollamaBase = await ollamaProbeBase()
  const results = await Promise.allSettled(
    PROBE_TARGETS.map(async (preset) => {
      const isOllama = preset.providerId === 'ollama'
      const baseUrl = isOllama ? ollamaBase : preset.baseUrl
      const reachable = await probeBackend(baseUrl, isOllama)

      if (reachable) {
        return {
          id: preset.id,
          name: preset.name,
          baseUrl,
          port: extractPort(baseUrl),
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
