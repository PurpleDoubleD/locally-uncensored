/**
 * Die Stufen der lokalen ComfyUI-Modelle (02.10.2026).
 *
 * Zwei Seiten muessen dasselbe sagen: der Katalog (jedes Bundle traegt `tier`)
 * und der lokale Waehler, der eine installierte Datei nur aus Typ und Namen
 * kennt (local-model-tier.ts). Dieser Test haelt sie gleich und haelt fest,
 * welche Familie wohin gehoert, mit dem Grund im Namen des Falls.
 */
import { describe, it, expect } from 'vitest'
import { localTier } from '../local-model-tier'
import { sortByTier, tierGroup, tierMarks, OLDER_GROUP } from '../model-tier'
import { classifyModel } from '../../../api/comfyui'
import {
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, type ModelBundle,
} from '../../../api/model-bundles'

const ALL: ModelBundle[] = [
  ...getImageBundles(), ...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles(),
]

/** Die Datei, die das Bundle tatsaechlich rechnet (nicht VAE oder Encoder). */
const mainFile = (b: ModelBundle) =>
  b.files.find((f) => ['diffusion_models', 'checkpoints', 'unet'].includes(f.subfolder ?? ''))?.filename ?? ''

const tierOfFile = (name: string) => localTier({ name, type: classifyModel(name) })

describe('jedes lokale Bundle traegt eine Stufe', () => {
  it('alle 46 Bundles haben best, standard oder older', () => {
    // B18 (3.0.9): Wan 2.2 A14B I2V und T2V Fast, Wan 2.1 Speed-LoRAs.
    expect(ALL.length).toBe(46)
    for (const b of ALL) expect(['best', 'standard', 'older'], b.name).toContain(b.tier)
  })

  it('Katalog und Waehler sagen dasselbe: die Stufe des Bundles ist die Stufe seiner Hauptdatei', () => {
    for (const b of ALL) {
      // Ein Bundle ohne eigene Hauptdatei (Krea 2 Begleitdateien, SDXL-VAE, Pixel Art
      // LoRA) kennt der Waehler nicht als Modell; dort zaehlt die Familie des Bundles.
      const name = mainFile(b)
      const viaFile = name ? localTier({ name, type: classifyModel(name) }) : null
      const viaFamily = localTier({ name, type: b.workflow })
      expect(viaFamily, `${b.name} (Familie ${b.workflow})`).toBe(b.tier)
      if (viaFile && name) {
        // AnimateDiff und die SD1.5-Basis tragen nie den Typ des Bundles.
        if (b.workflow !== 'animatediff') expect(viaFile, `${b.name} · ${name}`).toBe(b.tier)
      }
    }
  })
})

describe('welche Familie wohin gehoert', () => {
  const best = [
    ['LTX 2.5', 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'],
    ['MiniMax H3', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
    ['FastH3', 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors'],
    ['Qwen-Image 2.1', 'qwen_image_2.1_int8_convrot.safetensors'],
    ['Z-Image Turbo', 'z_image_turbo_bf16.safetensors'],
    ['Z-Image Base', 'z_image_bf16.safetensors'],
    ['FLUX 2 Klein', 'flux-2-klein-base-4b.safetensors'],
    ['Krea 2', 'krea-2-dev-fp8.safetensors'],
    ['ERNIE-Image', 'ernie-image-turbo.safetensors'],
    ['YuE2', 'yue2_3b_int8_convrot.safetensors'],
    ['ACE Step 1.5 Turbo', 'ace_step_1.5_turbo_aio.safetensors'],
  ]
  const standard = [
    ['Wan 2.2 TI2V 5B', 'wan2.2_ti2v_5B_fp16.safetensors'],
    ['Wan 2.2 Rapid AIO', 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf'],
    ['Wan 2.2 S2V', 'wan2.2_s2v_14B_fp8_scaled.safetensors'],
    ['Wan 2.2 Animate', 'Wan2.2-Animate-14B-Q4_K_M.gguf'],
    ['ACE Step v1', 'ace_step_v1_3.5b.safetensors'],
  ]
  const older = [
    ['Juggernaut XL', 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors'],
    ['RealVisXL', 'RealVisXL_V5.0_fp16.safetensors'],
    ['DreamShaper XL', 'DreamShaperXL_Turbo_V2-SFW.safetensors'],
    ['FLUX 1 schnell', 'flux1-schnell-fp8.safetensors'],
    ['FLUX 1 dev', 'flux1-dev-fp8.safetensors'],
    ['Wan 2.1 1.3B', 'wan2.1_t2v_1.3B_bf16.safetensors'],
    ['Wan 2.1 14B', 'wan2.1_t2v_14B_fp8_e4m3fn.safetensors'],
    ['NSFW Wan 14B', 'nsfw_wan_14b_e15_q4_k.gguf'],
    ['Wan VACE 1.3B', 'wan2.1_vace_1.3B_fp16.safetensors'],
    ['HunyuanVideo 1.5', 'hunyuanvideo1.5_480p_t2v_cfg_distilled_fp8_scaled.safetensors'],
    ['LTX 2.3', 'ltx-2.3-22b-distilled-fp8.safetensors'],
    ['FramePack', 'FramePackI2V_HY_fp8_e4m3fn.safetensors'],
    ['SVD', 'svd_xt_1_1.safetensors'],
    ['Mochi', 'mochi_preview_fp8_scaled.safetensors'],
    ['Cosmos 7B', 'Cosmos-1_0-Diffusion-7B-Text2World.safetensors'],
  ]

  it.each(best)('%s ist best', (_n, file) => { expect(tierOfFile(file)).toBe('best') })
  it.each(standard)('%s ist standard', (_n, file) => { expect(tierOfFile(file)).toBe('standard') })
  it.each(older)('%s ist older', (_n, file) => { expect(tierOfFile(file)).toBe('older') })

  it('was keine Liste nennt, bleibt standard und traegt nichts', () => {
    expect(localTier({ name: 'mystery.safetensors', type: 'unknown' })).toBe('standard')
    expect(localTier({ name: 'chroma1-hd.safetensors', type: 'chroma' })).toBe('standard')
    expect(tierMarks({ tier: 'standard' })).toEqual([])
    expect(tierGroup({ tier: 'standard' })).toBeUndefined()
  })
})

describe('die Reihenfolge im Waehler', () => {
  const list = [
    'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors', 'chroma1-hd.safetensors', 'qwen_image_2.1_int8_convrot.safetensors',
    'flux1-dev-fp8.safetensors', 'z_image_turbo_bf16.safetensors', 'wan2.2_ti2v_5B_fp16.safetensors',
  ].map((name) => ({ name, tier: tierOfFile(name) }))

  it('Beste oben mit "Best", der Rest in gewohnter Reihenfolge, Aeltere unten unter "Older models"', () => {
    const sorted = sortByTier(list)
    expect(sorted.map((m) => m.name)).toEqual([
      'qwen_image_2.1_int8_convrot.safetensors', 'z_image_turbo_bf16.safetensors',
      'chroma1-hd.safetensors', 'wan2.2_ti2v_5B_fp16.safetensors',
      'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors', 'flux1-dev-fp8.safetensors',
    ])
    expect(sorted.slice(0, 2).map((m) => tierMarks(m).map((t) => t.label))).toEqual([['Best'], ['Best']])
    expect(sorted.slice(2, 4).map((m) => tierGroup(m))).toEqual([undefined, undefined])
    expect(sorted.slice(4).map((m) => tierGroup(m))).toEqual([OLDER_GROUP, OLDER_GROUP])
  })

  it('sortiert, ohne etwas zu verlieren oder die Eingabe zu veraendern', () => {
    const before = list.map((m) => m.name)
    const sorted = sortByTier(list)
    expect(sorted).toHaveLength(list.length)
    expect(list.map((m) => m.name)).toEqual(before)
  })
})
