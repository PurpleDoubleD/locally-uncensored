import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REMOTE_ONLY_MODEL, isRemoteOnlyModel } from '../phone-engine-limits'
import { isThinkingModel, resolveThinkFlag } from '../../remote/remoteClient'

describe('Inkling 2 Mini on a phone', () => {
  it.each(['unsloth/Inkling-2-Mini-GGUF', 'thinkingmachines_Inkling-2-Mini-Q8_0.gguf', 'Inkling 2 Mini', 'inkling2-mini'])(
    'does not offer %s for the local engine',
    (name) => expect(isRemoteOnlyModel(name)).toBe(true),
  )

  it.each(['Qwen3.5-4B-Q8_0.gguf', 'Gemma-4-E2B', 'inkwell-7b', null, undefined, ''])('leaves %s alone', (name) => {
    expect(isRemoteOnlyModel(name)).toBe(false)
  })

  it('says the same sentence in the app and in the engine', () => {
    const rust = readFileSync(join(process.cwd(), 'src-tauri/src/commands/engine_inproc.rs'), 'utf8')
    expect(rust).toContain(`"${REMOTE_ONLY_MODEL}"`)
  })

  it.each(['inkling-2-mini', 'inkling-2-mini:26b-a5b', 'thinkingmachines_Inkling-2-Mini-Q3_K_S', 'Inkling-2-Mini-UD-Q4_K_M'])(
    'can think through Remote as %s',
    (name) => {
      expect(isThinkingModel(name)).toBe(true)
      expect(resolveThinkFlag(name, true)).toBe(true)
      expect(resolveThinkFlag(name, false)).toBe(false)
    },
  )
})
