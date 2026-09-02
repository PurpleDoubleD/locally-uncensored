/**
 * A4, the budget half: the three conversation surfaces stop sending the whole
 * history to a paid provider.
 *
 * Plain chat, a group round (per model) and compare (both sides) all resolve
 * their payload through this module, so the numbers below are the numbers that
 * go over the wire. Every claim has its negative control: the cap is one
 * setting away from off.
 *
 * Seit 2.6.8 (Compact-Schritt 2) gilt die Deckelung auch lokal — aber an einem
 * anderen Mass: ein bezahlter Anbieter wird auf die KOSTEN-Decke gekappt, ein
 * lokaler nur auf sein eigenes Fenster. Die Zusicherung fuer lokale Modelle ist
 * damit nicht mehr "nie", sondern "erst beim Ueberlauf": unter 92 Prozent des
 * Fensters ist die Nutzlast Wort fuer Wort die von 2.6.7, darueber wird gekappt
 * statt vom Modell stillschweigend vorne abgeschnitten.
 */

import { describe, it, expect } from 'vitest'
import {
  applyChatSendBudget,
  applySendBudget,
  chatBudgetApplies,
  chatSendBudget,
  sharedChatSendBudget,
} from '../chat-send-budget'
import { estimateMessageTokens, MAX_SEND_MESSAGES } from '../context-compaction'
import { DEFAULT_SEND_WINDOW_TOKENS } from '../send-window'

interface Wire {
  role: string
  content: string
  images?: { data: string; mimeType: string }[]
}

const size = (msgs: Wire[]) => estimateMessageTokens(msgs as never)

/** A history of roughly `tokens` tokens, in ordinary chat-sized turns. */
function historyOf(tokens: number): Wire[] {
  const perMessage = 500
  const chars = 'x '.repeat(perMessage) // ~1000 chars, ~250 tokens
  const out: Wire[] = [{ role: 'system', content: 'be helpful' }]
  while (size(out) < tokens) {
    out.push({ role: 'user', content: `q${out.length} ${chars}` })
    out.push({ role: 'assistant', content: `a${out.length} ${chars}` })
  }
  return out
}

const CLOUD_32K = { providerId: 'lu-cloud', modelWindow: 32768, contextDecay: true }
const CLOUD_262K = { providerId: 'lu-cloud', modelWindow: 262144, contextDecay: true }
const OLLAMA = { providerId: 'ollama', modelWindow: 262144, contextDecay: true }
/** Ein lokales Modell mit einem Fenster, das eine lange Unterhaltung sprengt. */
const OLLAMA_8K = { providerId: 'ollama', modelWindow: 8192, contextDecay: true }
/** Die Grenze, ab der die A3-Hysterese auf einem lokalen Modell greift. */
const TRIGGER_8K = Math.floor(Math.floor(8192 * 0.8) * 1.15)

describe('A4: a long chat costs budget level, not history level', () => {
  it('a 50k-token history plus a short question sends at most the budget', () => {
    const history = historyOf(50000)
    history.push({ role: 'user', content: 'and shorter please' })
    expect(size(history)).toBeGreaterThan(50000)

    const budget = chatSendBudget(CLOUD_32K)!
    expect(budget).toBe(Math.floor(32768 * 0.8))
    const sent = applyChatSendBudget(history, CLOUD_32K)
    expect(sent.promptTokens).toBeLessThanOrEqual(budget)
    expect(size(sent.messages)).toBeLessThanOrEqual(budget)
  })

  it('negative control: without the cap the same turn sends the whole 50k', () => {
    const history = historyOf(50000)
    history.push({ role: 'user', content: 'and shorter please' })
    const sent = applyChatSendBudget(history, { ...CLOUD_32K, contextDecay: false })
    expect(sent.budget).toBeNull()
    expect(sent.promptTokens).toBeGreaterThan(50000)
    expect(sent.messages).toBe(history)
  })

  it('a 262k model is capped at the 64k send window, not at 209k', () => {
    const history = historyOf(120000)
    expect(chatSendBudget(CLOUD_262K)).toBe(DEFAULT_SEND_WINDOW_TOKENS)
    const sent = applyChatSendBudget(history, CLOUD_262K)
    expect(sent.promptTokens).toBeLessThanOrEqual(DEFAULT_SEND_WINDOW_TOKENS)
  })

  it('negative control: the same history uncapped is over 100k', () => {
    const history = historyOf(120000)
    const sent = applyChatSendBudget(history, { ...CLOUD_262K, contextDecay: false })
    expect(sent.promptTokens).toBeGreaterThan(100000)
  })

  it('the power-user setting still raises it', () => {
    expect(chatSendBudget({ ...CLOUD_262K, sendWindowTokens: 128000 })).toBe(128000)
  })

  it('keeps the last messages, so the question being asked is always sent', () => {
    const history = historyOf(50000)
    history.push({ role: 'user', content: 'and shorter please' })
    const sent = applyChatSendBudget(history, CLOUD_32K)
    expect(sent.messages[sent.messages.length - 1].content).toBe('and shorter please')
    expect(sent.messages[0].role).toBe('system')
  })
})

describe('2.6.8: ein lokales Modell wird gekappt — aber erst, wo es ueberlaeuft', () => {
  // Die Zusicherung, die 2.6.7 universell galt und jetzt eine Grenze hat: was
  // ins Fenster passt, geht unveraendert raus. Der Nutzer soll von diesem
  // Umbau in einer normalen Unterhaltung nichts merken.
  it('laesst eine Unterhaltung unter der Grenze Wort fuer Wort durch', () => {
    const history = historyOf(2000)
    history.push({
      role: 'user',
      content: 'look',
      images: [{ data: 'A'.repeat(40000), mimeType: 'image/png' }],
    })
    expect(size(history)).toBeLessThan(TRIGGER_8K)
    const before = JSON.stringify(history)
    const sent = applyChatSendBudget(history, OLLAMA_8K)
    expect(JSON.stringify(sent.messages)).toBe(before)
    expect(sent.droppedImages).toBe(0)
  })

  // Der eigentliche Befund C1: hier hat 2.6.7 das ganze Array rausgeschickt,
  // und das Modell hat vorne abgeschnitten, ohne es zu sagen.
  it('kappt eine Unterhaltung, die das Fenster sprengt', () => {
    const history = historyOf(50000)
    expect(size(history)).toBeGreaterThan(TRIGGER_8K)
    const sent = applyChatSendBudget(history, OLLAMA_8K)
    expect(sent.budget).toBe(Math.floor(8192 * 0.8))
    expect(sent.promptTokens).toBeLessThanOrEqual(sent.budget!)
    expect(sent.messages.length).toBeLessThan(history.length)
  })

  // Negativkontrolle in der Zeit: derselbe Fall war vor diesem Umbau
  // ungekappt, und der Notaus stellt genau diesen Zustand wieder her.
  it('der Notaus stellt das Verhalten von 2.6.7 wieder her', () => {
    const history = historyOf(50000)
    const sent = applyChatSendBudget(history, { ...OLLAMA_8K, contextDecay: false })
    expect(sent.budget).toBeNull()
    expect(sent.messages).toBe(history)
  })

  // Die Zahl, die der Modulkopf von chat-send-budget.ts behauptet: nicht bei
  // 0,8 des Fensters, sondern bei 1,15 x 0,8 = 0,92 — der Rest ist der Platz,
  // den die ANTWORT braucht.
  it('die Grenze liegt bei 92 Prozent des Fensters, nicht bei 80', () => {
    expect(TRIGGER_8K / 8192).toBeCloseTo(0.92, 2)
    const knappDrunter = historyOf(TRIGGER_8K - 800)
    expect(applyChatSendBudget(knappDrunter, OLLAMA_8K).messages.length)
      .toBe(knappDrunter.length)
  })

  it('negative control: the same history on lu-cloud does shrink', () => {
    const history = historyOf(120000)
    expect(applyChatSendBudget(history, CLOUD_262K).messages.length).toBeLessThan(history.length)
  })

  it('an unknown window resolves to no cap rather than to a tiny one', () => {
    expect(chatSendBudget({ providerId: 'lu-cloud', modelWindow: 0, contextDecay: true })).toBeNull()
  })

  it('nur der Notaus schliesst das Tor — der Anbieter nicht mehr', () => {
    // Bis 2.6.7 fragte das Tor `isPaidProvider`, also eine KOSTEN-Frage. Die
    // entscheidet weiter die GROESSE der Decke, aber nicht mehr, ob ueberhaupt
    // gekappt wird: ein uebergelaufenes Fenster ist kein Abrechnungsproblem.
    expect(chatBudgetApplies('ollama', true)).toBe(true)
    expect(chatBudgetApplies('lm-studio', true)).toBe(true)
    expect(chatBudgetApplies('openai', undefined)).toBe(true)
    expect(chatBudgetApplies('lu-cloud', true)).toBe(true)
    // Der Notaus gilt fuer alle, lokal wie Cloud.
    expect(chatBudgetApplies('lu-cloud', false)).toBe(false)
    expect(chatBudgetApplies('ollama', false)).toBe(false)
  })

  it('die Kostendecke bleibt den bezahlten Anbietern vorbehalten', () => {
    // Gleiches Fenster, zwei Anbieter: der bezahlte wird zusaetzlich auf
    // codexSendWindowTokens gedeckelt, der lokale nur auf sein eigenes
    // Fenster. Das ist der Unterschied, den `isPaidProvider` weiter macht.
    expect(chatSendBudget({ providerId: 'ollama', modelWindow: 262144, contextDecay: true }))
      .toBe(Math.floor(262144 * 0.8))
    expect(chatSendBudget(CLOUD_262K)).toBe(DEFAULT_SEND_WINDOW_TOKENS)
  })
})

describe('A4: a group round is budgeted per model per round', () => {
  it('every model in the line-up gets the same ceiling on the shared history', () => {
    const shared = historyOf(120000)
    for (const model of [CLOUD_262K, CLOUD_262K, CLOUD_32K]) {
      const sent = applyChatSendBudget(shared, model)
      expect(sent.promptTokens).toBeLessThanOrEqual(chatSendBudget(model)!)
    }
  })

  it('ein lokales Mitglied wird an seinem eigenen Fenster gemessen', () => {
    // Der gefaehrlichste Platz fuer ein kleines lokales Modell: es traegt
    // dieselbe geteilte Historie wie das 262k-Modell neben ihm. Bis 2.6.7 ging
    // sie ungekappt an beide.
    const shared = historyOf(120000)
    const sent = applyChatSendBudget(shared, OLLAMA_8K)
    expect(sent.budget).toBe(Math.floor(8192 * 0.8))
    expect(sent.promptTokens).toBeLessThanOrEqual(sent.budget!)
    // Und das grosse lokale Modell derselben Runde behaelt ein Vielfaches
    // davon. Was seine Nutzlast begrenzt, ist nicht die neue Token-Decke
    // (209715 waere sie), sondern MAX_SEND_MESSAGES — die aeltere Anzahl-Decke,
    // die diese Historie mit ihren ~480 kurzen Zuegen schon vorher traf.
    const gross = applyChatSendBudget(shared, OLLAMA)
    expect(gross.promptTokens).toBeGreaterThan(sent.promptTokens * 10)
    expect(gross.promptTokens).toBeLessThan(gross.budget!)
    expect(gross.messages.length).toBeLessThanOrEqual(MAX_SEND_MESSAGES)
    expect(gross.messages.length).toBeLessThan(shared.length)
  })

  it('negative control: uncapped, one round bills the full history N times', () => {
    const shared = historyOf(120000)
    const perModel = [CLOUD_262K, CLOUD_262K, CLOUD_32K].map(
      (m) => applyChatSendBudget(shared, { ...m, contextDecay: false }).promptTokens,
    )
    expect(Math.min(...perModel)).toBeGreaterThan(100000)
  })
})

describe('A4: compare caps the shared base before the fan-out', () => {
  const bothSides = [CLOUD_262K, CLOUD_32K]

  it('takes the tightest of the two budgets', () => {
    expect(sharedChatSendBudget(bothSides)).toBe(Math.floor(32768 * 0.8))
  })

  it('sends both sides the same payload, under budget', () => {
    const history = historyOf(120000)
    const budget = sharedChatSendBudget(bothSides)!
    const sent = applySendBudget(history, budget)
    expect(sent.promptTokens).toBeLessThanOrEqual(budget)
    // One array, handed to A and to B: two models that were given different
    // prompts are not being compared.
    expect(applySendBudget(history, budget).messages.length).toBe(sent.messages.length)
  })

  it('zwei lokale Modelle teilen sich das engere ihrer Fenster', () => {
    // Beide Seiten muessen denselben Prompt sehen, sonst ist der Vergleich
    // keiner — also gilt auch unter lokalen Modellen das kleinere Fenster.
    expect(sharedChatSendBudget([OLLAMA, OLLAMA])).toBe(Math.floor(262144 * 0.8))
    expect(sharedChatSendBudget([OLLAMA, OLLAMA_8K])).toBe(Math.floor(8192 * 0.8))
    // Mit dem Notaus auf beiden Seiten bleibt es beim ungekappten Array.
    const aus = [OLLAMA, OLLAMA_8K].map((m) => ({ ...m, contextDecay: false }))
    expect(sharedChatSendBudget(aus)).toBeNull()
    const history = historyOf(50000)
    expect(applySendBudget(history, null).messages).toBe(history)
  })

  it('a mixed pairing takes the paid budget for both, so the prompts match', () => {
    expect(sharedChatSendBudget([OLLAMA, CLOUD_32K])).toBe(Math.floor(32768 * 0.8))
  })

  it('negative control: with the notaus off nothing is capped', () => {
    expect(sharedChatSendBudget(bothSides.map((s) => ({ ...s, contextDecay: false })))).toBeNull()
  })
})

describe('A4: the count cap stays the second barrier', () => {
  it('a chat of many short turns is cut by count even under the token budget', () => {
    const many: Wire[] = [{ role: 'system', content: 'be helpful' }]
    for (let i = 0; i < 600; i++) {
      many.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `t${i}` })
    }
    expect(size(many)).toBeLessThan(chatSendBudget(CLOUD_262K)!)
    const sent = applyChatSendBudget(many, CLOUD_262K)
    expect(sent.messages.length).toBeLessThanOrEqual(MAX_SEND_MESSAGES)
  })
})

describe('A4: old attachments are dropped on the chat path too', () => {
  it('reports the pictures it left behind', () => {
    const pixels = 'A'.repeat(40000)
    const history: Wire[] = [{ role: 'system', content: 'be helpful' }]
    for (let i = 1; i <= 6; i++) {
      history.push({ role: 'user', content: `q${i}`, images: [{ data: pixels, mimeType: 'image/png' }] })
      history.push({ role: 'assistant', content: `a${i}` })
    }
    const sent = applyChatSendBudget(history, CLOUD_262K)
    expect(sent.droppedImages).toBe(4)
    const rode = sent.messages.filter((m) => m.images?.length)
    expect(rode.map((m) => m.content)).toEqual(['q5', 'q6'])
  })

  it('negative control: with the notaus off all six ride along', () => {
    const pixels = 'A'.repeat(40000)
    const history: Wire[] = [{ role: 'system', content: 'be helpful' }]
    for (let i = 1; i <= 6; i++) {
      history.push({ role: 'user', content: `q${i}`, images: [{ data: pixels, mimeType: 'image/png' }] })
      history.push({ role: 'assistant', content: `a${i}` })
    }
    const sent = applyChatSendBudget(history, { ...CLOUD_262K, contextDecay: false })
    expect(sent.droppedImages).toBe(0)
    expect(sent.messages.filter((m) => m.images?.length)).toHaveLength(6)
  })
})
