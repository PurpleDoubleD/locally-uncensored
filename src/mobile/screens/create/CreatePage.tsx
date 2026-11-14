/**
 * K1 Create. Route /create, tab root, strand 3 (Create).
 *
 * Create runs on LU Cloud, or (LU 3.0.7, store switch remoteCreate) on the
 * user's own paired computer: the source "My computer" (ComputerSurface.tsx,
 * parts/computer-*.ts), offered only over the sealed channel and only while
 * the computer names Create for this phone. The page reads the create store, the cloud
 * catalog and the account through parts/facts.ts and starts runs through
 * hooks/useCloudCreate.ts. The desktop Create (useCreate, the image engine
 * on the machine) is never mounted here.
 *
 * Elements (DESIGN.md 4.4): K1.1 credits chip, K1.2 Gallery, K1.3 All,
 * K1.4 tool chip, K1.5 prompt, K1.6 summary with price, K1.7 Add source,
 * K1.8 Settings, K1.9 model, K1.10 Create and Cancel, K1.12 result, K1.13 Save, K1.14 Share, K1.15 Edit, K1.16 Animate,
 * K1.17 More, K1.18 source tile, K1.19 references, K1.20 Cancel and refund,
 * K1.21 retention notice, K1.22 rail of prompt styles, K1.23 batch row, K1.24 gate,
 * K1.26 Presets (the guided runs of several steps, K12)
 * button, K1.25 showcase. K1.11 (examples) is gone since round 45: the
 * page of every tool fits on the first screen of a phone, nothing to scroll.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download, Ellipsis, Flag, FastForward, Film, Images, Layers, LayoutGrid, Maximize2, Paperclip, Share2, Sparkles, Square, Wand2, Zap } from 'lucide-react'
import { useCloudCreate } from '../../../hooks/useCloudCreate'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'
import { useCloudNoticeStore, CLOUD_RETENTION_DAYS } from '../../../stores/cloudNoticeStore'
import { CLOUD_BASE } from '../../../api/cloud/config'
import { modelRuntimes } from '../../../api/cloud/studio'
import { signalCreditsExhausted } from '../../../lib/credits-exhausted'
import { musicText } from '../../../lib/render/music-ui'
import { pastDueLine } from '../../../lib/past-due'
import { MIN_SAMPLES, type ModelRuntime } from '../../../lib/render/runtime-format'
import { nav } from '../../nav'
import { haptic } from '../../platform/haptics'
import { openAppLink } from '../../policy/links'
import { CREATE_STRINGS as T } from '../../strings/create'
import { Button, Chip, ComposerTuneButton, EmptyState, Icon, IconButton, ListGroup, Notice, Progress, RootPage, Row, SkeletonCards, riskProps, tuneSummary } from '../../ui'
import { CloudSwitch } from '../settings/cloud/CloudSwitch'
import { applyStyle, saveWithToast, setTool, shareWithToast, takeItemAsExtend, takeItemAsSource } from './parts/actions'
import { toolProbe, useCatalogVersion } from './parts/catalog'
import { ErrorNotice } from './parts/ErrorNotice'
import { explainError } from './parts/errors'
import { cancelGuided, isGuidedRunning } from './parts/guided-run'
import { useCreateFacts, useGate, type CreateFacts, type GateState } from './parts/facts'
import { CharacterCard, EnhanceCard, ExtendCard, MusicCard, ReferenceCard, SourceCard, VideoInputCard, VoiceCard } from './parts/InputCards'
import { creditsLabel, formatClock, formatCredits } from './parts/params'
import { stylesFor, useStyleStore } from './parts/styles'
import { purchaseView, reportItem, storePolicy, withAiConsent } from './parts/policy'
import { PriceOwner } from './parts/PriceOwner'
import { runPhase, runShare, uploadCount } from './parts/run-state'
import { installCreateServices, refreshQuota, useRunStore } from './parts/services'
import { availableTools, fallbackTool } from './parts/tools'
import { ResultMediaView, TOOL_ICON, itemName, useGalleryItem, useScreenShape } from './parts/ui'
import ComputerSurface from './ComputerSurface'
import { installComputerSource, useComputerAvailability, useCreateSource, useEffectiveSource } from './parts/computer-source'
import { COMPUTER_STRINGS as C } from '../../strings/create'

// ---------- the gate: signed out, no plan, or cloud off ----------

/** Without LU Cloud the paired computer can still create: the gate says so with one button. */
function ComputerWay() {
  const avail = useComputerAvailability()
  const setSource = useCreateSource((s) => s.setSource)
  if (!avail.offered) return null
  return (
    <Button variant="quiet" block onPress={() => setSource('computer')} testid="m-create-gate-computer">
      {C.useComputer}
    </Button>
  )
}

function Gate({ gate, teasers }: { gate: Exclude<GateState, 'open' | 'checking'>; teasers: boolean }) {
  if (!teasers) {
    return (
      <RootPage title={T.title} screen="create" actions={<CloudSwitch />}>
        <div data-m-sparse="" data-testid="m-create-gate" data-state="quiet">
          <EmptyState
            title={T.gateTitle}
            icon={Sparkles}
            actions={
              <>
                <Button block onPress={() => nav.switchTab('settings')} testid="m-create-gate-settings" el="K1.24">
                  {T.gateOpenSettings}
                </Button>
                <ComputerWay />
              </>
            }
          >
            {T.gateQuiet}
          </EmptyState>
        </div>
      </RootPage>
    )
  }
  const label = gate === 'signed-out' ? T.gateSignIn : gate === 'no-plan' ? T.gatePlan : T.gateTurnOn
  // "No plan" leads to buying, so it follows the store rules: a button, a sentence, or a neutral line.
  const purchase = gate === 'no-plan' ? purchaseView().mode : 'links'
  return (
    <RootPage title={T.title} screen="create" actions={<CloudSwitch />}>
      <div data-m-sparse="" data-testid="m-create-gate" data-state={gate} data-m-purchase={gate === 'no-plan' ? purchase : undefined}>
        <EmptyState
          title={T.gateTitle}
          icon={Sparkles}
          actions={
            <>
              {/* The cloud gate of strand 5 (E3) knows how to sign in, pick a plan and switch. */}
              {purchase === 'links' ? (
                <Button variant="cloud" block onPress={() => nav.push('/cloud')} testid="m-create-gate-action" el="K1.24">
                  {label}
                </Button>
              ) : null}
              <Button variant="quiet" block onPress={() => nav.push('/create/showcase')} testid="m-create-gate-showcase" el="K1.25">
                {T.gateShowcase}
              </Button>
              <ComputerWay />
            </>
          }
        >
          {purchase === 'none' ? T.policy.gateNeutral : purchase === 'text-only' ? `${T.policy.gateNeutral} ${T.policy.plansElsewhere}` : T.gateText}
        </EmptyState>
      </div>
    </RootPage>
  )
}

// ---------- the stage ----------

/** The tools whose stage has no card of its own when nothing ran yet: they get the one line of the tool. */
const HINT_TOOLS: readonly string[] = ['image', 'video', 'music']

/** Measured run times per model, fetched once per session. */
let runtimesCache: Record<string, ModelRuntime> | null = null
function useUsualSeconds(model: string, running: boolean): number | null {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!running || runtimesCache) return
    let alive = true
    void modelRuntimes().then((r) => {
      runtimesCache = r
      if (alive) bump((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [running])
  const r = runtimesCache?.[model]
  return r && r.samples >= MIN_SAMPLES ? r.seconds : null
}

function Running({ f, onCancel }: { f: CreateFacts; onCancel: () => void }) {
  const progress = useCreateStore((s) => s.progress)
  const progressText = useCreateStore((s) => s.progressText)
  const progressPhase = useCreateStore((s) => s.progressPhase)
  const run = useRunStore((s) => s.run)
  const usual = useUsualSeconds(f.model.id, true)
  const [now, setNow] = useState(() => Date.now())
  // The clock only runs while there is a run to time (review N9). Without one
  // the page used to draw itself again every second for nothing.
  const startedAt = run.startedAt
  useEffect(() => {
    if (!startedAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  const phase = runPhase({ progress, phase: progressPhase, text: progressText })
  const share = runShare({ progress, phase: progressPhase })
  const clock = formatClock(run.startedAt ? (now - run.startedAt) / 1000 : 0)
  const count = phase === 'uploading' ? uploadCount(progressText) : null
  const parts = [count ? `${T.phase[phase]} ${T.uploadCount(count.done, count.total)}` : T.phase[phase], clock]
  if (usual && (phase === 'rendering' || phase === 'queued')) parts.push(T.usually(T.usuallyTime(usual)))
  const line = parts.join(' · ')
  return (
    <div className="m-k-box m-k-box--pad m-k-run" data-testid="m-create-running" data-state={phase} aria-live="polite">
      <div className="m-k-run-line" data-testid="m-create-running-line">
        {line}
      </div>
      {share === undefined ? (
        <div className="m-k-run-ring">
          <Progress label={T.runProgress} />
        </div>
      ) : (
        <Progress label={T.runProgress} value={share} tone="cloud" hidePercent testid="m-create-progress" />
      )}
      {f.imageCount > 1 && run.resultIds.length > 0 ? <div className="m-cap">{T.imagesDone(run.resultIds.length, f.imageCount)}</div> : null}
      {!f.online ? (
        <div className="m-cap" data-testid="m-create-running-offline">
          {T.runningOffline}
        </div>
      ) : (
        <div className="m-cap">{T.runningLeave}</div>
      )}
      <Button onPress={onCancel} busy={run.cancelling} testid="m-create-cancel-refund" el="K1.20">
        {run.cancelling ? T.cancelling : T.cancelRefund}
      </Button>
    </div>
  )
}

function Result({ item, ids, busy }: { item: GalleryItem; ids: string[]; busy: boolean }) {
  const gallery = useCreateStore((s) => s.gallery)
  const dispatch = useRunStore((s) => s.dispatch)
  const [working, setWorking] = useState<string | null>(null)
  const act = async (name: string, fn: () => Promise<unknown>) => {
    if (working) return
    setWorking(name)
    try {
      await fn()
    } finally {
      setWorking(null)
    }
  }
  const others = ids.map((id) => gallery.find((g) => g.id === id)).filter((g): g is GalleryItem => !!g)
  const open = () => nav.push('/create/item/:id', { id: item.id })
  return (
    <>
      <div className="m-k-box" data-testid="m-create-result" data-state="done" data-m-id={item.id} data-m-kind={item.type}>
        <ResultMediaView item={item} openTestid="m-create-result-open" el="K1.12" />
        <div className="m-k-racts">
          <button type="button" data-testid="m-create-result-save" {...riskProps('sensor')} data-el="K1.13" aria-busy={working === 'save' || undefined} disabled={!!working} onClick={() => void act('save', () => saveWithToast(item))}>
            <Icon icon={Download} small />
            {T.save}
          </button>
          <button type="button" data-testid="m-create-result-share" {...riskProps('leaves-app')} data-el="K1.14" aria-busy={working === 'share' || undefined} disabled={!!working} onClick={() => void act('share', () => shareWithToast(item))}>
            <Icon icon={Share2} small />
            {T.share}
          </button>
          {item.type === 'image' ? (
            <>
              <button type="button" data-testid="m-create-result-edit" data-el="K1.15" disabled={!!working || busy} onClick={() => void act('edit', () => takeItemAsSource(item, 'edit'))}>
                <Icon icon={Wand2} small />
                {T.edit}
              </button>
              <button type="button" data-testid="m-create-result-animate" data-el="K1.16" disabled={!!working || busy} onClick={() => void act('animate', () => takeItemAsSource(item, 'animate'))}>
                <Icon icon={Film} small />
                {T.animate}
              </button>
            </>
          ) : (
            <>
              <button type="button" data-testid="m-create-result-fullscreen" data-el="K1.12" onClick={open}>
                <Icon icon={Maximize2} small />
                {T.fullScreen}
              </button>
              {item.type === 'video' && item.jobId ? (
                <button type="button" data-testid="m-create-result-extend" disabled={busy} onClick={() => takeItemAsExtend(item)}>
                  <Icon icon={FastForward} small />
                  {T.extend}
                </button>
              ) : null}
            </>
          )}
          {storePolicy().reportContent ? (
            <button type="button" data-testid="m-create-result-report" aria-label={T.policy.reportLabel(itemName(item, 40))} onClick={() => reportItem(item)}>
              <Icon icon={Flag} small />
              {T.policy.report}
            </button>
          ) : null}
          <button type="button" data-testid="m-create-result-more" data-el="K1.17" onClick={() => nav.openSheet('result', { id: item.id })}>
            <Icon icon={Ellipsis} small />
            {T.more}
          </button>
        </div>
      </div>
      {others.length > 1 ? (
        <div className="m-chips m-k-strip" role="group" aria-label={T.gal.count(others.length)}>
          {others.map((g, i) => (
            <button
              key={g.id}
              type="button"
              className="m-k-thumb"
              aria-label={T.resultOf(i + 1, others.length)}
              aria-current={g.id === item.id}
              data-testid="m-create-result-thumb"
              data-m-id={g.id}
              onClick={() => dispatch({ type: 'show', id: g.id })}
            >
              {g.type === 'image' && (g.remoteUrl ?? g.dataUrl) ? <img src={g.remoteUrl ?? g.dataUrl} alt="" loading="lazy" /> : <Icon icon={TOOL_ICON[g.type === 'video' ? 'video' : 'music']} />}
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}

function StyleRail({ tool }: { tool: 'image' | 'video' }) {
  const own = useStyleStore((s) => s.presets)
  const list = stylesFor(tool, own)
  return (
    <section data-testid="m-create-styles" data-el="K1.22">
      <h2 className="m-label m-k-label">{T.styles}</h2>
      <div className="m-chips m-k-strip" style={{ paddingTop: 8 }}>
        {list.map((p) => (
          <button key={p.id} type="button" className="m-k-style" aria-label={T.stylesPage.apply(p.name)} data-testid="m-create-style" data-m-id={p.id} onClick={() => applyStyle(p)}>
            <b>{p.name}</b>
            <span>{p.text || [p.aspect, p.quality].filter(Boolean).join(', ')}</span>
          </button>
        ))}
        <Chip kind="action" onPress={() => nav.push('/create/styles')} testid="m-create-styles-all">
          {T.allStyles}
        </Chip>
      </div>
    </section>
  )
}

function Stage({ f, onRetry, onCancel, onMakeVoice }: { f: CreateFacts; onRetry: () => void; onCancel: () => void; onMakeVoice: Parameters<typeof VoiceCard>[0]['onMakeVoice'] }) {
  const run = useRunStore((s) => s.run)
  const pending = useRunStore((s) => s.pending)
  const pickedUp = useRunStore((s) => s.pickedUp)
  const setPickedUp = useRunStore((s) => s.setPickedUp)
  const error = useCreateStore((s) => s.error)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const batchSources = useCreateStore((s) => s.batchSources)
  const galleryCount = useCreateStore((s) => s.gallery.length)
  const pastDue = useCloudAuthStore((s) => s.pastDue)
  const pastDueTier = useCloudAuthStore((s) => s.pastDueTier)
  const retentionSeen = useCloudNoticeStore((s) => s.retentionNoticeSeen)
  const setRetentionSeen = useCloudNoticeStore((s) => s.setRetentionNoticeSeen)
  const item = useGalleryItem(run.resultId)

  const tool = f.tool
  const purchase = purchaseView().mode
  const explained = error ? explainError(error) : null
  // A prompt the safety check refused is shown under the field, not here.
  const stageError = error && !(explained && (explained.kind === 'policy-account' || (explained.kind === 'policy' && /prompt was blocked/i.test(error))))
  const showRunning = run.view === 'running' || isGenerating
  const showResult = !showRunning && run.view === 'result' && item
  const ToolGlyph = TOOL_ICON[tool]
  const text = T.tool[tool]

  return (
    // data-m-sparse: what the stage shows stands in the middle above the composer (round 45). Higher content starts at the top.
    <div className="m-k-stage" data-m-sparse="" data-testid="m-create-stage" data-state={showRunning ? 'running' : showResult ? 'result' : run.view === 'failed' ? 'failed' : 'empty'} data-m-tool={tool}>
      {/* Only a build with buy links speaks of a payment. The others say the neutral line, 'text-only' adds the one allowed sentence. */}
      {pastDue && purchase !== 'links' ? (
        <Notice variant="warn" testid="m-create-pastdue">
          {purchase === 'text-only' ? `${T.policy.pastDueNeutral} ${T.policy.plansElsewhere}` : T.policy.pastDueNeutral}
        </Notice>
      ) : pastDue ? (
        <Notice
          variant="error"
          title={T.pastDueTitle}
          testid="m-create-pastdue"
          actions={
            <Button compact onPress={() => void openAppLink(`${CLOUD_BASE}/account`)} risk="paid" testid="m-create-pastdue-action">
              {T.payInvoice}
            </Button>
          }
        >
          {pastDueLine(pastDueTier)}
        </Notice>
      ) : null}

      {pending.length > 0 && !showRunning ? (
        <Notice
          title={pickedUp > 0 ? T.pickedUp(pending.length) : undefined}
          testid="m-create-pending"
          actions={
            pickedUp > 0 ? (
              <Button compact variant="quiet" onPress={() => setPickedUp(0)} testid="m-create-pending-ok">
                {T.gotIt}
              </Button>
            ) : undefined
          }
        >
          {f.online ? T.pickedUpText : T.pickedUpOffline}
        </Notice>
      ) : null}

      {stageError && error ? <ErrorNotice message={error} stillBooked={pending.length > 0} onRetry={onRetry} retryDisabled={isGenerating || f.block !== null} /> : null}

      {showRunning ? <Running f={f} onCancel={onCancel} /> : null}
      {showResult && item ? <Result item={item} ids={run.resultIds} busy={isGenerating} /> : null}

      {(showResult || galleryCount > 0) && !retentionSeen && !showRunning ? (
        <Notice
          testid="m-create-retention"
          actions={
            <Button compact onPress={() => setRetentionSeen(true)} testid="m-create-retention-ok" el="K1.21">
              {T.gotIt}
            </Button>
          }
        >
          {T.retention(CLOUD_RETENTION_DAYS)}
        </Notice>
      ) : null}

      {/* The inputs of the tool. */}
      {tool === 'character' ? <CharacterCard f={f} /> : null}
      {f.facts.needsSource ? <SourceCard f={f} disabled={isGenerating} /> : null}
      {tool === 'lipsync' && f.needsClip ? <VideoInputCard f={f} title={T.presenterClip} sub={T.presenterClipSub} disabled={isGenerating} testid="m-create-clip" /> : null}
      {tool === 'lipsync' && f.needsPortrait ? <SourceCard f={f} title={T.presenter} sub={T.presenterSub} disabled={isGenerating} /> : null}
      {tool === 'lipsync' && !f.needsClip && !f.needsPortrait ? (
        <Notice testid="m-create-presenter-model">{T.presenterFromModel}</Notice>
      ) : null}
      {tool === 'lipsync' ? <VoiceCard f={f} disabled={isGenerating} onMakeVoice={onMakeVoice} /> : null}
      {tool === 'motion' ? (
        <>
          <SourceCard f={f} title={T.portrait} sub={T.portraitSub} disabled={isGenerating} />
          <VideoInputCard f={f} title={T.motionVideo} sub={T.motionVideoSub} disabled={isGenerating} testid="m-create-motion-video" />
        </>
      ) : null}
      <ReferenceCard f={f} disabled={isGenerating} />
      {tool === 'upscale' ? <EnhanceCard disabled={isGenerating} /> : null}
      {tool === 'extend' ? <ExtendCard disabled={isGenerating} /> : null}
      {tool === 'music' && f.model.id ? <MusicCard f={f} disabled={isGenerating} /> : null}

      {batchSources.length > 1 ? (
        <ListGroup>
          <Row icon={Images} title={T.batchRow(batchSources.length)} subtitle={T.batchRowSub} onPress={() => nav.push('/create/batch')} testid="m-create-batch-row" el="K1.23" />
        </ListGroup>
      ) : null}

      {/* A tool without an input card says in one line what it wants. The tool row above names it, the cards say it for the others. */}
      {!showRunning && !showResult && HINT_TOOLS.includes(tool) ? (
        <p className="m-k-hint" data-testid="m-create-empty">
          <Icon icon={ToolGlyph} />
          {text.empty}
        </p>
      ) : null}

      {f.facts.styles && !showRunning ? <StyleRail tool={tool as 'image' | 'video'} /> : null}

      {!showRunning ? (
        <ListGroup>
          <Row icon={Layers} title={T.guided.entry} subtitle={T.guided.entrySub} onPress={() => nav.push('/create/presets')} testid="m-create-presets-open" el="K1.26" />
        </ListGroup>
      ) : null}
    </div>
  )
}

// ---------- the composer ----------

/** Create, or Cancel while a run is on. The composer holds it; with very large text it stands alone below the page. */
function StartButton({ f, onCreate, onCancel, price }: { f: CreateFacts; onCreate: () => void; onCancel: () => void; price?: string }) {
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const batchCount = useCreateStore((s) => s.batchSources.length)
  const cancelling = useRunStore((s) => s.run.cancelling)
  const batch = batchCount > 1 && f.facts.batch && !f.needsMask
  const mainLabel = batch ? T.startBatch(batchCount) : f.tool === 'character' && !f.characterUse ? T.train : T.create
  return isGenerating ? (
    <button type="button" className="m-btn" aria-busy={cancelling || undefined} data-testid="m-create-cancel" data-el="K1.10" onClick={cancelling ? undefined : onCancel}>
      <Icon icon={Square} small />
      <span>{T.cancel}</span>
    </button>
  ) : (
    <Button risk={batch ? undefined : 'paid'} variant="primary" icon={Sparkles} label={price !== undefined && f.cost !== null ? `${mainLabel}, ${creditsLabel(f.cost)}` : undefined} testid="m-create-generate" el="K1.10" disabled={f.block !== null} onPress={onCreate}>
      {mainLabel}
      {/* Prompt v2: the price of this run sits on the button that spends it. */}
      {price !== undefined ? (
        <small className="m-k-go-price" data-short={f.wallet !== 'ok' ? '' : undefined} data-testid="m-create-price" data-state={f.priceState}>
          {(f.priceState === 'pending' || f.priceState === 'measuring') && f.cost !== null ? <span className="m-ring" aria-hidden="true" /> : null}
          {price}
        </small>
      ) : null}
    </Button>
  )
}

/**
 * The page is a single scrolling column (very large text on a low screen): Create stays fixed
 * below it, with the price next to it, whatever scrolls (round 45). The composer in the column
 * keeps everything else.
 */
function StartBar({ f, onCreate, onCancel }: { f: CreateFacts; onCreate: () => void; onCancel: () => void }) {
  const price = f.priceState === 'unavailable' ? T.block['price-unavailable'] : f.cost === null ? '' : creditsLabel(f.cost)
  return (
    <div className="m-composer-wrap m-k-startbar" data-testid="m-create-startbar">
      {price ? (
        <span className="m-k-summary-price" data-short={f.wallet !== 'ok' ? '' : undefined}>
          {price}
        </span>
      ) : null}
      <StartButton f={f} onCreate={onCreate} onCancel={onCancel} />
    </div>
  )
}

function Composer({ f, onCreate, onCancel, startBelow }: { f: CreateFacts; onCreate: () => void; onCancel: () => void; startBelow?: boolean }) {
  const prompt = useCreateStore((s) => s.prompt)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const error = useCreateStore((s) => s.error)
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    // Grow with the text up to the max-height of the stylesheet, then scroll.
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [prompt, f.promptShown])

  const explained = error ? explainError(error) : null
  const blockedPrompt = explained && (explained.kind === 'policy-account' || (explained.kind === 'policy' && /prompt was blocked/i.test(error ?? '')))
  const placeholder = f.tool === 'music' && f.model.id && musicText(f.model.id).main === 'lyrics' ? T.musicLyricsPlaceholder : T.tool[f.tool].placeholder
  const short = f.wallet !== 'ok'
  const priceText = f.priceState === 'unavailable' ? T.block['price-unavailable'] : f.cost === null ? (f.quota ? '' : T.block['quota-unknown']) : creditsLabel(f.cost)
  const line = f.summary.join(' · ')
  const modelName = f.facts.hasModels ? (f.model.id ? f.model.label : T.modelNone) : T.modelFixed
  const blockText = f.block ? T.block[f.block] : short ? (f.wallet === 'video_budget' ? T.videoBudget : f.wallet === 'trainings' ? T.noTrainings : T.notEnough) : null

  return (
    <div className="m-composer-wrap" data-testid="m-create-composer">
      {blockedPrompt && explained ? (
        <div className="m-k-composer-note">
          <Notice
            variant="error"
            title={T.error.policyTitle}
            testid="m-create-prompt-blocked"
            actions={
              explained.kind === 'policy-account' ? (
                <Button compact onPress={() => nav.push('/settings/content-policy')} testid="m-create-prompt-blocked-action">
                  {T.error.openPolicy}
                </Button>
              ) : undefined
            }
          >
            {explained.kind === 'policy-account' ? T.error.policyAccountText : T.error.policyText}
          </Notice>
        </div>
      ) : null}
      <div className="m-composer m-composer--cloud">
        {f.promptShown ? (
          <textarea
            ref={ref}
            rows={1}
            value={prompt}
            placeholder={placeholder}
            aria-label={T.promptLabel}
            data-testid="m-create-prompt"
            data-el="K1.5"
            maxLength={4000}
            onChange={(event) => setPrompt(event.target.value)}
          />
        ) : null}
        {blockText && !isGenerating ? (
          <div className="m-k-blocked" data-testid="m-create-blocked" data-m-reason={f.block ?? f.wallet}>
            {blockText}
          </div>
        ) : null}
        {/* Prompt v2 (14.11.2026): one row. The settings button with the summary (tool, model, what is set),
            Add source, Create with the price. Tool, model and everything else are in the run settings. */}
        <div className="m-composer-row">
          <ComposerTuneButton
            summary={
              <>
                <b>{T.tool[f.tool].short}</b>
                {` · ${tuneSummary([modelName, line])}`}
              </>
            }
            label={T.summaryLabel(tuneSummary([T.tool[f.tool].name, modelName, line]) || T.summaryEmpty, priceText)}
            onPress={() => nav.openSheet('run-settings')}
            testid="m-create-settings"
            el="K1.8"
          />
          <IconButton icon={Paperclip} label={T.addSource} onPress={() => nav.openSheet('source')} disabled={isGenerating} testid="m-create-add-source" el="K1.7" />
          {/* The number alone on the button, "credits" stays in its name and in the run settings: the summary keeps its room. */}
          {startBelow ? null : <StartButton f={f} onCreate={onCreate} onCancel={onCancel} price={f.cost !== null && f.priceState !== 'unavailable' ? formatCredits(f.cost) : priceText} />}
        </div>
      </div>
    </div>
  )
}

// ---------- the page ----------

function Surface() {
  const f = useCreateFacts()
  useCatalogVersion()
  const { generate, cancel, makeVoice } = useCloudCreate({ onQuotaChange: () => void refreshQuota() })
  const dispatch = useRunStore((s) => s.dispatch)
  const batchCount = useCreateStore((s) => s.batchSources.length)

  const tools = availableTools(toolProbe())
  const wanted = fallbackTool(f.tool, tools)
  useEffect(() => {
    // The catalog no longer offers the chosen tool: move to the first one it has.
    if (wanted && wanted !== f.tool && !useCreateStore.getState().isGenerating) setTool(wanted)
  }, [wanted, f.tool])

  const onCreate = () => {
    if (f.block) return
    if (f.wallet !== 'ok') {
      // The empty wallet has its own sheet (G5). It opens where the paid call would fail.
      signalCreditsExhausted(f.wallet)
      return
    }
    if (batchCount > 1 && f.facts.batch && !f.needsMask) {
      nav.push('/create/batch')
      return
    }
    haptic('light')
    // Before the first cloud job the user agrees once. On "no" nothing starts and the input stays.
    void withAiConsent(() => generate())
  }
  const onCancel = () => {
    // A step of a guided preset renders: its own run owns the job (parts/guided-run.ts).
    if (isGuidedRunning()) {
      void cancelGuided()
      return
    }
    dispatch({ type: 'cancel' })
    void cancel()
  }
  const credits = f.quota ? formatCredits(f.quota.remaining.credits) : null
  const shape = useScreenShape()
  const mainRef = useRef<HTMLDivElement>(null)
  const runView = useRunStore((s) => s.run.view)
  const hasError = useCreateStore((s) => s.error !== null)
  useEffect(() => {
    // In one scrolling column the stage sits under the composer: bring what just happened into view.
    if (shape !== 'low' || (runView === 'empty' && !hasError)) return
    mainRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [shape, runView, hasError])
  const composer = <Composer f={f} onCreate={onCreate} onCancel={onCancel} startBelow={shape === 'low'} />
  const stageView = <Stage f={f} onRetry={onCreate} onCancel={onCancel} onMakeVoice={(o) => void withAiConsent(() => makeVoice(o))} />

  return (
    <RootPage
      title={T.title}
      screen="create"
      needsNetwork
      bareFooter
      actions={
        <>
          <CloudSwitch />
          <Chip kind="action" tone="cloud" icon={Zap} label={credits ? T.credits(credits) : T.creditsUnknown} onPress={() => nav.push('/settings/account')} testid="m-create-credits" el="K1.1">
            <span className="m-mono" data-state={f.quota && f.quota.remaining.credits <= 0 ? 'empty' : 'ok'}>
              {credits ?? '···'}
            </span>
          </Chip>
          <IconButton icon={LayoutGrid} label={T.gallery} onPress={() => nav.push('/create/gallery')} testid="m-create-gallery" el="K1.2" />
        </>
      }
      footer={shape === 'tall' ? composer : shape === 'low' ? <StartBar f={f} onCreate={onCreate} onCancel={onCancel} /> : undefined}
    >
      <PriceOwner />
      {shape === 'tall' ? (
        stageView
      ) : (
        // Too little height for a fixed composer: on its side the two stand next to each other,
        // with very large text they are one scrolling column with the composer first.
        <div className={shape === 'wide' ? 'm-k-wide' : 'm-k-low'} data-testid="m-create-layout" data-state={shape}>
          <div className="m-k-layout-side">{composer}</div>
          <div className="m-k-layout-main" ref={mainRef}>
            {stageView}
          </div>
        </div>
      )}
    </RootPage>
  )
}

export default function CreatePage() {
  const { gate, teasers } = useGate()
  const source = useEffectiveSource()
  useEffect(() => {
    installCreateServices()
    installComputerSource()
  }, [])
  // "My computer" needs no LU Cloud: neither its gate nor its account.
  if (source === 'computer') return <ComputerSurface />
  if (gate === 'checking') {
    return (
      <RootPage title={T.title} screen="create">
        <SkeletonCards cards={2} label={T.gateChecking} testid="m-create-checking" />
      </RootPage>
    )
  }
  if (gate !== 'open') return <Gate gate={gate} teasers={teasers} />
  return <Surface />
}
