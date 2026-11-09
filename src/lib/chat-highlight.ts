/**
 * "Quoted speech" in its own colour (3.1.0, C58), the way roleplay readers
 * know it from SillyTavern, done on the rendered tree instead of the raw text.
 *
 * Why on the tree: a quote often runs across markdown, `"Hello *there*"`.
 * A regex over the source either breaks the emphasis or misses the quote. The
 * plugin walks each block (paragraph, list item, heading, cell) once, carries
 * "inside a quote" across its inline children, and wraps the text runs that
 * are inside in `<span class="lu-quote">`. Code, links and math are left as
 * they are. A block with an odd number of straight double quotes (5'10",
 * a stray mark) gets no straight-quote highlighting at all, so one stray
 * mark cannot colour the rest of a paragraph; curly and guillemet pairs are
 * unambiguous and still count.
 *
 * Actions (`*waves*`) need nothing here: markdown already makes them <em>,
 * and the stylesheet colours em inside the transcript (index.css, .lu-look).
 * User messages are plain text, not markdown; `highlightPlain` below gives
 * them the same two colours without rendering their text as markdown.
 */
import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

const SKIP = new Set(['code', 'pre', 'a', 'button', 'svg', 'math', 'kbd', 'script', 'style'])
const BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'dd', 'dt', 'figcaption'])

const OPEN: Record<string, string> = { '“': '”', '„': '“', '«': '»', '»': '«', '"': '"' }

interface QuoteState { close: string | null; straight: boolean }

/** KaTeX output and anything else marked as math stays untouched. */
function skipped(el: Element): boolean {
  if (SKIP.has(el.tagName)) return true
  const cls = el.properties?.className
  const list = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(/\s+/) : []
  return list.some((c) => c.startsWith('katex') || c === 'math' || c.startsWith('math-'))
}

function textOf(node: Element | Root): string {
  let s = ''
  for (const c of node.children) {
    if (c.type === 'text') s += c.value
    else if (c.type === 'element' && !skipped(c)) s += textOf(c)
  }
  return s
}

function quoteSpan(value: string): Element {
  return { type: 'element', tagName: 'span', properties: { className: ['lu-quote'] }, children: [{ type: 'text', value }] }
}

/** Split one text node by the quote state, advancing the state. */
function splitText(node: Text, state: QuoteState): ElementContent[] {
  const out: ElementContent[] = []
  const v = node.value
  let buf = ''
  let inQuote = state.close !== null
  const flush = () => {
    if (!buf) return
    out.push(inQuote ? quoteSpan(buf) : { type: 'text', value: buf })
    buf = ''
  }
  for (const ch of v) {
    if (state.close === null) {
      const close = OPEN[ch]
      if (close !== undefined && (ch !== '"' || state.straight)) {
        flush()
        state.close = close
        inQuote = true
        buf = ch
        continue
      }
      buf += ch
    } else {
      buf += ch
      if (ch === state.close) {
        flush()
        state.close = null
        inQuote = false
      }
    }
  }
  flush()
  return out
}

function walkInline(children: ElementContent[], state: QuoteState): ElementContent[] {
  const out: ElementContent[] = []
  for (const c of children) {
    if (c.type === 'text') out.push(...splitText(c, state))
    else if (c.type === 'element' && !skipped(c) && !BLOCKS.has(c.tagName)) {
      out.push({ ...c, children: walkInline(c.children, state) })
    } else if (c.type === 'element' && !skipped(c) && BLOCKS.has(c.tagName)) {
      out.push(walkBlock(c))
    } else out.push(c)
  }
  return out
}

function walkBlock(el: Element): Element {
  const straightCount = (textOf(el).match(/"/g) ?? []).length
  const state: QuoteState = { close: null, straight: straightCount % 2 === 0 }
  return { ...el, children: walkInline(el.children, state) }
}

function walk<T extends Root | Element>(node: T): T {
  const children = node.children.map((c: RootContent | ElementContent) => {
    if (c.type !== 'element' || skipped(c)) return c
    if (BLOCKS.has(c.tagName)) return walkBlock(c)
    return walk(c)
  })
  return { ...node, children } as T
}

/** rehype plugin: wraps quoted speech in `span.lu-quote`. */
export function rehypeQuoteHighlight() {
  return (tree: Root) => walk(tree)
}

export type PlainPiece = { kind: 'text' | 'quote' | 'action'; text: string }

/**
 * The same two colours for plain text (a user's message): quotes as above,
 * and `*action*` on one line. The asterisks stay visible, since the message
 * is shown exactly as typed.
 */
export function highlightPlain(text: string, quotes: boolean, actions: boolean): PlainPiece[] {
  if (!quotes && !actions) return [{ kind: 'text', text }]
  const parts: string[] = []
  if (quotes) {
    const straight = ((text.match(/"/g) ?? []).length % 2) === 0
    parts.push('“[^”\\n]*”', '„[^“”\\n]*[“”]', '«[^»\\n]*»')
    if (straight) parts.push('"[^"\\n]*"')
  }
  if (actions) parts.push('\\*[^*\\n]+\\*')
  const re = new RegExp(parts.join('|'), 'g')
  const out: PlainPiece[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    out.push({ kind: m[0].startsWith('*') ? 'action' : 'quote', text: m[0] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
