import { describe, it, expect } from 'vitest'
import { CSS_SCOPE, sanitizeChatCss, scopeSelector } from '../chat-css-sanitize'

const clean = (s: string) => sanitizeChatCss(s).css

describe('chat CSS: what is allowed comes out scoped', () => {
  it('scopes every selector to the transcript', () => {
    expect(clean('.lu-quote { color: red }')).toBe(`${CSS_SCOPE} .lu-quote { color: red }`)
    expect(clean('p, li { font-weight: 600 }')).toBe(`${CSS_SCOPE} p, ${CSS_SCOPE} li { font-weight: 600 }`)
  })
  it(':scope names the transcript itself', () => {
    expect(clean(':scope[data-mode="dark"] em { color: #fff }')).toBe(`${CSS_SCOPE}[data-mode="dark"] em { color: #fff }`)
  })
  it('keeps colours, gradients, calc and transforms', () => {
    const out = clean('.x { background: linear-gradient(90deg, rgb(1 2 3), color-mix(in srgb, red, blue)); width: calc(100% - 2px); transform: rotate(1deg) }')
    expect(out).toContain('linear-gradient(90deg, rgb(1 2 3), color-mix(in srgb, red, blue))')
    expect(out).toContain('calc(100% - 2px)')
    expect(out).toContain('rotate(1deg)')
  })
  it('keeps @media and renames keyframes so they cannot replace the app\'s', () => {
    const out = clean('@media (max-width: 600px) { p { margin: 0 } } @keyframes pulse { from { opacity: 0 } to { opacity: 1 } } .x { animation: pulse 1s }')
    expect(out).toContain(`@media (max-width: 600px) { ${CSS_SCOPE} p { margin: 0 } }`)
    expect(out).toContain('@keyframes lu-pulse')
    expect(out).toContain('animation: lu-pulse 1s')
  })
  it('keeps !important', () => {
    expect(clean('p { color: red !important }')).toBe(`${CSS_SCOPE} p { color: red !important }`)
  })
})

describe('chat CSS: no network, no escape from the scope', () => {
  it.each([
    ['url', '.x { background: url(https://evil.example/t.png) }'],
    ['url quoted', '.x { background-image: url("//evil.example/t") }'],
    ['image-set', '.x { background: image-set("a.png" 1x) }'],
    ['src', '.x { background: src("a.png") }'],
    ['attr', '.x::after { content: attr(data-x) }'],
    ['expression', '.x { width: expression(alert(1)) }'],
    ['javascript', '.x { background: javascript:alert(1) }'],
    ['unknown function', '.x { color: evil(1) }'],
    ['fixed', '.x { position: fixed; inset: 0 }'],
    ['sticky', '.x { position: sticky }'],
    ['binding', '.x { -moz-binding: none }'],
  ])('drops %s', (_name, css) => {
    const out = clean(css)
    expect(out).not.toMatch(/url|image-set|src\(|attr|expression|javascript|evil|fixed|sticky|binding/i)
  })
  it.each([
    '@import url(https://evil.example/x.css);',
    '@import "x.css";',
    '@font-face { font-family: X; src: url(https://evil.example/f.woff) }',
    '@namespace svg url(http://www.w3.org/2000/svg);',
    '@layer base { p { color: red } }',
  ])('drops the at-rule %s', (css) => {
    expect(clean(css)).toBe('')
  })
  it('refuses any backslash (escapes could spell url)', () => {
    const r = sanitizeChatCss('.x { background: u\\72l(https://evil.example) }')
    expect(r.css).toBe('')
    expect(r.dropped[0]).toMatch(/Backslash/)
  })
  it('refuses "<" (no way out of the style element)', () => {
    expect(clean('</style><script>alert(1)</script>')).toBe('')
  })
  it('a comment cannot hide anything', () => {
    expect(clean('.x { background: u/**/rl(https://evil.example) }')).not.toMatch(/evil/)
  })
  it.each(['~ div', '+ p', '> p', 'html p', 'body', ':root', ':host', '& p', '.a:nth-child(2):matches(p)', ':scope ~ div p'])(
    'refuses the selector %s',
    (sel) => expect(scopeSelector(sel)).toBeNull(),
  )
  it('a rule with one bad selector is dropped whole', () => {
    expect(clean('p, body { color: red }')).toBe('')
  })
  it('a string holding braces does not end the rule early', () => {
    const out = clean('.x::before { content: "}{ url(" } .y { color: red }')
    expect(out).not.toMatch(/url/)
    expect(out).toContain(`${CSS_SCOPE} .y { color: red }`)
  })
  it('reports what it dropped', () => {
    const r = sanitizeChatCss('.x { color: red; background: url(x) }')
    expect(r.css).toBe(`${CSS_SCOPE} .x { color: red }`)
    expect(r.dropped.join(' ')).toMatch(/background/)
  })
})

describe(':scope with a step', () => {
  it.each([':scope + p', ':scope[data-mode="dark"] ~ p', ':scope:hover~p'])('refuses %s', (sel) => expect(scopeSelector(sel)).toBeNull())
  it.each([':scope > p', ':scope[data-mode="dark"] p', ':scope .a ~ .b'])('allows %s', (sel) => expect(scopeSelector(sel)).not.toBeNull())
})
