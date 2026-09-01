/**
 * T-76 · "Create-Dateislots geben ihre Blob-URLs nie frei" — der Rest davon.
 *
 * Der Audit-Zeiger (SpecialIntentControls.tsx:48) trifft eine Stelle, die
 * bereits geschlossen IST: `mediaRefFrom` mintet eine `blob:` URL pro Pick,
 * und `setAudioInput` / `setVideoInput` geben die vorige über
 * `releaseReplacedMediaRef` zurück (bewiesen in
 * `src/api/__tests__/mlx-video-blob-lifetime.test.ts`).
 *
 * Ungedeckt blieb der DRITTE Slot derselben Familie: `trainImages`, ein
 * MediaRef[]. Er wird nicht ersetzt, sondern erweitert, gefiltert und
 * geleert — und keiner dieser drei Wege gab je etwas zurück:
 *
 *   - `addTrainImages` wirft Namensdubletten weg und kappt bei 30,
 *   - `removeTrainImage` filtert einen heraus,
 *   - `clearTrainImages` leert alles (der Cloud-Trainingslauf ruft das nach
 *     jedem Submit, `useCloudCreate.ts:367`).
 *
 * Jeder weggeworfene Eintrag hielt seine Datei bis zum Reload im Speicher —
 * bei 30 Fotos zu je einigen Megabyte ist das der ganze Trainingssatz.
 *
 * Lauf: npx vitest run src/components/create/experimental/__tests__/das-trainingsset-gibt-seine-blobs-zurueck.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { useCreateStore } from '../../../../stores/createStore'
import { mediaRefFrom } from '../mediaRef'

// ── ein zählbarer Ersatz für die Blob-Tabelle des Renderers ────────────────
let minted = 0
const live = new Set<string>()

beforeEach(() => {
  minted = 0
  live.clear()
  globalThis.URL.createObjectURL = () => {
    const url = `blob:test/${++minted}`
    live.add(url)
    return url
  }
  globalThis.URL.revokeObjectURL = (url: string) => { live.delete(url) }
  useCreateStore.setState({ trainImages: [], audioInput: null, videoInput: null })
})

/** Eine Datei, wie der Dateidialog sie liefert. */
function file(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

/** Genau das, was `TrainSetBoard.addFiles` (Stage.tsx) mit einem Drop tut. */
function drop(...names: string[]) {
  useCreateStore.getState().addTrainImages(names.map((n) => mediaRefFrom(file(n))))
}

describe('das Trainingsset gibt seine Blob-URLs zurück', () => {
  it('ein entferntes Foto gibt seine Datei frei', () => {
    drop('a.png', 'b.png')
    expect(live.size).toBe(2)
    useCreateStore.getState().removeTrainImage('a.png')
    expect(live.size).toBe(1)
  })

  it('eine verworfene Dublette gibt ihre Datei frei', () => {
    // Zweimal denselben Ordner fallen lassen ist der Normalfall, nicht der
    // Sonderfall: der Nutzer sieht nicht, dass die Bilder schon drin sind.
    // Die Dublette bekommt in `addFiles` eine EIGENE, frische URL und wird
    // dann von der Namens-Dedupe weggeworfen — unerreichbar, aber gepinnt.
    drop('a.png')
    const kept = useCreateStore.getState().trainImages[0].url
    drop('a.png')
    expect(useCreateStore.getState().trainImages).toHaveLength(1)
    expect(live.has(kept)).toBe(true)
    expect(live.size).toBe(1)
  })

  it('was die 30er-Kappe abschneidet, gibt seine Datei frei', () => {
    // Diese Grenze hat gar keine UI: der Schnitt passiert still.
    drop(...Array.from({ length: 34 }, (_, i) => `f${i}.png`))
    expect(useCreateStore.getState().trainImages).toHaveLength(30)
    expect(live.size).toBe(30)
  })

  it('das Leeren des Sets gibt jede Datei zurück, die es hielt', () => {
    // `useCloudCreate` ruft clearTrainImages nach jedem abgeschickten
    // Trainingslauf — vorher blieb dabei der komplette Satz im Speicher.
    drop(...Array.from({ length: 12 }, (_, i) => `f${i}.png`))
    expect(live.size).toBe(12)
    useCreateStore.getState().clearTrainImages()
    expect(live.size).toBe(0)
  })

  it('was das Set behält, wird nicht widerrufen', () => {
    // Die Gegenprobe: ein Helfer, der zu viel freigibt, macht die Vorschau
    // im Board kaputt, und das sähe im Test oben genauso "grün" aus.
    drop('a.png', 'b.png', 'c.png')
    useCreateStore.getState().removeTrainImage('b.png')
    for (const img of useCreateStore.getState().trainImages) {
      expect(live.has(img.url)).toBe(true)
    }
    expect(live.size).toBe(2)
  })

  it('ein erneuter Anlauf desselben Sets stapelt nichts auf', () => {
    // Der gemessene Ablauf: 30 wählen, ersetzen (dieselben Namen nochmal),
    // eins entfernen, Ansicht wechseln (= Set leeren).
    drop(...Array.from({ length: 30 }, (_, i) => `f${i}.png`))
    drop(...Array.from({ length: 30 }, (_, i) => `f${i}.png`))
    useCreateStore.getState().removeTrainImage('f0.png')
    useCreateStore.getState().clearTrainImages()
    expect(minted).toBe(60)
    expect(live.size).toBe(0)
  })
})

describe('es gibt genau eine Stelle, die eine Slot-URL mintet', () => {
  it('kein Create-Modul baut sich seinen MediaRef selbst zusammen', () => {
    // Der eigentliche Befund war nicht "hier fehlt ein revoke", sondern
    // "der Mint ist kopiert und nur eine Kopie hat ein Gegenstück". Solange
    // jede Oberfläche ihren eigenen `{ name, url, blob }` bauen darf, kommt
    // der nächste Slot ohne Freigabe daneben. `mediaRef.ts` ist die eine
    // Stelle; sein Gegenstück ist `releaseDroppedMediaRefs` im Store.
    const root = join(__dirname, '..', '..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(full) }
        else if (/\.tsx?$/.test(e.name)) files.push(full)
      }
    }
    walk(root)
    const offenders = files.filter((f) =>
      /url:\s*URL\.createObjectURL/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual(['experimental/mediaRef.ts'])
  })
})
