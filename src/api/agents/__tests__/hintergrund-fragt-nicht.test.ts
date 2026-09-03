import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MCPToolDefinition } from '../../mcp/types'

/**
 * Auftrag 2.3 (David, 04.09.2026): "hintergrund bzw multiagents sollen NIEMALS
 * freigabe brauchen."
 *
 * Die Entscheidung faellt EINMAL, VORNE. Was daraus folgt, steht in zwei
 * Haelften hier, und die zweite ist die wichtigere:
 *
 *   - kein Dialog pro Delegation, wenn die Entscheidung vorne schon gefallen
 *     ist,
 *   - und trotzdem keine Rechteerweiterung: was der Hauptlauf nicht darf,
 *     bekommt ein Unteragent nicht dadurch, dass er ein Unteragent ist.
 *
 * Der Befund, der diese Datei ausgeloest hat, sitzt an der Stelle "zwei Pfade,
 * einer gepflegt": buildSubAgentGates las bisher IMMER den Berechtigungs-Store
 * des Agent-Chats und stellte seine Frage IMMER in die Warteschlange des
 * Chats. Ein Unterauftrag aus dem Code-Tab lief damit unter der falschen
 * Entscheidung und fragte in einer Warteschlange, die das Code-Tab gar nicht
 * anzeigt.
 */

const chatWithTools = vi.fn()
const toolExecute = vi.fn(async () => 'tool output')
const auditRecord = vi.fn((_input: {
  convId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  parentToolCallId?: string
  startedAt?: number
}) => 'audit-1')
const auditComplete = vi.fn()

/** Kategorie-Stufen wie sie der Nutzer vorne in den Einstellungen fuehrt. */
let stufen: Record<string, 'auto' | 'confirm' | 'blocked'> = {}
/** Ausdrueckliche Einzelregeln (perToolOverrides). */
let einzelregeln: Record<string, 'auto' | 'confirm' | 'blocked'> = {}

const SHELL_DEF: MCPToolDefinition = {
  name: 'shell_execute',
  description: 'run a command',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  category: 'terminal',
  source: 'builtin',
}
const WRITE_DEF: MCPToolDefinition = {
  name: 'file_write',
  description: 'write a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  category: 'filesystem',
  source: 'builtin',
}
// Die beiden Definitionen haben verschiedene Schemata, also traegt die Karte
// den gemeinsamen Vertrag, den der Ausfuehrer wirklich liest.
const DEFS: Record<string, MCPToolDefinition> = { shell_execute: SHELL_DEF, file_write: WRITE_DEF }

vi.mock('../../../stores/modelStore', () => ({
  useModelStore: { getState: () => ({ activeModel: 'ollama::qwen' }) },
}))

vi.mock('../../providers', () => ({
  getProviderForModel: (name: string) => ({
    provider: { chatWithTools },
    modelId: name.includes('::') ? name.split('::')[1] : name,
  }),
}))

vi.mock('../../mcp/tool-registry', () => ({
  toolRegistry: {
    getAll: () => [SHELL_DEF, WRITE_DEF],
    resolveExecutable: (name: string) => DEFS[name],
    execute: (...args: unknown[]) => toolExecute(...(args as [])),
    // Die Doppel bildet die echte Signatur nach: die Kategorie-Stufe des
    // Werkzeugs, mit der uebergebenen Einzelregel-Karte darueber.
    getPermissionLevelWithOverrides: (
      name: string,
      _perms: unknown,
      overrides: Record<string, 'auto' | 'confirm' | 'blocked'>,
    ) => overrides[name] ?? stufen[name] ?? 'confirm',
  },
}))

vi.mock('../../../stores/permissionStore', () => ({
  usePermissionStore: {
    getState: () => ({
      getEffectivePermissions: () => ({}),
      get perToolOverrides() { return einzelregeln },
    }),
  },
}))

vi.mock('../../../stores/toolAuditStore', () => ({
  useToolAuditStore: { getState: () => ({ record: auditRecord, complete: auditComplete }) },
}))

import { defaultSubAgentRunner, SUB_AGENT_BUDGET, _setDepth } from '../sub-agent'
import { AgentBudget } from '../budget'
import type { AgentRunContext } from '../../agent-context'
import { headApproval, resetApprovals, dequeueApproval } from '../../../lib/approval-queue'
import { useCodexConfirmStore } from '../../../stores/codexConfirmStore'
import type { ChatMessage } from '../../providers/types'

const makeRun = (over: Partial<AgentRunContext> = {}): AgentRunContext => ({
  token: 'run-test',
  chatId: null,
  conversationId: 'conv-1',
  workspace: null,
  artifactMode: false,
  readOnlyShellTurn: false,
  mode: null,
  artifacts: [],
  ...over,
})

function scriptOneCall(name: string, args: Record<string, unknown>): void {
  chatWithTools
    .mockResolvedValueOnce({
      content: '',
      toolCalls: [{ id: 'tc1', function: { name, arguments: args } }],
    })
    .mockResolvedValueOnce({ content: 'done', toolCalls: [] })
}

const messagesOfTurn = (n: number): ChatMessage[] => chatWithTools.mock.calls[n][1] as ChatMessage[]
const lastToolMessage = (n: number): string => {
  const msgs = messagesOfTurn(n)
  return String(msgs[msgs.length - 1]?.content ?? '')
}

const tick = () => new Promise((r) => setTimeout(r, 0))

const runSub = (run: AgentRunContext) =>
  defaultSubAgentRunner('do it', '', { budget: new AgentBudget({ ...SUB_AGENT_BUDGET }), run })

beforeEach(() => {
  _setDepth(0)
  stufen = {}
  einzelregeln = {}
  chatWithTools.mockReset()
  toolExecute.mockReset()
  toolExecute.mockResolvedValue('tool output')
  auditRecord.mockClear()
  auditComplete.mockClear()
  resetApprovals()
  useCodexConfirmStore.setState({ pending: null, resolve: null })
})

describe('Unterauftrag aus dem Code-Tab: das Preset entscheidet, nicht der Chat-Store', () => {
  it('Bypass laesst einen Schreibvorgang durch, ohne irgendwo zu fragen', async () => {
    // Vorne entschieden: "Run without asking". Der Hauptlauf im Code-Tab
    // schreibt ohne Rueckfrage, also darf ein Unterauftrag nicht plotzlich
    // eine Frage stellen. Bis hierher stellte er sie, und zwar in der
    // Warteschlange des Chats, die das Code-Tab nicht anzeigt: der
    // Unterauftrag blieb bis zum Stop stehen.
    stufen.file_write = 'confirm'
    scriptOneCall('file_write', { path: 'a.txt', content: 'x' })

    const out = await runSub(makeRun({ mode: 'bypass', execApproval: { confirmExec: false, cloudReason: false } }))

    expect(out).toBe('done')
    expect(toolExecute).toHaveBeenCalledOnce()
    expect(headApproval('conv-1')).toBeNull()
    expect(useCodexConfirmStore.getState().pending).toBeNull()
  })

  it('Ask fragt vor shell_execute, auch wenn die Chat-Kategorie auf auto steht', async () => {
    // Die Rechteerweiterung, die es hier zu verhindern gilt: der Nutzer hat
    // "Confirm commands" gewaehlt, aber irgendwann fuer den Agent-Chat
    // 'terminal' auf 'auto' gestellt. Bis hierher lief das delegierte
    // shell_execute unbeaufsichtigt, waehrend derselbe Befehl im Hauptlauf
    // desselben Gespraechs einen Dialog geoeffnet haette.
    stufen.shell_execute = 'auto'
    scriptOneCall('shell_execute', { command: 'rm -rf /tmp/x' })

    const p = runSub(makeRun({ mode: 'ask', execApproval: { confirmExec: true, cloudReason: false } }))

    for (let i = 0; i < 100 && !useCodexConfirmStore.getState().pending; i++) await tick()
    const frage = useCodexConfirmStore.getState().pending
    expect(frage?.toolName).toBe('shell_execute')
    // Der ganze Befehl steht auf der Karte, nicht nur der Werkzeugname.
    expect(frage?.command).toMatch(/rm -rf \/tmp\/x/)
    expect(toolExecute).not.toHaveBeenCalled()
    // Und die Frage steht NICHT in der Chat-Warteschlange, die im Code-Tab
    // niemand anzeigt.
    expect(headApproval('conv-1')).toBeNull()

    useCodexConfirmStore.getState().answer(true)
    expect(await p).toBe('done')
    expect(toolExecute).toHaveBeenCalledOnce()
  })

  it('ein lesend gestellter Lauf laesst einen Schreibvorgang auch delegiert nicht zu', async () => {
    // Plan-Modus, Code-Review und die Nur-Lesen-Befehle nehmen dem Hauptlauf
    // die veraendernden Werkzeuge aus dem Katalog. Der Unterauftrag bekommt
    // den vollen Katalog (toolRegistry.getAll), also muss die Sperre im Gate
    // stehen. 'auto' hier ist Absicht: selbst eine erlaubte Kategorie darf
    // den Nur-Lesen-Lauf nicht aufheben.
    stufen.file_write = 'auto'
    scriptOneCall('file_write', { path: 'a.txt', content: 'x' })

    await runSub(makeRun({ mode: 'plan', readOnlyShellTurn: true, execApproval: { confirmExec: false, cloudReason: false } }))

    expect(toolExecute).not.toHaveBeenCalled()
    expect(headApproval('conv-1')).toBeNull()
    expect(useCodexConfirmStore.getState().pending).toBeNull()
    expect(lastToolMessage(1)).toMatch(/read-only/i)
  })

  it('das Protokoll traegt auch den Aufruf, der nicht mehr gefragt wurde', async () => {
    // Der Audit-Charakter von AGT-1 bleibt: nicht mehr fragen heisst nicht
    // nicht mehr mitschreiben.
    stufen.file_write = 'confirm'
    scriptOneCall('file_write', { path: 'a.txt', content: 'x' })

    await runSub(makeRun({ mode: 'bypass', execApproval: { confirmExec: false, cloudReason: false } }))

    expect(auditRecord).toHaveBeenCalledOnce()
    expect(auditRecord.mock.calls[0][0]).toMatchObject({
      convId: 'conv-1',
      toolName: 'file_write',
      parentToolCallId: 'sub-agent',
    })
    expect(auditComplete).toHaveBeenCalledOnce()
  })
})

describe('Unterauftrag aus dem Agent-Chat: der Berechtigungs-Store bleibt die Entscheidung', () => {
  it('eine abgeschaltete Kategorie bekommt der Unteragent auch als Unteragent nicht', async () => {
    stufen.shell_execute = 'blocked'
    scriptOneCall('shell_execute', { command: 'ls' })

    await runSub(makeRun())

    expect(toolExecute).not.toHaveBeenCalled()
    expect(headApproval('conv-1')).toBeNull()
    expect(lastToolMessage(1)).toMatch(/Blocked: shell_execute is not permitted/)
  })

  it('eine Kategorie auf confirm fragt weiter, und zwar in der Chat-Warteschlange', async () => {
    stufen.file_write = 'confirm'
    scriptOneCall('file_write', { path: 'a.txt', content: 'x' })

    const p = runSub(makeRun())
    for (let i = 0; i < 100 && !headApproval('conv-1'); i++) await tick()
    expect(headApproval('conv-1')?.toolName).toBe('file_write')
    dequeueApproval('conv-1')!.resolve(true)

    expect(await p).toBe('done')
    expect(toolExecute).toHaveBeenCalledOnce()
  })
})
