/**
 * N1 (Android 8 GB, mobile-docs/r9/netz.md): ein Link auf eine Datei mit
 * 100 MiB hat die App beendet.
 *
 * Der Rust-Befehl `web_fetch` hat die Datei an seiner Grenze von 8 MiB
 * abgelehnt und den Satz dafuer geworfen. `executeWebFetch` hat jeden Wurf als
 * "Rust nicht erreichbar" gelesen und dieselbe Adresse ein zweites Mal ueber
 * `fetchExternal` geholt. Dieser Weg hat keine Groessengrenze (der ganze
 * Koerper als ein String ueber die Bruecke) und die weitere Adressliste des
 * Katalogs statt `closed_to_a_model`. Eine Absage des ersten Wegs wurde so
 * zum Auftrag an den ungeschuetzten zweiten.
 *
 * In der App ist der Wurf des Rust-Befehls die Antwort. Der Rueckfall bleibt
 * dem Browser-/Dev-Modus, in dem es den Befehl nicht gibt.
 *
 * Run: npx vitest run src/api/mcp/__tests__/web-fetch-kein-rueckfall-in-der-app.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
// P-L (3.1.0): the address gate has its own tests (lib/__tests__/web-research-und-quellen.test.ts).
vi.mock('../../../lib/web-url-provenance', () => ({ guardWebUrl: async () => null, rememberUrls: () => {} }))

const h = vi.hoisted(() => ({
  inApp: true,
  primary: undefined as unknown,
  fetchExternal: vi.fn(async (_url: string) => 'x'),
}))

vi.mock('../../backend', () => ({
  isTauri: () => h.inApp,
  backendCall: vi.fn(async (cmd: string) => {
    if (cmd === 'web_fetch') throw h.primary
    return { ok: true }
  }),
  fetchExternal: h.fetchExternal,
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

const fetchUrl = (url: string) => registry.execute('web_fetch', { url }) as Promise<string>

/** Wortgleich `too_large_message(MAX_BODY)` aus src-tauri/src/commands/web_reach.rs. */
const TOO_LARGE = 'Fetch failed: the page is larger than 8 MB, so it was not read. Use a different address.'
/** Was eine geschlossene Adresse wirft (`strict_addrs`, sinngemaess). */
const CLOSED = 'Fetch failed: this address is closed to a model (a private network)'

/** Ein Koerper ueber der Grenze: was der zweite Weg ungebremst geliefert haette. */
const HUGE = 'a'.repeat(9 * 1024 * 1024)

beforeEach(() => {
  h.inApp = true
  h.primary = TOO_LARGE
  h.fetchExternal.mockReset()
  h.fetchExternal.mockImplementation(async () => HUGE)
})

describe('web_fetch in der App: die Absage des Rust-Befehls ist die Antwort', () => {
  it('SONDE: eine zu grosse Seite wird kein zweites Mal geholt', async () => {
    const out = await fetchUrl('https://files.example/100Mb.dat')
    // Vor dem Fix: ein Aufruf, und `out` waren die ersten 24 000 Zeichen der
    // Datei, nachdem alle 9 MiB (am Geraet 100 MiB) im Speicher lagen.
    expect(h.fetchExternal).not.toHaveBeenCalled()
    expect(out).toBe(`Error: ${TOO_LARGE}`)
  })

  it('der Satz kommt auch an, wenn die Bruecke einen Error statt eines Strings wirft', async () => {
    h.primary = new Error(TOO_LARGE)
    expect(await fetchUrl('https://files.example/100Mb.dat')).toBe(`Error: ${TOO_LARGE}`)
    expect(h.fetchExternal).not.toHaveBeenCalled()
  })

  it('eine fuer das Modell geschlossene Adresse erreicht den weiteren Weg nicht', async () => {
    h.primary = CLOSED
    const out = await fetchUrl('http://100.64.0.7:8080/admin')
    expect(h.fetchExternal).not.toHaveBeenCalled()
    expect(out).toBe(`Error: ${CLOSED}`)
  })

  it('das Ergebnis zaehlt als Fehlschlag (Zeile "failed", kein Haken)', async () => {
    expect((await fetchUrl('https://files.example/100Mb.dat')).startsWith('Error:')).toBe(true)
  })
})

/**
 * Der Dev-Proxy, dessen Koerper in Stuecken kommt. Jeder Aufruf bekommt eine
 * frische Antwort (die Registry versucht einen Fehlschlag ein zweites Mal);
 * `most()` ist die groesste Zahl an Stuecken, die EIN Aufruf abgeholt hat.
 */
function proxy(pieces: Uint8Array[], headers: Record<string, string> = {}) {
  let most = 0
  const cancel = vi.fn()
  const answer = async () => {
    let handed = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (handed < pieces.length) {
          controller.enqueue(pieces[handed++])
          most = Math.max(most, handed)
        } else controller.close()
      },
      cancel,
    })
    return new Response(body, { status: 200, headers })
  }
  return { answer, most: () => most, cancel }
}

describe('ohne die App bleibt der Rueckfall, und er liest hoechstens 8 MiB', () => {
  const MIB = 1024 * 1024
  const devFetch = vi.fn()

  beforeEach(() => {
    h.inApp = false
    h.primary = new Error('Unknown backend command: web_fetch')
    devFetch.mockReset()
    vi.stubGlobal('fetch', devFetch)
  })

  it('Gegenprobe: eine Seite wird ueber den Proxy des Dev-Servers gelesen', async () => {
    const page = proxy([new TextEncoder().encode('<html><body><p>Tea is old.</p></body></html>')])
    devFetch.mockImplementation(page.answer)
    const out = await fetchUrl('https://example.com/tea?a=1')
    expect(devFetch).toHaveBeenCalledWith('/local-api/proxy-download?url=https%3A%2F%2Fexample.com%2Ftea%3Fa%3D1')
    expect(out).toContain('Tea is old.')
    expect(h.fetchExternal).not.toHaveBeenCalled()
  })

  it('eine angekuendigte Laenge ueber der Grenze endet vor dem ersten Stueck', async () => {
    const page = proxy([new Uint8Array(MIB)], { 'content-length': String(100 * MIB) })
    devFetch.mockImplementation(page.answer)
    const out = await fetchUrl('https://files.example/100Mb.dat')
    expect(out).toContain(TOO_LARGE)
    expect(out.startsWith('Error:')).toBe(true)
    expect(page.most()).toBeLessThanOrEqual(1)
  })

  it('ein Koerper ohne Laenge wird gezaehlt und an der Grenze abgebrochen', async () => {
    // 100 Stuecke zu 1 MiB stehen bereit. Gelesen werden duerfen hoechstens
    // die, die es bis ueber die Grenze braucht.
    const page = proxy(Array.from({ length: 100 }, () => new Uint8Array(MIB)))
    devFetch.mockImplementation(page.answer)
    const out = await fetchUrl('https://files.example/stream')
    expect(out).toContain(TOO_LARGE)
    expect(page.most()).toBeLessThanOrEqual(10)
    expect(page.cancel).toHaveBeenCalled()
  })

  it('ein Koerper genau an der Grenze wird ganz gelesen', async () => {
    const piece = new Uint8Array(MIB).fill(0x61)
    const page = proxy(Array.from({ length: 8 }, () => piece))
    devFetch.mockImplementation(page.answer)
    const out = await fetchUrl('https://example.com/big')
    expect(out).not.toContain(TOO_LARGE)
    expect(out.startsWith('a')).toBe(true)
    expect(page.most()).toBe(8)
  })
})
