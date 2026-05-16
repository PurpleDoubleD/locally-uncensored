/**
 * Ollama error detection + typed errors.
 *
 * Ollama 0.20.x strict-rejects models whose on-disk manifest lacks the
 * runtime `capabilities` field (either pulled before Ollama 0.15 or whose
 * registry entry has been re-published since the local pull). The server
 * returns HTTP 400 with `{"error":"\"<model>\" does not support (chat|completion|generate)"}`.
 *
 * Two additional wrapping layers matter in practice:
 *   1. Tauri `proxy_localhost` wraps any non-2xx as Rust `Err("HTTP 400: <body>")`.
 *      The JS `localFetch` catches that, tries a direct fetch fallback, and
 *      if that also fails returns a synthetic `Response` with status 500 and
 *      body `{"error":"HTTP 400: {…}"}`.
 *   2. JSON encoding quotes the model name as `\"phi4:14b\"` when it's nested
 *      inside an outer JSON string.
 *
 * The regex here is tolerant to both wrappings and to all three API verbs
 * that can trigger it (`/api/chat`, `/api/generate` via `prompt`/`completion`).
 */

export type OllamaErrorKind = 'stale-manifest' | 'missing-blob' | 'connection' | 'other'

export interface ParsedOllamaError {
  kind: OllamaErrorKind
  model: string | null
  /** Human-readable, actionable message. */
  message: string
  /** Original raw error string (for logs). */
  raw: string
}

const STALE_MANIFEST_RE =
  /[\\'"]*([\w.:/\-]+?)[\\'"]*\s+does not support (chat|completion|generate)/i
// Ollama 0.20.7's /api/show returns 404 "model '<name>' not found" for
// manifests it can no longer parse — empirically this only happens for
// stale manifests pulled before the registry-side capabilities refresh.
// Fresh pulls of the same model name succeed. Treated as stale-manifest so
// the scan + banner can offer a one-click refresh.
const SHOW_NOT_FOUND_RE = /model\s+['"]?([\w.:/\-]+?)['"]?\s+not\s+found/i
// Bug C (v2.4.5 — Anson192 GH Discussion #39, RTX 4090): Ollama reports
// `unable to load model: <path>/blobs/sha256-<hash>` (HTTP 500) when the
// manifest references a blob that isn't on disk. Happens when blobs are
// manually deleted, the model dir lives on an external drive that wasn't
// mounted at pull time, or filesystem corruption. The fix is the same
// recovery path as stale-manifest: `ollama pull <name>` re-fetches missing
// blobs. We don't know the model NAME from this error (only the blob
// hash), so callers carry the active model name in through ModelLoadError.
const MISSING_BLOB_RE = /unable to load model[:\s].*blobs[\\/]+sha256-[0-9a-f]+/i

/**
 * Parse an Ollama error response into a typed structure.
 * `res` must be a non-ok Response. Safe to call on already-consumed bodies
 * (will return an `other` with the fallback message).
 *
 * `fallbackModel` is used by missing-blob detection (Bug C) — Ollama's
 * error string carries only the blob hash, so callers that know which
 * model they were trying to load pass it in for the user-facing message.
 */
export async function parseOllamaError(
  res: Response,
  fallback = 'Ollama request failed',
  fallbackModel?: string,
): Promise<ParsedOllamaError> {
  let raw = fallback
  try {
    const text = await res.text()
    // Only surface JSON error bodies — non-JSON responses (HTML gateway pages,
    // empty bodies) collapse to the caller-supplied fallback to avoid leaking
    // framework noise into the UI. Matches the pre-refactor behaviour of
    // OllamaProvider.extractError so existing tests keep passing.
    try {
      const data = JSON.parse(text)
      raw = (data && typeof data.error === 'string' ? data.error : fallback) || fallback
    } catch {
      raw = fallback
    }
  } catch {
    raw = fallback
  }

  if (typeof raw === 'string') {
    const m1 = raw.match(STALE_MANIFEST_RE)
    if (m1) {
      const model = m1[1]
      return {
        kind: 'stale-manifest',
        model,
        message: `Model "${model}" has a stale manifest. Run "ollama pull ${model}" to refresh.`,
        raw,
      }
    }
    // Bug C: missing-blob — the error string contains only the on-disk
    // blob path, not the model name. We surface kind='missing-blob' with
    // model=null and let the calling layer (loadModel) populate the model
    // name from its arguments when constructing ModelLoadError.
    if (MISSING_BLOB_RE.test(raw)) {
      const model = fallbackModel || null
      return {
        kind: 'missing-blob',
        model,
        message: model
          ? `Ollama could not load "${model}" — one of its blobs is missing on disk. Run "ollama pull ${model}" to re-fetch.`
          : 'Ollama could not load the model — one of its blobs is missing on disk. Run "ollama pull <model>" to re-fetch.',
        raw,
      }
    }
    // NOTE: we intentionally do NOT treat "model X not found" as stale here.
    // That string also legitimately fires for genuinely absent models
    // (user types a model name that was never pulled). The health scanner
    // cross-references with /api/tags before calling parseShowNotFound to
    // disambiguate — see `checkModelCapability` in api/ollama.ts.
  }

  return { kind: 'other', model: null, message: raw, raw }
}

/**
 * Parse `{"error":"model 'X' not found"}` bodies from /api/show.
 * Returns the captured model name or null. Only the scanner should call this,
 * and only AFTER verifying the name is present in /api/tags — the string
 * `model X not found` also fires for genuinely absent models (a user typing
 * a model that was never pulled) and we must not flag those as stale.
 */
export function parseShowNotFound(raw: string): string | null {
  const m = raw.match(SHOW_NOT_FOUND_RE)
  return m ? m[1] : null
}

/** Typed error thrown by loadModel / unloadModel. */
export class ModelLoadError extends Error {
  readonly kind: OllamaErrorKind
  readonly model: string
  readonly raw: string
  constructor(parsed: ParsedOllamaError, model: string) {
    super(parsed.message)
    this.name = 'ModelLoadError'
    this.kind = parsed.kind
    this.model = parsed.model || model
    this.raw = parsed.raw
  }
}

/**
 * Produce the same user-facing message as the chat path's `extractError`.
 * Kept separate so the detection logic stays in one place; callers that
 * want the chat-style wording (terminal instructions) can use this.
 */
export function chatStyleMessage(parsed: ParsedOllamaError): string {
  if (parsed.kind === 'stale-manifest' && parsed.model) {
    return `Ollama rejected "${parsed.model}" — its manifest is stale. Open a terminal and run: ollama pull ${parsed.model}   Then reload the model.`
  }
  if (parsed.kind === 'missing-blob') {
    const model = parsed.model || '<model>'
    return `Ollama could not load "${model}" — one of its on-disk blobs is missing. Open a terminal and run: ollama pull ${model}   Then reload the model.`
  }
  return parsed.message
}
