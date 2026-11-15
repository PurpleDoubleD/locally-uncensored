import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { Plus, Trash2, Power, PowerOff, Pencil, RotateCw } from 'lucide-react'
import { useMCPStore } from '../../stores/mcpStore'
import { toolRegistry } from '../../api/mcp'
import { isHttpServer, type MCPServerConfig, type MCPToolDefinition, type MCPTransport, type ToolArgs } from '../../api/mcp/types'
import { deleteMcpAuth, hasMcpAuth, loadMcpAuth, parseHeaderLines, saveMcpAuth } from '../../lib/mcp-secrets'
import { joinArgs, parseArgs } from '../../lib/mcp-args'
import { HINWEIS_TEXT } from '../../lib/hinweis'
// Beide Clients werden unten bewusst dynamisch geladen, damit der Tauri-Import
// im Dev-Modus nicht mitkommt. `ServerClient` ist die Flaeche, die das Panel
// von beiden braucht; die Klassen erfuellen sie strukturell, das prueft tsc
// an den beiden `new`-Stellen.

/**
 * What the panel needs of a client, whichever way it reaches its server:
 * the stdio one (external-client.ts) or the URL one (http-client.ts).
 */
interface ServerClient {
  connect(): Promise<MCPToolDefinition[]>
  callTool(name: string, args: ToolArgs): Promise<string>
  disconnect(): Promise<void>
}

// Active client instances (lazy-loaded to avoid Tauri import in dev mode)
const clients = new Map<string, ServerClient>()

/**
 * Connects still in flight, one per server. A connect takes as long as the
 * server needs for its handshake (an npx server installs first), and during
 * that time the row can be removed, disconnected or connected again. Before
 * this map the only guard was one `connecting` value for the whole panel:
 * a second Connect on the same row spawned a second process whose client
 * overwrote the first in `clients`, and a Remove found no client yet, so the
 * handshake finished afterwards and registered the tools of a server that
 * no longer existed, with its process running and no row left to stop it.
 * The entry is the attempt itself: whoever ends it (Remove, Disconnect, an
 * edit) deletes it, and the connect, once its handshake returns, sees that
 * it is no longer current and takes its own client down instead of
 * registering anything.
 */
interface ConnectAttempt { client: ServerClient | null }

/** The row's error without the "Failed to connect to MCP server "x": " the row already says. */
export function rowErrorText(message: string): string {
  return message.replace(/^Failed to connect to MCP server "[^"]*":\s*/, '')
}

const inputClass = 'w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:border-white/20 outline-none'
const inFlight = new Map<string, ConnectAttempt>()

export function MCPServerSettings() {
  const { servers, connectedServers, serverTools, serverErrors, addServer, updateServer, removeServer, setConnected, setServerTools, clearServerTools, setServerError } = useMCPStore()
  const [showAddForm, setShowAddForm] = useState(false)
  const [connecting, setConnecting] = useState<string[]>(() => [...inFlight.keys()])
  const markConnecting = (id: string, on: boolean) =>
    setConnecting((ids) => (on ? [...ids.filter((x) => x !== id), id] : ids.filter((x) => x !== id)))
  // What a connecting server is busy with (uvx/npx fetching it), per server.
  const [progress, setProgress] = useState<Record<string, string>>({})
  const markProgress = (id: string, note: string | null) =>
    setProgress((all) => {
      const next = { ...all }
      if (note) next[id] = note
      else delete next[id]
      return next
    })
  const [error, setError] = useState<string | null>(null)

  // Add form state. `editingId` entscheidet, ob Speichern anlegt oder aendert.
  const [formName, setFormName] = useState('')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')
  const [formTransport, setFormTransport] = useState<MCPTransport>('stdio')
  const [formUrl, setFormUrl] = useState('')
  // Token and headers are only ever typed, never shown back: an edit keeps
  // what the vault holds unless something new is typed or it is forgotten.
  const [formToken, setFormToken] = useState('')
  const [formHeaders, setFormHeaders] = useState('')
  const [forgetAuth, setForgetAuth] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const closeForm = () => {
    setFormName('')
    setFormCommand('')
    setFormArgs('')
    setFormTransport('stdio')
    setFormUrl('')
    setFormToken('')
    setFormHeaders('')
    setForgetAuth(false)
    setEditingId(null)
    setShowAddForm(false)
  }

  /**
   * Einen bestehenden Eintrag zum Bearbeiten oeffnen.
   *
   * Bis 2.6.8 gab es das nicht, und die Meldung fuer einen nicht startbaren
   * Befehl riet trotzdem dazu, den Befehl zu aendern. Ein Tester ist am
   * 05.09.2026 darueber gestolpert: die Zeile trug nur Verbinden und
   * Entfernen, wer sich vertippt hatte, musste loeschen und alles neu
   * eintippen. `updateServer` lag im Store bereits fertig und getestet und
   * wurde von nirgends gerufen.
   */
  const handleEdit = (server: MCPServerConfig) => {
    setEditingId(server.id)
    setFormName(server.name)
    setFormTransport(isHttpServer(server) ? 'http' : 'stdio')
    setFormCommand(server.command)
    setFormArgs(joinArgs(server.args))
    setFormUrl(server.url ?? '')
    setFormToken('')
    setFormHeaders('')
    setForgetAuth(false)
    setError(null)
    setShowAddForm(true)
  }

  const isUrlForm = formTransport === 'http'
  const formUrlOk = /^https?:\/\/\S+$/i.test(formUrl.trim())
  const canSave = !!formName.trim() && (isUrlForm ? formUrlOk : !!formCommand.trim())
  const editingServer = editingId ? servers.find((s) => s.id === editingId) : undefined
  const editingHasAuth = !!editingServer?.hasAuth

  const handleSave = async () => {
    if (!canSave) return
    const id = editingId ?? uuid()
    let felder: Partial<MCPServerConfig> & Pick<MCPServerConfig, 'name' | 'command' | 'args'>
    if (isUrlForm) {
      const typed = { token: formToken.trim() || undefined, headers: parseHeaderLines(formHeaders) }
      let hasAuth = editingHasAuth && !forgetAuth
      try {
        if (hasMcpAuth(typed)) { await saveMcpAuth(id, typed); hasAuth = true }
        else if (forgetAuth) await deleteMcpAuth(id)
      } catch {
        setError('LU could not save the token. Try again.')
        return
      }
      felder = { name: formName.trim(), transport: 'http', url: formUrl.trim(), hasAuth, command: '', args: [] }
    } else {
      felder = {
        name: formName.trim(),
        command: formCommand.trim(),
        args: parseArgs(formArgs),
      }
      // An entry that turns from a URL into a command keeps no sign in.
      if (editingServer && isHttpServer(editingServer)) {
        if (editingHasAuth) await deleteMcpAuth(id).catch(() => {})
        felder = { ...felder, transport: 'stdio', url: undefined, hasAuth: false }
      }
    }
    if (editingId) {
      // Ein laufender Server traegt noch den alten Befehl. Ihn stehen zu
      // lassen waere die schlimmere Haelfte des Fehlers: die Zeile zeigte
      // dann den neuen Befehl, waehrend der alte Prozess weiterlaeuft.
      if (connectedServers.includes(editingId) || inFlight.has(editingId)) await handleDisconnect(editingId)
      updateServer(editingId, felder)
      setServerError(editingId, null)
    } else {
      addServer({ id, ...felder, enabled: true })
    }
    closeForm()
  }

  const handleConnect = async (server: MCPServerConfig) => {
    // One connect per server: a second click while the first is still in its
    // handshake would start a second process.
    if (inFlight.has(server.id) || clients.has(server.id)) return
    const attempt: ConnectAttempt = { client: null }
    inFlight.set(server.id, attempt)
    const current = () =>
      inFlight.get(server.id) === attempt && useMCPStore.getState().servers.some((s) => s.id === server.id)
    markConnecting(server.id, true)
    setError(null)
    setServerError(server.id, null)
    try {
      // A server process can die on its own (crash, OOM kill, a bad config it
      // quits on). Before this the panel stayed green and its tools stayed in
      // the registry, so the model kept being offered a terminal that was not
      // there and every call failed with "Not connected" until the app closed.
      const onExit = (id: string) => {
        if (!attempt.client || clients.get(id) !== attempt.client) return
        toolRegistry.unregisterServer(id)
        setConnected(id, false)
        clearServerTools(id)
        clients.delete(id)
        setServerError(id, 'The server stopped. Reconnect to start it again.')
      }
      const onProgress = (note: string | null) => markProgress(server.id, note)
      let client: ServerClient
      if (isHttpServer(server)) {
        // Read at connect time, so a token changed in the form applies on
        // the next Connect without a restart. Never logged, never in state.
        const auth = server.hasAuth ? await loadMcpAuth(server.id).catch(() => null) : null
        const { MCPHttpClient } = await import('../../api/mcp/http-client')
        if (!current()) return
        client = new MCPHttpClient(server, { onExit, onProgress, auth })
      } else {
        const { MCPExternalClient } = await import('../../api/mcp/external-client')
        if (!current()) return
        client = new MCPExternalClient(server, { onExit, onProgress })
      }
      attempt.client = client
      let tools: MCPToolDefinition[]
      try {
        tools = await client.connect()
      } catch (err) {
        // A connect that was called off fails on purpose; that is no error.
        if (current()) throw err
        return
      }
      // Removed, disconnected or edited while the handshake ran: this client
      // is nobody's any more. Stop its process and register nothing.
      if (!current()) {
        await client.disconnect().catch(() => {})
        return
      }
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
        async (toolName, args) => client.callTool(toolName, args),
        server.name,
      )
    } catch (err) {
      setServerError(server.id, rowErrorText(err instanceof Error ? err.message : String(err)))
    } finally {
      if (inFlight.get(server.id) === attempt) inFlight.delete(server.id)
      markConnecting(server.id, false)
      markProgress(server.id, null)
    }
  }

  const handleDisconnect = async (id: string) => {
    // A connect still in its handshake is called off: its process is stopped
    // now, and the connect sees it is no longer current when it returns.
    const attempt = inFlight.get(id)
    if (attempt) {
      inFlight.delete(id)
      markConnecting(id, false)
      await attempt.client?.disconnect().catch(() => {})
    }
    const client = clients.get(id)
    if (client) {
      clients.delete(id)
      await client.disconnect()
    }
    toolRegistry.unregisterServer(id)
    setConnected(id, false)
    clearServerTools(id)
  }

  const handleReconnect = async (server: MCPServerConfig) => {
    await handleDisconnect(server.id)
    await handleConnect(server)
  }

  const handleRemove = async (id: string) => {
    const hadAuth = !!servers.find((s) => s.id === id)?.hasAuth
    await handleDisconnect(id)
    removeServer(id)
    if (hadAuth) await deleteMcpAuth(id).catch(() => {})
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
        const isLoading = connecting.includes(server.id)
        const rowError = !isConnected && !isLoading ? serverErrors[server.id] : undefined
        const viaUrl = isHttpServer(server)

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
              <div
                data-testid="mcp-status-dot"
                title={isConnected ? 'Connected' : rowError ? 'Not connected' : isLoading ? 'Connecting' : 'Off'}
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isConnected ? 'bg-green-500' : rowError ? 'bg-red-500' : 'bg-gray-600'
                }`}
              />

              {/* Name + command */}
              <div className="flex-1 min-w-0">
                <p className="text-[0.7rem] text-gray-300 font-medium">{server.name}</p>
                <p className="text-[0.55rem] text-gray-600 font-mono truncate">
                  {viaUrl ? server.url : `${server.command} ${joinArgs(server.args)}`}
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

              {/* Reconnect: after an error, or to pick up a changed server */}
              {(isConnected || rowError) && !isLoading && (
                <button
                  onClick={() => handleReconnect(server)}
                  className="p-1 rounded text-gray-600 hover:text-gray-300 hover:bg-white/5 transition-colors"
                  title="Reconnect"
                >
                  <RotateCw size={11} />
                </button>
              )}

              {/* Edit */}
              <button
                onClick={() => handleEdit(server)}
                className="p-1 rounded text-gray-600 hover:text-gray-300 hover:bg-white/5 transition-colors"
                title="Edit server"
              >
                <Pencil size={11} />
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

            {isLoading && !progress[server.id] && viaUrl && (
              <p className={`mt-1 t-micro leading-snug ${HINWEIS_TEXT.ruhig}`}>Connecting …</p>
            )}

            {rowError && (
              <p data-testid="mcp-row-error" className="mt-1 t-micro leading-snug text-red-400">{rowError}</p>
            )}

            {isLoading && progress[server.id] && (
              <p data-testid="mcp-installing-note" className={`mt-1 t-micro leading-snug ${HINWEIS_TEXT.ruhig}`}>
                {progress[server.id]}
              </p>
            )}

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
          <div className="flex gap-1" role="radiogroup" aria-label="How LU reaches the server">
            {([['stdio', 'Local command'], ['http', 'URL']] as const).map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={formTransport === value}
                onClick={() => setFormTransport(value)}
                className={`px-2 py-0.5 rounded t-micro border transition-colors ${
                  formTransport === value
                    ? 'bg-white/10 border-white/20 text-gray-200'
                    : 'border-white/10 text-gray-500 hover:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Server name"
            className={inputClass}
          />
          {isUrlForm ? (
            <>
              <input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="Server URL (e.g. http://localhost:8000/mcp)"
                className={`${inputClass} font-mono`}
              />
              <input
                type="password"
                autoComplete="off"
                value={formToken}
                onChange={(e) => setFormToken(e.target.value)}
                placeholder={editingHasAuth && !forgetAuth ? 'Token saved. Type a new one to replace it.' : 'Token (optional)'}
                className={`${inputClass} font-mono`}
              />
              <textarea
                value={formHeaders}
                onChange={(e) => setFormHeaders(e.target.value)}
                rows={2}
                placeholder="Extra headers (optional), one per line, e.g. X-Api-Key: abc"
                className={`${inputClass} font-mono resize-none`}
              />
              {editingHasAuth && (
                <label className="flex items-center gap-1.5 t-micro text-gray-500">
                  <input type="checkbox" checked={forgetAuth} onChange={(e) => setForgetAuth(e.target.checked)} />
                  Forget the saved token and headers
                </label>
              )}
              <p className="t-micro text-gray-600">Token and headers are kept in your system keychain.</p>
            </>
          ) : (
            <>
              <input
                value={formCommand}
                onChange={(e) => setFormCommand(e.target.value)}
                placeholder="Command (only npx or uvx)"
                className={`${inputClass} font-mono`}
              />
              <input
                value={formArgs}
                onChange={(e) => setFormArgs(e.target.value)}
                placeholder='Args (e.g. -y @modelcontextprotocol/server-filesystem "/My Folder")'
                className={`${inputClass} font-mono`}
              />
            </>
          )}
          <div className="flex gap-1.5">
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-3 py-1 rounded text-[0.6rem] font-medium bg-green-500/15 border border-green-500/30 text-green-300 hover:bg-green-500/25 disabled:opacity-40 transition-colors"
            >
              {editingId ? 'Save Changes' : 'Add Server'}
            </button>
            <button
              onClick={closeForm}
              className="px-3 py-1 rounded text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.65rem] text-gray-500 hover:text-gray-300 bg-white/[0.03] hover:bg-white/5 border border-white/10 hover:border-white/20 transition-colors w-full justify-center"
        >
          <Plus size={12} />
          Add MCP Server
        </button>
      )}
    </div>
  )
}
