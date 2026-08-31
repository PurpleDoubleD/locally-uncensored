/**
 * Two rules that used to be `useEffect`s writing state back into React, now
 * pure functions — tested as BEHAVIOUR rather than as source text.
 *
 * Both were flagged by React 19's `set-state-in-effect`, and in both cases the
 * rule itself never needed an effect: it is a function of things the render
 * already has. The source-pinning tests that guarded them
 * (cloud-teaser-click-identity.test.ts, tool-media-lifetime.test.ts) had to be
 * re-pointed at the new seam, so the guarantees live here where the spelling
 * cannot break them.
 *
 * Every case is what the effect version did.
 *
 * Run: npx vitest run src/lib/__tests__/derived-ui-state.test.ts
 */
import { describe, it, expect } from 'vitest'
import { selectedBackendId } from '../backend-detector'
import { displayableMedia } from '../local-media-url'

const OLLAMA = { id: 'ollama' }
const LMSTUDIO = { id: 'lmstudio' }

describe('the backend dialog picks a row the moment the list arrives', () => {
  it('marks nothing while the detection has not run', () => {
    // AppShell mounts the dialog with an EMPTY array. The old bug was a
    // useState default frozen on `[]`, so "Use selected" found nothing.
    expect(selectedBackendId(null, [])).toBe('')
  })

  it('falls to the first row the second the list is filled in', () => {
    expect(selectedBackendId(null, [OLLAMA, LMSTUDIO])).toBe('ollama')
  })

  it('does not overrule a user who picked before the list settled', () => {
    expect(selectedBackendId('lmstudio', [OLLAMA, LMSTUDIO])).toBe('lmstudio')
  })

  it('drops a pick the list no longer holds', () => {
    expect(selectedBackendId('vllm', [OLLAMA, LMSTUDIO])).toBe('ollama')
  })

  it('drops a pick when the list empties again', () => {
    expect(selectedBackendId('ollama', [])).toBe('')
  })
})

describe('a tool result says what it can actually show', () => {
  it('hands back anything that is not one of our files', () => {
    const view = 'http://localhost:8188/view?filename=x.png'
    expect(displayableMedia(view, null, null)).toEqual({ url: view, missing: false })
  })

  it('treats a stored blob: URL as already dead', () => {
    // Nothing mints them any more, so one in a persisted result came from an
    // older window and its blob died with it. Saying so beats a broken frame.
    expect(displayableMedia('blob:abc', null, null)).toEqual({ url: null, missing: true })
  })

  it('shows nothing, and does not cry missing, while the read is in flight', () => {
    expect(displayableMedia('file:///a.png', '/a.png', null)).toEqual({ url: null, missing: false })
  })

  it('shows the fresh blob once the read lands', () => {
    const read = { path: '/a.png', url: 'blob:fresh', missing: false }
    expect(displayableMedia('file:///a.png', '/a.png', read)).toEqual({ url: 'blob:fresh', missing: false })
  })

  it('says the file is gone when the read failed', () => {
    const read = { path: '/a.png', url: null, missing: true }
    expect(displayableMedia('file:///a.png', '/a.png', read)).toEqual({ url: null, missing: true })
  })

  it('never lets one file’s outcome speak for another', () => {
    // The read is async: a result can land after the block has moved on. An
    // untagged outcome would paint the previous file's blob — or its "gone" —
    // over the new one.
    const stale = { path: '/old.png', url: 'blob:old', missing: false }
    expect(displayableMedia('file:///new.png', '/new.png', stale)).toEqual({ url: null, missing: false })
    const staleMissing = { path: '/old.png', url: null, missing: true }
    expect(displayableMedia('file:///new.png', '/new.png', staleMissing)).toEqual({ url: null, missing: false })
  })
})
