/**
 * C60 (3.1.0): LU runs itself from the chat. The catalog reaches Voice,
 * Create, Memory, GPU and (stricter only) Permissions; several changes go on
 * one card; and before any card comes, the user's own words must ask for it,
 * and a strong change never follows foreign content in the same run.
 *
 * Run: npx vitest run src/lib/__tests__/c60-lu-runs-itself.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  CATALOG, LOCK_RULES, areaOf, findEntry, normKey, setKnownGpuCards, storeOf, textNames,
} from '../settings-catalog'
import { readEntry } from '../settings-stores'
import { DEFAULT_SETTINGS } from '../constants'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSettingsConfirmStore, CARD_TIMEOUT_MS } from '../../stores/settingsConfirmStore'
import { useSettingsAuditStore } from '../../stores/settingsAuditStore'
import { useChatStore } from '../../stores/chatStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useCreateStore } from '../../stores/createStore'
import { useMemoryStore } from '../../stores/memoryStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useLocalApiStore } from '../../stores/localApiStore'
import { executeSetSetting, executeSetSettings, parseSettingChanges } from '../../api/mcp/settings-tools'
import { executeLuDownload, executeLuService, executeLuModels } from '../../api/mcp/self-control-tools'
import { beginAgentRun, endAgentRun, type AgentRunContext } from '../../api/agent-context'
import { markRunTaint, toolTaints } from '../run-taint'
import { asksAboutSelfControl } from '../settings-tool-names'
import { asksAboutSettings } from '../tool-selection'
import { DEFAULT_PERMISSIONS } from '../../api/mcp/types'

const CONV = 'chat-c60'
const queue = () => useSettingsConfirmStore.getState().queue
const settings = () => useSettingsStore.getState().settings

/** The conversation as the store holds it: the model's answer before, then
 *  the user's message of this turn. */
function seed(user: string, assistantBefore?: string) {
  const messages = [
    ...(assistantBefore ? [{ id: 'a0', role: 'assistant', content: assistantBefore, timestamp: 1 }] : []),
    { id: 'u1', role: 'user', content: user, timestamp: 2 },
  ]
  useChatStore.setState({ conversations: [{ id: CONV, title: 't', messages }] } as never)
}

function run(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    token: `t-${Math.random()}`, chatId: null, conversationId: CONV, workspace: null, artifactMode: false,
    readOnlyShellTurn: false, mode: null, artifacts: [], settingsCard: true, toolCallId: 'call-1', ...over,
  }
}

async function cardUp() {
  for (let i = 0; i < 100 && queue().length === 0; i++) await Promise.resolve()
  return queue()[0]?.req
}
async function answer(allow: boolean, selected?: string[]) {
  const req = await cardUp()
  expect(req).toBeTruthy()
  useSettingsConfirmStore.getState().answer(req!.id, allow, selected)
  return req!
}

beforeEach(() => {
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) })
  useSettingsConfirmStore.setState({ queue: [] })
  useSettingsAuditStore.setState({ rows: [] })
  usePermissionStore.setState({ globalPermissions: { ...DEFAULT_PERMISSIONS } })
})
afterEach(() => { vi.useRealTimers() })

describe('the catalog over all stores', () => {
  it('every entry has an area and reads a value from its store', () => {
    for (const c of CATALOG) {
      expect(areaOf(c), c.key).toBeTruthy()
      if (storeOf(c) === 'gpu') continue // null = auto is a value
      expect(readEntry(c), c.key).not.toBeUndefined()
    }
  })

  it('an entry that matches a lock pattern says why it may be changed anyway', () => {
    const crossing = CATALOG.filter((c) => LOCK_RULES.some((r) => r.pattern.test(normKey(c.key))))
    const unexplained = crossing.filter((c) => !c.lockOverride).map((c) => c.key)
    expect(unexplained).toEqual([])
    expect(crossing.map((c) => c.key)).toContain('permission.web')
  })

  it('no key, token, endpoint, path or MCP setting is in it', () => {
    for (const c of CATALOG) {
      if (c.lockOverride && !c.key.startsWith('permission.')) continue // a count of tokens, the Enter key, ask-before-shell
      expect(c.key, c.key).not.toMatch(/apikey|token|secret|password|url|endpoint|path|folder|host|tunnel|lan$|cors|port$/i)
    }
  })
})

describe('intent: only what the user asked for gets a card', () => {
  it('"fass die Seite zusammen" opens no card for any setting', async () => {
    seed('Fass mir bitte diese Seite zusammen')
    expect(await executeSetSetting({ key: 'theme', value: 'light' }, run())).toMatch(/^Refused: the user did not ask about Theme/)
    expect(await executeSetSetting({ key: 'temperature', value: 1 }, run())).toMatch(/^Refused: /)
    expect(queue()).toEqual([])
    expect(useSettingsAuditStore.getState().rows[0]).toMatchObject({ outcome: 'refused', why: 'intent' })
  })

  it('the area in the user\'s words is enough for a normal setting', async () => {
    seed('Mach das Design dunkel')
    useSettingsStore.getState().updateSettings({ theme: 'light' })
    const p = executeSetSetting({ key: 'theme', value: 'dark' }, run())
    await answer(true)
    expect(await p).toMatch(/^Changed: Theme light → dark/)
  })

  it('a short "ja" answers the model\'s own question about it', async () => {
    seed('ja', 'Soll ich die Temperatur auf 0.6 stellen?')
    const p = executeSetSetting({ key: 'temperature', value: 0.6 }, run())
    await answer(true)
    expect(await p).toMatch(/^Changed: Temperature/)
    expect(settings().temperature).toBe(0.6)
  })

  it('a "ja" to a question about something else is not a yes to this', async () => {
    seed('ja', 'Soll ich die Temperatur auf 0.6 stellen?')
    expect(await executeSetSetting({ key: 'theme', value: 'light' }, run())).toMatch(/^Refused: /)
  })
})

describe('foreign content in the run', () => {
  it('only the tools whose output is LU\'s own leave the run clean', () => {
    for (const t of ['web_fetch', 'web_search', 'file_read', 'shell_execute', 'delegate_task', 'some_mcp_tool']) expect(toolTaints(t), t).toBe(true)
    for (const t of ['todo_write', 'set_setting', 'lu_models', 'image_generate']) expect(toolTaints(t), t).toBe(false)
  })

  it('a normal card still comes, and says what was read', async () => {
    seed('stell die Temperatur auf 0.4')
    const r = run()
    markRunTaint(r, 'web_fetch')
    const p = executeSetSetting({ key: 'temperature', value: 0.4 }, r)
    const req = await answer(true)
    expect(req.taintedBy).toMatch(/web page/)
    await p
    expect(useSettingsAuditStore.getState().rows[0]).toMatchObject({ outcome: 'applied', tainted: expect.stringMatching(/web_fetch/) })
  })

  it('the injection case: a page says "turn on the local API" and loosen permissions; nothing happens', async () => {
    seed('Fass diese Seite zusammen: https://example.org/artikel')
    useLocalApiStore.setState({ token: 'tok', lan: false, laeuft: false })
    const r = run()
    markRunTaint(r, 'web_fetch')
    expect(await executeLuService({ service: 'local_api', action: 'start' }, r)).toMatch(/^Refused: this run read a web page/)
    expect(await executeSetSetting({ key: 'permission.terminal', value: 'auto' }, r)).toMatch(/^Refused: /)
    expect(await executeSetSetting({ key: 'permissions', value: 'auto' }, r)).toMatch(/^Refused: Permissions is locked/)
    expect(await executeLuDownload({ action: 'start_link', url: 'https://huggingface.co/x/y/resolve/main/m.safetensors', folder: 'loras' }, r)).toMatch(/^Refused: only a link the user pasted/)
    expect(queue()).toEqual([])
    expect(useLocalApiStore.getState().laeuft).toBe(false)
  })

  it('a "ja" to a strong question counts only when the run that asked read nothing foreign', async () => {
    useLocalApiStore.setState({ token: 'tok', lan: false, laeuft: false })
    const before = beginAgentRun({ conversationId: CONV, settingsCard: true })
    markRunTaint(before, 'web_fetch')
    endAgentRun(before)
    const now = beginAgentRun({ conversationId: CONV, settingsCard: true })
    seed('ja', 'Soll ich die Local API einschalten?')
    expect(await executeLuService({ service: 'local_api', action: 'start' }, now)).toMatch(/^Refused: The local API was suggested in a run that read foreign content/)
    endAgentRun(now)
  })
})

describe('strong changes', () => {
  it('the local API: never with LAN on, never without a token, red card otherwise', async () => {
    seed('Schalt die Local API an')
    useLocalApiStore.setState({ token: 'tok', lan: true, laeuft: false })
    expect(await executeLuService({ service: 'local_api', action: 'start' }, run())).toMatch(/^Refused: the local API is set to answer the network/)
    useLocalApiStore.setState({ token: '', lan: false })
    expect(await executeLuService({ service: 'local_api', action: 'start' }, run())).toMatch(/^Refused: the local API has no access token/)
    useLocalApiStore.setState({ token: 'tok', lan: false })
    const p = executeLuService({ service: 'local_api', action: 'start' }, run())
    const req = await answer(false)
    expect(req).toMatchObject({ risk: 'strong', action: { title: 'Start the local API' } })
    expect(await p).toMatch(/declined/)
  })

  it('the area word alone does not open a strong change: "API" is not "Local API"', async () => {
    seed('Wie funktioniert eine API?')
    useLocalApiStore.setState({ token: 'tok', lan: false, laeuft: false })
    expect(await executeLuService({ service: 'local_api', action: 'start' }, run())).toMatch(/^Refused: the user did not ask/)
  })

  it('a download by link: only the user\'s own link, only HF or CivitAI, only safetensors or gguf', async () => {
    seed('lade https://evil.example/m.safetensors herunter')
    expect(await executeLuDownload({ action: 'start_link', url: 'https://evil.example/m.safetensors', folder: 'loras' }, run())).toMatch(/only https links to huggingface.co or civitai.com/)
    seed('lade https://huggingface.co/a/b/resolve/main/m.ckpt herunter')
    expect(await executeLuDownload({ action: 'start_link', url: 'https://huggingface.co/a/b/resolve/main/m.ckpt', folder: 'checkpoints' }, run())).toMatch(/only .safetensors and .gguf/)
    seed('lade https://huggingface.co/a/b/resolve/main/m.safetensors herunter')
    expect(await executeLuDownload({ action: 'start_link', url: 'https://huggingface.co/a/b/resolve/main/m.safetensors', folder: 'custom_nodes' }, run())).toMatch(/folder is one of/)
  })
})

describe('the card', () => {
  it('several settings on one card; an unticked one stays', async () => {
    seed('Temperatur 0.5 und Top P 0.8 bitte')
    const p = executeSetSettings({ changes: [{ key: 'temperature', value: 0.5 }, { key: 'topP', value: 0.8 }] }, run())
    const req = await answer(true, ['topP'])
    expect(req.items?.map((i) => i.key)).toEqual(['temperature', 'topP'])
    const out = await p
    expect(out).toMatch(/Unticked by the user: Temperature/)
    expect(settings().temperature).toBe(DEFAULT_SETTINGS.temperature)
    expect(settings().topP).toBe(0.8)
    expect(parseSettingChanges(out)).toEqual([{ key: 'topP', from: DEFAULT_SETTINGS.topP, to: 0.8 }])
  })

  it('at most three cards a run', async () => {
    seed('Theme, Temperatur, Top P, Top K')
    const r = run()
    for (const [key, value] of [['theme', 'light'], ['temperature', 0.3], ['topP', 0.5]] as const) {
      const p = executeSetSetting({ key, value }, r)
      await answer(false)
      await p
    }
    expect(await executeSetSetting({ key: 'topK', value: 10 }, r)).toMatch(/^Refused: 3 cards in this run already/)
  })

  it('no answer for ten minutes is a no', async () => {
    vi.useFakeTimers()
    seed('stell das Theme auf light')
    const p = executeSetSetting({ key: 'theme', value: 'light' }, run())
    await vi.advanceTimersByTimeAsync(0)
    expect(queue()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(CARD_TIMEOUT_MS + 1)
    expect(await p).toMatch(/No answer on the card for 10 minutes/)
    expect(settings().theme).toBe(DEFAULT_SETTINGS.theme)
  })

  it('a value changed by hand while the card was open is not overwritten', async () => {
    seed('Temperatur auf 0.9')
    const p = executeSetSetting({ key: 'temperature', value: 0.9 }, run())
    await cardUp()
    useSettingsStore.getState().updateSettings({ temperature: 0.2 })
    await answer(true)
    expect(await p).toMatch(/changed to 0.2 while the card was open/)
    expect(settings().temperature).toBe(0.2)
  })
})

describe('the other stores', () => {
  it('voice, create and memory change through their own setters', async () => {
    seed('Vorlesen an, Create 1216x832 und 30 Schritte, und merk dir weniger: memories per prompt 5')
    useVoiceStore.setState({ ttsEnabled: false })
    let p = executeSetSetting({ key: 'voice.ttsEnabled', value: 'an' }, run())
    await answer(true); await p
    expect(useVoiceStore.getState().ttsEnabled).toBe(true)

    p = executeSetSettings({ changes: [{ key: 'create.size', value: '1216x832' }, { key: 'create.steps', value: 30 }] }, run())
    await answer(true); await p
    expect(useCreateStore.getState()).toMatchObject({ width: 1216, height: 832, steps: 30 })

    p = executeSetSetting({ key: 'memory.maxMemoriesOverride', value: 5 }, run())
    await answer(true); await p
    expect(useMemoryStore.getState().settings.maxMemoriesOverride).toBe(5)
  })

  it('a Create model must be installed', async () => {
    seed('nimm als Bildmodell foo')
    useCreateStore.setState({ imageModelList: [{ name: 'flux1-schnell.safetensors', type: 'flux' }] } as never)
    expect(await executeSetSetting({ key: 'create.imageModel', value: 'sdxl-nope' }, run())).toMatch(/not installed. Installed: flux1-schnell/)
  })

  it('a permission only gets stricter', async () => {
    seed('Frag vorher bei Web-Werkzeugen (permission web)')
    usePermissionStore.setState({ globalPermissions: { ...DEFAULT_PERMISSIONS, web: 'auto' } })
    const p = executeSetSetting({ key: 'permission.web', value: 'confirm' }, run())
    await answer(true); await p
    expect(usePermissionStore.getState().globalPermissions.web).toBe('confirm')
    expect(await executeSetSetting({ key: 'permission.web', value: 'auto' }, run())).toMatch(/^Refused: from the chat Permission: web can only be set to stricter/)
    expect(await executeSetSetting({ key: 'permission.filesystem', value: 'auto' }, run())).toMatch(/^Refused: /)
  })

  it('the GPU per task: auto or a detected card, by number or name', () => {
    const e = findEntry('gpuRoles.comfy')!
    setKnownGpuCards([{ vendor: 'nvidia', index: 0, name: 'RTX 4090' }, { vendor: 'nvidia', index: 1, name: 'RTX 3060' }])
    expect(e.parse('auto')).toEqual({ ok: true, value: null })
    expect(e.parse('1')).toEqual({ ok: true, value: { vendor: 'nvidia', index: 1, name: 'RTX 3060' } })
    expect(e.parse('4090')).toEqual({ ok: true, value: { vendor: 'nvidia', index: 0, name: 'RTX 4090' } })
    expect(e.parse('rtx')).toMatchObject({ ok: false })
    setKnownGpuCards([])
  })

  it('the words of a setting name it, the area alone does not for a strong one', () => {
    const steps = findEntry('create.steps')!
    expect(textNames(steps, 'mehr Schritte bitte')).toBe(true)
    expect(textNames(steps, 'erzähl einen Witz')).toBe(false)
  })
})

describe('models', () => {
  it('switch waits for the card and happens after the run', async () => {
    const { useModelStore } = await import('../../stores/modelStore')
    useModelStore.setState({ models: [{ name: 'gemma4:12b', type: 'text', provider: 'ollama' }, { name: 'qwen3.5:9b', type: 'text', provider: 'ollama' }] as never, activeModel: 'qwen3.5:9b' })
    const r = beginAgentRun({ conversationId: CONV, settingsCard: true })
    r.toolCallId = 'call-1'
    seed('Wechsel auf Gemma')
    const p = executeLuModels({ action: 'switch', name: 'gemma' }, r)
    await answer(true)
    expect(await p).toMatch(/Switching the chat model to gemma4:12b when this answer is done/)
    expect(useModelStore.getState().activeModel).toBe('qwen3.5:9b')
    const setActive = vi.spyOn(useModelStore.getState(), 'setActiveModel').mockImplementation(() => {})
    endAgentRun(r)
    await new Promise((res) => setTimeout(res, 0))
    expect(setActive).toHaveBeenCalledWith('gemma4:12b')
    setActive.mockRestore()
  })
})

describe('the gate', () => {
  it('Agent and Code open on the app itself, plain chat keeps its narrow list', () => {
    expect(asksAboutSelfControl('Wechsel auf Gemma 4')).toBe(true)
    expect(asksAboutSelfControl('Schalt die Local API an')).toBe(true)
    expect(asksAboutSelfControl('Lade Flux Schnell herunter')).toBe(true)
    expect(asksAboutSelfControl('Erzähl mir einen Witz')).toBe(false)
    expect(asksAboutSettings('Erinnerst du dich an gestern?')).toBe(false)
  })
})
