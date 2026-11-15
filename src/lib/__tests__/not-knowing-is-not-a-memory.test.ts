import { describe, it, expect } from 'vitest'
import { onlyStatesAGap } from '../memory-gap'
import { parseExtractionResponse } from '../memory-extraction'

// CA bench AG10 (14.11.2026): the extraction had saved "User's preferred
// language for commit messages is unknown", and the model believed it over
// the real fact "writes commit messages in English".
describe('a memory that only says something is unknown', () => {
  it('is recognised in the shapes the extraction wrote', () => {
    expect(onlyStatesAGap({ content: "User's preferred language for commit messages is unknown", description: 'Unknown' })).toBe(true)
    expect(onlyStatesAGap({ content: 'Die Lieblingsfarbe ist noch unbekannt' })).toBe(true)
    expect(onlyStatesAGap({ content: 'Unknown' })).toBe(true)
    expect(onlyStatesAGap({ content: 'The deadline was not specified.' })).toBe(true)
  })

  it('leaves real facts alone, also ones with the word in them', () => {
    expect(onlyStatesAGap({ content: 'Schreibt Commit-Messages immer auf Englisch.' })).toBe(false)
    expect(onlyStatesAGap({ content: 'Likes the band Unknown Mortal Orchestra' })).toBe(false)
    expect(onlyStatesAGap({ content: 'Works on the project "unknown-tools"', description: 'Project name' })).toBe(false)
    expect(onlyStatesAGap({ content: 'Prefers clear, unknown-free specs' })).toBe(false)
  })

  it('is not saved by the extraction', () => {
    const r = parseExtractionResponse(JSON.stringify({
      shouldSave: true,
      memories: [
        { type: 'user', title: "User's preferred editor", description: 'Helix', content: "User's preferred editor is Helix" },
        { type: 'user', title: 'Commit language', description: 'Unknown', content: "User's preferred language for commit messages is unknown" },
      ],
    }))
    expect(r.memories.map((m) => m.description)).toEqual(['Helix'])
  })
})
