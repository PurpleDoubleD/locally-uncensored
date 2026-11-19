import { Drawer } from '../ui/Drawer'
import { WorkflowFinder } from '../WorkflowFinder'
import { isMlxImageHost } from '../../../api/mlx-image'
import { useCreateStore } from '../../../stores/createStore'
import {
  classifyModel,
  resolveLocalOpPick,
  sceneLaneModels,
  videoLaneModels,
} from '../../../api/comfyui'
import { ParamGroups } from './ParamGroups'
import { StudioParams } from './StudioParams'
import { ImproveToggle } from './ImproveToggle'
import { ImageCount } from './ImageCount'
import { ActiveWorkflowParams } from './WorkflowParams'
import { isHubIntent } from '../../../lib/create/character-hub'
import { HubSettings } from './hub/HubSettings'
import { SceneSettings } from './SceneControls'

export function AdvancedDrawer({
  open,
  onClose,
  studioModel,
  onOpenWorkflows,
}: {
  open: boolean
  onClose: () => void
  /** The Character tab offers the user's own workflows from here. */
  onOpenWorkflows?: () => void
  /** Set only on the cloud Studio track (Portplan Abschnitt 3b): a Studio
   *  model has no sampler, scheduler, VAE or LoRA list from ComfyUI, so it
   *  REPLACES WorkflowFinder + ParamGroups below rather than adding to them.
   *  ParamGroups.tsx itself stays untouched, e2e/create-expert-section.spec.ts
   *  is the guard that this stays an ersetzung, not a new condition inside
   *  ParamGroups' own showExpert. */
  studioModel?: string
}) {
  const mode = useCreateStore((state) => state.mode)
  const backend = useCreateStore((state) => state.backend)
  const intent = useCreateStore((state) => state.intent())

  const imageModel = useCreateStore(
    (state) => state.imageModel,
  )

  const videoModel = useCreateStore(
    (state) => state.videoModel,
  )

  const videoModels = useCreateStore(
    (state) => state.videoModelList,
  )

  // Match the model coercion used by the visible picker and generation path.
  // Animate/Extend require I2V-capable models; ordinary Video requires T2V.
  let effectiveVideoModel = videoModel

  if (videoModels.length > 0) {
    const compatibleModels = videoLaneModels(videoModels, intent)

    const storedModelIsCompatible =
      compatibleModels.some(
        (model) => model.name === videoModel,
      )

    if (
      compatibleModels.length > 0 &&
      !storedModelIsCompatible
    ) {
      effectiveVideoModel =
        compatibleModels[0].name
    }
  }

  // Motion Control runs its own model list, and a workflow of the user's own
  // is picked for THAT model (useCreate runs it in place of LU's graph).
  const localOpModel = useCreateStore((state) => state.localOpModel)
  const motionModels = useCreateStore((state) => state.motionModelList)

  const modelName =
    intent === 'motion'
      ? resolveLocalOpPick(localOpModel, motionModels)
      : intent === 'scene'
      ? resolveLocalOpPick(localOpModel, sceneLaneModels(motionModels))
      : mode === 'image'
        ? imageModel
        : effectiveVideoModel

  const modelType = classifyModel(modelName)

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Advanced settings"
      width={320}
    >
      {/* The Character tab keeps its model, size and prompt helpers here:
          its prompt window holds only the field, the upload and Create. */}
      {open && isHubIntent(intent) && <HubSettings onOpenWorkflows={onOpenWorkflows} />}
      {/* Scene to Video: Look and Style at the head (the web's last rows of
          its settings; here the drawer is the settings). */}
      {open && intent === 'scene' && <SceneSettings />}
      <ImproveToggle />
      <ImageCount />
      {studioModel ? (
        <StudioParams model={studioModel} />
      ) : (
        <>
          <ParamGroups />

          {/* Workflows are ComfyUI graphs. A Mac runs MLX and can run none,
              so the row that asks for a tagged workflow is not shown there. */}
          {backend === 'local' && modelName && !isMlxImageHost() && (
            <div className="border-t border-white/10 px-1 pb-4 pt-4">
              <WorkflowFinder
                modelName={modelName}
                modelType={modelType}
              />
              {/* Motion Control fills a workflow of its own way
                  (injectLaneParameters): fewer values are LU's there. */}
              <ActiveWorkflowParams
                modelName={modelName}
                modelType={modelType}
                path={intent === 'motion' ? 'lane' : 'workflow'}
              />
            </div>
          )}
        </>
      )}
    </Drawer>
  )
}