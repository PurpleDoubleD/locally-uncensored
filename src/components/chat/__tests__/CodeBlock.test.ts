/**
 * CodeBlock / HtmlPreviewModal Tests
 *
 * Tests the HTML-snippet detector used by the Preview chip. Every
 * positive case must be something we'd safely render in a sandboxed
 * iframe; every negative case must NOT trigger Preview (otherwise
 * we'd render random JS/CSS as HTML, which is confusing).
 *
 * Run: npx vitest run src/components/chat/__tests__/CodeBlock.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { refractor } from 'refractor/core'
import { isHtmlSnippet, highlightLanguageFor, PRISM_LANGUAGES } from '../CodeBlock'

const source = readFileSync(resolve(__dirname, '..', 'CodeBlock.tsx'), 'utf8')

describe('isHtmlSnippet', () => {
  describe('by language tag (fenced code block lang)', () => {
    it('detects html', () => {
      expect(isHtmlSnippet('<div>x</div>', 'html')).toBe(true)
    })
    it('detects htm', () => {
      expect(isHtmlSnippet('<p>hello</p>', 'htm')).toBe(true)
    })
    it('detects xhtml', () => {
      expect(isHtmlSnippet('<p/>', 'xhtml')).toBe(true)
    })
    it('detects svg', () => {
      expect(isHtmlSnippet('<svg></svg>', 'svg')).toBe(true)
    })
    it('is case-insensitive on language', () => {
      expect(isHtmlSnippet('<p>x</p>', 'HTML')).toBe(true)
      expect(isHtmlSnippet('<p>x</p>', 'Html')).toBe(true)
    })
    it('does NOT trigger on js/ts/python/css', () => {
      expect(isHtmlSnippet('const x = 1', 'js')).toBe(false)
      expect(isHtmlSnippet('const x: number = 1', 'ts')).toBe(false)
      expect(isHtmlSnippet('print(1)', 'python')).toBe(false)
      expect(isHtmlSnippet('body { color: red }', 'css')).toBe(false)
    })
  })

  describe('by content (no language tag)', () => {
    it('detects a full <!DOCTYPE html> document', () => {
      const code = '<!DOCTYPE html>\n<html><body>x</body></html>'
      expect(isHtmlSnippet(code)).toBe(true)
    })
    it('detects lowercased <!doctype html>', () => {
      const code = '<!doctype html>\n<html></html>'
      expect(isHtmlSnippet(code)).toBe(true)
    })
    it('detects a document starting with <html', () => {
      expect(isHtmlSnippet('<html><body>x</body></html>')).toBe(true)
    })
    it('detects <svg xmlns=...>', () => {
      const code = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'
      expect(isHtmlSnippet(code)).toBe(true)
    })
    it('tolerates leading whitespace before the marker', () => {
      const code = '   \n  <!DOCTYPE html>\n<html></html>'
      expect(isHtmlSnippet(code)).toBe(true)
      const code2 = '\n\t<html></html>'
      expect(isHtmlSnippet(code2)).toBe(true)
    })
  })

  describe('negative cases', () => {
    it('empty string → false', () => {
      expect(isHtmlSnippet('')).toBe(false)
      expect(isHtmlSnippet('   \n  ')).toBe(false)
    })
    it('plain text → false', () => {
      expect(isHtmlSnippet('Hello world')).toBe(false)
    })
    it('SVG without xmlns → false (too fragile to auto-detect)', () => {
      // Bare <svg> without xmlns is technically valid but most code-block
      // dumps are just fragments → don't auto-preview.
      expect(isHtmlSnippet('<svg><circle r="5"/></svg>')).toBe(false)
    })
    it('fragment <div> without lang tag → false', () => {
      // This is on purpose: `<div>foo</div>` by itself could be anything
      // (JSX, Vue template, Angular, …). We only preview when we're sure.
      expect(isHtmlSnippet('<div>foo</div>')).toBe(false)
    })
    it('JSON that starts with < → false', () => {
      expect(isHtmlSnippet('<not-html>')).toBe(false)
    })
    it('JavaScript using document.createElement → false', () => {
      expect(isHtmlSnippet('document.createElement("div")')).toBe(false)
    })
    it('CSS selector starting with html → false (content does not start with <html)', () => {
      expect(isHtmlSnippet('html { margin: 0 }')).toBe(false)
    })
  })
})

// ── M7 · the boot chunk is not 22 % syntax highlighting ─────────────────────

describe('only the grammars this app can actually show are bundled', () => {
  it('imports the PrismLight engine, never the full-Prism barrel', () => {
    // `react-syntax-highlighter`'s `Prism` export drags refractor's ~300
    // grammars into the boot chunk. This is the whole finding.
    expect(source).toContain("react-syntax-highlighter/dist/esm/prism-light")
    expect(source).not.toMatch(/from 'react-syntax-highlighter'/)
    expect(source).not.toMatch(/dist\/esm\/prism'/)
  })

  it('takes the one theme by its deep path, not the 46-theme barrel', () => {
    expect(source).toContain('styles/prism/one-dark')
    expect(source).not.toMatch(/styles\/prism'/)
  })

  it('registers what an LLM chat and the file preview actually emit', () => {
    // The audit's list, plus everything lib/file-preview.ts's LANGUAGE map can
    // hand us — a preview that quietly lost its colours would be a regression
    // dressed up as a saving.
    for (const lang of [
      'typescript', 'tsx', 'javascript', 'jsx', 'python', 'rust', 'bash',
      'json', 'yaml', 'sql', 'go', 'java', 'c', 'cpp', 'csharp', 'php',
      'ruby', 'markup', 'css', 'markdown', 'diff', 'toml', 'docker',
      'scss', 'less', 'ini', 'kotlin', 'swift', 'powershell', 'batch',
      'graphql', 'lua', 'r', 'dart', 'hcl', 'groovy', 'makefile',
    ]) {
      expect(highlightLanguageFor(lang), lang).toBe(lang)
    }
  })

  it('the declared language set is exactly what refractor really knows', () => {
    // Drift guard. PRISM_LANGUAGES is hand-written so production code does not
    // have to import refractor; importing CodeBlock above ran the
    // registrations, so refractor can be asked what actually happened.
    const real = refractor.listLanguages()
    // Nothing claimed that is not registered…
    expect([...PRISM_LANGUAGES].filter((n) => !real.includes(n))).toEqual([])
    // …and nothing registered that is not claimed, except refractor's built-in
    // plain-text family, which is left out on purpose so it normalises to the
    // highlighter's no-grammar branch.
    expect(real.filter((n) => !PRISM_LANGUAGES.has(n)).sort())
      .toEqual(['plain', 'plaintext', 'text', 'txt'])
  })

  it('stays far below the full-Prism grammar count', () => {
    // The full build answers to ~300 names. If this ever climbs back there,
    // somebody re-imported the barrel.
    expect(refractor.listLanguages().length).toBeLessThan(100)
  })
})

describe('an unknown fence renders as plain text instead of throwing', () => {
  it('a language nobody registered falls back to text', () => {
    // refractor throws "Unknown language" for anything unregistered. The
    // highlighter does catch that, but a chat that renders is not something to
    // leave to a library's catch block.
    expect(highlightLanguageFor('brainfuck')).toBe('text')
    expect(highlightLanguageFor('cobol')).toBe('text')
    expect(() => refractor.highlight('x', 'brainfuck')).toThrow()
  })

  it('no fence tag at all is text', () => {
    expect(highlightLanguageFor(undefined)).toBe('text')
    expect(highlightLanguageFor('')).toBe('text')
    expect(highlightLanguageFor('   ')).toBe('text')
  })

  it('every spelling of "no language" collapses to text', () => {
    expect(highlightLanguageFor('text')).toBe('text')
    expect(highlightLanguageFor('txt')).toBe('text')
    expect(highlightLanguageFor('plain')).toBe('text')
    expect(highlightLanguageFor('plaintext')).toBe('text')
  })

  it('the tags models really write map onto a registered grammar', () => {
    expect(highlightLanguageFor('sh')).toBe('sh')
    expect(highlightLanguageFor('shell')).toBe('shell')
    expect(highlightLanguageFor('zsh')).toBe('bash')
    expect(highlightLanguageFor('console')).toBe('bash')
    expect(highlightLanguageFor('py')).toBe('py')
    expect(highlightLanguageFor('ts')).toBe('ts')
    expect(highlightLanguageFor('rs')).toBe('rust')
    expect(highlightLanguageFor('golang')).toBe('go')
    expect(highlightLanguageFor('c++')).toBe('cpp')
    expect(highlightLanguageFor('c#')).toBe('csharp')
    expect(highlightLanguageFor('html')).toBe('html')
    expect(highlightLanguageFor('htm')).toBe('markup')
    expect(highlightLanguageFor('terraform')).toBe('hcl')
    expect(highlightLanguageFor('jsonc')).toBe('json')
  })

  it('is case- and whitespace-insensitive, the way fences are written', () => {
    expect(highlightLanguageFor('Python')).toBe('python')
    expect(highlightLanguageFor(' TSX ')).toBe('tsx')
    expect(highlightLanguageFor('Dockerfile')).toBe('dockerfile')
  })

  it('every registered name really highlights', () => {
    // The point of the fallback is that highlightLanguageFor never hands the
    // highlighter something refractor will reject.
    for (const name of PRISM_LANGUAGES) {
      if (name === 'text') continue
      expect(() => refractor.highlight('x = 1', name), name).not.toThrow()
    }
  })

  it('the header still shows the RAW tag, only the highlighter is normalised', () => {
    // `{language || 'code'}` in the header, highlightLanguageFor on the
    // highlighter — otherwise an unknown fence would silently be relabelled.
    expect(source).toContain("{language || 'code'}")
    expect(source).toContain('language={highlightLanguageFor(language)}')
  })
})
