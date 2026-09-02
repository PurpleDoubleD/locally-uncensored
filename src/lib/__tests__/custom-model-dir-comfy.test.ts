/**
 * The second half of GH #122, and the Discord thread "Read me first"
 * (ever.noob, 2026-08-28): LoRAs the user dropped into a folder of his own
 * stayed invisible.
 *
 * LU never scans image or video models off the disk, that inventory comes out
 * of ComfyUI's own `/object_info` enums, and ComfyUI lists only what sits under
 * its own models tree. So there is nothing for LU to scan here and no honest
 * way to call such a file Installed; the fix is to hand the folder to ComfyUI
 * through ComfyUI's own extra-model-paths mechanism. Which subfolders qualify,
 * and the fact that a flat folder qualifies for none, is proven in Rust
 * (`src-tauri/src/commands/custom_models.rs`). This file proves the handover
 * is wired and that the Settings copy no longer claims more than it does.
 *
 * Run: npx vitest run src/lib/__tests__/custom-model-dir-comfy.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
}))

import { syncCustomModelDir } from '../custom-model-dir'

beforeEach(() => { backendCall.mockReset() })

describe('handing the folder to ComfyUI', () => {
  it('names the folder and reports back what ComfyUI will get', async () => {
    backendCall.mockResolvedValue({ written: true, status: 'ok', file: '/data/lu_extra_model_paths.yaml', folders: ['loras', 'vae'] })
    const res = await syncCustomModelDir('  G:\\AI\\Models  ')
    expect(backendCall).toHaveBeenCalledWith('sync_custom_model_paths', { dir: 'G:\\AI\\Models' })
    expect(res).toEqual({ status: 'ok', folders: ['loras', 'vae'] })
  })

  it('clears the registration when the folder is unset', async () => {
    backendCall.mockResolvedValue({ written: false, status: 'off', file: '/data/lu_extra_model_paths.yaml', folders: [] })
    expect(await syncCustomModelDir('')).toEqual({ status: 'off', folders: [] })
    expect(backendCall).toHaveBeenCalledWith('sync_custom_model_paths', { dir: '' })
    expect(await syncCustomModelDir(null)).toEqual({ status: 'off', folders: [] })
  })

  it('carries a folder that cannot be read through as its own verdict', async () => {
    backendCall.mockResolvedValue({ written: false, status: 'unreachable', file: '/x', folders: [] })
    expect(await syncCustomModelDir('Z:\\gone')).toEqual({ status: 'unreachable', folders: [] })
    backendCall.mockResolvedValue({ written: false, status: 'unusable', file: '/x', folders: [] })
    expect(await syncCustomModelDir('~/models')).toEqual({ status: 'unusable', folders: [] })
  })

  // Negative control: an older backend that does not know the command, or a
  // drive that went away, costs the handover and NOTHING else. It must not
  // invent a verdict either, so the panel stays quiet instead of accusing the
  // folder. The GGUF scan is a separate path and must keep working.
  it('stays quiet when the backend cannot do it', async () => {
    backendCall.mockRejectedValue(new Error('Unknown backend command: sync_custom_model_paths'))
    await expect(syncCustomModelDir('G:\\AI\\Models')).resolves.toEqual({ status: 'unknown', folders: [] })
  })
})

describe('the Model Storage copy tells the truth', () => {
  const src = readFileSync(
    join(process.cwd(), 'src/components/settings/SettingsPage.tsx'),
    'utf8',
  )

  it('says the folder is read, not only written to', () => {
    // The shipped sentence started "Custom location for downloaded GGUFs" and
    // stopped there, which is why two users concluded the setting was broken
    // rather than one-directional.
    expect(src).toMatch(/it also reads this folder/)
    expect(src).toMatch(/listed under Installed/)
  })

  it('is honest that image and video go through ComfyUI', () => {
    expect(src).toMatch(/passes <code className="font-mono">\{result\.folders\.join/)
    expect(src).toMatch(/only for a ComfyUI that LU starts/)
    // And says plainly what happens when the folder is not ComfyUI-shaped,
    // instead of leaving a silent no-op behind.
    expect(src).toMatch(/stay invisible/)
  })

  it('does not promise ComfyUI on a host that never starts one', () => {
    // The Mac runs local media on MLX. The promise used to render there too.
    expect(src).toMatch(/result\.status === 'unsupported'/)
    expect(src).toMatch(/run on Apple MLX, not ComfyUI/)
  })

  it('says when the folder was too large to read to the end', () => {
    expect(src).toMatch(/scan\?\.status === 'truncated'/)
    expect(src).toMatch(/too large to read to the end/)
  })

  it('says why a folder produced nothing instead of going quiet', () => {
    expect(src).toMatch(/result\.status === 'unusable'/)
    expect(src).toMatch(/result\.status === 'unreachable'/)
    expect(src).toMatch(/That is not a full path/)
    expect(src).toMatch(/Check that the drive is connected/)
  })

  it('hands the folder over whenever the setting changes', () => {
    expect(src).toMatch(/syncCustomModelDir\(override\)/)
  })

  // Negative control: the old text must be gone, or the honest sentence would
  // just sit next to the misleading one.
  it('no longer calls the folder a download target and nothing else', () => {
    expect(src).not.toMatch(/Custom location for downloaded GGUFs\./)
  })
})

describe('the handover does not depend on a settings tab being open', () => {
  const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')

  it('runs at boot from the persisted setting', () => {
    // It used to run only inside the AI Backends panel's effect, so a folder
    // set in an older build and never revisited never reached ComfyUI.
    expect(app).toMatch(/syncCustomModelDir/)
    expect(app).toMatch(/settings\.hfDownloadPathOverride/)
  })

  // Negative control: the settings panel still syncs on change, or a folder the
  // user picks would only take effect after the next restart.
  it('and still on every change in the panel', () => {
    const panel = readFileSync(
      join(process.cwd(), 'src/components/settings/SettingsPage.tsx'),
      'utf8',
    )
    expect(panel).toMatch(/syncCustomModelDir\(override\)/)
  })
})

describe('the folder names Rust looks for are the folders ComfyUI uses', () => {
  it('matches subfolderForSource, so the two lists cannot drift apart', () => {
    const rust = readFileSync(
      join(process.cwd(), 'src-tauri/src/commands/custom_models.rs'),
      'utf8',
    )
    const block = rust.split('COMFY_MODEL_FOLDERS: &[&str] = &[')[1].split('];')[0]
    const rustFolders = new Set([...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))

    const ts = readFileSync(join(process.cwd(), 'src/api/comfyui.ts'), 'utf8')
    const fn = ts.split('export function subfolderForSource')[1].split('\n}')[0]
    const tsFolders = [...fn.matchAll(/return '([^']+)'/g)]
      .map((m) => m[1])
      // The AnimateDiff motion modules live under custom_nodes, which is not a
      // folder_paths key and cannot be mapped this way.
      .filter((f) => !f.includes('/'))

    for (const folder of tsFolders) {
      expect(rustFolders.has(folder), `${folder} is a ComfyUI models folder Rust does not map`).toBe(true)
    }
    // Negative control: a folder name that ComfyUI has no key for must not be
    // in the Rust list either.
    expect(rustFolders.has('custom_nodes')).toBe(false)
  })
})
