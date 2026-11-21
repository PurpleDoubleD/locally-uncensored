import { useEffect, useState } from 'react'
import { fetchExternal } from '../api/backend'
import { fetchGgufChoices, quantBudgetBytes } from '../api/discover'
import { getTotalRamGb } from '../lib/hardware'
import { useGraphicsMemoryGb } from './useGraphicsMemory'
import { chatModelBudgetGb } from '../lib/shared-memory-wording'
import { isMacOS } from '../lib/device-kind'
import { isRepoId, parseCard, resolveOriginal, type ModelOrigin, type OriginIo, type OriginalOffer } from '../lib/model-origin'

const CACHE_KEY = 'lu-model-original-cache'
const CACHE_DAYS = 14
const CACHE_MAX = 40
const API = 'https://huggingface.co/api/models'

type Cache = Record<string, { at: number; offer: OriginalOffer | null }>

function readCache(): Cache {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed as Cache : {}
  } catch { return {} }
}

function writeCache(key: string, offer: OriginalOffer | null) {
  try {
    const all = { ...readCache(), [key]: { at: Date.now(), offer } }
    const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX)
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch { /* a full or blocked storage only means asking again next time */ }
}

/** Only repo names go out: no file name, no path, no token. A failed request
 *  marks the run, so an offline answer is never remembered. */
function hubIo(onFail: () => void): OriginIo {
  const list = async (url: string) => {
    try {
      const parsed: unknown = JSON.parse(await fetchExternal(url))
      if (!Array.isArray(parsed)) { onFail(); return null }
      return parsed.map((m: { id?: unknown }) => m?.id).filter((id): id is string => typeof id === 'string')
    } catch { onFail(); return null }
  }
  return {
    card: async (repo) => {
      if (!isRepoId(repo)) return null
      try {
        const card = parseCard(await fetchExternal(`${API}/${repo}`), repo)
        if (!card) onFail()
        return card
      } catch { onFail(); return null }
    },
    search: (name) => list(`${API}?search=${encodeURIComponent(name.replace(/\s+/g, '-'))}&sort=downloads&direction=-1&limit=20`),
    ggufsOf: (repo) => list(`${API}?filter=gguf&filter=${encodeURIComponent(`base_model:quantized:${repo}`)}&sort=downloads&direction=-1&limit=20`),
    choices: async (repo) => {
      const c = await fetchGgufChoices(repo)
      if (!c) onFail()
      return c
    },
  }
}

/** What "Get the original" offers for this model. Null while it is unknown;
 *  offline or on a Hugging Face error it stays quiet. */
export function useOriginalOffer(origin: ModelOrigin | null | undefined, wanted: boolean): OriginalOffer | null {
  const graphicsGb = useGraphicsMemoryGb()
  const key = wanted && origin ? JSON.stringify([origin.basename, origin.sizeLabel, origin.bases, origin.sourceRepos, origin.file]) : null
  const [found, setFound] = useState<{ key: string; offer: OriginalOffer | null } | null>(null)

  useEffect(() => {
    if (!key || !origin) return
    const hit = readCache()[key]
    let gone = false
    if (hit && Date.now() - hit.at < CACHE_DAYS * 86_400_000) {
      queueMicrotask(() => { if (!gone) setFound({ key, offer: hit.offer }) })
      return () => { gone = true }
    }
    void (async () => {
      let failed = false
      const ramGb = await getTotalRamGb().catch(() => null)
      const budget = quantBudgetBytes(chatModelBudgetGb(isMacOS(), graphicsGb, ramGb && ramGb > 0 ? ramGb : null))
      const offer = await resolveOriginal(origin, hubIo(() => { failed = true }), budget).catch(() => null)
      if (!failed) writeCache(key, offer)
      if (!gone) setFound({ key, offer })
    })()
    return () => { gone = true }
    // `key` stands for the origin's content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, graphicsGb])

  return found && found.key === key ? found.offer : null
}
