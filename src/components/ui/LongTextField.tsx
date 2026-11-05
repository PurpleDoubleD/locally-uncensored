import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, Maximize2, Search } from 'lucide-react'
import { Modal } from './Modal'
import { estimateTokens } from '../../lib/token-estimate'
import { findMatches, readFieldHeight, writeFieldHeight, formatCount } from '../../lib/long-text'

/**
 * GH #197: a text area for long texts, the persona prompt, the reminder and a
 * memory. Prompts of 40,000 tokens are real (the issue), so:
 *
 *  - the bottom edge drags, and the height a person dragged to is kept per
 *    field (`storageKey`), in this browser only;
 *  - "Expand" opens the same text in a window almost as large as the app,
 *    with search (Ctrl+F, Cmd+F on a Mac) and a character and token count;
 *  - the count and the search run on a deferred copy of the text, so typing
 *    into 160,000 characters never waits for them.
 *
 * Both boxes edit the one value the caller holds; nothing is copied or saved
 * on close.
 */
export interface LongTextFieldProps {
  value: string
  onChange: (value: string) => void
  /** Remembers the dragged height under this name. */
  storageKey: string
  /** Name of the field, for the screen reader and the window title. */
  label: string
  placeholder?: string
  rows?: number
  className?: string
  /** Extra props for the inline text area (data-testid and the like). */
  testId?: string
}

/** The text that says how long the field is: "1,234 characters · ~310 tokens". */
export function lengthLine(text: string, tokens: number): string {
  return `${formatCount(text.length)} characters · ~${formatCount(tokens)} tokens`
}

const isFindKey = (e: KeyboardEvent | globalThis.KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f'

export function LongTextField({ value, onChange, storageKey, label, placeholder, rows = 4, className = '', testId }: LongTextFieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [searchFirst, setSearchFirst] = useState(false)

  // The kept height goes on before the first paint, so the box does not jump.
  useLayoutEffect(() => {
    const el = ref.current
    const saved = readFieldHeight(storageKey)
    if (el && saved) el.style.height = `${saved}px`
  }, [storageKey])

  // A drag on the corner changes the height and nothing else does (the width
  // follows the layout), so every new height seen here is one to keep.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let last = el.offsetHeight
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight
      if (h === last || h === 0) return
      last = h
      clearTimeout(timer)
      timer = setTimeout(() => writeFieldHeight(storageKey, h), 200)
    })
    ro.observe(el)
    return () => { ro.disconnect(); clearTimeout(timer) }
  }, [storageKey])

  const open = (withSearch: boolean) => {
    setSearchFirst(withSearch)
    setExpanded(true)
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (isFindKey(e)) {
            e.preventDefault()
            open(true)
          }
        }}
        aria-label={label}
        placeholder={placeholder}
        rows={rows}
        data-testid={testId}
        data-long-text={storageKey}
        className={`${className} resize-y min-h-[3rem] pr-7`}
      />
      <button
        type="button"
        onClick={() => open(false)}
        aria-label={`Expand ${label}`}
        title={`Open ${label} in a large editor with search (Ctrl+F)`}
        data-testid={testId ? `${testId}-expand` : undefined}
        className="absolute right-1.5 top-1.5 rounded p-0.5 text-gray-500 hover:text-gray-200 hover:bg-white/10"
      >
        <Maximize2 size={11} />
      </button>
      {expanded && (
        <ExpandedEditor
          value={value}
          onChange={onChange}
          label={label}
          placeholder={placeholder}
          searchFirst={searchFirst}
          testId={testId}
          onClose={() => {
            setExpanded(false)
            ref.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function ExpandedEditor({
  value, onChange, label, placeholder, searchFirst, testId, onClose,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  searchFirst: boolean
  testId?: string
  onClose: () => void
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  // Counting and searching 160,000 characters on every key would make the
  // typing wait; React runs these on the deferred copy after the key landed.
  const deferred = useDeferredValue(value)
  const deferredQuery = useDeferredValue(query)
  const tokens = useMemo(() => estimateTokens(deferred), [deferred])
  const matches = useMemo(() => findMatches(deferred, deferredQuery), [deferred, deferredQuery])
  const shown = matches.length === 0 ? 0 : Math.min(current, matches.length - 1)
  const hit = query && deferredQuery === query ? matches[shown] : undefined
  const markLayerRef = useRef<HTMLDivElement>(null)
  const [scrollbarGap, setScrollbarGap] = useState<number | undefined>(undefined)
  const syncMarkLayer = useCallback(() => {
    const area = areaRef.current
    const layer = markLayerRef.current
    if (!area || !layer) return
    layer.scrollTop = area.scrollTop
  }, [])
  // The layer follows the text area's scroll and leaves room for its scrollbar.
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area || !hit) return
    const pad = parseFloat(getComputedStyle(area).paddingRight) || 0
    setScrollbarGap(pad + (area.offsetWidth - area.clientWidth))
    syncMarkLayer()
  }, [hit, syncMarkLayer])

  useEffect(() => {
    const target = searchFirst ? searchRef.current : areaRef.current
    // After the Modal has put its own first focus.
    const t = setTimeout(() => target?.focus(), 0)
    return () => clearTimeout(t)
  }, [searchFirst])

  const reveal = useCallback((index: number) => {
    const area = areaRef.current
    const m = matches[index]
    if (!area || !m) return
    area.setSelectionRange(m.start, m.end)
    area.scrollTop = Math.max(0, offsetOf(area, m.start) - area.clientHeight / 3)
  }, [matches])

  // A new search goes to its first hit.
  useEffect(() => {
    setCurrent(0)
    if (deferredQuery) reveal(0)
    // Only on a new query, not on every edit of the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery])

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return
    const next = (shown + dir + matches.length) % matches.length
    setCurrent(next)
    reveal(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Escape closes this editor and nothing under it: the memory panel and
    // other popovers listen on the document too and would close as well,
    // dropping what was typed there. React handles this before the document.
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (isFindKey(e)) {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }

  return (
    <Modal open onClose={onClose} title={label} maxWidth="max-w-5xl" panelPad="p-4">
      <div onKeyDown={onKeyDown} className="flex flex-col gap-2" data-testid={testId ? `${testId}-editor` : 'long-text-editor'}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 focus-within:border-white/30">
            <Search size={12} className="shrink-0 text-gray-500" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  step(e.shiftKey ? -1 : 1)
                }
              }}
              placeholder="Find (Ctrl+F)"
              aria-label="Find in text"
              data-testid="long-text-find"
              className="lu-fokus-am-kasten min-w-0 flex-1 bg-transparent text-xs text-gray-200 placeholder-gray-500 focus:outline-none"
            />
            <span className="shrink-0 tabular-nums t-micro text-gray-500" data-testid="long-text-find-count">
              {query ? (matches.length ? `${shown + 1} / ${matches.length}` : 'no match') : ''}
            </span>
          </label>
          <button type="button" aria-label="Previous match" onClick={() => step(-1)} disabled={!matches.length}
            className="rounded p-1 text-gray-400 hover:bg-white/10 disabled:opacity-40"><ChevronUp size={14} /></button>
          <button type="button" aria-label="Next match" onClick={() => step(1)} disabled={!matches.length}
            className="rounded p-1 text-gray-400 hover:bg-white/10 disabled:opacity-40"><ChevronDown size={14} /></button>
        </div>
        {/* The current hit is drawn behind the text: a selection in a text
            area that does not have the focus (the keys are in the search
            box) is not shown in WebKit. The layer holds only the text up to
            the hit, in the same font and width, so it lines up with it. */}
        <div className="relative rounded-lg border border-white/10 bg-white/5 focus-within:border-white/20">
          {hit && (
            <div
              ref={markLayerRef}
              aria-hidden
              data-testid="long-text-mark-layer"
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-transparent"
              style={{ paddingRight: scrollbarGap }}
            >
              {value.slice(0, hit.start)}
              <mark data-testid="long-text-current-hit" className="rounded-sm bg-lu-accent/50 text-transparent">{value.slice(hit.start, hit.end)}</mark>
            </div>
          )}
          <textarea
            ref={areaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncMarkLayer}
            aria-label={label}
            placeholder={placeholder}
            spellCheck={false}
            data-testid="long-text-area"
            className="lu-fokus-am-kasten relative block h-[70vh] min-h-[12rem] w-full resize-y bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-gray-100 placeholder-gray-600 focus:outline-none scrollbar-thin"
          />
        </div>
        <div className="flex items-center justify-between gap-2 t-micro text-gray-500">
          <span data-testid="long-text-count">{lengthLine(deferred, tokens)}</span>
          <span>Tokens are estimated. Changes apply right away.</span>
        </div>
      </div>
    </Modal>
  )
}

/**
 * How far down in the text area the character at `index` sits, in pixels.
 * A hidden copy with the same width, font and wrapping holds the text up to
 * that point; its height is the answer. Only measured on a search step.
 */
function offsetOf(area: HTMLTextAreaElement, index: number): number {
  const cs = getComputedStyle(area)
  const mirror = document.createElement('div')
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'tabSize'] as const) {
    mirror.style[p] = cs[p]
  }
  // clientWidth is the content plus the padding, without border and scrollbar.
  mirror.style.boxSizing = 'border-box'
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.left = '-99999px'
  mirror.style.top = '0'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  mirror.style.width = `${area.clientWidth}px`
  mirror.textContent = area.value.slice(0, index)
  const mark = document.createElement('span')
  mark.textContent = '​'
  mirror.appendChild(mark)
  document.body.appendChild(mirror)
  const top = mark.offsetTop
  mirror.remove()
  return top
}
