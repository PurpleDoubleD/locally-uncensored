// Neurons' "Get the original" searches Hugging Face for the maker's model
// (N2, FEHLER-N2 #1, T1 31.10.2026): the first hit for "Qwen3.5 9B" was the
// changed model the user came from. In that search the originals come first
// and the changed versions follow under their own heading.

import type { DiscoverModel } from '../api/discover'

/** Words in a repo name that mean someone changed the weights after the
 *  maker's release. The first four mirror the engine's own list
 *  (commands/neuron/model.rs TWEAK_WORDS); the rest are names community
 *  tweaks often carry. Matched inside the lower-case name. */
const TWEAK_PARTS = [
  'abliterat', 'obliterat', 'heretic', 'uncensor', 'decensor', 'merge',
  'defiant', 'nsfw', 'erotic', 'roleplay', 'lewd', 'distill', 'finetune', 'fine-tune',
]

/** Short marks that only count as a whole word ("rp" not in "sharp"). */
const TWEAK_WORDS = ['mtp', 'rp', 'ft', 'evil', 'dark']

/** Uploaders whose GGUFs are straight conversions of the maker's weights. */
export const PLAIN_UPLOADERS = ['qwen', 'unsloth', 'bartowski', 'ggml-org', 'lmstudio-community', 'google', 'meta-llama', 'mistralai', 'microsoft']

export function looksTweaked(repoId: string): boolean {
  const low = repoId.split('/').pop()!.toLowerCase()
  if (TWEAK_PARTS.some((p) => low.includes(p))) return true
  const words = low.split(/[^a-z0-9]+/)
  return TWEAK_WORDS.some((w) => words.includes(w))
}

/** Name parts that say nothing about a change. */
const NEUTRAL_WORDS = ['gguf', 'instruct', 'it', 'chat', 'base', 'i1', 'imatrix', 'imat']

function repoOf(m: DiscoverModel): string {
  return m.description || m.name
}

const words = (t: string) => t.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)

/** A repo from an unknown uploader whose name says more than the search
 *  ("Qwen3.5-9B-DeepSeek-V4-Flash" for "Qwen3.5 9B") is someone's own
 *  version (Mac proof 31.10.2026: two such hits sat among the originals). */
export function saysMore(repoId: string, query: string): boolean {
  const asked = words(query)
  if (asked.length === 0) return false
  const [uploader, name = ''] = repoId.split('/')
  if (PLAIN_UPLOADERS.includes(uploader.toLowerCase())) return false
  return words(name).some((w) => !NEUTRAL_WORDS.includes(w) && !asked.some((a) => a === w || a.startsWith(w)))
}

/** The checked download of "Get the original": that repository alone, with
 *  the file LU checked in it. */
function exactHit(models: DiscoverModel[], repo: string, file?: string | null): DiscoverModel | null {
  const hit = models.find((m) => repoOf(m).toLowerCase() === repo.toLowerCase())
  if (!hit) return null
  if (!file) return hit
  const quant = /(Q\d+(?:_\d+)?(?:_[A-Z]+)*)/i.exec(file.split('/').pop() ?? '')?.[1].toUpperCase()
  const path = file.split('/').map(encodeURIComponent).join('/')
  const { quantGuessed: _guess, ...rest } = hit
  return { ...rest, filename: file.split('/').pop(), downloadUrl: `https://huggingface.co/${repoOf(hit)}/resolve/main/${path}`, tags: quant ? [quant, 'GGUF'] : ['GGUF'] }
}

/** Originals first (plain uploaders before the rest, the search's own order
 *  kept inside each group), then the changed versions. */
export function originalsFirst(models: DiscoverModel[], query = '', file?: string | null): { originals: DiscoverModel[]; changed: DiscoverModel[] } {
  if (query.includes('/')) {
    const exact = exactHit(models, query.trim(), file)
    if (exact) return { originals: [exact], changed: [] }
  }
  const originals: DiscoverModel[] = []
  const changed: DiscoverModel[] = []
  for (const m of models) (looksTweaked(repoOf(m)) || saysMore(repoOf(m), query) ? changed : originals).push(m)
  const plain = (m: DiscoverModel) => PLAIN_UPLOADERS.includes(repoOf(m).split('/')[0].toLowerCase()) ? 0 : 1
  originals.sort((a, b) => plain(a) - plain(b))
  return { originals, changed }
}
