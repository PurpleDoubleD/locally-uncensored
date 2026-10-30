import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Search } from 'lucide-react'
import { usePopoverPlatz } from '../../../hooks/usePopoverPlatz'
import { cn } from './cn'

export interface SelectOption {
  value: string
  label: string
  sublabel?: string
  /** Tooltip der Zeile und des geschlossenen Feldes, etwa der Dateiname hinter
   *  einem Anzeigenamen. Die Suche findet den Eintrag auch darueber. */
  title?: string
  /** Ueberschrift ueber diesem und den folgenden Eintraegen derselben Gruppe. */
  group?: string
  badge?: SelectTag
  /** Kleine Marken hinter dem Namen, nur in der aufgeklappten Liste (etwa Stufe und Herkunft). */
  tags?: SelectTag[]
}

/** Eine Marke im Etiketten-Stil der Modellwaehler (index.css, .lu-picker-tag):
 *  Haarlinie und Grau. 'accent' ist der eine Akzent, 'quiet' tritt zurueck. */
export interface SelectTag {
  label: string
  tone?: 'accent' | 'quiet'
}

interface Props {
  options: SelectOption[]
  value: string
  onChange: (v: string) => void
  searchable?: boolean
  placeholder?: string
  size?: 'sm' | 'md'
  align?: 'left' | 'right'
  className?: string
  /** Hoeher wird die Liste nie, auch im grossen Fenster nicht. */
  maxHeight?: number
  /** Beschriftung fuer Bedienhilfen, wo kein sichtbarer Text danebensteht. */
  ariaLabel?: string
}

export function Select({
  options,
  value,
  onChange,
  searchable = false,
  placeholder = 'Select...',
  size = 'md',
  align = 'left',
  className,
  maxHeight = 280,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // GitHub #149: the menu used to do its own sums against the window height
  // and kept a minimum height, so in a short or zoomed window it ended up
  // under the window edge. Placement is the app-wide rule now: the side with
  // room, capped to that room, the list scrolls.
  const menu = usePopoverPlatz(menuRef, open, {
    anker: triggerRef,
    rolle: listRef,
    fest: align === 'right' ? 'rechts' : 'links',
  })

  const current = options.find((option) => option.value === value)

  const filtered = useMemo(() => {
    // One row per value. A row's key is its value, and two rows with one key
    // are not two rows to React: filtering them left a third, stale one behind
    // (Discord 30.10.2026, a model listed twice showed three times after
    // typing "tur"). Two rows with one value are one choice anyway.
    const seen = new Set<string>()
    const unique = options.filter((option) => !seen.has(option.value) && !!seen.add(option.value))
    if (!query.trim()) return unique

    const normalizedQuery = query.toLowerCase()

    return unique.filter(
      (option) =>
        option.label.toLowerCase().includes(normalizedQuery) ||
        option.sublabel?.toLowerCase().includes(normalizedQuery) ||
        option.title?.toLowerCase().includes(normalizedQuery),
    )
  }, [options, query])

  const closeMenu = () => {
    setOpen(false)
    setQuery('')
  }

  const toggle = () => {
    if (open) {
      closeMenu()
    } else {
      setOpen(true)
    }
  }

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node

      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu()
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu()
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const controlHeight =
    size === 'sm'
      ? 'h-[var(--control-h-sm)]'
      : 'h-[var(--control-h-md)]'

  return (
    <>
      <div
        ref={triggerRef}
        className={cn('relative', className)}
      >
        <button
          type="button"
          onClick={toggle}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            't-control inline-flex w-full items-center justify-between gap-2 px-2.5',
            'rounded-[var(--radius-control)] transition-colors',
            'bg-white/[0.04] border border-white/[0.08]',
            'hover:border-white/15 text-gray-200',
            controlHeight,
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {current?.badge && <Badge tag={current.badge} />}

            <span className="truncate" title={current?.title}>
              {current?.label ?? placeholder}
            </span>
          </span>

          <ChevronDown
            size={13}
            className={cn(
              'shrink-0 text-gray-500 transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </div>

      {/* Dieselbe Flaeche und dieselbe Zeilengrammatik wie die Modellauswahl im
          Chat (index.css, .lu-picker): Haarlinie, einzeilige klebende
          Gruppenkoepfe, 24 px Zeile, Akzentstrich an der gewaehlten. Aufbau,
          Inhalte und Verhalten sind die alten. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={menuRef}
                initial={{
                  opacity: 0,
                  y: menu.nachOben ? 4 : -4,
                  scale: 0.98,
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                }}
                exit={{
                  opacity: 0,
                  y: menu.nachOben ? 4 : -4,
                  scale: 0.98,
                }}
                transition={{ duration: 0.12 }}
                style={menu.style}
                className="lu-elevated lu-picker fixed z-[100] flex min-w-0 flex-col overflow-hidden"
              >
                {searchable && (
                  <div className="lu-picker-search">
                    <Search size={13} aria-hidden="true" />

                    <input
                      autoFocus
                      value={query}
                      onChange={(event) =>
                        setQuery(event.target.value)
                      }
                      placeholder="Search..."
                    />
                  </div>
                )}

                <div
                  ref={listRef}
                  role="listbox"
                  className="lu-picker-list min-h-0 overflow-y-auto scrollbar-thin pt-1"
                  style={{ maxHeight }}
                  onWheel={(event) => event.stopPropagation()}
                >
                  {filtered.length === 0 && (
                    <div className="lu-picker-empty">
                      No matches
                    </div>
                  )}

                  {filtered.map((option, i) => {
                    const selected =
                      option.value === value
                    const head =
                      option.group &&
                      option.group !== filtered[i - 1]?.group
                        ? option.group
                        : null

                    return (
                      <div key={option.value}>
                      {head && (
                        <div className="lu-picker-head" data-group={head}>
                          <b>{head}</b>
                          <span className="n">{filtered.filter((x) => x.group === head).length}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        title={option.title}
                        onClick={() => {
                          onChange(option.value)
                          closeMenu()
                        }}
                        className="lu-picker-row w-[calc(100%-8px)] text-left"
                      >
                        {option.badge && <Badge tag={option.badge} />}

                        <span className="lu-picker-name truncate">
                          {option.label}
                        </span>

                        {option.tags?.map((t) => (
                          <Badge key={t.label} tag={t} />
                        ))}

                        <span className="lu-picker-fill" />

                        {option.sublabel && (
                          <span className="lu-picker-sub t-mono">
                            {option.sublabel}
                          </span>
                        )}
                      </button>
                      </div>
                    )
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  )
}

function Badge({ tag }: { tag: SelectTag }) {
  return (
    <span
      className={cn(
        't-micro lu-picker-tag',
        tag.tone === 'accent' && 'is-accent',
        tag.tone === 'quiet' && 'is-quiet',
      )}
    >
      {tag.label}
    </span>
  )
}
