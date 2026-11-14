/**
 * Swap Character on the desktop (07.11.2026, port of the web's C52; two steps
 * with SCAIL 2 and Kling since 14.11.2026): model choice, limits, the check
 * before a run, what a run sends, the price against the provider's own
 * examples (OpenJutsu 0.15/0.17/0.20/0.40 $ per input second, at least 3 s,
 * plus 0.02 $ per photo; Kling 0.168 $/s; SCAIL 2 720p 0.08 $/s), the marks,
 * the sentence of the frame step and the frame step itself.
 *
 * Pure: no store, no network. The upload is a fake that hands back a path.
 */
import { describe, expect, it } from 'vitest'
import {
  SWAP_CONSENT_MISSING, SWAP_CONSENT_MODELS, SWAP_FRAME_MODEL, SWAP_KLING_MODEL, SWAP_LONG_MODEL, SWAP_MAIN_MODEL,
  SWAP_OPENJUTSU_MODEL, SWAP_MODELS, SWAP_TIPS,
  swapAutoModel, swapBilledPhotos, swapClipCredits, swapClipLimits, swapClipSeconds, swapConsentRequired,
  swapCreditsPerSecond, swapDefaultOptions, swapFigureRoles, swapFixedOptions, swapFrameAspect, swapFrameKey,
  swapFrameOptions, swapFramePrompt, swapMarkRoles, swapMaxPeople, swapNeedsConsent, swapPanelFields,
  swapPricedSeconds, swapPrompt, swapReadsRoles, swapRoles, swapShortCredits, swapUsesFrame, swapWholeSeconds,
} from '../../render/swap'
import { swapInputError, swapReady, swapRunParams } from '../swap-run'
import { runSwapFrame, swapConfirmedFrame, swapFrameCredits, swapFrameProblem, swapFrameSubmit, swapKeyOf } from '../swap-frame'
import { presetModels, roleForModel } from '../../render/preset-models'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { neuerServer } from '../../render/__tests__/fixtures/test-catalogs'
import { STUDIO_MODELS, studioCredits, studioFields, studioOptions, studioPreviewCredits } from '../../render/studio-contract'
import { createStudioCost } from '../../render/create-studio'

const PHOTO = { url: 'data:image/png;base64,AA' }
const one = [{ image: PHOTO, role: '' }]
const credits = (usd: number) => Math.round(usd * 100000)

describe('the catalogue', () => {
  it('knows both new models under neutral endpoints, and SCAIL 2', () => {
    for (const id of SWAP_MODELS) expect(STUDIO_MODELS[id], id).toBeDefined()
    expect(STUDIO_MODELS[SWAP_OPENJUTSU_MODEL].endpoint).toBe('base/openjutsu/character-swap')
    expect(STUDIO_MODELS[SWAP_LONG_MODEL].endpoint).toBe('base/wan-2.2/animate')
    expect(STUDIO_MODELS[SWAP_OPENJUTSU_MODEL].inputs).toEqual({ video: 'video_path', images: 'image_paths' })
    expect(STUDIO_MODELS[SWAP_LONG_MODEL].defaults).toEqual({ mode: 'replace' })
  })

  it('offers roles, resolution 480p to 1080p (768p default) and seed on the main model', () => {
    const f = studioFields(SWAP_OPENJUTSU_MODEL)
    expect(Object.keys(f).sort()).toEqual(['resolution', 'roles', 'seed'])
    expect(f.resolution.enum).toEqual(['480p', '540p', '768p', '1080p'])
    expect(studioOptions(SWAP_OPENJUTSU_MODEL, '', undefined, false)).toEqual({ resolution: '768p' })
    expect(swapReadsRoles(SWAP_OPENJUTSU_MODEL)).toBe(true)
    expect(swapReadsRoles(SWAP_LONG_MODEL)).toBe(false)
  })

  it('holds each role to 200 characters (maxLength in the contract)', () => {
    expect(() => studioOptions(SWAP_OPENJUTSU_MODEL, '', { roles: ['a'.repeat(200)] }, false)).not.toThrow()
    expect(() => studioOptions(SWAP_OPENJUTSU_MODEL, '', { roles: ['a'.repeat(201)] }, false)).toThrow('Invalid roles')
    expect(() => studioOptions(SWAP_OPENJUTSU_MODEL, '', { roles: ['a', 'b', 'c', 'd', 'e'] }, false)).toThrow('Invalid roles')
  })
})

describe('model choice and limits', () => {
  it('runs SCAIL 2 first, then Kling, OpenJutsu and Wan 2.2 Animate (14.11.2026)', () => {
    expect([...SWAP_MODELS]).toEqual(['scail-2', 'kling-v3-pro-motion-control', 'openjutsu-character-swap', 'wan-2.2-animate-replace'])
    expect(SWAP_MAIN_MODEL).toBe('scail-2')
  })

  it('up to 3 people SCAIL 2 (long clips too), with 4 OpenJutsu; Kling never by itself', () => {
    expect(swapAutoModel(0)).toBe('scail-2')
    expect(swapAutoModel(1)).toBe('scail-2')
    expect(swapAutoModel(3)).toBe('scail-2')
    expect(swapAutoModel(4)).toBe(SWAP_OPENJUTSU_MODEL)
    expect(swapClipLimits('scail-2').max).toBe(120)
  })

  it('the notes before the start, grey', () => {
    expect([...SWAP_TIPS]).toEqual([
      'One continuous shot, no hard cuts. Everyone you replace must be visible in the first frame.',
      'Up to 3 people with SCAIL-2, one person with Kling (highest resolution).',
      'Subtitles burned into the video may disappear. Heavy make-up or costumes can blend back in.',
    ])
  })

  it('knows the span of each model', () => {
    expect(swapClipLimits(SWAP_OPENJUTSU_MODEL)).toEqual({ min: 2, max: 15, billedMin: 3 })
    expect(swapClipLimits(SWAP_LONG_MODEL)).toEqual({ min: 1, max: 120, billedMin: 3 })
    expect(swapMaxPeople(SWAP_OPENJUTSU_MODEL)).toBe(4)
    expect(swapMaxPeople(SWAP_LONG_MODEL)).toBe(1)
    expect(swapMaxPeople('scail-2')).toBe(3)
    expect(swapMaxPeople(SWAP_KLING_MODEL)).toBe(1)
    expect(swapClipLimits(SWAP_KLING_MODEL)).toEqual({ min: 3, max: 30, billedMin: 3 })
  })

  it('clips the length to the model and the video', () => {
    expect(swapClipSeconds(SWAP_OPENJUTSU_MODEL, null)).toBe(15)
    expect(swapClipSeconds(SWAP_OPENJUTSU_MODEL, 40)).toBe(15)
    expect(swapClipSeconds(SWAP_OPENJUTSU_MODEL, 1)).toBe(2)
    expect(swapClipSeconds(SWAP_OPENJUTSU_MODEL, null, 9.7)).toBe(9)
    expect(swapClipSeconds(SWAP_LONG_MODEL, 90, 200)).toBe(90)
    expect(swapPricedSeconds(SWAP_OPENJUTSU_MODEL, null, 40)).toBe(15)
    expect(swapPricedSeconds(SWAP_OPENJUTSU_MODEL, 10, 40)).toBe(10)
    expect(swapPricedSeconds(SWAP_OPENJUTSU_MODEL, null, 8.2)).toBe(8.2)
  })

  it('fixes mode replace on Wan 2.2 Animate and SCAIL 2, nothing on the main model', () => {
    expect(swapFixedOptions('swap_character', SWAP_LONG_MODEL)).toEqual({ mode: 'replace' })
    expect(swapFixedOptions('swap_character', 'scail-2')).toEqual({ mode: 'replace' })
    expect(swapFixedOptions('swap_character', SWAP_OPENJUTSU_MODEL)).toEqual({})
    // Motion Control keeps SCAIL 2 as animate.
    expect(swapFixedOptions('motion', 'scail-2')).toEqual({})
    expect(swapPanelFields('swap_character')).toEqual(['roles', 'resolution', 'mode'])
    expect(swapPanelFields('motion')).toEqual([])
  })
})

describe('the price, against the provider page', () => {
  it('10 s at 480p with 1 photo is 1.52 $', () => {
    expect(studioCredits(SWAP_OPENJUTSU_MODEL, { resolution: '480p' }, 10, 1, 100, 1)).toBe(credits(1.52))
    expect(swapClipCredits(SWAP_OPENJUTSU_MODEL, { resolution: '480p' }, 10, 1)).toBe(credits(1.52))
  })

  it('10 s at 768p with 2 photos is 2.04 $', () => {
    expect(studioCredits(SWAP_OPENJUTSU_MODEL, { resolution: '768p' }, 10, 1, 100, 2)).toBe(credits(2.04))
    expect(swapClipCredits(SWAP_OPENJUTSU_MODEL, { resolution: '768p' }, 10, 2)).toBe(credits(2.04))
  })

  it('15 s at 768p with 1 photo is 3.02 $', () => {
    expect(studioCredits(SWAP_OPENJUTSU_MODEL, { resolution: '768p' }, 15, 1, 100, 1)).toBe(credits(3.02))
    expect(swapClipCredits(SWAP_OPENJUTSU_MODEL, { resolution: '768p' }, 15, 1)).toBe(credits(3.02))
  })

  it('the preview of the Create button counts the same (default 768p, photos billed)', () => {
    expect(studioPreviewCredits(SWAP_OPENJUTSU_MODEL, {}, 10, 1, 100, 2)).toBe(credits(2.04))
    expect(createStudioCost(SWAP_OPENJUTSU_MODEL, { resolution: '480p' }, 100, 10, 1, swapBilledPhotos(SWAP_OPENJUTSU_MODEL, 1))).toBe(credits(1.52))
  })

  it('bills at least 3 s and every started second', () => {
    expect(swapClipCredits(SWAP_OPENJUTSU_MODEL, { resolution: '768p' }, 2, 1)).toBe(credits(0.62))
    expect(swapClipCredits(SWAP_OPENJUTSU_MODEL, { resolution: '768p' }, 9.2, 1)).toBe(credits(2.02))
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
    expect(swapInputError(SWAP_OPENJUTSU_MODEL, { ...ok, hasVideo: false })).toBe('Add the original video first.')
    expect(swapInputError(SWAP_OPENJUTSU_MODEL, { ...ok, figures: [{ image: null, role: '' }] })).toBe('Add a photo of the new person.')
    expect(swapInputError(SWAP_OPENJUTSU_MODEL, { ...ok, figures: [...one, { image: null, role: '' }] }))
      .toBe('Add a photo for person 2, or remove that person.')
    expect(swapInputError(SWAP_OPENJUTSU_MODEL, { ...ok, consent: false })).toBe(SWAP_CONSENT_MISSING)
    expect(swapInputError(SWAP_OPENJUTSU_MODEL, ok)).toBeNull()
    expect(swapReady(SWAP_OPENJUTSU_MODEL, ok)).toBe(true)
  })

  it('refuses several people on a one-person model instead of switching silently', () => {
    expect(swapInputError(SWAP_LONG_MODEL, { ...ok, figures: [...one, ...one] }))
      .toBe('This model replaces one person. Use SCAIL-2 for up to 3 people, or remove the others.')
    expect(swapInputError(SWAP_KLING_MODEL, { ...ok, frameJobId: 'f', figures: [...one, ...one] })).toMatch(/replaces one person/)
    expect(swapInputError('scail-2', { ...ok, frameJobId: 'f', figures: [...one, ...one, ...one, ...one] })).toBe('This model replaces at most 3 people.')
    expect(swapInputError('scail-2', { ...ok, frameJobId: 'f', figures: [...one, ...one, ...one] })).toBeNull()
  })

  it('refuses a role over 200 characters', () => {
    expect(swapInputError(SWAP_OPENJUTSU_MODEL, { ...ok, figures: [{ image: PHOTO, role: 'r'.repeat(201) }] }))
      .toBe('Keep each role under 200 characters.')
  })

  it('asks consent for every swap model, SCAIL 2 and Kling now too (gap: SCAIL 2 was missing)', () => {
    expect([...SWAP_CONSENT_MODELS]).toEqual(['scail-2', SWAP_KLING_MODEL, SWAP_OPENJUTSU_MODEL, SWAP_LONG_MODEL])
    expect(swapNeedsConsent('scail-2')).toBe(true)
    expect(swapNeedsConsent(SWAP_KLING_MODEL)).toBe(true)
    expect(swapInputError('scail-2', { ...ok, consent: false, frameJobId: 'f' })).toBe(SWAP_CONSENT_MISSING)
    expect(swapInputError(SWAP_KLING_MODEL, { ...ok, consent: false, frameJobId: 'f' })).toBe(SWAP_CONSENT_MISSING)
    expect(swapInputError(SWAP_LONG_MODEL, { ...ok, consent: false })).toBe(SWAP_CONSENT_MISSING)
  })

  it('SCAIL 2 and Kling start the video only on a confirmed first frame', () => {
    expect(swapInputError('scail-2', ok)).toMatch(/Build the first frame/)
    expect(swapReady('scail-2', ok)).toBe(false)
    expect(swapInputError('scail-2', { ...ok, frameJobId: 'f' })).toBeNull()
    expect(swapInputError(SWAP_KLING_MODEL, { ...ok, frameJobId: 'f' })).toBeNull()
    // OpenJutsu and Wan run in one step as before.
    expect(swapInputError(SWAP_LONG_MODEL, ok)).toBeNull()
  })
})

describe('what a run sends', () => {
  const upload = async (_image: unknown, i: number) => `user-1/photo-${i + 1}.png`

  it('main model: every photo in order, the roles, the length and the consent', async () => {
    const out = await swapRunParams(SWAP_OPENJUTSU_MODEL, {
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
    expect(() => studioOptions(SWAP_OPENJUTSU_MODEL, '', out.studio_options, false)).not.toThrow()
  })

  it('main model with one photo and no role: no roles, the whole 15 s', async () => {
    const out = await swapRunParams(SWAP_OPENJUTSU_MODEL, { hasVideo: true, consent: true, chosenSeconds: null, figures: one }, {}, upload)
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

  it('OpenJutsu takes its roles from the marks', async () => {
    const out = await swapRunParams(SWAP_OPENJUTSU_MODEL, {
      hasVideo: true, consent: true, chosenSeconds: null,
      figures: [{ image: PHOTO, role: '', mark: { x: 0.9, y: 0.5 } }, { image: PHOTO, role: '', mark: { x: 0.1, y: 0.5 } }],
    }, {}, upload)
    expect(out.studio_options).toEqual({ roles: ['the person on the right', 'the person on the left'] })
  })

  it('SCAIL 2: the confirmed frame as the still (adopt), replace, 720p, whole seconds, the video step', async () => {
    const log: string[] = []
    const out = await swapRunParams('scail-2', {
      hasVideo: true, consent: true, chosenSeconds: null, videoSeconds: 6.006, frameJobId: 'bild-1',
      figures: [{ image: PHOTO, role: '' }, { image: PHOTO, role: '' }],
    }, {}, async (_i, n) => { log.push(`upload ${n}`); return 'x' }, async (id) => { log.push(`adopt ${id}`); return `u/job-${id}-image` })
    expect(out).toEqual({
      source_path: 'u/job-bild-1-image',
      swap_step: 'video',
      studio_options: { resolution: '720p', mode: 'replace' },
      clip_seconds: 6,
      swap_consent: true,
    })
    // The photos do not go up again, only the frame is adopted.
    expect(log).toEqual(['adopt bild-1'])
  })

  it('SCAIL 2: an own resolution stays', async () => {
    const out = await swapRunParams('scail-2', { hasVideo: true, consent: true, chosenSeconds: null, frameJobId: 'b', figures: one }, { resolution: '480p' }, upload, async () => 'a')
    expect(out.studio_options).toEqual({ resolution: '480p', mode: 'replace' })
  })

  it('Kling: orientation of the video and the original sound, the chosen whole seconds', async () => {
    const out = await swapRunParams(SWAP_KLING_MODEL, {
      hasVideo: true, consent: true, chosenSeconds: 8, videoSeconds: 12.4, frameJobId: 'b', figures: one,
    }, {}, upload, async () => 'u/frame')
    expect(out).toEqual({
      source_path: 'u/frame', swap_step: 'video', clip_seconds: 8, swap_consent: true,
      studio_options: { character_orientation: 'video', keep_original_sound: true },
    })
    expect(studioOptions(SWAP_KLING_MODEL, '', out.studio_options)).toMatchObject({ keep_original_sound: true })
  })
})

describe('two steps (14.11.2026): models and people', () => {
  it('Kling 3.0 Pro Motion Control is in the catalogue as the provider describes it', () => {
    const m = STUDIO_MODELS[SWAP_KLING_MODEL]
    expect(m.label).toBe('Kling 3.0 Pro \u2022 Motion Control')
    expect(m.kind).toBe('video')
    expect(m.endpoint).toBe('kwaivgi/kling-v3.0-pro/motion-control')
    expect(m.inputs).toEqual({ image: 'source_path', video: 'video_path' })
    expect(m.defaults).toEqual({ character_orientation: 'video', keep_original_sound: true })
    expect(m.price).toMatchObject({ mode: 'input', rates: { default: 0.168 }, minSeconds: 3, maxSeconds: 30 })
    // No prompt needed, orientation by the video is valid.
    expect(studioOptions(SWAP_KLING_MODEL, '', {}).character_orientation).toBe('video')
    expect(() => studioOptions(SWAP_KLING_MODEL, '', { character_orientation: 'sideways' })).toThrow()
    // In Motion Control too, behind SCAIL 2 (on a server that lists it).
    useCloudCatalogStore.setState({ models: neuerServer() })
    expect(presetModels('motion').map((x) => x.id).slice(0, 2)).toEqual(['scail-2', SWAP_KLING_MODEL])
    expect(roleForModel(SWAP_KLING_MODEL)).toBe('motion')
  })

  it('Nano Banana Pro builds the frame and is in the catalogue', () => {
    expect(SWAP_FRAME_MODEL).toBe('nano-banana-pro-edit')
    expect(STUDIO_MODELS[SWAP_FRAME_MODEL]).toMatchObject({ kind: 'image', inputs: { images: 'image_paths' }, endpoint: 'google/nano-banana-pro/edit' })
  })

  it('only SCAIL 2 and Kling run in two steps, and only in Swap Character', () => {
    expect(swapUsesFrame('swap_character', 'scail-2')).toBe(true)
    expect(swapUsesFrame('swap_character', SWAP_KLING_MODEL)).toBe(true)
    expect(swapUsesFrame('swap_character', SWAP_OPENJUTSU_MODEL)).toBe(false)
    expect(swapUsesFrame('swap_character', SWAP_LONG_MODEL)).toBe(false)
    expect(swapUsesFrame('motion', 'scail-2')).toBe(false)
  })

  it('Kling: orientation of the video, original sound, no sentence; SCAIL 2: replace, 720p', () => {
    expect(swapFixedOptions('swap_character', SWAP_KLING_MODEL)).toEqual({ character_orientation: 'video', keep_original_sound: true })
    expect(swapFixedOptions('motion', SWAP_KLING_MODEL)).toEqual({})
    expect(swapDefaultOptions('swap_character', 'scail-2')).toEqual({ resolution: '720p' })
    expect(swapDefaultOptions('motion', 'scail-2')).toEqual({})
    expect(swapPrompt('swap_character', SWAP_KLING_MODEL, 'make it nice')).toBe('')
    expect(swapPrompt('swap_character', 'scail-2', 'make it nice')).toBe('')
    expect(swapPrompt('swap_character', SWAP_OPENJUTSU_MODEL, 'make it nice')).toBe('make it nice')
  })
})

describe('marks in the first frame become roles', () => {
  it('sorted by x: left, middle, right; with one mark "the person"', () => {
    expect(swapMarkRoles([])).toEqual([])
    expect(swapMarkRoles([{ x: 0.7, y: 0.4 }])).toEqual(['the person'])
    expect(swapMarkRoles([{ x: 0.8, y: 0.5 }, { x: 0.2, y: 0.5 }])).toEqual(['the person on the right', 'the person on the left'])
    expect(swapMarkRoles([{ x: 0.5, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.5 }]))
      .toEqual(['the person in the middle', 'the person on the right', 'the person on the left'])
    expect(swapMarkRoles([{ x: 0.4, y: 0 }, { x: 0.1, y: 0 }, { x: 0.9, y: 0 }, { x: 0.6, y: 0 }]))
      .toEqual(['the second person from the left', 'the first person from the left', 'the fourth person from the left', 'the third person from the left'])
  })

  it('an own role wins, without a mark the role stays empty (the main person)', () => {
    expect(swapFigureRoles([
      { role: '', mark: { x: 0.8, y: 0.5 } },
      { role: 'the woman with the phone', mark: { x: 0.2, y: 0.5 } },
    ])).toEqual(['the person on the right', 'the woman with the phone'])
    expect(swapFigureRoles([{ role: '' }])).toEqual([''])
    expect(swapFigureRoles([{ role: '  ', mark: null }])).toEqual([''])
  })
})

describe('the sentence of the frame step', () => {
  it('one person: the proven template, word for word (hair sentence of 14.11.)', () => {
    expect(swapFramePrompt(['the person'])).toBe(
      'Replace the person in the first image with the person from the second image. Keep the face identity, hair and facial features from the second image exactly. '
      + "Use the hair of the person from the second image and remove all of the original person's hair completely, even long hair. No headset, no microphone. Keep everything else from the first image identical: same pose, the same head angle as in the first image, "
      + 'same head size, mouth position, camera angle, framing, distance, clothing, background, lighting, colors, text overlays and phone-camera quality. '
      + 'It must look like the same raw phone video frame, just with the other person.',
    )
    expect(swapFramePrompt([''])).toContain('Replace the person in the first image')
    expect(swapFramePrompt([])).toContain('Replace the person in the first image')
  })

  it('several people: a photo each, plural', () => {
    const two = swapFramePrompt(['the person on the left', 'the person on the right'])
    expect(two).toContain('In the first image, replace the person on the left with the person from the second image and replace the person on the right with the person from the third image.')
    expect(two).toContain("Use each new person's own hair from their image and remove all of the original people's hair completely, even long hair.")
    expect(two).toContain('No headsets, no microphones.')
    expect(two).toContain('same poses, the same head angles as in the first image')
    expect(two).toContain('just with the other people.')
    const three = swapFramePrompt(['a', 'b', 'c'])
    expect(three).toContain('replace a with the person from the second image, replace b with the person from the third image and replace c with the person from the fourth image.')
  })

  it('"What\'s wrong?" goes at the end', () => {
    expect(swapFramePrompt(['the person'], 'head turned to the side like the original'))
      .toMatch(/just with the other person\. Fix this from the last attempt: head turned to the side like the original$/)
    expect(swapFramePrompt(['the person'], '   ')).toMatch(/other person\.$/)
  })

  it('aspect ratio: the allowed one closest to the video', () => {
    expect(swapFrameAspect(1080, 1920)).toBe('9:16')
    expect(swapFrameAspect(1920, 1080)).toBe('16:9')
    expect(swapFrameAspect(1000, 1000)).toBe('1:1')
    expect(swapFrameAspect(1440, 1920)).toBe('3:4')
    expect(swapFrameAspect(2560, 1080)).toBe('21:9')
    expect(swapFrameAspect(0, 0)).toBe('9:16')
    expect(swapFrameOptions(1080, 1920)).toEqual({ aspect_ratio: '9:16', resolution: '2k', output_format: 'jpeg' })
    expect(studioOptions(SWAP_FRAME_MODEL, 'x', swapFrameOptions(1080, 1920))).toMatchObject({ resolution: '2k', output_format: 'jpeg' })
  })
})

describe('prices (catalogue)', () => {
  it('Kling 6 s = 1.008 $; SCAIL 2 720p 6 s = 0.48 $', () => {
    expect(studioCredits(SWAP_KLING_MODEL, studioOptions(SWAP_KLING_MODEL, '', {}), 6)).toBe(100800)
    expect(studioCredits('scail-2', studioOptions('scail-2', '', { mode: 'replace', resolution: '720p' }), 6)).toBe(48000)
    expect(swapCreditsPerSecond(SWAP_KLING_MODEL, {})).toBe(16800)
    expect(swapCreditsPerSecond('scail-2', { resolution: '720p' })).toBe(8000)
    expect(swapClipCredits(SWAP_KLING_MODEL, {}, 6, 0)).toBe(100800)
    expect(swapClipCredits('scail-2', { resolution: '720p' }, 6, 0)).toBe(48000)
    // Kling: at least 3 s billed, at most 30 s.
    expect(studioCredits(SWAP_KLING_MODEL, studioOptions(SWAP_KLING_MODEL, '', {}), 2)).toBe(50400)
    expect(() => studioCredits(SWAP_KLING_MODEL, studioOptions(SWAP_KLING_MODEL, '', {}), 31)).toThrow()
  })

  it('the frame step costs what the catalogue names for Nano Banana Pro 2k', () => {
    expect(swapFrameCredits(1080, 1920, 1)).toBe(Math.round(STUDIO_MODELS[SWAP_FRAME_MODEL].price.rates['2k'] * 100000))
    expect(swapFrameCredits(1080, 1920, 1)).toBe(14000)
    expect(swapFrameCredits(1080, 1920, 3)).toBe(swapFrameCredits(1080, 1920, 1))
  })

  it('whole seconds just below: slider, button and server see the same number', () => {
    // 6.006 s the provider billed as 7 s; now 6 run.
    expect(swapWholeSeconds('scail-2', null, 6.006)).toBe(6)
    expect(swapPricedSeconds('scail-2', null, 6.006)).toBe(6)
    expect(swapPricedSeconds(SWAP_KLING_MODEL, null, 6.006)).toBe(6)
    expect(swapPricedSeconds('scail-2', null, 5.995)).toBe(6)
    expect(swapPricedSeconds('scail-2', 4, 9.5)).toBe(4)
    // More than 0.1 s over: the started second counts.
    expect(swapPricedSeconds('scail-2', null, 9.5)).toBe(10)
    expect(swapPricedSeconds('scail-2', null, 6.09)).toBe(6)
    expect(swapPricedSeconds('scail-2', null, 6.11)).toBe(7)
    expect(swapPricedSeconds('scail-2', null, 2.5)).toBe(3)
    expect(swapPricedSeconds(SWAP_KLING_MODEL, null, 45)).toBe(30)
    // The other models stay unrounded.
    expect(swapPricedSeconds(SWAP_OPENJUTSU_MODEL, null, 6.006)).toBe(6.006)
  })
})

describe('consent on the server', () => {
  it('asked for swap runs, not for Motion Control (the same rule as the web server)', () => {
    expect(swapConsentRequired(SWAP_OPENJUTSU_MODEL, {})).toBe(true)
    expect(swapConsentRequired(SWAP_LONG_MODEL, {})).toBe(true)
    expect(swapConsentRequired('scail-2', { studio_options: { mode: 'replace' } })).toBe(true)
    expect(swapConsentRequired('scail-2', { studio_options: { mode: 'animate' } })).toBe(false)
    expect(swapConsentRequired('scail-2', {})).toBe(false)
    expect(swapConsentRequired(SWAP_KLING_MODEL, {})).toBe(false)
    expect(swapConsentRequired(SWAP_KLING_MODEL, { swap_step: 'video' })).toBe(true)
    expect(swapConsentRequired(SWAP_FRAME_MODEL, { swap_step: 'frame' })).toBe(true)
    expect(swapConsentRequired(SWAP_FRAME_MODEL, {})).toBe(false)
  })
})

describe('the frame step', () => {
  const FOTO = 'data:image/png;base64,AA'
  const FRAME = { url: FOTO, width: 1080, height: 1920 }
  const request = (over: Partial<Parameters<typeof swapFrameProblem>[0]> = {}) => ({
    frame: FRAME, figures: [{ imageUrl: FOTO, role: '', mark: { x: 0.3, y: 0.4 } }], model: 'scail-2', consent: true, credits: 14000, ...over,
  })

  it('wants the frame, the photos, the limit of the model and the tick, before the frame step too', () => {
    expect(swapFrameProblem(request())).toBeNull()
    expect(swapFrameProblem(request({ frame: null }))).toBe('Add the original video first.')
    expect(swapFrameProblem(request({ figures: [{ imageUrl: null, role: '' }] }))).toBe('Add a photo of the new person.')
    expect(swapFrameProblem(request({ figures: [{ imageUrl: FOTO, role: '' }, { imageUrl: null, role: '' }] }))).toBe('Add a photo for person 2, or remove that person.')
    expect(swapFrameProblem(request({ consent: false }))).toBe(SWAP_CONSENT_MISSING)
    expect(swapFrameProblem(request({ model: SWAP_KLING_MODEL, figures: [{ imageUrl: FOTO, role: '' }, { imageUrl: FOTO, role: '' }] }))).toMatch(/one person/)
  })

  it('the body: first frame first, then the photos; 2k, JPEG, aspect ratio, the frame step with tick and ceiling', () => {
    const submit = swapFrameSubmit('u/frame', ['u/a', 'u/b'], request({
      figures: [{ imageUrl: FOTO, role: '', mark: { x: 0.8, y: 0.5 } }, { imageUrl: FOTO, role: '', mark: { x: 0.2, y: 0.5 } }],
      extra: 'no glasses',
    }))
    expect(submit.kind).toBe('image')
    expect(submit.model).toBe('nano-banana-pro-edit')
    expect(submit.params).toEqual({
      op: 'studio', image_paths: ['u/frame', 'u/a', 'u/b'],
      studio_options: { aspect_ratio: '9:16', resolution: '2k', output_format: 'jpeg' },
      swap_step: 'frame', swap_consent: true, max_credits: 14000, label: 'Swap Character first frame',
    })
    expect(submit.prompt).toContain('replace the person on the right with the person from the second image and replace the person on the left with the person from the third image')
    expect(submit.prompt).toMatch(/Fix this from the last attempt: no glasses$/)
  })

  it('uploads, submits and waits; without the tick nothing starts', async () => {
    const calls: string[] = []
    const deps = {
      uploadInput: async (_b: Blob, role: string) => { calls.push(`upload ${role}`); return `u/${calls.length}` },
      submitCloudJob: async (s: { model: string; params: { swap_step?: string } }) => { calls.push(`submit ${s.model} ${s.params.swap_step}`); return { id: 'job-9' } },
      pollJob: async (id: string) => { calls.push(`poll ${id}`); return { id, status: 'succeeded', result_url: 'https://ours/x.jpg' } as never },
      cancelJob: async () => ({ status: 'canceled' }),
    }
    const job = await runSwapFrame(request(), deps as never)
    expect(job.id).toBe('job-9')
    expect(calls).toEqual(['upload source', 'upload source', 'submit nano-banana-pro-edit frame', 'poll job-9'])
    calls.length = 0
    await expect(runSwapFrame(request({ consent: false }), deps as never)).rejects.toThrow(SWAP_CONSENT_MISSING)
    expect(calls).toEqual([])
  })

  it('the photos go up cut to the head, the first frame does not (head crop, 14.11.2026)', async () => {
    const sent: string[] = []
    const cropped: string[] = []
    const deps = {
      uploadInput: async (b: Blob, role: string) => { sent.push(`${role} ${await b.text()}`); return `u/${sent.length}` },
      cropFace: async (b: Blob) => { cropped.push(b.type); return new Blob([`head ${cropped.length}`], { type: 'image/png' }) },
      submitCloudJob: async () => ({ id: 'job-9' }),
      pollJob: async (id: string) => ({ id, status: 'succeeded', result_url: 'https://ours/x.jpg' } as never),
      cancelJob: async () => ({ status: 'canceled' }),
    }
    await runSwapFrame(request({ figures: [{ imageUrl: FOTO, role: '' }, { imageUrl: FOTO, role: '' }] }), deps as never)
    // Each photo cut once, the first frame of the video never.
    expect(cropped).toHaveLength(2)
    expect(sent.map((s) => s.includes('head'))).toEqual([false, true, true])
  })

  it('another video, photo, mark or role makes the built frame expire', () => {
    const fig = (url: string, role = '', mark: { x: number; y: number } | null = null) => ({ image: { url }, role, mark })
    const base = swapKeyOf('blob:v1', [fig('data:a')])
    expect(swapKeyOf('blob:v1', [fig('data:a')])).toBe(base)
    expect(swapKeyOf('blob:v2', [fig('data:a')])).not.toBe(base)
    expect(swapKeyOf('blob:v1', [fig('data:b')])).not.toBe(base)
    expect(swapKeyOf('blob:v1', [fig('data:a', 'the man')])).not.toBe(base)
    expect(swapKeyOf('blob:v1', [fig('data:a', '', { x: 0.5, y: 0.5 })])).not.toBe(base)
    expect(swapFrameKey('v', [{ imageUrl: null, role: '' }])).toBe(swapFrameKey('v', [{ imageUrl: null, role: '' }]))
    // Only a confirmed frame of the same inputs counts for the video run.
    const built = { jobId: 'j', key: base, confirmed: true }
    expect(swapConfirmedFrame(built, 'blob:v1', [fig('data:a')])).toBe('j')
    expect(swapConfirmedFrame({ ...built, confirmed: false }, 'blob:v1', [fig('data:a')])).toBeNull()
    expect(swapConfirmedFrame(built, 'blob:v2', [fig('data:a')])).toBeNull()
    expect(swapConfirmedFrame(null, 'blob:v1', [fig('data:a')])).toBeNull()
  })
})
