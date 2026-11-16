/**
 * David, 16.11.2026: do people who already have characters see them on the
 * stage right after the update to 3.1.0?
 *
 * The stage reads the same three places 3.0.x wrote to, in the same format.
 * This file pins that, with rows and names as 3.0.10 left them:
 *   (a) LoRA files of this machine: `char_<name>_zimage.safetensors`, the
 *       name the trainer has written since 3.0.0, also in a subfolder;
 *   (b) characters trained in LU Cloud: the rows of /api/loras;
 *   (c) characters saved from photos: the IndexedDB `lu-saved-characters`,
 *       version 1, store `characters`, rows { id, name, createdAt, photos }.
 * Nothing is migrated, because nothing changed place or shape.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { listLocalCharacters } from '../../characters'
import { hubFromCloud, hubFromLocal, hubFromSaved, mergeHubCharacters } from '../character-hub'
import type { CloudLora } from '../../../api/cloud/loras'

const src = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8')

describe('characters from 3.0.x after the update', () => {
  it('(a) every file the old trainer wrote is a character: plain, in a subfolder, in any case', async () => {
    const files = [
      'char_anna_zimage.safetensors',
      'chars/char_anna_b_zimage.safetensors',
      'sub\\char_Tom_zimage.safetensors',
      'CHAR_MIA_ZIMAGE.SAFETENSORS',
      // Not characters: a style of 3.0.9 and somebody's own LoRA.
      'style_ink_zimage.safetensors',
      'detail_tweaker.safetensors',
    ]
    const refs = await listLocalCharacters(async () => files, 'local:')
    expect(refs.map((r) => r.triggerWord).sort()).toEqual(['MIA', 'Tom', 'anna', 'anna_b'])
    const onStage = refs.map(hubFromLocal)
    expect(onStage.every((c) => c.kind === 'local' && c.image === null && !!c.ref)).toBe(true)
    // The same pattern as in 3.0.10 (git show v3.0.10:src/api/trainer.ts).
    expect(src('api/trainer.ts')).toContain(String.raw`/(?:^|[\\/])char_(.+)_zimage\.safetensors$/i`)
  })

  it('(b) a character trained in LU Cloud stands on the stage with its name, family and look', () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111', name: 'Bean', trigger_word: 'beanchar', base_family: 'flux',
      created_at: '2026-10-01T10:00:00Z', source: 'trained', preview_url: null, base_url: 'https://lu-labs.ai/x.png',
    } as unknown as CloudLora
    const c = hubFromCloud(row)
    expect(c).toMatchObject({ key: `cloud:${row.id}`, kind: 'cloud', name: 'Bean', meta: 'Trained · Flux', image: 'https://lu-labs.ai/x.png' })
    expect(c.ref).toMatchObject({ id: row.id, triggerWord: 'beanchar', family: 'flux' })
  })

  it('(c) the store of the saved characters is the one 3.0.5 to 3.0.10 wrote: same name, version, store and row', () => {
    const now = src('lib/saved-characters.ts')
    expect(now).toContain("const DB_NAME = 'lu-saved-characters'")
    expect(now).toContain("const STORE = 'characters'")
    expect(now).toContain('indexedDB.open(DB_NAME, 1)')
    expect(now).toMatch(/createObjectStore\(STORE, \{ keyPath: 'id' \}\)/)
    expect(now).toMatch(/export interface StoredCharacter \{\s*id: string\s*name: string\s*createdAt: number\s*photos: \{ type: string; bytes: ArrayBuffer \}\[\]\s*\}/)
    // A row as 3.0.10 stored it becomes a character of the stage.
    const saved = { id: 'c1', name: 'Oma', photos: [new Blob(['a']), new Blob(['b'])] }
    expect(hubFromSaved(saved, 'blob:1')).toMatchObject({ key: 'saved:c1', kind: 'saved', name: 'Oma', meta: 'Photos · 2', image: 'blob:1' })
  })

  it('all three sources stand in one row, none hides another of the same name', () => {
    const cloud = [hubFromCloud({ id: '1', name: 'Oma', trigger_word: 'oma', base_family: 'flux', source: 'trained', preview_url: null, base_url: null } as unknown as CloudLora)]
    const local = [hubFromLocal({ id: 'local:char_oma_zimage.safetensors', name: 'oma', triggerWord: 'oma', family: 'zimage' })]
    const saved = [hubFromSaved({ id: 'c1', name: 'Oma', photos: [new Blob(['a'])] }, null)]
    expect(mergeHubCharacters(cloud, local, saved).map((c) => c.kind)).toEqual(['cloud', 'local', 'saved'])
  })
})
