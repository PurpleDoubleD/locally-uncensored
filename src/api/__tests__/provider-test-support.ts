/**
 * Shared typing helpers for the provider tests.
 *
 * Not a test file — the vitest include glob only matches names ending in
 * `.test.ts` — just the three moves every provider test used to make with `any`:
 *
 *   1. reading back the request body a fetch spy captured,
 *   2. narrowing a caught error before asserting on its fields,
 *   3. giving backend.ts's `isTauri()` a `window` to look at under node.
 *
 * The point of (1) is that the caller names the PRODUCTION request type
 * (`OpenAIChatRequest`, `MessagesBody`, `OllamaChatRequest`). A fixture read
 * as `any` notices nothing when a provider renames a field; read as the
 * exported request interface, the assertion stops compiling.
 */

import { ProviderError } from '../providers/types'
import { isRecord } from '../providers/wire'

/** One recorded `fetch` call: `[input, init?]`, whatever the mock lib names them. */
type RecordedCall = readonly unknown[]

/**
 * The JSON body of a captured fetch call, typed as the request interface the
 * production code builds. Throws (failing the test loudly) when that call was
 * never made or carried no string body — the two ways an `as any` read used to
 * turn into a confusing `undefined` further down the assertion.
 */
export function sentJson<T>(calls: readonly RecordedCall[], call = 0): T {
  const init = calls[call]?.[1]
  const body = isRecord(init) ? init.body : undefined
  if (typeof body !== 'string') {
    throw new Error(
      `expected fetch call #${call} to carry a JSON string body, ` +
      `got ${calls.length} call(s) and body of type ${typeof body}`,
    )
  }
  return JSON.parse(body) as T
}

/** How many calls the spy recorded — for the `.length` assertions. */
export function callUrl(calls: readonly RecordedCall[], call = 0): string {
  const input = calls[call]?.[0]
  return typeof input === 'string' ? input : String(input)
}

/**
 * Narrow a caught value to ProviderError with a real `instanceof` check, so
 * `err.code` / `err.status` are read off a checked type instead of `any`.
 * A non-ProviderError throw fails the test here rather than silently
 * satisfying an `expect(e.code).toBe(undefined)`.
 */
export function asProviderError(e: unknown): ProviderError {
  if (!(e instanceof ProviderError)) {
    throw new Error(`expected a ProviderError, got: ${describeThrown(e)}`)
  }
  return e
}

/** Same, for the paths that throw a plain Error. */
export function asError(e: unknown): Error {
  if (!(e instanceof Error)) {
    throw new Error(`expected an Error, got: ${describeThrown(e)}`)
  }
  return e
}

function describeThrown(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return typeof e === 'object' ? JSON.stringify(e) : String(e)
}

/**
 * backend.ts's `isTauri()` probes `window.__TAURI_INTERNALS__`. Under the node
 * test environment there is no `window` at all, so the probe throws instead of
 * returning false and the provider never reaches the mockable `globalThis.fetch`.
 * An empty object is enough to make it answer "not Tauri".
 */
export function stubBrowserWindow(): void {
  // Reflect, not a cast: the DOM lib types `globalThis.window` as a full
  // `Window`, so any direct assignment needs an `as any` to get an empty
  // object past it — which is exactly the escape hatch this file removes.
  if (typeof Reflect.get(globalThis, 'window') === 'undefined') {
    Reflect.set(globalThis, 'window', {})
  }
}

/** The argument list `globalThis.fetch` is called with, for mock signatures. */
export type FetchArgs = Parameters<typeof fetch>
