import * as discover from '../api/discover'
import { catalogNamesByFile } from './model-search'

let cached: Map<string, string[]> | null = null

/**
 * Catalogue names by file stem, for the search over installed rows
 * (lib/model-search). Built once: the text catalogue is static data.
 *
 * The filter is a convenience on top of the row's own name, so a catalogue
 * that cannot be read (a test that stubs the discover module) leaves it
 * with no extra names instead of taking the Models page down.
 */
export function installedCatalogNames(): Map<string, string[]> {
  if (cached) return cached
  try {
    cached = catalogNamesByFile([...discover.getUncensoredTextModels(), ...discover.getMainstreamTextModels()])
  } catch {
    return new Map()
  }
  return cached
}
