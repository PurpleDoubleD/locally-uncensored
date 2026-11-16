/**
 * Rename in the Character area (3.1.0): the user's own name for a LoRA
 * character is a label on this computer, by the key of the list.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { cleanCharacterName, useCharacterNames, withCharacterNames } from '../character-names'

beforeEach(() => useCharacterNames.setState({ names: {} }))

describe('names the user gave', () => {
  it('a name is trimmed, keeps single spaces and stays under 40 characters', () => {
    expect(cleanCharacterName('  Mira   Vale ')).toBe('Mira Vale')
    expect(cleanCharacterName('x'.repeat(60))).toHaveLength(40)
  })

  it('a rename shows in the list, the other characters keep their names', () => {
    useCharacterNames.getState().rename('cloud:1', ' Greta ')
    const list = withCharacterNames([{ key: 'cloud:1', name: 'char one' }, { key: 'local:a', name: 'a' }], useCharacterNames.getState().names)
    expect(list.map((c) => c.name)).toEqual(['Greta', 'a'])
  })

  it('an empty name and forget both give the character its own name back', () => {
    const s = useCharacterNames.getState()
    s.rename('cloud:1', 'Greta')
    s.rename('cloud:1', '   ')
    expect(useCharacterNames.getState().names).toEqual({})
    s.rename('cloud:1', 'Greta')
    s.forget('cloud:1')
    expect(useCharacterNames.getState().names).toEqual({})
  })
})
