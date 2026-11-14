/**
 * The agent's shell stays inside its folder (CA, 14.11.2026, AG10).
 *
 * The file tools were always jailed to the workspace by the backend
 * (filesystem.rs, "Path escapes the allowed workspace"). The shell was not: it
 * starts in the folder, and from there a command can read anything the user
 * can. In a measured run (DeepSeek v4.1 Flash, AG10) a model that could not
 * find a fact in its memory spent 32 minutes on `find / -maxdepth 6`,
 * `ls /Users/<name>`, greps through ~/Library/Application Support and
 * `ps aux`, then gave no answer at all.
 *
 * This is the front gate for that: before a command runs, every path in it is
 * looked at. Home (`~`, `$HOME`, `%USERPROFILE%`), the file-system root and
 * absolute paths outside the folder are refused, unless the user allowed the
 * agent outside its folder in Settings → Agent. Absolute paths are judged by
 * the same backend jail the file tools use, so "inside" means exactly the
 * same thing for both.
 *
 * It reads the command, it does not sandbox the process: a command that hides
 * a path from it (built from variables, base64) still runs. It stops what the
 * models actually do, which is to type the path.
 */

/** Where a command may point without asking: devices, temp, system programs. */
const ALWAYS_FINE = [
  /^\/dev\/(null|stdin|stdout|stderr|tty|zero|u?random)$/,
  /^\/(private\/)?tmp(\/|$)/,
  /^\/var\/folders\//,
  /^\/(usr\/(local\/)?|opt\/homebrew\/)?s?bin\//,
  /^\/usr\/bin\/env$/,
]

/** A quoted string that starts with one of these is a path, not a pattern. */
const SYSTEM_TOP = /^\/(Users|home|root|Volumes|mnt|media|etc|var|private|Library|System|Applications|opt|srv|proc|sys)(\/|$)/

const HOME_REF = /(^|[\s=:"'(])~(?=[/\s"')]|$)|\$\{?HOME\}?|%USERPROFILE%|%HOMEPATH%|%APPDATA%|%LOCALAPPDATA%|\$env:(USERPROFILE|HOME|APPDATA|LOCALAPPDATA)/i

export interface OutsideReach {
  /** What the command points at, as the model wrote it. */
  path: string
  why: 'home' | 'root' | 'outside'
}

/** Words of a command with their quoting kept apart. Rough on purpose. */
function words(command: string): Array<{ text: string; quoted: boolean }> {
  const out: Array<{ text: string; quoted: boolean }> = []
  const re = /"([^"]*)"|'([^']*)'|([^\s;|&()<>]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command))) {
    if (m[1] !== undefined) out.push({ text: m[1], quoted: true })
    else if (m[2] !== undefined) out.push({ text: m[2], quoted: true })
    else out.push({ text: m[3], quoted: false })
  }
  return out
}

/** The path inside a word: the word itself, or what follows `--opt=` / `-I`. */
function pathIn(word: string): string | null {
  const w = word.replace(/^[0-9]?>>?/, '')
  const eq = w.match(/^-{1,2}[\w-]+=(.+)$/)
  const v = eq ? eq[1] : w
  if (/^\/|^[A-Za-z]:[\\/]|^\\\\/.test(v)) return v
  if (/(^|[\\/])\.\.([\\/]|$)/.test(v)) return v
  return null
}

/**
 * Paths in a command that point outside the folder for sure (home, root), and
 * candidates the backend jail has to judge (absolute paths, `..`).
 */
export function scanShellPaths(command: string): { sure: OutsideReach[]; check: string[] } {
  const sure: OutsideReach[] = []
  const check: string[] = []
  const home = command.match(HOME_REF)
  if (home) sure.push({ path: home[0].trim(), why: 'home' })
  for (const { text, quoted } of words(command)) {
    const p = pathIn(text)
    if (!p) continue
    if (p === '/' || /^[A-Za-z]:[\\/]?$/.test(p)) { sure.push({ path: p, why: 'root' }); continue }
    if (ALWAYS_FINE.some((r) => r.test(p))) continue
    // A quoted "/api/v1" is a search pattern far more often than a path.
    if (quoted && p.startsWith('/') && !SYSTEM_TOP.test(p)) continue
    // URLs are not paths.
    if (/^[a-z]+:\/\//i.test(p)) continue
    check.push(p)
  }
  return { sure, check: [...new Set(check)] }
}

/**
 * The first place the command reaches outside the folder, or null.
 * `isOutside` is the backend jail's answer for one path (relative paths are
 * taken from `cwd` when the command runs in a subfolder).
 */
export async function shellReachOutside(
  command: string,
  isOutside: (path: string) => Promise<boolean>,
  cwd?: string,
): Promise<OutsideReach | null> {
  const { sure, check } = scanShellPaths(command)
  if (sure.length) return sure[0]
  for (const p of check) {
    const full = cwd && !/^\/|^[A-Za-z]:[\\/]|^\\\\/.test(p) ? `${cwd.replace(/[\\/]+$/, '')}/${p}` : p
    if (await isOutside(full)) return { path: p, why: 'outside' }
  }
  return null
}

/** What the model reads when the gate refuses. Tells it to stop looking. */
export function outsideRefusal(reach: OutsideReach): string {
  const where = reach.why === 'home' ? 'the home folder' : reach.why === 'root' ? 'the whole disk' : `"${reach.path}", outside your folder`
  return `Refused: this command reaches ${where}. You work only inside your folder; the user can allow more in Settings → Agent. `
    + 'Use paths inside the folder. If what you need is not there, stop searching and say so in your answer.'
}

/**
 * Python code for code_execute, the same idea: the home folder and absolute
 * system paths typed into the code.
 */
export function scanCodePaths(code: string): OutsideReach | null {
  const home = code.match(/expanduser\(|Path\.home\(|os\.environ(\.get)?\(?\[?["']HOME["']|getenv\(["']HOME["']|\$\{?HOME\}?|["']~\//)
  if (home) return { path: home[0], why: 'home' }
  const re = /["'](\/[^"'\n]*)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const p = m[1]
    if (p === '/') return { path: p, why: 'root' }
    if (SYSTEM_TOP.test(p) && !ALWAYS_FINE.some((r) => r.test(p))) return { path: p, why: 'outside' }
  }
  return null
}

/** Shell timeouts (CA, 14.11.2026): a model asked for 600 s per `find /`. */
export const SHELL_TIMEOUT_DEFAULT_MS = 120_000
/** Test runs keep their longer budget; nothing else gets more than this. */
export const SHELL_TIMEOUT_MAX_MS = 120_000
export const TEST_RUN_TIMEOUT_MAX_MS = 300_000

/**
 * The timeout a command runs with. What the model asks for is a wish below the
 * cap; a recognised test run may use the test budget.
 */
export function cappedShellTimeout(requested: number | undefined, kindDefault: number): number {
  const isTestBudget = kindDefault > SHELL_TIMEOUT_DEFAULT_MS
  const cap = isTestBudget ? TEST_RUN_TIMEOUT_MAX_MS : SHELL_TIMEOUT_MAX_MS
  const want = requested && requested > 0 ? requested : kindDefault
  return Math.min(Math.max(want, 1_000), cap)
}
