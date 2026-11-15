// LU Cloud, offered where a local model does not fit (lib/cloud-offer.ts has
// the rules and the words). Two faces: one line on a Model Manager tile, one
// quiet notice in Create. Both lead into the cloud the way the app already
// goes there: the model picker's LU Cloud rows open the cloud gate, which
// switches an account that can use the cloud straight over and shows the
// plans to everyone else. Nothing here takes a payment or opens a new page.
//
// Neither face shows in cloud mode, and neither shows with "Show Cloud
// features in Local mode" switched off: that setting is the user's lasting
// answer to every cloud hint in local mode.

import { Cloud } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { reportCloudGate } from '../../api/funnel'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCreateStore } from '../../stores/createStore'
import { useCloudAuthStore, deriveCloudAvailable } from '../../stores/cloudAuthStore'
import { useCloudCatalogStore, cloudModelById, lengthPrice, runCredits } from '../../stores/cloudCatalogStore'
import { intentToJob } from '../../lib/render/cloud-jobs'
import { createRunModel, isStudioModel } from '../../lib/render/create-studio'
import {
  CLOUD_OFFER_BUTTON, CLOUD_OFFER_TITLE, offerCreditsLine, tileOfferLine,
  type CloudOfferTask,
} from '../../lib/cloud-offer'

/**
 * Into the cloud for this task. A chat task opens the gate with no model
 * named, so the mode rule picks the hosted chat model (AppShell). A Create
 * task first puts Create on the same tab, so the cloud run starts where the
 * local one could not. Create is opened right away only for an account that
 * can use the cloud now: everyone else sees the plans over the page they are
 * on and is not moved away from it.
 */
export function openCloudFor(task: CloudOfferTask): void {
  const ui = useUIStore.getState()
  if (task !== 'chat') {
    useCreateStore.getState().setIntent(task)
    if (deriveCloudAvailable(useCloudAuthStore.getState())) ui.setView('create')
  }
  ui.setPendingCloudModel(null)
  ui.setCloudGateOpen(true, 'cloud-offer')
}

/**
 * The price of one cloud run of this task, or undefined where the app does not
 * know it. It is the number the meter in Create shows for the same tab and
 * model (createRunModel), and only once that number is known; otherwise the
 * line names none.
 */
export function useOfferCredits(task: CloudOfferTask): number | undefined {
  const quota = useCloudAuthStore((s) => s.quota)
  const fetchedAt = useCloudCatalogStore((s) => s.fetchedAt)
  useCloudCatalogStore((s) => s.models)
  const image = useCreateStore((s) => s.cloudImageModel)
  const video = useCreateStore((s) => s.cloudVideoModel)
  const op = useCreateStore((s) => s.cloudOpModel)
  const frames = useCreateStore((s) => s.cloudFrames)
  const fps = useCreateStore((s) => s.cloudFps)
  const musicDuration = useCreateStore((s) => s.musicDuration)
  if (task === 'chat' || !quota || fetchedAt === null) return undefined
  const job = intentToJob(task)
  const model = createRunModel(task, { image, video, op })
  if (!model || isStudioModel(model) || lengthPrice(model, job.op)) return undefined
  const entry = cloudModelById(model)
  if (!entry || entry.quote_required || !entry.credits) return undefined
  const seconds =
    job.op === 'music'
      ? musicDuration
      : job.kind === 'video' && fps > 0
        ? frames / fps
        : undefined
  // 0 means "no number": the line shows a price only where one is known.
  const credits = runCredits(job.kind, job.op, model, seconds, 0)
  return credits > 0 ? credits : undefined
}

/** True where a cloud hint may show at all. */
export function useCloudOfferAllowed(): boolean {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const enabled = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  return appMode !== 'cloud' && enabled !== false
}

/** The button both faces carry. Text in the cloud colour, no fill: a link
 *  that says where it goes, not a second action beside the tile's Get. */
export function CloudOfferButton({ task }: { task: CloudOfferTask }) {
  return (
    <button
      type="button"
      onClick={() => {
        // Counted since 3.1.0 (funnel Nr. 3): the offer opens the gate, which
        // the switch's own count does not see.
        reportCloudGate('cloud_offer_click')
        openCloudFor(task)
      }}
      title={CLOUD_OFFER_TITLE}
      data-testid="cloud-offer-button"
      className="inline font-medium text-lu-cloud dark:text-lu-cloud-lift hover:underline underline-offset-2"
    >
      {CLOUD_OFFER_BUTTON}
    </button>
  )
}

/**
 * The line on a Model Manager tile whose model does not fit this machine. The
 * tile decides WHEN (a verdict of "big" on a model not yet here), this decides
 * whether the cloud may be named and what the line says.
 */
export function CloudOfferLine({ task, sharedMemory = false }: { task: CloudOfferTask; sharedMemory?: boolean }) {
  const allowed = useCloudOfferAllowed()
  const credits = useOfferCredits(task)
  if (!allowed) return null
  const price = offerCreditsLine(credits)
  return (
    <p
      className="mt-2 flex items-start gap-1.5 t-micro leading-snug text-gray-500 dark:text-gray-400"
      data-testid="cloud-offer-tile"
      data-cloud-task={task}
    >
      <Cloud size={11} className="mt-[2px] shrink-0 text-lu-cloud dark:text-lu-cloud-lift" aria-hidden />
      <span>
        {tileOfferLine(task, sharedMemory)}
        {price && <span data-testid="cloud-offer-credits"> {price}</span>}{' '}
        <CloudOfferButton task={task} />
      </span>
    </p>
  )
}
