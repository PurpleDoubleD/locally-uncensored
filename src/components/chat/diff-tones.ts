/**
 * Colours of a diff line, light and dark. One place, so the review panel and
 * the diff in a tool call read the same.
 *
 * The old diff was drawn for dark only (pale text on black/30): in the light
 * theme it came out grey on grey. Here every row carries a tinted background
 * and a dark text colour in light, a soft tint and a pale text in dark. Line
 * numbers stay muted, the sign column carries the colour.
 */
export const DIFF_TONE = {
  add: {
    row: 'bg-emerald-50 text-emerald-950 dark:bg-emerald-500/[0.12] dark:text-emerald-100',
    sign: 'text-emerald-700 dark:text-emerald-400',
  },
  remove: {
    row: 'bg-red-50 text-red-950 dark:bg-red-500/[0.12] dark:text-red-100',
    sign: 'text-red-700 dark:text-red-400',
  },
  context: {
    row: 'text-gray-700 dark:text-gray-300',
    sign: 'text-gray-400 dark:text-gray-600',
  },
} as const

export const DIFF_LINE_NO = 'text-gray-400 dark:text-gray-500'
export const DIFF_ADDED_COUNT = 'text-emerald-700 dark:text-emerald-400'
export const DIFF_REMOVED_COUNT = 'text-red-700 dark:text-red-400'
export const DIFF_SURFACE = 'bg-white dark:bg-black/30 border-gray-200 dark:border-white/10'
export const DIFF_HUNK_HEAD = 'bg-gray-50 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400'
