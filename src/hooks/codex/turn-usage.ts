import { useChatStore } from '../../stores/chatStore'
import { estimateTokens } from '../../lib/context-compaction'
import type { ChatMessage, ToolDefinition } from '../../api/providers/types'

/**
 * Das Feld `usage` einer Antwort — die eine Zahl, die der Nutzer als
 * Verbrauchsanzeige sieht.
 *
 * Der Schnitt folgt dem geteilten Zustand `message.usage`: in useCodex.ts
 * schrieben DREI Stellen hinein — ein Schaetzblock im Ollama-Zweig und zwei
 * WOERTLICH IDENTISCHE Bloecke, einer im Ollama-Zweig und einer im
 * OpenAI-kompatiblen Zweig:
 *
 *     if (turn.promptEvalCount || turn.evalCount) {
 *       useChatStore.getState().updateMessageUsage(convId!, assistantMsg.id, {
 *         promptTokens: turn.promptEvalCount || 0, …, estimated: false,
 *       })
 *     }
 *
 * Zwei Kopien derselben Regel in zwei Transporten, die dasselbe Feld fuellen,
 * gehoeren nach nebenan — sonst bekommt der eine Transport eine Korrektur, die
 * der andere nicht sieht.
 *
 * DIE REGEL, DIE DABEI ZU PRUEFEN IST: eine SCHAETZUNG darf eine ECHTE Zahl
 * NIE ueberschreiben. Der Schaetzblock traegt seinen Wert nur ein, solange
 * `usage` fehlt oder selbst geschaetzt ist; die echte Zahl des Modells (letzte
 * gewinnt, weil der spaeteste Aufruf den vollsten Prompt hatte) setzt
 * `estimated: false` und ist damit endgueltig. In der grossen Datei stand
 * diese Rangfolge nur als Kommentar; hier ist sie pruefbar, und zwar am
 * ECHTEN Chat-Speicher.
 */

/** Was ein Transportzug an Zahlen zurueckmeldet. */
export interface TurnCounts {
  promptEvalCount?: number
  evalCount?: number
}

/**
 * Die vorlaeufige Schaetzung: echte Promptgroesse (Systemprompt + Werkzeuge +
 * Repo-Karte + Verlauf), nicht ein Zeichen/4-Rateschluss ueber die sichtbaren
 * Nachrichten allein. Wird nur gesetzt, solange keine echte Zahl vorliegt.
 */
export function seedEstimatedUsage(
  convId: string,
  messageId: string,
  sendMessages: ChatMessage[],
  tools: ToolDefinition[],
): void {
  const existingUsage = useChatStore.getState().conversations
    .find((c) => c.id === convId)?.messages.find((m) => m.id === messageId)?.usage
  if (!existingUsage || existingUsage.estimated) {
    const estPrompt =
      estimateTokens(sendMessages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')) +
      estimateTokens(JSON.stringify(tools))
    useChatStore.getState().updateMessageUsage(convId, messageId, {
      promptTokens: estPrompt, completionTokens: 0, totalTokens: estPrompt, estimated: true,
    })
  }
}

/**
 * Die echte Zahl dieses Modellaufrufs. Mehrere Aufrufe laufen pro Aufgabe; der
 * letzte hat den vollsten Prompt, also gewinnt der letzte.
 */
export function reportTurnUsage(convId: string, messageId: string, turn: TurnCounts): void {
  if (turn.promptEvalCount || turn.evalCount) {
    useChatStore.getState().updateMessageUsage(convId, messageId, {
      promptTokens: turn.promptEvalCount || 0,
      completionTokens: turn.evalCount || 0,
      totalTokens: (turn.promptEvalCount || 0) + (turn.evalCount || 0),
      estimated: false,
    })
  }
}
