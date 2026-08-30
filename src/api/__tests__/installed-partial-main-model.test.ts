/**
 * M1 of the R67 re-measure on the real 2.6.7 Windows build (2026-08-30,
 * ergebnis-r67-nachmessung.md).
 *
 * Two byte-identical files lay in the SAME folder,
 * C:\Users\ddrob\ComfyUI\models\diffusion_models, 13.631.488 bytes each:
 *
 *   flux1-dev-fp8.safetensors      ->  in no list, no counter, no size, no
 *                                      delete button. Invisible in the app.
 *   flux1-dev-fp8-r67.safetensors  ->  listed fine, "13.0 MB"
 *
 * Renaming the one file was enough to make it appear, so it was the NAME. Our
 * catalogue ships FLUX.1 [dev] FP8 under that exact filename at 16.1 GB, the
 * size probe called the user's 13 MB file partial, and getImageModels dropped
 * it. The inventory read getImageModels, so the whole app went blind to a file
 * lying on the disk.
 *
 * The rule the R5 round already applied to the addon folders, now one folder
 * further in: a catalogue size is a claim about the file WE ship, never about
 * the file the user has. The inventory answers "what is on my disk" and must
 * show it, with its size and its delete button. The pickers answer "what can I
 * render with" and keep the filter, and the catalogue card keeps saying
 * honestly that the package is not fully downloaded.
 *
 * Run: npx vitest run src/api/__tests__/installed-partial-main-model.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn()
const backendCall = vi.fn()
vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...a),
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => false,
  comfyuiUrl: (path: string) => `http://127.0.0.1:8188${path}`,
}))

import {
  getImageModels, getVideoModels,
  getInstalledImageModels, getInstalledVideoModels,
  subfolderForSource,
} from '../comfyui'

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

// The pair from the box, spelled the way the box spells it. The first name is
// in our catalogue at 16.1 GB, the second is in no catalogue at all.
const CATALOG_NAME = 'flux1-dev-fp8.safetensors'
const RENAMED = 'flux1-dev-fp8-r67.safetensors'
const DUMMY_BYTES = 13_631_488
// A catalogue name in the video lane, 14 GB there.
const VIDEO_CATALOG_NAME = 'wan2.1_t2v_14B_fp8.safetensors'

function routeUnets(unets: string[]) {
  localFetch.mockImplementation(async (url: string) => {
    if (url.includes('UNETLoader') && !url.includes('UnetLoaderGGUF')) {
      return okJson({ UNETLoader: { input: { required: { unet_name: [unets] } } } })
    }
    return okJson({})
  })
}

/** The box's disk: every listed file exists, and every one of them is far
 *  smaller than the catalogue entry of the same name. */
function probeSaysPartial() {
  backendCall.mockImplementation(async (_cmd: string, args: { files: Array<{ filename: string; expectedBytes?: number }> }) =>
    args.files.map((f) => ({
      filename: f.filename,
      exists: true,
      actualBytes: DUMMY_BYTES,
      complete: !f.expectedBytes || f.expectedBytes <= DUMMY_BYTES,
    })),
  )
}

beforeEach(() => {
  localFetch.mockReset()
  backendCall.mockReset()
  probeSaysPartial()
})

describe('THE FIX: the inventory shows a file the catalogue would call partial', () => {
  it('both halves of the box pair are in the Image inventory', async () => {
    routeUnets([CATALOG_NAME, RENAMED])
    const names = (await getInstalledImageModels()).map((m) => m.name)
    expect(names).toContain(CATALOG_NAME)
    expect(names).toContain(RENAMED)
  })

  it('the file carries its folder, so its size can be read and it can be deleted', async () => {
    routeUnets([CATALOG_NAME])
    const entry = (await getInstalledImageModels()).find((m) => m.name === CATALOG_NAME)
    expect(entry?.source).toBe('diffusion_model')
    expect(subfolderForSource('diffusion_model')).toBe('diffusion_models')
  })

  it('the video lane has the same rule', async () => {
    routeUnets([VIDEO_CATALOG_NAME])
    const names = (await getInstalledVideoModels()).map((m) => m.name)
    expect(names).toContain(VIDEO_CATALOG_NAME)
  })

  it('a name nobody ships was never the problem and still is not', async () => {
    routeUnets([RENAMED])
    const names = (await getInstalledImageModels()).map((m) => m.name)
    expect(names).toEqual([RENAMED])
  })
})

describe('NEGATIVE CONTROL: the pickers still hide what they cannot render with', () => {
  it('the bug backwards: the Create image picker drops the confirmed-partial file and keeps the copy', async () => {
    // Same fixture as THE FIX above. If this list ever contained CATALOG_NAME,
    // the switch would be gone and the picker would offer a broken graph; if
    // the inventory list ever loses it again, the test above goes red. The two
    // together are what pins the fix.
    routeUnets([CATALOG_NAME, RENAMED])
    const picker = (await getImageModels()).map((m) => m.name)
    expect(picker).not.toContain(CATALOG_NAME)
    expect(picker).toContain(RENAMED)
  })

  it('the video picker drops its confirmed-partial file too', async () => {
    routeUnets([VIDEO_CATALOG_NAME])
    expect(await getVideoModels()).toEqual([])
  })

  it('a complete download is in both, so the switch is about size and nothing else', async () => {
    backendCall.mockImplementation(async (_cmd: string, args: { files: Array<{ filename: string }> }) =>
      args.files.map((f) => ({ filename: f.filename, exists: true, actualBytes: 17_286_263_603, complete: true })),
    )
    routeUnets([CATALOG_NAME])
    expect((await getImageModels()).map((m) => m.name)).toEqual([CATALOG_NAME])
    expect((await getInstalledImageModels()).map((m) => m.name)).toEqual([CATALOG_NAME])
  })

  it('a file the probe cannot locate stays in the picker (konata 2026-06-07)', async () => {
    // exists false means the size checker looked in the wrong ComfyUI root, not
    // that the file is short. ComfyUI enumerated it, so ComfyUI can load it.
    backendCall.mockImplementation(async (_cmd: string, args: { files: Array<{ filename: string }> }) =>
      args.files.map((f) => ({ filename: f.filename, exists: false, actualBytes: 0, complete: false })),
    )
    routeUnets([CATALOG_NAME])
    expect((await getImageModels()).map((m) => m.name)).toEqual([CATALOG_NAME])
  })

  it('an empty ComfyUI still yields an empty inventory, not a phantom', async () => {
    routeUnets([])
    expect(await getInstalledImageModels()).toEqual([])
  })
})
