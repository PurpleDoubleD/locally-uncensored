/**
 * The Character area (3.1.0 part B): one pill for four intents, the inner ids
 * stay, every way that sets one of them (gallery, chat, preset, phone) opens
 * the panel of its action, and the account switch of the server decides about
 * Swap and the sound.
 *
 * Run: npx vitest run src/lib/create/__tests__/character-hub.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HUB_INTENTS, actionMeta, actionOfIntent, hubFromCloud, hubFromLocal, hubFromSaved, hubHasPortrait,
  intentOfAction, isHubIntent, mergeHubCharacters, whatHeading, actionCloudPrice,
} from '../character-hub'
import {
  characterHubReleasedHere, clearCharacterHubRelease, noteCharacterHubFromCatalog, noteCharacterHubFromMe,
  useCharacterHubReleaseStore,
} from '../character-hub-release'
import { INTENTS, pillEntries, HUB_PILL } from '../../../components/create/experimental/intents'
import { useCreateStore } from '../../../stores/createStore'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { opSlot } from '../../../stores/createStore'

describe('the intents keep their ids', () => {
  it('four intents, four actions, both ways', () => {
    expect(HUB_INTENTS).toEqual(['character', 'swap_character', 'motion', 'lipsync'])
    for (const a of ['image', 'swap', 'motion', 'talk'] as const) expect(actionOfIntent(intentOfAction(a))).toBe(a)
    expect(actionOfIntent('music')).toBeNull()
    expect(isHubIntent('extend')).toBe(false)
  })

  it('the bar folds the four into one pill where Character stood', () => {
    const pills = pillEntries(INTENTS)
    // 3D (3.1.0) is a pill of its own at the far right, outside the Character area.
    // Scene to Video (3.1.3) stands after Animate, as on the web.
    expect(pills.map((p) => p.meta.short)).toEqual(['Image', 'Edit', 'Cutout', 'Enhance', 'Erase', 'Video', 'Animate', 'Scene', 'Character', 'Music', 'Extend', '3D'])
    const hub = pills.find((p) => p.hub)!
    expect(hub.meta).toBe(HUB_PILL)
    expect(hub.meta.label).toBe('Character')
    // Without Character Studio in the list (a host that hides it) the pill
    // takes the place of the first intent of the area that is there.
    const noStudio = pillEntries(INTENTS.filter((m) => m.id !== 'character'))
    expect(noStudio.filter((p) => p.hub)).toHaveLength(1)
  })
})

describe('characters from every source', () => {
  const lora = { id: 'c1', name: 'Bean', trigger_word: 'beanchar', base_family: 'flux', created_at: '', source: 'trained' as const, base_url: 'https://x/b.png', preview_url: 'https://x/p.png' }
  it('meta words as in the sketch', () => {
    expect(hubFromCloud(lora).meta).toBe('Trained · Flux')
    expect(hubFromCloud({ ...lora, source: 'uploaded', base_family: 'qwen-image' }).meta).toBe('Uploaded · Qwen')
    expect(hubFromLocal({ id: 'local:char_opa_zimage.safetensors', name: 'opa', triggerWord: 'opa', family: 'zimage' }).meta).toBe('Local LoRA')
    expect(hubFromSaved({ id: 's1', name: 'Sam', photos: Array.from({ length: 12 }, () => new Blob()) }, 'blob:t').meta).toBe('Photos · 12')
  })

  it('the base look leads the picture, then the preview', () => {
    expect(hubFromCloud(lora).image).toBe('https://x/b.png')
    expect(hubFromCloud({ ...lora, base_url: null }).image).toBe('https://x/p.png')
    expect(hubHasPortrait(hubFromLocal({ id: 'local:a', name: 'a', triggerWord: 'a', family: 'zimage' }))).toBe(false)
  })

  it('one list, cloud first, no key twice', () => {
    const c = hubFromCloud(lora)
    const l = hubFromLocal({ id: 'local:x', name: 'x', triggerWord: 'x', family: 'zimage' })
    expect(mergeHubCharacters([c], [l, l], []).map((x) => x.key)).toEqual(['cloud:c1', 'local:x'])
    expect(whatHeading(c)).toBe('What should Bean do?')
    expect(whatHeading(null)).toBe('What should your character do?')
  })
})

describe('prices of step 2', () => {
  it('Local first, the cloud price after it; none from a catalogue without the models', () => {
    expect(actionMeta({ local: true, cloudPrice: 'from 3k', showCloud: true })).toBe('Local · from 3k')
    expect(actionMeta({ local: false, cloudPrice: '8k / s', showCloud: true })).toBe('8k / s')
    expect(actionMeta({ local: true, cloudPrice: '8k / s', showCloud: false })).toBe('Local')
    useCloudCatalogStore.setState({ models: [] })
    expect(actionCloudPrice('swap')).toBeNull()
  })

  it('Swap: SCAIL 2 per second when the catalogue lists it', () => {
    useCloudCatalogStore.setState({ models: [{ id: 'scail-2', label: 'SCAIL 2', kind: 'video', ops: ['studio'], quote_required: true } as never] })
    expect(actionCloudPrice('swap')).toBe('8k / s')
  })
})

describe('the store', () => {
  beforeEach(() => {
    useCreateStore.setState({ backend: 'cloud', hubStep: 'who', hubCharacter: null, hubLastIntent: null })
    useCreateStore.getState().setIntent('image')
  })

  it('the pill opens step 1, later the action that was open', () => {
    useCreateStore.getState().openCharacterHub()
    expect(useCreateStore.getState().intent()).toBe('character')
    expect(useCreateStore.getState().hubStep).toBe('who')
    useCreateStore.getState().setIntent('motion')
    useCreateStore.getState().setIntent('image')
    useCreateStore.getState().openCharacterHub()
    expect(useCreateStore.getState().intent()).toBe('motion')
    expect(useCreateStore.getState().hubStep).toBe('panel')
  })

  it('a gallery reuse, the chat or a preset (setIntent) opens the panel of its action', () => {
    for (const intent of ['lipsync', 'motion', 'swap_character', 'character'] as const) {
      useCreateStore.setState({ hubStep: 'who' })
      useCreateStore.getState().setIntent(intent)
      expect(useCreateStore.getState().hubStep).toBe('panel')
    }
  })

  it('the opSlot of Use character is the same as before', () => {
    useCreateStore.getState().setIntent('character')
    useCreateStore.getState().setCharacterTab('use')
    expect(opSlot(useCreateStore.getState())).toBe('character:use')
  })
})

describe('the account switch', () => {
  beforeEach(() => clearCharacterHubRelease())

  it('not answered is no; /api/me or the catalogue say yes', () => {
    expect(characterHubReleasedHere()).toBe(false)
    noteCharacterHubFromMe({ user: { id: 'u' }, features: { createChat: false } })
    expect(characterHubReleasedHere()).toBe(false)
    noteCharacterHubFromCatalog({ models: [], features: { characterHub: true } })
    expect(characterHubReleasedHere()).toBe(true)
    clearCharacterHubRelease()
    noteCharacterHubFromMe({ features: { characterHub: true } })
    expect(characterHubReleasedHere()).toBe(true)
    expect(useCharacterHubReleaseStore.getState().fromMe).toBe(true)
  })

  it('a catalogue from the server reaches the switch through the store', () => {
    useCloudCatalogStore.getState().setCatalog({ models: [], ops: { removebg: 0, eraser: 0, upscale_image: 0, upscale_video_per_s: 0, upscale_video_min: 0 }, voice: { stt: 0, tts_per_1k_chars: 0 }, media_live: true, tier: 'x', monthly_credits: 0, features: { characterHub: true } })
    expect(characterHubReleasedHere()).toBe(true)
    useCloudCatalogStore.getState().setCatalog({ models: [], ops: { removebg: 0, eraser: 0, upscale_image: 0, upscale_video_per_s: 0, upscale_video_min: 0 }, voice: { stt: 0, tts_per_1k_chars: 0 }, media_live: true, tier: 'x', monthly_credits: 0 })
    expect(characterHubReleasedHere()).toBe(false)
  })
})
