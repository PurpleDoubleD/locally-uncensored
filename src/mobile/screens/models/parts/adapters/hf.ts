/**
 * ADAPTER around api/discover.ts for a search hit from Hugging Face.
 *
 * `resolveHfGgufFiles` answers with ONE quantization of a repository. The
 * detail page (M2.1) lists all of them, each with its own verdict, so the file
 * tree is fetched once here and handed to the same pure picker
 * (`selectGgufFromTree`) once per quantization.
 *
 * TODO(mobile/logik): a `listHfGgufVariants(repo)` next to resolveHfGgufFiles
 * would replace this file. Written down in mobile-docs/geruest-wuensche/models.md.
 */
import { fetchExternal, isTauri } from '../../../../../api/backend'
import { selectGgufFromTree, type HfGgufFile, type HfTreeEntry } from '../../../../../api/discover'

export interface HfVariant {
  quant: string
  files: HfGgufFile[]
  totalBytes: number
  /** Split into several parts. The phone engine loads single files only. */
  sharded: boolean
}

const QUANT = /(IQ\d_[A-Z0-9]+|Q\d_K(?:_[A-Z]+)?|Q\d_[01]|BF16|F16|F32)/i

async function fetchText(url: string): Promise<string> {
  if (isTauri()) return fetchExternal(url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** Pure: every quantization a file tree holds, smallest first. Projector files are not models. */
export function variantsFromTree(entries: HfTreeEntry[], repo: string): HfVariant[] {
  const models = entries.filter((e) => e.type === 'file' && /\.gguf$/i.test(e.path) && !/mmproj/i.test(e.path))
  const quants = new Set<string>()
  for (const entry of models) {
    const leaf = entry.path.split('/').pop() ?? ''
    const quant = (QUANT.exec(leaf)?.[1] ?? QUANT.exec(entry.path)?.[1])?.toUpperCase()
    if (quant) quants.add(quant)
  }
  const out: HfVariant[] = []
  for (const quant of quants) {
    const picked = selectGgufFromTree(models, repo, quant)
    if (!picked || picked.incomplete || picked.quant !== quant) continue
    out.push({ quant, files: picked.files, totalBytes: picked.totalBytes, sharded: picked.sharded })
  }
  if (out.length === 0) {
    const any = selectGgufFromTree(models, repo)
    if (any && !any.incomplete) out.push({ quant: any.quant ?? 'GGUF', files: any.files, totalBytes: any.totalBytes, sharded: any.sharded })
  }
  return out.sort((a, b) => a.totalBytes - b.totalBytes)
}

/** The GGUF files of a repository by quantization. Throws when the tree cannot be read. */
export async function listHfVariants(repo: string): Promise<HfVariant[]> {
  const text = await fetchText(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`)
  const entries: unknown = JSON.parse(text)
  if (!Array.isArray(entries)) throw new Error('unexpected answer')
  return variantsFromTree(entries as HfTreeEntry[], repo)
}

// Lives next to the fit calculation since round 5, so every verdict reads a name the same way.
export { paramsFromName } from '../../../../lib/device-fit'
