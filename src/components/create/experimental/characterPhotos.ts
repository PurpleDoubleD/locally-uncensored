// What a set of character photos can do next: load into the reference strip,
// or start a training set in Character Studio. Used by the frames picked from
// a video and by a saved character (lib/saved-characters).
import { useCreateStore } from '../../../stores/createStore'
import { MAX_STORED_REFERENCES } from '../../../lib/edit-references'
import { frameFileName } from '../../../lib/video-frames'
import { loadImageRef } from './loadImage'
import { mediaRefFrom } from './mediaRef'

function asFiles(name: string, photos: readonly Blob[]): File[] {
  return photos.map((blob, i) => new File([blob], frameFileName(name, i), { type: blob.type || 'image/jpeg' }))
}

/**
 * Loads the photos for an edit. With a source image already loaded in Edit or
 * Animate Image it stays, with its mask, and the photos join the reference
 * strip as far as it has room. Otherwise the first photo becomes the source
 * and the next ones fill the strip. Edit and Animate Image keep their tab,
 * every other tab switches to Edit and starts over with these photos. A model
 * shows and sends only as many photos as it reads.
 * Returns how many photos were loaded.
 */
export async function loadPhotosAsReferences(name: string, photos: readonly Blob[]): Promise<number> {
  const st = useCreateStore.getState()
  const intent = st.intent()
  const stays = intent === 'edit' || intent === 'animate'
  if (!stays) st.setIntent('edit')
  const keepSource = stays && !!st.source
  const room = keepSource ? MAX_STORED_REFERENCES - st.references.length : MAX_STORED_REFERENCES + 1
  const files = asFiles(name, photos).slice(0, Math.max(0, room))
  if (files.length === 0) return 0
  const refs = []
  for (const file of files) refs.push(await loadImageRef(file))
  const now = useCreateStore.getState()
  if (keepSource && now.source) {
    now.setReferences([...now.references, ...refs].slice(0, MAX_STORED_REFERENCES))
    return refs.length
  }
  now.setBatchSources([])
  now.setMask(null)
  now.setSource(refs[0])
  now.setReferences(refs.slice(1))
  return refs.length
}

/** The photos join the training set in Character Studio. The studio's own
 *  minimum and maximum stay as they are. A second batch under the same name
 *  numbers on after the first, so the frames keep one running count (the set
 *  itself would only append _2 to a name it already holds). */
export function sendPhotosToStudio(name: string, photos: readonly Blob[]): void {
  const st = useCreateStore.getState()
  st.setIntent('character')
  st.setCharacterTab('train')
  const taken = new Set(useCreateStore.getState().trainImages.map((t) => t.name))
  let next = 0
  const files = photos.map((blob) => {
    while (taken.has(frameFileName(name, next))) next++
    const file = new File([blob], frameFileName(name, next), { type: blob.type || 'image/jpeg' })
    taken.add(file.name)
    next++
    return file
  })
  st.addTrainImages(files.map(mediaRefFrom))
}
