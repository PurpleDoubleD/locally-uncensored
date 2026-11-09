/**
 * A Plan-mode run is a LONG read: it explores before it writes anything down,
 * and with the context decay from wave one the same file legitimately comes
 * back several times, because its bytes aged out of the prompt in between.
 *
 * That is exactly the shape detector 3 of the loop guard was built to kill, so
 * plan mode would be unusable if the two were not composed correctly (S1). This
 * pins the composition: a realistic plan run with five identical reads of one
 * file across thirteen steps does NOT halt while those re-reads are the
 * sanctioned kind, and the negative control shows the guard is still awake.
 *
 * Run: npx vitest run src/lib/__tests__/codex-plan-longrun.test.ts
 */
import { describe, it, expect } from 'vitest'
import { AgentLoopGuard } from '../agent-loop-guard'

type Call = { name: string; args: string }

const read = (path: string): Call => ({ name: 'file_read', args: JSON.stringify({ path }) })
const list = (path: string): Call => ({ name: 'file_list', args: JSON.stringify({ path }) })
const search = (q: string): Call => ({ name: 'file_search', args: JSON.stringify({ pattern: q }) })

const keyOf = (c: Call) => `${c.name}|${c.args}`

/**
 * What a plan run actually looks like: one central file read again and again as
 * the picture fills in, with different look-arounds in between. Thirteen steps,
 * five reads of src/router.ts.
 */
const ROUTER = read('src/router.ts')
const STEPS: Call[][] = [
  [ROUTER],
  [list('src')],
  [ROUTER],
  [search('registerRoute')],
  [ROUTER],
  [read('src/app.ts')],
  [list('src/routes')],
  [ROUTER],
  [search('middleware')],
  [read('src/server.ts')],
  [list('tests')],
  [ROUTER],
  [search('router')],
]

describe('a long read-only plan run is not mistaken for a loop', () => {
  it('does not halt over 13 steps with 5 identical reads, while the decay owns them', () => {
    const guard = new AgentLoopGuard()
    let firstRouter = true
    const verdicts = STEPS.map((calls) => {
      // The builder capped the newest result of this read, so the model no
      // longer holds those bytes. The FIRST read is not a re-read.
      const trimmedReadKeys = new Set<string>()
      if (calls.includes(ROUTER)) {
        if (!firstRouter) trimmedReadKeys.add(keyOf(ROUTER))
        firstRouter = false
      }
      return guard.recordBatch(calls, { trimmedReadKeys })
    })

    expect(STEPS.length).toBeGreaterThanOrEqual(12)
    expect(STEPS.filter((s) => s.includes(ROUTER)).length).toBeGreaterThanOrEqual(5)
    expect(verdicts.some((v) => v.action === 'halt')).toBe(false)
  })

  it('negative control: the same 13 steps WITHOUT the decay marking halt', () => {
    const guard = new AgentLoopGuard()
    const verdicts = STEPS.map((calls) => guard.recordBatch(calls))
    expect(verdicts.some((v) => v.action === 'halt')).toBe(true)
  })

  it('negative control: the guard still halts a genuine stall inside a plan run', () => {
    const guard = new AgentLoopGuard()
    // Same batch four times in a row is a stall whatever the decay says
    // (the third gets a warning first, C59 A5).
    const verdicts = [1, 2, 3, 4].map(() =>
      guard.recordBatch([ROUTER], { trimmedReadKeys: new Set([keyOf(ROUTER)]) }),
    )
    expect(verdicts.some((v) => v.action === 'halt')).toBe(true)
  })

  it('a plan run that never repeats a read is untouched', () => {
    const guard = new AgentLoopGuard()
    const verdicts = Array.from({ length: 14 }, (_, i) =>
      guard.recordBatch([read(`src/file-${i}.ts`)]),
    )
    expect(verdicts.every((v) => v.action === 'ok')).toBe(true)
  })
})
