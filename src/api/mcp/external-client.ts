/**
 * MCP External Client — connects to external MCP servers via stdio JSON-RPC.
 *
 * Uses @tauri-apps/plugin-shell to spawn server processes
 * and communicate via stdin/stdout JSON-RPC 2.0.
 */

import type { Child } from '@tauri-apps/plugin-shell'
import type { MCPToolDefinition, MCPServerConfig, ToolArgs } from './types'
import { log } from '../../lib/logger'
import { isTauri } from '../backend'
import { isRecord, prop, asString, asNumber, asRecordArray, errorText } from '../../types/json-guards'

// ── JSON-RPC message types ──────────────────────────────────────
//
// Everything arriving on stdout was written by a THIRD-PARTY process. The
// request side we build ourselves and can type exactly; the response side is
// `unknown` until `parseJsonRpcResponse` below has looked at it.

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  /** Absent on a notification — the server may talk without being asked. */
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Human-readable text for whatever a server put in `error`.
 *
 * The spec says an object with a `message`; real servers also send a bare
 * string, and one sends a number. Since this text is the ONLY thing the user
 * ever learns about the failure, a non-conforming value is rendered rather
 * than discarded — that is strictly better than the `Error: undefined` the
 * pre-typing code produced for exactly these lines.
 */
function jsonRpcErrorMessage(raw: unknown): string {
  if (isRecord(raw)) {
    const msg = asString(raw.message)
    if (msg) return msg
  }
  return errorText(raw) || 'MCP server reported an error'
}

/**
 * Narrow one parsed stdout line to a JSON-RPC response, or give up.
 *
 * Only the fields this client actually reads are required to be well-formed:
 * an `id` that can address a pending request, and an `error` — which is
 * honoured whenever it is PRESENT, whatever its shape. That is the load-bearing
 * rule here: a server that answers `"error": "boom"` has failed, and treating
 * the line as anything but a rejection would resolve the pending request with
 * `undefined` and tell the model the tool ran. Only `undefined`/`null` — i.e.
 * no error at all — is a success.
 *
 * Anything that is not a record, or carries no usable `id`, is a notification
 * or noise and is ignored.
 */
function parseJsonRpcResponse(v: unknown): JsonRpcResponse | null {
  if (!isRecord(v)) return null
  const id = asNumber(v.id)
  const rawError = v.error
  let error: JsonRpcResponse['error']
  if (rawError != null) {
    error = {
      code: (isRecord(rawError) ? asNumber(rawError.code) : undefined) ?? 0,
      message: jsonRpcErrorMessage(rawError),
      data: isRecord(rawError) ? rawError.data : rawError,
    }
  }
  return { jsonrpc: '2.0', id, result: v.result, error }
}

/**
 * Does this look like the JSON-Schema object a tool's `inputSchema` must be?
 *
 * Checked at the boundary: it is an object, its `type` says `'object'`, its
 * `properties` is an object, and `required` — when present — is an array of
 * strings. The property schemas INSIDE are deliberately not re-validated:
 * `inputSchema` is forwarded verbatim to the model as the tool's `parameters`,
 * and a real MCP server may legitimately use `anyOf` / `oneOf` / `$ref`, which
 * `JSONSchemaProp` does not model. Rewriting those would change what the model
 * is told the tool takes; dropping them would be worse.
 *
 * A server that sends a string, an array or a `properties: []` there gets the
 * empty schema below instead — previously that value went straight into the
 * prompt.
 */
function isToolInputSchema(v: unknown): v is MCPToolDefinition['inputSchema'] {
  if (!isRecord(v)) return false
  if (v.type !== 'object') return false
  if (!isRecord(v.properties)) return false
  if (v.required !== undefined
      && !(Array.isArray(v.required) && v.required.every((r) => typeof r === 'string'))) return false
  return true
}

/** The schema a tool gets when the server did not send a usable one. */
const EMPTY_INPUT_SCHEMA: MCPToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {},
  required: [],
}

/**
 * Every client that currently owns a live server process (T-53).
 *
 * The only other place a connected client was ever held is a `Map` private to
 * `components/settings/MCPServerSettings.tsx:9`. That map dies with the module
 * — a webview reload empties it — and nothing outside that component could
 * ever reach it, so "disconnect everything" was not expressible anywhere in
 * the app. The set lives HERE, next to the spawn, on purpose: a client that
 * starts a process registers itself in the same method that starts it, so a
 * future second caller of `connect()` cannot forget to enrol. That is the
 * difference between one path and two.
 *
 * Membership is exactly "has a child process": added when `connect()` has a
 * spawned child, removed by `disconnect()`, by the process's own `close`
 * event, and on a failed handshake.
 */
const liveClients = new Set<MCPExternalClient>()

/** How many external MCP server processes this app currently owns. */
export function liveExternalServerCount(): number {
  return liveClients.size
}

/**
 * Disconnect every connected external MCP server. The ONE cleanup path —
 * `api/mcp/shutdown.ts` decides when it runs, this decides what it does.
 *
 * Resolves to the number of clients it took down. Never rejects: one server
 * that will not die must not stop the next one, and the caller is usually a
 * page-unload handler where a rejection is an unhandled one.
 *
 * The catch below is a guarantee, not a currently reachable branch —
 * `disconnect()` swallows its own `kill()` failure ("Process may already be
 * dead") and today has no other way to throw. It is here so that the contract
 * survives a future `disconnect()` that does, and no test claims to exercise
 * it.
 */
export async function disconnectAllExternalServers(): Promise<number> {
  const clients = [...liveClients]
  await Promise.all(clients.map(async (c) => {
    try {
      await c.disconnect()
    } catch (err) {
      log.warn('[MCP] a server did not disconnect cleanly', { err: String(err) })
    }
  }))
  return clients.length
}

export class MCPExternalClient {
  /**
   * The Child that spawn() hands back — owns stdin and kill(). The Command
   * owns the stdout/stderr/close events instead; these live on two different
   * objects in @tauri-apps/plugin-shell, and keeping only the Command meant
   * `stdin.write` hit undefined on the very first request: every external
   * server failed to connect with "Cannot read properties of undefined
   * (reading 'write')".
   */
  private child: Child | null = null
  private requestId = 0
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private outputBuffer = ''
  private connected = false
  /** True while OUR disconnect() is taking the process down, so the close
   *  handler can tell a deliberate shutdown from a server that died. */
  private closingOnPurpose = false
  /** True once connect() has HANDED BACK tools, i.e. once somebody registered
   *  them. A process that dies during the handshake is already reported by the
   *  connect() rejection; announcing it twice would have the panel undo a
   *  registration that never happened. */
  private registered = false

  /**
   * Called once when the server process exits WITHOUT us asking it to.
   *
   * Until now that event only flipped a private boolean: the server's tools
   * stayed registered, the settings panel stayed green, and the model kept
   * being offered tools whose process was gone — every call failing with
   * "Not connected" for as long as the app stayed open. The owner of the
   * registration is the only one who can undo it, so it gets told.
   */
  private onExit?: (serverId: string) => void

  private readonly config: MCPServerConfig

  constructor(config: MCPServerConfig, opts?: { onExit?: (serverId: string) => void }) {
    this.config = config
    this.onExit = opts?.onExit
  }

  async connect(): Promise<MCPToolDefinition[]> {
    try {
      // Lazy so the plugin only loads once a server connects, but vite must
      // resolve and bundle it: with @vite-ignore the packaged WebView gets a
      // bare specifier and every connect dies on the import itself (D#90).
      const shellModule = await import('@tauri-apps/plugin-shell')
      const { Command } = shellModule

      // Windows gotcha: npm-family launchers exist only as `.cmd` shims
      // (npx.cmd) while node/deno/bun ship a real .exe, and tools like pnpm
      // exist as either depending on how they were installed. Rust's spawn
      // finds .exe from the bare name but never resolves .cmd, so neither a
      // blanket rewrite nor the bare name alone works for every install.
      // Try the likelier candidate first and fall back to the other.
      // Vor dem Versuch, nicht danach: ein Start, den dieses Fenster gar nicht
      // darf, scheitert mit Tauris Bereichsmeldung, und die erklaert dem
      // Nutzer nichts ueber seinen eigenen Eintrag.
      if (!isStartableMcpCommand(this.config.command)) {
        throw new Error(notStartableMessage(this.config.name, this.config.command))
      }
      const candidates = commandCandidatesForPlatform(this.config.command)
      let spawnError: unknown = null
      for (const program of candidates) {
        const command = Command.create(program, this.config.args, {
          env: this.config.env,
        })

        // Handle stdout — parse JSON-RPC responses
        command.stdout.on('data', (data: string) => {
          this.outputBuffer += data
          this.processBuffer()
        })

        command.stderr.on('data', (data: string) => {
          log.warn(`[MCP:${this.config.name}] stderr`, { data })
        })

        command.on('close', () => {
          const wasConnected = this.connected
          this.connected = false
          this.child = null
          // The process is gone: nothing left for a shutdown sweep to kill.
          liveClients.delete(this)
          this.rejectAllPending('Server process exited')
          // A crash, an OOM kill, a server that quits on a bad config: the
          // tools it registered are dead weight from this moment on, and the
          // only honest UI is one that says so.
          if (wasConnected && this.registered && !this.closingOnPurpose) {
            log.warn(`[MCP:${this.config.name}] server process exited unexpectedly`, { id: this.config.id })
            this.onExit?.(this.config.id)
          }
        })

        try {
          this.child = await command.spawn()
          spawnError = null
          break
        } catch (err) {
          spawnError = err
        }
      }
      if (!this.child) throw spawnError
      this.connected = true
      // Enrolled the moment a process exists, not once the handshake is
      // through: a server that spawns and then hangs in `initialize` is
      // exactly the one a shutdown has to be able to kill. The catch below
      // removes it again if the handshake fails outright.
      liveClients.add(this)

      // Initialize the MCP connection
      await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'locally-uncensored', version: '2.3.0' },
      })

      // Discover tools
      const toolsResult = await this.sendRequest('tools/list', {})
      const tools: MCPToolDefinition[] = []
      for (const t of asRecordArray(prop(toolsResult, 'tools'))) {
        const toolName = asString(t.name)
        // A tool with no name cannot be looked up, called or unregistered — it
        // used to land in the registry under the key `undefined`.
        if (!toolName) {
          log.warn(`[MCP:${this.config.name}] ignoring a tool with no name in tools/list`)
          continue
        }
        tools.push({
          name: toolName,
          description: asString(t.description) || '',
          inputSchema: isToolInputSchema(t.inputSchema) ? t.inputSchema : EMPTY_INPUT_SCHEMA,
          category: 'workflow', // External tools default to workflow category
          source: 'external',
          serverId: this.config.id,
        })
      }

      this.registered = true
      return tools
    } catch (err) {
      this.connected = false
      // A failure after spawn (handshake refused, tools/list timed out) leaves
      // the server process running with nobody holding a handle to it — the
      // caller never gets a client it could disconnect. Take it down here.
      await this.killServerProcess()
      liveClients.delete(this)
      throw new Error(`Failed to connect to MCP server "${this.config.name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async callTool(name: string, args: ToolArgs): Promise<string> {
    if (!this.connected) throw new Error('Not connected')

    const result = await this.sendRequest('tools/call', { name, arguments: args })

    // MCP returns a content array of `{ type, ... }` blocks.
    const content = prop(result, 'content')
    if (Array.isArray(content)) {
      return content
        .map((c: unknown) => {
          const type = prop(c, 'type')
          if (type === 'text') return asString(prop(c, 'text')) ?? ''
          if (type === 'image') return `[Image: ${String(prop(c, 'mimeType'))}]`
          return JSON.stringify(c)
        })
        .join('\n')
    }
    return JSON.stringify(result)
  }

  async disconnect() {
    this.closingOnPurpose = true
    this.connected = false
    // Out of the shutdown sweep first: a disconnect that is itself running
    // inside the sweep must not be reachable a second time.
    liveClients.delete(this)
    this.rejectAllPending('Disconnecting')
    await this.killServerProcess()
  }

  /**
   * Take the server process down — the whole tree, not just the shim (T-68).
   *
   * The one place this client kills anything. Both callers (a failed handshake
   * in `connect()`, and `disconnect()`) used to run `this.child.kill()`
   * themselves, and that call is NOT a tree kill:
   * `tauri-plugin-shell`'s `CommandChild::kill` is one signal to the DIRECT
   * child (`src/process/mod.rs:78`). An MCP server started as `npx -y <pkg>`
   * — or `npx.cmd` through cmd.exe on Windows — has the launcher as that
   * direct child and the real `node` server as a GRANDCHILD. Killing the shim
   * reaped the launcher and left the server running for the rest of the
   * session, unreachable: the JS handle was gone with it.
   *
   * ── The ordering is the whole point ─────────────────────────────────────
   *
   * `kill_process_tree` is called INSTEAD of `child.kill()`, never after it.
   * The Rust guard (`may_kill_pid`) only allows pids inside this app's own
   * subtree, and that is exactly what the direct child's death destroys: the
   * moment the launcher exits, its children are reparented to init, stop being
   * our descendants, and the guard refuses — correctly, and too late. Kill the
   * shim first and the tree kill can no longer reach anything.
   *
   * The tree kill covers the direct child too (`kill_pid_tree`'s snapshot
   * includes the root), so nothing is left for a follow-up kill to do. Not
   * calling the plugin's own `kill` command also does not strand the pid in
   * its child map: the plugin removes an entry when it sees `Terminated`
   * (`src/commands.rs:259`), which is what the tree kill causes.
   *
   * ── When the command is not there or says no ────────────────────────────
   *
   * Two ways to land in the fallback, both real: a Rust side older than
   * `c5773322` has no such command, and the guard refuses a pid that is not
   * ours — which happens when the process already exited on its own, so its
   * pid is not in this app's subtree any more. In both the alternative to
   * `child.kill()` is leaving a server process running, i.e. exactly the
   * pre-T-53 bug; so we fall back and say so in the log. What the fallback
   * can lose is grandchildren — the leak this method exists to close — and
   * nothing beyond that.
   *
   * Outside Tauri there is no IPC to ask, and no MCP server either: the spawn
   * goes through the shell plugin, which needs the same IPC. The check is
   * synchronous on purpose, so the no-Tauri case does not pay for a dynamic
   * import (a page-unload sweep is counted in ticks) and does not log a
   * warning about a tree kill nobody could have wanted.
   *
   * Best-effort throughout: `disconnect()` is reached from a page-unload sweep
   * where a rejection is an unhandled one.
   */
  private async killServerProcess(): Promise<void> {
    const child = this.child
    if (!child) return
    // Dropped before the awaits: a second disconnect (the sweep racing a
    // panel click) must not issue a second kill for the same pid — by then it
    // may belong to somebody else.
    this.child = null
    const pid = child.pid

    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('kill_process_tree', { pid })
        return
      } catch (err) {
        log.warn(
          `[MCP:${this.config.name}] no process-tree kill available — killing only the direct `
          + 'child, so a server that spawned its own processes may leave them running',
          { pid, err: errorText(err) },
        )
      }
    }

    try {
      await child.kill()
    } catch {
      // Process may already be dead
    }
  }

  isConnected() {
    return this.connected
  }

  // ── Private ─────────────────────────────────────────────────

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('Not connected'))
        return
      }
      const id = ++this.requestId
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`Request ${method} timed out`))
        }
      }, 30000)

      this.pendingRequests.set(id, { resolve, reject, timer })

      // Child.write is async: a failed write has to fail the request instead
      // of becoming an unhandled rejection and letting it sit for 30 s.
      const msg = JSON.stringify(request) + '\n'
      Promise.resolve(this.child.write(msg)).catch((err: unknown) => {
        if (this.pendingRequests.delete(id)) {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  private processBuffer() {
    const lines = this.outputBuffer.split('\n')
    this.outputBuffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        // Not JSON — a server that logs to stdout, ignore.
        continue
      }
      const response = parseJsonRpcResponse(parsed)
      if (!response || response.id === undefined) continue // notification or noise
      const pending = this.pendingRequests.get(response.id)
      if (pending) {
        this.pendingRequests.delete(response.id)
        clearTimeout(pending.timer)
        if (response.error) {
          pending.reject(new Error(response.error.message))
        } else {
          pending.resolve(response.result)
        }
      }
    }
  }

  private rejectAllPending(reason: string) {
    const pending = [...this.pendingRequests.values()]
    this.pendingRequests.clear()
    for (const { reject, timer } of pending) {
      clearTimeout(timer)
      reject(new Error(reason))
    }
  }
}

/**
 * Spawn candidates for a configured command, in the order worth trying.
 * On Windows a bare name can resolve to an .exe (node, deno, native bun)
 * or exist only as a .cmd shim (npx, npm, or an npm-installed pnpm), so
 * both spellings are returned with the likelier one first. Commands with
 * an extension or a path separator are returned as-is.
 */
/**
 * Die Programme, mit denen dieses Fenster ueberhaupt einen Prozess starten
 * darf.
 *
 * Die Wahrheit steht in `src-tauri/capabilities/default.json` unter
 * `shell:allow-spawn`, und nur dort: die Liste HIER ist eine Kopie, damit die
 * App vor dem Start sagen kann, warum ein Server nicht laeuft. Dass beide
 * gleich sind, haelt ein Test fest
 * (`__tests__/nur-zwei-starter.test.ts`), sonst waere es das teuerste Muster
 * im Haus.
 *
 * Warum nur diese zwei: bis 2.6.8 standen hier zwanzig Eintraege, darunter
 * node, python, deno, bun und docker. Jedes davon nimmt einen Einzeiler
 * entgegen (`node -e`, `python -c`) oder haendigt gleich die ganze Platte aus
 * (`docker run -v /:/host`). Mit denen in der Liste war jeder Skriptfehler in
 * der WebView, auch einer in einer Abhaengigkeit, Codeausfuehrung auf dem
 * Rechner des Nutzers statt Unfug innerhalb der App.
 */
export const MCP_STARTER = ['npx', 'uvx'] as const

/**
 * Kann dieses Fenster den Server mit diesem Befehl ueberhaupt starten.
 *
 * Der `.cmd`-Anhang gehoert dazu: unter Windows gibt es npx nur als Shim.
 */
export function isStartableMcpCommand(command: string): boolean {
  const nackt = command.trim().toLowerCase().replace(/\.cmd$/, '')
  return (MCP_STARTER as readonly string[]).includes(nackt)
}

/**
 * Der Satz, den ein Nutzer liest, dessen MCP-Server nicht mehr startet.
 *
 * Er nennt den Befehl, den er eingetragen hat, und die zwei, die gehen. Ohne
 * ihn kam Tauris eigene Meldung durch, die von einem Bereich spricht, den
 * niemand konfiguriert hat, und der Nutzer sucht den Fehler bei seinem Server.
 *
 * Der Satz endete bis zum 04.09.2026 auf "or run it yourself and connect over
 * its URL". Diesen Weg gibt es nicht: `MCPServerConfig` (api/mcp/types.ts)
 * kennt `command`, `args` und `env` und kein `url`, und unter api/mcp/ steht
 * weder ein SSE- noch ein HTTP-Transport. Ein Ausweg, den das Produkt nicht
 * hat, ist schlimmer als keiner, weil der Nutzer nach einem Feld sucht, das
 * es nie gab.
 *
 * Am 05.09.2026 fiel ein zweiter Ausweg derselben Sorte auf, diesmal von einem
 * Tester, der die App zum ersten Mal bediente. Der Ersatzsatz sagte "Change the
 * command to one of those". Aendern konnte man aber nichts: die Zeile trug
 * genau zwei Knoepfe, "Connect" und "Remove server", und Klick, Doppelklick
 * und Rechtsklick auf Name oder Befehl oeffneten kein Eingabefeld. Wer sich
 * vertippt hatte, musste loeschen und alles neu eintippen.
 *
 * Statt den Satz um die Luecke herumzuschreiben ist die Luecke geschlossen:
 * `updateServer` lag im Store bereits fertig und getestet und wurde von
 * nirgends gerufen. `MCPServerSettings` hat jetzt einen "Edit server"-Knopf,
 * der genau darauf geht. Der Rat stimmt damit wieder.
 *
 * Und das Beispiel `npx -y your-mcp-package` war ein Platzhaltername. Wer ihm
 * woertlich folgte, bekam "Server process exited", ohne Hinweis darauf, dass
 * das Paket gar nicht existiert. Die Meldung fuehrte in eine zweite, schlechtere.
 * Jetzt nennt sie ein Paket, das wirklich startet: `uvx mcp-server-time` wurde
 * am 05.09. auf der Windows-Box gefahren und lieferte zwei Werkzeuge.
 */
export function notStartableMessage(name: string, command: string): string {
  return (
    `LU cannot start "${name}": it is set to run \`${command}\`, and LU only starts `
    + `MCP servers through ${MCP_STARTER.join(' or ')}. Use the edit button on the `
    + `server entry to change the command to one of those, for example the command `
    + `\`uvx\` with the argument \`mcp-server-time\`.`
  )
}

export function commandCandidatesForPlatform(
  command: string,
  platform: string = typeof navigator !== 'undefined' ? navigator.platform : ''
): string[] {
  const isWindows = /Win/i.test(platform)
  if (!isWindows) return [command]
  if (/[\\/]|\.(cmd|bat|exe)$/i.test(command)) return [command]
  const CMD_SHIM_FIRST = new Set(['npx', 'npm', 'pnpm', 'yarn', 'corepack'])
  if (CMD_SHIM_FIRST.has(command)) return [`${command}.cmd`, command]
  return [command, `${command}.cmd`]
}
