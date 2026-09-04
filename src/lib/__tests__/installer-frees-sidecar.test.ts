/**
 * The Windows installer has to free our own engine before it copies over it,
 * and it may free NOTHING ELSE.
 *
 * aldrich_ironhart, 2026-08-10: the update died on "Error opening file for
 * writing: D:\Locally Uncensored\llama-server.exe". Windows locks a running
 * image, and the hook that kills our processes was compiled away in every
 * normal build (it sat behind a productName check that is false today), so
 * nothing ever stopped the sidecar.
 *
 * The name is the fragile part: it appears in the bundle config, in Rust, and
 * in the installer, and a rename in one of them makes the hook silently do
 * nothing again. So all three are compared here, not just the hook.
 *
 * Review 2026-08-14: the first version of the unlock reached far too wide.
 * `taskkill /F /T /IM "llama-server.exe"` matches by image name for the whole
 * session, so a llama.cpp server the user started themselves (one of the
 * backends this app detects, so a normal thing to have running) was hard
 * killed mid-generation by an update they never watched. Everywhere else the
 * app leaves a stranger alone, so the kill is now scoped to the one file the
 * installer is about to overwrite, and a lock it cannot clear moves the file
 * aside instead of handing the user Abort, Retry, Ignore.
 *
 * Run: npx vitest run src/lib/__tests__/installer-frees-sidecar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const hooks = read('src-tauri/windows/installer-hooks.nsh')
const engineRs = read('src-tauri/src/commands/engine.rs')
const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
  build?: { frontendDist?: string }
  bundle?: { externalBin?: string[]; resources?: string[] }
}

// Only the unlock macro. The dormant product-rename macro below it kills the
// app itself and is a different question, and so is the frontend sweep that
// now sits between them: this slice used to run to NSIS_HOOK_PREINSTALL and
// swallowed everything in between, so the cases below would have started
// making claims about code they were never written for.
const unlock = hooks.slice(
  hooks.indexOf('!macro LU_FREE_SIDECAR'),
  hooks.indexOf('!macro LU_SWEEP_OLD_FRONTEND'),
)

describe('the installer frees the bundled engine', () => {
  it('runs the unlock on every build, not only on a product rename', () => {
    const preinstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_PREINSTALL'))
    const insert = preinstall.indexOf('!insertmacro LU_FREE_SIDECAR')
    const rename = preinstall.indexOf('!if "${PRODUCTNAME}"')
    expect(insert).toBeGreaterThan(-1)
    // Before the compile-time rename switch, otherwise it is dead code again.
    expect(insert).toBeLessThan(rename)
  })

  it('asks the only question that matters, can the file be written', () => {
    expect(unlock).toMatch(/FileOpen \$R3 "\$INSTDIR\\\$\{EXE\}" a/)
    // Bounded: a locked file must not spin the installer forever.
    expect(unlock).toMatch(/\$R4 >= 4/)
  })

  it('frees the file the bundle actually ships and Rust actually starts', () => {
    const external = conf.bundle?.externalBin ?? []
    expect(external).toContain('bin/lu-llama-server')
    expect(engineRs).toMatch(/"lu-llama-server\.exe"/)
  })
})

describe('it kills our engine and nobody elses', () => {
  it('never swings at an image name', () => {
    expect(unlock).not.toMatch(/\/IM/)
  })

  it('kills only the process whose image is the file being overwritten', () => {
    expect(unlock).toContain("-eq '$INSTDIR\\${EXE}'")
    expect(unlock).toMatch(/Stop-Process -Id \$\$_\.ProcessId -Force/)
  })

  it('reads the path over WMI, a 32 bit installer cannot read a 64 bit MainModule', () => {
    expect(unlock).toContain('Get-CimInstance Win32_Process')
    expect(unlock).not.toContain('Get-Process')
  })

  it('escapes the PowerShell dollar so NSIS does not eat the pipeline variable', () => {
    // A bare $_ is an unknown NSIS variable and expands to nothing, which would
    // compare the empty string against the path and match no process at all.
    expect(unlock).not.toMatch(/[^$]\$_\./)
  })

  it('touches nothing while the file still opens for writing', () => {
    // The kill sits behind the write probe, not in front of it.
    expect(unlock.indexOf('FileOpen')).toBeLessThan(unlock.indexOf('nsExec::Exec'))
  })

  it('follows the rule the rest of the app already keeps', () => {
    expect(engineRs).toMatch(
      /already serving another llama-server that this app does not manage/,
    )
  })
})

describe('a lock we cannot clear must not end the update', () => {
  it('moves the old engine aside instead of failing the copy', () => {
    expect(unlock).toMatch(
      /Rename "\$INSTDIR\\\$\{EXE\}" "\$INSTDIR\\\$\{EXE\}\.old"/,
    )
    // The rename is the last resort, it belongs after the retry budget.
    expect(unlock.indexOf('$R4 >= 4')).toBeLessThan(unlock.indexOf('Rename'))
  })

  it('sweeps the leftover before the next install writes a new one', () => {
    const sweep = unlock.indexOf('Delete "$INSTDIR\\${EXE}.old"')
    expect(sweep).toBeGreaterThan(-1)
    expect(sweep).toBeLessThan(unlock.indexOf('${Do}'))
  })
})

/**
 * GitHub #120 (AnnSdf1969, Ubuntu 26.04, 2026-08-28): the sidecar was called
 * llama-server, Tauri's deb bundler copies external binaries straight into
 * /usr/bin, and Debian's own llama.cpp-tools package owns
 * /usr/bin/llama-server. dpkg refused the entire install over the collision.
 * The file now carries our prefix, which means a Windows update coming from
 * 2.6.6 or older finds the old file, and possibly a live process on it, in an
 * install folder we no longer write that name into.
 */
describe('an update from before the rename does not leave the old engine behind', () => {
  const preinstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_PREINSTALL'))

  it('frees the file this build actually ships', () => {
    expect(preinstall).toContain('!insertmacro LU_FREE_SIDECAR "lu-llama-server.exe"')
  })

  it('also frees and removes the name 2.6.6 shipped', () => {
    expect(preinstall).toContain('!insertmacro LU_SWEEP_OLD_SIDECAR')
    const sweep = hooks.slice(hooks.indexOf('!macro LU_SWEEP_OLD_SIDECAR'))
    expect(sweep).toContain('!insertmacro LU_FREE_SIDECAR "llama-server.exe"')
    expect(sweep).toContain('Delete "$INSTDIR\\llama-server.exe"')
  })

  it('never ships a name Debian already owns in /usr/bin', () => {
    // Negative control: the four binaries llama.cpp-tools installs there.
    const external = conf.bundle?.externalBin ?? []
    const names = external.map((b) => b.split('/').pop())
    for (const owned of ['llama-server', 'llama-cli', 'llama-bench', 'llama-quantize']) {
      expect(names).not.toContain(owned)
    }
  })
})

/**
 * Was der Installer hinlegt, muss er auch wieder wegnehmen koennen.
 *
 * Gemessen am 04.09.2026 auf der Windows-Box, in einem Ordner, der seit April
 * jede Aktualisierung mitgenommen hat:
 *
 *     _up_\dist\assets                        1170 Dateien   131,9 MB
 *     davon aus dem an dem Morgen installierten Build    266
 *     aelteste Datei                              15.04.2026
 *
 * Rund 900 tote Dateien und gut 110 MB, die jeder Nutzer mitschleppt. Der
 * Grund sind zwei Gewohnheiten, die einzeln richtig sind: Vite haengt an jeden
 * Brocken einen Hash, ein neuer Build ueberschreibt den alten also nie sondern
 * legt sich daneben, und NSIS kopiert nur, es raeumt nie weg.
 *
 * Beides zusammen erklaert, warum der Stapel waechst. Es erklaert nicht, warum
 * ueberhaupt ein Frontend danebenliegt: das ist der zweite Teil, weiter unten.
 */
describe('der Installer laesst den alten Frontend-Stapel nicht liegen', () => {
  const preinstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_PREINSTALL'))
  const sweep = hooks.slice(
    hooks.indexOf('!macro LU_SWEEP_OLD_FRONTEND'),
    hooks.indexOf('!macro NSIS_HOOK_PREINSTALL'),
  )

  it('raeumt vor jedem Kopieren auf, in jedem Build', () => {
    expect(preinstall).toContain('!insertmacro LU_SWEEP_OLD_FRONTEND')
    // Vor dem Umbenennungsschalter, sonst waere es wieder toter Code, genau
    // wie die Entsperrung es einmal war.
    expect(preinstall.indexOf('!insertmacro LU_SWEEP_OLD_FRONTEND'))
      .toBeLessThan(preinstall.indexOf('!if "${PRODUCTNAME}"'))
  })

  it('nimmt den ganzen Ordner, nicht einzelne Dateien', () => {
    // Eine Liste von Namen waere sinnlos: die Namen sind Hashes und heissen bei
    // jedem Build anders. Genau daran ist das Aufraeumen bisher gescheitert.
    expect(sweep).toContain('RMDir /r "$INSTDIR\\_up_\\dist"')
  })

  it('nur dort, wo unser Frontend wirklich liegt', () => {
    // Das rekursive Loeschen ist die einzige Anweisung in dieser Datei, die
    // sich nicht zuruecknehmen laesst. Sie darf bei einem falschen $INSTDIR
    // nicht losgehen.
    expect(sweep).toContain('${FileExists} "$INSTDIR\\_up_\\dist\\index.html"')
    expect(sweep.indexOf('FileExists')).toBeLessThan(sweep.indexOf('RMDir'))
  })

  it('faesst nichts an, worin Nutzerdaten liegen koennten', () => {
    // Negativkontrolle. Chats, Einstellungen, Modelle und Ergebnisse liegen
    // unter den App-Data-Ordnern, nie im Installationsordner. Ein RMDir auf
    // $APPDATA oder auf $INSTDIR selbst waere ein Datenverlust, kein Aufraeumen.
    expect(sweep).not.toContain('RMDir /r "$INSTDIR"')
    expect(sweep).not.toContain('$APPDATA')
    expect(sweep).not.toContain('$LOCALAPPDATA')
    expect(sweep).not.toContain('$DOCUMENTS')
    // Und der Ordner mit den Modellen der Engine schon gar nicht.
    expect(sweep).not.toContain('resources')
  })
})

/**
 * Und der Grund, warum ueberhaupt etwas liegen bleibt: wir haben das Frontend
 * zweimal ausgeliefert.
 *
 * `build.frontendDist` backt die Oberflaeche in die Binaerdatei, das ist der
 * Weg, den die App geht (`tauri.localhost` liest aus der exe). Daneben stand
 * `../dist` in `bundle.resources`, seit dem allerersten Tauri-Commit
 * (bd22a135, Geruest, ohne Begruendung). Das `..` schreibt Tauri als `_up_`,
 * darum der Ordner mit dem seltsamen Namen. Gelesen hat ihn nie jemand:
 * `resource_dir()` kommt in diesem Baum genau zweimal vor, einmal fuer
 * `whisper_server.py` und einmal fuer die Engine.
 *
 * Gegenprobe am 04.09.2026 am echten Windows-Build, nicht am Quelltext: den
 * Ordner beiseite geschoben (er liess sich verschieben, also hielt ihn kein
 * Prozess offen), App ueber die geplante Aufgabe neu gestartet, CDP nach vier
 * Sekunden gefragt. Titel „Locally Uncensored", ein Kind unter `#root`, alle
 * sechs Reiter der Kopfzeile da. Die Kopie ist tot.
 *
 * Die beiden Haelften gehoeren zusammen und ersetzen einander nicht: hier
 * entsteht kein neuer Stapel mehr, und das Aufraeumen oben holt den weg, den
 * die Aktualisierung von einer aelteren Fassung vorfindet.
 */
describe('das Frontend wird einmal ausgeliefert, nicht zweimal', () => {
  const resources = conf.bundle?.resources ?? []

  it('liegt in der Binaerdatei', () => {
    expect(conf.build?.frontendDist).toBe('../dist')
  })

  it('und nicht noch einmal daneben', () => {
    expect(resources).not.toContain('../dist')
    // Kein Eintrag klettert aus src-tauri heraus. Jeder, der es taete, laege
    // wieder unter `_up_` und faenge denselben Stapel von vorne an.
    for (const r of resources) expect(r).not.toContain('..')
  })

  it('was wirklich gebraucht wird, bleibt', () => {
    // Negativkontrolle gegen einen zu breiten Schnitt: `whisper_server.py`
    // wird ueber `resource_dir()` gelesen, das Loeschen waere kein Aufraeumen
    // sondern ein kaputtes Diktiergeraet.
    expect(resources).toContain('resources/whisper_server.py')
    expect(read('src-tauri/src/commands/whisper.rs')).toContain('.resource_dir()')
  })
})
