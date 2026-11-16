// Names the user gave characters on this computer (3.1.0, Rename in the
// Character area). A photo character is renamed where it is stored
// (lib/saved-characters). A LoRA character cannot be: the cloud has no rename
// call, and a local file is named after its trigger word, which the training
// learned. So the new name is a label here, by the key of the list
// (lib/create/character-hub HubCharacter.key); the trigger word stays.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../storage-quota'

export const MAX_CHARACTER_LABEL = 40

/** A name as it is kept: trimmed, single spaces, at most 40 characters. */
export function cleanCharacterName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_CHARACTER_LABEL)
}

interface CharacterNames {
  names: Record<string, string>
  /** An empty name takes the label away again. */
  rename: (key: string, name: string) => void
  forget: (key: string) => void
}

export const useCharacterNames = create<CharacterNames>()(
  persist(
    (set) => ({
      names: {},
      rename: (key, name) => set((s) => {
        const clean = cleanCharacterName(name)
        const { [key]: _old, ...rest } = s.names
        return { names: clean ? { ...rest, [key]: clean } : rest }
      }),
      forget: (key) => set((s) => {
        const { [key]: _gone, ...rest } = s.names
        return { names: rest }
      }),
    }),
    { name: 'lu-character-names', storage: safeJSONStorage() },
  ),
)

/** The list with the user's own names put in. */
export function withCharacterNames<T extends { key: string; name: string }>(list: readonly T[], names: Record<string, string>): T[] {
  return list.map((c) => (names[c.key] ? { ...c, name: names[c.key] } : c))
}
