/**
 * One compaction, from any surface (2.6.8, Compact-Schritt 4).
 *
 * Three hooks need this — plain chat, the agent loop and the coding loop — and
 * the old guard in agent-commands.test.ts named the exact failure of not
 * sharing it: "a second locally-handled command would need its own branch in
 * three hooks and would silently no-op if it did not get one". Three branches
 * are unavoidable (each hook owns its own transcript and its own abort), but
 * three implementations are not. This is the one implementation; a branch is
 * four lines.
 *
 * ── WHAT A COMPACTION ACTUALLY IS HERE ─────────────────────────────────────
 *
 * It is a RECORD, not an edit. Nothing is removed from the store, from the
 * visible transcript, or from any export. The record says "everything up to
 * this message is represented by this summary", and the payload builders read
 * it when they assemble the next request. That is what makes the whole feature
 * reversible: delete the record and the next request carries the full history
 * again, byte for byte.
 *
 * It is also the reason the summary can be shown to the user without a second
 * source of truth — the block in the transcript renders the same string the
 * model receives.
 */

import { v4 as uuid } from 'uuid'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { resolveAgentNumCtxWithConfidence } from './agent-num-ctx'
import { runCompactSummary, type CompactRunReason } from './compact-run'
import {
  chainToSend,
  renderCompactSummary,
  stateFromStored,
  renderTranscript,
  stripCompactSummary,
  summaryCouldEverFit,
  summaryTokens,
  type TranscriptTurn,
} from './compact-summary'
import { estimateTokens } from './context-compaction'
import { computeContextFill, type FillMessage } from './token-usage'
import {
  shouldAutoCompact,
  autoCompactOn,
  resolveCompactThreshold,
  MIN_MESSAGES_SINCE_COMPACT,
} from './compact-trigger'
import { effectiveSendWindow, sendWindowFor } from './send-window'
import { sendsToALanBackend } from './lan-openai-slot'
import { useSendSizeStore } from '../stores/sendSizeStore'
import { COMPACTING_ACTIVITY, useRunActivityStore } from '../stores/runActivityStore'
import type { CompactionRecord, Message } from '../types/chat'
import { formatCount } from './formatters'

/**
 * How many of the newest messages stay verbatim behind a summary when the
 * context window is not known.
 *
 * The mechanical path keeps KEEP_RECENT (4) as a floor under a budget-driven
 * window. Here the summary carries everything older, so this number answers a
 * different question: how much immediate thread does the model need in its own
 * words? Three exchanges. Fewer, and a follow-up like "do that again but
 * smaller" loses what "that" was; more, and the compaction stops paying for
 * itself on exactly the short-turn conversations that trip the count cap.
 */
export const KEEP_AFTER_COMPACT = 6

/**
 * The adaptive window (issue #151): with a known context window, keep as many
 * of the newest messages as fit into this share of it, never fewer than
 * KEEP_MIN and never more than KEEP_MAX.
 *
 * A quarter leaves three quarters for the summary, the system prompt, tools and
 * the answer. The floor is the mechanical path's KEEP_RECENT: two exchanges is
 * the least that still carries what "that" refers to. The ceiling stops a large
 * window from keeping so much that the compaction frees almost nothing; at
 * twenty short turns the immediate thread is long since covered.
 */
export const KEEP_WINDOW_SHARE = 0.25
export const KEEP_MIN = 4
export const KEEP_MAX = 20

/** Per message overhead of the wire format, the same 4 tokensBefore counts. */
const MESSAGE_OVERHEAD_TOKENS = 4

/**
 * How many of the newest visible messages stay verbatim, given the window the
 * payload is built against. Without a window (0, unknown, not a number) the
 * fixed KEEP_AFTER_COMPACT applies, which is what every compaction did before.
 */
export function keepRecentCount(
  visible: ReadonlyArray<{ content: string }>,
  windowTokens: number | undefined,
): number {
  if (!(typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0)) {
    return KEEP_AFTER_COMPACT
  }
  const budget = windowTokens * KEEP_WINDOW_SHARE
  let used = 0
  let count = 0
  for (let i = visible.length - 1; i >= 0 && count < KEEP_MAX; i--) {
    used += estimateTokens(visible[i].content) + MESSAGE_OVERHEAD_TOKENS
    if (used > budget) break
    count++
  }
  return Math.min(KEEP_MAX, Math.max(KEEP_MIN, count))
}

export type CompactOutcome =
  | { ok: true; record: CompactionRecord }
  | { ok: false; reason: CompactRunReason | 'no-conversation' | 'nothing-to-compact'; detail?: string }

/** How full the payload of this chat is, the same reading the counter shows. */
function contextFillOf(conv: { id: string; messages: Message[] }) {
  const sent = useSendSizeStore.getState().byConv[conv.id]
  return computeContextFill(
    conv.messages as unknown as FillMessage[],
    sent ? { tokens: sent.tokens + sent.toolsTokens, atMessageCount: sent.atMessageCount } : undefined,
  )
}

/** A stored message the model actually saw. App notices never reach a model. */
export function isModelVisible(m: Message): boolean {
  return m.role !== 'system' && typeof m.content === 'string' && m.content.trim() !== ''
}

/**
 * Run one compaction on a conversation and record it.
 *
 * Never throws. On any failure the caller keeps the conversation exactly as it
 * was — the mechanical trim is still underneath and still does its job, which
 * is what makes a failed compaction cost a round trip and nothing else.
 */
export async function runCompactForConversation(opts: {
  conversationId: string
  /**
   * Darf null sein. Das ist kein Nachgeben gegenueber einem Aufrufer, der es
   * nicht besser weiss, sondern die richtige Stelle fuer die Frage: ob ein
   * Modell aktiv ist, entscheidet ueber den Ausgang dieses Laufs, und der
   * Ausgang gehoert hierher. Jeder Aufrufer haette sonst dieselbe Pruefung
   * davorgesetzt — und der naechste haette sie vergessen.
   */
  activeModel: string | null
  trigger: 'manual' | 'auto'
  focus?: string
  signal?: AbortSignal
  /**
   * The window the payload is built against, for the adaptive count of kept
   * messages. Omitted, it is resolved here the same way the auto trigger
   * resolves it; 0 means unknown and keeps KEEP_AFTER_COMPACT.
   */
  window?: number
}): Promise<CompactOutcome> {
  if (!opts.activeModel) return { ok: false, reason: 'no-model' }

  const store = useChatStore.getState()
  const conv = store.conversations.find((c) => c.id === opts.conversationId)
  if (!conv) return { ok: false, reason: 'no-conversation' }

  const visible = conv.messages.filter(isModelVisible)
  const window = opts.window
    ?? (await resolveSendWindow(opts.activeModel).catch(() => ({ window: 0 }))).window
  const cutAt = visible.length - keepRecentCount(visible, window)
  if (cutAt <= 0) return { ok: false, reason: 'nothing-to-compact' }

  // Do not re-summarise material an earlier summary already covers: that is
  // the summary-of-a-summary decay this feature is designed to avoid. The cut
  // starts after the newest record's anchor.
  const previous = conv.compactions?.[conv.compactions.length - 1]
  const prevIdx = previous
    ? visible.findIndex((m) => m.id === previous.upToMessageId)
    : -1
  const from = prevIdx >= 0 ? prevIdx + 1 : 0
  // Zwei Wege enden hier, und sie bedeuten Verschiedenes. Der erste (oben)
  // heisst „der Chat ist zu kurz". Dieser heisst „seit der letzten
  // Verdichtung ist zu wenig dazugekommen" — und dem Nutzer zu sagen, sein
  // Chat sei „still short enough to send whole", waehrend darueber eine
  // Verdichtungslinie steht, ist schlicht falsch.
  if (cutAt <= from) return { ok: false, reason: 'nothing-to-compact', detail: 'already-compacted' }

  const covered = visible.slice(from, cutAt)
  const anchor = covered[covered.length - 1]
  const turns: TranscriptTurn[] = covered.map((m) => ({
    role: m.role,
    // An earlier summary riding inside a stored turn would otherwise be read
    // back as transcript and folded into the new one.
    content: stripCompactSummary(m.content),
  }))

  // Billig und vor jedem Modellaufruf: sind die neuen Zuege so kurz, dass
  // keine Verdichtung etwas spart, endet der Lauf hier mit derselben Meldung,
  // die sonst erst nach einem (oder zwei) vergeblichen Aufrufen kaeme. Das
  // gilt fuer die Zusammenfuehrung wie fuer den Rueckfall, denn beide ersetzen
  // dieselben neuen Zuege (Box-Lauf 3, Befund H3).
  const canSave = summaryCouldEverFit(renderTranscript(turns).length)
  if (!canSave) return { ok: false, reason: 'unusable', detail: 'not-smaller' }

  // ── Zusammengefuehrter Stand statt Kette (Issue #151) ────────────────────
  //
  // Steht vor dem Schnitt schon eine Verdichtung, wird ihr Stand mit den neuen
  // Zuegen zu EINEM Stand zusammengefuehrt, und nur dieser geht kuenftig mit.
  // Der Stand ist genau das, was die Nutzlast heute traegt: der neueste
  // zusammengefuehrte Datensatz und die Kettenglieder danach (chainToSend).
  const records = conv.compactions ?? []
  const chain = prevIdx >= 0 ? chainToSend(records, records.length - 1) : []
  const previousState = chain.length ? stateFromStored(chain) : undefined

  // The summary is a model call of its own and can take a while. The
  // transcript shows "Compacting conversation…" for as long as this runs,
  // for /compact as for the automatic trigger (3.0.9). Whatever the run said
  // before comes back afterwards.
  const activity = useRunActivityStore.getState()
  const activityBefore = activity.activity[opts.conversationId] ?? null
  activity.setActivity(opts.conversationId, COMPACTING_ACTIVITY)
  try {
    return await summariseAndRecord()
  } finally {
    useRunActivityStore.getState().setActivity(opts.conversationId, activityBefore)
  }

  async function summariseAndRecord(): Promise<CompactOutcome> {
    if (!opts.activeModel || !conv) return { ok: false, reason: 'no-model' }
    let result = await runCompactSummary({
      turns,
      activeModel: opts.activeModel,
      focus: opts.focus,
      signal: opts.signal,
      previous: previousState,
      window,
    })
    // Scheitert die Zusammenfuehrung, wird wie bisher nur der neue Abschnitt
    // zusammengefasst und als Kettenglied gespeichert. Die alten Datensaetze
    // bleiben unangetastet und gehen weiter mit, es geht also nichts verloren.
    // Abbruch und fehlendes Modell sind keine Gruende fuer einen zweiten Lauf.
    // Der Rueckfall nur, wenn er etwas sparen kann (canSave, oben) und der
    // Grund nicht beim Nutzer oder beim fehlenden Modell liegt.
    if (!result.ok && previousState && canSave
        && result.reason !== 'aborted' && result.reason !== 'no-model') {
      result = await runCompactSummary({
        turns,
        activeModel: opts.activeModel,
        focus: opts.focus,
        signal: opts.signal,
        window,
      })
    }
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail }

    const merged = Boolean(result.merged && previousState)
    // Was ohne diesen Lauf mitginge: die neuen Zuege, und bei einer
    // Zusammenfuehrung auch die Kette, die der neue Stand ersetzt.
    const chainTokens = merged ? chain.reduce((n, r) => n + estimateTokens(r.summary), 0) : 0
    const record: CompactionRecord = {
      id: uuid(),
      summary: renderCompactSummary(result.summary),
      upToMessageId: anchor.id,
      replaced: covered.length,
      atMessageCount: conv.messages.length,
      tokensBefore: turns.reduce((n, t) => n + estimateTokens(t.content) + 4, 0) + chainTokens,
      tokensAfter: summaryTokens(result.summary),
      trigger: opts.trigger,
      at: Date.now(),
      ...(merged ? { merged: true } : {}),
    }
    // The whole payload, for the line in the transcript: what the counter read
    // before, less what the summary saves. An estimate both ways, like the
    // counter's own number between two real usage reports.
    const contextBefore = contextFillOf(conv).used
    if (contextBefore > 0) {
      record.contextBefore = contextBefore
      record.contextAfter = Math.max(0, contextBefore - Math.max(0, record.tokensBefore - record.tokensAfter))
    }
    const newest = conv.messages[conv.messages.length - 1]
    if (newest) record.endMessageId = newest.id
    // Re-read the store: the conversation may have been deleted while the model
    // was writing. recordCompaction is a no-op on a missing id, but reporting
    // success for a chat that no longer exists would be a lie to the caller.
    if (!useChatStore.getState().conversations.some((c) => c.id === opts.conversationId)) {
      return { ok: false, reason: 'no-conversation' }
    }
    useChatStore.getState().recordCompaction(opts.conversationId, record)
    return { ok: true, record }
  }
}

/**
 * The newest record, or undefined.
 *
 * NOT for building a payload. That takes the chain from the newest merged
 * state on (all of it in chats from before 3.0.7), because a plain link only
 * summarises what the previous one did not cover, and a cut placed by the
 * newest anchor drops everything the earlier summaries stand for
 * (`applyStoredCompaction` in `compact-summary.ts`, fixed 04.09.2026). This
 * function exists for one thing only: `atMessageCount`, which the counter and
 * the auto trigger read to answer "how much has been said since the last
 * summary". Both callers are in this file and in `TokenCounter.tsx`.
 */
export function newestCompaction(
  compactions: CompactionRecord[] | undefined,
): CompactionRecord | undefined {
  return compactions?.length ? compactions[compactions.length - 1] : undefined
}

/** One line for the transcript, in the user's terms rather than the code's. */
export function compactOutcomeMessage(outcome: CompactOutcome): string {
  if (outcome.ok) {
    const { replaced, tokensBefore, tokensAfter } = outcome.record
    const saved = Math.max(0, tokensBefore - tokensAfter)
    return `Summarised ${replaced} earlier message${replaced === 1 ? '' : 's'}, about ${formatCount(saved)} tokens less in every following request. The full conversation is still here; only what gets sent changed.`
  }
  switch (outcome.reason) {
    case 'nothing-to-compact':
      if (outcome.detail === 'already-compacted') {
        return 'Nothing new to summarise — everything before the last summary is already covered, and the turns since then are the ones being kept.'
      }
      return 'Nothing to summarise yet — this conversation is still short enough to send whole.'
    case 'no-conversation':
      return 'That chat is gone, so there was nothing to summarise.'
    case 'aborted':
      return 'Stopped before the summary was written. Nothing changed.'
    case 'no-model':
      return 'No model is selected, so there is nothing to write the summary.'
    case 'unusable':
      // 'unusable' hat drei Ursachen, und nur zwei davon liegen beim Modell.
      // 'not-smaller' heisst: die alten Turns sind so kurz, dass die Huelle
      // der Zusammenfassung mehr kostet als der Text, den sie ersetzt. Das
      // dem Modell anzulasten war schlicht unwahr — gemessen am 02.09.2026 an
      // einem Chat, in dem nach Abzug von Marker und Vorrede 92 Zeichen fuer
      // fuenf Abschnitte uebrig blieben.
      if (outcome.detail === 'not-smaller') {
        return 'These turns are already short — a summary would take up more room than they do, so nothing changed.'
      }
      return 'The model did not produce a usable summary, so nothing changed. Older turns still get shortened automatically when the context fills up.'
    default:
      return 'The summary could not be written, so nothing changed. Older turns still get shortened automatically when the context fills up.'
  }
}

// ── Der automatische Auslöser ──────────────────────────────────────────────

/**
 * The window a payload for this model is built against: the model window,
 * capped the way the send path caps it. Shared by the auto trigger (its
 * denominator) and the compaction itself (the adaptive kept window), so both
 * read the same number. A lookup that fails comes back as 0, which both read
 * as unknown.
 */
export async function resolveSendWindow(
  activeModel: string,
): Promise<{ window: number; isTrue: boolean; modelWindow: number }> {
  const { modelId } = getProviderForModel(activeModel)
  // Der Aufloeser sagt jetzt selbst, ob er gemessen oder geraten hat. Hier
  // stand `window !== 8192`: ein Ratespiel an der Zahl, und in beide
  // Richtungen falsch: 8192 ist Ollamas Voreinstellung UND ein legitimer
  // Override, ein wirklich mit 8192 laufendes Modell galt also dauerhaft
  // als unsicher und wurde acht Prozentpunkte zu frueh zusammengefasst.
  const aufgeloest = await resolveAgentNumCtxWithConfidence(
    modelId,
    getProviderIdFromModel(activeModel),
    useSettingsStore.getState().settings.contextWindowOverride,
    activeModel,
  ).catch(() => ({ ctx: 0, gemessen: false }))
  let window = aufgeloest.ctx
  const modelWindow = aufgeloest.ctx
  const isTrue = window > 0 && aufgeloest.gemessen

  // ── Derselbe Nenner wie in der Nutzlast, und nicht das Modellfenster ────
  //
  // `resolveAgentNumCtx` liefert, was das MODELL kann. Was die Schleife
  // gleich darauf wirklich SENDET, ist weniger: `effectiveSendWindow` nimmt
  // einen Anteil davon und, bei bezahlten Anbietern, hoechstens die
  // eingestellte Kappe. Genau diese Zahl ist der Nenner des Fuellbalkens
  // (useActiveContextWindow, "meter honesty"), und genau gegen sie baut die
  // Schleife wenige Zeilen spaeter ihre Nachrichten (useAgentChat:898).
  //
  // Ohne diese Umrechnung rechnete die Anzeige gegen die Kappe und der
  // Ausloeser gegen das Modellfenster. Gemessenes Beispiel: 200k-Modell,
  // Kappe 64k, 60k belegt, Schwelle 0.8: der Balken steht bei 94 % und
  // sagt "triggers on the next message", der Ausloeser rechnet 0.3, urteilt
  // 'below' und tut nie etwas. Dauerhaft, nicht nur einmal.
  //
  // NUR in diesem Zweig: wer `window` selbst uebergibt (der einfache Chat
  // mit `modelWindowTokens`), hat seinen Nenner schon gewaehlt, und die
  // Nutzlast des einfachen Chats kennt diese Kappe nicht.
  const st = useSettingsStore.getState().settings
  const anbieter = getProviderIdFromModel(activeModel)
  const gekappt = effectiveSendWindow({
    providerId: anbieter,
    modelWindow: window,
    sendWindowTokens: sendWindowFor(st, activeModel),
    capEnabled: st.contextDecay !== false,
    smallModelMode: st.smallModelMode,
    localBackend: sendsToALanBackend(anbieter, activeModel),
  })
  if (gekappt > 0) window = gekappt
  return { window, isTrue, modelWindow }
}

/**
 * Compact before this send, when the payload nears the window.
 *
 * Called from every payload builder. On by default since 3.0.7; does nothing
 * at all when `autoCompact` is switched off.
 * Returns the record when one was written, else null; the caller re-reads the
 * conversation afterwards so the fresh record is applied to the payload it is
 * about to build.
 *
 * ── WHY THE DECISION IS NOT MADE HERE ──────────────────────────────────────
 *
 * Everything this function does with numbers, it delegates: the fill comes
 * from computeContextFill (which already knows how to anchor on a real usage
 * report and how to say when it is only guessing), and the verdict comes from
 * shouldAutoCompact (which owns the threshold, the confidence margin and the
 * cooldown). What is left here is plumbing — read the store, ask, act, write.
 * That split is what lets the hard part be unit-tested without a store, a
 * provider or a renderer.
 */
export async function maybeAutoCompact(opts: {
  conversationId: string
  /** Siehe runCompactForConversation: null ist ein Ausgang, kein Fehler. */
  activeModel: string | null
  /**
   * The honest denominator: the send window, else the model window. Omit it
   * and this resolves the same number itself through resolveAgentNumCtx.
   *
   * The option exists because of where the two agent loops resolve theirs:
   * AFTER they have built the message array, while this check has to run
   * BEFORE. Passing it would have meant restructuring two 2000-line hooks and
   * the 38 test files pinned to them. Resolving it here is not a second
   * source — resolveAgentNumCtx is THE resolver, and it is the same call the
   * loop makes a few lines later, cached, so both get the same number by
   * construction rather than by agreement.
   */
  window?: number
  /** Whether that window is the live one rather than a fallback guess. */
  windowIsTrue?: boolean
  /**
   * The send budget would trim the payload as it stands (sendBudgetWouldTrim).
   * A summary then comes first, so the trim is the safety net and not the
   * thing that runs instead of it. See CompactTriggerInput.trimImminent.
   */
  trimImminent?: boolean
  signal?: AbortSignal
}): Promise<CompactionRecord | null> {
  const settings = useSettingsStore.getState().settings
  // The cheap question first: switched off there is nothing to compute, and
  // this runs on every single send.
  if (!autoCompactOn(settings)) return null
  // Ohne aktives Modell gibt es niemanden, der zusammenfassen koennte. Die
  // Pruefung steht VOR dem Fenster-Aufloesen, denn das fragt das Modell.
  if (!opts.activeModel) return null

  const conv = useChatStore.getState().conversations.find((c) => c.id === opts.conversationId)
  if (!conv) return null
  // A summary that just failed is not tried again on the next send. A model
  // that cannot write one fails the same way again, and each try is a full
  // pass over the long history (box run d307-l: five tries of 11K tokens in a
  // row). The own failure notice marks the try; the next one waits as long as
  // after a summary that worked. The send budget still trims meanwhile.
  if (recentAutoFailure(conv.messages)) return null

  const visible = conv.messages.filter(isModelVisible)
  // ── Warum hier die UNGEFILTERTE Liste steht ──────────────────────────────
  //
  // `atMessageCount` wird von beiden Agentenschleifen als
  // `conversations.messages.length` aufgezeichnet — ungefiltert, App-Hinweise
  // eingeschlossen. `computeContextFill` prueft `atMessageCount <= länge`, und
  // mit der gefilterten Liste war diese Bedingung falsch, sobald auch nur EIN
  // Hinweis im Chat stand: der Anker wurde verworfen, und die Fuellstandsquelle
  // fiel stillschweigend von 'built' auf 'estimate' zurueck — eine andere Zahl,
  // eine andere Sicherheitsmarge, und damit ein anderes Urteil als das, was der
  // Nutzer am Balken sah. Der Token-Zaehler uebergab immer schon ungefiltert;
  // die beiden liefen also genau dann auseinander, wenn die App selbst geredet
  // hatte. Dass die Hinweise nicht mitzaehlen, erledigt jetzt
  // `computeContextFill` selbst und fuer BEIDE Aufrufer gleich.
  const fill = contextFillOf(conv)

  let window = opts.window
  let windowIsTrue = opts.windowIsTrue ?? false
  // The model window, for the 32K rule of the default threshold. A window
  // handed in is already the model window (plain chat).
  let modelWindow = window ?? 0
  if (window === undefined) {
    const resolved = await resolveSendWindow(opts.activeModel)
    window = resolved.window
    windowIsTrue = resolved.isTrue
    modelWindow = resolved.modelWindow
  }

  // The threshold follows the window unless the user fixed one, so it is
  // resolved only now that the window is known.
  const threshold = resolveCompactThreshold(settings, window, modelWindow) ?? undefined

  const verdict = shouldAutoCompact({
    used: fill.used,
    window,
    source: fill.source,
    real: fill.real,
    windowIsTrue,
    messageCount: visible.length,
    threshold,
    lastCompactAtMessageCount: newestCompaction(conv.compactions)?.atMessageCount,
    trimImminent: opts.trimImminent,
  })
  if (!verdict.shouldCompact) return null

  // runCompactForConversation shows "Compacting conversation…" while the
  // summary is written, and the record it stores is the line that stays.
  const outcome = await runCompactForConversation({
    conversationId: opts.conversationId,
    activeModel: opts.activeModel,
    trigger: 'auto',
    signal: opts.signal,
    window,
  })
  if (!outcome.ok) {
    meldeAutoFehlschlag(opts.conversationId, outcome)
    return null
  }
  return outcome.record
}

/**
 * Sagt es, wenn eine automatische Kompaktierung schiefging.
 *
 * ── WARUM UEBERHAUPT ───────────────────────────────────────────────────────
 *
 * Der manuelle Weg schreibt sein Ergebnis immer in den Verlauf, gelungen wie
 * misslungen — der Nutzer hat `/compact` getippt, er wartet auf eine Antwort.
 * Der automatische schrieb bisher NUR im Erfolgsfall. Scheiterte er, gab
 * `maybeAutoCompact` null zurueck und der Sendevorgang lief einfach weiter.
 * Fuer den Nutzer sah das aus wie: "Auto-Kompaktierung ist an, der Kontext ist
 * voll, und es passiert nichts." Beim naechsten Senden dasselbe, und beim
 * uebernaechsten. Eine Einstellung, die stumm nicht tut, was sie verspricht,
 * ist schlimmer als keine.
 *
 * ── WARUM NICHT JEDER AUSGANG ──────────────────────────────────────────────
 *
 * Gemeldet wird nur, was der Nutzer nicht schon weiss und was ein Problem
 * ist. 'aborted' hat er selbst ausgeloest. 'nothing-to-compact' ist kein
 * Fehlschlag, sondern die richtige Antwort — und weil dieser Weg VOR JEDEM
 * SENDEN laeuft, waere eine Zeile dafuer eine Zeile pro Nachricht. Uebrig
 * bleibt der Fall, der wirklich zaehlt: es haette gehen sollen und ging nicht.
 *
 * ── WARUM NICHT BEI JEDEM SENDEN, ABER AUCH NICHT NUR EINMAL ───────────────
 *
 * Die Ursache besteht meist fort — ein Modell, das keine brauchbare
 * Zusammenfassung schreibt, schreibt beim naechsten Versuch auch keine. Ohne
 * Bremse stuende die Warnung nach zehn Nachrichten zehnmal da.
 *
 * Die erste Fassung verglich gegen den LETZTEN Hinweis im Verlauf und war in
 * beide Richtungen falsch, gefunden am 02.09.2026:
 *
 *  ZU OFT: schiebt sich irgendein anderer Hinweis dazwischen — und seit dem
 *  selben Tag meldet sich JEDE fertige Hintergrundaufgabe als Hinweis —, ist
 *  die Warnung nicht mehr die letzte, und dieselbe Ursache schreibt sie neu.
 *  Mit fuenf Hintergrundagenten ueber eine Sitzung fuenfmal derselbe Satz.
 *
 *  ZU SELTEN: warnt es bei Nachricht 20 und scheitert danach sechzig Mal
 *  weiter, bleibt es sechzig Nachrichten lang still, waehrend der Zaehler
 *  daneben unbeirrt "triggers on the next message" sagt. Also genau der
 *  Zustand, gegen den diese Warnung ueberhaupt gebaut wurde.
 *
 * Beides behebt derselbe Wechsel: gesucht wird gezielt die letzte EIGENE
 * Warnung (am Id-Praefix, nicht am Text — `compactOutcomeMessage` buendelt
 * mehrere Gruende auf denselben Satz), und geschwiegen wird nur, solange sie
 * noch in Sichtweite steht. `MIN_MESSAGES_SINCE_COMPACT` ist dafuer das
 * richtige Mass, weil es dieselbe Frage beantwortet: wie viel Gespraech muss
 * vergehen, bis eine Kompaktierungssache wieder erwaehnenswert ist.
 *
 * Der Verlauf traegt diesen Zustand und nicht ein Modul-Flag: er ist das, was
 * der Nutzer sieht, und er ueberlebt einen Neustart.
 */
const AUTO_FAIL_PREFIX = 'autocompact-fail-'

// A successful auto-compaction wrote a notice up to 3.0.8 (prefix
// 'autocompact-ok-'); since 3.0.9 the record itself is drawn as the line
// "Compacted, 28.9K → 17.9K". See AUTO_OK_PREFIX in lib/compact-layers.ts.

/** True while the newest own failure notice is fewer than
 *  MIN_MESSAGES_SINCE_COMPACT messages back. */
export function recentAutoFailure(messages: ReadonlyArray<{ id: string }>): boolean {
  const letzteEigene = messages.findLastIndex((m) => m.id.startsWith(AUTO_FAIL_PREFIX))
  return letzteEigene !== -1 && messages.length - letzteEigene < MIN_MESSAGES_SINCE_COMPACT
}

function meldeAutoFehlschlag(convId: string, outcome: CompactOutcome & { ok: false }): void {
  if (outcome.reason === 'aborted' || outcome.reason === 'nothing-to-compact') return

  const nachrichten = useChatStore.getState().conversations.find((c) => c.id === convId)?.messages ?? []
  if (recentAutoFailure(nachrichten)) return

  useChatStore.getState().addMessage(convId, {
    id: `${AUTO_FAIL_PREFIX}${Date.now()}`,
    role: 'system',
    notice: 'warn',
    content: `Auto-compaction did not go through. ${compactOutcomeMessage(outcome)}`,
    timestamp: Date.now(),
  })
}
