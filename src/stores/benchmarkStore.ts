import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { BenchmarkResult } from '../lib/benchmark-prompts'

interface BenchmarkState {
  results: Record<string, BenchmarkResult[]>
  isRunning: boolean
  currentModel: string | null
  currentStep: number
  totalSteps: number
  /** Why the last run stopped early, or null. A benchmark that cannot start at
   *  all used to be indistinguishable from one that finished. */
  error: string | null
  addResult: (result: BenchmarkResult) => void
  setError: (message: string | null) => void
  setRunning: (running: boolean, model?: string, total?: number) => void
  setStep: (step: number) => void
  /** Drop every recorded run. */
  clearResults: () => void
  /** Drop the runs for one model (renamed, re-quantized, deleted). */
  clearModel: (modelName: string) => void
  /** Drop runs for models that are no longer installed. M0j0Risin, D#21
   *  2026-07-30: "if you change models around, rename them, things get out of
   *  whack with older entries mixed in". */
  pruneMissing: (installedModelNames: string[]) => void
}

export const useBenchmarkStore = create<BenchmarkState>()(
  persist(
    (set) => ({
      results: {},
      isRunning: false,
      currentModel: null,
      currentStep: 0,
      totalSteps: 0,
      error: null,

      setError: (message) => set({ error: message }),

      addResult: (result) => set((s) => {
        const existing = s.results[result.modelName] || []
        return {
          results: {
            ...s.results,
            [result.modelName]: [...existing, result],
          },
        }
      }),

      setRunning: (running, model, total) => set({
        isRunning: running,
        currentModel: model || null,
        totalSteps: total || 0,
        currentStep: 0,
      }),

      setStep: (step) => set({ currentStep: step }),

      clearResults: () => set({ results: {} }),

      clearModel: (modelName) => set((s) => {
        const { [modelName]: _dropped, ...rest } = s.results
        return { results: rest }
      }),

      pruneMissing: (installedModelNames) => set((s) => {
        const installed = new Set(installedModelNames)
        return {
          results: Object.fromEntries(
            Object.entries(s.results).filter(([model]) => installed.has(model)),
          ),
        }
      }),
    }),
    {
      name: 'lu-benchmark-store',
      storage: safeJSONStorage(),
      // Only the measurements are worth keeping. Run state is about the run
      // that is happening now: a persisted isRunning left over from a crash
      // greys out the Run button forever, and a persisted error greets the
      // user with a complaint about a run from last week.
      partialize: (s) => ({ results: s.results }),
    }
  )
)

/** Models with no recorded run yet — what a "measure everything left" pass
 *  works through. */
export function unbenchmarked(results: Record<string, BenchmarkResult[]>, modelNames: string[]): string[] {
  return modelNames.filter((m) => !(results[m]?.length))
}

/** Models that hold runs but are not installed any more. */
export function staleModels(results: Record<string, BenchmarkResult[]>, installedModelNames: string[]): string[] {
  const installed = new Set(installedModelNames)
  return Object.keys(results).filter((m) => !installed.has(m))
}

/**
 * The whole benchmark table as Markdown, so it can be pasted into a report or
 * handed to a model (M0j0Risin, D#21: "it's possible to screen scrape it and
 * get a useful report but it would be cool to be able to export from the app").
 * Ranked like the leaderboard, with the run count and the latest session next
 * to the average so a single fast run cannot masquerade as a stable result.
 */
export function toMarkdownReport(
  results: Record<string, BenchmarkResult[]>,
  generatedAt: string,
): string {
  const board = getLeaderboard(results)
  const lines = [
    '# Local model benchmark',
    '',
    `Generated ${generatedAt} by Locally Uncensored.`,
    '',
  ]
  if (board.length === 0) {
    lines.push('No benchmark runs recorded yet.', '')
    return lines.join('\n')
  }
  const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`)
  // The columns follow the on-screen board, including the score it is ranked
  // by. Exporting a table sorted by score while printing only speed made the
  // order look wrong to anyone reading the file (review 2026-08-14).
  lines.push(
    '| # | Model | Score | Average t/s | Latest t/s | Avg tokens | Think | Correct | Runs |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  board.forEach((entry, i) => {
    const latest = getLatestSpeed(results, entry.model)
    // A run the brake stopped is not a measurement either, and the footer
    // promises cut-off runs are marked. Counting only `truncated` left the
    // capped token count of a runaway sitting in the table unmarked.
    const flags = [
      entry.truncated > 0 ? `${entry.truncated} cut off` : '',
      entry.runaway > 0 ? `${entry.runaway} stopped by the brake` : '',
    ].filter(Boolean).join(', ')
    const tokens = entry.avgTokens === null
      ? '-'
      : `${entry.avgTokens}${flags ? ` (${flags})` : ''}`
    lines.push(
      `| ${i + 1} | ${entry.model} | ${entry.score} | ${entry.avgTps} | ${latest ?? '-'} | ${tokens} | ${pct(entry.thinkShare)} | ${pct(entry.accuracy)} | ${entry.runs} |`,
    )
  })
  lines.push(
    '',
    `${board.reduce((s, e) => s + e.runs, 0)} runs across ${board.length} models.`,
    '',
    'Average is every recorded run. Latest is the most recent benchmark pass.',
    'Avg tokens is the whole output including reasoning; a lower count for the',
    'same answers is the cheaper model. Think is the share of that output spent',
    'reasoning. Correct is how often the answer matched. Score is what the',
    'table is ranked by, speed weighed against correctness. A run cut off by',
    'the token budget or stopped by the brake is marked, and its token count is',
    'a floor, not a measurement.',
    '',
  )
  return lines.join('\n')
}

/** Get average speed for a model (standalone, not a store method) */
export function getAverageSpeed(results: Record<string, BenchmarkResult[]>, modelName: string): number | null {
  const runs = results[modelName]
  if (!runs || runs.length === 0) return null
  const avg = runs.reduce((sum, r) => sum + r.tokensPerSec, 0) / runs.length
  return Math.round(avg * 10) / 10
}

/**
 * Get the LATEST benchmark tps for a model. The Benchmark view shows this
 * next to each model so the displayed number reflects the most recent run,
 * not a session-wide running average that quietly drifts as more samples
 * cancel noise.
 *
 * nightmare13740 (Discord 2026-05-23/24) flagged this on a Bug M retest:
 * gemma4:e4b read 15.2 tok/s on the first run and climbed to 17.9 after ten
 * runs. They thought previous results were affecting new ones — they were,
 * but only because the UI was averaging instead of showing the last sample.
 * The actual measurement was stable; the display was misleading.
 *
 * Per-prompt samples within ONE benchmark click stay averaged (BENCHMARK_PROMPTS
 * has multiple prompts and the average across them within a single session
 * gives a meaningful tok/s). The drift the user saw was across sessions —
 * each "Run Benchmark" click appended more samples without resetting.
 */
export function getLatestSpeed(results: Record<string, BenchmarkResult[]>, modelName: string): number | null {
  const runs = results[modelName]
  if (!runs || runs.length === 0) return null
  // Group consecutive runs by their addedAt timestamp into "sessions" — a
  // session is one click of Run Benchmark across BENCHMARK_PROMPTS prompts.
  // Anything within 10 s of the previous result counts as the same session.
  const SESSION_GAP_MS = 10_000
  let sessionStart = runs.length - 1
  for (let i = runs.length - 1; i > 0; i--) {
    if (runs[i].timestamp - runs[i - 1].timestamp > SESSION_GAP_MS) {
      sessionStart = i
      break
    }
    sessionStart = i - 1
  }
  const lastSession = runs.slice(sessionStart)
  const avg = lastSession.reduce((s, r) => s + r.tokensPerSec, 0) / lastSession.length
  return Math.round(avg * 10) / 10
}

/**
 * Compute tokens-per-second excluding time-to-first-token / stream init.
 *
 * Pre-v2.4.7 we used (tokenCount / totalTime), which lumped stream-init +
 * connection-setup + TTFT into the denominator and undercounted local model
 * speed. nightmare13740 (Discord 2026-05-19) caught this on RTX 4070 Laptop:
 * benchmark showed 12 tok/s, manual chat measurement 23-25 tok/s, ollama CLI
 * baseline 30 tok/s. Generation-phase rate (post-first-token) matches the CLI
 * within run-to-run noise, so we drop TTFT from the denominator and surface
 * it as its own stat.
 */
export function computeGenerationTps(
  tokenCount: number,
  totalTimeMs: number,
  firstTokenTimeMs: number,
): number {
  const generationTimeMs = totalTimeMs - firstTokenTimeMs
  if (generationTimeMs <= 0 || tokenCount <= 0) return 0
  return (tokenCount / generationTimeMs) * 1000
}

/**
 * Average total tokens (thinking included) a model spent per prompt. This is
 * the axis a speed-only board is blind to: two models can tie on tok/s and
 * still differ by half again in tokens spent for the same answers (David
 * 2026-08-05). Null for a model whose runs predate the field.
 */
export function getAverageTokens(results: Record<string, BenchmarkResult[]>, modelName: string): number | null {
  const runs = (results[modelName] ?? []).filter((r) => typeof r.totalTokens === 'number')
  if (runs.length === 0) return null
  return Math.round(runs.reduce((s, r) => s + r.totalTokens, 0) / runs.length)
}

/**
 * Fraction of a model's runs whose answer matched, over the runs that recorded
 * a verdict. Null when no run carries one, which is every result from before
 * 2.6.3 and any run of a prompt with no check.
 */
export function getAccuracy(results: Record<string, BenchmarkResult[]>, modelName: string): number | null {
  const runs = (results[modelName] ?? []).filter((r) => r.correct !== undefined)
  if (runs.length === 0) return null
  return runs.filter((r) => r.correct).length / runs.length
}

/**
 * Average share of output spent on reasoning, 0..1, over runs that recorded a
 * think-token count. Null when none do. The number that explains a slow-feeling
 * model that is not actually slow, only verbose in its thinking.
 */
export function getAverageThinkShare(results: Record<string, BenchmarkResult[]>, modelName: string): number | null {
  const runs = (results[modelName] ?? []).filter((r) => r.thinkTokens !== undefined && r.totalTokens > 0)
  if (runs.length === 0) return null
  return runs.reduce((s, r) => s + r.thinkTokens! / r.totalTokens, 0) / runs.length
}

/**
 * Runs that ended on the token budget rather than the model deciding it was
 * done. Their token counts are floors and their answers may be cut off, so a
 * benchmark that shows the count without this flag invites the wrong read.
 */
export function getTruncatedCount(results: Record<string, BenchmarkResult[]>, modelName: string): number {
  return (results[modelName] ?? []).filter((r) => r.finishReason === 'length').length
}

/**
 * Runs the emergency brake stopped: a model looping instead of answering
 * (ElBiggus, issue #106). Separate from `truncated`, which is an honest run
 * that met the token budget with the answer still coming.
 */
export function getRunawayCount(results: Record<string, BenchmarkResult[]>, modelName: string): number {
  return (results[modelName] ?? [])
    .filter((r) => r.finishReason === 'runaway' || r.finishReason === 'timeout').length
}

export interface LeaderboardEntry {
  model: string
  avgTps: number
  runs: number
  avgTokens: number | null
  accuracy: number | null
  thinkShare: number | null
  truncated: number
  runaway: number
  /** What the board is ordered by. See rankingScore. */
  score: number
}

/**
 * Speed weighted by how often the answer was right, in tokens per second.
 *
 * Ordering by raw tok/s alone was the second half of ElBiggus's report
 * (issue #106): it puts a model that answers wrong twice as fast above one
 * that answers correctly, and the number carries no hint that correctness was
 * even measured. Multiplying is the honest reading of "useful throughput": at
 * 50% accuracy half the tokens were wasted, so the model earns half its rate.
 *
 * A model whose runs predate correctness scoring keeps its raw rate rather
 * than being pushed to the bottom by a missing field, and the board shows the
 * accuracy column empty so the gap is visible instead of silently assumed.
 */
export function rankingScore(avgTps: number, accuracy: number | null): number {
  return Math.round(avgTps * (accuracy ?? 1) * 10) / 10
}

/** The leaderboard, ordered by useful throughput (rankingScore) with every
 *  input to it visible alongside, so the ranking can be checked by eye rather
 *  than taken on faith. */
export function getLeaderboard(results: Record<string, BenchmarkResult[]>): LeaderboardEntry[] {
  return Object.entries(results)
    .map(([model, runs]) => {
      const avgTps = Math.round((runs.reduce((s, r) => s + r.tokensPerSec, 0) / runs.length) * 10) / 10
      const accuracy = getAccuracy(results, model)
      return {
        model,
        avgTps,
        runs: runs.length,
        avgTokens: getAverageTokens(results, model),
        accuracy,
        thinkShare: getAverageThinkShare(results, model),
        truncated: getTruncatedCount(results, model),
        runaway: getRunawayCount(results, model),
        score: rankingScore(avgTps, accuracy),
      }
    })
    // Raw speed breaks a tie, so two models with the same useful throughput
    // still sort deterministically.
    .sort((a, b) => b.score - a.score || b.avgTps - a.avgTps)
}
