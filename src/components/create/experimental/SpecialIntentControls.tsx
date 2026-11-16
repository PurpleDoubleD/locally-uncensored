// Composer surfaces for the 2.5.8 specialized Create categories
// (Character-Studio, talking character, music, extend, motion). Each intent
// owns exactly the inputs its lane consumes; everything stages into
// createStore slots. On the cloud backend useCloudCreate submits them; since
// 2.5.8 music / lipsync / extend / motion also run locally (useCreate's
// specialized lanes), and the surfaces below fork only where the two lanes
// genuinely differ (extend's source pick, the cloud voice maker).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePopoverPlatz } from '../../../hooks/usePopoverPlatz'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AudioLines, ChevronDown, Download, Film, Info, Loader2, Mic, Music2, Trash2, Upload, Wand2, X,
} from 'lucide-react'
import { useCreateStore, type CreateIntent, type GalleryItem, type SwapFigure } from '../../../stores/createStore'
import { useCloudCatalogStore, cloudModelById, lengthCredits, lengthPrice, modelForOp } from '../../../stores/cloudCatalogStore'
import { deleteLora, downloadLora, type CloudLora, type LoraDownloadProgress } from '../../../api/cloud/loras'
import { errorText } from '../../../types/json-guards'
import {
  characterTrainerStatus, deleteLocalCharacter, installCharacterTrainer,
  TRAINER_BASE_FILES, baseDownloadRunning, baseDownloadPercent, missingTrainerBases, missingBasesLine, aboutSize, baseBytes,
  baseStartFailedNote, basesStillMissingNote, type TrainerBaseFile, type TrainerStatus,
} from '../../../api/trainer'
import { startModelDownload, getDownloadProgress, catalogDigestFor } from '../../../api/discover'
import { useDownloadStore } from '../../../stores/downloadStore'
import { refreshComfyModels } from '../../../api/comfyui'
import { isMlxImageHost } from '../../../api/mlx-image'
import { buildMlxVideoModels, listVideoModels, mlxTalkingEntry, mlxVideoModelIdFor } from '../../../api/mlx-video'
import { openMlxLoraFolder } from '../../../api/mlx-loras'
import { getMacTrainStatus, macTrainMissing, macTrainNote, type MacTrainStatus } from '../../../api/mlx-train'
import { useUIStore } from '../../../stores/uiStore'
import { useModelStore } from '../../../stores/modelStore'
import { characterLoraFile } from '../../../lib/characters'
import { isWindows, isMacOS } from '../../../api/backend'
import { LOCAL_MUSIC_TEXT, SECONDS_LENGTH, musicHowtoLines, musicLength, musicText } from '../../../lib/render/music-ui'
import { MAC_MUSIC_MIN_SECONDS } from '../../../lib/mac-music'
import { createRunModel, studioShownValue } from '../../../lib/render/create-studio'
import { STUDIO_MODELS, studioFields } from '../../../lib/render/studio-contract'
import { modelLabel } from '../../../lib/render/preset-models'
import {
  SWAP_AUTO_MODELS, SWAP_CONSENT_TEXT, SWAP_INTENT, SWAP_OPENJUTSU_MODEL, SWAP_TIPS, swapAutoModel,
  swapDefaultOptions, swapFigureRoles, swapClipLimits, swapMaxPeople, swapNeedsConsent, swapShortCredits, swapUsesFrame,
} from '../../../lib/render/swap'
import {
  LIPSYNC_ONE_PERSON, LIPSYNC_STEP_DEFAULT, LIPSYNC_STEP_MODELS, SOUND_CHOICES, SOUND_LABEL, lipsyncBlocked, lipsyncCredits, lipsyncCut,
  lipsyncSeconds, soundApplies, soundClipSeconds, type SoundChoice,
} from '../../../lib/render/sound'
import { getJob } from '../../../api/cloud/jobs'
import { SwapFrameBuild, SwapFramePicker, useSwapFirstFrame } from './SwapFrameSteps'
import { CharacterPick, HubLine, UploadLine } from './hub/HubParts'
import { hubPortrait, hubPortraitName } from './hub/hubCharacters'
import { HUB_SWAP_SOON } from '../../../lib/create/character-hub'
import { useCharacterHubReleased } from '../../../lib/create/character-hub-release'
import { mediaSeconds } from './useStudioPrice'
import { galleryLabelShort } from '../../../lib/render/gallery-label'
import { TRAIN_VRAM_PRESETS, LOW_VRAM_NOTE, trainStepsNote, trainVramSuggestion, type TrainVramPreset } from '../../../lib/trainer-presets'
import { STYLE_MODE_NOTE, STYLE_NAME_PLACEHOLDER, STYLE_TRIGGER_HINT_OFF, STYLE_TRIGGER_HINT_ON, STYLE_TRIGGER_LABEL, TRAIN_KINDS, trainPresetsFor, type TrainKind } from '../../../lib/train-kind'
import { useGraphicsCardGb } from '../../../hooks/useGraphicsMemory'
import { BetaMark } from '../../ui/BetaMark'
import { trainerPathPlaceholder } from '../../../lib/trainer-path-placeholder'
import { trainerRootHint } from '../../../lib/trainer-root-hint'
import { useCreateExp } from './CreateContext'
import { CharacterUseLocally } from './CharacterUseLocally'
import { CLOUD_TRAINING_FAMILY_NOTE, localTrainingFamilyNote } from '../../../api/character-import'
import { useLocalPick } from './localPick'
import { characterBaseModel, characterRunBlock } from '../../../lib/character-base'
import { HINWEIS_TEXT } from '../../../lib/hinweis'
import { lastFrame } from '../../../lib/video-frames'
import { loadImageRef } from './loadImage'
import { mediaRefFrom } from './mediaRef'
import { fetchGalleryItemBlob } from './galleryUrl'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { Slider } from '../ui/Slider'
import { cn } from '../ui/cn'
import { useClickAway } from '../ui/useClickAway'
import { Modal } from '../../ui/Modal'
import { useTrainReplaceStore } from '../../../stores/trainReplaceStore'
import { ModalActions, ModalButton } from '../../ui/ModalActions'
import { MIN_TRAIN_IMAGES, maxTrainImages } from '../../../lib/train-image-cap'

export function SpecialControls({ intent }: { intent: CreateIntent }) {
  switch (intent) {
    case 'character': return <CharacterPanel />
    case 'lipsync': return <LipsyncControls />
    case 'music': return <MusicControls />
    case 'extend': return <ExtendControls />
    case 'motion': return <MotionControls />
    case 'swap_character': return <SwapControls />
    default: return null
  }
}

// The file inputs of Motion, Talk and Swap are lines of the Character area
// (hub/HubParts UploadLine, PortraitLine and DrivingVideoLine below).
// `mediaRefFrom` comes from `./mediaRef`, whose counterpart in createStore is
// `releaseDroppedMediaRefs`. Do NOT revoke in this file: the ref outlives the
// component, it lives in the store.

// ── Character-Studio ────────────────────────────────────────────────────────


/** Saves a trained cloud character as a file. The weights are the customer's
 *  own, a few hundred megabytes: the button shows how far the file is, and a
 *  failure lands in the red bar of the Create surface. Once the place is
 *  picked and the file comes in, a second button cancels it: the backend drops
 *  the connection and removes the unfinished file, and the row says so. */
function CharacterDownload({ lora }: { lora: CloudLora }) {
  const [progress, setProgress] = useState<LoraDownloadProgress | null>(null)
  // Set while the backend is downloading, which is when there is something to cancel.
  const [running, setRunning] = useState<AbortController | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const busy = progress !== null
  const percent = progress && progress.total > 0 ? Math.floor((progress.received / progress.total) * 100) : null
  const start = () => {
    if (busy) return
    const controller = new AbortController()
    setCancelled(false)
    setProgress({ received: 0, total: 0 })
    void downloadLora(lora, (p) => { setProgress(p); setRunning(controller) }, controller.signal)
      .then((end) => { if (end === 'stopped') setCancelled(true) })
      .catch((err: unknown) => useCreateStore.getState().setError(`Download failed: ${errorText(err)}`))
      .finally(() => { setProgress(null); setRunning(null); setCancelling(false) })
  }
  return (
    <>
      <button
        onClick={start}
        disabled={busy}
        className={cn('flex items-center gap-1 p-1', busy ? 'text-gray-400' : 'text-gray-600 hover:text-gray-200')}
        title={busy ? `Saving the .safetensors file${percent === null ? '…' : `, ${percent}%`}` : 'Download the .safetensors file'}
        aria-label="Download character"
        data-testid="character-download"
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
        {percent !== null && <span className="t-micro tabular-nums">{percent}%</span>}
      </button>
      {running && (
        <button
          onClick={() => { setCancelling(true); running.abort() }}
          disabled={cancelling}
          className={cn('p-1', cancelling ? 'text-gray-500' : 'text-gray-600 hover:text-red-400')}
          title={cancelling ? 'Cancelling the download…' : 'Cancel the download'}
          aria-label="Cancel download"
          data-testid="character-download-cancel"
        >
          <X size={11} />
        </button>
      )}
      {cancelled && (
        <span role="status" className="t-micro text-gray-500 px-1" data-testid="character-download-cancelled">
          Download cancelled
        </span>
      )}
    </>
  )
}

function CharacterPanel() {
  const backend = useCreateStore((s) => s.backend)
  const characterTab = useCreateStore((s) => s.characterTab)
  const triggerWord = useCreateStore((s) => s.triggerWord)
  const setTriggerWord = useCreateStore((s) => s.setTriggerWord)
  const trainImages = useCreateStore((s) => s.trainImages)
  const localLane = backend !== 'cloud'

  // In the Character area the head line picks the character and says
  // whether this is Image (use) or a new training (sketches v2). The shelf of
  // chips and the Train/Use switch that stood here are steps 1 and 2 now.
  return (
    <div className="space-y-2">
      <TrainReplaceDialog />
      {characterTab === 'train' && localLane && isMlxImageHost() ? (
        <MacTrainControls />
      ) : characterTab === 'train' && localLane ? (
        <LocalTrainControls />
      ) : characterTab === 'use' && localLane ? (
        <LocalCharacterNotes />
      ) : characterTab === 'train' ? (
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <input
            value={triggerWord}
            onChange={(e) => setTriggerWord(e.target.value)}
            placeholder="Trigger word, e.g. davechar"
            className="t-control w-44 px-2.5 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15"
          />
          <TriggerWordNote />
          <span className="t-label text-gray-600">
            {trainImages.length}/{maxTrainImages(backend)} photos added{trainImages.length < MIN_TRAIN_IMAGES ? `, need at least ${MIN_TRAIN_IMAGES}` : ''}
          </span>
          {/* Said before the training, not after it (3.0.8): only a Z-Image
              character can come to this computer. */}
          <p data-testid="cloud-train-family-note" className={`w-full text-center t-micro ${HINWEIS_TEXT.ruhig}`}>
            {CLOUD_TRAINING_FAMILY_NOTE}
          </p>
        </div>
      ) : (
        <CloudCharacterNotes />
      )}
    </div>
  )
}

/** Image with a cloud character: the one sentence the run needs. */
function CloudCharacterNotes() {
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  return (
    <p className="hub-dim pt-3 text-center hub-fs-125" data-testid="character-use-hint">
      {selectedCharacter
        ? <>Put “{selectedCharacter.triggerWord}” in your prompt to summon the character.</>
        : 'Pick a character in the head line, or train one from photos.'}
    </p>
  )
}

// Das Trainer-Installationspfad-Feld des Erstsetup-Gates. `status` speist nur
// `trainerRootHint`; Wert und Aenderungs-Handler gehoeren dem Aufrufer.
//
// A1-Korrektur (Final Review, 19.09.2026): dieses Feld war bis eben auch im
// Reinstall-Dialog, mit demselben Ordner vorbelegt. Das war der Blocker: ein
// Kunde, der bloss bestaetigt, schickte seinen bestehenden Standardordner als
// nicht-leeren Pfad an install_character_trainer, und trainer_root_is_customized()
// kippte auf true, obwohl sich nichts geaendert hatte -- die Cache-Migration
// (apply_trainer_cache_env, trainer.rs:363) griff dann fuer einen Kunden, der
// sie nie ausgeloest hatte, und liess pip/Torch mehrere GB neu laden, die
// schon auf der Platte lagen. Der Reinstall-Dialog zeigt den Ordner jetzt nur
// noch als Text (siehe TrainerReinstallModal) und schickt denselben leeren
// bzw. vorbelegten Pfad wie vor dem Z5-Umbau.
function TrainerPathField({
  value,
  onChange,
  status,
}: {
  value: string
  onChange: (v: string) => void
  status: Pick<TrainerStatus, 'root' | 'customized' | 'suggestedRoot'>
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`e.g. ${trainerPathPlaceholder(isWindows(), isMacOS())}`}
        className="t-control w-64 px-2.5 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15"
      />
      <span className="t-label text-gray-600">{trainerRootHint(status, value, status.suggestedRoot)}</span>
    </div>
  )
}

// Z5 (box-gruen/b, e2e Windows, 18.09.2026): "Reinstall trainer" hat bisher
// install_character_trainer im selben Moment ausgeloest, in dem der Knopf
// geklickt wurde, ohne Bestaetigung, ohne Chance, vorher zu sehen, was
// passiert. Die Rust-Seite loescht `<root>` dabei NICHT (siehe Doc-Kommentar
// von provision_trainer_env: `<root>/train` und `<root>/models` werden nie
// angefasst), ersetzt aber die venv (Rebuild oder Torch/musubi neu
// installieren, siehe `venv_action`), und genau das hat den Tester auf
// box-gruen mitten im Klick ueberrascht. Dieser Dialog sagt das ehrlich und
// ruft den Install-Befehl erst auf, wenn der Kunde "Reinstall" drueckt.
//
// A1/Blocker-Korrektur (Final Review, 19.09.2026): der Ordner ist hier nur
// noch Text, nicht editierbar. Ein editierbares Feld, vorbelegt mit dem
// bestehenden Ordner, hat jeden gewoehnlichen Reinstall (Kunde bestaetigt
// ohne etwas zu aendern) zu einem "customized" Pfad gemacht und damit den
// Cache-Migrationsschutz ausgeloest, den es hier nicht geben soll. Einen
// anderen Ordner fuer den Trainer waehlen geht weiterhin nur ueber das
// Erstsetup-Gate (TrainerPathField oben, bevor envReady zum ersten Mal wahr
// wird); ein Weg, das nach der Erstinstallation zu aendern, existiert in der
// App bisher nicht.
function TrainerReinstallModal({
  open,
  onClose,
  status,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  status: TrainerStatus
  onConfirm: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Reinstall the trainer?">
      <div className="space-y-4 text-sm text-gray-200">
        <p className="t-body leading-relaxed text-gray-300">
          This sets up the trainer's Python environment again: PyTorch and musubi-tuner get reinstalled. Your training photos and downloaded base models are not touched. Setup needs about 3 GB of downloads, same as the first install.
        </p>
        <p className="t-label text-gray-500 text-center">Trainer folder: {status.root}</p>
        <ModalActions>
          <ModalButton variant="quiet" onClick={onClose} data-autofocus>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={onConfirm} data-destructive>
            Reinstall
          </ModalButton>
        </ModalActions>
      </div>
    </Modal>
  )
}

// Local training readiness + inputs (2.5.8 A5). Three gates render in order:
// trainer env (one-time musubi setup) -> Z-Image base files -> the actual
// trigger/steps inputs. The Rust side is the source of truth for readiness.
// 3.0.9 P8: Character or Style / concept, above the inputs of both local
// trainers (CUDA and Mac). The cloud trains characters only, so it has none.
function TrainKindPicker() {
  const trainKind = useCreateStore((s) => s.trainKind)
  const setTrainKind = useCreateStore((s) => s.setTrainKind)
  const trainStyleTrigger = useCreateStore((s) => s.trainStyleTrigger)
  const setTrainStyleTrigger = useCreateStore((s) => s.setTrainStyleTrigger)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  return (
    <div className="flex flex-col items-center gap-1" data-testid="train-kind">
      <div className="flex items-center gap-1.5">
        <Segmented
          size="sm"
          layoutId="train-kind"
          value={trainKind}
          onChange={(v) => { if (!isGenerating) setTrainKind(v as TrainKind) }}
          options={TRAIN_KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
        {/* Beta stands for the style mode only (lib/beta.ts). */}
        <BetaMark feature="style-training" />
      </div>
      {trainKind === 'style' && (
        <>
          <div className="t-label text-gray-500 max-w-[560px] text-center" data-testid="style-mode-note">{STYLE_MODE_NOTE}</div>
          <label className="t-label text-gray-400 flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={trainStyleTrigger}
              disabled={isGenerating}
              onChange={(e) => setTrainStyleTrigger(e.target.checked)}
              data-testid="style-trigger"
            />
            {STYLE_TRIGGER_LABEL}
          </label>
          <div className="t-label text-gray-600 max-w-[560px] text-center" data-testid="style-trigger-hint">
            {trainStyleTrigger ? STYLE_TRIGGER_HINT_ON : STYLE_TRIGGER_HINT_OFF}
          </div>
        </>
      )}
    </div>
  )
}

function LocalTrainControls() {
  const triggerWord = useCreateStore((s) => s.triggerWord)
  const setTriggerWord = useCreateStore((s) => s.setTriggerWord)
  const trainImages = useCreateStore((s) => s.trainImages)
  const trainSteps = useCreateStore((s) => s.trainSteps)
  const setTrainSteps = useCreateStore((s) => s.setTrainSteps)
  const trainKind = useCreateStore((s) => s.trainKind)
  const presets = trainPresetsFor(trainKind)
  const trainVramPreset = useCreateStore((s) => s.trainVramPreset)
  const setTrainVramPreset = useCreateStore((s) => s.setTrainVramPreset)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  // 3.0.8 D20: the card's memory, for the Low VRAM suggestion under the
  // switch. The same reading the Model Manager uses (one probe per app run).
  const cardGb = useGraphicsCardGb()
  const vramHint = trainVramSuggestion(cardGb, trainVramPreset)
  const [status, setStatus] = useState<TrainerStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'bases' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // K5 (DIE-301-LISTE, Discord "Storage"): the trainer's
  // venv, torch and its pip/HF/torch caches all follow `trainer_root`
  // (see apply_trainer_cache_env in commands/trainer.rs), but nothing ever
  // let a customer set `trainer_root` in the first place, so the redirect
  // never fired for anyone. This is the smallest honest fix: the same
  // "type a path, it becomes the install target" control Settings > ComfyUI
  // already uses for install_comfyui, reused here for the one other local
  // installer that downloads multiple GB. Left empty, install_character_trainer
  // keeps its existing default (the app data folder), so this changes
  // nothing for a customer who never touches it.
  //
  // `typedPath` holds only what the customer actually typed. Lint-Fix
  // (react-hooks/set-state-in-effect, 19.09.2026): this used to be a second
  // piece of state (`installPath`) kept in sync with `status` through a
  // `useEffect` that called `setInstallPath` on every status/pathTouched
  // change. That is exactly the anti-pattern the rule flags -- state derived
  // from other state belongs in render, not in an effect that races the
  // render it is meant to feed. `installPath` below is now computed directly
  // from `typedPath`, `pathTouched` and `status` on every render; see
  // bau/lintfix.md for the truth table proving this is not a behavior change.
  const [typedPath, setTypedPath] = useState('')
  // K5 Nachbesserung, point 3: once the customer has typed anything (or the
  // field was pre-filled and they clear it on purpose), stop overwriting
  // their edit with the backend's current root on every poll.
  const [pathTouched, setPathTouched] = useState(false)
  // Z5 (box-gruen/b): der Bestaetigungsdialog vor "Reinstall trainer".
  const [reinstallOpen, setReinstallOpen] = useState(false)

  const refresh = useCallback(() => {
    characterTrainerStatus().then(setStatus).catch(() => setStatus(null))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  // Only the files this machine lacks get downloaded, named and sized (box
  // run: z_image_bf16 alone was missing, the line said 19 GB). The poll below
  // reads them through the ref so its interval does not restart per status.
  const missingBases = useMemo(() => (status ? missingTrainerBases(status) : []), [status])
  const missingRef = useRef(missingBases)
  useEffect(() => { missingRef.current = missingBases }, [missingBases])
  // Files of this click that did not start, with the reason. The progress
  // line of the others would otherwise overwrite them two seconds later.
  const startProblems = useRef<string[]>([])

  // K5 Nachbesserung, point 3: the field must always show the actually
  // valid path, not stay blank while a customized root is already active
  // (the old bug behind Blocker 2 -- a broken customized install re-showed
  // this gate with an empty field and a caption that still claimed the app
  // data default).
  //
  // Teil 10, point 3 (Opus review of `3ef38668`): a customer who never opens
  // this gate never learns that `suggestedRoot` exists at all -- it used to
  // sit only in the grayed-out placeholder, invisible the moment the field
  // has focus and gone the instant anything is typed. Nothing here moves an
  // EXISTING install: this only pre-fills the field, with a real, editable,
  // clearable value, and only while there is no trainer yet (this whole
  // gate only renders before `envReady`) and no customized root of the
  // customer's own to preserve.
  const installPath = pathTouched ? typedPath : status?.customized ? status.root : (status?.suggestedRoot ?? '')

  // A base-file download outlives this panel. Leave the tab and come back and
  // the button read "Download base files" again with no note, while the 19 GB
  // kept flowing in the tray (Phase G, Windows box, 06.09.2026). On mount the
  // meter picks a running download back up, and the poll below carries on.
  useEffect(() => {
    let live = true
    getDownloadProgress()
      .then((prog) => { if (live && baseDownloadRunning(prog)) setBusy('bases') })
      .catch(() => {})
    return () => { live = false }
  }, [])

  // While an install or a bases download runs, poll its progress into `note`.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(async () => {
      if (busy === 'install') {
        const s = await characterTrainerStatus().catch(() => null)
        if (!s) return
        setStatus(s)
        const last = s.install.logs[s.install.logs.length - 1]
        if (last) setNote(last)
        if (s.install.status !== 'installing') {
          setBusy(null)
          if (s.install.status === 'complete') setNote(null)
        }
      } else {
        const prog = await getDownloadProgress().catch(() => ({} as Record<string, { progress: number; total: number; status: string; filename: string; error?: string }>))
        const fetching = missingRef.current
        const pct = baseDownloadPercent(prog, fetching.length ? fetching.map((f) => f.filename) : undefined)
        if (pct !== null) {
          const size = aboutSize(baseBytes(fetching.length ? fetching : TRAINER_BASE_FILES))
          setNote([`Downloading base files (${pct}% of ${size})...`, ...startProblems.current.map((p) => `Did not start: ${p}`)].join('\n'))
          return
        }
        const failed = TRAINER_BASE_FILES.map((f) => prog[f.filename]).find((r) => r?.status === 'error')
        const s = await characterTrainerStatus().catch(() => null)
        if (s) setStatus(s)
        if (failed) {
          setNote(failed.error ?? 'Download failed. Check your connection and retry.')
          setBusy(null)
        } else if (s?.basesReady) {
          setNote(null)
          setBusy(null)
        } else if (s) {
          // Nothing is coming in any more and files are still missing.
          setNote(basesStillMissingNote(missingTrainerBases(s)))
          setBusy(null)
        }
      }
    }, 2000)
    return () => clearInterval(t)
  }, [busy])

  const runInstall = async (path: string) => {
    setBusy('install')
    setNote('Setting up the trainer...')
    try { await installCharacterTrainer(path.trim() || undefined) } catch (e) {
      setNote(e instanceof Error ? e.message : 'Install could not start.')
      setBusy(null)
    }
  }
  // The setup-gate button keeps using whatever the customer typed there
  // (or the pre-filled suggestion, or their own customized root).
  const startInstall = () => runInstall(installPath)
  // B1-Korrektur (Final Review Teil 17, review-teil17-lintfix.md): a
  // reinstall must NEVER move the trainer folder. `installPath` above also
  // carries `suggestedRoot` once no customized root exists (so the
  // erstsetup gate can show it), but that suggestion is for the FIRST
  // installation only. Sending it here on a bare "confirm the reinstall"
  // click wrote it into `trainer_root`, flipped
  // `trainer_root_is_customized()` to true for a customer who never
  // touched this setting, and moved the pip/HF/torch caches away from an
  // existing installation -- exactly the migration this dialog's text
  // ("training photos and downloaded base models are not touched")
  // promises will not happen. A reinstall therefore sends the customer's
  // own root only if the trainer is already customized, and `undefined`
  // (the default, i.e. today's location) in every other case.
  const confirmReinstall = async () => {
    setReinstallOpen(false)
    await runInstall(status?.customized ? status.root : '')
  }
  const startBases = async () => {
    if (!status) return
    setBusy('bases')
    setNote('Starting the downloads...')
    const missing = missingTrainerBases(status)
    // Same tray registration the Create install cards do: without it the header
    // Downloads tray reads "No active downloads" through a multi GB transfer and
    // its cancel + retry buttons never appear.
    const dl = useDownloadStore.getState()
    if (missing.length > 1) dl.setBundleGroup('Character Studio base models', missing.map((f) => f.filename))
    startProblems.current = []
    const alreadyThere: TrainerBaseFile[] = []
    let started = 0
    for (const f of missing) {
      dl.setMeta(f.filename, f.url, f.subfolder)
      try {
        const d = catalogDigestFor(f.filename, f.url)
        const r = await startModelDownload(f.url, f.subfolder, f.filename, d.expectedBytes, d.sha256)
        if (r?.status === 'started' || r?.status === 'already_running') started++
        else if (r?.status === 'exists') alreadyThere.push(f)
        else startProblems.current.push(`${f.label}: ${r?.error ?? 'the download did not start.'}`)
      } catch (e) {
        startProblems.current.push(`${f.label}: ${e instanceof Error ? e.message : 'the download did not start.'}`)
      }
      dl.startPolling()
    }
    if (started > 0) {
      if (startProblems.current.length) setNote(startProblems.current.map((p) => `Did not start: ${p}`).join('\n'))
      return
    }
    // Nothing is coming in. A file the downloader found already in place
    // may be readable to the trainer now (it asks the same folders), so look
    // again before saying anything.
    const s = await characterTrainerStatus().catch(() => null)
    if (s) setStatus(s)
    setBusy(null)
    setNote(s?.basesReady ? null : baseStartFailedNote(alreadyThere, startProblems.current))
  }

  if (!status) {
    return <div className="t-label text-gray-600 text-center">Checking the local trainer…</div>
  }
  if (!status.envReady || (busy === 'install' && status.install.status === 'installing')) {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <span className="t-label text-gray-500">Trains fully on your GPU. One time setup, about 3 GB.</span>
          <Button size="sm" variant="secondary" icon={Download} loading={busy === 'install'} disabled={busy === 'install'} onClick={startInstall}>
            {busy === 'install' ? 'Setting up…' : 'Set up trainer'}
          </Button>
        </div>
        {busy !== 'install' && (
          <TrainerPathField
            value={installPath}
            onChange={(v) => { setTypedPath(v); setPathTouched(true) }}
            status={status}
          />
        )}
        {note && <div role="status" tabIndex={0} className="text-xs leading-relaxed text-gray-600 max-w-[520px] max-h-40 overflow-y-auto select-text whitespace-pre-wrap text-center break-words">{note}</div>}
      </div>
    )
  }
  if (!status.basesReady) {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2">
          <span className="t-label text-gray-500">{missingBasesLine(missingBases)}</span>
          <Button size="sm" variant="secondary" icon={Download} loading={busy === 'bases'} disabled={busy === 'bases'} onClick={startBases}>
            {busy === 'bases' ? 'Downloading…' : 'Download base files'}
          </Button>
        </div>
        {/* K5 Blocker 3 (Opus review of `4fda5a0a`): these bytes go through
            download_model, which follows your configured model folder
            (Settings, ComfyUI), not the trainer folder set on the previous
            screen. Said here so the setup does not read as one place for
            everything the trainer downloads. */}
        <span className="t-label text-gray-600">Goes to your configured model folder (Settings, ComfyUI).</span>
        {note && <div role="status" tabIndex={0} className="text-xs leading-relaxed text-gray-600 max-w-[520px] max-h-40 overflow-y-auto select-text whitespace-pre-wrap text-center break-words">{note}</div>}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <TrainKindPicker />
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <input
          value={triggerWord}
          onChange={(e) => setTriggerWord(e.target.value)}
          placeholder={trainKind === 'style' ? STYLE_NAME_PLACEHOLDER : 'Trigger word, e.g. davechar'}
          aria-label={trainKind === 'style' ? 'Style name' : 'Trigger word'}
          className="t-control w-44 px-2.5 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15"
        />
        <TriggerWordNote />
        <Segmented
          size="sm"
          layoutId="train-steps"
          value={String(trainSteps)}
          onChange={(v) => setTrainSteps(Number(v))}
          options={presets.map((p) => ({ value: String(p.steps), label: p.label }))}
        />
        <Segmented
          size="sm"
          layoutId="train-vram"
          value={trainVramPreset}
          onChange={(v) => setTrainVramPreset(v as TrainVramPreset)}
          options={TRAIN_VRAM_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
        />
        <span className="t-label text-gray-600">
          {trainImages.length}/{maxTrainImages('local')} {trainKind === 'style' ? 'pictures' : 'photos'}{trainImages.length < MIN_TRAIN_IMAGES ? `, need at least ${MIN_TRAIN_IMAGES}` : ''}
        </span>
      </div>
      {!isGenerating && (
        <div className="t-label text-gray-600 flex items-center gap-1.5">
          {/* Die Klammer nennt die Stufe UND die Zahl. Fund 2 der Kampagne
              3.0.0: `(400 STEPS)` allein sagt nicht, welche der drei Stufen
              gerade gilt, und ein Tester hielt Quick deshalb fuer wirkungslos,
              obwohl Quick genau diese 400 sind. */}
          <span>Runs on your GPU and takes a while ({trainStepsNote(trainSteps, presets)}). The local chat model pauses for the run. The {trainKind === 'style' ? 'style' : 'character'} lands in your local LoRAs.</span>
          {/* The run repairs its own environment now (A2), so this is no
              longer the only way out of a broken install. It stays because
              the button used to render ONLY while the environment counted as
              not ready, which is exactly when a customer with a stale torch
              build could not reach it (D#102). */}
          <button
            type="button"
            onClick={() => setReinstallOpen(true)}
            disabled={busy === 'install'}
            className="underline underline-offset-2 text-gray-500 hover:text-gray-300 disabled:opacity-50 transition-colors"
          >
            {busy === 'install' ? 'Reinstalling…' : 'Reinstall trainer'}
          </button>
        </div>
      )}
      {!isGenerating && (
        <div className="t-label text-gray-600 max-w-[560px] text-center" data-testid="local-train-family-note">{localTrainingFamilyNote(trainKind)}</div>
      )}
      {!isGenerating && trainVramPreset === 'low-vram' && (
        <div className="t-label text-gray-600 max-w-[560px] text-center" data-testid="low-vram-note">{LOW_VRAM_NOTE}</div>
      )}
      {!isGenerating && vramHint && (
        <div className="t-label text-gray-500 flex items-center justify-center gap-1.5 flex-wrap max-w-[560px] text-center" data-testid="low-vram-suggestion">
          <span>{vramHint.text}</span>
          {vramHint.switchTo && (
            <button
              type="button"
              onClick={() => setTrainVramPreset(vramHint.switchTo as TrainVramPreset)}
              className="underline underline-offset-2 text-gray-400 hover:text-gray-200 transition-colors"
            >
              Use Low VRAM
            </button>
          )}
        </div>
      )}
      {note && <div role="status" tabIndex={0} className="text-xs leading-relaxed text-gray-600 max-w-[520px] max-h-40 overflow-y-auto select-text whitespace-pre-wrap text-center break-words">{note}</div>}
      <TrainerReinstallModal
        open={reinstallOpen}
        onClose={() => setReinstallOpen(false)}
        status={status}
        onConfirm={confirmReinstall}
      />
    </div>
  )
}

// Training a character on the Mac: the trainer of the Mac's own image engine
// (api/mlx-train.ts), on the Z-Image Turbo pack Create runs. The inputs are
// the ones of the Windows trainer; the gates are the Mac's: the Z-Image pack
// and enough memory. The run itself is the Create button, like on Windows.
function MacTrainControls() {
  const triggerWord = useCreateStore((s) => s.triggerWord)
  const setTriggerWord = useCreateStore((s) => s.setTriggerWord)
  const trainImages = useCreateStore((s) => s.trainImages)
  const trainSteps = useCreateStore((s) => s.trainSteps)
  const setTrainSteps = useCreateStore((s) => s.setTrainSteps)
  const trainKind = useCreateStore((s) => s.trainKind)
  const presets = trainPresetsFor(trainKind)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const setView = useUIStore((s) => s.setView)
  const setCategoryFilter = useModelStore((s) => s.setCategoryFilter)
  const [status, setStatus] = useState<MacTrainStatus | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    getMacTrainStatus()
      .then((s) => { if (live) setStatus(s) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [isGenerating])

  if (failed) {
    return <div className="t-label text-gray-600 text-center" data-testid="mac-train-note">The trainer could not be asked whether it is ready. Restart the app and try again.</div>
  }
  if (!status) {
    return <div className="t-label text-gray-600 text-center">Checking the trainer…</div>
  }
  if (status.memoryRefusal) {
    return <div role="alert" className={cn('t-label text-center max-w-md mx-auto', HINWEIS_TEXT.fehler)} data-testid="mac-train-note">{status.memoryRefusal}</div>
  }
  // GH #194: without Z-Image Turbo this used to be the whole tab, one grey
  // line under a photo strip that still took photos, and no trigger field.
  // The inputs stay now; the missing install sits above them with its
  // button, like "Download base files" of the Windows trainer.
  const missing = macTrainMissing(status)
  return (
    <div className="flex flex-col items-center gap-1.5" data-testid="mac-train-controls">
      <TrainKindPicker />
      {missing && (
        <div className="flex items-center justify-center gap-2 flex-wrap max-w-[560px]">
          <span className="t-label text-gray-400 text-center" data-testid="mac-train-note">{missing}</span>
          <Button size="sm" variant="secondary" icon={Download} onClick={() => { setCategoryFilter('image'); setView('models') }}>
            Install Z-Image Turbo
          </Button>
        </div>
      )}
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <input
          value={triggerWord}
          onChange={(e) => setTriggerWord(e.target.value)}
          placeholder={trainKind === 'style' ? STYLE_NAME_PLACEHOLDER : 'Trigger word, e.g. davechar'}
          aria-label={trainKind === 'style' ? 'Style name' : 'Trigger word'}
          className="t-control w-44 px-2.5 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15"
        />
        <TriggerWordNote />
        <Segmented
          size="sm"
          layoutId="train-steps"
          value={String(trainSteps)}
          onChange={(v) => setTrainSteps(Number(v))}
          options={presets.map((p) => ({ value: String(p.steps), label: p.label }))}
        />
        <span className="t-label text-gray-600">
          {trainImages.length}/{maxTrainImages('local')} {trainKind === 'style' ? 'pictures' : 'photos'}{trainImages.length < MIN_TRAIN_IMAGES ? `, need at least ${MIN_TRAIN_IMAGES}` : ''}
        </span>
      </div>
      {!isGenerating && (
        <div className="t-label text-gray-600 text-center max-w-[560px]" data-testid="mac-train-hint">
          {macTrainNote(trainStepsNote(trainSteps, presets), status, trainKind)}{' '}
          <button
            onClick={() => { void openMlxLoraFolder().catch(() => undefined) }}
            className="underline underline-offset-2 text-gray-500 hover:text-gray-300"
            data-testid="mac-train-open-folder"
          >
            Open the LoRA folder
          </button>
        </div>
      )}
    </div>
  )
}

// Image with a local character: the character is the trainer's own
// `char_<name>_zimage` LoRA file, picked in step 1 (hub/hubCharacters
// applyLocalLora puts it on the image chain and brings its model along). This
// says what the run needs, or why it cannot run, with the way back.
function LocalCharacterNotes() {
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  const setImageModel = useCreateStore((s) => s.setImageModel)
  const { list: imageModels, value: runModel } = useLocalPick()

  // A character from an earlier session, or a model changed after the pick:
  // this says so, with the way back. Nothing is said before the model list
  // is in, where every model would read as missing.
  const pickedFile = characterLoraFile(selectedCharacter)
  const base = pickedFile ? characterBaseModel(pickedFile, imageModels, runModel) : null
  const runType = imageModels.find((m) => m.name === runModel)?.type
  const block = pickedFile && runType ? characterRunBlock(pickedFile, runType, !!base) : null

  return (
    <div className="flex flex-col items-center gap-1.5 pt-3 text-center hub-fs-125">
      {!selectedCharacter && (isMlxImageHost() ? (
        <span className="hub-dim" data-testid="mac-no-characters">
          A trained character is a file named {'char_<name>_zimage.safetensors'} in the LoRA folder.{' '}
          <button onClick={() => { void openMlxLoraFolder().catch(() => undefined) }} className="underline hub-muted">Open the LoRA folder</button>
        </span>
      ) : (
        <span className="hub-dim">Pick a character in the head line, or train one from photos.</span>
      ))}
      {selectedCharacter && !block && (
        <span className="hub-dim" data-testid="character-use-hint">
          Put “{selectedCharacter.triggerWord}” in your prompt and describe the key features too. The trigger word alone often does not hold the look.
        </span>
      )}
      {block && (
        <span role="alert" className={cn('flex items-center justify-center gap-2 flex-wrap', HINWEIS_TEXT.fehler)} data-testid="character-model-warning">
          {block}
          {base && (
            <button
              onClick={() => setImageModel(base.name, base.type)}
              className="underline text-gray-300 hover:text-white"
              data-testid="character-model-switch"
            >
              Switch model
            </button>
          )}
        </span>
      )}
    </div>
  )
}

/** Deletes a local character file (More options of Image). The file moves to
 *  the Trash or the Recycle Bin, after a question. */
function LocalCharacterDelete({ file, trigger }: { file: string; trigger: string }) {
  const [asking, setAsking] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const removeCharacter = async () => {
    setDeleting(true)
    try {
      await deleteLocalCharacter(file)
      // The file is gone: the pick and the LoRA it rode on go with it, so the
      // next render does not ask for a file that is no longer there.
      const store = useCreateStore.getState()
      if (characterLoraFile(store.selectedCharacter) === file) store.setSelectedCharacter(null)
      if (store.selectedLoras.some((l) => l.name === file)) store.toggleLora(file)
      store.setHubCharacter(null)
      store.setHubStep('who')
      setAsking(false)
      // ComfyUI rereads its loras folder, then the list asks again.
      await refreshComfyModels().catch(() => { /* rescan is best-effort */ })
      store.bumpCharactersVersion()
    } catch (e) {
      setAsking(false)
      setDeleteError(errorText(e))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setAsking(true)}
        className="flex items-center gap-1 p-1 text-gray-600 hover:text-red-400"
        title="Delete character"
        aria-label={`Delete character ${trigger}`}
        data-testid="local-character-delete"
      >
        <Trash2 size={11} /> Delete
      </button>
      <Modal open={asking} onClose={() => { if (!deleting) setAsking(false) }} title="Delete character">
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-300 mb-3">
          Delete the character <span className="text-gray-900 dark:text-white font-mono">{trigger}</span>?
          Its file moves to the {isMacOS() ? 'Trash' : 'Recycle Bin'}, so you can put it back from there.
        </p>
        <ModalActions>
          <ModalButton variant="quiet" onClick={() => setAsking(false)} disabled={deleting}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="danger"
            onClick={() => void removeCharacter()}
            disabled={deleting}
            data-testid="local-character-delete-confirm"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </ModalButton>
        </ModalActions>
      </Modal>
      <Modal open={!!deleteError} onClose={() => setDeleteError(null)} title="Delete failed">
        <p className="text-[0.7rem] text-red-500 dark:text-red-400 mb-3">{deleteError}</p>
        <ModalActions>
          <ModalButton onClick={() => setDeleteError(null)}>
            Close
          </ModalButton>
        </ModalActions>
      </Modal>
    </>
  )
}

// ── Talking character (lipsync) ─────────────────────────────────────────────

function LipsyncControls() {
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const audioInput = useCreateStore((s) => s.audioInput)
  const setAudioInput = useCreateStore((s) => s.setAudioInput)
  const voiceFromJob = useCreateStore((s) => s.voiceFromJob)
  const setVoiceFromJob = useCreateStore((s) => s.setVoiceFromJob)
  // A Mac runs Talking Character itself (LTX-2.3 a2v): a portrait and a voice,
  // never a clip to resync, whatever the cloud catalogue says about its pick.
  const macLocal = useCreateStore((s) => s.backend) === 'local' && isMlxImageHost()
  // Catalog subscription so the rows re-render when the live catalog
  // arrives and flips the picked model's source type.
  useCloudCatalogStore((s) => s.fetchedAt)
  const model = cloudModelById(modelForOp('video', 'lipsync', cloudOpModel))
  const needsClip = !macLocal && model?.lipsync_source === 'video'

  // Talk in the Character area (sketches v2): one line per input, the
  // character's portrait (or the clip to re-sync), then the voice.
  return (
    <div className="flex flex-col" data-talk-controls>
      {macLocal && <MacTalkingPart />}
      {needsClip ? <DrivingVideoLine empty="Add the clip to re-sync" label="Clip" /> : <PortraitLine empty="Add portrait" />}
      <HubLine>
        <span className="hub-text w-[110px] shrink-0">Voice</span>
        <span className="flex-1" />
        <VoiceChip
          flat
          audioName={audioInput?.name ?? null}
          voiceLabel={voiceFromJob?.label ?? null}
          onAudioFile={(f) => setAudioInput(mediaRefFrom(f))}
          onPickVoice={(jobId, label) => setVoiceFromJob({ jobId, label })}
          onClear={() => { setAudioInput(null); setVoiceFromJob(null) }}
        />
        {(audioInput || voiceFromJob) && (
          <button onClick={() => { setAudioInput(null); setVoiceFromJob(null) }} className="hub-dim p-1" title="Remove the voice" aria-label="Remove the voice">
            <X size={12} />
          </button>
        )}
      </HubLine>
      {macLocal && <div className="pt-2.5"><MacTalkingWords /></div>}
    </div>
  )
}

/** What the voice says, on a Mac. Quoted in the run's prompt it makes the lips
 *  follow the words (lib/mac-talking macTalkingPrompt); left empty the run
 *  goes on the voice alone. */
function MacTalkingWords() {
  const words = useCreateStore((s) => s.talkingWords)
  const setWords = useCreateStore((s) => s.setTalkingWords)
  return (
    <input
      value={words}
      onChange={(e) => setWords(e.target.value)}
      maxLength={600}
      aria-label="What the voice says"
      placeholder="What does the voice say? Optional, the lips follow the words better with it"
      className="t-control w-full max-w-[520px] px-2.5 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15"
    />
  )
}

/**
 * The line of the Mac's Talking Character tab while the model it runs on
 * lacks its own download (the dev transformer of LTX-2.3, about 11 GB). One
 * button gets it on the slot of a video model install; with it on disk the
 * line is gone and the run can start.
 */
function MacTalkingPart() {
  // The model the run takes: the pick of the tab's model chip (localPick).
  const localOpModel = useCreateStore((s) => s.localOpModel)
  const videoModelList = useCreateStore((s) => s.videoModelList)
  const entry = mlxTalkingEntry(videoModelList, localOpModel)
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const id = entry ? mlxVideoModelIdFor(entry.name) : null
  if (!entry || !id || entry.mlxVideo?.talking !== 'missing') return null
  const name = entry.name.replace(/^MLX /, '')
  const get = async () => {
    setBusy(true)
    setFailed(null)
    try {
      // Loaded on the click: the install module brings the install store,
      // which nothing else on this surface needs.
      const install = await import('../../../api/mlx-install')
      try {
        await install.installMlxTalking({ id, name }, (msg) => setLine(msg))
      } catch (e) {
        if (e instanceof install.MlxInstallCancelled) return
        throw e
      }
      useCreateStore.getState().setVideoModelList(buildMlxVideoModels(await listVideoModels()))
    } catch (e) {
      setFailed(errorText(e))
    } finally {
      setBusy(false)
      setLine(null)
    }
  }
  return (
    <div className="w-full flex flex-col items-center gap-1.5" data-testid="mac-talking-part">
      <p className={cn('t-label text-center', HINWEIS_TEXT.ruhig)}>
        Talking Character runs on {name} and needs one more download for it, {entry.mlxVideo?.talkingGB ?? 11.3} GB.
      </p>
      <Button size="sm" variant="secondary" icon={Download} loading={busy} disabled={busy} onClick={() => void get()}>
        {busy ? (line ?? 'Starting the download…') : 'Get Talking Character'}
      </Button>
      {failed && <p role="alert" className={cn('t-label text-center', HINWEIS_TEXT.fehler)}>{failed}</p>}
    </div>
  )
}

// The hosted tts endpoint requires one of the service's own preset voices —
// these exact ids, live-verified 2026-07-18 (invented names get a 400).
const TTS_VOICES = [
  'Serena', 'Vivian', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Sohee', 'Ono_Anna', 'Uncle_Fu',
] as const

function VoiceChip({
  audioName,
  voiceLabel,
  onAudioFile,
  onPickVoice,
  onClear,
  flat = false,
}: {
  audioName: string | null
  voiceLabel: string | null
  onAudioFile: (f: File) => void
  onPickVoice: (jobId: string, label: string) => void
  onClear: () => void
  /** The Character area: text with a small arrow, no box (sketches v2). */
  flat?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [makerOpen, setMakerOpen] = useState(false)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'speak' | 'design'>('speak')
  // The model the voice maker runs (useCloudCreate, makeVoice), for its price.
  const voiceModel = mode === 'design' ? 'qwen3-tts-design' : 'qwen3-tts'
  const [voice, setVoice] = useState<string>(TTS_VOICES[0])
  const [description, setDescription] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => { setOpen(false); setMakerOpen(false) }, open || makerOpen)
  const panelRef = useRef<HTMLDivElement>(null)
  const panel = usePopoverPlatz(panelRef, open, { bevorzugt: 'oben', abstand: 6 })
  const { makeVoice } = useCreateExp()
  const isGenerating = useCreateStore((s) => s.isGenerating)
  // The AI voice maker + "your generated audio" picks are cloud runs (hosted
  // tts, jobId-backed re-signing) — on the local lane the speech source is an
  // upload. Hide the hosted affordances there instead of dead-ending them.
  const isCloud = useCreateStore((s) => s.backend) === 'cloud'
  const audioItems = useCreateStore((s) => s.gallery).filter((g) => g.type === 'audio' && g.jobId)

  const value = audioName ?? voiceLabel
  return (
    <div ref={ref} className="relative flex items-center">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) { onAudioFile(f); setOpen(false) }
          e.target.value = ''
        }}
      />
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          flat
            ? cn('flex items-center gap-1.5 hub-fs-14 transition-colors', value ? 'hub-text font-medium' : 'hub-acc')
            : cn(
              't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
              value
                ? 'bg-white/[0.06] border-white/10 text-gray-200'
                : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200 hover:border-white/15',
            ),
        )}
      >
        {!flat && <Mic size={12} />}
        <span className="max-w-[150px] truncate">{value ?? 'Add voice'}</span>
        {flat && <ChevronDown size={13} className="hub-dim" />}
      </button>
      {value && (
        <button onClick={onClear} className="p-1 text-gray-500 hover:text-gray-300" title="Remove voice" aria-label="Remove voice">
          <X size={11} />
        </button>
      )}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            style={panel.style}
            initial={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
            transition={{ duration: 0.12 }}
            className={cn('lu-elevated absolute left-0 z-50 w-72 rounded-lg p-1.5 space-y-1 overflow-y-auto scrollbar-thin', panel.nachOben ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}
          >
            {!makerOpen ? (
              <>
                <button
                  onClick={() => { inputRef.current?.click() }}
                  className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                >
                  <Upload size={12} /> Upload an audio file
                </button>
                {isCloud && (
                  <button
                    onClick={() => setMakerOpen(true)}
                    className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                  >
                    <Wand2 size={12} /> Generate a voice (AI)
                  </button>
                )}
                {isCloud && audioItems.length > 0 && (
                  <div className="pt-1 border-t border-white/[0.06]">
                    <div className="t-label text-gray-600 px-2.5 py-1">Your generated audio</div>
                    <div className="max-h-36 overflow-y-auto scrollbar-thin">
                      {audioItems.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => {
                            onPickVoice(g.jobId as string, g.prompt.slice(0, 40) || 'Generated audio')
                            setOpen(false)
                          }}
                          className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                        >
                          <AudioLines size={12} />
                          <span className="truncate">{g.prompt || 'Generated audio'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="p-1.5 space-y-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="What should the character say?"
                  rows={2}
                  className="w-full t-control px-2.5 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15 resize-none"
                />
                <div className="flex items-center gap-2">
                  <Segmented
                    size="sm"
                    layoutId="tts-mode"
                    value={mode}
                    onChange={(v) => setMode(v as 'speak' | 'design')}
                    options={[
                      { value: 'speak', label: 'Voice' },
                      { value: 'design', label: 'Describe' },
                    ]}
                  />
                  {mode === 'speak' ? (
                    <select
                      value={voice}
                      onChange={(e) => setVoice(e.target.value)}
                      className="t-control flex-1 min-w-0 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 focus:outline-none"
                    >
                      {TTS_VOICES.map((v) => (
                        <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="warm narrator, slight rasp…"
                      className="t-control flex-1 min-w-0 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none"
                    />
                  )}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  icon={Wand2}
                  disabled={isGenerating || !text.trim()}
                  onClick={() => {
                    void makeVoice({ text, mode, voice, description })
                    setOpen(false)
                    setMakerOpen(false)
                  }}
                >
                  {/* What this text costs, the figure the start sends as its ceiling. */}
                  Make voice{text.trim() && lengthPrice(voiceModel, 'tts') ? ` · ${lengthCredits(voiceModel, Array.from(text.trim()).length).toLocaleString('en-US')} credits` : ''}
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Music ───────────────────────────────────────────────────────────────────

function MusicControls() {
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const setMusicDuration = useCreateStore((s) => s.setMusicDuration)
  const musicLyrics = useCreateStore((s) => s.musicLyrics)
  const setMusicLyrics = useCreateStore((s) => s.setMusicLyrics)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const isCloud = useCreateStore((s) => s.backend) === 'cloud'
  const musicHowtoSeen = useCreateStore((s) => s.musicHowtoSeen)
  const setMusicHowtoSeen = useCreateStore((s) => s.setMusicHowtoSeen)
  const [howtoOpen, setHowtoOpen] = useState(false)
  // The catalog decides which models the picker holds, so this surface redraws
  // when it arrives.
  useCloudCatalogStore((s) => s.models)
  const model = createRunModel('music', { image: '', video: '', op: cloudOpModel })
  const studioOptions = useCreateStore((s) => s.cloudStudioOptions)
  const setStudioOptions = useCreateStore((s) => s.setCloudStudioOptions)
  // Cloud: which text goes where is the model's own business. For most the
  // prompt is the style and a few take lyrics next to it, for Mureka Song the
  // prompt IS the lyrics and the style sits next to it. The second text is
  // offered wherever the model reads one, under its real name.
  // Local: every music checkpoint runs through buildMusicWorkflow, which feeds
  // the lyrics box straight into the encoder. Asking the CLOUD catalog about a
  // local checkpoint is how the local tab once hid the box while sitting on
  // the one model that sings yours (#108).
  const text = isCloud ? musicText(model) : LOCAL_MUSIC_TEXT
  const second = text.second
  const secondValue = !second ? '' : second.option
    ? String(studioShownValue(model, studioOptions, second.option) ?? '')
    : musicLyrics
  const setSecondValue = (v: string) => {
    if (!second) return
    if (second.option) setStudioOptions({ ...studioOptions, [second.option]: v === '' ? undefined : v })
    else setMusicLyrics(v)
  }
  const [secondOpen, setSecondOpen] = useState(musicLyrics.length > 0)
  // The length slider stands only where the run reads a length, and sets the
  // field the run sends: the store's seconds for a local or a classic cloud
  // model, the model's own option for a Studio one (the same option the price
  // is computed from).
  // The Mac's music engine makes nothing under ten seconds (music.rs), and
  // the slider does not offer what the run would round up.
  const length = isCloud ? musicLength(model) : isMlxImageHost() ? { ...SECONDS_LENGTH, min: MAC_MUSIC_MIN_SECONDS } : SECONDS_LENGTH
  const lengthOption = length?.option
  const seconds = length && lengthOption
    ? Math.round(Number(studioShownValue(model, studioOptions, lengthOption)) / length.perSecond)
    : musicDuration
  const howtoLines = musicHowtoLines(isCloud ? 'cloud' : 'local', { text, length })

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center gap-3">
        {length && (
          <div className="w-56">
            <Slider
              label="Length"
              min={length.min}
              max={length.max}
              step={length.step}
              value={Math.max(length.min, Math.min(length.max, seconds))}
              onChange={(v) => (lengthOption
                ? setStudioOptions({ ...studioOptions, [lengthOption]: v * length.perSecond })
                : setMusicDuration(v))}
              format={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`}
            />
          </div>
        )}
        {second ? (
          <button
            onClick={() => setSecondOpen((o) => !o)}
            aria-expanded={secondOpen}
            className={cn(
              't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
              secondOpen
                ? 'bg-white/[0.06] border-white/10 text-gray-200'
                : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200',
            )}
          >
            <Music2 size={12} /> {second.is === 'lyrics' ? 'Lyrics' : 'Style'}
          </button>
        ) : (
          <span className="t-control text-gray-500">
            {text.main === 'lyrics' ? 'This model sings the lyrics you write.' : 'This model writes its own lyrics from the prompt.'}
          </span>
        )}
        <div className="relative">
          <button
            onClick={() => {
              setHowtoOpen((o) => !o)
              if (!musicHowtoSeen) setMusicHowtoSeen(true)
            }}
            className={cn(
              't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
              howtoOpen
                ? 'bg-white/[0.06] border-white/10 text-gray-200'
                : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200',
            )}
          >
            <Info size={12} /> How to
          </button>
          {!musicHowtoSeen && (
            <span aria-hidden className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-lu-accent pointer-events-none" />
          )}
        </div>
      </div>
      <AnimatePresence>
        {howtoOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="t-control px-3 py-2 rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-400 space-y-1 text-left">
              {/* Copy lives in music-ui.ts so the claims are asserted, not
                  eyeballed. The local panel used to promise other downloadable
                  models and per-second billing (#108), the cloud panel follows
                  the model on screen. */}
              {howtoLines.map((line, i) => (
                <p key={i} className={i === 0 ? 'text-gray-200' : undefined}>{line}</p>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {second && secondOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <textarea
              value={secondValue}
              onChange={(e) => setSecondValue(e.target.value)}
              aria-label={second.is === 'lyrics' ? 'Lyrics' : 'Style'}
              placeholder={second.is === 'lyrics'
                ? 'Your lyrics. [Verse] and [Chorus] markers make them sing best…'
                : 'Genre, mood, tempo, voice…'}
              rows={second.is === 'lyrics' ? 3 : 1}
              className="w-full t-control px-2.5 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15 resize-none"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Extend ──────────────────────────────────────────────────────────────────

/** The LAST frame of a video (blob URL or object URL) as a PNG File: the
 *  local extend lane feeds it to the regular image to video run as the start
 *  image, through ComfyUI on Windows and through MLX on the Mac
 *  (lib/video-frames lastFrame). */
async function lastFrameFile(videoUrl: string, name: string): Promise<File> {
  const blob = await lastFrame(videoUrl)
  return new File([blob], `${name.replace(/\.[^.]+$/, '')}_lastframe.png`, { type: 'image/png' })
}

function ExtendControls() {
  const backend = useCreateStore((s) => s.backend)
  return backend === 'local' ? <LocalExtendControls /> : <CloudExtendControls />
}

/** Local lane: pick one of your local gallery videos (or upload a clip) —
 *  its last frame becomes the Stage source, and the regular I2V flow
 *  continues from there. */
function LocalExtendControls() {
  const source = useCreateStore((s) => s.source)
  const setSource = useCreateStore((s) => s.setSource)
  const setError = useCreateStore((s) => s.setError)
  const clips = useCreateStore((s) => s.gallery).filter((g) => g.type === 'video' && !g.jobId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pickedLabel, setPickedLabel] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)
  const panelRef = useRef<HTMLDivElement>(null)
  const panel = usePopoverPlatz(panelRef, open, { bevorzugt: 'oben', abstand: 6, deckel: 256 })

  const setExtendClip = useCreateStore((s) => s.setExtendClip)
  const adopt = async (getUrl: () => Promise<{ url: string; revoke?: () => void; blob?: Blob }>, label: string) => {
    setBusy(true)
    setError(null)
    try {
      const { url, revoke, blob } = await getUrl()
      try {
        const frame = await lastFrameFile(url, label)
        setSource(await loadImageRef(frame))
        // B18: the clip itself goes along too. Wan and LTX 2.5 continue from
        // its last frames instead of the one still, and the result is the
        // whole clip, longer (lib/long-video-run).
        setExtendClip(blob ?? null)
        setPickedLabel(label)
      } finally {
        revoke?.()
      }
    } catch (e) {
      setError(`Could not read the clip: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  const fromGallery = (g: GalleryItem) =>
    adopt(async () => {
      const blob = await fetchGalleryItemBlob(g)
      const url = URL.createObjectURL(blob)
      return { url, revoke: () => URL.revokeObjectURL(url), blob }
    }, g.prompt.slice(0, 40) || 'Local video')

  const fromFile = (f: File) =>
    adopt(async () => {
      const url = URL.createObjectURL(f)
      return { url, revoke: () => URL.revokeObjectURL(url), blob: f }
    }, f.name)

  const value = source && pickedLabel ? pickedLabel : null
  return (
    <div className="flex items-center justify-center">
      <div ref={ref} className="relative flex items-center">
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void fromFile(f)
            e.target.value = ''
          }}
        />
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={busy}
          className={cn(
            't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
            value
              ? 'bg-white/[0.06] border-white/10 text-gray-200'
              : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200 hover:border-white/15',
          )}
        >
          <Film size={12} />
          <span className="max-w-[220px] truncate">
            {busy ? 'Reading last frame…' : value ? `Continues: ${value}` : 'Pick the clip to extend'}
          </span>
        </button>
        {value && (
          <button
            onClick={() => { setSource(null); setExtendClip(null); setPickedLabel(null) }}
            className="p-1 text-gray-500 hover:text-gray-300" title="Clear" aria-label="Clear"
          >
            <X size={11} />
          </button>
        )}
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panelRef}
              style={panel.style}
              initial={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
              transition={{ duration: 0.12 }}
              className={cn('lu-elevated absolute left-1/2 -translate-x-1/2 z-50 w-72 rounded-lg p-1 overflow-y-auto scrollbar-thin', panel.nachOben ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}
            >
              <button
                onClick={() => inputRef.current?.click()}
                className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
              >
                <Upload size={12} /> Upload a video file
              </button>
              {clips.length > 0 && <div className="t-label text-gray-600 px-2.5 py-1 border-t border-white/[0.06] mt-1">Your local videos</div>}
              {clips.map((g) => (
                <button
                  key={g.id}
                  onClick={() => { void fromGallery(g) }}
                  className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                >
                  <Film size={12} />
                  <span className="truncate">{g.prompt || 'Local video'}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function CloudExtendControls() {
  const extendSource = useCreateStore((s) => s.extendSource)
  const setExtendSource = useCreateStore((s) => s.setExtendSource)
  const clips = useCreateStore((s) => s.gallery).filter((g) => g.type === 'video' && g.jobId)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)
  const panelRef = useRef<HTMLDivElement>(null)
  const panel = usePopoverPlatz(panelRef, open, { bevorzugt: 'oben', abstand: 6, deckel: 256 })

  return (
    <div className="flex items-center justify-center">
      <div ref={ref} className="relative flex items-center">
        <button
          onClick={() => setOpen((o) => !o)}
          className={cn(
            't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
            extendSource
              ? 'bg-white/[0.06] border-white/10 text-gray-200'
              : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200 hover:border-white/15',
          )}
        >
          <Film size={12} />
          <span className="max-w-[200px] truncate">
            {extendSource ? extendSource.label : 'Pick one of your cloud videos'}
          </span>
        </button>
        {extendSource && (
          <button onClick={() => setExtendSource(null)} className="p-1 text-gray-500 hover:text-gray-300" title="Clear" aria-label="Clear">
            <X size={11} />
          </button>
        )}
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panelRef}
              style={panel.style}
              initial={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
              transition={{ duration: 0.12 }}
              className={cn('lu-elevated absolute left-1/2 -translate-x-1/2 z-50 w-72 rounded-lg p-1 overflow-y-auto scrollbar-thin', panel.nachOben ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}
            >
              {clips.length === 0 && (
                <div className="t-control text-gray-500 px-2.5 py-2">
                  No cloud videos yet. Render one on the Video tab first.
                </div>
              )}
              {clips.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setExtendSource({
                      jobId: g.jobId as string,
                      url: g.remoteUrl ?? '',
                      // P9: 'Cloud video' was the old blanket notname
                      // gallery-label.ts's own header comment names as the
                      // problem it fixes (19.09.2026: "everything
                      // after that is just Cloud videos"). A prompt-less
                      // entry here is routinely a Studio step (sharpen,
                      // extend, a preset step), galleryLabelShort names
                      // those from their model/label instead of a blank
                      // notname.
                      label: galleryLabelShort(g, 40),
                    })
                    setOpen(false)
                  }}
                  className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                >
                  <Film size={12} />
                  <span className="truncate">{galleryLabelShort(g, 60)}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ── Motion control ──────────────────────────────────────────────────────────

/** The portrait line of Motion and Talk: "Character → Bean ▾". It writes the
 *  shared Stage source (an ImageRef with a data-URL preview; the cloud upload
 *  path re-encodes from it). */
function PortraitLine({ empty }: { empty: string }) {
  const source = useCreateStore((s) => s.source)
  const setSource = useCreateStore((s) => s.setSource)
  const name = hubPortraitName(source?.url)
  return (
    <HubLine data-portrait-line>
      <span className="hub-text w-[110px] shrink-0">Character</span>
      {!source && <span className="hub-dim">{empty}</span>}
      <span className="flex-1" />
      <CharacterPick
        name={name}
        image={source?.url ?? null}
        label="Character image"
        onPhoto={(f) => { void loadImageRef(f).then(setSource) }}
        onCharacter={(c) => {
          void hubPortrait(c).then((r) => { if (r) setSource(r) })
            .catch((err: unknown) => useCreateStore.getState().setError(errorText(err)))
        }}
      />
      {source && (
        <button onClick={() => setSource(null)} className="hub-dim p-1" title="Remove" aria-label="Remove the character image">
          <X size={12} />
        </button>
      )}
    </HubLine>
  )
}

/** The video line of Motion (and Talk's re-sync): the clip, large, once it is
 *  there; before that one line to add it. Its name and an X stand in the head
 *  line of the area. */
function DrivingVideoLine({ empty, label }: { empty: string; label: string }) {
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  if (!videoInput) {
    return (
      <UploadLine
        icon={<Film size={15} />}
        label={empty}
        accept="video/mp4,video/webm,video/quicktime"
        onFile={(f) => setVideoInput(mediaRefFrom(f))}
      />
    )
  }
  return (
    <figure className="flex flex-col items-center pt-3" data-driving-video>
      <video src={videoInput.url} muted loop autoPlay playsInline aria-label={label} className="max-h-[min(36vh,280px)] max-w-full rounded-lg bg-black object-contain" />
    </figure>
  )
}

function MotionControls() {
  const backend = useCreateStore((s) => s.backend)
  const videoInput = useCreateStore((s) => s.videoInput)
  // Sound on the cloud lanes only: the local lanes have no lip sync step and
  // no worker to lay the sound under (14.11.2026, as on the web). And only
  // for an account the server released it for (features.characterHub).
  const cloud = soundApplies('motion', backend, useCharacterHubReleased())
  const [measured, setMeasured] = useState<{ url: string; seconds: number | undefined } | null>(null)
  useEffect(() => {
    let alive = true
    if (!cloud || !videoInput) return
    void mediaSeconds(videoInput.url, 'video').then((v) => { if (alive) setMeasured({ url: videoInput.url, seconds: v }) })
    return () => { alive = false }
  }, [cloud, videoInput])
  const videoSeconds = measured && videoInput && measured.url === videoInput.url ? measured.seconds : undefined
  // Motion in the Character area (sketches v2): the character, the video
  // whose moves it copies, the sound.
  return (
    <div className="flex flex-col" data-motion-controls>
      <PortraitLine empty="Add character image" />
      <DrivingVideoLine empty="Add driving video (dance/pose)" label="Motion video" />
      {videoInput && <p className="hub-dim pb-1 text-center hub-fs-12">Your character copies the moves of this video.</p>}
      {cloud && <SoundControls intent="motion" people={1} clipSeconds={videoSeconds} withPrice />}
    </div>
  )
}

// ── Sound (14.11.2026, David; port of the web's SoundControls): the original
// sound, no sound, or a new voice with the lips in sync. Swap and Motion,
// cloud only, released accounts only (lib/render/sound.ts). ──

function SoundControls({ intent, people, clipSeconds, withPrice = false }: {
  intent: CreateIntent; people: number; clipSeconds: number | undefined
  /** Motion has no length in the bar: the price of the lip sync step stands here. */
  withPrice?: boolean
}) {
  const backend = useCreateStore((s) => s.backend)
  const sound = useCreateStore((s) => s.sound)
  const setSound = useCreateStore((s) => s.setSound)
  const lipModel = useCreateStore((s) => s.lipsyncModel)
  const setLipModel = useCreateStore((s) => s.setLipsyncModel)
  const setLipCredits = useCreateStore((s) => s.setLipsyncCredits)
  const audioInput = useCreateStore((s) => s.audioInput)
  const setAudioInput = useCreateStore((s) => s.setAudioInput)
  const voiceFromJob = useCreateStore((s) => s.voiceFromJob)
  const setVoiceFromJob = useCreateStore((s) => s.setVoiceFromJob)
  // The catalogue decides whether the lip sync models are there.
  useCloudCatalogStore((s) => s.fetchedAt)
  const blocked = lipsyncBlocked(people, backend, lipModel)
  // A second person: lip sync no longer works, back to the original sound.
  useEffect(() => { if (blocked && sound === 'lipsync') setSound('original') }, [blocked, sound, setSound])
  // The length of the voice: an upload is measured here, an earlier voice
  // through its job's address (as the Composer's meter does).
  const [voice, setVoice] = useState<{ key: string; seconds: number | undefined } | null>(null)
  const voiceKey = audioInput?.url ?? (voiceFromJob ? `job:${voiceFromJob.jobId}` : undefined)
  useEffect(() => {
    let alive = true
    if (!voiceKey) return
    const url = audioInput?.url
      ? Promise.resolve(audioInput.url)
      : getJob(voiceFromJob!.jobId).then((j) => j.result_url ?? undefined)
    void url
      .then((u) => (u ? mediaSeconds(u, 'audio') : undefined))
      .catch(() => undefined)
      .then((v) => { if (alive) setVoice({ key: voiceKey, seconds: v }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceKey])
  const audioSeconds = voice && voice.key === voiceKey ? voice.seconds : undefined
  const active = sound === 'lipsync' && !blocked
  const credits = active && (voiceKey ? voice?.key === voiceKey : true) ? lipsyncCredits(lipModel, audioSeconds, clipSeconds) : null
  useEffect(() => { setLipCredits(credits) }, [credits, setLipCredits])
  useEffect(() => () => setLipCredits(null), [setLipCredits])
  const cut = active && lipsyncCut(audioSeconds, clipSeconds)

  return (
    <div className="w-full" data-sound-controls={intent}>
      <HubLine className="flex-wrap gap-y-1 py-1.5">
        <span className="hub-text w-[42px] shrink-0">Sound</span>
        <span className="contents hub-seg">
        <Segmented
          size="sm"
          layoutId={`sound-${intent}`}
          ariaLabel="Sound"
          className="max-w-full flex-wrap"
          value={sound}
          onChange={(v) => setSound(v as SoundChoice)}
          options={SOUND_CHOICES.map((c) => ({
            value: c, label: SOUND_LABEL[c],
            ...(c === 'lipsync' && blocked ? { disabled: true, title: blocked } : {}),
          }))}
        />
        </span>
        {blocked && (
          <span className="hub-dim hub-fs-11" data-sound-note="lipsync-blocked">{blocked === LIPSYNC_ONE_PERSON ? 'one person only' : blocked}</span>
        )}
      </HubLine>
      {active && (
        <div className="hub-line space-y-1.5 border-b py-2" data-sound-lipsync>
          <div className="flex flex-wrap items-center gap-2.5 hub-fs-14">
            <span className="hub-text w-[42px] shrink-0">Voice</span>
            <VoiceChip
              flat
              audioName={audioInput?.name ?? null}
              voiceLabel={voiceFromJob?.label ?? null}
              onAudioFile={(f) => setAudioInput(mediaRefFrom(f))}
              onPickVoice={(jobId, label) => setVoiceFromJob({ jobId, label })}
              onClear={() => { setAudioInput(null); setVoiceFromJob(null) }}
            />
            {credits != null && (
              <span className="hub-dim hub-fs-125 tabular-nums" data-sound-price>
                + lip sync {withPrice ? `${credits.toLocaleString('en-US')} credits` : swapShortCredits(credits)}
                {audioSeconds !== undefined ? ` (${Math.ceil(lipsyncSeconds(audioSeconds, clipSeconds)! - 1e-6)} s)` : ''}
              </span>
            )}
          </div>
          <p className="hub-dim hub-fs-125">After the video, a second step puts the new voice in and moves the lips to it.</p>
          {cut && (
            <p className="hub-dim hub-fs-125" data-sound-note="cut">
              Your voice is {Math.round(audioSeconds!)} s, the clip {Math.round(clipSeconds!)} s. The voice is cut to the clip.
            </p>
          )}
          <details className="hub-dim hub-fs-125">
            <summary className="cursor-pointer select-none">Lip sync model</summary>
            <div className="mt-1.5">
              <Segmented
                size="sm"
                layoutId={`lipsync-model-${intent}`}
                ariaLabel="Lip sync model"
                value={LIPSYNC_STEP_MODELS.includes(lipModel) ? lipModel : LIPSYNC_STEP_DEFAULT}
                onChange={(v) => setLipModel(v)}
                options={LIPSYNC_STEP_MODELS.map((m) => ({ value: m, label: m === 'latentsync' ? 'LatentSync (recommended)' : 'Lipsync-2' }))}
              />
            </div>
          </details>
        </div>
      )}
    </div>
  )
}

// ── Swap Character (07.11.2026, port of the web's C52; two steps since
// 14.11.2026; in the Character area since part B, sketches v2) ──────────────
//
// The input part of the sketch: the video, its first frame with a numbered
// mark per person to replace, one line per person ("1 the person on the left
// → Bean ▾"), the sound, the consent in one line. The length, the model and
// the price stand in the bar at the foot (Composer, hub). The frame step
// (Build first frame, Does this look right?, Continue) is SwapFrameBuild as
// it was. In the one click swap (hub/SwapOneClick.tsx, only with the
// account switch) the same inputs stand without it: the engine comes from the
// one click picks, the switches stand above the consent, and Create in its
// own bar runs the whole chain.

export function SwapControls({ oneClick }: {
  oneClick?: {
    /** The engine of the video (swapVideoModelFor), kept in the store too. */
    model: string
    /** "Uncensored" and "Check first frame before video". */
    switches?: ReactNode
  }
} = {}) {
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  const figures = useCreateStore((s) => s.swapFigures)
  const setFigures = useCreateStore((s) => s.setSwapFigures)
  const swapSeconds = useCreateStore((s) => s.swapSeconds)
  const consent = useCreateStore((s) => s.swapConsent)
  const setConsent = useCreateStore((s) => s.setSwapConsent)
  const options = useCreateStore((s) => s.cloudStudioOptions)
  const setOptions = useCreateStore((s) => s.setCloudStudioOptions)
  const opModel = useCreateStore((s) => s.cloudOpModel)
  const setOpModel = useCreateStore((s) => s.setCloudOpModel)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const released = useCharacterHubReleased()
  const model = oneClick?.model ?? createRunModel('swap_character', { image: '', video: '', op: opModel })
  // SCAIL 2 and Kling: the first frame first, then the video (SwapFrameSteps).
  const twoStep = swapUsesFrame(SWAP_INTENT, model)
  // The first frame to tap; for OpenJutsu too, whose roles come from it.
  useSwapFirstFrame()
  // The length of the customer's video, measured in the app (as the price).
  const [measured, setMeasured] = useState<{ url: string; seconds: number | undefined } | null>(null)
  useEffect(() => {
    let alive = true
    if (!videoInput) return
    void mediaSeconds(videoInput.url, 'video').then((v) => { if (alive) setMeasured({ url: videoInput.url, seconds: v }) })
    return () => { alive = false }
  }, [videoInput])
  const videoSeconds = measured && videoInput && measured.url === videoInput.url ? measured.seconds : undefined

  // The model follows the number of people: up to 3 SCAIL 2, with 4
  // OpenJutsu. Only between these two; Kling or Wan picked by hand stays. It
  // switches only when the target changes, not on opening the panel: an own
  // pick (OpenJutsu for 2 people) stays.
  const auto = SWAP_AUTO_MODELS.includes(model)
  const target = swapAutoModel(figures.length)
  const known = !!STUDIO_MODELS[model]
  const lastTarget = useRef(target)
  useEffect(() => {
    if (oneClick || lastTarget.current === target) return
    lastTarget.current = target
    if (auto && known && target !== model) setOpModel(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, known, target])
  // What Swap presets (SCAIL 2: 720p) stands in the store, so the bar and
  // the run see the same number.
  useEffect(() => {
    if (!known) return
    const preset = swapDefaultOptions(SWAP_INTENT, model)
    const missing = Object.entries(preset).filter(([k]) => options[k] === undefined)
    if (missing.length) setOptions({ ...options, ...Object.fromEntries(missing) })
  }, [known, model, options, setOptions])
  // One tap more than the model can do: onto the model that can do that many.
  // The one click swap picks its engine by the number of people itself.
  const fitPeople = (people: number) => {
    if (!oneClick && people > swapMaxPeople(model)) setOpModel(swapAutoModel(people))
  }

  if (!released) {
    // Without the account switch (features.characterHub) the server refuses
    // the new swap. Said quietly, nothing to fill in.
    return (
      <p className="hub-dim py-8 text-center hub-fs-14" data-swap-unavailable="soon">
        {HUB_SWAP_SOON}
      </p>
    )
  }
  if (!known) {
    // The server's catalogue does not list the swap models yet.
    return (
      <p className="hub-dim py-8 text-center hub-fs-14" data-swap-unavailable>
        Swap Character is not available on this LU Cloud yet.
      </p>
    )
  }

  const maxPeople = swapMaxPeople(model)
  const placed = swapFigureRoles(figures.map((f) => ({ ...f, role: '' })))
  // The marks in the first frame: up to the limit of Swap (OpenJutsu: 4).
  const markMax = swapMaxPeople(SWAP_OPENJUTSU_MODEL)
  const setFigure = (i: number, patch: Partial<SwapFigure>) => setFigures(figures.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const limits = swapClipLimits(model)
  const video = videoSeconds !== undefined ? Math.floor(videoSeconds + 0.05) : undefined

  return (
    <div className="flex flex-col" data-swap-controls data-swap-two-step={twoStep || undefined}>
      {!videoInput ? (
        <>
          <UploadLine
            icon={<Film size={15} />}
            label="Add the original video"
            accept="video/mp4,video/webm,video/quicktime"
            onFile={(f) => setVideoInput(mediaRefFrom(f))}
            note={`${limits.min} to ${limits.max} s`}
          />
          {/* Grey, not a warning (the desktop's house rule, lib/hinweis.ts). */}
          <ul className="hub-dim space-y-0.5 pt-2.5 hub-fs-125" data-swap-tips>
            {SWAP_TIPS.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </>
      ) : (
        <SwapFramePicker max={markMax} onCount={fitPeople} />
      )}

      <div className="hub-line mt-1 border-t" data-swap-figures={figures.length}>
        {figures.map((f, i) => (
          <HubLine key={i} data-swap-figure={i + 1}>
            <span className="hub-acc w-3.5 shrink-0 hub-fs-125 font-semibold tabular-nums">{i + 1}</span>
            <input
              type="text"
              value={f.role}
              maxLength={200}
              disabled={isGenerating}
              aria-label={`Who person ${i + 1} replaces`}
              placeholder={placed[i]
                ? placed[i]
                : figures.length > 1 ? 'Who? e.g. the woman in black on the left' : 'the main person'}
              onChange={(e) => setFigure(i, { role: e.target.value })}
              className="hub-role hub-text min-w-0 flex-1 bg-transparent hub-fs-14 outline-none"
            />
            <CharacterPick
              name={f.character ?? null}
              image={f.image?.url ?? null}
              label={`Character for person ${i + 1}`}
              inputData={{ 'data-swap-photo-input': String(i + 1) }}
              disabled={isGenerating}
              onPhoto={(file) => { void loadImageRef(file).then((image) => setFigure(i, { image, character: null })) }}
              onCharacter={(c) => {
                void hubPortrait(c).then((image) => { if (image) setFigure(i, { image, character: c.name }) })
                  .catch((err: unknown) => useCreateStore.getState().setError(errorText(err)))
              }}
            />
            {figures.length > 1 && !(twoStep && videoInput) && (
              <button
                type="button"
                aria-label={`Remove person ${i + 1}`}
                disabled={isGenerating}
                onClick={() => setFigures(figures.filter((_, j) => j !== i))}
                className="hub-dim rounded p-1"
              >
                <X size={12} />
              </button>
            )}
          </HubLine>
        ))}
        {((!twoStep || !videoInput) || (figures.length > 1 && maxPeople < figures.length)) && (
          <div className="flex min-h-8 items-center gap-3 hub-fs-125">
            {/* SCAIL 2 and Kling: people come in by a tap on the first frame.
                Without a video, and with OpenJutsu, also by this line. */}
            {(!twoStep || !videoInput) && (
              <button
                type="button"
                disabled={figures.length >= 4 || isGenerating}
                onClick={() => {
                  // Not every model takes several people. The switch is said in
                  // the sentence beside it, it does not happen silently.
                  fitPeople(figures.length + 1)
                  setFigures([...figures, { image: null, role: '' }])
                }}
                className="hub-acc disabled:opacity-40"
              >
                + Add person ({figures.length}/4)
              </button>
            )}
            {figures.length > 1 && maxPeople < figures.length && (
              <span className="hub-dim" data-swap-note="one-person-model">
                {modelLabel(model)} replaces {maxPeople === 1 ? 'one person' : `up to ${maxPeople} people`}.
              </span>
            )}
          </div>
        )}
      </div>

      {video !== undefined && video > limits.max && (
        <p className="hub-dim pt-2 hub-fs-125" data-clip-note="too-long">
          Your video is {video} s. {modelLabel(model)} reads at most {limits.max} s, so only the first {Math.min(swapSeconds ?? limits.max, limits.max)} s are used.
        </p>
      )}
      {video !== undefined && video < limits.min && (
        <p className="hub-dim pt-2 hub-fs-125" data-clip-note="too-short">
          Your video is {video} s. {modelLabel(model)} needs at least {limits.min} s.
        </p>
      )}

      <SoundControls intent={SWAP_INTENT} people={figures.length}
        clipSeconds={soundClipSeconds(SWAP_INTENT, model, swapSeconds, videoSeconds)} />
      {oneClick?.switches}
      {swapNeedsConsent(model) && (
        // A real person is swapped for a photo: the customer confirms rights
        // and consent first (the server asks too, for the frame step as for
        // the video).
        <label className="hub-muted flex w-full cursor-pointer items-start gap-2.5 pt-3 hub-fs-125" data-swap-consent>
          <input
            type="checkbox"
            checked={consent}
            disabled={isGenerating}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-px h-3 w-3 shrink-0 accent-[var(--color-lu-accent)]"
          />
          <span>{SWAP_CONSENT_TEXT}</span>
        </label>
      )}
      {twoStep && !oneClick && <div className="pt-3"><SwapFrameBuild model={model} /></div>}
    </div>
  )
}

/** What "More options" holds in a panel of the Character area. Nothing that
 *  was there before falls away: the resolution and the notes of Swap, the
 *  character's file actions of Image. The model's full schema stays one click
 *  further, in the settings drawer (CharacterHub links it). */
export function SpecialMore({ intent }: { intent: CreateIntent }) {
  if (intent === 'swap_character') return <SwapMore />
  // On the stage the file actions stand at the character on the left. That
  // column is gone on a phone-wide window (index.css, .hub-card), so there
  // they stay here.
  if (intent === 'character') return <div className="min-[701px]:hidden"><CharacterMore /></div>
  return null
}

function SwapMore() {
  const options = useCreateStore((s) => s.cloudStudioOptions)
  const setOptions = useCreateStore((s) => s.setCloudStudioOptions)
  const opModel = useCreateStore((s) => s.cloudOpModel)
  const videoInput = useCreateStore((s) => s.videoInput)
  const released = useCharacterHubReleased()
  const model = createRunModel('swap_character', { image: '', video: '', op: opModel })
  if (!released || !STUDIO_MODELS[model]) return null
  const resolutions = (studioFields(model).resolution?.enum ?? []) as string[]
  const resolution = String(studioShownValue(model, options, 'resolution') ?? '')
  return (
    <>
      {resolutions.length > 1 && (
        <div className="flex items-center gap-2.5 hub-fs-125">
          <span className="hub-muted w-[80px]">Resolution</span>
          <Segmented
            size="sm"
            layoutId="swap-resolution"
            ariaLabel="Resolution"
            value={resolution}
            onChange={(v) => setOptions({ ...options, resolution: v })}
            options={resolutions.map((r) => ({ value: r, label: r }))}
          />
        </div>
      )}
      {videoInput && (
        <ul className="hub-dim flex items-start gap-1.5 hub-fs-125" data-swap-tips>
          <Info size={12} className="mt-[2px] shrink-0" />
          <span className="space-y-0.5">{SWAP_TIPS.map((t) => <li key={t} className="list-none">{t}</li>)}</span>
        </ul>
      )}
    </>
  )
}

/** What can be done with the picked character's file: under More options
 *  of Image, and `bare` (without the name, on any tab) at the character on
 *  the stage. */
export function CharacterMore({ bare = false }: { bare?: boolean } = {}) {
  const backend = useCreateStore((s) => s.backend)
  const characterTab = useCreateStore((s) => s.characterTab)
  const hubCharacter = useCreateStore((s) => s.hubCharacter)
  const setSelectedCharacter = useCreateStore((s) => s.setSelectedCharacter)
  const setHubCharacter = useCreateStore((s) => s.setHubCharacter)
  const lora = hubCharacter?.lora
  const localFile = characterLoraFile(hubCharacter?.ref)
  if ((!bare && characterTab !== 'use') || !hubCharacter) return null
  if (localFile && hubCharacter.ref) {
    return (
      <div className="flex items-center gap-1 hub-fs-125" data-character-file-actions>
        {!bare && <span className="hub-muted mr-2">{hubCharacter.name}</span>}
        <LocalCharacterDelete file={localFile} trigger={hubCharacter.ref.triggerWord} />
      </div>
    )
  }
  if (backend !== 'cloud' || !lora) return null
  return (
    <div className="flex items-center gap-1 hub-fs-125" data-character-file-actions>
      {!bare && <span className="hub-muted mr-2">{hubCharacter.name}</span>}
      <CharacterDownload lora={lora} />
      <CharacterUseLocally lora={lora} />
      <button
        onClick={() => {
          void deleteLora(lora.id)
            .then(() => {
              setSelectedCharacter(null)
              setHubCharacter(null)
              useCreateStore.getState().setHubStep('who')
              useCreateStore.getState().bumpCharactersVersion()
            })
            .catch(() => {})
        }}
        className="p-1 text-gray-600 hover:text-red-400"
        title="Delete character"
        aria-label="Delete character"
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}

/** C7: says under the trigger field what it did to the typed word ("Jörg" is
 *  trained as "Joerg"), so the word on screen is visibly the word learned. */
function TriggerWordNote() {
  const note = useCreateStore((s) => s.triggerWordNote)
  if (!note) return null
  return <p role="status" data-testid="trigger-word-note" className={`w-full text-center t-micro ${HINWEIS_TEXT.ruhig}`}>{note}</p>
}

/** C8: asks before a new training replaces the character of the same name
 *  (stores/trainReplaceStore.ts). Same Modal as the shelf's delete question. */
function TrainReplaceDialog() {
  const pending = useTrainReplaceStore((s) => s.pending)
  const answer = useTrainReplaceStore((s) => s.answer)
  useEffect(() => useTrainReplaceStore.getState().mount(), [])
  return (
    <Modal open={!!pending} onClose={() => answer('rename')} title="Replace character?">
      <p className="t-micro text-gray-600 dark:text-gray-300 mb-3">
        A character named <span className="text-gray-900 dark:text-white font-mono">{pending}</span> already exists on this computer.
        Training with the same trigger word replaces its file when the run ends, and the old character is gone.
      </p>
      <ModalActions>
        <ModalButton variant="quiet" onClick={() => answer('rename')} data-testid="train-replace-rename">
          Pick another name
        </ModalButton>
        <ModalButton variant="danger" onClick={() => answer('replace')} data-testid="train-replace-confirm">
          Replace
        </ModalButton>
      </ModalActions>
    </Modal>
  )
}
