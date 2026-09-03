import { useChatStore } from '../../stores/chatStore'
import type { AgentBlock } from '../../types/agent-mode'

/**
 * Die Blockliste eines Zuges und ihr Spiegel im Chat-Speicher.
 *
 * Geteilter veraenderlicher Zustand: das Feld `blocks`. In useCodex.ts wurde es
 * von ACHT Stellen quer durch 1500 Zeilen angefasst — Architekt, Repo-Karte,
 * Gedanke, Antwort, zwei Schleifenwaechter-Meldungen, jeder Werkzeugaufruf und
 * jedes Werkzeugergebnis. Drei dieser Stellen (Architekt, Architekt-Absage,
 * Repo-Karte) schrieben `blocks.push(...)` und den Spiegelaufruf HAENDISCH
 * hin, statt `addBlock` zu benutzen; das ist dieselbe Doppelung, die den
 * Zustand irgendwann auseinanderlaufen laesst.
 *
 * DIE ZUSICHERUNG, die daran haengt und die kein Test bisher erreichen konnte:
 * jeder Schreibvorgang gibt eine FRISCHE Liste weiter (`[...blocks]`). React
 * vergleicht flach; wuerde dieselbe Liste zweimal gereicht, blieben neue
 * Bloecke unsichtbar, obwohl sie da sind. Und `update` auf eine unbekannte
 * Kennung tut NICHTS — sie schiebt keinen Block nach und legt keinen an.
 */

export interface AgentBlockSink {
  add(block: AgentBlock): void
  update(blockId: string, updates: Partial<AgentBlock>): void
  /** Die laufende Liste, fuer Leser die nicht schreiben. */
  list(): AgentBlock[]
}

export function createAgentBlockSink(convId: string, messageId: string): AgentBlockSink {
  const blocks: AgentBlock[] = []
  const mirror = () => {
    useChatStore.getState().updateMessageAgentBlocks(convId, messageId, [...blocks])
  }
  return {
    add(block: AgentBlock) {
      blocks.push(block)
      mirror()
    },
    update(blockId: string, updates: Partial<AgentBlock>) {
      const idx = blocks.findIndex((b) => b.id === blockId)
      if (idx < 0) return
      blocks[idx] = { ...blocks[idx], ...updates }
      mirror()
    },
    list: () => blocks,
  }
}
