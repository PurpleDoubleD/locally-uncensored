/**
 * What "Copy text" in the context menu of a chat message puts on the
 * clipboard (Discord #bug-reports 30.10.2026): the same as Ctrl+C, never
 * the Markdown source. The words the user selected inside the message, or,
 * with nothing selected there, the text of the message as it is shown. The
 * source stays one entry further down, "Copy as Markdown".
 *
 * `root` is the message; the parts that show its text carry
 * `data-copy-text`, so names, chips, sources and the action bar stay out.
 */
export function plainTextToCopy(root: Element, selection: Selection | null): string {
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    if (root.contains(range.commonAncestorContainer)) return selection.toString()
  }
  return [...root.querySelectorAll<HTMLElement>('[data-copy-text]')]
    // innerText is the text as laid out, as Ctrl+C copies it; jsdom has none.
    .map((el) => (el.innerText ?? el.textContent ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
}
