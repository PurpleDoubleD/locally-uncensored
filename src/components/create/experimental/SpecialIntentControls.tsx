// Composer surfaces for the 2.5.8 specialized Create categories
// (Character-Studio, talking character, music, extend, motion). Each intent
// owns exactly the inputs its lane consumes; everything stages into
// createStore slots. On the cloud backend useCloudCreate submits them; since
// 2.5.8 music / lipsync / extend / motion also run locally (useCreate's
// specialized lanes), and the surfaces below fork only where the two lanes
// genuinely differ (extend's source pick, the cloud voice maker).

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AudioLines, Download, Film, ImagePlus, Info, Mic, Music2, Trash2, Upload, Wand2, X,
} from 'lucide-react'
import { useCreateStore, type CreateIntent, type GalleryItem } from '../../../stores/createStore'
import { useCloudCatalogStore, cloudModelById, modelForOp } from '../../../stores/cloudCatalogStore'
import { listLoras, deleteLora, type CloudLora } from '../../../api/cloud/loras'
import {
  characterTrainerStatus, installCharacterTrainer, parseLocalCharacterLora,
  TRAINER_BASE_FILES, baseDownloadRunning, type TrainerStatus,
} from '../../../api/trainer'
import { startModelDownload, getDownloadProgress } from '../../../api/discover'
import { useDownloadStore } from '../../../stores/downloadStore'
import { getLoraModels } from '../../../api/comfyui'
import { musicTakesLyrics, musicHowtoLines } from '../../../lib/render/music-ui'
import { useCreateExp } from './CreateContext'
import { loadImageRef } from './loadImage'
import { mediaRefFrom } from './mediaRef'
import { fetchGalleryItemBlob } from './galleryUrl'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { Slider } from '../ui/Slider'
import { cn } from '../ui/cn'
import { useClickAway } from '../ui/useClickAway'

export function SpecialControls({ intent }: { intent: CreateIntent }) {
  switch (intent) {
    case 'character': return <CharacterPanel />
    case 'lipsync': return <LipsyncControls />
    case 'music': return <MusicControls />
    case 'extend': return <ExtendControls />
    case 'motion': return <MotionControls />
    default: return null
  }
}

// ── shared chip: a small labeled file slot (audio/video/image) ──────────────
//
// `mediaRefFrom` used to be defined right here, and the training board in
// Stage.tsx had its own inline copy of the same two lines. Two mints, one
// release — and it was the copy without a release. Both now come from
// `./mediaRef`, whose counterpart in createStore is
// `releaseDroppedMediaRefs`. Do NOT revoke in this file: the ref outlives the
// component, it lives in the store.

function FileChip({
  icon: Icon,
  empty,
  value,
  accept,
  onFile,
  onClear,
}: {
  icon: typeof Upload
  empty: string
  value: string | null
  accept: string
  onFile: (f: File) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className={cn(
          't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
          value
            ? 'bg-white/[0.06] border-white/10 text-gray-200'
            : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200 hover:border-white/15',
        )}
      >
        <Icon size={12} />
        <span className="max-w-[140px] truncate">{value ?? empty}</span>
      </button>
      {value && (
        <button onClick={onClear} className="p-1 text-gray-500 hover:text-gray-300" title="Remove" aria-label="Remove">
          <X size={11} />
        </button>
      )}
    </div>
  )
}

// The character-image slot writes the shared Stage source (an ImageRef with a
// data-URL preview — the cloud upload path re-encodes from it).
function PortraitChip({ empty }: { empty: string }) {
  const source = useCreateStore((s) => s.source)
  const setSource = useCreateStore((s) => s.setSource)
  return (
    <FileChip
      icon={ImagePlus}
      empty={empty}
      value={source ? 'Image ready' : null}
      accept="image/*"
      onFile={(f) => { void loadImageRef(f).then(setSource) }}
      onClear={() => setSource(null)}
    />
  )
}

function DrivingVideoChip({ empty }: { empty: string }) {
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  return (
    <FileChip
      icon={Film}
      empty={empty}
      value={videoInput?.name ?? null}
      accept="video/mp4,video/webm,video/quicktime"
      onFile={(f) => setVideoInput(mediaRefFrom(f))}
      onClear={() => setVideoInput(null)}
    />
  )
}

// ── Character-Studio ────────────────────────────────────────────────────────

const FAMILY_LABEL: Record<string, string> = {
  flux: 'Flux',
  'z-image': 'Z-Image',
  'qwen-image': 'Qwen',
  'ltx-2': 'LTX video',
}

function CharacterPanel() {
  const backend = useCreateStore((s) => s.backend)
  const characterTab = useCreateStore((s) => s.characterTab)
  const setCharacterTab = useCreateStore((s) => s.setCharacterTab)
  const triggerWord = useCreateStore((s) => s.triggerWord)
  const setTriggerWord = useCreateStore((s) => s.setTriggerWord)
  const trainImages = useCreateStore((s) => s.trainImages)
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  const setSelectedCharacter = useCreateStore((s) => s.setSelectedCharacter)
  const charactersVersion = useCreateStore((s) => s.charactersVersion)
  const localLane = backend !== 'cloud'
  const [shelf, setShelf] = useState<CloudLora[] | null>(null)

  useEffect(() => {
    if (localLane) return
    let live = true
    listLoras()
      .then((l) => { if (live) setShelf(l) })
      .catch(() => { if (live) setShelf([]) })
    return () => { live = false }
  }, [charactersVersion, localLane])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center">
        <Segmented
          size="sm"
          layoutId="character-tab"
          value={characterTab}
          onChange={(v) => setCharacterTab(v as 'train' | 'use')}
          options={[
            { value: 'train', label: 'Train new' },
            { value: 'use', label: 'Use character' },
          ]}
        />
      </div>
      {characterTab === 'train' && localLane ? (
        <LocalTrainControls />
      ) : characterTab === 'use' && localLane ? (
        <LocalCharacterShelf />
      ) : characterTab === 'train' ? (
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <input
            value={triggerWord}
            onChange={(e) => setTriggerWord(e.target.value)}
            placeholder="Trigger word, e.g. davechar"
            className="t-control w-44 px-2.5 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15"
          />
          <span className="t-label text-gray-600">
            {trainImages.length}/30 photos added{trainImages.length < 4 ? ', need at least 4' : ''}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          {shelf === null && <span className="t-label text-gray-600">Loading your characters…</span>}
          {shelf?.length === 0 && (
            <span className="t-label text-gray-600">No characters yet. Train one first.</span>
          )}
          {shelf?.map((c) => {
            const active = selectedCharacter?.id === c.id
            return (
              <div key={c.id} className="flex items-center">
                <button
                  onClick={() =>
                    setSelectedCharacter(
                      active
                        ? null
                        : { id: c.id, name: c.name, triggerWord: c.trigger_word, family: c.base_family },
                    )
                  }
                  className={cn(
                    't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
                    active
                      ? 'bg-white/10 border-white/20 text-white'
                      : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200',
                  )}
                  title={`Trigger word: ${c.trigger_word}`}
                >
                  <span className="max-w-[110px] truncate">{c.name}</span>
                  <span className="t-label text-gray-500">{FAMILY_LABEL[c.base_family] ?? c.base_family}</span>
                </button>
                <button
                  onClick={() => {
                    void deleteLora(c.id)
                      .then(() => {
                        if (selectedCharacter?.id === c.id) setSelectedCharacter(null)
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
          })}
          {selectedCharacter && (
            <span className="t-label text-gray-500 w-full text-center">
              Put “{selectedCharacter.triggerWord}” in your prompt to summon the character.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// Local training readiness + inputs (2.5.8 A5). Three gates render in order:
// trainer env (one-time musubi setup) -> Z-Image base files -> the actual
// trigger/steps inputs. The Rust side is the source of truth for readiness.
function LocalTrainControls() {
  const triggerWord = useCreateStore((s) => s.triggerWord)
  const setTriggerWord = useCreateStore((s) => s.setTriggerWord)
  const trainImages = useCreateStore((s) => s.trainImages)
  const trainSteps = useCreateStore((s) => s.trainSteps)
  const setTrainSteps = useCreateStore((s) => s.setTrainSteps)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const [status, setStatus] = useState<TrainerStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'bases' | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    characterTrainerStatus().then(setStatus).catch(() => setStatus(null))
  }, [])
  useEffect(() => { refresh() }, [refresh])

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
        const rows = TRAINER_BASE_FILES.map((f) => prog[f.filename]).filter(Boolean)
        const active = rows.find((r) => r.status === 'downloading' || r.status === 'connecting')
        if (active) {
          const pct = active.total > 0 ? Math.round((active.progress / active.total) * 100) : 0
          setNote(`Downloading ${active.filename} (${pct}%)...`)
          return
        }
        const failed = rows.find((r) => r.status === 'error')
        const s = await characterTrainerStatus().catch(() => null)
        if (s) setStatus(s)
        if (failed) {
          setNote(failed.error ?? 'Download failed. Check your connection and retry.')
          setBusy(null)
        } else if (s?.basesReady) {
          setNote(null)
          setBusy(null)
        }
      }
    }, 2000)
    return () => clearInterval(t)
  }, [busy])

  const startInstall = async () => {
    setBusy('install')
    setNote('Setting up the trainer...')
    try { await installCharacterTrainer() } catch (e) {
      setNote(e instanceof Error ? e.message : 'Install could not start.')
      setBusy(null)
    }
  }
  const startBases = async () => {
    if (!status) return
    setBusy('bases')
    setNote('Starting the downloads...')
    const missing = TRAINER_BASE_FILES.filter((f) =>
      (f.subfolder === 'diffusion_models' && !status.dit) ||
      (f.subfolder === 'text_encoders' && !status.textEncoder) ||
      (f.subfolder === 'vae' && !status.vae))
    // Same tray registration the Create install cards do: without it the header
    // Downloads tray reads "No active downloads" through a multi GB transfer and
    // its cancel + retry buttons never appear.
    const dl = useDownloadStore.getState()
    if (missing.length > 1) dl.setBundleGroup('Character Studio base models', missing.map((f) => f.filename))
    for (const f of missing) {
      dl.setMeta(f.filename, f.url, f.subfolder)
      try { await startModelDownload(f.url, f.subfolder, f.filename) } catch (e) {
        setNote(e instanceof Error ? e.message : `Could not start ${f.filename}.`)
      }
      dl.startPolling()
    }
  }

  if (!status) {
    return <div className="t-label text-gray-600 text-center">Checking the local trainer…</div>
  }
  if (!status.envReady || (busy === 'install' && status.install.status === 'installing')) {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2">
          <span className="t-label text-gray-500">Trains fully on your GPU. One time setup, about 3 GB.</span>
          <Button size="sm" variant="secondary" icon={Download} loading={busy === 'install'} disabled={busy === 'install'} onClick={startInstall}>
            {busy === 'install' ? 'Setting up…' : 'Set up trainer'}
          </Button>
        </div>
        {note && <div className="t-label text-gray-600 max-w-[520px] text-center break-words">{note}</div>}
      </div>
    )
  }
  if (!status.basesReady) {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2">
          <span className="t-label text-gray-500">Z Image training base files are missing (about 19 GB, one time).</span>
          <Button size="sm" variant="secondary" icon={Download} loading={busy === 'bases'} disabled={busy === 'bases'} onClick={startBases}>
            {busy === 'bases' ? 'Downloading…' : 'Download base files'}
          </Button>
        </div>
        {note && <div className="t-label text-gray-600 max-w-[520px] text-center break-words">{note}</div>}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <input
          value={triggerWord}
          onChange={(e) => setTriggerWord(e.target.value)}
          placeholder="Trigger word, e.g. davechar"
          className="t-control w-44 px-2.5 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15"
        />
        <Segmented
          size="sm"
          layoutId="train-steps"
          value={String(trainSteps)}
          onChange={(v) => setTrainSteps(Number(v))}
          options={[
            { value: '400', label: 'Quick' },
            { value: '1200', label: 'Standard' },
            { value: '2400', label: 'Thorough' },
          ]}
        />
        <span className="t-label text-gray-600">
          {trainImages.length}/30 photos{trainImages.length < 4 ? ', need at least 4' : ''}
        </span>
      </div>
      {!isGenerating && (
        <div className="t-label text-gray-600 flex items-center gap-1.5">
          <span>Runs on your GPU and takes a while ({trainSteps} steps). The local chat model pauses for the run. The character lands in your local LoRAs.</span>
          {/* The run repairs its own environment now (A2), so this is no
              longer the only way out of a broken install. It stays because
              the button used to render ONLY while the environment counted as
              not ready, which is exactly when a customer with a stale torch
              build could not reach it (bob80817, D#102). */}
          <button
            type="button"
            onClick={startInstall}
            disabled={busy === 'install'}
            className="underline underline-offset-2 text-gray-500 hover:text-gray-300 disabled:opacity-50 transition-colors"
          >
            {busy === 'install' ? 'Reinstalling…' : 'Reinstall trainer'}
          </button>
        </div>
      )}
    </div>
  )
}

// Local Use shelf: characters are the trainer's own `char_<name>_zimage`
// LoRA files. Picking one activates the LoRA on the normal image chain and
// surfaces the trigger word; generation itself is the plain local image path.
function LocalCharacterShelf() {
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  const setSelectedCharacter = useCreateStore((s) => s.setSelectedCharacter)
  const selectedLoras = useCreateStore((s) => s.selectedLoras)
  const toggleLora = useCreateStore((s) => s.toggleLora)
  const charactersVersion = useCreateStore((s) => s.charactersVersion)
  const [files, setFiles] = useState<string[] | null>(null)

  useEffect(() => {
    let live = true
    getLoraModels()
      .then((l) => { if (live) setFiles(l) })
      .catch(() => { if (live) setFiles([]) })
    return () => { live = false }
  }, [charactersVersion])

  const chars = (files ?? []).map(parseLocalCharacterLora)
    .filter((c): c is NonNullable<ReturnType<typeof parseLocalCharacterLora>> => c !== null)

  return (
    <div className="flex items-center justify-center gap-1.5 flex-wrap">
      {files === null && <span className="t-label text-gray-600">Loading your characters…</span>}
      {files !== null && chars.length === 0 && (
        <span className="t-label text-gray-600">No local characters yet. Train one first.</span>
      )}
      {chars.map((c) => {
        const active = selectedCharacter?.id === `local:${c.file}`
        return (
          <button
            key={c.file}
            onClick={() => {
              if (active) {
                setSelectedCharacter(null)
                if (selectedLoras.some((l) => l.name === c.file)) toggleLora(c.file)
                return
              }
              // One character at a time: drop other char LoRAs from the chain.
              for (const l of selectedLoras) {
                if (l.name !== c.file && parseLocalCharacterLora(l.name)) toggleLora(l.name)
              }
              if (!selectedLoras.some((l) => l.name === c.file)) toggleLora(c.file)
              setSelectedCharacter({ id: `local:${c.file}`, name: c.trigger, triggerWord: c.trigger, family: 'z-image' })
            }}
            className={cn(
              't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
              active
                ? 'bg-white/10 border-white/20 text-white'
                : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200',
            )}
            title={`Trigger word: ${c.trigger}`}
          >
            <span className="max-w-[110px] truncate">{c.trigger}</span>
            <span className="t-label text-gray-500">Z-Image</span>
          </button>
        )
      })}
      {selectedCharacter && (
        <span className="t-label text-gray-500 w-full text-center">
          Put “{selectedCharacter.triggerWord}” in your prompt. Works best with a Z Image base model.
        </span>
      )}
    </div>
  )
}

// ── Talking character (lipsync) ─────────────────────────────────────────────

function LipsyncControls() {
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const audioInput = useCreateStore((s) => s.audioInput)
  const setAudioInput = useCreateStore((s) => s.setAudioInput)
  const voiceFromJob = useCreateStore((s) => s.voiceFromJob)
  const setVoiceFromJob = useCreateStore((s) => s.setVoiceFromJob)
  // Catalog subscription so the chip row re-renders when the live catalog
  // arrives and flips the picked model's source type.
  useCloudCatalogStore((s) => s.fetchedAt)
  const model = cloudModelById(modelForOp('video', 'lipsync', cloudOpModel))
  const needsClip = model?.lipsync_source === 'video'

  return (
    <div className="flex items-center justify-center gap-2 flex-wrap">
      {needsClip ? (
        <DrivingVideoChip empty="Add video to resync" />
      ) : (
        <PortraitChip empty="Add portrait" />
      )}
      <VoiceChip
        audioName={audioInput?.name ?? null}
        voiceLabel={voiceFromJob?.label ?? null}
        onAudioFile={(f) => setAudioInput(mediaRefFrom(f))}
        onPickVoice={(jobId, label) => setVoiceFromJob({ jobId, label })}
        onClear={() => { setAudioInput(null); setVoiceFromJob(null) }}
      />
    </div>
  )
}

// The hosted tts endpoint requires one of WaveSpeed's own preset voices —
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
}: {
  audioName: string | null
  voiceLabel: string | null
  onAudioFile: (f: File) => void
  onPickVoice: (jobId: string, label: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [makerOpen, setMakerOpen] = useState(false)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'speak' | 'design'>('speak')
  const [voice, setVoice] = useState<string>(TTS_VOICES[0])
  const [description, setDescription] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => { setOpen(false); setMakerOpen(false) }, open || makerOpen)
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
          't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
          value
            ? 'bg-white/[0.06] border-white/10 text-gray-200'
            : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200 hover:border-white/15',
        )}
      >
        <Mic size={12} />
        <span className="max-w-[150px] truncate">{value ?? 'Add voice'}</span>
      </button>
      {value && (
        <button onClick={onClear} className="p-1 text-gray-500 hover:text-gray-300" title="Remove voice" aria-label="Remove voice">
          <X size={11} />
        </button>
      )}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="lu-elevated absolute bottom-full mb-1.5 left-0 z-50 w-72 rounded-lg p-1.5 space-y-1"
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
                      className="t-control flex-1 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 focus:outline-none"
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
                      className="t-control flex-1 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none"
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
                  Make voice
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
  // Cloud: only ace-step-1.5 has a lyrics input on the wire (catalog `lyrics`
  // flag); the other music endpoints write their own lyrics from the prompt,
  // so offering the box there would be a lie.
  // Local: every music checkpoint runs through buildMusicWorkflow, which feeds
  // `lyrics` straight into the ACE-Step encoder. Asking the CLOUD catalog about
  // a local checkpoint returns undefined, which is how the local tab ended up
  // hiding the lyrics box and claiming the model writes its own, while sitting
  // on the one model that sings yours (#108, ElBiggus).
  const canLyrics = musicTakesLyrics(
    isCloud ? 'cloud' : 'local',
    cloudModelById(modelForOp('audio', 'music', cloudOpModel))?.lyrics === true,
  )
  const howtoLines = musicHowtoLines(isCloud ? 'cloud' : 'local')
  const musicHowtoSeen = useCreateStore((s) => s.musicHowtoSeen)
  const setMusicHowtoSeen = useCreateStore((s) => s.setMusicHowtoSeen)
  const [lyricsOpen, setLyricsOpen] = useState(musicLyrics.length > 0)
  const [howtoOpen, setHowtoOpen] = useState(false)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center gap-3">
        <div className="w-56">
          <Slider
            label="Length"
            min={5}
            max={240}
            step={5}
            value={musicDuration}
            onChange={setMusicDuration}
            format={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`}
          />
        </div>
        {canLyrics ? (
          <button
            onClick={() => setLyricsOpen((o) => !o)}
            className={cn(
              't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
              lyricsOpen
                ? 'bg-white/[0.06] border-white/10 text-gray-200'
                : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200',
            )}
          >
            <Music2 size={12} /> Lyrics
          </button>
        ) : (
          <span className="t-control text-gray-500">
            This model writes its own lyrics from the prompt. Pick ACE-Step 1.5 to sing yours.
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
                  models and per-second billing (#108). */}
              {howtoLines.map((line, i) => (
                <p key={i} className={i === 0 ? 'text-gray-200' : undefined}>{line}</p>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {canLyrics && lyricsOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <textarea
              value={musicLyrics}
              onChange={(e) => setMusicLyrics(e.target.value)}
              placeholder="Your lyrics. [Verse] and [Chorus] markers make them sing best…"
              rows={3}
              className="w-full t-control px-2.5 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15 resize-none"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Extend ──────────────────────────────────────────────────────────────────

/** Grab the LAST frame of a video (blob URL or object URL) as a PNG File —
 *  the local extend lane feeds it to the regular I2V graph as the start
 *  image. Uses a same-origin blob URL so the canvas never taints. */
async function lastFrameFile(videoUrl: string, name: string): Promise<File> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = videoUrl
  await new Promise<void>((res, rej) => {
    video.onloadedmetadata = () => res()
    video.onerror = () => rej(new Error('could not read the video'))
  })
  // Seek close to the end; some containers refuse duration exactly.
  video.currentTime = Math.max(0, (video.duration || 1) - 0.05)
  await new Promise<void>((res, rej) => {
    video.onseeked = () => res()
    video.onerror = () => rej(new Error('could not seek the video'))
  })
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth || 832
  canvas.height = video.videoHeight || 480
  canvas.getContext('2d')!.drawImage(video, 0, 0)
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('could not capture the frame'))), 'image/png'))
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

  const adopt = async (getUrl: () => Promise<{ url: string; revoke?: () => void }>, label: string) => {
    setBusy(true)
    setError(null)
    try {
      const { url, revoke } = await getUrl()
      try {
        const frame = await lastFrameFile(url, label)
        setSource(await loadImageRef(frame))
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
      return { url, revoke: () => URL.revokeObjectURL(url) }
    }, g.prompt.slice(0, 40) || 'Local video')

  const fromFile = (f: File) =>
    adopt(async () => {
      const url = URL.createObjectURL(f)
      return { url, revoke: () => URL.revokeObjectURL(url) }
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
            onClick={() => { setSource(null); setPickedLabel(null) }}
            className="p-1 text-gray-500 hover:text-gray-300" title="Clear" aria-label="Clear"
          >
            <X size={11} />
          </button>
        )}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.12 }}
              className="lu-elevated absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-50 w-72 rounded-lg p-1 max-h-64 overflow-y-auto scrollbar-thin"
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
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.12 }}
              className="lu-elevated absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-50 w-72 rounded-lg p-1 max-h-64 overflow-y-auto scrollbar-thin"
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
                      label: g.prompt.slice(0, 40) || 'Cloud video',
                    })
                    setOpen(false)
                  }}
                  className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                >
                  <Film size={12} />
                  <span className="truncate">{g.prompt || 'Cloud video'}</span>
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

function MotionControls() {
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap">
      <PortraitChip empty="Add character image" />
      <DrivingVideoChip empty="Add driving video (dance/pose)" />
    </div>
  )
}
