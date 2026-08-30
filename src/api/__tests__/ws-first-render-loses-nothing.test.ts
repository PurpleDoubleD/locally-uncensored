/**
 * R16 Befund 1, measured on the Windows box (2026-08-30): on the FIRST image
 * render after an app start, not one loading line appeared. The waiting area
 * went "Preparing workflow" (+0.8 s), "Building workflow" (+9.1 s),
 * "Submitting to ComfyUI" (+9.9 s), "Queued" (+14.1 s) and then said nothing
 * until +34 s. From the SECOND render on, "Loading VAE", "Loading text
 * encoder" and "Loading the model into memory" all showed up. Restarting
 * ComfyUI under a running app also showed them, so it hung on the app start,
 * not on ComfyUI.
 *
 * Root cause, read off useCreate: `comfyWS.connect()` sat AFTER
 * `submitWorkflow`. The first connect of an app run pays a dynamic import, two
 * Tauri listener registrations and the Rust websocket handshake (up to 5 s),
 * while ComfyUI starts executing the moment the submit lands and addresses
 * this run's frames at our client id alone. ComfyUI buffers nothing, so those
 * frames were destroyed, not delayed.
 *
 * Two things are proven here: the socket is opened before the submit, and a
 * listener that registers a moment late is still told what it missed.
 *
 * Run: npx vitest run src/api/__tests__/ws-first-render-loses-nothing.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { comfyWS, WS_REPLAY_BUFFER, type ComfyWSEvent } from '../comfyui-ws'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

/** Push a frame through the client the way the transport does. */
const feed = (event: ComfyWSEvent) => {
  ;(comfyWS as unknown as { dispatch: (e: ComfyWSEvent) => void }).dispatch(event)
}

const executing = (node: string, prompt_id = 'p1'): ComfyWSEvent =>
  ({ type: 'executing', data: { node, prompt_id } })

const flush = () => new Promise<void>((r) => queueMicrotask(() => r()))

describe('a listener that registers late (Befund 1)', () => {
  it('is told the frames that arrived after its mark', async () => {
    const mark = comfyWS.mark()
    // The submit lands, ComfyUI walks straight into the loaders, and the
    // caller is still building its closure.
    feed(executing('1'))
    feed(executing('2'))
    const seen: string[] = []
    const off = comfyWS.on((e) => { if (e.type === 'executing') seen.push(e.data.node!) }, mark)
    await flush()
    expect(seen).toEqual(['1', '2'])
    // and it keeps listening for what comes next
    feed(executing('3'))
    expect(seen).toEqual(['1', '2', '3'])
    off()
  })

  it('NEGATIVE: without a mark nothing is replayed, which is the old behaviour', async () => {
    feed(executing('9'))
    const seen: string[] = []
    const off = comfyWS.on((e) => { if (e.type === 'executing') seen.push(e.data.node!) })
    await flush()
    expect(seen).toEqual([])
    off()
  })

  it('NEGATIVE: a mark taken after the frames replays nothing older than itself', async () => {
    feed(executing('a'))
    const mark = comfyWS.mark()
    const seen: string[] = []
    const off = comfyWS.on((e) => { if (e.type === 'executing') seen.push(e.data.node!) }, mark)
    await flush()
    expect(seen).toEqual([])
    off()
  })

  it('NEGATIVE: a listener removed before the replay runs is never called', async () => {
    const mark = comfyWS.mark()
    feed(executing('x'))
    const listener = vi.fn()
    const off = comfyWS.on(listener, mark)
    off()
    await flush()
    expect(listener).not.toHaveBeenCalled()
  })

  it('the replay is not delivered inside the on() call itself', async () => {
    // The caller writes `const off = comfyWS.on(...)` and its teardown closes
    // over `off`. A replay delivered during the call would reach a teardown
    // whose `off` is still in its temporal dead zone.
    const mark = comfyWS.mark()
    feed(executing('y'))
    let duringTheCall = false
    let assigned = false
    const off = comfyWS.on(() => { if (!assigned) duringTheCall = true }, mark)
    assigned = true
    await flush()
    expect(duringTheCall).toBe(false)
    off()
  })

  it('the buffer is bounded', () => {
    const mark = comfyWS.mark()
    for (let i = 0; i < WS_REPLAY_BUFFER + 50; i++) feed(executing(String(i)))
    const buf = (comfyWS as unknown as { buffer: unknown[] }).buffer
    expect(buf.length).toBe(WS_REPLAY_BUFFER)
    void mark
  })
})

describe('the Create render opens the socket before it submits', () => {
  const src = read('src/hooks/useCreate.ts')
  const connectAt = src.indexOf('await comfyWS.connect(3000)')
  const markAt = src.indexOf('wsMark = comfyWS.mark()')
  const submitAt = src.indexOf('await submitWorkflow(workflow, CLIENT_ID)')

  it('connect and mark both come before the submit', () => {
    expect(connectAt).toBeGreaterThan(-1)
    expect(markAt).toBeGreaterThan(-1)
    expect(submitAt).toBeGreaterThan(-1)
    expect(connectAt).toBeLessThan(submitAt)
    expect(markAt).toBeLessThan(submitAt)
  })

  it('the run listener is handed the mark, so the gap to the submit is replayed', () => {
    expect(src).toMatch(/\}, wsMark\)/)
  })

  it('NEGATIVE: the connect is not attempted a second time after the submit', () => {
    expect(src.indexOf('await comfyWS.connect(3000)', submitAt)).toBe(-1)
  })
})
