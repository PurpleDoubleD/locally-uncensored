import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HOWTO, HOWTO_GUIDE_BASE, HOWTO_VIDEO_BASE, howtoGuideUrl, howtoLineAt, howtoVideoUrl, stageHowtoTopic } from '../howto'
import { INTENTS } from '../../components/create/experimental/intents'

describe('how it works', () => {
  it('has a film for every Create tab, for Code and for Agent', () => {
    for (const intent of INTENTS) expect(HOWTO[intent.id], intent.id).toBeTruthy()
    expect(HOWTO.code.films.map((f) => f.label)).toEqual(['Modes', 'Slash commands'])
    expect(HOWTO.agent).toBeTruthy()
  })

  it('names each Create film after the tab it stands on', () => {
    for (const intent of INTENTS) expect(HOWTO[intent.id].title).toBe(`How ${intent.short} works`)
  })

  it('keeps the lines of every film in the order they are shown', () => {
    for (const topic of Object.values(HOWTO)) {
      for (const film of topic.films) {
        const froms = film.steps.map((s) => s.from)
        expect(froms).toEqual([...froms].sort((a, b) => a - b))
        expect(film.steps.length).toBeGreaterThan(0)
      }
    }
  })

  it('shows the last line that has started', () => {
    const steps = HOWTO.music.films[0].steps
    expect(howtoLineAt(steps, 0)).toBe(steps[0].text)
    expect(howtoLineAt(steps, 3.75)).toBe(steps[0].text)
    expect(howtoLineAt(steps, 3.76)).toBe(steps[1].text)
    expect(howtoLineAt(steps, 99)).toBe(steps[3].text)
  })

  it('shows the first line before the first one has started', () => {
    expect(howtoLineAt(HOWTO.image.films[0].steps, 0)).toBe(HOWTO.image.films[0].steps[0].text)
  })

  it('loads a film from the one place the content policy allows', () => {
    expect(howtoVideoUrl(HOWTO.code.films[1])).toBe(`${HOWTO_VIDEO_BASE}code-slash.mp4`)
    expect(HOWTO_VIDEO_BASE.startsWith('https://lu-labs.ai/')).toBe(true)
  })

  it('links every topic to a handbook page on the site', () => {
    for (const [key, topic] of Object.entries(HOWTO)) {
      expect(topic.guide, key).toMatch(/^\/guide\/[a-z-]+\/$/)
      expect(howtoGuideUrl(topic)).toBe(`${HOWTO_GUIDE_BASE}${topic.guide}`)
    }
  })

  it('offers a film on the stage in Cloud mode, and locally only where the local lane has its own', () => {
    expect(stageHowtoTopic('image', 'cloud')).toBe('image')
    expect(stageHowtoTopic('image', 'local')).toBe('workflows')
    expect(stageHowtoTopic('video', 'local')).toBeNull()
    expect(stageHowtoTopic('character', 'local')).toBe(HOWTO['character-local'] ? 'character-local' : null)
    expect(stageHowtoTopic('image', 'local', true)).toBe('mac-hires')
    expect(stageHowtoTopic('character', 'local', true)).toBe('mac-character')
    expect(stageHowtoTopic('music', 'local', true)).toBe('mac-music')
    expect(stageHowtoTopic('video', 'local', true)).toBe('mac-video')
    expect(stageHowtoTopic('lipsync', 'local', true)).toBe('mac-lipsync')
    expect(stageHowtoTopic('animate', 'local', true)).toBeNull()
  })

  // P11 (David, 30.10.2026): how a GGUF file the user already has becomes an
  // LU Engine model, in Help (Settings, Storage) and in the Neuron tweaker.
  it('explains in two or three steps how to add a GGUF file, under Storage too', () => {
    const steps = HOWTO['gguf-file'].films[0].steps
    expect(steps.length).toBeGreaterThanOrEqual(2)
    expect(steps.length).toBeLessThanOrEqual(3)
    expect(steps[0].text).toMatch(/GGUF file/)
    expect(steps.map((s) => s.text).join(' ')).toMatch(/LU Engine/)
    const settings = readFileSync(resolve(__dirname, '../../components/settings/SettingsPage.tsx'), 'utf8')
    expect(settings).toContain('<HowtoRow topic="gguf-file" />')
  })
})
