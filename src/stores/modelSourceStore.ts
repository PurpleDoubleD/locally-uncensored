import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { isModelSourcePage, modelSourceKey, sourcePageFromDownloadUrl } from '../lib/model-source'

/** Plenty for every model file a user keeps; the oldest go first. */
const LIMIT = 2000

interface ModelSourceState {
  /** File name (lower case, no folder) → its Hugging Face or CivitAI page. */
  pages: Record<string, string>
  /** Writes the page down. A page that is not https Hugging Face or CivitAI
   *  is dropped, and so is an empty one: it never overwrites a known page. */
  record: (filename: string, page: string | null | undefined) => void
  pageFor: (filename: string) => string | null
}

/**
 * D1: the source page of each downloaded model file, kept across restarts.
 * Its own store, not the download record: that one is trimmed to the last
 * downloads and is about resuming, not about what is installed.
 */
export const useModelSourceStore = create<ModelSourceState>()(persist((set, get) => ({
  pages: {},
  record: (filename, page) => {
    if (!filename || !page || !isModelSourcePage(page)) return
    const key = modelSourceKey(filename)
    set((s) => {
      if (s.pages[key] === page) return s
      const next = { ...s.pages }
      delete next[key]
      next[key] = page
      const keys = Object.keys(next)
      for (const k of keys.slice(0, Math.max(0, keys.length - LIMIT))) delete next[k]
      return { pages: next }
    })
  },
  pageFor: (filename) => {
    const page = get().pages[modelSourceKey(filename)]
    return page && isModelSourcePage(page) ? page : null
  },
}), {
  name: 'locally-uncensored-model-sources',
  storage: safeJSONStorage(),
  version: 1,
  partialize: (s) => ({ pages: s.pages }) as ModelSourceState,
  // Version 1 is the first: nothing older to carry over.
  migrate: (persisted) => persisted as ModelSourceState,
}))

/** Called by both download starts: the page the address itself shows. */
export function recordSourceFromDownload(filename: string, downloadUrl: string): void {
  useModelSourceStore.getState().record(filename, sourcePageFromDownloadUrl(downloadUrl))
}
