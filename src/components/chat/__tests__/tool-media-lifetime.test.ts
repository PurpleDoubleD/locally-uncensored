/**
 * B3 (2.6.3): what goes into a persisted tool result, and how long a blob lives.
 *
 * The defect had two halves and one cause. `executeImageGenerateMlx` put a
 * `blob:` URL into the tool-result string; the chat store persists that string;
 * a blob URL only means anything inside the document that made it. So nothing
 * ever revoked the blob (every generated image stayed in memory for the life of
 * the window) AND the stored URL was dead after a restart (the picture silently
 * vanished from the conversation). An LRU cap would have addressed neither.
 *
 * The bytes were on disk the whole time. The Create gallery already relies on
 * that (restoreFromDisk in create/experimental/galleryUrl.ts); the chat path now
 * does too.
 *
 * There is no render harness in this repo, so the component half is guarded at
 * the source, like DownloadBadge-autoclose.test.ts.
 *
 * Run: npx vitest run src/components/chat/__tests__/tool-media-lifetime.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

const tools = read('api', 'mcp', 'builtin-tools.ts')
const block = read('components', 'chat', 'ToolCallBlock.tsx')
const media = read('lib', 'local-media-url.ts')

describe('nothing writes a session-scoped URL into a stored result', () => {
  it('the helper that minted them is gone', () => {
    expect(tools).not.toMatch(/pngDataUrlToObjectUrl/)
  })

  it('the tool executors create no object URLs at all', () => {
    // The one place this could regress is a well-meaning "just show it now"
    // fix. There is no legitimate createObjectURL in this file any more.
    expect(tools).not.toMatch(/createObjectURL/)
  })

  it('both MLX lanes put the file path in the result instead', () => {
    expect(tools).toMatch(/Image generated: \$\{filename\}.*\$\{pathToFileUrl\(localPath\)\}/s)
    expect(tools).toMatch(/Video generated: \$\{filename\}.*\$\{pathToFileUrl\(job\.output\)\}/s)
  })

  it('the video lane no longer pulls the whole clip into memory to show it', () => {
    // readVideoAsBlobUrl read the entire file just to build a URL that was
    // then stored. The Create tab still uses it, on its own recovery path.
    expect(tools).not.toMatch(/readVideoAsBlobUrl\(/)
  })
})

describe('the viewer owns the blob, so it can end', () => {
  it('revokes on unmount', () => {
    expect(block).toMatch(/URL\.revokeObjectURL\(made\)/)
  })

  it('revokes a read that landed after the block went away', () => {
    // Without this, unmounting mid-read leaks exactly the blob nobody will see.
    expect(block).toMatch(/if \(!live\) \{ URL\.revokeObjectURL\(blobUrl\); return \}/)
  })

  it('reads the file through the shared helper rather than a second copy', () => {
    expect(block).toMatch(/readLocalFileAsBlobUrl/)
    expect(block).toMatch(/from '\.\.\/\.\.\/lib\/local-media-url'/)
  })

  it('says so when the file is gone instead of showing a broken frame', () => {
    // The failed read is recorded AGAINST ITS PATH, so a stale "gone" can never
    // paint over the next file's frame. What the element then shows is
    // displayableMedia's job — see src/lib/__tests__/derived-ui-state.test.ts,
    // which exercises pending / landed / failed / stale-tag directly. (Was a
    // bare `setMissing(true)` before the React 19 set-state-in-effect fix.)
    expect(block).toMatch(/setRead\(\{ path, url: null, missing: true \}\)/)
    expect(block).toMatch(/return displayableMedia\(url, path, read\)/)
    expect(block).toMatch(/no longer on disk/)
  })

  it('treats a blob: URL in a stored result as already dead', () => {
    // Nothing creates one any more, so any that appears was recorded by an
    // older build and its blob died with that window. The rule moved into
    // lib/local-media-url.ts with the rest of the display derivation; it is
    // asserted end-to-end in derived-ui-state.test.ts.
    expect(media).toMatch(/if \(rawUrl && rawUrl\.startsWith\('blob:'\)\) return \{ url: null, missing: true \}/)
  })

  it('picks the element kind from the raw result, not the resolved URL', () => {
    // Reading off disk is async; keying the video/image decision on the
    // resolved URL would render the wrong element for the first frame.
    expect(block).toMatch(/const isVideoResult = !!rawLocalUrl/)
  })
})
