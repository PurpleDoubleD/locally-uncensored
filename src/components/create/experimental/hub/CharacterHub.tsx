// The Character area of Create (3.1.0 part B). The stage David chose on
// 16.11.2026 (uebergabe-310/character-design, variant B) in place of the one
// narrow column of the first build:
//
//   no character   the three steps and "Create a character", beside them
//                  what a character can do (HubEmpty)
//   new            the page that makes one from photos or a LoRA file
//                  (HubNewCharacter)
//   the stage      the characters as tabs, the picked one on the left, its
//                  photos or the panel of an action on the right, and the
//                  bar across the foot with Image, Swap, Motion and Talk
//   training       a page of its own, the panel as it was
//
// The inner intent ids and the panels of the actions are untouched
// (lib/create/character-hub.ts): an action is still a name for an intent.

import { useEffect, type ReactNode } from 'react'
import { ChevronLeft, Film, X } from 'lucide-react'
import { useCreateStore, type CreateIntent } from '../../../../stores/createStore'
import { useUIStore, type CloudTeaserTarget } from '../../../../stores/uiStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { useCharacterHubReleased } from '../../../../lib/create/character-hub-release'
import {
  HUB_ACTIONS, HUB_SWAP_SOON, actionCloudPrice, actionMeta, actionOfIntent, intentOfAction,
  type HubAction, type HubCharacter,
} from '../../../../lib/create/character-hub'
import { isMlxImageHost } from '../../../../api/mlx-image'
import { mlxFollowsMotion, mlxTalking } from '../../../../api/mlx-video'
import { INTENT_MAP } from '../intents'
import { useIntentLanes } from '../IntentBar'
import { Stage } from '../Stage'
import { Composer, LaneControls } from '../Composer'
import { SpecialControls, SpecialMore } from '../SpecialIntentControls'
import { cn } from '../../ui/cn'
import { HUB_COLUMN, HubBarTopContext, HubCharactersContext, MoreOptions } from './HubParts'
import { HubEmpty } from './HubEmpty'
import { HubNewCharacter } from './HubNewCharacter'
import { HubActions, HubCard, HubPhotos, HubTabs, type HubActionState } from './HubStage'
import { SwapOneClick, useSwapOneClickShown } from './SwapOneClick'
import { openHubAction, useCharacterPhotos, useHubCharacters } from './hubCharacters'

type TeaserIntent = Extract<CloudTeaserTarget, { surface: 'intent' }>['intent']

interface Props {
  /** The props the Stage takes, as CreateExperimental hands them to it. */
  stage: Omit<React.ComponentProps<typeof Stage>, 'hub'>
  onOpenAdvanced: () => void
  onOpenWorkflows: () => void
  /** "Frames from a gallery video": the gallery opens, a clip there saves its frames. */
  onOpenGallery: () => void
}

export function CharacterHub({ stage, onOpenAdvanced, onOpenWorkflows, onOpenGallery }: Props) {
  const step = useCreateStore((s) => s.hubStep)
  const intent = useCreateStore((s) => s.intent())
  const characterTab = useCreateStore((s) => s.characterTab)
  const picked = useCreateStore((s) => s.hubCharacter)
  const setHubCharacter = useCreateStore((s) => s.setHubCharacter)
  const setHubStep = useCreateStore((s) => s.setHubStep)
  const setError = useCreateStore((s) => s.setError)
  const { list, loading } = useHubCharacters()
  // Swap with the account switch on the cloud: the one click flow, with its
  // own bar (hub/SwapOneClick.tsx). Without it the panel as before.
  const oneClick = useSwapOneClickShown()
  const pickAction = usePickAction()

  // The character as the list has it now (a new name, a new picture), for as
  // long as it is in the list.
  const current = (picked && list.find((c) => c.key === picked.key)) || picked
  const training = step === 'panel' && intent === 'character' && characterTab === 'train'
  const action = step === 'panel' && !training ? actionOfIntent(intent) : null
  const { photos, loading: photosLoading } = useCharacterPhotos(step === 'what' || step === 'panel' ? current : null)

  // Nobody picked yet, and there are characters: the first one takes the
  // stage, so the area opens on something of the user's own.
  const first = list[0]
  useEffect(() => {
    if (step === 'who' && first) {
      setHubCharacter(first)
      setHubStep('what')
    }
  }, [step, first, setHubCharacter, setHubStep])

  const pick = (c: HubCharacter | null) => {
    setHubCharacter(c)
    if (step === 'panel' && action) {
      void openHubAction(action, c, true).then((err) => { if (err) setError(err) })
    } else {
      setHubStep('what')
    }
  }

  let body: ReactNode
  if (step === 'new') {
    body = (
      <HubNewCharacter
        onBack={() => setHubStep(picked ? 'what' : 'who')}
        onSaved={(c) => { setHubCharacter(c); setHubStep(c ? 'what' : 'who') }}
        onOpenGallery={onOpenGallery}
      />
    )
  } else if (training) {
    body = (
      <div className="hub-page" data-hub-training>
        <div className="hub-line flex h-[35px] shrink-0 items-center gap-2 border-b hub-fs-13">
          <button type="button" onClick={() => setHubStep(picked ? 'what' : 'who')} className="hub-muted flex items-center gap-1" data-hub-back>
            <ChevronLeft size={13} />Characters
          </button>
          <span className="hub-dim" aria-hidden>/</span>
          <span className="hub-text font-medium">Train a model</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className={cn(HUB_COLUMN, 'pb-4')}>
            <div className="pt-3 empty:hidden"><Stage hub {...stage} /></div>
            <HubPanel onOpenAdvanced={onOpenAdvanced} />
          </div>
        </div>
        <div className={cn(HUB_COLUMN, 'shrink-0')}>
          <Composer hub onOpenAdvanced={onOpenAdvanced} onOpenWorkflows={onOpenWorkflows} />
        </div>
      </div>
    )
  } else if (step === 'who') {
    body = loading
      ? <p className="hub-dim py-6 hub-fs-13" data-hub-step="who">Loading your characters…</p>
      : <HubEmpty onCreate={() => setHubStep('new')} onTry={(a) => { setHubCharacter(null); pickAction(a) }} />
  } else {
    body = (
      <HubBarTopContext.Provider value={<StageActions active={action} name={current?.name ?? null} family={current?.ref?.family} onPick={pickAction} />}>
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
          {step === 'what' && (
            <>
              <div className="hub-body scrollbar-thin pb-4 pt-4"><HubPhotos c={current} photos={photos} loading={photosLoading} /></div>
              <div className="hub-foot"><div className="hub-bar" data-hub-bar="what"><StageActions active={null} name={current?.name ?? null} family={current?.ref?.family} onPick={pickAction} /></div></div>
            </>
          )}
          {step === 'panel' && oneClick && (
            <SwapOneClick onChangeCharacter={() => setHubStep('what')} onOpenAdvanced={onOpenAdvanced} />
          )}
          {step === 'panel' && !oneClick && (
            <>
              <div className="hub-body scrollbar-thin pb-4">
                <div className="pt-3 empty:hidden"><Stage hub {...stage} /></div>
                <HubPanel onOpenAdvanced={onOpenAdvanced} />
              </div>
              <div className="hub-foot"><Composer hub onOpenAdvanced={onOpenAdvanced} onOpenWorkflows={onOpenWorkflows} /></div>
            </>
          )}
        </div>
      </HubBarTopContext.Provider>
    )
  }

  return (
    <HubCharactersContext.Provider value={list}>
      <section className="lu-hub flex min-w-0 flex-1 flex-col overflow-hidden px-6" data-character-hub={step} aria-label="Character">
        {body}
      </section>
    </HubCharactersContext.Provider>
  )
}

/** The switch picks an action. A tab that cannot run here (Swap in local
 *  mode, a Mac lane without its model) opens the Cloud sheet, as its pill
 *  did. */
function usePickAction() {
  const { intents, lockedOf } = useIntentLanes()
  const setCloudTeaser = useUIStore((s) => s.setCloudTeaser)
  const setError = useCreateStore((s) => s.setError)
  return (a: HubAction) => {
    const intent = intentOfAction(a)
    const meta = intents.find((m) => m.id === intent) ?? INTENT_MAP[intent]
    if (lockedOf(meta)) { setCloudTeaser({ surface: 'intent', intent: intent as TeaserIntent }); return }
    const { hubCharacter: c, hubStep } = useCreateStore.getState()
    // From the stage the character's picture fills the inputs; switching
    // the action keeps what the panel already holds.
    void openHubAction(a, c, hubStep !== 'panel').then((err) => { if (err) setError(err) })
  }
}

/** The switch with what each action costs or where it runs. */
function StageActions({ active, name, family, onPick }: { active: HubAction | null; name: string | null; family: string | undefined; onPick: (a: HubAction) => void }) {
  const backend = useCreateStore((s) => s.backend)
  const cloudFeatures = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const released = useCharacterHubReleased()
  useCloudCatalogStore((s) => s.fetchedAt)
  const { intents, lockedOf } = useIntentLanes()
  const showCloud = backend === 'cloud' || cloudFeatures
  const actions: HubActionState[] = HUB_ACTIONS.flatMap((a) => {
    const intent: CreateIntent = intentOfAction(a)
    const meta = intents.find((m) => m.id === intent)
    // Left out where the tab is left out (Cloud features off, or a Mac
    // without the lane), as in the old pill bar.
    if (!meta) return []
    const locked = lockedOf(meta)
    // Local: the action has a lane on this machine. In cloud mode that is
    // asked of the local backend.
    const local = !lockedOfLocal(intents, intent, backend, lockedOf)
    const soon = a === 'swap' && !locked && !released
    const price = actionCloudPrice(a, a === 'image' ? family : undefined)
    const line = soon ? HUB_SWAP_SOON : locked ? 'Runs on LU Cloud' : actionMeta({ local, cloudPrice: price, showCloud: backend === 'cloud' || (showCloud && !local) })
    return [{ action: a, label: meta.label, locked, meta: line }]
  })
  return <HubActions actions={actions} active={active} name={name} onPick={onPick} right={active ? <StageClip /> : null} />
}

/** The clip a panel holds, by its name, with the way to take it out. Swap
 *  hands it on to Motion and Talk, so it stands where all three see it. */
function StageClip() {
  const intent = useCreateStore((s) => s.intent())
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  if (!videoInput || !(intent === 'swap_character' || intent === 'motion' || intent === 'lipsync')) return null
  return (
    <span className="hub-muted flex min-w-0 shrink items-center gap-1.5 hub-fs-12" data-hub-clip>
      <Film size={13} className="hub-dim shrink-0" />
      <span className="max-w-[180px] truncate">{videoInput.name}</span>
      <button type="button" onClick={() => setVideoInput(null)} className="hub-dim p-0.5" title="Remove the video" aria-label="Remove the video">
        <X size={12} />
      </button>
    </span>
  )
}

/** Whether an action is locked on the LOCAL backend of this machine (for
 *  the word "Local" in cloud mode too). In local mode it is the tab's own
 *  lock; in cloud mode the intents that have a local lane at all. */
function lockedOfLocal(
  intents: ReturnType<typeof useIntentLanes>['intents'],
  intent: CreateIntent,
  backend: string,
  lockedOf: ReturnType<typeof useIntentLanes>['lockedOf'],
): boolean {
  const meta = intents.find((m) => m.id === intent) ?? INTENT_MAP[intent]
  if (backend !== 'cloud') return lockedOf(meta)
  if (isMlxImageHost()) {
    // The Mac's own lanes: Character Studio always, Motion and Talk while
    // their models are installed (asked on the local rule in the store).
    const videos = useCreateStore.getState().videoModelList
    return !(intent === 'character' || (intent === 'motion' && mlxFollowsMotion(videos)) || (intent === 'lipsync' && mlxTalking(videos).tab))
  }
  return !meta.hasLocalLane
}

// ── the panel of an action ──────────────────────────────────────────────────

function HubPanel({ onOpenAdvanced }: { onOpenAdvanced: () => void }) {
  const intent = useCreateStore((s) => s.intent())
  const backend = useCreateStore((s) => s.backend)
  const released = useCharacterHubReleased()
  const swapSoon = intent === 'swap_character' && (!released || backend !== 'cloud')
  return (
    <div data-hub-step="panel" data-hub-intent={intent}>
      <SpecialControls intent={intent} />
      {!swapSoon && (
        <>
          {intent !== 'swap_character' && <div className="pt-2.5 empty:hidden"><LaneControls /></div>}
          <MoreOptions testId="hub-more">
            <SpecialMore intent={intent} />
            <button type="button" onClick={onOpenAdvanced} className="hub-muted hub-fs-125 underline decoration-[var(--hub-edge)] underline-offset-[3px]">
              All settings of the model
            </button>
          </MoreOptions>
        </>
      )}
    </div>
  )
}
