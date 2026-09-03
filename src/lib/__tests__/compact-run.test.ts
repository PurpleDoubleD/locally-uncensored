/**
 * Sperrklinken fuer den Modellaufruf des Zusammenfassers (2.6.8, Schritt 3b).
 *
 * Jede Pruefung hier haelt genau EINEN der sechs Fallstricke fest, die der
 * Modulkopf von compact-run.ts benennt. Sie sind keine Vermutungen: jeder
 * einzelne ist in diesem Projekt schon einmal echtes Verhalten gewesen, an
 * einer anderen Aufrufstelle. Ohne diese Datei wandern sie in die naechste.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/providers', () => ({
  getProviderForModel: vi.fn(),
  getProviderIdFromModel: vi.fn(),
}))
vi.mock('../agent-num-ctx', () => ({
  resolveAgentNumCtx: vi.fn(),
}))

import { runCompactSummary, COMPACT_TEMPERATURE, COMPACT_MAX_TOKENS } from '../compact-run'
import { getProviderForModel, getProviderIdFromModel } from '../../api/providers'
import { resolveAgentNumCtx } from '../agent-num-ctx'
import { COMPACT_OPEN, renderCompactSummary } from '../compact-summary'

const providerFor = getProviderForModel as unknown as ReturnType<typeof vi.fn>
const providerId = getProviderIdFromModel as unknown as ReturnType<typeof vi.fn>
const numCtx = resolveAgentNumCtx as unknown as ReturnType<typeof vi.fn>

/** Was der falsche Anbieter beim naechsten Aufruf zurueckgibt. */
let antwort: string | (() => never)
let verzoegerungMs: number
/** Womit chatStream tatsaechlich gerufen wurde. */
let gesehen: { model: string; messages: unknown[]; options: Record<string, unknown> } | null

const GUT = `TASK
Den Login reparieren.

PROGRESS
auth.ts gelesen, Nullwert in Zeile 40 gefunden.

DECISIONS
Kein Refactoring — der Rest ist getestet.

FACTS
src/auth.ts:40, verifyToken, "cannot read exp of undefined".

OPEN
Der Test fehlt.`

const verlauf = Array.from({ length: 24 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `Zug ${i}: ` + 'Inhalt '.repeat(60),
}))

describe('runCompactSummary', () => {
  beforeEach(() => {
    antwort = GUT
    verzoegerungMs = 0
    gesehen = null
    providerId.mockReset(); providerId.mockReturnValue('ollama')
    numCtx.mockReset(); numCtx.mockResolvedValue(32768)
    providerFor.mockReset()
    providerFor.mockImplementation((name: string) => ({
      modelId: name.includes('::') ? name.split('::').slice(1).join('::') : name,
      provider: {
        chatStream: async function* (model: string, messages: unknown[], options: Record<string, unknown>) {
          gesehen = { model, messages, options }
          if (typeof antwort === 'function') antwort()
          if (verzoegerungMs) await new Promise((r) => setTimeout(r, verzoegerungMs))
          yield { content: antwort as string, done: false }
          yield { content: '', done: true }
        },
      },
    }))
  })

  it('liefert die gelesene Zusammenfassung', async () => {
    const r = await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b' })
    expect(r.ok).toBe(true)
    expect(r.reason).toBe('ok')
    expect(r.summary.facts).toContain('verifyToken')
    expect(renderCompactSummary(r.summary)).toContain(COMPACT_OPEN)
  })

  // Falle 6 — und zugleich der Grund, warum das auf allen drei
  // Werkzeug-Schemata identisch laeuft.
  it('schickt NIE Werkzeuge mit', async () => {
    await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b' })
    expect(gesehen!.options.tools).toBeUndefined()
  })

  // Der Prompt ist eine einzige Nutzernachricht — keine Systemnachricht, an
  // der eine strenge Chat-Vorlage abbrechen koennte.
  it('sendet genau eine Nutzernachricht', async () => {
    await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b' })
    expect(gesehen!.messages).toHaveLength(1)
    expect((gesehen!.messages[0] as { role: string }).role).toBe('user')
  })

  // Falle 4: ohne num_ctx wirft Ollama die KV-Belegung des Chats weg und
  // laedt das Modell neu — gemessen an der ausgelieferten exe.
  it('reicht dasselbe num_ctx durch wie der Chat', async () => {
    await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b', contextWindowOverride: 0 })
    expect(numCtx).toHaveBeenCalled()
    expect(gesehen!.options.contextWindow).toBe(32768)
  })

  it('laeuft weiter, wenn die num_ctx-Aufloesung scheitert', async () => {
    numCtx.mockRejectedValue(new Error('ollama weg'))
    const r = await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b' })
    expect(r.ok).toBe(true)
    expect(gesehen!.options.contextWindow).toBeUndefined()
  })

  // Falle 5: mit `{}` als Optionen sieht der Abbruch die laufende Anfrage nie.
  it('reicht ein Abbruchsignal durch', async () => {
    await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b' })
    expect(gesehen!.options.signal).toBeDefined()
  })

  it('nimmt die Sampling-Werte des Zusammenfassers, nicht die des Chats', async () => {
    await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b' })
    expect(gesehen!.options.temperature).toBe(COMPACT_TEMPERATURE)
    expect(gesehen!.options.maxTokens).toBe(COMPACT_MAX_TOKENS)
  })

  // Falle 2: Qwen3 oeffnet <think> schon im PROMPT, die Antwort traegt also
  // nur den SCHLIESSENDEN Tag. Ein naiver Stripper findet daran nichts.
  it('entfernt Denktext ohne oeffnenden Tag', async () => {
    antwort = `Ich sollte kurz ueberlegen, was hier wichtig ist.</think>\n\n${GUT}`
    const r = await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b' })
    expect(r.ok).toBe(true)
    const alles = JSON.stringify(r.summary)
    expect(alles).not.toContain('sollte kurz ueberlegen')
    expect(alles).not.toContain('</think>')
    expect(r.summary.facts).toContain('verifyToken')
  })

  it('entfernt auch einen vollstaendigen Denkblock', async () => {
    antwort = `<think>lang und breit</think>\n${GUT}`
    const r = await runCompactSummary({ turns: verlauf, activeModel: 'qwen:4b' })
    expect(JSON.stringify(r.summary)).not.toContain('lang und breit')
  })

  describe('scheitert nie mit einer Ausnahme', () => {
    it('ohne Modell', async () => {
      const r = await runCompactSummary({ turns: verlauf, activeModel: '' })
      expect(r).toMatchObject({ ok: false, reason: 'no-model' })
    })

    it('ohne Inhalt', async () => {
      const r = await runCompactSummary({ turns: [{ role: 'user', content: '  ' }], activeModel: 'q' })
      expect(r).toMatchObject({ ok: false, reason: 'empty-input' })
    })

    it('wenn der Anbieter wirft', async () => {
      antwort = () => { throw new Error('backend tot') }
      const r = await runCompactSummary({ turns: verlauf, activeModel: 'q' })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('call-failed')
      expect(r.detail).toContain('backend tot')
    })

    it('wenn die Antwort leer ist', async () => {
      antwort = '   '
      const r = await runCompactSummary({ turns: verlauf, activeModel: 'q' })
      expect(r).toMatchObject({ ok: false, reason: 'unusable' })
    })

    // Falle 1: das eigene Zeitlimit. Der Waechter des Anbieters misst STILLE
    // zwischen Bruchstuecken, nicht die Gesamtzeit.
    it('wenn die Zeit ablaeuft', async () => {
      verzoegerungMs = 60
      const r = await runCompactSummary({ turns: verlauf, activeModel: 'q', timeoutMs: 10 })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('call-failed')
    })

    it('wenn der Nutzer vorher abbricht', async () => {
      const ac = new AbortController(); ac.abort()
      const r = await runCompactSummary({ turns: verlauf, activeModel: 'q', signal: ac.signal })
      expect(r).toMatchObject({ ok: false, reason: 'aborted' })
    })
  })

  describe('die Brauchbarkeit entscheidet, nicht die Hoeflichkeit', () => {
    it('lehnt eine Abschrift ab', async () => {
      antwort = 'PROGRESS\n' + verlauf.map((t) => t.content).join('\n')
      const r = await runCompactSummary({ turns: verlauf, activeModel: 'q' })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('unusable')
      expect(r.usability?.reason).toBe('not-smaller')
    })

    // Der Rueckfall, der den Sinn dieses Moduls traegt: ein Modell, das die
    // Ueberschriften ignoriert, hat trotzdem etwas Brauchbares gesagt.
    it('nimmt eine Antwort ganz ohne Ueberschriften an', async () => {
      antwort = 'Der Nutzer wollte den Login reparieren. In src/auth.ts Zeile 40 steht ein Nullwert in verifyToken. Ein Test dafuer fehlt noch, sonst ist alles gruen.'
      const r = await runCompactSummary({ turns: verlauf, activeModel: 'q' })
      expect(r.ok).toBe(true)
      expect(r.summary.rest).toContain('verifyToken')
    })
  })
})
