/**
 * B3 (2.6.3): a blob: URL must never be written into something that is stored.
 *
 * The Mac MLX tool results used to embed one straight into the tool-result
 * string, which the chat store persists. A blob URL is scoped to the document
 * that created it, so that single decision produced two defects at once:
 *
 *   1. nothing ever revoked it, so every image generated in a session stayed
 *      in memory for the life of the window
 *   2. after a restart the persisted URL pointed at nothing, so the picture
 *      silently disappeared from the conversation
 *
 * The bytes were already on disk the whole time (the Rust side writes the PNG
 * before returning), which is what makes the path form both correct and free.
 *
 * Run: npx vitest run src/lib/__tests__/local-media-url.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
}))

const { pathToFileUrl, fileUrlToPath, guessMimeFromName, readLocalFileAsBlobUrl } =
  await import('../local-media-url')

beforeEach(() => backendCall.mockReset())

describe('path round-trip', () => {
  it('survives a plain path', () => {
    const p = '/Users/purple/Library/Application Support/lu/mlx/mlx-1.png'
    expect(fileUrlToPath(pathToFileUrl(p))).toBe(p)
  })

  it('survives spaces, which every Mac data directory has', () => {
    // "Application Support" is the reason this cannot be raw string concat.
    const p = '/Users/a b/Application Support/mlx-2.png'
    const url = pathToFileUrl(p)
    expect(url).not.toMatch(/ /)
    expect(fileUrlToPath(url)).toBe(p)
  })

  it('survives a hash and other characters a filename can carry', () => {
    const p = '/tmp/render #3 (final).png'
    expect(fileUrlToPath(pathToFileUrl(p))).toBe(p)
  })

  it('is a real URL, so a result-line regex can find it', () => {
    const url = pathToFileUrl('/tmp/a.png')
    expect(url.startsWith('file://')).toBe(true)
    // The same shape the tool result puts on its own line.
    const line = `Image generated: a.png (prompt: "x")\n${url}`
    const m = line.match(/(file:\/\/[^\s)\]]+)/)
    expect(m?.[1]).toBe(url)
  })

  it('returns null for anything that is not one of ours', () => {
    expect(fileUrlToPath('blob:http://localhost/abc')).toBeNull()
    expect(fileUrlToPath('http://localhost:8188/view?filename=a.png')).toBeNull()
    expect(fileUrlToPath('data:image/png;base64,AAA')).toBeNull()
  })
})

describe('guessMimeFromName', () => {
  it('knows the formats both generation lanes produce', () => {
    expect(guessMimeFromName('a.png')).toBe('image/png')
    expect(guessMimeFromName('a.mp4')).toBe('video/mp4')
    expect(guessMimeFromName('a.webm')).toBe('video/webm')
    expect(guessMimeFromName('A.WEBP')).toBe('image/webp')
    expect(guessMimeFromName('a.jpeg')).toBe('image/jpeg')
  })

  it('falls back to png rather than guessing nothing', () => {
    expect(guessMimeFromName('noextension')).toBe('image/png')
  })
})

describe('readLocalFileAsBlobUrl', () => {
  it('reads through the guarded Rust command and types the blob by extension', async () => {
    backendCall.mockResolvedValue(btoa('fake-bytes'))
    const created: { type: string }[] = []
    const origCreate = URL.createObjectURL
    // defineProperty rather than an assignment through a cast: `value` is
    // untyped, so the stub goes in without claiming to be the real overload.
    const setCreate = (fn: unknown) =>
      Object.defineProperty(URL, 'createObjectURL', { value: fn, configurable: true, writable: true })
    setCreate((b: Blob) => { created.push({ type: b.type }); return 'blob:made' })
    try {
      const url = await readLocalFileAsBlobUrl('/tmp/clip.mp4')
      expect(backendCall).toHaveBeenCalledWith('read_media_file', { path: '/tmp/clip.mp4' })
      expect(url).toBe('blob:made')
      expect(created[0].type).toBe('video/mp4')
    } finally {
      setCreate(origCreate)
    }
  })

  // A read that fails is left to propagate rather than swallowed, so the
  // caller can render the "no longer on disk" state. That the caller actually
  // does is asserted in ToolCallBlock's own guard, where the catch lives; a
  // unit assertion here only ever proved that a mock rejects.
})
