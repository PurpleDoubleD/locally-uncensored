// @vitest-environment jsdom
/**
 * A dropped LoRA file as a character (3.1.0, "New character"): the file goes
 * to the backend in pieces, in order, and the last one is marked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const io = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[], answer: (_cmd: string, _args: Record<string, unknown>): unknown => ({}) }))
vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  backendCall: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    io.calls.push({ cmd, args })
    return io.answer(cmd, args)
  }),
}))

import { characterLoraFolder, importCharacterLora, isLoraFile, nameFromLoraFile, shortFolder } from '../character-lora'

beforeEach(() => { io.calls = []; io.answer = () => ({}) })

describe('the file and its folder', () => {
  it('reads a name out of the file name', () => {
    expect(nameFromLoraFile('char_mira_vale_zimage.safetensors')).toBe('mira vale')
    expect(nameFromLoraFile('Mira-v2.safetensors')).toBe('Mira v2')
    expect(isLoraFile({ name: 'x.SafeTensors' })).toBe(true)
    expect(isLoraFile({ name: 'x.png' })).toBe(false)
  })

  it('shortens the home folder, and leaves a Windows path alone', () => {
    expect(shortFolder('/Users/dave/Library/Application Support/lu-labs/loras')).toBe('~/Library/Application Support/lu-labs/loras')
    expect(shortFolder('D:\\ComfyUI\\models\\loras')).toBe('D:\\ComfyUI\\models\\loras')
  })

  it('names the folder, or says that there is none', async () => {
    io.answer = () => ({ status: 'ok', path: '/x/loras' })
    expect(await characterLoraFolder()).toEqual({ status: 'ok', path: '/x/loras' })
    io.answer = () => ({ status: 'no_comfy' })
    expect(await characterLoraFolder()).toEqual({ status: 'no_comfy' })
  })
})

describe('the import', () => {
  it('sends the pieces in order and marks the last', async () => {
    const file = new Blob(['abcdefghij'])
    io.answer = (_cmd, a) => (a.last ? { status: 'saved', file: 'char_Mira_zimage.safetensors', path: '/x/char_Mira_zimage.safetensors', keyFormat: 'same' } : { status: 'more' })
    const seen: number[] = []
    const r = await importCharacterLora(file, 'Mira', (got) => seen.push(got), 4)
    expect(r).toEqual({ status: 'saved', file: 'char_Mira_zimage.safetensors', path: '/x/char_Mira_zimage.safetensors', keyFormat: 'same' })
    const pieces = io.calls.filter((c) => c.cmd === 'character_lora_import')
    expect(pieces.map((c) => [c.args.offset, c.args.last])).toEqual([[0, false], [4, false], [8, true]])
    expect(pieces.map((c) => atob(String(c.args.dataB64))).join('')).toBe('abcdefghij')
    expect(pieces.every((c) => c.args.name === 'Mira')).toBe(true)
    expect(seen).toEqual([4, 8, 10])
  })

  it('a character of that name, or no folder, ends it without an error', async () => {
    io.answer = () => ({ status: 'exists', file: 'char_Mira_zimage.safetensors' })
    expect(await importCharacterLora(new Blob(['abc']), 'Mira')).toEqual({ status: 'exists', file: 'char_Mira_zimage.safetensors' })
    io.answer = () => ({ status: 'no_comfy' })
    expect(await importCharacterLora(new Blob(['abc']), 'Mira')).toEqual({ status: 'no_comfy' })
  })

  it('a layout LU does not know comes back as unknown', async () => {
    io.answer = () => ({ status: 'saved', file: 'f', path: 'p', keyFormat: 'something' })
    expect(await importCharacterLora(new Blob(['abc']), 'Mira')).toMatchObject({ keyFormat: 'unknown' })
  })

  it('a failure on the way takes the pieces away again', async () => {
    io.answer = (cmd) => { if (cmd === 'character_lora_import') throw new Error('This file is not a LoRA LU can read. Nothing was added.'); return {} }
    await expect(importCharacterLora(new Blob(['abc']), 'Mira')).rejects.toThrow('not a LoRA')
    expect(io.calls.at(-1)).toEqual({ cmd: 'character_lora_import_cancel', args: { name: 'Mira' } })
    await expect(importCharacterLora(new Blob([]), 'Mira')).rejects.toThrow('empty')
  })
})
