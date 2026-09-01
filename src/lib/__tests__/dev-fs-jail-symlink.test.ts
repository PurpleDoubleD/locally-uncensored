/**
 * Der Käfig gegen ECHTE Symlinks — mit echten Verzeichnissen, echten Links und
 * `fs.realpathSync` als hereingereichtem Auflöser.
 *
 * DER BEFUND: `containWithin` prüfte rein lexikalisch (`lexicalNormalize` +
 * Präfixvergleich), also glaubte es dem Pfad-STRING. Ein Symlink INNERHALB des
 * Arbeitsordners, der nach draussen zeigt, liest sich als `<root>/link/datei`,
 * besteht die Containment-Prüfung — und das `open()` dahinter landet trotzdem
 * draussen. Am laufenden Dev-Server nachgestellt:
 *
 *   ln -s /etc <ws>/out
 *   POST /local-api/fs-read {"path":"out/hosts","workingDirectory":"<ws>"}
 *   → {"content":"##\n# Host Database\n#\n…"}
 *
 * DIE RUST-SEITE HAT DIESE LÜCKE NICHT: `contain_within` (filesystem.rs:130)
 * prüft BEIDE Seiten — einmal lexikalisch und einmal über
 * `resolve_existing_prefix` (:62), das den tiefsten EXISTIERENDEN Vorfahren
 * kanonisiert und den noch nicht existierenden Schwanz wieder anhängt. Genau
 * das ist hier portiert; kein Produktbefund, sondern ein fehlender Port.
 *
 * WARUM DER AUFLÖSER HEREINGEREICHT WIRD: `src/lib/dev-fs-jail.ts` ist rein
 * (kein `node:*`-Import — das App-tsconfig kennt keine Node-Typen, und der
 * Käfig soll neben seinem Test liegen können). `homeDir` kommt schon so herein,
 * `net.isIP` beim SSRF-Wächter auch. DIESER Test darf `node:fs` benutzen, die
 * geprüfte Datei nicht.
 *
 * BEIDE SEITEN WERDEN AUFGELÖST, nicht nur der Kandidat — sonst wäre auf macOS
 * jeder Arbeitsordner unter `/tmp` (Symlink auf `/private/tmp`) ein Ausbruch.
 * Der Fall steht unten als eigene Zusicherung.
 *
 * MUTATIONSSONDE (von Hand geprüft): in `containWithin` den zweiten Vergleich
 *   `&& isWithinKey(resolveExistingPrefix(nroot, realPath), resolveExistingPrefix(candidate, realPath))`
 * entfernen → alle „führt hinaus"-Fälle werden rot; zurücknehmen → grün.
 * Gegenprobe im Test selbst: der letzte Block ruft dieselben Pfade OHNE
 * `realPath` auf und hält fest, dass sie dann durchgehen — das ist der Zustand
 * vor diesem Fix.
 *
 * Run: npx vitest run src/lib/__tests__/dev-fs-jail-symlink.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { containWithin, devResolveWithinJail, JailEscapeError, resolveExistingPrefix } from '../dev-fs-jail'
import type { RealPathFn } from '../dev-fs-jail'

/** Vorwärts-Schrägstriche, wie der Käfig sie sieht (auch unter Windows). */
const s = (p: string): string => p.replace(/\\/g, '/')

let basis = ''
let ws = ''
let geheim = ''
let wsLink = ''
/** Ein Heimatverzeichnis, das mit den Testpfaden garantiert nichts zu tun hat. */
const HOME = '/Users/kein-echtes-heim'

/**
 * Die Wurzel eines wurzel-relativen Pfades — `/` auf posix, `C:/` unter
 * Windows.
 *
 * DAS IST KEINE TESTKOSMETIK, SONDERN DIE PLATTFORM. Ein Pfad wie
 * `/gibt-es-nicht/x.txt` hat unter Windows kein Laufwerk und gehoert damit zum
 * AKTUELLEN — `realpathSync('/')` antwortet dort `C:\`, auf macOS `/` (beides
 * am 01.09.2026 auf beiden Maschinen nachgemessen). `resolveExistingPrefix`
 * loest den tiefsten existierenden Vorfahren auf, und der Vorfahre `/`
 * existiert auf beiden Systemen; es kommt also dieselbe Stelle zurueck, nur in
 * der Schreibweise des jeweiligen Systems.
 *
 * Genommen wird sie von `node:path`, nicht von `node:fs` und nicht von der
 * geprueften Datei: `parse(cwd).root` ist eine unabhaengige Auskunft darueber,
 * wie die Wurzel des aktuellen Laufwerks heisst, und macht die Zusicherung
 * damit nicht zum Spiegel des Codes, den sie prueft.
 */
const WURZEL = s(parse(process.cwd()).root)

const realPath = (p: string): string => realpathSync(p)

beforeAll(() => {
  basis = s(mkdtempSync(join(tmpdir(), 'lu-jail-symlink-')))
  ws = `${basis}/arbeitsordner`
  geheim = `${basis}/geheim`
  mkdirSync(`${ws}/echt`, { recursive: true })
  mkdirSync(geheim, { recursive: true })
  writeFileSync(`${ws}/echt/a.txt`, 'drinnen\n')
  writeFileSync(`${geheim}/schatz.txt`, 'draussen\n')
  // Der Ausbruch: ein Link IM Arbeitsordner, der hinauszeigt.
  symlinkSync(geheim, `${ws}/raus`)
  // Die Gegenprobe: ein Link im Arbeitsordner, der drinnen bleibt.
  symlinkSync(`${ws}/echt`, `${ws}/innen`)
  // Die Wurzel SELBST hinter einem Link — der /tmp-auf-/private/tmp-Fall.
  wsLink = `${basis}/arbeitsordner-link`
  symlinkSync(ws, wsLink)
})

afterAll(() => {
  if (basis) rmSync(basis, { recursive: true, force: true })
})

describe('ein Symlink, der aus dem Arbeitsordner hinausführt', () => {
  it('wird abgelehnt, obwohl der Pfad-String im Arbeitsordner liegt', () => {
    // Lexikalisch ist `<ws>/raus/schatz.txt` einwandfrei — genau darum ging der
    // Zugriff vorher durch.
    expect(s(`${ws}/raus/schatz.txt`).startsWith(`${ws}/`)).toBe(true)
    expect(() => containWithin(ws, 'raus/schatz.txt', realPath)).toThrow(JailEscapeError)
  })

  it('wird auch als ABSOLUTER Pfad abgelehnt', () => {
    expect(() => containWithin(ws, `${ws}/raus/schatz.txt`, realPath)).toThrow(JailEscapeError)
  })

  it('wird abgelehnt, wenn die Datei dahinter noch gar nicht existiert', () => {
    // Der `fs-write`-Fall: der Link existiert, das Ziel noch nicht. Genau dafür
    // löst Rust nur den existierenden Vorfahren auf und hängt den Rest an.
    expect(() => containWithin(ws, 'raus/neu.txt', realPath)).toThrow(JailEscapeError)
    expect(() => containWithin(ws, 'raus/tief/neu.txt', realPath)).toThrow(JailEscapeError)
  })

  it('wird auch an der echten Tür abgelehnt, nicht nur im Primitiv', () => {
    expect(() =>
      devResolveWithinJail({
        path: 'raus/schatz.txt',
        homeDir: HOME,
        workingDirectory: ws,
        realPath,
      }),
    ).toThrow(JailEscapeError)
  })
})

describe('was weiterhin durchgehen muss', () => {
  it('ein Symlink, der IM Arbeitsordner bleibt', () => {
    expect(containWithin(ws, 'innen/a.txt', realPath)).toBe(`${ws}/innen/a.txt`)
  })

  it('eine gewöhnliche Datei', () => {
    expect(containWithin(ws, 'echt/a.txt', realPath)).toBe(`${ws}/echt/a.txt`)
  })

  it('eine Datei, die es noch nicht gibt (fs-write legt sie an)', () => {
    expect(containWithin(ws, 'neu.txt', realPath)).toBe(`${ws}/neu.txt`)
    expect(containWithin(ws, 'noch/tiefer/neu.txt', realPath)).toBe(`${ws}/noch/tiefer/neu.txt`)
  })

  it('die Wurzel selbst', () => {
    expect(containWithin(ws, '.', realPath)).toBe(ws)
    expect(containWithin(ws, '', realPath)).toBe(ws)
  })

  it('ein Arbeitsordner, dessen WURZEL hinter einem Symlink liegt', () => {
    // Auf macOS ist schon `/tmp` ein Link auf `/private/tmp`. Würde nur der
    // Kandidat aufgelöst, wäre hier jeder Pfad ein Ausbruch — und der Käfig
    // hätte den ganzen Dev-Server lahmgelegt.
    expect(realPath(wsLink)).not.toBe(wsLink)
    expect(containWithin(wsLink, 'echt/a.txt', realPath)).toBe(`${wsLink}/echt/a.txt`)
    expect(containWithin(wsLink, 'neu.txt', realPath)).toBe(`${wsLink}/neu.txt`)
    // Und der Ausbruch bleibt auch über die verlinkte Wurzel ein Ausbruch.
    expect(() => containWithin(wsLink, 'raus/schatz.txt', realPath)).toThrow(JailEscapeError)
  })

  it('gibt den LEXIKALISCHEN Pfad zurück, nicht den aufgelösten', () => {
    // Wie Rust: entschieden wird auf dem echten Ziel, geantwortet in der
    // Schreibweise, die der Aufrufer kennt und in der Oberfläche vergleicht.
    const ergebnis = containWithin(wsLink, 'echt/a.txt', realPath)
    expect(ergebnis).toBe(`${wsLink}/echt/a.txt`)
    expect(ergebnis).not.toBe(`${s(realPath(ws))}/echt/a.txt`)
  })
})

describe('resolveExistingPrefix', () => {
  it('löst den tiefsten existierenden Vorfahren auf und hängt den Rest an', () => {
    expect(s(resolveExistingPrefix(`${ws}/raus/neu/tief.txt`, realPath))).toBe(
      `${s(realPath(geheim))}/neu/tief.txt`,
    )
  })

  it('löst nur den existierenden Vorfahren auf und lässt den Rest wörtlich stehen', () => {
    // Auf beiden Systemen existiert hier GENAU EIN Vorfahre: die Wurzel. Der
    // ganze Rest wird unverändert angehängt — kein Segment verschwindet, keins
    // wird umgestellt, keins aufgelöst.
    expect(resolveExistingPrefix('/gibt-es-nicht/auch-nicht/x.txt', realPath)).toBe(
      `${WURZEL}gibt-es-nicht/auch-nicht/x.txt`,
    )
  })

  it('gibt den lexikalischen Pfad zurück, wenn wirklich gar nichts existiert', () => {
    // Der Zweig, den der Test darüber NICHT erreicht: `segments.length === 0`,
    // also "auch das Präfix gibt es nicht". Über das Dateisystem ist er auf
    // keiner der beiden Maschinen erreichbar — `/` existiert auf macOS, und
    // unter Windows löst es sich auf das aktuelle Laufwerk auf. Erreichbar ist
    // er über den Auflöser, und der wird ohnehin hereingereicht: ein Auflöser,
    // der IMMER wirft, ist genau "nichts existiert", auf jedem System gleich.
    const nichtsExistiert: RealPathFn = () => { throw new Error('ENOENT') }
    expect(resolveExistingPrefix('/gibt-es-nicht/auch-nicht/x.txt', nichtsExistiert)).toBe(
      '/gibt-es-nicht/auch-nicht/x.txt',
    )
    expect(resolveExistingPrefix('C:/gibt-es-nicht/x.txt', nichtsExistiert)).toBe(
      'C:/gibt-es-nicht/x.txt',
    )
  })

  it('lässt ohne Auflöser alles unverändert', () => {
    expect(resolveExistingPrefix(`${ws}/raus/schatz.txt`)).toBe(`${ws}/raus/schatz.txt`)
  })
})

describe('ohne Auflöser — der Zustand VOR diesem Fix', () => {
  it('lässt denselben Symlink hinaus', () => {
    // Absichtlich festgehalten, nicht versteckt: fehlt `realPath`, prüft der
    // Käfig nur lexikalisch und die Lücke ist wieder offen. Deshalb reichen ihn
    // alle sechs Türen mit (dev-server-shape.test.ts hält das fest), und
    // deshalb ist DIESE Zusicherung die eingebaute Sonde für den Fix.
    expect(containWithin(ws, 'raus/schatz.txt')).toBe(`${ws}/raus/schatz.txt`)
    expect(
      devResolveWithinJail({ path: 'raus/schatz.txt', homeDir: HOME, workingDirectory: ws }),
    ).toBe(`${ws}/raus/schatz.txt`)
  })
})
