// The Character area of Create (3.1.0 part B), as David set it on 16.11.2026:
// the prompt window is the same Composer as in every tab, 660 wide, at the
// same place under the area (CreateExperimental renders it). The area is one
// column of that width above it:
//
//   no character   the three steps and "Create a character" (HubEmpty)
//   new            the page that makes one from photos or a LoRA file
//                  (HubNewCharacter)
//   the stage      the characters as tabs, the picked one as a head line,
//                  under it the inputs of the action and its photos
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
import { Stage } from '../Stage'
import { SpecialControls } from '../SpecialIntentControls'
import { ModelChip } from '../ModelChip'
import { HubCharactersContext } from './HubParts'
import { HubEmpty } from './HubEmpty'
import { HubNewCharacter } from './HubNewCharacter'
import { HubCard, HubPhotos, HubTabs } from './HubStage'
import { SwapOneClick, useSwapOneClickShown } from './SwapOneClick'
import { openHubAction, openStageAction, useCharacterPhotos, useHubCharacters } from './hubCharacters'
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
  const action = onStage ? actionOfIntent(intent) : null
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
  // character takes the stage, so the head says who the picture will show.
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

  const pick = (c: HubCharacter | null) => {
    setHubCharacter(c)
    void openStageAction(action ?? 'image', c, true).then((err) => { if (err) setError(err) })
  }

  useStageSlot({ step, training, action, current, oneClick })
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
        <div className="hub-line flex h-[35px] shrink-0 items-center gap-2 border-b hub-fs-13">
          <button type="button" onClick={() => toStage(picked ? 'what' : 'who')} className="hub-muted flex items-center gap-1" data-hub-back>
            <ChevronLeft size={13} />Characters
          </button>
          <span className="hub-dim" aria-hidden>/</span>
          <span className="hub-text font-medium">Train a model</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pb-4">
          <div className="pt-3 empty:hidden"><Stage hub {...stage} /></div>
          <HubPanel />
          {/* What the training runs on, said on its page. */}
          <div className="flex justify-center pt-2.5 empty:hidden" data-hub-train-model><ModelChip /></div>
        </div>
      </div>
    )
  } else if (step === 'who') {
    body = loading && !waited
      ? <p className="hub-dim py-6 hub-fs-13" data-hub-step="who">Loading your characters…</p>
      : <HubEmpty onCreate={() => setHubStep('new')} />
  } else {
    body = (
      <div className="hub-stage" data-hub-stage>
        <HubTabs
          list={list}
          loading={loading}
          current={current?.key ?? null}
          photoOnly={!current}
          onPick={pick}
          onPhotoOnly={() => pick(null)}
          onNew={() => setHubStep('new')}
        />
        <HubCard c={current} photo={photos[0] ?? null} />
        <StageClip />
        {oneClick ? (
          <SwapOneClick onChangeCharacter={() => toStage('what')} />
        ) : (
          <div className="hub-body scrollbar-thin pb-4">
            <div className="pt-3 empty:hidden"><Stage hub {...stage} /></div>
            {(action !== 'image' || inRun || !current) && <HubPanel />}
            {action === 'image' && fromPhotos && (
              <p className="hub-dim pt-3 text-center hub-fs-125" data-hub-from-photos>Pictures of {current.name} are made in Edit, from its photos.</p>
            )}
            {action === 'image' && <div className="pt-4"><HubPhotos c={current} photos={photos} loading={photosLoading} /></div>}
          </div>
        )}
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
function useStageSlot({ step, training, action, current, oneClick }: {
  step: string; training: boolean; action: ReturnType<typeof actionOfIntent>; current: HubCharacter | null; oneClick: boolean
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
    if (action !== 'image') return null
    if (!key) return wait('Pick a character for Image. A photo is enough for Swap and Motion.')
    const placeholder = `Describe a new picture of ${name}`
    if (photoCharacter) {
      // No LoRA to run: the picture is made in Edit, from the photos.
      return {
        placeholder,
        run: {
          label: 'Continue in Edit',
          ready: true,
          run: () => { void openHubAction('image', onStage.current) },
        },
      }
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
  }, [training, oneClick, step, action, key, name, ref, photoCharacter, selected, prompt, setError])
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
    <p className="hub-muted hub-line flex min-h-8 shrink-0 items-center gap-1.5 border-b hub-fs-12" data-hub-clip>
      <Film size={13} className="hub-dim shrink-0" />
      <span className="min-w-0 truncate">{videoInput.name}</span>
      <button type="button" onClick={() => setVideoInput(null)} className="hub-dim ml-auto p-0.5" title="Remove the video" aria-label="Remove the video">
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
