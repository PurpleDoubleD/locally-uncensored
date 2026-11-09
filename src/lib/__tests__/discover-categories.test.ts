// "Better Categories" (Discord 09.11.2026): Get new sorts and
// filters by what a model is for, the lanes of Create. Held against the real
// catalog, so a new entry that falls through every category shows up here.
import { describe, it, expect } from 'vitest'
import {
  TEXT_CATEGORIES, IMAGE_CATEGORIES, VIDEO_CATEGORIES,
  filterByCategory, categoryCounts, sortItems, isAddonBundle,
} from '../discover-categories'
import {
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles,
  getUncensoredTextModels, getMainstreamTextModels, type DiscoverModel,
} from '../../api/discover'

const lanes = new Map<string, string>([
  ...getAudioBundles().map((b) => [b.name, 'Music'] as const),
  ...getLipsyncBundles().map((b) => [b.name, 'Lip sync'] as const),
  ...getMotionBundles().map((b) => [b.name, 'Motion'] as const),
])
const videoItems = [...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles()]
  .map((bundle) => ({ bundle, lane: lanes.get(bundle.name) }))

describe('every catalog entry has a place', () => {
  it('each image bundle is in at least one category', () => {
    const lost = getImageBundles().filter((b) => !IMAGE_CATEGORIES.some((c) => c.match(b)))
    expect(lost.map((b) => b.name)).toEqual([])
  })

  it('each bundle of the Video tab is in at least one category', () => {
    const lost = videoItems.filter((v) => !VIDEO_CATEGORIES.some((c) => c.match(v)))
    expect(lost.map((v) => v.bundle.name)).toEqual([])
  })

  it('the lanes of Create are their own categories on the Video tab', () => {
    const music = filterByCategory(videoItems, VIDEO_CATEGORIES, 'music').map((v) => v.bundle.name)
    expect(music.length).toBe(getAudioBundles().length)
    expect(filterByCategory(videoItems, VIDEO_CATEGORIES, 'lipsync').length).toBe(getLipsyncBundles().length)
    expect(filterByCategory(videoItems, VIDEO_CATEGORIES, 'motion').length).toBe(getMotionBundles().length)
    // GEGENPROBE: a song model is no text-to-video model.
    const t2v = filterByCategory(videoItems, VIDEO_CATEGORIES, 't2v').map((v) => v.bundle.name)
    for (const m of music) expect(t2v).not.toContain(m)
  })

  it('an image-to-video model is filed under Image to video', () => {
    const i2v = filterByCategory(videoItems, VIDEO_CATEGORIES, 'i2v').map((v) => v.bundle)
    expect(i2v.length).toBeGreaterThan(0)
    expect(i2v.every((b) => b.i2v || b.tags.includes('I2V'))).toBe(true)
  })

  it('add-ons (LoRAs, VAEs, companion files) are no text-to-image model', () => {
    const addons = getImageBundles().filter(isAddonBundle)
    expect(addons.length).toBeGreaterThan(0)
    const generate = filterByCategory(getImageBundles(), IMAGE_CATEGORIES, 'generate')
    for (const a of addons) expect(generate).not.toContain(a)
  })

  it('the edit models are found under Edit', () => {
    const edit = filterByCategory(getImageBundles(), IMAGE_CATEGORIES, 'edit').map((b) => b.name)
    expect(edit.some((n) => /Qwen-Image 2\.1/.test(n))).toBe(true)
  })

  it('the chat catalog has agents, vision and coding models', () => {
    const all = [...getUncensoredTextModels(), ...getMainstreamTextModels()]
    const counts = categoryCounts(all, TEXT_CATEGORIES)
    expect(counts.agent).toBeGreaterThan(0)
    expect(counts.vision).toBeGreaterThan(0)
    expect(counts.coding).toBeGreaterThan(0)
    expect(counts.small).toBeGreaterThan(0)
  })
})

describe('filter and sort', () => {
  const m = (name: string, extra: Partial<DiscoverModel> = {}): DiscoverModel =>
    ({ name, description: '', pulls: '', tags: [], updated: '', ...extra })

  it('All and an unknown id keep everything, in order', () => {
    const list = [m('a'), m('b')]
    expect(filterByCategory(list, TEXT_CATEGORIES, 'all')).toEqual(list)
    // A remembered id a later catalog no longer has never empties the page.
    expect(filterByCategory(list, TEXT_CATEGORIES, 'gone-since')).toEqual(list)
  })

  it('sorts by size, missing sizes last, stable', () => {
    const list = [m('big', { sizeGB: 20 }), m('none'), m('small', { sizeGB: 2 }), m('small2', { sizeGB: 2 })]
    const key = { size: (x: DiscoverModel) => x.sizeGB, name: (x: DiscoverModel) => x.name, released: (x: DiscoverModel) => x.released }
    expect(sortItems(list, 'smallest', key).map((x) => x.name)).toEqual(['small', 'small2', 'big', 'none'])
    expect(sortItems(list, 'largest', key).map((x) => x.name)).toEqual(['big', 'small', 'small2', 'none'])
    expect(sortItems(list, 'recommended', key)).toEqual(list)
  })

  it('newest first by release month, undated last', () => {
    const list = [m('old', { released: '2025-01' }), m('undated'), m('new', { released: '2026-10' })]
    const key = { size: () => undefined, name: (x: DiscoverModel) => x.name, released: (x: DiscoverModel) => x.released }
    expect(sortItems(list, 'newest', key).map((x) => x.name)).toEqual(['new', 'old', 'undated'])
  })

  it('by name, numbers in their order', () => {
    const list = [m('Qwen 30B'), m('qwen 4B'), m('Gemma')]
    const key = { size: () => undefined, name: (x: DiscoverModel) => x.name }
    expect(sortItems(list, 'name', key).map((x) => x.name)).toEqual(['Gemma', 'qwen 4B', 'Qwen 30B'])
  })
})
