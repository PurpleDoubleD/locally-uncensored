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

/**
 * Does a catalogue entry answer a search? (boromirofgeo, Discord 12.11.2026)
 *
 * The catalogue names a model the way people say it ("Gemma 4 12B
 * Abliterated"), the disk names it the way the uploader did
 * (`Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf`). The
 * Models page saw only one side at a time: Get new searched the name and the
 * description, Installed the file. So a model you have on disk could not be
 * found in the catalogue by its file name, and the reverse.
 *
 * Now an entry also answers to its file name, its image part, its
 * Hugging Face repo and its Ollama tag, with the same word rule as the
 * installed rows ("gemma 4 12b q4" finds `gemma-4-12B-it-Q4_K_M`).
 */
export interface SearchableCatalogEntry {
  name: string
  description?: string
  filename?: string
  downloadUrl?: string
  mmprojUrl?: string
  ollamaModel?: string
  url?: string
}

/** `owner/repo` and the file of a Hugging Face resolve link, or nothing. */
function hfPartsOf(url: string | undefined): string[] {
  if (!url) return []
  const m = /huggingface\.co\/([^/]+\/[^/]+)\/(?:resolve|blob)\/[^/]+\/(.+)$/.exec(url)
  return m ? [m[1], decodeURIComponent(m[2])] : []
}

/** Every name a catalogue entry goes by on disk or upstream. */
export function catalogFileNames(entry: SearchableCatalogEntry): string[] {
  const names = [
    entry.filename,
    entry.ollamaModel,
    ...hfPartsOf(entry.downloadUrl),
    ...hfPartsOf(entry.mmprojUrl),
  ].filter((s): s is string => !!s && !!s.trim())
  return [...new Set(names.map((n) => n.replace(/\.(gguf|safetensors|ckpt|pt|pth|bin)$/i, '')))]
}

/** A pasted file name carries its extension; the names compared here do not. */
const withoutExtension = (q: string) => q.replace(/\.(gguf|safetensors|ckpt|pt|pth|bin)$/i, '')

export function catalogEntryMatchesSearch(entry: SearchableCatalogEntry, query: string): boolean {
  const q = withoutExtension(query.trim().toLowerCase())
  if (!q) return true
  if (installedRowMatchesSearch(entry.name, q)) return true
  if (entry.description?.toLowerCase().includes(q)) return true
  return catalogFileNames(entry).some((n) => installedRowMatchesSearch(n, q))
}

/**
 * The installed side of the same question: a row answers to its own id and
 * to the catalogue names of the file it is (`alsoKnownAs`).
 */
export function installedModelMatchesSearch(rowId: string, alsoKnownAs: readonly string[], query: string): boolean {
  query = withoutExtension(query.trim())
  return installedRowMatchesSearch(rowId, query) || alsoKnownAs.some((n) => installedRowMatchesSearch(n, query))
}

/**
 * Catalogue names by file, for the installed rows: lower-cased file stem →
 * the names of the entries that download it.
 */
export function catalogNamesByFile(entries: readonly SearchableCatalogEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const e of entries) {
    for (const f of catalogFileNames(e)) {
      const key = f.split('/').pop()!.toLowerCase()
      const list = out.get(key) ?? []
      if (!list.includes(e.name)) list.push(e.name)
      out.set(key, list)
    }
  }
  return out
}

/** The catalogue names a row id is known by: its file stem, without a provider prefix. */
export function catalogNamesFor(rowId: string, byFile: ReadonlyMap<string, string[]>): string[] {
  const bareId = rowId.split('::').pop() ?? rowId
  const stem = bareId.split(/[\\/]/).pop()!.replace(/\.(gguf|safetensors|ckpt|pt|pth|bin)$/i, '').toLowerCase()
  return byFile.get(stem) ?? []
}
