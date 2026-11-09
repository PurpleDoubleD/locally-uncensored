/**
 * The agent bench's hard fence (C59, Zentrale 09.11.2026).
 *
 * A bench run works in Bypass, and a shell command can go anywhere the user
 * can: in the first run a 27B searched the disk for a folder and named files
 * from the user's Desktop. With LU_BENCH_SANDBOX=1 (set by
 * playwright.agent-live.config.ts, not switchable off there) every shell
 * command of the dev server runs under macOS sandbox-exec: nothing under the
 * real home folder and nothing under /Volumes can be read or written, except
 * the toolchains a task needs (node, python) for reading. The workspace lives
 * outside the home folder (the bench's own HOME), so it stays writable.
 *
 * The file tools need no fence of their own here: the dev server's path jail
 * (lib/dev-fs-jail.ts) already keeps them inside the chat's workspace.
 *
 * Fails closed: asked for a sandbox where there is none, the command is
 * refused instead of run unfenced.
 */
import { existsSync } from 'fs'
import os from 'os'
import { dirname, sep } from 'path'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

const q = (p: string) => JSON.stringify(p)

/** Folders under the home that hold a toolchain: readable, never writable. */
export function toolchainDirs(realHome: string, execPath = process.execPath): string[] {
  const dirs = ['.nvm', '.local', '.cargo', '.rustup', '.pyenv', '.volta', '.bun'].map((d) => `${realHome}${sep}${d}`)
  // node itself, wherever it lives under the home (nvm, fnm, asdf …).
  const nodeRoot = dirname(dirname(execPath))
  if (nodeRoot.startsWith(realHome + sep)) dirs.push(nodeRoot)
  return dirs
}

export function benchSandboxProfile(realHome: string, readable: string[]): string {
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read-data file-write* (subpath ${q(realHome)}) (subpath "/Volumes"))`,
    ...(readable.length ? [`(allow file-read-data ${readable.map((d) => `(subpath ${q(d)})`).join(' ')})`] : []),
  ].join('\n')
}

export type Fenced = { bin: string; args: string[] } | { refused: string }

/** The command line for one shell command: fenced when the bench asks for it. */
export function fenceShell(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform = process.platform): Fenced {
  if (env.LU_BENCH_SANDBOX !== '1') return { bin, args }
  if (platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
    return { refused: 'The bench sandbox is on, but this machine has no sandbox-exec. Nothing was run.' }
  }
  // The REAL home: the bench sets HOME to its own folder.
  const realHome = os.userInfo().homedir
  return { bin: SANDBOX_EXEC, args: ['-p', benchSandboxProfile(realHome, toolchainDirs(realHome)), bin, ...args] }
}
