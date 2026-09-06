// Bug Y/b (v2.5.0) — match an LM-Studio-installed model against a curated
// Discover entry's GGUF filename so the INSTALLED badge lights up after a
// restart. Pulled out of DiscoverModels.tsx so it can be unit-tested directly.
//
// Two id forms must be bridged:
//   • OLD / full:    "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf" or "publisher/...-Q4_K_M"
//   • MODERN short:  "qwen2.5-0.5b-instruct@q4_k_m"  (LM Studio adds @quant only
//                    when several quants of the same model are downloaded)
//   • COLLAPSED:     "qwen/qwen2.5-vl-7b"  (publisher/repo, NO quant — what LM
//                    Studio reports when a model has a single quant on disk)
//
// CRITICAL correctness rule (v2.5.0 adversarial-audit fix): a Discover row is
// quant-SPECIFIC (its filename names exactly one quant), so the INSTALLED badge
// must only light when we have THAT quant. We therefore require quant equality
// whenever the Discover filename carries a quant. A COLLAPSED quant-less LM
// Studio id carries no quant evidence, so it deliberately does NOT light
// quant-specific rows — a false "you already have this" badge is worse than a
// missing one, and would otherwise wrongly mark every quant sibling of a model
// (e.g. all 7 "Qwen 3.6 27B" rows) as installed from a single download.

import { isLuEngineName } from './engine-name'

export interface InstalledModelLike {
  provider?: string
  providerName?: string
  model?: string
  name?: string
  lmsKey?: string
}

// Matches a trailing GGUF quant tag: optional `ud-` prefix, then
// q<n>… / iq<n>… / f16 / f32 / bf16, delimited by @ . _ or -.
const QUANT_TAIL = /[@._-]((?:ud-)?(?:iq\d|q\d|f16|f32|bf16)[a-z0-9_]*)$/i

// gguf-split shard suffix ("-00001-of-00003"). Stripped during
// normalisation: a split model's identity and quant live in the stem BEFORE
// this tail, and the Rust-side listing collapses a set to that stem too.
const SHARD_TAIL = /-\d{4,5}-of-\d{4,5}$/

/** Lower-cased last path segment without `.gguf` or a shard suffix. */
function normalBase(s: string): string {
  return (s.toLowerCase().split(/[\\/]/).pop() || '')
    .replace(/\.gguf$/, '')
    .replace(SHARD_TAIL, '')
}

/** The quant token of a model id/filename (compacted, e.g. "q4km"), or null. */
export function extractQuant(s: string): string | null {
  const m = normalBase(s).match(QUANT_TAIL)
  return m ? m[1].replace(/[^a-z0-9]/g, '') : null
}

/**
 * Model identity WITHOUT quant: last path segment, drop `.gguf`, drop the
 * trailing quant tag and one trailing decoration word (instruct/it/chat/hf),
 * then strip separators. Bridges "qwen/qwen2.5-vl-7b" and
 * "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf" → both "qwen25vl7b". Decoration words
 * like abliterated/uncensored/heretic are intentionally NOT stripped so
 * genuinely different finetunes never collapse together.
 */
export function modelIdentity(s: string): string {
  return normalBase(s)
    .replace(QUANT_TAIL, '')
    .replace(/[._-](instruct|it|chat|hf)$/i, '')
    .replace(/[^a-z0-9]/g, '')
}

/** An LM Studio entry in the installed-model list. */
export function isLmStudioEntry(m: InstalledModelLike): boolean {
  if (m.provider !== 'openai') return false
  const pname = (m.providerName || '').toLowerCase()
  return pname.includes('lm studio') || pname.includes('lmstudio')
}

/**
 * Gehoert diese Zeile dem lokalen Backend namens `name`.
 *
 * Jedes Backend, das das OpenAI-Protokoll spricht, traegt `provider: 'openai'`
 * — das ist der eine Steckplatz, den sie sich teilen. Auseinander halten kann
 * sie nur der Anzeigename, und der ist derselbe, den die Karte in den
 * Einstellungen zeigt. Unsere eigene Engine ist nie gemeint: sie hat ihre
 * eigene Erkennung eine Zeile weiter unten, und wer sie hier mitzaehlt, haelt
 * das Laufende fuer das Wartende.
 */
export function isRowOfBackend(
  m: InstalledModelLike | null | undefined,
  name: string | null | undefined,
): boolean {
  if (!m || !name || m.provider !== 'openai') return false
  if (isBuiltinEngineEntry(m)) return false
  return (m.providerName || '').toLowerCase() === name.toLowerCase()
}

/**
 * An LU Engine entry. `bundledToAIModels` stamps every downloaded GGUF with
 * `provider: 'openai'` and `providerName: 'LU Engine'` ('Built-in Engine'
 * before 2.6.8, still on disk in older chats), and its `model` is the file
 * stem, so the same filename matcher fits it exactly.
 */
export function isBuiltinEngineEntry(m: InstalledModelLike | null | undefined): boolean {
  if (!m || m.provider !== 'openai') return false
  return isLuEngineName(m.providerName)
}

/**
 * Are these two ids the same FILE, not merely the same model.
 *
 * A14 review: `matchesLmStudioInstalled` is the wrong question for
 * de-duplication and the difference is a whole quant. That matcher serves the
 * Discover badge, where a catalogue row without a quant in its filename means
 * "any quant of this counts as installed", so rule (2) returns a match for a
 * quant-less name against ANY quant on disk. Reused for de-duplication it
 * reads as: `Qwen2.5-0.5B-Instruct.gguf` in the LU Engine folder is the same
 * thing as `qwen2.5-0.5b-instruct@q4_k_m` in LM Studio. It is not. It is a
 * different file, a different download and a different answer quality, and
 * hiding it would hide a model the user has.
 *
 * So this one never guesses across a missing quant:
 *   (a) the same normalised basename, which already carries the quant, or
 *   (b) the same model identity AND both sides naming the same quant.
 * A name with no quant matches only under (a).
 */
export function isSameGgufFile(a: string, b: string): boolean {
  const baseA = normalBase(a)
  const baseB = normalBase(b)
  if (!baseA || !baseB) return false
  if (baseA === baseB) return true
  const idA = modelIdentity(a)
  const idB = modelIdentity(b)
  // The length floor is the one `findInstalled` uses: a two-character identity
  // collides with half the catalogue.
  if (!idA || idA.length < 5 || idA !== idB) return false
  const quantA = extractQuant(a)
  const quantB = extractQuant(b)
  return !!quantA && !!quantB && quantA === quantB
}

/**
 * True when any LM-Studio-installed model corresponds to the given GGUF
 * filename. Order: exact basename / `publisher/`-suffix (already quant-precise),
 * then a normalised model-identity match that additionally REQUIRES the quant to
 * agree whenever the Discover filename names one.
 */
export function matchesLmStudioInstalled(
  filename: string,
  installed: InstalledModelLike[],
): boolean {
  return !!findInstalled(filename, installed.filter(isLmStudioEntry))
}

/**
 * Same question for every local GGUF store the app can write into: LM Studio
 * AND the built-in engine.
 *
 * GH #118 (nayffy, 2026-08-27): the Discover badge only ever consulted the LM
 * Studio half, so a chat model downloaded for the BUILT-IN engine lost its
 * INSTALLED badge on the next app start (the in-session download store is the
 * only other evidence and it does not survive a restart). The tile then
 * offered "Get" for a file that was already on disk. `list_bundled_models`
 * reads that disk on every model refresh, so the evidence was there the whole
 * time, just never asked.
 *
 * The boolean face of `findLocalGgufInstalled`. The app itself asks the entry
 * version (lib/discover-installed.ts) because it needs the picker id, and the
 * regression suite for this matcher's quant precision asks this one.
 */
export function matchesLocalGgufInstalled(
  filename: string,
  installed: InstalledModelLike[],
): boolean {
  return !!findLocalGgufInstalled(filename, installed)
}

/**
 * The same question, answering WHICH entry matched instead of just whether one
 * did.
 *
 * GH #118, the dead-button half: a tile that knows a model is installed but not
 * which installed model it is has nothing to offer beyond a badge. The picker
 * id lives on the entry, so handing the entry back is what lets the tile load
 * the model into the chat instead of showing an inert "Installed" pill next to
 * an engine that is not running.
 */
export function findLocalGgufInstalled(
  filename: string,
  installed: InstalledModelLike[],
): InstalledModelLike | null {
  return findInstalled(filename, installed.filter((m) => isLmStudioEntry(m) || isBuiltinEngineEntry(m)))
}

function findInstalled(filename: string, lms: InstalledModelLike[]): InstalledModelLike | null {
  if (!filename) return null
  const wantBase = normalBase(filename)
  const wantId = modelIdentity(filename)
  const wantQuant = extractQuant(filename)
  for (const m of lms) {
    const candidates = [m.model, m.name, m.lmsKey]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
    for (const c of candidates) {
      // Keep any path prefix for the `/`-suffix check, but normalise the
      // basename the same way as `wantBase` (drop .gguf and shard tails).
      const cBase = c.replace(/\.gguf$/, '').replace(SHARD_TAIL, '')
      // (1) exact / path-suffix — full basename ids, already carry the quant
      if (cBase === wantBase || cBase.endsWith(`/${wantBase}`) || cBase.endsWith(`\\${wantBase}`)) {
        return m
      }
      // (2) normalised identity + quant agreement
      const cId = modelIdentity(c)
      if (cId && wantId && cId.length >= 5 && cId === wantId) {
        if (!wantQuant) return m // generic Discover entry (no quant) → match
        const cQuant = extractQuant(c)
        if (cQuant && cQuant === wantQuant) return m // exact quant present
        // quant-specific Discover row but candidate quant missing/different →
        // do NOT light (avoids quant-sibling false positives).
      }
    }
  }
  return null
}
