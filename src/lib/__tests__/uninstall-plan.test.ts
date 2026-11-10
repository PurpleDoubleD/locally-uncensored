// C17: one click uninstalls a model with all its files, and the dialog says
// before anything goes which files go, which stay and why.
import { describe, it, expect } from 'vitest'
import {
  bundleUninstallPlan, installedFileUninstallPlan, engineUninstallPlan, ollamaUninstallPlan,
  bundlesWithFile, type FileOnDisk,
} from '../uninstall-plan'
import type { ModelBundle, DiscoverModel } from '../../api/model-bundles'

const file = (filename: string, subfolder = 'diffusion_models'): DiscoverModel =>
  ({ name: filename, description: '', pulls: '', tags: [], updated: '', filename, subfolder, downloadUrl: `https://x/${filename}` })
const bundle = (name: string, files: DiscoverModel[]): ModelBundle => ({
  name, description: '', tags: [], totalSizeGB: 1, vramRequired: '', vramMinGB: null, vramComfortGB: null,
  workflow: 'wan', tier: 'standard', files,
})
const disk = (bytes: number, extra: Partial<FileOnDisk> = {}): FileOnDisk =>
  ({ path: `/test/models/${bytes}`, bytes, ownFolder: false, copies: 1, ...extra })

const WAN = bundle('Wan Test', [file('wan_model.safetensors'), file('umt5.safetensors', 'text_encoders'), file('wan_vae.safetensors', 'vae')])
const WAN_FAST = bundle('Wan Test Fast', [file('wan_fast.gguf'), file('umt5.safetensors', 'text_encoders'), file('wan_vae.safetensors', 'vae')])
const ALL = [WAN, WAN_FAST]

describe('a bundle goes with all its files', () => {
  it('every file on the disk goes, and the freed space is their sum', () => {
    const onDisk = new Map([['wan_model.safetensors', disk(1000)], ['umt5.safetensors', disk(200)], ['wan_vae.safetensors', disk(30)]])
    const plan = bundleUninstallPlan(WAN, ALL, { 'Wan Test': true }, onDisk)
    expect(plan.files.map((f) => [f.ref, f.action])).toEqual([
      ['wan_model.safetensors', 'delete'], ['umt5.safetensors', 'delete'], ['wan_vae.safetensors', 'delete'],
    ])
    expect(plan.freeBytes).toBe(1230)
  })

  it('THE RULE: a file another installed model needs stays, and says which', () => {
    const onDisk = new Map([['wan_model.safetensors', disk(1000)], ['umt5.safetensors', disk(200)], ['wan_vae.safetensors', disk(30)]])
    const plan = bundleUninstallPlan(WAN, ALL, { 'Wan Test': true, 'Wan Test Fast': true }, onDisk)
    const kept = plan.files.filter((f) => f.action === 'keep')
    expect(kept.map((f) => f.ref)).toEqual(['umt5.safetensors', 'wan_vae.safetensors'])
    expect(kept[0].reason).toContain('Wan Test Fast')
    expect(plan.freeBytes).toBe(1000)
  })

  it('GEGENPROBE: a model that is not installed keeps nothing alive', () => {
    const onDisk = new Map([['umt5.safetensors', disk(200)]])
    const plan = bundleUninstallPlan(WAN, ALL, { 'Wan Test': true, 'Wan Test Fast': false }, onDisk)
    expect(plan.files.every((f) => f.action === 'delete')).toBe(true)
  })

  it('a file in the user\'s own folder (Storage) is never deleted', () => {
    const onDisk = new Map([['wan_model.safetensors', disk(1000, { ownFolder: true })]])
    const plan = bundleUninstallPlan(WAN, ALL, {}, onDisk)
    expect(plan.files[0].action).toBe('keep')
    expect(plan.files[0].reason).toMatch(/own model folder/)
    expect(plan.freeBytes).toBe(0)
  })

  it('a file with two copies is left to the user', () => {
    const onDisk = new Map([['wan_model.safetensors', disk(1000, { copies: 2 })]])
    expect(bundleUninstallPlan(WAN, ALL, {}, onDisk).files[0].action).toBe('keep')
  })

  it('a file that is not on the disk is not listed', () => {
    const onDisk = new Map<string, FileOnDisk | null>([['wan_model.safetensors', disk(1000)], ['umt5.safetensors', null]])
    expect(bundleUninstallPlan(WAN, ALL, {}, onDisk).files.map((f) => f.ref)).toEqual(['wan_model.safetensors'])
  })
})

describe('the bin of an Installed row', () => {
  it('the model file of one bundle takes its companions along', () => {
    const onDisk = new Map([['wan_model.safetensors', disk(1000)], ['umt5.safetensors', disk(200)], ['wan_vae.safetensors', disk(30)]])
    const plan = installedFileUninstallPlan('wan_model.safetensors', ALL, { 'Wan Test': true }, onDisk)
    expect(plan.title).toBe('Wan Test')
    expect(plan.files).toHaveLength(3)
  })

  it('a shared file is only itself, and the note names who needs it', () => {
    const onDisk = new Map([['umt5.safetensors', disk(200)]])
    const plan = installedFileUninstallPlan('umt5.safetensors', ALL, { 'Wan Test': true, 'Wan Test Fast': true }, onDisk)
    expect(plan.files.map((f) => f.ref)).toEqual(['umt5.safetensors'])
    expect(plan.note).toContain('Wan Test Fast')
  })

  it('a file of no bundle (a CivitAI checkpoint) is only itself', () => {
    const onDisk = new Map([['my_model.safetensors', disk(5000)]])
    const plan = installedFileUninstallPlan('my_model.safetensors', ALL, {}, onDisk)
    expect(plan.files).toEqual([expect.objectContaining({ ref: 'my_model.safetensors', action: 'delete', bytes: 5000 })])
  })

  it('a row with a subfolder finds its bundle by the file name', () => {
    expect(bundlesWithFile('wan/wan_model.safetensors', ALL).map((b) => b.name)).toEqual(['Wan Test'])
    expect(bundlesWithFile('sub\\wan_fast.gguf', ALL).map((b) => b.name)).toEqual(['Wan Test Fast'])
  })
})

describe('LU Engine and Ollama', () => {
  it('an LU Engine model lists every part and the image part', () => {
    const plan = engineUninstallPlan('Qwen', [{ path: '/m/q-00001-of-00002.gguf', bytes: 10 }, { path: '/m/q-00002-of-00002.gguf', bytes: 10 }, { path: '/m/q.mmproj.gguf', bytes: 3 }])
    expect(plan.files.map((f) => f.label)).toEqual(['q-00001-of-00002.gguf', 'q-00002-of-00002.gguf', 'q.mmproj.gguf'])
    expect(plan.freeBytes).toBe(23)
  })

  it('an Ollama model says that shared layers may stay', () => {
    const plan = ollamaUninstallPlan('llama3:8b', 4_000)
    expect(plan.kind).toBe('ollama')
    expect(plan.note).toMatch(/Layers/)
  })
})
