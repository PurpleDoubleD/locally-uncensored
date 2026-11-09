import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { createElement } from 'react'
import { highlightPlain, rehypeQuoteHighlight } from '../chat-highlight'

const html = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [rehypeQuoteHighlight] }, md))

describe('rehypeQuoteHighlight', () => {
  it('wraps quoted speech, marks included', () => {
    expect(html('She said "hello there" and left.')).toBe('<p>She said <span class="lu-quote">&quot;hello there&quot;</span> and left.</p>')
  })
  it('carries a quote across emphasis', () => {
    const out = html('"Hello *there*, friend" she waves.')
    expect(out).toContain('<span class="lu-quote">&quot;Hello </span><em><span class="lu-quote">there</span></em><span class="lu-quote">, friend&quot;</span>')
  })
  it('curly, low-high and guillemet quotes', () => {
    expect(html('“Hi”')).toContain('<span class="lu-quote">“Hi”</span>')
    expect(html('„Hallo“')).toContain('<span class="lu-quote">„Hallo“</span>')
    expect(html('«Salut»')).toContain('<span class="lu-quote">«Salut»</span>')
    expect(html('»Na?«')).toContain('<span class="lu-quote">»Na?«</span>')
  })
  it('an odd straight quote colours nothing (5\'10")', () => {
    expect(html('He is 5\'10" tall and calm.')).not.toContain('lu-quote')
  })
  it('a new paragraph starts outside a quote', () => {
    const out = html('"open\n\nnext paragraph')
    expect(out).toContain('<p>next paragraph</p>')
  })
  it('leaves code and links alone', () => {
    expect(html('`a "b" c`')).not.toContain('lu-quote')
    expect(html('```\nx = "y"\n```')).not.toContain('lu-quote')
    expect(html('[a "b" c](https://example.com)')).not.toContain('lu-quote')
  })
})

describe('highlightPlain (user messages)', () => {
  it('splits quotes and actions', () => {
    expect(highlightPlain('*waves* "hi" ok', true, true)).toEqual([
      { kind: 'action', text: '*waves*' },
      { kind: 'text', text: ' ' },
      { kind: 'quote', text: '"hi"' },
      { kind: 'text', text: ' ok' },
    ])
  })
  it('does nothing when switched off', () => {
    expect(highlightPlain('*a* "b"', false, false)).toEqual([{ kind: 'text', text: '*a* "b"' }])
  })
  it('keeps the text whole', () => {
    const t = 'a "b" *c* „d“ e'
    expect(highlightPlain(t, true, true).map((p) => p.text).join('')).toBe(t)
  })
})
