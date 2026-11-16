// @vitest-environment jsdom
/**
 * The Character area as David chose it on 16.11.2026 (variant B):
 *   - no character yet: three steps, one button, four examples, no headline;
 *   - "New character" starts with the drop field alone and shows only the
 *     photos the user put there;
 *   - the stage shows only real things: a character without photos gets a
 *     line, never a stand-in picture;
 *   - Rename works on the desktop;
 *   - nothing of the area moves by itself except the four examples.
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
import { HubActions, HubCard, HubPhotos, type HubActionState } from '../hub/HubStage'
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
  it('shows the three steps, one button and four examples, and no headline', () => {
    const onCreate = vi.fn()
    const onTry = vi.fn()
    const { container } = hub(<HubEmpty onCreate={onCreate} onTry={onTry} />)
    expect(container.querySelectorAll('ol > li')).toHaveLength(3)
    expect(container.querySelectorAll('[data-hub-example]')).toHaveLength(4)
    expect(container.querySelectorAll('h1, h2, h3')).toHaveLength(0)
    expect(screen.getAllByRole('button').filter((b) => b.textContent === 'Create a character')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Create a character' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    fireEvent.click(container.querySelector('[data-hub-example="swap"]')!)
    expect(onTry).toHaveBeenCalledWith('swap')
  })

  it('draws the examples with the LU mark, not with a photo', () => {
    const { container } = hub(<HubEmpty onCreate={() => {}} onTry={() => {}} />)
    expect(container.querySelectorAll('img')).toHaveLength(0)
    const marks = [...container.querySelectorAll('image')].map((i) => i.getAttribute('href'))
    expect(marks.length).toBeGreaterThanOrEqual(4)
    expect(new Set(marks)).toEqual(new Set(['/LU-monogram.svg']))
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

describe('nothing is lost', () => {
  it('a narrow window keeps the character and all it can do: as a head over the photos, never hidden', () => {
    const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8')
    const from = css.indexOf('@media (max-width: 700px) {\n  .lu-hub .hub-stage')
    expect(from).toBeGreaterThan(0)
    const narrow = css.slice(from, css.indexOf('\n}', from))
    // The card is laid out, not taken away, and nothing in it but the file
    // actions (which stand under More options there) is switched off.
    expect(narrow).toMatch(/\.lu-hub \.hub-card \{[^}]*overflow: visible/)
    expect(narrow).toMatch(/\.hub-portrait \{[^}]*width: 56px/)
    const off = [...narrow.matchAll(/([^{}\n]+)\{[^}]*display: none/g)].map((m) => m[1].trim())
    expect(off).toEqual(['.lu-hub .hub-card .hub-card-file'])
    // Head above the photos, the photos above the bar.
    expect(narrow).toMatch(/\.hub-card \{[^}]*grid-row: 2/)
    expect(narrow).toMatch(/\.hub-body \{[^}]*grid-row: 3/)
    expect(narrow).toMatch(/\.hub-foot \{[^}]*grid-row: 4/)
    // Rename, Train a model and Delete are plain children of the card.
    const c: HubCharacter = { key: 'saved:1', kind: 'saved', name: 'Oma', meta: 'Photos · 2', image: null, photos: [new Blob(['a']), new Blob(['b'])] }
    const { container } = hub(<HubCard c={c} photo={null} />)
    const links = container.querySelector('.hub-card [data-hub-card-links]')!
    for (const sel of ['[data-hub-rename]', '[data-hub-train]', '[data-hub-delete]']) expect(links.querySelector(sel)).not.toBeNull()
    expect(links.closest('.hub-card-file')).toBeNull()
  })

  it('says once what the price of the picked action means, and only then', () => {
    const actions: HubActionState[] = [
      { action: 'image', label: 'Character', locked: false, meta: 'Local · free' },
      { action: 'swap', label: 'Swap Character', locked: true, meta: 'Runs on LU Cloud' },
    ]
    const idle = hub(<HubActions actions={actions} active={null} name="Oma" onPick={() => {}} />)
    expect(idle.container.querySelector('[data-hub-local-line]')).toBeNull()
    cleanup()
    const picked = hub(<HubActions actions={actions} active="image" name="Oma" onPick={() => {}} />)
    const line = picked.container.querySelectorAll('[data-hub-local-line]')
    expect(line).toHaveLength(1)
    expect(line[0].textContent).toBe(HUB_LOCAL_LINE)
    expect(HUB_LOCAL_LINE).toBe('Local runs on your own machine and costs nothing. Cloud prices in credits.')
    // The line is not one of those that step aside on a narrow window.
    expect(line[0].className).not.toMatch(/hidden/)
    expect(picked.container.querySelector('[data-hub-action-meta]')!.textContent).toBe('Local · free')
  })
})

describe('nothing moves by itself', () => {
  it('only the four examples of the first page are animated, and they stand still with reduced motion', () => {
    const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8')
    const from = css.indexOf('/* The stage (variant B')
    const to = css.indexOf('/* The NEW mark on the Character pill')
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const block = css.slice(from, to)
    const animated = [...block.matchAll(/([^{}]+)\{[^{}]*\banimation:(?!\s*none)[^;]+;[^{}]*\}/g)].map((m) => m[1].trim())
    expect(animated.length).toBe(4)
    for (const sel of animated) expect(sel).toMatch(/^\.lu-hub \.hub-ex-(a|b|tilt|bar)$/)
    expect(block).not.toMatch(/\btransition\b/)
    const reduced = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'))
    for (const cls of ['hub-ex-a', 'hub-ex-b', 'hub-ex-tilt', 'hub-ex-bar']) expect(reduced).toContain(`.lu-hub .${cls}`)
    expect(reduced).toMatch(/animation: none/)
  })
})
