/**
 * vollstaendigkeit-2 M7 and M8: the controls of a provider schema on a phone.
 *
 * M7: the presenter is picked by face, and no entry of the provider's list
 * is cut off. M8: a list field (style LoRAs, a pronunciation list) can be
 * edited; a field a phone cannot edit is not drawn, never shown locked.
 *
 * Run: npx vitest run src/mobile/screens/create/__tests__/schema-fields.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { avatarPreview } from '../../../../lib/render/heygen-avatars'
import { STUDIO_MODELS, studioFields, studioOptions } from '../../../../lib/render/studio-contract'
import { CREATE_STRINGS as T } from '../../../strings/create'
import {
  CHUNK, choiceEntries, drawnFields, fieldName, hasFaces, isDrawn, isSchemaSub, listKind, listMax, listSummary, listValue,
  nextChoice, sceneOf, schemaSubTitle, searchChoices, textEntries,
} from '../parts/SchemaFields'

const src = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8')

describe('M8: list fields', () => {
  const loras = studioFields('open-video-lora').loras

  it('style LoRAs are a list of choices with a strength, up to three', () => {
    expect(listKind(loras)).toBe('choices')
    expect(listMax(loras, 'choices')).toBe(3)
    expect(isDrawn(loras)).toBe(true)
    expect(fieldName('loras')).toBe('Style LoRAs')
    expect(drawnFields('open-video-lora').map(([key]) => key)).toContain('loras')
  })

  it('"Add" takes the first style that is not in the list yet', () => {
    const first = nextChoice(loras, [])
    expect(first).toEqual({ path: 'sulphur', scale: 1 })
    expect(nextChoice(loras, [first!])?.path).toBe('sulphur_v1')
  })

  it('what the editor writes is what the server check of the model accepts', () => {
    const rows = [{ path: 'hardcut', scale: 0.8 }, { path: 'vbvr', scale: 1 }]
    const options = studioOptions('open-video-lora', 'she turns', { loras: listValue(rows) })
    expect(options.loras).toEqual(rows)
    // An empty list is not sent at all.
    expect(listValue([])).toBeUndefined()
    expect(listSummary(loras, rows)).toBe('hardcut, vbvr')
    expect(listSummary(loras, undefined)).toBe('None')
  })

  it('a list of free lines can be edited too (pronunciation list)', () => {
    const dict = studioFields('minimax-speech-hd').pronunciation_dict
    expect(listKind(dict)).toBe('texts')
    expect(isDrawn(dict)).toBe(true)
    expect(listSummary(dict, ['Omg/Oh my god'])).toBe('1 entry')
    expect(studioOptions('minimax-speech-hd', 'hello', { pronunciation_dict: ['Omg/Oh my god'] }).pronunciation_dict).toEqual(['Omg/Oh my god'])
  })

  it('every field of every studio model is either drawn or left out, and every list a phone draws has an editor', () => {
    for (const id of Object.keys(STUDIO_MODELS)) {
      for (const [key, schema] of Object.entries(studioFields(id))) {
        if (schema.type === 'array') expect(isDrawn(schema), `${id}.${key}`).toBe(listKind(schema) !== null)
        if (schema.type === 'object') expect(isDrawn(schema), `${id}.${key}`).toBe(false)
      }
    }
  })

  it('garbage in the stored value does not break the editor', () => {
    expect(choiceEntries('x')).toEqual([])
    expect(choiceEntries([{ path: 'a' }, null, 3, { scale: 1 }])).toEqual([{ path: 'a' }])
    expect(textEntries([1, 'a', null])).toEqual(['a'])
  })

  it('no text says a field cannot be set "yet"', () => {
    expect(JSON.stringify(T)).not.toMatch(/cannot be set on a phone/i)
    expect(src('parts/SchemaFields.tsx')).not.toContain('unsupported')
    expect(src('RunSettingsSheet.tsx')).not.toContain('unsupported')
  })
})

describe('M7: the presenter with faces', () => {
  const avatar = studioFields('heygen-twin').avatar
  const names = (avatar.enum ?? []).map(String)

  it('the presenter field comes with faces, and most names have one', () => {
    expect(hasFaces('avatar', avatar)).toBe(true)
    expect(hasFaces('voice', avatar)).toBe(false)
    // 490 since the provider dropped ten (web e2dbb68e, desktop 3.1.3).
    expect(names.length).toBe(490)
    expect(names.filter((n) => avatarPreview(n)).length).toBeGreaterThan(480)
  })

  it('the picker has no cap: the source draws in chunks and never slices at a fixed number', () => {
    const file = src('parts/SchemaFields.tsx')
    expect(file).not.toMatch(/slice\(0,\s*200\)/)
    expect(file).toContain('useChunks(found.length, query)')
    expect(CHUNK).toBeGreaterThanOrEqual(40)
    expect(src('RunSettingsSheet.tsx')).not.toMatch(/slice\(0,\s*200\)/)
  })

  it('the scene stands under the person without her name', () => {
    expect(sceneOf('Annie Bar Standing Side 2')).toBe('Bar Standing Side 2')
    expect(sceneOf('Edward')).toBe('Edward')
  })

  it('the search finds by any part of the name', () => {
    expect(searchChoices(names, 'ANNIE').every((n) => n.toLowerCase().includes('annie'))).toBe(true)
    expect(searchChoices(names, '  ').length).toBe(490)
    expect(searchChoices(names, 'no such name')).toEqual([])
  })
})

describe('sub pages by name', () => {
  it('knows its own and names them', () => {
    expect(isSchemaSub('pick:avatar')).toBe(true)
    expect(isSchemaSub('list:loras')).toBe(true)
    expect(isSchemaSub('item:loras:1')).toBe(true)
    expect(isSchemaSub('negative')).toBe(false)
    expect(isSchemaSub(null)).toBe(false)
    expect(schemaSubTitle('pick:avatar')).toBe('Presenter')
    expect(schemaSubTitle('item:loras:1')).toBe('Style LoRAs')
    expect(schemaSubTitle('pick:aspect_ratio')).toBe('Aspect ratio')
  })
})
