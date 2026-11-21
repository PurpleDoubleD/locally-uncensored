// The Character area of Create (3.1.0 part B), as David set it on 16.11.2026:
// the prompt window is the same Composer as in every tab, 660 wide, at the
// same place under the area (CreateExperimental renders it). The area is one
// column of that width above it:
//
//   no character   the three steps and "Create a character" (HubEmpty)
//   new            the page that makes one from photos or a LoRA file
//                  (HubNewCharacter)
//   the stage      the characters as tabs, what the picked one can do
//                  behind the three dots at its tab, under the row the
//                  inputs of the action and its photos
//   training       a page of its own, the panel as it was
//
// What the action is stands in the row over the window (HubActionRow), and
// what the window's button does in the states the tab's run does not cover
// is said through hubRun. The inner intent ids and the panels of the actions
// are untouched (lib/create/character-hub.ts).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, Film, X } from 'lucide-react'
import { useCreateStore } from '../../../../stores/createStore'
import { actionOfIntent, type HubCharacter } from '../../../../lib/create/character-hub'
import { useCreateExp } from '../CreateContext'
import { Stage, useStageSetupCard } from '../Stage'
import { SpecialControls } from '../SpecialIntentControls'
import { ModelChip } from '../ModelChip'
import { HubCharactersContext } from './HubParts'
import { HubEmpty } from './HubEmpty'
import { HubNewCharacter } from './HubNewCharacter'
import { HubPhotos, HubTabs } from './HubStage'
import { SwapOneClick, useSwapOneClickShown } from './SwapOneClick'
import { imageFromPhotos, openStageAction, useCharacterPhotos, useHubCharacters } from './hubCharacters'
import { useHubRun, type HubStageSlot } from './hubRun'

/** How long the first page waits for the list before it shows itself. */
const LIST_GRACE_MS = 1500

interface Props {
  /** The props the Stage takes, as CreateExperimental hands them to it. */
  stage: Omit<React.ComponentProps<typeof Stage>, 'hub'>
  /** "Frames from a gallery video": the gallery opens, a clip there saves its frames. */
  onOpenGallery: () => void
}

export function CharacterHub({ stage, onOpenGallery }: Props) {
  const step = useCreateStore((s) => s.hubStep)
  const intent = useCreateStore((s) => s.intent())
  const characterTab = useCreateStore((s) => s.characterTab)
  const picked = useCreateStore((s) => s.hubCharacter)
  const setHubCharacter = useCreateStore((s) => s.setHubCharacter)
  const setHubStep = useCreateStore((s) => s.setHubStep)
  const setError = useCreateStore((s) => s.setError)
  const { list, loading } = useHubCharacters()
  // Swap with the account switch on the cloud: the one click flow, run
  // through the same prompt window (hub/SwapOneClick.tsx).
  const oneClick = useSwapOneClickShown()

  // The character as the list has it now (a new name, a new picture), for as
  // long as it is in the list.
  const current = (picked && list.find((c) => c.key === picked.key)) || picked
  const training = step === 'panel' && intent === 'character' && characterTab === 'train'
  const onStage = (step === 'what' || step === 'panel') && !training
  const photoImage = useCreateStore((s) => s.hubPhotoImage)
  const action = onStage ? (photoImage ? 'image' as const : actionOfIntent(intent)) : null
  // A one-time download of this action: its card stands alone (David, 21.11.).
  const setupCard = useStageSetupCard(stage.comfyStarting) && action !== 'image'
  const { photos, loading: photosLoading } = useCharacterPhotos(onStage ? current : null)

  // The stage: a training set left open is not an action of it.
  const toStage = (to: 'what' | 'who') => {
    const st = useCreateStore.getState()
    if (st.characterTab === 'train') st.setCharacterTab('use')
    setHubStep(to)
  }

  // Outside the training page the tab is not the training: the row over the
  // window shows Image, so the window is Image's (a field, Create).
  useEffect(() => {
    if (step !== 'panel' && intent === 'character' && characterTab === 'train') useCreateStore.getState().setCharacterTab('use')
  }, [step, intent, characterTab])

  // Nobody picked yet, and there are characters: the first one takes the
  // stage, so the area opens on something of the user's own. Image is the
  // action it opens on; nothing of the character is put into the run before
  // somebody asks for a picture (the window's button does that, below).
  const first = list[0]
  useEffect(() => {
    if (step === 'who' && first) {
      const st = useCreateStore.getState()
      setHubCharacter(first)
      st.setIntent('character')
      st.setCharacterTab('use')
      // A LoRA file of this machine would join the image chain and bring its
      // model along (the Image tab reads both): that waits for the button.
      // A cloud character is only a name for the run of this tab.
      if (first.kind !== 'local') st.setSelectedCharacter(first.ref ?? null)
      setHubStep('panel')
    }
  }, [step, first, setHubCharacter, setHubStep])

  // Image opened from outside the stage (a training that just finished, a
  // Reuse from the gallery) runs on a character nobody picked here: that
  // character takes the stage, so its tab says who the picture will show.
  const running = useCreateStore((s) => s.selectedCharacter)
  const runningOnStage = action === 'image' && !picked && running ? list.find((c) => c.ref?.id === running.id) : undefined
  useEffect(() => {
    if (runningOnStage) setHubCharacter(runningOnStage)
  }, [runningOnStage, setHubCharacter])

  // A list that is slow to answer (the cloud does not reach us) holds the
  // first page back for a moment only, so nobody with characters sees it
  // flash, and nobody without a connection waits for it.
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    if (step !== 'who' || !loading) return
    const t = setTimeout(() => setWaited(true), LIST_GRACE_MS)
    return () => clearTimeout(t)
  }, [step, loading])

  // Image with a photo character is an Edit with its photos (imageFromPhotos):
  // it starts as soon as such a character is on the stage on Image.
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const photoIdle = onStage && action === 'image' && !isGenerating && !!current && !current.ref
    && (current.photos?.length ?? 0) > 0 && photoImage?.key !== current.key ? current : null
  useEffect(() => {
    if (photoIdle) void imageFromPhotos(photoIdle).then((err) => { if (err) setError(err) })
  }, [photoIdle?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the training: to the page with the photos and the name, when
  // that is where it came from. Nothing is lost, what changed here comes along.
  const backFromTraining = () => {
    const st = useCreateStore.getState()
    const draft = st.hubNewDraft
    if (!draft || st.isGenerating) { toStage(picked ? 'what' : 'who'); return }
    const photos = st.trainImages.map((i) => (i.blob instanceof File ? i.blob : new File([i.blob], i.name, { type: i.blob.type || 'image/jpeg' })))
    const captions = st.trainImages.map((i) => st.trainCaptions[i.name] ?? '')
    st.setHubNewDraft({ ...draft, photos, captions, trigger: st.triggerWord, back: true })
    st.clearTrainImages()
    st.setCharacterTab('use')
    setHubStep('new')
  }
  const fromNew = useCreateStore((s) => !!s.hubNewDraft)
  const cloudTraining = useCreateStore((s) => s.backend === 'cloud')

  const pick = (c: HubCharacter | null) => {
    setHubCharacter(c)
    void openStageAction(action ?? 'image', c, true).then((err) => { if (err) setError(err) })
  }

  useStageSlot({ step, training, action, current, oneClick, setupCard })
  // Image: the notes of the run stand once the character is in it.
  const inRun = !!current?.ref && running?.id === current.ref.id
  const fromPhotos = !!current && !current.ref && (current.photos?.length ?? 0) > 0

  let body: ReactNode
  if (step === 'new') {
    body = (
      <HubNewCharacter
        onBack={() => toStage(picked ? 'what' : 'who')}
        onSaved={(c) => { setHubCharacter(c); toStage(c ? 'what' : 'who') }}
        onOpenGallery={onOpenGallery}
      />
    )
  } else if (training) {
    body = (
      <div className="hub-page" data-hub-training>
        <div className="hub-line flex h-[35px] shrink-0 items-center justify-center gap-2 border-b hub-fs-13">
          <button type="button" onClick={backFromTraining} className="hub-muted flex items-center gap-1" data-hub-back>
            <ChevronLeft size={13} />{fromNew ? 'Photos and name' : 'Characters'}
          </button>
          <span className="hub-dim" aria-hidden>/</span>
          <span className="hub-text font-medium">Train a model</span>
        </div>
        <div className="hub-train-scroll">
          <div className="hub-center">
            {/* What is next and its button first, the photos under it. */}
            <HubPanel />
            <div className="empty:hidden"><Stage hub {...stage} /></div>
            {/* On the cloud the trainer is a choice; locally it is a note under More options. */}
            {cloudTraining && <div className="flex justify-center pt-1 empty:hidden" data-hub-train-model><ModelChip /></div>}
          </div>
        </div>
      </div>
    )
  } else if (step === 'who') {
    body = loading && !waited
      ? <p className="hub-dim py-6 text-center hub-fs-13" data-hub-step="who">Loading your characters…</p>
      : <HubEmpty onCreate={() => setHubStep('new')} />
  } else {
    body = (
      <div className="hub-stage" data-hub-stage>
        <HubTabs
          list={list}
          loading={loading}
          current={current?.key ?? null}
          character={current}
          photoOnly={!current}
          onPick={pick}
          onPhotoOnly={() => pick(null)}
          onNew={() => setHubStep('new')}
        />
        {/* One scroll for what stands under the row. What is shorter than the room
            (a character without photos) stands in its middle, between the
            row of the characters and the row over the prompt window; what
            fills it starts at the top. */}
        <div className="hub-scroll scrollbar-thin">
        <div className="hub-center">
        <StageClip />
        {oneClick ? (
          <SwapOneClick onChangeCharacter={() => toStage('what')} />
        ) : (
          <div className="hub-body pb-4">
            <div className="pt-3 empty:hidden"><Stage hub {...stage} /></div>
            {!setupCard && (action !== 'image' || inRun || !current) && <HubPanel />}
            {action === 'image' && fromPhotos && (
              <p className="hub-dim pt-3 text-center hub-fs-125" data-hub-from-photos>New pictures use the photos of {current.name} as reference.</p>
            )}
            {action === 'image' && <div className="pt-4"><HubPhotos c={current} photos={photos} loading={photosLoading} /></div>}
          </div>
        )}
        </div>
        </div>
      </div>
    )
  }

  return (
    <HubCharactersContext.Provider value={list}>
      {/* The column of the prompt window under it (index.css, .lu-hub-row). */}
      <section className="lu-hub hub-column" data-character-hub={step} aria-label="Character">
        {body}
      </section>
    </HubCharactersContext.Provider>
  )
}

/** What the stage says about the prompt window (hub/hubRun.ts): the line in
 *  its field, and the button in the states the tab's own run does not cover.
 *  The one click swap writes its own slot. */
function useStageSlot({ step, training, action, current, oneClick, setupCard }: {
  step: string; training: boolean; action: ReturnType<typeof actionOfIntent>; current: HubCharacter | null; oneClick: boolean; setupCard: boolean
}) {
  const { generate } = useCreateExp()
  const setStage = useHubRun((s) => s.setStage)
  const prompt = useCreateStore((s) => s.prompt.trim().length > 0)
  const selected = useCreateStore((s) => s.selectedCharacter?.id ?? null)
  const setError = useCreateStore((s) => s.setError)
  const name = current?.name ?? null
  const key = current?.key ?? null
  const ref = current?.ref?.id ?? null
  const photoCharacter = !!current && !current.ref && (current.photos?.length ?? 0) > 0
  // The character as it is when the button is pressed (the list hands out a
  // new object on every load; the slot goes by its key).
  const onStage = useRef(current)
  const start = useRef(generate)
  useEffect(() => { onStage.current = current; start.current = generate }, [current, generate])
  const slot = useMemo<HubStageSlot | null>(() => {
    if (training || oneClick) return null
    const wait = (hint: string): HubStageSlot => ({ placeholder: 'Describe a new picture of your character', run: { label: 'Create', ready: false, hint, run: () => {} } })
    if (step === 'new') return wait('Save the character first.')
    if (step === 'who') return wait('Create a character first.')
    // The card of a one-time download says it all: no second line over the window.
    if (setupCard) return { run: { label: 'Create', ready: false, run: () => {} } }
    if (action !== 'image') return null
    if (!key) return wait('Pick a character for Image. A photo is enough for Swap and Motion.')
    const placeholder = `Describe a new picture of ${name}`
    if (photoCharacter) {
      // No LoRA to run: the window runs an Edit with the photos, right here.
      return { placeholder }
    }
    if (ref && selected !== ref) {
      // The character is on the stage and not yet in the run: Create puts
      // it there (its LoRA, its model) and starts.
      return {
        placeholder,
        run: {
          label: 'Create',
          ready: prompt,
          run: () => {
            void openStageAction('image', onStage.current).then((err) => {
              if (err) { setError(err); return }
              void start.current()
            })
          },
        },
      }
    }
    return { placeholder }
  }, [training, oneClick, step, action, key, name, ref, photoCharacter, selected, prompt, setError, setupCard])
  useEffect(() => { setStage(slot) }, [slot, setStage])
  useEffect(() => () => setStage(null), [setStage])
}

// ── the panel of an action ──────────────────────────────────────────────────

/** The clip the action holds, by its name, with the way to take it out. Swap
 *  hands it on to Motion and Talk, so it stands where all three see it. */
function StageClip() {
  const intent = useCreateStore((s) => s.intent())
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  if (!videoInput || !(intent === 'swap_character' || intent === 'motion' || intent === 'lipsync')) return null
  return (
    <p className="hub-muted flex min-h-8 shrink-0 items-center justify-center gap-1.5 hub-fs-12" data-hub-clip>
      <Film size={13} className="hub-dim shrink-0" />
      <span className="min-w-0 truncate">{videoInput.name}</span>
      <button type="button" onClick={() => setVideoInput(null)} className="hub-dim p-0.5" title="Remove the video" aria-label="Remove the video">
        <X size={12} />
      </button>
    </p>
  )
}

/** The inputs of the picked action: the lines of Motion, Talk and Swap, the
 *  notes of Image, the training. Its model and its other settings are in the
 *  settings of the prompt window (AdvancedDrawer). */
function HubPanel() {
  const intent = useCreateStore((s) => s.intent())
  return (
    <div data-hub-step="panel" data-hub-intent={intent}>
      <SpecialControls intent={intent} />
    </div>
  )
}
