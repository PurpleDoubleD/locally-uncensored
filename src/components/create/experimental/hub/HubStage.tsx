// The stage of the Character area (3.1.0, David 16.11.2026): the characters
// as text tabs across the top, then the photos of the picked one. All of it
// on one middle axis with the prompt window under it (David, 16.11.2026).
// Only real things stand here: the user's characters and their own pictures.
// What can be done with the picked character (Rename, Train a model, Delete,
// the file of a LoRA) sits behind the three dots next to its tab, in a list
// of the same make as the model choice (David, 19.11.2026: no card on the
// stage, no box in a box, the web did the same on 18.11.2026).

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ImagePlus, MoreHorizontal, Plus } from 'lucide-react'
import { useCreateStore } from '../../../../stores/createStore'
import { HUB_JUST_PHOTO, HUB_JUST_PHOTO_LINE, type HubCharacter } from '../../../../lib/create/character-hub'
import { useCharacterNames, cleanCharacterName, MAX_CHARACTER_LABEL } from '../../../../lib/create/character-names'
import { deleteSavedCharacter, renameSavedCharacter } from '../../../../lib/saved-characters'
import { characterLoraFile } from '../../../../lib/characters'
import { deleteLora } from '../../../../api/cloud/loras'
import { errorText } from '../../../../types/json-guards'
import { usePopoverPlatz } from '../../../../hooks/usePopoverPlatz'
import { cn } from '../../ui/cn'
import { sendPhotosToStudio } from '../characterPhotos'
import { CharacterDownload, LocalCharacterDelete } from '../SpecialIntentControls'
import { CharacterUseLocally } from '../CharacterUseLocally'
import { HubAvatar } from './HubParts'

// ── the tabs ────────────────────────────────────────────────────────────────

/** How much of each entry the row shows: 'names' (picture and name),
 *  'picked' (only the character on the stage keeps its name), 'pictures'
 *  (the round pictures alone; the name is the tooltip). */
export type TabsFit = 'names' | 'picked' | 'pictures'

const NAME_PX = 7.2
const NAME_MAX = 140
const PICTURE = 20
const GAP = 20
/** The three dots next to the picked character. */
const MENU_PX = 24
const tabWidth = (name: string) => PICTURE + 7 + Math.min(NAME_MAX, name.length * NAME_PX)
/** "Just use a photo" and "New character", with their words. */
const WORDS_PX = 112 + GAP + 118

/** The fullest form of the row that still fits `width` (rendered CSS px).
 *  Without a measured width (0) the row stands in full. */
export function tabsFit(names: string[], picked: string | null, width: number): TabsFit {
  if (!(width > 0)) return 'names'
  const gaps = (names.length + 1) * GAP
  const menu = picked !== null ? MENU_PX : 0
  const full = names.reduce((w, n) => w + tabWidth(n), 0) + gaps + WORDS_PX + menu
  if (full <= width) return 'names'
  const one = names.length * PICTURE + (picked ? tabWidth(picked) - PICTURE : 0) + gaps + WORDS_PX + menu
  return one <= width ? 'picked' : 'pictures'
}

export function HubTabs({ list, loading, current, character, photoOnly, onPick, onPhotoOnly, onNew }: {
  list: HubCharacter[]
  loading: boolean
  /** The key of the character on the stage. */
  current: string | null
  /** The character on the stage as the stage has it (it may not be in the
   *  list yet). Without it the entry of the list is taken. */
  character?: HubCharacter | null
  /** "Just use a photo" is on the stage. */
  photoOnly: boolean
  onPick: (c: HubCharacter) => void
  onPhotoOnly: () => void
  onNew: () => void
}) {
  // The row stands in the middle, over the prompt window. With less room it
  // gives up the names before it gives up the middle: first all but the
  // picked one, then every name, until only the round pictures stand there.
  const row = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = row.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const listed = list.find((c) => c.key === current) ?? null
  const picked = listed ? (character && character.key === listed.key ? character : listed) : null
  const fit = tabsFit(list.map((c) => c.name), picked?.name ?? null, width)
  return (
    <div ref={row} className="hub-tabs-wrap" data-hub-tabs-wrap>
      {/* Another character on the stage: an open menu, rename or question is gone. */}
      <TabsRow key={picked?.key ?? ''} list={list} loading={loading} picked={picked} photoOnly={photoOnly} fit={fit} onPick={onPick} onPhotoOnly={onPhotoOnly} onNew={onNew} />
    </div>
  )
}

function TabsRow({ list, loading, picked, photoOnly, fit, onPick, onPhotoOnly, onNew }: {
  list: HubCharacter[]
  loading: boolean
  picked: HubCharacter | null
  photoOnly: boolean
  fit: TabsFit
  onPick: (c: HubCharacter) => void
  onPhotoOnly: () => void
  onNew: () => void
}) {
  const small = fit === 'pictures'
  const [renaming, setRenaming] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const localDelete = useId()
  const backend = useCreateStore((s) => s.backend)

  const c = picked
  const saved = c?.kind === 'saved' ? c.key.slice('saved:'.length) : null
  const localFile = c?.ref ? characterLoraFile(c.ref) : null
  const cloudLora = !saved && !localFile && backend === 'cloud' ? c?.lora ?? null : null

  const removeSaved = async () => {
    if (!saved) return
    try {
      await deleteSavedCharacter(saved)
      const st = useCreateStore.getState()
      st.setHubCharacter(null)
      st.setHubStep('who')
    } catch (err) {
      setAsking(false)
      setError(errorText(err))
    }
  }
  // The cloud file goes as it went from the file actions (CharacterMore).
  const removeCloud = async () => {
    if (!cloudLora) return
    try {
      await deleteLora(cloudLora.id)
      const st = useCreateStore.getState()
      st.setSelectedCharacter(null)
      st.setHubCharacter(null)
      st.setHubStep('who')
      st.bumpCharactersVersion()
    } catch (err) {
      setAsking(false)
      setError(errorText(err))
    }
  }

  const items: MenuItem[] = []
  if (c) {
    items.push({ key: 'rename', label: 'Rename', data: 'data-hub-rename', run: () => { setError(null); setAsking(false); setRenaming(true) } })
    if (saved && c.photos) {
      items.push({ key: 'train', label: 'Train a model', data: 'data-hub-train', run: () => { const st = useCreateStore.getState(); st.setHubNewDraft(null); if (!st.triggerWord.trim()) st.setTriggerWord(c.name); sendPhotosToStudio(c.name, c.photos ?? []); useCreateStore.getState().setHubStep('panel') } })
    }
    if (cloudLora) {
      // These two show how far they are in their row, so the list stays open.
      items.push({ key: 'download', label: 'Download', data: 'data-hub-download', keepOpen: true, trailing: <CharacterDownload lora={cloudLora} /> })
      items.push({ key: 'local', label: 'Use locally', data: 'data-hub-use-locally', keepOpen: true, trailing: <CharacterUseLocally lora={cloudLora} /> })
    }
    if (saved || cloudLora) {
      items.push({ key: 'delete', label: 'Delete', data: 'data-hub-delete', run: () => { setError(null); setRenaming(false); setAsking(true) } })
    } else if (localFile) {
      // The question of the local file (it moves to the Trash) is its own.
      items.push({ key: 'delete', label: 'Delete', data: 'data-hub-delete', run: () => { document.getElementById(localDelete)?.querySelector<HTMLButtonElement>('[data-testid="local-character-delete"]')?.click() } })
    }
  }

  let line: ReactNode = null
  if (c && asking) {
    line = (
      <span className="hub-muted inline-flex items-center gap-2.5" data-hub-delete-ask>
        Delete {c.name}?
        <button type="button" className="text-red-500 dark:text-red-400" onClick={() => void (saved ? removeSaved() : removeCloud())} data-hub-delete-yes>Delete</button>
        <button type="button" className="hub-dim" onClick={() => setAsking(false)} data-hub-delete-keep>Keep</button>
      </span>
    )
  } else if (error) {
    line = <span role="alert" className="text-red-500 dark:text-red-400">{error}</span>
  } else if (c && renaming && c.ref) {
    line = <span className="hub-dim">The trigger word stays.</span>
  }

  return (
    <>
      <div className="hub-tabs hub-fs-14" data-hub-tabs data-hub-tabs-fit={fit}>
        <div role="tablist" aria-label="My characters" className="hub-tablist">
          {list.map((character) => {
            const on = character.key === picked?.key
            const named = fit === 'names' || (fit === 'picked' && on)
            if (on && renaming) {
              return (
                <span key={character.key} className="hub-tab hub-tab--on hub-text font-medium" data-hub-character={character.key}>
                  <HubAvatar name={character.name} image={character.image} size={small ? 24 : PICTURE} />
                  <RenameField c={picked ?? character} onDone={() => setRenaming(false)} onError={setError} />
                </span>
              )
            }
            const tab = (
              <button
                key={character.key}
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={character.name}
                onClick={() => onPick(character)}
                // The whole name, and the trigger word of a LoRA character,
                // where the tab cuts a long name (GitHub discussion #150).
                title={character.ref ? `${character.name}, trigger word: ${character.ref.triggerWord}` : character.name}
                className={cn('hub-tab', on ? 'hub-tab--on hub-text font-medium' : 'hub-muted')}
                data-hub-character={character.key}
              >
                <HubAvatar name={character.name} image={character.image} size={small ? 24 : PICTURE} />
                {named && <span className="max-w-[140px] truncate" data-hub-tab-name={on ? '' : undefined}>{character.name}</span>}
              </button>
            )
            if (!on || items.length === 0) return tab
            return (
              <span key={character.key} className="hub-tab-pair">
                {tab}
                <TabMenu name={character.name} items={items} />
              </span>
            )
          })}
          {loading && list.length === 0 && <span className="hub-dim self-center hub-fs-13">Loading your characters…</span>}
          <button
            type="button"
            role="tab"
            aria-selected={photoOnly}
            aria-label={HUB_JUST_PHOTO}
            onClick={onPhotoOnly}
            title={small ? `${HUB_JUST_PHOTO}. ${HUB_JUST_PHOTO_LINE}` : HUB_JUST_PHOTO_LINE}
            className={cn('hub-tab hub-fs-13', photoOnly ? 'hub-tab--on hub-text' : 'hub-dim')}
            data-hub-photo-only
          >
            {small ? <ImagePlus size={16} /> : HUB_JUST_PHOTO}
          </button>
          {/* The last entry of the same row, not a button set apart. */}
          <button type="button" onClick={onNew} aria-label="New character" title="New character" className="hub-tab hub-acc hub-fs-13" data-hub-new>
            <Plus size={small ? 16 : 14} />{!small && 'New character'}
          </button>
        </div>
      </div>
      {line && <p className="hub-tabs-line hub-fs-125" data-hub-tabs-line>{line}</p>}
      {/* The local file asks its own question and moves it to the Trash
          (SpecialIntentControls). Its button stays out of sight; Delete in
          the list presses it. */}
      {localFile && c?.ref && (
        <span id={localDelete} className="contents [&>button]:hidden" data-hub-local-delete>
          <LocalCharacterDelete file={localFile} trigger={c.ref.triggerWord} />
        </span>
      )}
    </>
  )
}

// ── the list behind the three dots ───────────────────────────────────────────

interface MenuItem {
  key: string
  label: string
  /** The data attribute of the row, for the tests. */
  data: string
  run?: () => void
  /** A row with a part of its own (a download that shows how far it is):
   *  the row presses that part's button, and the list stays open. */
  trailing?: ReactNode
  keepOpen?: boolean
}

function TabMenu({ name, items }: { name: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The app-wide rule for what opens (GitHub #149): the side with room,
  // pushed onto the screen, the list scrolls.
  const place = usePopoverPlatz(sheet, open, { anker: button, rolle: listRef, fest: 'links' })

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!button.current?.contains(t) && !sheet.current?.contains(t)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Open: the first row takes the focus, so the keys work on the list.
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
  }, [open])

  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length
    rows[next]?.focus()
  }

  const choose = (item: MenuItem, row: HTMLElement) => {
    if (item.trailing) {
      // The part's own first button (Download, Use locally) does the work;
      // while it runs it is disabled and the row does nothing.
      const own = row.querySelector<HTMLButtonElement>('[data-hub-menu-part] button')
      if (own && !own.disabled) own.click()
    } else {
      item.run?.()
    }
    if (!item.keepOpen) setOpen(false)
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`More for ${name}`}
        title={`More for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="hub-more"
        data-hub-menu
      >
        <MoreHorizontal size={16} />
      </button>
      {/* Lifted out to the body, as the model choice: the row of the tabs
          and the scrolling stage under it cut nothing off. It stays mounted
          while closed, so a download keeps saying how far it is. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={sheet}
            style={place.style}
            className={cn('lu-elevated lu-picker fixed z-[100] min-w-0 flex-col overflow-hidden', open ? 'flex' : 'hidden')}
            data-hub-menu-sheet
          >
            <div
              ref={listRef}
              role="menu"
              aria-label={`More for ${name}`}
              onKeyDown={move}
              className="lu-picker-list min-h-0 overflow-y-auto scrollbar-thin py-1"
              data-hub-menu-list
            >
              {items.map((item) => (
                <div
                  key={item.key}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={(e) => {
                    // A press on the part's own buttons is theirs.
                    if ((e.target as Element).closest('[data-hub-menu-part] button')) return
                    choose(item, e.currentTarget)
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    choose(item, e.currentTarget)
                  }}
                  className="lu-picker-row min-w-[132px] cursor-pointer pr-2.5 outline-none focus-visible:bg-[var(--pk-hover)]"
                  {...{ [item.data]: '' }}
                >
                  <span className="lu-picker-name">{item.label}</span>
                  {item.trailing && (
                    <>
                      <span className="lu-picker-fill" />
                      <span className="inline-flex items-center [&_button]:p-0.5 [&_button]:text-current" data-hub-menu-part>{item.trailing}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

// ── rename, in the place of the name ─────────────────────────────────────────

function RenameField({ c, onDone, onError }: { c: HubCharacter; onDone: () => void; onError: (e: string | null) => void }) {
  const [name, setName] = useState(c.name)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { field.current?.select() }, [])
  const save = async () => {
    const clean = cleanCharacterName(name)
    if (!clean) { onError('Give the character a name.'); return }
    try {
      if (c.kind === 'saved') await renameSavedCharacter(c.key.slice('saved:'.length), clean)
      else useCharacterNames.getState().rename(c.key, clean)
      onError(null)
      onDone()
    } catch (err) {
      onError(errorText(err))
    }
  }
  const cancel = () => { onError(null); onDone() }
  return (
    <span className="inline-flex items-center gap-2.5" data-hub-rename-field>
      <input
        ref={field}
        autoFocus
        value={name}
        size={Math.min(24, Math.max(8, name.length + 1))}
        maxLength={MAX_CHARACTER_LABEL}
        aria-label={`New name for ${c.name}`}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') cancel() }}
        className="hub-text hub-tab-field min-w-0 border-b bg-transparent font-medium outline-none"
      />
      <button type="button" className="hub-acc font-normal" onClick={() => void save()} data-hub-rename-save>Save</button>
      <button type="button" className="hub-dim font-normal" onClick={cancel} data-hub-rename-cancel>Cancel</button>
    </span>
  )
}

// ── the photos ─────────────────────────────────────────────────

/** The character's own photos. "Made with …" (its results) comes with 3.1.1;
 *  until then this is what there is to see of it. */
export function HubPhotos({ c, photos, loading }: { c: HubCharacter | null; photos: string[]; loading: boolean }) {
  if (!c) {
    return (
      <div data-hub-step="what" data-hub-photos-of="">
        <p className="hub-dim py-3 text-center hub-fs-13">Pick Swap or Motion below and add the photo there.</p>
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
      {photos.length > 0 && (
        <div className="mb-2 flex items-baseline justify-center gap-2">
          <h2 className="hub-dim hub-fs-10">Photos of {c.name}</h2>
          {photos.length > 1 && <span className="hub-dim hub-fs-12 tabular-nums">{photos.length}</span>}
        </div>
      )}
      {photos.length > 0 ? (
        <ul className="hub-photos" aria-label={`Photos of ${c.name}`}>
          {photos.map((src, i) => <li key={i}><img src={src} alt="" loading="lazy" /></li>)}
        </ul>
      ) : (
        <p className="hub-dim py-3 text-center hub-fs-13" data-hub-no-photos>{loading ? 'Loading the photos…' : none}</p>
      )}
    </div>
  )
}
