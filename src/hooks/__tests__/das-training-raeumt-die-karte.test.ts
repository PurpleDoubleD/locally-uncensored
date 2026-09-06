/**
 * The local character trainer is a 12 GB recipe on a 12 GB card. A resident
 * chat model (built-in engine, Ollama, LM Studio) squats 2 to 9 GB of that,
 * and the run used to die in the text-encoder cache or the first training
 * step with CUDA out of memory. Measured on the Windows box on 06.09.2026:
 * 3.6 GB in use before a single training byte, all of it LU's own engines.
 *
 * runCharacterTraining now goes through the same hand-off as a render (Z36):
 * evict before the run starts, restore in the finally. This pins the order
 * and the restore, the way the render path's own tests do.
 *
 * Run: npx vitest run src/hooks/__tests__/das-training-raeumt-die-karte.test.ts
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(path.join(__dirname, '..', 'useCreate.ts'), 'utf8')
const start = src.indexOf('const runCharacterTraining = useCallback(')
const end = src.indexOf('const generateInner = useCallback(')
const training = src.slice(start, end)

describe('the training run frees the card and gives it back', () => {
  it('slices the training function, not the render', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
  })

  it('evicts the chat backends before the run starts', () => {
    const evict = training.indexOf('await evictChatBackendsForRender()')
    const begin = training.indexOf('await startCharacterTraining(')
    expect(evict).toBeGreaterThan(0)
    expect(begin).toBeGreaterThan(evict)
  })

  it('stages the photos first, so a failed staging never evicts anything', () => {
    const stage = training.indexOf('await stageTrainingImage(')
    const evict = training.indexOf('await evictChatBackendsForRender()')
    expect(stage).toBeGreaterThan(0)
    expect(evict).toBeGreaterThan(stage)
  })

  it('brings the chat backends back in the finally, whatever the run did', () => {
    const fin = training.lastIndexOf('} finally {')
    expect(fin).toBeGreaterThan(0)
    expect(training.slice(fin)).toContain('restoreChatBackendsAfterRender(trainingEviction)')
  })

  it('tells the user what happens to the chat model', () => {
    expect(training).toContain('the local chat model pauses until the run ends')
  })
})
