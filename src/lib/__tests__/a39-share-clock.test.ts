/**
 * 3.1.2, A39 (GitHub #257): a user writing a story saw the model quote the
 * date, the time and the timezone of the run as facts of the story. The clock
 * line of agent runs ("Date and time at the start of this run: …") now sits
 * behind the switch "Share date and time with the model", on by default.
 * Off, it reaches no prompt: agent chat, Codex, sub-agent, the phone app's
 * remote agent and the relay page. The plain chat never had it.
 *
 * Run: npx vitest run src/lib/__tests__/a39-share-clock.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../constants'
import { agentClockLine, clockShared } from '../clock-share'
import { hostClockLine, platformPromptLine } from '../host-platform'
import { buildSubAgentSystemPrompt } from '../../api/agents/sub-agent'
import { buildRemoteSystemPrompt } from '../../mobile/remote/remoteAgent'
import { buildTurnContext } from '../turn-context'
import { SETTINGS_TAB_RESET_KEYS } from '../settings-reset'

const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', '..', ...p), 'utf8')
const root = (...p: string[]) => readFileSync(resolve(__dirname, '..', '..', '..', ...p), 'utf8')
const AT_NOON = new Date('2026-11-18T12:00:00Z')
const CLOCK = 'Date and time at the start of this run'

const share = (on: boolean) => useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, shareClockWithModel: on } })

beforeEach(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } }))

describe('A39: the switch', () => {
  it('is on by default and part of the Agent reset', () => {
    expect(DEFAULT_SETTINGS.shareClockWithModel).toBe(true)
    expect(clockShared()).toBe(true)
    expect(SETTINGS_TAB_RESET_KEYS.agent).toContain('shareClockWithModel')
  })

  it('a settings file from before 3.1.2 (no key) shares the clock', () => {
    const { shareClockWithModel: _gone, ...old } = DEFAULT_SETTINGS
    useSettingsStore.setState({ settings: old as typeof DEFAULT_SETTINGS })
    expect(clockShared()).toBe(true)
  })

  it('on: the line is the host clock line; off: empty', () => {
    expect(agentClockLine(AT_NOON)).toBe(hostClockLine(AT_NOON))
    share(false)
    expect(clockShared()).toBe(false)
    expect(agentClockLine(AT_NOON)).toBe('')
  })

  it('sits in Agent Permissions, in the existing list', () => {
    const page = read('components', 'settings', 'SettingsPage.tsx')
    const section = page.slice(page.indexOf('<Section title="Agent Permissions">'))
    const toggle = section.indexOf('label="Share date and time with the model"')
    expect(toggle).toBeGreaterThan(-1)
    expect(toggle).toBeLessThan(section.indexOf('</Section>'))
    expect(section).toContain('updateSettings({ shareClockWithModel: settings.shareClockWithModel === false })')
  })
})

describe('A39: every path follows the switch', () => {
  it('agent chat: the turn note carries the clock only while it is on', () => {
    expect(buildTurnContext({ clock: agentClockLine(AT_NOON) })).toContain(CLOCK)
    share(false)
    expect(buildTurnContext({ clock: agentClockLine(AT_NOON) })).toBe('')
    const src = read('hooks', 'useAgentChat.ts')
    expect(src).toContain('buildTurnContext({ memory: memoryContext, rag: ragSuffix, clock: agentClockLine() })')
    expect(src).not.toMatch(/hostClockLine\(/)
  })

  it('Codex: appends the line only when there is one', () => {
    const src = read('hooks', 'useCodex.ts')
    expect(src).toContain('const clockLine = agentClockLine()')
    expect(src).toContain('if (clockLine) systemPrompt += `\\n\\n${clockLine}`')
    expect(src).not.toMatch(/hostClockLine\(/)
  })

  it('sub-agent: on, the clock closes the prompt; off, none and no empty tail', () => {
    expect(buildSubAgentSystemPrompt()).toContain(CLOCK)
    share(false)
    const off = buildSubAgentSystemPrompt()
    expect(off).not.toContain(CLOCK)
    expect(off.endsWith(platformPromptLine())).toBe(true)
  })

  it('phone app remote agent: follows the desktop, on when an older desktop says nothing', () => {
    const base = { caveman: 'off' as const, persona: null, desktopPrompt: '', agent: true, platformLine: 'This machine runs macOS.', now: AT_NOON }
    expect(buildRemoteSystemPrompt(base)).toContain(CLOCK)
    expect(buildRemoteSystemPrompt({ ...base, shareClock: true })).toContain(CLOCK)
    const off = buildRemoteSystemPrompt({ ...base, shareClock: false })
    expect(off).not.toContain(CLOCK)
    expect(off).toContain('This machine runs macOS.')
    const store = read('mobile', 'remote', 'remoteClientStore.ts')
    expect(store).toContain('shareClock: hostConfig?.shareClock !== false')
    const client = read('mobile', 'remote', 'remoteClient.ts')
    expect(client).toContain('shareClock: data.shareClock !== false')
  })

  it('relay page and remote server: /config carries the switch, the page honours it', () => {
    const page = root('mobile-client', 'client.js')
    expect(page).toContain('hostShareClock = cfg.shareClock !== false;')
    expect(page).toContain('if(hostShareClock) parts.push(hostClockLine());')
    const rust = root('src-tauri', 'src', 'commands', 'remote.rs')
    expect(rust).toContain('"shareClock": SHARE_CLOCK.load(')
    const sync = read('lib', 'clock-share-remote.ts')
    expect(sync).toContain("backendCall('set_remote_share_clock', { share })")
    expect(read('App.tsx')).toContain('startRemoteShareClockSync()')
  })

  it('no other place in the app puts the clock line into a prompt', () => {
    // hostClockLine is called only behind the switch: clock-share.ts and the
    // remote builder, which takes the switch as input.
    const users = ['hooks/useChat.ts', 'hooks/useAgentChat.ts', 'hooks/useCodex.ts', 'api/agents/sub-agent.ts']
    for (const f of users) expect(read(...f.split('/')), f).not.toMatch(/hostClockLine\(|hostEnvironmentBlock\(/)
  })
})
