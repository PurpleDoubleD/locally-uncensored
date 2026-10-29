/**
 * C7 (funde-C.md): the trigger word of a local character, in the one form
 * the trainer, the LoRA file name and the Use shelf all agree on.
 *
 * The Rust side names the LoRA after the trigger run through
 * `sanitize_component` (src-tauri/src/commands/trainer.rs): every character
 * that is not an ASCII letter, digit, "-" or "_" becomes "_", then "_" is
 * trimmed off both ends. The Use shelf reads the trigger back from that file
 * name (api/trainer.ts parseLocalCharacterLora). A trigger "Jörg" was learned
 * from captions saying "Jörg", saved as `char_J_rg_zimage.safetensors`, and
 * the shelf then put "J_rg" into the prompt, a token the LoRA never saw.
 *
 * Chosen fix: transliterate in the field itself, as the person types. "Jörg"
 * turns into "Joerg" right there, so the word on screen is the word that is
 * trained, written into the captions, named in the file and put into the
 * prompt later. A refusal would make someone called Jörg guess a spelling; a
 * silent rewrite at send time would repeat the bug in a new shape. Letters
 * with no Latin form (Cyrillic, CJK) are dropped, and the note below says why.
 */

const SPELLED_OUT: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', ẞ: 'SS',
  ø: 'o', Ø: 'O', æ: 'ae', Æ: 'Ae', œ: 'oe', Œ: 'Oe',
  ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th', ı: 'i',
}

/** The longest trigger the field keeps (the Rust side allows 48). */
export const TRIGGER_WORD_MAX = 30

/**
 * What the field shows while the person types: no whitespace, common accented
 * letters spelled in ASCII (ö to oe, é to e, ø to o), anything else dropped.
 * Underscores at the ends stay so "my_" can still become "my_char".
 */
export function typedTriggerWord(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/[^\p{ASCII}]/gu, (c) => SPELLED_OUT[c] ?? c)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, TRIGGER_WORD_MAX)
}

/**
 * The trigger as it goes to the trainer and into every caption: the typed
 * form, with the end underscores Rust trims off anyway. Rust's
 * `sanitize_component` leaves this string unchanged, so the file name ends in
 * exactly this word and the shelf reads it back as is.
 */
export function trainTriggerWord(raw: string): string {
  return typedTriggerWord(raw).replace(/^_+|_+$/g, '')
}

/** The note under the field when the typed word was changed, or null. */
export function triggerWordNote(raw: string): string | null {
  const typed = raw.replace(/\s+/g, '')
  const kept = typedTriggerWord(raw)
  if (!typed || typed.slice(0, TRIGGER_WORD_MAX) === kept) return null
  return kept
    ? `Trained as “${kept}”: trigger words use the letters A to Z, digits, - and _.`
    : 'Trigger words use the letters A to Z, digits, - and _.'
}
