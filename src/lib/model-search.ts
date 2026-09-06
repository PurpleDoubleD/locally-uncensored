/**
 * Does an installed row answer a search typed against the catalogue?
 *
 * Measured 2026-09-05 on the Windows box: the search text "Llama 3.2 3B
 * Abliterated" found the catalogue tile under Get new and then, with the same
 * text still in the box, the Installed tab said no installed chat model
 * matched, while the file `Llama-3.2-3B-Instruct-abliterated.Q4_K_M` sat
 * right there. The row was matched on its picker id, which spells the model
 * the way the file does, not the way the catalogue does.
 *
 * The rule: every word of the query has to appear in the row id once both
 * are reduced to letters and digits. "3.2" becomes "32", "Llama-3.2-3B" becomes
 * "llama323b", and the words may come in any order. A plain substring of the
 * id still matches as before.
 */
const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

export function installedRowMatchesSearch(rowId: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (rowId.toLowerCase().includes(q)) return true
  const id = bare(rowId)
  const words = q.split(/\s+/).map(bare).filter(Boolean)
  return words.length > 0 && words.every((w) => id.includes(w))
}
