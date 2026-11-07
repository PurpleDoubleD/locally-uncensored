/**
 * Swap Character on the desktop (07.11.2026, port of the web's C52): model
 * choice, limits, the check before a run, what a run sends, and the price
 * against the provider's own examples (0.15/0.17/0.20/0.40 $ per input
 * second, at least 3 s, plus 0.02 $ per photo).
 *
 * Pure: no store, no network. The upload is a fake that hands back a path.
 */
import { describe, expect, it } from 'vitest'
import {
  SWAP_CONSENT_MISSING, SWAP_CONSENT_MODELS, SWAP_LONG_MODEL, SWAP_MAIN_MODEL, SWAP_MODELS,
  swapAutoModel, swapBilledPhotos, swapClipCredits, swapClipLimits, swapClipSeconds, swapFixedOptions,
  swapMaxPeople, swapNeedsConsent, swapPanelFields, swapPricedSeconds, swapReadsRoles, swapRoles, swapShortCredits,
} from '../../render/swap'
import { swapInputError, swapReady, swapRunParams } from '../swap-run'
import { STUDIO_MODELS, studioCredits, studioFields, studioOptions, studioPreviewCredits } from '../../render/studio-contract'
import { createStudioCost } from '../../render/create-studio'

const PHOTO = { url: 'data:image/png;base64,AA' }
const one = [{ image: PHOTO, role: '' }]
const credits = (usd: number) => Math.round(usd * 100000)

describe('the catalogue', () => {
  it('knows both new models under neutral endpoints, and SCAIL 2', () => {
    for (const id of SWAP_MODELS) expect(STUDIO_MODELS[id], id).toBeDefined()
    expect(STUDIO_MODELS[SWAP_MAIN_MODEL].endpoint).toBe('base/openjutsu/character-swap')
    expect(STUDIO_MODELS[SWAP_LONG_MODEL].endpoint).toBe('base/wan-2.2/animate')
    expect(STUDIO_MODELS[SWAP_MAIN_MODEL].inputs).toEqual({ video: 'video_path', images: 'image_paths' })
    expect(STUDIO_MODELS[SWAP_LONG_MODEL].defaults).toEqual({ mode: 'replace' })
  })

  it('offers roles, resolution 480p to 1080p (768p default) and seed on the main model', () => {
    const f = studioFields(SWAP_MAIN_MODEL)
    expect(Object.keys(f).sort()).toEqual(['resolution', 'roles', 'seed'])
    expect(f.resolution.enum).toEqual(['480p', '540p', '768p', '1080p'])
    expect(studioOptions(SWAP_MAIN_MODEL, '', undefined, false)).toEqual({ resolution: '768p' })
    expect(swapReadsRoles(SWAP_MAIN_MODEL)).toBe(true)
    expect(swapReadsRoles(SWAP_LONG_MODEL)).toBe(false)
  })

  it('holds each role to 200 characters (maxLength in the contract)', () => {
    expect(() => studioOptions(SWAP_MAIN_MODEL, '', { roles: ['a'.repeat(200)] }, false)).not.toThrow()
    expect(() => studioOptions(SWAP_MAIN_MODEL, '', { roles: ['a'.repeat(201)] }, false)).toThrow('Invalid roles')
    expect(() => studioOptions(SWAP_MAIN_MODEL, '', { roles: ['a', 'b', 'c', 'd', 'e'] }, false)).toThrow('Invalid roles')
  })
})

describe('model choice and limits', () => {
  it('runs up to 15 s on the main model, longer on Wan 2.2 Animate, several people always on the main model', () => {
    expect(swapAutoModel(undefined, 1)).toBe(SWAP_MAIN_MODEL)
    expect(swapAutoModel(15, 1)).toBe(SWAP_MAIN_MODEL)
    expect(swapAutoModel(15.4, 1)).toBe(SWAP_LONG_MODEL)
    expect(swapAutoModel(60, 1)).toBe(SWAP_LONG_MODEL)
    expect(swapAutoModel(60, 2)).toBe(SWAP_MAIN_MODEL)
  })

  it('knows the span of each model', () => {
    expect(swapClipLimits(SWAP_MAIN_MODEL)).toEqual({ min: 2, max: 15, billedMin: 3 })
    expect(swapClipLimits(SWAP_LONG_MODEL)).toEqual({ min: 1, max: 120, billedMin: 3 })
    expect(swapMaxPeople(SWAP_MAIN_MODEL)).toBe(4)
    expect(swapMaxPeople(SWAP_LONG_MODEL)).toBe(1)
    expect(swapMaxPeople('scail-2')).toBe(1)
  })

  it('clips the length to the model and the video', () => {
    expect(swapClipSeconds(SWAP_MAIN_MODEL, null)).toBe(15)
    expect(swapClipSeconds(SWAP_MAIN_MODEL, 40)).toBe(15)
    expect(swapClipSeconds(SWAP_MAIN_MODEL, 1)).toBe(2)
    expect(swapClipSeconds(SWAP_MAIN_MODEL, null, 9.7)).toBe(9)
    expect(swapClipSeconds(SWAP_LONG_MODEL, 90, 200)).toBe(90)
    expect(swapPricedSeconds(SWAP_MAIN_MODEL, null, 40)).toBe(15)
    expect(swapPricedSeconds(SWAP_MAIN_MODEL, 10, 40)).toBe(10)
    expect(swapPricedSeconds(SWAP_MAIN_MODEL, null, 8.2)).toBe(8.2)
  })

  it('fixes mode replace on Wan 2.2 Animate and SCAIL 2, nothing on the main model', () => {
    expect(swapFixedOptions('swap_character', SWAP_LONG_MODEL)).toEqual({ mode: 'replace' })
    expect(swapFixedOptions('swap_character', 'scail-2')).toEqual({ mode: 'replace' })
    expect(swapFixedOptions('swap_character', SWAP_MAIN_MODEL)).toEqual({})
    // Motion Control keeps SCAIL 2 as animate.
    expect(swapFixedOptions('motion', 'scail-2')).toEqual({})
    expect(swapPanelFields('swap_character')).toEqual(['roles', 'resolution', 'mode'])
    expect(swapPanelFields('motion')).toEqual([])
  })
})

describe('the price, against the provider page', () => {
  it('10 s at 480p with 1 photo is 1.52 $', () => {
    expect(studioCredits(SWAP_MAIN_MODEL, { resolution: '480p' }, 10, 1, 100, 1)).toBe(credits(1.52))
    expect(swapClipCredits(SWAP_MAIN_MODEL, { resolution: '480p' }, 10, 1)).toBe(credits(1.52))
  })

  it('10 s at 768p with 2 photos is 2.04 $', () => {
    expect(studioCredits(SWAP_MAIN_MODEL, { resolution: '768p' }, 10, 1, 100, 2)).toBe(credits(2.04))
    expect(swapClipCredits(SWAP_MAIN_MODEL, { resolution: '768p' }, 10, 2)).toBe(credits(2.04))
  })

  it('15 s at 768p with 1 photo is 3.02 $', () => {
    expect(studioCredits(SWAP_MAIN_MODEL, { resolution: '768p' }, 15, 1, 100, 1)).toBe(credits(3.02))
    expect(swapClipCredits(SWAP_MAIN_MODEL, { resolution: '768p' }, 15, 1)).toBe(credits(3.02))
  })

  it('the preview of the Create button counts the same (default 768p, photos billed)', () => {
    expect(studioPreviewCredits(SWAP_MAIN_MODEL, {}, 10, 1, 100, 2)).toBe(credits(2.04))
    expect(createStudioCost(SWAP_MAIN_MODEL, { resolution: '480p' }, 100, 10, 1, swapBilledPhotos(SWAP_MAIN_MODEL, 1))).toBe(credits(1.52))
  })

  it('bills at least 3 s and every started second', () => {
    expect(swapClipCredits(SWAP_MAIN_MODEL, { resolution: '768p' }, 2, 1)).toBe(credits(0.62))
    expect(swapClipCredits(SWAP_MAIN_MODEL, { resolution: '768p' }, 9.2, 1)).toBe(credits(2.02))
  })

  it('bills no photo on Wan 2.2 Animate, 0.08 $ per second at 720p', () => {
    expect(swapBilledPhotos(SWAP_LONG_MODEL, 1)).toBe(0)
    expect(swapClipCredits(SWAP_LONG_MODEL, { resolution: '720p' }, 60, 0)).toBe(credits(4.8))
    expect(studioCredits(SWAP_LONG_MODEL, { resolution: '720p', mode: 'replace' }, 60)).toBe(credits(4.8))
  })

  it('writes the price short for the button', () => {
    expect(swapShortCredits(950)).toBe('950')
    expect(swapShortCredits(152000)).toBe('152k')
    expect(swapShortCredits(1520)).toBe('1.5k')
  })
})

describe('roles', () => {
  it('sends none while every role is empty, and fills an empty one from the left once one is set', () => {
    expect(swapRoles([{ role: '' }])).toBeUndefined()
    expect(swapRoles([{ role: '  ' }, { role: '' }])).toBeUndefined()
    expect(swapRoles([{ role: 'the man in red' }, { role: '' }])).toEqual(['the man in red', 'the second person from the left'])
    expect(swapRoles([{ role: 'x'.repeat(250) }])![0]).toHaveLength(200)
  })
})

describe('the check before a run', () => {
  const ok = { hasVideo: true, figures: one, consent: true }

  it('wants the video, a photo for every person and the consent', () => {
    expect(swapInputError(SWAP_MAIN_MODEL, { ...ok, hasVideo: false })).toBe('Add the original video first.')
    expect(swapInputError(SWAP_MAIN_MODEL, { ...ok, figures: [{ image: null, role: '' }] })).toBe('Add a photo of the new person.')
    expect(swapInputError(SWAP_MAIN_MODEL, { ...ok, figures: [...one, { image: null, role: '' }] }))
      .toBe('Add a photo for person 2, or remove that person.')
    expect(swapInputError(SWAP_MAIN_MODEL, { ...ok, consent: false })).toBe(SWAP_CONSENT_MISSING)
    expect(swapInputError(SWAP_MAIN_MODEL, ok)).toBeNull()
    expect(swapReady(SWAP_MAIN_MODEL, ok)).toBe(true)
  })

  it('refuses several people on a one-person model instead of switching silently', () => {
    expect(swapInputError(SWAP_LONG_MODEL, { ...ok, figures: [...one, ...one] }))
      .toBe('This model replaces one person. Use OpenJutsu for up to 4 people, or remove the others.')
  })

  it('refuses a role over 200 characters', () => {
    expect(swapInputError(SWAP_MAIN_MODEL, { ...ok, figures: [{ image: PHOTO, role: 'r'.repeat(201) }] }))
      .toBe('Keep each role under 200 characters.')
  })

  it('asks consent for the two new models only, SCAIL 2 runs without', () => {
    expect([...SWAP_CONSENT_MODELS]).toEqual([SWAP_MAIN_MODEL, SWAP_LONG_MODEL])
    expect(swapNeedsConsent('scail-2')).toBe(false)
    expect(swapInputError('scail-2', { ...ok, consent: false })).toBeNull()
    expect(swapInputError(SWAP_LONG_MODEL, { ...ok, consent: false })).toBe(SWAP_CONSENT_MISSING)
  })
})

describe('what a run sends', () => {
  const upload = async (_image: unknown, i: number) => `user-1/photo-${i + 1}.png`

  it('main model: every photo in order, the roles, the length and the consent', async () => {
    const out = await swapRunParams(SWAP_MAIN_MODEL, {
      hasVideo: true, consent: true, chosenSeconds: 10,
      figures: [{ image: PHOTO, role: 'the woman on the left' }, { image: PHOTO, role: '' }],
    }, { resolution: '480p' }, upload)
    expect(out).toEqual({
      image_paths: ['user-1/photo-1.png', 'user-1/photo-2.png'],
      studio_options: { resolution: '480p', roles: ['the woman on the left', 'the second person from the left'] },
      clip_seconds: 10,
      swap_consent: true,
    })
    // The options pass the contract the server checks.
    expect(() => studioOptions(SWAP_MAIN_MODEL, '', out.studio_options, false)).not.toThrow()
  })

  it('main model with one photo and no role: no roles, the whole 15 s', async () => {
    const out = await swapRunParams(SWAP_MAIN_MODEL, { hasVideo: true, consent: true, chosenSeconds: null, figures: one }, {}, upload)
    expect(out.image_paths).toEqual(['user-1/photo-1.png'])
    expect(out.studio_options).toEqual({})
    expect(out.clip_seconds).toBe(15)
    expect(out.source_path).toBeUndefined()
  })

  it('Wan 2.2 Animate: the photo as still, mode replace, up to 120 s', async () => {
    const out = await swapRunParams(SWAP_LONG_MODEL, { hasVideo: true, consent: true, chosenSeconds: 75, figures: one }, { resolution: '720p', mode: 'animate' }, upload)
    expect(out).toEqual({
      source_path: 'user-1/photo-1.png',
      studio_options: { resolution: '720p', mode: 'replace' },
      clip_seconds: 75,
      swap_consent: true,
    })
  })

  it('SCAIL 2: mode replace, no consent field', async () => {
    const out = await swapRunParams('scail-2', { hasVideo: true, consent: false, chosenSeconds: 30, figures: one }, {}, upload)
    expect(out.studio_options).toEqual({ mode: 'replace' })
    expect(out.swap_consent).toBeUndefined()
    expect(out.source_path).toBe('user-1/photo-1.png')
  })
})
