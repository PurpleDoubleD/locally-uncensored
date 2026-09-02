/**
 * What the one button on a Discover tile does, for every state a tile can be in.
 *
 * GH #118 (nayffy, 2026-08-27): "the Get button doesn't do anything as the
 * files are still downloaded". Two halves. The badge was wrong, which the
 * filesystem rule in lib/discover-installed.ts fixes, and the right badge was
 * an inert pill: a text model that IS installed showed "Installed" and offered
 * nothing, so a user whose engine was not running had no way forward from the
 * Models page at all. A tile that knows the file is on the disk can load it.
 *
 * Pure so the rule "a tile is never a dead end" can be asserted directly.
 */

export type ModelTileAction =
  /** No download URL: the row can only be opened on the web. */
  | 'view'
  /** A download is in flight. Waiting IS the state, and it shows progress. */
  | 'downloading'
  /** On the disk, and this surface can load it into the chat. */
  | 'use'
  /** On the disk, and loading it is not this surface's job (image/video). */
  | 'installed'
  /** Not on the disk. */
  | 'get'

export interface ModelTileActionInput {
  /** Catalogue row without a usable download URL. */
  externalOnly: boolean
  /** Filesystem evidence only, never engine reachability. */
  installed: boolean
  downloading: boolean
  /** Does the caller know WHICH local model this row is, so it can be loaded. */
  loadable: boolean
}

/**
 * Order matters: an external row can never be downloaded, a download in flight
 * outranks everything else, and only then does the disk decide.
 */
export function modelTileAction(input: ModelTileActionInput): ModelTileAction {
  if (input.externalOnly) return 'view'
  if (input.downloading) return 'downloading'
  if (input.installed) return input.loadable ? 'use' : 'installed'
  return 'get'
}

/** True when the state offers the user something to click. `downloading` is
 *  the one state that legitimately does not: it is already doing the thing. */
export function tileActionIsClickable(action: ModelTileAction): boolean {
  return action !== 'downloading' && action !== 'installed'
}
