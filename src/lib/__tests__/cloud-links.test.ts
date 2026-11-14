/**
 * Funnel 3.1.0 (Nr. 3): every link from the app to lu-labs.ai says where it
 * was clicked, and the checkout link goes to the checkout start page with the
 * order, never to the payment provider.
 *
 * Run: npx vitest run src/lib/__tests__/cloud-links.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cloudLink, checkoutStartUrl, APP_RETURN_SCHEME } from '../cloud-links'

const BASE = 'https://lu-labs.ai'
const params = (u: string) => Object.fromEntries(new URL(u).searchParams)

describe('cloudLink', () => {
  it('adds the source and the place, and keeps a hash at the end', () => {
    expect(cloudLink('/pricing', 'gate', undefined, BASE)).toBe('https://lu-labs.ai/pricing?utm_source=desktop&utm_medium=gate')
    expect(cloudLink('/pricing#max', 'gate-plans', 'switch', BASE))
      .toBe('https://lu-labs.ai/pricing?utm_source=desktop&utm_medium=gate-plans&utm_content=switch#max')
    expect(cloudLink('/pricing?tab=credits', 'credits-meter', undefined, BASE))
      .toBe('https://lu-labs.ai/pricing?tab=credits&utm_source=desktop&utm_medium=credits-meter')
    expect(cloudLink('account', 'settings', undefined, BASE)).toBe('https://lu-labs.ai/account?utm_source=desktop&utm_medium=settings')
  })
})

describe('checkoutStartUrl', () => {
  it('names the order, the source, the way back and the place', () => {
    const sub = new URL(checkoutStartUrl({ order: 'sub', src: 'app-gate-main', medium: 'gate', opener: 'switch', base: BASE }))
    expect(sub.origin + sub.pathname).toBe('https://lu-labs.ai/checkout/start')
    expect(params(sub.href)).toEqual({
      plan: 'hosted', interval: 'month', src: 'app-gate-main', return: 'app', scheme: APP_RETURN_SCHEME,
      utm_source: 'desktop', utm_medium: 'gate', utm_content: 'switch',
    })
    const pack = params(checkoutStartUrl({ order: 'pack', src: 'gpu8', medium: 'create-sheet', base: BASE }))
    expect(pack).toEqual({
      pack: 'pack-15', src: 'gpu8', return: 'app', scheme: 'locallyuncensored', utm_source: 'desktop', utm_medium: 'create-sheet',
    })
  })

  it('drops a source or a model that is not a plain word', () => {
    const p = params(checkoutStartUrl({ order: 'sub', src: 'Bad Source!', medium: 'gate', model: 'x y', base: BASE }))
    expect(p.src).toBeUndefined()
    expect(p.model).toBeUndefined()
    expect(params(checkoutStartUrl({ order: 'sub', src: 'app-gate', medium: 'gate-models', model: 'direct/v-1.2', category: 'chat', base: BASE })).model)
      .toBe('direct/v-1.2')
  })

  it('carries nothing about the user', () => {
    const keys = Object.keys(params(checkoutStartUrl({ order: 'sub', src: 'app-gate', medium: 'gate-models', model: 'm', category: 'code', opener: 'cloud-offer', base: BASE })))
    expect(keys.sort()).toEqual(['category', 'interval', 'model', 'plan', 'return', 'scheme', 'src', 'utm_content', 'utm_medium', 'utm_source'])
  })
})

/** No link in the desktop code opens lu-labs.ai without the place it came
 *  from. Only `openExternal(` calls with the cloud address are read; fetches
 *  to the API are no visits. The phone has its own links. */
describe('the desktop opens lu-labs.ai only through cloudLink', () => {
  const root = resolve(__dirname, '..', '..')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) {
        if (e === '__tests__' || e === 'mobile') continue
        walk(p)
      } else if (/\.tsx?$/.test(e)) files.push(p)
    }
  }
  walk(root)

  it('has no bare CLOUD_BASE or PRICING_URL inside openExternal', () => {
    const bare = files.flatMap((f) => {
      const src = readFileSync(f, 'utf8')
      return [...src.matchAll(/openExternal\(([^)\n]*)\)/g)]
        .map((m) => m[1])
        .filter((arg) => /CLOUD_BASE|PRICING_URL|lu-labs\.ai/.test(arg))
        // The gate's model checkout builds its link in lib/cloud-links too.
        .filter((arg) => !/^(gateCheckoutUrl|cloudLink|checkoutStartUrl)\(/.test(arg))
        .map((arg) => `${f.slice(root.length)}: ${arg}`)
    })
    expect(bare).toEqual([])
  })
})
