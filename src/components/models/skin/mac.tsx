// The Mac face of the Model Manager: the redesign of 08.10.2026. A narrow
// rail like the one in Settings, the lane's name as the heading of the page,
// Get new and Installed as text tabs, one tile surface (`.lu-tile`) and one
// tinted action per tile (`.lu-tonal`).
//
// Only macOS draws it (skin/which.ts). Windows and Linux keep skin/classic.
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, FilePlus, RefreshCw, Search, X as XIcon } from 'lucide-react'
import { useGraphicsMemoryGb } from '../../../hooks/useGraphicsMemory'
import { getTotalRamGb } from '../../../lib/hardware'
import { isMacOS } from '../../../api/backend'
import { ICON_MD, ICON_SM } from '../../ui/icon-size'
import { BundleTile, CapLegend, HardwareChip, HardwareFoot, ModelTile } from '../ModelTiles'
import { ModelEmptyState, ModelQuietLine, SectionHead } from '../ModelPageParts'
import { LoraManager } from '../LoraManager'
import { ADD_GGUF_TITLE } from './types'
import type {
  EmptyStateProps, FilterBarProps, HeadProps, ManagerFrameProps, ModelSkin, RailKey,
} from './types'

/** What stands at the top of the pane for each rail entry: the name of the
 *  lane and one sentence about it. `here` is "this Mac" or "your computer". */
const LANE_HEAD: Record<RailKey, { title: string; text: (here: string) => string }> = {
  text: { title: 'Chat models', text: (here) => `The models you chat with. They run on ${here}.` },
  image: { title: 'Image models', text: (here) => `The models that make your images. They run on ${here}.` },
  video: { title: 'Video models', text: (here) => `The models that make your videos. They run on ${here}.` },
  // The Mac's LoRAs go to its image engine alone; its video engine takes none.
  lora: { title: 'LoRAs', text: () => 'Small add-ons that give an image model a style or a subject.' },
  music: { title: 'Music models', text: (here) => `The model that makes your tracks, songs with vocals or instrumentals. It runs on ${here}.` },
}

// One accent for all of them. The active entry is marked the way the Settings
// navigation marks its own, the accent bar and the soft accent ground, so the
// two side lists of the app read as one idiom. No colour per category: that
// was ruled out on 2026-07-17 and still holds.

/** An entry of the rail. The bar on the left is always there and transparent
 *  at rest, so nothing shifts when the selection moves. */
const railItem = (active: boolean) =>
  'flex items-center justify-center lg:justify-start gap-2 h-[var(--control-h-md)] lg:pl-2 lg:pr-2.5 '
  + 'rounded-md border-l-2 t-control transition-colors '
  + (active
    ? 'bg-lu-accent-soft border-l-lu-accent-edge dark:border-l-lu-accent text-gray-900 dark:text-white'
    : 'border-l-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04]')

/** Get new and Installed: the two views of a lane, as tabs on one rule. The
 *  accent line under the open one sits on that rule. Each keeps its width and
 *  its one line; at 760 px the search field is what gives way. */
const viewTab = (open: boolean) =>
  '-mb-px inline-flex items-center gap-1.5 h-[var(--control-h-md)] border-b-2 t-control whitespace-nowrap transition-colors '
  + (open
    ? 'border-lu-accent-edge dark:border-lu-accent text-gray-900 dark:text-white'
    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200')

/** The mark a counter wears while it has nothing counted to show. Not a 0:
 *  a 0 next to a card that reads Installed is a wrong answer, and this one
 *  stood for five seconds on the real box (Befund 2, 2026-08-29). */
function CountingDots({ label }: { label: string }) {
  return (
    <span
      className="t-micro font-normal opacity-60 animate-pulse"
      role="status"
      aria-label={label}
      title={label}
    >
      &middot;&middot;&middot;
    </span>
  )
}

function MacManagerFrame({ rail, entries, onBack, tab, onTab, installedBadge, searchRef, search, onRefresh, onPull, onAddFile, children }: ManagerFrameProps) {
  // What the verdicts of this page are measured against, for the foot of the
  // rail. The same two readings the catalogue takes (DiscoverModels), so the
  // rail and a tile cannot name two different machines.
  const sharedMemory = isMacOS()
  const graphicsGb = useGraphicsMemoryGb()
  const [ramGb, setRamGb] = useState<number | null>(null)
  useEffect(() => {
    getTotalRamGb().then((r) => { if (r > 0) setRamGb(r) }).catch(() => {})
  }, [])
  const laneHead = LANE_HEAD[rail]
  // Another lane or another view is another page: it starts at its top. The
  // pane kept its scroll position, so a click on Image from the middle of the
  // chat list opened the image list somewhere in its middle, with the
  // heading, the tabs and the filters out of sight (persona walk, 09.10.2026).
  const pane = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (pane.current) pane.current.scrollTop = 0
  }, [rail, tab])

  return (
    <>
      {/* The rail: back, the lanes, and at its foot the machine every verdict
          on this page is measured against. Icons only below lg. */}
      <aside
        aria-label="Model lanes"
        className="shrink-0 w-12 lg:w-44 flex flex-col border-r border-gray-200 dark:border-white/[0.06] px-1.5 lg:px-2.5 py-4 lg:py-5"
      >
        <div className="flex items-center justify-center lg:justify-start gap-1.5 mb-4">
          <button
            onClick={onBack}
            className="lu-control lu-control--icon"
            title="Back to chat"
            aria-label="Back to chat"
          >
            <ArrowLeft size={ICON_MD} />
          </button>
          <p className="hidden lg:block t-title text-gray-900 dark:text-white">Models</p>
        </div>

        <p className="hidden lg:block px-2 mb-1.5 t-label text-gray-500 dark:text-gray-400">Library</p>
        <div className="flex flex-col gap-0.5">
          {entries.map(({ key, label, Icon, active, badge, onPick }) => (
            <button
              key={key}
              onClick={onPick}
              title={label}
              aria-pressed={active}
              className={railItem(active)}
            >
              <Icon size={ICON_MD} className={`shrink-0 ${active ? 'text-lu-accent-ink dark:text-lu-accent' : ''}`} />
              {/* Label and count are blocks, not inline: that is what puts
                  the space into the name a screen reader says, "Image 2". */}
              <span className="hidden lg:block">{label}</span>
              {badge.kind === 'loading' ? (
                <span className="hidden lg:block ml-auto">
                  <CountingDots label={key === 'lora' ? 'Counting installed LoRAs' : `Counting installed ${label.toLowerCase()} models`} />
                </span>
              ) : badge.value > 0 ? (
                <span className="hidden lg:block ml-auto t-micro font-normal tabular-nums text-gray-500 dark:text-gray-400">{badge.value}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="mt-auto hidden lg:block space-y-2.5 px-2 pt-4 border-t border-gray-200 dark:border-white/[0.06]">
          <HardwareFoot vramGb={graphicsGb} ramGb={ramGb} sharedMemory={sharedMemory} />
          <p className="t-micro leading-relaxed text-gray-500 dark:text-gray-400">
            Models run 100% on {sharedMemory ? 'this Mac' : 'your computer'}.
          </p>
        </div>
      </aside>

      {/* Content */}
      <div ref={pane} className="flex-1 min-w-0 overflow-y-auto scrollbar-thin" data-testid="models-pane">
        {/* Full pane width like the chat area, no centered max-w cap, so wide
            windows get more grid columns instead of side gutters. */}
        <div className="p-4 lg:p-6 space-y-4">
          {/* Head: what this lane is, and on the right what works on the whole
              lane (search, refresh, pull). */}
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <h1 className="t-display text-gray-900 dark:text-white">{laneHead.title}</h1>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {laneHead.text(sharedMemory ? 'this Mac' : 'your computer')}
              </p>
            </div>

            {/* Always-visible search. Up to 14rem wide; in a narrow window it
                shrinks before anything beside it wraps. */}
            <div className="relative w-56 min-w-24 shrink">
              <Search size={ICON_SM} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                ref={searchRef}
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                onKeyDown={search.onKeyDown}
                placeholder={rail === 'lora' ? 'Search LoRAs…' : 'Search models…'}
                aria-label={rail === 'lora' ? 'Search LoRAs' : 'Search models'}
                className="w-full h-[var(--control-h-sm)] pl-7 pr-6 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 t-micro text-gray-900 dark:text-white placeholder-gray-500"
              />
              {search.value && (
                <button
                  onClick={() => search.onChange('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <XIcon size={ICON_SM} />
                </button>
              )}
            </div>

            <button
              onClick={onRefresh}
              className="lu-control lu-control--icon"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw size={ICON_SM} />
            </button>
            {/* Pull fetches an Ollama chat model by name. On the media and
                LoRA rails it has nothing to pull into. */}
            {onPull && (
              <button
                onClick={onPull}
                className="lu-control lu-control--outline"
                title="Pull any Ollama model by name"
              >
                <Download size={ICON_SM} /> Pull
              </button>
            )}
            {onAddFile && (
              <button
                onClick={onAddFile}
                className="lu-control lu-control--outline"
                title={ADD_GGUF_TITLE}
              >
                <FilePlus size={ICON_SM} /> GGUF file
              </button>
            )}
          </div>

          {/* Get new / Installed */}
          <div className="flex items-end gap-5 border-b border-gray-200 dark:border-white/[0.07]" data-models-view>
            <button
              onClick={() => onTab('discover')}
              aria-pressed={tab === 'discover'}
              className={viewTab(tab === 'discover')}
            >
              Get new
            </button>
            <button
              onClick={() => onTab('installed')}
              aria-pressed={tab === 'installed'}
              className={viewTab(tab === 'installed')}
            >
              Installed
              {installedBadge.kind === 'loading' ? (
                <CountingDots label="Counting installed models" />
              ) : (
                <span className="t-micro font-normal tabular-nums text-gray-500 dark:text-gray-400">{installedBadge.value}</span>
              )}
            </button>
          </div>

          {children}
        </div>
      </div>
    </>
  )
}

/** The single action of an empty lane. This is the one place on the page
 *  where a `.lu-primary` stands, because the surface has exactly one. */
function MacEmptyState({ Icon, title, children, action }: EmptyStateProps) {
  return (
    <ModelEmptyState
      icon={<Icon size={28} />}
      title={title}
      action={(
        <button onClick={action.onClick} className="lu-primary lu-control">
          <action.Icon size={ICON_SM} /> {action.label}
        </button>
      )}
    >
      {children}
    </ModelEmptyState>
  )
}

function MacHead({ place, title, Icon, count, note }: HeadProps) {
  if (place === 'tier') {
    return (
      <div className="col-span-full pt-2" data-tier-group={title}>
        <SectionHead title={title} />
      </div>
    )
  }
  if (place === 'all') {
    return (
      <div className="pt-1">
        <SectionHead title={title} />
      </div>
    )
  }
  return (
    <SectionHead
      level={place === 'installed' ? 'h2' : 'h3'}
      icon={Icon ? <Icon size={ICON_SM} /> : undefined}
      title={title}
      count={count}
      note={note}
    />
  )
}

/** One row since 08.10.2026: which catalogue, then how big. They stood in two
 *  rows with the hardware chip floating beside the first one. Narrow windows
 *  break the row between the two groups. */
function MacFilterBar({ catalogue, sizes, categories, hardware, switchBar, legend }: FilterBarProps) {
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {catalogue}
        {sizes}
        {/* From lg up this reading stands at the foot of the Models rail. */}
        <div className="ml-auto lg:hidden">
          <HardwareChip vramGb={hardware.vramGb} ramGb={hardware.ramGb} sharedMemory={hardware.sharedMemory} />
        </div>
      </div>

      {categories && <div className="mt-2">{categories}</div>}

      {/* The box of the switch line is always in the tree (it is a live
          region), so it gets its distance only while it holds a sentence. As a
          child of the spaced column it left a gap of two row distances under
          the filters on every visit. */}
      <div className="[&>:not(:empty)]:mt-3">
        {switchBar}
      </div>

      {legend && <CapLegend sharedMemory={hardware.sharedMemory} className="mt-3" />}
    </div>
  )
}

export const macSkin: ModelSkin = {
  name: 'mac',
  ManagerFrame: MacManagerFrame,
  QuietLine: ModelQuietLine,
  EmptyState: MacEmptyState,
  Head: MacHead,
  FilterBar: MacFilterBar,
  ModelTile,
  BundleTile,
  LoraManager,
  card: {
    // The surface is the tile recipe of the page. The row in use carries the
    // accent, edge and ground, where it carried a blue ring: blue was a fourth
    // colour on this page and stood for nothing else in the app.
    row: (isActive) => `lu-tile flex items-center gap-3 px-3.5 py-2 cursor-pointer group ${isActive ? 'lu-tile--active' : ''}`,
    // One tone for the three glyphs. They used to be blue, purple and green, a
    // colour per category, on a page that marks nothing else by category; the
    // list is already the lane the rail selected.
    typeIcon: (_type, isActive) => `shrink-0 ${isActive ? 'text-lu-accent-ink dark:text-lu-accent' : 'text-gray-400 dark:text-gray-500'}`,
    typeIconSize: ICON_SM,
    name: 'flex-1 min-w-0 flex text-xs text-gray-900 dark:text-gray-100 font-medium',
    stopped: 'shrink-0 t-label text-gray-500 dark:text-gray-400',
    active: 'shrink-0 t-label text-lu-accent-ink dark:text-lu-accent',
    mark: 'shrink-0 t-label text-gray-500 dark:text-gray-400',
    meta: 'hidden md:flex items-center gap-1.5 shrink-0 t-micro text-gray-500 dark:text-gray-400 lu-hud-num',
    // Use is the action of this row, so it takes the tint the tiles give
    // their Get (index.css, `.lu-tonal`).
    use: 'lu-tonal mr-1',
    useSpinnerSize: ICON_SM,
    info: 'lu-control lu-control--icon',
    remove: 'lu-control lu-control--icon',
    bench: 'lu-control lu-control--outline',
  },
  cls: {
    group: 'space-y-2',
    tileWrap: 'h-full',
    foldedRows: 'pt-0.5 t-micro text-gray-500 dark:text-gray-400',
    providerHeading: 'pt-2 t-label font-medium text-gray-500 dark:text-gray-400',
    installedNoMatch: 'text-center text-xs text-gray-500 dark:text-gray-400 py-6',
    sizeFilterEmpty: 'text-center text-xs text-gray-500 dark:text-gray-400 py-4',
    searchEmpty: 'text-center text-xs text-gray-500 dark:text-gray-400 py-4',
    loraDiscover: 'space-y-4',
    loraDiscoverNote: 'text-xs text-gray-500 dark:text-gray-400',
    addonsMessage: 't-micro',
  },
}
