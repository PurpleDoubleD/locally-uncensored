// The characters of the Character area and what picking one does.
//
// Step 1 lists every source in one list (lib/create/character-hub.ts):
// the trained and uploaded LoRAs of LU Cloud (/api/loras, with their base
// look), this machine's `char_*.safetensors` (ComfyUI loras or the Mac's
// LoRA folder) and the photo sets saved on this machine (IndexedDB).
//
// Picking an action fills its inputs from the character: Image runs on its
// LoRA, Swap puts its picture on person 1, Motion and Talk start from its
// picture. Nothing here books or renders anything.

import { useEffect, useMemo, useState } from 'react'
import { useCreateStore } from '../../../../stores/createStore'
import { listLoras } from '../../../../api/cloud/loras'
import { listLocalCharacters, characterLoraFile } from '../../../../lib/characters'
import { parseLocalCharacterLora } from '../../../../api/trainer'
import { characterBaseModel } from '../../../../lib/character-base'
import { isTauri } from '../../../../api/in-tauri'
import {
  hubFromCloud, hubFromLocal, hubFromSaved, intentOfAction, mergeHubCharacters,
  type HubAction, type HubCharacter,
} from '../../../../lib/create/character-hub'
import type { ImageRef } from '../../../../lib/image-ref'
import { useCharacterNames, withCharacterNames } from '../../../../lib/create/character-names'
import { trainingPhotos } from '../../../../lib/character-photos'
import { useSavedCharacters } from '../SavedCharacters'
import { loadImageRef } from '../loadImage'
import { loadPhotosAsReferences } from '../characterPhotos'

export interface HubCharacterList {
  list: HubCharacter[]
  /** Still asking at least one source. */
  loading: boolean
}

/** All characters, kept current after a training, an import or a delete
 *  (charactersVersion) and after every save of a photo set. */
export function useHubCharacters(): HubCharacterList {
  const backend = useCreateStore((s) => s.backend)
  const version = useCreateStore((s) => s.charactersVersion)
  const saved = useSavedCharacters()
  const [cloudRows, setCloud] = useState<{ key: string; list: HubCharacter[] } | null>(null)
  const [localRows, setLocal] = useState<{ key: number; list: HubCharacter[] } | null>(null)
  const cloudKey = `${backend}:${version}`
  const tauri = isTauri()

  useEffect(() => {
    let live = true
    if (backend !== 'cloud') return
    listLoras()
      .then((rows) => { if (live) setCloud({ key: cloudKey, list: rows.map(hubFromCloud) }) })
      .catch(() => { if (live) setCloud({ key: cloudKey, list: [] }) })
    return () => { live = false }
  }, [backend, cloudKey])

  useEffect(() => {
    let live = true
    if (!tauri) return
    listLocalCharacters()
      .then((refs) => { if (live) setLocal({ key: version, list: refs.map(hubFromLocal) }) })
      .catch(() => { if (live) setLocal({ key: version, list: [] }) })
    return () => { live = false }
  }, [tauri, version])

  const names = useCharacterNames((s) => s.names)
  // A source that is not asked here (cloud off, no Tauri) is an empty list;
  // one that is asked shows its last answer until the new one is in. The
  // user's own names for LoRA characters (Rename) go in here, so every place
  // that reads the list shows them.
  const list = useMemo(() => {
    const cloud = backend !== 'cloud' ? [] : cloudRows?.list ?? []
    const local = !tauri ? [] : localRows?.list ?? []
    return withCharacterNames(mergeHubCharacters(cloud, local, saved.map((c) => hubFromSaved(c, c.thumb))), names)
  }, [backend, cloudRows, tauri, localRows, saved, names])
  return { list, loading: (backend === 'cloud' && cloudRows === null) || (tauri && localRows === null) }
}

/** The most photos the stage shows of one character. */
export const STAGE_PHOTOS = 30

/**
 * The photos of a character, for the stage: the saved photos of a photo
 * character, the training photos a local character still has on this
 * machine, or the one picture a cloud character brings (its base look).
 * Addresses made here are given back when the character changes.
 */
export function useCharacterPhotos(c: HubCharacter | null): { photos: string[]; loading: boolean } {
  const [asked, setAsked] = useState<{ key: string; photos: string[] } | null>(null)
  const key = c?.key ?? ''
  const blobs = c?.photos
  const ref = c?.kind === 'local' ? c.ref : undefined
  const image = c?.image ?? null
  const own = useMemo(() => (blobs?.length ? blobs.slice(0, STAGE_PHOTOS).map((b) => URL.createObjectURL(b)) : null), [blobs])
  useEffect(() => () => { for (const u of own ?? []) URL.revokeObjectURL(u) }, [own])
  useEffect(() => {
    let live = true
    if (!key || own || !ref) return
    trainingPhotos(ref, STAGE_PHOTOS)
      .then((photos) => { if (live) setAsked({ key, photos }) })
      .catch(() => { if (live) setAsked({ key, photos: [] }) })
    return () => { live = false }
  }, [key, own, ref])
  if (!key) return { photos: [], loading: false }
  if (own) return { photos: own, loading: false }
  if (ref) return { photos: asked?.key === key ? asked.photos : [], loading: asked?.key !== key }
  return { photos: image ? [image] : [], loading: false }
}

/** Which character a loaded picture came from, by its address, so a line
 *  says "→ Bean" for the portrait it put there. */
const portraitNames = new Map<string, string>()

export function hubPortraitName(url: string | null | undefined): string | null {
  return url ? portraitNames.get(url) ?? null : null
}

/** The picture of a character as an input image: the first saved photo, or
 *  the base look / last preview of a cloud character. null for a local LoRA
 *  file, which has no picture. */
export async function hubPortrait(c: HubCharacter | null): Promise<ImageRef | null> {
  if (!c) return null
  const first = c.photos?.[0]
  let ref: ImageRef
  if (first) {
    ref = await loadImageRef(new File([first], `${c.name}.jpg`, { type: first.type || 'image/jpeg' }))
  } else {
    if (!c.image) return null
    const res = await fetch(c.image)
    if (!res.ok) throw new Error(`Could not load the picture of ${c.name}.`)
    const blob = await res.blob()
    ref = await loadImageRef(new File([blob], `${c.name}.jpg`, { type: blob.type || 'image/jpeg' }))
  }
  portraitNames.set(ref.url, c.name)
  return ref
}

/** Image with a local LoRA character: the LoRA joins the chain (one character
 *  at a time), the model it was trained for comes along (GH #161). The same
 *  steps as the old shelf of Character Studio. */
function applyLocalLora(c: HubCharacter): void {
  const st = useCreateStore.getState()
  const file = characterLoraFile(c.ref)
  if (!file || !c.ref) return
  for (const l of st.selectedLoras) {
    if (l.name !== file && parseLocalCharacterLora(l.name)) st.toggleLora(l.name)
  }
  if (!useCreateStore.getState().selectedLoras.some((l) => l.name === file)) st.toggleLora(file)
  const models = st.imageModelList
  const base = characterBaseModel(file, models, st.imageModel)
  if (base && base.name !== st.imageModel) st.setImageModel(base.name, base.type)
  st.setSelectedCharacter(c.ref)
}

/** Opens an action of the area with the character's inputs filled in. A
 *  photo character on Image goes to Edit with its photos as references (no
 *  LoRA to run). Returns a sentence when the picture could not be loaded;
 *  the action is open all the same. */
export async function openHubAction(action: HubAction, c: HubCharacter | null, replace = false): Promise<string | null> {
  const st = useCreateStore.getState()
  if (action === 'image' && c?.photos?.length && !c.ref) {
    await loadPhotosAsReferences(c.name, c.photos)
    return null
  }
  st.setIntent(intentOfAction(action))
  if (action === 'image') {
    st.setCharacterTab('use')
    if (c?.kind === 'local') applyLocalLora(c)
    else st.setSelectedCharacter(c?.ref ?? null)
    return null
  }
  if (!c) return null
  try {
    const picture = await hubPortrait(c)
    if (!picture) return null
    const now = useCreateStore.getState()
    if (action === 'swap') {
      const figures = now.swapFigures
      if (replace || !figures[0]?.image) now.setSwapFigures(figures.map((f, i) => (i === 0 ? { ...f, image: picture, character: c.name } : f)))
    } else if (replace || !now.source) {
      now.setSource(picture)
    }
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
