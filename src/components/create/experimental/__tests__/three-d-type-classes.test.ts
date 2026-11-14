/**
 * The 3D files used a type class `t-meta` that does not exist (the text fell
 * back to the browser's 16 px, larger than the body text). Every `t-…` class
 * in them must be one index.css defines.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve('src/index.css'), 'utf8')
const defined = new Set([...css.matchAll(/^\.(t-[a-z]+)\s*\{/gm)].map((m) => m[1]))
const FILES = [
  'src/components/create/experimental/ThreeDStage.tsx',
  'src/components/create/experimental/ThreeDControls.tsx',
  'src/components/three/ModelViewer.tsx',
]

describe('the 3D files use only type classes that exist', () => {
  it.each(FILES)('%s', (file) => {
    const used = new Set([...readFileSync(resolve(file), 'utf8').matchAll(/["'\s`](t-(?:display|title|body|control|label|mono|micro|meta|small|caption|[a-z]+))(?=[\s"'`])/g)].map((m) => m[1]))
    const unknown = [...used].filter((c) => !defined.has(c) && /^t-[a-z]+$/.test(c))
    expect(unknown).toEqual([])
  })
})
