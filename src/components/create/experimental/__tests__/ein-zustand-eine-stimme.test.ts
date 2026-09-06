/**
 * Zwei Stellen im Create-Bereich, an denen zwei Dinge fuer eine sprachen.
 *
 * D-S34 — die eingeklappte Galerieleiste.
 *   Gemessen am 01.09.2026 (Chromium 149, 1280x800, gerenderte Pixel): eine
 *   59,8 x 273,9 px hohe Saeule mit ZWEI Knoepfen — PanelRightOpen („Expand
 *   gallery") und Images („Gallery"), getrennt durch einen Strich, der eine
 *   Gruppierung andeutete. Beide riefen dasselbe `onOpenChange(true)` auf.
 *   Zwei Piktogramme fuer einen Befehl, dessen Name nur im Hover stand.
 *   Der Zahlenwert im Auditzettel („45px") war veraltet; die Leiste war schon
 *   52 CSS-px breit, unter --ui-scale 1.15 also 59,8 gerenderte px.
 *
 * D-S31 — Balken und Einrichtungskarte.
 *   Sie standen 40 px uebereinander und beschrieben dieselbe Lage zweimal.
 *   Auf dem Mac wortgleich, einmal als roter Alarm mit Warndreieck und einmal
 *   als ruhiges Angebot mit Knopf. Auf Windows zeigten sie AUSEINANDER: der
 *   Balken „ComfyUI is not running. Start it from Settings or wait for
 *   auto-start", die Karte darunter ein „Download & install", das ComfyUI
 *   selbst mitinstalliert. Beide Wortlaute liegen ausserhalb dieses Pakets
 *   (`hooks/useCreate.ts` und die COPY-Tabellen in `Stage.tsx`), und keiner
 *   ist fuer sich falsch — falsch war, dass sie gleichzeitig sprachen.
 *
 * Was hier NICHT geprueft werden kann: dass der Balken im laufenden Fenster
 * wirklich verschwindet. vitest hat keinen Renderer. Nachgestellt wurde es im
 * Browser (MLX-Mac, Bildspur, kein Modell): vor der Aenderung Balken + Karte,
 * danach nur die Karte. Was hier geprueft wird, ist die Bedingung, aus der das
 * folgt — und dass beide Seiten dieselbe Regel lesen statt zwei Abschriften.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/ein-zustand-eine-stimme.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stageShowsSetupCard } from '../stageGate'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')
const entkommentiert = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

const PANEL = entkommentiert(read('../CreatePanel.tsx'))
const CREATE = entkommentiert(read('../CreateExperimental.tsx'))
const STAGE = entkommentiert(read('../Stage.tsx'))

describe('D-S34: ein Befehl, ein Knopf', () => {
  /** Der eingeklappte Zweig — am key der motion.aside erkannt. */
  const rail = () => {
    const i = PANEL.indexOf('key="rail"')
    expect(i, 'eingeklappter Zweig nicht gefunden').toBeGreaterThan(-1)
    const j = PANEL.indexOf('key="full"')
    return PANEL.slice(i, j > i ? j : i + 1600)
  }

  it('oeffnet die Galerie genau einmal', () => {
    const oeffner = rail().match(/onOpenChange\(true\)/g) ?? []
    expect(oeffner.length, 'mehr als ein Knopf mit derselben Wirkung').toBe(1)
  })

  it('hat keinen Trennstrich mehr, der nichts trennt', () => {
    expect(rail()).not.toMatch(/h-px bg-gray-200/)
  })

  it('schreibt den Namen des Befehls hin', () => {
    // Nicht nur in title/aria-label — als gerenderter Text.
    expect(rail()).toMatch(/>Gallery</)
  })

  it('das ungenutzte Icon ist auch aus dem Import raus', () => {
    // Ein Import, den niemand mehr braucht, ist der Rest einer halben
    // Aenderung. `PanelRightClose` (aufgeklappter Zweig) bleibt.
    expect(PANEL).not.toMatch(/PanelRightOpen/)
    expect(PANEL).toMatch(/PanelRightClose/)
  })
})

describe('D-S31: die Regel gibt es genau einmal', () => {
  it('beide Seiten lesen dieselbe Funktion', () => {
    expect(STAGE).toMatch(/stageShowsSetupCard\(/)
    expect(CREATE).toMatch(/stageShowsSetupCard\(/)
  })

  it('keine Seite rechnet die Bedingung noch selbst nach', () => {
    // Die Abschrift, die vorher in Stage.tsx stand. Zwei Kopien einer Regel
    // sind der Zustand, in dem eine davon still falsch wird.
    expect(STAGE).not.toMatch(/const macMissing =/)
    expect(CREATE).not.toMatch(/const macMissing =/)
  })

  it('der Balken haengt an ihr', () => {
    expect(CREATE).toMatch(/setupCardOwnsStage \? null : modelLoadError/)
  })

  it('echte Laufzeitfehler bleiben unberuehrt', () => {
    // `error` ist die einzige Quelle mit Schliesskreuz und beschreibt einen
    // konkreten Lauf, den die Karte nicht erklaert. Sie darf NICHT
    // mitunterdrueckt werden.
    const b = CREATE.match(/const banner = ([^\n]+)/)
    expect(b, 'banner-Zeile nicht gefunden').toBeTruthy()
    expect(b![1]).toMatch(/^error \?\?/)
  })
})

describe('D-S31: die Regel selbst', () => {
  const basis = {
    backend: 'local' as const,
    requiresModels: 'image' as const,
    mlxMissing: null,
    connected: true,
    modelsLoaded: true,
    laneModelCount: 3,
  }

  it('schweigt, wenn alles da ist', () => {
    expect(stageShowsSetupCard(basis)).toBe(false)
  })

  it('meldet den Mac ohne eingerichtete Bildspur', () => {
    expect(stageShowsSetupCard({ ...basis, mlxMissing: { image: true, video: false } })).toBe(true)
    // … und nur die Spur, um die es geht.
    expect(stageShowsSetupCard({
      ...basis, requiresModels: 'video', mlxMissing: { image: true, video: false },
    })).toBe(false)
  })

  it('meldet ein nicht erreichbares ComfyUI', () => {
    expect(stageShowsSetupCard({ ...basis, connected: false })).toBe(true)
  })

  it('meldet eine leere Spur', () => {
    expect(stageShowsSetupCard({ ...basis, laneModelCount: 0 })).toBe(true)
  })

  it('blitzt waehrend der laufenden Sonde nicht auf', () => {
    // `connected === null` heisst: wir wissen es noch nicht. Wer daraus eine
    // Aussage macht, zeigt die Karte bei jedem Start kurz an.
    expect(stageShowsSetupCard({ ...basis, connected: null, laneModelCount: 0 })).toBe(false)
  })

  it('gilt nur lokal', () => {
    expect(stageShowsSetupCard({ ...basis, backend: 'cloud', connected: false })).toBe(false)
  })

  it('gilt nur fuer Spuren, die ueberhaupt Modelle brauchen', () => {
    // Cutout/Upscale/Eraser haben kein `requiresModels` — dort zeigt die
    // Buehne keine Karte, und der Balken muss weiter sprechen duerfen.
    expect(stageShowsSetupCard({ ...basis, requiresModels: undefined, connected: false })).toBe(false)
  })
})
