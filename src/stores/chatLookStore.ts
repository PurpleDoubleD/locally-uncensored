import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import {
  DEFAULT_LOOK, clampZoom, normalizeBackground, normalizeLook,
  type ChatBackground, type ChatLook,
} from '../lib/chat-look'

/**
 * The chat look (lib/chat-look.ts), the reading zoom and the background
 * pictures per chat and per persona. Persisted as `lu-chat-look` and carried
 * by the store backup (lib/store-backup.ts STORE_KEYS).
 *
 * The pictures themselves are NOT in here: a background is a reference
 * (`lu-attachment:v1:<sha256>`) into the attachment store (native files on
 * the desktop, IndexedDB in a browser), so a 400 kB JPEG never lands in
 * localStorage. Because the backup holds this store, the attachment garbage
 * collector (chat_attachments.rs) sees the reference and keeps the file.
 */
interface ChatLookState {
  look: ChatLook
  /** Reading zoom of the transcript (C42), 0.7 to 2. */
  zoom: number
  /** Key `chat:<id>` or `persona:<id>` (lib/chat-look bgKeyFor*). */
  backgrounds: Record<string, ChatBackground>
  setLook: (patch: Partial<ChatLook>) => void
  replaceLook: (look: unknown) => void
  resetLook: () => void
  setZoom: (zoom: number) => void
  setBackground: (key: string, bg: Partial<ChatBackground> & { ref: string }) => void
  patchBackground: (key: string, patch: Partial<Omit<ChatBackground, 'ref'>>) => void
  removeBackground: (key: string) => void
}

export const useChatLookStore = create<ChatLookState>()(
  persist(
    (set, get) => ({
      look: DEFAULT_LOOK,
      zoom: 1,
      backgrounds: {},
      setLook: (patch) => set({ look: normalizeLook({ ...get().look, ...patch }) }),
      replaceLook: (look) => set({ look: normalizeLook(look) }),
      resetLook: () => set({ look: DEFAULT_LOOK }),
      setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
      setBackground: (key, bg) => {
        const clean = normalizeBackground(bg)
        if (!clean) return
        set({ backgrounds: { ...get().backgrounds, [key]: clean } })
      },
      patchBackground: (key, patch) => {
        const now = get().backgrounds[key]
        if (!now) return
        const clean = normalizeBackground({ ...now, ...patch })
        if (clean) set({ backgrounds: { ...get().backgrounds, [key]: clean } })
      },
      removeBackground: (key) => {
        const next = { ...get().backgrounds }
        delete next[key]
        set({ backgrounds: next })
      },
    }),
    {
      name: 'lu-chat-look',
      storage: safeJSONStorage(),
      partialize: (s) => ({ look: s.look, zoom: s.zoom, backgrounds: s.backgrounds }) as ChatLookState,
      merge: (persisted, current) => {
        const p = (persisted && typeof persisted === 'object' ? persisted : {}) as Partial<ChatLookState>
        const backgrounds: Record<string, ChatBackground> = {}
        if (p.backgrounds && typeof p.backgrounds === 'object') {
          for (const [k, v] of Object.entries(p.backgrounds)) {
            const clean = v && typeof v === 'object' ? normalizeBackground(v) : null
            if (clean && /^(chat|persona):.+/.test(k)) backgrounds[k] = clean
          }
        }
        return {
          ...current,
          look: normalizeLook(p.look),
          zoom: clampZoom(typeof p.zoom === 'number' ? p.zoom : 1),
          backgrounds,
        }
      },
    },
  ),
)
