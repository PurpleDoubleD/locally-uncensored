
import { useLayoutEffect, useRef } from 'react'
import { cn } from './cn'
import { fitTextarea } from '../../../lib/fit-textarea'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  onSubmit?: () => void
  /** A pixel cap, or any CSS length. Default: PROMPT_FIELD_MAX. */
  maxHeight?: number | string
  autoFocus?: boolean
  /** The field stands, and takes no text (an action without a prompt). */
  disabled?: boolean
  className?: string
}

/**
 * How tall the field grows before it scrolls: 220 px, and never more than a
 * share of the window.
 *
 * Discord report (3.0.7): with a long prompt the field took its full 220 px
 * (253 on screen at --ui-scale 1.15) in every window, and the stage above it,
 * where the progress of a run and its result are shown, kept what was left.
 * In a 1024x700 window that was 143 px on a Mac and less on Windows, where
 * the tab bar takes two rows: the step line of a run was cut off and the
 * picture was a strip. `vh` is the one length `zoom` does not scale (see
 * --ui-scale in index.css), hence the division.
 */
const PROMPT_FIELD_MAX = 'min(220px, calc(16vh / var(--ui-scale, 1)))'

// Auto-grow textarea — grow logic ported from PromptInput.tsx:46-51.
export function PromptField({ value, onChange, placeholder, onSubmit, maxHeight = PROMPT_FIELD_MAX, autoFocus, disabled, className }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Measured off-page and written only on a real change (GH #139), so a key
  // within a line does not lay out the Create page around the field.
  // A CSS cap is held by the style below, also when the window changes size;
  // the field is then sized to its text and the browser clamps it.
  useLayoutEffect(() => {
    if (ref.current) fitTextarea(ref.current, typeof maxHeight === 'number' ? maxHeight : Infinity)
  }, [value, maxHeight])

  return (
    <textarea
      ref={ref}
      value={value}
      autoFocus={autoFocus}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (onSubmit && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSubmit() }
      }}
      placeholder={placeholder}
      rows={1}
      className={cn(
        // `lu-fokus-am-kasten`: beide Einbindungen sitzen in einem Kasten
        // mit `focus-within:border-*` (Composer.tsx), der den Fokus schon
        // zeichnet. Die Begruendung steht an der Regel in index.css.
        'lu-fokus-am-kasten t-body w-full resize-none bg-transparent outline-none text-gray-100 placeholder-gray-600 scrollbar-thin leading-relaxed',
        className,
      )}
      style={{ maxHeight }}
    />
  )
}