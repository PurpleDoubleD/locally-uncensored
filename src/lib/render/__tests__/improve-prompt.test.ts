import { describe, it, expect } from 'vitest'
import {
  IMPROVE_MAX_CHARS, buildImproveMessages, cleanImproved, improveKindForIntent,
} from '../improve-prompt'

describe('Improve my prompt: welche Laeufe es kennen', () => {
  it('Bild, Video, Animation und Musik schreiben einen Prompt, den es umschreibt', () => {
    expect(improveKindForIntent('image')).toBe('image')
    expect(improveKindForIntent('video')).toBe('video')
    expect(improveKindForIntent('animate')).toBe('video')
    expect(improveKindForIntent('music')).toBe('music')
  })

  it('alles, was Worte des Kunden woertlich braucht, bleibt unberuehrt', () => {
    for (const intent of ['removebg', 'upscale', 'eraser', 'character', 'lipsync', 'extend', 'motion', 'tts']) {
      expect(improveKindForIntent(intent)).toBeNull()
    }
  })
})

describe('B48: Bearbeiten kennt Improve my prompt', () => {
  it('ein Edit wird als Anweisung umgeschrieben, nie als Beschreibung des ganzen Bildes', () => {
    expect(improveKindForIntent('edit')).toBe('edit')
    const system = buildImproveMessages({ kind: 'edit', modelLabel: 'FLUX.1 Krea' }, 'make her jacket red')[0].content
    expect(system).toMatch(/instructions for an image editing model/)
    expect(system).toMatch(/Do not describe the whole picture/)
    expect(system).toMatch(/FLUX.1 Krea/)
  })
})

describe('Improve my prompt: was das Chatmodell gesagt bekommt', () => {
  it('der Prompt des Kunden geht unveraendert als Nutzernachricht', () => {
    const m = buildImproveMessages({ kind: 'image' }, '  a red fox in snow ')
    expect(m.map((x) => x.role)).toEqual(['system', 'user'])
    expect(m[1].content).toBe('a red fox in snow')
  })

  it('jede Art bekommt ihre eigene Anweisung', () => {
    const image = buildImproveMessages({ kind: 'image' }, 'x')[0].content
    const tags = buildImproveMessages({ kind: 'image', tags: true }, 'x')[0].content
    const video = buildImproveMessages({ kind: 'video' }, 'x')[0].content
    const music = buildImproveMessages({ kind: 'music' }, 'x')[0].content
    expect(image).toContain('natural language')
    expect(tags).toContain('tags')
    expect(video).toContain('camera')
    expect(music).toContain('genre')
    expect(new Set([image, tags, video, music]).size).toBe(4)
  })

  it('ein Video mit mehreren Schnitten behaelt jeden Schnitt', () => {
    const s = buildImproveMessages({ kind: 'video' }, 'x')[0].content
    expect(s).toContain('keep every shot in order')
    expect(s).toContain('each cut written out in words')
  })

  it('die Regeln: nicht zensieren, nichts hinzuerfinden, Englisch, nur der Prompt', () => {
    const s = buildImproveMessages({ kind: 'video', modelLabel: 'Wan 2.2' }, 'x')[0].content
    expect(s).toContain('Never censor')
    expect(s).toContain('Do not add subjects')
    expect(s).toContain('translate it to English')
    expect(s).toContain('rewritten prompt only')
    expect(s).toContain('"Wan 2.2"')
  })

  it('kein Gedankenstrich im Text, der an das Modell geht', () => {
    for (const kind of ['image', 'video', 'music'] as const) {
      expect(buildImproveMessages({ kind, tags: true, modelLabel: 'M' }, 'x')[0].content).not.toMatch(new RegExp('[\\u2014\\u2013]'))
    }
  })
})

describe('Improve my prompt: die Antwort aufraeumen', () => {
  it('nimmt eine saubere Antwort', () => {
    expect(cleanImproved('A red fox in deep snow, soft dawn light.')).toBe('A red fox in deep snow, soft dawn light.')
  })

  it('entfernt Denkbloecke, Anfuehrungszeichen, Code-Zaun und Etikett', () => {
    expect(cleanImproved('<think>hmm</think>\n"A red fox."')).toBe('A red fox.')
    expect(cleanImproved('```\nA red fox.\n```')).toBe('A red fox.')
    expect(cleanImproved('Rewritten prompt: A red fox.')).toBe('A red fox.')
    expect(cleanImproved('<thinking>x</thinking>A fox')).toBe('A fox')
  })

  it('ein abgebrochener Denkblock ist keine Antwort', () => {
    expect(cleanImproved('<think>still thinking about the fox')).toBeNull()
  })

  it('leer, Absage oder zu lang ist keine Antwort', () => {
    expect(cleanImproved('   ')).toBeNull()
    expect(cleanImproved("I'm sorry, but I can't help with that.")).toBeNull()
    expect(cleanImproved('I cannot write this.')).toBeNull()
    expect(cleanImproved('a'.repeat(IMPROVE_MAX_CHARS + 1))).toBeNull()
    expect(cleanImproved('a'.repeat(IMPROVE_MAX_CHARS))).not.toBeNull()
  })

  it('ein Satz, der nur mit "I can" anfaengt, ist keine Absage', () => {
    expect(cleanImproved('I can see a fox in the snow, wide shot.')).toBe('I can see a fox in the snow, wide shot.')
  })
})
