// The Swap part of the bar at the foot of the Character area (sketches v2):
// the length as text with a small arrow ("6 s ▾") and the price with its
// parts ("62k frame 14k + video 48k"). Same numbers as the old length slider
// (ClipLength) and the Create button: swapPricedSeconds, swapClipCredits,
// the frame step and the lip sync step.

import { useCreateStore } from '../../../../stores/createStore'
import { createRunModel } from '../../../../lib/render/create-studio'
import {
  SWAP_FRAME_MODELS, swapBilledPhotos, swapClipCredits, swapClipLimits, swapClipSeconds, swapPricedSeconds,
  swapShortCredits, swapUsesFrame, swapWholeSeconds, SWAP_INTENT,
} from '../../../../lib/render/swap'
import { swapFrameCredits } from '../../../../lib/create/swap-frame'
import { Select } from '../../ui/Select'

/** What the bar shows for Swap. `videoSeconds`: the measured length of the
 *  customer's video (the Composer measures it for the price). */
export function useSwapBar(videoSeconds: number | undefined) {
  const opModel = useCreateStore((s) => s.cloudOpModel)
  const options = useCreateStore((s) => s.cloudStudioOptions)
  const chosen = useCreateStore((s) => s.swapSeconds)
  const figures = useCreateStore((s) => s.swapFigures)
  const frame = useCreateStore((s) => s.swapFrame)
  const lipsync = useCreateStore((s) => (s.sound === 'lipsync' ? s.lipsyncCredits : null))
  const model = createRunModel('swap_character', { image: '', video: '', op: opModel })
  const limits = swapClipLimits(model)
  const frameModel = SWAP_FRAME_MODELS.includes(model)
  const value = frameModel ? swapWholeSeconds(model, chosen, videoSeconds) : swapClipSeconds(model, chosen, videoSeconds)
  const video = videoSeconds ? (frameModel ? swapWholeSeconds(model, null, videoSeconds) : Math.floor(videoSeconds)) : undefined
  const top = Math.max(limits.min, Math.min(limits.max, video ?? limits.max))
  const seconds: number[] = []
  for (let v = limits.min; v <= top; v++) seconds.push(v)
  const frameCredits = swapUsesFrame(SWAP_INTENT, model) ? swapFrameCredits(frame?.width ?? 9, frame?.height ?? 16, figures.length) : null
  const videoCredits = swapClipCredits(model, options, videoSeconds ? swapPricedSeconds(model, chosen, videoSeconds) : Math.min(value, limits.max), swapBilledPhotos(model, figures.length))
  const total = videoCredits == null ? null : videoCredits + (frameCredits ?? 0) + (lipsync ?? 0)
  return { model, value, seconds, frameCredits, videoCredits, lipsync, total }
}

export function SwapLength({ videoSeconds, disabled }: { videoSeconds: number | undefined; disabled?: boolean }) {
  const setSwapSeconds = useCreateStore((s) => s.setSwapSeconds)
  const { value, seconds } = useSwapBar(videoSeconds)
  return (
    <Select
      variant="text"
      textClassName="h-[27px] px-1.5 hub-fs-125 hub-muted"
      ariaLabel="Length"
      value={String(value)}
      maxHeight={240}
      options={seconds.map((v) => ({ value: String(v), label: `${v} s` }))}
      onChange={(v) => { if (!disabled) setSwapSeconds(Number(v)) }}
    />
  )
}

/** "62k frame 14k + video 48k". */
export function SwapPrice({ videoSeconds }: { videoSeconds: number | undefined }) {
  const { frameCredits, videoCredits, lipsync, total } = useSwapBar(videoSeconds)
  if (total == null || videoCredits == null) return null
  const parts = [
    frameCredits != null ? `frame ${swapShortCredits(frameCredits)}` : null,
    `video ${swapShortCredits(videoCredits)}`,
    lipsync != null ? `lip sync ${swapShortCredits(lipsync)}` : null,
  ].filter(Boolean).join(' + ')
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap hub-fs-12" data-clip-price title={`${total.toLocaleString('en-US')} credits`}>
      <b className="hub-text hub-fs-13 font-medium tabular-nums">{swapShortCredits(total)}</b>
      <span className="hub-dim max-[520px]:hidden" data-clip-split>{parts}</span>
    </span>
  )
}
