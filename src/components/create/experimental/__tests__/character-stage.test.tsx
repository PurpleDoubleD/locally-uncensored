// @vitest-environment jsdom
/**
 * The Character area as David set it on 16.11.2026:
 *   - no character yet: three steps and one button, no headline, no picture;
 *   - "New character" starts with the drop field alone and shows only the
 *     photos the user put there;
 *   - the stage shows only real things: a character without photos gets a
 *     line, never a stand-in picture;
 *   - Rename works on the desktop;
 *   - the area is one column of the prompt window's width, and it has no
 *     bar of its own: the window under it is the Composer of every tab;
 *   - nothing of the area moves by itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const io = vi.hoisted(() => ({ folder: { status: 'ok', path: '/Users/me/Library/Application Support/lu-labs/loras' } as { status: string; path?: string } | null, opened: 0, imported: [] as string[] }))
vi.mock('../../../../api/backend', async (orig) => ({ ...(await orig<typeof import('../../../../api/backend')>()), isTauri: () => true }))
vi.mock('../../../../lib/create/character-lora', async (orig) => ({
  ...(await orig<typeof import('../../../../lib/create/character-lora')>()),
  characterLoraFolder: vi.fn(async () => io.folder),
  openCharacterLoraFolder: vi.fn(async () => { io.opened++ }),
  importCharacterLora: vi.fn(async (_f: Blob, name: string) => { io.imported.push(name); return { status: 'saved', file: `char_${name}_zimage.safetensors`, path: '/x', keyFormat: 'same' } }),
}))
vi.mock('../CharacterUseLocally', () => ({ refreshLocalShelves: vi.fn(async () => undefined), CharacterUseLocally: () => null }))
vi.mock('../SpecialIntentControls', () => ({ CharacterMore: () => <span data-testid="file-actions" /> }))

import { HubEmpty } from '../hub/HubEmpty'
import { HubNewCharacter } from '../hub/HubNewCharacter'
import { HubCard, HubPhotos } from '../hub/HubStage'
import { HubActionRow } from '../hub/HubActionRow'
import { useCreateStore } from '../../../../stores/createStore'
import { useCharacterNames } from '../../../../lib/create/character-names'
import { __resetSavedCharacters, listSavedCharacters, saveCharacter } from '../../../../lib/saved-characters'
import { HUB_LOCAL_LINE, hubFromSaved, type HubCharacter } from '../../../../lib/create/character-hub'

const png = (name: string) => new File([`png-${name}`], name, { type: 'image/png' })
const hub = (ui: React.ReactElement) => render(<div className="lu-hub">{ui}</div>)

beforeEach(() => {
  __resetSavedCharacters()
  useCharacterNames.setState({ names: {} })
  io.folder = { status: 'ok', path: '/Users/me/Library/Application Support/lu-labs/loras' }
  io.opened = 0
  io.imported = []
  let n = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:test-${++n}`, revokeObjectURL: () => undefined }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('no character yet', () => {
  it('shows the three steps and one button: no headline, no picture, no example', () => {
    const onCreate = vi.fn()
    const { container } = hub(<HubEmpty onCreate={onCreate} />)
    expect(container.querySelectorAll('ol > li')).toHaveLength(3)
    expect(container.querySelectorAll('h1, h2, h3')).toHaveLength(0)
    expect(container.querySelectorAll('img, image, svg[viewBox="0 0 120 80"], [data-hub-example]')).toHaveLength(0)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Create a character' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})

describe('New character', () => {
  const page = (over: Partial<React.ComponentProps<typeof HubNewCharacter>> = {}) =>
    hub(<HubNewCharacter onBack={() => {}} onSaved={() => {}} onOpenGallery={() => {}} {...over} />)

  it('starts with the drop field alone: no picture stands there before the user adds one', async () => {
    const { container } = page()
    expect(container.querySelector('[data-hub-drop]')).toBeTruthy()
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.querySelector('[data-hub-photos]')).toBeNull()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(container.querySelector('[data-hub-lora-path]')).toBeTruthy())
  })

  it('shows exactly the photos that were added, and saves them under the name', async () => {
    const onSaved = vi.fn()
    const { container } = page({ onSaved })
    fireEvent.change(screen.getByLabelText('Photos or a LoRA file'), { target: { files: [png('a.png'), png('b.png'), png('c.png')] } })
    await waitFor(() => expect(container.querySelectorAll('ul[data-hub-photos] img')).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 2' }))
    await waitFor(() => expect(container.querySelectorAll('ul[data-hub-photos] img')).toHaveLength(2))
    fireEvent.change(container.querySelector('[data-hub-new-name]')!, { target: { value: 'Greta' } })
    expect(container.querySelector('[data-hub-save-summary]')!.textContent).toBe('2 photos · kept on this computer · free')
    fireEvent.click(screen.getByRole('button', { name: 'Save Greta' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const saved = await listSavedCharacters()
    expect(saved.map((c) => [c.name, c.photos.length])).toEqual([['Greta', 2]])
    expect((onSaved.mock.calls[0][0] as HubCharacter).key).toBe(`saved:${saved[0].id}`)
  })

  it('"Train a model" leads on to the training, with or without photos', async () => {
    page()
    fireEvent.click(screen.getByRole('radio', { name: /Train a model/ }))
    const go = screen.getByRole('button', { name: 'Continue to training' }) as HTMLButtonElement
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() => expect(useCreateStore.getState().hubStep).toBe('panel'))
    expect(useCreateStore.getState().intent()).toBe('character')
    expect(useCreateStore.getState().characterTab).toBe('train')
  })

  it('names the real LoRA folder and opens it', async () => {
    const { container } = page()
    const path = await waitFor(() => { const el = container.querySelector('[data-hub-lora-path]'); if (!el) throw new Error('no path yet'); return el })
    expect(path.textContent).toBe('~/Library/Application Support/lu-labs/loras')
    expect(path.getAttribute('title')).toBe('/Users/me/Library/Application Support/lu-labs/loras')
    fireEvent.click(screen.getByRole('button', { name: 'Open LoRA folder' }))
    await waitFor(() => expect(io.opened).toBe(1))
  })

  it('without a LoRA folder the page says so and offers no button for it', async () => {
    io.folder = { status: 'no_comfy' }
    const { container } = page()
    await waitFor(() => expect(container.querySelector('[data-hub-lora-folder="no_comfy"]')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Open LoRA folder' })).toBeNull()
  })

  it('a dropped LoRA file becomes a character under the name it suggests', async () => {
    const onSaved = vi.fn()
    const { container } = page({ onSaved })
    const lora = new File(['weights'], 'char_mira_zimage.safetensors')
    fireEvent.drop(container.querySelector('[data-hub-drop]')!, { dataTransfer: { files: [lora] } })
    await waitFor(() => expect(container.querySelector('[data-hub-lora-file]')).toBeTruthy())
    expect((container.querySelector('[data-hub-new-name]') as HTMLInputElement).value).toBe('mira')
    await waitFor(() => expect(container.querySelector('[data-hub-lora-path]')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Add mira' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(io.imported).toEqual(['mira'])
    // The new character takes the stage, by the id the list gives it.
    expect(onSaved.mock.calls[0][0]).toMatchObject({ kind: 'local', key: 'local:char_mira_zimage.safetensors', name: 'mira' })
  })
})

describe('the stage', () => {
  it('a character without a picture shows its initial, without photos a line, never a stand-in', () => {
    const c: HubCharacter = { key: 'local:char_opa_zimage.safetensors', kind: 'local', name: 'opa', meta: 'Local LoRA', image: null, ref: { id: 'local:char_opa_zimage.safetensors', name: 'opa', triggerWord: 'opa', family: 'zimage' } }
    const { container } = hub(<><HubCard c={c} photo={null} /><HubPhotos c={c} photos={[]} loading={false} /></>)
    expect(container.querySelectorAll('img, image')).toHaveLength(0)
    expect(container.querySelector('.hub-initial')!.textContent).toBe('O')
    expect(container.querySelector('[data-hub-no-photos]')!.textContent).toBe('The photos opa was trained on are not on this computer.')
  })

  it('shows the photos it is given, and only those', () => {
    const c: HubCharacter = { key: 'saved:1', kind: 'saved', name: 'Oma', meta: 'Photos · 2', image: 'blob:a', photos: [new Blob(['a']), new Blob(['b'])] }
    const { container } = hub(<HubPhotos c={c} photos={['blob:a', 'blob:b']} loading={false} />)
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['blob:a', 'blob:b'])
  })

  it('Rename gives a photo character another name where it is stored', async () => {
    const { character } = await saveCharacter('Oma', [new Blob(['a'], { type: 'image/png' })])
    const { container } = hub(<HubCard c={hubFromSaved(character, null)} photo={null} />)
    fireEvent.click(container.querySelector('[data-hub-rename]')!)
    fireEvent.change(screen.getByLabelText('New name for Oma'), { target: { value: 'Greta' } })
    fireEvent.click(container.querySelector('[data-hub-rename-save]')!)
    await waitFor(async () => expect((await listSavedCharacters())[0].name).toBe('Greta'))
    expect(useCharacterNames.getState().names).toEqual({})
  })

  it('Rename gives a LoRA character a label on this computer, and its trigger word stays', async () => {
    const c: HubCharacter = { key: 'cloud:7', kind: 'cloud', name: 'char seven', meta: 'Trained · Flux', image: null, ref: { id: '7', name: 'char seven', triggerWord: 'sevenchar', family: 'flux' } }
    const { container } = hub(<HubCard c={c} photo={null} />)
    fireEvent.click(container.querySelector('[data-hub-rename]')!)
    expect(container.textContent).toContain('The trigger word stays.')
    fireEvent.change(screen.getByLabelText('New name for char seven'), { target: { value: 'Greta' } })
    fireEvent.keyDown(screen.getByLabelText('New name for char seven'), { key: 'Enter' })
    await waitFor(() => expect(useCharacterNames.getState().names).toEqual({ 'cloud:7': 'Greta' }))
    expect(container.textContent).toContain('Trigger word: sevenchar')
  })
})

const hubCss = () => {
  const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8')
  const from = css.indexOf('/* The area is one column of the prompt window')
  const to = css.indexOf('/* The NEW mark on the Character pill')
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  return css.slice(from, to)
}

describe('one column, one window', () => {
  it('the area is as wide as the prompt window: 660, centred', () => {
    const block = hubCss()
    expect(block).toMatch(/\.lu-hub-row \{[^}]*grid-template-columns: minmax\(16px, 1fr\) minmax\(0, 660px\) minmax\(max-content, 1fr\)/)
    expect(block).toMatch(/\.lu-hub-row > \.hub-column \{[^}]*grid-column: 2/)
    // The stage is a plain column in it, not a grid across the page.
    expect(block).toMatch(/\.lu-hub \.hub-stage \{[^}]*flex-direction: column/)
    expect(block).not.toMatch(/grid-template-columns: minmax\(0, 210px\)/)
  })

  it('has no bar and no foot of its own', () => {
    const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8')
    expect(css).not.toMatch(/\.hub-bar\b/)
    expect(css).not.toMatch(/\.hub-foot\b/)
    const dir = resolve(__dirname, '../hub')
    for (const f of ['CharacterHub.tsx', 'HubStage.tsx', 'SwapOneClick.tsx', 'HubNewCharacter.tsx', 'HubEmpty.tsx']) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      expect(src, f).not.toMatch(/hub-bar|hub-foot|<Composer/)
    }
  })

  it('the prompt window is not built differently for the Character tab', () => {
    const src = readFileSync(resolve(__dirname, '../Composer.tsx'), 'utf8')
    const from = src.indexOf('data-prompt-window-area')
    const to = src.indexOf('{/* Action bar */}')
    expect(from).toBeGreaterThan(0)
    const head = src.slice(src.lastIndexOf('<div', from), to)
    // One wrapper, one width, one frame: no branch on `hub` in any of them.
    expect(head).toContain('className="shrink-0 flex flex-col justify-end px-4 pb-4 pt-2 min-h-[192px]"')
    expect(head).toContain('className="mx-auto w-full max-w-[660px] space-y-2.5"')
    expect(head).toMatch(/className="rounded-\[var\(--radius-panel\)\][^"]*" data-prompt-window>/)
    expect(src).not.toMatch(/hub \?\s*(cn\()?'[^']*(px-0|hub-bar)/)
    expect(src).not.toMatch(/!hub && 'max-w/)
  })
})

describe('nothing is lost', () => {
  it('the character stands as a head over its photos with all it can do, at every width', () => {
    const block = hubCss()
    expect(block).toMatch(/\.lu-hub \.hub-card \{[^}]*padding: 10px 0 10px 68px/)
    expect(block).toMatch(/\.hub-card > \.hub-portrait \{[^}]*width: 56px/)
    // Nothing of the area is switched off at any width but the icons of
    // the row on a phone-wide window.
    const off = [...block.matchAll(/([^{}\n]+)\{[^}]*display: none/g)].map((m) => m[1].trim())
    expect(off).toEqual(['.lu-hub .hub-act-item svg'])
    // Rename, Train a model and Delete are plain children of the card.
    const c: HubCharacter = { key: 'saved:1', kind: 'saved', name: 'Oma', meta: 'Photos · 2', image: null, photos: [new Blob(['a']), new Blob(['b'])] }
    const { container } = hub(<HubCard c={c} photo={null} />)
    const links = container.querySelector('.hub-card [data-hub-card-links]')!
    for (const sel of ['[data-hub-rename]', '[data-hub-train]', '[data-hub-delete]']) expect(links.querySelector(sel)).not.toBeNull()
    // The file actions of a LoRA character stand at its head as well.
    cleanup()
    const lora: HubCharacter = { key: 'cloud:7', kind: 'cloud', name: 'seven', meta: 'Trained · Flux', image: null, ref: { id: '7', name: 'seven', triggerWord: 'sevenchar', family: 'flux' } }
    const file = hub(<HubCard c={lora} photo={null} />)
    expect(file.container.querySelector('.hub-card [data-testid="file-actions"]')).not.toBeNull()
  })

  it('the row over the window: Image is picked by default, and one line says what Local and Cloud mean', () => {
    useCreateStore.setState({ backend: 'local' } as never)
    useCreateStore.getState().setIntent('character')
    useCreateStore.getState().setCharacterTab('use')
    const { container } = render(<HubActionRow />)
    const row = screen.getByRole('radiogroup', { name: 'Character action' })
    expect(row.querySelector('[data-hub-action="image"]')!.getAttribute('aria-checked')).toBe('true')
    expect([...row.querySelectorAll('[role=radio]')].filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    const line = container.querySelectorAll('[data-hub-local-line]')
    expect(line).toHaveLength(1)
    expect(line[0].textContent).toBe(HUB_LOCAL_LINE)
    expect(HUB_LOCAL_LINE).toBe('Local runs on your own machine and costs nothing. Cloud prices in credits.')
    expect(line[0].className).not.toMatch(/hidden/)
    // A row, not a bar: no frame around it.
    expect(container.querySelector('[data-hub-actions]')!.className).toBe('lu-hub')
  })
})

describe('nothing moves by itself', () => {
  it('no rule of the area animates or eases anything', () => {
    const block = hubCss()
    expect(block).not.toMatch(/\banimation\b/)
    expect(block).not.toMatch(/@keyframes/)
    expect(block).not.toMatch(/\btransition\b/)
    const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8')
    expect(css).not.toMatch(/lu-hub-ex|hub-ex-/)
  })
})
