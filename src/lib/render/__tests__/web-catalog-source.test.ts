/**
 * The cloud media catalogue of the desktop is a generated copy of the web's
 * (scripts/studio-snapshot.mjs). This guard runs without the web: it holds
 * every generated file against the sha256 the generator recorded in
 * web-catalog-source.json, together with the web commit it read.
 *
 * A file edited by hand, or a merge that brings in a change to a generated
 * file without running the generator, turns this red. The fix is never to
 * edit the hash: run the generator against the web commit the release ships
 * with (the command stands at the top of the script) and commit what it
 * writes.
 *
 * Whether that commit is still the live one is what the opt-in guards with
 * LU_WEB_REPO answer (studio-contract, katalog-paritaet-web, video-duration),
 * and `node scripts/studio-snapshot.mjs --ref <commit> --check` in the
 * release checklist.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GATE_SEED_FILE, GENERATED_FILES, SOURCE_FILE, checkSnapshot, gateSeedText, hashText } from '../../../../scripts/studio-snapshot.mjs'
import { isRetiredMediaModel } from '../retired-models'

const DIR = 'src/lib/render'
const read = (name: string) => readFileSync(resolve(DIR, name), 'utf8')

interface Source {
  generator: string
  web: { ref: string | null; commit: string | null; committed: string | null; dirty: boolean }
  files: Record<string, string>
  gate?: { from: string; file: string; sha256: string }
}

const source = JSON.parse(read(SOURCE_FILE)) as Source

describe('the catalogue copy is what the generator wrote', () => {
  it('names one web commit, read clean', () => {
    expect(source.generator).toBe('scripts/studio-snapshot.mjs')
    expect(source.web.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(Number.isNaN(Date.parse(source.web.committed ?? ''))).toBe(false)
    // A working tree with local changes in these files is no source a
    // release can name.
    expect(source.web.dirty).toBe(false)
  })

  it('lists exactly the generated files', () => {
    expect(Object.keys(source.files)).toEqual(GENERATED_FILES)
  })

  it.each(GENERATED_FILES)('%s has the hash the generator recorded', (name) => {
    expect(hashText(read(name)), `${name} differs from what the generator wrote. Run scripts/studio-snapshot.mjs instead of editing it.`)
      .toBe(source.files[name])
  })

  it('the files on disk are a snapshot the app can read', () => {
    expect(() => checkSnapshot(Object.fromEntries(GENERATED_FILES.map((name) => [name, read(name)])))).not.toThrow()
  })
})

describe('the offline lists of the gate pop-up are what the generator wrote', () => {
  const seedText = readFileSync(resolve(GATE_SEED_FILE), 'utf8')
  const seed = JSON.parse(seedText) as Record<'chat' | 'code' | 'create', Array<{ id: string; label: string; kind?: string; adult?: true }>>

  it('come from the public catalogue and have the hash recorded for them', () => {
    expect(source.gate?.file).toBe(GATE_SEED_FILE)
    expect(source.gate?.from).toMatch(/^https:\/\/lu-labs\.ai\/api\/public\/cloud-catalog$/)
    expect(hashText(seedText), `${GATE_SEED_FILE} differs from what the generator wrote. Run scripts/studio-snapshot.mjs --gate live instead of editing it.`)
      .toBe(source.gate?.sha256)
  })

  it('name no model the cloud has retired', () => {
    expect(seed.create.filter((m) => isRetiredMediaModel(m.id)).map((m) => m.id)).toEqual([])
  })

  it('keep the app\'s own names and only what the app reads', () => {
    const out = gateSeedText({
      version: 1,
      categories: {
        chat: [{ id: 'a/b', label: 'Public name', native_label: 'App name', plans: ['hosted'] }],
        code: [],
        create: [{ id: 'flux-x', label: 'Flux X', kind: 'image', plans: ['hosted'], adult: true }],
      },
    })
    expect(JSON.parse(out)).toEqual({ chat: [{ id: 'a/b', label: 'App name' }], code: [], create: [{ id: 'flux-x', label: 'Flux X', kind: 'image', adult: true }] })
    expect(() => gateSeedText({ version: 2, categories: {} })).toThrow()
  })
})
