/**
 * The agent shell's OS sandbox, prepared and not switched on (CA, David's E3
 * of 13.11.2026: "nur vorbereiten, damit sie später ein Schalter ist").
 *
 * Claude Code and Codex run agent commands under Seatbelt on macOS (Landlock /
 * bubblewrap on Linux) with the workspace writable and the rest of the home
 * folder closed. LU's bench already does this for its own runs
 * (dev-server/bench-sandbox.ts). This module is the product side of the same
 * idea, as pure data, so the switch later is a setting plus one wrapper call in
 * src-tauri/src/commands/shell.rs and bg_tasks.rs:
 *
 *   mode 'workspace' on macOS → spawn `/usr/bin/sandbox-exec -p <profile> <shell> …`
 *
 * Nothing calls it yet. Mode 'off' is today's behaviour.
 */

export type ShellSandboxMode = 'off' | 'workspace'

/** The switch's value until David decides otherwise. */
export const DEFAULT_SHELL_SANDBOX: ShellSandboxMode = 'off'

export interface SandboxPaths {
  /** The real home folder. */
  home: string
  /** The run's working folder: readable and writable. */
  workspace: string
  /** Temp folders: readable and writable (npm, pip, compilers). */
  temp: readonly string[]
  /** Toolchains under the home (nvm, cargo, pyenv …): readable only. */
  toolchains: readonly string[]
  /** Under the home and still needed to read: ~/.gitconfig and the like. */
  readOnlyFiles?: readonly string[]
}

const q = (p: string) => JSON.stringify(p)

/**
 * A Seatbelt profile: everything allowed except reading or writing under the
 * home folder and /Volumes; inside that, the workspace and temp are open again,
 * toolchains are readable. The network stays on (package installs, git).
 * Secret files inside the workspace are still refused by name by the tool
 * guard (lib/secret-paths), before the command runs.
 */
export function seatbeltProfile(p: SandboxPaths): string {
  const readable = [...p.toolchains.map((d) => `(subpath ${q(d)})`), ...(p.readOnlyFiles ?? []).map((f) => `(literal ${q(f)})`)]
  const writable = [p.workspace, ...p.temp].map((d) => `(subpath ${q(d)})`)
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read-data file-write* (subpath ${q(p.home)}) (subpath "/Volumes"))`,
    ...(readable.length ? [`(allow file-read-data ${readable.join(' ')})`] : []),
    `(allow file-read-data file-write* ${writable.join(' ')})`,
  ].join('\n')
}

/** Whether a workspace can be fenced at all: it must not be the home itself
 *  or a parent of it (the fence would open everything again). */
export function workspaceIsFenceable(home: string, workspace: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '')
  const h = norm(home)
  const w = norm(workspace)
  return !!w && w !== h && !h.startsWith(w + '/') && w !== ''
}
