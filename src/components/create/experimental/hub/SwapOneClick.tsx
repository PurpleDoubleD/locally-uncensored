// Swap with one click (14.11.2026, David's call, only with the account switch
// features.characterHub; port of the web's hub/SwapOneClick.tsx, 4e121fc0 and
// 4395e8d1). Sketches mockups-v2: c2 (ready), c3 (More options open), c4
// (running), d2 (check, only with "Check first frame"), c5 (refused).
// One button "Create · total" runs frame, video and sound one after the other
// (lib/create/swap-chain.ts). The inputs are SwapControls as before; the one
// framed part is the bar at the foot, built like the Composer's bar of the
// area. In the desktop style: rows with hairlines, text choices, no boxes.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { ArrowRight, Check, Loader2, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import { useCreateStore, type SwapFigure } from '../../../../stores/createStore'
import { useCreateExp } from '../CreateContext'
import { useNarrow } from '../Composer'
import { SwapControls, SpecialMore } from '../SpecialIntentControls'
import { mediaSeconds, useStudioPrice } from '../useStudioPrice'
import { Button } from '../../ui/Button'
import { Select, type SelectOption } from '../../ui/Select'
import { cn } from '../../ui/cn'
import { HUB_COLUMN, HubSwitch, MoreOptions } from './HubParts'
import { SwapLength, useSwapBar } from './SwapBarParts'
import { adoptInput, cancelJob, pollJob, submitCloudJob, uploadInput, type CloudJob } from '../../../../api/cloud/jobs'
import { galleryItemFromJob } from '../../../../lib/render/cloud-jobs'
import { studioShownValue } from '../../../../lib/render/create-studio'
import { describeSubmitError } from '../../../../lib/create/engine'
import { signalCreditsExhausted } from '../../../../lib/credits-exhausted'
import { buildSwapVideoSubmit } from '../../../../hooks/useCloudCreate'
import { useCharacterHubReleased } from '../../../../lib/create/character-hub-release'
import {
  swapBilledPhotos, swapDefaultOptions, swapFrameMaxPeople, swapFrameModelFor, swapPricedSeconds, swapShortCredits,
  swapWholeSeconds, SWAP_GALLERY_LABEL, SWAP_INTENT,
} from '../../../../lib/render/swap'
import { swapFrameCredits } from '../../../../lib/create/swap-frame'
import { swapInputError } from '../../../../lib/create/swap-run'
import {
  approveSwapFrame, cancelSwapChain, clearSwapChain, resumeSwapChain, retrySwapFrame, retrySwapOpen,
  startSwapChain, swapChainProblem, swapChainStore, swapChainTotal, SWAP_CHAIN_RUNNING, type SwapChainDeps, type SwapChainState,
} from '../../../../lib/create/swap-chain'
import {
  swapFrameChoices, swapIsChain, swapModelName, swapOpenModelsLine, swapVideoBlocked, swapVideoModelFor,
  useSwapOneClick, SWAP_VIDEO_CHOICES,
} from '../../../../lib/create/swap-one-click'

/** The ways of the chain, from the app. */
export function swapChainDeps(refreshQuota: () => Promise<void> | void): SwapChainDeps {
  return {
    uploadInput: (file, role) => uploadInput(file, role),
    adoptInput: (jobId, role) => adoptInput(jobId, role),
    submitCloudJob, pollJob, cancelJob,
    onQuota: () => { void refreshQuota() },
    onResult: (job: CloudJob) => {
      useCreateStore.getState().addToGallery({
        ...galleryItemFromJob(job),
        prompt: '',
        label: SWAP_GALLERY_LABEL,
      })
    },
  }
}

/** Who a person is: the character from the list, or a photo. */
function figureName(f: SwapFigure): string {
  return f.character ?? (f.image ? 'Photo' : '')
}

function joinNames(names: string[]): string {
  const n = names.filter(Boolean)
  if (n.length <= 1) return n[0] ?? ''
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}

/** Does the area show the one click swap? Only with the account switch and on
 *  the cloud; otherwise the panel as before ("Coming soon", or the Cloud
 *  sheet in local mode). */
export function useSwapOneClickShown(): boolean {
  const intent = useCreateStore((s) => s.intent())
  const backend = useCreateStore((s) => s.backend)
  const released = useCharacterHubReleased()
  return intent === SWAP_INTENT && released && backend === 'cloud'
}

export function SwapOneClick({ onChangeCharacter, onOpenAdvanced }: {
  /** "Change character" after a refusal: step 1 opens. */
  onChangeCharacter: () => void
  onOpenAdvanced: () => void
}) {
  const { refreshQuota, quota, generate, cancel } = useCreateExp()
  const deps = useMemo(() => swapChainDeps(refreshQuota), [refreshQuota])
  const narrow = useNarrow()
  const released = useCharacterHubReleased()

  const videoInput = useCreateStore((s) => s.videoInput)
  const frame = useCreateStore((s) => s.swapFrame)
  const figures = useCreateStore((s) => s.swapFigures)
  const swapSeconds = useCreateStore((s) => s.swapSeconds)
  const consent = useCreateStore((s) => s.swapConsent)
  const options = useCreateStore((s) => s.cloudStudioOptions)
  const setOptions = useCreateStore((s) => s.setCloudStudioOptions)
  const opModel = useCreateStore((s) => s.cloudOpModel)
  const setOpModel = useCreateStore((s) => s.setCloudOpModel)
  const setStudioCredits = useCreateStore((s) => s.setCloudStudioCredits)
  const backend = useCreateStore((s) => s.backend)
  const sound = useCreateStore((s) => s.sound)
  const audioInput = useCreateStore((s) => s.audioInput)
  const voiceFromJob = useCreateStore((s) => s.voiceFromJob)
  const lipModel = useCreateStore((s) => s.lipsyncModel)
  const lipCredits = useCreateStore((s) => (s.sound === 'lipsync' ? s.lipsyncCredits : null))
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const progressText = useCreateStore((s) => s.progressText)

  const prefs = useSwapOneClick()
  const { chain, busy, note } = useStore(swapChainStore)
  const [preparing, setPreparing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A chain that ran before a restart is followed on here.
  useEffect(() => { void resumeSwapChain(deps) }, [deps])

  const marked = figures.filter((f) => f.mark).length
  const videoModel = swapVideoModelFor(figures.length, prefs.videoOverride || null)
  const isChain = swapIsChain(videoModel)
  const frameModel = swapFrameModelFor(prefs.openModels, prefs.frameOverride || null)

  // The engine stands in the store, so price, run and gallery see the same.
  useEffect(() => { if (opModel !== videoModel) setOpModel(videoModel) }, [opModel, videoModel, setOpModel])
  useEffect(() => {
    const preset = swapDefaultOptions(SWAP_INTENT, videoModel)
    const missing = Object.entries(preset).filter(([k]) => options[k] === undefined)
    if (missing.length) setOptions({ ...options, ...Object.fromEntries(missing) })
  }, [videoModel, options, setOptions])

  const [measured, setMeasured] = useState<{ url: string; seconds: number | undefined } | null>(null)
  useEffect(() => {
    let alive = true
    if (!videoInput) return
    void mediaSeconds(videoInput.url, 'video').then((v) => { if (alive) setMeasured({ url: videoInput.url, seconds: v }) })
    return () => { alive = false }
  }, [videoInput])
  const videoSeconds = measured && videoInput && measured.url === videoInput.url ? measured.seconds : undefined

  const priceSeconds = videoSeconds !== undefined ? swapPricedSeconds(videoModel, swapSeconds, videoSeconds) : undefined
  const studioPrice = useStudioPrice(videoInput ? videoModel : undefined, options, '', priceSeconds, 0, swapBilledPhotos(videoModel, figures.length))
  const bar = useSwapBar(videoSeconds)
  // The server's quote; until it is there the catalogue's figure (as the bar).
  const videoCredits = videoInput ? studioPrice?.credits ?? bar.videoCredits : null
  // The ceiling of the video job is exactly this number (max_credits).
  useEffect(() => { setStudioCredits(videoCredits) }, [videoCredits, setStudioCredits])
  const frameCredits = isChain ? swapFrameCredits(frame?.width ?? 9, frame?.height ?? 16, figures.length, frameModel) : 0
  const lipsyncOn = sound === 'lipsync'
  const total = swapChainTotal({ frame: frameCredits, video: videoCredits, lipsync: lipsyncOn ? lipCredits ?? 0 : 0 })
  const seconds = videoSeconds !== undefined ? (isChain ? swapWholeSeconds(videoModel, swapSeconds, videoSeconds) : Math.round(priceSeconds ?? 0)) : null
  const resolution = String(studioShownValue(videoModel, options, 'resolution') ?? '')

  const running = !!chain && SWAP_CHAIN_RUNNING.includes(chain.stage)
  const plainRunning = !isChain && isGenerating
  const creditsOk = total == null || quota == null || quota.remaining.credits >= total
  const problem = !videoInput ? 'Add the original video first.'
    : isChain ? swapChainProblem({ frame, figures: figures.map((f) => ({ image: f.image, role: f.role, mark: f.mark })), frameModel, consent })
      : swapInputError(videoModel, { hasVideo: true, figures, consent })
  const voiceMissing = lipsyncOn && !audioInput && !voiceFromJob
  const ready = released && backend === 'cloud' && !problem && !voiceMissing && creditsOk && total != null
    && !running && !plainRunning && !preparing && !busy

  const names = joinNames(figures.map(figureName))

  const create = async () => {
    setError(null)
    if (!ready) return
    if (!isChain) { await generate(); return }
    clearSwapChain()
    setPreparing('Uploading your video…')
    try {
      const submit = await buildSwapVideoSubmit(videoModel, (t) => setPreparing(t))
      setPreparing('Uploading photos…')
      const lip = lipsyncOn && (audioInput || voiceFromJob)
        ? {
            model: lipModel, credits: lipCredits ?? 0,
            audio: audioInput ? { type: 'blob' as const, blob: audioInput.blob } : { type: 'job' as const, jobId: voiceFromJob!.jobId },
          }
        : null
      const started = startSwapChain({
        frame, figures: figures.map((f) => ({ image: f.image, role: f.role, mark: f.mark ?? null })),
        frameModel, check: prefs.check, consent, who: names,
        videoSubmit: submit, videoCredits: videoCredits ?? 0, lipsync: lip,
      }, deps)
      // As soon as the chain stands, its own view takes over.
      const unsub = swapChainStore.subscribe((st) => { if (st.chain) { setPreparing(null); unsub() } })
      await started.catch((err: unknown) => {
        unsub()
        setPreparing(null)
        const failure = describeSubmitError(err, signalCreditsExhausted)
        if (failure.text) setError(failure.text)
      })
    } catch (err) {
      setPreparing(null)
      const failure = describeSubmitError(err, signalCreditsExhausted)
      if (failure.text) setError(failure.text)
    }
  }

  // ── running (c4) ──
  if (preparing || running || plainRunning) {
    return (
      <SwapProgress
        chain={chain}
        preparing={preparing}
        plain={plainRunning ? progressText || 'Rendering in the cloud…' : null}
        originalUrl={frame?.url ?? null}
        names={names}
        note={note}
        onCancel={() => { if (plainRunning) void cancel(); else void cancelSwapChain(deps) }}
        cancelDisabled={!!preparing}
      />
    )
  }

  // ── check (d2) ──
  if (chain?.stage === 'review') {
    const summary = `${prefs.videoOverride ? '' : 'Auto · '}${swapModelName(videoModel)}${resolution ? ` · ${resolution}` : ''}${seconds ? ` · ${seconds} s` : ''}`
    return <SwapReview chain={chain} originalUrl={frame?.url ?? null} deps={deps} summary={summary} narrow={narrow} />
  }

  // ── done ──
  if (chain?.stage === 'done') {
    return (
      <Body>
        <div className="pt-4" data-swap-one-click="done">
          {chain.resultUrl && (
            <video src={chain.resultUrl} controls playsInline className="max-h-[52vh] w-full rounded-lg bg-black object-contain" />
          )}
          <p className="hub-dim mt-2 hub-fs-125">Your new video{chain.who ? ` · ${chain.who}` : ''}. It is in your gallery.</p>
          {chain.error && <p className="hub-text mt-2 hub-fs-13" role="alert">{chain.error}</p>}
          <button type="button" onClick={() => clearSwapChain()} className="hub-muted mt-4 hub-fs-13 underline decoration-[var(--hub-edge)] underline-offset-[3px]">
            Make another swap
          </button>
        </div>
      </Body>
    )
  }

  // ── inputs (c2 / c3 / c5) ──
  const refused = chain?.stage === 'refused'
  const failedText = chain?.stage === 'failed' ? chain.error : chain?.stage === 'canceled' ? 'Canceled. Nothing more was started.' : null
  const summary = `${prefs.videoOverride ? '' : 'Auto · '}${swapModelName(videoModel)}${resolution ? ` · ${resolution}` : ''}`
  const parts = [
    isChain && frameCredits != null ? `frame ${swapShortCredits(frameCredits)}` : null,
    videoCredits != null ? `video ${swapShortCredits(videoCredits)}` : null,
    lipsyncOn && lipCredits ? `lip sync ${swapShortCredits(lipCredits)}` : null,
  ].filter(Boolean).join(' + ')
  const hint = problem ?? (voiceMissing ? 'Add the new voice first.' : !creditsOk ? 'Not enough credits for this swap.' : undefined)

  return (
    <>
      <Body>
        <div className="pt-3" data-swap-one-click="form" data-swap-marks={marked}>
          <SwapControls
            oneClick={{
              model: videoModel,
              switches: isChain && (
                <div className="pt-1" data-swap-switches>
                  <HubSwitch testId="open-models" title="Uncensored" line={swapOpenModelsLine(videoModel)} on={prefs.openModels} onChange={prefs.setOpenModels} />
                  <HubSwitch testId="check" title="Check first frame before video" line="Pause after the first frame so you can retry it before paying for the video." on={prefs.check} onChange={prefs.setCheck} />
                </div>
              ),
            }}
          />
          <MoreOptions testId="hub-more">
            <SwapPicks videoModel={videoModel} frameModel={frameModel} people={figures.length} isChain={isChain} />
            <SpecialMore intent={SWAP_INTENT} />
            <button type="button" onClick={onOpenAdvanced} className="hub-muted hub-fs-125 underline decoration-[var(--hub-edge)] underline-offset-[3px]">
              All settings of the model
            </button>
          </MoreOptions>

          {refused && (
            <div className="flex items-start gap-2.5 pt-4" role="alert" data-swap-refused>
              <X size={14} className="hub-dim mt-[3px] shrink-0" />
              <div className="hub-fs-13">
                <p className="hub-text">{chain!.error}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2">
                  <button type="button" className="hub-acc" onClick={() => {
                    prefs.setOpenModels(true)
                    prefs.setFrameOverride('')
                    // With Uncensored the check is on by default (David, 14.11.).
                    void retrySwapOpen(deps, useSwapOneClick.getState().check)
                  }}>
                    Turn on Uncensored and retry
                  </button>
                  <span className="hub-dim" aria-hidden>·</span>
                  <button type="button" className="hub-acc" onClick={() => { clearSwapChain(); onChangeCharacter() }}>Change character</button>
                </p>
              </div>
            </div>
          )}
          {(failedText || error) && (
            <div className="flex items-start gap-2.5 pt-4" role="alert" data-swap-error>
              <X size={14} className="hub-dim mt-[3px] shrink-0" />
              <p className="hub-text flex-1 hub-fs-13">{failedText ?? error}</p>
              <button type="button" className="hub-dim hub-fs-125" onClick={() => { setError(null); if (chain) clearSwapChain() }}>Dismiss</button>
            </div>
          )}
        </div>
      </Body>

      <Foot>
        <SwapBar
          narrow={narrow}
          summary={summary}
          length={videoInput ? <SwapLength videoSeconds={videoSeconds} /> : null}
          seconds={videoInput ? seconds : null}
          total={total}
          parts={parts}
          ready={ready}
          hint={hint}
          onCreate={() => void create()}
        />
      </Foot>
    </>
  )
}

function Body({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className={cn(HUB_COLUMN, 'pb-4')}>{children}</div>
    </div>
  )
}

function Foot({ children }: { children: ReactNode }) {
  return <div className={cn(HUB_COLUMN, 'shrink-0 pb-3 pt-2')}>{children}</div>
}

/** "First frame ▾" and "Video ▾" under More options (c3). */
function SwapPicks({ videoModel, frameModel, people, isChain }: { videoModel: string; frameModel: string; people: number; isChain: boolean }) {
  const prefs = useSwapOneClick()
  const frameItems: SelectOption[] = swapFrameChoices(prefs.openModels).map((c) => {
    const tooMany = c.value !== '' && swapFrameMaxPeople(c.value) < Math.max(1, people)
    return { ...c, disabled: tooMany, sublabel: tooMany ? `up to ${swapFrameMaxPeople(c.value)} ${swapFrameMaxPeople(c.value) === 1 ? 'person' : 'people'}` : undefined }
  })
  const videoItems: SelectOption[] = [
    { value: '', label: `Auto (${swapModelName(swapVideoModelFor(people, null))})` },
    ...SWAP_VIDEO_CHOICES.map((id) => ({ value: id, label: swapModelName(id), disabled: !!swapVideoBlocked(id, people), sublabel: swapVideoBlocked(id, people) ?? undefined })),
  ]
  return (
    <div className="hub-fs-125" data-swap-picks>
      {isChain && (
        <div className="flex min-h-8 items-center gap-2.5" data-swap-pick="frame">
          <span className="hub-muted w-[80px] shrink-0">First frame</span>
          <Select variant="text" ariaLabel="First-frame model" textClassName="hub-fs-125" value={prefs.frameOverride}
            options={frameItems} onChange={prefs.setFrameOverride} placeholder={swapModelName(frameModel)} />
        </div>
      )}
      <div className="flex min-h-8 items-center gap-2.5" data-swap-pick="video">
        <span className="hub-muted w-[80px] shrink-0">Video</span>
        <Select variant="text" ariaLabel="Video model" textClassName="hub-fs-125" value={prefs.videoOverride}
          options={videoItems} onChange={prefs.setVideoOverride} placeholder={swapModelName(videoModel)} />
      </div>
    </div>
  )
}

/** The bar at the foot (c2): summary, length, total with its parts, Create.
 *  Narrow (phone width): the summary opens the length and the parts above
 *  the row, Create names the total (the Composer's narrow bar). */
function SwapBar({ narrow, summary, length, seconds, total, parts, ready, hint, onCreate }: {
  narrow: boolean; summary: string; length: ReactNode; seconds: number | null; total: number | null; parts: string
  ready: boolean; hint: string | undefined; onCreate: () => void
}) {
  const [open, setOpen] = useState(false)
  const price = total != null ? swapShortCredits(total) : null
  const create = (
    <span className="inline-flex" title={ready ? undefined : hint}>
      <Button variant="primary" size="md" icon={Sparkles} disabled={!ready} onClick={onCreate}
        className={narrow ? 'h-10 rounded-[20px] px-4' : undefined}>
        {narrow && price
          ? <>Create <span className="hub-fs-125 tabular-nums opacity-70">{price}</span></>
          : price ? `Create · ${price}` : 'Create'}
      </Button>
    </span>
  )
  const priceText = total != null && (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap hub-fs-12" data-clip-price data-swap-total={total} title={`${total.toLocaleString('en-US')} credits`}>
      <b className="hub-text hub-fs-13 font-medium tabular-nums">{swapShortCredits(total)}</b>
      {parts && <span className="hub-dim" data-clip-split>{parts}</span>}
    </span>
  )
  if (narrow) {
    return (
      <div className="hub-bar rounded-2xl" data-swap-bar="narrow">
        {open && (
          <div className="hub-line flex flex-wrap items-center gap-2 border-b px-2.5 py-2" data-hub-bar-options>
            {length}
            {priceText}
          </div>
        )}
        <div className="flex min-h-[45px] items-center gap-1.5 py-1.5 pl-2.5 pr-1.5">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
            className="hub-muted flex min-h-11 min-w-0 flex-1 items-center gap-1.5 text-left hub-fs-13" data-hub-bar-summary>
            <SlidersHorizontal size={14} className="shrink-0" />
            <span className="truncate">{summary}{seconds ? ` · ${seconds} s` : ''}</span>
          </button>
          {create}
        </div>
      </div>
    )
  }
  return (
    <div className="hub-bar" data-swap-bar="wide">
      <div className="flex min-h-[45px] items-center gap-1.5 py-[5px] pl-2.5 pr-1.5">
        <span className="hub-muted whitespace-nowrap hub-fs-13" data-swap-summary>{summary}</span>
        {length}
        <span className="flex-1" />
        {priceText}
        <span className="w-1" />
        {create}
      </div>
    </div>
  )
}

/** c4: "First frame ✓ → Video … → Sound", Cancel, you can leave. */
function SwapProgress({ chain, preparing, plain, originalUrl, names, note, onCancel, cancelDisabled }: {
  chain: SwapChainState | null; preparing: string | null; plain: string | null; originalUrl: string | null; names: string
  note: string | null; onCancel: () => void; cancelDisabled: boolean
}) {
  const stage = preparing ? 'frame' : plain ? 'video' : chain?.stage ?? 'frame'
  const frameUrl = chain?.frameUrl ?? null
  const steps = [
    ...(plain ? [] : [{ id: 'frame', label: 'First frame' }]),
    { id: 'video', label: 'Video' },
    // Sound and the length: without a new voice the worker does it in the
    // video step, with a new voice it is a job of its own.
    { id: 'sound', label: 'Sound' },
  ]
  const order = ['frame', 'video', 'sound']
  const at = order.indexOf(stage)
  return (
    <Body>
      <div className="pt-4" data-swap-one-click="running" data-swap-stage={stage}>
        {(frameUrl || originalUrl) && (
          <img src={frameUrl ?? originalUrl!} alt={frameUrl ? 'New first frame' : 'Original first frame'}
            className={cn('max-h-[42vh] max-w-full rounded-lg object-cover sm:max-w-[420px]', !frameUrl && 'opacity-50')} />
        )}
        <p className="hub-dim mt-2 hub-fs-125">{frameUrl ? `New first frame${names ? ` · ${names}` : ''}` : preparing ?? 'Building the first frame…'}</p>
        <div className="hub-line mt-3 flex min-h-12 flex-nowrap items-center gap-x-2.5 border-y py-1" data-swap-steps>
          {steps.map((st, i) => {
            const idx = order.indexOf(st.id)
            const done = idx < at
            const now = idx === at
            return (
              <span key={st.id} className="inline-flex shrink-0 items-center gap-2.5">
                {i > 0 && <ArrowRight size={13} className="hub-dim" aria-hidden />}
                <span className={cn('inline-flex items-center gap-1.5 hub-fs-14', done ? 'hub-text' : now ? 'hub-text font-medium' : 'hub-dim')}
                  data-swap-step={st.id} data-state={done ? 'done' : now ? 'now' : 'next'}>
                  {done && <Check size={14} className="hub-acc" />}
                  {now && <Loader2 size={14} className="hub-acc animate-spin" />}
                  {st.label}{now ? ' …' : ''}
                </span>
              </span>
            )
          })}
          <span className="flex-1" />
          <button type="button" onClick={onCancel} disabled={cancelDisabled} className="hub-muted min-h-11 shrink-0 hub-fs-14 disabled:opacity-40" data-swap-cancel>Cancel</button>
        </div>
        <p className="hub-dim mt-3 hub-fs-13">{note ?? (plain ? 'About 2 to 7 min. Keep LU open until it is done.' : 'About 2 to 7 min. You can leave this page.')}</p>
        {plain && <p className="hub-dim mt-1 hub-fs-12">{plain}</p>}
      </div>
    </Body>
  )
}

/** d2: "Does this look right?", below "What's wrong?", Try again and Continue. */
function SwapReview({ chain, originalUrl, deps, summary, narrow }: {
  chain: SwapChainState; originalUrl: string | null; deps: SwapChainDeps; summary: string; narrow: boolean
}) {
  const [extra, setExtra] = useState('')
  const busy = useStore(swapChainStore, (s) => s.busy)
  const next = chain.videoCredits + (chain.lipsync?.credits ?? 0)
  return (
    <>
      <Body>
        <div className="pt-4" data-swap-one-click="review">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <b className="hub-text hub-fs-14 font-semibold">Does this look right?</b>
            <span className="hub-dim hub-fs-125">The first frame of your new video. The rest follows the original motion.</span>
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[{ src: originalUrl, label: 'Original' }, { src: chain.frameUrl, label: `New first frame${chain.who ? ` · ${chain.who}` : ''}` }].map((p) => (
              <figure key={p.label}>
                {p.src ? <img src={p.src} alt={p.label} className="max-h-[40vh] w-full rounded-lg bg-black object-cover" /> : <div className="aspect-video rounded-lg bg-[var(--hub-fill)]" />}
                <figcaption className="hub-dim mt-1.5 hub-fs-125">{p.label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </Body>
      <Foot>
        <div className={cn('hub-bar', narrow && 'rounded-2xl')} data-swap-bar="review">
          <input
            type="text"
            value={extra}
            maxLength={500}
            aria-label="What's wrong?"
            placeholder="What's wrong? (optional)"
            onChange={(e) => setExtra(e.target.value)}
            className="hub-text hub-line h-11 w-full border-b bg-transparent px-3 hub-fs-14 outline-none"
          />
          <div className="flex min-h-[45px] items-center gap-2.5 py-[5px] pl-2.5 pr-1.5">
            {!narrow && <span className="hub-muted whitespace-nowrap hub-fs-13">{summary}</span>}
            <span className="flex-1" />
            <button type="button" disabled={busy} onClick={() => { void retrySwapFrame(deps, { extra }); setExtra('') }}
              className="hub-muted min-h-11 whitespace-nowrap hub-fs-13 disabled:opacity-40" data-swap-retry>
              Try again · {swapShortCredits(chain.frameCredits)}
            </button>
            <Button variant="primary" size="md" icon={Sparkles} disabled={busy} onClick={() => void approveSwapFrame(deps)}
              className={narrow ? 'h-10 rounded-[20px] px-4' : undefined}>
              {`Continue · ${swapShortCredits(next)}`}
            </Button>
          </div>
        </div>
      </Foot>
    </>
  )
}
