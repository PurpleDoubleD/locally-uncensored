/**
 * Der Gespraechswechsel im Composer wird IM RENDER entschieden, und er
 * konvergiert.
 *
 * 90aa5c3d hat den Entwurf an sein Gespraech gebunden: beim Wechsel wird der
 * halbe Satz unter dem alten Gespraech abgelegt und beim Zurueckkommen wieder
 * hingelegt. Das VERHALTEN sichern die vier Zusicherungen in
 * `e2e/composer-keys.spec.ts` (Rotprobe gefahren: nimmt man die Rettung
 * heraus, melden zwei davon "unexpected value 'ein unfertiger Entwurf'").
 * Dieser Test sichert die BAUFORM, an der sie haengen.
 *
 * Gebaut war der Wechsel zuerst als Effekt mit zwei Refs davor, und genau das
 * war der einzige rote Punkt von `npm run lint` am 03.09.2026. In Wahrheit
 * zwei Punkte, denn eslint meldet pro Komponente nur den ersten: hinter
 * `react-hooks/refs` (Stand des Feldes wurde im Renderkoerper in ein Ref
 * geschrieben) stand `react-hooks/set-state-in-effect` (der Effekt rief
 * `setInput`/`setImages` direkt auf). Beide Regeln zeigen auf dieselbe
 * Ursache, und die Aufloesung ist die von React selbst empfohlene: der
 * Vergleich mit dem vorigen Gespraech steht im Render, die Anpassung
 * geschieht dort, React laeuft die Komponente sofort noch einmal.
 *
 * WARUM DAS EINEN WAECHTER BRAUCHT, obwohl `npm run lint` den Rueckweg in
 * einen Effekt selbst rot faerbt: die Konvergenz faellt unter keine Regel.
 * Ein Render, der Zustand anpasst, muss die Bedingung im selben Zug falsch
 * machen, sonst rendert React bis "Too many re-renders". Die eine Zeile, die
 * das leistet, ist `setLetztesGespraech(conversationId)`, und sie sieht wie
 * Buchhaltung aus, die man beim Aufraeumen streicht.
 *
 * Run: npx vitest run src/components/chat/__tests__/der-entwurf-wechselt-im-render.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const quelle = readFileSync(resolve(here, '../ChatInput.tsx'), 'utf8')

/** Der Renderzweig, der den Wechsel bemerkt. */
const wechsel = quelle.indexOf('if (letztesGespraech !== conversationId) {')
/** Sein Ende: die naechste Zeile, die auf Komponentenebene wieder zumacht. */
const ende = quelle.indexOf('\n  }\n', wechsel)
const zweig = wechsel > -1 && ende > wechsel ? quelle.slice(wechsel, ende) : ''

describe('der Wechsel wird im Render entschieden, nicht in einem Effekt', () => {
  it('es gibt den Renderzweig, und er vergleicht Zustand mit Zustand', () => {
    expect(wechsel).toBeGreaterThan(-1)
    // Zustand, kein Ref: ein Ref duerfte im Render gar nicht gelesen werden
    // (react-hooks/refs), und genau daran ist die erste Bauform gescheitert.
    expect(quelle).toContain('const [letztesGespraech, setLetztesGespraech] = useState(conversationId)')
    expect(quelle).toContain('const [entwuerfe, setEntwuerfe] = useState<')
  })

  it('kein Effekt haengt mehr am Gespraechswechsel', () => {
    // Der Rueckweg in einen `useEffect(..., [conversationId])` wuerde
    // set-state-in-effect zurueckholen. Hier steht er als Zusicherung, damit
    // der Grund am Ort steht und nicht nur in einer Regelmeldung.
    expect(quelle).not.toContain('}, [conversationId])')
  })
})

describe('der Renderzweig macht seine eigene Bedingung falsch', () => {
  it('er setzt das zuletzt gesehene Gespraech, sonst rendert React endlos', () => {
    expect(zweig).toContain('setLetztesGespraech(conversationId)')
  })

  it('die Rettung selbst steht noch: ablegen und wieder hinlegen', () => {
    // Ohne diese drei bliebe der Waechter gruen, waehrend der Vertrag aus
    // 90aa5c3d weg waere.
    expect(zweig).toContain('setEntwuerfe((bisher) => {')
    expect(zweig).toContain('const zurueck = conversationId ? entwuerfe[conversationId] : undefined')
    expect(zweig).toContain("setInput(zurueck?.text ?? '')")
    expect(zweig).toContain('setImages(zurueck?.bilder ?? [])')
  })

  it('der Aktualisierer rechnet nur aus seinem Eingang, ist unter StrictMode also wiederholbar', () => {
    // StrictMode ruft ihn zweimal (src/main.tsx). Er darf deshalb nichts
    // lesen, was er selbst veraendert: kein `entwuerfe[` im Rumpf, nur
    // `bisher`.
    const auf = zweig.indexOf('setEntwuerfe((bisher) => {')
    const zu = zweig.indexOf('    }\n', auf)
    const rumpf = auf > -1 && zu > auf ? zweig.slice(auf, zu) : ''
    expect(rumpf).toContain('bisher')
    expect(rumpf).not.toContain('entwuerfe[')
  })
})
