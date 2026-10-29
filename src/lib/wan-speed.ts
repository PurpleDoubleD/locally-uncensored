// Fast mode for the Wan 14B models (B18, 3.0.9).
//
// lightx2v distilled Wan 2.1 and Wan 2.2 A14B to four sampling steps without
// classifier free guidance and published the difference as rank 64 LoRAs
// (lightx2v/Wan2.2-Distill-Loras, lightx2v/Wan2.1-Distill-Loras, Apache-2.0).
// Loaded on top of the untouched base model they turn a 30 step run at cfg 5,
// which costs two model calls a step, into 4 steps at cfg 1, one call each:
// about fifteen times fewer model calls for the same clip. The model card asks
// for strength 1.0; the sampling values below are the ones its ComfyUI
// workflows run (euler, simple, shift 5, the A14B pair split 2 + 2).
//
// Quality stays one switch away. The quality values are the official
// Comfy-Org templates for the A14B pair (20 steps, cfg 3.5, shift 8) and the
// family defaults for Wan 2.1.

/** Which speed LoRA set a model takes, or null when it has none. */
export type WanSpeedKind = 'a14b-i2v' | 'a14b-t2v' | 'wan21-i2v' | 'wan21-t2v'

export type VideoSpeed = 'fast' | 'quality'

export interface WanSampling {
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  /** ModelSamplingSD3 shift. */
  shift: number
}

/** Four steps at cfg 1, as the lightx2v LoRAs are distilled for. */
export const WAN_FAST: WanSampling = { steps: 4, cfgScale: 1, sampler: 'euler', scheduler: 'simple', shift: 5 }

/** The official Comfy-Org A14B templates. */
export const WAN_A14B_QUALITY: WanSampling = { steps: 20, cfgScale: 3.5, sampler: 'euler', scheduler: 'simple', shift: 8 }

/** Wan 2.1 at its family defaults, plus the shift its official templates set
 *  (LU ran it without one until 3.0.9). */
export const WAN21_QUALITY: WanSampling = { steps: 30, cfgScale: 6, sampler: 'euler', scheduler: 'normal', shift: 8 }

const isA14B = (lower: string) =>
  /wan[._-]?2[._-]?2/.test(lower) && !lower.includes('ti2v') && !/(^|[^0-9])5b/.test(lower)
  && (/(^|[^0-9])a?14b/.test(lower) || /(high|low)[._-]?noise/.test(lower) || /(^|[^a-z])[it]2v([^a-z]|$)/.test(lower))

/** A merge that already carries a distill (Rapid AIO, Lightning, FusionX,
 *  CausVid) runs fast by itself; a second distill on top burns the picture. */
export function isMergedFastModel(name: string): boolean {
  return /rapid|lightning|lightx2v|fusionx|causvid|4step|4-step|distill/i.test(name)
}

/** The speed LoRA set this video model takes, or null. Only the 14B models
 *  have one: lightx2v published none for the 1.3B and none for the TI2V-5B. */
export function wanSpeedKind(model: string): WanSpeedKind | null {
  const lower = (model || '').toLowerCase()
  if (!lower || isMergedFastModel(lower)) return null
  const i2v = /(^|[^a-z])i2v([^a-z]|$)/.test(lower) || lower.includes('_i2v') || lower.includes('-i2v')
  if (isA14B(lower)) return i2v ? 'a14b-i2v' : 'a14b-t2v'
  const wan21 = /wan[._-]?2[._-]?1/.test(lower)
  if (wan21 && /(^|[^0-9.])14b/.test(lower) && !lower.includes('vace') && !lower.includes('flf')) {
    return i2v ? 'wan21-i2v' : 'wan21-t2v'
  }
  return null
}

/** True when the model has a fast mode at all. */
export function hasWanFastMode(model: string): boolean {
  return wanSpeedKind(model) !== null
}

/**
 * The installed speed LoRA for one half of the model (`single` for Wan 2.1),
 * from the names ComfyUI's LoRA loader lists, or null.
 *
 * Both spellings are accepted: lightx2v's own
 * (wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors) and
 * the older Comfy-Org repack
 * (wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors). When several
 * match, the newest lightx2v release wins (the highest trailing number).
 */
export function findWanSpeedLora(kind: WanSpeedKind, half: 'high' | 'low' | 'single', listed: string[]): string | null {
  const task = kind.endsWith('i2v') ? 'i2v' : 't2v'
  const base = (n: string) => n.replace(/^.*[\\/]/, '').toLowerCase()
  const hits = listed.filter((name) => {
    const b = base(name)
    if (!/lightx2v/.test(b) || !/4[_-]?steps?/.test(b)) return false
    if (!new RegExp(`(^|[^a-z])${task}([^a-z]|$)`).test(b)) return false
    if (kind.startsWith('a14b')) {
      if (!/wan[._-]?2[._-]?2/.test(b)) return false
      return half === 'high' ? /high[._-]?noise/.test(b) : half === 'low' ? /low[._-]?noise/.test(b) : false
    }
    return /wan[._-]?2[._-]?1/.test(b) && half === 'single'
  })
  if (hits.length === 0) return null
  const stamp = (n: string) => Number((/_(\d{3,4})\.safetensors$/i.exec(base(n)) ?? [])[1] ?? 0)
  return [...hits].sort((a, b) => stamp(b) - stamp(a))[0]
}

/** The file names a fast run needs, for the message when one is missing. */
export function wanSpeedLoraNames(kind: WanSpeedKind): string[] {
  switch (kind) {
    case 'a14b-i2v': return [
      'wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors',
      'wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors',
    ]
    case 'a14b-t2v': return [
      'wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors',
      'wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors',
    ]
    case 'wan21-i2v': return ['wan2.1_i2v_lora_rank64_lightx2v_4step.safetensors']
    case 'wan21-t2v': return ['wan2.1_t2v_14b_lora_rank64_lightx2v_4step.safetensors']
  }
}

/** The sampling a Wan model starts with in the given mode, or null when the
 *  model is not one of the 14B models this file speaks for. */
export function wanSamplingFor(model: string, speed: VideoSpeed): WanSampling | null {
  const kind = wanSpeedKind(model)
  if (!kind) return null
  if (speed === 'fast') return WAN_FAST
  return kind.startsWith('a14b') ? WAN_A14B_QUALITY : WAN21_QUALITY
}

/** A run that asks for few steps at cfg 1 is a fast run. The builder reads
 *  this off the numbers the run carries, so a user who drags the sliders to
 *  4 and 1 by hand gets the LoRAs too, and one who drags them back gets none. */
export function isFastSampling(steps: number, cfgScale: number): boolean {
  return steps > 0 && steps <= 8 && cfgScale <= 1.5
}
