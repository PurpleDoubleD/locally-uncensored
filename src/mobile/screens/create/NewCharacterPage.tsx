/**
 * K11 New character. Route /create/characters/new, page, strand 3 (Create).
 *
 * K11.1 the name, K11.2 "Add photos" (4 to 30, the numbers the cloud
 * trainer takes), K11.3 the X of a photo, K11.4 "Train" with its price,
 * K11.5 the note about uploading over mobile data with "Wait for Wi-Fi".
 *
 * The training itself is the run of hooks/useCloudCreate.ts with the tool
 * "character" on its train side. It uploads the photos, books the job and
 * waits. The job is written down, so it goes on when the app is left.
 */
import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Wifi } from 'lucide-react'
import { useCloudCreate } from '../../../hooks/useCloudCreate'
import { signalCreditsExhausted } from '../../../lib/credits-exhausted'
import { MIN_TRAIN_IMAGES, maxTrainImages } from '../../../lib/train-image-cap'
import { stagedCount } from '../../../lib/train-upload'
import { useCreateStore } from '../../../stores/createStore'
import { nav } from '../../nav'
import { pickPhotos } from '../../platform/files'
import { CREATE_STRINGS as T } from '../../strings/create'
import { Button, Field, ListGroup, Notice, Page, Progress, Row, riskProps, toast } from '../../ui'
import { fileProblemText } from './parts/actions'
import { connectionKind, onConnectionChange, readConnectionKind, type ConnectionKind } from './parts/adapters/connection'
import { loadTrainPhoto } from './parts/photos'
import { pickModel, toolModels, useCatalogVersion } from './parts/catalog'
import { ErrorNotice } from './parts/ErrorNotice'
import { explainError } from './parts/errors'
import { useCreateFacts } from './parts/facts'
import { creditsLabel } from './parts/params'
import { withAiConsent } from './parts/policy'
import { PriceOwner } from './parts/PriceOwner'
import { installCreateServices, refreshPending, refreshQuota } from './parts/services'
import { RemoveX } from './parts/ui'
import './parts/create.css'

const MAX = maxTrainImages('cloud')

function useConnection(): ConnectionKind {
  const [kind, setKind] = useState<ConnectionKind>(() => connectionKind())
  useEffect(() => {
    let alive = true
    // The system is asked (native layer on iOS and Android), the WebView alone does not know on iOS.
    const ask = () => {
      void readConnectionKind().then((next) => {
        if (alive) setKind(next)
      })
    }
    ask()
    const off = onConnectionChange(ask)
    return () => {
      alive = false
      off()
    }
  }, [])
  return kind
}

/** "Uploading training photos 3/12" of the run, as numbers. */
function uploadStep(text: string): { done: number; total: number } | null {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text)
  return m && /upload/i.test(text) ? { done: Number(m[1]), total: Number(m[2]) } : null
}

export default function NewCharacterPage() {
  useCatalogVersion()
  const f = useCreateFacts()
  const name = useCreateStore((s) => s.triggerWord)
  const photos = useCreateStore((s) => s.trainImages)
  const running = useCreateStore((s) => s.isGenerating)
  const progress = useCreateStore((s) => s.progress)
  const progressText = useCreateStore((s) => s.progressText)
  const error = useCreateStore((s) => s.error)
  const opModel = useCreateStore((s) => s.cloudOpModel)
  const { generate, cancel } = useCloudCreate({ onQuotaChange: () => void refreshQuota() })
  const connection = useConnection()
  const [waitWifi, setWaitWifi] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [asked, setAsked] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    installCreateServices()
    // This page is the train side of the tool "character".
    const st = useCreateStore.getState()
    if (st.isGenerating) return
    if (st.intent() !== 'character') st.setIntent('character')
    useCreateStore.getState().setCharacterTab('train')
    useCreateStore.getState().setError(null)
  }, [])

  // How many photos an earlier attempt already brought up (read at render:
  // the notice that shows it only appears after a run ended).
  const keptUp = stagedCount(photos.map((p) => p.blob))
  const ready = f.tool === 'character' && !f.characterUse
  const trainers = ready ? toolModels('character', { character: null, characterUse: false, musicSeconds: 0, fallbackCredits: { image: null, video: null, audio: null } }) : []
  const trainerId = f.model.id || opModel

  const start = () => {
    started.current = true
    setWaiting(false)
    void withAiConsent(() => generate()).then((yes) => {
      if (!yes) started.current = false
    })
  }
  // Waiting for Wi-Fi: the run starts by itself when the phone is on it.
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    if (waiting && connection === 'wifi') startRef.current()
  }, [waiting, connection])

  // The run of this page came to its end.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (running) {
      wasRunning.current = true
      return
    }
    if (!wasRunning.current || !started.current) return
    wasRunning.current = false
    started.current = false
    refreshPending()
    const st = useCreateStore.getState()
    // "Cannot be stopped" was said during the run. When the training then came through (the run
    // itself emptied the photos), that sentence is over and the page ends like any training.
    const stoppedInVain = !!st.error && explainError(st.error).kind === 'cannot-stop' && st.trainImages.length === 0
    if (st.error && !stoppedInVain) return
    // A training that came through emptied the photos. Photos still there and no error: the run was
    // stopped (the shelf's Stop, or Stop during the upload). That is not "trained", and the shelf says
    // "Training cancelled" itself; this page used to toast "trained" over it and leave the shelf.
    if (!stoppedInVain && st.trainImages.length > 0) return
    if (stoppedInVain) st.setError(null)
    st.clearTrainImages()
    st.setTriggerWord('')
    st.bumpCharactersVersion()
    toast(T.newChar.done, { testid: 'create-character-trained' })
    void nav.back()
  }, [running])

  const add = async () => {
    setAdding(true)
    try {
      const picked = await pickPhotos({ multiple: true })
      if (picked.length === 0) return
      const room = Math.max(0, MAX - useCreateStore.getState().trainImages.length)
      const take = picked.slice(0, room)
      const refs = []
      let problem: string | null = null
      for (const p of take) {
        try {
          refs.push(await loadTrainPhoto(p.file))
        } catch (err) {
          problem = fileProblemText(err)
        }
      }
      if (refs.length) useCreateStore.getState().addTrainImages(refs)
      if (picked.length > room) toast(T.newChar.tooMany(MAX, picked.length - room), { testid: 'create-photos-too-many' })
      else if (problem) toast(problem, { tone: 'error', testid: 'create-photos-problem' })
    } finally {
      setAdding(false)
    }
  }

  const tooFew = photos.length < MIN_TRAIN_IMAGES
  const reason = !name.trim() ? T.newChar.nameMissing : tooFew ? T.newChar.tooFew(MIN_TRAIN_IMAGES) : f.block ? T.block[f.block] : undefined
  const onTrain = () => {
    setAsked(true)
    if (reason) return
    if (f.wallet !== 'ok') {
      signalCreditsExhausted(f.wallet)
      return
    }
    if (waitWifi && connection === 'cellular') {
      setWaiting(true)
      return
    }
    start()
  }

  const step = uploadStep(progressText)
  const uploading = running && (step !== null || progress <= 5)
  const explained = error ? explainError(error) : null
  const price = f.cost !== null ? creditsLabel(f.cost) : null

  return (
    <Page
      title={T.newChar.title}
      screen="create-character-new"
      needsNetwork
      flush
      footer={
        running ? (
          <Button block onPress={() => void cancel()} testid="m-create-train-cancel">
            {T.newChar.cancel}
          </Button>
        ) : waiting ? (
          <Button block onPress={() => setWaiting(false)} testid="m-create-train-wait-cancel">
            {T.newChar.cancel}
          </Button>
        ) : (
          <Button variant="cloud" risk="paid" block onPress={onTrain} disabled={!ready} disabledReason={undefined} testid="m-create-train" el="K11.4">
            {price ? T.newChar.train(price) : T.newChar.trainPlain}
            {asked && reason ? <span className="m-btn-hint">{reason}</span> : null}
          </Button>
        )
      }
    >
      <PriceOwner />
      {running ? (
        <div className="m-k-sec" data-testid="m-create-train-running" data-state={uploading ? 'uploading' : 'training'}>
          {uploading ? (
            <Progress
              label={T.newChar.uploadProgress}
              tone="cloud"
              value={step ? step.done / Math.max(1, step.total) : undefined}
              hidePercent
              detail={step ? T.newChar.uploading(step.done, step.total) : T.newChar.uploadingPlain}
            />
          ) : (
            <Notice title={T.newChar.training} testid="m-create-train-training">
              {T.newChar.trainingText}
            </Notice>
          )}
        </div>
      ) : null}
      {running && explained?.kind === 'cannot-stop' ? (
        <div className="m-k-sec">
          <Notice variant="warn" title={T.newChar.cannotStopTitle} testid="m-create-train-cannot-stop">
            {T.newChar.cannotStopText}
          </Notice>
        </div>
      ) : null}
      {waiting ? (
        <div className="m-k-sec">
          <Notice icon={Wifi} title={T.newChar.waitingWifi} testid="m-create-train-waiting">
            {T.newChar.cellular}
          </Notice>
        </div>
      ) : null}
      {error && explained && !running ? (
        <div className="m-k-sec">
          {explained.kind === 'network' ? (
            <Notice
              variant="error"
              title={T.newChar.uploadFailedTitle}
              testid="m-create-train-error"
              actions={
                <Button compact onPress={onTrain} testid="m-create-train-retry">
                  {T.newChar.retry}
                </Button>
              }
            >
              {keptUp > 0 ? T.newChar.uploadFailedKept(keptUp, photos.length) : T.newChar.uploadFailedText}
            </Notice>
          ) : (
            <ErrorNotice message={error} stillBooked={false} onRetry={onTrain} testid="m-create-train-error" />
          )}
        </div>
      ) : null}
      <div className="m-k-sec">
        <Field
          label={T.newChar.name}
          value={name}
          onChange={(v) => useCreateStore.getState().setTriggerWord(v)}
          placeholder={T.newChar.namePlaceholder}
          hint={T.newChar.nameHint}
          error={asked && !name.trim() ? T.newChar.nameMissing : undefined}
          disabled={running}
          maxLength={30}
          autoComplete="off"
          testid="m-create-char-name"
          el="K11.1"
        />
      </div>
      <div className="m-k-sec">
        <div className="m-label">
          {T.newChar.photos} <span data-testid="m-create-char-count">{T.newChar.photosCount(photos.length, MAX)}</span>
        </div>
        <p className="m-k-card-sub">{T.newChar.addHint(MIN_TRAIN_IMAGES, MAX)}</p>
        {asked && tooFew ? (
          <p className="m-k-blocked" role="alert" data-testid="m-create-char-too-few">
            {T.newChar.tooFew(MIN_TRAIN_IMAGES)}
          </p>
        ) : null}
      </div>
      <div className="m-k-photos">
        {photos.map((p, i) => (
          <div className="m-k-photo" key={p.name} data-testid="m-create-char-photo">
            <img src={p.url} alt="" loading="lazy" decoding="async" />
            {running ? null : <RemoveX label={T.newChar.remove(i + 1)} onPress={() => useCreateStore.getState().removeTrainImage(p.name)} testid="m-create-char-photo-remove" el="K11.3" />}
          </div>
        ))}
        {photos.length < MAX && !running ? (
          <button type="button" className="m-k-photo-add" onClick={() => void add()} aria-busy={adding || undefined} data-testid="m-create-char-add" {...riskProps('sensor')} data-el="K11.2">
            <ImagePlus aria-hidden="true" />
            <span>{adding ? T.newChar.preparing : T.newChar.add}</span>
          </button>
        ) : null}
      </div>
      {trainers.length > 1 ? (
        <ListGroup title={T.newChar.base} role="radiogroup" label={T.newChar.base}>
          {trainers.map((m) => (
            <Row
              key={m.id}
              title={m.label}
              subtitle={m.credits !== null ? creditsLabel(m.credits) : T.newChar.baseSub}
              radio={{ checked: trainerId === m.id, onSelect: () => pickModel('character', m.id) }}
              disabled={running}
              testid="m-create-char-base"
            />
          ))}
        </ListGroup>
      ) : null}
      <div className="m-k-sec" data-el="K11.5" data-testid="m-create-char-data" data-m-connection={connection}>
        {connection === 'cellular' ? (
          <ListGroup>
            <Row title={T.newChar.waitWifi} subtitle={T.newChar.cellular} icon={Wifi} switch={{ checked: waitWifi, onChange: setWaitWifi, tone: 'cloud' }} disabled={running} testid="m-create-char-wifi" />
          </ListGroup>
        ) : (
          <p className="m-k-card-sub">{connection === 'wifi' ? T.newChar.onWifi : T.newChar.cellularUnknown}</p>
        )}
      </div>
    </Page>
  )
}
