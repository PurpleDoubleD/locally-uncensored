/**
 * C8 (funde-C.md): "Train new" with the trigger word of a character already
 * on this machine (luxfox) went straight to mlx_train_start, and the run's end
 * wrote the new LoRA over char_luxfox_zimage.safetensors. The old character
 * was gone, not in the Trash.
 *
 * Now runCharacterTraining looks for a character of the same trigger first
 * and asks (stores/trainReplaceStore.ts, dialog in the Character panel). Only
 * "Replace" goes on; anything else stops before a photo is staged.
 *
 * Run: npx vitest run src/hooks/__tests__/training-asks-before-replacing-a-character.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { characterThisWouldReplace, useTrainReplaceStore } from '../../stores/trainReplaceStore'

const src = fs.readFileSync(path.join(__dirname, '..', 'useCreate.ts'), 'utf8')
const training = src.slice(src.indexOf('const runCharacterTraining = useCallback('), src.indexOf('const runOnce = useCallback('))

beforeEach(() => useTrainReplaceStore.setState({ pending: null, resolve: null, listeners: 0 }))

describe('C8: a new training asks before it replaces a character of the same name', () => {
  it('the run reads the local characters and asks before staging or starting', () => {
    const look = training.indexOf('characterThisWouldReplace(trigger, await listLocalCharacters()')
    const ask = training.indexOf('useTrainReplaceStore.getState().ask(existing)')
    const stage = training.indexOf('await stageTrainingImage(')
    const clear = training.indexOf('await clearTrainingSet(')
    const begin = training.indexOf('await startCharacterTraining(')
    expect(look).toBeGreaterThan(0)
    expect(ask).toBeGreaterThan(look)
    expect(clear).toBeGreaterThan(ask)
    expect(stage).toBeGreaterThan(ask)
    expect(begin).toBeGreaterThan(ask)
  })

  it('only an explicit "replace" goes on', () => {
    const ask = training.slice(training.indexOf('const existing = characterThisWouldReplace('))
    expect(ask).toMatch(/ask\(existing\) !== 'replace'\) \{\s*setError\([^)]*already exists[^)]*\)\s*return/)
  })

  it('finds the existing character by trigger, case blind, and only then', () => {
    const shelf = [{ triggerWord: 'luxfox' }, { triggerWord: 'mia' }]
    expect(characterThisWouldReplace('luxfox', shelf)).toBe('luxfox')
    expect(characterThisWouldReplace('Luxfox', shelf)).toBe('luxfox')
    expect(characterThisWouldReplace('luxfox2', shelf)).toBeNull()
  })

  it('the dialog answers the waiting run', async () => {
    const unmount = useTrainReplaceStore.getState().mount()
    const answer = useTrainReplaceStore.getState().ask('luxfox')
    expect(useTrainReplaceStore.getState().pending).toBe('luxfox')
    useTrainReplaceStore.getState().answer('replace')
    await expect(answer).resolves.toBe('replace')
    expect(useTrainReplaceStore.getState().pending).toBeNull()
    unmount()
  })

  it('with no dialog on screen the ask never replaces and never hangs', async () => {
    await expect(useTrainReplaceStore.getState().ask('luxfox')).resolves.toBe('rename')
  })

  it('a dialog that goes away mid-question answers "rename"', async () => {
    const unmount = useTrainReplaceStore.getState().mount()
    const answer = useTrainReplaceStore.getState().ask('luxfox')
    unmount()
    await expect(answer).resolves.toBe('rename')
  })
})
