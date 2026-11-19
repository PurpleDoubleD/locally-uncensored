// Which local model a run will really use, read once for the picker and for
// the waiting area, so the two cannot disagree about the model on the card.
import { useCreateStore } from '../../../stores/createStore'
import { resolveLocalOpPick, videoLaneModels, type ClassifiedModel } from '../../../api/comfyui'
import { imageLaneModels } from '../../../lib/image-engines'
import { isMlxImageHost } from '../../../api/mlx-image'
import { mlxTalkingEntry } from '../../../api/mlx-video'
import { swapLocalModels } from '../../../lib/create/swap-local'

export interface LocalPick {
  isVideo: boolean
  /** The lane's own model family (Music, Lip sync, Motion), null on the regular lists. */
  laneList: ClassifiedModel[] | null
  /** The models this intent can run, in the store's order. */
  list: ClassifiedModel[]
  /** The model a run takes now. */
  value: string
}

export function useLocalPick(): LocalPick {
  const mode = useCreateStore((s) => s.mode)
  const intent = useCreateStore((s) => s.intent())
  const imageModel = useCreateStore((s) => s.imageModel)
  const videoModel = useCreateStore((s) => s.videoModel)
  const localOpModel = useCreateStore((s) => s.localOpModel)
  const imageModelList = useCreateStore((s) => s.imageModelList)
  const videoModelList = useCreateStore((s) => s.videoModelList)
  const audioModelList = useCreateStore((s) => s.audioModelList)
  const lipsyncModelList = useCreateStore((s) => s.lipsyncModelList)
  const motionModelList = useCreateStore((s) => s.motionModelList)

  const isVideo = mode === 'video'
  // A Mac has no lip sync models: its Talking Character runs on the video
  // models that talk (api/mlx-video mlxTalking).
  const macTalking = intent === 'lipsync' && isMlxImageHost()
  // The 2.5.8 lanes with their own local model families. Extend is NOT here:
  // it rides the regular i2v-capable video list (last-frame continue).
  const laneList =
    intent === 'music' ? audioModelList
    : macTalking ? videoModelList.filter((m) => m.mlxVideo?.talking)
    : intent === 'lipsync' ? lipsyncModelList
    : intent === 'motion' ? motionModelList
    // Swap on this computer (3.1.3): the Animate models of the motion list.
    : intent === 'swap_character' ? swapLocalModels(motionModelList)
    : null

  // Mirror the cloud picker's op-gating (2026-07-17: "only offer models
  // that can actually do it"): Animate/Extend list i2v-capable local models,
  // Video lists t2v-capable ones (SVD/FramePack are i2v-only and drop there).
  // Shared with Stage's missing-models gate so card and picker cannot drift.
  const rawList = isVideo ? videoModelList : imageModelList
  // The image list is narrowed only where it says itself which models edit
  // (the Mac's catalogue); a ComfyUI list comes back as it is.
  const list = laneList ?? (!isVideo ? imageLaneModels(rawList, intent) : videoLaneModels(rawList, intent))
  const stored = laneList ? localOpModel : (isVideo ? videoModel : imageModel)
  // Reflect the model the run will really use: a leftover pick the current
  // op can't perform must not show as "selected". Lanes share the submit-side
  // rule (resolveLocalOpPick) so chip, meter and run always agree.
  const value = macTalking
    ? (mlxTalkingEntry(list, stored)?.name ?? '')
    : laneList
    ? resolveLocalOpPick(stored, list)
    : list.some((m) => m.name === stored) ? stored : (list[0]?.name ?? stored)

  return { isVideo, laneList, list, value }
}
