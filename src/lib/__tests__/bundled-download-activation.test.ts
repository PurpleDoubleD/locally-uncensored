/**
 * A downloaded GGUF becomes the active chat model, through the picker.
 *
 * Measured on the Windows box, 2026-09-05, build 4070cd91: after the download
 * of Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf the engine ran on
 *   C:\...\models/Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf
 * while list_bundled_models listed
 *   C:\...\models\Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf
 * so `loaded` stayed false, the picker still named the previous model, and
 * the Use click restarted the engine on the same file (PID 36576 -> 30264).
 *
 * Run: npx vitest run src/lib/__tests__/bundled-download-activation.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateDownloadedBundledModel, bundledPickerIdForFile } from '../bundled-download-activation'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

describe('the picker id of a downloaded file', () => {
  it('is the file stem behind the LU Engine prefix, exactly as list_bundled_models names it', () => {
    expect(bundledPickerIdForFile('Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf'))
      .toBe('openai::Llama-3.2-3B-Instruct-abliterated.Q4_K_M')
  })
  it('never carries a folder, whichever separator a caller glued on', () => {
    expect(bundledPickerIdForFile('C:\\Users\\x\\models/orcarouter_Qwen3.8-27B-Uncensored-IQ2_M.gguf'))
      .toBe('openai::orcarouter_Qwen3.8-27B-Uncensored-IQ2_M')
  })
})

describe('activating the model the user just downloaded', () => {
  it('refreshes the list first and then asks the picker for the id, never for a path', async () => {
    const order: string[] = []
    const refresh = vi.fn(async () => { order.push('refresh') })
    const activate = vi.fn(async (id: string) => { order.push(`activate:${id}`) })
    const id = await activateDownloadedBundledModel({
      filename: 'Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf', refresh, activate,
    })
    expect(id).toBe('openai::Llama-3.2-3B-Instruct-abliterated.Q4_K_M')
    expect(order).toEqual(['refresh', 'activate:openai::Llama-3.2-3B-Instruct-abliterated.Q4_K_M'])
    expect(activate.mock.calls[0][0]).not.toMatch(/[\\/]/)
  })
  it('lets a failed activation reach the caller, who owns the error line', async () => {
    await expect(activateDownloadedBundledModel({
      filename: 'x.gguf', refresh: async () => undefined, activate: async () => { throw new Error('engine died') },
    })).rejects.toThrow('engine died')
  })
})

describe('no component starts the engine on a path it glued together itself', () => {
  // NEGATIVE CONTROL for the measured fault: the two download paths used to
  // call startBundledEngine(`${dir}/${file}`). Either coming back is the bug.
  for (const rel of ['src/components/models/DiscoverModels.tsx', 'src/components/onboarding/ModelsStep.tsx']) {
    it(`${rel} goes through the picker`, () => {
      const src = read(rel)
      expect(src, 'a hand-built engine path').not.toMatch(/startBundledEngine\(`\$\{/)
      expect(src, 'the engine started outside the picker').not.toContain('startBundledEngine(')
      expect(src).toContain('bundled-download-activation')
    })
  }
})
