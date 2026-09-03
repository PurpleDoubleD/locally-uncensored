/**
 * Das ERSTE Tor des Dev-Käfigs, gegen die Rust-Quelle gestellt.
 *
 * DER BEFUND: `filesystem.rs` hat zwei getrennte Tore und schreibt den
 * Unterschied selbst hin (`resolve_path`, :359) — `check_workspace_root`
 * entscheidet, OB eine Wurzel überhaupt ein Käfig sein darf, `contain_within`
 * erst danach, ob ein Pfad darin liegt. Der TypeScript-Port hatte nur das
 * zweite. Folge: `workingDirectory: "/"` machte `/` zur Käfigwurzel, jeder Pfad
 * lag „innerhalb", und die Prüfung war formal intakt und praktisch wertlos. Am
 * laufenden Dev-Server nachgestellt:
 *
 *   POST /local-api/fs-read {"path":"/etc/hosts","workingDirectory":"/"}
 *   → {"content":"##\n# Host Database\n#\n…"}
 *
 * WARUM DIESE DATEI DIE RUST-QUELLE LIEST statt zwei Listen zu pflegen: dieselbe
 * Begründung wie in dev-fs-jail-slug.test.ts. Eine von Hand abgeschriebene
 * Sperrliste läuft von der Vorlage weg, und der Test, der aus der Abschrift
 * seine Erwartung ableitet, merkt es als Letzter. Also: die Regeln werden aus
 * `forbidden_exact_roots`, `forbidden_root_prefixes` und `may_be_a_picked_root`
 * HERAUSGELESEN, daraus eine Referenz gebaut und der Port dagegen gefahren —
 * und zusätzlich die Sicherheitseigenschaft selbst geprüft, damit ein
 * gemeinsamer Fehler beider Seiten nicht grün wird.
 *
 * DIE EINE BEWUSSTE ABWEICHUNG ist unten in einem eigenen `describe`
 * festgehalten: Rust hat vor `may_be_a_picked_root` noch die Allowlist der im
 * nativen Dialog geklickten Ordner (`PICKED_ROOTS`). Der Dev-Server hat keinen
 * nativen Dialog, also kann er diese Liste weder füllen noch führen; die
 * Begründung steht bei `devCheckWorkspaceRoot`.
 *
 * MUTATIONSSONDE (von Hand geprüft): in `src/lib/dev-fs-jail.ts` in
 * `devResolveWithinJail` die zwei Zeilen
 *   `if ((args.workingDirectory ?? '').trim()) devCheckWorkspaceRoot(…)`
 * entfernen → „die Wurzel aus dem Request geht durch das erste Tor" und der
 * ganze Paritätsblock werden rot; zurücknehmen → grün.
 *
 * Run: npx vitest run src/lib/__tests__/dev-fs-jail-root.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  devCheckWorkspaceRoot,
  devResolveWithinJail,
  JailEscapeError,
  WorkspaceRootError,
  namedDepth,
} from '../dev-fs-jail'
import { AGENT_WORKSPACE_DIR } from '../app-identity'

const HOME = '/Users/dev'
const DRIVE = 'C:'

// ── Die Rust-Regeln, aus der Quelle gelesen ────────────────────────────────

const filesystemRs = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/commands/filesystem.rs'),
  'utf8',
)

/** Der Rumpf EINER Rust-Funktion, ohne den Rest der Datei. */
function fnBody(name: string): string {
  const start = filesystemRs.indexOf(`fn ${name}(`)
  expect(start, `${name} nicht in filesystem.rs gefunden`).toBeGreaterThanOrEqual(0)
  const rest = filesystemRs.slice(start)
  const end = rest.indexOf('\n}')
  expect(end, `Ende von ${name} nicht gefunden`).toBeGreaterThan(0)
  return rest.slice(0, end + 2)
}

/** Alle String-Array-Literale eines Rumpfes, in Reihenfolge. */
function stringArrays(body: string): string[][] {
  const out: string[][] = []
  for (const match of body.matchAll(/\[\s*((?:"[^"]*"\s*,?\s*)+)\]/g)) {
    out.push([...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]))
  }
  return out
}

/** `forbidden_exact_roots`, zerlegt. */
function rustExactRoots(): string[] {
  const body = fnBody('forbidden_exact_roots')
  const arrays = stringArrays(body)
  expect(
    arrays.length,
    'forbidden_exact_roots hat nicht mehr genau EIN String-Array — nachsehen, nicht anpassen',
  ).toBe(1)
  const out = [...arrays[0]]
  // Der Windows-Eintrag steht als `format!("{}\\Users", drive)` da, nicht als
  // Literal; wird er umbenannt, muss dieser Test hier rot werden.
  expect(body, 'der Windows-Eintrag von forbidden_exact_roots sieht anders aus').toContain(
    'format!("{}\\\\Users", drive)',
  )
  out.push(`${DRIVE}/Users`)
  // Und das Heimatverzeichnis selbst.
  expect(body, 'forbidden_exact_roots kennt das Heimatverzeichnis nicht mehr').toMatch(
    /if let Some\(home\) = dirs::home_dir\(\)\s*\{\s*out\.push\(home\);/,
  )
  out.push(HOME)
  return out
}

/** `forbidden_root_prefixes`, zerlegt. */
function rustPrefixes(): { system: string[]; homeRelative: string[] } {
  const body = fnBody('forbidden_root_prefixes')
  const arrays = stringArrays(body)
  expect(
    arrays.length,
    'forbidden_root_prefixes hat nicht mehr genau DREI String-Arrays (posix, windows, home) — nachsehen, nicht anpassen',
  ).toBe(3)
  const [posix, windowsRel, homeRelative] = arrays
  expect(body, 'die Windows-Einträge werden anders zusammengesetzt').toContain(
    'format!("{}\\\\{}", drive, rel)',
  )
  // Die Filterzeile: ein „System"-Verzeichnis, das HOME enthält, ist keines.
  expect(body, 'die home-enthält-Filterung ist verschwunden').toContain(
    'is_within(&lexical_normalize(p), &lexical_normalize(h))',
  )
  expect(body, 'die home-relativen Einträge werden nicht mehr an home gehängt').toContain(
    'out.push(home.join(rel))',
  )
  return {
    system: [...posix, ...windowsRel.map((rel) => `${DRIVE}/${rel}`)],
    homeRelative,
  }
}

/** Die drei Ablehnungsgründe von `may_be_a_picked_root`, in ihrer Reihenfolge. */
function rustReasons(): string[] {
  const body = fnBody('may_be_a_picked_root')
  const reasons = [...body.matchAll(/refuse\("([^"]+)"\)/g)].map((m) => m[1])
  expect(
    reasons.length,
    'may_be_a_picked_root hat nicht mehr genau DREI Ablehnungen — nachsehen, nicht anpassen',
  ).toBe(3)
  expect(body, 'die Tiefenprüfung (named_depth == 0) ist verschwunden').toContain(
    'named_depth(norm) == 0',
  )
  expect(body, 'die Meldung von may_be_a_picked_root hat eine andere Form').toContain(
    'Not an allowed workspace folder ({}): {}',
  )
  return reasons
}

const EXACT = rustExactRoots()
const PREFIX = rustPrefixes()
const REASONS = rustReasons()

// ── Die Referenz, ausschliesslich aus dem Gelesenen gebaut ─────────────────

function norm(p: string): string {
  const unified = p.replace(/\\/g, '/')
  const parts: string[] = []
  const drive = /^([a-z]:)\//i.exec(unified)
  const unc = unified.startsWith('//')
  const body = unified.slice(unc ? 2 : drive ? drive[0].length : 0)
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  if (unc) return `//${parts.join('/')}`
  if (drive) return `${drive[1]}/${parts.join('/')}`
  return unified.startsWith('/') ? `/${parts.join('/')}` : parts.join('/')
}

function key(p: string): string {
  const t = norm(p).replace(/\/+$/, '')
  return /^[a-z]:/i.test(t) || t.startsWith('//') ? t.toLowerCase() : t
}

function within(root: string, cand: string): boolean {
  const r = key(root)
  const c = key(cand)
  return c === r || c.startsWith(`${r}/`)
}

/** Was `may_be_a_picked_root` zu dieser Wurzel sagen würde. */
function rustRefusal(root: string): string | null {
  const n = norm(root)
  if (namedDepthReference(n) === 0) return REASONS[0]
  for (const bad of EXACT) {
    if (within(bad, n) && within(n, bad)) return REASONS[1]
  }
  const system = PREFIX.system.filter((p) => !within(p, HOME))
  for (const bad of [...system, ...PREFIX.homeRelative.map((rel) => `${HOME}/${rel}`)]) {
    if (within(bad, n)) return REASONS[2]
  }
  return null
}

/**
 * `named_depth` als Referenz — bewusst unabhängig von `namedDepth` im Port
 * geschrieben, sonst prüfte der Vergleich unten nur sich selbst.
 */
function namedDepthReference(normalized: string): number {
  if (normalized.startsWith('//')) {
    // Rusts Windows-Sicht: `\\server\share` ist ein PREFIX, kein benannter Teil.
    // `Math.max` fängt die Krüppelform `//` ab (weniger als zwei Teile).
    return Math.max(0, normalized.slice(2).split('/').filter(Boolean).length - 2)
  }
  const drive = /^([a-z]:)\/?/i.exec(normalized)
  const body = drive ? normalized.slice(drive[0].length) : normalized
  return body.split('/').filter(Boolean).length
}

/** Was der Port zu dieser Wurzel sagt: `null` = durchgelassen. */
function portRefusal(root: string): string | null {
  try {
    devCheckWorkspaceRoot(root, HOME, { systemDrive: DRIVE })
    return null
  } catch (err) {
    expect(err, `${root} wirft etwas anderes als WorkspaceRootError`).toBeInstanceOf(
      WorkspaceRootError,
    )
    const m = /^Not an allowed workspace folder \((.+)\): /.exec((err as Error).message)
    expect(m, `unerwartete Meldung für ${root}: ${(err as Error).message}`).not.toBeNull()
    return m![1]
  }
}

// ── Das Korpus ─────────────────────────────────────────────────────────────

function korpus(): string[] {
  const roots = [
    // Wurzeln ohne benannten Bestandteil.
    '/', '//', 'C:/', 'C:\\', 'c:/', 'D:\\', '',
    // Heim- und Mount-Behälter.
    '/Users', '/home', '/Volumes', '/mnt', '/media', '/Users/', HOME, `${HOME}/`,
    'C:/Users', 'c:\\users',
    // System- und Zugangsdaten-Verzeichnisse, als Präfix.
    '/etc', '/etc/nginx', '/private/etc', '/dev', '/proc', '/sys', '/boot',
    '/root', '/var/root', '/usr', '/usr/local/src', '/bin', '/sbin',
    '/System', '/System/Library', '/Library', '/Library/Caches',
    `${HOME}/.ssh`, `${HOME}/.aws/cli`, `${HOME}/.gnupg`, `${HOME}/.kube`,
    `${HOME}/.docker`, `${HOME}/.config`, `${HOME}/.config/lu`, `${HOME}/.lu`,
    `${HOME}/Library/Keychains`, `${HOME}/AppData/Roaming`,
    'C:/Windows', 'C:/Windows/System32/config', 'C:/Program Files',
    'C:/Program Files (x86)/App', 'C:/ProgramData', 'c:\\windows\\system32',
    // Der Kletterweg dorthin.
    '/Users/dev/projects/..', '/Users/dev/projects/../..', `${HOME}/projects/../.ssh`,
    // Ordentliche Arbeitsordner.
    '/Users/dev/projects/lu', '/projects/app', '/opt/work', '/srv/code',
    `${HOME}/code/repo`, `${HOME}/Documents/projekt`, 'D:/projects/app',
    '/Volumes/Extern/projekt', '/mnt/data/repo', '/home/tester/repo',
    '//server/share/projekt',
    // Der app-eigene Sandkasten.
    `${HOME}/${AGENT_WORKSPACE_DIR}`, `${HOME}/${AGENT_WORKSPACE_DIR}/chat-1`,
    // Ähnlich geschrieben, aber nicht dasselbe (Bestandteil-Grenze).
    '/Usersonstiges', '/etcetera', `${HOME}/.sshfs`, '/rootless/projekt',
  ]
  return roots
}

// ── Die Zusicherungen ──────────────────────────────────────────────────────

describe('die Rust-Regeln, wie dieser Test sie gelesen hat', () => {
  it('nennt die drei Ablehnungsgründe von may_be_a_picked_root', () => {
    expect(REASONS).toEqual([
      'a drive or filesystem root is not a workspace',
      'a home or mount container is not a workspace',
      'system or credential directory',
    ])
  })

  it('kennt die Behälter, die nur als EXAKTE Wurzel gesperrt sind', () => {
    expect(EXACT).toContain('/Users')
    expect(EXACT).toContain('/Volumes')
    expect(EXACT).toContain(HOME)
    expect(EXACT).toContain(`${DRIVE}/Users`)
  })

  it('kennt die Verzeichnisse, die als PRÄFIX gesperrt sind', () => {
    expect(PREFIX.system).toContain('/etc')
    expect(PREFIX.system).toContain('/Library')
    expect(PREFIX.system).toContain(`${DRIVE}/Windows`)
    expect(PREFIX.homeRelative).toContain('.ssh')
    expect(PREFIX.homeRelative).toContain('Library/Keychains')
    expect(PREFIX.homeRelative).toContain('AppData')
  })
})

describe('devCheckWorkspaceRoot gegen may_be_a_picked_root', () => {
  it('urteilt für jede Wurzel im Korpus gleich — und mit demselben Grund', () => {
    for (const root of korpus()) {
      expect(portRefusal(root), `Wurzel ${JSON.stringify(root)}`).toBe(rustRefusal(root))
    }
  })

  it('zählt benannte Bestandteile wie `named_depth`', () => {
    expect(namedDepth('/')).toBe(0)
    expect(namedDepth('C:/')).toBe(0)
    expect(namedDepth('C:\\')).toBe(0)
    expect(namedDepth('//server/share')).toBe(0)
    expect(namedDepth('/etc')).toBe(1)
    expect(namedDepth('//server/share/projekt')).toBe(1)
    expect(namedDepth('/a/b/c')).toBe(3)
    expect(namedDepth('/a/b/../..')).toBe(0)
  })
})

describe('die Sicherheitseigenschaft selbst', () => {
  // Unabhängig von der Rust-Quelle formuliert: machen beide Seiten denselben
  // Fehler, ist der Vergleich oben grün und diese Zusicherungen sind rot.

  it('lässt weder das Dateisystem noch ein Laufwerk als Käfigwurzel zu', () => {
    for (const root of ['/', 'C:/', 'C:\\', 'D:/', '//server/share', '']) {
      expect(() => devCheckWorkspaceRoot(root, HOME), root).toThrow(WorkspaceRootError)
    }
  })

  it('lässt das Heimatverzeichnis und die Mount-Behälter nicht zu', () => {
    for (const root of [HOME, `${HOME}/`, '/Users', '/home', '/Volumes', '/mnt', '/media']) {
      expect(() => devCheckWorkspaceRoot(root, HOME), root).toThrow(WorkspaceRootError)
    }
  })

  it('lässt kein Zugangsdaten- oder Systemverzeichnis zu', () => {
    for (const root of [
      `${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.gnupg`, `${HOME}/.config`,
      `${HOME}/Library/Keychains`, `${HOME}/AppData`, '/etc', '/etc/ssl/private',
      '/usr/bin', '/System/Library', 'C:/Windows/System32',
    ]) {
      expect(() => devCheckWorkspaceRoot(root, HOME), root).toThrow(WorkspaceRootError)
    }
  })

  it('erkennt den Kletterweg, weil vorher normalisiert wird', () => {
    expect(() => devCheckWorkspaceRoot('/Users/dev/projekt/..', HOME)).toThrow(WorkspaceRootError)
    expect(() => devCheckWorkspaceRoot(`${HOME}/projekt/../.ssh`, HOME)).toThrow(
      WorkspaceRootError,
    )
  })

  it('lässt einen gewöhnlichen Projektordner weiterhin durch', () => {
    // Die Gegenprobe: ein Tor, das alles ablehnt, wäre auch „sicher".
    for (const root of [
      '/Users/dev/projects/lu', '/projects/app', `${HOME}/code/repo`,
      '/Volumes/Extern/projekt', '/mnt/data/repo', 'D:/projects/app',
      '//server/share/projekt', `${HOME}/${AGENT_WORKSPACE_DIR}/chat-1`,
    ]) {
      expect(() => devCheckWorkspaceRoot(root, HOME), root).not.toThrow()
    }
  })

  it('vergleicht an der Bestandteil-Grenze, nicht auf dem Präfix des Strings', () => {
    for (const root of ['/Usersonstiges', '/etcetera', `${HOME}/.sshfs`, '/rootless/projekt']) {
      expect(() => devCheckWorkspaceRoot(root, HOME), root).not.toThrow()
    }
  })

  it('behandelt ein System-Verzeichnis, das HOME enthält, nicht als System', () => {
    // Die Filterzeile aus filesystem.rs: mit HOME=/root liegt der Arbeitsordner
    // selbst unter /root, und /root darf dann kein gesperrtes Präfix sein.
    expect(() => devCheckWorkspaceRoot('/root/projekt', '/root')).not.toThrow()
    // Als exakte Wurzel bleibt das Heimatverzeichnis trotzdem gesperrt.
    expect(() => devCheckWorkspaceRoot('/root', '/root')).toThrow(WorkspaceRootError)
    // Und für einen anderen Nutzer ist /root weiterhin gesperrt.
    expect(() => devCheckWorkspaceRoot('/root/projekt', HOME)).toThrow(WorkspaceRootError)
  })
})

describe('das Tor an der echten Tür', () => {
  it('prüft die Wurzel aus dem Request, bevor irgendein Pfad geprüft wird', () => {
    // DER BEFUND als Einzeiler: vorher gab dieser Aufruf `/etc/hosts` zurück.
    expect(() =>
      devResolveWithinJail({ path: '/etc/hosts', homeDir: HOME, workingDirectory: '/' }),
    ).toThrow(WorkspaceRootError)
    expect(() =>
      devResolveWithinJail({ path: 'id_rsa', homeDir: HOME, workingDirectory: `${HOME}/.ssh` }),
    ).toThrow(WorkspaceRootError)
    expect(() =>
      devResolveWithinJail({ path: '.zshrc', homeDir: HOME, workingDirectory: HOME }),
    ).toThrow(WorkspaceRootError)
  })

  it('meldet die Ablehnung als JailEscapeError, damit sie eine 403 wird', () => {
    // `withJsonBody` in vite.config.ts bildet JailEscapeError auf 403 ab; ohne
    // die Ableitung wäre eine abgelehnte Wurzel eine 400 mit `error`-Feld.
    const fehler = (() => {
      try {
        devResolveWithinJail({ path: 'x', homeDir: HOME, workingDirectory: '/' })
      } catch (e) {
        return e
      }
      return null
    })()
    expect(fehler).toBeInstanceOf(WorkspaceRootError)
    expect(fehler).toBeInstanceOf(JailEscapeError)
  })

  it('lässt einen erlaubten Arbeitsordner unverändert arbeiten', () => {
    expect(
      devResolveWithinJail({
        path: 'src/app.ts',
        homeDir: HOME,
        workingDirectory: '/Users/dev/projects/lu',
      }),
    ).toBe('/Users/dev/projects/lu/src/app.ts')
  })

  it('prüft den abgeleiteten Sandkasten NICHT — wie resolve_path', () => {
    // Rust ruft `check_workspace_root` nur, wenn `working_dir` gesetzt ist:
    // die per-Chat-Wurzel kommt nicht vom Aufrufer, sie wird abgeleitet.
    expect(
      devResolveWithinJail({ path: 'notiz.txt', homeDir: HOME, chatId: 'c1' }),
    ).toBe(`${HOME}/${AGENT_WORKSPACE_DIR}/c1/notiz.txt`)
    expect(
      devResolveWithinJail({ path: 'notiz.txt', homeDir: HOME, chatId: 'c1', workingDirectory: '  ' }),
    ).toBe(`${HOME}/${AGENT_WORKSPACE_DIR}/c1/notiz.txt`)
  })
})

describe('die eine bewusste Abweichung von der Rust-Vorlage', () => {
  it('ist die Allowlist der im Dialog geklickten Ordner — und sie steht begründet im Code', () => {
    // Rust hat vor `may_be_a_picked_root` noch `PICKED_ROOTS`. Der Dev-Server
    // hat keinen nativen Ordner-Dialog (`pick_folder` ist ein Tauri-Befehl),
    // kann diese Liste also nicht füllen; eine leere Allowlist wäre ein „nein"
    // auf jeden Arbeitsordner. Diese Zusicherung hält fest, dass die
    // Abweichung im Code BENANNT ist und nicht stillschweigend passiert.
    const port = readFileSync(resolve(process.cwd(), 'src/lib/dev-fs-jail.ts'), 'utf8')
    expect(port).toContain('PICKED_ROOTS')
    expect(port).toMatch(/DIE EINE BEWUSSTE ABWEICHUNG/)
    // Und in Rust gibt es sie wirklich, sonst wäre der Kommentar veraltet.
    expect(filesystemRs).toContain('static PICKED_ROOTS')
    expect(fnBody('check_workspace_root')).toContain('PICKED_ROOTS')
  })

  it('lässt einen beliebigen, nicht verbotenen Ordner zu — das ist der Preis', () => {
    // Ehrlich festgehalten statt versteckt: gegenüber dem gepackten Build bleibt
    // im Dev-Server der Fall offen, dass die Wurzel auf einen beliebigen
    // erlaubten Ordner gesetzt wird. Rust würde ihn ohne Klick ablehnen.
    expect(() => devCheckWorkspaceRoot(`${HOME}/Documents/steuer`, HOME)).not.toThrow()
  })
})
