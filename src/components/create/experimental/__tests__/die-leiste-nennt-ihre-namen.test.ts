/**
 * Die Hauptnavigation von Create sagt, wie ihre Spuren heissen.
 *
 * Befund D-A10: bis 2.6.7 trug nur die AKTIVE Pille ihren Namen. Die uebrigen
 * standen auf `max-w-0 opacity-0 px-0` — zwoelf Piktogramme, deren Bedeutung
 * nur ein Hover-Tooltip verriet. Das Auffaellige daran war nicht die fehlende
 * Beschriftung, sondern dass sie fertig im Datenmodell lag: jedes `IntentMeta`
 * hat seit jeher ein `short` („Cutout", „Lipsync", „Animate"), und NIEMAND las
 * es. Der Renderer nahm `label` und blendete es weg.
 *
 * Gemessen am 01.09.2026 im laufenden Fenster (Chromium 149, 1280x800,
 * --ui-scale 1.15, gerenderte Pixel, alle zwoelf Pillen der Cloud-Leiste):
 *
 *     nur Icons        476 px
 *     `short`         1068 px      <- gewaehlt, 184 px Luft
 *     `label`         1704 px      <- sprengt das Standardfenster um 452 px
 *     verfuegbar      1252 px
 *
 * Deshalb pruefen die Faelle unten drei Dinge, und nur die drei:
 *
 *   1. Jede Pille rendert `short` — nicht `label`, nicht nichts.
 *   2. Kein `short` ist so lang, dass die Rechnung oben kippt.
 *   3. Der volle Name bleibt in `title`/`aria-label` erreichbar.
 *
 * Was hier NICHT geprueft werden kann: die Breiten selbst. vitest laeuft unter
 * `environment: 'node'`, es gibt kein Fenster und keine Schrift — jede hier
 * eingetragene Pixelzahl waere eine Behauptung. Die Messwerte stehen im
 * Kommentarkopf von IntentBar.tsx, samt der Gegenprobe zum Umbruchverhalten
 * (bei 700 px Fenster: zwei Zeilen, 35,6 -> 71,3 px, kein Ueberlauf, kein
 * abgeschnittener Text).
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/die-leiste-nennt-ihre-namen.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INTENTS } from '../intents'

const SRC = readFileSync(resolve(__dirname, '../IntentBar.tsx'), 'utf8')

/** Kommentare raus: der Kopf von IntentBar.tsx ZITIERT `max-w-0` als das,
 *  was dort stand — ein Scanner, der ihn mitliest, meldet die Erklaerung. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

describe('jede Pille traegt ihren Namen', () => {
  it('rendert `short`, nicht `label`', () => {
    expect(code).toMatch(/\{meta\.short\}/)
    // `meta.label` darf weiter vorkommen — aber nur in title/aria-label,
    // also als `${meta.label}` im Template-String. Der Lookbehind schliesst
    // genau die aus und laesst nur den gerenderten Kindknoten uebrig.
    expect(code).not.toMatch(/(?<!\$)\{meta\.label\}/)
  })

  it('kein Label ist mehr weggeblendet', () => {
    // Die drei Eigenschaften, aus denen der alte Zustand bestand. Eine davon
    // reicht, um eine Beschriftung unsichtbar zu machen.
    expect(code).not.toMatch(/max-w-0/)
    expect(code).not.toMatch(/opacity-0/)
    // `px-0` auf dem Labelspan war die dritte; ausserhalb davon nutzt die
    // Leiste kein px-0.
    expect(code).not.toMatch(/\bpx-0\b/)
  })

  it('der volle Name bleibt in title und aria-label', () => {
    expect(code).toMatch(/aria-label=\{[^}]*meta\.label/)
    expect(code).toMatch(/title=\{[^}]*meta\.label/)
  })
})

describe('die Namen bleiben kurz genug fuer eine Zeile', () => {
  it('jedes Intent hat ein nicht-leeres `short`', () => {
    for (const m of INTENTS) {
      expect(m.short.length, `Intent ${m.id} ohne short`).toBeGreaterThan(0)
    }
  })

  it('kein `short` ist laenger als das laengste gemessene', () => {
    // „Character" (9 Zeichen) war bei der Messung die breiteste Pille mit
    // 98,7 px. Die 1068 px der ganzen Leiste haengen an dieser Obergrenze:
    // waechst ein Name darueber hinaus, ist die Rechnung im Dateikopf von
    // IntentBar.tsx nicht mehr die, die gemessen wurde.
    for (const m of INTENTS) {
      expect(m.short.length, `short von ${m.id} ist laenger als die gemessene Obergrenze`).toBeLessThanOrEqual(9)
    }
  })

  it('`short` ist wirklich kuerzer, wo `label` lang ist', () => {
    // Der Grund, warum es das Feld ueberhaupt gibt. Ohne diesen Fall koennte
    // jemand `short` auf `label` setzen und der Test oben bliebe gruen.
    const lang = INTENTS.filter((m) => m.label.length > 12)
    expect(lang.length).toBeGreaterThan(3)
    for (const m of lang) {
      expect(m.short.length, `short von ${m.id} spart nichts gegenueber label`).toBeLessThan(m.label.length)
    }
  })
})

describe('bei knappem Platz wird gescrollt, nicht ueberlaufen und nicht umgebrochen', () => {
  it('die Leiste ist ein Scrollrad', () => {
    // Die Gegenprobe im Browser (700 px Fenster, ohne Gegenmittel): 50 px
    // Ueberlauf ueber den Container, die letzte Pille abgeschnitten. Bis 2.6.8
    // war die Antwort `flex-wrap` und damit eine zweite Zeile; seit dem
    // Scrollrad bleibt es eine Zeile, die scrollt. Hier steht nur die Quelle
    // dafuer, die Breiten selbst sind in dieser Umgebung nicht messbar.
    expect(code).toMatch(/<WheelNav/)
    expect(code).toMatch(/radius=\{5\}/)
  })

  it('und bricht nicht mehr um', () => {
    // Beides zusammen waere ein Rad, das trotzdem in eine zweite Zeile faellt:
    // die Mitte stimmte dann nicht mehr, und die Buehne darunter spraenge
    // weiter um eine Zeilenhoehe.
    expect(code).not.toMatch(/flex-wrap/)
  })

  it('der aktive Eintrag steht in der Mitte, nicht irgendwo', () => {
    // Ohne diesen Fall koennte `activeIndex` still auf 0 stehen und das Rad
    // zeigte immer denselben Ausschnitt.
    expect(code).toMatch(/activeIndex=\{intents\.findIndex/)
  })
})
