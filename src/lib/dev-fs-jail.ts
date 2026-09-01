/**
 * Path jail for the DEV SERVER's file endpoints (vite.config.ts middlewares).
 *
 * The packaged app routes every file op through Rust, where
 * `commands/filesystem.rs` resolves a path against the workspace root and then
 * `contain_within` refuses anything that escapes it. `npm run dev` in a browser
 * has no Rust, so each `/local-api/fs-*` middleware is on its own. This module
 * is the port of that boundary: same root rule (a configured workingDirectory
 * wins, otherwise `~/<AGENT_WORKSPACE_DIR>/<chatId>`), same containment rule
 * (relative paths resolve inside the root, absolute paths are accepted only
 * when they already fall inside it), same lexical `..` normalization so a path
 * that does not exist yet can still be judged.
 *
 * ZWEI TORE, NICHT EINES — das ist der Punkt, den dieser Port lange nicht
 * hatte. `filesystem.rs` schreibt den Unterschied selbst hin (`resolve_path`,
 * :359): `check_workspace_root` entscheidet, OB eine Wurzel überhaupt ein
 * Käfig sein darf, `contain_within` erst danach, ob ein Pfad darin liegt. Hier
 * stand nur das zweite Tor, und damit machte `workingDirectory: "/"` die ganze
 * Platte zur Käfigwurzel: jeder Pfad lag „innerhalb", die Prüfung war formal
 * intakt und praktisch wertlos. Am laufenden Dev-Server nachgestellt:
 * `POST /local-api/fs-read {"path":"/etc/hosts","workingDirectory":"/"}`
 * antwortete mit dem Inhalt der Datei. Das erste Tor ist jetzt
 * `devCheckWorkspaceRoot` (siehe dort, auch für die EINE bewusste Abweichung
 * von der Rust-Vorlage).
 *
 * SYMLINKS: die Prüfung war rein lexikalisch, also glaubte sie dem
 * Pfad-STRING. Ein Symlink INNERHALB des Arbeitsordners, der nach draussen
 * zeigt, liest sich als `<root>/link/datei` und besteht die Containment-Prüfung
 * — das `open()` dahinter landet trotzdem draussen. Rust hat dafür
 * `resolve_existing_prefix` und prüft in `contain_within` BEIDE Seiten
 * (lexikalisch UND aufgelöst); `containWithin` tut das jetzt auch, sobald der
 * Aufrufer einen Auflöser hereinreicht. Am laufenden Dev-Server nachgestellt:
 * `ln -s /etc <ws>/out` und `{"path":"out/hosts","workingDirectory":"<ws>"}`
 * gab den Inhalt von `/etc/hosts` zurück.
 *
 * PURE STRINGS ON PURPOSE: no `node:path`, no `node:fs`. The app tsconfig
 * carries no node types, and a helper that needs them could not live in `src`
 * next to its test. Both separators are handled because the dev server also
 * runs on Windows. DESHALB WIRD DER SYMLINK-AUFLÖSER HEREINGEREICHT
 * (`realPath`), genau wie `homeDir` hier und `net.isIP` beim SSRF-Wächter: ein
 * `import { realpathSync } from 'node:fs'` in dieser Datei wäre der Bruch mit
 * dem Haus, und der Test könnte sie nicht mehr neben sich haben.
 */

import { AGENT_WORKSPACE_DIR } from './app-identity'

/** Read cap for one dev byte-read, mirroring READ_BYTES_CAP in filesystem.rs. */
export const DEV_READ_BYTES_CAP = 16 * 1024 * 1024

/**
 * Strip duplicate drive-letter prefixes (`D:/a/D:/a/f.txt` → `D:/a/f.txt`),
 * the port of `normalize_duplicate_drive_prefix`. Windows-only in practice;
 * a posix path has no `X:` sequence to find.
 */
export function normalizeDuplicateDrivePrefix(path: string): string {
  if (path.length < 3) return path
  let lastDrive = -1
  for (let i = 1; i + 1 < path.length; i++) {
    const prev = path[i - 1]
    const next = path[i + 1]
    if (path[i] === ':' && /[a-z]/i.test(prev) && (next === '/' || next === '\\')) {
      lastDrive = i - 1
    }
  }
  return lastDrive > 0 ? path.slice(lastDrive) : path
}

/** True for `/x`, `C:/x`, `C:\x` and UNC `\\server\share`. */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false
  if (path[0] === '/' || path[0] === '\\') return true
  return /^[a-z]:[/\\]/i.test(path)
}

/**
 * Lexically resolve `.` and `..` without touching the filesystem, returning a
 * forward-slash path. Port of `lexical_normalize`: `..` pops, `.` drops, and a
 * `..` that would climb past the root is simply absorbed (matching
 * `PathBuf::pop` on an empty tail), which is what makes the containment check
 * below the real boundary rather than the normalizer.
 */
export function lexicalNormalize(path: string): string {
  const unified = path.replace(/\\/g, '/')
  const uncPrefix = unified.startsWith('//') ? '//' : ''
  const driveMatch = /^([a-z]:)\//i.exec(unified)
  const drive = driveMatch ? driveMatch[1] : ''
  const rooted = !uncPrefix && !drive && unified.startsWith('/')

  const body = unified.slice(uncPrefix.length + drive.length)
  const out: string[] = []
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  if (uncPrefix) return `//${joined}`
  if (drive) return `${drive}/${joined}`
  return rooted ? `/${joined}` : joined
}

/** Case-insensitive comparison on Windows-shaped paths, exact elsewhere. */
function compareKey(normalized: string): string {
  const trimmed = normalized.replace(/\/+$/, '')
  return /^[a-z]:/i.test(trimmed) || trimmed.startsWith('//')
    ? trimmed.toLowerCase()
    : trimmed
}

/**
 * `is_within` aus filesystem.rs, auf normalisierten Strings: `cand` IST `root`
 * oder liegt darunter, verglichen an einer Bestandteil-Grenze, damit `…/foo`
 * nie auf `…/foobar` passt.
 */
function isWithinKey(root: string, cand: string): boolean {
  const r = compareKey(root)
  const c = compareKey(cand)
  return c === r || c.startsWith(`${r}/`)
}

/** Gegenseitige Enthaltung ist Gleichheit — Rusts `same` in `may_be_a_picked_root`. */
function sameKey(a: string, b: string): boolean {
  return isWithinKey(a, b) && isWithinKey(b, a)
}

/**
 * Ein normalisierter Pfad, zerlegt in sein PRÄFIX und seine BENANNTEN
 * Bestandteile — das Gegenstück zu `Path::components()`.
 *
 * `/`, `C:/` und die UNC-Freigabe `//server/share` sind reines Präfix und haben
 * NULL benannte Bestandteile; genau darauf zählt `named_depth` in
 * filesystem.rs. Dass `//server/share` als Ganzes das Präfix ist, ist Rusts
 * Windows-Sicht (`Component::Prefix(UNC(server, share))`) — auf einem Posix-
 * Rust wären es zwei `Normal`. Diese Datei nimmt die Windows-Lesart, weil eine
 * nackte Freigabe ebenso wenig ein Projektordner ist wie `C:\`.
 */
function splitNormalized(norm: string): { prefix: string; segments: string[] } {
  if (norm.startsWith('//')) {
    const parts = norm.slice(2).split('/').filter(Boolean)
    return { prefix: `//${parts.slice(0, 2).join('/')}`, segments: parts.slice(2) }
  }
  const drive = /^([a-z]:)\/?/i.exec(norm)
  if (drive) {
    return { prefix: drive[1], segments: norm.slice(drive[0].length).split('/').filter(Boolean) }
  }
  return {
    prefix: norm.startsWith('/') ? '/' : '',
    segments: norm.split('/').filter(Boolean),
  }
}

/** Die Umkehrung von `splitNormalized`. */
function joinNormalized(prefix: string, segments: readonly string[]): string {
  const body = segments.join('/')
  if (prefix === '') return body
  if (prefix === '/') return `/${body}`
  return body ? `${prefix}/${body}` : `${prefix}/`
}

/** Zahl der BENANNTEN Bestandteile — `/` und `C:\` sind 0, `/etc` ist 1. */
export function namedDepth(path: string): number {
  return splitNormalized(lexicalNormalize(path)).segments.length
}

/**
 * Filesystem-safe folder name for a chat id — the port of
 * `agent::sanitize_chat_slug` (src-tauri/src/commands/agent.rs).
 *
 * SICHERHEIT (Audit IPC-1, kritisch) — DER PUNKT GEHÖRT HIER NICHT HINEIN.
 * Diese Funktion stand bis zu diesem Commit als
 * `id.slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, '_')` da, mit `.` in der
 * Zeichenklasse, und der Kommentar daneben behauptete „exactly like the Rust
 * side". Das war es nicht: Rust erlaubt `[A-Za-z0-9_-]`, sonst nichts.
 *
 * Mit dem Punkt überlebte eine Chat-Id von `".."` die Sanitisierung wörtlich.
 * `<workspace>/..` zeigt eine Ebene ÜBER das Workspace-Verzeichnis, und
 * `lexicalNormalize` löst das `..` auf — die KÄFIGWURZEL SELBST fiel damit auf
 * `$HOME` zusammen, und jede Containment-Prüfung danach war für das ganze
 * Heimatverzeichnis erfüllt. Am laufenden Dev-Server nachgestellt:
 * `POST /local-api/fs-write {"path":".lu-probe","chatId":".."}` antwortete mit
 * `{"status":"saved","path":"/Users/<user>/.lu-probe"}`.
 *
 * Genau dieses Loch war auf der Rust-Seite Audit IPC-1 und ist dort seit
 * langem zu; der Kommentar in agent.rs nennt `sanitize_chat_slug` deshalb
 * „the ONLY sanitiser in the tree that drops `.`". Dieser Port hatte die
 * Korrektur nie mitbekommen.
 *
 * WER HIER AUFRÄUMT UND DEN PUNKT WIEDER HINZUFÜGT, ÖFFNET IPC-1 ERNEUT. Er
 * kostet nichts: keine echte Chat-Id enthält je einen Punkt — Desktop-Slugs
 * sind `[a-z0-9-]` (`src/api/agent-context.ts::chatWorkspaceSlug`), mobile Ids
 * sind `c-<millis>-<base36>`, Konversations-Ids sind UUIDs, und der
 * Sonderschlüssel ist `__remote__`.
 *
 * ZWEI WEITERE FEINHEITEN, die derselben Sorte sind wie der Punkt:
 *
 *  - GEZÄHLT WIRD IN CODEPOINTS, nicht in UTF-16-Einheiten. Rust arbeitet auf
 *    `.chars()`, JavaScript auf `.slice()`/`.replace()` in Einheiten: ein
 *    Zeichen ausserhalb der BMP ist dort ZWEI Einheiten und wurde damit zu
 *    ZWEI Unterstrichen statt zu einem, und die 64er-Kappung schnitt an einer
 *    anderen Stelle. Ein Chat hätte im Dev-Server einen anderen Ordner
 *    bekommen als in der App. `Array.from` iteriert über Codepoints und ist
 *    deshalb das Gegenstück zu `.chars()`.
 *  - DIE KAPPUNG STEHT VOR DEM ERSETZEN, wie `.take(64)` vor `.map(…)`.
 *  - DER LEER-RÜCKFALL GILT NUR FÜR EIN LEERES ERGEBNIS. Ein Slug wie `"__"`
 *    (aus `".."`) ist ein gültiger Ordnername und muss von `default`
 *    VERSCHIEDEN bleiben, sonst teilen sich zwei verschiedene Chats ein
 *    Verzeichnis.
 *
 * Die Zusicherung dazu liest die Rust-Quelle und leitet die Erwartung daraus
 * ab: src/lib/__tests__/dev-fs-jail-slug.test.ts.
 */
export function devSanitizeChatSlug(id: string): string {
  const safe = Array.from(id)
    .slice(0, 64)
    .map((c) => (/^[A-Za-z0-9_-]$/.test(c) ? c : '_'))
    .join('')
  return safe || 'default'
}

/**
 * The jail root for a dev file op — port of `workspace_root`. A non-empty
 * `workingDirectory` (the folder the user picked) wins; otherwise the per-chat
 * sandbox `<homeDir>/<AGENT_WORKSPACE_DIR>/<chatId>`, with the id put through
 * `devSanitizeChatSlug` — the port of the sanitiser Rust uses at the same spot.
 */
export function devWorkspaceRoot(
  homeDir: string,
  chatId?: string | null,
  workingDirectory?: string | null,
): string {
  const wd = (workingDirectory ?? '').trim()
  if (wd) return lexicalNormalize(wd)
  // `chatId || 'default'` ist `chat_id.unwrap_or("default")`; ein leerer String
  // landet ohnehin über den Leer-Rückfall der Sanitisierung bei `default`.
  const safe = devSanitizeChatSlug(chatId || 'default')
  return lexicalNormalize(`${homeDir}/${AGENT_WORKSPACE_DIR}/${safe}`)
}

/** Thrown for any path that leaves the workspace root. */
export class JailEscapeError extends Error {}

/**
 * Thrown when die WURZEL selbst kein Käfig sein darf — das erste Tor.
 *
 * ABLEITUNG VON `JailEscapeError` MIT ABSICHT: `withJsonBody` in
 * vite.config.ts beantwortet `JailEscapeError` mit 403, und jeder der fünf
 * fs-Endpunkte hängt daran. Eine unabhängige Klasse hätte an fünf Stellen
 * nachgezogen werden müssen, und die eine vergessene wäre aus einer Ablehnung
 * eine 400 mit `error`-Feld geworden. Es ist derselbe Fehlerfall — „diese
 * Anfrage darf diesen Pfad nicht anfassen" — nur eine Ebene früher.
 */
export class WorkspaceRootError extends JailEscapeError {}

/**
 * Ein Symlink-Auflöser mit der Form von `fs.realpathSync`: gibt den echten
 * Pfad zurück oder WIRFT, wenn es ihn nicht gibt. Wird hereingereicht (siehe
 * Dateikopf), nie importiert.
 */
export type RealPathFn = (path: string) => string

/** Die Umgebungsangaben, die der Käfig vom Aufrufer braucht. */
export interface DevJailOptions {
  /**
   * `fs.realpathSync`. FEHLT ER, PRÜFT DER KÄFIG NUR LEXIKALISCH — dann ist
   * die Symlink-Lücke wieder offen. Optional bleibt er nur, weil die reinen
   * Pfad-Zusicherungen (und `containWithin` als Primitive) ohne Dateisystem
   * auskommen müssen; dass ihn alle sechs echten Türen mitgeben, hält
   * `src/dev/__tests__/dev-server-shape.test.ts` fest.
   */
  realPath?: RealPathFn
  /**
   * `process.env.SystemDrive` — nur unter Windows gesetzt. Rust liest dieselbe
   * Variable und fällt auf `C:` zurück (`forbidden_exact_roots`,
   * `forbidden_root_prefixes`); dieser Port tut dasselbe.
   */
  systemDrive?: string | null
}

/**
 * Verzeichnisse, die fremde Heimatverzeichnisse oder alle Laufwerke
 * enthalten — Port von `forbidden_exact_roots` (filesystem.rs:334). NUR als
 * exakte Wurzel gesperrt; die Ordner DARIN sind gewöhnliche Arbeitsordner.
 */
function forbiddenExactRoots(homeDir: string, systemDrive?: string | null): string[] {
  const drive = (systemDrive ?? 'C:').replace(/[/\\]+$/, '')
  return [
    '/Users',
    '/home',
    '/Volumes',
    '/mnt',
    '/media',
    // Rust hat diesen Eintrag hinter `#[cfg(windows)]`. Dieser Port kann nicht
    // pro Plattform übersetzt werden und führt ihn immer mit: ein Posix-Pfad
    // kann `C:/Users` nie gleichen, der Eintrag kostet dort also nichts — und
    // auf einem Windows-Dev-Server wäre sein Fehlen eine echte Lücke.
    `${drive}/Users`,
    homeDir,
  ].map((p) => lexicalNormalize(p))
}

/**
 * Verzeichnisse, die nie ein Projekt-Arbeitsordner sind, sondern nur ein Ziel —
 * Port von `forbidden_root_prefixes` (filesystem.rs:296). Als PRÄFIX gesperrt:
 * auch `/etc/nginx` ist keine Käfigwurzel.
 */
function forbiddenRootPrefixes(homeDir: string, systemDrive?: string | null): string[] {
  const drive = (systemDrive ?? 'C:').replace(/[/\\]+$/, '')
  const home = lexicalNormalize(homeDir)
  const system = [
    '/etc', '/private/etc', '/dev', '/proc', '/sys', '/boot', '/root',
    '/var/root', '/usr', '/bin', '/sbin', '/System', '/Library',
    // Wie oben: die Windows-Einträge laufen immer mit, statt hinter einem
    // `#[cfg(windows)]`, das es in TypeScript nicht gibt.
    `${drive}/Windows`, `${drive}/Program Files`, `${drive}/Program Files (x86)`,
    `${drive}/ProgramData`,
  ].map((p) => lexicalNormalize(p))
  // Ein „System"-Verzeichnis, das das Heimatverzeichnis ENTHÄLT, ist für diesen
  // Nutzer keines: mit HOME=/root (Container) liegt der Arbeitsordner selbst
  // unter /root. Wörtlich die Filterzeile aus filesystem.rs.
  const out = system.filter((p) => !isWithinKey(p, home))
  for (const rel of [
    '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config', '.lu',
    'Library/Keychains', 'AppData',
  ]) {
    out.push(lexicalNormalize(`${home}/${rel}`))
  }
  return out
}

/**
 * Die Ordner, die niemals Käfigwurzel sein dürfen, egal wie sie vorgeschlagen
 * wurden — Port von `may_be_a_picked_root` (filesystem.rs:366). Gleiche
 * Reihenfolge, gleiche Ablehnungsgründe, gleicher Meldungstext.
 */
function mayBeAPickedRoot(norm: string, homeDir: string, systemDrive?: string | null): void {
  const refuse = (why: string): never => {
    throw new WorkspaceRootError(`Not an allowed workspace folder (${why}): ${norm}`)
  }
  // `/` und `C:\` haben überhaupt keinen benannten Bestandteil.
  if (splitNormalized(norm).segments.length === 0) {
    refuse('a drive or filesystem root is not a workspace')
  }
  for (const bad of forbiddenExactRoots(homeDir, systemDrive)) {
    if (sameKey(bad, norm)) refuse('a home or mount container is not a workspace')
  }
  for (const bad of forbiddenRootPrefixes(homeDir, systemDrive)) {
    if (isWithinKey(bad, norm)) refuse('system or credential directory')
  }
}

/**
 * DARF diese vom Aufrufer gelieferte Wurzel überhaupt ein Käfig sein? — Port
 * von `check_workspace_root` (filesystem.rs:422).
 *
 * DIE EINE BEWUSSTE ABWEICHUNG, und sie ist keine Bequemlichkeit: Rust hat vor
 * `may_be_a_picked_root` noch eine ALLOWLIST — der Ordner muss im nativen
 * Dialog angeklickt worden sein (`PICKED_ROOTS`, gefüttert ausschliesslich von
 * `system::pick_folder`). Dieser Dev-Server hat keinen nativen Dialog:
 * `pick_folder` ist ein Tauri-Befehl, und `npm run dev` im Browser hat kein
 * Tauri (AgentWorkspaceDialog.tsx fängt genau das mit „Folder picker
 * unavailable (bridge offline?)" ab). Eine Allowlist, die nichts füllen kann,
 * ist keine Allowlist, sondern ein „nein" auf jeden Arbeitsordner — der
 * Dev-Server könnte dann gar keinen mehr bedienen.
 *
 * WAS DAS KOSTET, ehrlich benannt: gegenüber dem gepackten Build bleibt hier
 * der Fall offen, dass ein kompromittierter Renderer einen BELIEBIGEN, nicht
 * verbotenen Ordner (`~/Documents/steuer`) als Wurzel setzt. Was er nicht mehr
 * kann, ist die Wurzel auf `/`, `$HOME`, `/Volumes`, `~/.ssh`, `/etc` … legen —
 * und genau das war der Hebel, mit dem aus dem Käfig die ganze Platte wurde.
 * Wer den Dev-Server irgendwann mit einem echten Ordner-Dialog ausstattet,
 * gehört mit seiner Liste HIER hin, vor `mayBeAPickedRoot`.
 */
export function devCheckWorkspaceRoot(
  root: string,
  homeDir: string,
  opts?: DevJailOptions,
): void {
  const norm = lexicalNormalize(root)
  // `is_app_work_dir`: die app-eigenen Sandkästen unter `~/<AGENT_WORKSPACE_DIR>`
  // picken kann niemand, sie werden abgeleitet — Rust lässt sie deshalb VOR
  // allen weiteren Regeln durch.
  if (isWithinKey(lexicalNormalize(`${homeDir}/${AGENT_WORKSPACE_DIR}`), norm)) return
  mayBeAPickedRoot(norm, homeDir, opts?.systemDrive)
}

/**
 * Symlinks auflösen, so weit der Pfad wirklich existiert, den Rest wörtlich
 * wieder anhängen — Port von `resolve_existing_prefix` (filesystem.rs:62).
 *
 * `realpathSync` allein reicht nicht: die Hälfte der Pfade, die hier ankommen,
 * gibt es noch gar nicht (`fs-write` legt sie an). Der tiefste EXISTIERENDE
 * Vorfahre wird aufgelöst, der noch nicht existierende Schwanz bleibt stehen.
 * Ohne `realPath` gibt es nichts aufzulösen — dann ist das Ergebnis der
 * lexikalische Pfad, und `containWithin` prüft wie zuvor nur ihn.
 */
export function resolveExistingPrefix(path: string, realPath?: RealPathFn): string {
  const normalized = lexicalNormalize(path)
  if (!realPath) return normalized
  const tail: string[] = []
  let cur = normalized
  for (;;) {
    let real: string | null = null
    try {
      real = lexicalNormalize(realPath(cur))
    } catch {
      real = null // existiert (noch) nicht — eine Ebene höher versuchen
    }
    if (real !== null) {
      if (tail.length === 0) return real
      return `${real.replace(/\/+$/, '')}/${tail.slice().reverse().join('/')}`
    }
    const { prefix, segments } = splitNormalized(cur)
    // Wurzel / Präfix erreicht: nichts davon existiert.
    if (segments.length === 0) return normalized
    tail.push(segments[segments.length - 1])
    cur = joinNormalized(prefix, segments.slice(0, -1))
  }
}

/**
 * Resolve `path` inside `root` or throw. Relative paths resolve against the
 * root; absolute paths are allowed ONLY when they already sit inside it, so
 * the desktop habit of passing absolute paths within the picked project folder
 * keeps working while `../../.ssh/id_rsa` does not.
 *
 * ZWEI VERGLEICHE, wie `contain_within` in filesystem.rs (:130): einmal
 * lexikalisch und einmal auf den symlink-aufgelösten Pfaden. Der lexikalische
 * allein glaubt dem String — ein Symlink im Arbeitsordner, der nach draussen
 * zeigt, besteht ihn und führt trotzdem hinaus. BEIDE Seiten werden aufgelöst,
 * nicht nur der Kandidat: auf macOS ist schon `/tmp` ein Symlink auf
 * `/private/tmp`, ein Arbeitsordner darunter also selbst „woanders" — würde nur
 * der Kandidat aufgelöst, wäre jeder Pfad darin plötzlich ein Ausbruch.
 *
 * ZURÜCK KOMMT DER LEXIKALISCHE PFAD, nicht der aufgelöste — auch das wie
 * Rust: die Entscheidung fällt auf dem echten Ziel, die Antwort behält die
 * Schreibweise, die der Aufrufer kennt und in der Oberfläche vergleicht.
 *
 * Was das NICHT leistet, wörtlich wie in filesystem.rs: Prüfung und späteres
 * `open()` sind zwei Systemaufrufe. Wird ein Bestandteil dazwischen durch einen
 * Symlink ersetzt, entwischt er (TOCTOU); ebenso ein Hardlink im Arbeitsordner
 * auf eine Datei draussen. Beides bräuchte `openat`/`O_NOFOLLOW`, keinen
 * String-Vergleich — der Arbeitsordner gilt als nicht angreiferbeschreibbar,
 * solange eine Operation läuft.
 */
export function containWithin(root: string, path: string, realPath?: RealPathFn): string {
  const cleaned = normalizeDuplicateDrivePrefix(path)
  const nroot = lexicalNormalize(root)
  const candidate = isAbsolutePath(cleaned)
    ? lexicalNormalize(cleaned)
    : lexicalNormalize(`${nroot}/${cleaned}`)

  const within =
    isWithinKey(nroot, candidate) &&
    isWithinKey(resolveExistingPrefix(nroot, realPath), resolveExistingPrefix(candidate, realPath))
  if (within) return candidate

  throw new JailEscapeError(
    `Path escapes the allowed workspace.\n  workspace root: ${root}\n  requested path: ${path}`,
  )
}

/**
 * One call: root from the request, THE ROOT GATE, then containment.
 *
 * Die Reihenfolge ist die von `resolve_path` (filesystem.rs:359), einschliesslich
 * der Bedingung: geprüft wird die Wurzel nur, wenn sie AUS DEM REQUEST kommt
 * (`workingDirectory` nicht leer). Der abgeleitete Sandkasten
 * `~/<AGENT_WORKSPACE_DIR>/<slug>` ist keine Angabe des Aufrufers und geht
 * denselben Weg wie in Rust: ungeprüft, weil ihn niemand setzen kann.
 */
export function devResolveWithinJail(args: {
  path: string
  homeDir: string
  chatId?: string | null
  workingDirectory?: string | null
} & DevJailOptions): string {
  const root = devWorkspaceRoot(args.homeDir, args.chatId, args.workingDirectory)
  if ((args.workingDirectory ?? '').trim()) {
    devCheckWorkspaceRoot(root, args.homeDir, args)
  }
  return containWithin(root, args.path, args.realPath)
}

/**
 * The effective byte cap for one read: the caller may ask for LESS than the
 * ceiling, never more. Same `min` the Rust command applies.
 */
export function effectiveByteCap(requested?: number | null): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEV_READ_BYTES_CAP
  }
  return Math.min(requested, DEV_READ_BYTES_CAP)
}
