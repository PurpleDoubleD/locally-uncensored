// "Picture first" in the cloud: the order of the two runs, the price the
// button shows, the content gate before each run, and that a failed or
// stopped second run keeps the picture.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import schemas from '../../render/provider-schemas.json'
import { STUDIO_MODELS, STUDIO_MODELS_WITH_RETIRED, type Schema } from '../../render/studio-contract'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { checkPromptSafety } from '../../render/safety'
import { installContentPolicyCap } from '../../content-policy-cap'
import { intentPickerModels, resolveIntentPick } from '../../render/create-studio'
import type { CloudJob } from '../../../api/cloud/jobs'
import { runCloudPictureFirst, pictureFirstProvenance, type PictureFirstDeps, type PictureFirstPlan } from '../cloud-picture-first'
import { PICTURE_FIRST_MESH, isPictureFirstRun, pictureFirstOffered, pictureFirstPictureCredits, pictureFirstPictureModel, pictureStepCredits } from '../picture-first'
import { threeDPicturePrompt } from '../run-local-3d'
import { THREE_D_TEXT } from '../three-d-text'
import { MESH_TEXT, installThreeDStudio, threeDCatalogEntries } from '../../../mobile/screens/create/__tests__/fixtures/three-d-models'

let undo: () => void = () => {}
let catalogBefore: ReturnType<typeof useCloudCatalogStore.getState>['models']
const OPEN = { id: 'z-image', label: 'Z-Image Base', kind: 'image', adult: true, quote_required: true, tier: 'best', weights: 'open' }
const CAPPED = { id: 'qwen-image-2.1', label: 'Qwen Image 2.1', kind: 'image', quote_required: true, tier: 'best', weights: 'open' }

beforeAll(() => {
  undo = installThreeDStudio(STUDIO_MODELS, schemas as Record<string, Schema>, STUDIO_MODELS_WITH_RETIRED)
  catalogBefore = useCloudCatalogStore.getState().models
})
afterAll(() => {
  undo()
  useCloudCatalogStore.setState({ models: catalogBefore })
})
beforeEach(() => {
  useCloudCatalogStore.setState({ models: [...catalogBefore, ...threeDCatalogEntries(), OPEN, CAPPED] as typeof catalogBefore })
})

describe('the pick', () => {
  it('paints with the open image model that has the filter off', () => {
    expect(STUDIO_MODELS['z-image']).toMatchObject({ kind: 'image', adult: true, weights: 'open', inputs: {} })
    expect(pictureFirstPictureModel()).toBe('z-image')
    expect(pictureFirstOffered()).toBe(true)
  })

  it('a build that caps the content policy paints with a filtered open model', () => {
    const off = installContentPolicyCap(() => 'soft')
    try {
      expect(pictureFirstPictureModel()).toBe('qwen-image-2.1')
    } finally {
      off()
    }
  })

  it('leads the "From text" list and is its default, next to the direct models', () => {
    const list = intentPickerModels('3d-text')
    expect(list.map((m) => m.id)).toEqual([PICTURE_FIRST_MESH, MESH_TEXT])
    expect(list[0].label).toBe(THREE_D_TEXT.pictureFirstSwitch)
    expect(resolveIntentPick('3d-text', '')).toBe(PICTURE_FIRST_MESH)
    expect(resolveIntentPick('3d-text', MESH_TEXT)).toBe(MESH_TEXT)
    // The picture way keeps its own list and name.
    expect(intentPickerModels('3d-image').find((m) => m.id === PICTURE_FIRST_MESH)?.label).toBe('TRELLIS.2')
  })

  it('is not offered when the server lists no open image model or no image-to-3D model', () => {
    useCloudCatalogStore.setState({ models: [...catalogBefore, ...threeDCatalogEntries()] as typeof catalogBefore })
    expect(pictureFirstOffered()).toBe(false)
    expect(intentPickerModels('3d-text').map((m) => m.id)).toEqual([MESH_TEXT])
    useCloudCatalogStore.setState({ models: [...catalogBefore, ...threeDCatalogEntries().filter((m) => m.id !== PICTURE_FIRST_MESH), OPEN] as typeof catalogBefore })
    expect(pictureFirstOffered()).toBe(false)
  })

  it('only an image-to-3D model on the text way is a picture-first run', () => {
    expect(isPictureFirstRun('text', PICTURE_FIRST_MESH)).toBe(true)
    expect(isPictureFirstRun('image', PICTURE_FIRST_MESH)).toBe(false)
    expect(isPictureFirstRun('text', MESH_TEXT)).toBe(false)
    expect(isPictureFirstRun('text', 'z-image')).toBe(false)
  })

  it('the price shown is the picture plus the model', () => {
    // Z-Image Base is a flat 1,000 credits.
    expect(pictureFirstPictureCredits('a clay teapot')).toBe(1000)
    expect(pictureStepCredits('3d', 'text', PICTURE_FIRST_MESH, 'a clay teapot')).toBe(1000)
    expect(pictureStepCredits('3d', 'image', PICTURE_FIRST_MESH, 'a clay teapot')).toBe(0)
    expect(pictureStepCredits('3d', 'text', MESH_TEXT, 'a clay teapot')).toBe(0)
    expect(pictureStepCredits('image', 'text', PICTURE_FIRST_MESH, 'a clay teapot')).toBe(0)
  })
})

// ---------- the chain ----------

const job = (id: string, over: Partial<CloudJob> = {}): CloudJob => ({
  id, kind: 'image', model: 'z-image', provider: null, status: 'succeeded', result_url: `https://store.example/${id}.png`,
  attestation: null, cost_units: 0, created_at: '', completed_at: '', error: null, ...over,
})

function rig(over: { prices?: Record<string, number>; second?: Partial<CloudJob>; first?: Partial<CloudJob>; gate?: PictureFirstDeps['gate']; stopAfterPicture?: boolean } = {}) {
  const log: string[] = []
  const submits: Parameters<PictureFirstDeps['submit']>[0][] = []
  const gated: string[] = []
  let stop = false
  const prices = over.prices ?? { 'z-image': 1000, [PICTURE_FIRST_MESH]: 20000 }
  const deps: PictureFirstDeps = {
    gate: (text) => {
      gated.push(text)
      return over.gate ? over.gate(text) : checkPromptSafety(text, { tier: 'cloud', policy: 'off' })
    },
    quote: async (model) => { log.push(`quote ${model}`); return prices[model] },
    submit: async (j) => { submits.push(j); log.push(`submit ${j.model}`); return { id: j.kind === 'image' ? 'job-1' : 'job-2' } },
    poll: async (id) => { log.push(`poll ${id}`); return id === 'job-1' ? job(id, over.first) : job(id, { kind: '3d', model: PICTURE_FIRST_MESH, ...over.second }) },
    adopt: async (id) => { log.push(`adopt ${id}`); return `user/job-${id}-x.png` },
    onPicture: async (j) => { log.push(`picture ${j.id}`); if (over.stopAfterPicture) stop = true },
    onBooked: (id) => { log.push(`booked ${id}`) },
    stopped: () => stop,
  }
  return { deps, log, submits, gated }
}

const plan = (over: Partial<PictureFirstPlan> = {}): PictureFirstPlan => ({
  prompt: 'classical marble statue of an athlete', pictureModel: 'z-image', meshModel: PICTURE_FIRST_MESH,
  meshOptions: { resolution: 1024 }, shown: { mesh: 20000, picture: 1000 }, requestIds: ['r1', 'r2'], ...over,
})

describe('the chain', () => {
  it('paints, shows the picture, then builds the model from the copied picture', async () => {
    const r = rig()
    const out = await runCloudPictureFirst(plan(), r.deps)
    expect(out.kind).toBe('done')
    expect(r.log).toEqual([
      'quote z-image', `quote ${PICTURE_FIRST_MESH}`,
      'submit z-image', 'booked job-1', 'poll job-1', 'picture job-1',
      'adopt job-1', `submit ${PICTURE_FIRST_MESH}`, 'booked job-2', 'poll job-2',
    ])
    const [one, two] = r.submits
    expect(one).toMatchObject({ kind: 'image', model: 'z-image', prompt: threeDPicturePrompt(plan().prompt) })
    expect(one.params).toMatchObject({ op: 'studio', studio_options: {}, client_request_id: 'r1', max_credits: 1000 })
    expect(two).toMatchObject({ kind: '3d', model: PICTURE_FIRST_MESH, prompt: '' })
    expect(two.params).toMatchObject({
      op: 'studio', studio_options: { resolution: 1024 }, client_request_id: 'r2', max_credits: 20000,
      source_path: 'user/job-job-1-x.png', source_prompt: pictureFirstProvenance(plan().prompt),
      label: plan().prompt,
    })
    // The server's gate reads the user's words with the picture.
    expect(two.params.source_prompt).toContain(plan().prompt)
  })

  it('runs the gate on the prompt before the first run and with the provenance before the second', async () => {
    const r = rig()
    await runCloudPictureFirst(plan(), r.deps)
    expect(r.gated).toEqual([`${plan().prompt} ${threeDPicturePrompt(plan().prompt)}`, pictureFirstProvenance(plan().prompt)])
  })

  it('a refused prompt books nothing and asks for no price', async () => {
    const r = rig()
    const out = await runCloudPictureFirst(plan({ prompt: 'nude schoolgirl' }), r.deps)
    expect(out).toMatchObject({ kind: 'blocked', step: 1 })
    expect(r.log).toEqual([])
  })

  it('a refusal before the second run keeps the picture and books no model', async () => {
    let calls = 0
    const r = rig({ gate: () => ({ blocked: ++calls === 2, reason: 'csam' }) })
    const out = await runCloudPictureFirst(plan(), r.deps)
    expect(out).toMatchObject({ kind: 'blocked', step: 2 })
    expect(r.log).toContain('picture job-1')
    expect(r.log.some((l) => l.startsWith('adopt'))).toBe(false)
    expect(r.submits).toHaveLength(1)
  })

  it('a higher confirmed sum books nothing and names the new sum', async () => {
    const r = rig({ prices: { 'z-image': 1000, [PICTURE_FIRST_MESH]: 40000 } })
    const out = await runCloudPictureFirst(plan(), r.deps)
    expect(out).toEqual({ kind: 'price', total: 41000, mesh: 40000 })
    expect(r.submits).toHaveLength(0)
  })

  it('a lower or equal sum books, each run capped at its own confirmed price', async () => {
    const r = rig({ prices: { 'z-image': 1000, [PICTURE_FIRST_MESH]: 10000 } })
    expect((await runCloudPictureFirst(plan(), r.deps)).kind).toBe('done')
    expect(r.submits.map((s) => s.params.max_credits)).toEqual([1000, 10000])
  })

  it('a failed second run keeps the picture', async () => {
    const r = rig({ second: { status: 'failed', result_url: null, error: 'provider error' } })
    const out = await runCloudPictureFirst(plan(), r.deps)
    expect(out.kind).toBe('mesh-failed')
    if (out.kind === 'mesh-failed') {
      expect(out.picture.id).toBe('job-1')
      expect(out.job.error).toBe('provider error')
    }
    expect(r.log).toContain('picture job-1')
  })

  it('a failed picture builds no model', async () => {
    const r = rig({ first: { status: 'failed', result_url: null, error: 'no' } })
    const out = await runCloudPictureFirst(plan(), r.deps)
    expect(out.kind).toBe('picture-failed')
    expect(r.submits).toHaveLength(1)
    expect(r.log.some((l) => l.startsWith('picture'))).toBe(false)
  })

  it('Stop after the picture keeps it and books no model', async () => {
    const r = rig({ stopAfterPicture: true })
    const out = await runCloudPictureFirst(plan(), r.deps)
    expect(out).toMatchObject({ kind: 'stopped', picture: { id: 'job-1' } })
    expect(r.submits).toHaveLength(1)
  })
})
