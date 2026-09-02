/**
 * @vitest-environment jsdom
 *
 * A13, Windows counter-check 2026-09-02, point 5: "mit C:\\ als Ordner bleibt
 * die App zwar bedienbar und die Liste stimmt, aber es erscheint kein Hinweis
 * zu gross".
 *
 * Rust has had the answer the whole time. The GGUF walk carries a five second
 * deadline and a 20 000 entry budget per folder and reports `truncated` when
 * it runs out, plus `unreachable` for a drive that is gone and `unusable` for
 * a path the OS cannot resolve. A partial list that looks complete is the kind
 * of thing people debug for an hour, so the panel says which one it got.
 *
 * Run: npx vitest run src/components/settings/__tests__/model-dir-scan-note.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { ScannedDir } from '../../../api/engine'

let scanned: ScannedDir | null = null
vi.mock('../../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../../api/engine')>('../../../api/engine')
  return {
    ...actual,
    listBundledModels: vi.fn(async () => []),
    lastCustomScanDir: () => scanned,
  }
})
vi.mock('../../../lib/custom-model-dir', () => ({
  syncCustomModelDir: vi.fn(async () => ({ status: 'ok', folders: ['loras'], yaml: '' })),
}))
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => null),
  isTauri: () => true,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { HfDownloadPathSetting, modelDirScanNote } = await import('../SettingsPage')
const { useSettingsStore } = await import('../../../stores/settingsStore')

const FOLDER = 'C:\\'

beforeEach(() => {
  scanned = null
  useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: FOLDER })
})
afterEach(() => {
  cleanup()
  useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '' })
})

async function noteFor(status: ScannedDir['status']) {
  scanned = { path: FOLDER, status }
  render(createElement(HfDownloadPathSetting))
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
  return screen.queryByTestId('model-dir-scan-note')?.textContent ?? ''
}

describe('the sentence for each verdict', () => {
  it('names the size problem and what to do about it', () => {
    expect(modelDirScanNote('truncated')).toBe(
      'This folder is too big to scan completely. Only the first files were read; pick a folder that holds just your models.',
    )
  })

  it('says the folder is away, not that it is empty', () => {
    expect(modelDirScanNote('unreachable')).toBe(
      'This folder cannot be reached right now (drive disconnected or path missing). Models in it are hidden until it is back.',
    )
  })

  it('says a path that is no folder is no folder', () => {
    expect(modelDirScanNote('unusable')).toBe('This path is not a folder LU can read.')
  })

  it('stays silent on a clean scan', () => {
    expect(modelDirScanNote('ok')).toBe('')
    expect(modelDirScanNote(null)).toBe('')
    expect(modelDirScanNote(undefined)).toBe('')
  })
})

describe('Model Storage shows it under the path', () => {
  it('warns about a whole drive instead of pretending the list is complete', async () => {
    expect(await noteFor('truncated')).toContain('too big to scan completely')
  })

  it('explains a disconnected drive', async () => {
    expect(await noteFor('unreachable')).toContain('cannot be reached right now')
  })

  it('explains a path that is not a folder', async () => {
    expect(await noteFor('unusable')).toBe('This path is not a folder LU can read.')
  })

  it('says nothing at all when the scan finished', async () => {
    expect(await noteFor('ok')).toBe('')
    // The ComfyUI handoff line is a different subject and still shows.
    expect(screen.getByText(/passes/)).toBeTruthy()
  })

  it('does not stack two warnings about one broken folder', async () => {
    await noteFor('unreachable')
    expect(screen.queryByText(/Check that the drive is connected/)).toBeNull()
  })

  it('says nothing twice about a path that is no folder either', async () => {
    await noteFor('unusable')
    expect(screen.queryByText(/That is not a full path/)).toBeNull()
  })

  // Review 2026-09-02: truncated is NOT the same case. The folder is readable,
  // the walk only ran out of budget, and what LU hands to ComfyUI is
  // unaffected, so swallowing the handoff line there hid a true sentence.
  it('keeps the ComfyUI handoff line next to the size warning', async () => {
    expect(await noteFor('truncated')).toContain('too big to scan completely')
    expect(screen.getByText(/passes/)).toBeTruthy()
  })
})
