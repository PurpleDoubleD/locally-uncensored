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
 * PURE STRINGS ON PURPOSE: no `node:path`, no `node:fs`. The app tsconfig
 * carries no node types, and a helper that needs them could not live in `src`
 * next to its test. Both separators are handled because the dev server also
 * runs on Windows.
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
 * Resolve `path` inside `root` or throw. Relative paths resolve against the
 * root; absolute paths are allowed ONLY when they already sit inside it, so
 * the desktop habit of passing absolute paths within the picked project folder
 * keeps working while `../../.ssh/id_rsa` does not.
 */
export function containWithin(root: string, path: string): string {
  const cleaned = normalizeDuplicateDrivePrefix(path)
  const nroot = lexicalNormalize(root)
  const candidate = isAbsolutePath(cleaned)
    ? lexicalNormalize(cleaned)
    : lexicalNormalize(`${nroot}/${cleaned}`)

  const r = compareKey(nroot)
  const c = compareKey(candidate)
  if (c === r || c.startsWith(`${r}/`)) return candidate

  throw new JailEscapeError(
    `Path escapes the allowed workspace.\n  workspace root: ${root}\n  requested path: ${path}`,
  )
}

/** One call: root from the request, then containment. Throws on escape. */
export function devResolveWithinJail(args: {
  path: string
  homeDir: string
  chatId?: string | null
  workingDirectory?: string | null
}): string {
  const root = devWorkspaceRoot(args.homeDir, args.chatId, args.workingDirectory)
  return containWithin(root, args.path)
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
