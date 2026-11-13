// REA, "Reverse Engineer Anything" (github.com/morluto/rea, MIT), as a
// plugin of the agents (3.0.7). It is a local MCP server: switched on under
// Plugins, LU starts it the way it starts every external MCP server
// (api/mcp/external-client), and its tools reach Agent and Code next to the
// built-in ones, each behind the same confirmation as any external tool.
//
// What starts is the official tarball of one version, fetched and checked
// against its registry checksum by the Rust process (commands/plugin_rea.rs)
// and checked again before every start. npx is handed that file, never a
// package name, and REA's own `setup` (which writes other apps' settings) is
// never run.

import { backendCall } from '../../api/backend'
import type { MCPServerConfig } from '../../api/mcp/types'
import { REA_SERVER_ID } from './rea-tools'

export const REA_PLUGIN = {
  id: 'rea',
  serverId: REA_SERVER_ID,
  name: 'REA',
  title: 'REA: Reverse Engineer Anything',
  version: '6.5.0',
  license: 'MIT',
  homepage: 'https://github.com/morluto/rea',
  npm: 'rea-agents',
} as const

/**
 * How long REA's first `initialize` may take. `npx` installs REA's pinned
 * dependencies before the server answers, and on the first start that is a
 * download: on the Windows box (d307-k, 19.10.2026, a slow line) it took
 * about two minutes, and the general 30 s of an MCP request ended every first
 * start with "Request initialize timed out" while a second start, from npm's
 * cache, came up in 22 s. Ten minutes covers a slow line; a server that hangs
 * is still ended by the switch, since the client is enrolled at spawn.
 */
export const REA_FIRST_START_TIMEOUT_MS = 10 * 60_000

/** What the plugin row says about the programs REA can use, and the models it
 *  suits: Qwen 3.8 27B at 64K wrote a complete answer on the real run
 *  (17.10.2026); Qwen 3.5 9B at 32K ran out of context before one. */
export const REA_TOOLS_NOTE =
  'Reads JavaScript and Electron apps, .NET, Go and Rust programs, Flutter, SQLite and WebAssembly as it is. '
  + 'Ghidra, Hopper, JADX and Frida are used where you have them installed; LU installs none of them. '
  + 'It works best with a model of about 27B and a context window of 64K or more; smaller ones often stop before an answer. '
  + 'Use it on software you own or are allowed to examine.'

/**
 * What LU found of Ghidra (commands/plugin_rea.rs, `ghidra_status_in`).
 *
 * REA uses a Ghidra the user installed. On a Mac the official download has no
 * decompiler for the machine (B11): Ghidra ships it for Windows and Linux
 * x86-64 only and asks everyone else to build it once.
 */
export interface ReaGhidra {
  found: boolean
  installDir?: string
  /** env: GHIDRA_INSTALL_DIR, path: a launcher on the PATH, folder: LU's search. */
  foundBy?: 'env' | 'path' | 'folder'
  version?: string | null
  /** The Ghidra version REA is validated against. */
  wantVersion: string
  /** Ghidra's name for this machine's native tools, e.g. mac_arm_64. */
  nativeDir: string | null
  decompiler?: string | null
  /** Found, but no decompiler for this machine: `gradle buildNatives` needed. */
  needsNatives?: boolean
  /** `<install>/support/gradle`, where Ghidra's build runs. */
  buildDir?: string
}

/** The section of the guide that walks through Ghidra on a Mac. */
export const REA_GHIDRA_GUIDE = 'https://locallyuncensored.com/guide/agent/#rea-ghidra'

/**
 * The sentence about Ghidra under the REA row, or null when there is nothing
 * to say (Ghidra ready, or the status came from an older Rust side).
 */
export function reaGhidraLine(g: ReaGhidra | null | undefined): string | null {
  if (!g) return null
  if (!g.found) {
    return g.installDir
      ? `GHIDRA_INSTALL_DIR points at ${g.installDir}, which is not a Ghidra install. Native programs need Ghidra ${g.wantVersion}.`
      : `Ghidra not found. For native programs install Ghidra ${g.wantVersion} from its official GitHub release (guide: ${REA_GHIDRA_GUIDE}).`
  }
  const which = `Ghidra ${g.version ?? '(unknown version)'} at ${g.installDir}`
  const versionNote = g.version && g.version !== g.wantVersion ? ` REA is made for Ghidra ${g.wantVersion}.` : ''
  if (g.needsNatives) {
    return `${which} has no decompiler for this computer (${g.nativeDir}). `
      + 'The official download ships it only for Windows and Linux; build it once in Terminal: '
      + `xcode-select --install, then cd "${g.buildDir}" && gradle buildNatives (needs Gradle 8.5+ and a JDK 21). `
      + `Then switch REA off and on. Guide: ${REA_GHIDRA_GUIDE}${versionNote}`
  }
  return `${which}, decompiler ready.${versionNote}`
}

/** The answer of `plugin_rea_status` / `plugin_rea_fetch`. */
export interface ReaStatus {
  version: string
  /** The pinned tarball is on disk and its checksum is the registry's. */
  ready: boolean
  tarball: string | null
  workDir: string
  /** The PATH REA gets (the user's own on a Mac), or null for the app's. */
  path: string | null
  node: string | null
  nodeOk: boolean
  nodeRange: string
  /** Since 3.0.9; missing from an older Rust side. */
  ghidra?: ReaGhidra | null
}

export function reaStatus(): Promise<ReaStatus> {
  return backendCall<ReaStatus>('plugin_rea_status')
}

/** Fetch the pinned package where it is not on disk yet (5.6 MB). */
export function reaFetch(): Promise<ReaStatus> {
  return backendCall<ReaStatus>('plugin_rea_fetch')
}

/** Every string in a tool call's arguments, at any depth. */
export function reaArgStrings(args: unknown, out: string[] = []): string[] {
  if (typeof args === 'string') out.push(args)
  else if (Array.isArray(args)) for (const a of args) reaArgStrings(a, out)
  else if (args && typeof args === 'object') for (const v of Object.values(args)) reaArgStrings(v, out)
  return out
}

/**
 * REA does not analyze LU itself (David, 27.10.2026): its app, its helper
 * programs, lu-labs.ai or LU Cloud. The Rust process decides by name, folder,
 * bundle id and the hash of LU's own programs (commands/plugin_rea.rs) and
 * answers with the one sentence the model gets instead of a result, or null.
 * A hurdle and no more: the desktop app is open source.
 */
export function reaGuard(args: unknown): Promise<string | null> {
  return backendCall<string | null>('plugin_rea_guard', { strings: reaArgStrings(args) })
}

/** Why REA cannot start with this status, or null when it can. */
export function reaNotStartable(status: ReaStatus): string | null {
  // Where LU looked, so "node -v works in my terminal" has an answer (A37):
  // a Linux app started from the menu does not read ~/.bashrc, where nvm and
  // fnm put their lines.
  if (!status.node) return `REA needs Node.js (${status.nodeRange}), and none was found: not on the PATH LU was started with, not in the folders of nvm, fnm, Volta, asdf, mise or nodenv, and not in your login shell. If node -v works in a terminal, start LU from that terminal once, or install Node.js from nodejs.org. Then switch REA on again.`
  if (!status.nodeOk) return `REA needs Node.js ${status.nodeRange}; this computer has ${status.node}. Update Node.js, then switch REA on again.`
  if (!status.ready || !status.tarball) return 'The REA package is not on this computer yet, or it was changed. Switch REA on again to fetch the official one.'
  return null
}

/**
 * The server LU starts for REA, from a status that can start it.
 *
 * `--package=<file>` hands npx the checked tarball; the dependencies it
 * names are pinned to exact versions in its package.json. Install scripts
 * stay off: REA's own package has none, and nothing it pulls in needs one to
 * serve MCP. It works in the plugin's folder, so whatever it writes lands
 * there and nowhere else.
 */
export function reaServerConfig(status: ReaStatus): MCPServerConfig {
  const why = reaNotStartable(status)
  if (why) throw new Error(why)
  const env: Record<string, string> = {
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    // Its log goes to stderr; warnings and errors are what LU keeps.
    REA_LOG_LEVEL: 'warn',
  }
  if (status.path) env.PATH = status.path
  // A Ghidra LU found in a folder is one REA would not find on its own: a
  // Finder start has no GHIDRA_INSTALL_DIR and no terminal PATH (B11).
  if (status.ghidra?.found && status.ghidra.installDir && status.ghidra.foundBy === 'folder') {
    env.GHIDRA_INSTALL_DIR = status.ghidra.installDir
  }
  return {
    id: REA_PLUGIN.serverId,
    name: REA_PLUGIN.name,
    command: 'npx',
    args: ['--yes', `--package=${status.tarball}`, '--', 'rea', 'mcp'],
    env,
    cwd: status.workDir,
    initializeTimeoutMs: REA_FIRST_START_TIMEOUT_MS,
    enabled: true,
  }
}
