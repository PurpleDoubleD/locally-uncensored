// T1 Nacht-Durchtest 3.0.9 (Jäger A, A5): eine URL, ein Hash oder Base64 ohne
// Leerzeichen lief aus der Blase und wurde am Fensterrand abgeschnitten
// (computed overflow-wrap: normal, scrollWidth 26 379 px bei 638 px Blase).
// Beide Wege, die Text in eine Blase schreiben, tragen deshalb wrap-anywhere.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8')

describe('a word without spaces in a chat bubble', () => {
  it('wraps in the answer (markdown root)', () => {
    expect(src('MarkdownRenderer.tsx')).toMatch(/className="markdown-content[^"]*\bwrap-anywhere\b/)
  })
  it('wraps in the user bubble', () => {
    expect(src('MessageBubble.tsx')).toMatch(/whitespace-pre-wrap wrap-anywhere">\{message\.displayContent \|\| message\.content\}/)
  })
})
