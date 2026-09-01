import { useBenchmarkStore, getLatestSpeed, getLeaderboard } from '../../stores/benchmarkStore'
import { useBenchmark } from '../../hooks/useBenchmark'
import { Zap, Play, Square, Trophy } from 'lucide-react'

interface Props {
  modelName: string
}

export function BenchmarkButton({ modelName }: Props) {
  const { runBenchmark, stopBenchmark } = useBenchmark()
  const isRunning = useBenchmarkStore((s) => s.isRunning)
  const currentModel = useBenchmarkStore((s) => s.currentModel)
  const currentStep = useBenchmarkStore((s) => s.currentStep)
  const totalSteps = useBenchmarkStore((s) => s.totalSteps)
  const results = useBenchmarkStore((s) => s.results)
  const latestSpeed = getLatestSpeed(results, modelName)

  const isThisRunning = isRunning && currentModel === modelName

  return (
    <div className="flex items-center gap-1.5">
      {latestSpeed !== null && (
        <span className="text-[0.55rem] text-gray-400 lu-hud-num flex items-center gap-0.5" title={`Latest run: ${latestSpeed} tokens/sec`}>
          <Zap size={9} />
          {latestSpeed} t/s
        </span>
      )}
      {isThisRunning ? (
        <button
          onClick={stopBenchmark}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 text-[0.55rem] lu-hud-num hover:bg-red-500/25 transition-colors"
          title="Stop benchmark"
        >
          <Square size={9} />
          {currentStep}/{totalSteps}
        </button>
      ) : (
        <button
          onClick={() => runBenchmark(modelName)}
          disabled={isRunning}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 text-gray-400 text-[0.55rem] hover:bg-white/10 hover:text-gray-300 transition-colors disabled:opacity-30"
          title="Run benchmark"
        >
          <Play size={9} />
          Bench
        </button>
      )}
    </div>
  )
}

export function BenchmarkLeaderboard() {
  const results = useBenchmarkStore((s) => s.results)
  const leaderboard = getLeaderboard(results)

  if (leaderboard.length === 0) return null

  return (
    <div className="mt-4 p-3 rounded-lg bg-white/[0.03] border border-white/5">
      <h3 className="text-[0.7rem] font-semibold text-amber-400 flex items-center gap-1.5 mb-2">
        <Trophy size={12} />
        Benchmark Leaderboard
      </h3>
      <div className="space-y-1.5">
        {leaderboard.map((entry, i) => {
          // Same class as the picker bug of R10: a position in a list that is
          // ordered by something else. getLeaderboard sorts by score
          // (avgTps × accuracy), so row 1 is not the fastest row, and
          // `leaderboard[0].avgTps` as the scale drew bars past 100% for every
          // model that was faster but less accurate than the leader. The
          // longest bar is asked for by value now, not by position.
          const maxTps = Math.max(...leaderboard.map((e) => e.avgTps))
          const barWidth = maxTps > 0 ? (entry.avgTps / maxTps) * 100 : 0

          return (
            <div key={entry.model} className="flex items-center gap-2">
              <span className="text-[0.6rem] text-gray-500 w-4 text-right font-mono">{i + 1}.</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[0.6rem] text-gray-300 truncate">{entry.model}</span>
                  <span className="text-[0.55rem] text-gray-400 lu-hud-num shrink-0 ml-2">{entry.avgTps} t/s</span>
                </div>
                <div className="w-full h-1 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gray-500/60 transition-all duration-500"
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                <div className="flex items-center flex-wrap gap-x-2 mt-0.5 text-[0.5rem] lu-hud-num text-gray-600">
                  {entry.avgTokens !== null && <span>{entry.avgTokens} tok</span>}
                  {entry.accuracy !== null && (
                    <span className={entry.accuracy < 1 ? 'text-amber-400' : 'text-emerald-400'}>
                      {Math.round(entry.accuracy * 100)}% correct
                    </span>
                  )}
                  {entry.truncated > 0 && <span className="text-red-400">{entry.truncated} cut off</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[0.5rem] text-gray-600 mt-2">
        {leaderboard.reduce((s, e) => s + e.runs, 0)} total runs across {leaderboard.length} models
      </p>
    </div>
  )
}
