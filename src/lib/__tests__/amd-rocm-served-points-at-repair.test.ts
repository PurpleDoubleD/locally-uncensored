/**
 * 3.0.8, kinghebes (Windows 11, RX 9070 XT, ComfyUI on the processor).
 *
 * The card is one LU builds AMD's ROCm environment for, his environment
 * simply predates that. Both places that explain a CPU render used to send a
 * Windows AMD user to a ZLUDA ComfyUI of his own. When the backend says LU
 * serves the card (`amdRocmServed`), they point at Repair environment.
 *
 * Run: npx vitest run src/lib/__tests__/amd-rocm-served-points-at-repair.test.ts
 */
import { describe, it, expect } from 'vitest'
import { comfyCpuBannerText } from '../comfy-cpu-banner'
import { cpuCauseSuffix } from '../render-budget'

describe('a served AMD card on Windows is sent to Repair environment', () => {
  it('the Create banner', () => {
    const text = comfyCpuBannerText({ startedCpu: true, mode: 'auto', hasAmd: true, isLinux: false, amdRocmServed: true })
    expect(text).toMatch(/Press Repair environment in Settings → ComfyUI/)
    expect(text).toMatch(/does not have it yet/)
    expect(text).not.toMatch(/ZLUDA/)
  })

  it('the render failure notices', () => {
    const text = cpuCauseSuffix({ startedCpu: true, mode: 'auto', hasAmd: true, isWindows: true, amdRocmServed: true })
    expect(text).toMatch(/Repair environment/)
    expect(text).not.toMatch(/could not install/)
  })
})

describe('NEGATIVE CONTROL: everything else reads as before', () => {
  it('an unserved Windows card still gets the ZLUDA route', () => {
    const text = comfyCpuBannerText({ startedCpu: true, mode: 'auto', hasAmd: true, isLinux: false, amdRocmServed: false })
    expect(text).toMatch(/you need a ZLUDA ComfyUI of your own/)
    expect(cpuCauseSuffix({ startedCpu: true, mode: 'auto', hasAmd: true, isWindows: true })).toMatch(/could not install/)
  })

  it('Linux and Force CPU ignore the flag', () => {
    expect(comfyCpuBannerText({ startedCpu: true, mode: 'auto', hasAmd: true, isLinux: true, amdRocmServed: true }))
      .toMatch(/LU installs the ROCm build of PyTorch for AMD cards now/)
    expect(comfyCpuBannerText({ startedCpu: true, mode: 'cpu', hasAmd: true, isLinux: false, amdRocmServed: true }))
      .not.toMatch(/Repair environment/)
  })
})

describe('an AMD card LU has no GPU build for on Windows (RX 6800)', () => {
  const facts = { startedCpu: true, mode: 'auto' as const, hasAmd: true, isLinux: false, amdRocmServed: false, amdNoGpuBuild: true }

  it('says why, and does not send the user to Repair', () => {
    const text = comfyCpuBannerText(facts)
    expect(text).toMatch(/no GPU build of PyTorch for this AMD card on Windows/)
    expect(text).toMatch(/Repair environment would install the same processor build/)
    expect(text).toMatch(/ZLUDA custom node inside this environment cannot change that/)
    expect(text).not.toMatch(/no usable GPU detected/)
    expect(text).not.toMatch(/Reinstall/)
  })

  it('Force CPU stays the user\'s own reason', () => {
    expect(comfyCpuBannerText({ ...facts, mode: 'cpu' })).toMatch(/you selected Force CPU/)
  })

  it('says nothing while ComfyUI is not on the CPU', () => {
    expect(comfyCpuBannerText({ ...facts, startedCpu: false })).toBe('')
  })
})
