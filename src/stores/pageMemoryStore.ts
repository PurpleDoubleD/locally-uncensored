/**
 * C22 (Discord 31.10.2026): what a page looked like when the
 * user left it, so going to Chat or Create and back finds it as it was.
 *
 * AppShell mounts one view at a time, so every `useState` of Models and
 * Settings started from scratch on each visit: the lane, Installed or Get new,
 * the search, the filters, the hits of a search, the open Settings sections
 * and where the page was scrolled to.
 *
 * Held for the session only, on purpose. A restart opening on the filters of
 * last week is a surprise; coming back from Chat to the page one just left is
 * the expectation. What already outlives a restart (the model category, the
 * Settings tab) stays where it is.
 */
import { create } from 'zustand'
import type { CivitAIModelResult, DiscoverModel } from '../api/discover'

export type ModelsTab = 'installed' | 'discover'
export type ModelsExtraRail = 'lora' | 'music' | null
export type DiscoverSubTab = 'uncensored' | 'mainstream'
export type DiscoverSizeTier = 'all' | 'fit' | 'ultra' | 'light' | 'middle' | 'highend'

/** One Discover lane's filters (Chat, Image, Video each keep their own). */
export interface DiscoverLaneMemory {
  subTab: DiscoverSubTab
  sizeTier: DiscoverSizeTier
  /** A category id from lib/discover-categories, 'all' for none. */
  category: string
  /** A sort id from lib/discover-categories. */
  sort: string
}

export const DEFAULT_DISCOVER_LANE: DiscoverLaneMemory = {
  subTab: 'mainstream',
  sizeTier: 'all',
  category: 'all',
  sort: 'recommended',
}

/** The last Hugging Face search of the Chat lane and its hits. */
export interface HfSearchMemory { query: string; results: DiscoverModel[] }

/** The last CivitAI search of one panel and its hits. */
export interface CivitaiSearchMemory { query: string; results: CivitAIModelResult[] }

interface PageMemoryState {
  modelsTab: ModelsTab
  modelsExtraRail: ModelsExtraRail
  modelsSearch: string
  discover: Record<string, DiscoverLaneMemory>
  hfSearch: HfSearchMemory | null
  civitai: Record<string, CivitaiSearchMemory>
  /** Settings sections the user opened or closed, by title. */
  settingsSections: Record<string, boolean>
  settingsScroll: number
  /** The LoRA list shows the hidden ones too (C41). */
  lorasShowHidden: boolean

  setModelsTab: (tab: ModelsTab) => void
  setModelsExtraRail: (rail: ModelsExtraRail) => void
  setModelsSearch: (q: string) => void
  setDiscoverLane: (lane: string, patch: Partial<DiscoverLaneMemory>) => void
  setHfSearch: (m: HfSearchMemory | null) => void
  setCivitai: (key: string, m: CivitaiSearchMemory) => void
  setSettingsSection: (title: string, open: boolean) => void
  forgetSettingsSection: (title: string) => void
  setSettingsScroll: (top: number) => void
  setLorasShowHidden: (v: boolean) => void
}

type PageMemoryData = Pick<PageMemoryState,
  'modelsTab' | 'modelsExtraRail' | 'modelsSearch' | 'discover' | 'hfSearch' | 'civitai'
  | 'settingsSections' | 'settingsScroll' | 'lorasShowHidden'>

/** A fresh session: nothing remembered yet. */
const FRESH: PageMemoryData = {
  // Get new is where most visits go first; the first visit of a session
  // still opens there, every later one opens where the user was.
  modelsTab: 'discover',
  modelsExtraRail: null,
  modelsSearch: '',
  discover: {},
  hfSearch: null,
  civitai: {},
  settingsSections: {},
  settingsScroll: 0,
  lorasShowHidden: false,
}

export const usePageMemoryStore = create<PageMemoryState>()((set) => ({
  ...FRESH,

  setModelsTab: (modelsTab) => set({ modelsTab }),
  setModelsExtraRail: (modelsExtraRail) => set({ modelsExtraRail }),
  setModelsSearch: (modelsSearch) => set({ modelsSearch }),
  setDiscoverLane: (lane, patch) => set((s) => ({
    discover: { ...s.discover, [lane]: { ...(s.discover[lane] ?? DEFAULT_DISCOVER_LANE), ...patch } },
  })),
  setHfSearch: (hfSearch) => set({ hfSearch }),
  setCivitai: (key, m) => set((s) => ({ civitai: { ...s.civitai, [key]: m } })),
  setSettingsSection: (title, open) => set((s) => ({ settingsSections: { ...s.settingsSections, [title]: open } })),
  forgetSettingsSection: (title) => set((s) => {
    if (!(title in s.settingsSections)) return s
    const next = { ...s.settingsSections }
    delete next[title]
    return { settingsSections: next }
  }),
  setSettingsScroll: (settingsScroll) => set({ settingsScroll }),
  setLorasShowHidden: (lorasShowHidden) => set({ lorasShowHidden }),
}))

/** Forget everything (a test starts each case as a fresh session). */
export function resetPageMemory(): void {
  usePageMemoryStore.setState(FRESH)
}
