// @vitest-environment jsdom
/**
 * W33 (Discord, 15.11.2026): a right click in LU opened the web view's own
 * menu (Print, Reload, Save page as ...). In a release build of the app it is
 * off. A text field gets Cut, Copy, Paste and Select all, selected text Copy,
 * everything else nothing. A dev build and the browser keep their own menu.
 * The Models tab: a LoRA row and an image or video model get a menu of the
 * actions they already have as buttons.
 *
 * Run: npx vitest run src/components/ui/__tests__/right-click-w33.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react'

const env = vi.hoisted(() => ({ tauri: true }))
vi.mock('../../../api/backend', async (o) => ({ ...(await o<typeof import('../../../api/backend')>()), isTauri: () => env.tauri }))

import { TextContextMenu } from '../TextContextMenu'
import { textMenuActions, readTarget, keepsNativeMenu } from '../../../lib/text-context-menu'
import { buildDownloadMenu, buildLoraRowMenu, buildModelCardMenu } from '../menu-actions'
import { RenameNoteDialog } from '../../models/RenameNoteDialog'
import { useLoraNotesStore } from '../../../stores/loraNotesStore'

function rightClick(el: Element) {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
  act(() => { el.dispatchEvent(e) })
  return e
}
const labels = () => screen.queryAllByRole('menuitem').map((b) => b.textContent)

beforeEach(() => { env.tauri = true; vi.stubEnv('DEV', false) })
afterEach(() => { cleanup(); vi.unstubAllEnvs(); document.body.innerHTML = '' })

describe('which actions, where', () => {
  it('a field with a selection: all four; empty field: Paste only; read only: Copy and Select all', () => {
    expect(textMenuActions({ editable: true, readOnly: false, hasSelection: true, hasText: true })).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    expect(textMenuActions({ editable: true, readOnly: false, hasSelection: false, hasText: false })).toEqual(['paste'])
    expect(textMenuActions({ editable: true, readOnly: true, hasSelection: true, hasText: true })).toEqual(['copy', 'selectAll'])
  })
  it('selected text on the page: Copy; nothing selected: no menu', () => {
    expect(textMenuActions({ editable: false, readOnly: true, hasSelection: true, hasText: false })).toEqual(['copy'])
    expect(textMenuActions({ editable: false, readOnly: true, hasSelection: false, hasText: false })).toEqual([])
  })
  it('a password field is no text field here', () => {
    const pw = document.createElement('input')
    pw.type = 'password'
    pw.value = 'secret'
    expect(readTarget(pw, '').editable).toBe(false)
  })
  it('a dev build keeps the web view menu (Inspect), a release build does not', () => {
    expect(keepsNativeMenu(true)).toBe(true)
    expect(keepsNativeMenu(false)).toBe(false)
  })
})

describe('the right click in the app', () => {
  it('in the prompt: the web view menu is off and LU shows Cut, Copy, Paste, Select all', () => {
    render(<><textarea data-testid="prompt" defaultValue="a lighthouse at dusk" /><TextContextMenu /></>)
    const ta = screen.getByTestId('prompt') as HTMLTextAreaElement
    ta.focus()
    ta.setSelectionRange(2, 12)
    const e = rightClick(ta)
    expect(e.defaultPrevented).toBe(true)
    expect(labels()).toEqual(['Cut', 'Copy', 'Paste', 'Select all'])
  })

  it('Copy puts the selected words on the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText, readText: vi.fn(async () => '') } })
    render(<><textarea data-testid="prompt" defaultValue="a lighthouse at dusk" /><TextContextMenu /></>)
    const ta = screen.getByTestId('prompt') as HTMLTextAreaElement
    ta.focus()
    ta.setSelectionRange(2, 12)
    rightClick(ta)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' })) })
    expect(writeText).toHaveBeenCalledWith('lighthouse')
  })

  it('on a plain spot: no menu at all, and not the web view one either', () => {
    render(<><div data-testid="plain">Models</div><TextContextMenu /></>)
    const e = rightClick(screen.getByTestId('plain'))
    expect(e.defaultPrevented).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a menu of LU\'s own (it already took the click) is left alone', () => {
    render(<><div data-testid="row" onContextMenu={(e) => e.preventDefault()}>row</div><TextContextMenu /></>)
    rightClick(screen.getByTestId('row'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('NEGATIVE CONTROL: a dev build and the browser keep their own menu', () => {
    vi.stubEnv('DEV', true)
    const dev = render(<><textarea data-testid="prompt" defaultValue="x" /><TextContextMenu /></>)
    expect(rightClick(screen.getByTestId('prompt')).defaultPrevented).toBe(false)
    dev.unmount()
    vi.stubEnv('DEV', false)
    env.tauri = false
    render(<><textarea data-testid="prompt2" defaultValue="x" /><TextContextMenu /></>)
    expect(rightClick(screen.getByTestId('prompt2')).defaultPrevented).toBe(false)
  })
})

describe('the Models tab', () => {
  it('a LoRA row: Show in folder, Rename, Details, Delete (with its confirmation)', () => {
    const remove = vi.fn()
    const items = buildLoraRowMenu({ reveal: vi.fn(), rename: vi.fn(), info: vi.fn(), remove })
    expect(items.map((i) => i.label)).toEqual(['Show in folder', 'Rename…', 'Details', 'Delete…'])
    expect(items.at(-1)?.destructive).toBe(true)
    items.at(-1)!.run()
    expect(remove).toHaveBeenCalledOnce()
  })
  it('an image or video model gets Show in folder and Rename; a chat model neither', () => {
    const base = { select: vi.fn(), info: vi.fn(), remove: vi.fn() }
    expect(buildModelCardMenu({ ...base, reveal: vi.fn(), rename: vi.fn() }, { isActive: false, canDelete: true }).map((i) => i.label)).toEqual(['Use this model', 'Details', 'Show in folder', 'Rename…', 'Delete model'])
    expect(buildModelCardMenu(base, { isActive: false, canDelete: true }).map((i) => i.label)).not.toContain('Show in folder')
  })
})

describe('W33 part 2: finished downloads and the name of a model', () => {
  it('a finished single download: Show in folder, Rename, Remove from list, Delete file', () => {
    const items = buildDownloadMenu({ reveal: vi.fn(), rename: vi.fn(), removeFromList: vi.fn(), deleteFile: vi.fn() })
    expect(items.map((i) => i.label)).toEqual(['Show in folder', 'Rename…', 'Remove from list', 'Delete file…'])
    // Taking the entry off the list is not a deletion: only the file entry is red.
    expect(items.filter((i) => i.destructive).map((i) => i.id)).toEqual(['delete-file'])
  })
  it('a finished bundle: Show in folder and Remove from list (its files are rows in the Models tab)', () => {
    expect(buildDownloadMenu({ reveal: vi.fn(), removeFromList: vi.fn() }).map((i) => i.label)).toEqual(['Show in folder', 'Remove from list'])
  })
  it('Rename gives a model file the name LU shows and keeps the file', async () => {
    useLoraNotesStore.setState({ notes: {} } as never)
    const onClose = vi.fn()
    render(<RenameNoteDialog name="ltx-2.5-distilled.safetensors" kind="model" onClose={onClose} />)
    expect(screen.getByText(/The file keeps its own name/)).toBeTruthy()
    fireEvent.change(screen.getByTestId('lora-edit-name'), { target: { value: 'LTX fast' } })
    await act(async () => { fireEvent.click(screen.getByTestId('lora-edit-save')) })
    expect(useLoraNotesStore.getState().notes['ltx-2.5-distilled.safetensors']?.label).toBe('LTX fast')
    expect(onClose).toHaveBeenCalled()
  })
})

