import { useCreateExp } from './CreateContext'
import { useRunCredits } from './useRunCredits'
import { meterState } from '../../../lib/render/credits-meter'
import { Tooltip } from '../ui/Tooltip'
import { openExternal } from '../../../api/backend'
import { cloudLink } from '../../../lib/cloud-links'
import { cn } from '../ui/cn'
import { HINWEIS_TEXT, PUNKT_FARBE } from '../../../lib/hinweis'

// Compact credits meter for the cloud backend: remaining vs monthly budget,
// plus the cost of the run the user is about to start. One shared pool, so
// images and clips draw from the same number. At 0 (or not enough for this
// run) it becomes the upsell chip and the Create button is gated off.
//
// Der Balken kennt zwei Zustaende, keinen dritten: er laeuft (gruen) oder er
// ist so gut wie leer (grau). Der knappe Kontostand war gelb und hat damit
// wie eine Stoerung ausgesehen, obwohl noch jeder Lauf durchgeht. Leer ist
// keine Farbe am Balken, sondern der rote Knopf darunter.
export function CreditsMeter() {
  const { quota } = useCreateExp()
  const run = useRunCredits()
  if (!quota || !run) return null
  const { kind, op, unitCost, imageCount, cost } = run
  const remaining = quota.remaining.credits
  const limit = quota.limits.credits
  const gate = meterState(quota, cost, kind, op)
  const state = gate.kind === 'ok' && imageCount > 1 ? meterState(quota, unitCost, kind, op) : gate
  // Every shortfall this chip can show is wallet-fixable now, trainings
  // included since a topup wallet can fund a run past the included count
  // (the server allows that), so all three send the customer to the credits
  // tab, not to a plan change.
  //
  // Der Knopf traegt die Flaeche des Zaehlers daneben und den Fehlerton als
  // SCHRIFT. Vorher war er gelb gefuellt, also dieselbe Farbe, mit der ein
  // knapper Kontostand nur informiert hat. Kein Geld mehr zu haben ist kein
  // Zwischenton: es haelt den Lauf an. Regel in lib/hinweis.ts.
  const upsell = (label: string, tab?: 'credits') => (
    <button
      onClick={() => void openExternal(cloudLink(`/pricing${tab ? '?tab=credits' : ''}`, 'credits-meter'))}
      className={cn(
        't-control px-2 h-[var(--control-h-sm)] inline-flex items-center rounded-md',
        'bg-white/[0.04] hover:bg-white/[0.08] transition-colors',
        HINWEIS_TEXT.fehler,
      )}
    >
      {label}
    </button>
  )

  if (state.kind === 'insufficient') {
    return upsell(
      state.remaining <= 0
        ? 'Out of credits, top up'
        : `Needs ${state.cost} credits (${state.remaining} left)`,
      'credits',
    )
  }
  if (state.kind === 'no-trainings') return upsell('No included trainings left, top up', 'credits')
  if (state.kind === 'no-video-budget') return upsell('Video budget used up, top up', 'credits')

  const noun = op === 'lora-train' ? 'training' : kind === 'video' ? 'clip' : kind === 'audio' ? 'track' : 'image'
  const tail = state.runsLeft === null ? '' : `, about ${state.runsLeft} more like it`
  const videoTail =
    state.showVideoBudget && quota.video
      ? ` (monthly video budget: ${quota.video.remaining} of ${quota.video.limit} credits left)`
      : ''
  // B3 (review-a1.md): the chip beside this tooltip can already show more
  // runs than the included count once a topup wallet covers the run
  // (trainingPackRun in credits-meter.ts). Without this half-sentence the
  // tooltip named only the included count and read as a contradiction next
  // to the chip's own number.
  const topup = quota.topup?.credits ?? 0
  const trainingPackRun = op === 'lora-train' && cost > 0 && topup >= cost
  const trainingTail =
    op === 'lora-train' && quota.trainings
      ? ` (${quota.trainings.remaining} of ${quota.trainings.limit} included trainings left${trainingPackRun ? '; paid credits unlock more' : ''})`
      : ''

  return (
    <Tooltip
      content={`${remaining} of ${limit} credits left this billing period. This ${noun} uses ${unitCost}${imageCount > 1 ? ` (${imageCount} images, ${cost} in all)` : ''}${tail}${videoTail}${trainingTail}.`}
    >
      <div className="flex items-center gap-1.5 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.04] text-gray-400 t-control">
        <div className="w-12 h-1 rounded-full bg-white/10 overflow-hidden">
          <div
            className={cn('h-full rounded-full', state.pct > 0.25 ? PUNKT_FARBE.an : PUNKT_FARBE.aus)}
            style={{ width: `${state.pct * 100}%` }}
          />
        </div>
        <span className="tabular-nums">{remaining}</span>
        {/* Several images: the bar names what this run binds, next to the
            button that starts it. One image keeps the "how many more" figure. */}
        {imageCount > 1 ? (
          <>
            <span className="text-gray-600">·</span>
            <span className="tabular-nums whitespace-nowrap">{imageCount} images, {cost} credits</span>
          </>
        ) : state.runsLeft !== null && (
          <>
            <span className="text-gray-600">·</span>
            <span className="tabular-nums whitespace-nowrap">≈{state.runsLeft} {state.unit}</span>
          </>
        )}
      </div>
    </Tooltip>
  )
}
