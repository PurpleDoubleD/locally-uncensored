/**
 * The window's half of Create over the desktop (lib/remote-create-runner.ts):
 * a job from Rust is made with the generation functions, its progress and its
 * end go back through the two commands, a cancel reaches the engine, a failure
 * is reported as one, and capabilities answer with the installed models.
 * The generation is a stand in; Rust's half is tested in remote_create.rs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createRemoteCreateRunner, parseMediaResult, useRemoteCreateStore,
  type RemoteCreateDeps, type RemoteCreateJob,
} from '../remote-create-runner'

function job(over: Partial<RemoteCreateJob> = {}): RemoteCreateJob {
  return {
    id: 'job_1', kind: 'image', prompt: 'a cat', negative: '', model: null,
    width: 1024, height: 1024, steps: null, seed: 7, count: 1,
    conversation_id: 'remote-create:job_1', ...over,
  }
}

interface Rig {
  deps: RemoteCreateDeps
  progress: Array<{ id: string; progress?: number; stepText?: string; index?: number }>
  finished: Array<{ id: string; ok: boolean; error: string | null; outputs: unknown[] }>
  generated: Array<{ media: string; args: Record<string, unknown>; conv: string }>
  cancelled: Array<{ conv: string; media: string }>
  gallery: unknown[]
  signal: ((f: number | null, t: string | null) => void) | null
  alive: { value: boolean }
  lanes: Array<{ job: RemoteCreateJob; signal: AbortSignal }>
  galleryReplies: Array<{ requestId: string; items: unknown[] }>
}

function rig(
  generate?: (media: string, args: Record<string, unknown>) => Promise<string>,
  lane?: (job: RemoteCreateJob, signal: AbortSignal) => Promise<string>,
  tool: 'comfyui' | 'mlx' = 'comfyui',
): Rig {
  const r: Rig = { progress: [], finished: [], generated: [], cancelled: [], gallery: [], signal: null, alive: { value: true }, lanes: [], galleryReplies: [], deps: null as unknown as RemoteCreateDeps }
  let clock = 0
  r.deps = {
    tool,
    runLane: async (j, watch) => {
      r.lanes.push({ job: j, signal: watch.signal })
      watch.report(0.5, 'Half way')
      return lane ? lane(j, watch.signal) : 'Image generated: cut.png (prompt: "")\nfile:///out/cut.png'
    },
    editArgs: (j) => ({ referenceImages: (j.inputs ?? []).slice(1).map((i) => i.input_comfy_name), ...(j.mask ? { maskImage: j.mask.input_comfy_name } : {}) }),
    galleryItems: () => [{ key: 'g1', media: 'image', path: '/out/a.png', prompt: 'p', model: 'm', created_at: 1, from_phone: false }],
    replyGallery: async (requestId, items) => { r.galleryReplies.push({ requestId, items }) },
    generate: async (media, args, conv) => {
      r.generated.push({ media, args, conv })
      return generate ? generate(media, args) : `Image generated: x.png (prompt: "a cat")\nhttp://127.0.0.1:8188/view?filename=lu_0001_.png&subfolder=&type=output`
    },
    cancel: (conv, media) => { r.cancelled.push({ conv, media }) },
    listModels: async () => ({ kinds: { image: { models: [{ id: 'flux', name: 'FLUX' }] } }, engine_ready: true }),
    desktopBusy: () => false,
    inputRef: (j) => j.input_path,
    progress: async (id, p) => { r.progress.push({ id, ...p }); return r.alive.value },
    finish: async (id, ok, error, outputs) => { r.finished.push({ id, ok, error, outputs }) },
    replyCapabilities: async () => null,
    addToGallery: (_j, out) => { r.gallery.push(out) },
    watchEngine: (onSignal) => { r.signal = onSignal; return () => { r.signal = null } },
    now: () => (clock += 1000),
  }
  return r
}

beforeEach(() => useRemoteCreateStore.setState({ running: null, queued: 0 }))

describe('a job from the phone', () => {
  it('is made with the job values, reports progress and ends with the file', async () => {
    const r = rig()
    const runner = createRemoteCreateRunner(r.deps)
    await runner.handle({ action: 'run', job: job({ count: 2, negative: 'blur' }) })
    expect(r.generated).toHaveLength(2)
    expect(r.generated[0]).toEqual({
      media: 'image',
      // No model from the phone: the first installed, never the desktop's picker.
      args: { prompt: 'a cat', negativePrompt: 'blur', model: 'flux', width: 1024, height: 1024, seed: 7 },
      conv: 'remote-create:job_1',
    })
    expect(r.generated[1].args.seed).toBe(8)
    expect(r.progress[0]).toEqual({ id: 'job_1', progress: 0, stepText: 'Starting', index: 0 })
    expect(r.progress.some((p) => p.stepText === 'Image 2 of 2' && p.index === 1)).toBe(true)
    expect(r.finished).toEqual([{
      id: 'job_1', ok: true, error: null,
      outputs: [{ comfyFilename: 'lu_0001_.png', comfySubfolder: '' }, { comfyFilename: 'lu_0001_.png', comfySubfolder: '' }],
    }])
    expect(r.gallery).toHaveLength(2)
  })

  it('passes engine signals on as progress across the items, without a timer of its own', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    const r = rig(async () => { await gate; return 'Image generated: a.png\nfile:///out/images/a.png' })
    const runner = createRemoteCreateRunner(r.deps)
    const done = runner.handle({ action: 'run', job: job() })
    await vi.waitFor(() => expect(r.signal).not.toBeNull())
    r.signal!(0.5, 'Step 10 of 20')
    await vi.waitFor(() => expect(r.progress.some((p) => p.progress === 0.5 && p.stepText === 'Step 10 of 20')).toBe(true))
    release()
    await done
    expect(r.signal).toBeNull()
    expect(r.finished[0].outputs).toEqual([{ path: '/out/images/a.png' }])
  })

  it('a cancel stops the engine through its own conversation and reports no end', async () => {
    let release!: (v: string) => void
    const r = rig(() => new Promise<string>((res) => { release = res }))
    const runner = createRemoteCreateRunner(r.deps)
    const done = runner.handle({ action: 'run', job: job({ count: 3 }) })
    await vi.waitFor(() => expect(r.generated).toHaveLength(1))
    expect(runner.currentJobId()).toBe('job_1')
    await runner.handle({ action: 'cancel', id: 'job_1' })
    // A cancel for another job is not ours.
    await runner.handle({ action: 'cancel', id: 'job_other' })
    expect(r.cancelled).toEqual([{ conv: 'remote-create:job_1', media: 'image' }])
    release('Image generation cancelled.')
    await done
    expect(r.generated).toHaveLength(1)
    expect(r.finished).toEqual([])
    expect(runner.currentJobId()).toBeNull()
  })

  it('stops by itself when Rust says the job no longer runs', async () => {
    const r = rig()
    r.alive.value = false
    const runner = createRemoteCreateRunner(r.deps)
    await runner.handle({ action: 'run', job: job() })
    expect(r.generated).toEqual([])
    expect(r.finished).toEqual([])
  })

  it('a failed generation is reported as failed with its first line', async () => {
    const r = rig(async () => 'Error: No image model installed. Download one first.\nmore detail')
    const runner = createRemoteCreateRunner(r.deps)
    await runner.handle({ action: 'run', job: job({ model: 'flux' }) })
    expect(r.finished).toEqual([{ id: 'job_1', ok: false, error: 'Error: No image model installed. Download one first.', outputs: [] }])
    expect(r.gallery).toEqual([])
  })

  it('a thrown generation is reported, not swallowed', async () => {
    const r = rig(async () => { throw new Error('ComfyUI went away') })
    const runner = createRemoteCreateRunner(r.deps)
    await runner.handle({ action: 'run', job: job({ model: 'flux' }) })
    expect(r.finished).toEqual([{ id: 'job_1', ok: false, error: 'ComfyUI went away', outputs: [] }])
  })

  it('a video job with a start image runs as video with that image', async () => {
    const r = rig(async () => 'Video generated: c.mp4 (prompt: "x")\nfile:///out/videos/c.mp4')
    const runner = createRemoteCreateRunner(r.deps)
    await runner.handle({ action: 'run', job: job({ kind: 'image-to-video', input_path: '/up/abc.png', model: 'wan' }) })
    expect(r.generated[0].media).toBe('video')
    expect(r.generated[0].args.inputImage).toBe('/up/abc.png')
    expect(r.finished[0].outputs).toEqual([{ path: '/out/videos/c.mp4' }])
  })
})

describe('capabilities and the bar', () => {
  it('answers with the installed models and whether the desktop is busy', async () => {
    const r = rig()
    const replies: unknown[] = []
    r.deps.replyCapabilities = async (rid, caps) => { replies.push({ rid, caps }) }
    r.deps.desktopBusy = () => true
    const runner = createRemoteCreateRunner(r.deps)
    await runner.handle({ action: 'capabilities', request_id: 'cap_1' })
    expect(replies).toEqual([{ rid: 'cap_1', caps: { kinds: { image: { models: [{ id: 'flux', name: 'FLUX' }] } }, engine_ready: true, desktop_busy: true } }])
  })

  it('a listing that fails still answers, with nothing ready', async () => {
    const r = rig()
    const replies: unknown[] = []
    r.deps.listModels = async () => { throw new Error('down') }
    r.deps.replyCapabilities = async (_rid, caps) => { replies.push(caps) }
    await createRemoteCreateRunner(r.deps).handle({ action: 'capabilities', request_id: 'cap_2' })
    expect(replies).toEqual([{ kinds: {}, engine_ready: false, desktop_busy: false }])
  })

  it('state events feed the bar store', async () => {
    const runner = createRemoteCreateRunner(rig().deps)
    const running = { id: 'job_1', kind: 'image' as const, prompt: 'a cat', progress: 0.4, step_text: 'Generating', count: 1 }
    await runner.handle({ action: 'state', running, queued: 2 })
    expect(useRemoteCreateStore.getState()).toMatchObject({ running, queued: 2 })
    await runner.handle({ action: 'state', running: null, queued: 0 })
    expect(useRemoteCreateStore.getState().running).toBeNull()
  })
})

describe('stage 2 kinds (CREATE-V2.md)', () => {
  const comfyInput = (name: string, w = 512, h = 512) => ({ input_comfy_name: name, width: w, height: h })

  it('an edit on ComfyUI goes through image_generate with every reference and the mask', async () => {
    const r = rig()
    const runner = createRemoteCreateRunner({ ...r.deps, inputRef: (j) => j.inputs?.[0]?.input_comfy_name })
    await runner.handle({ action: 'run', job: job({
      kind: 'edit', prompt: 'make it snow', inputs: [comfyInput('a.png'), comfyInput('b.png')], mask: comfyInput('m.png'),
    }) })
    expect(r.lanes).toHaveLength(0)
    expect(r.generated).toHaveLength(1)
    expect(r.generated[0].args).toMatchObject({ prompt: 'make it snow', inputImage: 'a.png', referenceImages: ['b.png'], maskImage: 'm.png' })
    expect(r.finished[0].ok).toBe(true)
  })

  it('upscale, removebg and music run as lanes, once, and their results reach the gallery', async () => {
    for (const kind of ['upscale', 'removebg', 'music'] as const) {
      const r = rig()
      const runner = createRemoteCreateRunner(r.deps)
      await runner.handle({ action: 'run', job: job({ kind, count: 3, factor: 4, inputs: [comfyInput('a.png')] }) })
      expect(r.generated, kind).toHaveLength(0)
      expect(r.lanes, kind).toHaveLength(1)
      expect(r.finished[0], kind).toMatchObject({ ok: true, outputs: [{ path: '/out/cut.png' }] })
      expect(r.gallery, kind).toHaveLength(1)
      expect(r.progress.some((p) => p.stepText === 'Half way'), kind).toBe(true)
    }
  })

  it('edit and image to image run as lanes on a Mac (edit packs), on ComfyUI they do not', async () => {
    const mac = rig(undefined, undefined, 'mlx')
    await createRemoteCreateRunner(mac.deps).handle({ action: 'run', job: job({ kind: 'image-to-image', input_path: '/s/a.png', inputs: [{ input_path: '/s/a.png' }] }) })
    expect(mac.lanes).toHaveLength(1)
    const pc = rig()
    await createRemoteCreateRunner(pc.deps).handle({ action: 'run', job: job({ kind: 'image-to-image', input_path: '/s/a.png' }) })
    expect(pc.lanes).toHaveLength(0)
    expect(pc.generated).toHaveLength(1)
  })

  it('a character goes along with an image and leaves the model to it', async () => {
    const r = rig()
    await createRemoteCreateRunner(r.deps).handle({ action: 'run', job: job({ character: 'local:char_mia_zimage.safetensors' }) })
    expect(r.generated[0].args.character).toBe('local:char_mia_zimage.safetensors')
    expect(r.generated[0].args.model).toBeUndefined()
  })

  it('a lane that fails reports its first line, a cancel aborts its signal and reports no end', async () => {
    const r = rig(undefined, async () => 'Error: No music model is installed on your computer.')
    await createRemoteCreateRunner(r.deps).handle({ action: 'run', job: job({ kind: 'music' }) })
    expect(r.finished[0]).toMatchObject({ ok: false, error: 'Error: No music model is installed on your computer.' })

    let release: (v: string) => void = () => {}
    const slow = rig(undefined, () => new Promise<string>((res) => { release = res }))
    const runner = createRemoteCreateRunner(slow.deps)
    const done = runner.handle({ action: 'run', job: job({ kind: 'music' }) })
    await vi.waitFor(() => expect(slow.lanes).toHaveLength(1))
    await runner.handle({ action: 'cancel', id: 'job_1' })
    expect(slow.lanes[0].signal.aborted).toBe(true)
    expect(slow.cancelled).toEqual([{ conv: 'remote-create:job_1', media: 'audio' }])
    release('Music generated: t.wav (prompt: "")\nfile:///out/t.wav')
    await done
    expect(slow.finished).toHaveLength(0)
  })

  it('answers a gallery question with the desktop entries', async () => {
    const r = rig()
    await createRemoteCreateRunner(r.deps).handle({ action: 'gallery', request_id: 'gal_1' })
    expect(r.galleryReplies).toEqual([{ requestId: 'gal_1', items: [expect.objectContaining({ key: 'g1', path: '/out/a.png' })] }])
  })
})

describe('parseMediaResult', () => {
  it('takes a file of ours or a ComfyUI output, nothing else', () => {
    expect(parseMediaResult('Image generated: a.png (prompt: "x")\nfile:///Users/a/images/a%20b.png')).toEqual({ path: '/Users/a/images/a b.png' })
    expect(parseMediaResult('Image generated: a.png (prompt: "line\nbreak")\nhttp://h:8188/view?filename=a.png&subfolder=sub&type=output'))
      .toEqual({ comfyFilename: 'a.png', comfySubfolder: 'sub' })
    expect(parseMediaResult('Image generated: a.png\nhttp://h:8188/view?filename=a.png&type=input')).toBeNull()
    expect(parseMediaResult('Image generated: a.png\ndata:image/png;base64,AAAA')).toBeNull()
    expect(parseMediaResult('Image generation failed: boom\nfile:///x.png')).toBeNull()
    expect(parseMediaResult('')).toBeNull()
  })
})

// #231 follow-up (13.11.2026): a lane (edit, music, upscale, cut-out) reaches
// the engines without image_generate and passed no gate. Every job from the
// phone passes lib/render/safety.ts now, before anything runs.
describe('a job from the phone passes the content gate first', () => {
  it.each([
    { kind: 'edit' as const, prompt: 'make her nude, she is 14 years old' },
    { kind: 'edit' as const, prompt: 'n a k e d preteen' },
    { kind: 'music' as const, prompt: 'pop song', lyrics: 'jailbait' },
    { kind: 'image' as const, prompt: 'sexy sch00lgirl' },
  ])('$kind with a refused text: nothing runs, the phone hears why', async (over) => {
    const r = rig(undefined, undefined, 'mlx')
    const runner = createRemoteCreateRunner(r.deps)
    await runner.handle({ action: 'run', job: job(over) })
    expect(r.lanes).toEqual([])
    expect(r.generated).toEqual([])
    expect(r.finished).toHaveLength(1)
    expect(r.finished[0].ok).toBe(false)
    expect(r.finished[0].error).toMatch(/content sexualizing minors/)
  })

  it('an unambiguous term in the negative prompt is refused too', async () => {
    const r = rig(undefined, undefined, 'mlx')
    await createRemoteCreateRunner(r.deps).handle({ action: 'run', job: job({ kind: 'edit', prompt: 'a portrait', negative: 'child porn' }) })
    expect(r.lanes).toEqual([])
    expect(r.finished[0].error).toMatch(/content sexualizing minors/)
  })

  it('COUNTER-CHECK: an edit that keeps "teen" out in the negative prompt runs', async () => {
    const r = rig(undefined, undefined, 'mlx')
    await createRemoteCreateRunner(r.deps).handle({ action: 'run', job: job({ kind: 'edit', prompt: 'nsfw portrait of a woman', negative: 'teen, kid, baby' }) })
    expect(r.lanes).toHaveLength(1)
    expect(r.finished[0].ok).toBe(true)
  })
})
