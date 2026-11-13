// The web's lib/render/cloud-jobs.ts, as the mirrored Create in chat files see
// it: the same names and shapes, answered by the desktop's own client
// (api/cloud: cloudFetch with the bearer token and its deadlines).
import { CLOUD_BASE } from '../../../api/cloud/config'
import { intentToJob as desktopIntentToJob, type RenderKind, type RenderOp } from '../../render/cloud-jobs'
import type { StudioIntent } from '../../render/create-studio'

export { CloudJobError } from '../../../api/cloud/client'
export {
  adoptInput, cancelJob, getJob, getQuota, isActiveJob, pollJob, submitCloudJob, uploadInput,
  type AdoptRole, type CloudJob, type CloudJobParams, type CloudJobSubmit, type UploadRole,
} from '../../../api/cloud/jobs'
export { listLoras } from '../../../api/cloud/loras'

/** Which queue kind and op a subcategory renders as. 'video_upscale' is its
 *  own subcategory on the web; the queue knows it as an upscale of kind video. */
export function intentToJob(intent: StudioIntent): { kind: RenderKind; op: RenderOp } {
  if (intent === '3d-text' || intent === '3d-image' || intent === '3d-video') return desktopIntentToJob('3d')
  return intent === 'video_upscale' ? { kind: 'video', op: 'upscale' } : desktopIntentToJob(intent)
}

/** The fixed address of an own job's result on the server. A WebView cannot
 *  load it into an image or a player (the route wants the bearer token), so
 *  the order card resolves a signed address per job instead
 *  (components/chat/create/CreateOrders.tsx). */
export function jobFileUrl(jobId: string): string {
  return `${CLOUD_BASE}/api/jobs/${encodeURIComponent(jobId)}/file`
}
