/**
 * Telling a CivitAI API key apart from a folder path.
 *
 * A14 review 8, from the Windows follow-up: the Model Storage folder field and
 * the CivitAI key field sat directly under each other, two bare text boxes in
 * a row, and a tester saved a filesystem path as his API key. Nothing said no.
 * The key then went into the OS credential store, every CivitAI download kept
 * failing with a bare 400, and the field showed a row of dots that looked
 * exactly like a key that was there.
 *
 * Two answers, and the first one does most of the work: the key has a section
 * of its own now, away from the folder. This is the second, for whoever still
 * pastes the wrong thing.
 */

/** What the empty field shows. A CivitAI key is 32 hex characters, so the
 *  placeholder is 32 hex characters: the shape is the instruction. */
export const CIVITAI_KEY_PLACEHOLDER = '3f9a1c7d5e2b48f06a1d9c3e7b52f8a4'

/** Said under the field when what is in it is plainly not a key. */
export const CIVITAI_KEY_LOOKS_WRONG =
  'That looks like a folder, not a key. The model folder is set further up, under Model Storage. A CivitAI key is a single line of letters and digits from your CivitAI account page.'

/**
 * Is this a filesystem path rather than a key.
 *
 * Narrow on purpose, because a false alarm on a real key is worse than no
 * alarm at all: a key that a user cannot save is a feature he cannot use. Only
 * shapes a CivitAI key can never have count, and every one of them is a
 * separator no key contains.
 */
export function looksLikeAFolderPath(value: string | null | undefined): boolean {
  const v = (value ?? '').trim()
  if (!v) return false
  // A Windows drive letter, the shape from the report: C:\ or G:/
  if (/^[a-z]:[\\/]/i.test(v)) return true
  // A UNC share or a POSIX absolute path.
  if (v.startsWith('\\\\') || v.startsWith('/')) return true
  // A home-relative path.
  if (v.startsWith('~/') || v.startsWith('~\\')) return true
  // Anything carrying a separator at all. No key does.
  if (v.includes('/') || v.includes('\\')) return true
  return false
}
