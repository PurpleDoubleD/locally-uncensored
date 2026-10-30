// B38 and B45 (Discord 29.10. and 30.10.2026): the end image of Animate and
// the reference images of the Image tab. Each one shows where the model on
// screen reads it, and where it does not, a line says so and which models do
// (lib/frame-refs). An image kept from an earlier model stays on screen,
// marked "not sent", the way the Edit references do.
import { useRef, useState } from 'react'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { classifyModel } from '../../../api/comfyui'
import { isMlxImageHost } from '../../../api/mlx-image'
import {
  CREATE_REFERENCE_MODELS, LOCAL_END_FRAME_MODELS, createReferenceLine, createReferenceSupport,
  laneVideoModel, localEndFrame, type CreateReferenceKind,
} from '../../../lib/frame-refs'
import { studioPickFor, studioReadsEndImage } from '../../../lib/render/create-studio'
import { laneImageModel } from '../../../lib/image-engines'
import { imageRefWords, withImageRef } from '../../../lib/image-ref-names'
import { loadImageRef } from './loadImage'
import { GALLERY_DRAG_TYPE, fetchGalleryItemBlob } from './galleryUrl'
import { cn } from '../ui/cn'

const TILE = 'w-16 h-16 rounded-lg shrink-0'

/** The cloud line where the Studio model on Animate starts from one image. */
// The Animate picker of LU Cloud lists the server catalogue's video models,
// and the render worker hands an end image only to Studio models (Mac run,
// 30.10.2026). So in the cloud this line is what Animate shows today.
export const CLOUD_END_FRAME_MODELS = 'The LU Cloud video models here start from one image. An end image works on your own ComfyUI with Wan 2.2 14B i2v, Wan 2.1 FLF2V and MiniMax H3.'

/** Does the Animate model on screen take an end image? */
export function useEndImageSupport(): { supported: boolean; hint: string } {
  const backend = useCreateStore((s) => s.backend)
  const cloudModel = useCreateStore((s) => studioPickFor('animate', s))
  const localModel = useCreateStore((s) => laneVideoModel(s.videoModelList, s.videoModel, 'animate'))
  if (backend === 'cloud') {
    return studioReadsEndImage(cloudModel) ? { supported: true, hint: '' } : { supported: false, hint: CLOUD_END_FRAME_MODELS }
  }
  // The Mac's own video engine takes one start image.
  if (isMlxImageHost()) return { supported: false, hint: `The video engine of this Mac starts from one image. ${LOCAL_END_FRAME_MODELS}` }
  return localEndFrame(localModel) ? { supported: true, hint: '' } : { supported: false, hint: LOCAL_END_FRAME_MODELS }
}

async function fileFromDrop(e: React.DragEvent, gallery: ReturnType<typeof useCreateStore.getState>['gallery']): Promise<File | null> {
  const file = e.dataTransfer.files[0]
  if (file) return file
  const item = gallery.find((g) => g.id === e.dataTransfer.getData(GALLERY_DRAG_TYPE))
  if (!item) return null
  const blob = await fetchGalleryItemBlob(item)
  return new File([blob], item.filename || 'image.png', { type: blob.type || 'image/png' })
}

/** Animate: the picture the clip ends on, beside the start image. */
export function EndImageSlot() {
  const intent = useCreateStore((s) => s.intent())
  const endImage = useCreateStore((s) => s.endImage)
  const setEndImage = useCreateStore((s) => s.setEndImage)
  const setError = useCreateStore((s) => s.setError)
  const gallery = useCreateStore((s) => s.gallery)
  const { supported, hint } = useEndImageSupport()
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)
  if (intent !== 'animate') return null

  const take = async (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('That file type is not supported. Use PNG, JPG or WebP.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      setEndImage(await loadImageRef(file))
    } catch (err) {
      setError(`Could not load the image: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  if (!supported && !endImage) {
    return <p className="mt-3 t-micro leading-snug text-gray-500 text-center max-w-md mx-auto text-balance" data-testid="end-image-unsupported">{hint}</p>
  }
  return (
    <div className="mt-3 flex flex-col items-center gap-1.5" data-testid="end-image-slot">
      <div
        className="flex items-center gap-2"
        onDragOver={(e) => { if (supported) e.preventDefault() }}
        onDrop={(e) => { e.preventDefault(); if (supported && !loading) void fileFromDrop(e, gallery).then(take) }}
      >
        {endImage ? (
          <div className={cn(TILE, 'relative')} data-not-sent={supported ? undefined : 'true'}>
            <img src={endImage.url} alt="end image" className={cn(TILE, 'object-cover border border-white/[0.06]', !supported && 'opacity-40')} />
            <span className="lu-on-dark absolute bottom-1 left-1 t-micro text-gray-200 bg-black/60 px-1 rounded">{supported ? 'End' : 'not sent'}</span>
            <button
              onClick={() => setEndImage(null)}
              className="lu-on-dark absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-md bg-black/60 text-gray-300 hover:text-white"
              title="Remove the end image"
              aria-label="Remove the end image"
            >
              <X size={11} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={loading}
            className={cn(TILE, 'border-2 border-dashed border-white/10 hover:border-white/25 text-gray-500 hover:text-gray-300 flex flex-col items-center justify-center gap-0.5 transition-colors')}
            title="Add the picture the clip should end on"
            data-testid="end-image-add"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
            <span className="t-micro">End image</span>
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void take(e.target.files?.[0] ?? null); e.target.value = '' }} />
      </div>
      <p className="t-micro leading-snug text-gray-500 text-center max-w-md text-balance" data-testid="end-image-line">
        {supported
          ? endImage ? 'The clip starts on the image above and ends on this one.' : 'Optional: add the picture the clip should end on.'
          : `${hint} The end image here is not sent.`}
      </p>
    </div>
  )
}

/** What the Image tab's model does with reference images, and how many. */
export function useImageReferenceSupport(): { slots: number; kind?: CreateReferenceKind; hint: string } {
  const backend = useCreateStore((s) => s.backend)
  const model = useCreateStore((s) => laneImageModel(s.imageModelList, s.imageModel, 'image'))
  const listedType = useCreateStore((s) => s.imageModelList.find((m) => m.name === laneImageModel(s.imageModelList, s.imageModel, 'image'))?.type)
  if (backend === 'cloud') {
    return { slots: 0, hint: 'The LU Cloud image models make the picture from the prompt alone. To work from your own image, use Edit. Reference images work on your own ComfyUI with Krea 2, Qwen-Image 2.1 and FLUX.2.' }
  }
  // The Mac's own image engine runs prompt to picture only.
  if (isMlxImageHost()) return { slots: 0, hint: 'The image engine of this Mac makes the picture from the prompt alone. Reference images work through ComfyUI with Krea 2, Qwen-Image 2.1 and FLUX.2.' }
  const support = createReferenceSupport(listedType ?? classifyModel(model), model)
  return support.slots > 0 ? { ...support, hint: '' } : { slots: 0, hint: CREATE_REFERENCE_MODELS }
}

/** Image tab: reference images for style, pose and camera angle (B45). */
export function ImageReferenceStrip() {
  const refs = useCreateStore((s) => s.imageReferences)
  const add = useCreateStore((s) => s.addImageReference)
  const remove = useCreateStore((s) => s.removeImageReference)
  const setError = useCreateStore((s) => s.setError)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const gallery = useCreateStore((s) => s.gallery)
  const { slots, kind, hint } = useImageReferenceSupport()
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const takeFiles = async (files: File[]) => {
    let room = slots - refs.length
    setLoading(true)
    setError(null)
    try {
      for (const file of files) {
        if (room <= 0) break
        if (!file.type.startsWith('image/')) { setError('That file type is not supported. Use PNG, JPG or WebP.'); continue }
        add(await loadImageRef(file))
        room--
      }
    } catch (err) {
      setError(`Could not load the image: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  if (slots === 0 && refs.length === 0) {
    // One quiet line, opened on demand: the empty Image tab is not crowded
    // with a sentence about a feature most of its models do not have.
    return (
      <div className="mt-2 flex flex-col items-center" data-testid="image-references-unsupported">
        <button type="button" onClick={() => setOpen((o) => !o)} className="t-micro text-gray-500 hover:text-gray-300 underline underline-offset-2">
          Reference images?
        </button>
        {open && <p className="mt-1 t-micro leading-snug text-gray-500 text-center max-w-md text-balance">{hint}</p>}
      </div>
    )
  }
  const canAdd = refs.length < slots
  return (
    <div className="mt-3 flex flex-col items-center gap-2" data-testid="image-references">
      <div
        className="flex flex-wrap justify-center items-center gap-2 rounded-xl p-1 max-w-md"
        onDragOver={(e) => { if (canAdd) e.preventDefault() }}
        onDrop={(e) => {
          e.preventDefault()
          if (!canAdd || loading) return
          if (e.dataTransfer.files.length) { void takeFiles(Array.from(e.dataTransfer.files)); return }
          void fileFromDrop(e, gallery).then((f) => (f ? takeFiles([f]) : undefined))
        }}
      >
        {refs.map((ref, i) => {
          const sent = i < slots
          return (
            <div key={`${ref.url.slice(-24)}-${i}`} className={cn(TILE, 'relative')} data-not-sent={sent ? undefined : 'true'}>
              <img src={ref.url} alt={imageRefWords(i + 1)} className={cn(TILE, 'object-cover border border-white/[0.06]', !sent && 'opacity-40')} />
              {sent && kind !== 'style' ? (
                <button
                  type="button"
                  onClick={() => setPrompt(withImageRef(useCreateStore.getState().prompt, i + 1))}
                  className="lu-on-dark absolute bottom-1 left-1 t-micro text-gray-200 bg-black/60 hover:bg-black/80 hover:text-white px-1 rounded"
                  title={`Refer to it as ${imageRefWords(i + 1)} in your prompt. Click to add it.`}
                >
                  Image {i + 1}
                </button>
              ) : !sent ? (
                <span className="lu-on-dark absolute bottom-1 left-1 t-micro text-gray-300 bg-black/70 px-1 rounded">not sent</span>
              ) : null}
              <button
                onClick={() => remove(i)}
                className="lu-on-dark absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-md bg-black/60 text-gray-300 hover:text-white"
                title={`Remove reference ${i + 1}`}
                aria-label={`Remove reference ${i + 1}`}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
        {canAdd && (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={loading}
            className={cn(TILE, 'border-2 border-dashed border-white/10 hover:border-white/25 text-gray-500 hover:text-gray-300 flex flex-col items-center justify-center gap-0.5 transition-colors')}
            title="Add a reference image"
            data-testid="image-reference-add"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
            <span className="t-micro">Reference</span>
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void takeFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      </div>
      <p className="t-micro leading-snug text-gray-500 text-center max-w-md text-balance" data-testid="image-references-line">
        {slots === 0 ? `${hint} The images here are not sent.` : createReferenceLine(kind, Math.min(refs.length, slots))}
      </p>
    </div>
  )
}
