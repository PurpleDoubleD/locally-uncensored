// @vitest-environment jsdom
/**
 * Discord #bug-reports, 30.10.2026 (LU 3.0.8, 16 GB card): Create → Edit,
 * local model list, search "tur": "krea2TurboOfficialComfy krea2TurboInt8"
 * three times, every other Krea model once.
 *
 * Two faults behind it, both pinned here:
 * - The image lane read checkpoints/ and diffusion_models/ and never merged
 *   them, so a file found by both loaders was listed twice.
 * - The picker keys its rows by value. Two rows with one key are not two rows
 *   to React: typing into the search left a stale third one behind, in the
 *   order of the screenshot.
 *
 * Run: npx vitest run src/components/create/ui/__tests__/a-model-in-two-folders-is-listed-once.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const localFetch = vi.fn()
const backendCall = vi.fn()
vi.mock('../../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...a),
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => false,
  comfyuiUrl: (path: string) => `http://127.0.0.1:8188${path}`,
}))

import { getImageModels } from '../../../../api/comfyui'
import { Select } from '../Select'

const KREA = 'krea2TurboOfficialComfy_krea2TurboInt8.safetensors'
const LABEL = 'krea2TurboOfficialComfy krea2TurboInt8'

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  localFetch.mockReset()
  backendCall.mockReset()
  backendCall.mockImplementation(async (_cmd: string, args: { files: Array<{ filename: string }> }) =>
    args.files.map((f) => ({ filename: f.filename, exists: true, actualBytes: 1024, complete: true })),
  )
  localFetch.mockImplementation(async (url: string) => {
    if (url.includes('CheckpointLoaderSimple')) {
      return okJson({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['krea2Turbo18For_v2.safetensors', KREA]] } } } })
    }
    if (url.includes('UnetLoaderGGUF')) return okJson({})
    if (url.includes('UNETLoader')) {
      return okJson({ UNETLoader: { input: { required: { unet_name: [[KREA, 'krealism_v31TurboBf16.safetensors']] } } } })
    }
    return okJson({})
  })
})
afterEach(cleanup)

describe('a model in two folders', () => {
  it('is offered once by the image lane', async () => {
    const names = (await getImageModels()).map((m) => m.name)
    expect(names.filter((n) => n === KREA)).toHaveLength(1)
    expect(names).toContain('krea2Turbo18For_v2.safetensors')
    expect(names).toContain('krealism_v31TurboBf16.safetensors')
  })

  // The reporter has ONE file (Discord 30.10. 18:47Z, "i have only one").
  // One file comes back from several loaders when ComfyUI reads one folder
  // for several keys (a shared model folder, extra_model_paths.yaml). Every
  // loader that names it, here all three, still makes one entry.
  it('is offered once when one file is named by every loader', async () => {
    localFetch.mockImplementation(async (url: string) => {
      if (url.includes('CheckpointLoaderSimple')) return okJson({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[KREA]] } } } })
      if (url.includes('UnetLoaderGGUF')) return okJson({ UnetLoaderGGUF: { input: { required: { unet_name: [[KREA]] } } } })
      if (url.includes('UNETLoader')) return okJson({ UNETLoader: { input: { required: { unet_name: [[KREA]] } } } })
      return okJson({})
    })
    expect((await getImageModels()).map((m) => m.name)).toEqual([KREA])
  })

  it('keeps the checkpoint entry, the one every run finds first', async () => {
    const krea = (await getImageModels()).find((m) => m.name === KREA)
    expect(krea?.source).toBe('checkpoint')
  })
})

describe('the picker with one value twice', () => {
  // The order of the screenshot: both copies in the "Best" group, the other
  // Krea models between them.
  const options = [
    { value: 'krea2Turbo18For_v2.safetensors', label: 'krea2Turbo18For v2 3129121', group: 'Best' },
    { value: KREA, label: LABEL, group: 'Best' },
    { value: 'krealism_v31TurboBf16.safetensors', label: 'krealism v31TurboBf16', group: 'Best' },
    { value: KREA, label: LABEL, group: 'Best' },
    { value: 'flux1-dev.safetensors', label: 'flux1 dev', group: 'Older models' },
  ]
  const rows = () => screen.queryAllByRole('option').filter((o) => o.textContent?.includes('OfficialComfy'))

  it('shows it once, and still once after typing "tur" letter by letter', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Select ariaLabel="Model" searchable options={options} value={KREA} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(rows()).toHaveLength(1)
    const search = screen.getByPlaceholderText('Search...')
    for (const q of ['t', 'tu', 'tur']) {
      fireEvent.change(search, { target: { value: q } })
      expect(rows()).toHaveLength(1)
    }
    // Negative control: the search still narrows and finds the others.
    expect(screen.queryAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('krea2Turbo18For'), expect.stringContaining('krealism')]),
    )
    expect(screen.queryAllByRole('option').some((o) => o.textContent?.includes('flux1'))).toBe(false)
  })

  // Whatever hands the picker one value more than once, it is one row.
  it('shows a value that comes three times once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const thrice = [...options, { value: KREA, label: LABEL, group: 'Best' }]
    render(<Select ariaLabel="Model" searchable options={thrice} value={KREA} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const search = screen.getByPlaceholderText('Search...')
    for (const q of ['', 't', 'tu', 'tur', 'tu', '']) {
      fireEvent.change(search, { target: { value: q } })
      expect(rows()).toHaveLength(1)
    }
  })
})
