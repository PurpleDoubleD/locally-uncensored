/**
 * Die zwei Werkzeuge, mit denen ein Hauptagent seine Hintergrundagenten
 * erreicht: nachsehen und hineinrufen.
 *
 * Warum sie hier und nicht in sub-agent.ts stehen: dort liegt der LAUF, hier
 * liegt die STEUERUNG. Ein Lauf soll nichts über die Werkzeuge wissen, die
 * über ihn sprechen — sonst hätte man einen Zyklus zwischen dem, was arbeitet,
 * und dem, was danach fragt.
 *
 * Beide Werkzeuge sind absichtlich klein und sagen im Fehlerfall genau, was
 * nicht ging. Ein Modell, das "Error: not found" liest, rät weiter; eines, das
 * "task xy is already finished, its answer was already reported" liest, hört
 * auf zu fragen.
 */

import type { MCPToolDefinition, ToolArgs } from '../mcp/types'
import type { AgentRunContext } from '../agent-context'
import { renderTaskOneLine, isTerminal } from '../../lib/agent-tasks'

export const CHECK_TASKS_TOOL_DEF: MCPToolDefinition = {
  name: 'check_tasks',
  // Jede Zeile hier ist Katalogtext in JEDEM Prompt, der dieses Werkzeug
  // sieht — der Deckel in tool-catalog-tokens.test.ts misst genau das.
  //
  // Die erste Fassung sagte ZWEI Dinge auf einmal: „USE before relying on a
  // delegated answer" und „No polling needed". Fuer ein grosses Modell ist
  // das eine Nuance, fuer ein 3B-Modell ein Widerspruch — die eine Haelfte
  // laedt zum Nachfragen ein, die andere verbietet es. Es bleibt EINE
  // Anweisung, und zwar die, die etwas erlaubt.
  description:
    'List your background tasks with their state and answers. '
    + 'USE when the user asks what the agents are doing.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  // 'system' und nicht 'workflow', denn die Kategorie entscheidet ueber die
  // Berechtigung: workflow heisst nachfragen. Fuer ein Werkzeug, das die
  // eigenen Hintergrundaufgaben AUFZAEHLT, waere eine Rueckfrage nur Laerm —
  // es liest App-Zustand, den derselbe Agent gerade selbst erzeugt hat, und
  // beruehrt die Maschine des Nutzers mit keinem Byte. Dieselbe Lage wie bei
  // todo_write, das aus demselben Grund unter 'system' steht.
  category: 'system',
  source: 'builtin',
}

export const MESSAGE_AGENT_TOOL_DEF: MCPToolDefinition = {
  name: 'message_agent',
  description:
    'Send more instructions to a still-running background task; it reads them at its next step. '
    + 'USE to narrow a goal or add a constraint mid-work. A finished task cannot be messaged.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The id delegate_task returned.' },
      message: { type: 'string', description: 'One or two sentences.' },
    },
    required: ['task_id', 'message'],
  },
  // Ebenfalls 'system', und die Frage ist hier ernster, weil geschrieben wird.
  // Sie geht trotzdem so aus: eine Nachricht landet als Nutzer-Turn im
  // Gespraech eines Sub-Agenten, den der Nutzer beim delegate_task schon
  // freigegeben hat, und JEDES Werkzeug, das dieser Sub-Agent daraufhin ruft,
  // laeuft weiterhin durch buildSubAgentGates — also durch dieselbe Freigabe
  // wie zuvor. Es gibt keinen Weg, ueber diesen Kanal eine Erlaubnis zu
  // erlangen, die vorher nicht da war; darum ist eine zweite Rueckfrage
  // Zeremonie und kein Schutz.
  category: 'system',
  source: 'builtin',
}

export function buildCheckTasksExecutor() {
  return async (_args: ToolArgs, run?: AgentRunContext): Promise<string> => {
    const convId = run?.conversationId
    if (!convId) return 'No conversation, so there are no background tasks to list.'
    const { useAgentTaskStore } = await import('../../stores/agentTaskStore')
    const alle = useAgentTaskStore.getState().forConv(convId)
    if (!alle.length) return 'No background tasks in this conversation.'
    const now = Date.now()
    // Die fertigen tragen ihre Antwort gleich mit: das Modell hat sonst die
    // Kennung, muesste dann aber ein zweites Werkzeug rufen, um an das
    // Ergebnis zu kommen — und genau dafuer reicht ein kleines Modell nicht.
    return alle.map((t) => {
      const kopf = renderTaskOneLine(t, now)
      if (!isTerminal(t.status)) return kopf
      const leib = t.status === 'done' ? (t.output || '(no answer)') : (t.error || `(${t.status})`)
      return `${kopf}\n${leib}`
    }).join('\n\n')
  }
}

export function buildMessageAgentExecutor() {
  return async (args: ToolArgs, run?: AgentRunContext): Promise<string> => {
    const id = typeof args.task_id === 'string' ? args.task_id.trim() : ''
    const message = typeof args.message === 'string' ? args.message.trim() : ''
    if (!id) return 'Error: message_agent requires a "task_id".'
    if (!message) return 'Error: message_agent requires a "message".'

    const { useAgentTaskStore } = await import('../../stores/agentTaskStore')
    const store = useAgentTaskStore.getState()
    const t = store.get(id)
    if (!t) {
      // Kein stilles Neustarten. Eine Aufgabe, die aus dem Ring gefallen ist,
      // hat ihr Gespraech verloren; sie "fortzusetzen" hiesse, bei null
      // anzufangen und es Fortsetzung zu nennen.
      return `Error: no background task ${id} in this conversation. It may have finished long ago and been dropped. Start a new one if you still need the work.`
    }
    // Fremde Konversation: eine Aufgabe gehoert dem Gespraech, in dem sie
    // gestartet wurde. Sonst koennte ein Zug in Chat A einem Agenten in
    // Chat B hineinreden.
    if (run?.conversationId && t.convId !== run.conversationId) {
      return `Error: task ${id} belongs to another conversation.`
    }
    if (isTerminal(t.status)) {
      return `Task ${id} is already ${t.status === 'done' ? 'finished' : t.status}; it cannot take new instructions. Its answer: ${t.output || t.error || '(none)'}`
    }
    return store.post(id, message)
      ? `Delivered to ${id}. It will read this at the start of its next step.`
      : `Error: task ${id} could not take the message.`
  }
}
