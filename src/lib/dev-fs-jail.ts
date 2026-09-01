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
 * The jail root for a dev file op — port of `workspace_root`. A non-empty
 * `workingDirectory` (the folder the user picked) wins; otherwise the per-chat
 * sandbox `<homeDir>/<AGENT_WORKSPACE_DIR>/<chatId>`, with the id sanitised to
 * `[A-Za-z0-9_.-]` and capped at 64 chars exactly like the Rust side.
 */
export function devWorkspaceRoot(
  homeDir: string,
  chatId?: string | null,
  workingDirectory?: string | null,
): string {
  const wd = (workingDirectory ?? '').trim()
  if (wd) return lexicalNormalize(wd)
  const id = chatId || 'default'
  const safe = id
    .slice(0, 64)
    .replace(/[^A-Za-z0-9_.-]/g, '_')
  return lexicalNormalize(`${homeDir}/${AGENT_WORKSPACE_DIR}/${safe || 'default'}`)
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
