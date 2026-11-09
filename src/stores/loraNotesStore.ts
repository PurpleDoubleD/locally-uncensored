/**
 * C41 (Discord 03.11.2026): manage the LoRAs, not only list
 * them. A name of one's own, a note (trigger words, the strength that works),
 * and hiding the ones that are not wanted in the LoRA stack right now.
 *
 * Kept by LU beside the file, never in it: the file keeps its name, so a
 * saved Create setting, a workflow and ComfyUI itself still find it, and a
 * LoRA of the user's own folder is never touched. Keyed by the name ComfyUI
 * lists (with its subfolder), which is what Create sends.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'

export interface LoraNote {
  /** The name LU shows. Empty or absent: the file name. */
  label?: string
  note?: string
  hidden?: boolean
}

interface LoraNotesState {
  notes: Record<string, LoraNote>
  setNote: (name: string, patch: Partial<LoraNote>) => void
  /** When a LoRA file is deleted its note goes with it. */
  forget: (name: string) => void
}

/** A note without content is no note: it is removed instead of kept empty. */
function clean(n: LoraNote): LoraNote | null {
  const label = n.label?.trim() || undefined
  const note = n.note?.trim() || undefined
  const hidden = n.hidden ? true : undefined
  if (!label && !note && !hidden) return null
  return { ...(label ? { label } : {}), ...(note ? { note } : {}), ...(hidden ? { hidden } : {}) }
}

export const useLoraNotesStore = create<LoraNotesState>()(
  persist(
    (set) => ({
      notes: {},
      setNote: (name, patch) => set((s) => {
        const next = { ...s.notes }
        const merged = clean({ ...s.notes[name], ...patch })
        if (merged) next[name] = merged
        else delete next[name]
        return { notes: next }
      }),
      forget: (name) => set((s) => {
        if (!(name in s.notes)) return s
        const next = { ...s.notes }
        delete next[name]
        return { notes: next }
      }),
    }),
    {
      name: 'lu-lora-notes',
      storage: safeJSONStorage(),
      version: 1,
      partialize: (s) => ({ notes: s.notes }) as LoraNotesState,
      // Version 1 is the first: nothing older to carry over.
      migrate: (persisted) => persisted as LoraNotesState,
    },
  ),
)

/** The name a LoRA is shown by: the user's, else what the caller had. */
export function loraLabel(name: string, fallback: string, notes: Readonly<Record<string, LoraNote>>): string {
  return notes[name]?.label || fallback
}

/**
 * The rows of a LoRA list with the user's names, notes and hidden ones
 * applied. A hidden LoRA that is ticked in the stack stays, so it can be
 * unticked; `showHidden` brings all of them back (the Models list's switch).
 */
export function applyLoraNotes<T extends { name: string; label: string }>(
  rows: readonly T[],
  notes: Readonly<Record<string, LoraNote>>,
  opts: { picked?: ReadonlySet<string>; showHidden?: boolean } = {},
): (T & { note?: string; hidden: boolean })[] {
  return rows
    .filter((r) => opts.showHidden || !notes[r.name]?.hidden || opts.picked?.has(r.name))
    .map((r) => {
      const n = notes[r.name]
      return { ...r, label: n?.label || r.label, ...(n?.note ? { note: n.note } : {}), hidden: !!n?.hidden }
    })
}
