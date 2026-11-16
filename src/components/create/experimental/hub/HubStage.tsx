// The stage of the Character area (3.1.0, David 16.11.2026): the characters
// as text tabs across the top, the picked one as a head under them (a small
// picture, its name, what can be done with it), then its photos. All of it
// in the one column over the prompt window. Only real things stand here:
// the user's characters and their own pictures. A character without a
// picture shows its initial, one without photos a line that says so.

import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Plus } from 'lucide-react'
import { useCreateStore } from '../../../../stores/createStore'
import { HUB_JUST_PHOTO, HUB_JUST_PHOTO_LINE, hubInitial, type HubCharacter } from '../../../../lib/create/character-hub'
import { useCharacterNames, cleanCharacterName, MAX_CHARACTER_LABEL } from '../../../../lib/create/character-names'
import { deleteSavedCharacter, renameSavedCharacter } from '../../../../lib/saved-characters'
import { errorText } from '../../../../types/json-guards'
import { cn } from '../../ui/cn'
import { sendPhotosToStudio } from '../characterPhotos'
import { CharacterMore } from '../SpecialIntentControls'
import { HubAvatar } from './HubParts'

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

// ── the character's head ───────────────────────────────────────────────

function Portrait({ c, photo }: { c: HubCharacter | null; photo: string | null }) {
  const image = c?.image ?? photo
  if (image) {
    return <span className="hub-portrait" style={{ backgroundImage: `url("${image}")` }} role="img" aria-label={`Picture of ${c?.name ?? 'the character'}`} />
  }
  return (
    <span className="hub-portrait hub-portrait--none hub-dim" aria-hidden>
      {c ? <span className="hub-initial">{hubInitial(c.name)}</span> : <ImagePlus size={20} />}
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
        <p className="hub-dim mt-1.5 hub-fs-125">In Chat, name it: “a picture of {c.ref?.name ?? c.name} at the beach”.</p>
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

// ── the photos ─────────────────────────────────────────────────

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
