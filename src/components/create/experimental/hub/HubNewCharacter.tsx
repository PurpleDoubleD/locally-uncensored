// "New character" (3.1.0, David 16.11.2026): one page with one decision.
// Left the photos (only the ones the user put there, nothing before that),
// right the name and how LU remembers the face: keep the photos (a character
// at once, lib/saved-characters) or train a model (the photos go on to the
// training, as "Train from photos" did). A LoRA file dropped here becomes a
// character of this machine instead (lib/create/character-lora); the page
// says where that folder is and opens it.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronLeft, FolderOpen, Upload, X } from 'lucide-react'
import { useCreateStore } from '../../../../stores/createStore'
import { isTauri } from '../../../../api/backend'
import { MAX_CHARACTER_NAME, MAX_CHARACTER_PHOTOS, saveCharacter } from '../../../../lib/saved-characters'
import { MIN_TRAIN_IMAGES, maxTrainImages } from '../../../../lib/train-image-cap'
import { hubFromLocal, hubFromSaved, type HubCharacter } from '../../../../lib/create/character-hub'
import { characterFromLora, localCharacterPrefix } from '../../../../lib/characters'
import {
  characterLoraFolder, importCharacterLora, isLoraFile, nameFromLoraFile, openCharacterLoraFolder, shortFolder,
  type LoraFolder,
} from '../../../../lib/create/character-lora'
import { keyFormatNote } from '../../../../api/character-import'
import { errorText } from '../../../../types/json-guards'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { sendPhotosToStudio } from '../characterPhotos'
import { refreshLocalShelves } from '../CharacterUseLocally'
import { ACTION_ICON } from './HubStage'
import { ACTION_LABEL, HUB_ACTIONS } from '../../../../lib/create/character-hub'

type Way = 'keep' | 'train'

const GOOD = ['One person, face clearly visible', 'Different angles, light and clothes', 'Close-ups and half body mixed']
const AVOID = ['Sunglasses, masks, heavy filters', 'Other people in the picture', 'Ten copies of the same selfie']

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}

/** The addresses of the photos on the page, given back when they leave it. */
function usePhotoUrls(files: File[]): string[] {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => { for (const u of urls) URL.revokeObjectURL(u) }, [urls])
  return urls
}

interface Props {
  /** Back to the characters. */
  onBack: () => void
  /** A character was made: the stage shows it. */
  onSaved: (c: HubCharacter | null) => void
  /** "Frames from a gallery video": the gallery opens. */
  onOpenGallery: () => void
}

export function HubNewCharacter({ onBack, onSaved, onOpenGallery }: Props) {
  const [photos, setPhotos] = useState<File[]>([])
  const [lora, setLora] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [way, setWay] = useState<Way>('keep')
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<ReactNode>(null)
  // A LoRA that is in its folder, with something to say about it before the
  // page is left.
  const [added, setAdded] = useState<{ note: string; character: HubCharacter | null } | null>(null)
  const [folder, setFolder] = useState<LoraFolder | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const urls = usePhotoUrls(photos)
  const desktop = isTauri()
  const backend = useCreateStore((s) => s.backend)
  // A character keeps 30 photos; a training set takes what the trainer takes.
  const most = way === 'train' ? maxTrainImages(backend) : MAX_CHARACTER_PHOTOS

  useEffect(() => {
    let live = true
    void characterLoraFolder().then((f) => { if (live) setFolder(f) })
    return () => { live = false }
  }, [])

  const take = (list: File[]) => {
    setError(null)
    setNote(null)
    const file = list.find(isLoraFile)
    if (file) {
      if (!desktop) { setError('A LoRA file can be added in the desktop app.'); return }
      setLora(file)
      setPhotos([])
      if (!name.trim()) setName(nameFromLoraFile(file.name))
      return
    }
    const images = list.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) { if (list.length) setError('Add photos (JPG, PNG, WebP) or a .safetensors file.'); return }
    setLora(null)
    setPhotos((before) => {
      const next = [...before, ...images].slice(0, most)
      if (before.length + images.length > most) setNote(`${way === 'train' ? 'A training set takes' : 'A character keeps'} ${most} photos. The rest was left out.`)
      return next
    })
  }

  const clean = name.trim()
  // The training has its own page, with its own photos and checks: the way
  // there is always open, and takes along what is here already.
  const toTraining = !lora && way === 'train'
  const ready = !busy && (toTraining || (!!clean && (lora ? folder?.status === 'ok' : photos.length > 0)))
  const hint = toTraining
    ? null
    : !lora && photos.length === 0
      ? 'Add photos first'
      : !clean
        ? 'Give the character a name'
        : lora && folder?.status !== 'ok'
          ? 'There is no LoRA folder on this computer'
          : null

  const save = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      if (lora) {
        setProgress(0)
        const r = await importCharacterLora(lora, clean, (got, total) => setProgress(total > 0 ? got / total : 0))
        if (r.status === 'exists') throw new Error(`There is already a character called ${clean} on this computer. Pick another name.`)
        if (r.status === 'no_comfy') throw new Error('LU found no ComfyUI on this computer, so there is no LoRA folder to put the file in.')
        await refreshLocalShelves()
        const warn = keyFormatNote(r.keyFormat)
        // The new character takes the stage, by the id the list gives it.
        const ref = characterFromLora(r.file, await localCharacterPrefix())
        const made = ref ? hubFromLocal(ref) : null
        if (warn) { setAdded({ note: warn, character: made }); return }
        onSaved(made)
        return
      }
      if (way === 'train') {
        if (clean) useCreateStore.getState().setTriggerWord(clean)
        sendPhotosToStudio(clean || 'photo', photos)
        // The training is a panel of the area (intent character, tab train).
        useCreateStore.getState().setHubStep('panel')
        return
      }
      const { character } = await saveCharacter(clean, photos)
      onSaved(hubFromSaved(character, null))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const summary = lora
    ? `LoRA file · ${megabytes(lora.size)} · goes into your LoRA folder`
    : way === 'train'
      ? photos.length === 0
        ? 'The training is set up on the next page'
        : `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} go along · the training is set up on the next page`
      : photos.length === 0
        ? 'No photos yet'
        : `${Math.min(photos.length, MAX_CHARACTER_PHOTOS)} ${photos.length === 1 ? 'photo' : 'photos'} · kept on this computer · free`
  const button = added ? 'Done' : lora ? (clean ? `Add ${clean}` : 'Add') : way === 'train' ? 'Continue to training' : clean ? `Save ${clean}` : 'Save'

  return (
    <div className="hub-page" data-hub-step="new">
      <div className="hub-line flex h-[35px] shrink-0 items-center gap-2 border-b hub-fs-13">
        <button type="button" onClick={onBack} className="hub-muted flex items-center gap-1" data-hub-back>
          <ChevronLeft size={13} />Characters
        </button>
        <span className="hub-dim" aria-hidden>/</span>
        <span className="hub-text font-medium">New character</span>
      </div>

      <div className="hub-new scrollbar-thin">
        <div className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="hub-dim hub-fs-10">{lora ? 'LoRA file' : 'Photos of the face'}</h2>
            {!lora && photos.length > 0 && <span className="hub-dim hub-fs-12 tabular-nums" data-hub-photo-count>{photos.length} of {most}</span>}
          </div>
          <div
            role="button"
            tabIndex={0}
            aria-label={desktop ? 'Drop photos or a LoRA file here, or choose files' : 'Drop photos here, or choose files'}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(Array.from(e.dataTransfer.files ?? [])) }}
            className={cn('hub-drop flex min-h-16 cursor-pointer items-center gap-3 px-4 hub-fs-14', over && 'hub-drop--over')}
            data-hub-drop
          >
            <Upload size={17} className="hub-dim shrink-0" />
            <span className="hub-muted min-w-0 flex-1">
              <span className="hub-text font-medium">{desktop ? 'Drop photos or a LoRA file here' : 'Drop photos here'}</span>, or choose files
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenGallery(); setNote('Open a video in the gallery and choose Save as character. Its frames become a character.') }}
              className="hub-muted shrink-0 underline decoration-[var(--hub-edge)] underline-offset-[3px] hub-fs-125"
            >
              Frames from a gallery video
            </button>
            <input
              ref={input}
              type="file"
              multiple
              accept={desktop ? 'image/*,.safetensors' : 'image/*'}
              className="hidden"
              aria-label="Photos or a LoRA file"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => { take(Array.from(e.target.files ?? [])); e.target.value = '' }}
            />
          </div>

          {photos.length > 0 && (
            <ul className="mt-3.5 flex flex-wrap gap-2" aria-label="Photos of the new character" data-hub-photos={photos.length}>
              {photos.map((f, i) => (
                <li key={`${f.name}-${i}`} className="relative">
                  {urls[i] && <img src={urls[i]} alt="" className="hub-thumb" />}
                  <button
                    type="button"
                    onClick={() => setPhotos(photos.filter((_, k) => k !== i))}
                    className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-black/55 text-white"
                    title="Remove this photo"
                    aria-label={`Remove photo ${i + 1}`}
                  >
                    <X size={10} strokeWidth={2.4} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lora && (
            <div className="hub-line mt-3.5 flex min-h-10 items-center gap-2.5 border-y hub-fs-14" data-hub-lora-file>
              <span className="hub-text min-w-0 flex-1 truncate" title={lora.name}>{lora.name}</span>
              <span className="hub-dim hub-fs-125 tabular-nums">{megabytes(lora.size)}</span>
              {!busy && !added && (
                <button type="button" onClick={() => setLora(null)} className="hub-dim p-1" title="Remove the file" aria-label="Remove the LoRA file"><X size={13} /></button>
              )}
            </div>
          )}

          {!lora && (
            <div className="hub-line mt-5 grid grid-cols-2 gap-6 border-t pt-3.5 hub-fs-13">
              <ul className="hub-muted space-y-1">
                <li className="hub-text mb-1.5 flex items-center gap-1.5 font-medium"><Check size={13} strokeWidth={2.2} className="text-emerald-500 dark:text-emerald-300" />Good</li>
                {GOOD.map((t) => <li key={t}>{t}</li>)}
              </ul>
              <ul className="hub-muted space-y-1">
                <li className="hub-text mb-1.5 flex items-center gap-1.5 font-medium"><X size={13} strokeWidth={2.2} className="text-red-500 dark:text-red-300" />Avoid</li>
                {AVOID.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
          )}

          {desktop && folder && (
            <div className="hub-line mt-4 border-t pt-3.5 hub-fs-13" data-hub-lora-folder={folder.status}>
              {folder.status === 'ok' ? (
                <>
                  <p className="hub-muted flex items-start gap-2">
                    <FolderOpen size={14} className="hub-dim mt-0.5 shrink-0" />
                    <span><span className="hub-text font-medium">Already have a LoRA?</span> Drop the .safetensors above. LU copies it into its LoRA folder under the character's name:</span>
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-[22px]">
                    <code className="hub-text hub-path min-w-0 break-all" title={folder.path} data-hub-lora-path>{shortFolder(folder.path)}</code>
                    <button
                      type="button"
                      onClick={() => { void openCharacterLoraFolder().catch((err) => setError(errorText(err))) }}
                      className="hub-muted underline decoration-[var(--hub-edge)] underline-offset-[3px]"
                      data-hub-lora-open
                    >
                      Open LoRA folder
                    </button>
                  </p>
                </>
              ) : (
                <p className="hub-dim flex items-start gap-2">
                  <FolderOpen size={14} className="mt-0.5 shrink-0" />
                  <span>A LoRA file needs ComfyUI, and LU found none on this computer. Photos work without it.</span>
                </p>
              )}
            </div>
          )}

          {note && <p className="hub-dim pt-3 hub-fs-125" role="status">{note}</p>}
        </div>

        <div className="min-w-0">
          <label className="hub-dim mb-2 block hub-fs-10" htmlFor="hub-new-name">Name</label>
          <input
            id="hub-new-name"
            value={name}
            maxLength={MAX_CHARACTER_NAME}
            placeholder="Name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
            className="hub-text hub-name-field w-full border-b bg-transparent pb-2 pt-1 outline-none"
            data-hub-new-name
          />

          {lora ? (
            <p className="hub-dim pt-5 hub-fs-13">
              A LoRA is a small model that already knows a face. On this computer LU runs it with Z-Image. It shows in your characters as soon as it is in the folder.
            </p>
          ) : (
            <>
              <h2 className="hub-dim mb-1 mt-6 hub-fs-10">How should LU remember this face?</h2>
              <div role="radiogroup" aria-label="How LU remembers the face" className="hub-line border-t">
                <WayRow
                  on={way === 'keep'} onPick={() => setWay('keep')} id="keep" title="Keep the photos"
                  line="Ready now and free. Enough for Swap, Motion and Talk. New pictures use the photos as a reference."
                />
                <WayRow
                  on={way === 'train'} onPick={() => setWay('train')} id="train" title="Train a model"
                  line={`Best likeness in new pictures. Needs at least ${MIN_TRAIN_IMAGES} photos, 10 or more work better. It takes a while, on this computer or for credits on LU Cloud. The next page sets it up.`}
                />
              </div>
              <h2 className="hub-dim mb-1 mt-6 hub-fs-10">After saving</h2>
              <div className="hub-line flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-y hub-fs-13">
                {HUB_ACTIONS.map((a) => (
                  <span key={a} className="hub-text inline-flex items-center gap-1.5"><span className="hub-muted">{ACTION_ICON[a]}</span>{ACTION_LABEL[a]}</span>
                ))}
                <span className="hub-dim ml-auto hub-fs-125">{way === 'train' ? 'ready after the training' : 'ready right away'}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 pb-3 pt-2">
        {(error || added) && (
          <p role={error ? 'alert' : 'status'} className={cn('pb-2 hub-fs-125', error ? 'text-red-500 dark:text-red-400' : 'hub-muted')} data-hub-new-message>
            {error ?? `${clean} is in your LoRA folder. ${added?.note}`}
          </p>
        )}
        <div className="hub-bar flex min-h-[52px] items-center gap-3 py-1.5 pl-3.5 pr-2" data-hub-save-bar>
          {urls[0] && !lora && <img src={urls[0]} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />}
          {clean && <span className="hub-text shrink-0 hub-fs-14 font-medium">{clean}</span>}
          <span className="hub-dim min-w-0 flex-1 truncate hub-fs-125" data-hub-save-summary>
            {progress !== null ? `Copying… ${Math.round(progress * 100)} %` : summary}
          </span>
          {!lora && way === 'keep' && photos.length > 0 && <span className="hub-dim hub-fs-125 max-[820px]:hidden">You can still train later.</span>}
          <span className="inline-flex" title={ready || added ? undefined : hint ?? undefined} data-hub-save>
            <Button variant="primary" size="md" disabled={added ? false : !ready} onClick={() => { if (added) onSaved(added.character); else void save() }}>{button}</Button>
          </span>
        </div>
      </div>
    </div>
  )
}

function WayRow({ on, onPick, id, title, line }: { on: boolean; onPick: () => void; id: string; title: string; line: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className="hub-line flex w-full items-start gap-3 border-b py-3 text-left"
      data-hub-way={id}
    >
      <span className={cn('hub-radio mt-0.5 shrink-0', on && 'hub-radio--on')} aria-hidden />
      <span className="min-w-0">
        <span className="hub-text block hub-fs-14 font-medium">{title}</span>
        <span className="hub-dim mt-0.5 block hub-fs-13">{line}</span>
      </span>
    </button>
  )
}
