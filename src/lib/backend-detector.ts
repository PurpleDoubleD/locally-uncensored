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

const PROBE_TIMEOUT = 2000 // 2 seconds

/**
 * Probe a single backend URL. Returns true if reachable.
 */
async function probeBackend(baseUrl: string, isOllama: boolean): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT)

  try {
    const url = isOllama
      ? baseUrl.replace(/\/v1$/, '') + '/api/tags'  // Ollama uses /api/tags
      : baseUrl + '/models'                          // OpenAI-compat uses /v1/models

    let res: Response

    if (isTauri()) {
      // In Tauri, use proxy to avoid CORS
      res = await localFetch(url)
    } else {
      res = await fetch(url, { signal: controller.signal })
    }

    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
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
