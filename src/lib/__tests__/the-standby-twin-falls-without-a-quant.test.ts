/**
 * A17 (Windows counter-check 03.09.), the first durchfaller: "Ein Modell, das
 * beide haben, steht zweimal da."
 *
 * After the switch to the LU Engine, Models > Installed showed
 *
 *     mlabonne_gemma-3-4b-it-abliterated-Q4_K_M   LU Engine
 *     mlabonne_gemma-3-4b-it-abliterated          LM Studio, standby, OFF
 *
 * one file of 2 489 894 304 bytes under two names, on two different disks
 * (AppData\Roaming\Locally Uncensored\models and .lmstudio\models). The Qwen
 * pair right beside it collapsed correctly, and the only difference was that
 * LM Studio spelled "@q4_k_m" there.
 *
 * Route 3 of the matcher required that NEITHER side name a quant. That rule
 * was written for the other direction, where the row that goes is ours and its
 * file would then be reachable from nowhere. In this direction the row that
 * goes is a standby row, which hides no file at all, so the same evidence buys
 * a different answer. This file pins both halves of that asymmetry.
 *
 * Run: npx vitest run src/lib/__tests__/the-standby-twin-falls-without-a-quant.test.ts
 */
import { describe, it, expect } from 'vitest'
import { dropStandbyRowsServedByLuEngine, dropDuplicateLuEngineRows } from '../lu-engine-rows'

/** A GGUF in the LU Engine folder, as `bundledToAIModels` stamps it. */
const ours = (stem: string, dir = 'C:\\Users\\ddrob\\AppData\\Roaming\\Locally Uncensored\\models') => ({
  name: `openai::${stem}`, model: stem, path: `${dir}\\${stem}.gguf`,
  provider: 'openai', providerName: 'LU Engine',
})

/** A row of the backend waiting beside the slot, as `cloudModelRow` builds it:
 *  no path and no size, because a `/v1/models` listing carries neither. */
const standbyRow = (id: string) => ({
  name: `openai::${id}`, model: id, provider: 'openai', providerName: 'LM Studio',
})

describe('the standby twin of a file the LU Engine is serving', () => {
  // THE FINDING, with the pair from the report.
  it('falls even when only our side names the quant', () => {
    const gemma = ours('mlabonne_gemma-3-4b-it-abliterated-Q4_K_M')
    const kept = dropStandbyRowsServedByLuEngine(
      [standbyRow('mlabonne_gemma-3-4b-it-abliterated')],
      [gemma],
    )
    expect(kept).toEqual([])
  })

  // The pair beside it, which always worked, still works: this is not a fix
  // that trades one collapse for another.
  it('and still falls when LM Studio spells the quant out', () => {
    const qwen = ours('Qwen3-4B-Q4_K_M')
    expect(dropStandbyRowsServedByLuEngine([standbyRow('qwen/qwen3-4b@q4_k_m')], [qwen])).toEqual([])
  })

  // NEGATIVE CONTROL for the count, which is the whole of the evidence here.
  // Two quants of one model on our side and one nameless standby row: nothing
  // says which of the two it means, so it stays and the user keeps both.
  it('stays when we hold two quants of the same model', () => {
    const rows = [standbyRow('mlabonne_gemma-3-4b-it-abliterated')]
    const kept = dropStandbyRowsServedByLuEngine(rows, [
      ours('mlabonne_gemma-3-4b-it-abliterated-Q4_K_M'),
      ours('mlabonne_gemma-3-4b-it-abliterated-Q8_0'),
    ])
    expect(kept).toEqual(rows)
  })

  // A standby row that DOES name a quant is not nameless, so the count route
  // never applies to it: it is dropped only when the quants actually agree.
  it('stays when it names a quant we do not hold', () => {
    const rows = [standbyRow('mlabonne_gemma-3-4b-it-abliterated@q8_0')]
    expect(dropStandbyRowsServedByLuEngine(rows, [ours('mlabonne_gemma-3-4b-it-abliterated-Q4_K_M')]))
      .toEqual(rows)
  })

  // A different model is still a different model. The relaxed route asks for
  // the same identity before it asks anything else.
  it('leaves a standby row for a model we do not have at all', () => {
    const rows = [standbyRow('meta/llama-3.2-3b-instruct')]
    expect(dropStandbyRowsServedByLuEngine(rows, [ours('Qwen3-4B-Q4_K_M')])).toEqual(rows)
  })
})

describe('the other direction is untouched', () => {
  // THE ASYMMETRY, stated as one pair of assertions. The same two names, the
  // same quant on our side, opposite answers, because a dropped standby row
  // hides nothing while a dropped LU Engine row hides a file.
  it('keeps our named quant behind a collapsed LM Studio row, as it always did', () => {
    const gemma = ours('mlabonne_gemma-3-4b-it-abliterated-Q4_K_M')
    const collapsed = [standbyRow('mlabonne_gemma-3-4b-it-abliterated')]
    expect(dropDuplicateLuEngineRows([gemma], collapsed), 'our file went missing').toEqual([gemma])
    // And the very same inputs, read the other way round, collapse.
    expect(dropStandbyRowsServedByLuEngine(collapsed, [gemma])).toEqual([])
  })

  it('still drops our row when LM Studio names the quant we hold', () => {
    const q8 = ours('Qwen2.5-0.5B-Instruct-Q8_0')
    expect(dropDuplicateLuEngineRows([q8], [standbyRow('qwen2.5-0.5b-instruct@q8_0')])).toEqual([])
  })
})
