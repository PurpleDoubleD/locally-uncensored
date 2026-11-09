import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LOOK, LOOK_PRESETS, MIN_CONTRAST, PANE, clampZoom, cleanFontName, contrast, keyZoom, lookVars,
  normalizeBackground, normalizeLook, parseHex, pickBackground, readableOn, scenePrompt, wheelZoom, widthFactor,
} from '../chat-look'

const ref = 'lu-attachment:v1:' + 'a'.repeat(64)

describe('readableOn: a picked colour never makes a chat unreadable', () => {
  it('keeps a colour that already reads', () => {
    expect(readableOn('#111111', PANE.light)).toBe('#111111')
  })
  it.each([
    ['#ffff00', 'light'], ['#ffffff', 'light'], ['#a5b4fc', 'light'],
    ['#000000', 'dark'], ['#1e3a8a', 'dark'], ['#333333', 'dark'],
  ] as const)('moves %s until it reads on the %s pane', (hex, mode) => {
    const out = readableOn(hex, PANE[mode])!
    expect(contrast(parseHex(out)!, parseHex(PANE[mode])!)).toBeGreaterThanOrEqual(MIN_CONTRAST)
  })
  it('keeps the hue: a yellow becomes a darker yellow, not grey', () => {
    const out = parseHex(readableOn('#ffff00', PANE.light))!
    expect(out.r).toBeGreaterThan(out.b + 40)
    expect(out.g).toBeGreaterThan(out.b + 40)
  })
  it('refuses what is not a colour', () => {
    expect(readableOn('red; background:url(x)', PANE.light)).toBeNull()
    expect(readableOn(null, PANE.light)).toBeNull()
  })
})

describe('lookVars', () => {
  it('emits nothing for the default look, so the chat looks as before', () => {
    const vars = lookVars(DEFAULT_LOOK, 'dark')
    expect(Object.keys(vars).filter((k) => k !== '--lu-look-leading')).toEqual([])
  })
  it('every preset reads in both modes', () => {
    for (const p of LOOK_PRESETS) {
      const look = normalizeLook({ ...DEFAULT_LOOK, ...p.look })
      for (const mode of ['light', 'dark'] as const) {
        const vars = lookVars(look, mode)
        const surfaces = [PANE[mode], vars['--lu-look-user-bubble'], vars['--lu-look-model-bubble']].filter(Boolean) as string[]
        for (const name of ['--lu-look-quote', '--lu-look-action']) {
          if (!vars[name]) continue
          for (const s of surfaces) {
            expect(contrast(parseHex(vars[name])!, parseHex(s)!), `${p.id} ${mode} ${name} on ${s}`).toBeGreaterThanOrEqual(MIN_CONTRAST)
          }
        }
        if (vars['--lu-look-model-text']) {
          expect(contrast(parseHex(vars['--lu-look-model-text'])!, parseHex(vars['--lu-look-model-bubble'] ?? PANE[mode])!)).toBeGreaterThanOrEqual(MIN_CONTRAST)
        }
      }
    }
  })
  it('quotes and actions get a colour only when switched on', () => {
    expect(lookVars({ ...DEFAULT_LOOK, quoteText: '#ff0000' }, 'light')['--lu-look-quote']).toBeUndefined()
    expect(lookVars({ ...DEFAULT_LOOK, highlightQuotes: true }, 'light')['--lu-look-quote']).toBeDefined()
  })
})

describe('fonts', () => {
  it('cuts a typed font name to what a family name can hold', () => {
    expect(cleanFontName(`Georgia'; } body { x: url(evil)`)).toBe('Georgia body x urlevil')
    expect(cleanFontName('Noto Serif JP')).toBe('Noto Serif JP')
  })
})

describe('normalizeLook', () => {
  it('drops broken and foreign fields from an imported look', () => {
    const look = normalizeLook({ modelText: 'javascript:alert(1)', font: 'comic', width: 'huge', lineHeight: 99, evil: 1, userBubble: '#ABC' })
    expect(look.modelText).toBeNull()
    expect(look.font).toBe('app')
    expect(look.width).toBe('normal')
    expect(look.lineHeight).toBe(2.2)
    expect(look.userBubble).toBe('#aabbcc')
    expect('evil' in look).toBe(false)
  })
  it('width factors', () => {
    expect(widthFactor('normal')).toBe(1)
    expect(widthFactor('wide')).toBeGreaterThan(1)
    expect(widthFactor('full')).toBeNull()
  })
})

describe('zoom (C42)', () => {
  it('one mouse notch is one step, like a browser', () => {
    expect(wheelZoom(1, -100)).toBe(1.1)
    expect(wheelZoom(1, 100)).toBe(0.9)
    expect(wheelZoom(1, -3, 1)).toBe(1.1)
  })
  it('a trackpad pinch zooms smoothly', () => {
    const z = wheelZoom(1, -4)
    expect(z).toBeGreaterThan(1)
    expect(z).toBeLessThan(1.1)
  })
  it('stays within bounds', () => {
    expect(wheelZoom(2, -100)).toBe(2)
    expect(wheelZoom(0.7, 100)).toBe(0.7)
    expect(clampZoom(Number.NaN)).toBe(1)
  })
  it('keys', () => {
    expect(keyZoom(1, '=')).toBe(1.1)
    expect(keyZoom(1, '+')).toBe(1.1)
    expect(keyZoom(1.3, '-')).toBe(1.2)
    expect(keyZoom(1.7, '0')).toBe(1)
    expect(keyZoom(1, 'a')).toBeNull()
  })
})

describe('backgrounds', () => {
  it('the chat picture wins over the persona picture', () => {
    const bgs = { 'chat:c1': { ref, scrim: 0.7, blur: 0 }, 'persona:p1': { ref, scrim: 0.6, blur: 2 } }
    expect(pickBackground(bgs, 'c1', 'p1')?.key).toBe('chat:c1')
    expect(pickBackground(bgs, 'c2', 'p1')?.key).toBe('persona:p1')
    expect(pickBackground(bgs, 'c2', undefined)).toBeNull()
  })
  it('accepts only attachment references and keeps the scrim floor', () => {
    expect(normalizeBackground({ ref: 'https://evil.example/x.png' })).toBeNull()
    expect(normalizeBackground({ ref: 'data:image/png;base64,AAAA' })).toBeNull()
    expect(normalizeBackground({ ref, scrim: 0 })!.scrim).toBeGreaterThanOrEqual(0.5)
    expect(normalizeBackground({ ref, blur: 99 })!.blur).toBe(16)
  })
  it('the scene prompt keeps narration and drops speech and markup', () => {
    const p = scenePrompt(['old', '*She leans on the rail.* "Look at that!" The harbour glows under a red sky. ((OOC: brb))'])
    expect(p).toContain('The harbour glows under a red sky.')
    expect(p).not.toContain('Look at that')
    expect(p).not.toContain('OOC')
    expect(p).not.toContain('*')
  })
})
