/**
 * K4 Run settings. Sheet "run-settings", opened with nav.openSheet('run-settings'), strand 3 (Create).
 *
 * Only the controls the chosen cloud model really takes are shown
 * (parts/params.ts). K4.1 Aspect, K4.2 Quality, K4.3 Images 1 to 4, K4.4 Size
 * or Length, K4.5 Improve my prompt, K4.6 Negative prompt (sub page),
 * K4.7 Prompt history (sub page), K4.8 Model settings (sub page with the
 * controls of the provider schema, drawn by parts/SchemaFields.tsx: choice
 * lists, the presenter with faces, list fields such as style LoRAs), K4.9 Save as prompt style, K4.10 Close is the
 * close button of the sheet. The footer always shows "This run" and the price.
 */
import { Box, Cloud, History, SlidersHorizontal, Sparkles, Star, TextQuote, X } from 'lucide-react'
import { EDIT_MAX_DENOISE, useCreateStore } from '../../../stores/createStore'
import { MAX_IMAGE_COUNT } from '../../../lib/render/image-count'
import { nav, useSheet } from '../../nav'
import { CREATE_STRINGS as T } from '../../strings/create'
import { Button, EmptyState, IconButton, ListGroup, Row, Segmented, Sheet, Slider, TextArea, toast } from '../../ui'
import { imageBaseLong } from './parts/catalog'
import { useCreateFacts, type CreateFacts } from './parts/facts'
import { ASPECTS, QUALITIES, aspectSize, creditsLabel, formatCredits, hasAnyParam } from './parts/params'
import { checkStyle, cleanStyle, useStyleStore } from './parts/styles'
import { retryPrice } from './parts/PriceOwner'
import { SchemaFields, SchemaSub, isSchemaSub, schemaSubTitle, type SchemaHost } from './parts/SchemaFields'
import { useComputerAvailability, useCreateSource } from './parts/computer-source'
import { TOOL_ICON } from './parts/ui'
import { COMPUTER_STRINGS as C } from '../../strings/create'

const st = () => useCreateStore.getState()

function PriceFooter({ f }: { f: CreateFacts }) {
  const short = f.wallet !== 'ok'
  let value: string
  let note: string | null = null
  if (f.priceState === 'unavailable') value = ''
  else if (f.cost === null) value = ''
  else value = creditsLabel(f.cost)
  if (f.priceState === 'unavailable') note = T.priceUnavailable
  else if (f.cost === null) note = f.quota ? T.priceChecking : T.priceUnknown
  else if (f.priceState === 'pending') note = T.priceChecking
  else if (short) note = f.wallet === 'video_budget' ? T.videoBudget : f.wallet === 'trainings' ? T.noTrainings : `${T.notEnough}. ${T.walletShort(formatCredits(f.quota?.remaining.credits ?? 0))}`
  else if (f.meter?.kind === 'ok' && f.meter.runsLeft !== null && f.meter.runsLeft <= 20) note = T.runsLeft(f.meter.runsLeft, f.meter.unit)
  return (
    <div data-testid="m-create-settings-price" data-state={f.priceState === 'unavailable' ? 'unavailable' : f.cost === null || f.priceState === 'pending' ? 'checking' : short ? 'short' : 'known'}>
      <div className="m-k-foot-price" data-short={short ? '' : undefined}>
        <span>{T.thisRun}</span>
        <b>{value}</b>
      </div>
      {note ? <div className="m-cap">{note}</div> : null}
      {f.priceState === 'unavailable' ? (
        <Button block onPress={retryPrice} testid="m-create-settings-price-retry">
          {T.priceRetry}
        </Button>
      ) : null}
    </div>
  )
}

// ---------- K4.8: the controls of the provider schema ----------
// Drawn by parts/SchemaFields.tsx, which a guided preset uses too. Here the values live in the create store.

function setOption(key: string, value: unknown): void {
  const next = { ...st().cloudStudioOptions }
  if (value === undefined || value === '') delete next[key]
  else next[key] = value
  st().setCloudStudioOptions(next)
}

function useSchemaHost(model: string): SchemaHost {
  const options = useCreateStore((s) => s.cloudStudioOptions)
  return { model, options, set: setOption }
}

// ---------- K4.7: prompt history ----------

function PromptHistory({ onUse }: { onUse: () => void }) {
  const history = useCreateStore((s) => s.promptHistory)
  if (history.length === 0) {
    return (
      <EmptyState title={T.run.historyEmpty} icon={History} testid="m-create-history-empty">
        {T.run.historyEmptyText}
      </EmptyState>
    )
  }
  const clearAll = async () => {
    const yes = await nav.confirm({ title: T.run.clearAllTitle, text: T.run.clearAllText, confirmLabel: T.run.clearAllConfirm, cancelLabel: T.run.keep, tone: 'danger', testid: 'create-history-clear' })
    if (yes) st().clearPromptHistory()
  }
  return (
    <div data-testid="m-create-history">
      <ListGroup>
        {history.map((text) => (
          <Row
            key={text}
            title={text}
            label={T.run.historyUse(text.slice(0, 60))}
            chevron={false}
            onPress={() => {
              st().setPrompt(text)
              onUse()
            }}
            trailing={<IconButton icon={X} label={T.run.historyRemove(text.slice(0, 60))} onPress={() => st().removeFromPromptHistory(text)} testid="m-create-history-remove" />}
            testid="m-create-history-row"
          />
        ))}
      </ListGroup>
      <div className="m-k-sec">
        <Button variant="danger" block onPress={() => void clearAll()} testid="m-create-history-clear">
          {T.run.clearAll}
        </Button>
      </div>
    </div>
  )
}

export default function RunSettingsSheet() {
  const { sub, pushSub, close, back } = useSheet()
  const f = useCreateFacts()
  const p = f.params
  const negative = useCreateStore((s) => s.negativePrompt)
  const improve = useCreateStore((s) => s.improvePrompt)
  const denoise = useCreateStore((s) => s.denoise)
  const count = useCreateStore((s) => s.cloudImageCount)
  const target = useCreateStore((s) => s.targetResolution)
  const historyCount = useCreateStore((s) => s.promptHistory.length)
  const footer = <PriceFooter f={f} />
  const host = useSchemaHost(f.model.id)
  const busy = useCreateStore((s) => s.isGenerating)
  const computerOffered = useComputerAvailability().offered
  const setSource = useCreateSource((s) => s.setSource)

  if (sub === 'negative') {
    return (
      <Sheet title={T.run.negative} footer={footer}>
        <div className="m-k-sec">
          <TextArea label={T.run.negativeLabel} hint={T.run.negativeHint} value={negative} onChange={(v) => st().setNegativePrompt(v)} rows={4} maxLength={1000} autoFocus testid="m-create-negative" el="K4.6" />
        </div>
      </Sheet>
    )
  }
  if (sub === 'history') {
    return (
      <Sheet title={T.run.history} footer={footer}>
        <PromptHistory onUse={close} />
      </Sheet>
    )
  }
  if (sub === 'model' && f.model.studio) {
    return (
      <Sheet title={T.run.modelSettings} footer={footer}>
        <SchemaFields host={host} onOpen={pushSub} />
      </Sheet>
    )
  }
  if (isSchemaSub(sub) && f.model.studio) {
    return (
      <Sheet title={schemaSubTitle(sub)} footer={footer}>
        <SchemaSub host={host} sub={sub} onDone={back} onOpen={pushSub} />
      </Sheet>
    )
  }

  const styleTool = f.tool === 'image' || f.tool === 'video' ? f.tool : null
  const saveStyle = async () => {
    if (!styleTool) return
    const name = await nav.prompt({ title: T.run.saveStyleTitle, confirmLabel: T.run.saveStyleConfirm, field: { label: T.run.saveStyleField }, testid: 'create-style-name' })
    if (name === null) return
    const draft = {
      name,
      tool: styleTool,
      text: st().prompt,
      aspect: styleTool === 'image' && p.aspect ? f.aspect : undefined,
      quality: styleTool === 'image' && p.quality ? f.quality : undefined,
      seconds: styleTool === 'video' && f.seconds !== null ? f.seconds : undefined,
    }
    const existing = useStyleStore.getState().presets
    const problem = checkStyle(draft, existing)
    if (problem) {
      toast(T.stylesPage.problems[problem], { tone: 'error', testid: 'create-style-problem' })
      return
    }
    useStyleStore.getState().save(cleanStyle(draft, () => `p-${Date.now().toString(36)}`))
    toast(T.run.styleSaved, { testid: 'create-style-saved' })
  }

  const any = hasAnyParam(p)
  return (
    <Sheet title={T.run.title} footer={footer}>
      {/* Prompt v2 (14.11.2026): the tool row above the field and the model chip beside it live here now. */}
      <ListGroup testid="m-create-settings-what">
        <Row
          title={T.run.what}
          icon={TOOL_ICON[f.tool]}
          value={T.tool[f.tool].name}
          disabled={busy}
          onPress={() => {
            close()
            nav.openSheet('tools')
          }}
          testid="m-create-tools-all"
          el="K1.3"
        />
        {f.facts.hasModels ? (
          <Row
            title={T.run.model}
            icon={Box}
            value={f.model.id ? f.model.label : T.modelNone}
            disabled={busy}
            onPress={() => {
              close()
              nav.openSheet('create-model')
            }}
            testid="m-create-model"
            el="K1.9"
          />
        ) : (
          <Row title={T.run.model} icon={Box} value={T.modelFixed} testid="m-create-model-fixed" el="K1.9" />
        )}
        {computerOffered ? (
          <Row
            title={T.run.runsOn}
            icon={Cloud}
            value={C.cloud}
            subtitle={C.useComputer}
            disabled={busy}
            onPress={() => {
              close()
              setSource('computer')
            }}
            testid="m-create-source-computer"
          />
        ) : null}
      </ListGroup>
      {p.aspect ? (
        <div className="m-k-sec">
          <span className="m-label">{T.run.aspect}</span>
          <Segmented
            label={T.run.aspect}
            value={f.aspect}
            onChange={(k) => {
              const size = aspectSize(k, imageBaseLong())
              st().setSize(size.w, size.h)
            }}
            options={ASPECTS.map((a) => ({ value: a, label: a, testid: `m-create-aspect-${a.replace(':', 'x')}` }))}
            testid="m-create-aspect"
            el="K4.1"
          />
        </div>
      ) : null}
      {p.quality ? (
        <div className="m-k-sec">
          <span className="m-label">{T.run.quality}</span>
          <Segmented label={T.run.quality} value={f.quality} onChange={(q) => st().setImageQuality(q)} options={QUALITIES.map((q) => ({ value: q, label: q, testid: `m-create-quality-${q.toLowerCase()}` }))} testid="m-create-quality" el="K4.2" />
        </div>
      ) : null}
      {p.count ? (
        <div className="m-k-sec">
          <span className="m-label">{T.run.images}</span>
          <Segmented
            label={T.run.images}
            value={String(count)}
            onChange={(n) => st().setCloudImageCount(Number(n))}
            options={Array.from({ length: MAX_IMAGE_COUNT }, (_, i) => ({ value: String(i + 1), label: String(i + 1), testid: `m-create-count-${i + 1}` }))}
            testid="m-create-count"
            el="K4.3"
          />
        </div>
      ) : null}
      {p.size ? (
        <div className="m-k-sec">
          <span className="m-label">{T.run.size}</span>
          <Segmented
            label={T.run.size}
            value={target}
            onChange={(v) => st().setTargetResolution(v)}
            options={[
              { value: '2k', label: '2K', testid: 'm-create-size-2k' },
              { value: '4k', label: '4K', testid: 'm-create-size-4k' },
              { value: '8k', label: '8K', testid: 'm-create-size-8k' },
            ]}
            testid="m-create-size"
            el="K4.4"
          />
        </div>
      ) : null}
      {p.length.length > 0 && f.seconds !== null ? (
        <div className="m-k-sec">
          <span className="m-label">{T.run.length}</span>
          <Segmented
            label={T.run.length}
            value={String(f.seconds)}
            onChange={(s) => {
              st().setCloudFrames(Number(s) * 16)
              st().setCloudFps(16)
            }}
            options={p.length.slice(0, 6).map((s) => ({ value: String(s), label: T.run.seconds(s), testid: `m-create-length-${s}` }))}
            testid="m-create-length"
            el="K4.4"
          />
        </div>
      ) : null}
      {p.strength ? (
        <div className="m-k-sec">
          <Slider label={T.run.strength} min={0.05} max={EDIT_MAX_DENOISE} step={0.05} value={Math.min(denoise, EDIT_MAX_DENOISE)} onChange={(v) => st().setDenoise(v)} format={(v) => v.toFixed(2)} testid="m-create-strength" />
          <span className="m-cap">{T.run.strengthHint}</span>
        </div>
      ) : null}
      {p.musicLength === null && f.tool === 'music' ? <p className="m-cap m-k-pad">{T.run.musicModelDecides}</p> : null}
      {!any && f.tool !== 'music' ? (
        <p className="m-cap m-k-pad" data-testid="m-create-settings-none">
          {T.run.nothing}
        </p>
      ) : null}
      <ListGroup>
        {p.improve ? (
          <Row icon={Sparkles} title={T.run.improve} subtitle={T.run.improveSub} switch={{ checked: improve, onChange: (next) => st().setImprovePrompt(next), tone: 'cloud' }} testid="m-create-improve" el="K4.5" />
        ) : null}
        {p.negative ? <Row icon={TextQuote} title={T.run.negative} value={negative.trim() ? negative.trim().slice(0, 18) : T.run.negativeNone} onPress={() => pushSub('negative')} testid="m-create-negative-open" el="K4.6" /> : null}
        {f.promptShown ? <Row icon={History} title={T.run.history} value={T.run.historyCount(historyCount)} onPress={() => pushSub('history')} testid="m-create-history-open" el="K4.7" /> : null}
        {p.modelSettings ? <Row icon={SlidersHorizontal} title={T.run.modelSettings} subtitle={T.run.modelSettingsSub(f.model.label)} onPress={() => pushSub('model')} testid="m-create-model-settings-open" el="K4.8" /> : null}
        {styleTool ? <Row icon={Star} title={T.run.saveStyle} chevron={false} onPress={() => void saveStyle()} testid="m-create-save-style" el="K4.9" /> : null}
      </ListGroup>
    </Sheet>
  )
}
