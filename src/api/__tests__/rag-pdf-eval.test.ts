/**
 * GHSA-hq66-cqwq-w95j — "arbitrary JavaScript execution upon opening a
 * malicious PDF". 2.6.7 shipped pdfjs-dist 5.6.205, squarely inside the
 * affected range (>= 5.6.83, < 6.2.108).
 *
 * The sink is concrete: a PDF may carry a PostScript calculator function
 * (`/FunctionType 4`). Up to 6.2.108 pdf.js translated that program into
 * JavaScript source and passed it to `new Function` whenever `isEvalSupported`
 * kept its default `true`. 6.2.108 replaced the compiler with a WebAssembly
 * one and deleted the option.
 *
 * So the regression guard is not "is the version string new enough" — it is
 * "does opening a document that carries such a program still construct a
 * function out of it". This file measures that directly, by trapping the
 * global `Function` constructor while a crafted PDF goes through the parser.
 *
 * How far the sink was from this app, measured on 5.6.205 with the probe
 * below: text extraction (getDocument → getPage → getTextContent, which is
 * all rag.ts does) compiles nothing; `getOperatorList` on the same file
 * compiles the document's own program and constructs it —
 *   dest[destOffset + 0] = Math.max(0, (1 - (... src[srcOffset + 0] ... * 2)));
 * So the shipped RAG path did not run the payload, and the first feature to
 * render a page rather than read it would have. Both are asserted here, and a
 * downgrade under the pin fails the second one, not just `npm audit`.
 *
 * Run: npx vitest run src/api/__tests__/rag-pdf-eval.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractText } from '../rag'

/** Assemble a syntactically valid PDF with a real xref table. */
function buildPdf(objects: string[]): Uint8Array {
  let out = '%PDF-1.7\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

function stream(dict: string, body: string): string {
  return `<<${dict}/Length ${body.length}>>\nstream\n${body}\nendstream`
}

/** A plain text document, one object per page content. */
function textPdf(pages: string[]): Uint8Array {
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  pages.forEach((text, i) => {
    const contentObj = 5 + i * 2
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents ${contentObj} 0 R` +
        '/Resources<</Font<</F1 3 0 R>>>>>>',
    )
    objects.push(stream('', `BT /F1 12 Tf 20 200 Td (${text}) Tj ET`))
  })
  return buildPdf(objects)
}

/**
 * A document carrying the attack primitive: a `/FunctionType 4` PostScript
 * program, referenced by a shading the page actually paints, so the parser has
 * a reason to build the function rather than skip the object.
 */
function postScriptFunctionPdf(text: string): Uint8Array {
  const ps = '{ 2 mul 1 exch sub }'
  const content = `q /Sh0 sh Q BT /F1 12 Tf 20 200 Td (${text}) Tj ET`
  return buildPdf([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R' +
      '/Resources<</Font<</F1 5 0 R>>/Shading<</Sh0 7 0 R>>>>>>',
    stream('', content),
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    stream('/FunctionType 4/Domain[0 1]/Range[0 1]', ps),
    '<</ShadingType 2/ColorSpace/DeviceGray/Coords[0 0 300 0]/Function 6 0 R/Extend[true true]>>',
  ])
}

const asFile = (bytes: Uint8Array, name = 'probe.pdf') =>
  new File([bytes as unknown as BlobPart], name, { type: 'application/pdf' })

/**
 * Record every dynamic function construction. `new Function(...)` and
 * `Function(...)` both resolve `Function` off the global object from inside a
 * module, so a Proxy in that slot sees the compiled body pdf.js would hand it.
 * Behaviour is unchanged — every trap forwards to the real intrinsic.
 */
async function recordFunctionSources<T>(run: () => Promise<T>): Promise<{ result: T; sources: string[] }> {
  const real = globalThis.Function
  const sources: string[] = []
  const note = (args: ArrayLike<unknown>) => sources.push(String(args[args.length - 1] ?? ''))
  globalThis.Function = new Proxy(real, {
    construct(target, args, newTarget) {
      note(args)
      return Reflect.construct(target, args, newTarget)
    },
    apply(target, thisArg, args) {
      note(args)
      return Reflect.apply(target, thisArg, args)
    },
  })
  try {
    return { result: await run(), sources }
  } finally {
    globalThis.Function = real
  }
}

/** What rag.ts asked pdf.js to load its worker from. */
let requestedWorkerSrc = ''

beforeAll(async () => {
  // rag.ts loads pdf.js lazily. Import it once up front so module evaluation —
  // which legitimately builds functions — happens outside the trap below.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')

  // Vite rewrites `new URL(<bare specifier>, import.meta.url)` into an emitted
  // asset URL for the client build only. Vitest runs the node module graph, so
  // rag.ts's worker URL resolves next to src/api/ and points at nothing. Keep
  // what it asked for — that string is the privacy and compatibility
  // invariant — and hand pdf.js the copy that is actually on disk.
  const onDisk = pathToFileURL(
    resolve(__dirname, '../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
  ).href
  Object.defineProperty(pdfjsLib.GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => onDisk,
    set: (value: string) => { requestedWorkerSrc = value },
  })
})

describe('the PDF worker is bundled, not fetched', () => {
  it('points at the local legacy worker and never at a remote origin', async () => {
    await extractText(asFile(textPdf(['worker source probe'])))
    expect(requestedWorkerSrc).toMatch(/pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs$/)
    expect(requestedWorkerSrc).not.toMatch(/^https?:/)
  })
})

describe('PDF text extraction still works after the pdfjs 6 jump', () => {
  it('reads the text out of a real single-page PDF', async () => {
    const text = await extractText(asFile(textPdf(['Locally Uncensored RAG probe'])))
    expect(text).toContain('Locally Uncensored RAG probe')
  })

  it('keeps every page, separated by a blank line', async () => {
    const text = await extractText(asFile(textPdf(['first page marker', 'second page marker'])))
    expect(text).toContain('first page marker')
    expect(text).toContain('second page marker')
    expect(text.split('\n\n')).toHaveLength(2)
  })

  it('reports which file failed instead of a bare parser error', async () => {
    const notAPdf = asFile(new TextEncoder().encode('this is not a PDF at all'), 'broken.pdf')
    await expect(extractText(notAPdf)).rejects.toThrow(/broken\.pdf/)
  })
})

describe('GHSA-hq66-cqwq-w95j — a PDF cannot get its own code executed', () => {
  it('builds no function while extracting text from a PostScript-function PDF', async () => {
    const { result, sources } = await recordFunctionSources(() =>
      extractText(asFile(postScriptFunctionPdf('carrier document'))),
    )
    expect(result).toContain('carrier document')
    expect(sources).toEqual([])
  })

  it('builds no function even on the path that used to compile the program', async () => {
    // Text extraction never asks for an operator list, so this is the sink the
    // advisory describes reached deliberately: on 5.6.205 it hands the
    // document's own compiled program to `new Function`, here it must not.
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { sources } = await recordFunctionSources(async () => {
      const doc = await pdfjsLib.getDocument({
        data: postScriptFunctionPdf('carrier document'),
        enableXfa: false,
      }).promise
      const page = await doc.getPage(1)
      await page.getOperatorList()
    })
    expect(sources).toEqual([])
  })
})
