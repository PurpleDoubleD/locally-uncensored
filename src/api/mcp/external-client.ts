/**
 * MCP External Client — connects to external MCP servers via stdio JSON-RPC.
 *
 * Uses @tauri-apps/plugin-shell to spawn server processes
 * and communicate via stdin/stdout JSON-RPC 2.0.
 */

import type { MCPToolDefinition, MCPServerConfig } from './types'
import { log } from '../../lib/logger'

// JSON-RPC message types
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: any
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: any
  error?: { code: number; message: string; data?: any }
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
  private child: any = null
  private requestId = 0
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void
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

      // Initialize the MCP connection
      await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'locally-uncensored', version: '2.3.0' },
      })

      // Discover tools
      const toolsResult = await this.sendRequest('tools/list', {})
      const tools: MCPToolDefinition[] = (toolsResult.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {}, required: [] },
        category: 'workflow' as const, // External tools default to workflow category
        source: 'external' as const,
        serverId: this.config.id,
      }))

      this.registered = true
      return tools
    } catch (err) {
      this.connected = false
      // A failure after spawn (handshake refused, tools/list timed out) leaves
      // the server process running with nobody holding a handle to it — the
      // caller never gets a client it could disconnect. Take it down here.
      if (this.child) {
        try { await this.child.kill() } catch { /* already gone */ }
        this.child = null
      }
      throw new Error(`Failed to connect to MCP server "${this.config.name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async callTool(name: string, args: Record<string, any>): Promise<string> {
    if (!this.connected) throw new Error('Not connected')

    const result = await this.sendRequest('tools/call', { name, arguments: args })

    // MCP returns content array
    if (Array.isArray(result.content)) {
      return result.content
        .map((c: any) => {
          if (c.type === 'text') return c.text
          if (c.type === 'image') return `[Image: ${c.mimeType}]`
          return JSON.stringify(c)
        })
        .join('\n')
    }
    return JSON.stringify(result)
  }

  async disconnect() {
    this.closingOnPurpose = true
    this.connected = false
    this.rejectAllPending('Disconnecting')
    if (this.child) {
      try {
        await this.child.kill()
      } catch {
        // Process may already be dead
      }
      this.child = null
    }
  }

  isConnected() {
    return this.connected
  }

  // ── Private ─────────────────────────────────────────────────

  private sendRequest(method: string, params?: any): Promise<any> {
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
      try {
        const response: JsonRpcResponse = JSON.parse(trimmed)
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
      } catch {
        // Not JSON — might be a notification, ignore
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
