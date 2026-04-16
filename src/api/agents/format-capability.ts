/**
 * Phase 4 (v2.4.0) — Ollama `format` capability probe.
 *
 * Ollama supports a `format` request parameter for constrained JSON output
 * (`format: "json"` or, as of 0.5+, `format: <JSON-Schema>` for strict
 * structured output). Support varies by MODEL, not by server version:
 *   - Most modern models (Qwen 3, Llama 3.1+, Gemma 3/4) handle it cleanly.
 *   - Some older quants crash, refuse, or hang the daemon when given it.
 *
 * To stay safe we probe per-model the first time we would use `format`,
 * cache the result in localStorage, and silently fall back to unconstrained
 * generation on failure.
 *
 * This module is deliberately pure + side-effect-light — it exposes a probe
 * entry point and two cache helpers. Actual probing is done by the caller
 * (ollama-provider) with a tiny request under a short timeout.
 */

const STORAGE_KEY = 'lu-format-capability-v1'
/** How long a cached negative-probe result is considered valid. */
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

export type FormatCapability = 'supported' | 'unsupported' | 'unknown'

type CacheEntry = {
  capability: 'supported' | 'unsupported'
  checkedAt: number
}

type CacheShape = Record<string, CacheEntry>

function loadCache(): CacheShape {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveCache(cache: CacheShape): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Quota errors etc. — swallowed; capability will re-probe next session.
  }
}

/**
 * Returns the cached capability for a model. 'unknown' means the caller
 * should probe before sending `format`. Negative results older than
 * NEGATIVE_TTL_MS are treated as 'unknown' so models that once failed can
 * be re-tried (Ollama upgrades, model re-quantisation, etc.).
 */
export function getFormatCapability(model: string): FormatCapability {
  const cache = loadCache()
  const entry = cache[model]
  if (!entry) return 'unknown'
  if (entry.capability === 'supported') return 'supported'
  if (Date.now() - entry.checkedAt > NEGATIVE_TTL_MS) return 'unknown'
  return 'unsupported'
}

/** Mark a model as supporting `format`. Sticky — retained indefinitely. */
export function markFormatSupported(model: string): void {
  const cache = loadCache()
  cache[model] = { capability: 'supported', checkedAt: Date.now() }
  saveCache(cache)
}

/**
 * Mark a model as NOT supporting `format`. Expires after NEGATIVE_TTL_MS
 * so infra upgrades can be picked up without manual cache clears.
 */
export function markFormatUnsupported(model: string): void {
  const cache = loadCache()
  cache[model] = { capability: 'unsupported', checkedAt: Date.now() }
  saveCache(cache)
}

/** Drop the cache entry for a model (forces re-probe next use). */
export function clearFormatCapability(model: string): void {
  const cache = loadCache()
  delete cache[model]
  saveCache(cache)
}

/** Debug / test helper — wipe the entire capability cache. */
export function resetFormatCapabilityCache(): void {
  saveCache({})
}

/**
 * Probe a model for `format` support. The probe sends a minimal
 * /api/generate request with `format: "json"`, a 3-second abort timeout,
 * and a trivial prompt that must return valid JSON.
 *
 * The probe is deliberately tolerant: a non-JSON response is treated as
 * unsupported, a timeout as unsupported, a network error re-throws so the
 * caller can distinguish transport issues from model issues.
 */
export async function probeFormatSupport(
  model: string,
  ollamaBaseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<'supported' | 'unsupported'> {
  const url = `${ollamaBaseUrl.replace(/\/$/, '')}/api/generate`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt: 'Return the JSON object {"ok":true} and nothing else.',
        stream: false,
        format: 'json',
        options: { temperature: 0, num_predict: 32 },
      }),
    })
    clearTimeout(timer)
    if (!res.ok) {
      markFormatUnsupported(model)
      return 'unsupported'
    }
    const data = await res.json().catch(() => null)
    const text: string = data?.response ?? ''
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        markFormatSupported(model)
        return 'supported'
      }
    } catch {
      // Not JSON — model ignored the format param.
    }
    markFormatUnsupported(model)
    return 'unsupported'
  } catch (err) {
    clearTimeout(timer)
    if ((err as DOMException)?.name === 'AbortError') {
      markFormatUnsupported(model)
      return 'unsupported'
    }
    // Network / transport — leave cache alone and surface the error.
    throw err
  }
}
