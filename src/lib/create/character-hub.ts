// The Character area of Create (3.1.0, part B, David's sketches v2 of
// 14.11.2026, uebergabe-310/CHARACTER-HUB-KONZEPT.md).
//
// One pill "Character" instead of four (Character, Motion, Lipsync, Swap).
// Three steps: 1 Who? (a character from every source), 2 What? (Image, Swap,
// Motion, Talk), 3 the panel of that action. The inner intent ids stay as
// they were (`character`, `motion`, `lipsync`, `swap_character`): the gallery
// Reuse, the chat tools, the presets, the phone and the opSlot keys all keep
// working, an action is only a new name for an intent.
//
// Pure: no React, no store writes. The store only lends its types.

import type { CloudLora } from '../../api/cloud/loras'
import type { CharacterRef } from '../character-ref'
import type { CreateIntent } from './create-intent'
import {
  characterGenerationModels, cloudModelById, lengthPrice, loraGenModels,
} from '../../stores/cloudCatalogStore'
import { intentPickerModels } from '../render/create-studio'
import { STUDIO_MODELS } from '../render/studio-contract'
import { SWAP_INTENT, SWAP_MAIN_MODEL, swapCreditsPerSecond, swapDefaultOptions, swapShortCredits } from '../render/swap'

/** The intents the one pill stands for, in the order of step 2. */
export const HUB_INTENTS: readonly CreateIntent[] = ['character', 'swap_character', 'motion', 'lipsync']

export function isHubIntent(intent: CreateIntent | string): boolean {
  return (HUB_INTENTS as readonly string[]).includes(intent)
}

export type HubAction = 'image' | 'swap' | 'motion' | 'talk'

export const HUB_ACTIONS: readonly HubAction[] = ['image', 'swap', 'motion', 'talk']

const ACTION_INTENT: Record<HubAction, CreateIntent> = {
  image: 'character',
  swap: 'swap_character',
  motion: 'motion',
  talk: 'lipsync',
}

export function intentOfAction(action: HubAction): CreateIntent {
  return ACTION_INTENT[action]
}

/** The action an intent opens, or null for an intent outside the area. */
export function actionOfIntent(intent: CreateIntent | string): HubAction | null {
  const hit = HUB_ACTIONS.find((a) => ACTION_INTENT[a] === intent)
  return hit ?? null
}

export const ACTION_LABEL: Record<HubAction, string> = {
  image: 'Image',
  swap: 'Swap',
  motion: 'Motion',
  talk: 'Talk',
}

export const ACTION_LINE: Record<HubAction, string> = {
  image: 'New pictures of your character',
  swap: 'Put your character into a real video',
  motion: 'Your character copies a dance or move',
  talk: 'Your character says your text',
}

/** Where the area stands: who (no character picked yet), new (the page
 *  that makes one), what (a character on the stage, no action yet), or the
 *  panel of an action. */
export type HubStep = 'who' | 'new' | 'what' | 'panel'

// Characters from every source.

export type HubCharacterKind = 'cloud' | 'local' | 'saved'

export interface HubCharacter {
  /** Unique over all sources: 'cloud:<id>', the local ref id ('local:…',
   *  'mlx:…') or 'saved:<id>'. */
  key: string
  kind: HubCharacterKind
  name: string
  /** Grey line on the right: "Trained · Flux", "Photos · 12", "Local LoRA". */
  meta: string
  /** A picture of the character: the base look, the last preview or the
   *  first photo. null where there is none (a local LoRA file). */
  image: string | null
  /** LoRA characters: what the image run reads. */
  ref?: CharacterRef
  /** The cloud row as the server sent it (download, use locally, delete). */
  lora?: CloudLora
  /** Saved photo characters (IndexedDB). */
  photos?: Blob[]
}

const FAMILY_LABEL: Record<string, string> = {
  flux: 'Flux',
  'z-image': 'Z-Image',
  zimage: 'Z-Image',
  'qwen-image': 'Qwen',
  'ltx-2': 'LTX video',
}

export function familyLabel(family: string): string {
  return FAMILY_LABEL[family] ?? family
}

/** A trained or uploaded LoRA of LU Cloud. */
export function hubFromCloud(lora: CloudLora): HubCharacter {
  const word = lora.source === 'uploaded' ? 'Uploaded' : 'Trained'
  return {
    key: `cloud:${lora.id}`,
    kind: 'cloud',
    name: lora.name,
    meta: `${word} · ${familyLabel(lora.base_family)}`,
    image: lora.base_url || lora.preview_url || null,
    ref: { id: lora.id, name: lora.name, triggerWord: lora.trigger_word, family: lora.base_family },
    lora,
  }
}

/** A `char_*.safetensors` of this machine (ComfyUI loras or the Mac folder). */
export function hubFromLocal(ref: CharacterRef): HubCharacter {
  return { key: ref.id, kind: 'local', name: ref.name || ref.triggerWord, meta: 'Local LoRA', image: null, ref }
}

/** A character saved from photos or frames on this machine. */
export function hubFromSaved(saved: { id: string; name: string; photos: Blob[] }, thumb: string | null): HubCharacter {
  return {
    key: `saved:${saved.id}`,
    kind: 'saved',
    name: saved.name,
    meta: `Photos · ${saved.photos.length}`,
    image: thumb,
    photos: saved.photos,
  }
}

/** One list over all sources: cloud first (the base look leads), then this
 *  machine's LoRAs, then the saved photo sets. A name that two sources share
 *  stays twice: they are two different characters. */
export function mergeHubCharacters(cloud: HubCharacter[], local: HubCharacter[], saved: HubCharacter[]): HubCharacter[] {
  const seen = new Set<string>()
  return [...cloud, ...local, ...saved].filter((c) => !seen.has(c.key) && !!seen.add(c.key))
}

/** The initial of a character without a picture. */
export function hubInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

/** Does this character bring a picture that Swap, Motion and Talk can start
 *  from? A local LoRA file has none; there the panel asks for a photo. */
export function hubHasPortrait(c: HubCharacter | null): boolean {
  return !!c && (!!c.image || (c.photos?.length ?? 0) > 0)
}

// Prices for step 2. Every figure comes from the server's catalogue; an
// action whose models the catalogue does not list shows no price.

/** Credits per second of one model, or null when it is not priced by length. */
export function perSecondCredits(id: string): number | null {
  const studio = STUDIO_MODELS[id]
  if (studio) {
    if (!cloudModelById(id)) return null
    const mode = studio.price.mode
    if (mode !== 'output' && mode !== 'input' && mode !== 'both' && mode !== 'inout') return null
    return swapCreditsPerSecond(id, { ...(studio.defaults ?? {}), ...swapDefaultOptions(SWAP_INTENT, id) })
  }
  const rate = lengthPrice(id)
  if (!rate || rate.basis === 'chars') return null
  return Math.ceil(rate.per_block / rate.block)
}

function flatCredits(id: string): number | null {
  const base = cloudModelById(id)?.credits?.base
  return typeof base === 'number' && base > 0 ? base : null
}

function cheapest(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x) && x > 0)
  return v.length ? Math.min(...v) : null
}

/** The cloud price of an action as step 2 shows it: "8k / s", "from 3k",
 *  "from 3k / s". null when the catalogue lists no model for it. `family`
 *  is the LoRA family of the picked character (Image runs on its models). */
export function actionCloudPrice(action: HubAction, family?: string): string | null {
  if (action === 'swap') {
    const s = perSecondCredits(SWAP_MAIN_MODEL)
    return s === null ? null : `${swapShortCredits(s)} / s`
  }
  if (action === 'image') {
    const list = family ? characterGenerationModels(family) : loraGenModels()
    const c = cheapest(list.map((m) => flatCredits(m.id)))
    return c === null ? null : `from ${swapShortCredits(c)}`
  }
  const ids = intentPickerModels(action === 'motion' ? 'motion' : 'lipsync').map((m) => m.id).filter((id) => !!cloudModelById(id))
  if (ids.length === 0) return null
  const perS = ids.map(perSecondCredits)
  const s = cheapest(perS)
  if (s !== null) return `${ids.length > 1 ? 'from ' : ''}${swapShortCredits(s)} / s`
  const flat = cheapest(ids.map(flatCredits))
  return flat === null ? null : `from ${swapShortCredits(flat)}`
}

/** The grey line on the right of an action row. `local`: the action has a
 *  local lane on this machine. `cloud`: the price shows (cloud mode, or local
 *  mode with the cloud features on). */
export function actionMeta(opts: { local: boolean; cloudPrice: string | null; showCloud: boolean }): string {
  const parts: string[] = []
  if (opts.local) parts.push('Local')
  if (opts.showCloud && opts.cloudPrice) parts.push(opts.cloudPrice)
  return parts.join(' · ')
}

/** The heading over step 2. */
export function whatHeading(c: HubCharacter | null): string {
  return c ? `What should ${c.name} do?` : 'What should your character do?'
}

export const HUB_SWAP_SOON = 'Coming soon to your LU Cloud'
export const HUB_JUST_PHOTO = 'Just use a photo'
export const HUB_JUST_PHOTO_LINE = 'Enough for Swap and Motion. Nothing is saved.'
export const HUB_LOCAL_LINE = 'Local runs on your own machine and costs nothing. Cloud prices in credits.'
