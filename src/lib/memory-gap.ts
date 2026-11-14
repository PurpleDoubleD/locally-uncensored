/**
 * A "memory" that only records that something is NOT known (CA, 14.11.2026).
 *
 * The automatic extraction stored "User's preferred language for commit
 * messages is unknown" after a turn that did not mention it. Injected later
 * next to the real fact ("writes commit messages in English"), it won: Kimi
 * answered that it had never been told (CA bench AG10). Not knowing is not a
 * fact about the user. Such entries are not saved, and ones saved before are
 * left out of the prompt.
 *
 * Narrow on purpose: only a statement that something IS unknown / unclear /
 * not given, or a field that says nothing but "unknown". A memory that merely
 * contains the word ("likes Unknown Mortal Orchestra") stays.
 */
const IS_UNKNOWN = /\b(?:is|are|was|were|remains?|stays?)\s+(?:still\s+|currently\s+|not\s+yet\s+)?(?:unknown|unclear|undetermined|not\s+(?:known|specified|mentioned|provided|stated|given|clear))\b/i
const IST_UNBEKANNT = /\b(?:ist|sind|war|bleibt)\s+(?:noch\s+|bisher\s+)?(?:unbekannt|unklar|nicht\s+(?:bekannt|angegeben|genannt|klar))\b/i
const ONLY_UNKNOWN = /^\s*(?:unknown|unclear|not\s+specified|not\s+known|n\/a|none|unbekannt|keine\s+angabe)\s*\.?\s*$/i

export function onlyStatesAGap(m: { content?: string; description?: string }): boolean {
  const content = m.content ?? ''
  const description = m.description ?? ''
  if (ONLY_UNKNOWN.test(content)) return true
  if (IS_UNKNOWN.test(content) || IST_UNBEKANNT.test(content)) return true
  return ONLY_UNKNOWN.test(description) && (IS_UNKNOWN.test(content) || IST_UNBEKANNT.test(content) || content.trim() === '')
}
