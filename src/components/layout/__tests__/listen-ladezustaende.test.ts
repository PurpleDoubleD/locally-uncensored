/**
 * Die vier Listen-Ladezustände — Audit Welle 3, Punkt 1.
 *
 * WAS SICH HIER PRUEFEN LAESST und was nicht, ausdruecklich:
 *
 *   prüfbar   · dass an allen vier Stellen ein Skelett steht statt eines
 *               Satzes (oder statt nichts),
 *             · dass die Skelette die Klassen der echten Liste TRAGEN —
 *               das ist der Kern der Sache, denn ein Skelett mit anderer
 *               Geometrie erzeugt genau den Sprung, den es verhindern soll,
 *             · dass sie aria-mässig als Ladezustand angesagt werden,
 *             · dass ihre Bewegung `animate-pulse` ist und damit unter
 *               „Bewegung reduzieren" die vorhandene Ausnahme erbt,
 *             · dass der Modellwähler waehrend des Ladens nicht mehr
 *               „No models available" behaupten KANN.
 *
 *   nur im Fenster · ob das Skelett tatsaechlich so hoch ist wie die Liste,
 *               die kommt (das entscheidet der Layout-Algorithmus, nicht der
 *               Quelltext), ob die Zeilenzahl gut gewaehlt ist, und ob der
 *               Puls in der Sidebar-Kachel nicht als Fehler gelesen wird.
 *               Dafuer gibt es in diesem Repo keinen Render-Harness
 *               (`environment: 'node'`), und Screenshots kann dieser Test
 *               nicht machen.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

/**
 * Quelltext ohne Kommentare. Ohne das prueft dieser Test seine eigenen
 * Begruendungen: die Kommentare an den vier Stellen ZITIEREN den Satz, der
 * dort stand („Loading models...", „No models available"), und ein Test, der
 * „ist das weg" fragt, faende das Zitat. Dasselbe Vorgehen wie in
 * streaming-does-not-repaint-the-app.test.ts.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const SKELETONS = codeOnly(read('components', 'layout', 'ViewSkeletons.tsx'))
const DISCOVER = codeOnly(read('components', 'models', 'DiscoverModels.tsx'))
const SELECTOR = codeOnly(read('components', 'models', 'ModelSelector.tsx'))
const SETTINGS = codeOnly(read('components', 'settings', 'SettingsPage.tsx'))
const CSS = read('index.css')

/** Der Rumpf einer exportierten Skelett-Komponente. */
function skeleton(name: string): string {
  const at = SKELETONS.indexOf(`export function ${name}()`)
  expect(at, `${name} fehlt in ViewSkeletons.tsx`).toBeGreaterThan(0)
  const next = SKELETONS.indexOf('\nexport function ', at + 1)
  return SKELETONS.slice(at, next < 0 ? undefined : next)
}

describe('an allen vier Stellen steht ein Skelett', () => {
  it('1/4 — das Modell-Raster in Discover', () => {
    expect(DISCOVER).toMatch(/\{loading \? \(\s*<ModelGridSkeleton \/>/)
    expect(DISCOVER).not.toContain('Loading models...')
  })

  it('2/4 — die CivitAI-Trefferliste', () => {
    expect(DISCOVER).toContain('{civitaiSearching && <CivitaiResultsSkeleton />}')
    expect(DISCOVER).not.toContain('Searching CivitAI...')
  })

  it('3/4 — die Liste im Modellwaehler', () => {
    expect(SELECTOR).toContain('{!inventoryLoaded && textModels.length === 0 && <ModelPickerSkeleton />}')
  })

  it('4/4 — die Import-Kandidaten in den Einstellungen', () => {
    expect(SETTINGS).toContain('{scanning && <ImportScanSkeleton />}')
    // Und die echte Liste erscheint erst NACH dem Scan, sonst stuenden
    // Skelett und Restliste des letzten Scans gleichzeitig da.
    expect(SETTINGS).toContain('{candidates !== null && !errors.scan && !scanning && (')
  })
})

describe('der Modellwaehler kann waehrend des Ladens nichts mehr behaupten', () => {
  it('„No models available" haengt an inventoryLoaded, nicht nur an der Laenge', () => {
    // Das ist der eigentliche Befund an dieser Stelle: der Zustand fehlte
    // nicht nur, er war durch eine FALSCHE Aussage besetzt.
    expect(SELECTOR).toContain('{inventoryLoaded && textModels.length === 0 && (')
    const at = SELECTOR.indexOf('No models available')
    expect(at).toBeGreaterThan(0)
    // Der Gate steht davor, nicht irgendwo.
    expect(SELECTOR.lastIndexOf('inventoryLoaded && textModels.length === 0', at)).toBeGreaterThan(0)
  })

  it('das Signal kommt aus dem Store, nicht aus einem zweiten lokalen Flag', () => {
    expect(SELECTOR).toContain('useModelStore((s) => s.inventoryLoaded)')
  })
})

describe('die Skelette tragen die Geometrie der Liste, die kommt', () => {
  it('das Raster-Skelett benutzt dieselbe Rasterzeile wie Discover', () => {
    const grid = 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5'
    expect(DISCOVER).toContain(grid)
    expect(skeleton('ModelGridSkeleton')).toContain(grid)
  })

  it('die Kachel-Huelle stimmt mit der echten Kachel ueberein', () => {
    // Die echte Kachel steht in ModelTiles.tsx: rounded-xl, 1px Rand, p-3.
    const tile = read('components', 'models', 'ModelTiles.tsx')
    expect(tile).toMatch(/relative rounded-xl border p-3/)
    const s = skeleton('ModelGridSkeleton')
    expect(s).toContain('rounded-xl border')
    expect(s).toContain('p-3')
  })

  it('die CivitAI-Zeile stimmt in Polsterung, Radius und Thumbnail-Mass', () => {
    expect(DISCOVER).toContain('flex gap-3 p-3 rounded-lg')
    expect(DISCOVER).toContain('w-14 h-14 rounded-lg')
    const s = skeleton('CivitaiResultsSkeleton')
    expect(s).toContain('flex gap-3 p-3 rounded-lg')
    expect(s).toContain('w-14 h-14 rounded-lg')
  })

  it('die Waehler-Zeile stimmt in Polsterung', () => {
    expect(SELECTOR).toContain('px-2.5 py-[5px] mx-1')
    expect(skeleton('ModelPickerSkeleton')).toContain('px-2.5 py-[5px] mx-1')
  })

  it('die Import-Zeile stimmt im Zeilenabstand', () => {
    expect(SETTINGS).toContain('<div className="space-y-1">')
    expect(skeleton('ImportScanSkeleton')).toContain('space-y-1')
  })
})

describe('die Skelette sagen, dass sie Ladezustaende sind', () => {
  const NAMES = [
    'ModelGridSkeleton',
    'CivitaiResultsSkeleton',
    'ModelPickerSkeleton',
    'ImportScanSkeleton',
  ]

  it.each(NAMES)('%s haengt in der ListShell', (name) => {
    expect(skeleton(name)).toContain('<ListShell label=')
  })

  it('die ListShell meldet role/aria und einen Text fuer Screenreader', () => {
    const shell = SKELETONS.slice(
      SKELETONS.indexOf('function ListShell('),
      SKELETONS.indexOf('export function SettingsSkeleton'),
    )
    expect(shell).toContain('role="status"')
    expect(shell).toContain('aria-busy="true"')
    expect(shell).toContain('aria-live="polite"')
    expect(shell).toContain('className="sr-only"')
  })

  it('und sie STRECKT sich nicht — h-full gehoert nur den View-Fallbacks', () => {
    const shell = SKELETONS.slice(
      SKELETONS.indexOf('function ListShell('),
      SKELETONS.indexOf('export function SettingsSkeleton'),
    )
    expect(shell).not.toContain('h-full')
    // Die View-Fallbacks brauchen es weiterhin.
    const viewShell = SKELETONS.slice(
      SKELETONS.indexOf('function Shell('),
      SKELETONS.indexOf('function ListShell('),
    )
    expect(viewShell).toContain('h-full')
  })
})

describe('die Bewegung erbt die Ausnahme, statt eine neue zu brauchen', () => {
  it('alle Skelette pulsen mit `animate-pulse`, keins bringt ein eigenes Keyframe mit', () => {
    expect(SKELETONS).toContain('animate-pulse')
    // Ein eigenes `@keyframes` in dieser Datei gaebe es gar nicht — aber ein
    // eigener Klassenname, der in index.css ein Keyframe bekaeme, schon.
    expect(SKELETONS).not.toMatch(/animation|keyframes|lu-skeleton|shimmer/i)
  })

  it('und index.css nimmt `animate-pulse` ausdruecklich von der Kuerzung aus', () => {
    // Ohne diese Ausnahme wuerde die Regel darueber
    // (`animation-iteration-count: 1`) das Skelett nach einem Durchlauf
    // einfrieren — und ein eingefrorenes Skelett sagt „fertig, aber leer".
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/)
    const pulse = block.match(/\.animate-pulse\s*\{[^}]*\}/)?.[0] ?? ''
    expect(pulse).toMatch(/animation-iteration-count:\s*infinite\s*!important/)
    expect(pulse).toMatch(/animation-duration:\s*3s\s*!important/)
  })
})
