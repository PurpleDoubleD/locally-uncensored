/**
 * GH #122 (zrmdsxa, 2026-08-28): "Custom location not detecting my models".
 *
 * The folder under Settings → Model Storage was a download TARGET and nothing
 * else. `hfDownloadPathOverride` was read by the downloader and by onboarding,
 * and by no scan anywhere, so a GGUF already sitting in `G:\AI\Models` was
 * never looked at: Models tab empty, model not loadable, no way to tell why.
 *
 * What is proven here is the frontend half: the setting reaches the scan, in
 * the shape Windows writes it, and a model that comes back from the folder
 * becomes an Installed row the picker can load. The scan itself, its depth and
 * its precedence rules are proven in Rust
 * (`src-tauri/src/commands/engine.rs`, tests `the_custom_folder_is_read_…`).
 *
 * Run: npx vitest run src/api/__tests__/custom-model-folder.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
}))

import { customModelDirs, listBundledModels, bundledToAIModels, lastScanDirs, lastCustomScanDir } from '../engine'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'

/** The path exactly as Windows hands it over: drive letter, backslashes,
 *  a space in a folder name. All three were in the issue's screenshots. */
const WINDOWS_FOLDER = 'G:\\AI\\Models'

/** What Rust answers for a folder it walked to the end. */
function okDirs() {
  return [
    { path: '/app/models', status: 'ok' },
    { path: WINDOWS_FOLDER, status: 'ok' },
  ]
}

function setFolder(dir: string) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, hfDownloadPathOverride: dir } })
}

beforeEach(() => {
  backendCall.mockReset()
  setFolder('')
})

describe('the folder under Model Storage reaches the scan', () => {
  it('hands the Windows path to the backend, verbatim', async () => {
    setFolder(WINDOWS_FOLDER)
    expect(customModelDirs()).toEqual([WINDOWS_FOLDER])

    backendCall.mockResolvedValue({ dir: '/app/models', dirs: okDirs(), models: [] })
    await listBundledModels()

    expect(backendCall).toHaveBeenCalledWith('list_bundled_models', {
      extraDirs: [WINDOWS_FOLDER],
    })
  })

  it('trims what the user typed, because a trailing space is not a folder', () => {
    setFolder('  G:\\AI\\Models  ')
    expect(customModelDirs()).toEqual([WINDOWS_FOLDER])
  })

  // Negative control: with no folder set, nothing extra is scanned. This is
  // the shipped single-folder behaviour and it must not change for the users
  // who never touched the setting.
  it('asks for no extra folder when the setting is empty', async () => {
    expect(customModelDirs()).toEqual([])
    setFolder('   ')
    expect(customModelDirs()).toEqual([])

    backendCall.mockResolvedValue({ dir: '/app/models', models: [] })
    await listBundledModels()
    expect(backendCall).toHaveBeenCalledWith('list_bundled_models', { extraDirs: [] })
  })
})

describe('a model found in that folder is an Installed row', () => {
  it('carries the folder path through to a loadable picker entry', async () => {
    setFolder(WINDOWS_FOLDER)
    backendCall.mockResolvedValue({
      dir: '/app/models',
      dirs: okDirs(),
      models: [
        {
          name: 'Cydonia-24B-v4.1-Q4_K_M',
          path: 'G:\\AI\\Models\\Text Generation\\Cydonia-24B-v4.1-Q4_K_M.gguf',
          size: 14_000_000_000,
          loaded: false,
          ctx_train: 32768,
        },
      ],
    })

    const bundled = await listBundledModels()
    expect(bundled).toHaveLength(1)
    // The absolute path is what makes it loadable: the engine is started with
    // it, so a model on another drive works exactly like one in the app dir.
    expect(bundled[0].path).toContain('G:\\AI\\Models')

    const rows = bundledToAIModels(bundled)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('openai::Cydonia-24B-v4.1-Q4_K_M')
    expect(rows[0].providerName).toBe('Built-in Engine')
    expect(rows[0].size).toBe(14_000_000_000)
  })

  // Negative control: an empty folder is an empty list, not an invented row.
  it('invents nothing when the folder holds no GGUF', async () => {
    setFolder(WINDOWS_FOLDER)
    backendCall.mockResolvedValue({ dir: '/app/models', dirs: okDirs(), models: [] })
    expect(bundledToAIModels(await listBundledModels())).toEqual([])
  })
})

describe('the panel is told how the scan fared, not only what it found', () => {
  it('carries the per-folder verdict through', async () => {
    setFolder(WINDOWS_FOLDER)
    backendCall.mockResolvedValue({
      dir: '/app/models',
      dirs: [
        { path: '/app/models', status: 'ok' },
        { path: WINDOWS_FOLDER, status: 'truncated' },
      ],
      models: [{ name: 'partial', path: 'G:\\AI\\Models\\partial.gguf', size: 1, loaded: false }],
    })
    await listBundledModels()
    expect(lastScanDirs()).toHaveLength(2)
    // The user's own folder is the one the panel talks about, never the app's.
    expect(lastCustomScanDir()).toEqual({ path: WINDOWS_FOLDER, status: 'truncated' })
    // And a truncated walk still returns what it did find.
    expect(await listBundledModels()).toHaveLength(1)
  })

  // Negative control: an older backend answers without the field, and the
  // panel must then say nothing rather than accuse the folder.
  it('claims nothing when the backend does not report folders', async () => {
    setFolder(WINDOWS_FOLDER)
    backendCall.mockResolvedValue({ dir: '/app/models', models: [] })
    await listBundledModels()
    expect(lastScanDirs()).toEqual([])
    expect(lastCustomScanDir()).toBeNull()
  })

  // A13: the row is found by PATH, not by position. Read off an index, the
  // panel reports the app folder's verdict about the user's folder the day the
  // order changes, and Windows writes the same folder in more than one way.
  it('finds the row for the folder that was asked about, whatever its position', async () => {
    setFolder(WINDOWS_FOLDER)
    backendCall.mockResolvedValue({
      dir: '/app/models',
      dirs: [
        { path: 'g:/ai/models\\', status: 'unreachable' },
        { path: '/app/models', status: 'ok' },
      ],
      models: [],
    })
    await listBundledModels()
    expect(lastCustomScanDir()?.status).toBe('unreachable')
  })

  // Negative control: a verdict about SOME other folder is not a verdict about
  // this one, and silence beats a wrong accusation.
  it('reports nothing when the answer does not mention the folder at all', async () => {
    setFolder(WINDOWS_FOLDER)
    backendCall.mockResolvedValue({
      dir: '/app/models',
      dirs: [
        { path: '/app/models', status: 'ok' },
        { path: 'D:\\somewhere\\else', status: 'truncated' },
      ],
      models: [],
    })
    await listBundledModels()
    expect(lastCustomScanDir()).toBeNull()
  })

  // Negative control: with no folder of his own there is no second row, so the
  // panel has nothing to report either.
  it('has no custom row when no folder is set', async () => {
    setFolder('')
    backendCall.mockResolvedValue({
      dir: '/app/models',
      dirs: [{ path: '/app/models', status: 'ok' }],
      models: [],
    })
    await listBundledModels()
    expect(lastCustomScanDir()).toBeNull()
  })
})
