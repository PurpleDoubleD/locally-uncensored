/**
 * Which `bash` a test may hand to execFileSync.
 *
 * Not a test itself — vitest only collects `*.test.ts` (see vitest.config.ts),
 * so this sits next to the tests that need it without being run as one.
 *
 * macOS/Linux: plain `bash` off PATH, exactly as before.
 *
 * Windows: a bare `bash` is NOT usable and this is the whole reason the file
 * exists. On a stock Windows 10/11, PATH resolves `bash` to
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` — the WSL app-execution-alias
 * stub, a zero-length reparse point, not a shell. `existsSync` says yes and
 * `where bash` prints it, but with no WSL distro registered CreateProcess
 * refuses it outright ("Das System kann auf die Datei nicht zugreifen",
 * ApplicationFailedException / NativeCommandFailed), so every
 * execFileSync('bash', ...) dies before a shell is ever reached — which is what
 * used to redden this file's tests on Windows while the code under test was
 * fine. Git for Windows always installs a real bash alongside git, so resolve
 * that deterministically and drop every WindowsApps candidate on the floor.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const BASH_EXE = 'bash.exe'

/** `...\WindowsApps\bash.exe` is the WSL alias stub — never an actual shell. */
function isWslAliasStub(candidate: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(candidate)
}

/** `where` on Windows, one absolute path per line; missing program = no lines. */
function whereOnPath(program: string): string[] {
  try {
    const out = execFileSync('where', [program], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Every place a real bash could be, most trustworthy first. Nothing here is
 * machine-specific: git's own location is the primary source, the install
 * roots are only the fallback for a git that is not on PATH.
 */
function windowsCandidates(): string[] {
  const seen: string[] = []
  const add = (candidate: string) => {
    if (!seen.includes(candidate)) seen.push(candidate)
  }

  // 1. Derive it from git. Git for Windows ships bash in the same install, so
  //    `where git` -> ...\Git\cmd\git.exe pins down ...\Git\bin\bash.exe. Walk
  //    up a few levels instead of assuming `cmd\`, because git.exe also lives
  //    under mingw64\bin in some layouts.
  for (const gitExe of whereOnPath('git')) {
    let dir = dirname(gitExe)
    for (let up = 0; up < 3; up++) {
      dir = dirname(dir)
      add(join(dir, 'bin', BASH_EXE))
      add(join(dir, 'usr', 'bin', BASH_EXE))
    }
  }

  // 2. The documented install roots, for a git that is not on PATH at all.
  const localPrograms = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs')
    : undefined
  for (const root of [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    localPrograms,
  ]) {
    if (!root) continue
    add(join(root, 'Git', 'bin', BASH_EXE))
    add(join(root, 'Git', 'usr', 'bin', BASH_EXE))
  }

  // 3. Whatever PATH itself offers, last — and only after the stub filter, so
  //    a WSL alias can never win just because it happens to be first on PATH.
  for (const onPath of whereOnPath('bash')) add(onPath)

  return seen
}

let resolved: string | undefined

/** The bash to spawn. Throws on Windows if no real one is installed. */
export function bashInterpreter(): string {
  if (resolved !== undefined) return resolved
  if (process.platform !== 'win32') {
    resolved = 'bash'
    return resolved
  }

  const candidates = windowsCandidates()
  const usable = candidates.find((c) => !isWslAliasStub(c) && existsSync(c))
  if (!usable) {
    throw new Error(
      'no usable bash found on Windows. The `bash` on PATH is the WSL ' +
        'app-execution-alias stub under WindowsApps, which cannot run without ' +
        'a registered WSL distro, so it is deliberately ignored. Install Git ' +
        'for Windows (https://git-scm.com/download/win, or `winget install ' +
        '--id Git.Git`), which ships Git Bash. Checked:\n' +
        candidates.map((c) => `  ${c}${isWslAliasStub(c) ? '  (WSL stub, skipped)' : ''}`).join('\n'),
    )
  }
  resolved = usable
  return resolved
}
