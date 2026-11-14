/**
 * The repository is checked out under "Locally Uncensored", with a space.
 * `new URL(…, import.meta.url).pathname` keeps that space as %20, so a script
 * that builds a folder path that way finds nothing (check-cloud-sales.mjs did,
 * 3.1.0). Scripts turn file URLs into paths with fileURLToPath.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPTS = resolve('scripts')
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : files(join(dir, e.name))) : /\.(mjs|cjs|js|ts)$/.test(e.name) ? [join(dir, e.name)] : [])

describe('scripts read their own folder in a path with a space', () => {
  it('no script takes .pathname of a file URL', () => {
    const hits = files(SCRIPTS).filter((f) => /import\.meta\.url\)\s*\.pathname/.test(readFileSync(f, 'utf8')))
    expect(hits.map((f) => f.slice(SCRIPTS.length + 1))).toEqual([])
  })

  it('fileURLToPath gives the real folder where .pathname does not', () => {
    const dir = '/tmp/Locally Uncensored/docs'
    const url = pathToFileURL(dir)
    expect(url.pathname).toContain('%20')
    expect(fileURLToPath(url)).toBe(dir)
  })

  it('check-cloud-sales finds the docs folder with fileURLToPath', () => {
    expect(readFileSync(join(SCRIPTS, 'check-cloud-sales.mjs'), 'utf8')).toMatch(/const docsRoot = fileURLToPath\(new URL\('\.\.\/docs', import\.meta\.url\)\)/)
  })
})
