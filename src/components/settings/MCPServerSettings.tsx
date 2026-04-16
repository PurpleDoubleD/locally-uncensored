import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { Plus, Trash2, Power, PowerOff, ChevronDown } from 'lucide-react'
import { useMCPStore } from '../../stores/mcpStore'
import { toolRegistry } from '../../api/mcp'
import type { MCPServerConfig } from '../../api/mcp/types'

// Active client instances (lazy-loaded to avoid Tauri import in dev mode)
const clients = new Map<string, any>()

export function MCPServerSettings() {
  const { servers, connectedServers, serverTools, addServer, removeServer, setConnected, setServerTools, clearServerTools } = useMCPStore()
  const [showAddForm, setShowAddForm] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Add form state
  const [formName, setFormName] = useState('')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')

  const handleAdd = () => {
    if (!formName.trim() || !formCommand.trim()) return
    const server: MCPServerConfig = {
      id: uuid(),
      name: formName.trim(),
      command: formCommand.trim(),
      args: formArgs.trim() ? formArgs.trim().split(' ') : [],
      enabled: true,
    }
    addServer(server)
    setFormName('')
    setFormCommand('')
    setFormArgs('')
    setShowAddForm(false)
  }

  const handleConnect = async (server: MCPServerConfig) => {
    setConnecting(server.id)
    setError(null)
    try {
      const { MCPExternalClient } = await import('../../api/mcp/external-client')
      const client = new MCPExternalClient(server)
      const tools = await client.connect()
      clients.set(server.id, client)
      setConnected(server.id, true)
      setServerTools(server.id, tools)
      // Register tools with the global registry. The two-arg executor
      // contract lets the registry bind each tool's name into its own
      // closure — previously a single-arg hack tried to smuggle the name
      // via `args.__toolName`, which was never populated, so MCP calls
      // silently dispatched with an empty tool name and failed.
      toolRegistry.registerExternal(
        server.id,
        tools,
        async (toolName, args) => client.callTool(toolName, args)
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(null)
    }
  }

  const handleDisconnect = async (id: string) => {
    const client = clients.get(id)
    if (client) {
      await client.disconnect()
      clients.delete(id)
    }
    toolRegistry.unregisterServer(id)
    setConnected(id, false)
    clearServerTools(id)
  }

  const handleRemove = async (id: string) => {
    await handleDisconnect(id)
    removeServer(id)
  }

  return (
    <div className="space-y-3">
      <p className="text-[0.6rem] text-gray-500">
        Connect external MCP servers to extend Agent capabilities with community tools.
      </p>

      {/* Server List */}
      {servers.map((server) => {
        const isConnected = connectedServers.includes(server.id)
        const tools = serverTools[server.id] || []
        const isLoading = connecting === server.id

        return (
          <div
            key={server.id}
            className={`px-3 py-2 rounded-lg border transition-colors ${
              isConnected
                ? 'bg-green-500/[0.03] border-green-500/20'
                : 'bg-white/[0.02] border-white/[0.06]'
            }`}
          >
            <div className="flex items-center gap-2">
              {/* Status dot */}
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                isConnected ? 'bg-green-500' : 'bg-gray-600'
              }`} />

              {/* Name + command */}
              <div className="flex-1 min-w-0">
                <p className="text-[0.7rem] text-gray-300 font-medium">{server.name}</p>
                <p className="text-[0.55rem] text-gray-600 font-mono truncate">
                  {server.command} {server.args.join(' ')}
                </p>
              </div>

              {/* Tools count */}
              {isConnected && tools.length > 0 && (
                <span className="text-[0.55rem] text-green-400 font-medium">
                  {tools.length} tools
                </span>
              )}

              {/* Connect/Disconnect */}
              <button
                onClick={() => isConnected ? handleDisconnect(server.id) : handleConnect(server)}
                disabled={isLoading}
                className={`p-1 rounded transition-colors ${
                  isConnected
                    ? 'text-green-400 hover:text-red-400 hover:bg-red-500/10'
                    : 'text-gray-500 hover:text-green-400 hover:bg-green-500/10'
                }`}
                title={isConnected ? 'Disconnect' : 'Connect'}
              >
                {isLoading ? (
                  <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
                ) : isConnected ? (
                  <PowerOff size={12} />
                ) : (
                  <Power size={12} />
                )}
              </button>

              {/* Remove */}
              <button
                onClick={() => handleRemove(server.id)}
                className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Remove server"
              >
                <Trash2 size={11} />
              </button>
            </div>

            {/* Expanded tool list */}
            {isConnected && tools.length > 0 && (
              <div className="mt-1.5 pt-1.5 border-t border-white/5 space-y-0.5">
                {tools.map((t) => (
                  <div key={t.name} className="flex items-center gap-1.5">
                    <span className="text-[0.55rem] text-gray-500 font-mono">{t.name}</span>
                    <span className="text-[0.5rem] text-gray-600 truncate">{t.description}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Error */}
      {error && (
        <p className="text-[0.6rem] text-red-400 px-2">{error}</p>
      )}

      {/* Add Server Form */}
      {showAddForm ? (
        <div className="space-y-2 p-3 rounded-lg border border-white/10 bg-white/[0.02]">
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Server name"
            className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:border-white/20 outline-none"
          />
          <input
            value={formCommand}
            onChange={(e) => setFormCommand(e.target.value)}
            placeholder="Command (e.g. npx, python)"
            className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 font-mono focus:border-white/20 outline-none"
          />
          <input
            value={formArgs}
            onChange={(e) => setFormArgs(e.target.value)}
            placeholder="Args (e.g. -y @modelcontextprotocol/server-filesystem /path)"
            className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 font-mono focus:border-white/20 outline-none"
          />
          <div className="flex gap-1.5">
            <button
              onClick={handleAdd}
              disabled={!formName.trim() || !formCommand.trim()}
              className="px-3 py-1 rounded text-[0.6rem] font-medium bg-green-500/15 border border-green-500/30 text-green-300 hover:bg-green-500/25 disabled:opacity-40 transition-colors"
            >
              Add Server
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="px-3 py-1 rounded text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/5 border border-dashed border-white/10 hover:border-white/20 transition-all w-full justify-center"
        >
          <Plus size={12} />
          Add MCP Server
        </button>
      )}
    </div>
  )
}
