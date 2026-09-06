/**
 * M7 · RP-1: a long conversation opened every message as a full layout + paint
 * in one synchronous commit, and kept paying for the part of itself nobody was
 * looking at on every streaming frame.
 *
 * The fix is `content-visibility: auto` on the off-screen part of the list, NOT
 * a windowed slice. That choice is the thing this file guards: a slice would
 * unmount messages, and this list's entire scroll behaviour — the pin to
 * `scrollHeight`, the ResizeObserver re-pin (G33), the "sending jumps to the
 * bottom" resume key (G31/G33), Cmd+F over the transcript — is built on every
 * message being in the DOM. So the invariant is: still N nodes, just cheaper
 * ones.
 *
 * There is no render harness in this repo, so this is guarded at the source,
 * like tool-media-lifetime.test.ts and scroll-pins-bottom.test.ts.
 *
 * Run: npx vitest run src/components/chat/__tests__/long-transcripts-stay-cheap.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')
const list = read('../MessageList.tsx')
const hook = read('../../../hooks/useAutoScroll.ts')

describe('every message stays mounted — no window, no slice', () => {
  it('the whole filtered list is still mapped', () => {
    expect(list).toMatch(/visibleMessages\s*\n?\s*\.map\(\(message, index\) =>/)
  })

  it('nothing slices, windows or paginates the message array', () => {
    // A slice is what would break the pin, the resume key and Cmd+F.
    expect(list).not.toMatch(/visibleMessages\.slice\(/)
    expect(list).not.toMatch(/react-window|react-virtuoso|virtua/)
    expect(list).not.toMatch(/IntersectionObserver/)
  })

  it('the scroll contract is untouched', () => {
    // Same hook, same trigger, same resume key as before the change.
    expect(list).toContain('useAutoScroll(')
    expect(list).toContain('lastUserMessage?.id')
    expect(list).toContain('ref={contentRef}')
    expect(hook).toContain('new ResizeObserver(')
  })

  it('the Working anchor is still inside the observed wrapper (G33)', () => {
    const wrapper = list.indexOf('ref={contentRef}')
    const anchor = list.indexOf('<WorkingAnchor')
    expect(wrapper).toBeGreaterThan(-1)
    expect(anchor).toBeGreaterThan(wrapper)
  })

  it('the column cap is still there, and it is the derived one', () => {
    // W1 introduced a cap here; a virtualisation rewrite is exactly the kind
    // of change that quietly drops it. Since 05.09.2026 the cap is no longer
    // `--lu-measure`: David asked for a transcript that overhangs the prompt
    // box by about 20 percent on each side, and that number is derived from
    // the composer width in composer-width.ts instead of standing next to it.
    expect(list).toContain('TRANSCRIPT_MAX_PX')
    expect(list).toContain('mx-auto w-full')
    expect(list).not.toContain('max-w-[var(--lu-measure)]')
  })
})

describe('off-screen messages skip layout and paint', () => {
  it('carries content-visibility with a remembered intrinsic size', () => {
    expect(list).toContain("contentVisibility: 'auto'")
    // `auto` in contain-intrinsic-size = keep the real height once a bubble has
    // been rendered. Without it every scroll-back would re-guess.
    expect(list).toMatch(/containIntrinsicSize: 'auto /)
  })

  it('the hint sits on a wrapper, so MessageBubble keeps owning its root', () => {
    const wrapperIdx = list.indexOf('style={skipOffscreen && index < tailStart')
    const bubbleIdx = list.indexOf('<MessageBubble')
    expect(wrapperIdx).toBeGreaterThan(-1)
    expect(bubbleIdx).toBeGreaterThan(wrapperIdx)
  })

  it('the tail is never skippable', () => {
    // The bottom edge is what the auto-scroll pin measures against; an
    // estimated height there is the one place a wrong guess shows.
    expect(list).toContain('const ALWAYS_RENDERED_TAIL = 3')
    expect(list).toContain('const tailStart = visibleMessages.length - ALWAYS_RENDERED_TAIL')
    expect(list).toContain('index < tailStart')
  })
})

describe('the gate is decided per conversation, not per render', () => {
  it('short transcripts are completely unaffected', () => {
    expect(list).toContain('const CONTENT_VISIBILITY_THRESHOLD = 200')
    expect(list).toContain('visibleMessages.length >= CONTENT_VISIBILITY_THRESHOLD')
  })

  it('it is keyed on the conversation id, so it cannot flip mid-thread', () => {
    // A plain `length >= 200` re-evaluated every render would flip the
    // property on at message 200 of a LIVE thread: every off-screen bubble
    // above the fold collapses to its estimate in one frame, and a reader who
    // is scrolled up gets yanked. Latching on the id makes the answer either
    // "on from the first paint" or "off for this visit".
    expect(list).toContain('if (skipGate.id !== conversation.id)')
    expect(list).toContain('const skipOffscreen = skipGate.id === conversation.id && skipGate.on')
  })
})
