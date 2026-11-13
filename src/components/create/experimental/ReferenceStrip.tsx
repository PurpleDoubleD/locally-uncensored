// The reference strip under the Edit source (GH #144, Discord and
// A user, 2026-09-23 to 09-27): Edit took one image, so "put the person from
// this photo into that scene" could not be asked. Layout picked by the owner on
// 2026-10-01: the source stays large, the further images sit as small tiles
// below it with a "+ Reference" tile, and the prompt names them image 2,
// image 3. Up to nine tiles (3.0.8, Discord D7), so the row wraps. Shown for a local model that takes more than one image, and (02.10.2026,
// figure from photos without training) in the cloud for the Studio models that
// read a list of images: the multi-image editors and the reference-to-video
// models. The photos go to the user's own storage at the start, never as a URL.
// On a Mac (15.10.2026) the strip offers only as many slots as the Mac's
// memory takes at the canvas set in Create (lib/mac-edit-memory), the same
// estimate the engine refuses a run by. Images already in the strip past that
// stay and are marked not sent. Through ComfyUI (18.10.2026) the line under
// the strip follows what the graphics card carries (lib/comfy-edit-memory).
import { useRef, useState } from 'react'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { useMacEditReferenceRoom, useReferenceSlots } from './referenceSlots'
import { MANY_REFERENCES, MANY_REFERENCES_LINE, referenceNames } from '../../../lib/edit-references'
import { SOURCE_IS_IMAGE_1, imageRefWords, withImageRef } from '../../../lib/image-ref-names'
import { laneImageModel } from '../../../lib/image-engines'
import { macEditNoRoomLine, macEditOverRoomLine } from '../../../lib/mac-edit-memory'
import { comfyEditFullImages, qwenEditPlusOverCard } from '../../../lib/comfy-edit-memory'
import { useGraphicsCardGb } from '../../../hooks/useGraphicsMemory'
import { SavedCharacterChips } from './SavedCharacters'
import { TrainedCharacterChips } from './TrainedCharacterChips'
import { loadPhotosAsReferences } from './characterPhotos'
import { loadImageRef } from './loadImage'
import { GALLERY_DRAG_TYPE, fetchGalleryItemBlob } from './galleryUrl'
import { cn } from '../ui/cn'

const TILE = 'w-16 h-16 rounded-lg shrink-0'

export function ReferenceStrip() {
  const references = useCreateStore((s) => s.references)
  const addReference = useCreateStore((s) => s.addReference)
  const removeReference = useCreateStore((s) => s.removeReference)
  const setError = useCreateStore((s) => s.setError)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const gallery = useCreateStore((s) => s.gallery)
  const backend = useCreateStore((s) => s.backend)
  const intent = useCreateStore((s) => s.intent())
  // The Mac's own engine: only its catalogue rows carry `editImages`
  // (lib/image-engines), a ComfyUI list never does.
  const macEngine = useCreateStore((s) => s.imageModelList.find((m) => m.name === laneImageModel(s.imageModelList, s.imageModel, s.intent()))?.editImages !== undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)
  const [drag, setDrag] = useState(false)

  const cloud = backend === 'cloud'
  const modelSlots = useReferenceSlots()
  const { room, memoryGb } = useMacEditReferenceRoom()
  const cardGb = useGraphicsCardGb()
  if (modelSlots === 0) return null
  // The images the store keeps for this model stay on screen; on a Mac only
  // as many as its memory takes are sent (useCreate cuts at the same number).
  const shown = references.slice(0, modelSlots)
  const slots = room === null ? modelSlots : Math.min(modelSlots, room)
  const memoryLimited = room !== null && room < modelSlots
  const overRoom = memoryLimited && shown.length > slots
  const canAdd = shown.length < slots
  // Not a single further image fits: a quiet line instead of the slots.
  if (slots === 0 && shown.length === 0) {
    return (
      <p className="mt-3 t-label text-gray-600 text-center max-w-md mx-auto text-balance" data-testid="reference-strip-no-room">
        {macEditNoRoomLine(memoryGb ?? 0)}
      </p>
    )
  }
  // Past what the graphics card carries at full size (four images, fewer on
  // a card under 24 GB), ComfyUI scales every one of them smaller and the
  // result follows the first (referenceSide in lib/edit-references). The
  // Mac's own engine keeps its canvas, only the images shrink there, so it
  // says nothing. Qwen-Image-Edit (two slots) cannot shrink them: past the
  // card it is refused at Create, and the strip says so first.
  // Only an edit shrinks its images; a reference video model (MiniMax H3
  // ref2va, B38) scales its references itself.
  const comfyLane = !cloud && !macEngine && intent === 'edit'
  const shrinks = comfyLane && slots > 2 && 1 + shown.length > comfyEditFullImages(cardGb)
  const overCard = comfyLane && slots === 2 ? qwenEditPlusOverCard(1 + Math.min(shown.length, slots), cardGb) : null

  const add = async (load: () => Promise<File>) => {
    setLoading(true)
    setError(null)
    try {
      addReference(await loadImageRef(await load()))
    } catch (err) {
      setError(`Could not load the image: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  // Mehrere Dateien auf einmal, soweit Platz ist (die Cloud-Modelle lesen bis zu
  // vier weitere Fotos, Qwen-Image 2.1 lokal bis zu neun). Jede Datei geht durch dieselbe Pruefung wie eine einzelne.
  const addFiles = async (files: File[]) => {
    let room = slots - shown.length
    for (const file of files) {
      if (room <= 0) break
      if (!file.type.startsWith('image/')) {
        setError('That file type is not supported. Use PNG, JPG or WebP.')
        continue
      }
      await add(async () => file)
      room--
    }
  }

  return (
    <div className="mt-3 flex flex-col items-center gap-2" data-testid="reference-strip">
      <div
        className={cn('flex flex-wrap justify-center items-center gap-2 rounded-xl p-1 max-w-md transition-colors', drag && 'bg-blue-500/10')}
        onDragOver={(e) => { if (canAdd) { e.preventDefault(); setDrag(true) } }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          if (!canAdd || loading) return
          if (e.dataTransfer.files.length) { void addFiles(Array.from(e.dataTransfer.files)); return }
          const item = gallery.find((g) => g.id === e.dataTransfer.getData(GALLERY_DRAG_TYPE))
          if (item) {
            void add(async () => {
              const blob = await fetchGalleryItemBlob(item)
              return new File([blob], item.filename || 'reference.png', { type: blob.type || 'image/png' })
            })
          }
        }}
      >
        {shown.map((ref, i) => (
          <div key={`${ref.url.slice(-24)}-${i}`} className={cn(TILE, 'relative')} data-not-sent={i >= slots ? 'true' : undefined}>
            <img
              src={ref.url}
              alt={imageRefWords(i + 2)}
              className={cn(TILE, 'object-cover border border-white/[0.06]', i >= slots && 'opacity-40')}
            />
            {i >= slots
              ? <span className="lu-on-dark absolute bottom-1 left-1 t-micro text-gray-300 bg-black/70 px-1 rounded" title="This Mac's memory does not take this image at this size">not sent</span>
              : (
                // The name the prompt uses, on the tile itself (Discord help-18,
                // 23.10.2026: "should i just put image 2, or IMAGE 2.?"). A click
                // adds it to the prompt; any spelling reaches the model the
                // way its encoder names the image (lib/image-ref-names).
                <button
                  type="button"
                  onClick={() => setPrompt(withImageRef(useCreateStore.getState().prompt, i + 2))}
                  className="lu-on-dark absolute bottom-1 left-1 t-micro text-gray-200 bg-black/60 hover:bg-black/80 hover:text-white px-1 rounded"
                  title={`Refer to it as ${imageRefWords(i + 2)} in your prompt. Click to add it.`}
                  aria-label={`Add ${imageRefWords(i + 2)} to the prompt`}
                >
                  Image {i + 2}
                </button>
              )}
            <button
              onClick={() => removeReference(i)}
              className="lu-on-dark absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-md bg-black/60 text-gray-300 hover:text-white"
              title={`Remove ${cloud ? 'photo' : 'image'} ${i + 2}`}
              aria-label={`Remove ${cloud ? 'photo' : 'image'} ${i + 2}`}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        {canAdd && (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={loading}
            className={cn(TILE, 'border-2 border-dashed border-white/10 hover:border-white/25 text-gray-500 hover:text-gray-300 flex flex-col items-center justify-center gap-0.5 transition-colors')}
            title={cloud ? 'Add another photo of your character' : 'Add another image the edit can use'}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
            <span className="t-micro">{cloud ? 'Photo' : 'Reference'}</span>
          </button>
        )}
      </div>
      {/* Sentence case, not the uppercase of t-label: the line says how the
          prompt names the images, and in capitals it read as "IMAGE 2"
          (Discord help-18, 23.10.2026). */}
      <p className="t-micro leading-snug text-gray-500 text-center max-w-md text-balance" data-testid="reference-strip-names">
        {cloud
          ? `Add up to ${slots + 1} photos of your character.${intent === 'edit' && shown.length > 0 ? ` Name them in the prompt as ${referenceNames(shown.length)}. ${SOURCE_IS_IMAGE_1}` : ''}`
          : memoryLimited && slots === 0
            ? `${macEditNoRoomLine(memoryGb ?? 0)} The images here stay and are not sent.`
            : shown.length === 0
              ? `Add up to ${slots === 1 ? 'one more image' : `${slots} more images`}, for example a person or an outfit to bring into this one.${memoryLimited ? ' That is what the memory of this Mac takes at this size.' : ''}`
              : `Name them in the prompt as ${referenceNames(Math.min(shown.length, slots))}. ${SOURCE_IS_IMAGE_1}${Math.min(shown.length, slots) >= MANY_REFERENCES ? ` ${MANY_REFERENCES_LINE}` : ''}${shrinks ? ' With this many images the edit comes out smaller, so it fits in memory.' : ''}${overCard ? ` ${overCard}` : ''}${overRoom ? ` ${macEditOverRoomLine(slots, memoryGb ?? 0)}` : ''}`}
      </p>
      {/* A character saved from a video (lib/saved-characters) loads its photos
          here with one click: they join the strip, and the first becomes the
          source only when none is loaded. */}
      <SavedCharacterChips
        label="Saved characters"
        disabled={loading}
        title={(c) => `Load the photos of ${c.name}`}
        onPick={(c) => {
          setLoading(true)
          setError(null)
          void loadPhotosAsReferences(c.name, c.photos)
            .catch((err: unknown) => setError(`Could not load the photos: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => setLoading(false))
        }}
      />
      {/* A character trained on this machine brings the photos it was
          trained on, so the edit keeps its face. */}
      {!cloud && <TrainedCharacterChips slots={slots} disabled={loading} onBusy={setLoading} />}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void addFiles(files)
        }}
      />
    </div>
  )
}
