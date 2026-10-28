/**
 * B18 (3.0.9): long local clips and Fast mode, the parts without ComfyUI.
 *
 * Run: npx vitest run src/lib/__tests__/long-video.test.ts
 */
import { describe, it, expect } from 'vitest'
import { planLongVideo, framesForSeconds, secondsOf, canMakeLongVideo } from '../long-video'
import { continueModelFor, longVideoRequest, planExtension, runLongVideo, LongRunStopped, type ClipItem, type LongVideoAsk } from '../long-video-run'
import { findWanSpeedLora, hasWanFastMode, isFastSampling, wanSamplingFor, wanSpeedKind } from '../wan-speed'
import { estimateVideoRun, minutesText } from '../video-estimate'

describe('planLongVideo: sections on the family grid', () => {
  it('Wan: 30 s at 16 fps is 81 + six sections of 76 new frames, never shorter than asked', () => {
    const p = planLongVideo('wan', 30, 16)!
    expect(p.sections[0]).toBe(81)
    expect(p.overlap).toBe(5)
    for (const f of p.sections) expect((f - 1) % 4).toBe(0)
    expect(p.totalFrames).toBeGreaterThanOrEqual(480)
    expect(p.totalFrames - 480).toBeLessThan(4)
    expect(p.sections).toHaveLength(7)
    expect(p.seconds).toBeGreaterThanOrEqual(30)
  })

  it('a short clip is one run', () => {
    expect(planLongVideo('wan', 4, 16)!.sections).toEqual([65])
  })

  it('LTX 2.5: 10 s sections of 8n+1 frames with 17 repeated', () => {
    const p = planLongVideo('ltx25', 30, 24)!
    expect(p.sections[0]).toBe(241)
    for (const f of p.sections) expect((f - 1) % 8).toBe(0)
    expect(p.totalFrames).toBeGreaterThanOrEqual(720)
    expect(p.sections).toHaveLength(4)
  })

  it('families without a way to continue stay out', () => {
    for (const t of ['hunyuan', 'framepack', 'minimaxh3', 'mochi', 'svd']) {
      expect(canMakeLongVideo(t)).toBe(false)
      expect(planLongVideo(t, 30, 24)).toBeNull()
    }
  })

  it('seconds and frames agree', () => {
    expect(framesForSeconds('wan', 5, 16)).toBe(81)
    expect(framesForSeconds('ltx25', 10, 24)).toBe(241)
    expect(secondsOf(81, 16)).toBe(5.1)
  })
})

describe('planExtension: every section continues', () => {
  it('+5 s of Wan is one section of 81 frames (5 repeated + 76 new)', () => {
    const p = planExtension('wan', 4.75, 16)!
    expect(p.sections).toEqual([81])
    expect(p.totalFrames).toBe(76)
  })
  it('+25 s of Wan is six sections', () => {
    expect(planExtension('wan', 25, 16)!.sections.length).toBe(6)
  })
})

describe('continueModelFor: the image to video model of the same family', () => {
  const installed = ['Wan2.2-T2V-A14B-HighNoise-Q4_K_S.gguf', 'Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf', 'Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf']
  it('a T2V A14B file continues with its I2V twin', () => {
    expect(continueModelFor('Wan2.2-T2V-A14B-HighNoise-Q4_K_S.gguf', 'wan', installed)).toBe('Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf')
  })
  it('an I2V file, the 5B and LTX 2.5 continue with themselves', () => {
    expect(continueModelFor('Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf', 'wan', installed)).toBe('Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf')
    expect(continueModelFor('wan2.2_ti2v_5B_fp16.safetensors', 'wan22', [])).toBe('wan2.2_ti2v_5B_fp16.safetensors')
    expect(continueModelFor('ltx-2.5-22b-distilled.safetensors', 'ltx25', [])).toBe('ltx-2.5-22b-distilled.safetensors')
  })
  it('null without an I2V model', () => {
    expect(continueModelFor('wan2.1_t2v_1.3B_bf16.safetensors', 'wan', ['wan2.1_t2v_1.3B_bf16.safetensors'])).toBeNull()
  })
})

describe('longVideoRequest: what a Create press means', () => {
  const ask = (over: Partial<LongVideoAsk> = {}): LongVideoAsk => ({
    mode: 'video', intent: 'video', model: 'Wan2.2-T2V-A14B-HighNoise-Q4_K_S.gguf', type: 'wan',
    installed: ['Wan2.2-T2V-A14B-HighNoise-Q4_K_S.gguf', 'Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf'],
    longVideoSeconds: 30, longVideoMode: 'sections', fps: 16, frames: 81, extendClip: null, ...over,
  })
  it('30 s: sections, first T2V, then I2V', () => {
    const r = longVideoRequest(ask())!
    expect(r.kind).toBe('sections')
    if (r.kind !== 'sections') return
    expect(r.start.firstModel).toBe('Wan2.2-T2V-A14B-HighNoise-Q4_K_S.gguf')
    expect(r.start.continueModel).toBe('Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf')
  })
  it('within the native length: an ordinary run', () => {
    expect(longVideoRequest(ask({ longVideoSeconds: 5 }))).toBeNull()
    expect(longVideoRequest(ask({ longVideoSeconds: 0 }))).toBeNull()
  })
  it('one pass: the whole length as frames', () => {
    const r = longVideoRequest(ask({ longVideoMode: 'one-pass' }))!
    expect(r).toMatchObject({ kind: 'one-pass' })
  })
  it('no I2V twin: says what to install', () => {
    const r = longVideoRequest(ask({ installed: ['Wan2.2-T2V-A14B-HighNoise-Q4_K_S.gguf'] }))!
    expect(r.kind).toBe('error')
  })
  it('Extend Video with a clip continues it', () => {
    const r = longVideoRequest(ask({ intent: 'extend', model: 'Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf', extendClip: new Blob(['x']), longVideoSeconds: 10 }))!
    expect(r.kind).toBe('sections')
    if (r.kind === 'sections') expect(r.start.clip).toBeDefined()
  })
  it('Hunyuan and the image tab stay ordinary', () => {
    expect(longVideoRequest(ask({ type: 'hunyuan' }))).toBeNull()
    expect(longVideoRequest(ask({ mode: 'image' }))).toBeNull()
  })
})

describe('runLongVideo: section after section, one clip in the gallery', () => {
  function fakeDeps(opts: { failAt?: number } = {}) {
    let gallery: ClipItem[] = []
    const calls: Array<{ override: Record<string, unknown>; opts: { stepLabel: string; continueFrom?: { video: string; overlap: number } } }> = []
    const uploads: string[] = []
    const removed: string[] = []
    let error: string | null = null
    let n = 0
    return {
      calls, uploads, removed,
      galleryNow: () => gallery,
      deps: {
        run: async (override: Record<string, unknown>, o: { stepLabel: string; continueFrom?: { video: string; overlap: number } }) => {
          calls.push({ override, opts: o })
          n++
          if (opts.failAt === n) { error = 'ComfyUI said no'; return }
          gallery = [{ id: `v${n}`, type: 'video', filename: `out_${n}.mp4` }, ...gallery]
        },
        gallery: () => gallery,
        error: () => error,
        fetchBlob: async (item: ClipItem) => new Blob([item.filename ?? '']),
        upload: async (_b: Blob, name: string) => { uploads.push(name); return name },
        remove: (id: string) => { removed.push(id); gallery = gallery.filter((g) => g.id !== id) },
        aborted: () => false,
      },
    }
  }

  it('runs every section, continues from the newest clip and keeps only the last', async () => {
    const f = fakeDeps()
    const plan = planLongVideo('wan', 15, 16)!
    const done = await runLongVideo(plan, { firstModel: 'T2V', continueModel: 'I2V' }, f.deps)
    expect(f.calls).toHaveLength(plan.sections.length)
    expect(f.calls[0].override).toMatchObject({ videoModel: 'T2V', frames: 81 })
    expect(f.calls[0].opts.continueFrom).toBeUndefined()
    for (const c of f.calls.slice(1)) {
      expect(c.override).toMatchObject({ videoModel: 'I2V', cloudOp: 'extend' })
      expect(c.opts.continueFrom?.overlap).toBe(5)
    }
    expect(f.galleryNow().map((g) => g.id)).toEqual([done!.id])
    expect(f.calls[2].opts.stepLabel).toBe(`Section 3 of ${plan.sections.length}`)
  })

  it('a brought clip is continued and never removed', async () => {
    const f = fakeDeps()
    const plan = planExtension('wan', 10, 16)!
    await runLongVideo(plan, { firstModel: 'I2V', continueModel: 'I2V', clip: new Blob(['mine']) }, f.deps)
    expect(f.calls).toHaveLength(plan.sections.length)
    expect(f.calls[0].opts.continueFrom).toBeDefined()
    expect(f.removed).not.toContain('mine')
  })

  it('stops at a failed section with its error and keeps what was made', async () => {
    const f = fakeDeps({ failAt: 3 })
    await expect(runLongVideo(planLongVideo('wan', 30, 16)!, { firstModel: 'T', continueModel: 'I' }, f.deps)).rejects.toThrow(LongRunStopped)
    expect(f.galleryNow()).toHaveLength(1)
  })

  it('settles the seams at the right frames when it can', async () => {
    const f = fakeDeps()
    const seen: number[][] = []
    await runLongVideo(planLongVideo('wan', 15, 16)!, { firstModel: 'T', continueModel: 'I' }, {
      ...f.deps,
      settle: async (item, seams) => { seen.push([...seams]); return item },
    })
    // One seam per step, at the frame the new section starts.
    expect(seen[0]).toEqual([81])
    expect(seen[1]).toEqual([157])
  })

  it('matches every new section to the first one, not to the one before (P5)', async () => {
    const f = fakeDeps()
    const anchors: number[] = []
    await runLongVideo(planLongVideo('wan', 30, 16)!, { firstModel: 'T', continueModel: 'I' }, {
      ...f.deps,
      settle: async (item, _seams, anchorEnd) => { anchors.push(anchorEnd); return item },
    })
    expect(anchors).toHaveLength(6)
    expect(new Set(anchors)).toEqual(new Set([81]))
  })

  it('an extended clip is its own anchor', async () => {
    const f = fakeDeps()
    const anchors: number[] = []
    const plan = planExtension('wan', 10, 16)!
    await runLongVideo(plan, { firstModel: 'I', continueModel: 'I', clip: new Blob(['x']), clipFrames: 161 }, {
      ...f.deps,
      settle: async (item, _seams, anchorEnd) => { anchors.push(anchorEnd); return item },
    })
    expect(new Set(anchors)).toEqual(new Set([161]))
  })
})

describe('Fast mode for the Wan 14B models', () => {
  it('knows which models have a speed LoRA set', () => {
    expect(wanSpeedKind('Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf')).toBe('a14b-i2v')
    expect(wanSpeedKind('wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors')).toBe('a14b-t2v')
    expect(wanSpeedKind('wan2.1_t2v_14B_fp8_e4m3fn.safetensors')).toBe('wan21-t2v')
    expect(wanSpeedKind('wan2.1_i2v_480p_14B_fp8_e4m3fn.safetensors')).toBe('wan21-i2v')
    expect(wanSpeedKind('wan2.1_t2v_1.3B_bf16.safetensors')).toBeNull()
    expect(wanSpeedKind('wan2.2_ti2v_5B_fp16.safetensors')).toBeNull()
    expect(wanSpeedKind('wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf')).toBeNull()
    expect(hasWanFastMode('ltx-2.5-22b-distilled.safetensors')).toBe(false)
  })

  it('finds the LoRA of each half in both spellings, newest release first', () => {
    const listed = [
      'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
      'wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors',
      'wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors',
      'wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors',
    ]
    expect(findWanSpeedLora('a14b-i2v', 'high', listed)).toBe('wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors')
    expect(findWanSpeedLora('a14b-i2v', 'low', listed)).toBe('wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors')
    expect(findWanSpeedLora('a14b-t2v', 'low', listed)).toBeNull()
    expect(findWanSpeedLora('a14b-i2v', 'high', ['wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors'])).toBe('wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors')
  })

  it('fast is 4 steps at cfg 1, quality the official template', () => {
    expect(wanSamplingFor('Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf', 'fast')).toMatchObject({ steps: 4, cfgScale: 1, shift: 5 })
    expect(wanSamplingFor('Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf', 'quality')).toMatchObject({ steps: 20, cfgScale: 3.5, shift: 8 })
    expect(isFastSampling(4, 1)).toBe(true)
    expect(isFastSampling(20, 3.5)).toBe(false)
  })
})

describe('the estimate under the button', () => {
  it('a long clip costs about its sections, and says so', () => {
    const one = estimateVideoRun({ type: 'wan', model: 'Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf', width: 832, height: 480, frames: 81, steps: 4, cfgScale: 1, weightGb: 8.15, cardGb: 12 })!
    const long = estimateVideoRun({ type: 'wan', model: 'Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf', width: 832, height: 480, frames: 81, steps: 4, cfgScale: 1, seconds: 30, fps: 16, weightGb: 8.15, cardGb: 12 })!
    expect(long.sections).toBe(7)
    expect(long.minutes[0]).toBeGreaterThan(one.minutes[0] * 5)
    expect(long.line).toMatch(/7 sections/)
    expect(long.line).toMatch(/estimate/)
  })
  it('quality at cfg 3.5 costs about ten times fast', () => {
    const fast = estimateVideoRun({ type: 'wan', model: 'x14b', width: 832, height: 480, frames: 81, steps: 4, cfgScale: 1 })!
    const quality = estimateVideoRun({ type: 'wan', model: 'x14b', width: 832, height: 480, frames: 81, steps: 20, cfgScale: 3.5 })!
    expect(quality.minutes[0] / fast.minutes[0]).toBeGreaterThan(4)
  })
  it('a card too small says how much goes to system memory', () => {
    const e = estimateVideoRun({ type: 'wan', model: 'x14b', width: 832, height: 480, frames: 81, steps: 4, cfgScale: 1, weightGb: 8.15, cardGb: 8 })!
    expect(e.offloadGb).toBeGreaterThan(0)
    expect(e.line).toMatch(/system memory/)
  })
  it('no numbers for a family without measurements', () => {
    expect(estimateVideoRun({ type: 'hunyuan', model: 'h', width: 848, height: 480, frames: 45, steps: 30, cfgScale: 6 })).toBeNull()
  })
  it('minutes read short', () => {
    expect(minutesText([0.2, 0.5])).toBe('under 1 min')
    expect(minutesText([3.2, 6.8])).toBe('3–7 min')
    expect(minutesText([21, 44])).toBe('20–45 min')
  })
})
