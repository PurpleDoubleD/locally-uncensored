/**
 * 3.0.0 leftover, found 2026-09-11: the compaction budget still called a
 * self-hosted LAN server a paid provider.
 *
 * GH #129 taught `useActiveContextWindow` that the `openai` slot can hold a
 * llama.cpp on this machine as easily as api.openai.com, and gave that case
 * `sendWindow = contextWindow`. The budget path next to it never learned it:
 * `PAID_PROVIDER_IDS` has `openai` in it, so `effectiveSendWindow` clamped the
 * reporter's 262144-token local model to 64000 and compacted a history that
 * nobody was ever going to be billed for.
 *
 * The two now ask ONE question (lib/lan-openai-slot), the same one the context
 * fix asks: the slot's own isLocal flag, or a private/loopback host.
 *
 * Run: npx vitest run src/lib/__tests__/a-lan-server-is-not-a-bill.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

vi.mock('../../api/backend', () => ({
  // The real rule, reimplemented nowhere: the classifier calls this and the
  // test needs it to answer for the hosts below.
  isPrivateOrLanHost: (host: string) =>
    /^(127\.|localhost$|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host),
  hostnameOf: (url: string) => { try { return new URL(url).hostname } catch { return '' } },
  isTauri: () => false,
}))

const { useProviderStore } = await import('../../stores/providerStore')
const { effectiveSendWindow, isPaidProvider, DEFAULT_SEND_WINDOW_TOKENS, WINDOW_SHARE } =
  await import('../send-window')
const { isLanOpenAiBackend, sendsToALanBackend } = await import('../lan-openai-slot')
const { chatSendBudget, chatAnswerReserve } = await import('../chat-send-budget')

const LOCAL_MODEL_WINDOW = 262144

/** Point the shared `openai` slot at one base URL, with an explicit isLocal. */
function slotPointsAt(baseUrl: string, isLocal: boolean) {
  const providers = useProviderStore.getState().providers
  useProviderStore.setState({
    providers: {
      ...providers,
      openai: { ...providers.openai, baseUrl, isLocal, enabled: true, managed: false },
    },
  })
}

beforeEach(() => { slotPointsAt('https://api.openai.com/v1', false) })

describe('the one classification', () => {
  it('calls a loopback server local even when the flag says nothing', () => {
    slotPointsAt('http://127.0.0.1:8080/v1', false)
    expect(isLanOpenAiBackend()).toBe(true)
  })

  it('calls a LAN address local', () => {
    slotPointsAt('http://192.168.1.54:8000/v1', false)
    expect(isLanOpenAiBackend()).toBe(true)
  })

  it('believes the slot flag for a host it cannot judge', () => {
    slotPointsAt('http://my-workstation.lan:8080/v1', true)
    expect(isLanOpenAiBackend()).toBe(true)
  })

  it('does not call api.openai.com local', () => {
    expect(isLanOpenAiBackend()).toBe(false)
  })

  // The answer must never be given without the provider id: a llama.cpp in the
  // openai slot does not make a send to LU Cloud free.
  it('never lets a LAN openai slot speak for another provider', () => {
    slotPointsAt('http://127.0.0.1:8080/v1', true)
    expect(sendsToALanBackend('openai', null)).toBe(true)
    expect(sendsToALanBackend('lu-cloud', null)).toBe(false)
    expect(sendsToALanBackend('anthropic', null)).toBe(false)
  })
})

describe('the budget follows it', () => {
  it('gives a LAN custom backend its whole local budget', () => {
    slotPointsAt('http://127.0.0.1:8080/v1', false)
    const budget = effectiveSendWindow({
      providerId: 'openai',
      modelWindow: LOCAL_MODEL_WINDOW,
      localBackend: sendsToALanBackend('openai', null),
    })
    expect(budget).toBe(Math.floor(LOCAL_MODEL_WINDOW * WINDOW_SHARE))
    expect(budget).toBeGreaterThan(DEFAULT_SEND_WINDOW_TOKENS)
  })

  it('counter-check: the same slot pointed at a paid remote keeps the clamp', () => {
    const budget = effectiveSendWindow({
      providerId: 'openai',
      modelWindow: LOCAL_MODEL_WINDOW,
      localBackend: sendsToALanBackend('openai', null),
    })
    expect(budget).toBe(DEFAULT_SEND_WINDOW_TOKENS)
  })

  it('leaves a real paid provider clamped even while a LAN slot is configured', () => {
    slotPointsAt('http://127.0.0.1:8080/v1', true)
    expect(
      effectiveSendWindow({
        providerId: 'lu-cloud',
        modelWindow: LOCAL_MODEL_WINDOW,
        localBackend: sendsToALanBackend('lu-cloud', null),
      }),
    ).toBe(DEFAULT_SEND_WINDOW_TOKENS)
  })

  it('says so in the cost question itself', () => {
    expect(isPaidProvider('openai')).toBe(true)
    expect(isPaidProvider('openai', true)).toBe(false)
    expect(isPaidProvider('lu-cloud', true)).toBe(false)
    // Nothing passed is the pre-3.0.0 answer, so no caller that was never
    // touched can change behaviour by accident.
    expect(isPaidProvider('openai', undefined)).toBe(true)
    expect(isPaidProvider('ollama')).toBe(false)
  })

  it('carries through the chat surfaces too', () => {
    slotPointsAt('http://192.168.1.54:8000/v1', false)
    const local = chatSendBudget({
      providerId: 'openai',
      modelWindow: LOCAL_MODEL_WINDOW,
      localBackend: sendsToALanBackend('openai', null),
    })
    // GH #201: a conversation on a local server keeps its window less the
    // answer's room, not 0.8 of it.
    expect(local).toBe(LOCAL_MODEL_WINDOW - chatAnswerReserve(LOCAL_MODEL_WINDOW))

    slotPointsAt('https://api.openai.com/v1', false)
    expect(
      chatSendBudget({
        providerId: 'openai',
        modelWindow: LOCAL_MODEL_WINDOW,
        localBackend: sendsToALanBackend('openai', null),
      }),
    ).toBe(DEFAULT_SEND_WINDOW_TOKENS)
  })
})

/**
 * The flag is only as good as the call sites, and a budget that forgets it is
 * silently back to the bug. Reading the sources is the only way to catch the
 * next `effectiveSendWindow({ ... })` that goes in without it.
 */
/**
 * Alles zwischen der eben geoeffneten Klammer und der, die sie schliesst.
 * Eine Textsuche nach dem naechsten `},` faellt ueber jedes Objekt im ersten
 * Argument, und genau dort steht bei beiden Aufrufen eine Nachrichtenliste.
 */
function argumentsOf(afterOpenParen: string): string {
  let depth = 1
  for (let i = 0; i < afterOpenParen.length; i++) {
    const c = afterOpenParen[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return afterOpenParen.slice(0, i)
    }
  }
  return afterOpenParen
}

describe('no budget is computed without asking the question', () => {
  const SITES = [
    'src/hooks/useAgentChat.ts',
    'src/hooks/useCodex.ts',
    'src/hooks/useActiveContextWindow.ts',
    'src/lib/run-compact-command.ts',
    'src/lib/chat-send-budget.ts',
  ]

  it('every production call passes localBackend', () => {
    for (const site of SITES) {
      const src = readFileSync(resolve(process.cwd(), site), 'utf8')
      const calls = src.split('effectiveSendWindow({').slice(1)
      expect(calls.length, `${site} no longer computes a send window`).toBeGreaterThan(0)
      for (const call of calls) {
        const body = call.slice(0, call.indexOf('})'))
        expect(body, `${site} computes a send window without localBackend`).toContain('localBackend')
        // GitHub #173: and asks about the server of THIS model, not the slot.
        if (body.includes('sendsToALanBackend(')) {
          expect(body, `${site} asks sendsToALanBackend without the model`).toMatch(/sendsToALanBackend\(\w+, \w+\)/)
        }
      }
    }
  })

  /**
   * R2-4: das hier war eine Dateitextsuche. Sie fand die eine Stelle, die das
   * Feld setzte, und sagte nichts ueber die zweite daneben, die es wegliess.
   * `useChat.ts` baut ZWEI Budgets, eines fuer die Gruppenrunde und eines fuer
   * den Hauptpfad, und genau dem Hauptpfad fehlte es (R2-3). Jetzt wird wie im
   * Nachbartest zerlegt und jeder Block einzeln gefragt.
   */
  it('and every budget input of the chat surfaces fills the field', () => {
    for (const site of ['src/hooks/useChat.ts', 'src/hooks/useABCompare.ts']) {
      const src = readFileSync(resolve(process.cwd(), site), 'utf8')
      // Beide Namen, unter denen ein Chatbudget gebaut wird. useABCompare geht
      // ueber sharedChatSendBudget, useChat ueber applyChatSendBudget, und
      // useChat baut zwei davon.
      const calls = [
        ...src.split('applyChatSendBudget(').slice(1),
        ...src.split('sharedChatSendBudget(').slice(1),
      ].map(argumentsOf)
      expect(calls.length, `${site} no longer builds a send budget`).toBeGreaterThan(0)
      for (const [i, call] of calls.entries()) {
        expect(call, `${site} budget ${i + 1} of ${calls.length} without localBackend`)
          // GitHub #173: useChat names the model too, so a model of an
          // additional OpenAI-compatible entry asks about ITS server.
          .toMatch(/localBackend: sendsToALanBackend\(providerId, (model|activeModel|m)\)/)
      }
    }
  })

  /**
   * Und was das am Hauptpfad in Tokens ausmacht. Der eigene Server im Netz
   * stellt keine Rechnung, also gilt dort das eigene Fenster weniger dem
   * Platz fuer die Antwort (GH #201, vorher 0.8 mal das Fenster) und nicht
   * die Kostendeckelung fuer bezahlte Anbieter.
   */
  it('a LAN server in the openai slot keeps its own window on the main path', () => {
    slotPointsAt('http://127.0.0.1:8080/v1', true)
    expect(
      chatSendBudget({
        providerId: 'openai',
        modelWindow: 262_144,
        localBackend: sendsToALanBackend('openai', null),
      }),
    ).toBe(262_144 - 8192)

    slotPointsAt('https://api.openai.com/v1', false)
    expect(
      chatSendBudget({
        providerId: 'openai',
        modelWindow: 262_144,
        localBackend: sendsToALanBackend('openai', null),
      }),
    ).toBe(DEFAULT_SEND_WINDOW_TOKENS)
  })
})
