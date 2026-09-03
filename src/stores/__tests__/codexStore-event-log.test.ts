/**
 * The Codex thread event log is bounded.
 *
 * It grew forever and kept every event of the session. Each `terminal_output`
 * carries the UNTRUNCATED shell result (useCodex's 60k cap applies to what goes
 * back to the MODEL, not to what is stored here) and each `file_change` carries
 * a full unified diff — so a 200-iteration run held tens of megabytes for as
 * long as the app stayed open, on a store that is never persisted and whose
 * content nothing reads.
 *
 * Kept rather than removed: the one consumer in the tree, CodexView, uses
 * `events.length` as half of its auto-scroll trigger key, and the log is the
 * obvious place for a real transcript reader to land later.
 *
 * Run: npx vitest run src/stores/__tests__/codexStore-event-log.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useCodexStore } from '../codexStore'

const CONV = 'conv-events'

beforeEach(() => {
  useCodexStore.setState({ threads: {}, fileTreeVersion: 0 })
  useCodexStore.getState().initThread(CONV, '/tmp/project')
})

const addOutputs = (n: number, size = 10) => {
  for (let i = 0; i < n; i++) {
    useCodexStore.getState().addEvent(CONV, {
      id: `e${i}`,
      type: 'terminal_output',
      content: 'x'.repeat(size),
      timestamp: i,
    })
  }
}

describe('codexStore — the event log has a ceiling', () => {
  it('a long run cannot grow the log without bound', () => {
    addOutputs(1200)
    expect(useCodexStore.getState().getThread(CONV)!.events.length).toBe(500)
  })

  it('the ceiling drops the OLDEST events, so the newest transcript survives', () => {
    addOutputs(600)
    const events = useCodexStore.getState().getThread(CONV)!.events
    expect(events[0].id).toBe('e100')
    expect(events[events.length - 1].id).toBe('e599')
  })

  it('a normal run is untouched by the cap', () => {
    addOutputs(40)
    expect(useCodexStore.getState().getThread(CONV)!.events.length).toBe(40)
  })

  it('the fileTreeVersion bump still fires for every mutating event, capped or not', () => {
    // The explorer panel reloads off this counter; capping the ARRAY must not
    // start swallowing the signal that files changed.
    addOutputs(600)
    expect(useCodexStore.getState().fileTreeVersion).toBe(600)
  })

  it('a non-mutating event still does not bump it', () => {
    useCodexStore.getState().addEvent(CONV, {
      id: 'i1', type: 'instruction', content: 'do a thing', timestamp: 0,
    })
    expect(useCodexStore.getState().fileTreeVersion).toBe(0)
  })

  it('the only consumer reads length, and re-pins on height anyway', () => {
    // Documents WHY capping the length is safe. If someone later renders the
    // events themselves, this test is the place that says the cap exists.
    const view = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/chat/CodexView.tsx'),
      'utf8',
    )
    expect(view).toContain('thread?.events?.length')
    expect(view).toContain('useAutoScroll(')
    // Nothing reads an event's content.
    expect(view).not.toContain('events.map(')
  })
})
