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
  renderCompactSummary,
  stripCompactSummary,
  summaryTokens,
  type TranscriptTurn,
} from './compact-summary'
import { estimateTokens } from './context-compaction'
import { computeContextFill, type FillMessage } from './token-usage'
import { shouldAutoCompact, MIN_MESSAGES_SINCE_COMPACT } from './compact-trigger'
import { effectiveSendWindow } from './send-window'
import { useSendSizeStore } from '../stores/sendSizeStore'
import type { CompactionRecord, Message } from '../types/chat'

/**
 * How many of the newest messages stay verbatim behind a summary.
 *
 * The mechanical path keeps KEEP_RECENT (4) as a floor under a budget-driven
 * window. Here the summary carries everything older, so this number answers a
 * different question: how much immediate thread does the model need in its own
 * words? Three exchanges. Fewer, and a follow-up like "do that again but
 * smaller" loses what "that" was; more, and the compaction stops paying for
 * itself on exactly the short-turn conversations that trip the count cap.
 */
export const KEEP_AFTER_COMPACT = 6

export type CompactOutcome =
  | { ok: true; record: CompactionRecord }
  | { ok: false; reason: CompactRunReason | 'no-conversation' | 'nothing-to-compact'; detail?: string }

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
}): Promise<CompactOutcome> {
  if (!opts.activeModel) return { ok: false, reason: 'no-model' }

  const store = useChatStore.getState()
  const conv = store.conversations.find((c) => c.id === opts.conversationId)
  if (!conv) return { ok: false, reason: 'no-conversation' }

  const visible = conv.messages.filter(isModelVisible)
  const cutAt = visible.length - KEEP_AFTER_COMPACT
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

  const result = await runCompactSummary({
    turns,
    activeModel: opts.activeModel,
    focus: opts.focus,
    contextWindowOverride: useSettingsStore.getState().settings.contextWindowOverride,
    signal: opts.signal,
  })
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail }

  const record: CompactionRecord = {
    id: uuid(),
    summary: renderCompactSummary(result.summary),
    upToMessageId: anchor.id,
    replaced: covered.length,
    atMessageCount: conv.messages.length,
    tokensBefore: turns.reduce((n, t) => n + estimateTokens(t.content) + 4, 0),
    tokensAfter: summaryTokens(result.summary),
    trigger: opts.trigger,
    at: Date.now(),
  }
  // Re-read the store: the conversation may have been deleted while the model
  // was writing. recordCompaction is a no-op on a missing id, but reporting
  // success for a chat that no longer exists would be a lie to the caller.
  if (!useChatStore.getState().conversations.some((c) => c.id === opts.conversationId)) {
    return { ok: false, reason: 'no-conversation' }
  }
  useChatStore.getState().recordCompaction(opts.conversationId, record)
  return { ok: true, record }
}

/** The newest record, or undefined. Only the newest shapes a payload. */
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
    return `Summarised ${replaced} earlier message${replaced === 1 ? '' : 's'} — about ${saved.toLocaleString()} tokens less in every following request. The full conversation is still here; only what gets sent changed.`
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
 * Compact before this send, if the user asked for that to happen.
 *
 * Called from every payload builder, and does nothing at all unless
 * `autoCompactThreshold` is set — which is the whole shape of the opt-in.
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
  signal?: AbortSignal
}): Promise<CompactionRecord | null> {
  const threshold = useSettingsStore.getState().settings.autoCompactThreshold
  // The cheap question first: without an opt-in there is nothing to compute,
  // and this runs on every single send.
  if (!threshold) return null
  // Ohne aktives Modell gibt es niemanden, der zusammenfassen koennte. Die
  // Pruefung steht VOR dem Fenster-Aufloesen, denn das fragt das Modell.
  if (!opts.activeModel) return null

  const conv = useChatStore.getState().conversations.find((c) => c.id === opts.conversationId)
  if (!conv) return null

  const visible = conv.messages.filter(isModelVisible)
  const sent = useSendSizeStore.getState().byConv[opts.conversationId]
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
  const fill = computeContextFill(
    conv.messages as unknown as FillMessage[],
    sent ? { tokens: sent.tokens + sent.toolsTokens, atMessageCount: sent.atMessageCount } : undefined,
  )

  let window = opts.window
  let windowIsTrue = opts.windowIsTrue ?? false
  if (window === undefined) {
    const { modelId } = getProviderForModel(opts.activeModel)
    // Der Aufloeser sagt jetzt selbst, ob er gemessen oder geraten hat. Hier
    // stand `window !== 8192` — ein Ratespiel an der Zahl, und in beide
    // Richtungen falsch: 8192 ist Ollamas Voreinstellung UND ein legitimer
    // Override, ein wirklich mit 8192 laufendes Modell galt also dauerhaft
    // als unsicher und wurde acht Prozentpunkte zu frueh zusammengefasst.
    const aufgeloest = await resolveAgentNumCtxWithConfidence(
      modelId,
      getProviderIdFromModel(opts.activeModel),
      useSettingsStore.getState().settings.contextWindowOverride,
      opts.activeModel,
    ).catch(() => ({ ctx: 0, gemessen: false }))
    window = aufgeloest.ctx
    windowIsTrue = window > 0 && aufgeloest.gemessen

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
    // Kappe 64k, 60k belegt, Schwelle 0.8 — der Balken steht bei 94 % und
    // sagt "triggers on the next message", der Ausloeser rechnet 0.3, urteilt
    // 'below' und tut nie etwas. Dauerhaft, nicht nur einmal.
    //
    // NUR in diesem Zweig: wer `window` selbst uebergibt (der einfache Chat
    // mit `modelWindowTokens`), hat seinen Nenner schon gewaehlt, und die
    // Nutzlast des einfachen Chats kennt diese Kappe nicht.
    const st = useSettingsStore.getState().settings
    const gekappt = effectiveSendWindow({
      providerId: getProviderIdFromModel(opts.activeModel),
      modelWindow: window,
      sendWindowTokens: st.codexSendWindowTokens,
      capEnabled: st.contextDecay !== false,
      smallModelMode: st.smallModelMode,
    })
    if (gekappt > 0) window = gekappt
  }

  const verdict = shouldAutoCompact({
    used: fill.used,
    window,
    source: fill.source,
    real: fill.real,
    windowIsTrue,
    messageCount: visible.length,
    threshold,
    lastCompactAtMessageCount: newestCompaction(conv.compactions)?.atMessageCount,
  })
  if (!verdict.shouldCompact) return null

  const outcome = await runCompactForConversation({
    conversationId: opts.conversationId,
    activeModel: opts.activeModel,
    trigger: 'auto',
    signal: opts.signal,
  })
  if (!outcome.ok) {
    meldeAutoFehlschlag(opts.conversationId, outcome)
    return null
  }
  meldeAutoErfolg(opts.conversationId, outcome)
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

/**
 * Same prefix trick for the case that WORKED.
 *
 * The asymmetry was the bug. A failed auto-compaction has written a visible
 * notice into the transcript since it existed; a successful one wrote nothing
 * — although success is the case that changes what the model can still see.
 * The window kept showing the full conversation, the request no longer carried
 * it, and the only way to find out was to read the network traffic. A tester
 * put the cost plainly on 2026-09-03: „Ich glaube, das Werkzeug hat alles, und
 * uebernehme falsche Zahlen in einen Artikel."
 *
 * `notice: 'info'`, not 'warn': nothing went wrong. Something happened, and the
 * person it happened to gets to know. The wording is `compactOutcomeMessage`,
 * the same sentence the manual /compact has always shown — including the half
 * that takes the fright out of it: the conversation is still here, only the
 * payload got shorter.
 */
const AUTO_OK_PREFIX = 'autocompact-ok-'

function meldeAutoErfolg(convId: string, outcome: CompactOutcome & { ok: true }): void {
  useChatStore.getState().addMessage(convId, {
    id: `${AUTO_OK_PREFIX}${outcome.record.id}`,
    role: 'system',
    notice: 'info',
    content: compactOutcomeMessage(outcome),
    timestamp: Date.now(),
  })
}

function meldeAutoFehlschlag(convId: string, outcome: CompactOutcome & { ok: false }): void {
  if (outcome.reason === 'aborted' || outcome.reason === 'nothing-to-compact') return

  const nachrichten = useChatStore.getState().conversations.find((c) => c.id === convId)?.messages ?? []
  const letzteEigene = nachrichten.findLastIndex((m) => m.id.startsWith(AUTO_FAIL_PREFIX))
  if (letzteEigene !== -1 && nachrichten.length - letzteEigene < MIN_MESSAGES_SINCE_COMPACT) return

  useChatStore.getState().addMessage(convId, {
    id: `${AUTO_FAIL_PREFIX}${Date.now()}`,
    role: 'system',
    notice: 'warn',
    content: `Auto-compaction did not go through. ${compactOutcomeMessage(outcome)}`,
    timestamp: Date.now(),
  })
}
