/**
 * The numbers of the LU Cloud page (parts/cloud-counts.ts), recounted.
 *
 * Every number is held twice: against a written out value here, so whoever
 * changes it changes it twice and on purpose, and against a count of the
 * catalogue this app carries by the one rule of parts/cloud-count-rule.ts
 * (decision D1). The total is the sum of its parts, the App Store build names
 * none before sign in (D2), and the count of a signed in account follows what
 * its build lists.
 *
 * Lauf: npx vitest run src/mobile/screens/settings/__tests__/cloud-counts.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_PITCH } from '../../../../lib/cloud-pitch'
import { CLOUD_MODEL_SEED } from '../../../../lib/render/cloud-models'
import { STUDIO_MODELS } from '../../../../lib/render/studio-contract'
import { STORE_PRESETS, setStorePresetForTests } from '../../../policy/storePolicy'
import { offeredCreateModels } from '../../create/parts/policy'
import { countCreateModels, countedKind, modelKey } from '../parts/cloud-count-rule'
import { CATALOGUE_COUNTS, CLOUD_COUNTED_ON, cloudCountsFor, cloudCountsSeen, measuredWithoutRefusals } from '../parts/cloud-counts'

afterEach(() => setStorePresetForTests(null))

/** The Create catalogue the app carries: the seed of the classic models and the studio registry. */
const CATALOGUE = [
  ...CLOUD_MODEL_SEED,
  ...Object.entries(STUDIO_MODELS).map(([id, m]) => ({ id, label: m.label, kind: m.kind, adult: m.adult })),
]

/** The rows of the measurement: the cloud chat models the app knows by id. One more joined after it (said in the file). */
function measuredRows(): string[] {
  const text = readFileSync(resolve(__dirname, '../../../../lib/no-refusals-measurement.md'), 'utf8')
  const table = text.slice(0, text.indexOf('## Refusals per answer'))
  const rows = [...table.matchAll(/^\| ([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+) \|/gm)].map((m) => m[1])
  expect(text).toMatch(/DeepSeek V4\.1 Flash joined the catalogue after\s+that run/)
  return rows
}

describe('the counts of the LU Cloud page', () => {
  it('are written out here a second time', () => {
    expect(CATALOGUE_COUNTS).toEqual({ chat: 43, image: 24, video: 24 })
    expect(CLOUD_COUNTED_ON).toBe('2026-10-24')
  })

  it('chat: the 36 measured rows and the seven that joined later, the same 43 as the pitch', () => {
    const rows = measuredRows()
    expect(rows).toHaveLength(36)
    expect(new Set(rows).size).toBe(rows.length)
    // DeepSeek V4.1 Flash, Kimi K3.1 Pro, MiMo V2.6 Pro, Nemotron 3.5 Super VL (catalogue of 24.10.2026),
    // Qwen 4 Max, Inkling 2 Mini, Inkling 2 Small (24.11.2026).
    expect(CATALOGUE_COUNTS.chat).toBe(rows.length + 7)
    expect(CATALOGUE_COUNTS.chat).toBe(CLOUD_PITCH.chatModels)
  })

  it('image and video: recounted from the catalogue the app carries, by the one rule', () => {
    expect(countCreateModels(CATALOGUE)).toEqual({ image: CATALOGUE_COUNTS.image, video: CATALOGUE_COUNTS.video })
  })

  it('the rule leaves out twins, tools and sound, and counts one name once', () => {
    const kinds = new Map(CATALOGUE.map((m) => [m.id, countedKind(m)]))
    // Twins: the same endpoint under a new name.
    for (const id of ['preset-chroma', 'preset-prefect-pony', 'preset-neta-lumina', 'preset-wan-2.2-spicy', 'preset-wan-2.7-spicy']) expect(kinds.get(id), id).toBeNull()
    // Tools that work on a finished result, training, sound.
    for (const id of ['wan-2.2-spicy-extend', 'preset-wan-2.2-spicy-extend', 'wan-3.0-extend', 'seedance-2.5-extend', 'flashvsr', 'video-upscaler', 'qwen-image-edit', 'seedream-5-edit', 'infinitetalk', 'latentsync', 'scail-2', 'wan-ditto', 'mmaudio-v2', 'flux-lora-trainer', 'flux-schnell-lora', 'qwen3-tts', 'eleven-music']) {
      expect(kinds.get(id), id).toBeNull()
    }
    // Makers, classic and studio.
    for (const id of ['flux-schnell', 'chroma', 'z-image', 'qwen-image-2.1']) expect(kinds.get(id), id).toBe('image')
    for (const id of ['wan-2.2-720p', 'vidu-q3-spicy', 'open-video', 'ltx-2.5-t2v', 'minimax-h3-ref']) expect(kinds.get(id), id).toBe('video')
    // One name, one model.
    expect(modelKey('LTX 2.5')).toBe(modelKey('LTX 2.5'))
    expect(modelKey('MiniMax H3 • Reference')).toBe(modelKey('MiniMax H3'))
    expect(modelKey('OpenVideo + Style LoRA')).toBe(modelKey('OpenVideo'))
    expect(modelKey('Z-Image Turbo (fast)')).toBe('z-image turbo')
    expect(modelKey('Wan 3.0 Spicy')).not.toBe(modelKey('Wan 3.0'))
  })

  it('the total is the sum of the parts, computed', () => {
    const counts = cloudCountsFor(STORE_PRESETS.open)!
    expect(counts.total).toBe(counts.chat + counts.image + counts.video)
    // 79 until the web catalogue of 24.10.2026 came over (3.1.0), nine more image models since.
    expect(counts.total).toBe(91)
  })

  it('the open build names the numbers, the two store builds none before sign in (Play since r56, 18.10.2026)', () => {
    expect(cloudCountsFor(STORE_PRESETS.open)).not.toBeNull()
    expect(cloudCountsFor(STORE_PRESETS.play)).toBeNull()
    expect(cloudCountsFor(STORE_PRESETS.appstore)).toBeNull()
  })

  it('the measured count stands in the open build only', () => {
    expect(measuredWithoutRefusals(STORE_PRESETS.open)).toBe(CLOUD_PITCH.unfilteredChatModels)
    expect(measuredWithoutRefusals(STORE_PRESETS.play)).toBeNull()
    expect(measuredWithoutRefusals(STORE_PRESETS.appstore)).toBeNull()
  })

  it('signed in: the count of the lists this build really shows', () => {
    const chat = [
      { name: 'lu-cloud::maker/a', displayName: 'A', provider: 'lu-cloud' },
      { name: 'lu-cloud::maker/b', displayName: 'B', provider: 'lu-cloud', unfiltered: 'full' },
      { name: 'lu-cloud::maker/c', displayName: 'C', provider: 'lu-cloud', unrestricted: true },
      { name: 'phone-model', displayName: 'On this phone', provider: 'builtin' },
    ]
    setStorePresetForTests('open')
    const open = cloudCountsSeen(chat, offeredCreateModels(CATALOGUE), STORE_PRESETS.open)!
    expect(open).toMatchObject({ chat: 3, image: 24, video: 24, total: 51 })
    setStorePresetForTests('appstore')
    const apple = cloudCountsSeen(chat, offeredCreateModels(CATALOGUE), STORE_PRESETS.appstore)!
    expect(apple.chat).toBe(1)
    expect(apple.image).toBeLessThan(open.image)
    expect(apple.video).toBeLessThan(open.video)
    expect(apple.total).toBe(apple.chat + apple.image + apple.video)
    // Play counts what it lists since r56: the same as the App Store build.
    setStorePresetForTests('play')
    expect(cloudCountsSeen(chat, offeredCreateModels(CATALOGUE), STORE_PRESETS.play)).toEqual(apple)
    // Nothing loaded yet: no number from half a list.
    expect(cloudCountsSeen([], offeredCreateModels(CATALOGUE), STORE_PRESETS.open)).toBeNull()
    expect(cloudCountsSeen(chat, null, STORE_PRESETS.open)).toBeNull()
  })
})
