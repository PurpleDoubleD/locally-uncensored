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
 * Every state is rendered for real here, including the two the review of
 * 2026-09-02 turned up:
 *
 *   B1  no lane at all must NOT disable the button. The panel behind it holds
 *       the install card, and that card is the only way to get a lane, so a
 *       disabled button is a locked door to the repair shop.
 *   B2  the tooltip may not promise "stays on this computer" when indexing
 *       would ship whole documents to a LAN Ollama.
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
  DOCS_TITLE_CLOUD_LOCAL,
  DOCS_TITLE_NO_EMBEDDINGS,
} from '../../../lib/docs-availability'
import type { EmbedLaneInfo } from '../../../api/embed-availability'

const BUNDLED: EmbedLaneInfo = { lane: 'bundled', endpoint: null }
const OLLAMA_LOCAL: EmbedLaneInfo = { lane: 'ollama-local', endpoint: null }
const OLLAMA_REMOTE: EmbedLaneInfo = { lane: 'ollama-remote', endpoint: 'http://192.168.0.54:11434' }
const NONE: EmbedLaneInfo = { lane: 'none', endpoint: null }

afterEach(() => cleanup())

function show(appMode: 'local' | 'cloud', info: EmbedLaneInfo | null, onToggle = () => {}) {
  return render(
    createElement(DocsButton, {
      availability: docsAvailability(appMode, info),
      open: false,
      ragEnabled: false,
      docCount: 0,
      onToggle,
    }),
  )
}

const docs = () => screen.queryByTestId('docs-toggle') as HTMLButtonElement | null

describe('the rule that decides the Docs button', () => {
  it('local mode is untouched: there, pressable, plain tooltip, no lane read', () => {
    expect(docsAvailability('local', null)).toEqual({
      visible: true,
      enabled: true,
      needsSetup: false,
      lane: null,
      title: DOCS_TITLE_PLAIN,
    })
  })

  it('local mode does not care what the lane probe says, in any direction', () => {
    // Negative control for the probe: local mode never measured it before the
    // fix and must not start depending on it now.
    for (const info of [BUNDLED, OLLAMA_REMOTE, NONE]) {
      expect(docsAvailability('local', info).needsSetup).toBe(false)
      expect(docsAvailability('local', info).title).toBe(DOCS_TITLE_PLAIN)
    }
  })

  it('cloud on the bundled lane: there, pressable, and the tooltip says files stay put', () => {
    const a = docsAvailability('cloud', BUNDLED)
    expect(a).toMatchObject({ visible: true, enabled: true, needsSetup: false, lane: 'bundled' })
    expect(a.title).toBe(DOCS_TITLE_CLOUD_LOCAL)
  })

  it('cloud on a loopback Ollama says the same thing, because it is equally true', () => {
    expect(docsAvailability('cloud', OLLAMA_LOCAL).title).toBe(DOCS_TITLE_CLOUD_LOCAL)
  })

  it('cloud on a REMOTE Ollama names the host instead of promising the opposite (B2)', () => {
    const a = docsAvailability('cloud', OLLAMA_REMOTE)
    expect(a.title).toContain('http://192.168.0.54:11434')
    expect(a.title).toContain('whole documents are sent there')
    // Negative control on the wording: the comfortable lie must be absent.
    expect(a.title).not.toContain('stay on this computer')
    expect(a.title).not.toContain('Files stay on this computer')
  })

  it('cloud with no lane: needs setup, and STILL pressable (B1)', () => {
    const a = docsAvailability('cloud', NONE)
    expect(a).toEqual({
      visible: true,
      enabled: true,
      needsSetup: true,
      lane: 'none',
      title: DOCS_TITLE_NO_EMBEDDINGS,
    })
    expect(a.title).toContain('Documents need the local embeddings engine')
    expect(a.title).toContain('Click to install it.')
  })

  it('cloud while the probe is still running is plain and pressable, not a flicker', () => {
    expect(docsAvailability('cloud', null)).toMatchObject({
      needsSetup: false,
      enabled: true,
      title: DOCS_TITLE_PLAIN,
    })
  })

  it('never hides the button and never disables it, in any state', () => {
    for (const mode of ['local', 'cloud'] as const) {
      for (const info of [BUNDLED, OLLAMA_LOCAL, OLLAMA_REMOTE, NONE, null]) {
        const a = docsAvailability(mode, info)
        expect(a.visible).toBe(true)
        expect(a.enabled).toBe(true)
      }
    }
  })
})

describe('the button as it actually renders', () => {
  it('cloud with a lane: present, enabled, clicking opens the panel', () => {
    const onToggle = vi.fn()
    show('cloud', BUNDLED, onToggle)
    const b = docs()!
    expect(b.disabled).toBe(false)
    expect(b.getAttribute('data-needs-setup')).toBe('false')
    expect(b.getAttribute('title')).toBe(DOCS_TITLE_CLOUD_LOCAL)
    fireEvent.click(b)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('cloud without a lane: damped, but the click still reaches the install card (B1)', () => {
    const onToggle = vi.fn()
    show('cloud', NONE, onToggle)
    const b = docs()!
    expect(b.disabled).toBe(false)
    expect(b.getAttribute('data-needs-setup')).toBe('true')
    expect(b.getAttribute('title')).toContain('Documents need the local embeddings engine')
    expect(b.className).toContain('opacity-60')
    fireEvent.click(b)
    // This is the whole point of B1: the dead end is gone.
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('a working lane is not damped, so the damping means something', () => {
    // Negative control on the styling.
    show('cloud', BUNDLED)
    expect(docs()!.className).not.toContain('opacity-60')
  })

  it('local: present and enabled, exactly as before the fix', () => {
    const onToggle = vi.fn()
    show('local', null, onToggle)
    const b = docs()!
    expect(b.disabled).toBe(false)
    expect(b.textContent).toContain('Docs')
    expect(b.getAttribute('data-needs-setup')).toBe('false')
    fireEvent.click(b)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('the document count still rides along', () => {
    render(
      createElement(DocsButton, {
        availability: docsAvailability('cloud', NONE),
        open: false,
        ragEnabled: false,
        docCount: 3,
        onToggle: () => {},
      }),
    )
    expect(docs()!.textContent).toContain('3')
  })
})
