/**
 * GH #255 (3.1.2): memory in long story chats. One test group per point of
 * the report; each one failed on 3.1.1 (cb2971030).
 *
 * Run: npx vitest run src/stores/__tests__/memory-long-story-chats-255.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  useMemoryStore, __setMemoryEmbedFn, fitMemoryText, renderMemoryContext, effectiveMemoryBudget,
  memoryContextCeiling, isHandWritten, memoryCharLimit, MEMORY_COUNT_MAX,
} from '../memoryStore'
import type { MemoryFile } from '../../types/agent-mode'
import { searchTerms } from '../../lib/search-terms'
import { bm25Score } from '../../api/rag'
import { extractionContextRules, buildExtractionPrompt, buildResolutionPrompt } from '../../lib/memory-extraction'
import { extractionPersonaOf } from '../../lib/chat-persona'
import type { Persona } from '../../types/settings'

const SETTINGS = { autoExtractEnabled: false, autoExtractInAllModes: false, maxMemoriesInPrompt: 10, maxMemoryChars: 3000 }

/** A story day of about 1,200 characters, the fact of the day at the end. */
const DAY_1121 = '2024年11月21日 木曜日。' + '朝は雨で、二人は駅前の喫茶店で待ち合わせた。'.repeat(52) + '夜、ミナは赤い傘を公園のベンチに忘れた。'

function mem(id: string, extra: Partial<MemoryFile> = {}): MemoryFile {
  return {
    id, type: 'user', title: id, description: '', content: `Fact ${id}`, tags: [],
    source: 'manual', createdAt: 1000, updatedAt: 1000, ...extra,
  }
}

beforeEach(() => {
  __setMemoryEmbedFn(async (texts) => texts.map(() => []))
  useMemoryStore.setState({ entries: [], forgotten: [], pinnedMemoryIds: [], lastInjection: {}, activeMemoryOwner: null, settings: { ...SETTINGS } })
})
afterEach(() => __setMemoryEmbedFn())

describe('1. a memory reaches the model whole, a cut is marked', () => {
  it('a Japanese story day of 1,200 characters goes whole, with the fact at its end', () => {
    expect([...DAY_1121].length).toBeGreaterThan(1100)
    const out = renderMemoryContext([mem('d', { content: DAY_1121 })], 8000, 8000)
    expect(out.text).toContain('赤い傘を公園のベンチに忘れた')
    expect(out.shortened).toEqual([])
  })

  it('a longer one is cut at the end of a sentence and the line says so', () => {
    const text = 'One sentence here. '.repeat(30) + 'The end.'
    const fit = fitMemoryText(text, 200)
    expect(fit.cut).toBe(true)
    expect(fit.text).toMatch(/here\. \[cut: \d+ of \d+ characters\]$/)
    // A point inside a number is not the end of a sentence.
    expect(fitMemoryText('Version 3.5 is out. ' + 'It runs 2.5x faster than 3.1 ever did on this box '.repeat(8), 120).text).not.toMatch(/\d\. \[cut/)
    const ja = fitMemoryText('雨が降った。'.repeat(60), 100)
    expect(ja.text).toMatch(/。 \[cut: \d+ of 360 characters\]$/)
  })

  it('the limit is the setting "Characters per memory", which nothing read before', () => {
    useMemoryStore.setState({ settings: { ...SETTINGS, maxMemoryChars: 400, memoryTokenBudget: 8000 } })
    useMemoryStore.setState({ entries: [mem('d', { content: DAY_1121 })] })
    const block = useMemoryStore.getState().getMemoriesForPrompt('', 262144)
    expect(block).toMatch(/\[cut: \d+ of \d+ characters\]/)
    expect(block).not.toContain('赤い傘')
    expect(memoryCharLimit(5)).toBe(200)
    expect(memoryCharLimit(undefined)).toBe(3000)
  })
})

describe('2. the preview is what the last request of this chat carried', () => {
  it('keeps the block per chat, with its question and project', async () => {
    useMemoryStore.setState({ entries: [
      mem('global', { title: 'Weather', content: 'It rained all day' }),
      mem('alpha', { title: 'Alpha plan', content: 'Alpha ships in May', scope: 'A' }),
    ] })
    await useMemoryStore.getState().getMemoryContextAsync('alpha plan', 8192, { scope: 'A', conversationId: 'c1' })
    await useMemoryStore.getState().getMemoryContextAsync('weather', 8192, { conversationId: 'c2' })
    const { lastInjection } = useMemoryStore.getState()
    expect(lastInjection.c1.sent).toEqual(['alpha'])
    expect(lastInjection.c1.text).toContain('Alpha ships in May')
    expect(lastInjection.c2.sent).toEqual(['global'])
    expect(lastInjection.c2.text).not.toContain('Alpha')
  })
})

describe('3. a hand-written memory is never rewritten by the extractor', () => {
  it('UPDATE on a hand-written target keeps its text and drops the automatic copy', () => {
    const targetId = useMemoryStore.getState().addMemory({ type: 'user', title: '11/21', description: '', content: DAY_1121, tags: [], source: 'manual' })
    const newId = useMemoryStore.getState().addMemory({ type: 'project', title: 'Nov 21', description: '', content: 'Mina forgot her umbrella.', tags: [], source: 'conv-1', sourceKind: 'chat' }, { auto: true })
    useMemoryStore.getState().applyWriteDecision({ action: 'UPDATE', targetId, mergedContent: 'Mina forgot an umbrella.' }, { newId })
    const entries = useMemoryStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toBe(DAY_1121)
    // No forget mark: the user deleted nothing.
    expect(useMemoryStore.getState().forgotten).toEqual([])
  })

  it('an entry from before sourceKind existed counts as hand-written', () => {
    expect(isHandWritten({ source: 'conv-9', sourceKind: undefined })).toBe(true)
    expect(isHandWritten({ source: 'manual', sourceKind: 'chat' })).toBe(true)
    expect(isHandWritten({ source: 'conv-9', sourceKind: 'voice' })).toBe(false)
  })
})

describe('4. a token budget of its own', () => {
  it('is the budget and the ceiling, up to half of the window', () => {
    const b = effectiveMemoryBudget(262144, null, 40000)
    expect(b.budgetTokens).toBe(40000)
    expect(b.maxMemories).toBe(MEMORY_COUNT_MAX)
    expect(memoryContextCeiling(262144, null, 40000)).toBe(40000)
    expect(memoryContextCeiling(32768, null, 40000)).toBe(16384)
    // Without it, the count rule of #238 stays as it was.
    expect(effectiveMemoryBudget(262144, 100).budgetTokens).toBe(15000)
    expect(memoryContextCeiling(262144, 100)).toBe(26214)
  })

  it('41 story days of about 1,200 characters all go with a budget of 60,000', () => {
    const days = Array.from({ length: 41 }, (_, i) => mem(`day${i}`, { content: DAY_1121, updatedAt: 1000 + i }))
    useMemoryStore.setState({ entries: days, settings: { ...SETTINGS, maxMemoriesOverride: 100, memoryTokenBudget: 60000 } })
    useMemoryStore.getState().getMemoriesForPrompt('', 262144, { conversationId: 'story' })
    const report = useMemoryStore.getState().lastInjection.story
    expect(report.sent).toHaveLength(41)
    expect(report.leftOut).toEqual([])
    expect(report.tokens).toBeLessThanOrEqual(report.budget)
  })
})

describe('5. Japanese, Chinese and Korean questions find their memory', () => {
  it('cuts text without spaces into pairs of characters', () => {
    const date = searchTerms('11月21日のことを教えて')
    expect(date).toEqual(expect.arrayContaining(['1月', '月2', '1日', '11月21日']))
    // Hiragana carries the grammar and two digits are in every date.
    expect(date).not.toContain('のこ')
    expect(date).not.toContain('11')
    expect(searchTerms('Qwen4-27Bについて調べて')).toEqual(expect.arrayContaining(['qwen4', '27b']))
    expect(searchTerms('서울에서 회의')).toEqual(expect.arrayContaining(['서울', '회의']))
    // English stays the words it was.
    expect(searchTerms('What does Mara drink?')).toEqual(['what', 'does', 'mara', 'drink'])
  })

  it('the keyword search picks the day the question is about', () => {
    useMemoryStore.setState({ entries: [
      mem('d20', { title: '2024年11月20日 水曜日', content: '二人は図書館で勉強した。' }),
      mem('d21', { title: '2024年11月21日 木曜日', content: DAY_1121 }),
      mem('other', { title: '東京旅行', content: '新幹線で東京へ行った。' }),
    ] })
    const block = useMemoryStore.getState().getMemoriesForPrompt('11月21日に傘はどうなった？', 8192, { conversationId: 'c' })
    expect(useMemoryStore.getState().lastInjection.c.sent[0]).toBe('d21')
    expect(block).toContain('2024年11月21日')
    expect(block).not.toContain('東京旅行')
  })

  it('BM25 scores a Japanese question when given the term cutter', () => {
    const docs = ['赤い傘を忘れた', '図書館で勉強した']
    expect(bm25Score('傘を忘れた日', docs[0], docs)).toBe(0)
    expect(bm25Score('傘を忘れた日', docs[0], docs, searchTerms)).toBeGreaterThan(0)
  })
})

describe('6. switches, persona and language, and nothing dropped without a word', () => {
  it('"Send memories to the model" off sends nothing, in every chat', async () => {
    useMemoryStore.setState({ entries: [mem('a', { title: 'Tea', content: 'Mara likes tea' })], settings: { ...SETTINGS, injectEnabled: false } })
    expect(useMemoryStore.getState().getMemoriesForPrompt('tea', 8192, { conversationId: 'c' })).toBe('')
    expect((await useMemoryStore.getState().getMemoryContextAsync('tea', 8192, { conversationId: 'c' })).text).toBe('')
    expect(useMemoryStore.getState().lastInjection.c.off).toBe('all')
  })

  it('a chat without a project ID still gets the global memories, unless its own switch is off', async () => {
    useMemoryStore.setState({ entries: [mem('a', { title: 'Tea', content: 'Mara likes tea' })] })
    expect((await useMemoryStore.getState().getMemoryContextAsync('tea', 8192, { conversationId: 'c' })).text).toContain('Mara likes tea')
    expect((await useMemoryStore.getState().getMemoryContextAsync('tea', 8192, { conversationId: 'c', chatOff: true })).text).toBe('')
    expect(useMemoryStore.getState().lastInjection.c.off).toBe('chat')
  })

  it('memories over the budget are named in the report', () => {
    const big = (id: string) => mem(id, { title: id, content: 'word '.repeat(400) })
    useMemoryStore.setState({ entries: [big('one'), big('two'), big('three')], settings: { ...SETTINGS, memoryTokenBudget: 1200 } })
    useMemoryStore.getState().getMemoriesForPrompt('', 262144, { conversationId: 'c' })
    const report = useMemoryStore.getState().lastInjection.c
    expect(report.sent.length).toBeGreaterThan(0)
    expect(report.leftOut.length).toBeGreaterThan(0)
    expect(report.sent.length + report.leftOut.length).toBe(3)
  })

  it('the extraction writes in the conversation language and knows the persona names', () => {
    const rules = extractionContextRules({ name: 'ミナ', text: 'あなたはミナ。親友のユウと一緒に暮らしている。' })
    const prompt = buildExtractionPrompt('傘を忘れた', '大丈夫だよ', '', rules)[0].content
    expect(prompt).toContain('in the language the user writes in')
    expect(prompt).toContain('"ミナ"')
    expect(prompt).toContain('ユウ')
    expect(extractionContextRules()).toHaveLength(1)
    expect(buildResolutionPrompt({ title: 't', content: 'c' }, [])[0].content).toContain('in the language of that existing memory')
  })

  it('the persona goes to the extraction only when the chat speaks as it', () => {
    const persona = { id: 'p1', name: 'Mina', icon: '', systemPrompt: 'You are Mina.', isBuiltIn: false } as Persona
    expect(extractionPersonaOf({ personaId: 'p1', personaEnabled: true }, [persona], undefined, true)).toEqual({ name: 'Mina', text: 'You are Mina.' })
    expect(extractionPersonaOf({ personaId: 'p1', personaEnabled: false }, [persona], undefined, true)).toBeUndefined()
    expect(extractionPersonaOf(undefined, [persona], undefined, true)).toBeUndefined()
  })
})

describe('7. pin "always send"', () => {
  it('a pinned memory goes with every question, before the search picks', async () => {
    useMemoryStore.setState({ entries: [
      mem('world', { title: 'Story world', content: 'The story is set in Sendai, 2024.' }),
      mem('tea', { title: 'Tea', content: 'Mara likes tea' }),
    ] })
    useMemoryStore.getState().setMemoryPinned('world', true)
    const block = useMemoryStore.getState().getMemoriesForPrompt('tea please', 8192, { conversationId: 'c' })
    expect(block).toContain('Sendai')
    expect(block).toContain('Mara likes tea')
    expect(useMemoryStore.getState().lastInjection.c.sent[0]).toBe('world')
    const async = await useMemoryStore.getState().getMemoryContextAsync('something unrelated entirely', 8192)
    expect(async.memoryIds).toEqual(['world'])
  })

  it('a pin goes with its memory when that is deleted, and an unknown id is not pinned', () => {
    useMemoryStore.setState({ entries: [mem('a')] })
    useMemoryStore.getState().setMemoryPinned('a', true)
    useMemoryStore.getState().setMemoryPinned('ghost', true)
    expect(useMemoryStore.getState().pinnedMemoryIds).toEqual(['a'])
    useMemoryStore.getState().removeMemory('a')
    expect(useMemoryStore.getState().pinnedMemoryIds).toEqual([])
  })
})
