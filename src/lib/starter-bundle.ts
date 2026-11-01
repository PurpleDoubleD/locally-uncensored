import { bundleForVideoIntent } from '../api/comfyui'
import {
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles,
} from '../api/discover'
import type { ModelBundle } from '../api/model-bundles'

export type StarterKind = 'image' | 'video' | 'audio' | 'lipsync' | 'motion' | 'upscale'

/**
 * The bundle the Create setup card installs for a lane. One place, because
 * two need it: the installer, and the card, which has to know whether that
 * bundle is already on disk (GH #209, 31.10.2026: the card asked for the
 * download again over files that were all there).
 *
 * The video lane picks by the same rule the gate uses: Extend Video and
 * Animate Image need an image-to-video model, see bundleForVideoIntent.
 */
export function starterBundleFor(kind: StarterKind, intent: string): ModelBundle | undefined {
  if (kind === 'video') return bundleForVideoIntent(getVideoBundles(), intent)
  return (
    kind === 'image' ? getImageBundles()
    : kind === 'audio' ? getAudioBundles()
    : kind === 'lipsync' ? getLipsyncBundles()
    : kind === 'upscale' ? getUpscaleBundles()
    : getMotionBundles()
  )[0]
}
