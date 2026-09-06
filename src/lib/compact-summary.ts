/**
 * The written summary — the pure half (2.6.8, Compact-Schritt 3).
 *
 * This is what separates a compaction from a truncation. Today's mechanical
 * path keeps a suffix window and leaves behind a list of TOOL NAMES; whatever
 * was reasoned, decided or found in the dropped turns is simply gone. Here the
 * model is asked to write down what happened before the drop, and that text
 * rides along instead.
 *
 * ── WHY THIS MODULE HOLDS NO MODEL CALL ────────────────────────────────────
 *
 * Prompt building, answer parsing and the "is this usable?" judgement are the
 * parts that decide whether compaction helps or quietly destroys a run, and
 * they are the parts worth testing hardest. A model call in the same module
 * would make every one of those tests need a fake provider. So the round trip
 * lives at the call site and this module stays pure — the same split the
 * project already uses for agent-commands.ts ("pure data + pure functions
 * here — no React, no side effects").
 *
 * ── WHY PLAIN TEXT AND NOT A JSON SCHEMA ───────────────────────────────────
 *
 * The obvious design is to demand JSON and parse it. It is the wrong one here,
 * because of who has to answer. This app runs models on three tool-calling
 * strategies (native, hermes_xml, template_fix), and the two fallback
 * strategies exist precisely BECAUSE those models cannot be relied on to emit
 * a required structure — that is what the fallback is for. A summariser that
 * demands valid JSON would work on the cloud models that need compaction least
 * and fail on the small local models that need it most, and it would fail by
 * throwing away the history it was asked to preserve.
 *
 * So: named sections in plain prose, and a parser that takes what it finds.
 * A model that ignores the headings entirely still produces usable text, and
 * `summaryFromLooseText` keeps it rather than declaring failure. Only genuinely
 * empty or degenerate output falls through to the mechanical path.
 *
 * ── THE SIZE RULE ──────────────────────────────────────────────────────────
 *
 * A summary that is not much smaller than what it replaced has bought nothing
 * and cost a round trip. `isUsableSummary` enforces that, so a model that
 * "summarises" by echoing the transcript is rejected and the mechanical path
 * runs instead — which is the honest outcome: no summary is better than a
 * summary that is a copy.
 */

import { estimateTokens, attachNoteToUserMaterial } from './context-compaction'

/** One section of the summary, in the order they are asked for and rendered. */
export interface CompactSummary {
  /** What the user actually wanted. Survives every later compaction. */
  task: string
  /**
   * Die eigenen Worte des Nutzers, woertlich.
   *
   * ── WARUM WOERTLICH UND NICHT DESTILLIERT ────────────────────────────────
   *
   * Alle anderen Abschnitte sind Nacherzaehlung — das Modell schreibt auf,
   * was es verstanden hat. Genau darin liegt der Verlust: eine Anweisung, die
   * einmal falsch verstanden wurde, bleibt nach der Verdichtung fuer immer
   * falsch, denn das Original ist weg und niemand kann nachlesen. Und
   * Nebenbedingungen ("aber nie mehr als X", "ausser im normalen Chat")
   * ueberleben eine Zusammenfassung fast nie, obwohl sie das sind, woran der
   * Nutzer die Arbeit misst.
   *
   * Die Claude-Code-Desktop-App macht dafuer einen eigenen Abschnitt auf, und
   * das ist der Grund: die Bitten des Nutzers sind das einzige im Verlauf, das
   * keine zweite Quelle hat. Werkzeugausgaben lassen sich neu erzeugen, Code
   * neu lesen — ein Satz, den der Mensch getippt hat, nicht.
   *
   * Der Platz dafuer ist billig: in einem Arbeitsgespraech sind die eigenen
   * Nachrichten ein kleiner Bruchteil des Textes, den Werkzeugausgaben und
   * Antworten fuellen. Reicht er einmal nicht, greift die Groessenpruefung
   * (MAX_SUMMARY_SHARE) und sagt ehrlich, dass hier nichts zu holen war.
   */
  requests: string
  /** What was already done, in order. */
  progress: string
  /** Decisions taken and the reason, so they are not re-litigated. */
  decisions: string
  /** Facts found that later turns still depend on (paths, names, values). */
  facts: string
  /** What is still open. */
  open: string
  /** Anything the model wrote that fitted no heading. Never dropped. */
  rest: string
}

export const EMPTY_SUMMARY: CompactSummary = {
  task: '', requests: '', progress: '', decisions: '', facts: '', open: '', rest: '',
}

/**
 * The headings the prompt asks for. The parser matches these case-insensitively
 * and tolerates markdown decoration around them, because models decorate.
 */
export const SECTIONS: ReadonlyArray<{ key: keyof CompactSummary; heading: string }> = [
  { key: 'task', heading: 'TASK' },
  { key: 'requests', heading: 'USER REQUESTS' },
  { key: 'progress', heading: 'PROGRESS' },
  { key: 'decisions', heading: 'DECISIONS' },
  { key: 'facts', heading: 'FACTS' },
  { key: 'open', heading: 'OPEN' },
]

/**
 * Marker that wraps a rendered summary wherever it travels. It has two jobs:
 * the UI finds a compaction block by it, and `stripCompactSummary` can remove
 * an older one so summaries never nest — a summary of a summary of a summary
 * is how a long run forgets everything it did.
 */
/**
 * Die Ueberschrift, unter der loser Text steht — der `rest`.
 *
 * Sie steht NICHT in SECTIONS, weil sie kein benanntes Feld ist, sondern der
 * Auffangeimer. Aber sie muss beiden Seiten bekannt sein, und genau daran ist
 * die erste Fassung gescheitert: `renderCompactSummary` schrieb `NOTES`,
 * `parseCompactSummary` kannte das Wort nicht, und die Zeile samt ihrem Text
 * landete im Eimer der VORHERIGEN Ueberschrift. Aus `{task:'A', rest:'X'}`
 * wurde beim Zurueckleben ein einziger TASK-Block mit dem Wort NOTES
 * mittendrin — nachgemessen am 02.09.2026, gefunden von einem Waechter, der
 * genau diesen Rundlauf pruefen sollte.
 *
 * Die Lehre steckt in der Konstante: wer eine Ueberschrift schreibt, die der
 * Leser nicht kennt, baut eine Einbahnstrasse. Beide Richtungen lesen ab
 * hier dieselbe Zeichenkette.
 */
export const REST_HEADING = 'NOTES'

export const COMPACT_OPEN = '[compacted-context]'
export const COMPACT_CLOSE = '[/compacted-context]'

/** A summary must be at most this share of what it replaced, or it is refused. */
export const MAX_SUMMARY_SHARE = 0.5

/**
 * Below this many characters of CONTENT, a summary is not a summary.
 *
 * Content, not rendered length: the rendered form carries a fixed preamble
 * that explains to the model what it is looking at, and that preamble alone is
 * longer than this floor. Measuring the rendered string would have let a
 * one-word summary through on the strength of its own wrapper — which is
 * exactly the case this floor exists to catch.
 */
export const MIN_SUMMARY_CHARS = 40

export interface CompactPromptOptions {
  /**
   * The user's optional steer from `/compact <focus>`. Free text, appended as
   * an emphasis instruction rather than replacing the sections — a focus must
   * narrow what is emphasised, never license dropping the task itself.
   */
  focus?: string
  /** Character budget for the transcript handed to the summariser. */
  maxTranscriptChars?: number
}

/** Default cap for the transcript the summariser is shown. */
export const DEFAULT_TRANSCRIPT_CHARS = 60000

export interface TranscriptTurn {
  role: string
  content: string
}

/**
 * Render the turns being dropped as a transcript for the summariser.
 *
 * Head-and-tail, not head-only: the last turns before the cut are the ones the
 * conversation is standing on right now, and a head-only cap would summarise
 * the beginning of a long run and lose the part that matters most.
 */
export function renderTranscript(turns: TranscriptTurn[], maxChars = DEFAULT_TRANSCRIPT_CHARS): string {
  const lines = turns
    .filter((t) => typeof t.content === 'string' && t.content.trim() !== '')
    .map((t) => `${t.role}: ${stripCompactSummary(t.content).trim()}`)
  const whole = lines.join('\n\n')
  if (whole.length <= maxChars) return whole
  const half = Math.floor(maxChars / 2)
  const head = whole.slice(0, half)
  const tail = whole.slice(whole.length - half)
  const omitted = whole.length - head.length - tail.length
  return `${head}\n\n… [${omitted} characters of the middle omitted] …\n\n${tail}`
}

/**
 * The summarisation request.
 *
 * Written as ONE user message on purpose. A system message would be the
 * natural place for instructions, but this text is sent to whatever model the
 * chat is already using, including models whose chat template refuses a system
 * message anywhere but position 0 — the same rule that governs where the
 * finished summary is allowed to ride (context-compaction.ts, "System message
 * must be at the beginning"). Keeping the whole request in one user turn means
 * the summariser call has no template shape a model can refuse.
 */
export function buildCompactPrompt(
  turns: TranscriptTurn[],
  opts: CompactPromptOptions = {},
): string {
  const transcript = renderTranscript(turns, opts.maxTranscriptChars)
  const focus = opts.focus?.trim()
  const focusLine = focus
    ? `\n\nThe person asked you to pay particular attention to: ${focus}\nCover it in more detail than the rest — but still fill in every section below.`
    : ''
  return `Below is part of a conversation that is about to be removed to free up context. Write a summary that lets the conversation continue without it.

Write for the assistant that has to carry on, not for a human reader. Facts over prose. Keep names, paths, numbers and identifiers exactly as they appear — they cannot be looked up again once the original is gone. Do not add anything that is not in the transcript, and do not offer to help; this is a record, not a reply.

Write the whole summary in the language the conversation is in. A record that changes language has been re-said, not recorded: on 2026-09-03 a German conversation came back as an English summary in which "47,3 Millionen Euro" had become "47.3 million euros" and a time of day had disappeared entirely. Never translate, convert or reformat a value — not currency, not dates, not times, not units, not decimal marks. Copy them character for character.

Count nothing you have not written down. If the person marked five things to remember and you can only find four, record the four and say the fifth is missing. A list that promises five and delivers four makes the next assistant shift the values into the wrong slots — which is worse than a gap, because a gap gets asked about.

Use exactly these six headings, each on its own line:

TASK
What the person originally asked for, in one or two sentences.

USER REQUESTS
Every instruction the person gave, in their own words, quoted exactly, one per line, in order. Do not shorten, translate or tidy them. Include the conditions and exceptions they attached ("but never more than", "except in"). This is the only part of the record that cannot be reconstructed from anywhere else.

PROGRESS
What has already been done, in order. Name the concrete results.

DECISIONS
Choices that were made and the reason for each, so they are not made again differently.

FACTS
Specific things discovered that later steps depend on: file paths, function names, values, error messages, versions.

OPEN
What is still unfinished or unanswered.

Write "none" under a heading that has nothing. Never write "none" under USER REQUESTS if the person said anything at all.${focusLine}

--- TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---`
}

/** Escape a string for use inside a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Read the model's answer back into sections.
 *
 * Deliberately forgiving: a heading may carry markdown hashes, bold markers,
 * a trailing colon or a leading list bullet, and may be in any case. Anything
 * before the first recognised heading, or under none of them, is kept in
 * `rest` — output that did not follow the format is still information, and
 * throwing it away would be the one failure this whole module exists to avoid.
 */
export function parseCompactSummary(text: string): CompactSummary {
  const src = (text || '').trim()
  if (!src) return { ...EMPTY_SUMMARY }

  // Deko auf BEIDEN Seiten. Die erste Fassung erlaubte sie nur vor dem Wort,
  // und `- decisions -` fiel damit durch — eine Zeile, die ein Modell ohne
  // Weiteres so schreibt. Die Klasse ist absichtlich dieselbe links wie
  // rechts, statt rechts eine kuerzere zu fuehren: eine Ueberschrift ist an
  // ihrem WORT erkennbar, die Zeichen drumherum sind Geschmack des Modells.
  const deco = '[\\s>*_#:.\\-=]*'
  // REST_HEADING steht mit in der Liste, nicht daneben: sie ist eine
  // Ueberschrift wie die anderen, sie zeigt nur auf `rest` statt auf ein
  // benanntes Feld. Ein Modell, das von sich aus NOTES schreibt, landet
  // damit ebenfalls richtig — das war vorher Zufall.
  const headingRe = new RegExp(
    `^${deco}(${[...SECTIONS.map((s) => s.heading), REST_HEADING].map(esc).join('|')})${deco}$`,
    'i',
  )

  const out: CompactSummary = { ...EMPTY_SUMMARY }
  const buckets: Record<string, string[]> = { rest: [] }
  let current = 'rest'

  for (const line of src.split('\n')) {
    const m = line.match(headingRe)
    if (m) {
      const wort = m[1].toLowerCase()
      const found = SECTIONS.find((s) => s.heading.toLowerCase() === wort)
      if (found || wort === REST_HEADING.toLowerCase()) {
        current = found ? found.key : 'rest'
        if (!buckets[current]) buckets[current] = []
        continue
      }
    }
    if (!buckets[current]) buckets[current] = []
    buckets[current].push(line)
  }

  for (const key of Object.keys(buckets)) {
    const body = buckets[key].join('\n').trim()
    // "none" is the prompt's own word for an empty section; keeping it would
    // spend tokens saying nothing on every future request.
    out[key as keyof CompactSummary] = /^none\.?$/i.test(body) ? '' : body
  }
  return out
}

/**
 * A model that ignored the headings still said something useful. Rather than
 * calling that a failure, keep the whole answer as the summary body.
 */
export function summaryFromLooseText(text: string): CompactSummary {
  return { ...EMPTY_SUMMARY, rest: (text || '').trim() }
}

/** True when the summary carries nothing at all. */
export function isEmptySummary(s: CompactSummary): boolean {
  return SECTIONS.every((sec) => !s[sec.key].trim()) && !s.rest.trim()
}

/**
 * Turn a parsed summary back into the text that will ride in the payload.
 *
 * Wrapped in the markers so it can be found and stripped later; sections that
 * are empty are left out entirely rather than carried as a heading with
 * nothing under it.
 */
/**
 * Der Satz, der im Nutzlast-Text ueber der Zusammenfassung steht.
 *
 * Eine Konstante und kein Literal im Template, weil ihn ZWEI Seiten brauchen:
 * der Aufbau schreibt ihn, die Anzeige nimmt ihn wieder weg. Stuenden beide
 * Fassungen als Text da, waere die Anzeige beim naechsten Umformulieren
 * stillschweigend kaputt — sie wuerde den Satz einfach als Inhalt zeigen,
 * ohne dass ein Test das merkt.
 */
export const COMPACT_PREAMBLE =
  'Earlier turns in this conversation were summarised to free up context. This is that summary; treat it as the record of what happened, and carry on from it rather than starting over.'

export function renderCompactSummary(s: CompactSummary): string {
  const parts: string[] = []
  for (const sec of SECTIONS) {
    const body = s[sec.key].trim()
    if (body) parts.push(`${sec.heading}\n${body}`)
  }
  const rest = s.rest.trim()
  if (rest) parts.push(parts.length ? `${REST_HEADING}\n${rest}` : rest)
  if (!parts.length) return ''
  return `${COMPACT_OPEN}\n${COMPACT_PREAMBLE}\n\n${parts.join('\n\n')}\n${COMPACT_CLOSE}`
}

/**
 * Remove a rendered summary from a piece of text.
 *
 * Used before a NEW summary is written, so the summariser never reads its own
 * previous output back as if it were transcript. Without this, every
 * compaction would fold the last one into itself and detail would decay
 * geometrically — the same failure shape that made the mechanical path's trim
 * notice stack until it was explicitly stripped (context-compaction.ts,
 * stripTrimNotice).
 */
export function stripCompactSummary(text: string): string {
  if (typeof text !== 'string' || !text.includes(COMPACT_OPEN)) return text
  const re = new RegExp(`${esc(COMPACT_OPEN)}[\\s\\S]*?${esc(COMPACT_CLOSE)}\\s*`, 'g')
  return text.replace(re, '').trim()
}

/** True when this text already carries a summary. */
export function hasCompactSummary(text: string): boolean {
  return typeof text === 'string' && text.includes(COMPACT_OPEN)
}

export interface UsabilityInput {
  summary: CompactSummary
  /** Characters of transcript the summary is meant to replace. */
  replacedChars: number
}

export interface UsabilityResult {
  usable: boolean
  reason: 'ok' | 'empty' | 'too-short' | 'not-smaller'
  /** Rendered length, so the caller can log what it rejected. */
  renderedChars: number
  /** Length of the summary's own words, without the wrapper. */
  contentChars: number
}

/** The summary's own words, with no preamble and no headings. */
export function summaryContentChars(s: CompactSummary): number {
  return SECTIONS.reduce((n, sec) => n + s[sec.key].trim().length, 0) + s.rest.trim().length
}

/**
 * Die kleinstmoegliche Zusammenfassung, in Zeichen — Huelle, Vorrede, eine
 * Ueberschrift und gerade so viel Text, dass MIN_SUMMARY_CHARS erreicht ist.
 *
 * Nicht als Zahl hingeschrieben, sondern GERECHNET, ueber genau die Funktion,
 * die auch die echte Fassung baut. Eine Konstante waere in dem Moment falsch,
 * in dem jemand die Vorrede umformuliert, und niemand merkte es.
 */
export function minimalSummaryChars(): number {
  return renderCompactSummary({
    ...EMPTY_SUMMARY,
    [SECTIONS[0].key]: 'x'.repeat(MIN_SUMMARY_CHARS),
  }).length
}

/**
 * Kann eine Zusammenfassung dieser Textmenge ueberhaupt kleiner sein als das,
 * was sie ersetzt?
 *
 * Die Frage ist reine Arithmetik und laesst sich VOR dem Aufruf beantworten.
 * Wer das kann und es trotzdem erst hinterher prueft, laesst ein lokales
 * Modell umsonst rechnen — auf einem Laptop eine spuerbare Sekunde fuer nichts.
 *
 * Die Grenze in Zahlen (Stand 02.09.2026): die kleinste ueberhaupt baubare
 * Fassung misst 269 Zeichen, davon 224 allein Marker und Vorrede. Bei
 * MAX_SUMMARY_SHARE = 0.5 heisst das: unter rund 538 zu ersetzenden Zeichen
 * kann NICHTS passen, egal wie gut das Modell arbeitet.
 *
 * Was diese Funktion NICHT leistet, und das gehoert hierher, weil der erste
 * Entwurf genau das behauptete: sie faengt den gemessenen Beschwerdefall
 * nicht. Der hatte 633 ersetzte Zeichen, liess also 316 zu, und die kleinste
 * Fassung mit 269 haette gepasst — abgelehnt wurde erst die WIRKLICHE Antwort
 * ueber zehn Turns. Diese Pruefung spart den aussichtslosen Aufruf, sie ersetzt
 * die spaete Pruefung nicht. Der zweite Teil der Antwort auf jenen Fall ist
 * die ehrliche Meldung in compactOutcomeMessage, nicht diese Rechnung.
 */
export function summaryCouldEverFit(replacedChars: number): boolean {
  if (!(replacedChars > 0)) return true // ohne Bezugsgroesse greift die Regel gar nicht
  return minimalSummaryChars() <= replacedChars * MAX_SUMMARY_SHARE
}

/**
 * Is this summary worth using instead of the mechanical trim?
 *
 * Three ways to say no, and every one of them ends in the mechanical path
 * rather than in an error. Compaction may never be the end of a run — the same
 * rule the thinking downgrade follows (hooks/codex/thinking-downgrade.ts).
 */
export function isUsableSummary(input: UsabilityInput): UsabilityResult {
  const rendered = renderCompactSummary(input.summary)
  const renderedChars = rendered.length
  const contentChars = summaryContentChars(input.summary)
  if (isEmptySummary(input.summary)) {
    return { usable: false, reason: 'empty', renderedChars, contentChars }
  }
  if (contentChars < MIN_SUMMARY_CHARS) {
    return { usable: false, reason: 'too-short', renderedChars, contentChars }
  }
  // A "summary" the size of its source is a copy with a bill attached. This
  // one measures the RENDERED length, because that is what every future
  // request actually pays for.
  if (input.replacedChars > 0 && renderedChars > input.replacedChars * MAX_SUMMARY_SHARE) {
    return { usable: false, reason: 'not-smaller', renderedChars, contentChars }
  }
  return { usable: true, reason: 'ok', renderedChars, contentChars }
}

/** Estimated tokens a rendered summary will cost in every future request. */
export function summaryTokens(s: CompactSummary): number {
  const rendered = renderCompactSummary(s)
  return rendered ? estimateTokens(rendered) : 0
}

// ── Anwenden ────────────────────────────────────────────────────────────────

export interface ApplyCompactInput<T> {
  /** The full outgoing history, system prompt first if there is one. */
  messages: T[]
  /** How many of the NEWEST messages stay verbatim behind the summary. */
  keepRecent: number
  summary: CompactSummary
}

export interface ApplyCompactResult<T> {
  messages: T[]
  /** How many messages the summary stands in for. 0 = nothing was applied. */
  replaced: number
  /** The summary as it went into the payload, or '' when none was applied. */
  rendered: string
}

/** A tool RESULT, native or Hermes-shaped. A kept window may not begin with one. */
function isToolResult(m: { role: string; content?: unknown }): boolean {
  if (m.role === 'tool') return true
  return (
    m.role === 'user' && typeof m.content === 'string' && m.content.includes('<tool_response>')
  )
}

/**
 * Put the summary in front of the kept window.
 *
 * ── WHY THERE IS NO PINNED TASK HERE ───────────────────────────────────────
 *
 * The mechanical path pins the first user message, because its notice can only
 * list tool NAMES and would otherwise lose what was asked (audit C5: a 30-step
 * plan restarted at step 1 because the only thing left was the plan itself).
 * A written summary does not need that crutch: TASK is its first section, and
 * it is the model's own reading of what was asked rather than a verbatim turn
 * that may itself have been superseded four times since. Pinning on top would
 * mean sending the task twice, in two versions, and letting the model decide
 * which one is current.
 *
 * ── WHY THE SUMMARY IS ANNOUNCED AS A SUMMARY ──────────────────────────────
 *
 * The wrapper says, in the payload, that this is a record of removed turns.
 * That is not decoration. The lesson this codebase paid for is written at
 * compactMessages: an 80-character slice of a file the agent had read was
 * indistinguishable from the whole file, so the model edited against content
 * it could no longer see. A summary carries the same danger the moment it can
 * be mistaken for the material itself. Labelled, it cannot be.
 */
export function applyCompactSummary<T extends { role: string; content?: unknown }>(
  input: ApplyCompactInput<T>,
): ApplyCompactResult<T> {
  const rendered = renderCompactSummary(input.summary)
  if (!rendered) return { messages: input.messages, replaced: 0, rendered: '' }
  const body = input.messages[0]?.role === 'system'
    ? input.messages.length - 1
    : input.messages.length
  return spliceSummary(input.messages, body - Math.max(0, Math.floor(input.keepRecent)), rendered)
}

/**
 * The half both appliers share: drop the first `dropLeading` body messages and
 * put `rendered` in front of what is left.
 *
 * `dropLeading` rather than "keep the last N", because that is the quantity
 * that stays true as the conversation grows — the fresh case converts once,
 * the stored case derives it from its anchor, and neither has to re-derive the
 * other's framing later.
 */
function spliceSummary<T extends { role: string; content?: unknown }>(
  messages: T[],
  dropLeading: number,
  rendered: string,
): ApplyCompactResult<T> {
  const unchanged: ApplyCompactResult<T> = { messages, replaced: 0, rendered: '' }
  if (!rendered || dropLeading <= 0) return unchanged

  const hasSystem = messages[0]?.role === 'system'
  const body = hasSystem ? messages.slice(1) : messages
  if (dropLeading >= body.length) return unchanged

  const kept = body.slice(dropLeading)
  // A kept window may not open on a tool result whose call was dropped with
  // the rest — strict OpenAI-compatible providers reject a result with no
  // call in front of it. Same rule as compactMessages.
  while (kept.length > 0 && isToolResult(kept[0])) kept.shift()

  const replaced = body.length - kept.length
  if (replaced <= 0) return unchanged

  return {
    messages: attachNoteToUserMaterial<T>({
      system: hasSystem ? messages[0] : null,
      pinned: null,
      kept,
      note: rendered,
      strip: stripCompactSummary,
    }),
    replaced,
    rendered,
  }
}

// ── Aus einem gespeicherten Eintrag ────────────────────────────────────────

/** The stored shape this module needs. Mirrors types/chat.ts CompactionRecord. */
export interface StoredCompaction {
  summary: string
  upToMessageId: string
}

/** The message shape this module needs to find the cut. */
export interface IdentifiedMessage {
  id?: string
  role: string
  content?: unknown
}

/**
 * Apply the compactions that already happened.
 *
 * Takes the RENDERED summaries from the records rather than re-rendering, so
 * what the transcript block shows and what the model receives are the same
 * bytes by construction rather than by two code paths agreeing.
 *
 * Takes the WHOLE chain, not just the newest one, and that is the point.
 * Each run only summarises what the previous run did not cover
 * (`run-compact-command.ts`, `visible.slice(prevIdx + 1, cutAt)`), which is
 * right on its own: it avoids the summary-of-a-summary decay. But the cut here
 * drops everything before the last anchor. Passing only the newest record
 * therefore deleted the first section twice over: not as messages, because the
 * cut removes them, and not as a summary, because it was never sent. A user
 * who compacted twice lost the beginning of the conversation without being
 * told. Every summary up to the cut goes out, in order.
 *
 * A record whose anchor message is gone (deleted, or filtered out before this
 * call) cannot place a cut. The last record whose anchor still exists decides
 * where the cut falls; records after it are stale and ignored. A stale record
 * is detectable, and the honest answer to "I no longer know where this summary
 * ends" is to send the real history.
 */
export function applyStoredCompaction<T extends IdentifiedMessage>(
  messages: T[],
  records: readonly (StoredCompaction | null | undefined)[] | null | undefined,
): ApplyCompactResult<T> {
  const kette = (records ?? []).filter(
    (r): r is StoredCompaction => Boolean(r?.summary && r?.upToMessageId),
  )
  if (kette.length === 0) return { messages, replaced: 0, rendered: '' }

  const body = messages[0]?.role === 'system' ? messages.slice(1) : messages

  // Der letzte Datensatz, dessen Anker noch dasteht, bestimmt den Schnitt.
  // Alles danach ist veraltet und wird uebergangen.
  let letzter = -1
  let schnitt = -1
  for (let i = kette.length - 1; i >= 0; i--) {
    const treffer = body.findIndex((m) => m.id === kette[i].upToMessageId)
    if (treffer >= 0) { letzter = i; schnitt = treffer; break }
  }
  if (letzter < 0) return { messages, replaced: 0, rendered: '' }

  const rendered = kette.slice(0, letzter + 1).map((r) => r.summary).join('\n\n')
  return spliceSummary(
    messages as unknown as Array<T & { role: string }>,
    schnitt + 1,
    rendered,
  ) as ApplyCompactResult<T>
}

// ───────────────────────────────────────────────────────────────────────────
// Die Anzeige-Haelfte
//
// Der Verlauf behaelt nach einer Verdichtung ALLES. Verdichtet wird die
// Nutzlast, nicht das Gedaechtnis des Nutzers — die alten Nachrichten stehen
// weiter da, oben, lesbar, kopierbar. Sichtbar wird nur die SCHNITTSTELLE:
// eine Zeile an der Stelle, ab der das Modell statt der Turns die
// Zusammenfassung sieht.
//
// Diese Funktionen gehoeren hierher und nicht in die Komponente, weil sie das
// Format kennen muessen. Eine Komponente, die `[compacted-context]` selbst
// wegschneidet, ist beim naechsten Formatwechsel still kaputt; hier steht sie
// neben dem Aufbau und faellt mit ihm zusammen um.
// ───────────────────────────────────────────────────────────────────────────

/** Eine Ueberschrift mit ihrem Text, so wie sie angezeigt werden soll. */
export interface SummarySection {
  heading: string
  body: string
}

/**
 * Der reine Inhalt einer gerenderten Zusammenfassung: ohne Marker, ohne
 * Praeambel.
 *
 * Absichtlich nachsichtig. Ein gespeicherter Datensatz kann aus einer
 * frueheren Fassung stammen, in der die Praeambel anders lautete oder die
 * Marker fehlten. Beides fuehrt hier nicht zu einem Fehler, sondern nur dazu,
 * dass etwas mehr Text stehen bleibt — das ist die richtige Richtung, denn
 * eine alte Zusammenfassung zu ZEIGEN ist immer besser, als sie mit einer
 * strengen Erkennung ganz zu verschlucken.
 */
export function compactSummaryBody(rendered: string): string {
  let t = (rendered || '').trim()
  if (!t) return ''
  const open = t.indexOf(COMPACT_OPEN)
  if (open !== -1) t = t.slice(open + COMPACT_OPEN.length)
  const close = t.indexOf(COMPACT_CLOSE)
  if (close !== -1) t = t.slice(0, close)
  t = t.trim()
  if (t.startsWith(COMPACT_PREAMBLE)) t = t.slice(COMPACT_PREAMBLE.length).trim()
  return t
}

/**
 * Die Abschnitte einer gespeicherten Zusammenfassung, in der Reihenfolge der
 * Leiter, leere weggelassen.
 *
 * `NOTES` bekommt eine Sonderbehandlung: der Aufbau schreibt es als
 * Ueberschrift, aber es steht nicht in SECTIONS (es IST der Rest, nicht ein
 * benanntes Feld). Ohne diesen Schnitt zeigte die Anzeige das Wort NOTES als
 * erste Zeile des Textes an, was wie ein Formatfehler des Modells aussieht,
 * obwohl wir es selbst hingeschrieben haben.
 */
export function summarySections(rendered: string): SummarySection[] {
  const inner = compactSummaryBody(rendered)
  if (!inner) return []
  const parsed = parseCompactSummary(inner)
  const out: SummarySection[] = []
  for (const sec of SECTIONS) {
    const body = parsed[sec.key].trim()
    if (body) out.push({ heading: sec.heading, body })
  }
  // Kein Nachschneiden mehr: seit parseCompactSummary REST_HEADING kennt,
  // steht in `rest` der Text und nicht mehr die Ueberschrift davor. Die frueher
  // hier stehende replace-Zeile war fuer alles, was renderCompactSummary
  // erzeugt, ohnehin tot — sie hat einen Fehler kaschiert, statt ihn zu
  // beheben, und genau das hat ihn so lange am Leben gehalten.
  const rest = parsed.rest.trim()
  if (rest) out.push({ heading: REST_HEADING, body: rest })
  return out
}

/**
 * Wo im sichtbaren Verlauf die Linien einer Verdichtung stehen: je sichtbarer
 * Nachricht die Datensaetze, die NACH ihr angezeigt werden.
 *
 * Drei Faelle, die diese Funktion ueberhaupt noetig machen:
 *
 *  1. Der Schnittpunkt ist unsichtbar. `upToMessageId` kann auf eine
 *     Systemnachricht oder eine ausgeblendete zeigen; der Verlauf filtert
 *     beide weg. Die Linie wandert dann auf die letzte SICHTBARE Nachricht
 *     davor — an der richtigen Stelle, nur eine Zeile hoeher.
 *  2. Der Schnittpunkt ist geloescht. Dann gibt es keine ehrliche Stelle mehr,
 *     und der Datensatz wird uebersprungen. Ihn ersatzweise oben oder unten
 *     anzuhaengen waere schlimmer als ihn wegzulassen: eine Linie an einer
 *     falschen Stelle behauptet etwas ueber den Verlauf, was nicht stimmt.
 *  3. Zwei Verdichtungen landen auf derselben Zeile. Passiert, wenn zwischen
 *     ihnen nur unsichtbare Nachrichten liegen. Beide werden gezeigt, in ihrer
 *     Reihenfolge — nicht die letzte allein, denn dann verschwaende die
 *     Anzeige genau die Information, dass zweimal verdichtet wurde.
 *
 * Reine Rechnung ueber IDs, kein React: dieselbe Entscheidung wie beim
 * Datensatz selbst, der eine ID und keinen Index traegt.
 */
export function compactionAnchors<T extends IdentifiedMessage, R extends StoredCompaction>(
  allMessages: readonly T[],
  visibleIds: readonly string[],
  compactions: readonly R[] | undefined,
): Map<string, R[]> {
  const out = new Map<string, R[]>()
  if (!compactions?.length || !visibleIds.length) return out

  const visible = new Set(visibleIds)
  for (const record of compactions) {
    const cut = allMessages.findIndex((m) => m.id === record.upToMessageId)
    if (cut === -1) continue // Fall 2: der Schnittpunkt existiert nicht mehr.

    let anchor: string | undefined
    for (let i = cut; i >= 0; i--) {
      const id = allMessages[i]?.id
      if (id && visible.has(id)) { anchor = id; break }
    }
    if (!anchor) continue // alles davor unsichtbar — es gibt keine Linie zu ziehen.

    const list = out.get(anchor)
    if (list) list.push(record)
    else out.set(anchor, [record])
  }
  return out
}
