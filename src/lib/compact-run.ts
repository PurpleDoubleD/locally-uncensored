/**
 * The written summary — the impure half (2.6.8, Compact-Schritt 3b).
 *
 * compact-summary.ts builds the request and reads the answer. This module is
 * the one round trip in between, and it exists as its own file for one reason:
 * every hazard of an internal model call in this app is a separate, measured
 * bug, and putting them in the same place as the prompt logic would mean every
 * prompt test needs a fake provider.
 *
 * ── THE SIX THINGS THAT GO WRONG, AND WHERE EACH WAS MEASURED ──────────────
 *
 *  1. NO TIMEOUT. `chatWithTools` carries only `options.signal`; the no-chunk
 *     watchdog (`idleAbortGuard`) lives in `chatStream` alone. A wedged
 *     backend hangs a `chatWithTools` caller forever. So this module streams
 *     and collects — the same shape useMemory.ts uses for extraction — and
 *     puts its OWN deadline on top, because the built-in guard measures
 *     silence between chunks, not total time.
 *
 *  2. THINKING LEAKS INTO THE ANSWER. Qwen3's Ollama template pre-opens
 *     `<think>` in the PROMPT, so what comes back is reasoning, then a bare
 *     `</think>`, then the answer — with no opening tag for a naive stripper
 *     to find. Only `settleThinking` (via splitOrphanCloser) catches that
 *     shape. Without it the summary that goes into every future request opens
 *     with the model's private reasoning about how to summarise.
 *
 *  3. THE NATIVE THINKING CHANNEL. Reasoning also arrives on its own field,
 *     separate from the content. Reading only `content` is the whole fix, and
 *     it is what agents/architect.ts already does.
 *
 *  4. num_ctx CHURN. An Ollama call with no options makes Ollama throw away
 *     the KV allocation the chat just paid for and reload the model at its own
 *     default — measured on the ship exe, where the chat sent 32768, the
 *     extraction that follows every turn sent nothing, and `ollama ps` then
 *     reported 4096 while the UI still said 32K. Same model, same num_ctx:
 *     `resolveAgentNumCtx` is the one resolver.
 *
 *  5. STOP DOES NOT REACH IT. Passing `{}` as options means the abort can only
 *     be seen BETWEEN requests; the in-flight one keeps generating and keeps
 *     holding the GPU. The caller's signal is threaded through.
 *
 *  6. NO TOOLS, EVER. The summariser is a text call. Beyond costing nothing,
 *     this is what makes it identical on all three tool-calling strategies —
 *     native, hermes_xml and template_fix never enter the picture, so the one
 *     model class that most needs compaction is also the one this cannot
 *     break on.
 *
 * ── ON COST, AND WHY THIS IS NOT A "SILENT CALL" ───────────────────────────
 *
 * lib/silent-model-calls.ts gates hidden inference on lu-cloud behind an
 * opt-in, because "silent model calls are silent money". That policy is right
 * and this call is deliberately outside it, on both of its own terms:
 *
 *   - It is not silent. Every compaction leaves a visible block in the
 *     transcript saying what it replaced. The memory extraction it was written
 *     for leaves nothing.
 *   - The consent is already explicit and specific. `/compact` is the user
 *     typing the command; auto-compact only ever runs when the user has set
 *     `autoCompactThreshold` themselves, and that setting exists for nothing
 *     else. Asking a second time through `memoryCloudOptIn` — a switch about
 *     MEMORY — would gate this feature behind an unrelated one, and would
 *     silently make a typed `/compact` do nothing at all on a default cloud
 *     profile.
 *
 * The model is the chat's own, not the cheap catalogue model that
 * `pickSilentCallModel` would choose (owner decision, 2026-09-02). A summary
 * is read by the same model on every following turn, and a small model's
 * misreading of a long run is not cheaper than the tokens it saves.
 *
 * ── NEVER THROWS ───────────────────────────────────────────────────────────
 *
 * Every failure returns a reason and the caller falls back to the mechanical
 * trim. Compaction may not be the end of a run — the same rule the thinking
 * downgrade follows.
 */

import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { resolveAgentNumCtx } from './agent-num-ctx'
import { settleThinking } from './thinking-stripper'
import {
  buildCompactPrompt,
  parseCompactSummary,
  summaryFromLooseText,
  isEmptySummary,
  isUsableSummary,
  summaryCouldEverFit,
  renderTranscript,
  EMPTY_SUMMARY,
  type CompactSummary,
  type TranscriptTurn,
  type UsabilityResult,
} from './compact-summary'

/**
 * Deadline for the whole call. Generous, because a long transcript on a small
 * local model is genuinely slow, and the cost of giving up too early is a
 * mechanical trim the user did not need. The provider's own no-chunk guard
 * handles a dead connection long before this fires; this one exists for the
 * other shape — a backend that keeps dribbling tokens and never finishes.
 */
export const COMPACT_TIMEOUT_MS = 120_000

/** Sampling for the summariser. Low temperature: this is a record, not prose. */
export const COMPACT_TEMPERATURE = 0.2

/** Output ceiling. A summary longer than this was not going to be usable. */
export const COMPACT_MAX_TOKENS = 1200

export interface CompactRunInput {
  /** The turns about to be dropped — what the summary must stand in for. */
  turns: TranscriptTurn[]
  /** The prefixed model name the conversation is running on. */
  activeModel: string
  /** Optional steer from `/compact <focus>`. */
  focus?: string
  /** settings.contextWindowOverride. */
  contextWindowOverride?: number
  /** The turn's abort signal, so Stop reaches this call too. */
  signal?: AbortSignal
  /** Override the deadline (tests). */
  timeoutMs?: number
}

export type CompactRunReason =
  | 'ok'
  | 'no-model'      // nothing to call
  | 'empty-input'   // nothing to summarise
  | 'aborted'       // the user pressed Stop
  | 'call-failed'   // the provider errored or timed out
  | 'unusable'      // the model answered, but the answer is not a summary

export interface CompactRunResult {
  ok: boolean
  summary: CompactSummary
  reason: CompactRunReason
  /** Free text for the log; never shown as-is to the user. */
  detail?: string
  /** Present whenever the answer was judged. */
  usability?: UsabilityResult
}

const fail = (reason: CompactRunReason, detail?: string): CompactRunResult => ({
  ok: false, summary: { ...EMPTY_SUMMARY }, reason, detail,
})

/**
 * Ask the conversation's own model to summarise the turns being dropped.
 *
 * Resolves to a result, always. The caller checks `ok` and falls back to the
 * mechanical trim when it is false.
 */
export async function runCompactSummary(input: CompactRunInput): Promise<CompactRunResult> {
  if (!input.activeModel) return fail('no-model')
  const turns = input.turns.filter(
    (t) => typeof t?.content === 'string' && t.content.trim() !== '',
  )
  if (turns.length === 0) return fail('empty-input')

  // Measured against the transcript AS THE MODEL SEES IT, capped and with any
  // earlier summary already stripped — not against the raw turns. Judging a
  // summary "not smaller" against material that was never sent would reject
  // good summaries of very long histories.
  const replacedChars = renderTranscript(turns).length

  // Die Frage vor dem Aufruf, nicht danach: kann eine Zusammenfassung dieser
  // Textmenge ueberhaupt kleiner sein als das, was sie ersetzt? Ist sie es
  // nicht, wuerde `isUsableSummary` unten in JEDEM Fall ablehnen — nach einem
  // vollen Roundtrip. Ein lokales Modell rechnet dann eine Sekunde fuer nichts.
  // Der Grund ist derselbe, den die spaete Pruefung vergeben haette, also
  // liest der Nutzer denselben Satz — nur ohne die Wartezeit davor.
  //
  // Das ist ein enges Tor (unter rund 538 ersetzten Zeichen, siehe die
  // Rechnung bei summaryCouldEverFit) und faengt bewusst nur die Faelle, in
  // denen die Ablehnung SICHER ist. Ein weiteres Tor waere geraten, und
  // geratene Tore lehnen gute Zusammenfassungen ab.
  if (!summaryCouldEverFit(replacedChars)) {
    return { ok: false, summary: { ...EMPTY_SUMMARY }, reason: 'unusable', detail: 'not-smaller' }
  }

  const prompt = buildCompactPrompt(turns, { focus: input.focus })

  // One deadline for the whole call, chained to the caller's signal so Stop
  // still wins. AbortSignal.any is not assumed present — a manual link works
  // on every runtime this app ships to.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), input.timeoutMs ?? COMPACT_TIMEOUT_MS)
  const onOuterAbort = () => deadline.abort()
  input.signal?.addEventListener('abort', onOuterAbort)

  try {
    if (input.signal?.aborted) return fail('aborted')

    const { provider, modelId } = getProviderForModel(input.activeModel)
    const providerId = getProviderIdFromModel(input.activeModel)
    // Same model, same num_ctx — otherwise Ollama reloads (hazard 4).
    const contextWindow = await resolveAgentNumCtx(
      modelId, providerId, input.contextWindowOverride, input.activeModel,
    ).catch(() => undefined)

    let raw = ''
    // chatStream, not chatWithTools: the no-chunk watchdog only exists here
    // (hazard 1). No `tools` field at all (hazard 6).
    const stream = provider.chatStream(modelId, [{ role: 'user', content: prompt }], {
      temperature: COMPACT_TEMPERATURE,
      maxTokens: COMPACT_MAX_TOKENS,
      contextWindow,
      // Denken AUS, und zwar gemessen (03.09.2026, Qwen3.5-9B, genau diese
      // Werte): das Modell verbrauchte alle 1200 Token im Denk-Kanal — 4553
      // Zeichen Ueberlegung — und schrieb KEINE EINZIGE ZEILE Antwort. In der
      // App landet das eine Zeile weiter unten in `fail('unusable', 'empty
      // answer')`. Auf einem Denkmodell war die Verdichtung damit nicht
      // langsam, sondern unmoeglich.
      //
      // Das ist kein Sparen an der Qualitaet: eine Verdichtung ist eine
      // Umschreibung dessen, was schon dasteht, keine Ueberlegung. Die
      // Stripper unten bleiben trotzdem — als Absicherung fuer Modelle, die
      // `think: false` ignorieren oder ihre Ueberlegung in den Text schreiben.
      // Der Anbieter nimmt `think` bei einem 400 selbst wieder heraus, aeltere
      // Ollama-Staende und Nicht-Denkmodelle bleiben also unberuehrt.
      thinking: false,
      signal: deadline.signal,
    })
    for await (const chunk of stream) {
      if (chunk.content) raw += chunk.content
      if (chunk.done) break
    }

    if (input.signal?.aborted) return fail('aborted')
    if (deadline.signal.aborted) return fail('call-failed', 'timed out')

    // Hazards 2 and 3: strip the reasoning that rides inside the content, and
    // never read the separate reasoning channel at all.
    const content = settleThinking(raw, '', false).content.trim()
    if (!content) return fail('unusable', 'empty answer')

    // The forgiving read first; a model that ignored the headings still said
    // something, and keeping it is the whole point of the loose fallback.
    let summary = parseCompactSummary(content)
    if (isEmptySummary(summary)) summary = summaryFromLooseText(content)

    const usability = isUsableSummary({ summary, replacedChars })
    if (!usability.usable) {
      return { ok: false, summary, reason: 'unusable', detail: usability.reason, usability }
    }
    return { ok: true, summary, reason: 'ok', usability }
  } catch (err) {
    if (input.signal?.aborted) return fail('aborted')
    const msg = err instanceof Error ? err.message : String(err)
    return fail('call-failed', deadline.signal.aborted ? `timed out (${msg})` : msg)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onOuterAbort)
  }
}
