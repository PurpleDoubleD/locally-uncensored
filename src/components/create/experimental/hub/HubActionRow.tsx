// The row above the prompt window of the Character tab: Image, Swap, Motion
// and Talk (David, 16.11.2026). It stands where every tab of Create has its
// own row of controls (LaneControls, ThreeDControls), centred over the
// window, and it is a row, not a bar: no frame, nothing that moves. Beside
// the picked action its price or where it runs, under it the one line that
// says what Local and Cloud mean.

import type { ReactNode } from 'react'
import { Image as ImageIcon, Mic, PersonStanding, Replace } from 'lucide-react'
import { useCreateStore, type CreateIntent } from '../../../../stores/createStore'
import { useUIStore, type CloudTeaserTarget } from '../../../../stores/uiStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { useCharacterHubReleased } from '../../../../lib/create/character-hub-release'
import {
  ACTION_LABEL, ACTION_LINE, HUB_ACTIONS, HUB_LOCAL_LINE, actionCloudPrice, actionMeta, actionOfIntent,
  intentOfAction, type HubAction,
} from '../../../../lib/create/character-hub'
import { isMlxImageHost } from '../../../../api/mlx-image'
import { mlxFollowsMotion, mlxTalking } from '../../../../api/mlx-video'
import { INTENT_MAP } from '../intents'
import { useIntentLanes } from '../IntentBar'
import { cn } from '../../ui/cn'
import { openStageAction } from './hubCharacters'

export const ACTION_ICON: Record<HubAction, ReactNode> = {
  image: <ImageIcon size={14} />,
  swap: <Replace size={14} />,
  motion: <PersonStanding size={14} />,
  talk: <Mic size={14} />,
}

type TeaserIntent = Extract<CloudTeaserTarget, { surface: 'intent' }>['intent']

/** The row picks an action. A tab that cannot run here (Swap in local mode,
 *  a Mac lane without its model) opens the Cloud sheet, as its pill did. */
export function usePickAction() {
  const { intents, lockedOf } = useIntentLanes()
  const setCloudTeaser = useUIStore((s) => s.setCloudTeaser)
  const setError = useCreateStore((s) => s.setError)
  return (a: HubAction) => {
    const intent = intentOfAction(a)
    const meta = intents.find((m) => m.id === intent) ?? INTENT_MAP[intent]
    if (lockedOf(meta)) { setCloudTeaser({ surface: 'intent', intent: intent as TeaserIntent }); return }
    const st = useCreateStore.getState()
    // Leaving the training or the page of a new character for an action:
    // the stage comes back.
    const fresh = st.hubStep !== 'panel' || (st.intent() === 'character' && st.characterTab === 'train')
    if (st.hubStep === 'new') st.setHubStep(st.hubCharacter ? 'what' : 'who')
    // From the stage the character's picture fills the inputs; switching
    // the action keeps what the panel already holds.
    void openStageAction(a, st.hubCharacter, fresh).then((err) => { if (err) setError(err) })
  }
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

export function HubActionRow() {
  const backend = useCreateStore((s) => s.backend)
  const intent = useCreateStore((s) => s.intent())
  const training = useCreateStore((s) => s.intent() === 'character' && s.characterTab === 'train' && s.hubStep === 'panel')
  const family = useCreateStore((s) => s.hubCharacter?.ref?.family)
  const cloudFeatures = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const released = useCharacterHubReleased()
  useCloudCatalogStore((s) => s.fetchedAt)
  const { intents, lockedOf } = useIntentLanes()
  const onPick = usePickAction()
  const active = training ? null : actionOfIntent(intent)
  const showCloud = backend === 'cloud' || cloudFeatures
  const actions = HUB_ACTIONS.flatMap((a) => {
    const of: CreateIntent = intentOfAction(a)
    const meta = intents.find((m) => m.id === of)
    // Left out where the tab is left out (Cloud features off, or a Mac
    // without the lane), as in the old pill bar.
    if (!meta) return []
    const locked = lockedOf(meta)
    // Local: the action has a lane on this machine. In cloud mode that is
    // asked of the local backend. Swap that is not released yet says so in
    // its panel, once.
    const local = !lockedOfLocal(intents, of, backend, lockedOf)
    const soon = a === 'swap' && !locked && !released
    const price = actionCloudPrice(a, a === 'image' ? family : undefined)
    const line = soon ? '' : locked ? 'Runs on LU Cloud' : actionMeta({ local, cloudPrice: price, showCloud: backend === 'cloud' || (showCloud && !local) })
    return [{ action: a, label: meta.label, locked, meta: line }]
  })
  const on = actions.find((a) => a.action === active) ?? null
  return (
    // The tokens of the area (.lu-hub) come along: the row stands in the
    // Composer, outside the area's own section.
    <div className="lu-hub" data-hub-actions>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <div role="radiogroup" aria-label="Character action" className="hub-act">
          {actions.map((a) => (
            <button
              key={a.action}
              type="button"
              role="radio"
              aria-checked={a.action === active}
              aria-label={a.locked ? `${a.label}, runs on LU Cloud` : a.label}
              title={a.locked ? `${a.label}, runs on LU Cloud` : ACTION_LINE[a.action]}
              onClick={() => onPick(a.action)}
              className={cn('hub-act-item hub-fs-13', a.action === active && 'hub-act-item--on', a.locked && 'opacity-60')}
              data-hub-action={a.action}
            >
              {ACTION_ICON[a.action]}{ACTION_LABEL[a.action]}
            </button>
          ))}
        </div>
        {on?.meta && <span className="hub-dim whitespace-nowrap hub-fs-125 tabular-nums" data-hub-action-meta>{on.meta}</span>}
      </div>
      {/* What the price beside it means. One quiet line, at every width. */}
      {on && <p className="hub-dim pt-1 text-center hub-fs-125" data-hub-local-line>{HUB_LOCAL_LINE}</p>}
    </div>
  )
}
