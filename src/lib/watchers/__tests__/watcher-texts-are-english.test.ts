// Watchers: every text a user or a model reads is English (David, 14.11.2026:
// a notification read "LU-wächter"). The feature is "Watchers", one is a
// "Watcher". German only lives in the lists that READ what a user typed
// ("jeden Morgen", "um 18 Uhr"), and those are never shown.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WATCHER_TOOLS } from '../../../api/mcp/watcher-tools'
import { WATCHER_PROMPT_LINE } from '../../watcher-tool-names'
import { repeatText, rightsText, whenText } from '../schedule'
import { watcherPrompt, summaryOf } from '../runner'
import { stripLine, rowState } from '../../../components/chat/WatcherStrip'
import { NO_RIGHTS, type Watcher } from '../types'

const ROOT = resolve(__dirname, '../../../..')
const GERMAN = /[äöüÄÖÜß]|\b(waechter|wächter|uhr|jeden|täglich|einstellung|benachrichtigung|löschen|pausieren|fortsetzen|nächste|ergebnis|fehler)\b/i

/** The files whose string literals are shown, with the lines that only read input. */
const SHOWN: Record<string, RegExp | null> = {
  'src/components/chat/WatcherStrip.tsx': null,
  'src/components/settings/WatcherSettings.tsx': null,
  'src/lib/watchers/schedule.ts': null,
  'src/lib/watchers/runner.ts': null,
  'src/lib/watchers/caps.ts': null,
  'src/lib/watchers/tool-exec.ts': /\.test\(t\)/, // intent patterns over the user's own words
  'src/api/mcp/watcher-tools.ts': null,
  'src-tauri/src/watchers.rs': null,
}

/** String literals of a line, without comments. */
function literals(line: string): string[] {
  const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/\s.*$/, '')
  return [...code.matchAll(/'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g)].map((m) => m[0])
}

describe('the watcher texts are English', () => {
  it('no string literal a user or model reads carries German or an umlaut', () => {
    const found: string[] = []
    for (const [file, readsInput] of Object.entries(SHOWN)) {
      const lines = readFileSync(resolve(ROOT, file), 'utf8').split('\n')
      let inTests = false
      lines.forEach((line, i) => {
        if (file.endsWith('.rs') && line.startsWith('#[cfg(test)]')) inTests = true
        if (inTests || (readsInput && readsInput.test(line))) return
        for (const lit of literals(line)) if (GERMAN.test(lit)) found.push(`${file}:${i + 1} ${lit}`)
      })
    }
    expect(found).toEqual([])
  })

  it('the tool texts and the prompt line are plain ASCII English', () => {
    const all = [WATCHER_PROMPT_LINE, JSON.stringify(WATCHER_TOOLS)]
    for (const t of all) {
      expect(t).not.toMatch(GERMAN)
      expect(/^[\x20-\x7e…–]*$/.test(t.replace(/\\n/g, ' ')), t.slice(0, 80)).toBe(true)
    }
    for (const tool of WATCHER_TOOLS) expect(tool.name).toMatch(/^watcher_[a-z]+$/)
  })

  it('what the line, the list and a run produce is English', () => {
    const now = new Date(2026, 10, 14, 12, 0).getTime()
    const w: Watcher = {
      id: 'w', name: 'Prices', task: 'Check.', schedule: { kind: 'daily', hour: 8, minute: 0, days: [0, 1, 2, 3, 4] },
      rights: { ...NO_RIGHTS, files: true }, folder: '/x/shop', model: null, paused: true, created_at: 0,
      next_at: now + 3600_000, running_since: null, conversation_id: null, origin_conversation_id: null,
      runs: [{ at: now - 60_000, ms: 1, status: 'failed', summary: '' }],
    }
    const out = [
      stripLine([w], [], now), stripLine([w, { ...w, id: 'v', paused: false }], [{ id: 'h', name: 'News', was_next: now }], now),
      stripLine([], [{ id: 'h', name: 'News', was_next: null }], now), rowState(w, now), repeatText(w.schedule),
      repeatText({ kind: 'interval', minutes: 30 }), repeatText({ kind: 'once', at: now }), rightsText(w.rights, w.folder),
      rightsText(NO_RIGHTS, null), whenText(now + 26 * 3600_000, now), watcherPrompt(w, now), summaryOf('**done**'),
    ]
    for (const t of out) expect(t ?? '').not.toMatch(GERMAN)
  })
})
