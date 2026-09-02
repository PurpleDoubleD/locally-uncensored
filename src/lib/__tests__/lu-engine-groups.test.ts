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
import { splitLuEngineRows, groupInstalledByProvider, dropDuplicateLuEngineRows, needsLuEngineHeading, LU_ENGINE_GROUP } from '../lu-engine-rows'

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

// ── A14 review, point 1: one file, not one model ─────────────────────────────

describe('de-duplication asks about the FILE, never about the model', () => {
  const luFile = (stem: string) => ({ name: `openai::${stem}`, model: stem, path: `/u/models/${stem}.gguf`, provider: 'openai', providerName: 'LU Engine' })
  const lmsHas = (id: string) => [{ name: `openai::${id}`, model: id, provider: 'openai', providerName: 'LM Studio' }]

  it('drops the row when LM Studio holds the very same quant', () => {
    const kept = dropDuplicateLuEngineRows([luFile('Qwen2.5-0.5B-Instruct-Q8_0')], lmsHas('qwen2.5-0.5b-instruct@q8_0'))
    expect(kept).toEqual([])
  })

  it('drops the row for an identical filename, whatever the quant is called', () => {
    const kept = dropDuplicateLuEngineRows([luFile('Qwen2.5-0.5B-Instruct-Q8_0')], lmsHas('Qwen2.5-0.5B-Instruct-Q8_0.gguf'))
    expect(kept).toEqual([])
  })

  // THE REVIEW FINDING. The Discover badge's matcher answers a catalogue
  // question: a name with no quant means "any quant counts as installed". Used
  // for de-duplication it made a quant-less GGUF in the LU Engine folder
  // disappear behind whichever quant LM Studio happened to hold, and those are
  // two different files with two different answer qualities.
  it('keeps a quant-less GGUF beside a NAMED LM Studio quant of the same model', () => {
    // LM Studio naming a quant means it knows which file it has, and it is not
    // this one: ours names none, so the two cannot be shown to be one file.
    const row = luFile('Qwen2.5-0.5B-Instruct')
    expect(dropDuplicateLuEngineRows([row], lmsHas('qwen2.5-0.5b-instruct@q4_k_m'))).toEqual([row])
    expect(dropDuplicateLuEngineRows([row], lmsHas('qwen2.5-0.5b-instruct@q8_0'))).toEqual([row])
  })

  // A14 second review: the collapsed id is the COMMON case, not the exotic
  // one. LM Studio reports "qwen/qwen2.5-0.5b-instruct" with no quant at all
  // whenever it holds exactly one quant of a model, which is most of the time,
  // and the strict rule kept both rows for one file. One nameless row and
  // exactly one file of that identity can only be each other.
  it('drops the row for a collapsed LM Studio id when we hold exactly one such file', () => {
    const q8 = luFile('Qwen2.5-0.5B-Instruct-Q8_0')
    expect(dropDuplicateLuEngineRows([q8], lmsHas('qwen/qwen2.5-0.5b-instruct'))).toEqual([])
  })

  // NEGATIVE CONTROL for that route: with TWO quants of the model in our
  // folder, a nameless LM Studio row cannot say which of them it is. Dropping
  // either would be a guess, so both stay.
  it('keeps both when a collapsed id could mean either of two files we hold', () => {
    const rows = [luFile('Qwen2.5-0.5B-Instruct-Q8_0'), luFile('Qwen2.5-0.5B-Instruct-Q4_K_M')]
    expect(dropDuplicateLuEngineRows(rows, lmsHas('qwen/qwen2.5-0.5b-instruct'))).toEqual(rows)
  })

  it('drops the row when the file itself lies in LM Studio own store', () => {
    // The auto-detect case: the LU Engine folder is ~/.lmstudio/models, so the
    // folder walk finds LM Studio own files. Then the identity settles it and
    // no quant needs to be named anywhere.
    const inStore = {
      name: 'openai::Qwen2.5-0.5B-Instruct',
      model: 'Qwen2.5-0.5B-Instruct',
      path: '/Users/d/.lmstudio/models/qwen/Qwen2.5-0.5B-Instruct/Qwen2.5-0.5B-Instruct.gguf',
      provider: 'openai',
      providerName: 'LU Engine',
    }
    expect(dropDuplicateLuEngineRows([inStore], lmsHas('qwen/qwen2.5-0.5b-instruct@q4_k_m'))).toEqual([])
  })

  // NEGATIVE CONTROL: the same shape OUTSIDE LM Studio's store is a real
  // second download and stays.
  it('keeps a quant-less file of our own beside a differently quantised LM Studio one', () => {
    const own = luFile('Qwen2.5-0.5B-Instruct')
    const second = luFile('Qwen2.5-0.5B-Instruct-Q4_K_M')
    // Two files of the identity, so route 3 cannot fire and the strict rule
    // finds no quant on our first file: both stay.
    expect(dropDuplicateLuEngineRows([own, second], lmsHas('qwen2.5-0.5b-instruct@q8_0'))).toEqual([own, second])
  })

  it('drops the row when both sides name the same path', () => {
    const shared = '/Users/d/models/Qwen2.5-0.5B-Instruct-Q8_0.gguf'
    const ours = { name: 'openai::Qwen2.5-0.5B-Instruct-Q8_0', model: 'Qwen2.5-0.5B-Instruct-Q8_0', path: shared, provider: 'openai', providerName: 'LU Engine' }
    const theirs = [{ name: 'openai::whatever-lm-studio-calls-it', model: 'whatever-lm-studio-calls-it', path: shared, provider: 'openai', providerName: 'LM Studio' }]
    expect(dropDuplicateLuEngineRows([ours], theirs)).toEqual([])
  })

  // NEGATIVE CONTROL: two quants of one model are two files.
  it('keeps both when the quants differ', () => {
    const row = luFile('Qwen2.5-0.5B-Instruct-Q8_0')
    expect(dropDuplicateLuEngineRows([row], lmsHas('qwen2.5-0.5b-instruct@q4_k_m'))).toEqual([row])
  })

  // NEGATIVE CONTROL: Ollama is not LM Studio. Its blob store holds a second
  // copy, so hiding the GGUF there would hide a real download.
  it('never lets an Ollama row hide a GGUF', () => {
    const row = luFile('Qwen2.5-0.5B-Instruct-Q8_0')
    const ollamaRows = [{ name: 'qwen2.5:0.5b-instruct-q8_0', model: 'qwen2.5:0.5b-instruct-q8_0', provider: 'ollama', providerName: 'Ollama' }]
    expect(dropDuplicateLuEngineRows([row], ollamaRows)).toEqual([row])
  })

  // NEGATIVE CONTROL: genuinely different models must never collapse, however
  // similar the names look.
  it('keeps two different models apart', () => {
    const row = luFile('Qwen2.5-0.5B-Instruct-Q8_0')
    expect(dropDuplicateLuEngineRows([row], lmsHas('gemma-3-4b-it@q8_0'))).toEqual([row])
    // An abliterated finetune is a different model, same quant or not.
    expect(dropDuplicateLuEngineRows([row], lmsHas('qwen2.5-0.5b-instruct-abliterated@q8_0'))).toEqual([row])
  })
})

// ── A14 review 7: the heading is the warning, so it cannot be optional ──────

describe('when the LU Engine heading has to be drawn', () => {
  const labels = <T extends { label: string }>(g: T[]) => g.map((x) => x.label)
  const luGroup = labels(groupInstalledByProvider([lu('a')]))
  const ollamaGroup = labels(groupInstalledByProvider([ollama('a')]))
  const both = labels(groupInstalledByProvider([lu('a'), ollama('b')]))

  // THE REVIEW FINDING. A user whose only local models are GGUFs in the LU
  // Engine folder, with Ollama or LM Studio in front, got one unlabelled list
  // and a click that moved his chat backend without a word of warning.
  it('one LU Engine group under a foreign backend still gets its heading', () => {
    expect(needsLuEngineHeading(luGroup, false)).toBe(true)
  })

  it('and so does a list with more than one backend in it, either way round', () => {
    expect(needsLuEngineHeading(both, false)).toBe(true)
    expect(needsLuEngineHeading(both, true)).toBe(true)
  })

  // NEGATIVE CONTROL: a plain Ollama box looks exactly as it did before. A
  // heading over the only list there names nothing the user did not know.
  it('a single foreign group draws none', () => {
    expect(needsLuEngineHeading(ollamaGroup, false)).toBe(false)
    expect(needsLuEngineHeading(ollamaGroup, true)).toBe(false)
  })

  // NEGATIVE CONTROL: with the LU Engine itself in front there is no switch to
  // warn about, so its own single group needs no heading either.
  it('and neither does the LU Engine when it is already the chat backend', () => {
    expect(needsLuEngineHeading(luGroup, true)).toBe(false)
  })

  it('an empty list needs nothing', () => {
    expect(needsLuEngineHeading([], false)).toBe(false)
  })
})

// ── One rule, two surfaces ──────────────────────────────────────────────────
//
// The rule above is proven by behaviour. That both surfaces ASK it, rather
// than each keeping a copy that drifts, is pinned by reading the source: the
// Installed list and the composer's picker group by different things and
// neither component has a render harness in this repo. Weaker proof, and
// labelled as such: it catches a copy creeping back in, not a broken render.
describe('the Installed list and the picker ask the same rule', () => {
  const read = async (p: string) => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), p), 'utf8')
  }

  it('the composer picker calls it instead of counting groups itself', async () => {
    const src = await read('../../components/models/ModelSelector.tsx')
    expect(src).toContain('needsLuEngineHeading(groups.map((g) => g.family), luEngineHoldsChat)')
    expect(src).not.toMatch(/family === LU_ENGINE_GROUP\)\) &&/)
  })

  it('and so does the Installed list', async () => {
    const src = await read('../../components/models/ModelManager.tsx')
    expect(src).toContain('needsLuEngineHeading(providerGroups.map((g) => g.label), luEngineHoldsChat)')
  })
})
