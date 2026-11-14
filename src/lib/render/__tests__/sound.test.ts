// The rules of the sound choice in Swap and Motion (14.11.2026, port of the
// web's lib/render/__tests__/sound.test.ts).
import { describe, it, expect, beforeEach } from 'vitest'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { neuerServer } from './fixtures/test-catalogs'
import {
  LIPSYNC_CLOUD_ONLY, LIPSYNC_NOT_AVAILABLE, LIPSYNC_ONE_PERSON, SOUND_CHOICES, SOUND_LABEL,
  lipsyncBlocked, lipsyncCredits, lipsyncCut, lipsyncSeconds, lipsyncSubmit, soundApplies, soundClipSeconds,
  soundInputError, soundParam, soundStudioOptions,
} from '../sound'

beforeEach(() => {
  useCloudCatalogStore.setState({
    models: neuerServer().map((m) => (m.id === 'latentsync'
      ? { ...m, credits: { base: 9000, length: { basis: 'audio' as const, block: 1, per_block: 3000, min: 3, max: 300, quote: 10 } } }
      : m.id === 'lipsync-2'
        ? { ...m, credits: { base: 50000, length: { basis: 'video' as const, block: 1, per_block: 5000, min: 1, max: 300, quote: 10 } } }
        : m)),
  })
})

describe('sound choice', () => {
  it('three choices, the original sound first', () => {
    expect(SOUND_CHOICES.map((c) => SOUND_LABEL[c])).toEqual(['Original sound', 'No sound', 'New voice, lips in sync'])
  })

  it('stands in Swap and Motion on the cloud only', () => {
    expect(soundApplies('swap_character', 'cloud', true)).toBe(true)
    expect(soundApplies('motion', 'cloud', true)).toBe(true)
    expect(soundApplies('motion', 'local', true)).toBe(false)
    expect(soundApplies('lipsync', 'cloud', true)).toBe(false)
    expect(soundApplies('video', 'cloud', true)).toBe(false)
    // Without the account switch (features.characterHub) there is no choice.
    expect(soundApplies('motion', 'cloud', false)).toBe(false)
    expect(soundApplies('swap_character', 'cloud', false)).toBe(false)
  })

  it('lip sync: one person, cloud only, and only when the server lists the model', () => {
    expect(lipsyncBlocked(1, 'cloud')).toBeNull()
    expect(lipsyncBlocked(2, 'cloud')).toBe(LIPSYNC_ONE_PERSON)
    expect(lipsyncBlocked(1, 'local')).toBe(LIPSYNC_CLOUD_ONLY)
    useCloudCatalogStore.setState({ models: neuerServer().filter((m) => m.id !== 'latentsync') })
    expect(lipsyncBlocked(1, 'cloud')).toBe(LIPSYNC_NOT_AVAILABLE)
  })

  it('the video run keeps the original sound until the lip sync step; Kling has a switch', () => {
    expect(soundParam('original')).toBe('original')
    expect(soundParam('lipsync')).toBe('original')
    expect(soundParam('none')).toBe('none')
    expect(soundStudioOptions('kling-v3-pro-motion-control', 'none')).toEqual({ keep_original_sound: false })
    expect(soundStudioOptions('kling-v3-pro-motion-control', 'lipsync')).toEqual({ keep_original_sound: true })
    expect(soundStudioOptions('scail-2', 'none')).toEqual({})
  })

  it('a voice longer than the clip is cut to it', () => {
    expect(lipsyncSeconds(9, 6)).toBe(6)
    expect(lipsyncSeconds(4, 6)).toBe(4)
    expect(lipsyncSeconds(undefined, 6)).toBe(6)
    expect(lipsyncSeconds(4, undefined)).toBe(4)
    expect(lipsyncCut(9, 6)).toBe(true)
    expect(lipsyncCut(6.03, 6)).toBe(false)
    expect(lipsyncCut(undefined, 6)).toBe(false)
  })

  it('prices by the catalogue rule: LatentSync by the voice (at least 3 s), Lipsync-2 by the clip', () => {
    expect(lipsyncCredits('latentsync', 9, 6)).toBe(18000)
    expect(lipsyncCredits('latentsync', 1, 6)).toBe(9000)
    expect(lipsyncCredits('lipsync-2', 2, 6)).toBe(30000)
    useCloudCatalogStore.setState({ models: neuerServer().filter((m) => m.id !== 'latentsync') })
    expect(lipsyncCredits('latentsync', 9, 6)).toBeNull()
  })

  it('the sentences before a start', () => {
    expect(soundInputError('original', 3, 'cloud', false)).toBeNull()
    expect(soundInputError(undefined, 3, 'cloud', false)).toBeNull()
    expect(soundInputError('lipsync', 2, 'cloud', true)).toBe('Lip sync works with one person. Pick Original sound or remove the other people.')
    expect(soundInputError('lipsync', 1, 'cloud', false)).toBe('Add the new voice: upload audio, make one, or pick an earlier voice.')
    expect(soundInputError('lipsync', 1, 'cloud', true)).toBeNull()
  })

  it('the lip sync body: fit_audio, the ceiling, and in Swap the swap step with the tick', () => {
    expect(lipsyncSubmit('latentsync', 'v', 'a', 18000, true)).toEqual({
      kind: 'video', model: 'latentsync', prompt: '',
      params: { op: 'lipsync', video_path: 'v', audio_path: 'a', fit_audio: true, max_credits: 18000, label: 'Lip sync', swap_step: 'lipsync', swap_consent: true },
    })
    const motion = lipsyncSubmit('lipsync-2', 'v', 'a', null, false)
    expect(motion.params.swap_step).toBeUndefined()
    expect(motion.params.max_credits).toBeUndefined()
  })

  it('the clip of the lip sync step: the seconds that run in Swap, the whole video in Motion', () => {
    expect(soundClipSeconds('swap_character', 'scail-2', 4, 6.006)).toBe(4)
    expect(soundClipSeconds('motion', 'scail-2', 4, 6.006)).toBe(6.006)
    expect(soundClipSeconds('motion', 'scail-2', null, undefined)).toBeUndefined()
  })
})
