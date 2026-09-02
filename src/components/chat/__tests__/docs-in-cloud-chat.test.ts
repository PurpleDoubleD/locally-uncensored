/**
 * @vitest-environment jsdom
 *
 * A9: "There's no document tab in cloud chat to add documents and audio clips"
 * (aldrich_ironhart, Discord #general, 2026-09-01).
 *
 * He was right. ChatView hid the Docs button on `appMode !== 'cloud'`, on the
 * belief that Document Chat needs a local backend. It needs a local EMBEDDING
 * backend, which is a different sidecar (127.0.0.1:8128), one the app resumes
 * in Cloud mode too, and the retrieved passages reach the model through the
 * system prompt, which every provider takes.
 *
 * So the rule is not about the mode any more, it is about the embedding lane.
 * Three states, each rendered for real, plus the negative controls that keep
 * the fix from turning into "always enabled, never honest":
 *
 *   local                      -> visible, pressable, unchanged
 *   cloud + embeddings present -> visible, pressable, tooltip says where the
 *                                 files stay
 *   cloud + no embeddings      -> visible, NOT pressable, tooltip names the
 *                                 missing part instead of hiding the feature
 *
 * Run: npx vitest run src/components/chat/__tests__/docs-in-cloud-chat.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { DocsButton } from '../DocsButton'
import {
  docsAvailability,
  DOCS_TITLE_PLAIN,
  DOCS_TITLE_CLOUD,
  DOCS_TITLE_NO_EMBEDDINGS,
} from '../../../lib/docs-availability'

afterEach(() => cleanup())

function show(appMode: 'local' | 'cloud', embedReady: boolean | null, onToggle = () => {}) {
  return render(
    createElement(DocsButton, {
      availability: docsAvailability(appMode, embedReady),
      open: false,
      ragEnabled: false,
      docCount: 0,
      onToggle,
    }),
  )
}

const docs = () => screen.queryByTestId('docs-toggle') as HTMLButtonElement | null

describe('the rule that decides the Docs button', () => {
  it('local mode is untouched: there, pressable, plain tooltip', () => {
    expect(docsAvailability('local', null)).toEqual({
      visible: true,
      enabled: true,
      title: DOCS_TITLE_PLAIN,
    })
  })

  it('local mode does not care what the embedding probe says, in either direction', () => {
    // Negative control for the probe: local mode never measured it before the
    // fix and must not start depending on it now.
    expect(docsAvailability('local', false).enabled).toBe(true)
    expect(docsAvailability('local', true).enabled).toBe(true)
  })

  it('cloud with an embedding lane: there and pressable, which is the whole bug report', () => {
    const a = docsAvailability('cloud', true)
    expect(a.visible).toBe(true)
    expect(a.enabled).toBe(true)
    expect(a.title).toBe(DOCS_TITLE_CLOUD)
  })

  it('cloud without one: still there, but off, and it says why', () => {
    expect(docsAvailability('cloud', false)).toEqual({
      visible: true,
      enabled: false,
      title: DOCS_TITLE_NO_EMBEDDINGS,
    })
  })

  it('cloud while the probe is still running keeps it pressable, not dead-then-alive', () => {
    // A button that starts disabled and wakes up a moment later reads as
    // broken. Unknown is not "no".
    expect(docsAvailability('cloud', null).enabled).toBe(true)
  })

  it('never hides the button again, in any state', () => {
    for (const mode of ['local', 'cloud'] as const) {
      for (const ready of [true, false, null]) {
        expect(docsAvailability(mode, ready).visible).toBe(true)
      }
    }
  })
})

describe('the button as it actually renders', () => {
  it('cloud with embeddings: present, enabled, and clicking opens the panel', () => {
    const onToggle = vi.fn()
    show('cloud', true, onToggle)
    const b = docs()
    expect(b).not.toBeNull()
    expect(b!.disabled).toBe(false)
    expect(b!.getAttribute('title')).toBe(DOCS_TITLE_CLOUD)
    expect(b!.getAttribute('title')).toContain('stay here')
    fireEvent.click(b!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('cloud without embeddings: present, disabled, tooltip names the engine, click does nothing', () => {
    const onToggle = vi.fn()
    show('cloud', false, onToggle)
    const b = docs()
    expect(b).not.toBeNull()
    expect(b!.disabled).toBe(true)
    expect(b!.getAttribute('title')).toBe('Documents need the local embeddings engine')
    fireEvent.click(b!)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('local: present and enabled, exactly as before the fix', () => {
    const onToggle = vi.fn()
    show('local', null, onToggle)
    const b = docs()
    expect(b).not.toBeNull()
    expect(b!.disabled).toBe(false)
    expect(b!.textContent).toContain('Docs')
    fireEvent.click(b!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('the document count still rides along, and a disabled button never looks active', () => {
    cleanup()
    render(
      createElement(DocsButton, {
        availability: docsAvailability('cloud', false),
        open: true,
        ragEnabled: true,
        docCount: 3,
        onToggle: () => {},
      }),
    )
    const b = docs()!
    expect(b.textContent).toContain('3')
    // Negative control on the styling: open + ragEnabled would normally paint
    // the button green. A button that cannot be pressed must not claim to be on.
    expect(b.className).not.toContain('bg-green-500/15')
    expect(b.className).toContain('cursor-not-allowed')
  })
})
