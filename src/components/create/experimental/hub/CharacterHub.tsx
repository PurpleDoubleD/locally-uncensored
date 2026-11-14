// The Character area of Create (3.1.0 part B), built after David's sketches
// v2 (uebergabe-310/SWAP-HUB-bilder/mockups-v2): one column of 660 px
// (760 rendered, the chat's measure), a head line `Character ▾ → Action ▾`
// as text, rows with hairlines, and at the foot the one framed part, the bar
// (Composer, hub).
//
//   step 1  Who?   every character in one list, "+ New character" with three
//                  ways, "Just use a photo"
//   step 2  What?  Image, Swap, Motion, Talk with their price
//   step 3  the panel of the action: the stage (a run, a result), the
//          inputs (SpecialControls), the lane's own controls, More options,
//          the bar.

import { useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Film, Image as ImageIcon, Mic, PersonStanding, Plus, Replace, X } from 'lucide-react'
import { useCreateStore, type CreateIntent } from '../../../../stores/createStore'
import { useUIStore, type CloudTeaserTarget } from '../../../../stores/uiStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { useCharacterHubReleased } from '../../../../lib/create/character-hub-release'
import {
  ACTION_LABEL, ACTION_LINE, HUB_ACTIONS, HUB_JUST_PHOTO, HUB_JUST_PHOTO_LINE, HUB_LOCAL_LINE, HUB_SWAP_SOON,
  actionCloudPrice, actionMeta, actionOfIntent, intentOfAction, whatHeading,
  type HubAction, type HubCharacter,
} from '../../../../lib/create/character-hub'
import { saveCharacter } from '../../../../lib/saved-characters'
import { isMlxImageHost } from '../../../../api/mlx-image'
import { openMlxLoraFolder } from '../../../../api/mlx-loras'
import { mlxFollowsMotion, mlxTalking } from '../../../../api/mlx-video'
import { INTENT_MAP } from '../intents'
import { useIntentLanes } from '../IntentBar'
import { Stage } from '../Stage'
import { Composer, LaneControls } from '../Composer'
import { SpecialControls, SpecialMore } from '../SpecialIntentControls'
import { Select, type SelectOption } from '../../ui/Select'
import { cn } from '../../ui/cn'
import { HubAvatar, HubCharactersContext, MoreOptions } from './HubParts'
import { openHubAction, useHubCharacters } from './hubCharacters'

type TeaserIntent = Extract<CloudTeaserTarget, { surface: 'intent' }>['intent']

const ACTION_ICON: Record<HubAction, ReactNode> = {
  image: <ImageIcon size={15} />,
  swap: <Replace size={15} />,
  motion: <PersonStanding size={15} />,
  talk: <Mic size={15} />,
}

interface Props {
  /** The props the Stage takes, as CreateExperimental hands them to it. */
  stage: Omit<React.ComponentProps<typeof Stage>, 'hub'>
  onOpenAdvanced: () => void
  onOpenWorkflows: () => void
  /** "From my gallery": the gallery opens, a clip there saves its frames. */
  onOpenGallery: () => void
}

/** The column every step shares: 660 px, centred. */
const COLUMN = 'mx-auto w-full max-w-[660px] px-4'

export function CharacterHub({ stage, onOpenAdvanced, onOpenWorkflows, onOpenGallery }: Props) {
  const step = useCreateStore((s) => s.hubStep)
  const { list, loading } = useHubCharacters()
  return (
    <HubCharactersContext.Provider value={list}>
      <section className="lu-hub flex min-w-0 flex-1 flex-col overflow-hidden" data-character-hub={step} aria-label="Character">
        <div className={cn(COLUMN, 'shrink-0')}>
          <HubHead list={list} />
        </div>
        {step === 'who' && <Scroll><HubWho list={list} loading={loading} onOpenGallery={onOpenGallery} /></Scroll>}
        {step === 'what' && <Scroll><HubWhat /></Scroll>}
        {step === 'panel' && (
          <>
            <Scroll>
              <div className="empty:hidden pt-3"><Stage hub {...stage} /></div>
              <HubPanel onOpenAdvanced={onOpenAdvanced} />
            </Scroll>
            <div className={cn(COLUMN, 'shrink-0')}>
              <Composer hub onOpenAdvanced={onOpenAdvanced} onOpenWorkflows={onOpenWorkflows} />
            </div>
          </>
        )}
      </section>
    </HubCharactersContext.Provider>
  )
}

function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className={cn(COLUMN, 'pb-4')}>{children}</div>
    </div>
  )
}

// ── head line ───────────────────────────────────────────────────────────────

const CHOOSE = '__choose'
const PHOTO = '__photo'
const NEW = '__new'

function HubHead({ list }: { list: HubCharacter[] }) {
  const step = useCreateStore((s) => s.hubStep)
  const intent = useCreateStore((s) => s.intent())
  const characterTab = useCreateStore((s) => s.characterTab)
  const hubCharacter = useCreateStore((s) => s.hubCharacter)
  const setHubCharacter = useCreateStore((s) => s.setHubCharacter)
  const setHubStep = useCreateStore((s) => s.setHubStep)
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  const setError = useCreateStore((s) => s.setError)
  const pickAction = usePickAction()
  const training = step === 'panel' && intent === 'character' && characterTab === 'train'
  const action = step === 'panel' ? actionOfIntent(intent) : null

  const who: SelectOption[] = [
    ...list.map((c) => ({ value: c.key, label: c.name, sublabel: c.meta, lead: <HubAvatar name={c.name} image={c.image} size={18} /> })),
    { value: PHOTO, label: HUB_JUST_PHOTO },
    { value: NEW, label: 'New character', lead: <Plus size={14} className="hub-dim" /> },
    { value: CHOOSE, label: 'All characters…' },
  ]
  const whoValue = training ? NEW : hubCharacter?.key ?? (step === 'who' ? '' : PHOTO)
  const whoOptions = whoValue === PHOTO || whoValue === NEW || !whoValue || list.some((c) => c.key === whoValue)
    ? who
    : [{ value: whoValue, label: hubCharacter?.name ?? '', lead: <HubAvatar name={hubCharacter?.name ?? ''} image={hubCharacter?.image} size={20} /> }, ...who]
  const withLead = whoOptions.map((o) => (o.value === hubCharacter?.key ? { ...o, lead: <HubAvatar name={o.label} image={hubCharacter?.image} size={20} /> } : o))

  const onWho = (v: string) => {
    if (v === CHOOSE) { setHubStep('who'); return }
    if (v === NEW) { startTraining(); return }
    const c = v === PHOTO ? null : list.find((x) => x.key === v) ?? null
    setHubCharacter(c)
    if (step === 'panel' && action) {
      void openHubAction(action, c, true).then((err) => { if (err) setError(err) })
    } else {
      setHubStep('what')
    }
  }

  const actions: SelectOption[] = HUB_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a], sublabel: ACTION_LINE[a] }))

  return (
    <div className="hub-line flex h-[35px] items-center gap-2 border-b hub-fs-13" data-hub-head>
      <Select
        variant="text"
        ariaLabel="Character"
        placeholder="Character"
        textClassName={step === 'who' ? 'hub-acc' : undefined}
        value={whoValue}
        options={withLead}
        onChange={onWho}
      />
      <ArrowRight size={12} className="hub-dim shrink-0" aria-hidden />
      <Select
        variant="text"
        ariaLabel="Action"
        // A new character's training stands where the action stands; the
        // list leads on to the actions once it is trained.
        placeholder={training ? 'Train' : 'Action'}
        textClassName={training ? undefined : step === 'what' ? 'hub-acc' : step === 'who' ? 'hub-dim' : undefined}
        value={training ? '' : action ?? ''}
        options={actions}
        onChange={(v) => pickAction(v as HubAction)}
      />
      <span className="flex-1" />
      {step === 'panel' && videoInput && (intent === 'swap_character' || intent === 'motion' || intent === 'lipsync') && (
        <span className="hub-muted flex min-w-0 items-center gap-1.5 hub-fs-12" data-hub-clip>
          <Film size={13} className="hub-dim shrink-0" />
          <span className="truncate">{videoInput.name}</span>
          <button type="button" onClick={() => setVideoInput(null)} className="hub-dim p-0.5" title="Remove the video" aria-label="Remove the video">
            <X size={12} />
          </button>
        </span>
      )}
    </div>
  )
}

/** "Train from photos": Character Studio's training, as it was. */
function startTraining() {
  const st = useCreateStore.getState()
  st.setHubCharacter(null)
  st.setIntent('character')
  st.setCharacterTab('train')
}

/** Step 2 and the head line pick an action the same way. A tab that cannot
 *  run here (Swap in local mode, a Mac lane without its model) opens the
 *  Cloud sheet, as its pill did. */
function usePickAction() {
  const { intents, lockedOf } = useIntentLanes()
  const setCloudTeaser = useUIStore((s) => s.setCloudTeaser)
  const setError = useCreateStore((s) => s.setError)
  return (a: HubAction) => {
    const intent = intentOfAction(a)
    const meta = intents.find((m) => m.id === intent) ?? INTENT_MAP[intent]
    if (lockedOf(meta)) { setCloudTeaser({ surface: 'intent', intent: intent as TeaserIntent }); return }
    const { hubCharacter: c, hubStep } = useCreateStore.getState()
    // From step 2 the character's picture fills the inputs; switching the
    // action in the head line keeps what the panel already holds.
    void openHubAction(a, c, hubStep !== 'panel').then((err) => { if (err) setError(err) })
  }
}

// ── step 1: who? ────────────────────────────────────────────────────────────

export function HubWho({ list, loading, onOpenGallery }: { list: HubCharacter[]; loading: boolean; onOpenGallery: () => void }) {
  const setHubCharacter = useCreateStore((s) => s.setHubCharacter)
  const setHubStep = useCreateStore((s) => s.setHubStep)
  const [upload, setUpload] = useState<File[] | null>(null)
  const [note, setNote] = useState<ReactNode>(null)
  const file = useRef<HTMLInputElement>(null)

  const pick = (c: HubCharacter | null) => { setHubCharacter(c); setHubStep('what') }

  return (
    <div data-hub-step="who">
      <h2 className="hub-dim mt-5 mb-1.5 hub-fs-10">My characters</h2>
      <div aria-label="My characters">
        {list.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => pick(c)}
            // The whole name, and the trigger word of a LoRA character, where
            // the row cuts a long name (GitHub discussion #150).
            title={c.ref ? `${c.name}, trigger word: ${c.ref.triggerWord}` : c.name}
            className="hub-line hub-hover -mx-2 flex h-10 w-[calc(100%+16px)] items-center gap-2.5 rounded-sm border-b px-2 text-left"
            data-hub-character={c.key}
          >
            <HubAvatar name={c.name} image={c.image} size={26} />
            <span className="hub-text min-w-0 flex-1 truncate hub-fs-14 font-medium">{c.name}</span>
            <span className="hub-dim hub-fs-125 tabular-nums">{c.meta}</span>
          </button>
        ))}
        {list.length === 0 && (
          <p className="hub-dim hub-line border-b py-3 hub-fs-13">{loading ? 'Loading your characters…' : 'No characters yet. Make your first one below.'}</p>
        )}
      </div>

      <div className="hub-line border-b pb-2.5">
        <div className="flex h-10 items-center gap-2.5">
          <span className="hub-muted grid w-[26px] place-items-center"><Plus size={15} /></span>
          <span className="hub-text hub-fs-14 font-medium">New character</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-9 hub-fs-13" data-hub-new>
          <button type="button" className="hub-acc hover:underline" onClick={startTraining}>Train from photos</button>
          <span className="hub-dim" aria-hidden>·</span>
          <button type="button" className="hub-acc hover:underline" onClick={() => file.current?.click()}>Upload photos or LoRA</button>
          <span className="hub-dim" aria-hidden>·</span>
          <button
            type="button"
            className="hub-acc hover:underline"
            onClick={() => { onOpenGallery(); setNote('Open a video in the gallery and choose Save as character. Its frames become a character.') }}
          >
            From my gallery
          </button>
          <input
            ref={file}
            type="file"
            multiple
            accept="image/*,.safetensors"
            className="hidden"
            aria-label="Upload photos or a LoRA file"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (files.some((f) => f.name.toLowerCase().endsWith('.safetensors'))) {
                setUpload(null)
                setNote(<LoraFileNote />)
                return
              }
              if (files.length) { setUpload(files); setNote(null) }
            }}
          />
        </div>
        {upload && <SavePhotos files={upload} onDone={() => setUpload(null)} />}
        {note && <p className="hub-dim pl-9 pt-2 hub-fs-125" role="status">{note}</p>}
      </div>

      <div className="flex flex-wrap items-baseline gap-3 pt-3.5 hub-fs-125">
        <button type="button" onClick={() => pick(null)} className="hub-muted underline decoration-[var(--hub-edge)] underline-offset-[3px]">
          {HUB_JUST_PHOTO}
        </button>
        <span className="hub-dim">{HUB_JUST_PHOTO_LINE}</span>
      </div>
    </div>
  )
}

/** A LoRA file is not uploaded from here: it goes into the LoRA folder of
 *  this machine, under the name the list reads. */
function LoraFileNote() {
  return (
    <>
      A LoRA file goes into your LoRA folder, named {'char_<name>_zimage.safetensors'}. It shows here after that.
      {isMlxImageHost() && (
        <> <button type="button" className="underline" onClick={() => { void openMlxLoraFolder().catch(() => undefined) }}>Open the LoRA folder</button></>
      )}
    </>
  )
}

/** Photos picked by "Upload photos or LoRA": one name, then they are a
 *  character on this machine (lib/saved-characters), ready for every action. */
function SavePhotos({ files, onDone }: { files: File[]; onDone: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    try {
      await saveCharacter(name, files)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2.5 pl-9 pt-2 hub-fs-13" data-hub-save-photos>
      <span className="hub-muted">{files.length} {files.length === 1 ? 'photo' : 'photos'}</span>
      <input
        autoFocus
        value={name}
        maxLength={40}
        aria-label="Name of the new character"
        placeholder="Name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
        className="hub-text hub-line w-40 border-b bg-transparent py-1 outline-none"
      />
      <button type="button" className="hub-acc disabled:opacity-40" disabled={!name.trim()} onClick={() => void save()}>Save</button>
      <button type="button" className="hub-dim" onClick={onDone}>Cancel</button>
      {error && <span role="alert" className="text-red-400">{error}</span>}
    </div>
  )
}

// ── step 2: what? ───────────────────────────────────────────────────────────

function HubWhat() {
  const hubCharacter = useCreateStore((s) => s.hubCharacter)
  const backend = useCreateStore((s) => s.backend)
  const cloudFeatures = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const released = useCharacterHubReleased()
  useCloudCatalogStore((s) => s.fetchedAt)
  const { intents, lockedOf } = useIntentLanes()
  const pickAction = usePickAction()
  const showCloud = backend === 'cloud' || cloudFeatures
  const family = hubCharacter?.ref?.family

  return (
    <div data-hub-step="what">
      <h2 className="hub-dim mt-5 mb-1.5 hub-fs-10">{whatHeading(hubCharacter)}</h2>
      <div role="radiogroup" aria-label="Character action" className="hub-line border-t">
        {HUB_ACTIONS.map((a) => {
          const intent: CreateIntent = intentOfAction(a)
          const meta = intents.find((m) => m.id === intent)
          // Left out where the tab is left out (Cloud features off, or a Mac
          // without the lane), as in the old pill bar.
          if (!meta) return null
          const locked = lockedOf(meta)
          // Local: the action has a lane on this machine. In cloud mode that
          // is asked of the local backend.
          const local = !lockedOfLocal(intents, intent, backend, lockedOf)
          const soon = a === 'swap' && !locked && !released
          const price = actionCloudPrice(a, a === 'image' ? family : undefined)
          const line = soon ? HUB_SWAP_SOON : locked ? 'Runs on LU Cloud' : actionMeta({ local, cloudPrice: price, showCloud: backend === 'cloud' || (showCloud && !local) })
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={false}
              aria-label={locked ? `${meta.label}, runs on LU Cloud` : meta.label}
              title={locked ? `${meta.label}, runs on LU Cloud` : meta.label}
              onClick={() => pickAction(a)}
              className={cn('hub-line hub-hover -mx-2 flex h-[38px] w-[calc(100%+16px)] items-center gap-2.5 rounded-sm border-b px-2 text-left hub-fs-14', locked && 'opacity-60')}
              data-hub-action={a}
            >
              <span className="hub-muted shrink-0">{ACTION_ICON[a]}</span>
              <span className="hub-text w-[111px] shrink-0 font-medium">{ACTION_LABEL[a]}</span>
              <span className="hub-muted min-w-0 flex-1 truncate hub-fs-13 max-[520px]:hidden">{ACTION_LINE[a]}</span>
              <span className="hub-dim ml-auto whitespace-nowrap hub-fs-125 tabular-nums" data-hub-action-meta>{line}</span>
            </button>
          )
        })}
      </div>
      <p className="hub-dim pt-3 hub-fs-125">{HUB_LOCAL_LINE}</p>
    </div>
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

// ── step 3: the panel ───────────────────────────────────────────────────────

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

