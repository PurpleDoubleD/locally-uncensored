/**
 * AS-10 — der eine echte Fehler unter den 43 `no-unused-vars`.
 *
 * `executeWebFetch` hat zwei Wege: erst den Rust-Befehl `web_fetch`, und wenn
 * der wirft, den Browser-Fallback `fetchExternal` + `htmlToText`. Scheiterten
 * BEIDE, stand da:
 *
 *     } catch (fallbackErr) {
 *       return `Error: web_fetch failed: ${e instanceof Error ? e.message : String(e)}`
 *     }
 *
 * `fallbackErr` wurde benannt und dann weggeworfen; gemeldet wurde `e`, der
 * Fehler des ERSTEN Wegs. Das ist kein Aufraeumfall, sondern ein Diagnosefehler:
 * im Browser-/Dev-Modus ist der Rust-Befehl grundsaetzlich nicht erreichbar,
 * `e` ist dort auf jedem Fehlschlag derselbe konstante Satz. Der einzige Text,
 * der sagt, was wirklich passiert ist — DNS, CORS, 404, Timeout —, steckt in
 * `fallbackErr`, und das Modell bekam ihn nie zu sehen. Es sieht auf jeden
 * kaputten Link dieselbe Zeile und kann nichts daraus machen.
 *
 * Dreissig Zeilen weiter oben schreibt `executeWebSearch` die Regel selbst hin:
 * ein still verschluckter Provider-Fehler "would look like search is broken".
 *
 * Run: npx vitest run src/api/mcp/__tests__/web-fetch-nennt-den-grund-des-fallbacks.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Was der Rust-Weg wirft. Im Browser-/Dev-Modus IMMER dasselbe. */
const PRIMARY = 'Tauri backend not available'
/** Was der Fallback wirft. Wechselt pro Seite — das ist die nuetzliche Haelfte. */
let fallbackThrow: unknown = new Error('CORS policy blocked https://example.com')

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string) => {
    if (cmd === 'web_fetch') throw new Error(PRIMARY)
    return { ok: true }
  }),
  fetchExternal: vi.fn(async () => {
    throw fallbackThrow
  }),
}))
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { registerBuiltinTools } from '../builtin-tools'
import { ToolRegistry } from '../tool-registry'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

const fetchUrl = (url = 'https://example.com') =>
  registry.execute('web_fetch', { url }) as Promise<string>

beforeEach(() => {
  fallbackThrow = new Error('CORS policy blocked https://example.com')
})

describe('web_fetch: scheitern beide Wege, zaehlt der Grund des zweiten', () => {
  it('SONDE: der Grund des Fallbacks steht in der Meldung', async () => {
    const out = await fetchUrl()
    // Genau die Zeile, die der Fix einsetzt. Nimmt man ihn zurueck (also
    // `fallbackErr` wieder wegwerfen und nur `e` melden), faellt dieses expect.
    expect(out).toContain('CORS policy blocked https://example.com')
  })

  it('der Fehler des ersten Wegs bleibt als Kontext erhalten', async () => {
    // Beide Haelften, nicht die eine gegen die andere getauscht: dass der
    // Rust-Weg zuerst gescheitert ist, ist die Erklaerung dafuer, warum
    // ueberhaupt ein Fallback lief.
    const out = await fetchUrl()
    expect(out).toContain(PRIMARY)
    expect(out.startsWith('Error: web_fetch failed:')).toBe(true)
  })

  it('unterscheidbar: zwei verschiedene Fallback-Fehler geben zwei verschiedene Meldungen', async () => {
    // Der eigentliche Schaden war nicht der fehlende Satz, sondern dass ALLE
    // Fehlschlaege gleich aussahen. Vor dem Fix waren diese beiden Meldungen
    // Zeichen fuer Zeichen identisch.
    const a = await fetchUrl()
    fallbackThrow = new Error('getaddrinfo ENOTFOUND example.invalid')
    const b = await fetchUrl('https://example.invalid')
    expect(a).not.toBe(b)
    expect(b).toContain('ENOTFOUND')
  })

  it('ein Nicht-Error als Fallback-Grund wird trotzdem gemeldet, nicht verschluckt', async () => {
    // `throw 'string'` kommt aus fremdem Code haeufiger vor als man denkt;
    // String(fallbackErr) muss dann greifen statt einer leeren Stelle.
    fallbackThrow = 'roher String statt Error'
    const out = await fetchUrl()
    expect(out).toContain('roher String statt Error')
  })
})
