/**
 * A11: the model reads and changes LU's settings through get_settings and
 * set_setting. Every key is classified, the security relevant ones are locked
 * under any name, one-way keys only move the safe way, and nothing changes
 * before the user's yes.
 *
 * Run: npx vitest run src/lib/__tests__/settings-tool.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { CATALOG, HIDDEN_KEYS, LOCK_RULES, type LockedCategory } from '../settings-catalog'
import { DEFAULT_SETTINGS } from '../constants'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSettingsConfirmStore } from '../../stores/settingsConfirmStore'
import { useChatStore } from '../../stores/chatStore'
import { executeGetSettings, executeSetSetting, parseSettingChange, SETTINGS_TOOLS } from '../../api/mcp/settings-tools'
import { asksAboutSettings, gateCreateTools, selectRelevantTools } from '../tool-selection'
import { allowedInReadOnlyTurn } from '../mutating-tools'
import { toolCallCapMs } from '../tool-timeout'
import { toolRegistry, DEFAULT_PERMISSIONS } from '../../api/mcp'
import type { AgentRunContext } from '../../api/agent-context'

const run = (over: Partial<AgentRunContext> = {}): AgentRunContext => ({
  token: 't', chatId: null, conversationId: 'chat-a', workspace: null, artifactMode: false,
  readOnlyShellTurn: false, mode: null, artifacts: [], settingsCard: true, toolCallId: 'call-1', ...over,
})
const settings = () => useSettingsStore.getState().settings
const queue = () => useSettingsConfirmStore.getState().queue

/** Waits until the card is up, then answers it. */
async function answerCard(allow: boolean) {
  for (let i = 0; i < 50 && queue().length === 0; i++) await Promise.resolve()
  const req = queue()[0]?.req
  expect(req).toBeTruthy()
  useSettingsConfirmStore.getState().answer(req!.id, allow)
  return req!
}

/** C60: a card only comes when the user's own message asks for the setting.
 *  These tests are about what happens after that, so the user asked. */
const ASKED = 'Settings: auto compact threshold 80, theme light, temperature 1.5, engine context 16384, default coding mode ask'
function seedTurn(text = ASKED) {
  useChatStore.setState({
    conversations: [{ id: 'chat-a', title: 't', messages: [{ id: 'u1', role: 'user', content: text, timestamp: 1 }] }],
  } as never)
}

beforeEach(() => {
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) })
  useSettingsConfirmStore.setState({ queue: [] })
  seedTurn()
})

describe('every setting is classified', () => {
  // The keys of `interface Settings`, read from the source, so an optional key
  // without a default is caught too.
  const src = readFileSync(resolve(__dirname, '../../types/settings.ts'), 'utf8')
  const body = src.slice(src.indexOf('export interface Settings {'), src.indexOf('export interface Persona'))
  const keys = [...body.matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => m[1])
  const engineBody = src.slice(src.indexOf('export interface BuiltinEngineTuning {'), src.indexOf('export interface Settings {'))
  const engineKeys = [...engineBody.matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => `builtinEngine.${m[1]}`)
  const listed = new Set<string>([
    ...CATALOG.map((c) => c.key), ...HIDDEN_KEYS, ...LOCK_RULES.flatMap((r) => r.names),
  ])

  it('reads the keys at all', () => {
    expect(keys.length).toBeGreaterThan(50)
    expect(keys).toContain('autoCompactThreshold')
    expect(engineKeys).toContain('builtinEngine.ctx')
  })

  it('each key is in the catalog, locked or hidden', () => {
    const missing = [...keys.filter((k) => k !== 'builtinEngine'), ...engineKeys].filter((k) => !listed.has(k))
    expect(missing).toEqual([])
  })

  it('no key is in two lists', () => {
    const all = [...CATALOG.map((c) => c.key), ...HIDDEN_KEYS, ...LOCK_RULES.flatMap((r) => r.names)]
    expect(all.filter((k, i) => all.indexOf(k) !== i)).toEqual([])
  })
})

describe('locked: refused under any name, nothing changes, no card', () => {
  const cases: [LockedCategory, string[]][] = [
    ['computer-control', ['computerControl', 'computer_use_enabled', 'allowMouseAndKeyboard']],
    ['remote-access', ['remotePageTitle', 'remoteAccess', 'remote_enabled', 'localApiPort', 'lanAccess']],
    ['permissions', ['permissions', 'sandboxLevel', 'bypass', 'autoApproveAll', 'filesystemPermission']],
    ['keys', ['braveApiKey', 'tavilyApiKey', 'hfToken', 'openai_api_key', 'githubToken']],
    ['paths', ['apiEndpoint', 'hfDownloadPathOverride', 'defaultWorkspace', 'comfyuiPath', 'pythonExecutable']],
    ['plugins', ['reaPluginEnabled', 'mcpServers', 'installPlugin', 'customNodes', 'createEnabled']],
    ['persona-text', ['systemPrompt', 'personaPrompt', 'characterCard']],
  ]
  for (const [category, names] of cases) {
    it(category, async () => {
      const before = structuredClone(settings())
      const rule = LOCK_RULES.find((r) => r.category === category)!
      for (const key of names) {
        const out = await executeSetSetting({ key, value: 'on' }, run())
        expect(out, key).toMatch(/^Refused: /)
        expect(out, key).toContain(rule.what)
        expect(out, key).toContain(rule.where)
      }
      expect(queue()).toEqual([])
      expect(settings()).toEqual(before)
    })
  }

  it('get_settings names the locked ones and never shows a key value', async () => {
    useSettingsStore.getState().updateSettings({ braveApiKey: 'brv-secret-123' })
    const all = await executeGetSettings({})
    expect(all).toContain('Locked')
    expect(all).not.toContain('brv-secret-123')
    expect(all).not.toMatch(/braveApiKey|apiEndpoint|remotePageTitle/)
    expect(await executeGetSettings({ query: 'braveApiKey' })).toMatch(/^Refused: API keys/)
  })
})

describe('one way only', () => {
  it('bypass, cloud and auto-apply are refused, the safe direction asks', async () => {
    for (const [key, value] of [['codexDefaultMode', 'bypass'], ['appMode', 'cloud'], ['codexAutoApply', 'on'],
      ['codexConfirmShell', 'off'], ['memoryCloudOptIn', 'on'], ['codexArchitectAllowCloud', 'true']] as const) {
      const out = await executeSetSetting({ key, value }, run())
      expect(out, key).toMatch(/^Refused: /)
    }
    expect(queue()).toEqual([])
    useSettingsStore.getState().updateSettings({ codexDefaultMode: 'bypass' })
    const p = executeSetSetting({ key: 'codexDefaultMode', value: 'ask' }, run())
    await answerCard(true)
    expect(await p).toMatch(/^Changed: /)
    expect(settings().codexDefaultMode).toBe('ask')
  })
})

describe('set_setting', () => {
  it('auto compact: 80 % becomes 0.8 after Accept, the answer carries the undo data', async () => {
    const p = executeSetSetting({ key: 'autoCompactThreshold', value: '80' }, run())
    const req = await answerCard(true)
    expect(req).toMatchObject({ label: 'Auto-compact at', from: 'auto', to: '80 %', toolCallId: 'call-1' })
    const out = await p
    expect(settings().autoCompactThreshold).toBe(0.8)
    expect(out).toContain('auto → 80 %')
    expect(parseSettingChange(out)).toEqual({ key: 'autoCompactThreshold', from: 0, to: 0.8 })
  })

  it('"auf 400" is refused with the reason, before any card', async () => {
    const out = await executeSetSetting({ key: 'autoCompactThreshold', value: 400 }, run())
    expect(out).toMatch(/percent of the context window, not in tokens/)
    expect(out).toContain('30–95')
    expect(queue()).toEqual([])
    expect(settings().autoCompactThreshold).toBe(0)
  })

  it('Decline and Stop change nothing', async () => {
    const p = executeSetSetting({ key: 'theme', value: 'light' }, run())
    await answerCard(false)
    expect(await p).toMatch(/declined/)
    expect(settings().theme).toBe(DEFAULT_SETTINGS.theme)
    const ac = new AbortController()
    const q = executeSetSetting({ key: 'temperature', value: 1.5 }, run(), ac.signal)
    for (let i = 0; i < 50 && queue().length === 0; i++) await Promise.resolve()
    ac.abort()
    expect(await q).toMatch(/declined/)
    expect(queue()).toEqual([])
    expect(settings().temperature).toBe(DEFAULT_SETTINGS.temperature)
  })

  it('refuses where no card is drawn (voice, workflow, outside a run)', async () => {
    expect(await executeSetSetting({ key: 'theme', value: 'light' }, run({ settingsCard: undefined }))).toMatch(/^Error: .*confirmation card/)
    expect(await executeSetSetting({ key: 'theme', value: 'light' })).toMatch(/^Error: /)
    expect(queue()).toEqual([])
  })

  it('an unknown key names the closest ones, a bad value the range', async () => {
    expect(await executeSetSetting({ key: 'autoCompaktThreshhold', value: 80 }, run())).toMatch(/Closest: .*autoCompact/)
    expect(await executeSetSetting({ key: 'temperature', value: 9 }, run())).toMatch(/Allowed: 0–1.5/)
    expect(await executeSetSetting({ key: 'onboardingDone', value: false }, run())).toMatch(/no setting "onboardingDone"/)
  })

  it('the LU Engine context is set inside builtinEngine and marked as chosen', async () => {
    const p = executeSetSetting({ key: 'builtinEngine.ctx', value: 16384 }, run())
    await answerCard(true)
    await p
    expect(settings().builtinEngine).toMatchObject({ ctx: 16384, ctxChosen: true, flashAttn: DEFAULT_SETTINGS.builtinEngine.flashAttn })
  })
})

describe('where the tools ride along', () => {
  it('the gate opens on settings words only', () => {
    expect(asksAboutSettings('stell Auto Compact auf 80')).toBe(true)
    expect(asksAboutSettings('Switch to dark mode please')).toBe(true)
    expect(asksAboutSettings('Was kannst du in den Einstellungen ändern?')).toBe(true)
    expect(asksAboutSettings('Erzähl mir einen Witz')).toBe(false)
    expect(asksAboutSettings('fix the failing test in auth.ts')).toBe(false)
  })

  it('in Code they pass the keyword gate only when asked, and drop out of a read-only turn', () => {
    const defs = toolRegistry.getAvailableTools(DEFAULT_PERMISSIONS)
    const names = (list: { name: string }[]) => list.map((t) => t.name).filter((n) => n.includes('setting'))
    expect(names(gateCreateTools(defs, 'refactor the parser'))).toEqual([])
    // C60: the batch change and the settings page come along on the same gate.
    expect(names(gateCreateTools(defs, 'set the temperature to 0.3'))).toEqual(['get_settings', 'set_setting', 'set_settings', 'lu_open_settings'])
    expect(names(selectRelevantTools('set the temperature to 0.3', defs, DEFAULT_PERMISSIONS))).toEqual(['get_settings', 'set_setting', 'set_settings', 'lu_open_settings'])
    expect(allowedInReadOnlyTurn('set_setting')).toBe(false)
    expect(allowedInReadOnlyTurn('get_settings')).toBe(true)
  })

  it('the card has all the time it needs', () => {
    expect(toolCallCapMs('set_setting', {}, {})).toBeGreaterThan(60 * 60_000)
  })

  it('both definitions stay small (about 200 tokens together)', () => {
    const wire = JSON.stringify(SETTINGS_TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })))
    expect(wire.length / 4).toBeLessThan(220)
  })
})
