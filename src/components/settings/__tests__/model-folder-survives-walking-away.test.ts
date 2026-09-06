/**
 * @vitest-environment jsdom
 *
 * A16 (A14-2a), Windows counter-check 02.09.: the LU Engine folder was stored
 * on Enter or on blur and on nothing else. Type a path and navigate away, and
 * the value stood in the box while `hfDownloadPathOverride` stayed empty,
 * Installed did not change, and a refresh did not help either. The
 * counter-check's first run concluded from that the folder was simply being
 * ignored. It is the reading anyone would reach, and a field that keeps
 * showing a value it never saved has earned it.
 *
 * The first answer to that was a 600 ms debounce beside the blur, and the
 * follow-up counter-check showed what it cost. The debounce stored the TRIMMED
 * value while the user was still typing, the store value flowed straight back
 * into the box, and a path with a space in it lost the space mid word:
 * "C:\Program " became "C:\Program" with the cursor at the end, and typing on
 * produced "C:\ProgramFiles". The same write sent a half typed path to the
 * folder scan, which answered with a red "unreachable" line under a field
 * nobody had finished filling in.
 *
 * No timer writes anything now. Blur, Enter and unmount commit, and the third
 * is what the original finding was about: walking away from a field IS a blur
 * or an unmount.
 *
 * Run: npx vitest run src/components/settings/__tests__/model-folder-survives-walking-away.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

const listBundledModels = vi.fn(async () => [])

vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => null),
  isTauri: () => true,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(), secretDelete: vi.fn(),
  setComfyPort: vi.fn(), setComfyHost: vi.fn(),
}))
vi.mock('../../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../../api/engine')>('../../../api/engine')
  return {
    ...actual,
    listBundledModels: () => listBundledModels(),
    lastCustomScanDir: () => null,
    lastScanDirs: () => [],
    syncCustomModelDir: vi.fn(async () => null),
  }
})

const { HfDownloadPathSetting } = await import('../SettingsPage')
const { useSettingsStore } = await import('../../../stores/settingsStore')

const TYPED = 'C:\\lu-e2e-models'
/** Longer than the debounce that used to sit here, so a timer that came back
 *  would fire inside this window and be caught. */
const A_PAUSE_MS = 700

function storedFolder() {
  return useSettingsStore.getState().settings.hfDownloadPathOverride
}

async function fieldWithTypedPath() {
  render(createElement(HfDownloadPathSetting))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const box = screen.getByLabelText('LU Engine folder')
  fireEvent.change(box, { target: { value: TYPED } })
  return box
}

beforeEach(() => {
  vi.useFakeTimers()
  listBundledModels.mockClear()
  useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '' })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '' })
})

describe('a folder typed into the LU Engine field', () => {
  it('is stored when the field goes away with the panel', async () => {
    await fieldWithTypedPath()
    expect(storedFolder(), 'nothing should be stored yet').toBe('')

    // Closing Settings, or switching to another tab: the field unmounts with
    // the typed value never having been blurred.
    cleanup()

    expect(storedFolder(), 'the typed folder was thrown away on the way out').toBe(TYPED)
  })

  it('survives a pause in the middle of a path that has a space in it', async () => {
    // The counter-check's own example. "C:\Program " is a path in the middle
    // of being typed, and the trailing space is part of it.
    render(createElement(HfDownloadPathSetting))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const box = screen.getByLabelText('LU Engine folder')
    const scansBefore = listBundledModels.mock.calls.length

    fireEvent.change(box, { target: { value: 'C:\\Program ' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(A_PAUSE_MS) })

    // The pause must not have eaten the space, or the next word joins the
    // previous one.
    expect((box as HTMLInputElement).value, 'the trailing space was trimmed away under the cursor')
      .toBe('C:\\Program ')
    // And it must not have sent half a path to the folder scan, which answers
    // a half path with a red "unreachable" line.
    expect(storedFolder(), 'half a path reached the store').toBe('')
    expect(
      listBundledModels.mock.calls.length,
      'the folder scan ran on a path the user had not finished typing',
    ).toBe(scansBefore)

    fireEvent.change(box, { target: { value: 'C:\\Program Files' } })
    expect((box as HTMLInputElement).value).toBe('C:\\Program Files')
    fireEvent.blur(box)
    expect(storedFolder()).toBe('C:\\Program Files')
  })

  it('is stored on Enter, trimmed', async () => {
    render(createElement(HfDownloadPathSetting))
    await act(async () => { await Promise.resolve() })
    const box = screen.getByLabelText('LU Engine folder')
    fireEvent.change(box, { target: { value: `  ${TYPED}  ` } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(storedFolder()).toBe(TYPED)
  })

  it('and the model list is told, so a refresh sees the folder', async () => {
    const refreshes: Event[] = []
    const onRefresh = (e: Event) => refreshes.push(e)
    window.addEventListener('lu-models-refresh', onRefresh)
    const box = await fieldWithTypedPath()
    fireEvent.blur(box)
    window.removeEventListener('lu-models-refresh', onRefresh)
    expect(refreshes.length).toBeGreaterThan(0)
  })

  // NEGATIVE CONTROL: nothing is written while the user is still typing. A
  // path stored half finished sends the scan against "C:\lu" while the user is
  // on the second syllable, and the scan's verdict about that folder is worse
  // than no verdict at all.
  it('is not stored mid word, however long the pause', async () => {
    render(createElement(HfDownloadPathSetting))
    await act(async () => { await Promise.resolve() })
    const box = screen.getByLabelText('LU Engine folder')
    fireEvent.change(box, { target: { value: 'C:\\lu' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(A_PAUSE_MS * 5) })
    expect(storedFolder(), 'a half typed path reached the store').toBe('')
    fireEvent.change(box, { target: { value: TYPED } })
    fireEvent.blur(box)
    expect(storedFolder()).toBe(TYPED)
  })

  // NEGATIVE CONTROL: the blur path, which worked before and has to keep
  // working, and it trims the way it always did.
  it('still saves on blur, trimmed', async () => {
    render(createElement(HfDownloadPathSetting))
    await act(async () => { await Promise.resolve() })
    const box = screen.getByLabelText('LU Engine folder')
    fireEvent.change(box, { target: { value: `  ${TYPED}  ` } })
    fireEvent.blur(box)
    expect(storedFolder()).toBe(TYPED)
  })

  // NEGATIVE CONTROL: the unmount trims too, so walking away and blurring
  // cannot store two different strings for one typed path.
  it('trims on the way out as well', async () => {
    render(createElement(HfDownloadPathSetting))
    await act(async () => { await Promise.resolve() })
    const box = screen.getByLabelText('LU Engine folder')
    fireEvent.change(box, { target: { value: `  ${TYPED}  ` } })
    cleanup()
    expect(storedFolder()).toBe(TYPED)
  })

  // NEGATIVE CONTROL: an unmount that owes nothing must not write. Otherwise
  // opening and closing Settings would rewrite the setting, and Reset would be
  // undone by the very act of leaving.
  it('writes nothing when the field is left untouched', async () => {
    useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: 'D:\\models' })
    const writes: Event[] = []
    const onRefresh = (e: Event) => writes.push(e)
    window.addEventListener('lu-models-refresh', onRefresh)
    render(createElement(HfDownloadPathSetting))
    await act(async () => { await Promise.resolve() })
    cleanup()
    window.removeEventListener('lu-models-refresh', onRefresh)
    expect(writes, 'leaving the panel wrote the setting again').toHaveLength(0)
    expect(storedFolder()).toBe('D:\\models')
  })
})
