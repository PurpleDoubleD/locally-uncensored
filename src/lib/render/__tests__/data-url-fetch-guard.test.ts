/**
 * The webview's connect-src has no data: entry, so fetch() on a data: URL
 * fails in the packaged app ("Load failed") and works on every dev server.
 * Several places shipped that way. A bare fetch() of a URL held in a variable
 * does not show which kind arrives, so each such call is listed here with the
 * reason it can only see a server. A new one turns this test red: read media
 * through blobFromUrl (lib/render/data-url), or add the call with its reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { blobFromUrl } from '../data-url'

const SRC = join(__dirname, '..', '..', '..')

/** file -> argument text -> why no data: URL can arrive there. */
const SERVER_ONLY: Record<string, Record<string, string>> = {
  'lib/render/data-url.ts': { url: 'blobFromUrl itself, after the data: branch' },
  'api/backend.ts': { url: 'local backend and proxy routes, built from http(s) addresses' },
  'api/cloud/client.ts': { '`${CLOUD_BASE}${path}`': 'the cloud API' },
  'api/cloud/memory-sync.ts': { '`${CLOUD_BASE}${path}${suffix}`': 'the cloud API' },
  'api/comfyui.ts': { "comfyuiUrl('/upload/image')": 'the local image engine' },
  'api/discover.ts': { url: 'model catalogue pages' },
  // D4: a file of the local image engine goes through the proxy now; only a
  // web address the call named itself is fetched by the browser.
  'api/vram-handoff.ts': { url: 'an http(s) address the call named, never a file of the local image engine' },
  'lib/backend-detector.ts': { url: 'probes of local server ports' },
  'hooks/useCloudCreate.ts': { 'vj.result_url': 'signed result URL of a cloud job', 'src.result_url': 'signed result URL of a cloud job' },
  'components/create/experimental/PresetWorkshop.tsx': { 'fresh.result_url': 'signed result URL of a cloud job' },
  'components/chat/create/save-media.ts': { url: 'result URL of an order card, always a server file' },
  // The Character area: the picture of a cloud character, the base look or
  // the last preview as /api/loras signs it (https). A saved photo character
  // is read from its own blobs and never comes here.
  'components/create/experimental/hub/hubCharacters.ts': { 'c.image': 'signed https picture of a cloud character from /api/loras' },
  // The head crop of the swap photos: the face model the app serves itself
  // from public/face/, a fixed path, never a photo.
  'lib/create/face-detect.ts': { FACE_MODEL_PATH: 'the face model under /face/, a fixed path of the app' },
  // The phone. None of the seven reads media; each sends a request to a server address the app builds.
  'lib/lu-native.ts': { 'request.url': 'the browser stand-in of the native request to a paired desktop: method, headers and body to its http(s) address' },
  'mobile/remote/remoteClient.ts': { url: 'API routes of a paired desktop, built from its http(s) base address' },
  'mobile/remote/remoteClientStore.ts': { url: 'the plain way to a paired desktop, behind guardPlainFetch: API routes built from its http(s) base address' },
  'mobile/screens/remote/parts/session.ts': { url: 'the address lookup (remote/addressLookup.ts): ADDRESS_LOOKUP_ORIGIN, an https address, plus the desktop id' },
  'mobile/screens/settings/parts/ComputerSignIn.tsx': { url: 'the sign-in redeem route (remote/computerSignin.ts): SIGNIN_REDEEM_URL, an https address' },
  'mobile/policy/report.ts': { url: 'the report service: reportEndpoint() answers an https address or nothing' },
  'mobile/screens/models/parts/adapters/hf.ts': { url: 'the file tree of a Hugging Face repository, an https address written in that file' },
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') sourceFiles(path, out)
    } else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** A literal address that names its own scheme or path cannot be a data: URL. */
function isServerLiteral(arg: ts.Expression): boolean {
  if (ts.isStringLiteralLike(arg)) return !arg.text.startsWith('data:')
  if (!ts.isTemplateExpression(arg)) return false
  // `${held}` alone is a variable in disguise.
  return !arg.head.text.startsWith('data:') && (arg.head.text !== '' || arg.templateSpans.some((s) => s.literal.text !== ''))
}

function bareFetchCalls(): { file: string; arg: string; literal: boolean }[] {
  const calls: { file: string; arg: string; literal: boolean }[] = []
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, 'utf8')
    if (!text.includes('fetch(')) continue
    const file = relative(SRC, path).split(sep).join('/')
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const bare = (ts.isIdentifier(callee) && callee.text === 'fetch')
          || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch' && /^(window|globalThis|self)$/.test(callee.expression.getText(source)))
        const arg = node.arguments[0]
        if (bare && arg) calls.push({ file, arg: arg.getText(source).replace(/\s+/g, ' '), literal: isServerLiteral(arg) })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return calls
}

describe('no bare fetch() of a URL that may be a data: URL', () => {
  const calls = bareFetchCalls()

  it('finds the fetch calls of the tree at all', () => {
    expect(calls.length).toBeGreaterThan(20)
    expect(calls.some((c) => c.file === 'lib/render/data-url.ts' && c.arg === 'url')).toBe(true)
  })

  it('every fetch of a held URL is listed with the reason it only sees a server', () => {
    const unlisted = calls
      .filter((c) => !c.literal && !SERVER_ONLY[c.file]?.[c.arg])
      .map((c) => `${c.file}: fetch(${c.arg})`)
    expect(unlisted).toEqual([])
  })

  it('the list names no call that is gone', () => {
    const stale = Object.entries(SERVER_ONLY).flatMap(([file, args]) =>
      Object.keys(args).filter((arg) => !calls.some((c) => c.file === file && c.arg === arg)).map((arg) => `${file}: fetch(${arg})`))
    expect(stale).toEqual([])
  })
})

describe('blobFromUrl', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('decodes a data: URL without asking fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const blob = await blobFromUrl(`data:image/png;base64,${btoa('\x89PNG')}`)
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(4)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches any other URL and keeps the type the server named', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['abc'], { type: 'video/mp4' }))))
    const blob = await blobFromUrl('blob:http://localhost/3f1c')
    expect(blob.type).toBe('video/mp4')
    expect(blob.size).toBe(3)
  })

  it('a refused request is an error that names the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 403 })))
    await expect(blobFromUrl('https://files.example/render.png')).rejects.toThrow('media request failed (403)')
  })
})
