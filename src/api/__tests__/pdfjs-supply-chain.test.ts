/**
 * Supply-chain guard for the PDF parser.
 *
 * GHSA-hq66-cqwq-w95j affects pdfjs-dist >= 5.6.83 and < 6.2.108. 2.6.7
 * shipped 5.6.205. The behavioural proof that the sink is gone lives in
 * rag-pdf-eval.test.ts; this file guards the two ways it could quietly come
 * back — a lockfile that resolves into the window again, and a manifest range
 * that permits it.
 *
 * `npm audit` catches the same thing, but only when someone runs it. The suite
 * runs on every change.
 *
 * Run: npx vitest run src/api/__tests__/pdfjs-supply-chain.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractText } from '../rag'

/**
 * Stand in for pdf.js so the options rag.ts passes are observable. The mock is
 * keyed on the legacy specifier: if rag.ts ever goes back to the default build,
 * this does not apply and the assertions below fail — which is the point, the
 * legacy build is what older WKWebView/WebKitGTK can run at all.
 */
const captured = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (params: Record<string, unknown>) => {
    captured.push(params)
    return {
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'ok' }] }) }),
      }),
    }
  },
}))

const REPO = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8')
const json = (p: string) => JSON.parse(read(p))

/** First affected and first fixed version of GHSA-hq66-cqwq-w95j. */
const AFFECTED_FROM = '5.6.83'
const FIXED_IN = '6.2.108'

/** -1 / 0 / 1, on plain `x.y.z` releases — pdfjs never ships prereleases. */
function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

const inAdvisoryWindow = (v: string) =>
  compare(v, AFFECTED_FROM) >= 0 && compare(v, FIXED_IN) < 0

describe('pdfjs-dist stays out of GHSA-hq66-cqwq-w95j', () => {
  it('the version on disk is at or past the fix', () => {
    const installed = json('node_modules/pdfjs-dist/package.json').version as string
    expect(inAdvisoryWindow(installed)).toBe(false)
    expect(compare(installed, FIXED_IN)).toBeGreaterThanOrEqual(0)
  })

  it('the declared range cannot resolve back into the window', () => {
    const range = json('package.json').dependencies['pdfjs-dist'] as string
    // A caret range on 6.x has 6.x as its floor and 7.0.0 as its ceiling, so
    // no resolution of it reaches 5.x or an early 6.x. Any other range shape
    // (a `>=`, a `*`, a downgrade to `^5`) needs re-reading, not a nod.
    const caret = /^\^(\d+\.\d+\.\d+)$/.exec(range)
    expect(caret, `unexpected range shape for pdfjs-dist: ${range}`).not.toBeNull()
    const floor = caret![1]
    expect(floor.startsWith('6.')).toBe(true)
    expect(compare(floor, FIXED_IN)).toBeGreaterThanOrEqual(0)
  })

  it('no shipped bundle still carries the eval switch', () => {
    // `isEvalSupported` was both the option name and the internal gate in front
    // of `new Function(<compiled PostScript>)`. 6.2.108 removed the compiler,
    // so the identifier disappears from the build entirely — its presence in
    // any bundle means the vulnerable code path is back on disk.
    for (const bundle of [
      'node_modules/pdfjs-dist/build/pdf.mjs',
      'node_modules/pdfjs-dist/build/pdf.worker.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    ]) {
      expect(read(bundle), bundle).not.toContain('isEvalSupported')
    }
  })
})

describe('getDocument is called with the document-driven features pinned off', () => {
  it('passes enableXfa: false and the file bytes, nothing else', async () => {
    captured.length = 0
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'x.pdf')

    await expect(extractText(file)).resolves.toBe('ok')

    expect(captured).toHaveLength(1)
    // XFA carries its own scripting layer; it stays off no matter what pdf.js
    // decides to default to later.
    expect(captured[0].enableXfa).toBe(false)
    // No URL option: every one of them (cMapUrl, standardFontDataUrl, iccUrl,
    // wasmUrl, docBaseUrl) turns document content into a fetch, and a dropped
    // file is processed locally or not at all.
    for (const key of ['cMapUrl', 'standardFontDataUrl', 'iccUrl', 'wasmUrl', 'docBaseUrl', 'url']) {
      expect(captured[0]).not.toHaveProperty(key)
    }
  })
})
