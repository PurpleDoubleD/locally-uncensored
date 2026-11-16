// The stage of the Character area (3.1.0, variant B, David 16.11.2026): the
// characters as text tabs across the top, the picked one on the left with
// its name and what can be done with it, its photos on the right, and at the
// foot the bar with the switch between Image, Swap, Motion and Talk. Only
// real things stand here: the user's characters and their own pictures. A
// character without a picture shows its initial, one without photos a line
// that says so.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Image as ImageIcon, ImagePlus, Mic, PersonStanding, Plus, Replace } from 'lucide-react'
import { useCreateStore } from '../../../../stores/createStore'
import {
  ACTION_LABEL, ACTION_LINE, HUB_JUST_PHOTO, HUB_JUST_PHOTO_LINE, HUB_LOCAL_LINE, hubInitial,
  type HubAction, type HubCharacter,
} from '../../../../lib/create/character-hub'
import { useCharacterNames, cleanCharacterName, MAX_CHARACTER_LABEL } from '../../../../lib/create/character-names'
import { deleteSavedCharacter, renameSavedCharacter } from '../../../../lib/saved-characters'
import { errorText } from '../../../../types/json-guards'
import { cn } from '../../ui/cn'
import { sendPhotosToStudio } from '../characterPhotos'
import { CharacterMore } from '../SpecialIntentControls'
import { HubAvatar } from './HubParts'

export const ACTION_ICON: Record<HubAction, ReactNode> = {
  image: <ImageIcon size={14} />,
  swap: <Replace size={14} />,
  motion: <PersonStanding size={14} />,
  talk: <Mic size={14} />,
}

// ── the tabs ────────────────────────────────────────────────────────────────

export function HubTabs({ list, loading, current, photoOnly, onPick, onPhotoOnly, onNew }: {
  list: HubCharacter[]
  loading: boolean
  /** The key of the character on the stage. */
  current: string | null
  /** "Just use a photo" is on the stage. */
  photoOnly: boolean
  onPick: (c: HubCharacter) => void
  onPhotoOnly: () => void
  onNew: () => void
}) {
  return (
    <div className="hub-tabs hub-line border-b hub-fs-14" data-hub-tabs>
      <div role="tablist" aria-label="My characters" className="hub-tablist scrollbar-none">
        {list.map((c) => {
          const on = c.key === current
          return (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onPick(c)}
              // The whole name, and the trigger word of a LoRA character,
              // where the tab cuts a long name (GitHub discussion #150).
              title={c.ref ? `${c.name}, trigger word: ${c.ref.triggerWord}` : c.name}
              className={cn('hub-tab', on ? 'hub-tab--on hub-text font-medium' : 'hub-muted')}
              data-hub-character={c.key}
            >
              <HubAvatar name={c.name} image={c.image} size={20} />
              <span className="max-w-[140px] truncate">{c.name}</span>
            </button>
          )
        })}
        {loading && list.length === 0 && <span className="hub-dim self-center hub-fs-13">Loading your characters…</span>}
        <button
          type="button"
          role="tab"
          aria-selected={photoOnly}
          onClick={onPhotoOnly}
          title={HUB_JUST_PHOTO_LINE}
          className={cn('hub-tab hub-fs-13', photoOnly ? 'hub-tab--on hub-text' : 'hub-dim')}
          data-hub-photo-only
        >
          {HUB_JUST_PHOTO}
        </button>
      </div>
      <button type="button" onClick={onNew} className="hub-acc flex shrink-0 items-center gap-1 hub-fs-13" data-hub-new>
        <Plus size={14} />New character
      </button>
    </div>
  )
}

// ── the character on the left ───────────────────────────────────────────────

function Portrait({ c, photo }: { c: HubCharacter | null; photo: string | null }) {
  const image = c?.image ?? photo
  if (image) {
    return <span className="hub-portrait" style={{ backgroundImage: `url("${image}")` }} role="img" aria-label={`Picture of ${c?.name ?? 'the character'}`} />
  }
  return (
    <span className="hub-portrait hub-portrait--none hub-dim" aria-hidden>
      {c ? <span className="hub-initial">{hubInitial(c.name)}</span> : <ImagePlus size={28} />}
    </span>
  )
}

export function HubCard({ c, photo }: { c: HubCharacter | null; photo: string | null }) {
  // Another character on the stage: an open rename or question is gone.
  return <Card key={c?.key ?? ''} c={c} photo={photo} />
}

function Card({ c, photo }: { c: HubCharacter | null; photo: string | null }) {
  const [renaming, setRenaming] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!c) {
    return (
      <div className="hub-card" data-hub-card="photo">
        <Portrait c={null} photo={null} />
        <h2 className="hub-text hub-fs-20 font-semibold">{HUB_JUST_PHOTO}</h2>
        <p className="hub-muted mt-1 hub-fs-13">{HUB_JUST_PHOTO_LINE}</p>
      </div>
    )
  }

  const saved = c.kind === 'saved' ? c.key.slice('saved:'.length) : null
  const remove = async () => {
    if (!saved) return
    try {
      await deleteSavedCharacter(saved)
      const st = useCreateStore.getState()
      st.setHubCharacter(null)
      st.setHubStep('who')
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div className="hub-card" data-hub-card={c.key}>
      <Portrait c={c} photo={photo} />
      {renaming ? (
        <RenameField c={c} onDone={() => setRenaming(false)} />
      ) : (
        <h2 className="hub-text hub-fs-20 truncate font-semibold" title={c.name} data-hub-card-name>{c.name}</h2>
      )}
      <p className="hub-muted mt-1 hub-fs-13">{c.meta}</p>
      {c.ref && <p className="hub-dim mt-0.5 hub-fs-125">Trigger word: {c.ref.triggerWord}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 hub-fs-125" data-hub-card-links>
        {!renaming && <button type="button" className="hub-muted hover:underline" onClick={() => { setError(null); setRenaming(true) }} data-hub-rename>Rename</button>}
        {saved && c.photos && (
          <button type="button" className="hub-muted hover:underline" onClick={() => { sendPhotosToStudio(c.name, c.photos ?? []); useCreateStore.getState().setHubStep('panel') }} data-hub-train>Train a model</button>
        )}
        {saved && !asking && <button type="button" className="hub-dim ml-auto hover:underline" onClick={() => setAsking(true)} data-hub-delete>Delete</button>}
        {saved && asking && (
          <span className="hub-muted ml-auto flex items-center gap-2.5" data-hub-delete-ask>
            Delete {c.name}?
            <button type="button" className="text-red-500 dark:text-red-400" onClick={() => void remove()} data-hub-delete-yes>Delete</button>
            <button type="button" className="hub-dim" onClick={() => setAsking(false)}>Keep</button>
          </span>
        )}
      </div>
      {/* The file of a LoRA character: download, use on this computer, delete. */}
      {!saved && <div className="hub-card-file -ml-1 mt-1.5"><CharacterMore bare /></div>}
      {error && <p role="alert" className="mt-1.5 text-red-500 hub-fs-125 dark:text-red-400">{error}</p>}
      {c.kind === 'local' && (
        <p className="hub-dim hub-line mt-4 border-t pt-3 hub-fs-125">In Chat, name it: “a picture of {c.ref?.name ?? c.name} at the beach”.</p>
      )}
    </div>
  )
}

function RenameField({ c, onDone }: { c: HubCharacter; onDone: () => void }) {
  const [name, setName] = useState(c.name)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { field.current?.select() }, [])
  const save = async () => {
    const clean = cleanCharacterName(name)
    if (!clean) { setError('Give the character a name.'); return }
    try {
      if (c.kind === 'saved') await renameSavedCharacter(c.key.slice('saved:'.length), clean)
      else useCharacterNames.getState().rename(c.key, clean)
      onDone()
    } catch (err) {
      setError(errorText(err))
    }
  }
  return (
    <div data-hub-rename-field>
      <input
        ref={field}
        autoFocus
        value={name}
        maxLength={MAX_CHARACTER_LABEL}
        aria-label={`New name for ${c.name}`}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') onDone() }}
        className="hub-text hub-fs-20 hub-name-field w-full border-b bg-transparent font-semibold outline-none"
      />
      <div className="mt-1.5 flex items-center gap-3 hub-fs-125">
        <button type="button" className="hub-acc" onClick={() => void save()} data-hub-rename-save>Save</button>
        <button type="button" className="hub-dim" onClick={onDone}>Cancel</button>
        {c.ref && <span className="hub-dim">The trigger word stays.</span>}
      </div>
      {error && <p role="alert" className="mt-1 text-red-500 hub-fs-125 dark:text-red-400">{error}</p>}
    </div>
  )
}

// ── the photos on the right ─────────────────────────────────────────────────

/** The character's own photos. "Made with …" (its results) comes with 3.1.1;
 *  until then this is what there is to see of it. */
export function HubPhotos({ c, photos, loading }: { c: HubCharacter | null; photos: string[]; loading: boolean }) {
  if (!c) {
    return (
      <div data-hub-step="what" data-hub-photos-of="">
        <p className="hub-dim hub-line border-b py-3 hub-fs-13">Pick Swap or Motion below and add the photo there.</p>
      </div>
    )
  }
  const none = c.kind === 'cloud'
    ? `${c.name} has no picture yet.`
    : c.kind === 'local'
      ? `The photos ${c.name} was trained on are not on this computer.`
      : `${c.name} has no photos.`
  return (
    <div data-hub-step="what" data-hub-photos-of={c.key}>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="hub-dim hub-fs-10">Photos of {c.name}</h2>
        {photos.length > 1 && <span className="hub-dim hub-fs-12 tabular-nums">{photos.length}</span>}
      </div>
      {photos.length > 0 ? (
        <ul className="hub-photos" aria-label={`Photos of ${c.name}`}>
          {photos.map((src, i) => <li key={i}><img src={src} alt="" loading="lazy" /></li>)}
        </ul>
      ) : (
        <p className="hub-dim hub-line border-y py-3 hub-fs-13" data-hub-no-photos>{loading ? 'Loading the photos…' : none}</p>
      )}
    </div>
  )
}

// ── the switch in the bar ───────────────────────────────────────────────────

export interface HubActionState {
  action: HubAction
  /** The name of the tab the action stands for ("Swap Character"), read out
   *  as it was on the old pill. */
  label: string
  /** Opens the Cloud sheet instead of the action. */
  locked: boolean
  /** The grey words on the right while this action is picked. */
  meta: string
}

/** Image, Swap, Motion, Talk: the top line of the bar at the foot. */
export function HubActions({ actions, active, name, onPick, right }: {
  actions: HubActionState[]
  active: HubAction | null
  name: string | null
  onPick: (a: HubAction) => void
  /** What stands before the price on the right: the clip of the panel. */
  right?: ReactNode
}) {
  const on = actions.find((a) => a.action === active) ?? null
  const line = on
    ? ACTION_LINE[on.action].replace('your character', name ?? 'your character').replace('Your character', name ?? 'Your character')
    : name ? `What should ${name} do?` : 'What should your character do?'
  return (
    <div data-hub-actions>
    <div className="flex min-h-[42px] items-center gap-3 py-1 pl-1.5 pr-3">
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
      <span className="hub-dim min-w-0 flex-1 truncate hub-fs-125 max-[640px]:hidden" data-hub-action-line>{line}</span>
      {right}
      {on?.meta && <span className="hub-dim shrink-0 whitespace-nowrap hub-fs-125 tabular-nums max-[520px]:hidden" data-hub-action-meta>{on.meta}</span>}
    </div>
    {/* What the price beside it means, once an action is picked. One quiet
        line, at every width. */}
    {on && <p className="hub-dim px-3 pb-1.5 hub-fs-125" data-hub-local-line>{HUB_LOCAL_LINE}</p>}
    </div>
  )
}
