/**
 * 3.0.8 D28 und D20: die Beschriftung je Foto und das Rezept fuer Karten mit
 * wenig Speicher, die reinen Teile.
 *
 * Run: npx vitest run src/lib/__tests__/train-captions-and-low-vram.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildTrainCaption, cleanTrainDescription, TRAIN_CAPTION_MAX, TRAIN_CAPTION_HELP } from '../train-captions'
import {
  TRAIN_VRAM_FLOOR_MIB, TRAIN_VRAM_PRESETS, TRAIN_VRAM_PRESET_DEFAULT, LOW_VRAM_NOTE,
  isTrainVramPreset, trainVramSuggestion,
} from '../trainer-presets'

const rust = readFileSync(resolve(__dirname, '../../..', 'src-tauri/src/commands/trainer.rs'), 'utf8')

describe('die Beschriftung je Foto (D28)', () => {
  it('ohne Beschreibung exakt die bisherige Zeile', () => {
    expect(buildTrainCaption('davechar')).toBe('davechar, a photo of davechar')
    expect(buildTrainCaption('davechar', '')).toBe('davechar, a photo of davechar')
    expect(buildTrainCaption('davechar', '   ')).toBe('davechar, a photo of davechar')
    expect(buildTrainCaption('davechar', null)).toBe('davechar, a photo of davechar')
  })

  it('mit Beschreibung: Triggerwort vorn, das Wechselnde hinten', () => {
    expect(buildTrainCaption('davechar', 'red jacket, short hair, beach'))
      .toBe('davechar, a photo of davechar, red jacket, short hair, beach')
  })

  it('eine Zeile, ohne Satzzeichen am Ende, gekappt', () => {
    expect(cleanTrainDescription('  red jacket,\n short   hair.  ')).toBe('red jacket, short hair')
    expect(cleanTrainDescription('x'.repeat(500)).length).toBe(TRAIN_CAPTION_MAX)
    expect(buildTrainCaption('t', 'a\r\nb')).toBe('t, a photo of t, a b')
  })

  it('die Erklaerzeile ist englisch und ohne Gedankenstrich', () => {
    expect(TRAIN_CAPTION_HELP).toMatch(/clothes, hair or place/)
    expect(TRAIN_CAPTION_HELP).not.toMatch(/[\u2013\u2014]| - /)
  })

  it('der Rust-Teil schreibt die Zeile als .txt neben das Bild', () => {
    expect(rust).toContain('caption_extension = \\".txt\\"')
    expect(rust).toContain('fs::write(img_dir.join(format!("{stem}.txt")), caption_file_text(caption))')
  })
})

describe('Low VRAM (D20)', () => {
  it('zwei Rezepte, Normal ist die Voreinstellung', () => {
    expect(TRAIN_VRAM_PRESETS.map((p) => `${p.value}:${p.label}`)).toEqual(['standard:Normal', 'low-vram:Low VRAM'])
    expect(TRAIN_VRAM_PRESET_DEFAULT).toBe('standard')
    expect(isTrainVramPreset('low-vram')).toBe(true)
    expect(isTrainVramPreset('ultra')).toBe(false)
    expect(isTrainVramPreset(undefined)).toBe(false)
  })

  it('die Untergrenzen sind dieselben wie im Rust-Teil', () => {
    expect(rust).toContain('const TRAINER_VRAM_FLOOR_MIB_FP8: u64 = 11 * 1024;')
    expect(rust).toContain('const TRAINER_VRAM_FLOOR_MIB_LOW_VRAM_FP8: u64 = 7 * 1024 + 512;')
    expect(TRAIN_VRAM_FLOOR_MIB.standard).toBe(11 * 1024)
    expect(TRAIN_VRAM_FLOOR_MIB['low-vram']).toBe(7 * 1024 + 512)
  })

  it('der Rust-Teil kennt denselben Namen fuer das Rezept', () => {
    expect(rust).toContain('Some("low-vram") => TrainPreset::LowVram')
  })

  it('eine 8-GB-Karte bekommt den Vorschlag mit Knopf', () => {
    const s = trainVramSuggestion(8, 'standard')
    expect(s?.switchTo).toBe('low-vram')
    expect(s?.text).toBe('This card has 8 GB. Normal training needs 11 GB, Low VRAM is made for cards like this one, and a run started on Normal switches to it on its own.')
    expect(trainVramSuggestion(10, 'standard')?.switchTo).toBe('low-vram')
  })

  it('mit Low VRAM gewaehlt oder einer 12-GB-Karte: kein Vorschlag', () => {
    expect(trainVramSuggestion(8, 'low-vram')).toBeNull()
    expect(trainVramSuggestion(12, 'standard')).toBeNull()
    expect(trainVramSuggestion(24, 'low-vram')).toBeNull()
  })

  it('unbekannte Karte (oder Mac): kein Vorschlag', () => {
    expect(trainVramSuggestion(null, 'standard')).toBeNull()
    expect(trainVramSuggestion(0, 'standard')).toBeNull()
  })

  it('unter 8 GB: ehrlich, ohne Knopf, mit Cloud als Weg', () => {
    const s = trainVramSuggestion(6, 'standard')
    expect(s?.switchTo).toBeUndefined()
    expect(s?.text).toContain('This card has 6 GB')
    expect(s?.text).toContain('Cloud mode')
    expect(trainVramSuggestion(6, 'low-vram')?.switchTo).toBeUndefined()
  })

  it('der Satz zu Dauer und Qualitaet nennt beides', () => {
    expect(LOW_VRAM_NOTE).toContain('512 px')
    expect(LOW_VRAM_NOTE).toContain('longer')
    expect(LOW_VRAM_NOTE).toContain('softer')
    expect(LOW_VRAM_NOTE).not.toMatch(/[\u2013\u2014]| - /)
  })
})
