import { classifyModel } from '../../../api/comfyui'
import { isMlxImageHost } from '../../../api/mlx-image'
import { laneImageModel } from '../../../lib/image-engines'
import { isPromptlessRemoval, localEditMaskBlock } from '../../../lib/local-edit-mask'
import { useCreateStore } from '../../../stores/createStore'

/** The state of a painted mask on the local Edit tab, for the model the run
 *  will use: `block` says why it cannot run, `removes` that Create takes the
 *  painted area out because the prompt is empty. */
export function useLocalEditMask(): { block: string | null; removes: boolean; masked: boolean } {
  const intent = useCreateStore((s) => s.intent())
  const backend = useCreateStore((s) => s.backend)
  const hasMask = useCreateStore((s) => !!s.mask)
  const prompt = useCreateStore((s) => s.prompt)
  const list = useCreateStore((s) => s.imageModelList)
  const stored = useCreateStore((s) => s.imageModel)
  const model = laneImageModel(list, stored, intent)
  const modelType = list.find((m) => m.name === model)?.type ?? classifyModel(model)
  const block = localEditMaskBlock({ intent, backend, mac: isMlxImageHost(), hasMask, modelType })
  return {
    block,
    removes: !block && isPromptlessRemoval({ intent, backend, hasMask, prompt }),
    masked: backend === 'local' && intent === 'edit' && hasMask,
  }
}
