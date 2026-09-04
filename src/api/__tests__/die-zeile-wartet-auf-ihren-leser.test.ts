/**
 * @vitest-environment jsdom
 *
 * Eine Zeile, die nur im Chat gezeichnet wird, darf nicht ablaufen, waehrend
 * der Nutzer in den Einstellungen steht.
 *
 * Beide Ansagen ueber eine Wahl, die sich von selbst geaendert hat, werden von
 * den Einstellungen aus ausgeloest. Der gemessene Fall G1 (04.09.2026) ist
 * "Provider LM Studio wieder herausgenommen", der zweite ist "Enable auf der
 * Standby-Karte". Gezeichnet wird die Zeile aber von `LuEngineSwitchBar`, und
 * die haengt ueber dem Eingabefeld im Chat und auf der Models-Seite, nicht im
 * Einstellungsblatt. Auf der gewoehnlichen Zwoelf-Sekunden-Uhr lief sie also
 * genau dort ab, wo niemand sie sehen konnte, und der Kunde kam in einen Chat
 * zurueck, in dem ein anderes Modell stand und kein Wort dazu. Das war der
 * Befund, und die Zeile allein hat ihn nicht behoben.
 *
 * Run: npx vitest run src/api/__tests__/die-zeile-wartet-auf-ihren-leser.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../backend', () => ({
  backendCall: vi.fn(async () => ({})),
  isTauri: () => false,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const {
  announceChatModelReplaced, announceChatModelLostItsEngine, UNSEEN_NOTE_HOLD_MS,
} = await import('../lu-engine-switch')
const { useLuEngineSwitchStore, LU_ENGINE_SWITCH_NOTE_MS, HOLD_CHECK_MS } =
  await import('../../stores/luEngineSwitchStore')
const { useUIStore } = await import('../../stores/uiStore')

const WEG = 'openai::Qwen3-4B-Q4_K_M'
const STATT = 'openai::G1-Kaputt-Q4_K_M'

const zeile = () => useLuEngineSwitchStore.getState().note
const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

beforeEach(() => {
  vi.useFakeTimers()
  useLuEngineSwitchStore.getState().dismiss()
  useUIStore.setState({ currentView: 'settings' })
})
afterEach(() => {
  useLuEngineSwitchStore.getState().dismiss()
  useUIStore.setState({ currentView: 'chat' })
  vi.useRealTimers()
})

describe('die Zeile ueber die selbst getauschte Wahl', () => {
  it('steht noch, wenn der Nutzer nach 12,44 s immer noch in den Einstellungen ist', () => {
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(12_440)
    expect(zeile()).not.toBeNull()
  })

  it('und laeuft erst ab, nachdem er im Chat war', () => {
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(30_000)
    expect(zeile()).not.toBeNull()

    useUIStore.setState({ currentView: 'chat' })
    // Der Halt wird im Sekundentakt geprueft, danach beginnt die Lesezeit bei
    // null.
    vi.advanceTimersByTime(HOLD_CHECK_MS + LU_ENGINE_SWITCH_NOTE_MS - 1_000)
    expect(zeile()).not.toBeNull()
    vi.advanceTimersByTime(2 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile()).toBeNull()
  })

  it('die Models-Seite zaehlt auch, die Zeile haengt dort ebenfalls', () => {
    useUIStore.setState({ currentView: 'models' })
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(2 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile(), 'auf einer Seite, die sie zeigt, gilt die gewoehnliche Uhr').toBeNull()
  })

  it('bleibt nicht ewig stehen, wenn er nie zurueckkommt', () => {
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(UNSEEN_NOTE_HOLD_MS + 3 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile()).toBeNull()
  })

  // Negativkontrolle: genau die alte Ansage, an genau diesem Ablauf.
  it('die alte Ansage ohne Halt waere in den Einstellungen verfallen', () => {
    useLuEngineSwitchStore.getState().announce('irgendein Satz ohne Halt', 'info')
    vi.advanceTimersByTime(12_440)
    expect(zeile()).toBeNull()
  })
})

describe('die Zeile ueber die mit dem Steckplatz gefallene Wahl', () => {
  it('wartet genauso, sie wird sogar in den Einstellungen ausgeloest', () => {
    announceChatModelLostItsEngine(WEG, 'LM Studio')
    vi.advanceTimersByTime(12_440)
    expect(zeile()).not.toBeNull()
    useUIStore.setState({ currentView: 'chat' })
    vi.advanceTimersByTime(HOLD_CHECK_MS + 2 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile()).toBeNull()
  })

  it('ohne Namen des Uebernehmers bleibt der Satz trotzdem ein Satz', () => {
    announceChatModelLostItsEngine(WEG, null)
    expect(zeile()).toContain('another backend')
    expect(zeile()).toContain('Qwen3-4B-Q4_K_M')
  })
})

describe('warum genau diese beiden Seiten', () => {
  it('die Zeile haengt im Chat und auf der Models-Seite', () => {
    expect(lies('components/chat/ChatView.tsx')).toContain('<LuEngineSwitchBar />')
    const models = lies('components/models/ModelManager.tsx') + lies('components/models/DiscoverModels.tsx')
    expect(models).toContain('<LuEngineSwitchBar />')
  })

  it('und nicht im Einstellungsblatt, wo beide Ausloeser sitzen', () => {
    const settings = lies('components/settings/SettingsPage.tsx') + lies('components/settings/ProviderConfig.tsx')
    expect(settings).not.toContain('LuEngineSwitchBar')
    // Beide Ausloeser stehen wirklich dort: Remove auf der Provider-Karte und
    // Enable auf der Standby-Karte.
    expect(lies('components/settings/ProviderConfig.tsx')).toContain('slotHandbackUpdate')
  })
})
