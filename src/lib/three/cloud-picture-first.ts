// The two cloud runs of "Picture first" (lib/three/picture-first.ts), in
// order, with everything that talks to the cloud handed in. The hook
// (hooks/useCloudCreate.ts) hands in the real calls and the store, the tests
// hand in fakes.
//
// 1. The content gate reads the prompt and the words added for the picture.
// 2. Both prices are confirmed before anything is booked. Their sum is what
//    the button showed; a higher sum stops here and shows the new number.
// 3. The open image model paints the picture. It lands in the gallery as a
//    picture and on the Stage under "From image", whatever happens after.
// 4. The gate reads again, now with where the picture came from (the user's
//    words), as it does for every picture a 3D run takes.
// 5. The server copies the picture into the inputs (POST /api/jobs/adopt), it
//    never goes through the customer's line again, and the image-to-3D model
//    builds from it. The words go along as `source_prompt` for the server's
//    own gate.
//
// A failed or stopped second step costs nothing (the server refunds it) and
// takes nothing away: the picture stays, and "Make it 3D" runs it again.
import type { CloudJob, CloudJobParams } from '../../api/cloud/jobs'
import type { SafetyVerdict } from '../render/safety'
import { THREE_D_TEXT } from './three-d-text'
import { threeDPicturePrompt } from './picture-prompt'

export interface PictureFirstPlan {
  /** What the user typed. */
  prompt: string
  /** The open image model that paints (pictureFirstPictureModel). */
  pictureModel: string
  /** The image-to-3D model the user picked as "Picture first". */
  meshModel: string
  /** The studio options of the mesh model (detail step, drawer). */
  meshOptions: Record<string, unknown>
  /** What the button showed: the mesh price (null before the first paint)
   *  and the picture price. */
  shown: { mesh: number | null; picture: number }
  /** One idempotency key per booking. */
  requestIds: [string, string]
}

export interface PictureFirstDeps {
  gate: (text: string) => SafetyVerdict
  quote: (model: string, prompt: string, options: Record<string, unknown>, images?: number) => Promise<number>
  submit: (job: { kind: 'image' | '3d'; model: string; prompt: string; params: CloudJobParams }) => Promise<{ id: string }>
  poll: (id: string, step: 1 | 2) => Promise<CloudJob>
  adopt: (jobId: string) => Promise<string>
  /** The picture is done: into the gallery and onto the Stage. */
  onPicture: (job: CloudJob, picturePrompt: string) => Promise<void>
  /** A job was booked (for Cancel and the progress line). */
  onBooked: (id: string, step: 1 | 2) => void
  /** The user asked to stop. Checked before every booking. */
  stopped: () => boolean
}

export type PictureFirstOutcome =
  | { kind: 'blocked'; step: 1 | 2; reason?: string }
  /** The confirmed sum is higher than the shown one: nothing was booked. */
  | { kind: 'price'; total: number; mesh: number }
  | { kind: 'stopped'; picture?: CloudJob }
  | { kind: 'picture-failed'; job: CloudJob }
  | { kind: 'mesh-failed'; picture: CloudJob; job: CloudJob }
  | { kind: 'done'; picture: CloudJob; mesh: CloudJob }

/** The text the gate and the server read for the second step: the user's
 *  words and the words the picture was painted with. */
export function pictureFirstProvenance(prompt: string): string {
  return `${prompt.trim()} ${threeDPicturePrompt(prompt)}`
}

export async function runCloudPictureFirst(plan: PictureFirstPlan, deps: PictureFirstDeps): Promise<PictureFirstOutcome> {
  const picturePrompt = threeDPicturePrompt(plan.prompt)
  const first = deps.gate(`${plan.prompt} ${picturePrompt}`)
  if (first.blocked) return { kind: 'blocked', step: 1, reason: first.reason }

  // Both prices before the first booking. The mesh is priced for the one
  // picture it will read, before that picture exists.
  const [picture, mesh] = await Promise.all([
    deps.quote(plan.pictureModel, picturePrompt, {}),
    deps.quote(plan.meshModel, '', plan.meshOptions, 1),
  ])
  if (plan.shown.mesh !== null && picture + mesh > plan.shown.mesh + plan.shown.picture) {
    return { kind: 'price', total: picture + mesh, mesh: picture + mesh - plan.shown.picture }
  }
  if (deps.stopped()) return { kind: 'stopped' }

  const one = await deps.submit({
    kind: 'image', model: plan.pictureModel, prompt: picturePrompt,
    params: { op: 'studio', studio_options: {}, client_request_id: plan.requestIds[0], max_credits: picture },
  })
  deps.onBooked(one.id, 1)
  const pictureJob = await deps.poll(one.id, 1)
  if (pictureJob.status === 'canceled') return { kind: 'stopped' }
  if (pictureJob.status !== 'succeeded' || !pictureJob.result_url) return { kind: 'picture-failed', job: pictureJob }
  await deps.onPicture(pictureJob, picturePrompt)

  const provenance = pictureFirstProvenance(plan.prompt)
  const second = deps.gate(provenance)
  if (second.blocked) return { kind: 'blocked', step: 2, reason: second.reason }
  if (deps.stopped()) return { kind: 'stopped', picture: pictureJob }

  const sourcePath = await deps.adopt(pictureJob.id)
  if (deps.stopped()) return { kind: 'stopped', picture: pictureJob }
  const two = await deps.submit({
    kind: '3d', model: plan.meshModel, prompt: '',
    params: {
      op: 'studio', studio_options: plan.meshOptions, client_request_id: plan.requestIds[1],
      max_credits: mesh, source_path: sourcePath, source_prompt: provenance,
      label: plan.prompt.trim().slice(0, 120) || THREE_D_TEXT.gallery.text,
    },
  })
  deps.onBooked(two.id, 2)
  const meshJob = await deps.poll(two.id, 2)
  if (meshJob.status === 'canceled') return { kind: 'stopped', picture: pictureJob }
  if (meshJob.status !== 'succeeded' || !meshJob.result_url) return { kind: 'mesh-failed', picture: pictureJob, job: meshJob }
  return { kind: 'done', picture: pictureJob, mesh: meshJob }
}
