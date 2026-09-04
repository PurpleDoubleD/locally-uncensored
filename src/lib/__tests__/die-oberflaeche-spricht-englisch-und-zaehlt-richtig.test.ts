/**
 * Vier Nebenbefunde der Gegenprobe G2, alle vom selben Schlag: eine Zeichenkette,
 * die niemand mit dem Fall geprueft hat, in dem sie steht.
 *
 * 1. "1 files" auf den Bildmodell-Kacheln unter Models, Image, auch bei genau
 *    einer Datei. Dasselbe im Download-Streifen und im Bestaetigungsfenster.
 * 2. Das X ueber einem EINZELNEN Download traegt den Titel "Cancel all".
 * 3. "Download cancelled. The LU Engine keeps the model it is running." stand
 *    da, waehrend gar keine Engine lief. Der Tester hat das ausdruecklich
 *    notiert: "Beim ersten Abbruch lief gar keine Engine auf 8127."
 * 4. Zwei Katalogeintraege beschrieben sich auf Deutsch in einer englischen
 *    Oberflaeche: "kleinster brauchbarer Quant, passt auf eine 12-GB-Karte"
 *    und "Q6, nahezu verlustfrei". Die Nachbarn derselben Seite sind Englisch.
 *
 * Run: npx vitest run src/lib/__tests__/die-oberflaeche-spricht-englisch-und-zaehlt-richtig.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { countLabel } from '../formatters'

const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

describe('countLabel', () => {
  it('eins ist Einzahl', () => {
    expect(countLabel(1, 'file')).toBe('1 file')
    expect(countLabel(1, 'model')).toBe('1 model')
  })

  it('alles andere ist Mehrzahl', () => {
    expect(countLabel(0, 'file')).toBe('0 files')
    expect(countLabel(2, 'file')).toBe('2 files')
  })

  it('und trennt Tausender wie der Rest der Oberflaeche', () => {
    expect(countLabel(9766, 'download')).toBe('9,766 downloads')
  })

  it('eine unregelmaessige Mehrzahl laesst sich sagen', () => {
    expect(countLabel(1, 'entry', 'entries')).toBe('1 entry')
    expect(countLabel(3, 'entry', 'entries')).toBe('3 entries')
  })

  // Negativkontrolle: genau das stand auf der Kachel.
  it('die alte Fassung sagte "1 files"', () => {
    expect(`${1} files`).toBe('1 files')
    expect(countLabel(1, 'file')).not.toBe('1 files')
  })
})

describe('die Stellen, an denen es stand', () => {
  it('keine Kachel und kein Streifen zaehlt mehr von Hand', () => {
    for (const [datei, stelle] of [
      ['components/models/ModelTiles.tsx', 'countLabel(bundle.files.length'],
      ['components/models/DiscoverModels.tsx', 'countLabel(confirmDownload.files.length'],
      ['components/layout/DownloadBadge.tsx', 'countLabel(files.length'],
    ] as const) {
      const src = lies(datei)
      expect(src).toContain(stelle)
      expect(src).not.toMatch(/\{[\w.]*files\.length\} files/)
    }
  })

  it('das X ueber einem einzelnen Download heisst nicht "Cancel all"', () => {
    const src = lies('components/layout/DownloadBadge.tsx')
    expect(src).toContain("files.length === 1 ? 'Cancel' : 'Cancel all'")
    expect(src).toContain("files.length === 1 ? 'Dismiss' : 'Dismiss all'")
    expect(src).not.toContain('title="Cancel all"')
  })

  it('die Abbruchmeldung behauptet nichts ueber eine Engine, die vielleicht nicht laeuft', () => {
    const src = lies('components/models/DiscoverModels.tsx')
    expect(src).toContain('Download cancelled, so the chat model was not switched.')
    expect(src).not.toContain('The LU Engine keeps the model it is running')
  })
})

describe('der Modellkatalog spricht die Sprache der Oberflaeche', () => {
  const KATALOG = lies('api/discover.ts')

  it('kein deutscher Satz in einer Beschreibung', () => {
    const DE = /\b(der|die|das|und|nicht|fuer|Fuer|eine|einen|einer|kein|keine|nahezu|verlustfrei|guenstigste|kleinster|brauchbarer|passt|Karte|Karten|Speicher)\b/
    const suender: string[] = []
    for (const m of KATALOG.matchAll(/description: '((?:[^'\\]|\\.)*)'/g)) {
      if (DE.test(m[1])) suender.push(m[1].slice(0, 80))
    }
    expect(suender).toEqual([])
  })

  it('und die fuenf Stellen sagen jetzt, was sie sagen wollten', () => {
    expect(KATALOG).toContain('the smallest usable quant, fits a 12 GB card.')
    expect(KATALOG).toContain('Qwen 3.8 27B RVN Heretic · Q6, near-lossless. For high-VRAM setups.')
    expect(KATALOG).toContain('Gemma 4 12B heretic · IQ4_XS, the cheapest 4-bit. For 8 GB cards.')
    expect(KATALOG).toContain('Gemma 4 12B heretic · Q6, near-lossless.')
    expect(KATALOG).toContain('Qwen3-VL 8B abliterated · Q6, near-lossless.')
  })
})
