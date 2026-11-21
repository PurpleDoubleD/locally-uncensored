/**
 * GH #235 follow-up (LU-Admin, 15.11.2026): "Unload all models" in the model
 * picker unloaded Ollama only, said "Ollama did not answer" for any failure,
 * and was missing when only the LU Engine ran. It now frees Ollama, the LU
 * Engine, LM Studio and ComfyUI's memory, and names each engine that did not go.
 *
 * Run: npx vitest run src/lib/__tests__/unload-all-frees-every-engine-235.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { unloadEverything, unloadProblems, unloadedNames, type UnloadDeps } from '../unload-everything'

function deps(over: Partial<UnloadDeps> = {}): UnloadDeps & Record<string, ReturnType<typeof vi.fn>> {
  let lms = ['qwen3-8b']
  const d = {
    unloadOllama: vi.fn(async () => ({ unloaded: ['llama3:8b'], stillBusy: [], failed: [] })),
    offload: vi.fn(async () => ({ offloaded: ['bundled-engine', 'comfyui'], notOurs: [] })),
    lmsLoaded: vi.fn(async () => lms),
    lmsUnloadAll: vi.fn(async () => { lms = [] }),
    desktop: vi.fn(() => true),
    ...over,
  }
  return d as never
}

describe('Unload all models frees every engine', () => {
  it('Ollama, the LU Engine, LM Studio and ComfyUI, and says nothing went wrong', async () => {
    const d = deps()
    const r = await unloadEverything({ ollama: true, lmstudio: true }, d)
    expect(d.unloadOllama).toHaveBeenCalledOnce()
    expect(d.offload).toHaveBeenCalledOnce()
    expect(d.lmsUnloadAll).toHaveBeenCalledOnce()
    expect(unloadedNames(r.outcomes)).toEqual(['Ollama', 'LU Engine', 'ComfyUI', 'LM Studio'])
    expect(unloadProblems(r.outcomes)).toBeNull()
  })

  it('with only the LU Engine running, Ollama and LM Studio are not asked', async () => {
    const d = deps()
    const r = await unloadEverything({ ollama: false, lmstudio: false }, d)
    expect(d.unloadOllama).not.toHaveBeenCalled()
    expect(d.lmsLoaded).not.toHaveBeenCalled()
    expect(unloadedNames(r.outcomes)).toEqual(['LU Engine', 'ComfyUI'])
  })

  it('a failure names its own engine, the others still go', async () => {
    const d = deps({
      unloadOllama: vi.fn(async () => { throw new Error('ECONNREFUSED') }),
      lmsLoaded: vi.fn(async () => { throw new Error('lms gone') }),
    })
    const r = await unloadEverything({ ollama: true, lmstudio: true }, d)
    const text = unloadProblems(r.outcomes)!
    expect(text).toContain('Ollama did not answer')
    expect(text).toContain('LM Studio did not answer')
    expect(text).not.toMatch(/LU Engine|ComfyUI/)
    expect(unloadedNames(r.outcomes)).toEqual(['LU Engine', 'ComfyUI'])
  })

  it('the LU Engine failing is said as the LU Engine, not as Ollama', async () => {
    const d = deps({ offload: vi.fn(async () => { throw new Error('ipc') }) })
    const text = unloadProblems((await unloadEverything({ ollama: true, lmstudio: false }, d)).outcomes)!
    expect(text).toContain('The LU Engine did not stop')
    expect(text).not.toContain('Ollama')
  })

  it('a ComfyUI on another computer is said as such', async () => {
    const why = 'ComfyUI is configured on another host, so its VRAM is not this machine\'s to free'
    const d = deps({ offload: vi.fn(async () => ({ offloaded: ['bundled-engine'], notOurs: [{ backend: 'comfyui', why }] })) })
    expect(unloadProblems((await unloadEverything({ ollama: false, lmstudio: false }, d)).outcomes)).toMatch(/ComfyUI runs on another computer/)
  })

  it('NEGATIVE CONTROL (from the real run): no ComfyUI running is not a problem', async () => {
    // The app's own words on the Mac test build, 15.11.2026, ComfyUI not started.
    const why = 'nothing answered /free there (error sending request for url (http://localhost:8188/free))'
    const d = deps({ offload: vi.fn(async () => ({ offloaded: ['bundled-engine'], notOurs: [{ backend: 'comfyui', why }, { backend: 'ollama', why: 'nothing answered /api/ps there' }] })) })
    const r = await unloadEverything({ ollama: false, lmstudio: false }, d)
    expect(unloadProblems(r.outcomes)).toBeNull()
    expect(unloadedNames(r.outcomes)).toEqual(['LU Engine'])
  })

  it('a ComfyUI that answers with an error is named', async () => {
    const d = deps({ offload: vi.fn(async () => ({ offloaded: ['bundled-engine'], notOurs: [{ backend: 'comfyui', why: '/free answered HTTP 500' }] })) })
    expect(unloadProblems((await unloadEverything({ ollama: false, lmstudio: false }, d)).outcomes)).toBe('ComfyUI did not free its memory.')
  })

  it('LM Studio still holding a model after the unload is named', async () => {
    const d = deps({ lmsUnloadAll: vi.fn(async () => {}) })
    expect(unloadProblems((await unloadEverything({ ollama: false, lmstudio: true }, d)).outcomes)).toBe('LM Studio still has qwen3-8b loaded.')
  })

  it('NEGATIVE CONTROL: in the browser only Ollama is asked', async () => {
    const d = deps({ desktop: vi.fn(() => false) })
    const r = await unloadEverything({ ollama: true, lmstudio: true }, d)
    expect(d.offload).not.toHaveBeenCalled()
    expect(d.lmsLoaded).not.toHaveBeenCalled()
    expect(r.outcomes.map((o) => o.engine)).toEqual(['ollama'])
  })
})

describe('the button', () => {
  const src = readFileSync(resolve(__dirname, '../../components/models/ModelSelector.tsx'), 'utf8')
  it('is there for every local engine, also the LU Engine alone', () => {
    expect(src).toMatch(/const showUnloadAll = hasOllamaModels \|\| hasLmStudioRows \|\| luEngineHoldsChat \|\| !!luLoadedPath\n/)
    expect(src).toMatch(/\{showUnloadAll && \(/)
    expect(src).not.toContain("'Could not unload the models. Ollama did not answer.'")
  })
})
