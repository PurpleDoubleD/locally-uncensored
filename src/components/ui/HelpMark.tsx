/**
 * A small "?" that explains the control next to it.
 *
 * Hover shows the text as the native tooltip. A tap or a click also shows it,
 * as a line the caller places under the control: a phone has no hover, and a
 * floating bubble inside a scrolling popup gets cut off. The button only
 * toggles that line; it never moves focus to or from the control it sits next
 * to, so inside a <label> it does not drag the slider along.
 */
export function HelpMark({
  text,
  label,
  open,
  onToggle,
  testId,
}: {
  text: string
  label: string
  open: boolean
  onToggle: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      title={text}
      data-testid={testId}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }}
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-gray-400/60 t-micro leading-none text-gray-500 hover:text-gray-300 hover:border-gray-300"
    >
      ?
    </button>
  )
}
