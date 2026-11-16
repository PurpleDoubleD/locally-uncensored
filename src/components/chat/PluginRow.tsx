// One row of the Plugins menu (3.1.0, David 16.11.2026: "jedes Plugin
// bekommt den Lichtschalter wie Neurons"). Every plugin looks the same: its
// icon, its name and a short line, the switch at the far right. Off closes
// the row; on opens what the plugin has to set right under it. Rows are
// parted by hairlines from the menu (PluginsDropdown), never boxed.

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { HINWEIS_TEXT } from '../../lib/hinweis'

/** The switch at the right end of every plugin row. One look for all. */
export function PluginSwitch({
  on,
  available = true,
  onToggle,
  label,
  title,
  testId,
}: {
  on: boolean
  available?: boolean
  onToggle: () => void
  label: string
  title?: string
  testId?: string
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (available) onToggle() }}
      disabled={!available}
      aria-pressed={on}
      aria-label={label}
      data-testid={testId}
      title={title}
      className={
        'shrink-0 flex items-center w-7 h-3.5 rounded-full transition-colors '
        + (!available
          ? 'bg-gray-300/20 dark:bg-white/5 cursor-default justify-start'
          : on
            ? 'bg-sky-500/40 hover:bg-sky-500/55 justify-end'
            : 'bg-gray-300/30 dark:bg-white/10 hover:bg-gray-300/45 dark:hover:bg-white/15 justify-start')
      }
    >
      <span className={`w-3 h-3 rounded-full shadow-sm mx-px ${available ? 'bg-white' : 'bg-white/40'}`} />
    </button>
  )
}

/** The small calm dot that points at something new (no pulse, no number). */
export function HintDot({ testId, label }: { testId: string; label: string }) {
  return (
    <span
      data-testid={testId}
      aria-hidden="true"
      title={label}
      className="inline-block shrink-0 w-1.5 h-1.5 rounded-full bg-sky-400"
    />
  )
}

export function PluginRow({
  testId,
  icon: Icon,
  onColor,
  name,
  mark,
  line,
  on,
  available = true,
  reason,
  onToggle,
  switchLabel,
  switchTitle,
  switchTestId,
  hint,
  children,
}: {
  testId: string
  icon: LucideIcon
  /** Text colour of the icon while on, the plugin's colour in the trigger. */
  onColor: string
  name: string
  /** A mark after the name (Beta). */
  mark?: ReactNode
  /** The short grey line after the name. */
  line?: ReactNode
  on: boolean
  available?: boolean
  /** Why the switch is grey; shown under the row while it is. */
  reason?: string
  onToggle: () => void
  switchLabel: string
  switchTitle?: string
  switchTestId?: string
  /** A hint dot after the name. */
  hint?: ReactNode
  /** What opens under the row while the plugin is on. */
  children?: ReactNode
}) {
  return (
    <div className="px-2.5" data-testid={testId} data-on={on || undefined}>
      <div className="w-full flex items-center justify-between py-1.5 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon size={10} className={`shrink-0 ${on ? onColor : 'text-gray-400'}`} />
          <span className="shrink-0 t-micro font-medium text-gray-600 dark:text-gray-300">{name}</span>
          {mark}
          {hint}
          {line != null && <span className="t-micro text-gray-400 truncate">{line}</span>}
        </div>
        <PluginSwitch
          on={on}
          available={available}
          onToggle={onToggle}
          label={switchLabel}
          title={!available ? reason : switchTitle}
          testId={switchTestId}
        />
      </div>
      {!available && reason && (
        // A reason, not an error: the calm grey of lib/hinweis.ts.
        <div data-testid={`${testId}-reason`} className={`pb-1.5 t-micro leading-snug ${HINWEIS_TEXT.ruhig}`}>
          {reason}
        </div>
      )}
      {on && available && children != null && (
        <div data-testid={`${testId}-body`} className="pb-1.5">{children}</div>
      )}
    </div>
  )
}
