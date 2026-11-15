// "Picture first" in the cloud (3.1.0, C3D-PLAN 1.2): 3D from words as two
// cloud runs. An open image model paints one object, then an image-to-3D
// model builds the mesh from that picture. The text-to-3D endpoints filter
// (one blocked a museum statue in the measurement run); this way needs none
// of them.
//
// The pick is the image-to-3D model itself: in the "From text" list it stands
// as "Picture first", so price, detail step and settings drawer read its own
// schema like any studio model. Only the start (hooks/useCloudCreate.ts)
// knows it paints a picture before.
import { STUDIO_MODELS, studioBaseCredits, studioPreviewCredits } from '../render/studio-contract'
import { studioEntries } from '../../stores/cloudCatalogStore'
import { contentPolicyCap } from '../content-policy-cap'
import { threeDPicturePrompt } from './picture-prompt'

/** The image-to-3D model that builds from the painted picture. */
export const PICTURE_FIRST_MESH = 'trellis-2'

/** Open image models the provider runs with its own filter off, best first.
 *  Z-Image Base: open weights, the cheapest flat price of the open ones. */
const OPEN_PICTURE_MODELS = ['z-image']

/** A build that caps the content policy (a store build of the phone app) does
 *  not list the models without a filter, so it does not run one unseen
 *  either. It paints with an open model that keeps the provider's filter. */
const CAPPED_PICTURE_MODELS = ['qwen-image-2.1']

/** The image model that paints the picture, or undefined when the server
 *  lists none of them. */
export function pictureFirstPictureModel(): string | undefined {
  const ids = contentPolicyCap() ? CAPPED_PICTURE_MODELS : OPEN_PICTURE_MODELS
  return studioEntries(ids)[0]?.id
}

/** True when the server lists both halves of the chain. */
export function pictureFirstOffered(): boolean {
  return !!pictureFirstPictureModel() && studioEntries([PICTURE_FIRST_MESH]).length > 0
}

/** A run of the "From text" way on a model that reads a picture is a
 *  picture-first run. */
export function isPictureFirstRun(way: string | undefined, model: string | undefined): boolean {
  const m = model ? STUDIO_MODELS[model] : undefined
  return way === 'text' && m?.kind === '3d' && Object.values(m.inputs).includes('source_path')
}

/** The credits of the picture step, from the image model's own flat price. */
export function pictureFirstPictureCredits(prompt: string, model = pictureFirstPictureModel()): number {
  if (!model) return 0
  return studioPreviewCredits(model, {}, undefined, 1, Array.from(threeDPicturePrompt(prompt)).length) ?? studioBaseCredits(model)
}

/** What a run adds to the price of its model: the picture step of a
 *  picture-first run, 0 for every other run. Meter, button and picker add
 *  it to the model's own price, so they show the sum the two runs book. */
export function pictureStepCredits(intent: string, way: string | undefined, model: string | undefined, prompt: string): number {
  return intent === '3d' && isPictureFirstRun(way, model) ? pictureFirstPictureCredits(prompt) : 0
}
