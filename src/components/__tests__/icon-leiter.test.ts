/**
 * Die Icon-Leiter 12/16/20 und ihre optische Korrektur — Audit Welle 3,
 * Punkt 3.
 *
 * Der Kern ist eine Rechnung, keine Meinung: lucide skaliert seinen
 * 24er-Strich mit der Groesse, also sieht dieselbe Strichstaerke bei jeder
 * Groesse anders aus. Dieser Test rechnet die Korrektur gegen die FORMEL
 * nach, die lucide wirklich benutzt — gelesen aus dem installierten Paket,
 * nicht angenommen. Aendert lucide die Formel, faellt dieser Test, und nicht
 * erst der Blick ins Fenster.
 *
 * Was hier NICHT geprueft werden kann: wie die Korrektur aussieht. Dass ein
 * 1px-Strich bei size=20 als „richtig" empfunden wird, ist eine Entscheidung
 * und steht als solche in `ui/icon-size.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ICON_SM,
  ICON_MD,
  ICON_LG,
  ICON_LADDER,
  ICON_STROKE_PX,
  ICON_STROKE_MARK,
  iconStrokeAttr,
  seenStrokePx,
} from '../ui/icon-size'

const ROOT = resolve(__dirname, '..', '..', '..')
const SRC = resolve(ROOT, 'src')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

/** Alle .tsx unter src/components, rekursiv, ohne __tests__. */
function componentFiles(dir = resolve(SRC, 'components')): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__') continue
    const p = resolve(dir, e.name)
    if (e.isDirectory()) out.push(...componentFiles(p))
    else if (e.name.endsWith('.tsx')) out.push([p.slice(SRC.length + 1), readFileSync(p, 'utf8')])
  }
  return out
}
const FILES = componentFiles()
const ALL = FILES.map(([, s]) => s).join('\n')

describe('die Leiter ist drei Zahlen, und sie stehen an einer Stelle', () => {
  it('12 / 16 / 20', () => {
    expect([ICON_SM, ICON_MD, ICON_LG]).toEqual([12, 16, 20])
    expect(ICON_LADDER).toEqual([12, 16, 20])
  })

  it('jede Stufe liegt bei 1x UND bei 2x auf ganzen Geraetepixeln', () => {
    // Das ist der Grund fuer genau diese drei Zahlen: `size` ist bei lucide
    // eine px-Angabe und laeuft am 18,4px-Wurzelmass vorbei.
    for (const s of ICON_LADDER) {
      expect(Number.isInteger(s)).toBe(true)
      expect(Number.isInteger(s * 2)).toBe(true)
    }
  })
})

describe('die optische Korrektur ist Arithmetik, gegen die echte lucide-Formel', () => {
  /**
   * Die Formel steht im installierten Paket, nicht in diesem Test:
   *   absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth
   * Wir lesen sie, damit ein lucide-Update, das sie aendert, hier auffaellt.
   */
  const lucideIcon = readFileSync(
    resolve(ROOT, 'node_modules', 'lucide-react', 'dist', 'esm', 'Icon.js'),
    'utf8',
  )

  it('lucide rechnet bei absoluteStrokeWidth wirklich `strokeWidth * 24 / size`', () => {
    expect(lucideIcon).toContain('* 24 / Number(size ?? contextSize)')
    expect(lucideIcon).toContain('absoluteStrokeWidth ?? contextAbsoluteStrokeWidth')
  })

  it('lucide liest Default-Groesse und -Staerke wirklich aus dem Context', () => {
    // Ohne das waere der Provider in AppShell wirkungslos und alles unten
    // waere eine Rechnung ueber etwas, das nie passiert.
    expect(lucideIcon).toContain('useLucideContext()')
    expect(lucideIcon).toContain('contextStrokeWidth = 2')
  })

  it('auf jeder Leiterstufe ist die GESEHENE Staerke exakt ICON_STROKE_PX', () => {
    for (const size of ICON_LADDER) {
      expect(seenStrokePx(size, iconStrokeAttr(size))).toBeCloseTo(ICON_STROKE_PX, 10)
    }
  })

  it('und auch auf jeder Groesse, die die App heute sonst noch setzt', () => {
    // 7 bis 36 — die Korrektur ist keine Tabelle fuer drei Faelle, sie gilt
    // fuer alles, was noch nicht auf der Leiter steht.
    for (let size = 7; size <= 36; size++) {
      expect(seenStrokePx(size, iconStrokeAttr(size))).toBeCloseTo(ICON_STROKE_PX, 10)
    }
  })

  it('OHNE Korrektur laeuft die Staerke um Faktor 2,5 auseinander — der Befund', () => {
    // lucide-Default: strokeWidth 2 auf dem 24er-Raster.
    const naiv = (size: number) => seenStrokePx(size, 2)
    expect(naiv(8)).toBeCloseTo(0.667, 3)
    expect(naiv(20)).toBeCloseTo(1.667, 3)
    expect(naiv(20) / naiv(8)).toBeCloseTo(2.5, 10)
    // Und der Mittelwert der Leiter landet auf 1,33px = 2,67 Geraetepixel
    // bei 2x, also zwischen zwei Pixelreihen.
    expect(naiv(ICON_MD) * 2).toBeCloseTo(2.667, 3)
  })

  it('die Markenstaerke ist die doppelte Hausstaerke, nicht eine vierte Zahl', () => {
    expect(ICON_STROKE_MARK).toBe(ICON_STROKE_PX * 2)
  })
})

describe('die Korrektur haengt an der Wurzel, nicht an 668 Call-Sites', () => {
  const shell = read('components', 'layout', 'AppShell.tsx')

  it('AppShell haengt den Provider um den Baum und nimmt die Konstante', () => {
    expect(shell).toMatch(/<LucideProvider absoluteStrokeWidth strokeWidth=\{ICON_STROKE_PX\}>/)
    expect(shell).toMatch(/import \{ ICON_STROKE_PX \} from '\.\.\/ui\/icon-size'/)
  })

  it('der Provider steht UM die frueheren Rueckgaben, nicht darin', () => {
    // AppShell kehrt vor dem Rahmen zweimal frueh zurueck (restoring,
    // Onboarding). Laege der Provider erst im Hauptzweig, traege
    // ausgerechnet der erste Bildschirm der App die Korrektur nicht.
    const wrapper = shell.match(/export function AppShell\(\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(wrapper).toContain('<LucideProvider')
    expect(wrapper).toContain('<AppShellTree />')
    // Und der Baum mit den fruehen Rueckgaben ist wirklich das Kind.
    expect(shell).toMatch(/function AppShellTree\(\)/)
    const tree = shell.slice(shell.indexOf('function AppShellTree()'))
    expect(tree).toContain('if (!onboardingDone)')
    expect(tree).not.toContain('<LucideProvider')
  })

  it('genau eine Stelle in der App setzt den Provider', () => {
    expect((ALL.match(/<LucideProvider/g) ?? []).length).toBe(1)
  })
})

describe('keine Call-Site korrigiert doppelt', () => {
  /**
   * Mit dem Provider bedeutet ein eigenes `strokeWidth={x}` „x CSS-Pixel
   * gesehen", nicht mehr „x auf dem 24er-Raster". Die 15 handgesetzten
   * Werte von vorher (1.5, 1.8, 2.4) meinten das andere und waeren nach dem
   * Umbau um bis zu 118 % zu fett gewesen — `Cloud size={11}
   * strokeWidth={2.4}` etwa sprang von 1,10px auf 2,40px.
   */
  it('jedes verbliebene strokeWidth nennt eine Konstante, keine Zahl', () => {
    const offenders: string[] = []
    for (const [name, src] of FILES) {
      for (const m of src.matchAll(/strokeWidth=\{([^}]*)\}/g)) {
        const v = m[1].trim()
        if (v === 'ICON_STROKE_PX' || v === 'ICON_STROKE_MARK') continue
        offenders.push(`${name}: strokeWidth={${v}}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('die Zahlen, die dort standen, sind wirklich verschwunden', () => {
    for (const bad of ['strokeWidth={1.5}', 'strokeWidth={1.8}', 'strokeWidth={2.4}', 'strokeWidth={1.75}']) {
      expect(ALL).not.toContain(bad)
    }
  })
})

describe('die Leiter ist angewandt, wo dieses Paket hinreicht — und nur da', () => {
  it('die Fensterknoepfe tragen eine Stufe statt dreier Groessen', () => {
    // Titlebar und Onboarding zeichnen DENSELBEN Fensterbalken; sie hatten
    // 14 / 11 / 14 nebeneinander, in beiden Kopien.
    for (const f of ['components/layout/Titlebar.tsx', 'components/onboarding/Onboarding.tsx']) {
      const src = FILES.find(([n]) => n === f)?.[1] ?? ''
      expect(src, f).not.toBe('')
      for (const glyph of ['Minus', 'Square']) {
        expect(src, `${f}: ${glyph}`).toMatch(new RegExp(`<${glyph} size=\\{ICON_SM\\}`))
      }
    }
  })

  it('und der Rest ist ehrlich gezaehlt statt behauptet', () => {
    // Ehrlichkeit vor Vollstaendigkeit: 655 der 667 Icon-Groessen in
    // src/components stehen NICHT auf der Leiter, und dieses Paket bringt
    // sie auch nicht darauf — 655 Call-Sites umzustellen ist ein eigenes
    // Paket mit eigenem Sichttermin, nicht ein Nebensatz in einem anderen.
    //
    // Was das Paket erreicht hat: die 19 Groessen unterscheiden sich nicht
    // mehr im GEWICHT (das rechnen die Bloecke oben nach), nur noch in der
    // Groesse. Der Faktor 2,5 zwischen dem kleinsten und dem groessten
    // Strich ist weg, ohne dass eine dieser 655 Zeilen angefasst wurde.
    //
    // Die Zahl hier ist eine Sperrklinke: sie darf sinken, nicht steigen.
    // Wer eine ZWANZIGSTE Groesse erfindet, faellt hier durch und nimmt
    // eine Leiterstufe.
    const sizes = new Set<number>()
    for (const [name, src] of FILES) {
      if (name.includes('three/')) continue // three.js `size` ist keine Icon-Groesse
      for (const m of src.matchAll(/\bsize=\{(\d+)\}/g)) sizes.add(Number(m[1]))
    }
    expect(sizes.size).toBeLessThanOrEqual(19)
    // Und die Leiter ist wirklich in Gebrauch, nicht nur definiert.
    const onLadder = (ALL.match(/\bsize=\{ICON_(?:SM|MD|LG)\}/g) ?? []).length
    expect(onLadder).toBeGreaterThanOrEqual(11)
  })
})
