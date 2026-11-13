/**
 * C7 (funde-C.md): a trigger word "Jörg" was learned from captions saying
 * "Jörg", but Rust named the LoRA after `sanitize_component("Jörg")`, so the
 * file was `char_J_rg_zimage.safetensors` and the Use shelf put "J_rg" into
 * the prompt. Now the field itself turns the word into the form Rust keeps
 * unchanged, visibly, and the training run uses that form.
 *
 * Run: npx vitest run src/lib/__tests__/train-trigger-matches-the-lora-file.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { useCreateStore } from '../../stores/createStore'
import { buildTrainCaption } from '../train-captions'
import { parseLocalCharacterLora } from '../../api/trainer'
import { trainTriggerWord } from '../train-trigger'

/** src-tauri/src/commands/trainer.rs `sanitize_component`, 1:1. */
const rustSanitize = (s: string) =>
  [...s].map((c) => (/^[A-Za-z0-9_-]$/.test(c) ? c : '_')).join('').replace(/^_+|_+$/g, '').slice(0, 48)

/** What runCharacterTraining hands on, end to end: field, caption, file, shelf. */
function roundTrip(typed: string) {
  useCreateStore.getState().setTriggerWord(typed)
  const field = useCreateStore.getState().triggerWord
  const trigger = trainTriggerWord(field)
  const caption = buildTrainCaption(trigger)
  const file = `char_${rustSanitize(trigger)}_zimage.safetensors`
  return { field, caption, shelf: parseLocalCharacterLora(file)?.trigger }
}

beforeEach(() => useCreateStore.setState({ triggerWord: '', triggerWordNote: null }))

describe('C7: captions, LoRA file and Use shelf name the same trigger word', () => {
  it.each([
    ['Jörg', 'Joerg'],
    ['Zoë', 'Zoe'],
    ['Søren', 'Soren'],
    ['Renée', 'Renee'],
    ['Straße', 'Strasse'],
  ])('%s is shown and trained as %s', (typed, expected) => {
    const { field, caption, shelf } = roundTrip(typed)
    expect(field).toBe(expected)
    expect(caption).toBe(`${expected}, a photo of ${expected}`)
    expect(shelf).toBe(expected)
  })

  it('the field says what it did, and the note stays after the next keystroke', () => {
    useCreateStore.getState().setTriggerWord('Jörg')
    expect(useCreateStore.getState().triggerWordNote).toContain('“Joerg”')
    useCreateStore.getState().setTriggerWord('Joergx')
    expect(useCreateStore.getState().triggerWordNote).toContain('Joerg')
    useCreateStore.getState().setTriggerWord('')
    expect(useCreateStore.getState().triggerWordNote).toBeNull()
  })

  it('a plain ASCII word is untouched and gets no note', () => {
    const { field, shelf } = roundTrip('davechar')
    expect(field).toBe('davechar')
    expect(shelf).toBe('davechar')
    expect(useCreateStore.getState().triggerWordNote).toBeNull()
  })

  it('letters without a Latin form are dropped, with the rule said', () => {
    useCreateStore.getState().setTriggerWord('Сергей')
    expect(useCreateStore.getState().triggerWord).toBe('')
    expect(useCreateStore.getState().triggerWordNote).toMatch(/A to Z/)
  })

  it('end underscores are trimmed for the run, as Rust trims them', () => {
    expect(trainTriggerWord('_mia_')).toBe('mia')
    expect(rustSanitize(trainTriggerWord('_mia_'))).toBe('mia')
  })

  it('the training run builds its captions from the cleaned trigger', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'hooks', 'useCreate.ts'), 'utf8')
    expect(src).toContain('const trigger = trainTriggerWord(state.triggerWord)')
  })
})
