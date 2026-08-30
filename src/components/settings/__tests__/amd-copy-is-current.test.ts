/**
 * The AMD sentences the user reads, against what the app actually does.
 *
 * Befund 5d of the round 12 research (recherche-amd-rundum.md): three user
 * texts were still describing the app of before 2.6.7. Two of them were fixed
 * in round 12 with the code that made them wrong; these are the leftovers.
 *
 *   src/components/settings/HardwareSettings.tsx:227
 *   "LU installs an NVIDIA / CPU ComfyUI by default"
 *
 * That has not been true since 57196b31 on Linux and since 6d5dc61e on
 * Windows, and it sends an AMD owner looking for a ComfyUI of his own that the
 * app has already installed for him. The DirectML pointer next to it is stale
 * in its own right: torch-directml has had no release since 2024-09-15, pins
 * torch 2.4.1, and is in Microsoft's declared maintenance mode.
 *
 * The same stale claim sat in the Create tab's CPU banner, on the Windows half
 * ("PyTorch ships no ROCm wheels for Windows, so this card needs a DirectML or
 * ZLUDA ComfyUI of your own"), which is the very sentence the research
 * disproved. It is fixed here with its twin, because leaving one of two
 * identical false sentences standing is not a smaller change, it is a worse
 * one.
 *
 * The copy is pinned against the switch that decides, so the two cannot drift
 * apart again in silence.
 *
 * Run: npx vitest run src/components/settings/__tests__/amd-copy-is-current.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

const hardware = read('src/components/settings/HardwareSettings.tsx')
// Round 14 moved the Create tab's CPU banner copy out of the .tsx and into a
// pure module, because the banner became three sentences instead of one and the
// node-environment runner cannot render the component. Same copy, same pins,
// one file further along.
const createTab = read('src/lib/comfy-cpu-banner.ts')
const wheels = read('src-tauri/src/commands/torch_wheels.rs')

describe('THE FIX: the AMD copy says what the app does', () => {
  it('the ComfyUI GPU note no longer claims an NVIDIA / CPU install by default', () => {
    expect(hardware).not.toMatch(/installs an NVIDIA \/ CPU ComfyUI by default/)
    expect(hardware).toMatch(/on Linux LU installs the ROCm build of PyTorch/)
    expect(hardware).toMatch(/RX 7000 and RX 9000 cards/)
  })

  it('and it names the cards that stay on the processor on purpose', () => {
    expect(hardware).toMatch(/no ROCm wheel carries kernels for, which stay on the processor/)
  })

  it('the frozen DirectML pointer is gone from both surfaces', () => {
    expect(hardware).not.toMatch(/DirectML/)
    expect(createTab).not.toMatch(/DirectML or ZLUDA ComfyUI of your own/)
    expect(createTab).not.toMatch(/PyTorch ships no ROCm wheels for Windows/)
  })

  it("the Create banner's Windows half names AMD's own build instead", () => {
    expect(createTab).toMatch(/LU installs AMD's own ROCm build of PyTorch for RX 7000 and RX 9000 cards on Windows/)
    // ZLUDA is still the answer for the cards AMD does not serve, so it stays
    expect(createTab).toMatch(/you need a ZLUDA ComfyUI of your own/)
  })

  it('the copy matches the switch that decides, on both branches', () => {
    // Windows: AMD's own index, for the cards measured as supported
    expect(wheels).toMatch(/os == "windows" && coverage == AmdCoverage::Supported/)
    expect(wheels).toMatch(/ROCM_WINDOWS_CHANNELS/)
    // Linux: ROCm wheels, except for the families no wheel carries
    expect(wheels).toMatch(/if coverage == AmdCoverage::NoKernels \{\s*\n\s*return WheelPlan::Cpu/)
  })
})

describe('NEGATIVE CONTROL: the sentences that were already true', () => {
  it('the Auto and Force GPU help still describe the two modes correctly', () => {
    expect(hardware).toMatch(/NVIDIA runs on the GPU\./)
    expect(hardware).toMatch(/Never fall back to CPU\./)
    expect(hardware).toMatch(/If your ComfyUI has no working GPU torch it will fail to start\./)
  })

  it('the Linux half of the Create banner is untouched', () => {
    expect(createTab).toMatch(/AMD GPU\? LU installs the ROCm build of PyTorch for AMD cards now\./)
    expect(createTab).toMatch(/Reinstall the ComfyUI environment from Settings/)
  })

  it('and the CPU warning itself still says why it is there', () => {
    expect(createTab).toMatch(/ComfyUI is running on the CPU \(no usable GPU detected\)/)
  })

  it('no em dash in the new copy', () => {
    const from = (text: string, a: string, b: string) => {
      const i = text.indexOf(a)
      expect(i).toBeGreaterThan(-1)
      const j = text.indexOf(b, i)
      expect(j).toBeGreaterThan(i)
      return text.slice(i, j)
    }
    expect(from(hardware, 'Written before 2.6.7', 'Takes effect on next ComfyUI start')).not.toMatch(/[–—]/)
    expect(from(createTab, 'The AMD half of the banner', 'to force GPU."')).not.toMatch(/[–—]/)
  })
})
