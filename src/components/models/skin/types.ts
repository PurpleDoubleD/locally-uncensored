// What a face of the Model Manager has to bring. Everything in here is look:
// layout pieces, class chains and icon sizes. The pieces get their words,
// their numbers and their handlers from the page, which owns the rules.
import type { ComponentType, KeyboardEvent, ReactNode, RefObject } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { CounterView } from '../../../lib/inventory-counter'
import type { BundleTileProps, ModelTileProps } from '../ModelTiles'
import type { LoraManagerProps } from '../LoraManager'
import type { ModelSkinName } from './which'

/** The hover text of the GGUF file button, the same in both faces (D17). */
export const ADD_GGUF_TITLE = 'Use a GGUF file from your drive as a chat model on the LU Engine'

export type RailKey = 'text' | 'image' | 'video' | 'lora' | 'music'
export type ModelsTab = 'installed' | 'discover'

export interface RailEntry {
  key: RailKey
  label: string
  Icon: LucideIcon
  active: boolean
  /** How many of this lane are installed, or that the count is still out. */
  badge: CounterView
  onPick: () => void
}

/** The page around the views: the rail, the head with search, refresh and
 *  pull, and the switch between Get new and Installed. */
export interface ManagerFrameProps {
  rail: RailKey
  entries: RailEntry[]
  onBack: () => void
  tab: ModelsTab
  onTab: (tab: ModelsTab) => void
  installedBadge: CounterView
  searchRef: RefObject<HTMLInputElement | null>
  search: {
    value: string
    onChange: (value: string) => void
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  }
  onRefresh: () => void
  /** Present where there is something to pull into (Ollama, chat lane). */
  onPull?: () => void
  /** D17: pick a GGUF file from the drive for the LU Engine (chat lane). */
  onAddFile?: () => void
  children: ReactNode
}

/** Which empty state this is. The classic face gave each its own measure. */
export type EmptyKind = 'engine-down' | 'nothing-installed' | 'lane-empty'

export interface EmptyStateProps {
  kind: EmptyKind
  Icon: LucideIcon
  title: string
  children?: ReactNode
  action: { Icon: LucideIcon; label: string; onClick: () => void }
}

/** Where a heading stands. Its words come from the page. */
export type HeadPlace = 'installed' | 'start-here' | 'all' | 'hf-results' | 'tier' | 'addons'

export interface HeadProps {
  place: HeadPlace
  title: string
  Icon?: LucideIcon
  count?: number
  note?: string
}

export interface FilterBarProps {
  /** The Mainstream / Unfiltered switch. */
  catalogue: ReactNode
  /** The size filter, or nothing where the lane has none. */
  sizes: ReactNode
  /** What the models are for (Agent, Coding, Edit, Music, …) and how they are
   *  sorted ("Better Categories", Discord 09.11.2026). Its own row in both
   *  faces: it is the widest of the controls and wraps on its own. */
  categories?: ReactNode
  hardware: { vramGb: number | null; ramGb: number | null; sharedMemory: boolean }
  /** The line that says a pick moved the chat backend. Always in the tree. */
  switchBar: ReactNode
  /** Whether the legend of the capability glyphs stands under the bar. */
  legend: boolean
}

/** The look of an installed row (ModelCard). Same structure in both faces. */
export interface CardLook {
  row: (isActive: boolean) => string
  typeIcon: (type: 'text' | 'image' | 'video', isActive: boolean) => string
  typeIconSize: number
  name: string
  stopped: string
  active: string
  /** A14: the quiet mark of a copy LU removed the refusals from. */
  mark: string
  meta: string
  use: string
  useSpinnerSize: number
  info: string
  remove: string
  /** The Bench button of a chat row (ModelBenchmark). */
  bench: string
}

export interface ModelSkin {
  name: ModelSkinName
  ManagerFrame: ComponentType<ManagerFrameProps>
  QuietLine: ComponentType<{ children: ReactNode }>
  EmptyState: ComponentType<EmptyStateProps>
  Head: ComponentType<HeadProps>
  FilterBar: ComponentType<FilterBarProps>
  ModelTile: ComponentType<ModelTileProps>
  BundleTile: ComponentType<BundleTileProps>
  LoraManager: ComponentType<LoraManagerProps>
  card: CardLook
  cls: {
    /** Distance between a heading and the block it heads. */
    group: string
    /** The wrapper that carries a tile's entrance. */
    tileWrap: string | undefined
    foldedRows: string
    providerHeading: string
    installedNoMatch: string
    sizeFilterEmpty: string
    searchEmpty: string
    loraDiscover: string
    loraDiscoverNote: string
    addonsMessage: string
  }
}
