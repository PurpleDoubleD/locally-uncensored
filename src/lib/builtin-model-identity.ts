/**
 * Which model the built-in engine is really holding.
 *
 * Counter-check finding, Windows box 2026-08-28: with Gemma loaded, a request
 * carrying `"model": "Hermes-3-Llama-3.2-3B.Q4_K_M"` and even one carrying
 * `"model": "gibt-es-nicht-42"` were both answered by Gemma, with no error and
 * no model change. That is llama-server behaving as documented: it serves the
 * one model it was started with and treats the `model` field as a label. The
 * app never checked, so the user could be shown one name and be answered by
 * another. In a group chat with two local speakers that is not an edge case,
 * it is every single round.
 *
 * These are the pure halves of the check: the picker id of a loaded GGUF path,
 * the bare id behind a picker id, and the comparison between them. Kept apart
 * from `api/builtin-ensure` so the rules can be tested without a store or a
 * Tauri backend, and so the Rust guard in `commands/proxy.rs` has a readable
 * twin to mirror (`builtin_model_name_from_path` there).
 */

/**
 * llama.cpp gguf-split suffix on a file STEM (the extension is already gone).
 * `scan_gguf_models` in Rust collapses a split set into one entry named after
 * the base and pointing at part 1, so the loaded path of a split model is
 * `<base>-00001-of-00003.gguf` while its picker id is plain `<base>`.
 */
const SHARD_SUFFIX = /-\d{4,5}-of-\d{4,5}$/

/**
 * The picker id of a bundled GGUF, derived from the path the engine was
 * started with. Handles both path separators because the loaded path comes
 * from Rust and may be a Windows one.
 *
 * Empty string when nothing is loaded, which callers must read as "unknown",
 * never as "mismatch".
 */
export function builtinModelNameFromPath(modelPath: string | null | undefined): string {
  const raw = (modelPath ?? '').trim()
  if (!raw) return ''
  const leaf = raw.split(/[\\/]/).pop() ?? ''
  const stem = leaf.replace(/\.gguf$/i, '')
  return stem.replace(SHARD_SUFFIX, '')
}

/**
 * The bare model id behind a picker id: `openai::qwen2.5-0.5b` and
 * `qwen2.5-0.5b` both answer `qwen2.5-0.5b`.
 *
 * Nothing else is touched. This id is a LOOKUP KEY: it is matched against the
 * `name` of a `list_bundled_models` entry and it names the model in an error
 * the user reads, so it has to stay the string the picker holds. Tolerance for
 * a name that carries the file extension belongs in the comparison below, not
 * here.
 */
export function bareBuiltinModelName(nameOrPrefixed: string | null | undefined): string {
  const raw = (nameOrPrefixed ?? '').trim()
  const parts = raw.split('::')
  return parts.length === 2 ? parts[1] : raw
}

/**
 * Does the engine hold what the request asks for.
 *
 * True whenever the answer is not a proven mismatch: an unknown loaded path
 * (engine not running, or a status shape without one) and an empty request
 * both mean there is nothing to contradict, and inventing a mismatch there
 * would break sends that were always fine. Only two known, different names
 * count as a mismatch.
 */
export function builtinModelMatches(
  loadedPath: string | null | undefined,
  requested: string | null | undefined,
): boolean {
  const loaded = builtinModelNameFromPath(loadedPath)
  // The requested name goes through the same normaliser, so a caller that
  // passes "model.gguf" is compared against "model" and not called a mismatch.
  const want = builtinModelNameFromPath(bareBuiltinModelName(requested))
  if (!loaded || !want) return true
  return loaded === want
}

/**
 * The English sentence a user gets when a request names a model the engine is
 * not holding and the app cannot load it (the file is gone). The wording says
 * what was asked for, what is loaded, and what to do, because "model not
 * found" on a server that answers everything is the least helpful thing we
 * could say.
 */
export function builtinModelMismatchMessage(loadedName: string, requestedName: string): string {
  return (
    `The LU Engine has "${loadedName}" loaded, but this request asked for "${requestedName}". ` +
    'The engine serves only the model it was started with, so answering would have used the wrong model. ' +
    `Install or pick "${requestedName}" in Models and send again.`
  )
}
