/**
 * A7 (3.0.8): the first wait of a turn says what it is. David's box,
 * 20.10.2026: 53 seconds of a bare "Starting" while the model read the chat.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { endFirstWait, hiddenThoughtArrived, readingActivity, useRunActivityStore, toolProgressActivity } from '../runActivityStore'
import { deriveRunStatus } from '../../components/status/run-status'

const activity = (id: string) => useRunActivityStore.getState().activity[id]
const set = useRunActivityStore.getState().setActivity

describe('reading the conversation', () => {
  beforeEach(() => { useRunActivityStore.setState({ activity: {} }) })

  it('names the wait and its size, rounded so the line does not twitch', () => {
    expect(readingActivity(5577)).toEqual({ label: 'Reading the conversation', kind: 'reading', detail: '5.6k tokens' })
    expect(readingActivity(12049)).toMatchObject({ detail: '12k tokens' })
    expect(readingActivity(400)).toEqual({ label: 'Reading the conversation', kind: 'reading' })
  })

  it('the status line says it instead of Starting', () => {
    const status = deriveRunStatus({ activity: readingActivity(5577), message: { content: '', agentBlocks: [] } })
    expect(status).toMatchObject({ kind: 'reading', word: 'Reading the conversation', detail: '5.6k tokens' })
  })

  it('gives way to the first word or shown thought, without a Starting flash in between', () => {
    // Seen in the browser run: clearing the line on the first token showed
    // "Starting" for one frame before the token reached the message.
    const reading = readingActivity(5577)
    expect(deriveRunStatus({ activity: reading, message: { content: 'Hallo' } }).kind).toBe('responding')
    expect(deriveRunStatus({ activity: reading, message: { thinking: 'hm' } }).kind).toBe('thinking')
    expect(deriveRunStatus({ activity: { label: 'Thinking', kind: 'thinking' }, message: { content: 'Hallo' } }).kind).toBe('responding')
    // Any other line keeps its priority over streamed text, as before.
    expect(deriveRunStatus({ activity: { label: 'Compacting', kind: 'compacting' }, message: { content: 'x' } }).kind).toBe('compacting')
  })

  it('the first answer takes the line back', () => {
    set('c1', readingActivity(5000))
    endFirstWait('c1')
    expect(activity('c1')).toBeUndefined()
  })

  it('a hidden thought turns it into Thinking, and the answer ends that too', () => {
    set('c1', readingActivity(5000))
    hiddenThoughtArrived('c1')
    expect(activity('c1')).toEqual({ label: 'Thinking', kind: 'thinking' })
    expect(deriveRunStatus({ activity: activity('c1') })).toMatchObject({ kind: 'thinking', word: 'Thinking' })
    endFirstWait('c1')
    expect(activity('c1')).toBeUndefined()
  })

  it('leaves someone else\'s line alone', () => {
    set('c1', { label: 'Compacting', kind: 'compacting' })
    endFirstWait('c1')
    hiddenThoughtArrived('c1')
    expect(activity('c1')).toEqual({ label: 'Compacting', kind: 'compacting' })
    const call = toolProgressActivity({ name: 'web_search', argsChars: 10 } as Parameters<typeof toolProgressActivity>[0])
    set('c2', call)
    endFirstWait('c2')
    expect(activity('c2')).toEqual(call)
  })

  it('both chat paths set it before the request and take it back when the turn ends', () => {
    const src = (f: string) => readFileSync(resolve(__dirname, '..', '..', 'hooks', f), 'utf8')
    const agent = src('useAgentChat.ts')
    expect(agent).toMatch(/if \(stepNo === 1\) \{\n\s+useRunActivityStore\.getState\(\)\.setActivity\(convId, readingActivity\(estPrompt\)\)/)
    // B26: and the watch that says why a long first wait lasts.
    expect(agent).toMatch(/watchChatFirstWait\(convId, activeModel, abort\.signal\)/)
    expect(agent).toMatch(/endFirstWait\(convId\)\n\s+logFirstWait\(\)\n\s+turn = ollamaTurn/)
    expect(agent.match(/hiddenThoughtArrived\(convId\)/g)!.length).toBe(2)
    // Where the first wait went lands in the log file, once per message.
    expect(agent).toMatch(/log\.event\('agent\.first_wait', \{/)
    expect(agent.match(/logFirstWait\(\)/g)!.length).toBe(2)
    const chat = src('useChat.ts')
    expect(chat).toMatch(/setActivity\(convId, readingActivity\(/)
    expect(chat).toMatch(/watchChatFirstWait\(convId, activeModel, abort\.signal\)/)
    expect(chat).toMatch(/endFirstWait\(run\.convId\)/)
  })
})
