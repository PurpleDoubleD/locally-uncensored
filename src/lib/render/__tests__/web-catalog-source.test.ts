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
import { GENERATED_FILES, SOURCE_FILE, checkSnapshot, hashText } from '../../../../scripts/studio-snapshot.mjs'

const DIR = 'src/lib/render'
const read = (name: string) => readFileSync(resolve(DIR, name), 'utf8')

interface Source {
  generator: string
  web: { ref: string | null; commit: string | null; committed: string | null; dirty: boolean }
  files: Record<string, string>
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
