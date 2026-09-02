/**
 * What Settings, AI Backends, Model Storage says about each of the three
 * places a local chat model can live.
 *
 * A14 (2.6.8), David: the panel held ONE field labelled "(auto-detect)" and a
 * paragraph that named LM Studio, Ollama and our own downloads in the same
 * breath. Nothing on screen said which of the three the folder you were about
 * to pick actually belonged to, and the honest answer is that it belongs to
 * exactly one of them. So the panel is three rows now, each with a name, a
 * path and a role, and the rules for what each row prints live here where they
 * can be read and tested without a browser.
 */

/** What the backend knows about LM Studio's models folder. */
export interface LmStudioModelDir {
  installed: boolean
  path: string | null
}

/**
 * The placeholder in the LU Engine folder field.
 *
 * "(auto-detect)" on its own answered the wrong question. The user is not
 * asking whether the app detects something, he is asking which folder is being
 * read while the field is empty, and the app knows that folder: it is row 0 of
 * the last listing, the app's own models dir.
 *
 * A14 review 4: it is named for what it IS, not as an "auto" anything. There
 * is no detection going on and nothing is derived from the active provider;
 * an empty field simply means LU uses the folder it owns. Saying "auto" there
 * next to a paragraph about four folder levels invited the reading that the
 * four levels apply to this folder, and they do not: the app folder is walked
 * two levels deep (MAX_SCAN_DEPTH), the folder the user names four
 * (MAX_CUSTOM_SCAN_DEPTH).
 */
export function luEngineFolderPlaceholder(autoDir: string | null | undefined): string {
  const dir = (autoDir ?? '').trim()
  return dir ? `Leave empty and LU uses its own folder: ${dir}` : 'Leave empty and LU uses its own folder'
}

/** The role line under the LM Studio row. */
export function lmStudioFolderNote(dir: LmStudioModelDir | null | undefined): string {
  if (!dir) return ''
  if (!dir.installed) return 'LM Studio is not installed.'
  return 'LM Studio manages this folder. LU reads it through LM Studio when LM Studio is your chat provider.'
}

/**
 * The path the LM Studio row prints, or '' when there is none to print.
 *
 * Installed with no folder yet is a real state (LM Studio present, no model
 * downloaded), and it must not print an invented path: this row is read-only
 * precisely because LU does not own that folder.
 */
export function lmStudioFolderPath(dir: LmStudioModelDir | null | undefined): string {
  return (dir?.path ?? '') || ''
}

/**
 * Folders macOS gates behind a consent dialog. The user gets asked once, by
 * the system, the first time LU walks one of them. Nothing here prevents that
 * dialog, and nothing may: it is the operating system asking on the user's
 * behalf. The panel just stops it from arriving as a surprise.
 *
 * Matched on the path segment rather than on a home-directory prefix, because
 * the home directory is spelled differently on a Mac with a relocated home,
 * and because a folder on an external drive named `Documents` is not one of
 * these.
 */
const MACOS_GATED_FOLDERS = ['desktop', 'documents', 'downloads']

/**
 * Does macOS ask for access to this folder the first time it is read.
 *
 * `platformIsMac` is passed in rather than read here so the rule can be tested
 * in both directions from one process.
 */
export function macOsWillAskForFolder(path: string | null | undefined, platformIsMac: boolean): boolean {
  if (!platformIsMac) return false
  const raw = (path ?? '').trim()
  if (!raw) return false
  const segments = raw.replace(/\\/g, '/').split('/').filter(Boolean)
  // Only the folder itself and what lies inside it are gated, and the gate
  // sits directly under the home directory: /Users/<name>/Documents/... . So
  // the gated segment is the one right after the user name, never any deeper
  // segment that merely happens to be called "documents".
  const home = segments.findIndex((s) => s.toLowerCase() === 'users')
  const gatedIndex = home >= 0 ? home + 2 : -1
  if (gatedIndex < 0 || gatedIndex >= segments.length) return false
  return MACOS_GATED_FOLDERS.includes(segments[gatedIndex].toLowerCase())
}

/** The one line the panel prints under a gated folder. */
export const MACOS_FOLDER_ACCESS_NOTE = 'macOS will ask once for access to this folder.'
