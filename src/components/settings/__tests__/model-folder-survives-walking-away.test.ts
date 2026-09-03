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
 * Two ways to save were added and the blur was kept: a short debounce after
 * typing stops, and a commit when the field is unmounted.
 *
 * Run: npx vitest run src/components/settings/__tests__/model-folder-survives-walking-away.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

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
    listBundledModels: vi.fn(async () => []),
    lastCustomScanDir: () => null,
    lastScanDirs: () => [],
    syncCustomModelDir: vi.fn(async () => null),
  }
})

const { HfDownloadPathSetting, MODEL_DIR_SAVE_DEBOUNCE_MS } = await import('../SettingsPage')
const { useSettingsStore } = await import('../../../stores/settingsStore')

const TYPED = 'C:\\lu-e2e-models'

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

  it('is stored on its own shortly after typing stops', async () => {
    await fieldWithTypedPath()
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_DIR_SAVE_DEBOUNCE_MS + 50) })
    expect(storedFolder()).toBe(TYPED)
  })

  it('and the model list is told, so a refresh sees the folder', async () => {
    const refreshes: Event[] = []
    const onRefresh = (e: Event) => refreshes.push(e)
    window.addEventListener('lu-models-refresh', onRefresh)
    await fieldWithTypedPath()
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_DIR_SAVE_DEBOUNCE_MS + 50) })
    window.removeEventListener('lu-models-refresh', onRefresh)
    expect(refreshes.length).toBeGreaterThan(0)
  })

  // NEGATIVE CONTROL: it is a debounce, not a write per keystroke. A path
  // being typed must not be stored half finished, or the scan runs against
  // "C:\lu" while the user is still on the second syllable.
  it('is not stored mid word', async () => {
    render(createElement(HfDownloadPathSetting))
    await act(async () => { await Promise.resolve() })
    const box = screen.getByLabelText('LU Engine folder')
    fireEvent.change(box, { target: { value: 'C:\\lu' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_DIR_SAVE_DEBOUNCE_MS - 200) })
    fireEvent.change(box, { target: { value: TYPED } })
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_DIR_SAVE_DEBOUNCE_MS - 200) })
    expect(storedFolder(), 'a half typed path reached the store').toBe('')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
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
