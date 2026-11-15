/**
 * Create with "My computer" as the source (LU 3.0.7, the whole tool row
 * since A17, LU 3.0.8): the user's own computer makes the image, the edit,
 * the clip, the track, the enhanced photo or the cutout; the phone sends the
 * job through the sealed channel and gets the result back into its gallery.
 *
 * Same frame as the cloud page (round 45): tool row, stage in the middle,
 * composer fixed at the bottom, nothing to scroll on 412x915. The tool row
 * holds the tools of the cloud row the computer names (parts/computer-tools.ts),
 * a tool the computer cannot run now stays in the row and says why. No
 * credits chip, no price, no time estimate: local means the computer says
 * how far it is (`progress`, `step_text`) and nothing else. The prompt check
 * of the app runs before anything leaves the phone; every result has the
 * report button, like a cloud result.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ListTodo, Brush, Camera, Download, Ellipsis, Flag, Image as ImageIcon, Images, LayoutGrid, Paperclip, Share2, Sparkles, Square, UserRound, Video } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { nav } from '../../nav'
import { haptic } from '../../platform/haptics'
import { takePhoto } from '../../platform/camera'
import { pickPhotos, type PickedFile } from '../../platform/files'
import { COMPUTER_STRINGS as C, CREATE_STRINGS as T } from '../../strings/create'
import { REMOTE_STRINGS as RS } from '../../strings/remote'
import { Button, Chip, ChipGroup, ComposerTuneButton, Icon, IconButton, Notice, Progress, RootPage, Segmented, SkeletonCards, TextArea, riskProps, toast, tuneSummary } from '../../ui'
import { dataUrlToBlob } from '../../../lib/render/data-url'
import { saveWithToast, shareWithToast } from './parts/actions'
import { clearComputerBlocked, cancelComputerJob, dismissComputerError, startComputerJob, useComputerRun } from './parts/computer-run'
import { MAX_LYRICS, jobBodyOf, modelFor, shownValue, sizeNote, summaryOf, useComputerForm, type StartImage } from './parts/computer-form'
import { useComputerAvailability, useComputerCaps } from './parts/computer-source'
import { mediaOfTool, modelOptional, toolPrompt, toolTakesMask, type ComputerTool } from './parts/computer-tools'
import { useComputerTool, type ComputerToolView } from './parts/computer-use'
import { loadPhoneImage } from './parts/photos'
import { reportItem, storePolicy } from './parts/policy'
import { RemoveX, ResultMediaView, TOOL_ICON, itemName, useGalleryItem, useScreenShape } from './parts/ui'

function useBusy(): boolean {
  const view = useComputerRun((s) => s.view)
  return view === 'sending' || view === 'running' || view === 'loading'
}

function Running() {
  const run = useComputerRun()
  const job = run.job
  const phase = run.view === 'sending' ? 'sending' : run.view === 'loading' ? 'loading' : job?.state === 'queued' ? 'queued' : 'running'
  const parts: string[] = [phase === 'running' && job?.stepText ? job.stepText : C.phase[phase]]
  if (phase === 'queued' && job && job.position > 0) parts.push(C.queuedAt(job.position))
  const share = phase === 'running' && job && job.progress > 0 ? job.progress : undefined
  return (
    <div className="m-k-box m-k-box--pad m-k-run" data-testid="m-create-computer-running" data-state={phase} aria-live="polite">
      <div className="m-k-run-line" data-testid="m-create-computer-running-line">
        {parts.join(' · ')}
      </div>
      {share === undefined ? (
        <div className="m-k-run-ring">
          <Progress label={C.phase[phase]} />
        </div>
      ) : (
        <Progress label={C.phase.running} value={share} testid="m-create-computer-progress" />
      )}
      <div className="m-cap" data-testid={run.waiting ? 'm-create-computer-waiting' : undefined}>
        {run.waiting ? C.waiting : C.leave}
      </div>
    </div>
  )
}

function ResultCard({ item, ids }: { item: GalleryItem; ids: string[] }) {
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
  const gallery = useCreateStore((s) => s.gallery)
  const others = ids.map((id) => gallery.find((g) => g.id === id)).filter((g): g is GalleryItem => !!g)
  const [shown, setShown] = useState(item.id)
  const current = others.find((g) => g.id === shown) ?? item
  return (
    <div className="m-k-box" data-testid="m-create-computer-result" data-m-id={current.id} data-m-kind={current.type}>
      <ResultMediaView key={current.id} item={current} openTestid="m-create-computer-result-open" />
      <div className="m-k-racts">
        <button type="button" data-testid="m-create-computer-save" {...riskProps('sensor')} disabled={!!working} onClick={() => void act('save', () => saveWithToast(current))}>
          <Icon icon={Download} small />
          {T.save}
        </button>
        <button type="button" data-testid="m-create-computer-share" {...riskProps('leaves-app')} disabled={!!working} onClick={() => void act('share', () => shareWithToast(current))}>
          <Icon icon={Share2} small />
          {T.share}
        </button>
        {storePolicy().reportContent ? (
          <button type="button" data-testid="m-create-computer-report" aria-label={T.policy.reportLabel(itemName(current, 40))} onClick={() => reportItem(current)}>
            <Icon icon={Flag} small />
            {T.policy.report}
          </button>
        ) : null}
        <button type="button" data-testid="m-create-computer-more" onClick={() => nav.openSheet('result', { id: current.id })}>
          <Icon icon={Ellipsis} small />
          {T.more}
        </button>
      </div>
      {others.length > 1 ? (
        <div className="m-chips m-k-strip" role="group" aria-label={T.gal.count(others.length)}>
          {others.map((g, i) => (
            <button key={g.id} type="button" className="m-k-thumb" aria-label={C.resultLabel(i + 1, others.length)} aria-current={g.id === current.id} data-testid="m-create-computer-thumb" onClick={() => setShown(g.id)}>
              {g.type === 'image' && g.dataUrl ? <img src={g.dataUrl} alt="" loading="lazy" /> : <Icon icon={g.type === 'video' ? Video : ImageIcon} />}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A picked photo as the computer takes it: bytes, a preview, its size. Null with a toast when it cannot go. */
async function readPhoto(file: File, limit: number): Promise<StartImage | null> {
  try {
    const ref = await loadPhoneImage(file)
    const bytes = new Uint8Array(await dataUrlToBlob(ref.url).arrayBuffer())
    if (limit && bytes.length > limit) {
      toast(C.imageTooLarge, { tone: 'error', testid: 'create-computer-image-large' })
      return null
    }
    return { bytes, preview: ref.url, width: ref.width, height: ref.height, ref }
  } catch {
    toast(C.imageUnreadable, { tone: 'error', testid: 'create-computer-image-bad' })
    return null
  }
}

/** Photos from the library or the camera into the form, at most what the tool takes. */
async function addPhotos(view: ComputerToolView, files: PickedFile[]): Promise<void> {
  const form = useComputerForm.getState()
  const room = view.limits.max - form.inputs.slice(0, view.limits.max).length
  if (room <= 0 || files.length === 0) return
  const limit = view.capsOk?.limits.maxUploadBytes ?? 0
  const read: StartImage[] = []
  for (const f of files.slice(0, room)) {
    const img = await readPhoto(f.file, limit)
    if (img) read.push(img)
  }
  if (files.length > room) toast(C.photosLeftOut(view.limits.max), { testid: 'create-computer-photos-left-out' })
  // Keep only what this tool uses, then add: a tool with one photo takes the new one.
  if (view.limits.max === 1 && read.length > 0) {
    useComputerForm.setState({ inputs: [], image: null, mask: null })
  }
  useComputerForm.getState().addInputs(read, view.limits.max)
}

function pickFromLibrary(view: ComputerToolView): void {
  void pickPhotos({ multiple: view.limits.max > 1 }).then((files) => addPhotos(view, files))
}

function pickFromCamera(view: ComputerToolView): void {
  void takePhoto().then((p) => addPhotos(view, p ? [p] : []))
}

/** The photos of the run: the start image, the photo to enhance or cut out, the references of an edit. */
function PhotosCard({ view, disabled }: { view: ComputerToolView; disabled: boolean }) {
  const mask = useComputerForm((s) => s.mask)
  const removeInput = useComputerForm((s) => s.removeInput)
  const setMask = useComputerForm((s) => s.setMask)
  const { tool, limits, used } = view
  if (limits.max === 0) return null
  // An optional start image (image, video) only shows once one is there; the composer has its "+".
  if (limits.min === 0 && used.length === 0) return null
  const full = used.length >= limits.max
  return (
    <div className="m-k-card" data-testid="m-create-computer-photos" data-m-count={used.length} data-state={mask ? 'masked' : 'plain'}>
      <span className="m-k-card-text">
        <span className="m-k-card-title">{C.photosTitle(tool)}</span>
        <span className="m-k-card-sub">{C.photosSub(tool, limits.max)}</span>
      </span>
      {used.length > 0 ? (
        <div className="m-chips m-k-strip" role="group" aria-label={C.photosTitle(tool)}>
          {used.map((img, i) => (
            <span key={img.preview.length + i * 7919 + img.width} className="m-k-ref" style={{ width: 72, height: 72 }}>
              <span className="m-k-thumb" style={{ width: 72, height: 72 }} aria-label={C.photoLabel(i + 1, used.length)} role="img" data-testid="m-create-computer-photo">
                <img src={img.preview} alt="" />
              </span>
              {disabled ? null : <RemoveX label={C.removePhoto(i + 1)} testid="m-create-computer-photo-remove" onPress={() => removeInput(i)} />}
            </span>
          ))}
        </div>
      ) : null}
      {!full ? (
        <div className="m-k-card-actions">
          <Button icon={Camera} onPress={() => pickFromCamera(view)} disabled={disabled} risk="sensor" testid="m-create-computer-photo-take">
            {C.takePhoto}
          </Button>
          <Button icon={Images} onPress={() => pickFromLibrary(view)} disabled={disabled} risk="sensor" testid="m-create-computer-photo-add">
            {C.library}
          </Button>
        </div>
      ) : null}
      {toolTakesMask(tool) && used.length > 0 ? (
        <>
          <span className="m-k-card-sub" data-testid="m-create-computer-mask-state">
            {mask ? C.areaSet : C.areaNone}
          </span>
          <div className="m-k-card-actions">
            <Button icon={Brush} onPress={() => nav.push('/create/computer-mask')} disabled={disabled} testid="m-create-computer-paint">
              {mask ? C.paintAgain : C.paintArea}
            </Button>
            {mask ? (
              <Button variant="quiet" onPress={() => setMask(null)} disabled={disabled} testid="m-create-computer-mask-remove">
                {C.removeArea}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

function CharacterCard({ view, disabled }: { view: ComputerToolView; disabled: boolean }) {
  const character = useComputerForm((s) => s.character)
  const setCharacter = useComputerForm((s) => s.setCharacter)
  const characters = view.capsOk?.characters
  const list = characters ?? []
  useEffect(() => {
    // The computer no longer has the picked one, or none is picked: take its first.
    if (characters && characters.length > 0 && !characters.some((c) => c.id === character)) setCharacter(characters[0].id)
  }, [characters, character, setCharacter])
  if (view.tool !== 'character' || list.length === 0) return null
  return (
    <div className="m-k-card" data-testid="m-create-computer-characters">
      <span className="m-k-card-text">
        <span className="m-k-card-title">{C.character}</span>
        <span className="m-k-card-sub">{C.characterSub}</span>
      </span>
      <ChipGroup label={C.character} role="radiogroup" testid="m-create-computer-character-list">
        {list.map((c) => (
          <Chip key={c.id} kind="choice" icon={UserRound} selected={c.id === character} onPress={() => setCharacter(c.id)} disabled={disabled} testid="m-create-computer-character">
            {c.name}
          </Chip>
        ))}
      </ChipGroup>
    </div>
  )
}

function MusicCard({ view, disabled }: { view: ComputerToolView; disabled: boolean }) {
  const lyrics = useComputerForm((s) => s.lyrics)
  const setLyrics = useComputerForm((s) => s.setLyrics)
  if (view.tool !== 'music' || !view.available) return null
  return (
    <div className="m-k-sec" data-testid="m-create-computer-music">
      <TextArea label={C.lyrics} value={lyrics} placeholder={C.lyricsPlaceholder} onChange={setLyrics} rows={3} maxLength={MAX_LYRICS} disabled={disabled} testid="m-create-computer-lyrics" />
    </div>
  )
}

function FactorCard({ view, disabled }: { view: ComputerToolView; disabled: boolean }) {
  const values = useComputerForm((s) => s.values)
  const setValue = useComputerForm((s) => s.setValue)
  const field = view.info?.fields.find((f) => f.key === 'factor')
  if (view.tool !== 'upscale' || !field?.enumNumbers || field.enumNumbers.length < 2) return null
  const v = String(shownValue(field, values) ?? field.enumNumbers[0])
  return (
    <div className="m-k-sec" data-testid="m-create-computer-factor">
      <div className="m-label">{C.factor}</div>
      <Segmented
        label={C.factor}
        options={field.enumNumbers.map((n) => ({ value: String(n), label: C.factorOption(n) }))}
        value={v}
        onChange={(x) => {
          if (!disabled) setValue('factor', Number(x))
        }}
        testid="m-create-computer-factor-choice"
      />
    </div>
  )
}

function Stage({ view, reload }: { view: ComputerToolView; reload: () => void }) {
  const run = useComputerRun()
  const avail = useComputerAvailability()
  const item = useGalleryItem(run.view === 'result' ? (run.resultIds[0] ?? null) : null)
  const busy = useBusy()
  const { caps, info, tool } = view
  const needsModel = !modelOptional(view.kind)
  return (
    <div className="m-k-stage" data-m-sparse="" data-testid="m-create-computer-stage" data-state={busy ? 'running' : run.view} data-m-media={mediaOfTool(tool)} data-m-tool={tool}>
      {caps.state === 'loading' ? <SkeletonCards cards={1} label={C.loading} testid="m-create-computer-loading" /> : null}
      {caps.state === 'error' ? (
        <Notice
          variant={caps.code === 'forbidden' ? 'warn' : 'error'}
          testid="m-create-computer-caps-error"
          actions={
            <Button compact onPress={reload} testid="m-create-computer-caps-retry">
              {C.retry}
            </Button>
          }
        >
          <span data-m-code={caps.code}>{caps.message}</span>
        </Notice>
      ) : null}
      {caps.state === 'ok' && caps.caps.busy && !busy ? <Notice testid="m-create-computer-busy">{C.busy}</Notice> : null}
      {caps.state === 'ok' && !view.available ? (
        <Notice variant="warn" title={C.unavailableTitle} testid="m-create-computer-unavailable">
          {view.reason}
        </Notice>
      ) : caps.state === 'ok' && needsModel && (!info || info.models.length === 0) ? (
        <Notice variant="warn" testid="m-create-computer-no-models">
          {C.noModels(tool === 'video' ? 'videos' : tool === 'music' ? 'music' : 'images')}
        </Notice>
      ) : null}
      {run.error && !busy ? (
        <Notice
          variant="error"
          title={C.failedTitle}
          testid="m-create-computer-error"
          actions={
            <Button compact onPress={dismissComputerError} testid="m-create-computer-error-ok">
              {C.dismiss}
            </Button>
          }
        >
          <span data-m-code={run.error.code}>{run.error.message}</span>
        </Notice>
      ) : null}
      {busy ? <Running /> : null}
      {!busy && item ? <ResultCard item={item} ids={run.resultIds} /> : null}
      {view.available ? (
        <>
          <PhotosCard view={view} disabled={busy} />
          <CharacterCard view={view} disabled={busy} />
          <FactorCard view={view} disabled={busy} />
          <MusicCard view={view} disabled={busy} />
        </>
      ) : null}
      {!busy && !item && view.available ? (
        <p className="m-k-hint" data-testid="m-create-computer-hint">
          <Icon icon={TOOL_ICON[tool]} />
          {view.limits.min > 0 && view.used.length === 0 ? T.tool[tool].empty : C.hint(avail.name)}
        </p>
      ) : null}
    </div>
  )
}

function StartButton({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  const run = useComputerRun()
  const busy = useBusy()
  return busy ? (
    <button type="button" className="m-btn" aria-busy={run.cancelling || undefined} data-testid="m-create-computer-cancel" onClick={run.cancelling ? undefined : () => void cancelComputerJob()}>
      <Icon icon={Square} small />
      <span>{run.cancelling ? C.cancelling : C.cancel}</span>
    </button>
  ) : (
    // No risk "paid": nothing is booked, the computer is the user's own.
    <Button variant="primary" icon={Sparkles} testid="m-create-computer-generate" disabled={disabled} onPress={onCreate}>
      {C.create}
    </Button>
  )
}

function placeholderOf(tool: ComputerTool): string {
  if (tool === 'image') return C.placeholderImage
  if (tool === 'video') return C.placeholderVideo
  if (tool === 'music') return C.placeholderStyle
  if (tool === 'edit') return C.placeholderEdit
  return T.tool[tool].placeholder
}

/** Pure enough: why Create cannot start now, or null. */
function blockOf(view: ComputerToolView, prompt: string, busy: boolean, model: { id: string } | null): string | null {
  if (busy || view.caps.state !== 'ok' || !view.available) return 'wait'
  if (!modelOptional(view.kind) && !model) return 'model'
  if (toolPrompt(view.tool) === 'yes' && !prompt.trim()) return 'prompt'
  if (view.used.length < view.limits.min) return 'photo'
  return null
}

function Composer({ view, onCreate, startBelow }: { view: ComputerToolView; onCreate: () => void; startBelow?: boolean }) {
  const prompt = useCreateStore((s) => s.prompt)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const blocked = useComputerRun((s) => s.blocked)
  const busy = useBusy()
  const form = useComputerForm()
  const ref = useRef<HTMLTextAreaElement>(null)
  const promptShown = toolPrompt(view.tool) !== 'no'
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [prompt, promptShown])
  const model = modelFor(view.info, form.models[view.kind])
  const line = summaryOf(view.info, form, view.kind).join(' · ')
  // The computer says when this size gets slow for the model (SD 1.5 above 768).
  const note = sizeNote(view.info, form, view.kind)
  const disabled = blockOf(view, prompt, busy, model) !== null
  // The "+" of 3.0.7: a start image for image and video. Edit, Enhance and Cutout have their card on the stage.
  const plus = view.limits.max > 0 && view.limits.min === 0 && view.used.length < view.limits.max

  return (
    <div className="m-composer-wrap" data-testid="m-create-computer-composer">
      {blocked ? (
        <div className="m-k-composer-note">
          <Notice variant="error" title={C.blockedTitle} testid="m-create-computer-blocked">
            {blocked}
          </Notice>
        </div>
      ) : null}
      {note ? (
        <div className="m-k-composer-note">
          <Notice variant="warn" testid="m-create-computer-size-note">
            {note}
          </Notice>
        </div>
      ) : null}
      <div className="m-composer">
        {promptShown ? (
          <textarea
            ref={ref}
            rows={1}
            value={prompt}
            placeholder={placeholderOf(view.tool)}
            aria-label={C.promptLabel}
            data-testid="m-create-computer-prompt"
            maxLength={4000}
            onChange={(e) => {
              setPrompt(e.target.value)
              clearComputerBlocked()
            }}
          />
        ) : null}
        {/* Prompt v2 (14.11.2026): one row. Settings with the summary, a start image where the tool takes one, Create. */}
        <div className="m-composer-row">
          <ComposerTuneButton
            summary={
              <>
                <b>{T.tool[view.tool].short}</b>
                {` · ${tuneSummary([model?.name ?? (modelOptional(view.kind) ? C.modelOwn : C.modelNone), line, C.computer])}`}
              </>
            }
            label={C.summaryLabel(tuneSummary([T.tool[view.tool].name, model?.name ?? (modelOptional(view.kind) ? C.modelOwn : C.modelNone), line, C.onYourComputer]))}
            onPress={() => nav.openSheet('create-computer')}
            testid="m-create-computer-settings"
          />
          {plus ? <IconButton icon={Paperclip} label={C.addImage} onPress={() => pickFromLibrary(view)} disabled={busy} risk="sensor" testid="m-create-computer-add-image" /> : null}
          {startBelow ? null : <StartButton onCreate={onCreate} disabled={disabled} />}
        </div>
      </div>
    </div>
  )
}

export default function ComputerSurface() {
  const avail = useComputerAvailability()
  const { reload } = useComputerCaps(true)
  const view = useComputerTool()
  const shape = useScreenShape()
  const prompt = useCreateStore((s) => s.prompt)
  const busy = useBusy()

  const onCreate = () => {
    if (view.caps.state !== 'ok') return
    const form = useComputerForm.getState()
    const model = modelFor(view.info, form.models[view.kind])
    if (blockOf(view, prompt, busy, model) !== null) return
    haptic('light')
    const promptText = toolPrompt(view.tool) === 'no' ? '' : prompt
    void startComputerJob({
      media: mediaOfTool(view.tool),
      tool: view.tool,
      body: jobBodyOf(view.kind, view.info, { ...form, character: view.tool === 'character' ? form.character : null }, promptText),
      modelName: model?.name ?? '',
      images: view.kind === 'image' || view.kind === 'video' || view.kind === 'music' ? [] : view.used.map((i) => i.bytes),
      mask: view.kind === 'edit' ? (form.mask?.bytes ?? null) : null,
      uploadLimit: view.caps.caps.limits.maxUploadBytes,
    })
  }
  const model = modelFor(view.info, useComputerForm.getState().models[view.kind])
  const disabled = blockOf(view, prompt, busy, model) !== null

  const composer = <Composer view={view} onCreate={onCreate} startBelow={shape === 'low'} />
  const stage = <Stage view={view} reload={reload} />
  return (
    <RootPage
      title={T.title}
      screen="create"
      bareFooter
      actions={
        <>
          {avail.features.includes('tasks') ? (
            <IconButton icon={ListTodo} label={RS.shared.tasks} onPress={() => nav.openSheet('remote-tasks')} testid="m-create-computer-tasks" />
          ) : null}
          <IconButton icon={LayoutGrid} label={T.gallery} onPress={() => nav.push('/create/gallery')} testid="m-create-gallery" el="K1.2" />
        </>
      }
      footer={
        shape === 'tall' ? (
          composer
        ) : shape === 'low' ? (
          <div className="m-composer-wrap m-k-startbar" data-testid="m-create-computer-startbar">
            <StartButton onCreate={onCreate} disabled={disabled} />
          </div>
        ) : undefined
      }
    >
      {shape === 'tall' ? (
        stage
      ) : (
        <div className={shape === 'wide' ? 'm-k-wide' : 'm-k-low'} data-testid="m-create-computer-layout" data-state={shape}>
          <div className="m-k-layout-side">{composer}</div>
          <div className="m-k-layout-main">{stage}</div>
        </div>
      )}
    </RootPage>
  )
}
