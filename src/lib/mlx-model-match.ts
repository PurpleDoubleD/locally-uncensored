/**
 * Matching an image/video model NAME typed in a chat call against the models
 * actually installed for the macOS MLX lane, plus the rule for what an
 * argument-less call falls back to.
 *
 * It lives here rather than in api/mcp/builtin-tools.ts because that module
 * closes an import cycle through the tool registry and cannot be loaded by a
 * test (see lib/__tests__/tool-classification.test.ts, which reads it as
 * text). Pure functions, no store and no I/O, so both rules are testable.
 */

/** The shape both MLX catalogs (image and video) share. */
export interface NamedModel {
  id: string
  name: string
}

/**
 * Fuzzy-resolve a chat-typed model name against an installed MLX catalog by id
 * or display name. Same tolerant-matching shape as resolveModelName in
 * api/vram-handoff.ts, kept separate so this Mac-only path does not pull in
 * the ComfyUI-flavoured module.
 */
export function resolveMlxModel<T extends NamedModel>(
  requested: string | undefined,
  installed: T[],
): T | null {
  if (installed.length === 0 || !requested) return null
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const r = norm(requested)
  if (!r) return null
  return (
    installed.find((m) => norm(m.id) === r || norm(m.name) === r) ??
    installed.find((m) => norm(m.id).includes(r) || norm(m.name).includes(r)) ??
    installed.find((m) => r.includes(norm(m.id)) || r.includes(norm(m.name))) ??
    null
  )
}

/**
 * Which installed MLX image model an argument-less `image_generate` runs on.
 *
 * Same rule the ComfyUI gate follows in api/model-pick.ts, kept in step for
 * cross-platform parity: the Create tab holds the model the user picked and
 * can see, so it answers first. Nebenbefund N1 of the D1 counter-check
 * (Windows build, 2026-08-29) caught the ComfyUI half of this ignoring that
 * choice; the MLX half had the same shape.
 *
 * sd-turbo stays the fallback for an install that never opened Create, then
 * the first installed model. Undefined only for an empty install, which the
 * caller reports with its own message.
 */
export function defaultMlxImageModel<T extends NamedModel>(
  installed: T[],
  createChoice: string | null | undefined,
): T | undefined {
  return (
    resolveMlxModel(createChoice || undefined, installed)
    ?? installed.find((m) => m.id === 'sd-turbo')
    ?? installed[0]
  )
}
