/**
 * Which image and video bundles Get new shows for the Mainstream/Unfiltered
 * switch and the search box.
 *
 * Discord, thread "I can't launch Wan2.2" (15.10.2026): the reporter typed
 * "FramePack" into the search and got nothing. The FramePack bundle is filed
 * under Unfiltered, the page opens on Mainstream, and the search only looked
 * inside the open tab. A name search that answers "nothing" for a model the
 * catalogue carries reads as "LU does not have it". While a search is typed
 * it now looks in both tabs; without one the tab decides as before.
 */
import { catalogFileNames, installedRowMatchesSearch, type SearchableCatalogEntry } from './model-search'
export interface SearchableBundle {
  name: string
  description: string
  uncensored?: boolean
  /** The files a bundle downloads: found by their names too. */
  files?: SearchableCatalogEntry[]
}

export function bundlesForTabAndSearch<T extends SearchableBundle>(
  bundles: T[],
  subTab: 'uncensored' | 'mainstream',
  search: string,
): T[] {
  const q = search.trim().toLowerCase()
  if (!q) return bundles.filter((b) => (subTab === 'uncensored' ? !!b.uncensored : !b.uncensored))
  return bundles.filter(
    (b) =>
      b.name.toLowerCase().includes(q) ||
      b.description.toLowerCase().includes(q) ||
      (b.files ?? []).some((f) => catalogFileNames(f).some((n) => installedRowMatchesSearch(n, q))),
  )
}
