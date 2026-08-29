/**
 * Counter-check round 2, side finding 6 (installed Windows build, 2026-08-29).
 *
 * On a box with no Ollama installed, the app knocked on
 * http://localhost:11434/api/ps every 1.5 seconds, forever, and wrote two
 * console lines per attempt:
 *
 *   [localFetch] Proxy failed, trying direct fetch  err: proxy_localhost: ...
 *   Failed to load resource: net::ERR_CONNECTION_REFUSED
 *
 * Over forty hits inside a single chat round. Nothing broke, but the real
 * errors drowned in it during exactly the kind of fault-finding this run was.
 *
 * Run: npx vitest run src/lib/__tests__/probe-backoff.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  nextProbeDelayMs,
  shouldLogRepeat,
  PROBE_BASE_MS,
  PROBE_MAX_MS,
} from '../probe-backoff'

describe('nextProbeDelayMs', () => {
  it('keeps the brisk beat while the backend answers', () => {
    expect(nextProbeDelayMs(0)).toBe(PROBE_BASE_MS)
    expect(PROBE_BASE_MS).toBe(1500)
  })

  it('doubles the gap on every consecutive miss', () => {
    expect([1, 2, 3, 4, 5].map((n) => nextProbeDelayMs(n))).toEqual([3000, 6000, 12000, 24000, 48000])
  })

  it('stops climbing at one minute', () => {
    expect(nextProbeDelayMs(6)).toBe(PROBE_MAX_MS)
    expect(nextProbeDelayMs(50)).toBe(PROBE_MAX_MS)
    expect(PROBE_MAX_MS).toBe(60_000)
  })

  // NEGATIVE CONTROL: a long-lived window must not turn 2 ** many into
  // Infinity or NaN, and nonsense input must not produce a nonsense gap.
  it('never returns a broken number', () => {
    for (const n of [400, 1e9, -3, NaN, Infinity, undefined as unknown as number]) {
      const d = nextProbeDelayMs(n)
      expect(Number.isFinite(d)).toBe(true)
      expect(d).toBeGreaterThanOrEqual(PROBE_BASE_MS)
      expect(d).toBeLessThanOrEqual(PROBE_MAX_MS)
    }
  })

  it('honours a caller supplied base and cap', () => {
    expect(nextProbeDelayMs(0, 200, 1000)).toBe(200)
    expect(nextProbeDelayMs(9, 200, 1000)).toBe(1000)
  })
})

describe('shouldLogRepeat', () => {
  it('lets the first failure through and swallows the storm behind it', () => {
    const seen = new Map<string, number>()
    expect(shouldLogRepeat(seen, 'localhost', 0)).toBe(true)
    // The forty attempts of one chat round, at the old 1.5 s beat. The
    // fortieth lands exactly on the minute mark and is allowed to speak again,
    // which is the point: one line a minute instead of forty a round.
    for (let i = 1; i <= 39; i++) {
      expect(shouldLogRepeat(seen, 'localhost', i * 1500)).toBe(false)
    }
    expect(shouldLogRepeat(seen, 'localhost', 40 * 1500)).toBe(true)
  })

  it('speaks up again once the window has passed', () => {
    const seen = new Map<string, number>()
    shouldLogRepeat(seen, 'localhost', 0)
    expect(shouldLogRepeat(seen, 'localhost', 59_999)).toBe(false)
    expect(shouldLogRepeat(seen, 'localhost', 60_000)).toBe(true)
  })

  // NEGATIVE CONTROL: throttling one host must never silence another. A
  // genuinely new error has to stay visible, which is the whole point.
  it('throttles per host, not globally', () => {
    const seen = new Map<string, number>()
    expect(shouldLogRepeat(seen, 'localhost', 0)).toBe(true)
    expect(shouldLogRepeat(seen, '127.0.0.1', 10)).toBe(true)
    expect(shouldLogRepeat(seen, '192.168.0.54', 20)).toBe(true)
  })
})

// ── Wiring ───────────────────────────────────────────────────────────────────
// The dropdown cannot be rendered here (the suite runs on the node
// environment), so the source is the evidence for the two call sites.
const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('the pollers actually back off', () => {
  const selector = read('../../components/models/ModelSelector.tsx')

  it('the model dropdown reschedules with the ladder', () => {
    expect(selector).toContain("import { nextProbeDelayMs } from '../../lib/probe-backoff'")
    expect(selector).toContain('setTimeout(tick, nextProbeDelayMs(misses))')
  })

  // NEGATIVE CONTROL: the fixed 1.5 s interval must be gone. A backoff that
  // still runs next to a setInterval would poll just as often.
  it('the fixed 1.5 second interval is gone', () => {
    expect(selector).not.toContain('setInterval(refresh, 1500)')
  })

  it('the proxy fallback logs one line per host per window', () => {
    const backend = read('../../api/backend.ts')
    expect(backend).toContain("import { shouldLogRepeat } from \"../lib/probe-backoff\"")
    expect(backend).toContain('shouldLogRepeat(proxyWarnSeen, hostnameOf(url), Date.now())')
  })
})
