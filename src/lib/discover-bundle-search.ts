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

/**
 * W42 (Discord, 17.11.2026): Image and Video searched both tabs, Text only
 * the open one, and a Mainstream hit under the Unfiltered tab was taken for
 * an unfiltered model. Now every catalogue searches both tabs the same way,
 * and the hits stand in two groups, each under its catalogue's name: the open
 * tab's first, then the other's. Without a search there is one group, the
 * open tab, with no name over it, as before.
 */
export type CatalogueTab = 'uncensored' | 'mainstream'

export const CATALOGUE_TITLE: Record<CatalogueTab, string> = {
  uncensored: 'Unfiltered',
  mainstream: 'Mainstream',
}

export interface CatalogueSection<T> {
  /** Null without a search: the open tab, shown without a name. */
  tab: CatalogueTab | null
  items: T[]
}

export function catalogueSections<T>(
  open: CatalogueTab,
  search: string,
  byTab: Record<CatalogueTab, T[]>,
): CatalogueSection<T>[] {
  if (!search.trim()) return [{ tab: null, items: byTab[open] }]
  const other: CatalogueTab = open === 'uncensored' ? 'mainstream' : 'uncensored'
  return [open, other]
    .map((tab) => ({ tab, items: byTab[tab] }))
    .filter((s) => s.items.length > 0)
}
