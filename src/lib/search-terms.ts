/**
 * Search terms of a text for the memory keyword search (GH #255, 3.1.2).
 *
 * The keyword search took the words between spaces. Japanese and Chinese
 * write without spaces and Korean glues its particles to the word, so a
 * whole Japanese question was one single "word" and never matched any memory.
 *
 * Words in scripts with spaces stay what they were: letters and digits, longer
 * than two characters. A run of Han, Katakana or Hangul (digits inside it
 * count, so 11月21日 stays one run) gives its overlapping pairs of characters
 * instead, the usual way to search such text without a dictionary (a run of
 * one character is kept as it is). Runs of
 * Hiragana alone are left out: they carry the grammar (について, です), not
 * the subject, and every Japanese memory contains them.
 */

const CJK_CHAR = /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}ー々〆]/u
const HIRAGANA = /\p{Script=Hiragana}/u
const DIGIT = /\p{N}/u

/** True when the text holds Han, Katakana or Hangul characters. */
export function hasCjk(text: string): boolean {
  return CJK_CHAR.test(text)
}

function pairs(run: string): string[] {
  const chars = [...run]
  if (chars.length < 2) return []
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
  return out
}

/**
 * The terms of `text`, lower case, each one once, in the order they appear.
 * Plain ASCII text gives exactly the words the old search took (minus the
 * punctuation glued to them), so English and German retrieval is unchanged.
 */
export function searchTerms(text: string): string[] {
  return [...new Set(searchTermList(text))]
}

/** The same terms with repeats, for counting how often a term occurs (BM25). */
export function searchTermList(text: string): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  const push = (term: string) => { out.push(term) }

  // Walk the text once, cutting it into runs of one kind: CJK (with digits
  // inside), other letters and digits, and everything else as a separator.
  let run = ''
  let kind: 'cjk' | 'word' | null = null
  const flush = () => {
    if (kind === 'cjk') {
      // A pair of two digits ("11", "21") is in every date and says nothing.
      for (const p of pairs(run)) if (!/^\p{N}+$/u.test(p)) push(p)
      // The whole run as well, when it is short enough to be one name or one
      // date: "11月21日" then hits the memory of that day harder than the
      // memory of the 20th, which shares most of its pairs.
      const length = [...run].length
      if (length > 2 && length <= 12) push(run)
      // A single kanji between kana is often the whole word (傘を忘れた:
      // umbrella, forget), so a run of one character is a term of its own.
      if (length === 1 && !DIGIT.test(run)) push(run)
    } else if (kind === 'word' && [...run].length > 2) {
      push(run)
    }
    run = ''
    kind = null
  }
  for (const ch of lower) {
    if (CJK_CHAR.test(ch)) {
      if (kind === 'word' && /^\p{N}+$/u.test(run)) { kind = 'cjk'; run += ch; continue }
      if (kind !== 'cjk') flush()
      kind = 'cjk'
      run += ch
    } else if (DIGIT.test(ch) && kind === 'cjk') {
      run += ch
    } else if (HIRAGANA.test(ch)) {
      flush()
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      if (kind === 'cjk') flush()
      kind = 'word'
      run += ch
    } else {
      flush()
    }
  }
  flush()
  return out
}
