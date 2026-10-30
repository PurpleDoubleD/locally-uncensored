// @vitest-environment jsdom
/**
 * B29 (3.0.9): a page the model writes can be previewed in the chat, like an
 * artifact, and the preview is walled off from the app.
 *
 *  - nothing runs when a chat is shown: no frame until the user clicks Preview;
 *  - the frame is sandboxed with scripts but never with same-origin;
 *  - in the app the page comes from the `luprev` scheme, whose response has
 *    its own closed policy (Rust tests in src-tauri/src/html_preview.rs), not
 *    as srcdoc, which inherits the app policy and ran no script at all;
 *  - the network is off and opens only after a second, explicit yes, for
 *    that one page;
 *  - the app's own policy is not loosened for it: it only allows the frame.
 *
 * Run: npx vitest run src/components/chat/__tests__/html-preview-b29.test.tsx
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const tauri = vi.hoisted(() => ({ on: false, calls: [] as Array<{ cmd: string; args?: Record<string, unknown> }> }))
vi.mock('../../../api/backend', async (orig) => ({
  ...(await orig<typeof import('../../../api/backend')>()),
  isTauri: () => tauri.on,
  backendCall: async (cmd: string, args?: Record<string, unknown>) => {
    tauri.calls.push({ cmd, args })
    return 'ab'.repeat(16)
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
}))

import { CodeBlock } from '../CodeBlock'
import { putPreviewDocument } from '../../../lib/html-preview-source'

const PAGE = '<!doctype html><html><body><h1 id="t">x</h1><script>document.getElementById("t").textContent="ran"</script></body></html>'
const root = resolve(__dirname, '../../../..')

beforeEach(() => { tauri.on = false; tauri.calls = [] })
afterEach(cleanup)

describe('B29: preview only on the user\'s click', () => {
  it('an html block offers Preview and shows no frame until it is clicked', () => {
    const { container } = render(<CodeBlock code={PAGE} language="html" />)
    expect(screen.getByTestId('code-preview-button').textContent).toBe('Preview')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('code that is not a page gets no Preview', () => {
    render(<CodeBlock code={'const x = 1'} language="js" />)
    expect(screen.queryByTestId('code-preview-button')).toBeNull()
  })

  it('the click mounts a sandboxed frame: scripts yes, same origin never', async () => {
    const { container } = render(<CodeBlock code={PAGE} language="html" />)
    fireEvent.click(screen.getByTestId('code-preview-button'))
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    // Back to code takes the frame away again.
    fireEvent.click(screen.getByTestId('code-preview-button'))
    expect(container.querySelector('iframe')).toBeNull()
  })
})

describe('B29: in the app the page comes from the luprev scheme', () => {
  it('the frame loads luprev://, not srcdoc, and the page went up with the network off', async () => {
    tauri.on = true
    const { container } = render(<CodeBlock code={PAGE} language="html" />)
    fireEvent.click(screen.getByTestId('code-preview-button'))
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe(`luprev://localhost/${'ab'.repeat(16)}`)
    expect(frame.hasAttribute('srcdoc')).toBe(false)
    expect(tauri.calls).toEqual([{ cmd: 'html_preview_put', args: { doc: PAGE, allowNetwork: false } }])
  })

  it('the network needs a second yes and goes up as a new page', async () => {
    tauri.on = true
    render(<CodeBlock code={PAGE} language="html" />)
    fireEvent.click(screen.getByTestId('code-preview-button'))
    await waitFor(() => expect(tauri.calls).toHaveLength(1))
    fireEvent.click(screen.getByTestId('html-preview-network'))
    // One click only asks.
    const ask = screen.getByTestId('html-preview-network-ask')
    // Mac run: as an uppercase label inside the monospace code block the
    // question did not wrap and ran under its own buttons.
    expect(ask.className).not.toMatch(/\bt-label\b/)
    expect(ask.className).toMatch(/whitespace-normal/)
    expect(screen.getByTestId('html-preview-panel').className).toMatch(/\bfont-sans\b/)
    expect(screen.getByTestId('html-preview-panel').dataset.network).toBe('off')
    fireEvent.click(screen.getByText('Keep offline'))
    expect(screen.queryByTestId('html-preview-network-ask')).toBeNull()
    expect(tauri.calls).toHaveLength(1)
    fireEvent.click(screen.getByTestId('html-preview-network'))
    fireEvent.click(screen.getByText('Allow for this page'))
    await waitFor(() => expect(tauri.calls).toHaveLength(2))
    expect(tauri.calls[1].args).toEqual({ doc: PAGE, allowNetwork: true })
    expect(screen.getByTestId('html-preview-panel').dataset.network).toBe('on')
  })

  it('in the browser build the page goes in as srcdoc with the closed policy first', async () => {
    const src = await putPreviewDocument(PAGE, true)
    expect(src.kind).toBe('doc')
    const doc = src.kind === 'doc' ? src.doc : ''
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<script>'))
    expect(doc).toMatch(/default-src 'none'/)
    expect(doc).not.toMatch(/connect-src/)
  })
})

describe('B29: the app policy is not loosened for the preview', () => {
  const conf = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const csp: string = conf.app.security.csp
  const directive = (name: string) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '')

  it('frames may come from luprev, and from nowhere new besides', () => {
    expect(directive('frame-src').split(/\s+/).slice(1).sort()).toEqual(["'self'", 'http://luprev.localhost', 'luprev:'].sort())
  })

  it('the app itself still runs no inline script', () => {
    expect(directive('script-src')).not.toMatch(/unsafe-inline|luprev/)
  })

  it('the scheme is registered and its command is in the handler list', () => {
    const lib = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8')
    expect(lib).toMatch(/register_uri_scheme_protocol\(html_preview::SCHEME/)
    expect(lib).toMatch(/html_preview::html_preview_put,/)
  })
})
