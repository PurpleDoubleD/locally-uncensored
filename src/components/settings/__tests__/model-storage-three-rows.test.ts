/**
 * @vitest-environment jsdom
 *
 * A14 (2.6.8), David: "es muss klar sein, ob der Ordner fuer LM Studio, Ollama
 * oder die LU Engine gilt."
 *
 * Before this, Model Storage was one field labelled "(auto-detect)" over a
 * paragraph that named all three backends at once. A user setting that field
 * had no way to tell whose folder he was setting, and the honest answer is
 * that it is one backend's folder and not the other two's. It is three named
 * rows now: the field the user owns, the folder LM Studio owns, and Ollama,
 * which has no folder to set at all.
 *
 * Run: npx vitest run src/components/settings/__tests__/model-storage-three-rows.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { ScannedDir } from '../../../api/engine'

let dirs: ScannedDir[] = []
let lmstudio: { installed: boolean; path: string | null } = { installed: false, path: null }
let onMac = false

vi.mock('../../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../../api/engine')>('../../../api/engine')
  return {
    ...actual,
    listBundledModels: vi.fn(async () => []),
    lastCustomScanDir: () => null,
    lastScanDirs: () => dirs,
  }
})
vi.mock('../../../api/model-folders', () => ({
  lmStudioModelDir: vi.fn(async () => lmstudio),
}))
vi.mock('../../../lib/custom-model-dir', () => ({
  syncCustomModelDir: vi.fn(async () => ({ status: 'ok', folders: [], yaml: '' })),
}))
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => null),
  isTauri: () => true,
  isMacOS: () => onMac,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { HfDownloadPathSetting, LmStudioFolderSetting, ImportLocalModels } = await import('../SettingsPage')
const { useSettingsStore } = await import('../../../stores/settingsStore')

const APP_DIR = '/Users/dev/Library/Application Support/lu/models'

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  dirs = []
  onMac = false
  lmstudio = { installed: false, path: null }
  useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '' })
})
afterEach(() => {
  cleanup()
  useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '' })
})

describe('row 1: the folder the user sets belongs to the LU Engine and says so', () => {
  it('is named LU Engine folder and says what runs from it', async () => {
    render(createElement(HfDownloadPathSetting))
    await settle()
    expect(screen.getByText('LU Engine folder')).toBeTruthy()
    expect(screen.getByText(/Models here run on the LU Engine/)).toBeTruthy()
    expect(screen.getByText(/up to four levels down/)).toBeTruthy()
  })

  it('the empty field names the folder that is being read instead of saying nothing', async () => {
    dirs = [{ path: APP_DIR, status: 'ok' }]
    render(createElement(HfDownloadPathSetting))
    await settle()
    const field = screen.getByLabelText('LU Engine folder') as HTMLInputElement
    expect(field.placeholder).toBe(`(auto: ${APP_DIR})`)
  })

  // NEGATIVE CONTROL: with no folder known there is nothing to name, and the
  // placeholder must not print "(auto: )" at the user.
  it('falls back to the old wording when the listing knows no folder', async () => {
    dirs = []
    render(createElement(HfDownloadPathSetting))
    await settle()
    const field = screen.getByLabelText('LU Engine folder') as HTMLInputElement
    expect(field.placeholder).toBe('(auto-detect)')
  })

  // NEGATIVE CONTROL: the sentences that moved to the other two rows are gone
  // from this one. Leaving them would put the same claim on screen twice and
  // the row would still not say whose folder it is.
  it('no longer explains LM Studio and Ollama in the LU Engine row', async () => {
    render(createElement(HfDownloadPathSetting))
    await settle()
    expect(screen.queryByText(/auto-detect from your active provider/)).toBeNull()
    expect(screen.queryByText(/Ollama is unaffected/)).toBeNull()
  })
})

describe('row 2: LM Studio owns its folder and the row is read-only', () => {
  it('shows the detected path and who manages it', async () => {
    lmstudio = { installed: true, path: '/Users/dev/.lmstudio/models' }
    render(createElement(LmStudioFolderSetting))
    await settle()
    expect(screen.getByText('LM Studio folder')).toBeTruthy()
    expect(screen.getByTestId('lmstudio-folder-path').textContent).toBe('/Users/dev/.lmstudio/models')
    expect(screen.getByTestId('lmstudio-folder-note').textContent).toBe(
      'LM Studio manages this folder. LU reads it through LM Studio when LM Studio is your chat provider.',
    )
  })

  it('says so plainly when LM Studio is not on the machine', async () => {
    lmstudio = { installed: false, path: null }
    render(createElement(LmStudioFolderSetting))
    await settle()
    expect(screen.getByTestId('lmstudio-folder-note').textContent).toBe('LM Studio is not installed.')
  })

  // NEGATIVE CONTROL: installed with no models downloaded yet is a real state.
  // The row must not invent a path it has not seen.
  it('prints no path when LM Studio is installed but has no models folder yet', async () => {
    lmstudio = { installed: true, path: null }
    render(createElement(LmStudioFolderSetting))
    await settle()
    expect(screen.queryByTestId('lmstudio-folder-path')).toBeNull()
    expect(screen.getByTestId('lmstudio-folder-note').textContent).toContain('LM Studio manages this folder')
  })

  // NEGATIVE CONTROL: no input, no Browse. LU does not own this folder and a
  // field here would be a promise it cannot keep.
  it('offers nothing to edit', async () => {
    lmstudio = { installed: true, path: '/Users/dev/.lmstudio/models' }
    const { container } = render(createElement(LmStudioFolderSetting))
    await settle()
    expect(container.querySelectorAll('input').length).toBe(0)
    expect(container.querySelectorAll('button').length).toBe(0)
  })
})

describe('row 3: Ollama has no folder, and the row says why', () => {
  it('names Ollama, names the reason, and keeps the scan button under it', async () => {
    render(createElement(ImportLocalModels))
    await settle()
    expect(screen.getByText('Ollama')).toBeTruthy()
    expect(screen.getByTestId('ollama-store-note').textContent).toBe(
      'Ollama keeps its own model store. LU pulls Ollama models with ollama pull; a folder cannot be set here.',
    )
    expect(screen.getByText('Scan for local models')).toBeTruthy()
  })

  // NEGATIVE CONTROL: a row that says "a folder cannot be set here" must not
  // then offer a field to set one.
  it('offers no path field of its own', async () => {
    const { container } = render(createElement(ImportLocalModels))
    await settle()
    expect(container.querySelectorAll('input').length).toBe(0)
  })
})

// ── A14 point 4: the macOS access dialog ─────────────────────────────────────

describe('the panel warns before macOS asks', () => {
  it('says so under the field for a folder on the Desktop', async () => {
    onMac = true
    useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '/Users/david/Desktop/LU/models' })
    render(createElement(HfDownloadPathSetting))
    await settle()
    expect(screen.getByTestId('macos-folder-access-note').textContent)
      .toBe('macOS will ask once for access to this folder.')
  })

  // NEGATIVE CONTROL: an ordinary folder is not gated, so a note there would
  // be noise that teaches the user to skip the real one.
  it('stays quiet for an ordinary folder on the same Mac', async () => {
    onMac = true
    useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '/Users/david/AI/models' })
    render(createElement(HfDownloadPathSetting))
    await settle()
    expect(screen.queryByTestId('macos-folder-access-note')).toBeNull()
  })

  // NEGATIVE CONTROL: the same folder on Windows. Nothing asks there.
  it('stays quiet off the Mac', async () => {
    onMac = false
    useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '/Users/david/Desktop/LU/models' })
    render(createElement(HfDownloadPathSetting))
    await settle()
    expect(screen.queryByTestId('macos-folder-access-note')).toBeNull()
  })
})
