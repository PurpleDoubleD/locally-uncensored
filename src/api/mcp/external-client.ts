/**
 * MCP External Client — connects to external MCP servers via stdio JSON-RPC.
 *
 * Uses @tauri-apps/plugin-shell to spawn server processes
 * and communicate via stdin/stdout JSON-RPC 2.0.
 */

import type { MCPToolDefinition, MCPServerConfig } from './types'

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
  private process: any = null
  private requestId = 0
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>()
  private outputBuffer = ''
  private connected = false

  constructor(private config: MCPServerConfig) {}

  async connect(): Promise<MCPToolDefinition[]> {
    try {
      // Dynamic import for Tauri shell plugin — only available in .exe builds
      // @ts-ignore — module may not exist in dev mode
      const shellModule = await import(/* @vite-ignore */ '@tauri-apps/plugin-shell')
      const { Command } = shellModule

      // Windows gotcha: Node-based MCP servers are invoked as `npx`, `npm`,
      // `node` — but on Windows the resolvable PATH entries for those are
      // `npx.cmd`, `npm.cmd`, etc. Command.create tries to spawn the bare
      // name which fails with "program not found". Map known command names
      // to their .cmd shim here.
      const resolvedCommand = resolveCommandForPlatform(this.config.command)

      this.process = Command.create(resolvedCommand, this.config.args, {
        env: this.config.env,
      })

      // Handle stdout — parse JSON-RPC responses
      this.process.stdout.on('data', (data: string) => {
        this.outputBuffer += data
        this.processBuffer()
      })

      this.process.stderr.on('data', (data: string) => {
        console.warn(`[MCP:${this.config.name}] stderr:`, data)
      })

      this.process.on('close', () => {
        this.connected = false
        this.rejectAllPending('Server process exited')
      })

      await this.process.spawn()
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

      return tools
    } catch (err) {
      this.connected = false
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
    this.connected = false
    this.rejectAllPending('Disconnecting')
    if (this.process) {
      try {
        await this.process.kill()
      } catch {
        // Process may already be dead
      }
      this.process = null
    }
  }

  isConnected() {
    return this.connected
  }

  // ── Private ─────────────────────────────────────────────────

  private sendRequest(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      this.pendingRequests.set(id, { resolve, reject })

      const msg = JSON.stringify(request) + '\n'
      this.process.stdin.write(msg)

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`Request ${method} timed out`))
        }
      }, 30000)
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
    for (const [id, { reject }] of this.pendingRequests) {
      reject(new Error(reason))
      this.pendingRequests.delete(id)
    }
  }
}

/**
 * Map a bare command name to the Windows `.cmd` shim when running on
 * Windows. Commands with an extension or an absolute path are returned
 * unchanged.
 */
export function resolveCommandForPlatform(
  command: string,
  platform: string = typeof navigator !== 'undefined' ? navigator.platform : ''
): string {
  const isWindows = /Win/i.test(platform)
  if (!isWindows) return command
  if (/[\\/]|\.(cmd|bat|exe)$/i.test(command)) return command
  const NEEDS_CMD = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bun', 'node', 'deno'])
  if (NEEDS_CMD.has(command)) return `${command}.cmd`
  return command
}
