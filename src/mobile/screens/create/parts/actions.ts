/**
 * What the buttons of Create do, apart from drawing. One place, so K1, the
 * result sheet, the viewer and the gallery do the same thing for the same
 * button.
 */
import { useCreateStore, type CreateIntent, type GalleryItem, type ImageRef } from '../../../../stores/createStore'
import { MAX_BATCH_IMAGES } from '../../../../lib/batch-edit'
import { galleryLabelShort } from '../../../../lib/render/gallery-label'
import { mediaRefFrom } from '../../../../components/create/experimental/mediaRef'
import { haptic } from '../../../platform/haptics'
import { copyText } from '../../../platform/clipboard'
import { toast } from '../../../ui'
import { CREATE_STRINGS as T } from '../../../strings/create'
import { ImageLoadError, loadPhoneImage, loadPhoneImageFromBlob } from './photos'
import { saveItem, shareItem, type OutResult } from './media-out'
import { fetchItemBlob, ResultGoneError } from './adapters/result-url'
import { checkFile, type MediaKind } from './files'
import { applyStyleText, type PromptStyle } from './styles'
import { aspectSize } from './params'
import { nav } from '../../../nav'
import { imageBaseLong } from './catalog'
import { toolFacts, toolNeedsMask, toolTakesPhoto, type ToolId } from './tools'
import type { PickPurpose } from './pick'

const store = () => useCreateStore.getState()

/** Switch the tool. A source that the new tool can use stays (the store decides). */
export function setTool(tool: ToolId): void {
  const st = store()
  if (st.intent() === tool) return
  st.setIntent(tool)
  if (tool === 'character') {
    // Opening the tool lands on "use" when a character is picked, else on the shelf.
    useCreateStore.getState().setCharacterTab('use')
  }
}

/** The sentence for a file that cannot be used. */
export function fileProblemText(err: unknown, kind: MediaKind = 'image'): string {
  if (err instanceof ImageLoadError) {
    const p = err.problem
    if (p.kind === 'too-large') return T.file.tooLarge(p.sizeMb, p.limitMb)
    if (p.kind === 'wrong-kind') return T.file.wrongKind[p.wanted]
    if (p.kind === 'empty') return T.file.empty
    // A HEIC photo first: that has its own way out. Then a very large file, where memory is the likely cause.
    return p.heic ? T.file.heic : p.heavy ? T.file.tooHeavy : T.file.undecodable
  }
  return kind === 'image' ? T.file.undecodable : T.file.wrongKind[kind]
}

/** Make `ref` the source image. A tool without a source becomes Edit. */
export function takeImageAsSource(ref: ImageRef, tool?: ToolId): void {
  const st = store()
  const want = tool ?? (toolTakesPhoto(st.intent()) ? st.intent() : 'edit')
  if (st.intent() !== want) st.setIntent(want)
  // 3D: a photo is the way "From image". Words and a video have no photo of their own.
  if (want === '3d' && store().threeDWay !== 'image') store().setThreeDWay('image')
  const now = store()
  if (now.batchSources.length) now.setBatchSources([])
  now.setMask(null)
  now.setSource(ref)
}

export type AddResult = { ok: true; batch: number; leftOut: number; skipped: number } | { ok: false; message: string }

/**
 * Picked photos become the source. Several photos start a batch where the
 * tool can run one: the first is shown, all of them wait in the list.
 */
export async function addSourceFiles(files: readonly File[]): Promise<AddResult> {
  if (files.length === 0) return { ok: false, message: '' }
  const st = store()
  const intent = st.intent()
  const target: ToolId = toolTakesPhoto(intent) ? intent : 'edit'
  const usable = files.filter((f) => checkFile(f, 'image') === null)
  const skipped = files.length - usable.length
  if (usable.length === 0) {
    try {
      await loadPhoneImage(files[0])
    } catch (err) {
      return { ok: false, message: fileProblemText(err) }
    }
    return { ok: false, message: T.file.undecodable }
  }
  let first: ImageRef
  try {
    first = await loadPhoneImage(usable[0])
  } catch (err) {
    return { ok: false, message: fileProblemText(err) }
  }
  takeImageAsSource(first, target)
  if (usable.length < 2 || !toolFacts(target).batch) return { ok: true, batch: 0, leftOut: 0, skipped }
  const taken = usable.slice(0, MAX_BATCH_IMAGES)
  store().setBatchSources(taken.map((f) => mediaRefFrom(f)))
  return { ok: true, batch: taken.length, leftOut: usable.length - taken.length, skipped }
}

/** A result of the gallery as the source of `tool`. Fetches the bytes, so it can fail. */
export async function takeItemAsSource(item: GalleryItem, tool: ToolId): Promise<boolean> {
  try {
    const blob = await fetchItemBlob(item)
    const ref = await loadPhoneImageFromBlob(blob, `${item.id}.png`)
    takeImageAsSource(ref, tool)
    return true
  } catch (err) {
    toast(err instanceof ResultGoneError ? T.result.gone : err instanceof ImageLoadError ? fileProblemText(err) : T.result.gone, { tone: 'error', testid: 'create-source-failed' })
    return false
  }
}

/** A clip of the gallery as the clip to extend. */
export function takeItemAsExtend(item: GalleryItem): boolean {
  if (!item.jobId || !item.remoteUrl) return false
  const st = store()
  if (st.intent() !== 'extend') st.setIntent('extend')
  store().setExtendSource({ jobId: item.jobId, url: item.remoteUrl, label: galleryLabelShort(item, 40) })
  return true
}

/** A sound of the gallery as the voice of a talking character. */
export function takeItemAsVoice(item: GalleryItem): boolean {
  if (!item.jobId) return false
  const st = store()
  if (st.intent() !== 'lipsync') st.setIntent('lipsync')
  store().setVoiceFromJob({ jobId: item.jobId, label: galleryLabelShort(item, 40) })
  return true
}

function sayOut(result: OutResult, saving: boolean): void {
  switch (result.status) {
    case 'saved':
      haptic('success')
      toast(T.saved[result.target], { testid: 'create-saved' })
      return
    case 'shared':
      toast(T.shared, { testid: 'create-shared' })
      return
    case 'cancelled':
      return
    case 'expired':
      toast(T.saveExpired, { tone: 'error', testid: 'create-save-expired' })
      return
    case 'storage':
      toast(T.saveStorage, { tone: 'error', testid: 'create-save-storage' })
      return
    case 'denied':
      toast(T.saveDenied, { tone: 'error', testid: 'create-save-denied' })
      return
    case 'unavailable':
      toast(saving ? T.saveUnavailable : T.shareUnavailable, { tone: 'error', testid: 'create-save-unavailable' })
      return
    default:
      toast(saving ? T.saveFailed : T.shareFailed, { tone: 'error', testid: 'create-save-failed' })
  }
}

export async function saveWithToast(item: GalleryItem): Promise<OutResult> {
  const result = await saveItem(item)
  sayOut(result, true)
  return result
}

export async function shareWithToast(item: GalleryItem): Promise<OutResult> {
  const result = await shareItem(item, galleryLabelShort(item, 60))
  sayOut(result, false)
  return result
}

export async function copyWithToast(text: string): Promise<void> {
  const ok = await copyText(text)
  toast(ok ? T.copied : T.copyFailed, { tone: ok ? 'default' : 'error', testid: 'create-copied' })
}

export function deleteItems(ids: readonly string[]): void {
  const st = store()
  for (const id of ids) st.removeFromGallery(id)
}

/** Apply a prompt style: its tool, its text and the values the current model can take. */
export function applyStyle(style: PromptStyle): void {
  const st = store()
  if (st.intent() !== style.tool) st.setIntent(style.tool as CreateIntent)
  const now = store()
  now.setPrompt(applyStyleText(now.prompt, style.text))
  if (style.tool === 'image') {
    if (style.quality) now.setImageQuality(style.quality)
    if (style.aspect) {
      const size = aspectSize(style.aspect, imageBaseLong())
      now.setSize(size.w, size.h)
    }
  }
  if (style.tool === 'video' && style.seconds) {
    now.setCloudFrames(style.seconds * 16)
    now.setCloudFps(16)
  }
}

/** Whether a painted area is needed right now, read from the store (for places without the facts hook). */
export function maskNeededNow(maskless: boolean): boolean {
  return toolNeedsMask(store().intent(), maskless)
}

/** Open the gallery as a picker for a source image, a clip to extend or a voice. */
export function openGalleryPicker(purpose: PickPurpose): void {
  nav.push('/create/gallery/pick/:purpose', { purpose })
}
