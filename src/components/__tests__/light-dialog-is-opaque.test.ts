/**
 * C25 (3.1.0): in the light theme every ui/Modal read slightly through to the
 * page behind it. `.light .lu-dialog` was rgba(255,255,255,0.95) wherever the
 * WebView reports backdrop-filter support, which is every current one. The
 * light sheet is opaque white in both branches now; the dark glass keeps its
 * blur.
 *
 * Run: npx vitest run src/components/__tests__/light-dialog-is-opaque.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS = readFileSync(resolve(__dirname, '../../index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function blocks(selector: string): string[] {
  const out: string[] = []
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  for (const m of CSS.matchAll(re)) out.push(m[1])
  return out
}

describe('the light dialog sheet', () => {
  const light = blocks('.light .lu-dialog')

  it('is defined for both the plain and the backdrop-filter branch', () => {
    expect(light.length).toBe(2)
  })

  it.each([0, 1])('branch %i paints an opaque background', (i) => {
    const bg = /background:\s*([^;]+);/.exec(light[i])?.[1].trim() ?? ''
    expect(bg).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/)
    expect(bg).not.toMatch(/transparent/)
    expect(bg.toLowerCase()).toMatch(/^#fff(fff)?$/)
  })

  it('the dark sheet is still glass, so only light changed', () => {
    const dark = blocks('.lu-dialog').filter((b) => /backdrop-filter:\s*blur/.test(b))
    expect(dark.length).toBe(1)
  })
})
