/**
 * A14 (2.6.8), David: "Die Modelle erscheinen unter Installed in einer Gruppe
 * 'LU Engine' (analog zu den Provider-Gruppen)" and the same in the composer's
 * picker.
 *
 * The heading is not decoration. Since the LU Engine's GGUFs are listed even
 * while Ollama or LM Studio holds the chat, one of those rows is the only kind
 * of row in the list whose use moves the chat backend, and the user should
 * read that before he clicks rather than after.
 *
 * Run: npx vitest run src/lib/__tests__/lu-engine-groups.test.ts
 */
import { describe, it, expect } from 'vitest'
import { splitLuEngineRows, groupInstalledByProvider, LU_ENGINE_GROUP } from '../lu-engine-rows'

const lu = (n: string) => ({ name: `openai::${n}`, model: n, provider: 'openai', providerName: 'LU Engine' })
const luOld = (n: string) => ({ name: `openai::${n}`, model: n, provider: 'openai', providerName: 'Built-in Engine' })
const lms = (n: string) => ({ name: `openai::${n}`, model: n, provider: 'openai', providerName: 'LM Studio' })
const ollama = (n: string) => ({ name: n, model: n, provider: 'ollama', providerName: 'Ollama' })

describe('splitLuEngineRows', () => {
  it('separates the engine rows from everything else, order untouched', () => {
    const { luEngine, rest } = splitLuEngineRows([ollama('a'), lu('b'), lms('c'), lu('d')])
    expect(luEngine.map((m) => m.model)).toEqual(['b', 'd'])
    expect(rest.map((m) => m.model)).toEqual(['a', 'c'])
  })

  it('a row recorded under the old name belongs to the same group', () => {
    expect(splitLuEngineRows([luOld('b')]).luEngine.length).toBe(1)
  })

  // NEGATIVE CONTROL: LM Studio shares provider id 'openai' with the engine.
  // A split that went by provider id would sweep every LM Studio row into the
  // LU Engine group and offer to switch the backend for models that are
  // already running on the one in front.
  it('never takes an LM Studio row along', () => {
    expect(splitLuEngineRows([lms('c')]).luEngine).toEqual([])
  })
})

describe('groupInstalledByProvider', () => {
  it('puts the LU Engine group first, whatever order the rows arrived in', () => {
    const groups = groupInstalledByProvider([ollama('a'), lms('c'), lu('b')])
    expect(groups.map((g) => g.label)).toEqual([LU_ENGINE_GROUP, 'Ollama', 'LM Studio'])
    expect(groups[0].models.map((m) => m.model)).toEqual(['b'])
  })

  it('keeps every row: nothing is grouped away', () => {
    const rows = [ollama('a'), lms('c'), lu('b'), ollama('d')]
    const groups = groupInstalledByProvider(rows)
    expect(groups.flatMap((g) => g.models).length).toBe(rows.length)
  })

  // NEGATIVE CONTROL: a single backend is not a grouping problem. One group is
  // what the render reads to draw no heading at all, so the Installed list of
  // a plain Ollama box looks exactly as it did before.
  it('answers with one group when one backend serves everything', () => {
    const groups = groupInstalledByProvider([ollama('a'), ollama('d')])
    expect(groups.length).toBe(1)
    expect(groups[0].label).toBe('Ollama')
  })

  // NEGATIVE CONTROL: a row with no provider name is still a model the user
  // has. It gets a heading rather than an empty one, and is never dropped.
  it('gives a nameless row a heading instead of losing it', () => {
    const groups = groupInstalledByProvider([{ name: 'x', model: 'x', provider: 'ollama' }])
    expect(groups.map((g) => g.label)).toEqual(['Other'])
  })
})
