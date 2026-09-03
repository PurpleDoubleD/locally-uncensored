/**
 * Die Ausnahme, die der Nutzer ausdruecklich gezogen hat.
 *
 * Wortlaut vom 02.09.2026: "und zwar gilt das auch für JEDEN bereich außer
 * normaler chat. multi agents."
 *
 * Der normale Chat soll also keine Sub-Agenten starten koennen. Beim Nachmessen
 * stellte sich heraus: er kann es heute schon nicht. Der Chat faehrt keine
 * offene Werkzeugliste, sondern die kuratierte `CHAT_TOOLS` — fuenf Namen, und
 * `delegate_task` ist keiner davon.
 *
 * Deshalb steht hier eine Sperrklinke und kein Umbau. Die Regel ist wahr, aber
 * sie war nirgends festgehalten, und eine Wahrheit ohne Sperre ist nur ein
 * Zufall, der bis zum naechsten Commit haelt. Wer `delegate_task` spaeter in
 * die Chat-Liste aufnimmt, tut das dann gegen einen roten Test und eine
 * benannte Entscheidung — statt versehentlich.
 *
 * Run: npx vitest run src/lib/__tests__/multiagent-nicht-im-chat.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CHAT_TOOLS } from '../chat-tool-intent'
import { DELEGATE_TASK_TOOL_DEF } from '../../api/agents/sub-agent'

const SRC = resolve(__dirname, '..', '..')
const lies = (p: string) => readFileSync(resolve(SRC, p), 'utf8')

describe('Multi-Agenten bleiben aus dem normalen Chat heraus', () => {
  it('die kuratierte Chat-Liste kennt delegate_task nicht', () => {
    expect([...CHAT_TOOLS]).not.toContain(DELEGATE_TASK_TOOL_DEF.name)
  })

  it('sie kennt ueberhaupt kein Werkzeug, das einen Agenten startet', () => {
    // Breiter als der Name: auch ein spaeteres `spawn_agent` oder
    // `run_subagent` faellt hier auf, nicht erst im Betrieb.
    const verdaechtig = [...CHAT_TOOLS].filter((t) =>
      /delegate|sub_?agent|spawn|dispatch_task/i.test(t),
    )
    expect(verdaechtig).toEqual([])
  })

  it('der Chat-Pfad reicht die kuratierte Liste durch und keine offene', () => {
    // useChat darf nicht heimlich an CHAT_TOOLS vorbei die volle Registry
    // uebergeben — dann waere die Liste oben Zierrat.
    const chat = lies('hooks/useChat.ts')
    expect(chat).toMatch(/curatedTools:\s*(cloudMode|CHAT_TOOLS)/)
    // Und der Agentenmodus verlaesst diesen Pfad VORHER: sonst liefe der
    // Agent selbst durch die kuratierte Fuenferliste.
    expect(chat).toMatch(/Agent mode already returned above/)
  })

  it('die beiden Werkzeugflaechen fuer Agenten fuehren delegate_task sehr wohl', () => {
    // Die Gegenprobe. Ohne sie wuerde ein Test, der `delegate_task` global
    // entfernt, faelschlich gruen bleiben und behaupten, alles sei in Ordnung.
    const auswahl = lies('lib/tool-selection.ts')
    expect(auswahl).toContain('delegate_task')
    expect(DELEGATE_TASK_TOOL_DEF.name).toBe('delegate_task')
  })
})
