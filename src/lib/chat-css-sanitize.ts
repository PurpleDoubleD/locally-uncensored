/**
 * Custom CSS for the chat (3.1.0, C58), made safe.
 *
 * SillyTavern pastes custom CSS into the page as typed. A shared theme can
 * therefore load fonts and pictures from any server (a tracking beacon on
 * every chat open), cover the whole window with a fake dialog, or restyle the
 * settings. LU never passes the user's text through. It is parsed here into
 * rules and declarations, every part is checked against an allow list, and a
 * NEW stylesheet is written from what passed:
 *
 *  - Every selector is put under the transcript's scope (`.lu-chat-custom`),
 *    so nothing outside the chat can be matched. A selector may not start
 *    with a combinator (`~ div` would reach siblings of the scope) and may not
 *    name :root, html, body, :host or the nesting `&`.
 *  - No url(), image-set(), src(), element(), attr(), expression(), no
 *    @import, @font-face, @namespace, @charset, @layer, @property, @container
 *    or anything else that is not @media, @supports or @keyframes. Function
 *    calls in values must be on the allow list (colours, gradients, calc,
 *    transforms, filters): a function the list does not know drops the
 *    declaration, it is never guessed at.
 *  - No backslash anywhere (CSS escapes could spell `url(` without the
 *    letters), no `<` (no way out of a <style> element), no `javascript:`.
 *  - `position: fixed` and `sticky` are refused: the scope does not contain
 *    them, and a fixed box could cover the rest of the app.
 *  - At most MAX_CSS characters in, MAX_RULES rules out.
 *
 * The result lists what was dropped, so the editor can tell the user why a
 * line has no effect instead of failing in silence.
 */

import { MAX_CSS } from './chat-look'

export const CSS_SCOPE = '.lu-chat-custom'
const MAX_RULES = 400

/** Value functions that cannot reach the network or the page. */
const ALLOWED_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
  'var', 'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'translate', 'translatex', 'translatey', 'translate3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d',
  'scale', 'scalex', 'scaley', 'scale3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'cubic-bezier', 'steps', 'linear',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  'minmax', 'repeat', 'fit-content', 'counter', 'counters',
])

/** Pseudo-class functions a selector may use. */
const SELECTOR_FUNCTIONS = new Set(['is', 'where', 'not', 'has', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'lang', 'dir'])

const BANNED_SELECTOR = /(^|[^a-z0-9_-])(html|body)(?![a-z0-9_-])|:root|:host|&/i

const ALLOWED_AT = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes'])

export interface SanitizedCss {
  css: string
  dropped: string[]
}

/** Strip /* comments *\/ (a comment can hide nothing then). */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
}

interface Block { prelude: string; body: string }

/**
 * Split text into top-level `prelude { body }` blocks, honouring strings and
 * nested braces. Text outside any block (a stray declaration, `@import x;`)
 * is reported as dropped.
 */
function blocks(text: string, dropped: string[]): Block[] {
  const out: Block[] = []
  let i = 0
  let start = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipString(text, i); continue }
    if (ch === ';') {
      const stray = text.slice(start, i).trim()
      if (stray) dropped.push(short(stray))
      start = i + 1
      i++
      continue
    }
    if (ch === '{') {
      const prelude = text.slice(start, i).trim()
      let depth = 1
      let j = i + 1
      while (j < text.length && depth > 0) {
        const c = text[j]
        if (c === '"' || c === "'") { j = skipString(text, j); continue }
        if (c === '{') depth++
        else if (c === '}') depth--
        j++
      }
      out.push({ prelude, body: text.slice(i + 1, depth === 0 ? j - 1 : j) })
      i = j
      start = j
      continue
    }
    if (ch === '}') {
      // An unmatched closing brace: skip it.
      start = i + 1
    }
    i++
  }
  const rest = text.slice(start).trim()
  if (rest) dropped.push(short(rest))
  return out
}

function skipString(s: string, at: number): number {
  const q = s[at]
  let j = at + 1
  while (j < s.length && s[j] !== q && s[j] !== '\n') j++
  return j + 1
}

/** Split on `sep` at depth 0, outside strings, parentheses and brackets. */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let last = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'") { i = skipString(s, i) - 1; continue }
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
    else if (c === sep && depth === 0) { parts.push(s.slice(last, i)); last = i + 1 }
  }
  parts.push(s.slice(last))
  return parts
}

function short(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? one.slice(0, 57) + '...' : one
}

/** A selector put under the scope, or null when it may not be used. */
export function scopeSelector(sel: string): string | null {
  const s = sel.trim()
  if (!s) return null
  if (/^[>+~]/.test(s)) return null
  if (BANNED_SELECTOR.test(s)) return null
  if (/[{};@]/.test(s)) return null
  for (const m of s.matchAll(/:{1,2}([a-z-]+)\(/gi)) {
    if (!SELECTOR_FUNCTIONS.has(m[1].toLowerCase())) return null
  }
  // `:scope` names the transcript itself.
  if (/^:scope\b/i.test(s)) {
    const rest = s.slice(':scope'.length)
    // The scope's own compound (`[data-mode="dark"]`, `:hover`) may follow,
    // then only a descendant or child step: `~` and `+` would match the
    // scope's siblings, which are outside the transcript.
    if (/[~+]/.test(rest.slice(compoundEnd(rest)).trimStart().charAt(0))) return null
    if (/:scope\b/i.test(rest)) return null
    return CSS_SCOPE + rest
  }
  if (/:scope\b/i.test(s)) return null
  return `${CSS_SCOPE} ${s}`
}

/** Where the first compound selector of `s` ends: the first space or
 *  combinator outside brackets, parentheses and strings. */
function compoundEnd(s: string): number {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'") { i = skipString(s, i) - 1; continue }
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /[\s>+~]/.test(c)) return i
  }
  return s.length
}

/** One declaration, cleaned, or null when it may not be used. */
export function cleanDeclaration(decl: string): string | null {
  const colon = decl.indexOf(':')
  if (colon < 0) return null
  const prop = decl.slice(0, colon).trim().toLowerCase()
  let value = decl.slice(colon + 1).trim()
  if (!/^(--[a-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(prop)) return null
  if (!value) return null
  let important = ''
  const imp = /!\s*important\s*$/i.exec(value)
  if (imp) { important = ' !important'; value = value.slice(0, imp.index).trim() }
  if (value.includes('!')) return null
  if (/[{};<@]/.test(value)) return null
  if (/javascript:|expression|behavior|binding/i.test(value)) return null
  if (prop === 'behavior' || prop.endsWith('-binding')) return null
  if (prop === 'position' && /\b(fixed|sticky)\b/i.test(value)) return null
  for (const m of value.matchAll(/([a-z-]+)\s*\(/gi)) {
    if (!ALLOWED_FUNCTIONS.has(m[1].toLowerCase())) return null
  }
  // A bare `(` without a name before it (e.g. `( url`) is not a function we know.
  const named = [...value.matchAll(/[a-z-]+\s*\(/gi)].length
  const opens = (value.match(/\(/g) ?? []).length
  if (opens !== named) return null
  return `${prop}: ${value}${important}`
}

function declarations(body: string, dropped: string[]): string[] {
  const out: string[] = []
  for (const raw of splitTop(body, ';')) {
    const d = raw.trim()
    if (!d) continue
    const ok = cleanDeclaration(d)
    if (ok) out.push(ok)
    else dropped.push(short(d))
  }
  return out
}

function styleRules(text: string, dropped: string[], count: { n: number }, depth: number): string[] {
  const out: string[] = []
  for (const b of blocks(text, dropped)) {
    if (count.n >= MAX_RULES) { dropped.push('(too many rules)'); break }
    if (b.prelude.startsWith('@')) {
      const name = /^@([a-z-]+)/i.exec(b.prelude)?.[1].toLowerCase() ?? ''
      if (!ALLOWED_AT.has(name) || depth > 1) { dropped.push(short(b.prelude)); continue }
      const cond = b.prelude.slice(name.length + 1).trim()
      if (/[{};<\\]|url\s*\(/i.test(cond)) { dropped.push(short(b.prelude)); continue }
      if (name.endsWith('keyframes')) {
        if (!/^[a-z_][a-z0-9_-]*$/i.test(cond)) { dropped.push(short(b.prelude)); continue }
        const frames: string[] = []
        for (const f of blocks(b.body, dropped)) {
          if (!/^(from|to|\d{1,3}(\.\d+)?%)(\s*,\s*(from|to|\d{1,3}(\.\d+)?%))*$/i.test(f.prelude)) { dropped.push(short(f.prelude)); continue }
          frames.push(`${f.prelude} { ${declarations(f.body, dropped).join('; ')} }`)
        }
        count.n++
        out.push(`@${name} lu-${cond} { ${frames.join(' ')} }`)
        continue
      }
      const inner = styleRules(b.body, dropped, count, depth + 1)
      if (inner.length) out.push(`@${name} ${cond} { ${inner.join(' ')} }`)
      continue
    }
    const selectors = splitTop(b.prelude, ',').map(scopeSelector)
    if (selectors.some((s) => s === null)) { dropped.push(short(b.prelude)); continue }
    const decls = declarations(b.body, dropped)
    if (!decls.length) continue
    count.n++
    out.push(`${selectors.join(', ')} { ${decls.join('; ')} }`)
  }
  return out
}

/**
 * The user's CSS, rebuilt from what passed. Animation names get the prefix
 * `lu-` both where they are declared and where they are used, so a user
 * keyframe never replaces one of the app's.
 */
export function sanitizeChatCss(input: string): SanitizedCss {
  const dropped: string[] = []
  if (typeof input !== 'string' || !input.trim()) return { css: '', dropped }
  let text = input.slice(0, MAX_CSS)
  if (input.length > MAX_CSS) dropped.push(`(cut at ${MAX_CSS} characters)`)
  text = stripComments(text)
  // Refused outright: escapes, markup, and anything that names a URL loader.
  if (/\\/.test(text)) return { css: '', dropped: ['Backslashes are not allowed in chat CSS.'] }
  if (/</.test(text)) return { css: '', dropped: ['"<" is not allowed in chat CSS.'] }
  const rules = styleRules(text, dropped, { n: 0 }, 0)
  const css = rules.join('\n').replace(
    /(animation(?:-name)?\s*:\s*)([a-z_][a-z0-9_-]*)/gi,
    (m, head: string, name: string) => (/^(none|initial|inherit|unset|revert|lu-.*)$/i.test(name) ? m : `${head}lu-${name}`),
  )
  return { css, dropped }
}
