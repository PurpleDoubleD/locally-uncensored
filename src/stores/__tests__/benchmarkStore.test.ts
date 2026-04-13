import { describe, it, expect, beforeEach } from 'vitest'
import { useBenchmarkStore, getAverageSpeed, getLeaderboard } from '../benchmarkStore'
import type { BenchmarkResult } from '../../lib/benchmark-prompts'

// ── Helpers ─────────────────────────────────────────────────────

function makeResult(modelName: string, tps: number, overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    modelName,
    promptId: 'speed',
    tokensPerSec: tps,
    timeToFirstToken: 100,
    totalTime: 5000,
    totalTokens: tps * 5,
    timestamp: Date.now(),
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════
//  benchmarkStore
// ═══════════════════════════════════════════════════════════════

describe('benchmarkStore', () => {
  beforeEach(() => {
    useBenchmarkStore.setState({
      results: {},
      isRunning: false,
      currentModel: null,
      currentStep: 0,
      totalSteps: 0,
    })
  })

  // ── addResult ──────────────────────────────────────────────

  describe('addResult', () => {
    it('adds a result for a new model', () => {
      useBenchmarkStore.getState().addResult(makeResult('llama3', 45))
      const results = useBenchmarkStore.getState().results
      expect(results['llama3']).toHaveLength(1)
      expect(results['llama3'][0].tokensPerSec).toBe(45)
    })

    it('accumulates multiple results per model', () => {
      useBenchmarkStore.getState().addResult(makeResult('llama3', 40))
      useBenchmarkStore.getState().addResult(makeResult('llama3', 50))
      useBenchmarkStore.getState().addResult(makeResult('llama3', 45))
      expect(useBenchmarkStore.getState().results['llama3']).toHaveLength(3)
    })

    it('keeps results separate per model', () => {
      useBenchmarkStore.getState().addResult(makeResult('llama3', 40))
      useBenchmarkStore.getState().addResult(makeResult('mistral', 55))
      expect(useBenchmarkStore.getState().results['llama3']).toHaveLength(1)
      expect(useBenchmarkStore.getState().results['mistral']).toHaveLength(1)
    })

    it('creates the array when model has no prior results', () => {
      expect(useBenchmarkStore.getState().results['phi3']).toBeUndefined()
      useBenchmarkStore.getState().addResult(makeResult('phi3', 60))
      expect(useBenchmarkStore.getState().results['phi3']).toBeDefined()
      expect(useBenchmarkStore.getState().results['phi3']).toHaveLength(1)
    })

    it('preserves existing results for other models', () => {
      useBenchmarkStore.getState().addResult(makeResult('llama3', 40))
      useBenchmarkStore.getState().addResult(makeResult('mistral', 55))
      useBenchmarkStore.getState().addResult(makeResult('llama3', 42))
      expect(useBenchmarkStore.getState().results['mistral']).toHaveLength(1)
      expect(useBenchmarkStore.getState().results['llama3']).toHaveLength(2)
    })
  })

  // ── setRunning ─────────────────────────────────────────────

  describe('setRunning', () => {
    it('sets running state with model and total', () => {
      useBenchmarkStore.getState().setRunning(true, 'llama3', 3)
      const state = useBenchmarkStore.getState()
      expect(state.isRunning).toBe(true)
      expect(state.currentModel).toBe('llama3')
      expect(state.totalSteps).toBe(3)
    })

    it('resets currentStep to 0 when starting', () => {
      useBenchmarkStore.setState({ currentStep: 5 })
      useBenchmarkStore.getState().setRunning(true, 'llama3', 3)
      expect(useBenchmarkStore.getState().currentStep).toBe(0)
    })

    it('clears model and steps when stopping', () => {
      useBenchmarkStore.getState().setRunning(true, 'llama3', 3)
      useBenchmarkStore.getState().setRunning(false)
      const state = useBenchmarkStore.getState()
      expect(state.isRunning).toBe(false)
      expect(state.currentModel).toBeNull()
      expect(state.totalSteps).toBe(0)
      expect(state.currentStep).toBe(0)
    })
  })

  // ── setStep ────────────────────────────────────────────────

  describe('setStep', () => {
    it('sets currentStep', () => {
      useBenchmarkStore.getState().setStep(2)
      expect(useBenchmarkStore.getState().currentStep).toBe(2)
    })

    it('increments through steps', () => {
      useBenchmarkStore.getState().setStep(1)
      useBenchmarkStore.getState().setStep(2)
      useBenchmarkStore.getState().setStep(3)
      expect(useBenchmarkStore.getState().currentStep).toBe(3)
    })
  })

  // ── getAverageSpeed ────────────────────────────────────────

  describe('getAverageSpeed', () => {
    it('returns null for model with no results', () => {
      expect(getAverageSpeed({}, 'unknown')).toBeNull()
    })

    it('returns null for empty results array', () => {
      expect(getAverageSpeed({ 'llama3': [] }, 'llama3')).toBeNull()
    })

    it('returns exact value for single result', () => {
      const results = { 'llama3': [makeResult('llama3', 45.3)] }
      expect(getAverageSpeed(results, 'llama3')).toBe(45.3)
    })

    it('calculates average for multiple results', () => {
      const results = {
        'llama3': [
          makeResult('llama3', 40),
          makeResult('llama3', 50),
        ],
      }
      expect(getAverageSpeed(results, 'llama3')).toBe(45)
    })

    it('rounds to one decimal place', () => {
      const results = {
        'llama3': [
          makeResult('llama3', 33.33),
          makeResult('llama3', 33.33),
          makeResult('llama3', 33.34),
        ],
      }
      const avg = getAverageSpeed(results, 'llama3')!
      // 33.333... rounded to 1 decimal
      expect(avg).toBe(33.3)
    })

    it('returns null for non-existent model key', () => {
      const results = { 'llama3': [makeResult('llama3', 40)] }
      expect(getAverageSpeed(results, 'nonexistent')).toBeNull()
    })
  })

  // ── getLeaderboard ─────────────────────────────────────────

  describe('getLeaderboard', () => {
    it('returns empty array for empty results', () => {
      expect(getLeaderboard({})).toEqual([])
    })

    it('sorts models by average tokens/sec descending', () => {
      const results = {
        'slow': [makeResult('slow', 20)],
        'fast': [makeResult('fast', 80)],
        'medium': [makeResult('medium', 50)],
      }
      const board = getLeaderboard(results)
      expect(board).toHaveLength(3)
      expect(board[0].model).toBe('fast')
      expect(board[1].model).toBe('medium')
      expect(board[2].model).toBe('slow')
    })

    it('includes correct run counts', () => {
      const results = {
        'llama3': [makeResult('llama3', 40), makeResult('llama3', 50), makeResult('llama3', 45)],
        'mistral': [makeResult('mistral', 55)],
      }
      const board = getLeaderboard(results)
      const llama = board.find(b => b.model === 'llama3')!
      const mistral = board.find(b => b.model === 'mistral')!
      expect(llama.runs).toBe(3)
      expect(mistral.runs).toBe(1)
    })

    it('calculates correct averages', () => {
      const results = {
        'llama3': [makeResult('llama3', 40), makeResult('llama3', 50)],
      }
      const board = getLeaderboard(results)
      expect(board[0].avgTps).toBe(45)
    })

    it('rounds averages to one decimal', () => {
      const results = {
        'llama3': [makeResult('llama3', 33), makeResult('llama3', 34)],
      }
      const board = getLeaderboard(results)
      expect(board[0].avgTps).toBe(33.5)
    })

    it('handles single model', () => {
      const results = {
        'only-one': [makeResult('only-one', 42.7)],
      }
      const board = getLeaderboard(results)
      expect(board).toHaveLength(1)
      expect(board[0].model).toBe('only-one')
      expect(board[0].avgTps).toBe(42.7)
      expect(board[0].runs).toBe(1)
    })
  })
})
