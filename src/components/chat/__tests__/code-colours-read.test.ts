/**
 * Code blocks read in both modes (3.1.0, P-M).
 *
 * Until 3.1.0 every block used the one-dark theme on a 30 % black wash, also
 * in light mode. On the white pane that is a mid grey (#b3b3b3) under colours
 * made for a dark ground: plain code measured 1.02:1, comments 2.9:1. Now
 * each mode has its theme, and every token colour must reach 4.5:1 on the
 * ground it is really drawn on (the wash over the pane).
 *
 * Run: npx vitest run src/components/chat/__tests__/code-colours-read.test.ts
 */
import { describe, it, expect } from 'vitest'
import { CODE_GROUND, CODE_THEME_DARK, CODE_THEME_LIGHT } from '../CodeBlock'
import { PANE, contrast, type Rgb } from '../../../lib/chat-look'

function parse(c: string): { rgb: Rgb; a: number } | null {
  let m = /^#([0-9a-f]{6})$/i.exec(c)
  if (m) return { rgb: { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) }, a: 1 }
  m = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c)
  if (m) return { rgb: { r: +m[1], g: +m[2], b: +m[3] }, a: m[4] === undefined ? 1 : +m[4] }
  m = /^hsl\(\s*([\d.]+),\s*([\d.]+)%?,\s*([\d.]+)%\)$/.exec(c)
  if (m) {
    const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100
    const f = (n: number) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
    return { rgb: { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 }, a: 1 }
  }
  return null
}

function over(top: string, under: string): Rgb {
  const t = parse(top)!
  const u = parse(under)!.rgb
  return { r: t.rgb.r * t.a + u.r * (1 - t.a), g: t.rgb.g * t.a + u.g * (1 - t.a), b: t.rgb.b * t.a + u.b * (1 - t.a) }
}

function weakTokens(theme: Record<string, { color?: string }>, ground: Rgb): string[] {
  const out: string[] = []
  for (const [key, rule] of Object.entries(theme)) {
    // Selection colours and the whitespace markers (::before, alpha) are not text.
    if (!rule.color || key.includes('selection') || key.includes(':before')) continue
    const c = parse(rule.color)
    if (!c) continue
    const ratio = contrast(c.rgb, ground)
    if (ratio < 4.5) out.push(`${key} ${rule.color} ${ratio.toFixed(2)}:1`)
  }
  return out
}

describe('code colours read', () => {
  it('light mode: every token reaches 4.5:1 on its ground', () => {
    expect(weakTokens(CODE_THEME_LIGHT as Record<string, { color?: string }>, over(CODE_GROUND.light, PANE.light))).toEqual([])
  })
  it('dark mode: every token reaches 4.5:1 on its ground', () => {
    expect(weakTokens(CODE_THEME_DARK as Record<string, { color?: string }>, over(CODE_GROUND.dark, PANE.dark))).toEqual([])
  })
})
