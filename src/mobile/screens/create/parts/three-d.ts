/**
 * 3D on the phone (3.1.0, cloud only). What the picked model takes, the
 * detail step, and the still frames of a video.
 *
 * The video never leaves the phone. LU reads still frames of it here; the
 * picked moments in order become the source (the "Front") and the further
 * sides of the create store, and from there "From video" runs exactly like
 * "From image". Built after the desktop row (ThreeDControls.tsx), not taken
 * from it.
 */
import { create } from 'zustand'
import { useCreateStore, type ImageRef, type ThreeDDetail, type ThreeDWay } from '../../../../stores/createStore'
import { cloudDetailOf, threeDControlFacts, threeDDetailField } from '../../../../lib/three/three-d-models'
import { framesAcrossVideo } from '../../../../lib/video-frames'
import { checkFileAgainst } from '../../../../lib/media-file'
import { loadPhoneImageFromBlob } from './photos'

/** How many moments of a video are offered to pick from. */
export const FRAME_CHOICES = 8

export const DETAILS: readonly ThreeDDetail[] = ['draft', 'standard', 'fine']

export interface ThreeDModelFacts {
  /** How many pictures the model takes: 1, or up to 4 sides. */
  maxViews: number
  /** The model has a detail step. */
  hasDetail: boolean
}

/** What the cloud model `studioId` takes. A model the registry does not know takes one picture and no step. */
export function threeDModelFacts(studioId: string | undefined): ThreeDModelFacts {
  const f = threeDControlFacts('cloud', studioId)
  return { maxViews: f.maxViews, hasDetail: f.hasDetail }
}

/** `want` indices spread evenly over `n` frames: 0, 2, 4, 5 of eight. Same rule as the desktop. */
export function evenPick(n: number, want: number): number[] {
  if (n <= 0) return []
  const k = Math.min(want, n)
  if (k === 1) return [Math.floor((n - 1) / 2)]
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / k))
}

/**
 * A tap on moment `i`. One picture: it becomes the one. Several: a picked
 * moment goes (never the last one), a new one comes in and pushes out the
 * oldest when the strip is full. Always in the order of the video.
 */
export function togglePick(picked: readonly number[], i: number, want: number): number[] {
  if (want <= 1) return [i]
  if (picked.includes(i)) return picked.length > 1 ? picked.filter((k) => k !== i) : [...picked]
  return (picked.length >= want ? [...picked.slice(1), i] : [...picked, i]).sort((a, b) => a - b)
}

/** The step a cloud model stands on now. */
export function shownDetail(studioId: string | undefined, options: Record<string, unknown>, stored: ThreeDDetail): ThreeDDetail {
  const field = threeDDetailField(studioId)
  return field ? cloudDetailOf(field, options[field.field], studioId) : stored
}

/** Pick a step: in the cloud the step is the model's own field, written where the price and the booking read it. */
export function pickDetail(studioId: string | undefined, d: ThreeDDetail): void {
  const st = useCreateStore.getState()
  st.setThreeDDetail(d)
  const field = threeDDetailField(studioId)
  if (field) st.setCloudStudioOptions({ ...st.cloudStudioOptions, [field.field]: field.values[d] })
}

/** Switch the way. A video read before comes back with its picks. */
export function pickWay(way: ThreeDWay, maxViews: number): void {
  const st = useCreateStore.getState()
  if (st.threeDWay === way) return
  st.setThreeDWay(way)
  if (way === 'video' && useThreeDVideo.getState().frames.length > 0) applyPicks(maxViews)
}

// ---------- the video ----------

export interface ThreeDVideo {
  /** File name of the video, null before one was picked. */
  name: string | null
  frames: ImageRef[]
  picked: number[]
  reading: boolean
}

const EMPTY: ThreeDVideo = { name: null, frames: [], picked: [], reading: false }

export const useThreeDVideo = create<ThreeDVideo>()(() => ({ ...EMPTY }))

/** Write the picked moments to the create store: the first is the source, the others the further sides. */
export function applyPicks(maxViews: number): void {
  const { frames, picked } = useThreeDVideo.getState()
  if (!frames.length) return
  const want = Math.max(1, Math.min(4, maxViews))
  const chosen = picked.map((i) => frames[i]).filter((f): f is ImageRef => !!f).slice(0, want)
  const st = useCreateStore.getState()
  st.setSource(chosen[0] ?? null)
  st.setThreeDViews(chosen.slice(1))
}

/** The user tapped moment `i`. */
export function tapFrame(i: number, maxViews: number): void {
  const want = Math.max(1, Math.min(4, maxViews))
  useThreeDVideo.setState((s) => ({ picked: togglePick(s.picked, i, want) }))
  applyPicks(maxViews)
}

/** The picked model changed: it may take more or fewer pictures now. */
export function fitPicks(maxViews: number): void {
  const { frames, picked } = useThreeDVideo.getState()
  if (!frames.length) return
  const want = Math.max(1, Math.min(4, maxViews))
  if (picked.length !== Math.min(want, frames.length)) useThreeDVideo.setState({ picked: evenPick(frames.length, want) })
  applyPicks(maxViews)
}

/** Forget the video and its frames. */
export function clearVideo(): void {
  useThreeDVideo.setState({ ...EMPTY })
  const st = useCreateStore.getState()
  st.setSource(null)
  st.setThreeDViews([])
}

export type ReadVideoResult = { ok: true } | { ok: false; reason: 'empty' | 'wrong-kind' | 'unreadable' }

/**
 * Read still frames of `file`. The bytes stay in this phone's memory: an
 * address of its own is made for the reading and dropped right after. No
 * upload limit applies, because the video itself is never uploaded.
 */
export async function readVideoFrames(file: File, maxViews: number): Promise<ReadVideoResult> {
  const bad = checkFileAgainst(file, 'video', Number.POSITIVE_INFINITY)
  if (bad) return { ok: false, reason: bad.kind === 'empty' ? 'empty' : bad.kind === 'wrong-kind' ? 'wrong-kind' : 'unreadable' }
  const st = useCreateStore.getState()
  if (st.intent() !== '3d') st.setIntent('3d')
  if (useCreateStore.getState().threeDWay !== 'video') useCreateStore.getState().setThreeDWay('video')
  useThreeDVideo.setState({ reading: true, name: file.name })
  const url = URL.createObjectURL(file)
  try {
    const blobs = await framesAcrossVideo(url, FRAME_CHOICES)
    const base = file.name.replace(/\.[^.]+$/, '') || 'video'
    const frames: ImageRef[] = []
    for (const [i, b] of blobs.entries()) frames.push(await loadPhoneImageFromBlob(b, `${base}-frame-${i + 1}.jpg`))
    if (!frames.length) throw new Error('no frames')
    const want = Math.max(1, Math.min(4, maxViews))
    useThreeDVideo.setState({ frames, picked: evenPick(frames.length, want), reading: false })
    applyPicks(maxViews)
    return { ok: true }
  } catch {
    useThreeDVideo.setState({ ...EMPTY })
    return { ok: false, reason: 'unreadable' }
  } finally {
    URL.revokeObjectURL(url)
  }
}
