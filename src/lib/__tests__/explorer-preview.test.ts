/**
 * The Explorer preview (2.6.6 C3): which preview a file gets, and the sandbox
 * the HTML one runs in.
 *
 * SECURITY claim under test: clicking a file in the repository tree renders it,
 * it does not EXECUTE it. The explorer frame starts with an empty sandbox
 * attribute (every restriction on) and only gains allow-scripts after a
 * per-file opt-in; allow-same-origin appears nowhere. The model-snippet modal
 * keeps its old behaviour, and the test below pins both sides so a later
 * refactor cannot quietly swap them.
 *
 * Run: npx vitest run src/lib/__tests__/explorer-preview.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  PREVIEW_TEXT_CAP,
  capPreviewText,
  extensionOf,
  imageMimeFor,
  previewKindFor,
  previewLanguageFor,
  sandboxAttr,
} from '../file-preview'
import { buildDocument } from '../html-preview'
import { isWithinRoot } from '../explorer-tree'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
/** Source with comments removed: a rule explained in prose must not be able to
 *  satisfy a test that asks whether the rule is implemented. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the preview switch reads the file type', () => {
  it('sends images to the image branch', () => {
    for (const n of ['logo.png', 'a.JPG', 'b.jpeg', 'c.gif', 'd.webp', 'e.svg', 'f.avif', 'g.ico']) {
      expect(previewKindFor(n)).toBe('image')
    }
  })

  it('sends html to the sandboxed frame', () => {
    for (const n of ['index.html', 'page.HTM', 'old.xhtml']) {
      expect(previewKindFor(n)).toBe('html')
    }
  })

  it('sends code and prose to the highlighter', () => {
    for (const n of ['main.ts', 'App.tsx', 'lib.rs', 'README.md', 'Makefile', 'notes', '.gitignore']) {
      expect(previewKindFor(n)).toBe('text')
    }
  })

  it('refuses to render a binary as text', () => {
    for (const n of ['model.gguf', 'app.exe', 'lib.dylib', 'clip.mp4', 'archive.zip', 'doc.pdf']) {
      expect(previewKindFor(n)).toBe('binary')
    }
  })

  it('counter-test: html-ish names that are not html stay text', () => {
    expect(previewKindFor('template.html.tera')).toBe('text')
    expect(previewKindFor('index.html.bak')).toBe('text')
    expect(previewKindFor('render.tsx')).toBe('text')
  })

  it('reads the extension off the NAME, on both platforms', () => {
    expect(extensionOf('a.PNG')).toBe('png')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('.gitignore')).toBe('gitignore')
  })

  it('picks the blob content type from the same extension', () => {
    expect(imageMimeFor('a.png')).toBe('image/png')
    expect(imageMimeFor('a.JPG')).toBe('image/jpeg')
    expect(imageMimeFor('a.svg')).toBe('image/svg+xml')
    expect(imageMimeFor('a.unknown')).toBe('application/octet-stream')
  })

  it('names a language for the highlighter, or falls back to text', () => {
    expect(previewLanguageFor('main.rs')).toBe('rust')
    expect(previewLanguageFor('App.tsx')).toBe('tsx')
    expect(previewLanguageFor('Dockerfile')).toBe('docker')
    expect(previewLanguageFor('weird.qqq')).toBe('text')
  })

  it('caps a minified bundle instead of feeding it to the highlighter', () => {
    const small = capPreviewText('hello')
    expect(small).toEqual({ text: 'hello', truncated: false })
    const huge = capPreviewText('x'.repeat(PREVIEW_TEXT_CAP + 10))
    expect(huge.truncated).toBe(true)
    expect(huge.text).toHaveLength(PREVIEW_TEXT_CAP)
  })
})

describe('scripts are off in the Explorer preview', () => {
  it('the default sandbox is the fully restricted one', () => {
    expect(sandboxAttr(false)).toBe('')
  })

  it('the opt-in adds scripts and nothing else', () => {
    expect(sandboxAttr(true)).toBe('allow-scripts')
  })

  it('allow-same-origin is never granted, on either setting', () => {
    expect(sandboxAttr(false)).not.toContain('allow-same-origin')
    expect(sandboxAttr(true)).not.toContain('allow-same-origin')
    expect(code('../../components/chat/HtmlPreviewFrame.tsx')).not.toMatch(/allow-same-origin/)
  })

  it('the panel preview starts with scripts off and resets per file', () => {
    const src = code('../../components/chat/FilePreview.tsx')
    // The opt-in state starts false ...
    expect(src).toMatch(/const \[allowScripts, setAllowScripts\] = useState\(false\)/)
    expect(src).toMatch(/allowScripts=\{allowScripts\}/)
    // ... and the panel mounts a FRESH preview per path, so an opt-in on one
    // file cannot carry over to the next one.
    expect(code('../../components/chat/ExplorerPanel.tsx')).toMatch(
      /<FilePreview key=\{selected\.path\}/,
    )
    // The frame never hard-codes the permissive sandbox: no bare `allowScripts`
    // prop (which is JSX for true) and no literal sandbox attribute.
    const frame = /<HtmlPreviewFrame[\s\S]*?\/>/.exec(src)?.[0] ?? ''
    expect(frame).toMatch(/allowScripts=\{allowScripts\}/)
    expect(frame).not.toMatch(/allowScripts\s*(\/>|[a-zA-Z]+=)/)
    expect(src).not.toMatch(/sandbox="allow-scripts"/)
  })

  it('counter-test: the model-snippet modal keeps running scripts', () => {
    // Since B29 (3.0.9) the modal shows the chat's preview panel, which
    // owns the frame.
    expect(code('../../components/chat/HtmlPreviewModal.tsx')).toMatch(/<HtmlPreviewPanel/)
    const src = code('../../components/chat/HtmlPreviewPanel.tsx')
    expect(src).toMatch(/<HtmlPreviewFrame[^>]*allowScripts/)
  })

  it('the panel has no dead open-in-browser button', () => {
    // openExternal refuses a data: URL, so the button was a no-op in the panel.
    const src = code('../../components/chat/FilePreview.tsx')
    expect(src).not.toMatch(/openExternal/)
    expect(src).not.toMatch(/data:text\/html/)
  })
})

describe('a preview outside the workspace root is refused', () => {
  it('the guard says no before anything is read', () => {
    expect(isWithinRoot('/repo', '/etc/passwd')).toBe(false)
    expect(isWithinRoot('/repo', '/repo/../etc/passwd')).toBe(false)
    expect(isWithinRoot('/repo', '/repo/src/main.ts')).toBe(true)
  })

  it('FilePreview asks the guard first and reads only inside the root', () => {
    const src = code('../../components/chat/FilePreview.tsx')
    const guard = src.indexOf('isWithinRoot(root, node.path)')
    const firstCall = src.indexOf('backendCall')
    expect(guard).toBeGreaterThan(-1)
    // The import of backendCall sits above, so compare against the first CALL.
    const firstInvocation = src.indexOf("backendCall<", guard)
    expect(firstCall).toBeGreaterThan(-1)
    expect(firstInvocation).toBeGreaterThan(guard)
    // Every read carries the picked root, so the Rust jail is the same one the
    // agent runs under.
    expect(src.match(/workingDirectory: root/g) ?? []).toHaveLength(2)
  })
})

describe('the shared document shell', () => {
  it('passes a full document through untouched', () => {
    const doc = '<!doctype html><html><body>hi</body></html>'
    expect(buildDocument(doc)).toBe(doc)
  })

  it('wraps a bare snippet so it has a charset', () => {
    const out = buildDocument('<p>hi</p>')
    expect(out).toMatch(/^<!doctype html>/)
    expect(out).toContain('<p>hi</p>')
    expect(out).toContain('charset="utf-8"')
  })

  it('centres a bare svg', () => {
    const out = buildDocument('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>')
    expect(out).toContain('SVG Preview')
  })
})
