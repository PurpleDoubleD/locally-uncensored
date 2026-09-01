import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Check, Search } from 'lucide-react'
import { cn } from './cn'

export interface SelectOption {
  value: string
  label: string
  sublabel?: string
  badge?: { label: string; color: string }
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
  maxHeight?: number
}

interface MenuPosition {
  top?: number
  bottom?: number
  left?: number
  right?: number
  width: number
  maxWidth: number
  maxHeight: number
  dropUp: boolean
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
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuPosition, setMenuPosition] =
    useState<MenuPosition | null>(null)

  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const current = options.find((option) => option.value === value)

  const filtered = useMemo(() => {
    if (!query.trim()) return options

    const normalizedQuery = query.toLowerCase()

    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(normalizedQuery) ||
        option.sublabel?.toLowerCase().includes(normalizedQuery),
    )
  }, [options, query])

  const closeMenu = () => {
    setOpen(false)
    setQuery('')
    setMenuPosition(null)
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

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return

    const updatePosition = () => {
      const trigger = triggerRef.current
      if (!trigger) return

      const rect = trigger.getBoundingClientRect()
      const viewportPadding = 8
      const gap = 4

      const spaceBelow =
        window.innerHeight - rect.bottom - viewportPadding - gap
      const spaceAbove =
        rect.top - viewportPadding - gap

      const searchHeight = searchable ? 48 : 0
      const menuChromeHeight = searchHeight + 8
      const estimatedRowsHeight =
        Math.max(filtered.length, 1) * 32

      const desiredHeight = Math.min(
        maxHeight + menuChromeHeight,
        estimatedRowsHeight + menuChromeHeight,
      )

      // Prefer opening downward whenever there is enough usable space.
      // The menu can scroll internally when all options do not fit.
      const minimumUsefulHeight = Math.min(desiredHeight, 160)
      const dropUp =
        spaceBelow < minimumUsefulHeight &&
        spaceAbove > spaceBelow

      const availableSpace = Math.max(
        80,
        dropUp ? spaceAbove : spaceBelow,
      )

      // The trigger width is the menu's MINIMUM: options with sublabels
      // (model prices) may need more room, so the menu grows with its
      // content. Right-aligned menus anchor their right edge and grow
      // leftward; both stay clamped inside the viewport via maxWidth.
      const width = rect.width
      const maxWidth =
        window.innerWidth - viewportPadding * 2

      const left =
        align === 'right'
          ? undefined
          : Math.min(
              Math.max(viewportPadding, rect.left),
              Math.max(
                viewportPadding,
                window.innerWidth - width - viewportPadding,
              ),
            )
      const right =
        align === 'right'
          ? Math.max(
              viewportPadding,
              window.innerWidth - rect.right,
            )
          : undefined

      setMenuPosition({
        top: dropUp ? undefined : rect.bottom + gap,
        bottom: dropUp
          ? window.innerHeight - rect.top + gap
          : undefined,
        left,
        right,
        width,
        maxWidth,
        maxHeight: Math.min(desiredHeight, availableSpace),
        dropUp,
      })
    }

    updatePosition()

    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    const resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(triggerRef.current)

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      resizeObserver.disconnect()
    }
  }, [
    align,
    filtered.length,
    maxHeight,
    open,
    searchable,
  ])

  const controlHeight =
    size === 'sm'
      ? 'h-[var(--control-h-sm)]'
      : 'h-[var(--control-h-md)]'

  const optionsMaxHeight = Math.max(
    64,
    (menuPosition?.maxHeight ?? maxHeight) -
      (searchable ? 48 : 8),
  )

  return (
    <>
      <div
        ref={triggerRef}
        className={cn('relative', className)}
      >
        <button
          type="button"
          onClick={toggle}
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
            {current?.badge && (
              <Badge
                color={current.badge.color}
                label={current.badge.label}
              />
            )}

            <span className="truncate">
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

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={menuRef}
                initial={{
                  opacity: 0,
                  y: menuPosition?.dropUp ? 4 : -4,
                  scale: 0.98,
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                }}
                exit={{
                  opacity: 0,
                  y: menuPosition?.dropUp ? 4 : -4,
                  scale: 0.98,
                }}
                transition={{ duration: 0.12 }}
                style={{
                  top: menuPosition?.top,
                  bottom: menuPosition?.bottom,
                  left: menuPosition?.left,
                  right: menuPosition?.right,
                  minWidth: menuPosition?.width,
                  maxWidth: menuPosition?.maxWidth,
                  maxHeight:
                    menuPosition?.maxHeight ?? maxHeight,
                  visibility: menuPosition
                    ? 'visible'
                    : 'hidden',
                }}
                className={cn(
                  'lu-elevated fixed z-[100] min-w-0',
                  'rounded-[var(--radius-panel)]',
                  'p-1 overflow-hidden',
                )}
              >
                {searchable && (
                  <div className="mb-1 flex items-center gap-1.5 border-b border-white/[0.06] px-2 py-1.5">
                    <Search
                      size={13}
                      className="text-gray-500"
                    />

                    <input
                      autoFocus
                      value={query}
                      onChange={(event) =>
                        setQuery(event.target.value)
                      }
                      placeholder="Search..."
                      className="t-control w-full bg-transparent text-gray-200 outline-none placeholder-gray-600"
                    />
                  </div>
                )}

                <div
                  role="listbox"
                  className="overflow-y-auto overscroll-contain scrollbar-thin"
                  style={{ maxHeight: optionsMaxHeight }}
                  onWheel={(event) => event.stopPropagation()}
                >
                  {filtered.length === 0 && (
                    <div className="t-control px-2.5 py-2 text-gray-600">
                      No matches
                    </div>
                  )}

                  {filtered.map((option) => {
                    const selected =
                      option.value === value

                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        key={option.value}
                        onClick={() => {
                          onChange(option.value)
                          closeMenu()
                        }}
                        className={cn(
                          't-control flex w-full items-center justify-between gap-2',
                          'rounded-[6px] px-2.5 py-1.5 text-left transition-colors',
                          selected
                            ? 'bg-white/10 text-white'
                            : 'text-gray-300 hover:bg-white/[0.06]',
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          {option.badge && (
                            <Badge
                              color={option.badge.color}
                              label={option.badge.label}
                            />
                          )}

                          <span className="truncate">
                            {option.label}
                          </span>

                          {option.sublabel && (
                            <span className="t-mono truncate text-gray-600">
                              {option.sublabel}
                            </span>
                          )}
                        </span>

                        {selected && (
                          <Check
                            size={13}
                            className="shrink-0 text-gray-300"
                          />
                        )}
                      </button>
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

function Badge({
  color,
  label,
}: {
  color: string
  label: string
}) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5',
        'text-[0.55rem] font-semibold',
        color,
      )}
    >
      {label}
    </span>
  )
}