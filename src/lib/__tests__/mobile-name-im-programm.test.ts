/**
 * Der lange Produktname steht in keinem Handy-Programm (David, 10.10.2026:
 * die Handy-Apps heissen ueberall nur "LU").
 *
 * Die Oberflaeche haelt der Store-Waechter. Dieser Test haelt den Rust-Teil:
 * `strings` ueber das siebte Abnahmepaket fand dort noch einen Fehlersatz,
 * einen Ordnernamen, den Kopf einer geschriebenen Datei, vier Kennungen fuer
 * ausgehende Aufrufe und die Adresse des Desktop-Updaters. Eine automatische
 * Store-Pruefung liest das Programm, und die Kennungen gehen an fremde Server.
 *
 * Die Regel: Wer im Rust-Quelltext den langen Namen in einem Text schreibt,
 * tut das an EINER Stelle, in `src-tauri/src/app_identity.rs` im Modul
 * `desktop_wording`. Das Modul wird in einen Handy-Bau nicht uebersetzt
 * (`cfg(not(mobile))`), sein Zwilling `phone_wording` sagt "LU". Alles andere
 * steht unten in einer benannten Liste mit Klasse und Grund:
 *
 *   c  nur intern: ein Bezeichner, ein Speicherort des Desktops, ein
 *      Schluessel. Kein Nutzer und kein fremder Server sieht ihn.
 *   d  am Handy toter Code: laeuft nur am Rechner und stand im siebten
 *      Abnahmepaket nicht im Programm.
 *
 * Eine neue Stelle ohne Eintrag macht den Test rot, ein Eintrag ohne Stelle
 * auch. Was am Ende wirklich im Paket steht, liest
 * `scripts/mobile/release/pruefe-name-im-paket.sh` am fertigen Paket; der
 * letzte Teil dieses Tests startet es an zwei kleinen Attrappen.
 *
 * Notiz: mobile-docs/r19/name-im-programm.md
 * Lauf:  npx vitest run src/lib/__tests__/mobile-name-im-programm.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/** Jede Schreibweise des langen Namens. */
const LONG_NAME = /locally[ ._-]?uncensored/i

const WORDING_FILE = 'src-tauri/src/app_identity.rs'
const SCRIPT = 'scripts/mobile/release/pruefe-name-im-paket.sh'
const ALLOWED_IN_PACKAGE = 'scripts/mobile/release/name-im-paket.erlaubt'

type Allowed = { file: string; has: string; klasse: 'c' | 'd'; grund: string }

/**
 * Die erlaubten Stellen ausserhalb von `desktop_wording`. `has` ist ein Stueck
 * der Zeile, an dem die Stelle zu erkennen ist.
 */
const ALLOWED: Allowed[] = [
  {
    file: 'src-tauri/src/hf_link.rs',
    has: 'pub const SCHEME: &str = "locallyuncensored";',
    klasse: 'd',
    grund: 'Link-Schema von Hugging Face "Use this model" (P9, 3.0.9): Name, unter dem das System die App findet. Modul unter cfg(desktop), am Handy nicht uebersetzt.',
  },
  {
    file: 'src-tauri/src/commands/plugin_rea.rs',
    has: '"locally uncensored",',
    klasse: 'd',
    grund: 'REA-Sperre gegen LU als Ziel (A37, 27.10.2026): Name, an dem LUs eigene Dateien zu erkennen sind. Unter cfg(not(mobile)), REA laeuft nur am Rechner.',
  },
  {
    file: 'src-tauri/src/commands/plugin_rea.rs',
    has: '"locally-uncensored",',
    klasse: 'd',
    grund: 'REA-Sperre gegen LU als Ziel (A37, 27.10.2026): Name, an dem LUs eigene Dateien zu erkennen sind. Unter cfg(not(mobile)), REA laeuft nur am Rechner.',
  },
  {
    file: 'src-tauri/src/commands/plugin_rea.rs',
    has: '"locally_uncensored",',
    klasse: 'd',
    grund: 'REA-Sperre gegen LU als Ziel (A37, 27.10.2026): Name, an dem LUs eigene Dateien zu erkennen sind. Unter cfg(not(mobile)), REA laeuft nur am Rechner.',
  },
  {
    file: 'src-tauri/src/commands/plugin_rea.rs',
    has: 'const LU_BUNDLE_ID: &str = "com.purpledoubled.locally-uncensored";',
    klasse: 'd',
    grund: 'REA-Sperre gegen LU als Ziel (A37, 27.10.2026): Name, an dem LUs eigene Dateien zu erkennen sind. Unter cfg(not(mobile)), REA laeuft nur am Rechner.',
  },
  {
    file: 'src-tauri/src/commands/search_tier_tests.rs',
    has: 'client=locally-uncensored/',
    klasse: 'c',
    grund: 'Testdatei der Websuche (3.0.8, eingebunden mit #[cfg(test)] mod), prueft den Desktop-Wortlaut. Wird nicht ausgeliefert.',
  },
  {
    file: 'src-tauri/src/commands/search_tier_tests.rs',
    has: 'APP_USER_AGENT.starts_with("LocallyUncensored/")',
    klasse: 'c',
    grund: 'Dieselbe Testdatei, dieselbe Pruefung fuer die Kennung gegenueber Wikimedia, Exa und You.com.',
  },
  {
    file: 'src-tauri/src/main.rs',
    has: 'locally_uncensored_lib::run()',
    klasse: 'c',
    grund: 'Name der Rust-Bibliothek, ein Bezeichner. main.rs ist das Programm des Rechners und wird fuer kein Handy gebaut.',
  },
  {
    file: WORDING_FILE,
    has: 'pub const APP_CONFIG_DIR: &str = "locally-uncensored";',
    klasse: 'c',
    grund: 'Ordner des Rechners fuer config.json. Das Handy legt seine Ordner in os_paths::mobile_layout an und benutzt den Namen nicht.',
  },
  {
    file: WORDING_FILE,
    has: 'pub const APP_DISPLAY_DIR: &str = "Locally Uncensored";',
    klasse: 'c',
    grund: 'Datenordner des Rechners. Umbenennen verliert die Daten der Nutzer dort. Am Handy benutzt ihn kein Pfad mehr (custom_models hat einen eigenen Arm).',
  },
  {
    file: WORDING_FILE,
    has: 'pub const KEYCHAIN_SERVICE: &str = "com.locallyuncensored.providerkeys";',
    klasse: 'c',
    grund: 'Dienstname im Schluesselbund von Windows und macOS. Aendern verwaist gespeicherte Schluessel. Das Handy hat einen eigenen Speicher im Plugin.',
  },
  {
    file: 'src-tauri/src/commands/engine.rs',
    has: 'Install Locally Uncensored to a shorter',
    klasse: 'd',
    grund: 'Hinweis zu einem zu langen Installationspfad unter Windows.',
  },
  {
    file: 'src-tauri/src/commands/engine.rs',
    has: '" Reinstall Locally Uncensored if this keeps happening',
    klasse: 'd',
    grund: 'Hinweis nach dem Absturz des Engine-Prozesses. Am Handy laeuft die Engine im Programm, es gibt keinen Prozess.',
  },
  {
    file: 'src-tauri/src/commands/engine.rs',
    has: 'is missing from this installation. Reinstall Locally Uncensored',
    klasse: 'd',
    grund: 'Das mitgelieferte Engine-Programm fehlt. Ein Handy-Paket liefert keins mit.',
  },
  {
    file: 'src-tauri/src/commands/install/python.rs',
    has: 'Restart Locally Uncensored',
    klasse: 'd',
    grund: 'Python-Installation ueber winget, nur Windows.',
  },
  {
    file: 'src-tauri/src/commands/remote.rs',
    has: 'let legacy = format!("Locally Uncensored Remote {}", port);',
    klasse: 'd',
    grund: 'Alte Firewall-Regel unter Windows, hinter cfg(target_os = "windows").',
  },
  {
    file: 'src-tauri/src/commands/self_migrate.rs',
    has: 'pub const APPIMAGE_FILE: &str = "Locally.Uncensored.AppImage";',
    klasse: 'd',
    grund: 'Umzug einer AppImage-Installation unter Linux.',
  },
  {
    file: 'src-tauri/src/commands/self_migrate.rs',
    has: 'pub const STAGED_FILE: &str = "Locally.Uncensored.AppImage.part";',
    klasse: 'd',
    grund: 'wie oben.',
  },
  {
    file: 'src-tauri/src/commands/self_migrate.rs',
    has: 'pub const DESKTOP_FILE: &str = "Locally Uncensored.desktop";',
    klasse: 'd',
    grund: 'wie oben.',
  },
  {
    file: 'src-tauri/src/commands/self_migrate.rs',
    has: 'pub const ICON_NAME: &str = "locally-uncensored";',
    klasse: 'd',
    grund: 'wie oben.',
  },
  {
    file: 'src-tauri/src/commands/self_migrate.rs',
    has: 'Name=Locally Uncensored',
    klasse: 'd',
    grund: 'wie oben, der Starter-Eintrag unter Linux.',
  },
]

/** Jede Quelldatei, aus der ein Handy-Programm entsteht. */
function sources(): string[] {
  const out: string[] = ['src-tauri/build.rs']
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name === 'target' || name === 'build' || name === 'node_modules' || name.startsWith('.')) continue
      const rel = `${dir}/${name}`
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(rs|swift|kt)$/.test(name)) out.push(rel)
    }
  }
  walk('src-tauri/src')
  walk('src-tauri/plugins')
  return out
}

type Hit = { file: string; line: number; text: string }

/**
 * Die Zeilen einer Datei, die ausgeliefert werden: ohne Kommentarzeilen und
 * ohne die Testmodule (`#[cfg(test)]` vor `mod name {` bis zur schliessenden
 * Klammer auf derselben Einrueckung).
 */
function shippedLines(text: string): { line: number; text: string }[] {
  const lines = text.split('\n')
  const out: { line: number; text: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1] ?? ''
    if (lines[i].trim() === '#[cfg(test)]' && /^\s*(pub(\([a-z]+\))? )?mod \w+ \{\s*$/.test(next)) {
      const indent = next.length - next.trimStart().length
      let j = i + 2
      while (j < lines.length && lines[j] !== `${' '.repeat(indent)}}`) j++
      i = j
      continue
    }
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    out.push({ line: i + 1, text: lines[i].replace(/\s\/\/\s.*$/, '') })
  }
  return out
}

function hitsIn(file: string, text: string): Hit[] {
  return shippedLines(text)
    .filter((l) => LONG_NAME.test(l.text))
    .map((l) => ({ file, line: l.line, text: l.text.trim() }))
}

/** Erste und letzte Zeile (1-basiert) des Moduls `name` in der Wortlaut-Datei. */
function moduleRange(text: string, name: string): { from: number; to: number; before: string } {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^(pub(\\(crate\\))? )?mod ${name} \\{$`).test(l))
  if (start < 0) throw new Error(`mod ${name} fehlt in ${WORDING_FILE}`)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  return { from: start + 1, to: end + 1, before: lines[start - 1] ?? '' }
}

function unlisted(all: Hit[], wording: string): Hit[] {
  const desktop = moduleRange(wording, 'desktop_wording')
  return all.filter((hit) => {
    if (hit.file === WORDING_FILE && hit.line > desktop.from && hit.line < desktop.to) return false
    return !ALLOWED.some((a) => a.file === hit.file && hit.text.includes(a.has))
  })
}

const wording = read(WORDING_FILE)
const allHits = sources().flatMap((file) => hitsIn(file, read(file)))

describe('der lange Name im Rust-Quelltext', () => {
  it('steht nur im Desktop-Wortlaut und an den benannten internen Stellen', () => {
    const rest = unlisted(allHits, wording).map((h) => `${h.file}:${h.line}: ${h.text}`)
    expect(
      rest,
      'Der lange Name steht in einem Text, den ein Handy-Bau uebersetzt. Den Wortlaut ueber app_identity holen ' +
        '(PRODUCT_NAME, outgoing_agent!) oder die Stelle mit Klasse und Grund in ALLOWED eintragen.',
    ).toEqual([])
  })

  it('jeder Eintrag der Liste trifft noch eine Stelle, und jeder hat einen Grund', () => {
    for (const a of ALLOWED) {
      const found = allHits.filter((h) => h.file === a.file && h.text.includes(a.has))
      expect(found.length, `${a.file}: "${a.has}" steht nicht mehr da, der Eintrag kann weg`).toBeGreaterThan(0)
      expect(a.grund.length).toBeGreaterThan(8)
      expect(LONG_NAME.test(a.has), `${a.has} nennt den Namen nicht`).toBe(true)
    }
  })

  it('der Waechter sieht die Stellen ueberhaupt: der Desktop-Wortlaut ist gefunden', () => {
    // Ohne diese Probe waere ein Waechter gruen, der keine Datei liest.
    const desktop = moduleRange(wording, 'desktop_wording')
    const inside = allHits.filter((h) => h.file === WORDING_FILE && h.line > desktop.from && h.line < desktop.to)
    expect(inside.length).toBeGreaterThanOrEqual(6)
    expect(sources().length).toBeGreaterThan(60)
  })

  it('Gegenprobe: eine zurueckgedrehte Stelle macht ihn rot', () => {
    const back = [
      ['src-tauri/src/commands/proxy.rs', '        .user_agent("LocallyUncensored/2.0")'],
      ['src-tauri/src/commands/download.rs', '            "... or update Locally Uncensored, the address is part of the catalog."'],
      ['src-tauri/src/commands/custom_models.rs', '        "# Written by Locally Uncensored from Settings -> Model Storage.\\n\\'],
      ['src-tauri/src/commands/search.rs', '    " (https://github.com/PurpleDoubleD/locally-uncensored; https://locallyuncensored.com)"'],
      ['src-tauri/plugins/lu-native/src/remote.rs', '    format!("LocallyUncensored-Mobile/{app_version}")'],
      // Dieselbe Zeile wie im Desktop-Wortlaut, aber ausserhalb des Moduls.
      [WORDING_FILE, 'pub const PRODUCT_NAME: &str = "Locally Uncensored";'],
    ] as const
    for (const [file, line] of back) {
      const text = `${read(file)}\n${line}\n`
      const rest = unlisted(hitsIn(file, text), file === WORDING_FILE ? text : wording)
      expect(rest.map((h) => h.text), `${file} mit der alten Zeile`).toContain(line.trim())
    }
    // Und im Testmodul darf der Name stehen: dort haelt der Desktop seinen Wortlaut fest.
    const inTest = '#[cfg(test)]\nmod tests {\n    const A: &str = "Locally Uncensored";\n}\n'
    expect(hitsIn('x.rs', inTest)).toEqual([])
  })
})

describe('die eine Stelle fuer den Wortlaut', () => {
  const desktop = moduleRange(wording, 'desktop_wording')
  const phone = moduleRange(wording, 'phone_wording')
  const lines = wording.split('\n')
  const body = (r: { from: number; to: number }) => lines.slice(r.from, r.to - 1).join('\n')

  it('der Desktop-Wortlaut wird in einen Handy-Bau nicht uebersetzt', () => {
    expect(desktop.before).toBe('#[cfg(not(mobile))]')
    // Auch die Weitergabe haengt an derselben Bedingung, sonst braeche der Handy-Bau.
    expect(wording).toMatch(/#\[cfg\(not\(mobile\)\)\]\npub\(crate\) use desktop_wording::\{/)
    expect(wording).toMatch(/#\[cfg\(mobile\)\]\npub\(crate\) use phone_wording::\{/)
  })

  it('der Handy-Wortlaut nennt nur LU, ohne Repo-Adresse und ohne die alte Domain', () => {
    const text = body(phone)
    expect(text).not.toMatch(LONG_NAME)
    expect(text).not.toMatch(/github\.com|purpledoubled/i)
    expect(text).toContain('pub const PRODUCT_NAME: &str = "LU";')
    // Runde 22 (N13): die Version des Pakets (build.rs), nicht die der Kiste.
    expect(text).toContain('concat!("LU/", env!("LU_PHONE_VERSION"))')
    expect(text).not.toContain('CARGO_PKG_VERSION')
    // Die Kontaktangabe fuer Dienste, die eine verlangen (Wikimedia): seit
    // 3.0.8 haengt die Websuche sie an die eine Kennung an, auf beiden Seiten
    // dieselbe Projektadresse (commands/search_tiers.rs, APP_USER_AGENT).
    const tiers = read('src-tauri/src/commands/search_tiers.rs')
    expect(tiers).toContain('outgoing_agent_for(crate::app_identity::APP_VERSION)')
    expect(tiers).toContain('(+https://lu-labs.ai)')
  })

  it('beide Seiten tragen dieselben Namen', () => {
    const names = (text: string) =>
      [...text.matchAll(/^\s*(?:pub const|pub fn|macro_rules!) (\w+)/gm)].map((m) => m[1]).sort()
    const d = names(body(desktop))
    expect(d.length).toBeGreaterThanOrEqual(6)
    for (const name of d) expect(names(body(phone)), `phone_wording ohne ${name}`).toContain(name)
  })

  it('kein ausgehender Aufruf baut seine Kennung selbst', () => {
    // Jede Stelle, die einem reqwest-Client eine Kennung gibt, holt sie aus
    // app_identity oder reicht einen Parameter durch. Ein Literal waere ein
    // zweiter Wortlaut neben der einen Stelle.
    const own: string[] = []
    for (const file of sources().filter((f) => f.startsWith('src-tauri/src/') && f.endsWith('.rs'))) {
      for (const l of shippedLines(read(file))) {
        const m = l.text.match(/\.user_agent\(\s*(format!\(\s*)?"([^"]*)"/)
        if (m) own.push(`${file}:${l.line}: ${m[2]}`)
      }
    }
    expect(own).toEqual([])
  })
})

describe('die Tauri-Konfiguration eines Handy-Baus', () => {
  type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
  /** JSON Merge Patch (RFC 7396), so mischt Tauri die Plattformdatei ein: null entfernt den Schluessel. */
  const merge = (base: Json, patch: Json): Json => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
    const out: { [key: string]: Json } =
      base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete out[key]
      else out[key] = merge(out[key] ?? null, value)
    }
    return out
  }
  const base = JSON.parse(read('src-tauri/tauri.conf.json')) as Json
  const merged = (platform: 'ios' | 'android') =>
    merge(base, JSON.parse(read(`src-tauri/tauri.${platform}.conf.json`)) as Json) as {
      productName: string
      identifier: string
      plugins: Record<string, Json>
    }

  it('der Rechner behaelt seinen Updater', () => {
    const endpoints = JSON.stringify((base as { plugins: { updater: Json } }).plugins.updater)
    expect(endpoints).toContain('/releases/latest/download/latest.json')
  })

  it.each(['ios', 'android'] as const)('%s: ohne den Updater des Rechners und ohne den langen Namen', (platform) => {
    const conf = merged(platform)
    // Updates kommen ueber den Store. Das Plugin ist am Handy nicht einmal
    // gebaut (Cargo.toml), seine Adresse stand trotzdem im Programm, weil die
    // ganze Konfiguration hineinwandert.
    expect(Object.keys(conf.plugins)).not.toContain('updater')
    expect(conf.productName).toBe('LU')
    // Die Kennung der Android-App bleibt: 3.0.7 ueberspielt die alte App.
    const rest = JSON.stringify({ ...conf, identifier: '' })
    expect(rest).not.toMatch(LONG_NAME)
    expect(conf.identifier).toBe(platform === 'ios' ? 'com.purpledoubled.lu' : 'com.purpledoubled.locallyuncensored')
  })

  it('das Updater-Plugin ist nur fuer den Rechner gebaut und registriert', () => {
    const cargo = read('src-tauri/Cargo.toml')
    const desktopOnly = cargo.slice(cargo.indexOf(`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`))
    expect(desktopOnly).toContain('tauri-plugin-updater')
    expect(cargo.match(/tauri-plugin-updater/g) ?? []).toHaveLength(1)
    expect(read('src-tauri/src/lib.rs')).toMatch(/#\[cfg\(desktop\)\]\n\s*let builder = builder\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\);/)
  })
})

describe('die Pruefung am fertigen Paket', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lu-name-test-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  const script = join(ROOT, SCRIPT)
  const run = (file: string) => spawnSync('bash', [script, file], { encoding: 'utf8' })
  const tools = ['strings', 'perl', 'unzip'].every((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0)

  it('das Skript ist da, ausfuehrbar, und RELEASE-KNOPF nennt es', () => {
    expect(existsSync(script)).toBe(true)
    expect(statSync(script).mode & 0o111).not.toBe(0)
    expect(read('mobile-docs/RELEASE-KNOPF.md')).toContain('pruefe-name-im-paket.sh')
  })

  it('die Liste der erlaubten Stellen im Paket ist genau diese', () => {
    const patterns = read(ALLOWED_IN_PACKAGE)
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    expect(patterns).toEqual([
      // Name der Rust-Bibliothek: Modulpfade in Protokollzeilen, Symbole, Dateiname der .so
      'locally_uncensored_lib',
      // Paketname der Android-App (bleibt wegen des Updates von 2.6.6)
      'purpledoubled[._/]locallyuncensored',
      // Name des Cargo-Pakets, den Tauri hinter die Paketbeschreibung legt
      '(?<=Private, local AI chat & image/video generation)locally-uncensored',
      // Name des Android-Themes in der Ressourcentabelle
      'Theme\\.locally_uncensored',
    ])
    // Das dritte Muster haengt an der Beschreibung des Pakets.
    expect(read('src-tauri/Cargo.toml')).toContain('description = "Private, local AI chat & image/video generation"')
  })

  it.runIf(tools)('gruen bei den erlaubten Stellen, rot bei jeder anderen', () => {
    const inner =
      'src/commands/x.rs locally_uncensored_lib::commands::x\0' +
      'Java_com_purpledoubled_locallyuncensored_WryActivity_create\0' +
      'purpledoubledPrivate, local AI chat & image/video generationlocally-uncensoredcore:path:default\0' +
      'LU/3.0.7 (https://lu-labs.ai)\0# Written by LU from Settings\0'
    const clean = join(tmp, 'clean.so')
    writeFileSync(clean, Buffer.from(`\x7fELF\0\0${inner}`, 'latin1'))
    const good = run(clean)
    expect(good.status, good.stdout + good.stderr).toBe(0)
    expect(good.stdout).toContain('3 allowed internal places')

    const forbidden = [
      'LocallyUncensored/2.0',
      'or update Locally Uncensored ',
      '# Written by Locally Uncensored from Settings',
      'https://github.com/purpledoubled/locally-uncensored/releases/latest/download/latest.json',
      'https://locallyuncensored.com',
      'INSTANCE_NAME=locally-uncensored',
    ]
    for (const text of forbidden) {
      const dirty = join(tmp, 'dirty.so')
      writeFileSync(dirty, Buffer.from(`\x7fELF\0\0${inner}${text}\0`, 'latin1'))
      const bad = run(dirty)
      expect(bad.status, `${text}\n${bad.stdout}`).toBe(1)
      expect(bad.stdout).toContain('FAIL')
    }
    // Ein Fund direkt neben einer erlaubten Stelle bleibt ein Fund.
    const beside = join(tmp, 'beside.so')
    writeFileSync(beside, Buffer.from('locally_uncensored_libLocally Uncensoredlocally_uncensored_lib\0', 'latin1'))
    expect(run(beside).status).toBe(1)
    // Und ein Aufruf ohne Paket ist ein falscher Aufruf, kein Bestanden.
    expect(spawnSync('bash', [script], { encoding: 'utf8' }).status).toBe(2)
    expect(run(join(tmp, 'gibt-es-nicht.apk')).status).toBe(1)
  })

  it.runIf(tools)('liest auch ein gepacktes Paket und Text in UTF-16', () => {
    const dir = join(tmp, 'paket')
    spawnSync('mkdir', ['-p', join(dir, 'lib/arm64-v8a')])
    writeFileSync(join(dir, 'lib/arm64-v8a/libx.so'), Buffer.from('abcdefgh\0LocallyUncensored-Agent/1.0\0', 'latin1'))
    writeFileSync(join(dir, 'AndroidManifest.xml'), Buffer.from('Locally Uncensored Remote', 'utf16le'))
    const apk = join(tmp, 'p.apk')
    const zipped = spawnSync('zip', ['-q', '-r', apk, '.'], { cwd: dir })
    if (zipped.status !== 0) return
    const bad = run(apk)
    expect(bad.status, bad.stdout).toBe(1)
    expect(bad.stdout).toContain('lib/arm64-v8a/libx.so')
    expect(bad.stdout).toContain('AndroidManifest.xml')
  })
})
