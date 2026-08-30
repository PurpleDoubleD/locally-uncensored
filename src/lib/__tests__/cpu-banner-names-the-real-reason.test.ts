/**
 * Nebenbefund 1 of the R12/R13 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r1213-nachmessung.md, box: NVIDIA GeForce RTX 3060):
 *
 *   "Der Klammerzusatz (no usable GPU detected) stimmt in genau diesem Fall
 *    nicht. Auf dieser Maschine steckt eine funktionierende RTX 3060, die App
 *    hat sie im selben Einstellungsdialog korrekt erkannt, und der CPU-Modus
 *    kam allein durch die bewusste Wahl Force CPU zustande. Das Band
 *    unterstellt dem Nutzer einen Erkennungsfehler, den es nicht gab, und
 *    schickt ihn danach durch drei Saetze AMD-Hilfe, die ihn nichts angehen."
 *
 * Two wrong claims in one bar, and both were avoidable: `get_comfy_gpu_status`
 * has returned `mode` and `hasAmd` next to `startedCpu` all along, and the
 * Create tab read only the third. So the banner now has the three sentences the
 * three states deserve, and the AMD paragraph appears only where there is an
 * AMD card.
 *
 * Run: npx vitest run src/lib/__tests__/cpu-banner-names-the-real-reason.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { comfyCpuBannerText, asComfyGpuMode, type ComfyCpuBannerFacts } from '../comfy-cpu-banner'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

/** The box the re-measure ran on: one working NVIDIA card, no AMD, Windows. */
const NVIDIA_WINDOWS = { startedCpu: true, mode: 'auto', hasAmd: false, isLinux: false } as ComfyCpuBannerFacts

describe('THE FIX: the CPU banner names the reason that is actually true', () => {
  it('a user who picked Force CPU is told he picked it, not that his card is missing', () => {
    // The measured press: Settings, Hardware, ComfyUI GPU, Force CPU, on a box
    // whose RTX 3060 the same panel lists correctly two rows above.
    const text = comfyCpuBannerText({ ...NVIDIA_WINDOWS, mode: 'cpu' })
    expect(text).toMatch(/running on the CPU because you selected Force CPU/)
    // the claim the box disproved
    expect(text).not.toMatch(/no usable GPU detected/)
  })

  it('and it says where to put the switch back, which is the only thing that helps him', () => {
    const text = comfyCpuBannerText({ ...NVIDIA_WINDOWS, mode: 'cpu' })
    expect(text).toMatch(/Settings → Hardware → ComfyUI GPU back to Auto/)
    expect(text).toMatch(/restart ComfyUI from Settings → AI Backends/)
  })

  it('no AMD advice reaches a machine with no AMD card, in either mode', () => {
    for (const mode of ['auto', 'cpu', 'gpu'] as const) {
      const text = comfyCpuBannerText({ ...NVIDIA_WINDOWS, mode })
      expect(text).not.toMatch(/AMD/)
      expect(text).not.toMatch(/ZLUDA/)
      expect(text).not.toMatch(/ROCm/)
    }
  })

  it('an AMD card still gets the AMD route, and the OS decides which one', () => {
    const win = comfyCpuBannerText({ ...NVIDIA_WINDOWS, hasAmd: true })
    expect(win).toMatch(/AMD's own ROCm build of PyTorch for RX 7000 and RX 9000 cards on Windows/)
    expect(win).toMatch(/you need a ZLUDA ComfyUI of your own/)

    const linux = comfyCpuBannerText({ ...NVIDIA_WINDOWS, hasAmd: true, isLinux: true })
    expect(linux).toMatch(/LU installs the ROCm build of PyTorch for AMD cards now/)
    // the Windows-only dead end three Linux users followed in round 12
    expect(linux).not.toMatch(/ZLUDA/)
  })

  it('the AMD paragraph is skipped even for an AMD owner who forced the CPU himself', () => {
    // He did not hit a driver problem, he flipped a switch. Handing him a
    // reinstall of the ComfyUI environment would send him after a fault that
    // does not exist.
    const text = comfyCpuBannerText({ startedCpu: true, mode: 'cpu', hasAmd: true, isLinux: false })
    expect(text).toMatch(/because you selected Force CPU/)
    expect(text).not.toMatch(/AMD/)
  })

  it('the Create tab renders this text instead of carrying a fourth copy of it', () => {
    const tab = read('src/components/create/experimental/CreateExperimental.tsx')
    expect(tab).toMatch(/comfyOnCpu && comfyCpuBanner &&/)
    expect(tab).toMatch(/<span>\{comfyCpuBanner\}<\/span>/)
    // the single hard-coded sentence that could not tell the states apart
    expect(tab).not.toMatch(/no usable GPU detected/)
    const ctx = read('src/components/create/experimental/CreateContext.tsx')
    // and all three facts are read off the reply that always carried them
    expect(ctx).toMatch(/startedCpu: s\?\.startedCpu === true/)
    expect(ctx).toMatch(/mode: asComfyGpuMode\(s\?\.mode\)/)
    expect(ctx).toMatch(/hasAmd: s\?\.hasAmd === true/)
  })

  it('the backend really sends all three, so the frontend is not inventing them', () => {
    const rust = read('src-tauri/src/commands/process.rs')
    expect(rust).toMatch(/"mode": mode, "startedCpu": started_cpu, "hasAmd": has_amd/)
    // "cpu" is the Force CPU entry, which is what mode === 'cpu' leans on
    expect(rust).toMatch(/"cpu" => ComfyGpuMode::ForceCpu/)
  })
})

describe('NEGATIVE CONTROL: what the banner did right stays untouched', () => {
  it('a plain fallback to the processor keeps the exact sentence it always had', () => {
    // Nothing about this case was wrong. shd_scorpion's RX 7900 XTX is still
    // the reason the bar exists at all.
    expect(comfyCpuBannerText(NVIDIA_WINDOWS)).toBe(
      'ComfyUI is running on the CPU (no usable GPU detected). Generation will be extremely slow and may time out.',
    )
  })

  it('every variant still warns about the speed, which is the point of the bar', () => {
    const all = [
      comfyCpuBannerText(NVIDIA_WINDOWS),
      comfyCpuBannerText({ ...NVIDIA_WINDOWS, mode: 'cpu' }),
      comfyCpuBannerText({ ...NVIDIA_WINDOWS, hasAmd: true }),
    ]
    for (const t of all) expect(t).toMatch(/extremely slow and may time out/)
  })

  it('there is no bar at all when ComfyUI is not on the processor', () => {
    expect(comfyCpuBannerText({ ...NVIDIA_WINDOWS, startedCpu: false })).toBe('')
    // Force CPU chosen but ComfyUI not (re)started under it yet: nothing is
    // running on the CPU, so nothing may be claimed.
    expect(comfyCpuBannerText({ ...NVIDIA_WINDOWS, startedCpu: false, mode: 'cpu' })).toBe('')
    expect(comfyCpuBannerText(null)).toBe('')
    expect(comfyCpuBannerText(undefined)).toBe('')
  })

  it('an unknown or missing mode is read as auto, never as a forced CPU', () => {
    // A backend that answers with nothing, or with something new, must not be
    // able to tell a user he pressed a button he never pressed.
    expect(asComfyGpuMode(undefined)).toBe('auto')
    expect(asComfyGpuMode(null)).toBe('auto')
    expect(asComfyGpuMode('')).toBe('auto')
    expect(asComfyGpuMode('something-else')).toBe('auto')
    expect(asComfyGpuMode('CPU')).toBe('cpu')
    expect(asComfyGpuMode(' gpu ')).toBe('gpu')
  })

  it('no em dash anywhere in the new copy', () => {
    expect(read('src/lib/comfy-cpu-banner.ts')).not.toMatch(/[–—]/)
  })
})
