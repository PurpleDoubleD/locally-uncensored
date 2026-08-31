// Dynamic Tool Registry — MCP-shaped, replaces hardcoded AGENT_TOOL_DEFS

import type { MCPToolDefinition, PermissionMap, PermissionLevel } from './types'
import type { OllamaTool } from '../../types/agent-mode'
import type { ToolDefinition } from '../providers/types'
import { MUTATING_TOOLS } from '../../lib/mutating-tools'
import { RETIRED_TOOL_NAMES, retiredPermissionLevel } from '../../lib/retired-tools'
import type { AgentRunContext } from '../agent-context'

/**
 * The optional second argument is the run this call belongs to (plan 2.6.6 C1).
 * Tools whose gate depends on the run (read-only turn, todo target
 * conversation, artifact capture, workspace jail) read it from there instead of
 * the process-wide singleton, so a second interleaving run cannot move their
 * goalposts mid-call. Tools that do not care simply ignore it.
 */
type ToolExecutor = (
  args: Record<string, any>,
  run?: AgentRunContext,
  signal?: AbortSignal,
) => Promise<string>
/** The pre-2.6.6 shape, still accepted from external servers and tests. */
type LegacyToolExecutor = (args: Record<string, any>) => Promise<string>
/**
 * External-tool executor gets the tool name too, because one MCP server
 * owns many tools and routes by name. The registry wraps it into a
 * per-tool ToolExecutor closure so the Map lookup stays {name → executor}.
 */
type ExternalToolExecutor = (toolName: string, args: Record<string, any>) => Promise<string>

interface RegisteredTool {
  definition: MCPToolDefinition
  executor: ToolExecutor
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()
  /**
   * Names the app itself owns. A third-party MCP server — the settings panel
   * advertises those as "community tools" — could register under `file_write`
   * or `shell_execute` and the Map.set simply replaced the builtin: every later
   * call went to the foreign server, transparently, with the builtin's own
   * description still selling it to the model. Disconnecting the server then
   * ran unregisterServer, which deleted the entry by serverId and took the
   * BUILTIN with it — permanently, for the rest of the session.
   *
   * Builtins are therefore untouchable: a colliding external name is refused,
   * not merged, not suffixed. Suffixing would be worse than refusing, because
   * the model would then see two tools that both claim to be the terminal.
   */
  private builtinNames = new Set<string>()
  /** Collisions refused since startup, for the MCP settings panel / report. */
  private rejectedExternal: { serverId: string; toolName: string }[] = []

  // ── Registration ──────────────────────────────────────────────

  registerBuiltin(tool: MCPToolDefinition, executor: ToolExecutor) {
    this.builtinNames.add(tool.name)
    this.tools.set(tool.name, { definition: tool, executor })
  }

  /** Is this name owned by the app (and thus off-limits to MCP servers)? */
  isBuiltinName(name: string): boolean {
    return this.builtinNames.has(name)
  }

  /** External registrations refused because they collided with a builtin. */
  getRejectedExternalTools(): readonly { serverId: string; toolName: string }[] {
    return this.rejectedExternal
  }

  /**
   * Register all tools from an external MCP server. The executor receives
   * both the tool name and args, letting one MCP client back many tools
   * (which is how MCP servers actually work — one `tools/call` endpoint,
   * dispatched by name).
   *
   * Also accepts the legacy single-arg executor shape for backward compat
   * — tests and older callers can still pass `(args) => ...` and the
   * registry will call it unchanged. Prefer the two-arg shape in new code.
   */
  registerExternal(
    serverId: string,
    tools: MCPToolDefinition[],
    executor: ExternalToolExecutor | LegacyToolExecutor
  ) {
    const isTwoArg = executor.length >= 2
    for (const tool of tools) {
      const name = tool.name
      // Name collision with an app tool: refuse the registration and say so.
      // The alternative (overwrite) hands the app's own file and terminal tools
      // to a third-party process without a word to the user, and the eventual
      // disconnect deletes the builtin for good. See `builtinNames`.
      if (this.builtinNames.has(name)) {
        this.rejectedExternal.push({ serverId, toolName: name })
        console.warn(
          `[ToolRegistry] MCP server "${serverId}" tried to register "${name}", `
          + 'which is a built-in tool. Registration refused; the built-in stays in place.',
        )
        continue
      }
      const bound: ToolExecutor = isTwoArg
        ? (args: Record<string, any>) =>
            (executor as ExternalToolExecutor)(name, args)
        : (executor as LegacyToolExecutor)
      this.tools.set(name, {
        definition: { ...tool, source: 'external', serverId },
        executor: bound,
      })
    }
  }

  unregisterServer(serverId: string) {
    for (const [name, entry] of this.tools) {
      // `source === 'external'` as well as the serverId: a builtin can never be
      // collateral of a disconnect, whatever a definition claims to carry.
      if (entry.definition.serverId === serverId && !this.builtinNames.has(name)) {
        this.tools.delete(name)
      }
    }
    this.rejectedExternal = this.rejectedExternal.filter((r) => r.serverId !== serverId)
  }

  // ── Query ─────────────────────────────────────────────────────

  getAll(): MCPToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition)
  }

  getAvailableTools(permissions: PermissionMap): MCPToolDefinition[] {
    return this.getAll().filter(t => permissions[t.category] !== 'blocked')
  }

  getToolByName(name: string): MCPToolDefinition | undefined {
    return this.tools.get(name)?.definition
  }

  /**
   * Resolve a name to something the step executor may run: registered tools
   * by their definition, retired names (2.6.6 merge) as a schema-less stub so
   * the executor reaches execute(), where runRetiredTool redirects them.
   * Without this, the executor's own getTool miss fails the call as
   * "Unknown tool" before the redirect ever runs.
   */
  resolveExecutable(name: string): { name: string; inputSchema?: MCPToolDefinition['inputSchema'] } | undefined {
    const td = this.tools.get(name)?.definition
    if (td) return { name: td.name, inputSchema: td.inputSchema }
    if (RETIRED_TOOL_NAMES.has(name)) return { name }
    return undefined
  }

  getPermissionLevel(toolName: string, permissions: PermissionMap): PermissionLevel {
    const tool = this.tools.get(toolName)?.definition
    if (tool) return permissions[tool.category]
    // A9: a retired name has no definition to read a category off, and the
    // 'confirm' below meant Agent mode opened an approval dialog for
    // `git_status`, whose executor is one fixed read. Read-only retired names
    // run unattended, mutating ones keep confirm, blocked stays blocked.
    // Anything else is genuinely unknown and confirm is the honest answer.
    return retiredPermissionLevel(toolName, permissions) ?? 'confirm'
  }

  /**
   * Phase 12 — resolve the effective permission for a tool with a per-tool
   * override map layered on top of category defaults. The override map is
   * typically sourced from permissionStore.perToolOverrides and takes
   * precedence over the category permission; when no override exists we
   * fall back to getPermissionLevel() semantics.
   */
  getPermissionLevelWithOverrides(
    toolName: string,
    permissions: PermissionMap,
    perToolOverrides: Record<string, PermissionLevel>
  ): PermissionLevel {
    const override = perToolOverrides[toolName]
    if (override) return override
    return this.getPermissionLevel(toolName, permissions)
  }

  // ── Execution ─────────────────────────────────────────────────

  async execute(
    name: string,
    args: Record<string, any>,
    maxRetries = 1,
    run?: AgentRunContext,
    signal?: AbortSignal,
  ): Promise<string> {
    // The run's Stop, in the tool's own hands. Callers that predate the fourth
    // argument still reach it through the run they already thread.
    const abort = signal ?? run?.abortSignal
    // Stop is not "finish the batch quietly": a call that has not started yet
    // must not start. The executor checks this too, but the registry is also
    // reached directly (sub-agents, retired-name redirects).
    if (abort?.aborted) return `Error: cancelled by the user before "${name}" started.`
    const entry = this.tools.get(name)
    if (!entry) {
      // Retired names (2.6.6 tool merge) still run: a restored session or a
      // model that knows git_status from its context must not burn the step
      // on "Unknown tool". Dynamic import keeps the module graph acyclic.
      const { runRetiredTool } = await import('./builtin-tools')
      const redirected = await runRetiredTool(name, args, run)
      if (redirected !== null) return redirected
      return `Error: Unknown tool "${name}"`
    }

    // Audit B2: a retry re-RUNS the tool. For a side-effecting tool that is a
    // second commit, a second push, a second shell command — never acceptable
    // on spec. Reads may retry, and only on transient failures.
    const retriable = !MUTATING_TOOLS.has(name)
    const isTransientText = (s: string) =>
      s.includes('timed out') || s.includes('ECONNREFUSED') || s.includes('fetch failed')

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await entry.executor(args, run, abort)
        // If result is an error and we have retries left, retry
        if (result.startsWith('Error:') && attempt < maxRetries) {
          // A retry after Stop would run the command the user just cancelled a
          // second time — the one case where "transient" is the wrong read.
          if (retriable && isTransientText(result) && !abort?.aborted) continue
        }
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // The throw path used to retry EVERYTHING once, blind — including a
        // git_commit whose invoke threw after the commit landed, and aborted
        // calls. Same rule as the string path: transient + non-mutating only,
        // and an abort is the user speaking, not a network hiccup.
        const aborted =
          (err as { name?: string })?.name === 'AbortError'
          || /abort/i.test(message)
          || abort?.aborted === true
        if (attempt < maxRetries && retriable && !aborted && isTransientText(message)) continue
        return `Error: ${message}`
      }
    }
    return `Error: Max retries exceeded for "${name}"`
  }

  // ── Format Conversion ─────────────────────────────────────────

  toOllamaTools(permissions: PermissionMap): OllamaTool[] {
    return this.getAvailableTools(permissions).map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }

  toOpenAITools(permissions: PermissionMap): ToolDefinition[] {
    return this.getAvailableTools(permissions).map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }

  toHermesToolDefs(permissions: PermissionMap): { name: string; description: string; parameters: any }[] {
    return this.getAvailableTools(permissions).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }))
  }
}

// ── Singleton ────────────────────────────────────────────────────

export const toolRegistry = new ToolRegistry()
