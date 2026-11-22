/**
 * "Start here" recommends what this machine can fetch (persona walk,
 * 09.10.2026, Fund 18): with the LU Engine alone the first row recommended an
 * entry "(Ollama)". The rule holds on every platform.
 *
 * Run: npx vitest run src/lib/__tests__/start-here-picks.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mayBeStartHerePick, needsOllama } from '../start-here-picks'
import { ollamaOnlyDownloadBlock } from '../text-download-target'
import { getMainstreamTextModels, getUncensoredTextModels } from '../../api/discover'

const OLLAMA_ONLY = { name: 'Qwen 3.8 27B (Ollama)', ollamaModel: 'qwen3.8' }
const GGUF: { name: string; downloadUrl: string; ollamaModel?: string } = { name: 'Qwen 3.8 27B', downloadUrl: 'https://huggingface.co/x/y/resolve/main/z.gguf' }

describe('a first pick', () => {
  it('without Ollama is never an entry only Ollama can pull', () => {
    expect(mayBeStartHerePick(OLLAMA_ONLY, { ollamaEnabled: false })).toBe(false)
    expect(mayBeStartHerePick(GGUF, { ollamaEnabled: false })).toBe(true)
  })

  it('COUNTER-CHECK: with Ollama it may be', () => {
    expect(mayBeStartHerePick(OLLAMA_ONLY, { ollamaEnabled: true })).toBe(true)
    expect(mayBeStartHerePick(GGUF, { ollamaEnabled: true })).toBe(true)
  })

  it('is refused exactly where Get would refuse the entry', () => {
    for (const ollamaEnabled of [true, false]) {
      const getRefuses = ollamaOnlyDownloadBlock(OLLAMA_ONLY.name, ollamaEnabled) !== null
      expect(mayBeStartHerePick(OLLAMA_ONLY, { ollamaEnabled })).toBe(!getRefuses)
    }
  })

  it('is never Inkling 2 Mini, with or without Ollama, and the list below keeps it', () => {
    const inkling = getMainstreamTextModels().filter((m) => /^Inkling 2 Mini/.test(m.name))
    expect(inkling.length).toBeGreaterThan(1)
    for (const m of inkling) {
      expect(mayBeStartHerePick(m, { ollamaEnabled: true }), m.name).toBe(false)
      expect(mayBeStartHerePick(m, { ollamaEnabled: false }), m.name).toBe(false)
    }
  })

  it('COUNTER-CHECK: no other catalogue entry is held back', () => {
    const others = [...getMainstreamTextModels(), ...getUncensoredTextModels()].filter((m) => !/^Inkling 2 Mini/.test(m.name))
    expect(others.length).toBeGreaterThan(0)
    for (const m of others) expect(m.notFirstPick, m.name).toBeUndefined()
  })

  it('asks no platform', () => {
    const rule = readFileSync(resolve(__dirname, '../start-here-picks.ts'), 'utf-8')
    expect(rule).not.toMatch(/isMacOS|isMlxImageHost|hostIsMac|mac:/)
  })
})

describe('the catalogue', () => {
  it('names every entry "(Ollama)" by its Ollama tag, so the rule sees it', () => {
    const named = [...getMainstreamTextModels(), ...getUncensoredTextModels()].filter((m) => /\(Ollama\)/.test(m.name))
    expect(named.length).toBeGreaterThan(0)
    for (const m of named) expect(needsOllama(m), m.name).toBe(true)
  })

  it('and the page asks the rule before it scores a pick, with the answer Get uses', () => {
    const page = readFileSync(resolve(__dirname, '../../components/models/DiscoverModels.tsx'), 'utf-8')
    expect(page).toContain("if (!mayBeStartHerePick(rep, { ollamaEnabled: !!providers.ollama?.enabled })) return { g, score: -1 }")
    expect(page).toContain('ollamaOnlyDownloadBlock(model.name, !!providers.ollama?.enabled)')
    // A pick needs a score above 1.
    expect(page).toContain('scoredGroups.slice(0, 3).filter(s => s.score > 1)')
  })
})
