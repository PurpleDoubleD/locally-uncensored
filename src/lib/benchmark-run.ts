/**
 * The per-prompt measurement, lifted out of the React hook so it can be tested
 * against a synthetic stream instead of a live model.
 *
 * It consumes one chat stream and reports not just how fast the model ran but
 * how much it spent, how much of that went into reasoning, why it stopped, and
 * whether the answer was actually right (David 2026-08-05). The clock is
 * injected so a test can make the timing deterministic; production passes
 * performance.now.
 */

import { createThinkStreamSplitter } from './hermes-stream'
import { settleThinking } from './thinking-stripper'
import type { ChatStreamChunk } from '../api/providers/types'
import { computeGenerationTps } from '../stores/benchmarkStore'

export interface RunMeasurement {
  tokensPerSec: number
  timeToFirstToken: number
  totalTime: number
  totalTokens: number
  thinkTokens: number
  finishReason?: string
  correct: boolean
}

/**
 * The emergency brake (ElBiggus, issue #106, RTX 5080 / Win11 25h2): a model
 * that derails into a loop emits two orders of magnitude more tokens than the
 * task needs and the benchmark simply stops moving, with no way to tell a
 * long run from a dead one. The longest honest answer here is fifty numbers
 * on their own lines plus some reasoning, so a few hundred tokens; 8000 is far
 * outside anything the three prompts can legitimately produce.
 *
 * The wall clock is the second half of the brake, for a machine so slow that
 * a runaway would still be under the token cap an hour in. It is deliberately
 * generous: a big model on CPU is slow, not broken.
 */
export const RUNAWAY_TOKEN_CAP = 8000
export const RUNAWAY_MS_CAP = 300_000

export interface MeasureOptions {
  /** Injected so a test can make timing deterministic. */
  clock?: () => number
  maxTokens?: number
  maxMs?: number
  /** Called the moment a cap trips, so the caller can abort the upstream
   *  request rather than leave the model generating into a dropped stream. */
  onLimit?: (reason: 'runaway' | 'timeout') => void
  /** Resolves after `ms`. Injected for the same reason `clock` is: a test must
   *  be able to trip the wall clock without waiting five real minutes. */
  deadlineIn?: (ms: number) => Promise<void>
}

export async function measureRun(
  stream: AsyncIterable<ChatStreamChunk>,
  check: (answer: string) => boolean,
  options: MeasureOptions = {},
): Promise<RunMeasurement> {
  const {
    clock = () => performance.now(),
    maxTokens = RUNAWAY_TOKEN_CAP,
    maxMs = RUNAWAY_MS_CAP,
    onLimit,
    deadlineIn = (ms) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms) as unknown as { unref?: () => void }
      t.unref?.()
    }),
  } = options
  const startTime = clock()
  let firstTokenTime = 0
  let contentCount = 0
  let thinkCount = 0
  let answerText = ''
  // Splits an inline <think> span out of the content stream. Never
  // startInThink here: a benchmark prompt is a fresh turn and a pre-opened
  // thought closes itself on the first closer, which the settlement below
  // catches for the answer text.
  const inlineThink = createThinkStreamSplitter()
  let finishReason: string | undefined
  let apiEvalCount: number | undefined
  let apiEvalDurationMs: number | undefined

  // Not `for await`: that parks on the pending next() and the wall clock below
  // is only ever read when a chunk arrives. A model that stops sending is
  // exactly the case the wall clock exists for (ElBiggus: "the benchmark simply
  // stops moving"), and it was the one case it could not catch. One deadline
  // for the whole run, raced against every step.
  const iterator = stream[Symbol.asyncIterator]()
  const deadline = deadlineIn(maxMs).then(() => ({ kind: 'timeout' as const }))
  try {
  for (;;) {
    const step = await Promise.race([
      iterator.next().then((r) => ({ kind: 'step' as const, r })),
      deadline,
    ])
    if (step.kind === 'timeout') {
      finishReason = 'timeout'
      break
    }
    if (step.r.done) break
    const chunk = step.r.value
    // Time to first token is the first output of any kind: for a model that
    // reasons out loud the thinking arrives before the answer, and starting
    // the clock only at the first answer token would hide the whole reasoning
    // phase from the generation rate below.
    if ((chunk.content || chunk.thinking) && firstTokenTime === 0) {
      firstTokenTime = clock() - startTime
    }
    if (chunk.thinking) thinkCount++
    if (chunk.content) {
      // 2.6.7 Denk-Audit, Loch 7: a backend that does NOT own a reasoning
      // channel sends the thought inline, as <think> inside the content
      // (Ollama with the think flag unset, llama.cpp with reasoning-format
      // none, LM Studio). Counting that as answer put the reasoning into
      // `answerText`, so the correctness check could pass on a number the
      // model only considered and rejected, and thinkShare read 0 on exactly
      // the local backends the board is used to compare. Same splitter every
      // other surface uses.
      const part = inlineThink.feed(chunk.content)
      if (part.thinking) thinkCount++
      if (part.prose) {
        answerText += part.prose
        contentCount++
      }
    }
    if (chunk.finishReason) finishReason = chunk.finishReason
    // Bug M v2.4.7 — Ollama reports authoritative gen metrics in the done:true
    // chunk. Prefer these over client-side timing because WebView2 release-mode
    // buffers the response stream for fast small models, collapsing
    // firstTokenTime to ~totalTime and producing absurd JS-measured tps values.
    if (chunk.evalCount !== undefined && chunk.evalCount > 0) {
      apiEvalCount = chunk.evalCount
    }
    if (chunk.evalDurationMs !== undefined && chunk.evalDurationMs > 0) {
      apiEvalDurationMs = chunk.evalDurationMs
    }

    // The brake. Breaking out closes the generator; onLimit fires AFTER the
    // loop, because aborting mid-iteration would race the generator's own
    // cleanup and could turn a recorded result into a thrown AbortError. The
    // run is still recorded either way: a model that ran away is a result
    // about that model, and dropping it would leave the board blank exactly
    // where the answer is "it derailed".
    const limit = contentCount + thinkCount > maxTokens
      ? 'runaway' as const
      : clock() - startTime > maxMs
        ? 'timeout' as const
        : null
    if (limit) {
      finishReason = limit
      break
    }
  }
  } finally {
    // for await closed the generator on break; doing it by hand keeps that,
    // so a stalled upstream is released instead of left generating.
    await iterator.return?.(undefined).catch(() => { /* already closed */ })
  }
  if (finishReason === 'runaway' || finishReason === 'timeout') {
    onLimit?.(finishReason)
  }

  const totalTime = clock() - startTime

  // Whatever the splitter still held back, plus the pre-opened shape it could
  // not see coming: the answer the check scores is prose only.
  {
    const rest = inlineThink.flush()
    if (rest.prose) { answerText += rest.prose; contentCount++ }
    if (rest.thinking) thinkCount++
    answerText = settleThinking(answerText, '', false).content
  }

  // totalTokens is the whole output, thinking included, so a model that reasons
  // out loud and one that does not are counted the same way (David 2026-08-05:
  // two 9B models tied on tok/s, one spent 8975 tokens where the other spent
  // 5480 for the same answers). Ollama's evalCount already folds thinking into
  // the count; the JS fallback adds the two chunk counters to match. thinkShare
  // is a ratio of the same chunk units on both paths, so it stays comparable
  // regardless of which branch produced the token total.
  const jsTotal = contentCount + thinkCount
  const thinkShare = jsTotal > 0 ? thinkCount / jsTotal : 0

  // Three-way TPS branch for Bug M (v2.4.7):
  //   1. Provider returned authoritative server metrics (Ollama via
  //      eval_count/eval_duration) -> use them. Most accurate.
  //   2. JS measurement with a real generation phase -> use the post-TTFT
  //      formula (the original Bug M fix). Works for providers that do not
  //      return server metrics but where the stream actually streams.
  //   3. JS measurement collapsed to ~0ms generation phase -> the response was
  //      buffered (Tauri Rust proxy in release-mode collects all bytes before
  //      returning, or WebView2 aggregates TCP packets for fast responses). The
  //      post-TTFT formula would divide by ~0 and produce absurd values like
  //      685k tok/s. Fall back to wall-clock rate (tokens/totalTime). It
  //      under-counts because it includes load and TTFT time but at least is
  //      sane, and a real improvement over pre-v2.4.7 where this case also
  //      produced garbage just via a different formula path.
  const generationTimeMs = totalTime - firstTokenTime
  const hasApiMetrics = apiEvalCount !== undefined && apiEvalDurationMs !== undefined
  const isBuffered = !hasApiMetrics && generationTimeMs < 100 && totalTime > 0
  const reportedTokens = hasApiMetrics ? apiEvalCount! : jsTotal
  const reportedTps = hasApiMetrics
    ? (apiEvalCount! / apiEvalDurationMs!) * 1000
    : isBuffered
      ? (jsTotal / totalTime) * 1000
      : computeGenerationTps(jsTotal, totalTime, firstTokenTime)

  return {
    tokensPerSec: reportedTps,
    timeToFirstToken: firstTokenTime,
    totalTime,
    totalTokens: reportedTokens,
    // thinkShare is measured in chunk units; scaling the authoritative token
    // total by it keeps thinkTokens in the same unit as totalTokens, so
    // thinkTokens / totalTokens is a valid ratio even when the total came from
    // Ollama's evalCount rather than the counters.
    thinkTokens: Math.round(reportedTokens * thinkShare),
    finishReason,
    // The answer is the visible output only. A model that reasoned its way to
    // the right number but never printed it fails here, which is the whole
    // point of measuring correctness next to speed. A run the brake stopped is
    // wrong by definition, whatever happens to sit in the partial text.
    correct: finishReason === 'runaway' || finishReason === 'timeout' ? false : check(answerText),
  }
}
