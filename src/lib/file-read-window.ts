/**
 * Windowed read for file_read (audit C1). Whole-file-only was the single
 * biggest gap for real codebases: a 5000-line file rode into the context
 * complete, the 60k-char head+tail truncation then dropped the MIDDLE
 * silently, and the model edited against content it never saw. offset/limit
 * page by LINES, with a header naming the window and the total so the model
 * knows to page.
 *
 * No line-number prefixes on the content itself, on purpose: file_edit
 * matches old_string byte-exactly against the file, and a model that copies
 * a numbered line into old_string would never match.
 */
export function sliceFileReadResult(content: string, args: Record<string, unknown>): string {
  const offset = Number(args?.offset)
  const limit = Number(args?.limit)
  const hasOffset = Number.isFinite(offset) && offset > 0
  const hasLimit = Number.isFinite(limit) && limit > 0
  if (!hasOffset && !hasLimit) return content
  const lines = content.split('\n')
  const start = hasOffset ? Math.min(Math.max(1, Math.floor(offset)), lines.length + 1) : 1
  const count = hasLimit ? Math.floor(limit) : lines.length
  const window = lines.slice(start - 1, start - 1 + count)
  const end = start + window.length - 1
  const header = `[lines ${start}-${end} of ${lines.length}]`
  const tail = end < lines.length
    ? `\n[${lines.length - end} more line${lines.length - end === 1 ? '' : 's'} — call file_read again with offset: ${end + 1}]`
    : ''
  return `${header}\n${window.join('\n')}${tail}`
}
