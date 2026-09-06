/**
 * Nebenbefund 2 of the R8 re-measure (2026-08-30, Windows box, installed
 * build): five seconds after a confirmed delete the file still stood in the
 * Installed list and the counter still showed the old number, while the file
 * itself was already off the disk. After about ten seconds both were right.
 *
 * No timer and no cache with a lifetime sat behind that. The list only ever
 * changed at the END of the reconcile chain that runs after the delete:
 * ComfyUI re-reads its model tree (POST /api/refresh, retried with 1s and 2s
 * pauses when it does not answer), then fetchModels does a reachability probe,
 * two /object_info reads and one stat over every remaining file. All of it
 * before a single pixel moved.
 *
 * The delete command has returned Ok by then, so the row and the counter are
 * allowed to say so straight away. The chain still runs and still has the last
 * word; this only stops the app from showing a corpse while it works.
 *
 * Run: npx vitest run src/stores/__tests__/delete-inventory-lag.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AIModel } from '../../types/models'

vi.mock('../../api/ollama', () => ({ unloadModel: vi.fn() }))
vi.mock('../../api/lmstudio', () => ({ unloadLmStudioModel: vi.fn() }))
vi.mock('../../api/engine', () => ({ activateBuiltinModel: vi.fn() }))
vi.mock('../../api/backend', () => ({ isTauri: () => false, backendCall: vi.fn() }))

const { useModelStore } = await import('../modelStore')

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

function comfy(name: string, type: 'image' | 'video'): AIModel {
  return { name, model: name, size: 1024, type, providerName: 'ComfyUI' } as unknown as AIModel
}
function chat(name: string): AIModel {
  return { name, model: name, size: 0, type: 'text', provider: 'ollama', providerName: 'Ollama' } as unknown as AIModel
}

const CKPT = 'Juggernaut-XL_v9.safetensors'

describe('removeInventoryModel', () => {
  beforeEach(() => {
    useModelStore.setState({
      models: [chat('llama3'), comfy(CKPT, 'image'), comfy('flux1-dev-fp8.safetensors', 'image')],
      activeModel: 'llama3',
    })
  })

  it('takes the row out at once', () => {
    useModelStore.getState().removeInventoryModel(CKPT)
    expect(useModelStore.getState().models.map((m) => m.name)).toEqual([
      'llama3', 'flux1-dev-fp8.safetensors',
    ])
  })

  it('takes BOTH lanes out, because one file is one file', () => {
    // A checkpoint is listed under Image and, while AnimateDiff motion modules
    // are installed, under Video as well. Deleting the file empties both rows,
    // so both counters have to move (the R8 run watched Video go 8 to 10 for
    // two checkpoint dummies and back again).
    useModelStore.setState({ models: [comfy(CKPT, 'image'), comfy(CKPT, 'video'), chat('llama3')] })
    useModelStore.getState().removeInventoryModel(CKPT)
    expect(useModelStore.getState().models.map((m) => m.name)).toEqual(['llama3'])
  })

  it('leaves everything else alone', () => {
    const before = useModelStore.getState().models[0]
    useModelStore.getState().removeInventoryModel(CKPT)
    expect(useModelStore.getState().models[0]).toBe(before)
    expect(useModelStore.getState().activeModel).toBe('llama3')
  })

  it('an unknown name changes nothing, not even the array identity', () => {
    const before = useModelStore.getState().models
    useModelStore.getState().removeInventoryModel('never-was-here.safetensors')
    expect(useModelStore.getState().models).toBe(before)
  })

  it('an empty name is not a wildcard', () => {
    const before = useModelStore.getState().models
    useModelStore.getState().removeInventoryModel('')
    expect(useModelStore.getState().models).toBe(before)
  })

  it('the counter a rail badge reads moves with it', () => {
    const imageCount = () => useModelStore.getState().models.filter((m) => m.type === 'image').length
    expect(imageCount()).toBe(2)
    useModelStore.getState().removeInventoryModel(CKPT)
    expect(imageCount()).toBe(1)
  })
})

describe('ModelManager delete path', () => {
  const src = readFileSync(resolve(repo, 'src/components/models/ModelManager.tsx'), 'utf8')
  const body = src.slice(src.indexOf('const handleDelete'), src.indexOf('const filteredModels'))

  it('tells the backend which folder is the user\'s own', () => {
    // ComfyUI lists files from that folder since GH #122, and LU does not
    // delete out of it. Without the folder the backend can only answer "was
    // not found", which reads like a bug rather than a rule.
    expect(body).toMatch(/extraDirs: customModelDirs\(\)/)
  })

  it('drops the row only AFTER the delete command returned', () => {
    // Never before: an optimistic removal ahead of the command would be a
    // guess, and a failed delete would hide a file that is still on the disk.
    const deleted = body.indexOf("backendCall('delete_comfy_model'")
    const dropped = body.indexOf('removeInventoryModel(name)')
    expect(deleted).toBeGreaterThan(-1)
    expect(dropped).toBeGreaterThan(deleted)
  })

  it('and BEFORE the slow rescan, which is the whole point', () => {
    const dropped = body.indexOf('removeInventoryModel(name)')
    const rescan = body.indexOf('refreshComfyModels()')
    const refetch = body.indexOf('fetchModels()')
    expect(dropped).toBeGreaterThan(-1) // else "before the rescan" is vacuously true
    expect(rescan).toBeGreaterThan(dropped)
    expect(refetch).toBeGreaterThan(dropped)
  })

  it('closes the confirm dialog on the same beat', () => {
    // It used to close only after the chain, so the modal stood over the list
    // for those same seconds.
    const deleted = body.indexOf("backendCall('delete_comfy_model'")
    const closed = body.indexOf('setConfirmDelete(null)', deleted)
    const rescan = body.indexOf('refreshComfyModels()')
    expect(closed).toBeGreaterThan(deleted)
    expect(closed).toBeLessThan(rescan)
  })

  it('NEGATIVE CONTROL: the rescan is still there and still the last word', () => {
    // A "fix" that only removed the row and dropped the reconcile would be a
    // false pass: the app would then never learn what ELSE the rescan changed.
    expect(body).toMatch(/await refreshComfyModels\(\)/)
    expect(body).toMatch(/await fetchModels\(\)/)
  })

  it('NEGATIVE CONTROL: the Ollama branch is untouched', () => {
    // Chat models delete through removeModel and their list is fast. Dropping
    // an active chat model from the store by hand would leave the picker
    // pointing at a dead name until the refetch landed, which is a new bug in
    // place of an old delay.
    expect(body).toMatch(/await removeModel\(name\)/)
    expect(body.match(/removeInventoryModel/g)?.length).toBe(1)
  })
})
