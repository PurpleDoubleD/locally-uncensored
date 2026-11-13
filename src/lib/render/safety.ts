// AI-CSAM gate for the image/video generation paths. Non-negotiable block:
// prompts that sexualize minors are refused on BOTH axes: client-side in the
// Create hooks (fast feedback) and server-side in POST /api/jobs (the
// authoritative gate; the client check is UX, not security).
//
// Matching is deliberately conjunctive for the general case: a minor-related
// term alone ("a child's birthday party") or an adult-content term alone is
// legitimate; the combination is not. A small set of unambiguous terms blocks
// on its own. Server hits are logged as `jobs.csam_blocked`, and that log line
// is the operator's NCMEC escalation trigger (18 U.S.C. 2258A reporting is an
// operator duty; the worker never renders the job).

// Term lists are declared as bare alternations and compiled twice: once anchored
// on word boundaries for running against readable text, once bare for running
// against a letter-spacing run (see collapseSpacing). Deriving both from one
// string is what keeps the two views from drifting apart.
const bounded = (alt: string) => new RegExp(String.raw`\b${alt}\b`, 'i')

const MINOR_ALT = String.raw`(child|children|kid|kids|minor|minors|underage|under[\s-]?age|preteen|pre[\s-]?teen|prepubescent|teen|teens|teenager|teenagers|toddler|infant|baby|babies|schoolgirl|schoolboy|school[\s-]?uniform|grade[\s-]?school|elementary[\s-]?school|middle[\s-]?school|kindergart\w*|little[\s-]?(?:girl|boy)|loli|shota|(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[\s-]*(?:yo|years?[\s-]?old)|(?:1[0-7]|[1-9])[\s-]*(?:yo|y/o|yr[\s-]?old|year[\s-]?old|years[\s-]?old))`

const SEXUAL_ALT = String.raw`(nude|nudes|naked|nsfw|sex|sexual|sexualized|sexy|erotic|erotica|porn|pornographic|xxx|explicit|undress(?:ed|ing)?|topless|bottomless|lingerie|fetish|bdsm|bondage|genitals?|hentai|intercourse|masturbat\w*|orgasm|aroused|seductive|provocative)`

const MINOR_TERMS = bounded(MINOR_ALT)
const MINOR_TERMS_RUN = new RegExp(MINOR_ALT, 'i')

const SEXUAL_TERMS = bounded(SEXUAL_ALT)
const SEXUAL_TERMS_RUN = new RegExp(SEXUAL_ALT, 'i')

const ALWAYS_BLOCKED = /\b(csam|child\s*porn(?:ography)?|jail\s*bait|lolita\s*(?:porn|nude|sex)|pedo\w*)\b/i

// Cloud-tier adult gate. Split in two (matching Web's 2026-07-29 change) so
// hosted rendering can allow nudity and erotica while still refusing
// hardcore. Local backends stay ungated beyond CSAM either way.
//
// Deliberately NARROWER than SEXUAL_TERMS: that regex is one half of the
// minor+sexual conjunction and includes soft words ("seductive", "lingerie",
// "sexy") that must never block an adult prompt on their own. Keep the lists
// separate; they serve different gates.

/** Nudity and erotica. Allowed on 'soft', refused on 'strict'. */
const ADULT_SOFT_ALT = String.raw`(nude|nudes|naked|nsfw|topless|bottomless|erotic|erotica)`

/** Explicit acts and pornography. Refused on 'soft' as well; only 'off' lets
 *  these through. */
const ADULT_HARD_ALT =
  String.raw`(porn|pornographic|pornography|xxx|hentai|genitals?|penis|vagina|vulva|anal|blowjob|handjob|cum|cumshot|masturbat\w*|orgasm|intercourse|deepthroat|gangbang|creampie|bukkake|fellatio|cunnilingus)`

const ADULT_SOFT_TERMS = bounded(ADULT_SOFT_ALT)
const ADULT_SOFT_TERMS_RUN = new RegExp(ADULT_SOFT_ALT, 'i')

const ADULT_HARD_TERMS = bounded(ADULT_HARD_ALT)
const ADULT_HARD_TERMS_RUN = new RegExp(ADULT_HARD_ALT, 'i')

/** How much adult content hosted rendering accepts.
 *  'strict' = SFW-only (nudity blocked too)
 *  'soft'   = nudity and erotica pass, hardcore is refused (default)
 *  'off'    = no adult gate at all, CSAM only */
export type AdultPolicy = 'strict' | 'soft' | 'off'

/** Desktop has no per-deployment policy knob (Web's RENDER_ADULT_POLICY is a
 *  server env var for a server rollback switch; there is no equivalent
 *  concept in the shipped app). The default matches Web's shipped default so
 *  an untagged call never disagrees between the two copies. */
export function adultPolicy(): AdultPolicy {
  return 'soft'
}

// Compact match for the unambiguous terms after separators are stripped: beats
// letter-spacing evasion ("c h i l d  p o r n" -> "childporn"). Only strings
// that are never substrings of an innocent word go here (so no bare "pedo",
// which lives in "torpedo").
const ALWAYS_BLOCKED_COMPACT = /(csam|childporn(?:ography)?|jailbait|lolita(?:porn|nude|sex))/i

// Shortest literal a whole-string compaction check (see LONG_COMPACT and
// `compactAll`/`compactLeet` below) is allowed to carry. Below this length, an
// ordinary sentence produces the term as an accidental substring once every
// separator in the WHOLE prompt is stripped: "a classic samurai image" ->
// "aclassicsamuraiimage" contains "csam". Measured against a list of 26
// ordinary prompts (safety-strength-regression.test.ts), "csam" alone (4
// letters) produced 11 false CSAM blocks that way; none of the terms below
// (8+ letters) produced a single one on the same list, because a run that
// long is too specific to occur by word-boundary accident. That is why
// "csam" is NOT in LONG_COMPACT and stays on the run-only, word-boundary
// checks (ALWAYS_BLOCKED against `readable`, ALWAYS_BLOCKED_COMPACT against
// `runs`) below: any future addition here must clear this length, or belongs
// in the run-only set instead.
const MIN_WHOLE_STRING_TERM_LENGTH = 8
const LONG_COMPACT_TERMS = ['childporn', 'childpornography', 'jailbait', 'lolitaporn', 'lolitanude', 'lolitasex']
if (LONG_COMPACT_TERMS.some((t) => t.length < MIN_WHOLE_STRING_TERM_LENGTH)) {
  throw new Error('safety.ts: a LONG_COMPACT_TERMS entry is below MIN_WHOLE_STRING_TERM_LENGTH')
}
const LONG_COMPACT = new RegExp(`(${LONG_COMPACT_TERMS.join('|')})`, 'i')

// Cyrillic / Greek lookalikes -> latin. Fullwidth + many compatibility forms
// are already folded by NFKC; these are the ones it leaves alone.
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', ѕ: 's', і: 'i',
  ј: 'j', к: 'k', м: 'm', н: 'h', т: 't', в: 'b', г: 'r',
  α: 'a', ε: 'e', ο: 'o', ρ: 'p', ϲ: 'c', χ: 'x', υ: 'u', ι: 'i', κ: 'k', ν: 'v', τ: 't',
}
const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i',
}
// Derived from LEET so the two never drift (adding a key auto-extends the
// fold). The keys (digits, @, $, !) are all literal inside a char class: do
// NOT backslash-escape them (\0/\1 would become NUL/octal escapes).
const LEET_CLASS = new RegExp(`[${Object.keys(LEET).join('')}]`, 'g')

function baseNormalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu, '') // zero-width chars
    // Strip diacritics (decompose + drop combining marks) so accented
    // lookalikes like "chîld" fold to "child" and don't defeat the terms.
    .normalize('NFKD')
    .replace(/[\u{0300}-\u{036f}]/gu, '')
    .toLowerCase()
    // NUL is the LOWER BOUND of the ASCII range here, not a control character
    // matched for its own sake: this line folds every NON-ASCII code point
    // through HOMOGLYPHS. Narrowing the range to start at 0x20 to appease the
    // rule would stop folding any homoglyph that maps onto a control char,
    // exactly the evasion this normalizer exists to close.
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7F]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
}

/**
 * Letter-spacing fold that KEEPS word boundaries: split on every run of
 * non-alphanumerics, then glue runs of single characters back into one word.
 * "naked t e e n girl" becomes "naked teen girl", where stripping every
 * separator outright would have produced "nakedteengirl" and silently disarmed
 * the \b in every term list: the conjunction below then never fires, which is
 * exactly how "naked t e e n girl" passed the gate.
 *
 * `runs` carries those glued fragments on their own, for the case where the
 * whole prompt is spaced out ("t e e n  n u d e" glues to one run "teennude"
 * with no boundary left to anchor). Runs are matched WITHOUT \b, which is safe
 * precisely because a run of single characters IS the evasion: ordinary prose
 * never lands in `runs`, so the "teen" inside "eighteen" cannot trip it. The
 * accepted cost is that a spaced-out adult age ("1 8 y o") glues to "18yo" and
 * matches the bare age alternative on its "8yo" tail. Written normally it does
 * not, and over-blocking deliberate obfuscation is the right side to err on.
 */
function collapseSpacing(text: string): { text: string; runs: string[] } {
  const words: string[] = []
  const runs: string[] = []
  let run: string[] = []
  const flush = () => {
    if (run.length === 0) return
    const glued = run.join('')
    if (run.length > 1) runs.push(glued)
    words.push(glued)
    run = []
  }
  for (const tok of text.split(/[^a-z0-9]+/)) {
    if (tok.length === 0) continue
    if (tok.length === 1) {
      run.push(tok)
      continue
    }
    flush()
    words.push(tok)
  }
  flush()
  return { text: words.join(' '), runs }
}

export interface SafetyVerdict {
  blocked: boolean
  reason?: string
}

/** 'local' = CSAM gate only (default). 'cloud' = CSAM + adult block: hosted
 *  rendering is SFW-only on 'strict', hardcore-only on 'soft'. */
export type SafetyTier = 'local' | 'cloud'

/** Check a generation prompt (positive + negative + any free-text params
 *  concatenated is fine: the caller should pass everything a backend could
 *  route into the effective prompt). */
// B30 (2026-10-29): `negative` is the negative prompt, kept apart. It names
// what the picture must NOT show, and people and chat models fill it with the
// words that keep minors out ("child, underage, nsfw"). Read together with the
// prompt, that exclusion completed the minor+sexual conjunction and an adult
// prompt was refused. No engine renders a negative prompt, so it takes part in
// the unambiguous terms (with every fold) and nowhere else. The prompt itself
// is checked exactly as before.
export function checkPromptSafety(
  text: string,
  opts: { tier?: SafetyTier; policy?: AdultPolicy; negative?: string } = {},
): SafetyVerdict {
  if (opts.negative?.trim() && unambiguous(opts.negative)) return { blocked: true, reason: 'csam' }
  return checkPositive(text, opts)
}

/** The unambiguous terms on their own, with every fold the full check uses. */
function unambiguous(text: string): boolean {
  return checkPositive(text, { tier: 'local' }).reason === 'csam'
}

function checkPositive(text: string, opts: { tier?: SafetyTier; policy?: AdultPolicy }): SafetyVerdict {
  const base = baseNormalize(text)
  // Leet-folded copy for word terms. NOT used for age digits: folding maps
  // '1'->'i'/'4'->'a', which would destroy "14 yo"; ages are matched on `base`.
  const deleeted = base.replace(LEET_CLASS, (ch) => LEET[ch] ?? ch)
  const spacedBase = collapseSpacing(base)
  const spacedLeet = collapseSpacing(deleeted)

  // The four readable views a boundary-anchored term is tested against, plus
  // the glued letter-spacing runs, which are tested boundary-free.
  const readable = [base, deleeted, spacedBase.text, spacedLeet.text]
  const runs = [...spacedBase.runs, ...spacedLeet.runs]
  const hits = (re: RegExp, run: RegExp) =>
    readable.some((t) => re.test(t)) || runs.some((r) => run.test(r))

  // Strip EVERY non-alphanumeric, not just [\s._-]: the old class let any
  // other separator through, so `c*h*i*l*d*p*o*r*n` and `c/h/i/l/d/p/o/r/n`
  // walked straight past the always-blocked list that exists to catch exactly
  // this. That stripping happens inside collapseSpacing already (it splits on
  // `/[^a-z0-9]+/`, not just `[\s._-]+`), so `runs` above is where every
  // separator variant lands, letter by letter.
  //
  // `runs` only ever holds glued RUNS OF SINGLE CHARACTERS: two- or
  // three-character blocks ("ch il dp or n", "jai lba it") never form a run
  // and pass `runs` untouched, and neither does a term glued inside a longer
  // token with no separator at all ("xxjailbaitxx", "achildporn"). NEVER
  // "fix" this by narrowing this whole check back to `[\s._-]+` or by running
  // it on `base` only instead of both `base` and `deleeted`, which is
  // precisely the R5-9 regression (review-w2ui.md B1), measured at 275 of 927
  // chunked probes. The fix is the whole-string compaction below, not a
  // narrower run definition.
  //
  // `compactAll`/`compactLeet` strip every separator from the ENTIRE prompt
  // (not just from single-character runs), which is what closes the chunked-
  // and glued-token gap above. Tested only against LONG_COMPACT, never
  // against ALWAYS_BLOCKED_COMPACT's full list: joining the ENTIRE prompt
  // before testing glues unrelated, ordinary words across a plain space too
  // ("a classic samurai image" -> "aclassicsamuraiimage" contains "csam"),
  // which is a false alarm, not an evasion. See MIN_WHOLE_STRING_TERM_LENGTH
  // above for why "csam" is excluded from this check and stays run-only.
  const compactAll = base.replace(/[^a-z0-9]+/g, '')
  const compactLeet = deleeted.replace(/[^a-z0-9]+/g, '')
  // Schlusspruefung Inhaltsschutz (Opus 5, 18.09.2026), Variante C: closes
  // most of what is left for the SHORT term ("csam") after the checks above,
  // without reopening the whole-string false alarm MIN_WHOLE_STRING_TERM_LENGTH
  // exists to avoid. Two parts, both scoped to real whitespace, never
  // merging two ordinary words across a plain space:
  //   1) compact EACH whitespace-token on its own ("c*s*a*m" -> "csam" is
  //      one token, no real space inside) and test it for "csam" as a
  //      substring. Measured safe: 0 hits trying every one of the 235976
  //      words in the system dictionary as "a WORD image".
  //   2) additionally glue two ADJACENT tokens when BOTH are at most
  //      SHORT_TERM_GLUE_MAX_LENGTH characters long (after compaction), to
  //      catch a two-block split like "cs am" that step 1 alone cannot see
  //      (neither token contains "csam" by itself, and `runs` above does not
  //      apply either: a two-or-more-character block is not a
  //      single-character run). The bound is measured, not guessed: at 2,
  //      zero false alarms across the same dictionary check pairwise (165
  //      real words of that length, 27225 pairs) and across a set of
  //      ordinary prompts; at 3, two of those pairs read as ordinary short
  //      English prose and would false-alarm. Never raise this bound without
  //      re-measuring both.
  // Reduces the measured residual for chunked/glued "csam" by 67% against
  // the currently-live production fassung and 86% against the fassung
  // before the original regression, at zero new false alarms.
  const SHORT_TERM_GLUE_MAX_LENGTH = 2
  const compactToken = (t: string) => t.replace(/[^a-z0-9]+/g, '')
  const tokenCompactions = (text: string) => text.split(/\s+/).filter(Boolean).map(compactToken)
  const shortTermHits = (tokens: string[]) => {
    if (tokens.some((t) => t.includes('csam'))) return true
    for (let i = 0; i + 1 < tokens.length; i++) {
      const a = tokens[i]
      const b = tokens[i + 1]
      if (a.length <= SHORT_TERM_GLUE_MAX_LENGTH && b.length <= SHORT_TERM_GLUE_MAX_LENGTH && (a + b).includes('csam')) {
        return true
      }
    }
    return false
  }
  if (
    readable.some((t) => ALWAYS_BLOCKED.test(t)) ||
    runs.some((r) => ALWAYS_BLOCKED_COMPACT.test(r)) ||
    LONG_COMPACT.test(compactAll) ||
    LONG_COMPACT.test(compactLeet) ||
    shortTermHits(tokenCompactions(base)) ||
    shortTermHits(tokenCompactions(deleeted))
  ) {
    return { blocked: true, reason: 'csam' }
  }
  const minor = hits(MINOR_TERMS, MINOR_TERMS_RUN)
  const sexual = hits(SEXUAL_TERMS, SEXUAL_TERMS_RUN)
  if (minor && sexual) {
    return { blocked: true, reason: 'minor+sexual' }
  }
  // CSAM checks above run first so an adult+minor prompt always carries the
  // csam reason (and its alert path), never the softer adult-cloud one.
  if (opts.tier === 'cloud') {
    const policy = opts.policy ?? adultPolicy()
    if (policy !== 'off' && hits(ADULT_HARD_TERMS, ADULT_HARD_TERMS_RUN)) {
      return { blocked: true, reason: 'adult-cloud' }
    }
    if (policy === 'strict' && hits(ADULT_SOFT_TERMS, ADULT_SOFT_TERMS_RUN)) {
      return { blocked: true, reason: 'adult-cloud' }
    }
  }
  return { blocked: false }
}

export const SAFETY_BLOCK_MESSAGE =
  'This prompt was blocked: content sexualizing minors is never generated, on any backend.'

// The message names the setting rather than claiming the cloud cannot do
// this at all: it is an account content-policy setting, not a limit of the
// service. No adult vocabulary, it appears in the app UI.
export const ADULT_BLOCK_MESSAGE =
  "Your account's content policy blocked this prompt. You can change it in Settings, under Content policy."

/** Map a verdict reason to its user-facing message. */
export function blockMessageFor(reason?: string): string {
  return reason === 'adult-cloud' ? ADULT_BLOCK_MESSAGE : SAFETY_BLOCK_MESSAGE
}

// NOTE: the operator-facing CSAM alert (out-of-band webhook POST) lives in the
// SERVER, not here. It was previously exported from this client lib but never
// imported, and `process.env` is undefined in WebView2, so it was inert dead
// code. Removed in the 2.5.7 security pass: an escalation/alerting path has no
// business shipping in the desktop bundle. The client's job ends at
// `checkPromptSafety` (the local gate) + the 422 the server returns.
