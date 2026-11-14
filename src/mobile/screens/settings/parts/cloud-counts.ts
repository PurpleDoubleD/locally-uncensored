/**
 * How many models the LU Cloud page (E3) names, per store preset.
 *
 * The page names a number BEFORE anybody is signed in, so there is no list
 * to count yet: the numbers stand here, counted by the one rule of
 * cloud-count-rule.ts (decision D1, mobile-docs/plaene/LU-CLOUD-SEITE.md)
 * from the catalogue this app carries. The total is computed, never typed.
 * Once an account is signed in and its lists are loaded, the page counts the
 * lists it really shows instead (cloudCountsSeen below).
 *
 * Derivation, counted 17.10.2026 (mobile-docs/r51/cloudseite.md), chat
 * counted again for the catalogue of 24.10.2026:
 *  - chat 40: the 36 rows of lib/no-refusals-measurement.md (DeepSeek R1 and
 *    GLM 5.1 left the catalogue on 24.10., eight retired upstream models on
 *    08.11.) plus four that joined after that run: DeepSeek V4.1 Flash, Kimi
 *    K3.1 Pro, MiMo V2.6 Pro and Nemotron 3.5 Super VL (the same 40 as
 *    lib/cloud-pitch.ts chatModels).
 *  Image and video counted again for the web catalogue of 24.10.2026 (3.1.0,
 *  lib/render/web-catalog-source.json):
 *  - image 24: the 8 classic image models of lib/render/cloud-models.ts
 *    (HiDream and HunyuanImage 2.1 left the pickers on 24.10.) and 16 studio
 *    models that make a picture from words: Z-Image Base, Nucleus, JibMix
 *    Qwen, Wan 2.2 Realism, Qwen Image 2.1, and since 24.10. FLUX 3 Klein,
 *    FLUX 3 Klein Base, Krea 2 Turbo, MOSS Image, GPT Image 2, Nano Banana
 *    Pro, FLUX.2 Max, Midjourney, Grok Imagine Quality, Recraft V4.1 Pro and
 *    Kling Image O3. Not the 3 studio twins.
 *  - video 24: the 14 classic video models (HunyuanVideo 1.5 and LTX 2.3 left
 *    on 24.10., Seedance 2.0 Mini joined), and 10 studio models: OpenVideo
 *    (with its Style LoRA endpoint, one model), Seedance 2.5, Seedance 2.5
 *    Turbo, MiniMax H3 (text, image and reference, one model), Wan 3.0 (text,
 *    image and reference, one model), Wan 3.0 Spicy, Wan 3.0 Prime (text and
 *    image, one model), Wan 3.0 Prime Spicy, LTX 2.5 (text and image, one
 *    model), MiniMax H3 Singularity (image and reference, one model). Not the
 *    twins, not extend, upscale, lip sync, motion, restyle or sound.
 *
 * open and play list the whole catalogue (play the marked models under the
 * mark "Direct"), so they name the same numbers. appstore leaves models out
 * and lists fewer, and how many chat models it lists depends on a mark only
 * the server sets (`unrestricted`): no number before sign in (decision D2).
 *
 * Count again before every release. __tests__/cloud-counts.test.ts recounts
 * from the catalogue and holds every number against a written out value.
 */
import { CLOUD_PITCH } from '../../../../lib/cloud-pitch'
import { cloudModelsShown, type NamedCloudModel } from '../../../policy/unfiltered'
import type { StorePolicy } from './policy'
import { countChatModels, countCreateModels, type CountableCreateModel } from './cloud-count-rule'
import { listsWholeCloudCatalogue } from './store-rules'

export interface CloudCounts {
  chat: number
  image: number
  video: number
  total: number
}

/** The day of the count above. */
export const CLOUD_COUNTED_ON = '2026-10-24'

/** The counts of the whole catalogue, as the app carries it. */
export const CATALOGUE_COUNTS = { chat: 40, image: 24, video: 24 } as const

const withTotal = (c: { chat: number; image: number; video: number }): CloudCounts => ({ ...c, total: c.chat + c.image + c.video })

/** Pure: the counts this build may name before sign in, or null where it names none. */
export function cloudCountsFor(policy: Parameters<typeof listsWholeCloudCatalogue>[0]): CloudCounts | null {
  return listsWholeCloudCatalogue(policy) ? withTotal(CATALOGUE_COUNTS) : null
}

/**
 * Pure: the chat models that answered without refusing in the measurement of
 * 10.09.2026 (decision D7), for a build that may advertise it, else null. A
 * measurement and said as one; read from lib/cloud-pitch.ts, whose guard counts
 * it in lib/no-refusals-measurement.md.
 */
export function measuredWithoutRefusals(policy: Pick<StorePolicy, 'unfilteredMarketing' | 'unfilteredCatalog'>): number | null {
  return policy.unfilteredMarketing && policy.unfilteredCatalog ? CLOUD_PITCH.unfilteredChatModels : null
}

/**
 * Pure: the counts of the lists a signed in account really sees in this
 * build: the LU Cloud chat models the picker lists and the Create models the
 * sheet offers. Null while one of the two is not there yet.
 */
export function cloudCountsSeen(
  chat: ReadonlyArray<NamedCloudModel & { provider?: string }>,
  create: readonly CountableCreateModel[] | null,
  policy: Pick<StorePolicy, 'unfilteredCatalog' | 'unfilteredMarketing' | 'unfilteredWords' | 'directBadge'>,
): CloudCounts | null {
  const chatCount = countChatModels(cloudModelsShown(chat, policy).keys())
  if (!chatCount || !create) return null
  return withTotal({ chat: chatCount, ...countCreateModels(create) })
}
