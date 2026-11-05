// How many further photos the model on screen reads besides the source image.
// 0 hides the reference strip. One reader for the strip and for the saved
// characters that load into it.
import { useEffect, useState } from 'react'
import { useCreateStore } from '../../../stores/createStore'
import { classifyModel } from '../../../api/comfyui'
import { qwenEditResolution } from '../../../api/dynamic-workflow'
import { extraReferenceSlots } from '../../../lib/edit-references'
import { getSharedMemoryGb } from '../../../lib/hardware'
import { laneImageModel } from '../../../lib/image-engines'
import { macEditReferenceRoom } from '../../../lib/mac-edit-memory'
import { referenceModel, studioExtraPhotoSlots } from '../../../lib/render/create-studio'
import { isMlxImageHost } from '../../../api/mlx-image'
import { laneVideoModel, localAnimateReferenceSlots } from '../../../lib/frame-refs'

export function useReferenceSlots(): number {
  const backend = useCreateStore((s) => s.backend)
  const intent = useCreateStore((s) => s.intent())
  // The model the tab runs: on the Mac, Edit lists the models that take an
  // image, and a pick that cannot is not the one that runs. A ComfyUI list
  // leaves the stored pick as it is.
  const imageModel = useCreateStore((s) => laneImageModel(s.imageModelList, s.imageModel, s.intent()))
  const listedType = useCreateStore((s) => s.imageModelList.find((m) => m.name === laneImageModel(s.imageModelList, s.imageModel, s.intent()))?.type)
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const localAnimateModel = useCreateStore((s) => laneVideoModel(s.videoModelList, s.videoModel, 'animate'))
  // The type from the fetched list carries the header sniff; the name is the
  // fallback, exactly as useCreate decides the pipeline.
  if (backend === 'cloud') {
    const pick = referenceModel(intent, { cloudImageModel, cloudVideoModel, cloudOpModel })
    return pick ? studioExtraPhotoSlots(pick) : 0
  }
  return intent === 'edit' ? extraReferenceSlots(listedType ?? classifyModel(imageModel), imageModel)
    // B38: a local reference video model that reads several pictures (MiniMax
    // H3 ref2va). The Mac's own video engine reads one.
    : intent === 'animate' && !isMlxImageHost() ? localAnimateReferenceSlots(localAnimateModel)
    : 0
}

/** The memory of this Mac, read once for every strip. */
let macMemory: Promise<number> | null = null
function readMacMemory(): Promise<number> {
  // Asynchronous from the first step on, so a reader that is not there never
  // throws into a render.
  macMemory ??= Promise.resolve().then(() => getSharedMemoryGb()).catch(() => 0)
  return macMemory
}

/**
 * On the Mac's own engine: how many further images this Mac's memory takes at
 * the canvas set in Create (lib/mac-edit-memory), with the memory read. Null
 * room everywhere else (Windows, Linux, the cloud) and while the memory is
 * not known, so nothing changes there.
 */
export function useMacEditReferenceRoom(): { room: number | null; memoryGb: number | null } {
  const backend = useCreateStore((s) => s.backend)
  const intent = useCreateStore((s) => s.intent())
  // Only the Mac's catalogue rows carry `editImages` (lib/image-engines).
  const lane = useCreateStore((s) => s.imageModelList.find((m) => m.name === laneImageModel(s.imageModelList, s.imageModel, s.intent())))
  const width = useCreateStore((s) => s.width)
  const height = useCreateStore((s) => s.height)
  const mac = backend === 'local' && intent === 'edit' && (lane?.editImages ?? 0) > 0
  const [memoryGb, setMemoryGb] = useState<number | null>(null)
  useEffect(() => {
    if (!mac) return
    let stale = false
    void readMacMemory().then((gb) => { if (!stale && gb > 0) setMemoryGb(gb) })
    return () => { stale = true }
  }, [mac])
  if (!mac || memoryGb === null) return { room: null, memoryGb: null }
  return { room: macEditReferenceRoom(qwenEditResolution(width, height), lane?.packGb ?? 0, memoryGb), memoryGb }
}

/** For tests: forget the memory read. */
export function forgetMacMemoryForTests(): void {
  macMemory = null
}
