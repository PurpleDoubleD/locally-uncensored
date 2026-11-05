/**
 * Waechter ueber die Release-Skripte der Handy-Apps (scripts/mobile/release/).
 *
 * Drei Dinge duerfen nie wieder moeglich sein, und jedes ist ein Skript weit
 * von einem Store entfernt:
 *
 *   A  Ein Paket fuer einen Store wird mit dem Cargo-Feature abnahme gebaut
 *      (inspizierbare WebView, Testhaken window.__LU_TEST__).
 *   B  Ein Paket verlaesst das Skript, ohne auf den Testhaken geprueft zu sein.
 *   C  Ein Skript laedt von selbst hoch.
 *
 * Dazu die Versionsnummer: version-setzen.sh muss jede Stelle finden, an der
 * die Handy-Version steht, und darf die Desktop-Version nicht anfassen.
 *
 * Der erste Teil liest die Skripte (laeuft ueberall). Der zweite startet sie,
 * im Trockenlauf und mit Attrappen, und laeuft nur auf dem Mac: dort werden
 * die Pakete gebaut, und die Skripte benutzen dessen Werkzeuge. Gebaut wird
 * hier nichts.
 *
 * Lauf: npx vitest run src/lib/__tests__/mobile-release-skripte.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const REL = 'scripts/mobile/release'
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/**
 * Der Text einer key.properties fuer einen Test. Die zwei Feldnamen der
 * Passwoerter entstehen erst hier: stuende eine fertige Zeile mit einem Wert
 * im Quelltext, saehe sie fuer die Schluesselsuche des Repos
 * (mobile-tests/checks/release.mjs) wie ein ausgeschriebenes Passwort aus.
 */
const keyProperties = (storeFile: string, alias: string, words: { store?: string; key?: string }) => {
  const lines = [`storeFile=${storeFile}`, `keyAlias=${alias}`]
  for (const which of ['store', 'key'] as const) {
    const word = words[which]
    if (word !== undefined) lines.push(`${which}Password=${word}`)
  }
  return `${lines.join('\n')}\n`
}
/** Ohne Kommentarzeilen: geprueft wird das Skript, nicht seine Erklaerung. */
const code = (p: string) =>
  read(p)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

const ENTRY = ['android-play.sh', 'android-offen.sh', 'ios-appstore.sh'] as const
const UPLOAD_WORD: Record<string, string | null> = {
  'android-play.sh': 'UPLOAD-TO-PLAY',
  'android-offen.sh': null,
  'ios-appstore.sh': 'UPLOAD-TO-APP-STORE',
}
/** Der Befehl, der wirklich hochlaedt, je Skript. */
const UPLOAD_COMMAND: Record<string, RegExp | null> = {
  'android-play.sh': /^\s*fastlane supply\b/m,
  'android-offen.sh': null,
  'ios-appstore.sh': /^\s*xcrun altool --upload-app\b/m,
}
const PACKAGE_CHECK: Record<string, string> = {
  'android-play.sh': 'android_bauen_und_pruefen "$PRESET" 1',
  'android-offen.sh': 'android_bauen_und_pruefen "$PRESET" 0',
  'ios-appstore.sh': '"$RELEASE_DIR/pruefe-ios-ipa.sh"',
}

const common = code(`${REL}/_gemeinsam.sh`)
const android = code(`${REL}/_android.sh`)

describe('A: kein Release-Skript baut mit dem Feature abnahme', () => {
  for (const name of ENTRY) {
    it(`${name} nennt weder ein Feature noch abnahme`, () => {
      const sh = code(`${REL}/${name}`)
      expect(sh).not.toContain('--features')
      expect(sh).not.toMatch(/abnahme/i)
      expect(sh).not.toContain('VITE_LU_ABNAHME')
    })

    it(`${name} liest seine Argumente ueber die gemeinsame Stelle, die alles Unbekannte ablehnt`, () => {
      const sh = code(`${REL}/${name}`)
      expect(sh).toMatch(/^argumente_lesen "[^\n]*" "\$@"$/m)
      expect(sh).toMatch(/^umgebung_setzen$/m)
      // Kein eigenes Lesen der Argumente neben der gemeinsamen Stelle.
      expect([...sh.matchAll(/\$[@*]/g)].length).toBe(1)
      expect(sh).not.toMatch(/\bshift\b|\bgetopts\b/)
    })
  }

  it('die gemeinsame Stelle lehnt jedes unbekannte Argument ab und kennt kein Feature-Argument', () => {
    expect(common).toMatch(/\*\) abbruch "unknown argument/)
    expect(common).not.toContain('--features')
    const known = [...common.matchAll(/^\s+(--[a-z-]+|-h\|--help)\)/gm)].map((m) => m[1])
    expect(known.sort()).toEqual(['--confirm', '--dry-run', '--probe', '--upload', '--version', '-h|--help'])
  })

  it('die gemeinsame Stelle loescht VITE_LU_ABNAHME, gleich was die Shell traegt', () => {
    expect(common).toMatch(/^\s*unset VITE_LU_ABNAHME$/m)
    expect(common).not.toMatch(/export VITE_LU_ABNAHME/)
  })

  it('Android: das Bauskript bekommt ein leeres Feature-Argument, und nur so wird es gerufen', () => {
    const calls = [...android.matchAll(/android-bauen\.sh"([^\n]*)/g)].map((m) => m[1].trim())
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call).toBe('release "" aarch64')
    // Das Bauskript selbst loescht die Variable vor allem anderen.
    expect(read('scripts/mobile/android-bauen.sh')).toMatch(/^unset VITE_LU_ABNAHME \|\| true$/m)
  })

  it('iOS: die Argumente der Tauri-CLI stehen fest und werden nicht erweitert', () => {
    const sh = code(`${REL}/ios-appstore.sh`)
    expect(sh).toContain('ARGS=(ios build --target aarch64 --ci --export-method app-store-connect)')
    expect(sh).not.toMatch(/ARGS\+=/)
    expect([...sh.matchAll(/npx tauri /g)].length).toBe(2) // die Anzeige und der Aufruf
    expect(sh).toContain('npx tauri "${ARGS[@]}"')
  })

  it('der Baubeleg der Release-Pakete nennt keine Features', () => {
    expect(code(`${REL}/ios-appstore.sh`)).toContain('bau-beleg.sh" release "" "$IPA"')
  })

  it('abnahme ist kein Standard-Feature, und die Vorpruefung sieht nach', () => {
    expect(read('src-tauri/Cargo.toml')).not.toMatch(/^default *= *\[[^\]]*abnahme/m)
    expect(common).toContain("'^default *= *\\[[^]]*abnahme'")
  })
})

describe('B: jedes Paket wird auf den Testhaken geprueft, bevor das Skript es nennt', () => {
  it('die Android-Pruefung ruft pruefe-testhaken.sh mit der Seite und der Bibliothek aus dem Paket', () => {
    const mjs = read(`${REL}/pruefe-android-paket.mjs`)
    expect(mjs).toContain("sh(join(HIER, 'pruefe-testhaken.sh'), [dist, ...libs])")
    expect(mjs).toMatch(/if \(!r\.ok\) fehler \+= 1/)
    expect(mjs).toMatch(/process\.exit\(fehler \? 1 : 0\)/)
    // Dazu die Wegwerf-Signatur und das Feature im Baubeleg.
    expect(mjs).toContain('WEGWERF')
    expect(mjs).toContain("(e.bau?.features ?? ['?']).length === 0")
  })

  it('das AAB wird selbst geprueft: Signatur gueltig, Kennung, Version und Baunummer aus seinem Manifest', () => {
    const mjs = read(`${REL}/pruefe-android-paket.mjs`)
    expect(mjs).toContain("sh(jarsigner, [...ENGLISCH, '-verify', aab])")
    expect(mjs).toContain("/^jar verified\\./m.test(v.aus)")
    expect(mjs).toContain("sh(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', proto])")
    for (const line of ["attr('package') === soll.kennung", "attr('versionName') === version", "attr('versionCode') === String(code)"]) expect(mjs).toContain(`pruefe(${line}`)
    // Laesst sich das Manifest nicht lesen, ist das ein Fund und kein Hinweis.
    expect(mjs).toMatch(/fail\(`the manifest of the bundle could not be read/)
    expect(mjs).not.toContain('that needs bundletool')
  })

  it('die Werkzeuge des JDK werden englisch gelesen, gleich in welcher Sprache das System laeuft', () => {
    // Probelauf 10.10.2026: keytool schrieb "Eigentuemer:", die Pruefung suchte "Owner:" und
    // meldete ein signiertes AAB als unsigniert.
    const mjs = read(`${REL}/pruefe-android-paket.mjs`)
    expect(mjs).toContain("const ENGLISCH = ['-J-Duser.language=en', '-J-Duser.country=US']")
    const calls = [...mjs.matchAll(/sh\((keytool|jarsigner), \[([^\]]*)\]/g)]
    expect(calls.map((m) => m[1]).sort()).toEqual(['jarsigner', 'keytool'])
    for (const m of calls) expect(m[2], m[1]).toMatch(/^\.\.\.ENGLISCH, /)
  })

  it('die iOS-Pruefung ruft pruefe-testhaken.sh mit der Seite und dem Programm aus dem Paket', () => {
    const sh = code(`${REL}/pruefe-ios-ipa.sh`)
    expect(sh).toContain('if "$HIER/pruefe-testhaken.sh" "${LU_RELEASE_DIST:-$WURZEL/dist}" "$BIN"; then :; else FEHLER=$((FEHLER + 1)); fi')
    expect(sh).toMatch(/must not be published\."\n\s*exit 1/)
  })

  it('der Android-Bau endet mit Abbruch, wenn die Pruefung scheitert', () => {
    const checks = [...android.matchAll(/^\s*node "\$RELEASE_DIR\/pruefe-android-paket\.mjs"[^\n]*$/gm)].map((m) => m[0])
    expect(checks.length).toBe(2)
    for (const line of checks) expect(line).toMatch(/\|\| abbruch "the package failed its checks/)
    // Alte Pakete werden vor dem Bau geloescht, geprueft wird also dieser Lauf.
    expect(android.indexOf('rm -f "$APK"')).toBeGreaterThan(-1)
    expect(android.indexOf('rm -f "$APK"')).toBeLessThan(android.indexOf('android-bauen.sh"'))
  })

  for (const name of ENTRY) {
    it(`${name}: erst die Vorpruefung, dann der Bau mit Paketpruefung, dann erst das Ergebnis`, () => {
      const sh = code(`${REL}/${name}`)
      const gate = sh.indexOf('vorpruefung_abschliessen "')
      const check = sh.indexOf(PACKAGE_CHECK[name])
      const ready = sh.indexOf('echo "Ready for ')
      expect(gate).toBeGreaterThan(-1)
      expect(check).toBeGreaterThan(gate)
      expect(ready).toBeGreaterThan(check)
      expect(sh).toMatch(/^set -euo pipefail$/m)
      if (name === 'ios-appstore.sh') expect(sh).toMatch(/pruefe-ios-ipa\.sh"[^\n]*\|\| abbruch "the package failed its checks/)
    })
  }

  it('die Seite muss aus diesem Bau stammen, sonst gilt sie als ungeprueft', () => {
    for (const sh of [android, code(`${REL}/ios-appstore.sh`)]) {
      expect(sh).toMatch(/stat -f %m "\$WURZEL\/dist\/index\.html"[^\n]*-lt "\$\{?START\}?"|stat -f %m "\$WURZEL\/dist\/index\.html"[^\n]*-lt "\$start"/)
    }
  })
})

describe('C: der Upload ist nie Standard', () => {
  it('UPLOAD beginnt bei 0 und wird nur vom Argument --upload gesetzt', () => {
    expect(common).toMatch(/^UPLOAD=0$/m)
    const sets = [...common.matchAll(/UPLOAD=1/g)]
    expect(sets.length).toBe(1)
    expect(common).toMatch(/--upload\)\n\s*\[ -n "\$wort" \] \|\| abbruch [^\n]*\n\s*UPLOAD=1 ;;/)
    for (const name of ENTRY) expect(code(`${REL}/${name}`)).not.toMatch(/UPLOAD=1\b(?!")/)
  })

  it('--upload ohne das Bestaetigungswort bricht ab, bevor irgendetwas geprueft oder gebaut wird', () => {
    expect(common).toMatch(/if \[ "\$UPLOAD" = "1" \] && \[ "\$CONFIRM" != "\$wort" \]; then\n\s*abbruch/)
  })

  for (const name of ENTRY) {
    const word = UPLOAD_WORD[name]
    const command = UPLOAD_COMMAND[name]
    if (!word || !command) {
      it(`${name} kennt keinen Upload`, () => {
        const sh = code(`${REL}/${name}`)
        expect(sh).toMatch(/^argumente_lesen "" "\$@"$/m)
        expect(sh).not.toMatch(/fastlane|altool|supply|Transporter|notarytool|curl /)
      })
      continue
    }
    it(`${name}: der Upload-Befehl steht einmal da, hinter der Paketpruefung und nur im bestaetigten Zweig`, () => {
      const sh = code(`${REL}/${name}`)
      expect(sh).toContain(`WORT="${word}"`)
      const all = [...sh.matchAll(new RegExp(command.source, 'gm'))]
      expect(all.length).toBe(1)
      const at = all[0].index!
      expect(at).toBeGreaterThan(sh.indexOf(PACKAGE_CHECK[name]))
      // Der letzte `if [ "$UPLOAD" = "1" ]` vor dem Befehl ist noch offen: kein `else` und kein `fi` auf Spalte 0 dazwischen.
      const branch = sh.lastIndexOf('if [ "$UPLOAD" = "1" ]; then', at)
      expect(branch).toBeGreaterThan(-1)
      expect(sh.slice(branch, at)).not.toMatch(/^(else|fi)$/m)
    })
  }

  it('die Export-Vorlage exportiert und laedt nicht hoch', () => {
    const plist = read(`${REL}/ExportOptions.vorlage.plist`).replace(/<!--[\s\S]*?-->/g, '')
    expect(plist).toMatch(/<key>destination<\/key>\s*<string>export<\/string>/)
    expect(plist).not.toMatch(/<string>upload<\/string>/)
    expect(plist).toMatch(/<key>teamID<\/key>\s*<string>__TEAM_ID__<\/string>/)
    expect(plist).toMatch(/<key>manageAppVersionAndBuildNumber<\/key>\s*<false\/>/)
    // Und das Skript prueft es noch einmal an der gefuellten Kopie.
    expect(code(`${REL}/ios-appstore.sh`)).toContain(`[ "$($PB -c 'Print :destination' "$OPTIONEN")" = "export" ] || abbruch`)
  })

  it('kein Skript legt einen Zugang ab', () => {
    for (const name of [...ENTRY, '_gemeinsam.sh', '_android.sh']) {
      const sh = code(`${REL}/${name}`)
      expect(sh, name).not.toMatch(/store-credentials|--store-password-in-keychain|security (add|import|create-keychain)|keytool -genkey|\.netrc/)
      // Geschrieben wird nur in den Wegwerfordner, in den Bauordner, in die Ablage der fertigen Pakete
      // und in die Cargo-Konfiguration des iOS-Laufs (nur Bau-Flags, am Ende entfernt).
      for (const m of sh.matchAll(/\s>>?\s+(\S+)/g)) expect(m[1], `${name}: ${m[0]}`).toMatch(/^"?(\$ARBEIT\/|\$ABLAGE\/|\$PFADE_KONFIG\/config\.toml"$|\/dev\/null)/)
      // Kopiert wird kein Schluessel und keine Zugangsdatei. Die eine erlaubte .json ist der Baubeleg des Pakets.
      expect(sh, name).not.toMatch(/\btee\b|\bcp [^\n]*(\.p8|(?<!\.bau)\.json|key\.properties)/)
    }
  })
})

describe('D: der Probelauf (--probe) lockert nur die Meldeadresse und kann nie hochladen', () => {
  it('PROBE beginnt bei 0 und wird nur vom Argument --probe gesetzt', () => {
    expect(common).toMatch(/^PROBE=0$/m)
    expect([...common.matchAll(/\bPROBE=1\b/g)].length).toBe(1)
    expect(common).toMatch(/--probe\) PROBE=1 ;;/)
    for (const name of ENTRY) expect(code(`${REL}/${name}`)).not.toMatch(/\bPROBE=[01]\b/)
  })

  it('--probe mit --upload ist ein Abbruch beim Lesen der Argumente, vor jeder Pruefung', () => {
    expect(common).toMatch(/if \[ "\$PROBE" = "1" \] && \[ "\$UPLOAD" = "1" \]; then\n\s*abbruch "--probe and --upload exclude each other/)
    // Die Stelle steht in argumente_lesen, also vor umgebung_setzen und vor der Vorpruefung.
    const args = common.slice(common.indexOf('argumente_lesen() {'), common.indexOf('umgebung_setzen() {'))
    expect(args).toContain('--probe and --upload exclude each other')
  })

  it('die zweite Sperre steht direkt vor jedem Upload-Befehl', () => {
    expect(common).toMatch(/kein_upload_im_probelauf\(\) \{\n\s*if \[ "\$PROBE" != "0" \] \|\| \[ -n "\$\{LU_RELEASE_PROBE:-\}" \]; then\n\s*abbruch/)
    for (const name of ENTRY) {
      const command = UPLOAD_COMMAND[name]
      const sh = code(`${REL}/${name}`)
      if (!command) {
        expect(sh, name).not.toContain('kein_upload_im_probelauf')
        continue
      }
      // Zwischen der Sperre und dem ersten Befehl, der die Welt erreicht, steht nichts als Anzeige und Zuweisung.
      const lock = sh.lastIndexOf('kein_upload_im_probelauf', command.exec(sh)!.index)
      expect(lock, name).toBeGreaterThan(sh.lastIndexOf('if [ "$UPLOAD" = "1" ]; then', command.exec(sh)!.index))
      const firstNetwork = sh.slice(lock).search(/^\s*(fastlane|xcrun altool)\b/m)
      expect(sh.slice(lock, lock + firstNetwork)).not.toMatch(/^\s*(fastlane|xcrun|curl)\b/m)
      // Jeder Upload-Befehl des Skripts liegt hinter der Sperre.
      for (const m of sh.matchAll(/^\s*(fastlane supply|xcrun altool)\b/gm)) expect(m.index!, name).toBeGreaterThan(lock)
    }
  })

  it('der Probelauf setzt die Platzhalter-Adresse selbst, und nur fuer ein Store-Preset', () => {
    expect(common).toContain('PROBE_MELDEADRESSE="https://lu-release-probe.invalid/report"')
    const sets = [...common.matchAll(/export VITE_LU_REPORT_URL=/g)]
    expect(sets.length).toBe(1)
    const at = sets[0].index!
    // Im Zweig des Probelaufs, hinter dem Fall `open) ;;`.
    const branch = common.lastIndexOf('if [ "$PROBE" = "1" ]; then', at)
    expect(branch).toBeGreaterThan(-1)
    expect(common.slice(branch, at)).toMatch(/case "\$preset" in\n\s*open\) ;;/)
    // Der Zweig des Probelaufs ist an der Stelle noch offen (sein `fi` steht zwei Zeichen tief).
    expect(common.slice(branch, at)).not.toMatch(/^ {2}fi$/m)
  })

  it('ohne --probe ist dieselbe Adresse ein Platzhalter und damit ein Abbruch', () => {
    expect(common).toContain("*example.*|*.invalid|*.invalid/*|*.invalid:*|*localhost*|*127.0.0.1*|*'...'*|*'<'*)")
    expect(common).toMatch(/if \[ "\$PROBE" = "1" \] && \[ "\$VITE_LU_REPORT_URL" = "\$PROBE_MELDEADRESSE" \]; then\n\s*note "PROBE RUN[^\n]*\n\s*else\n\s*missing "VITE_LU_REPORT_URL is a placeholder/)
  })

  it('der Probelauf aendert sonst keine Pruefung: PROBE wird nur an den genannten Stellen gelesen', () => {
    // Gemeinsame Stelle: Argumente, Umgebung, Sperre, Hinweis und Adresse, Platzhalter, Ablage (Name, Datei, Aufraeumen, Hinweisdatei).
    expect([...common.matchAll(/"\$PROBE"/g)].length).toBe(9)
    // Android: der Schluessel, die Signatur, die Version, das Paket werden im Probelauf genauso geprueft.
    expect(android).not.toContain('PROBE')
    // Die Einstiege lesen es nur fuer die Ueberschrift des Ergebnisses und den Satz zum Upload.
    for (const name of ENTRY) {
      const reads = [...code(`${REL}/${name}`).matchAll(/"\$PROBE"/g)].length
      expect(reads, name).toBe(UPLOAD_WORD[name] ? 2 : 1)
    }
  })

  it('ein Probe-Paket sagt es im Baubeleg, und die Paketpruefungen lassen es nie als echtes durch', () => {
    expect(read('scripts/mobile/bau-beleg.sh')).toContain('...(e.LU_RELEASE_PROBE === "1" ? { probe: true } : {}),')
    expect(read('mobile-tests/checks/release.mjs')).toContain('probe: beleg.probe === true')
    const apk = read(`${REL}/pruefe-android-paket.mjs`)
    expect(apk).toContain("const PROBE = process.env.LU_RELEASE_PROBE === '1'")
    expect(apk).toContain("else pruefe(e.bau?.probe !== true, 'not a probe package', 'this package comes from a probe run (--probe)")
    expect(apk).toContain("if (PROBE) pruefe(e.bau?.probe === true, 'the build receipt says probe'")
    expect(apk).toContain('all checks passed, FOR A PROBE. This package must not be published')
    const ipa = code(`${REL}/pruefe-ios-ipa.sh`)
    expect(ipa).toContain('if [ "$BELEG_PROBE" = "1" ]; then fail "this package comes from a probe run (--probe)')
    // Die Variable kommt nur aus --probe: ohne das Argument loescht die gemeinsame Stelle sie.
    expect(common).toMatch(/^\s*unset LU_RELEASE_PROBE\n\s*if \[ "\$PROBE" = "1" \]; then export LU_RELEASE_PROBE=1; fi$/m)
  })
})

describe('Ablage: jedes Ziel legt sein Paket in einen eigenen Ordner ausserhalb des Bauordners', () => {
  const CALL: Record<string, string> = {
    'android-play.sh': 'paket_ablegen play android "$AAB" "$APK"',
    'android-offen.sh': 'paket_ablegen offen android "$APK"',
    'ios-appstore.sh': 'paket_ablegen appstore ios "$IPA"',
  }
  for (const name of ENTRY) {
    it(`${name} legt ab, nach der Paketpruefung und unter dem eigenen Zielnamen`, () => {
      const sh = code(`${REL}/${name}`)
      expect([...sh.matchAll(/^\s*paket_ablegen /gm)].length).toBe(1)
      expect(sh).toContain(CALL[name])
      expect(sh.indexOf(CALL[name])).toBeGreaterThan(sh.indexOf(PACKAGE_CHECK[name]))
      // Kein Skript nennt den Bauordner noch als Ergebnis.
      expect(sh).not.toMatch(/^\s*(ls -la|shasum -a 256) "\$(APK|AAB|IPA)"/m)
    })
  }

  it('die drei Zielnamen sind verschieden, der Ordner traegt Ziel, Version und Baunummer', () => {
    const names = Object.values(CALL).map((call) => call.split(' ')[1])
    expect(new Set(names).size).toBe(3)
    expect(common).toContain('name="$ziel-$ERWARTETE_VERSION-$code"')
    expect(common).toContain('ABLAGE_WURZEL="${LU_RELEASE_PAKETE:-$(dirname "$WURZEL")/release-pakete}"')
  })
})

describe('Version: version-setzen.sh findet jede Stelle der Handy-Version', () => {
  const FILES = [
    'src-tauri/tauri.android.conf.json',
    'src-tauri/tauri.ios.conf.json',
    'src-tauri/gen/apple/project.yml',
    'src-tauri/gen/apple/locally-uncensored_iOS/Info.plist',
  ]
  const DESKTOP = ['src-tauri/tauri.conf.json', 'package.json', 'src-tauri/Cargo.toml']
  const node = (args: string[]) => spawnSync(process.execPath, [join(root, REL, 'handy-version.mjs'), ...args], { encoding: 'utf8' })
  const temps: string[] = []
  afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  // Die Tests setzen nie eine feste Nummer: sie nehmen die naechste nach der, die das Repo
  // heute traegt. Eine feste 3.0.7 waere am Tag, an dem das Repo sie traegt, "unchanged".
  const [CURRENT] = node(['zeige']).stdout.trim().split(' ')
  // Auf einem Vorab-Zweig traegt das Repo X.Y.Z-preN: gezaehlt wird vom Kern.
  const bump = (version: string, by: number) => {
    const [major, minor, patch] = version.replace(/-pre\d+$/, '').split('.').map(Number)
    return `${major}.${minor}.${patch + by}`
  }
  const codeOf = (version: string, build: number) => {
    const [major, minor, patch] = version.split('.').map(Number)
    return major * 10_000_000 + minor * 100_000 + patch * 1_000 + build
  }
  const NEXT = bump(CURRENT, 1)
  const AFTER_NEXT = bump(CURRENT, 2)
  const NEXT_CODE = codeOf(NEXT, 1)

  function copyOfTheTree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lu-version-'))
    temps.push(dir)
    for (const rel of [...FILES, ...DESKTOP]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      cpSync(join(root, rel), join(dir, rel))
    }
    return dir
  }

  it('nennt genau die vier Dateien', () => {
    const out = node(['dateien'])
    expect(out.status).toBe(0)
    expect(out.stdout.trim().split('\n').sort()).toEqual([...FILES].sort())
  })

  it('die heutige Baunummer steht in keiner verfolgten Datei, die das Skript nicht kennt', () => {
    const [, current] = node(['zeige']).stdout.trim().split(' ')
    expect(current).toMatch(/^\d{8,10}$/)
    const grep = spawnSync('git', ['grep', '-n', '-F', current, '--', '.', ':!*.md', ':!mobile-docs', ':!mobile-tests/trocken'], { cwd: root, encoding: 'utf8' })
    const lines = grep.stdout.split('\n').filter(Boolean).map((line) => {
      const [, file, text] = /^([^:]+):\d+:(.*)$/.exec(line)!
      return { file, text }
    })
    const hits = [...new Set(lines.map((l) => l.file))]
    // Eine Zahl in einer Kommentarzeile ist ein Rechenbeispiel (die Koepfe der Skripte nennen
    // "3.0.7 mit Bau 1 ergibt 30007001"), sie traegt keine Version. Ausserhalb von Kommentaren
    // darf die Zahl nur in den vier Dateien stehen, und in drei Tests, die sie als Eingabe
    // oder als erwartete Ausgabe eines Skripts nennen.
    const tests = new Set(['src/lib/__tests__/mobile-ios-geraetebau.test.ts', 'src/lib/__tests__/mobile-release-skripte.test.ts', 'src/lib/__tests__/ios-nur-iphone.test.ts'])
    const carried = lines.filter((l) => !/^\s*(#|\/\/|\*)/.test(l.text) && !tests.has(l.file))
    expect([...new Set(carried.map((l) => l.file))].filter((file) => !FILES.includes(file))).toEqual([])
    for (const file of FILES) expect(hits, file).toContain(file)
  })

  it('die heutigen Dateien sind in sich stimmig', () => {
    const out = node(['pruefe'])
    expect(out.stdout.trim(), out.stdout).toBe('')
    expect(out.status).toBe(0)
  })

  it('der Trockenlauf nennt alle vier Dateien und schreibt nichts', () => {
    const dir = copyOfTheTree()
    const before = FILES.map((rel) => readFileSync(join(dir, rel), 'utf8'))
    const out = node(['setze', NEXT, String(NEXT_CODE), '--dry-run', '--wurzel', dir])
    expect(out.status, out.stderr).toBe(0)
    for (const rel of FILES) expect(out.stdout).toContain(`would change  ${rel}`)
    expect(out.stdout).toContain('dry run: 4 of 4 files would change, nothing was written')
    expect(FILES.map((rel) => readFileSync(join(dir, rel), 'utf8'))).toEqual(before)
  })

  it('setzt die naechste Version an allen Stellen, laesst den Desktop in Ruhe, und die Pruefung ist danach still', () => {
    const dir = copyOfTheTree()
    const [oldVersion, oldCode] = node(['zeige', '--wurzel', dir]).stdout.trim().split(' ')
    const desktopBefore = DESKTOP.map((rel) => readFileSync(join(dir, rel), 'utf8'))
    const out = node(['setze', NEXT, String(NEXT_CODE), '--wurzel', dir])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('4 of 4 files changed')

    const androidConf = JSON.parse(readFileSync(join(dir, FILES[0]), 'utf8'))
    const iosConf = JSON.parse(readFileSync(join(dir, FILES[1]), 'utf8'))
    expect(androidConf.version).toBe(NEXT)
    expect(androidConf.bundle.android.versionCode).toBe(NEXT_CODE)
    expect(iosConf.version).toBe(NEXT)
    expect(iosConf.bundle.iOS.bundleVersion).toBe(String(NEXT_CODE))
    const yml = readFileSync(join(dir, FILES[2]), 'utf8')
    expect(yml).toContain(`CFBundleShortVersionString: ${NEXT}`)
    expect(yml).toContain(`CFBundleVersion: "${NEXT_CODE}"`)
    const plist = readFileSync(join(dir, FILES[3]), 'utf8')
    expect(plist).toMatch(new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${NEXT.replace(/\./g, '\\.')}</string>`))
    expect(plist).toMatch(new RegExp(`<key>CFBundleVersion</key>\\s*<string>${NEXT_CODE}</string>`))
    // Nichts vom alten Stand bleibt in den vier Dateien zurueck.
    for (const rel of FILES) {
      const text = readFileSync(join(dir, rel), 'utf8')
      expect(text, rel).not.toContain(oldCode)
      expect(text, rel).not.toMatch(new RegExp(`(version"?: "?|VersionString: |<string>)${oldVersion.replace(/\./g, '\\.')}\\b`))
    }
    // Sonst aendert sich an den Konfigurationen nichts.
    const { version: _a, ...androidRest } = androidConf
    const androidWas = JSON.parse(read(FILES[0]))
    androidRest.bundle.android.versionCode = androidWas.bundle.android.versionCode
    const { version: _b, ...androidWasRest } = androidWas
    expect(androidRest).toEqual(androidWasRest)
    // Der Desktop ist Byte fuer Byte derselbe.
    expect(DESKTOP.map((rel) => readFileSync(join(dir, rel), 'utf8'))).toEqual(desktopBefore)

    // Die Pruefung ist still, auch wenn der Desktop bei seiner Version bleibt: die Handy-App
    // zeigt die Version ihres Pakets (src/dev/phone-version.ts), package.json wird nicht verglichen.
    const check = node(['pruefe', '--erwartet', NEXT, '--wurzel', dir])
    expect(check.stdout.trim(), check.stdout).toBe('')
    expect(check.status).toBe(0)
    // Auch wenn der Desktop eine ganz andere Version traegt (am 26.10. waren beide 3.0.8,
    // darum hier ausdruecklich eine fremde): die Pruefung bleibt still.
    const pkg = join(dir, 'package.json')
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'))
    const other = node(['pruefe', '--erwartet', NEXT, '--wurzel', dir])
    expect(other.stdout.trim(), other.stdout).toBe('')
    expect(other.status).toBe(0)
    // Eine andere erwartete Version ist weiter ein Fund.
    const wrong = node(['pruefe', '--erwartet', '1.2.3', '--wurzel', dir])
    expect(wrong.status).toBe(1)
    expect(wrong.stdout).toContain(`the phone packages carry version ${NEXT}, expected 1.2.3`)

    // Dieselbe Version noch einmal: die Baunummer zaehlt hoch, zurueck geht es nicht.
    expect(node(['setze', NEXT, String(NEXT_CODE + 1), '--wurzel', dir]).status).toBe(0)
    const back = node(['setze', NEXT, String(NEXT_CODE), '--wurzel', dir])
    expect(back.status).toBe(2)
    expect(back.stderr).toContain('counts up')
    // Ein Code, der nicht zur Version gehoert, wird abgelehnt.
    expect(node(['setze', AFTER_NEXT, String(NEXT_CODE + 2), '--wurzel', dir]).status).toBe(2)
  })

  it('die Release-Skripte verlangen nicht mehr dieselbe Version in package.json, sondern die Bau-Konstante', () => {
    // Vorher: Abbruch, solange package.json eine andere Version trug als das Handy-Paket.
    expect(read(`${REL}/handy-version.mjs`)).not.toMatch(/package\.json carries version/)
    // Jetzt, vor dem Bau: die Seite About liest die Version des Pakets, und der Handy-Bau bekommt sie.
    expect(common).toContain(`grep -q "typeof __LU_PHONE_VERSION__ === 'string'" "$WURZEL/src/mobile/screens/settings/parts/app-info.ts"`)
    expect(common).toContain(`grep -q 'define: PHONE_DEFINE' "$WURZEL/vite.config.ts"`)
    expect(common).toMatch(/missing "the About page does not read the version of the phone package/)
    // Und nach dem Bau: die gebaute Seite nennt genau die Version des Pakets, sonst Abbruch.
    expect(android).toMatch(/^\s*seite_traegt_version "\$version"$/m)
    expect(android.indexOf('seite_traegt_version "$version"')).toBeLessThan(android.indexOf('node "$RELEASE_DIR/pruefe-android-paket.mjs"'))
    const ios = code(`${REL}/ios-appstore.sh`)
    expect(ios).toMatch(/^seite_traegt_version "\$VERSION"$/m)
    expect(ios.indexOf('seite_traegt_version "$VERSION"')).toBeLessThan(ios.indexOf(PACKAGE_CHECK['ios-appstore.sh']))
    // Die zwei Stellen, nach denen die Vorpruefung sucht, gibt es wirklich.
    expect(read('src/mobile/screens/settings/parts/app-info.ts')).toContain("typeof __LU_PHONE_VERSION__ === 'string'")
    expect(read('vite.config.ts')).toContain('define: PHONE_DEFINE')
  })

  it('die Pruefungen der Pakete lesen die Version des Handy-Pakets, nicht fest die des Desktops', () => {
    expect(read('scripts/mobile/ios/pruefe-paket.sh')).toContain('scripts/mobile/release/handy-version.mjs" zeige ios')
    expect(read('mobile-tests/checks/release.mjs')).toContain("projektVersion(PROJEKT, 'android')")
    expect(read('mobile-tests/checks/release.mjs')).toContain("projektVersion(PROJEKT, 'ios')")
  })
})

// ── Ab hier werden die Skripte gestartet. Nur auf dem Mac, nichts wird gebaut. ──
const onMac = process.platform === 'darwin'

describe.skipIf(!onMac)('die Skripte im Lauf (nur macOS, Trockenlauf und Attrappen)', () => {
  /** Ohne alles, was auf dem Rechner eines Entwicklers gesetzt sein koennte. */
  const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^(LU_|VITE_LU_|APPLE_|IOS_CERTIFICATE|IOS_MOBILE_PROVISION|API_PRIVATE_KEYS_DIR)/.test(key)) delete env[key]
    }
    return { ...env, ...extra }
  }
  const run = (name: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('/bin/bash', [join(root, REL, name), ...args], { encoding: 'utf8', env: cleanEnv(env), timeout: 60_000 })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const temps: string[] = []
  afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'lu-release-'))
    temps.push(dir)
    return dir
  }
  /** Die Ausgabeordner der Pakete: kein Lauf hier darf dort etwas anlegen. */
  const outputs = ['src-tauri/gen/android/app/build/outputs/bundle', 'src-tauri/gen/apple/build/release-appstore']
  const stamp = () => outputs.map((rel) => (existsSync(join(root, rel)) ? statSync(join(root, rel)).mtimeMs : null))

  it('alle Skripte sind ausfuehrbar und gueltiges bash', () => {
    for (const name of [...ENTRY, 'version-setzen.sh', 'pruefe-testhaken.sh', 'pruefe-ios-ipa.sh', '_gemeinsam.sh', '_android.sh']) {
      expect(spawnSync('/bin/bash', ['-n', join(root, REL, name)]).status, name).toBe(0)
      if (!name.startsWith('_')) expect(statSync(join(root, REL, name)).mode & 0o100, name).toBeTruthy()
    }
  })

  for (const name of ENTRY) {
    it(`${name} lehnt ein Feature oder eine Bauart als Argument ab`, () => {
      for (const args of [['abnahme'], ['release', 'abnahme'], ['--features', 'abnahme'], ['debug']]) {
        const r = run(name, args)
        expect(r.status, args.join(' ')).toBe(2)
        expect(r.out).toContain('unknown argument')
        expect(r.out).not.toContain('Preconditions')
      }
    })

    it(`${name} --dry-run baut nichts, sagt was fehlt, und der Upload ist aus`, () => {
      const before = stamp()
      const r = run(name, ['--version', '3.0.7', '--dry-run'], { VITE_LU_ABNAHME: '1' })
      expect([0, 1], r.out).toContain(r.status)
      expect(r.out).toContain('DRY RUN: nothing was built, nothing was uploaded.')
      expect(r.out).toContain('VITE_LU_ABNAHME was set in this shell. It is removed')
      expect(r.out).toMatch(UPLOAD_WORD[name] ? /upload: off \(default\)/ : /upload: none/)
      // Die Handy-Version haengt nicht mehr an package.json.
      expect(r.out).toContain('ok       the About page shows the version of the phone package')
      expect(r.out).not.toContain('package.json carries version')
      expect(r.out).not.toMatch(/npx tauri|fastlane supply|altool --upload/)
      // Ohne Schluessel und ohne Team in der Umgebung fehlt immer etwas.
      expect(r.status).toBe(1)
      expect(r.out).toMatch(name === 'ios-appstore.sh' ? /MISSING {2}Apple team: APPLE_DEVELOPMENT_TEAM is not set/ : /MISSING {2}signing key: LU_ANDROID_KEY_PROPERTIES is not set/)
      if (name !== 'android-offen.sh') expect(r.out).toMatch(/MISSING {2}VITE_LU_REPORT_URL is not set to an https address/)
      expect(stamp()).toEqual(before)
    })

    it(`${name} ohne --dry-run bricht bei Luecken ab, bevor gebaut wird`, () => {
      const before = stamp()
      const r = run(name, ['--version', '3.0.7'])
      expect(r.status).toBe(2)
      expect(r.out).toContain('ABORT: nothing was built.')
      expect(r.out).not.toMatch(/\[bauen\]|\[appstore\]|npx tauri/)
      expect(stamp()).toEqual(before)
    })
  }

  it('--upload ohne oder mit falschem Bestaetigungswort endet sofort', () => {
    for (const name of ['android-play.sh', 'ios-appstore.sh']) {
      for (const args of [['--upload'], ['--upload', '--confirm', 'yes'], ['--upload', '--confirm', 'upload-to-play'], ['--confirm', UPLOAD_WORD[name]!]]) {
        const r = run(name, ['--version', '3.0.7', ...args])
        expect(r.status, `${name} ${args.join(' ')}`).toBe(2)
        expect(r.out).toContain(UPLOAD_WORD[name]!)
        expect(r.out).not.toContain('Preconditions')
      }
    }
    const open = run('android-offen.sh', ['--upload', '--confirm', 'UPLOAD-TO-PLAY'])
    expect(open.status).toBe(2)
    expect(open.out).toContain('this target has no upload step')
  })

  const JDK = process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin/keytool')) ? join(process.env.JAVA_HOME, 'bin') : existsSync('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin/keytool') ? '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin' : null
  it.skipIf(!JDK)('keytool: mit den zwei Schaltern steht "Owner:" da, in einer anderen Sprache nicht', () => {
    // Ein frisch signiertes Archiv, damit die Pruefung an einer echten Ausgabe von keytool haengt.
    const dir = temp()
    const secret = `t${Math.random().toString(36).slice(2)}${Date.now()}`
    const env = { ...cleanEnv(), LU_TEST_STOREPASS: secret }
    const store = join(dir, 'test.p12')
    const jar = join(dir, 'test.jar')
    writeFileSync(join(dir, 'a.txt'), 'a')
    expect(spawnSync('zip', ['-q', '-j', jar, join(dir, 'a.txt')]).status).toBe(0)
    const gen = spawnSync(join(JDK!, 'keytool'), ['-genkeypair', '-keystore', store, '-storetype', 'PKCS12', '-alias', 't', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1', '-dname', 'CN=LU Test', '-storepass:env', 'LU_TEST_STOREPASS', '-keypass:env', 'LU_TEST_STOREPASS'], { encoding: 'utf8', env })
    expect(gen.status, gen.stderr).toBe(0)
    const sign = spawnSync(join(JDK!, 'jarsigner'), ['-keystore', store, '-storepass:env', 'LU_TEST_STOREPASS', jar, 't'], { encoding: 'utf8', env })
    expect(sign.status, sign.stderr).toBe(0)
    const print = (flags: string[]) => spawnSync(join(JDK!, 'keytool'), [...flags, '-printcert', '-jarfile', jar], { encoding: 'utf8', env: cleanEnv() }).stdout
    expect(print(['-J-Duser.language=en', '-J-Duser.country=US'])).toMatch(/^Owner: CN=LU Test$/m)
    expect(print(['-J-Duser.language=de', '-J-Duser.country=DE'])).not.toMatch(/^Owner: /m)
    const verify = spawnSync(join(JDK!, 'jarsigner'), ['-J-Duser.language=en', '-J-Duser.country=US', '-verify', jar], { encoding: 'utf8', env: cleanEnv() })
    expect(verify.stdout).toMatch(/^jar verified\./m)
  })

  describe('--probe im Lauf', () => {
    it('mit --probe ist --upload unmoeglich, in jeder Reihenfolge, mit und ohne --dry-run', () => {
      for (const name of ['android-play.sh', 'ios-appstore.sh']) {
        const word = UPLOAD_WORD[name]!
        for (const args of [
          ['--probe', '--upload', '--confirm', word],
          ['--upload', '--confirm', word, '--probe'],
          ['--upload', '--probe', '--confirm', word],
          ['--probe', '--upload', '--confirm', word, '--dry-run'],
        ]) {
          const r = run(name, ['--version', '3.0.7', ...args])
          expect(r.status, `${name} ${args.join(' ')}`).toBe(2)
          expect(r.out).toContain('--probe and --upload exclude each other')
          expect(r.out).not.toContain('Preconditions')
          expect(r.out).not.toMatch(/npx tauri|fastlane supply|altool/)
        }
        // Auch ohne das Wort bleibt es ein Abbruch.
        expect(run(name, ['--version', '3.0.7', '--probe', '--upload']).status).toBe(2)
      }
      expect(run('android-offen.sh', ['--version', '3.0.7', '--probe', '--upload']).status).toBe(2)
    })

    it('die Sperre vor dem Upload greift auch, wenn nur die Variable gesetzt ist', () => {
      const lock = (setup: string) => spawnSync('/bin/bash', ['-c', `set -euo pipefail\nsource "${join(root, REL, '_gemeinsam.sh')}"\n${setup}\nkein_upload_im_probelauf\necho PASSED\n`], { encoding: 'utf8', env: cleanEnv() })
      expect(lock('').stdout).toContain('PASSED')
      for (const setup of ['PROBE=1', 'export LU_RELEASE_PROBE=1', 'PROBE=1; UPLOAD=1']) {
        const r = lock(setup)
        expect(r.status, setup).toBe(2)
        expect(r.stderr).toContain('A probe package is never uploaded')
        expect(r.stdout).not.toContain('PASSED')
      }
    })

    for (const name of ['android-play.sh', 'ios-appstore.sh']) {
      it(`${name} --probe --dry-run: die Meldeadresse fehlt nicht mehr, alles andere fehlt wie zuvor`, () => {
        const r = run(name, ['--version', '3.0.7', '--probe', '--dry-run'], { VITE_LU_REPORT_URL: 'https://reports.lu-labs.example.org/real' })
        expect(r.status, r.out).toBe(1)
        expect(r.out).toContain('PROBE RUN: the package is named PROBE')
        expect(r.out).toContain('PROBE RUN: VITE_LU_REPORT_URL from this shell is not used.')
        expect(r.out).toMatch(/note {5}PROBE RUN: preset (play|appstore) is built with the placeholder https:\/\/lu-release-probe\.invalid\/report/)
        expect(r.out).not.toMatch(/MISSING {2}VITE_LU_REPORT_URL/)
        // Schluessel und Team verlangt der Probelauf wie jeder andere.
        expect(r.out).toMatch(name === 'ios-appstore.sh' ? /MISSING {2}Apple team: APPLE_DEVELOPMENT_TEAM is not set/ : /MISSING {2}signing key: LU_ANDROID_KEY_PROPERTIES is not set/)
        expect(r.out).not.toMatch(/npx tauri|\[bauen\]|\[appstore\]/)
      })

      it(`${name} ohne --probe: die Adresse des Probelaufs ist ein Platzhalter und fehlt`, () => {
        for (const url of ['https://lu-release-probe.invalid/report', 'https://anything.invalid', 'https://reports.example.com/x']) {
          const r = run(name, ['--version', '3.0.7', '--dry-run'], { VITE_LU_REPORT_URL: url })
          expect(r.out, url).toMatch(/MISSING {2}VITE_LU_REPORT_URL is a placeholder/)
        }
      })
    }

    it('eine echte Adresse besteht ohne --probe wie zuvor', () => {
      const r = run('android-play.sh', ['--version', '3.0.7', '--dry-run'], { VITE_LU_REPORT_URL: 'https://lu-labs.ai/api/report' })
      expect(r.out).toContain('ok       preset play, report service address is set (https)')
    })

    it('android-offen.sh --probe --dry-run setzt keine Meldeadresse: der offene Bau braucht keine', () => {
      const r = run('android-offen.sh', ['--version', '3.0.7', '--probe', '--dry-run'])
      expect(r.out).toContain('PROBE RUN: the package is named PROBE')
      expect(r.out).toContain('VITE_LU_REPORT_URL is not set: content reports stay in a queue on the phone')
      expect(r.out).not.toContain('lu-release-probe.invalid')
    })

    it('ein Wegwerf-Schluessel bleibt auch im Probelauf abgelehnt', () => {
      const dir = join(temp(), 'wegwerf')
      mkdirSync(dir)
      writeFileSync(join(dir, 'lu-wegwerf.jks'), '')
      writeFileSync(join(dir, 'key.properties'), keyProperties(join(dir, 'lu-wegwerf.jks'), 'lu-wegwerf', { store: 'placeholder', key: 'placeholder' }))
      const r = run('android-play.sh', ['--version', '3.0.7', '--probe', '--dry-run'], { LU_ANDROID_KEY_PROPERTIES: join(dir, 'key.properties') })
      expect(r.out).toMatch(/MISSING {2}throwaway signature/)
    })

    it('die Ablage eines Probelaufs: Ordner und Dateien heissen PROBE, der Hinweis liegt dabei, der Bauordner ist leer', () => {
      const ablage = temp()
      const build = temp()
      const apk = join(build, 'app-universal-release.apk')
      writeFileSync(apk, 'probe-apk')
      writeFileSync(`${apk}.bau.json`, JSON.stringify({ art: 'release', preset: 'play', probe: true }))
      const script = `set -euo pipefail\nsource "${join(root, REL, '_gemeinsam.sh')}"\nERWARTETE_VERSION="3.0.7"\nPROBE=1\npaket_ablegen play android "${apk}"\necho "ABLAGE=$ABLAGE"\n`
      const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: cleanEnv({ LU_RELEASE_PAKETE: ablage }) })
      expect(r.status, r.stderr).toBe(0)
      const dir = /^ABLAGE=(.*)$/m.exec(r.stdout)![1]
      const [, buildCode] = spawnSync(process.execPath, [join(root, REL, 'handy-version.mjs'), 'zeige', 'android'], { encoding: 'utf8' }).stdout.trim().split(' ')
      expect(dir).toBe(join(ablage, `PROBE-play-3.0.7-${buildCode}`))
      expect(readdirSync(dir).sort()).toEqual([`PROBE-play-3.0.7-${buildCode}.apk`, `PROBE-play-3.0.7-${buildCode}.apk.bau.json`, 'PROBE-NICHT-VEROEFFENTLICHEN.txt', 'SHA256SUMS'].sort())
      expect(readFileSync(join(dir, 'PROBE-NICHT-VEROEFFENTLICHEN.txt'), 'utf8')).toContain('NOT FOR PUBLICATION')
      // In der Summenliste steht nur das Paket.
      expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').length).toBe(1)
      // Unter dem Namen eines echten Pakets bleibt im Bauordner nichts liegen.
      expect(readdirSync(build)).toEqual([])
      // Und kein Ordner ohne PROBE im Namen ist entstanden.
      expect(readdirSync(ablage)).toEqual([`PROBE-play-3.0.7-${buildCode}`])
    })
  })

  it('--upload mit dem Wort, aber ohne Zugangsdaten: der Trockenlauf nennt sie als fehlend', () => {
    const play = run('android-play.sh', ['--version', '3.0.7', '--dry-run', '--upload', '--confirm', 'UPLOAD-TO-PLAY'])
    expect(play.status).toBe(1)
    expect(play.out).toMatch(/MISSING {2}upload: LU_PLAY_SERVICE_ACCOUNT_JSON is not set/)
    const ios = run('ios-appstore.sh', ['--version', '3.0.7', '--dry-run', '--upload', '--confirm', 'UPLOAD-TO-APP-STORE'])
    expect(ios.status).toBe(1)
    for (const key of ['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']) expect(ios.out).toMatch(new RegExp(`MISSING {2}upload: ${key} is not set`))
  })

  it('der Wegwerf-Schluessel wird schon vor dem Bau erkannt', () => {
    const dir = join(temp(), 'wegwerf')
    mkdirSync(dir)
    writeFileSync(join(dir, 'lu-wegwerf.jks'), '')
    writeFileSync(join(dir, 'key.properties'), keyProperties(join(dir, 'lu-wegwerf.jks'), 'lu-wegwerf', { store: 'placeholder', key: 'placeholder' }))
    const r = run('android-play.sh', ['--version', '3.0.7', '--dry-run'], { LU_ANDROID_KEY_PROPERTIES: join(dir, 'key.properties') })
    expect(r.out).toMatch(/MISSING {2}throwaway signature/)
    expect(r.out).not.toContain('placeholder')
  })

  it('eine key.properties mit Luecken nennt die Felder, nie einen Wert', () => {
    const dir = temp()
    writeFileSync(join(dir, 'key.properties'), keyProperties('/nowhere/real.jks', 'release', { store: 'do-not-print-me' }))
    const r = run('android-offen.sh', ['--version', '3.0.7', '--dry-run'], { LU_ANDROID_KEY_PROPERTIES: join(dir, 'key.properties') })
    expect(r.out).toMatch(/MISSING {2}signing key: key\.properties has no value for keyPassword/)
    expect(r.out).not.toContain('do-not-print-me')
  })

  describe('paket_ablegen (die gemeinsame Stelle, mit Attrappen statt Paketen)', () => {
    /** Ruft paket_ablegen so, wie ein Release-Skript es nach dem Bau tut. */
    const ablegen = (ablage: string, ziel: string, files: string[], version = '3.0.7') => {
      const script = `set -euo pipefail\nsource "${join(root, REL, '_gemeinsam.sh')}"\nERWARTETE_VERSION="${version}"\npaket_ablegen ${ziel} android ${files.map((f) => `"${f}"`).join(' ')}\necho "ABLAGE=$ABLAGE"\n`
      const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: cleanEnv({ LU_RELEASE_PAKETE: ablage }) })
      return { status: r.status, out: `${r.stdout}${r.stderr}`, dir: /^ABLAGE=(.*)$/m.exec(r.stdout)?.[1] ?? '' }
    }
    const fakeBuild = (content: string) => {
      const dir = temp()
      const apk = join(dir, 'app-universal-release.apk')
      writeFileSync(apk, content)
      writeFileSync(`${apk}.bau.json`, JSON.stringify({ art: 'release', preset: content }))
      return apk
    }
    const buildCode = spawnSync(process.execPath, [join(root, REL, 'handy-version.mjs'), 'zeige', 'android'], { encoding: 'utf8' }).stdout.trim().split(' ')[1]
    const sha = (file: string) => spawnSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).stdout.split(' ')[0]

    it('Play und offen landen in zwei Ordnern, auch wenn der Bau beide an denselben Ort schreibt', () => {
      const ablage = temp()
      // Derselbe Pfad im Bauordner, erst der eine Bau, dann der andere: wie in Wirklichkeit.
      const apk = fakeBuild('play')
      const play = ablegen(ablage, 'play', [apk])
      expect(play.status, play.out).toBe(0)
      writeFileSync(apk, 'open')
      writeFileSync(`${apk}.bau.json`, JSON.stringify({ art: 'release', preset: 'open' }))
      const offen = ablegen(ablage, 'offen', [apk])
      expect(offen.status, offen.out).toBe(0)

      expect(play.dir).toBe(join(ablage, `play-3.0.7-${buildCode}`))
      expect(offen.dir).toBe(join(ablage, `offen-3.0.7-${buildCode}`))
      expect(readFileSync(join(play.dir, `LU-play-3.0.7-${buildCode}.apk`), 'utf8')).toBe('play')
      expect(readFileSync(join(offen.dir, `LU-offen-3.0.7-${buildCode}.apk`), 'utf8')).toBe('open')
      // Der Baubeleg reist mit, und die Summe stimmt mit der Datei ueberein.
      expect(JSON.parse(readFileSync(join(play.dir, `LU-play-3.0.7-${buildCode}.apk.bau.json`), 'utf8')).preset).toBe('play')
      const sums = readFileSync(join(offen.dir, 'SHA256SUMS'), 'utf8').trim().split('\n')
      expect(sums).toEqual([`${sha(join(offen.dir, `LU-offen-3.0.7-${buildCode}.apk`))}  LU-offen-3.0.7-${buildCode}.apk`])
      // Das Skript nennt den Ordner und die Summe.
      expect(offen.out).toContain(offen.dir)
      expect(offen.out).toContain(sums[0])
    })

    it('derselbe Bau noch einmal ueberschreibt nichts: der alte Ordner steht daneben', () => {
      const ablage = temp()
      const first = ablegen(ablage, 'play', [fakeBuild('first')])
      const second = ablegen(ablage, 'play', [fakeBuild('second')])
      expect(second.status, second.out).toBe(0)
      expect(second.dir).toBe(first.dir)
      expect(readFileSync(join(second.dir, `LU-play-3.0.7-${buildCode}.apk`), 'utf8')).toBe('second')
      const aside = readdirSync(ablage).filter((n) => n.startsWith(`play-3.0.7-${buildCode}.frueher-`))
      expect(aside.length).toBe(1)
      expect(readFileSync(join(ablage, aside[0], `LU-play-3.0.7-${buildCode}.apk`), 'utf8')).toBe('first')
    })

    it('eine Ablage in einem Git-Arbeitsbaum wird abgelehnt, ein fehlendes Paket auch', () => {
      const inside = ablegen(join(root, 'dist-ablage-test-gibt-es-nicht'), 'play', [fakeBuild('x')])
      rmSync(join(root, 'dist-ablage-test-gibt-es-nicht'), { recursive: true, force: true })
      expect(inside.status).toBe(2)
      expect(inside.out).toContain('lies inside a git working tree')
      const missing = ablegen(temp(), 'play', [join(temp(), 'nothing.apk')])
      expect(missing.status).toBe(2)
      expect(missing.out).toContain('does not exist')
    })
  })

  describe('seite_traegt_version (die gebaute Seite gegen das Paket)', () => {
    const check = (html: string | null, version: string) => {
      const dir = temp()
      if (html !== null) {
        mkdirSync(join(dir, 'dist'))
        writeFileSync(join(dir, 'dist/index.html'), html)
      }
      const script = `set -euo pipefail\nsource "${join(root, REL, '_gemeinsam.sh')}"\nWURZEL="${dir}"\nseite_traegt_version "${version}"\n`
      const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', env: cleanEnv() })
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    }
    const page = (version: string) => `<!doctype html><html><head><meta name="lu-phone-version" content="${version}"><title>LU</title></head></html>`

    it('dieselbe Version besteht', () => {
      const r = check(page('3.0.7'), '3.0.7')
      expect(r.status, r.out).toBe(0)
      expect(r.out).toContain('the built page carries version 3.0.7')
    })

    it('eine andere Version, eine Seite ohne Angabe (Desktop-Bau) und eine fehlende Seite sind ein Abbruch', () => {
      const other = check(page('3.0.5'), '3.0.7')
      expect(other.status).toBe(2)
      expect(other.out).toContain("dist/index.html says '3.0.5', the package is 3.0.7")
      const none = check('<!doctype html><html><head><title>LU</title></head></html>', '3.0.7')
      expect(none.status).toBe(2)
      expect(none.out).toContain("says 'nothing'")
      expect(check(null, '3.0.7').status).toBe(2)
    })

    it('die Angabe in der Seite ist die, die der Bau schreibt', async () => {
      const { withPhoneVersionMeta } = await import('../../dev/phone-version')
      expect(check(withPhoneVersionMeta('<!doctype html><html><head></head></html>', '3.0.7'), '3.0.7').status).toBe(0)
    })
  })

  describe('pruefe-testhaken.sh', () => {
    const page = (withHook: boolean) => {
      const dir = temp()
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>')
      writeFileSync(join(dir, 'assets/app.js'), withHook ? 'window.__LU_TEST__={preset(){}}' : 'console.log("LU")')
      return dir
    }
    const binary = (marker: string | null) => {
      const file = join(temp(), 'liblocally_uncensored_lib.so')
      writeFileSync(file, Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(`some text ${marker ?? 'nothing special'} more text`), Buffer.from([0, 0])]))
      return file
    }

    it('eine saubere Seite und ein sauberes Programm bestehen', () => {
      const r = run('pruefe-testhaken.sh', [page(false), binary(null)])
      expect(r.status, r.out).toBe(0)
    })

    it('der Testhaken in der Seite ist ein Fund', () => {
      const r = run('pruefe-testhaken.sh', [page(true), binary(null)])
      expect(r.status).toBe(1)
      expect(r.out).toContain('the test hook __LU_TEST__ is in the built page')
    })

    for (const marker of ['setWebContentsDebuggingEnabled', 'developerExtrasEnabled', 'setInspectable', '__LU_TEST__']) {
      it(`${marker} im Programm ist ein Fund`, () => {
        const r = run('pruefe-testhaken.sh', [page(false), binary(marker)])
        expect(r.status).toBe(1)
        expect(r.out).toContain(`'${marker}' is in liblocally_uncensored_lib.so`)
      })
    }

    it('ohne gebaute Seite gilt nichts als geprueft', () => {
      expect(run('pruefe-testhaken.sh', [temp()]).status).toBe(1)
      expect(run('pruefe-testhaken.sh', []).status).toBe(2)
    })
  })

  it('version-setzen.sh rechnet die Baunummer aus und schreibt im Trockenlauf nichts', () => {
    // The version the phone files carry (3.0.10 since the APK on that
    // release): a lower one is refused on purpose, a store only counts up.
    const r = run('version-setzen.sh', ['3.0.10', '1', '--dry-run'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('version 3.0.10, build 1, code 30010001')
    expect(r.out).toContain('nothing was written')
    expect(run('version-setzen.sh', ['3.0.10']).status).toBe(2)
    expect(run('version-setzen.sh', ['3.0.10', '0', '--dry-run']).status).toBe(2)
    expect(run('version-setzen.sh', ['3.0.10', '1000', '--dry-run']).status).toBe(2)
    expect(run('version-setzen.sh', ['3.0.7', '1', '--dry-run']).status).toBe(2)
  })
})

// ── Baupfade (Sicherheitspruefung r49, Fund N2) ──────────────────────────────
// Ohne Umschreibung standen im nativen Programm des APK Heimordner und
// Benutzername des Baurechners (Quellpfade von Cargo, rustup und llama.cpp).
describe('N2: die Release-Wege schreiben die Baupfade um, die Paketpruefung sieht nach', () => {
  const ios = code(`${REL}/ios-appstore.sh`)

  it('die gemeinsame Stelle schreibt Heimordner, Cargo, rustup und Arbeitsbaum um, fuer Rust und fuer C/C++', () => {
    expect(common).toMatch(/^pfade_umschreiben\(\) \{$/m)
    for (const pair of ['"$HOME=/home"', '"${CARGO_HOME:-$HOME/.cargo}=/cargo"', '"${RUSTUP_HOME:-$HOME/.rustup}=/rustup"', '"$WURZEL=/lu"']) expect(common).toContain(pair)
    expect(common).toContain('flags+=("--remap-path-prefix=$teil")')
    expect(common).toContain('export CARGO_ENCODED_RUSTFLAGS')
    expect(common).toContain('-ffile-prefix-map=$alt=$neu')
    expect(common).toContain('export "$cvar=$cflags" "$cxxvar=$cxxflags"')
  })

  it('Android ruft sie vor dem Bau, mit den Linker-Flags, die die Tauri-CLI sonst selbst setzt', () => {
    expect(android).toContain('TAURI_ANDROID_RUSTFLAGS="-Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES"')
    const call = android.indexOf('pfade_umschreiben aarch64-linux-android $TAURI_ANDROID_RUSTFLAGS')
    expect(call).toBeGreaterThan(0)
    expect(call).toBeLessThan(android.indexOf('"$WURZEL/scripts/mobile/android-bauen.sh" release'))
  })

  it('iOS ruft sie vor der Tauri-CLI', () => {
    const call = ios.indexOf('pfade_umschreiben aarch64-apple-ios')
    expect(call).toBeGreaterThan(0)
    expect(call).toBeLessThan(ios.indexOf('npx tauri "${ARGS[@]}"'))
  })

  it('iOS: die C-Flags gehen als Cargo-Konfiguration fuer den Lauf an cargo, Xcode reicht die Variablen nicht weiter', () => {
    expect(common).toMatch(/^pfade_als_cargo_konfig\(\) \{$/m)
    expect(common).toContain('ordner="$WURZEL/.cargo"')
    expect(common).toContain('force = true')
    expect(common).toMatch(/^pfade_konfig_entfernen\(\) \{$/m)
    const umschreiben = ios.indexOf('pfade_umschreiben aarch64-apple-ios')
    const konfig = ios.indexOf('pfade_als_cargo_konfig aarch64-apple-ios')
    expect(konfig).toBeGreaterThan(umschreiben)
    expect(konfig).toBeLessThan(ios.indexOf('npx tauri "${ARGS[@]}"'))
    expect(ios).toContain(`trap 'rm -rf "$ARBEIT"; pfade_konfig_entfernen' EXIT`)
    expect(ios.indexOf('pfade_konfig_entfernen\n', konfig)).toBeGreaterThan(ios.indexOf('CLI_ENDE=$?'))
  })

  it('die Paketpruefung des IPA findet den Heimordner im Programm', () => {
    const ipa = code(`${REL}/pruefe-ios-ipa.sh`)
    expect(ipa).toContain('strings -a "$BIN" | grep -c -F "${HOME%/}/"')
    expect(ipa).toContain('no build path of this machine (home folder, user name) in the program')
  })

  it('die Seitengroesse fuer 16 KB haengt nicht an diesen Variablen: build.rs gibt sie dem Linker', () => {
    expect(read('src-tauri/build.rs')).toContain('cargo:rustc-link-arg=-Wl,-z,max-page-size=16384')
  })

  it('die Paketpruefung findet den Heimordner in der nativen Bibliothek', () => {
    const mjs = read(`${REL}/pruefe-android-paket.mjs`)
    expect(mjs).toContain('Buffer.from(`${homedir().replace(/\\/+$/, \'\')}/`)')
    expect(mjs).toContain('readFileSync(lib).includes(heim)')
    expect(mjs).toContain("'no build path of this machine (home folder, user name) in the native library'")
  })

  describe.skipIf(!onMac)('im Lauf (bash des Mac)', () => {
    const flagsOf = (pre: string, call: string) => {
      const script = `set -euo pipefail\nHOME=/Users/someone\nunset CARGO_HOME RUSTUP_HOME\n${pre}\nsource "${join(root, REL, '_gemeinsam.sh')}"\nsource "${join(root, REL, '_android.sh')}"\n${call}\nprintf '%s' "$CARGO_ENCODED_RUSTFLAGS" | tr '\\037' '\\n'; echo\necho "RUSTFLAGS=\${RUSTFLAGS:-unset}"\necho "C=$CFLAGS_aarch64_linux_android"\necho "CXX=$CXXFLAGS_aarch64_linux_android"\n`
      const env = { ...process.env }
      for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CFLAGS', 'CXXFLAGS', 'CFLAGS_aarch64_linux_android', 'CXXFLAGS_aarch64_linux_android']) delete env[key]
      const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', env })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('note     build paths of aarch64-linux-android are rewritten')
      return r.stdout.split('\n').filter((line) => !line.startsWith('  note')).join('\n')
    }

    it('vorhandene Flags bleiben, die der Tauri-CLI kommen dazu, die Umschreibungen zuletzt', () => {
      const out = flagsOf('export RUSTFLAGS="-Cfoo=1 -Cbar"\nexport CFLAGS="-O2"', 'pfade_umschreiben aarch64-linux-android $TAURI_ANDROID_RUSTFLAGS')
      const lines = out.split('\n')
      const end = lines.indexOf('RUSTFLAGS=unset')
      expect(lines.slice(0, end)).toEqual([
        '-Cfoo=1',
        '-Cbar',
        '-Clink-arg=-landroid',
        '-Clink-arg=-llog',
        '-Clink-arg=-lOpenSLES',
        '--remap-path-prefix=/Users/someone=/home',
        '--remap-path-prefix=/Users/someone/.cargo=/cargo',
        '--remap-path-prefix=/Users/someone/.rustup=/rustup',
        `--remap-path-prefix=${root}=/lu`,
      ])
      expect(out).toMatch(/^C=-O2 -ffile-prefix-map=\/Users\/someone=\/home -ffile-prefix-map=\/Users\/someone\/\.cargo=\/cargo /m)
      expect(out).toMatch(/^CXX=-ffile-prefix-map=\/Users\/someone=\/home /m)
    })

    it('iOS: die Cargo-Konfiguration traegt sysroot und Umschreibungen und verschwindet wieder', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lu-pfade-'))
      try {
        const script = `set -euo pipefail\nHOME=/Users/someone\nunset CARGO_HOME RUSTUP_HOME CFLAGS CXXFLAGS\nsource "${join(root, REL, '_gemeinsam.sh')}"\nWURZEL="${dir}"\npfade_umschreiben aarch64-apple-ios >/dev/null\npfade_als_cargo_konfig aarch64-apple-ios /SDK/iPhoneOS.sdk >/dev/null\ncat "$WURZEL/.cargo/config.toml"\npfade_konfig_entfernen\n[ ! -e "$WURZEL/.cargo" ] && echo GONE\n`
        const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' })
        expect(r.status, r.stderr).toBe(0)
        expect(r.stdout).toMatch(/^CFLAGS_aarch64_apple_ios = \{ value = "-isysroot \/SDK\/iPhoneOS\.sdk -ffile-prefix-map=\/Users\/someone=\/home .*", force = true \}$/m)
        expect(r.stdout).toMatch(/^CXXFLAGS_aarch64_apple_ios = \{ value = "-ffile-prefix-map=\/Users\/someone=\/home .*", force = true \}$/m)
        expect(r.stdout).toMatch(/^OBJCFLAGS = \{ value = "-ffile-prefix-map=\/Users\/someone=\/home .*", force = true \}$/m)
        expect(r.stdout).toContain(`-ffile-prefix-map=${dir}=/lu`)
        expect(r.stdout.trim().endsWith('GONE')).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('CARGO_ENCODED_RUSTFLAGS der Shell bleibt erhalten, auch mit Leerzeichen in einem Flag', () => {
      const out = flagsOf("export CARGO_ENCODED_RUSTFLAGS=\"-Cx=a b$(printf '\\037')-Cy\"", 'pfade_umschreiben aarch64-linux-android')
      expect(out.split('\n').slice(0, 3)).toEqual(['-Cx=a b', '-Cy', '--remap-path-prefix=/Users/someone=/home'])
    })
  })
})

// ── Vorab-Version (X.Y.Z-preN, nur offener Bau) ──────────────────────────────
describe('Vorab-Version: X.Y.Z-preN mit Bau 0, unter der echten Version, nur fuer den offenen Bau', () => {
  const node = (args: string[]) => spawnSync(process.execPath, [join(root, REL, 'handy-version.mjs'), ...args], { encoding: 'utf8' })
  const FILES = [
    'src-tauri/tauri.android.conf.json',
    'src-tauri/tauri.ios.conf.json',
    'src-tauri/gen/apple/project.yml',
    'src-tauri/gen/apple/locally-uncensored_iOS/Info.plist',
    'src-tauri/tauri.conf.json',
    'package.json',
    'src-tauri/Cargo.toml',
  ]
  const temps: string[] = []
  afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  const copyOfTheTree = () => {
    const dir = mkdtempSync(join(tmpdir(), 'lu-vorab-'))
    temps.push(dir)
    for (const rel of FILES) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      cpSync(join(root, rel), join(dir, rel))
    }
    return dir
  }

  it('erkennt die Vorab-Version und nur sie', () => {
    for (const v of ['3.0.7-pre1', '3.0.7-pre12', '4.1.0-pre99']) expect(node(['vorab', v]).status, v).toBe(0)
    for (const v of ['3.0.7', '3.0.7-pre0', '3.0.7-pre100', '3.0.7-beta1', '3.0.7-pre', 'pre1']) expect(node(['vorab', v]).status, v).toBe(1)
  })

  it('setzt 3.0.7-pre1 mit Code 30007000, auch unter einem hoeheren Stand, und die Pruefung ist danach still', () => {
    const dir = copyOfTheTree()
    const out = node(['setze', '3.0.7-pre1', '30007000', '--wurzel', dir])
    expect(out.status, out.stderr).toBe(0)
    expect(node(['zeige', 'android', '--wurzel', dir]).stdout.trim()).toBe('3.0.7-pre1 30007000')
    const check = node(['pruefe', '--erwartet', '3.0.7-pre1', '--wurzel', dir])
    expect(check.stdout.trim(), check.stdout).toBe('')
    expect(check.status).toBe(0)
    // Ein anderer Code als Bau 0 gehoert nicht zur Vorab-Version.
    expect(node(['setze', '3.0.7-pre1', '30007001', '--wurzel', dir]).status).toBe(2)
    // Die echte Version geht darueber.
    expect(node(['setze', '3.0.7', '30007001', '--wurzel', dir]).status).toBe(0)
  })

  it('versionen.py und version-setzen.sh: Vorab nur mit Bau 0, die echte Version nie mit Bau 0', () => {
    const py = (version: string, build: number) => spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import versionen; print(versionen.codes(sys.argv[2], int(sys.argv[3])))', join(root, REL), version, String(build)], { encoding: 'utf8' })
    expect(py('3.0.7-pre1', 0).stdout.trim()).toBe('30007000')
    expect(py('3.0.7-pre1', 1).status).not.toBe(0)
    expect(Number(py('3.0.7-pre1', 0).stdout)).toBeLessThan(Number(py('3.0.7', 1).stdout))
    expect(Number(py('3.0.7-pre1', 0).stdout)).toBeGreaterThan(Number(py('3.0.6', 999).stdout))
    if (!onMac) return
    const sh = (args: string[]) => spawnSync('/bin/bash', [join(root, REL, 'version-setzen.sh'), ...args], { encoding: 'utf8' })
    const dir = copyOfTheTree()
    const ok = sh(['3.0.7-pre1', '0', '--dry-run', '--wurzel', dir])
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toContain('version 3.0.7-pre1, build 0, code 30007000')
    expect(sh(['3.0.7-pre1', '1', '--dry-run', '--wurzel', dir]).status).toBe(2)
    expect(sh(['3.0.7', '0', '--dry-run', '--wurzel', dir]).status).toBe(2)
  })

  it('die Store-Skripte lehnen eine Vorab-Version ab, der offene Bau nennt sie', () => {
    expect(common).toContain('node "$RELEASE_DIR/handy-version.mjs" vorab "$ERWARTETE_VERSION"')
    expect(common).toMatch(/missing "\$ERWARTETE_VERSION is a pre-release\. It is built only with android-offen\.sh \(preset open\), never for a store"/)
    if (!onMac) return
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(LU_|VITE_LU_|APPLE_)/.test(key)) delete env[key]
    for (const name of ['android-play.sh', 'ios-appstore.sh']) {
      const r = spawnSync('/bin/bash', [join(root, REL, name), '--version', '3.0.7-pre1', '--dry-run'], { encoding: 'utf8', env, timeout: 60_000 })
      expect(r.status, name).toBe(1)
      expect(`${r.stdout}${r.stderr}`, name).toContain('MISSING  3.0.7-pre1 is a pre-release.')
    }
    const offen = spawnSync('/bin/bash', [join(root, REL, 'android-offen.sh'), '--version', '3.0.7-pre1', '--dry-run'], { encoding: 'utf8', env, timeout: 60_000 })
    expect(`${offen.stdout}${offen.stderr}`).toContain('note     pre-release 3.0.7-pre1: for testers by direct download only')
    expect(`${offen.stdout}${offen.stderr}`).not.toContain('is a pre-release. It is built only')
  })
})
