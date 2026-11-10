// The classic face of the Model Manager: Windows and Linux.
//
// The build is the page as it stood before the redesign (commit 9339daa7):
// the wide rail with its boxed selection, "Models" and the segmented
// Get new / Installed in one top bar, the tile with its size pill and one
// row of controls. The redesign's build stays on the Mac (08.10.2026).
//
// The colours are the Mac's since 10.10.2026: the page was too grey here.
// One accent for the selection, the action and the progress, the tile
// surface of the house (`.lu-tile`), the tinted Get (`.lu-tonal`). Where a
// house recipe would have brought a measure of its own (a height, a
// padding), its colours are spelled here on the classic measure instead.
//
// It holds look and nothing else. Words, numbers and handlers come from the
// page (ModelManager, DiscoverModels, LoraAddons), which owns the rules and
// hands the same ones to the Mac face in skin/mac.tsx.
//
// Pictures of this face: proof/design-pill/win/model-manager/.
import type { ReactNode } from 'react'
import { ADD_GGUF_TITLE } from './types'
import {
  ArrowLeft, Download, FilePlus, HardDrive, RefreshCw, Search, Sparkles, X as XIcon,
} from 'lucide-react'
import { CapLegend, HardwareChip } from '../ModelTiles'
import {
  ClassicBundleTile, ClassicModelTile, CLASSIC_CAP_LEGEND, CLASSIC_HARDWARE_CHIP,
} from './ClassicTiles'
import { ClassicLoraManager } from './ClassicLoraManager'
import type {
  EmptyStateProps, FilterBarProps, HeadProps, ManagerFrameProps, ModelSkin,
} from './types'

/** The mark a counter wears while it has nothing counted to show. Not a 0:
 *  a 0 next to a card that reads Installed is a wrong answer, and this one
 *  stood for five seconds on the real box (Befund 2, 2026-08-29). */
function CountingDots({ label }: { label: string }) {
  return (
    <span
      className="text-[0.55rem] font-normal opacity-50 animate-pulse"
      role="status"
      aria-label={label}
      title={label}
    >
      &middot;&middot;&middot;
    </span>
  )
}

// One accent for every lane, no colour per category (ruled out on
// 2026-07-17 and still so). The boxed selection carries it: the soft accent
// ground and the accent edge, the pair `.lu-tile--active` uses.
/** The open view of the segmented switch: the accent pair of the selection,
 *  its edge drawn inside the segment so the switch keeps its width. */
const VIEW_OPEN = 'bg-lu-accent-soft ring-1 ring-inset ring-lu-accent-edge dark:ring-lu-accent-ring text-gray-900 dark:text-white'
const VIEW_CLOSED = 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
const VIEW_GLYPH = 'text-lu-accent-ink dark:text-lu-accent'

function ClassicManagerFrame({ entries, onBack, tab, onTab, installedBadge, searchRef, search, onRefresh, onPull, onAddFile, children }: ManagerFrameProps) {
  return (
    <>
      {/* Category rail, the big, labeled home of Chat / Image / Video */}
      <aside className="shrink-0 w-12 lg:w-36 border-r border-gray-200 dark:border-white/[0.06] flex flex-col py-3 px-1.5 lg:px-2 gap-1">
        {entries.map(({ key, label, Icon, active, badge, onPick }) => (
          <button
            key={key}
            onClick={onPick}
            title={label}
            aria-pressed={active}
            className={`flex items-center justify-center lg:justify-start gap-2 px-2 py-2 rounded-lg border transition-colors ${
              active
                ? 'bg-lu-accent-soft border-lu-accent-edge dark:border-lu-accent-ring text-gray-900 dark:text-white'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04]'
            }`}
          >
            <Icon size={15} className={active ? 'text-lu-accent-ink dark:text-lu-accent' : undefined} />
            <span className="hidden lg:block t-micro font-medium">
              {label}
            </span>
            {badge.kind === 'loading' ? (
              <span className="hidden lg:block ml-auto">
                <CountingDots label={key === 'lora' ? 'Counting installed LoRAs' : `Counting installed ${label.toLowerCase()} models`} />
              </span>
            ) : badge.value > 0 ? (
              <span className="hidden lg:block ml-auto text-[0.55rem] text-gray-500 dark:text-gray-400 tabular-nums">{badge.value}</span>
            ) : null}
          </button>
        ))}
        <div className="mt-auto hidden lg:block px-2 pb-1 text-[0.5rem] leading-relaxed text-gray-500 dark:text-gray-400">
          Models run 100% on your computer.
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin" data-testid="models-pane">
        {/* Full pane width like the chat area, no centered max-w cap, so wide
            windows get more grid columns instead of side gutters. */}
        <div className="p-4 space-y-4">
          {/* Top bar */}
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              title="Back to chat"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="text-[0.85rem] font-semibold text-gray-900 dark:text-white">Models</h1>

            {/* Get new / Installed segment. It keeps its width and its one
                line: at 760 px the search field used to squeeze it until
                "Get new" broke in two. The search field is what gives way. */}
            <div className="ml-2 shrink-0 flex items-center p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06]" data-models-view>
              <button
                onClick={() => onTab('discover')}
                aria-pressed={tab === 'discover'}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md t-micro font-semibold whitespace-nowrap transition-colors ${
                  tab === 'discover' ? VIEW_OPEN : VIEW_CLOSED
                }`}
              >
                <Sparkles size={11} className={tab === 'discover' ? VIEW_GLYPH : undefined} /> Get new
              </button>
              <button
                onClick={() => onTab('installed')}
                aria-pressed={tab === 'installed'}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md t-micro font-semibold whitespace-nowrap transition-colors ${
                  tab === 'installed' ? VIEW_OPEN : VIEW_CLOSED
                }`}
              >
                <HardDrive size={11} className={tab === 'installed' ? VIEW_GLYPH : undefined} /> Installed
                {installedBadge.kind === 'loading' ? (
                  <CountingDots label="Counting installed models" />
                ) : (
                  <span className="text-[0.55rem] font-normal opacity-70 tabular-nums">{installedBadge.value}</span>
                )}
              </button>
            </div>

            {/* Always-visible search. Up to 14rem wide and pushed to the right
                by its margin; in a narrow window it shrinks before anything
                beside it wraps. */}
            <div className="relative ml-auto flex-1 min-w-24 max-w-56">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                ref={searchRef}
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                onKeyDown={search.onKeyDown}
                placeholder="Search models…"
                className="w-full pl-7 pr-6 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 t-micro text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
              />
              {search.value && (
                <button
                  onClick={() => search.onChange('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <XIcon size={11} />
                </button>
              )}
            </div>

            <button onClick={onRefresh} className="shrink-0 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors" title="Refresh">
              <RefreshCw size={13} />
            </button>
            {/* Pull fetches an Ollama chat model by name. On the media and
                LoRA rails it has nothing to pull into. */}
            {onPull && (
              <button
                onClick={onPull}
                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/[0.14] dark:border-white/[0.14] text-gray-600 dark:text-gray-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] hover:text-gray-900 dark:hover:text-gray-100 t-micro transition-colors"
                title="Pull any Ollama model by name"
              >
                <Download size={11} /> Pull
              </button>
            )}
            {onAddFile && (
              <button
                onClick={onAddFile}
                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/[0.14] dark:border-white/[0.14] text-gray-600 dark:text-gray-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] hover:text-gray-900 dark:hover:text-gray-100 t-micro transition-colors"
                title={ADD_GGUF_TITLE}
              >
                <FilePlus size={11} /> GGUF file
              </button>
            )}
          </div>

          {children}
        </div>
      </div>
    </>
  )
}

function ClassicQuietLine({ children }: { children: ReactNode }) {
  return (
    <div className="text-center py-16 px-6">
      <p className="text-[0.7rem] text-gray-500 dark:text-gray-400">{children}</p>
    </div>
  )
}

/** The three empty states of the Installed view. Each kept its own measure:
 *  the lane that is merely empty is a line and a small button, the other two
 *  are the round glyph, two lines and the button. The button is the one
 *  action of its surface, so it is the filled accent (`.lu-primary`). */
function ClassicEmptyState({ kind, Icon, title, children, action }: EmptyStateProps) {
  if (kind === 'lane-empty') {
    return (
      <div className="text-center py-10 space-y-2">
        <p className="text-[0.7rem] text-gray-500 dark:text-gray-400">
          {title}
        </p>
        <button
          onClick={action.onClick}
          className="lu-primary inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md t-micro transition-colors"
        >
          <action.Icon size={11} /> {action.label}
        </button>
      </div>
    )
  }
  const engineDown = kind === 'engine-down'
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 gap-3">
      <div className="w-14 h-14 rounded-full bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/[0.08] flex items-center justify-center">
        <Icon size={28} className="text-gray-400 dark:text-gray-500" />
      </div>
      <div className="space-y-1">
        <p className={engineDown ? 't-control text-gray-900 dark:text-white' : 'text-[12px] font-medium text-gray-900 dark:text-white'}>{title}</p>
        <p className={`t-micro text-gray-500 dark:text-gray-400 ${engineDown ? 'max-w-[300px]' : 'max-w-[280px]'} leading-relaxed`}>
          {children}
        </p>
      </div>
      <button
        onClick={action.onClick}
        className="lu-primary flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-md t-micro transition-colors"
      >
        <action.Icon size={11} /> {action.label}
      </button>
    </div>
  )
}

const HEAD_WORD = 't-micro font-semibold uppercase tracking-[0.12em] text-gray-700 dark:text-gray-300'
const HEAD_RULE = 'flex-1 h-px bg-gray-200 dark:bg-white/[0.07]'
const HEAD_NOTE = 'text-[0.55rem] text-gray-500 dark:text-gray-400'

/** The headings of the classic page. They were written out where they stood
 *  and differ in small things (an icon size, a tone, a rule or none), so each
 *  place keeps its own line here. */
function ClassicHead({ place, title, Icon, count, note }: HeadProps) {
  switch (place) {
    case 'installed':
      return (
        <div className="flex items-center gap-2 px-1">
          {Icon && <Icon size={11} className="text-gray-500 dark:text-gray-400" />}
          <h2 className={HEAD_WORD}>
            {title}
          </h2>
          <span className={`${HEAD_NOTE} tabular-nums`}>{count}</span>
          <div className={HEAD_RULE} />
        </div>
      )
    case 'start-here':
      return (
        <div className="flex items-center gap-1.5 px-1">
          {Icon && <Icon size={11} className="text-gray-500 dark:text-gray-400" />}
          <h3 className={HEAD_WORD}>{title}</h3>
          <span className={HEAD_NOTE}>{note}</span>
          <div className={HEAD_RULE} />
        </div>
      )
    case 'all':
      return (
        <div className="flex items-center gap-1.5 px-1 pt-1">
          <h3 className={HEAD_WORD}>
            {title}
          </h3>
          <div className={HEAD_RULE} />
        </div>
      )
    case 'hf-results':
      return (
        <div className="flex items-center gap-1.5 px-1">
          {Icon && <Icon size={10} className="text-gray-500 dark:text-gray-400" />}
          <h3 className="t-micro font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">{title}</h3>
          <div className={HEAD_RULE} />
        </div>
      )
    case 'tier':
      return <div className="col-span-full t-control pt-2 text-gray-500 dark:text-gray-400" data-tier-group={title}>{title}</div>
    case 'addons':
      return <h3 className={`px-1 ${HEAD_WORD}`}>{title}</h3>
  }
}

/** Two rows: which catalogue with the hardware chip beside it, then how big.
 *  All four pieces are children of the page's spaced column, as they were. */
function ClassicFilterBar({ catalogue, sizes, categories, hardware, switchBar, legend }: FilterBarProps) {
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        {catalogue}

        <div className="ml-auto">
          <HardwareChip vramGb={hardware.vramGb} ramGb={hardware.ramGb} sharedMemory={hardware.sharedMemory} surface={CLASSIC_HARDWARE_CHIP} />
        </div>
      </div>

      {sizes}

      {categories}

      {switchBar}

      {legend && <CapLegend sharedMemory={hardware.sharedMemory} ink={CLASSIC_CAP_LEGEND} />}
    </>
  )
}

/** The grey word beside a model's name: "stopped", and the mark of a copy
 *  without refusals (A14), which is not set in capitals. */
const QUIET_BADGE = 'shrink-0 text-[0.5rem] text-gray-500 dark:text-gray-400 font-medium'

export const classicSkin: ModelSkin = {
  name: 'classic',
  ManagerFrame: ClassicManagerFrame,
  QuietLine: ClassicQuietLine,
  EmptyState: ClassicEmptyState,
  Head: ClassicHead,
  FilterBar: ClassicFilterBar,
  ModelTile: ClassicModelTile,
  BundleTile: ClassicBundleTile,
  LoraManager: ClassicLoraManager,
  card: {
    // The surface of the house on the classic measure: `.lu-tile` would round
    // the row to 10 px, and the row keeps its 8.
    row: (isActive) => `lu-tile rounded-lg! flex items-center gap-2.5 px-3 py-1.5 cursor-pointer group ${isActive ? 'lu-tile--active' : ''}`,
    typeIcon: (_type, isActive) => `shrink-0 ${isActive ? 'text-lu-accent-ink dark:text-lu-accent' : 'text-gray-400 dark:text-gray-500'}`,
    typeIconSize: 13,
    name: 'flex-1 min-w-0 flex text-[0.7rem] text-gray-900 dark:text-gray-100 font-medium',
    stopped: `${QUIET_BADGE} uppercase`,
    active: 'shrink-0 text-[0.5rem] text-lu-accent-ink dark:text-lu-accent font-medium uppercase',
    mark: QUIET_BADGE,
    meta: 'hidden md:flex items-center gap-1.5 shrink-0 t-micro text-gray-500 dark:text-gray-400 lu-hud-num',
    // The colours of `.lu-tonal` on the small measure of this row. The recipe
    // itself is 26 px high and would make every row taller.
    use: 'px-2 py-0.5 mr-1 rounded t-micro font-medium border border-lu-accent-ink/30 dark:border-lu-accent/30 bg-lu-accent/[0.12] text-lu-accent-ink dark:text-lu-accent hover:bg-lu-accent/20 hover:border-lu-accent-ink dark:hover:border-lu-accent-ring dark:hover:text-lu-accent-hover transition-colors disabled:grayscale disabled:opacity-45 disabled:cursor-default inline-flex items-center gap-1',
    useSpinnerSize: 9,
    info: 'p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors',
    remove: 'p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors',
    // The outline of `.lu-control--outline`, drawn inside the box so the
    // button keeps its size.
    bench: 'flex items-center gap-1 px-1.5 py-0.5 rounded ring-1 ring-inset ring-black/[0.14] dark:ring-white/[0.14] text-gray-600 dark:text-gray-400 text-[0.55rem] hover:bg-black/[0.05] dark:hover:bg-white/[0.07] hover:text-gray-900 dark:hover:text-gray-100 transition-colors disabled:opacity-30',
  },
  cls: {
    group: 'space-y-1.5',
    tileWrap: undefined,
    foldedRows: 'px-1 pt-0.5 text-[0.55rem] text-gray-500 dark:text-gray-400',
    providerHeading: 'px-1 pt-1 t-label font-medium text-gray-500 dark:text-gray-400',
    installedNoMatch: 'text-center t-micro text-gray-500 dark:text-gray-400 py-6',
    sizeFilterEmpty: 'text-center text-gray-500 dark:text-gray-400 py-4 text-sm',
    searchEmpty: 'text-center text-gray-500 dark:text-gray-400 py-4',
    loraDiscover: 'space-y-2',
    loraDiscoverNote: 'px-1 t-micro text-gray-500 dark:text-gray-400',
    addonsMessage: 'px-1 t-micro',
  },
}
