import { create } from 'zustand'

/**
 * Text for the composer to take over once, from outside it (CA U4: after
 * "Rewind to here" the rewound message goes back into the field, like the
 * large coding tools do, so it can be changed and sent again). Not persisted:
 * the composer has its own drafts (lib/chat-drafts.ts).
 */
interface ComposerFillState {
  fill: { text: string; n: number } | null
  put: (text: string) => void
}

export const useComposerFillStore = create<ComposerFillState>((set, get) => ({
  fill: null,
  put: (text) => set({ fill: { text, n: (get().fill?.n ?? 0) + 1 } }),
}))
