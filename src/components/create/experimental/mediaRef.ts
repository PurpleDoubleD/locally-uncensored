/**
 * Where a staged Create input file gets its `blob:` preview URL — and the only
 * place it does.
 *
 * A `blob:` URL pins its File in the renderer until somebody revokes it. This
 * module owns the BIRTH of such a URL; `createStore`'s `releaseDroppedMediaRefs`
 * owns its DEATH, and every slot that holds a `MediaRef` writes through a
 * setter that calls it. Two functions, one lifetime.
 *
 * That pairing is the point. Before T-76 the mint was copied inline into each
 * surface that needed one — SpecialIntentControls for the voice clip and the
 * driving video, Stage's training board for the photo set — and only the two
 * scalar slots had a release. The third surface leaked its whole set, and
 * nothing about the code said which of the three was the odd one out. Anyone
 * adding a fourth slot now finds a mint that has exactly one counterpart.
 *
 * Do NOT revoke here. The ref outlives the component that made it — it lives
 * in the store, and the store is what knows when it stops being reachable.
 */
import type { MediaRef } from '../../../stores/createStore'

/** A staged file plus the `blob:` preview URL that shows it. */
export function mediaRefFrom(file: File): MediaRef {
  return { name: file.name, url: URL.createObjectURL(file), blob: file }
}
