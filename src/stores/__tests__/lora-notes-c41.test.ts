// C41: LoRAs get a name of the user's own, a note, and can be hidden from the
// LoRA stack. The file is never renamed: saved settings still find it.
import { describe, it, expect, beforeEach } from 'vitest'
import { useLoraNotesStore, applyLoraNotes } from '../loraNotesStore'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

beforeEach(() => useLoraNotesStore.setState({ notes: {} }))

describe('the notes', () => {
  it('a name and a note are kept, trimmed', () => {
    useLoraNotesStore.getState().setNote('styles/pixel.safetensors', { label: '  Pixel art  ', note: 'trigger: pxl' })
    expect(useLoraNotesStore.getState().notes['styles/pixel.safetensors']).toEqual({ label: 'Pixel art', note: 'trigger: pxl' })
  })

  it('a note emptied again is removed, not kept empty', () => {
    const s = useLoraNotesStore.getState()
    s.setNote('a.safetensors', { label: 'A' })
    s.setNote('a.safetensors', { label: '' })
    expect(useLoraNotesStore.getState().notes).toEqual({})
  })

  it('hiding keeps the name, showing again keeps it too', () => {
    const s = useLoraNotesStore.getState()
    s.setNote('a.safetensors', { label: 'A', hidden: true })
    s.setNote('a.safetensors', { hidden: false })
    expect(useLoraNotesStore.getState().notes['a.safetensors']).toEqual({ label: 'A' })
  })

  it('a deleted file takes its note along', () => {
    const s = useLoraNotesStore.getState()
    s.setNote('a.safetensors', { note: 'x' })
    s.forget('a.safetensors')
    expect(useLoraNotesStore.getState().notes).toEqual({})
  })
})

describe('applied to a list (Models and the LoRA stack of Create)', () => {
  const rows = [{ name: 'a.safetensors', label: 'a' }, { name: 'b.safetensors', label: 'b' }]
  const notes = { 'a.safetensors': { label: 'Alpha', note: 'n' }, 'b.safetensors': { hidden: true } }

  it('shows the user\'s name and leaves the hidden one out', () => {
    expect(applyLoraNotes(rows, notes)).toEqual([{ name: 'a.safetensors', label: 'Alpha', note: 'n', hidden: false }])
  })

  it('GEGENPROBE: a hidden LoRA that is ticked stays, so it can be turned off', () => {
    expect(applyLoraNotes(rows, notes, { picked: new Set(['b.safetensors']) }).map((r) => r.name)).toEqual(['a.safetensors', 'b.safetensors'])
  })

  it('Show hidden brings every one back, marked', () => {
    const all = applyLoraNotes(rows, notes, { showHidden: true })
    expect(all.find((r) => r.name === 'b.safetensors')?.hidden).toBe(true)
  })

  it('the name that goes to a run is the file\'s, never the label', () => {
    expect(applyLoraNotes(rows, notes)[0].name).toBe('a.safetensors')
  })
})

describe('kept like the other stores', () => {
  it('is in the backup list, so an update does not lose it', () => {
    const src = readFileSync(resolve(__dirname, '../../lib/store-backup.ts'), 'utf8')
    expect(src).toContain("'lu-lora-notes'")
  })

  it('Create reads the notes for its LoRA stack', () => {
    const src = readFileSync(resolve(__dirname, '../../components/create/experimental/ParamGroups.tsx'), 'utf8')
    expect(src).toMatch(/applyLoraNotes\(loraRows\(/)
  })
})
