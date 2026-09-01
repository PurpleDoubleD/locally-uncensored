import { useState } from 'react'
import { ArrowLeft, Trophy, Zap, Play, Square, Trash2, Download, ListChecks } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useModels } from '../../hooks/useModels'
import {
  useBenchmarkStore, getLatestSpeed, getLeaderboard,
  toMarkdownReport, unbenchmarked, staleModels,
} from '../../stores/benchmarkStore'
import { useBenchmark } from '../../hooks/useBenchmark'

export function BenchmarkView() {
  const { setView } = useUIStore()
  // appMode-filtered view (useModels choke point) — the raw store also holds
  // hosted lu-cloud models, which would get a "Run Benchmark" button on this
  // local-hardware view and burn credits measuring network speed.
  const { models } = useModels()
  const results = useBenchmarkStore((s) => s.results)
  const isRunning = useBenchmarkStore((s) => s.isRunning)
  const benchError = useBenchmarkStore((s) => s.error)
  const currentModel = useBenchmarkStore((s) => s.currentModel)
  const currentStep = useBenchmarkStore((s) => s.currentStep)
  const totalSteps = useBenchmarkStore((s) => s.totalSteps)
  const clearResults = useBenchmarkStore((s) => s.clearResults)
  const pruneMissing = useBenchmarkStore((s) => s.pruneMissing)
  const { runBenchmark, stopBenchmark } = useBenchmark()
  const leaderboard = getLeaderboard(results)
  const [confirmClear, setConfirmClear] = useState(false)

  // Only show text models (benchmarks don't apply to image/video)
  const textModels = models.filter((m) => m.type === 'text')
  const names = textModels.map((m) => m.name)
  const pending = unbenchmarked(results, names)
  const stale = staleModels(results, names)

  /** Measure everything that has no run yet, one after another. The models
   *  share one GPU, so this is a queue, not a fan-out (M0j0Risin, D#21).
   *  It also stops at the first failure: without that, a dead backend meant
   *  every remaining model marched past in silence. */
  const runPending = async () => {
    useBenchmarkStore.getState().setError(null)
    for (const name of pending) {
      if (useBenchmarkStore.getState().isRunning) break
      await runBenchmark(name)
      if (useBenchmarkStore.getState().error) break
    }
  }

  const exportReport = () => {
    const md = toMarkdownReport(results, new Date().toISOString().slice(0, 16).replace('T', ' '))
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'lu-benchmark.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-2xl mx-auto px-4 py-4">
        {benchError && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/25 text-[0.6rem] text-red-300 flex items-start gap-2">
            <span className="flex-1">{benchError}</span>
            <button
              onClick={() => useBenchmarkStore.getState().setError(null)}
              className="text-red-400 hover:text-red-200 transition-colors"
            >
              Dismiss
            </button>
          </div>
        )}
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => setView('models')} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/5 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors">
            <ArrowLeft size={16} />
          </button>
          <Trophy size={16} className="text-amber-400" />
          <h1 className="text-[0.8rem] font-semibold text-gray-800 dark:text-gray-200">Benchmark</h1>
          <div className="ml-auto flex items-center gap-1">
            {pending.length > 0 && (
              <button
                onClick={runPending}
                disabled={isRunning}
                title={`Benchmark the ${pending.length} model(s) with no result yet, one after another`}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-[0.6rem] hover:bg-gray-200 dark:hover:bg-white/10 transition-colors disabled:opacity-30"
              >
                <ListChecks size={11} />
                Benchmark {pending.length} remaining
              </button>
            )}
            {leaderboard.length > 0 && (
              <button
                onClick={exportReport}
                title="Download the table as Markdown"
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-[0.6rem] hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
              >
                <Download size={11} />
                Export
              </button>
            )}
            {leaderboard.length > 0 && (
              <button
                onClick={() => { if (confirmClear) { clearResults(); setConfirmClear(false) } else setConfirmClear(true) }}
                onBlur={() => setConfirmClear(false)}
                title="Delete every recorded benchmark run"
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[0.6rem] transition-colors ${
                  confirmClear
                    ? 'bg-red-500/20 text-red-500'
                    : 'bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 hover:bg-red-500/15 hover:text-red-500'
                }`}
              >
                <Trash2 size={11} />
                {confirmClear ? 'Confirm' : 'Clear all'}
              </button>
            )}
          </div>
        </div>

        {/* Results whose model is gone — the "out of whack" state from D#21. */}
        {stale.length > 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <p className="text-[0.65rem] text-amber-600 dark:text-amber-400">
              {stale.length} model{stale.length === 1 ? '' : 's'} in this table {stale.length === 1 ? 'is' : 'are'} no longer installed:{' '}
              {stale.slice(0, 3).join(', ')}{stale.length > 3 ? ` and ${stale.length - 3} more` : ''}.
            </p>
            <button
              onClick={() => pruneMissing(names)}
              className="shrink-0 px-2 py-1 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[0.6rem] hover:bg-amber-500/25 transition-colors"
            >
              Remove them
            </button>
          </div>
        )}

        {/* Leaderboard */}
        {leaderboard.length > 0 && (
          <div className="mb-6 p-4 rounded-xl bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/5">
            <h2 className="text-[0.7rem] font-semibold text-amber-500 flex items-center gap-1.5 mb-3">
              <Trophy size={13} />
              Leaderboard
            </h2>
            <div className="space-y-2">
              {leaderboard.map((entry, i) => {
                // The bar follows the ranking, so the picture and the order
                // cannot disagree (issue #106: a board sorted one way and
                // drawn another is where "black box" comes from).
                const topScore = leaderboard[0].score
                const barWidth = topScore > 0 ? (entry.score / topScore) * 100 : 0

                return (
                  <div key={entry.model} className="flex items-center gap-3">
                    <span className={`text-[0.7rem] w-5 text-right font-bold ${i === 0 ? 'text-amber-400' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-orange-700' : 'text-gray-500'}`}>
                      {i + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[0.7rem] text-gray-800 dark:text-gray-200 truncate font-medium">{entry.model}</span>
                        <span className="text-[0.65rem] text-gray-600 dark:text-gray-400 font-mono shrink-0 ml-2 flex items-center gap-1">
                          <Zap size={10} className="text-amber-400" />
                          <span title="Useful throughput: the average rate multiplied by how often the answer was right. This is what the board is ordered by.">
                            {entry.score} t/s useful
                          </span>
                          {entry.score !== entry.avgTps && (
                            <span className="text-gray-500" title="Raw average rate, correct answers and wrong ones counted alike">
                              ({entry.avgTps} raw)
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-gray-200 dark:bg-white/5 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${i === 0 ? 'bg-amber-400' : 'bg-gray-400 dark:bg-gray-500/60'}`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      {/* The economy row: speed is only half the story. Two models
                          can tie on t/s and differ by half again in tokens spent. */}
                      <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[0.55rem] font-mono text-gray-500">
                        {entry.avgTokens !== null && (
                          <span title="Average tokens spent per prompt, reasoning included. Fewer for the same answers is the cheaper model.">
                            {entry.avgTokens} tok
                          </span>
                        )}
                        {entry.thinkShare !== null && entry.thinkShare > 0 && (
                          <span title="Share of the output spent on reasoning before the answer">
                            {Math.round(entry.thinkShare * 100)}% think
                          </span>
                        )}
                        {entry.accuracy !== null && (
                          <span
                            title="How often the answer matched the expected result"
                            className={entry.accuracy < 1 ? 'text-amber-500' : 'text-emerald-500'}
                          >
                            {Math.round(entry.accuracy * 100)}% correct
                          </span>
                        )}
                        {entry.truncated > 0 && (
                          <span title="Runs the token budget cut off before the model was done. Their token counts are a floor, not a measurement." className="text-red-500">
                            {entry.truncated} cut off
                          </span>
                        )}
                        {entry.runaway > 0 && (
                          <span title="Runs stopped by the emergency brake: the model kept generating far past anything the task needs, so it was aborted and counted as wrong." className="text-red-500">
                            {entry.runaway} ran away
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="text-[0.55rem] text-gray-500 mt-3">
              {leaderboard.reduce((s, e) => s + e.runs, 0)} total runs across {leaderboard.length} models.
              {' '}Ordered by average tokens per second multiplied by how often the answer was right,
              so a fast model that answers wrong does not outrank a slower one that answers correctly.
            </p>
          </div>
        )}

        {/* Model List with Bench Buttons */}
        <div className="space-y-1">
          <h2 className="text-[0.65rem] font-semibold uppercase tracking-widest text-gray-500 mb-2">
            {textModels.length} Text Models
          </h2>
          {textModels.map((model) => {
            const latestSpeed = getLatestSpeed(results, model.name)
            const isThisRunning = isRunning && currentModel === model.name

            return (
              <div
                key={model.name}
                className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.03] border border-transparent hover:border-gray-200 dark:hover:border-white/5 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[0.7rem] text-gray-800 dark:text-gray-200 truncate">{model.name}</span>
                  {latestSpeed !== null && (
                    <span className="text-[0.55rem] text-gray-500 font-mono flex items-center gap-0.5 shrink-0" title="Most recent benchmark run">
                      <Zap size={9} className="text-amber-400" />
                      {latestSpeed} t/s
                    </span>
                  )}
                </div>
                <div className="shrink-0">
                  {isThisRunning ? (
                    <button
                      onClick={stopBenchmark}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-red-500/15 text-red-500 text-[0.6rem] hover:bg-red-500/25 transition-colors"
                    >
                      <Square size={10} />
                      {currentStep}/{totalSteps}
                    </button>
                  ) : (
                    <button
                      onClick={() => runBenchmark(model.name)}
                      disabled={isRunning}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-[0.6rem] hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-gray-200 transition-colors disabled:opacity-30"
                    >
                      <Play size={10} />
                      Run Benchmark
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          {textModels.length === 0 && (
            <p className="text-center text-gray-500 text-[0.7rem] py-8">
              No text models installed. Pull a model from the Model Manager first.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
