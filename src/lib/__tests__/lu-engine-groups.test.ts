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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { splitBackendSwitchRows, groupInstalledByProvider, dropDuplicateLuEngineRows, needsBackendSwitchHeading, LU_ENGINE_GROUP } from '../lu-engine-rows'

const lu = (n: string) => ({ name: `openai::${n}`, model: n, provider: 'openai', providerName: 'LU Engine' })
const luOld = (n: string) => ({ name: `openai::${n}`, model: n, provider: 'openai', providerName: 'Built-in Engine' })
const lms = (n: string) => ({ name: `openai::${n}`, model: n, provider: 'openai', providerName: 'LM Studio' })
const ollama = (n: string) => ({ name: n, model: n, provider: 'ollama', providerName: 'Ollama' })

describe('splitBackendSwitchRows, ein fremdes Backend bedient den Chat', () => {
  const teilen = <T extends { model: string; provider: string; providerName: string }>(rows: T[]) =>
    splitBackendSwitchRows(rows, false, 'LM Studio')

  it('separates the engine rows from everything else, order untouched', () => {
    const { label, switching, rest } = teilen([ollama('a'), lu('b'), lms('c'), lu('d')])
    expect(label).toBe(LU_ENGINE_GROUP)
    expect(switching.map((m) => m.model)).toEqual(['b', 'd'])
    expect(rest.map((m) => m.model)).toEqual(['a', 'c'])
  })

  it('a row recorded under the old name belongs to the same group', () => {
    expect(teilen([luOld('b')]).switching.length).toBe(1)
  })

  // NEGATIVE CONTROL: LM Studio shares provider id 'openai' with the engine.
  // A split that went by provider id would sweep every LM Studio row into the
  // LU Engine group and offer to switch the backend for models that are
  // already running on the one in front.
  it('never takes an LM Studio row along', () => {
    expect(teilen([lms('c')]).switching).toEqual([])
  })
})

// ── Persona 2, Punkt 9 (03.09.2026): der Weg zurueck hatte keine Ueberschrift ──
//
// Versprochen war „a running LM Studio stays in the model picker after the
// chat has moved to the LU Engine. Its models keep their own heading in the
// list". Im Waehler standen sie zwischen Qwen und Hermes, ohne ein Wort
// darueber, dass ein Klick den Steckplatz zurueckgibt.
describe('splitBackendSwitchRows, die LU Engine bedient den Chat', () => {
  const teilen = <T extends { model: string; provider: string; providerName: string }>(rows: T[]) =>
    splitBackendSwitchRows(rows, true, 'LM Studio')

  it('setzt die Zeilen des wartenden Backends unter dessen eigenen Namen ab', () => {
    const { label, switching, rest } = teilen([ollama('a'), lu('b'), lms('c'), lms('e')])
    expect(label).toBe('LM Studio')
    expect(switching.map((m) => m.model)).toEqual(['c', 'e'])
    expect(rest.map((m) => m.model)).toEqual(['a', 'b'])
  })

  // NEGATIVKONTROLLE: unsere eigenen Zeilen sind jetzt die laufenden. Sie
  // abzusetzen hiesse, vor einem Wechsel zu warnen, den es nicht gibt.
  it('nimmt die eigene Engine nie mit', () => {
    expect(teilen([lu('b'), luOld('x')]).switching).toEqual([])
  })

  // NEGATIVKONTROLLE: wartet niemand, gibt es nichts abzusetzen und der
  // Waehler gruppiert nach Familie wie eh und je.
  it('ohne wartendes Backend bleibt alles beim Rest', () => {
    const { label, switching, rest } = splitBackendSwitchRows([lms('c'), lu('b')], true, null)
    expect(label).toBeNull()
    expect(switching).toEqual([])
    expect(rest.length).toBe(2)
  })

  // Ein drittes lokales Backend, das gerade NICHT wartet, wird nicht
  // mitgenommen: der Name entscheidet, nicht die Protokoll-Familie.
  it('trennt zwei OpenAI-Backends an ihrem Namen', () => {
    const jan = { name: 'openai::x', model: 'x', provider: 'openai', providerName: 'Jan' }
    const { switching } = splitBackendSwitchRows([lms('c'), jan], true, 'LM Studio')
    expect(switching.map((m) => m.model)).toEqual(['c'])
  })
})

// ── Persona 5, Punkt E2 (03./04.09.2026): die Sortierung war verkehrtherum ──
//
// Gemessen am echten Build: solange die LU Engine bediente, standen die
// LM-Studio-Modelle unter einer eigenen Ueberschrift LM STUDIO. Richtig.
// Sobald LM Studio selbst bediente, verteilten sich seine sieben Zeilen auf
// QWEN und OTHER, unterscheidbar nur noch am kleinen Abzeichen am
// Zeilenende. Genau dann, wenn jemand in LM Studio arbeitet, war das die
// unbrauchbarste Sortierung.
describe('splitBackendSwitchRows, ein fremdes Backend HAELT den Platz', () => {
  const teilen = <T extends { model: string; provider: string; providerName: string }>(rows: T[]) =>
    splitBackendSwitchRows(rows, false, null, 'LM Studio')

  it('behaelt seinen Namen als Ueberschrift, statt in Familien zu zerfallen', () => {
    const { holderLabel, holding, rest } = teilen([lms('qwen3-4b'), ollama('a'), lms('gemma')])
    expect(holderLabel).toBe('LM Studio')
    expect(holding.map((m) => m.model)).toEqual(['qwen3-4b', 'gemma'])
    expect(rest.map((m) => m.model)).toEqual(['a'])
  })

  it('und die eigene Engine bleibt daneben die Wechselgruppe', () => {
    const { label, switching, holderLabel, holding } =
      splitBackendSwitchRows([lu('b'), lms('c')], false, null, 'LM Studio')
    expect(label).toBe(LU_ENGINE_GROUP)
    expect(switching.map((m) => m.model)).toEqual(['b'])
    expect(holderLabel).toBe('LM Studio')
    expect(holding.map((m) => m.model)).toEqual(['c'])
  })

  // NEGATIVKONTROLLE: haelt unsere eigene Engine den Platz, bleiben ihre
  // GGUFs bei den Familien. Dort sagt die Ueberschrift etwas ueber die Datei,
  // und QWEN neben PHI neben HERMES ist die Ordnung, nach der Menschen
  // waehlen.
  it('unsere eigene Engine bekommt keine Halter-Ueberschrift', () => {
    const { holderLabel, holding } = splitBackendSwitchRows([lu('b')], true, 'LM Studio', 'LU Engine')
    expect(holderLabel).toBeNull()
    expect(holding).toEqual([])
  })

  // NEGATIVKONTROLLE: ohne Halternamen bleibt alles wie vorher.
  it('ohne Halternamen aendert sich nichts', () => {
    const { holderLabel, holding, rest } = splitBackendSwitchRows([lms('c'), ollama('a')], false, null)
    expect(holderLabel).toBeNull()
    expect(holding).toEqual([])
    expect(rest.length).toBe(2)
  })

  it('der Waehler reicht den Halternamen wirklich durch', () => {
    const src = readFileSync(
      resolve(__dirname, '..', '..', 'components/models/ModelSelector.tsx'), 'utf8',
    )
    expect(src).toContain('splitBackendSwitchRows(textModels, luEngineHoldsChat, standbyName, holderName)')
    expect(src).toContain('wechsel.holding.length > 0 && wechsel.holderLabel')
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
  // whenever it holds exactly one quant of a model, which is most of the time.
  // A14 third review pinned the price of that shortcut: it may only be walked
  // when OUR side is nameless too. One nameless row and one nameless file of
  // that identity can only be each other.
  it('drops the row for a collapsed LM Studio id when our file names no quant either', () => {
    const ours = luFile('Qwen2.5-0.5B-Instruct')
    // The plain spelling, where the two filenames already match.
    expect(dropDuplicateLuEngineRows([ours], lmsHas('qwen/qwen2.5-0.5b-instruct'))).toEqual([])
    // And the one route 3 exists for: the same model identity written without
    // the trailing decoration word, so no filename comparison can join them.
    expect(dropDuplicateLuEngineRows([ours], lmsHas('qwen/qwen2.5-0.5b'))).toEqual([])
  })

  // THE A14 THIRD REVIEW FINDING, and David's own machine: ~/lu-e2e-models
  // holds Qwen2.5-0.5B-Instruct-Q8_0.gguf, LM Studio reports the collapsed id
  // because it happens to hold one quant, and that quant may be a Q4_K_M in a
  // completely different folder. Our file names its quant, so the two are not
  // the same file as far as anyone here can prove, and the row that would go
  // missing is the one the whole feature exists to show.
  it('keeps our named quant beside a collapsed LM Studio id', () => {
    const q8 = {
      name: 'openai::Qwen2.5-0.5B-Instruct-Q8_0',
      model: 'Qwen2.5-0.5B-Instruct-Q8_0',
      path: '/Users/d/lu-e2e-models/Qwen2.5-0.5B-Instruct-Q8_0.gguf',
      provider: 'openai',
      providerName: 'LU Engine',
    }
    expect(dropDuplicateLuEngineRows([q8], lmsHas('qwen/qwen2.5-0.5b-instruct'))).toEqual([q8])
  })

  // NEGATIVE CONTROL for that route: with TWO nameless files of the model in
  // our folder, a nameless LM Studio row cannot say which of them it is.
  // Dropping either would be a guess, so both stay.
  it('keeps both when a collapsed id could mean either of two files we hold', () => {
    const rows = [luFile('Qwen2.5-0.5B-Instruct'), luFile('Qwen2.5-0.5B-Chat')]
    expect(dropDuplicateLuEngineRows(rows, lmsHas('qwen/qwen2.5-0.5b'))).toEqual(rows)
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

describe('when the switch heading has to be drawn', () => {
  const labels = <T extends { label: string }>(g: T[]) => g.map((x) => x.label)
  const luGroup = labels(groupInstalledByProvider([lu('a')]))
  const ollamaGroup = labels(groupInstalledByProvider([ollama('a')]))
  const both = labels(groupInstalledByProvider([lu('a'), ollama('b')]))

  // THE REVIEW FINDING. A user whose only local models are GGUFs in the LU
  // Engine folder, with Ollama or LM Studio in front, got one unlabelled list
  // and a click that moved his chat backend without a word of warning.
  it('one LU Engine group under a foreign backend still gets its heading', () => {
    expect(needsBackendSwitchHeading(luGroup, LU_ENGINE_GROUP)).toBe(true)
  })

  it('and so does a list with more than one backend in it, either way round', () => {
    expect(needsBackendSwitchHeading(both, LU_ENGINE_GROUP)).toBe(true)
    expect(needsBackendSwitchHeading(both, null)).toBe(true)
  })

  // Und dieselbe Regel andersherum: eine einzige LM-Studio-Gruppe unter
  // unserer eigenen Engine traegt ihre Ueberschrift, weil der Klick darauf
  // den Steckplatz zurueckgibt.
  it('eine einzelne Gruppe des wartenden Backends bekommt sie ebenso', () => {
    expect(needsBackendSwitchHeading(['LM Studio'], 'LM Studio')).toBe(true)
  })

  // NEGATIVE CONTROL: a plain Ollama box looks exactly as it did before. A
  // heading over the only list there names nothing the user did not know.
  it('a single foreign group draws none', () => {
    expect(needsBackendSwitchHeading(ollamaGroup, LU_ENGINE_GROUP)).toBe(false)
    expect(needsBackendSwitchHeading(ollamaGroup, null)).toBe(false)
  })

  // NEGATIVE CONTROL: with the LU Engine itself in front there is no switch to
  // warn about, so its own single group needs no heading either.
  it('and neither does the LU Engine when it is already the chat backend', () => {
    expect(needsBackendSwitchHeading(luGroup, null)).toBe(false)
  })

  it('an empty list needs nothing', () => {
    expect(needsBackendSwitchHeading([], LU_ENGINE_GROUP)).toBe(false)
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
    expect(src).toContain('needsBackendSwitchHeading(groups.map((g) => g.family), wechsel.label)')
    expect(src).not.toMatch(/family === LU_ENGINE_GROUP\)\) &&/)
  })

  it('and so does the Installed list', async () => {
    const src = await read('../../components/models/ModelManager.tsx')
    expect(src).toContain('needsBackendSwitchHeading(providerGroups.map((g) => g.label), luEngineHoldsChat ? null : LU_ENGINE_GROUP)')
  })
})
