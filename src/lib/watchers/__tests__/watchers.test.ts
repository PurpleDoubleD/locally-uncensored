// Watchers: the rules of the window's half, without React or Tauri.
import { describe, expect, it, vi } from 'vitest'
import { scheduleFromArgs, repeatText, rightsText, whenText } from '../schedule'
import { watcherCaps } from '../caps'
import { createWatcherRunner, shouldNotify, summaryOf, watcherPrompt, type RunnerDeps } from '../runner'
import { NO_RIGHTS, type Watcher } from '../types'
import { asksAboutWatchers, isWatcherToolName } from '../../watcher-tool-names'
import { isSelfControlToolName, withSelfControlTools } from '../../settings-tool-names'
import { stripLine, rowState } from '../../../components/chat/WatcherStrip'

// Saturday 14.11.2026, 12:00 local.
const NOW = new Date(2026, 10, 14, 12, 0, 0, 0).getTime()

function watcher(over: Partial<Watcher> = {}): Watcher {
  return {
    id: 'w1', name: 'Prices', task: 'Check the prices.', schedule: { kind: 'daily', hour: 18, minute: 0, days: [] },
    rights: { ...NO_RIGHTS, web: true }, folder: null, model: null, paused: false, created_at: NOW,
    next_at: new Date(2026, 10, 14, 18, 0).getTime(), running_since: null, conversation_id: null, origin_conversation_id: null, runs: [],
    ...over,
  }
}

describe('the schedule out of the tool call', () => {
  it('reads a time later today as today and an earlier one as tomorrow', () => {
    const later = scheduleFromArgs({ repeat: 'once', time: '18:00' }, NOW)
    expect(later).toEqual({ ok: true, schedule: { kind: 'once', at: new Date(2026, 10, 14, 18, 0).getTime() } })
    const earlier = scheduleFromArgs({ repeat: 'once', time: '08:00' }, NOW)
    expect(earlier).toEqual({ ok: true, schedule: { kind: 'once', at: new Date(2026, 10, 15, 8, 0).getTime() } })
  })

  it('takes in_minutes, a date, weekdays and an interval', () => {
    expect(scheduleFromArgs({ repeat: 'once', in_minutes: 20 }, NOW)).toEqual({ ok: true, schedule: { kind: 'once', at: NOW + 20 * 60_000 } })
    expect(scheduleFromArgs({ repeat: 'once', time: '9:30', date: '2026-11-20' }, NOW))
      .toEqual({ ok: true, schedule: { kind: 'once', at: new Date(2026, 10, 20, 9, 30).getTime() } })
    expect(scheduleFromArgs({ repeat: 'weekdays', time: '07:30', days: ['Fri', 'mon', 'monday'] }, NOW))
      .toEqual({ ok: true, schedule: { kind: 'daily', hour: 7, minute: 30, days: [0, 4] } })
    expect(scheduleFromArgs({ repeat: 'interval', every_minutes: 60 }, NOW)).toEqual({ ok: true, schedule: { kind: 'interval', minutes: 60 } })
  })

  it('says what is missing instead of guessing', () => {
    expect(scheduleFromArgs({ repeat: 'daily' }, NOW).ok).toBe(false)
    expect(scheduleFromArgs({ repeat: 'once', time: '25:00' }, NOW).ok).toBe(false)
    expect(scheduleFromArgs({ repeat: 'weekdays', time: '08:00', days: [] }, NOW).ok).toBe(false)
    expect(scheduleFromArgs({ repeat: 'sometimes', time: '08:00' }, NOW).ok).toBe(false)
  })
})

describe('the words of the line', () => {
  it('names the time the way a person reads it', () => {
    expect(whenText(new Date(2026, 10, 14, 18, 0).getTime(), NOW)).toBe('18:00')
    expect(whenText(new Date(2026, 10, 15, 8, 0).getTime(), NOW)).toBe('tomorrow 08:00')
    expect(whenText(new Date(2026, 10, 16, 7, 30).getTime(), NOW)).toBe('Mon 07:30')
  })

  it('names the repeat and the rights', () => {
    expect(repeatText({ kind: 'daily', hour: 8, minute: 0, days: [] })).toBe('every day 08:00')
    expect(repeatText({ kind: 'daily', hour: 8, minute: 0, days: [0, 1, 2, 3, 4] })).toBe('Mon–Fri 08:00')
    expect(repeatText({ kind: 'interval', minutes: 120 })).toBe('every 2 h')
    expect(rightsText(NO_RIGHTS, null)).toBe('answers only, no tools')
    expect(rightsText({ ...NO_RIGHTS, files: true, terminal: true }, '/Users/a/shop', '/Users/a')).toBe('files and shell in ~/shop')
  })

  it('collapses to one line: one watcher by name, several by count', () => {
    expect(stripLine([], [], NOW)).toBeNull()
    expect(stripLine([watcher()], [], NOW)).toBe('18:00 · Prices')
    const two = [watcher(), watcher({ id: 'w2', name: 'News', next_at: new Date(2026, 10, 14, 13, 0).getTime() })]
    expect(stripLine(two, [], NOW)).toBe('2 watchers · next 13:00')
    expect(stripLine([watcher({ running_since: NOW })], [], NOW)).toBe('running · Prices')
    expect(stripLine([watcher({ paused: true })], [], NOW)).toBe('Prices · paused')
    expect(stripLine([], [{ id: 'x', name: 'News', was_next: null }], NOW)).toBe('News ended when LU quit')
    expect(rowState(watcher({ paused: true }), NOW)).toBe('paused · not run yet')
  })
})

describe('the cap a run carries', () => {
  it('lets through exactly what was ticked, and never the screen or a foreign MCP server', () => {
    const caps = watcherCaps({ ...NO_RIGHTS, web: true, files: true })
    expect(caps).toMatchObject({ web: 'auto', filesystem: 'auto', terminal: 'blocked', image: 'blocked', desktop: 'blocked', mcp: 'blocked', system: 'auto' })
    const all = watcherCaps({ web: true, files: true, terminal: true, create: true, extra_folders: [] })
    expect(all.desktop).toBe('blocked')
    expect(all.mcp).toBe('blocked')
  })
})

describe('the gate of the tools', () => {
  it('opens on a time or a repeat, not on a plain question', () => {
    for (const msg of ['um 18 Uhr prüf die Preise', 'every morning at 8 sum up the news', 'remind me in 20 minutes', 'check at 18:30', 'jeden Morgen um 8']) {
      expect(asksAboutWatchers(msg), msg).toBe(true)
    }
    for (const msg of ['what is the capital of France', 'write a poem about cats', 'stell auto compact auf 80']) {
      expect(asksAboutWatchers(msg), msg).toBe(false)
    }
  })

  it('belongs to the self-control family, but rides on its own gate', () => {
    expect(isWatcherToolName('watcher_create')).toBe(true)
    expect(isSelfControlToolName('watcher_create')).toBe(true)
    const all = [{ name: 'watcher_create' }, { name: 'set_setting' }, { name: 'web_search' }]
    expect(withSelfControlTools([], all, 'um 18 Uhr prüf die Preise').map((t) => t.name)).toEqual(['watcher_create'])
    expect(withSelfControlTools([], all, 'stell die einstellung temperatur auf 0.5').map((t) => t.name)).toEqual(['set_setting'])
  })
})

describe('the run', () => {
  function deps(over: Partial<RunnerDeps> = {}) {
    const calls: string[] = []
    let t = NOW
    const d: RunnerDeps = {
      now: () => (t += 1000),
      chatExists: () => false,
      createChat: () => { calls.push('create'); return 'c1' },
      setWorkspace: (c, f) => { calls.push(`ws ${c} ${f ?? 'sandbox'}`) },
      setCaps: (c) => { calls.push(`caps ${c}`) },
      clearCaps: (c) => { calls.push(`uncap ${c}`) },
      waitForDesk: async () => true,
      currentView: () => ({ convId: 'mine', restore: () => { calls.push('restore') } }),
      focus: (c) => { calls.push(`focus ${c}`) },
      useModel: () => () => { calls.push('model back') },
      send: async (c, content) => { calls.push(`send ${c} ${content.split('\n')[0]}`) },
      lastAnswer: () => ({ text: '**2 offers** under 1,900 €' }),
      wasStopped: () => false,
      denyQuestions: () => { calls.push('deny on'); return () => { calls.push('deny off') } },
      update: vi.fn(async () => null),
      finished: vi.fn(async () => null),
      notify: vi.fn(async () => null),
      notifySettings: () => ({ notify: true, sound: true, notifyOn: 'all' }),
      ...over,
    }
    return { d, calls }
  }

  it('runs the task in its own chat under its cap, then puts everything back and notifies', async () => {
    const { d, calls } = deps({ currentView: (() => { let n = 0; return () => ({ convId: n++ === 0 ? 'mine' : 'c1', restore: () => { calls.push('restore') } }) })() })
    await createWatcherRunner(d).due(watcher())
    expect(calls).toEqual([
      'create', 'ws c1 sandbox', 'caps c1', 'deny on', 'focus c1', 'send c1 Check the prices.',
      'deny off', 'uncap c1', 'model back', 'restore',
    ])
    expect(d.update).toHaveBeenCalledWith('w1', { conversationId: 'c1' })
    expect(d.finished).toHaveBeenCalledWith('w1', expect.objectContaining({ status: 'done', summary: '2 offers under 1,900 €' }))
    expect(d.notify).toHaveBeenCalledWith('Prices', '2 offers under 1,900 €', true)
  })

  it('reports a failed turn as failed, and an error-only setting still notifies it', async () => {
    const { d } = deps({ lastAnswer: () => ({ text: '', error: 'The model could not load.' }), notifySettings: () => ({ notify: true, sound: false, notifyOn: 'errors' }) })
    await createWatcherRunner(d).due(watcher())
    expect(d.finished).toHaveBeenCalledWith('w1', expect.objectContaining({ status: 'failed', summary: 'The model could not load.' }))
    expect(d.notify).toHaveBeenCalledWith('Prices failed', 'The model could not load.', false)
  })

  it('takes the cap off even when the send throws', async () => {
    const { d, calls } = deps({ send: async () => { throw new Error('Another chat was opened.') } })
    await createWatcherRunner(d).due(watcher())
    expect(calls).toContain('uncap c1')
    expect(calls).toContain('deny off')
    expect(d.finished).toHaveBeenCalledWith('w1', expect.objectContaining({ status: 'failed' }))
  })

  it('runs two due watchers one after the other, never at once', async () => {
    let inFlight = 0
    let most = 0
    const { d } = deps({ send: async () => { inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight-- } })
    const r = createWatcherRunner(d)
    await Promise.all([r.due(watcher()), r.due(watcher({ id: 'w2' }))])
    expect(most).toBe(1)
    expect(d.finished).toHaveBeenCalledTimes(2)
  })

  it('reuses the watcher chat while it exists', async () => {
    const { d, calls } = deps({ chatExists: () => true })
    await createWatcherRunner(d).due(watcher({ conversation_id: 'old' }))
    expect(calls).not.toContain('create')
    expect(calls).toContain('send old Check the prices.')
  })

  it('tells the model nobody is watching', () => {
    expect(watcherPrompt(watcher(), new Date(2026, 10, 14, 18, 0).getTime())).toMatch(/Nobody is watching this run: do not ask questions/)
  })

  it('notifies by the settings', () => {
    expect(shouldNotify('done', { notify: true, notifyOn: 'all' })).toBe(true)
    expect(shouldNotify('done', { notify: true, notifyOn: 'errors' })).toBe(false)
    expect(shouldNotify('failed', { notify: true, notifyOn: 'errors' })).toBe(true)
    expect(shouldNotify('failed', { notify: false, notifyOn: 'all' })).toBe(false)
    expect(shouldNotify('stopped', { notify: true, notifyOn: 'all' })).toBe(false)
  })

  it('makes a short plain line out of an answer', () => {
    expect(summaryOf('## Result\n\n- [Shop](https://x.y) has it for **1,849 €**')).toBe('Result - Shop has it for 1,849 €')
    expect(summaryOf('x'.repeat(500)).length).toBe(280)
  })
})
