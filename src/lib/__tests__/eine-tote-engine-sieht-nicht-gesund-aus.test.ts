/**
 * Stirbt die Engine, darf keine Stelle der Oberflaeche weiter behaupten, sie
 * laufe.
 *
 * Gegenprobe G2, 04.09.2026, echter Windows-Build. Der Engine-Prozess auf
 * Port 8127 wurde von aussen getoetet, der Einbettungsserver auf 8128 blieb
 * stehen. Zwei Stellen logen danach:
 *
 *   A3  Die Kachel des toten Modells trug weiter das Abzeichen ACTIVE und sah
 *       ansonsten aus wie jede gesunde Kachel. "Es gibt keinen Zustand
 *       gestoppt, abgestuerzt oder aehnliches, keinen Fehlertext, keine eigene
 *       Farbe, keinen eigenen Knopf."
 *   A6  Der Punkt neben "LU Engine DEFAULT LOCAL" blieb ueber 150 Sekunden
 *       `bg-green-500`, gemessen im Sekundentakt, waehrend derselbe Bildschirm
 *       zwei Zentimeter tiefer "Engine not running" meldete. Ursache war die
 *       Uhr: der Zustand wurde EINMAL beim Aufbauen geholt und nie wieder.
 *
 * Run: npx vitest run src/lib/__tests__/eine-tote-engine-sieht-nicht-gesund-aus.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { liveSlotStatus, builtinSlotStatus } from '../builtin-slot-status'

const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')
const LU = { managed: true }
const FREMD = { managed: false }

describe('A6: der Punkt in der Providerliste', () => {
  it('wird rot, wenn die Engine tot ist', () => {
    const tot = { status: { running: false, healthy: false }, geantwortet: true }
    expect(liveSlotStatus('openai', LU, tot)).toBe('stopped')
  })

  it('bleibt gruen, solange sie antwortet', () => {
    const gesund = { status: { running: true, healthy: true }, geantwortet: true }
    expect(liveSlotStatus('openai', LU, gesund)).toBe('connected')
  })

  it('sagt nichts, solange noch keine Antwort da war', () => {
    // Sonst blitzte beim Aufbauen eine Sekunde lang "stopped" auf.
    expect(liveSlotStatus('openai', LU, { status: null, geantwortet: false })).toBeNull()
  })

  it('sagt nichts ueber eine Engine, die laeuft und noch nicht antwortet', () => {
    // Der Prozess bindet vielleicht gerade den Port. Das ist genau der Fall,
    // den eine echte Sonde beantworten soll.
    const waermt = { status: { running: true, healthy: false }, geantwortet: true }
    expect(liveSlotStatus('openai', LU, waermt)).toBeNull()
  })

  it('und sagt nie etwas ueber eine fremde Zeile', () => {
    const tot = { status: { running: false, healthy: false }, geantwortet: true }
    expect(liveSlotStatus('openai', FREMD, tot)).toBeNull()
    expect(liveSlotStatus('ollama', LU, tot)).toBeNull()
    expect(liveSlotStatus('anthropic', null, tot)).toBeNull()
  })

  it('folgt derselben Regel wie der Aufschlag, nicht einer zweiten', () => {
    for (const e of [
      { running: false, healthy: false },
      { running: true, healthy: true },
      { running: true, healthy: false },
    ]) {
      expect(liveSlotStatus('openai', LU, { status: e, geantwortet: true }))
        .toBe(builtinSlotStatus(e))
    }
  })

  it('verdrahtet: die Liste liest die laufende Schleife', () => {
    const src = lies('components/settings/ProviderConfig.tsx')
    expect(src).toContain('const engineAnswer = useBuiltinEngineStatus()')
    expect(src).toContain('liveSlotStatus(id, config, engineAnswer) ?? statuses[id]')
  })
})

describe('A3: die Kachel des toten Modells', () => {
  const KARTE = lies('components/models/ModelCard.tsx')

  it('sagt "Not running" statt ACTIVE, wenn die Engine steht', () => {
    expect(KARTE).toContain('data-testid="model-card-stopped"')
    expect(KARTE).toContain('Not running')
    expect(KARTE).toContain('engineStopped ? (')
  })

  it('und ACTIVE bleibt genau dann, wenn wirklich etwas laeuft', () => {
    const stelle = KARTE.slice(KARTE.indexOf('{isActive && ('), KARTE.indexOf('{isActive && (') + 900)
    expect(stelle).toContain('>\n            Not running\n          </span>')
    expect(stelle).toContain('Active</span>')
  })

  it('der Zustand kommt aus derselben Schleife wie der Punkt', () => {
    const seite = lies('components/models/ModelManager.tsx')
    expect(seite).toContain('const engineRuht = engineIsIdle(useBuiltinEngineStatus())')
    expect(seite).toContain('engineStopped={engineRuht}')
  })
})
