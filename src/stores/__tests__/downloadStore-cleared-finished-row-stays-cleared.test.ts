/**
 * @vitest-environment jsdom
 *
 * Bug hunt C9 (Oktober 2026): a chat download finished. Download badge,
 * "Clear completed": the row went, and 1.5 s later it was back ("Complete
 * (1 file)"), because the poll rebuilt the rows from the Rust map, which keeps
 * finished entries. The X on the row held only until Models was opened again,
 * whose mount refresh brought it back the same way.
 *
 * Run: npx vitest run src/stores/__tests__/downloadStore-cleared-finished-row-stays-cleared.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const io = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  clear: vi.fn(async (_id: string) => {}),
}))

vi.mock('../../api/discover', async () => {
  const actual = await vi.importActual<typeof import('../../api/discover')>('../../api/discover')
  return {
    ...actual,
    getDownloadProgress: vi.fn(async () => io.rows),
    cancelDownload: vi.fn(async () => {}),
    clearDownloadEntry: (id: string) => io.clear(id),
  }
})

import { useDownloadStore } from '../downloadStore'

const FILE = 'Tiny-Model-Q4_K_M.gguf'
const done = (filename: string) => ({ progress: 100, total: 100, speed: 0, filename, status: 'complete' })
const running = (filename: string) => ({ progress: 10, total: 100, speed: 5, filename, status: 'downloading' })
const rows = () => useDownloadStore.getState().downloads

beforeEach(() => {
  useDownloadStore.getState().stopPolling()
  useDownloadStore.setState({ downloads: {}, ownRows: {}, cancelled: [], dismissed: [], orphans: {}, bundleMap: {} })
  io.clear.mockClear()
  io.rows = { [FILE]: done(FILE) }
})

describe('a finished download the user cleared', () => {
  it('THE REPORT: stays gone through the next poll and the Models mount refresh', async () => {
    await useDownloadStore.getState().refresh()
    expect(rows()[FILE]?.status).toBe('complete')

    useDownloadStore.getState().dismiss(FILE)
    expect(rows()[FILE]).toBeUndefined()

    await useDownloadStore.getState().refresh()
    await useDownloadStore.getState().refresh()
    expect(rows()[FILE]).toBeUndefined()
  })

  it('does not announce the finished file again on every poll', async () => {
    await useDownloadStore.getState().refresh()
    useDownloadStore.getState().dismiss(FILE)
    const heard: string[] = []
    const listen = (e: Event) => heard.push((e as CustomEvent<{ filename: string }>).detail.filename)
    window.addEventListener('comfyui-model-downloaded', listen)
    try {
      await useDownloadStore.getState().refresh()
      await useDownloadStore.getState().refresh()
    } finally {
      window.removeEventListener('comfyui-model-downloaded', listen)
    }
    expect(heard).toEqual([])
  })

  it('shows again when the same file is downloaded anew', async () => {
    await useDownloadStore.getState().refresh()
    useDownloadStore.getState().dismiss(FILE)

    useDownloadStore.getState().setMeta(FILE, 'https://huggingface.co/x/y/resolve/main/' + FILE, 'gguf', '/models')
    io.rows = { [FILE]: running(FILE) }
    await useDownloadStore.getState().refresh()
    expect(rows()[FILE]?.status).toBe('downloading')

    io.rows = { [FILE]: done(FILE) }
    await useDownloadStore.getState().refresh()
    expect(rows()[FILE]?.status).toBe('complete')
  })

  it('a running download started elsewhere for that file shows even without a new start here', async () => {
    await useDownloadStore.getState().refresh()
    useDownloadStore.getState().dismiss(FILE)
    io.rows = { [FILE]: running(FILE) }
    await useDownloadStore.getState().refresh()
    expect(rows()[FILE]?.status).toBe('downloading')
  })

  it('other finished rows are not hidden', async () => {
    const OTHER = 'Other-Model-Q4_K_M.gguf'
    io.rows = { [FILE]: done(FILE), [OTHER]: done(OTHER) }
    await useDownloadStore.getState().refresh()
    useDownloadStore.getState().dismiss(FILE)
    await useDownloadStore.getState().refresh()
    expect(Object.keys(rows())).toEqual([OTHER])
  })
})
