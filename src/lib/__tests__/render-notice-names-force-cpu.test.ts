/**
 * The last surface carrying the wrong reason from Nebenbefund 1 of the R12/R13
 * re-measure (2026-08-30, ergebnis-r1213-nachmessung.md).
 *
 * Round 14 fixed the Create tab's yellow banner: it had been telling a user
 * with a working, correctly detected RTX 3060 that no usable GPU was found,
 * when he had picked Force CPU himself in Settings, Hardware, ComfyUI GPU.
 *
 * The three render failure notices in lib/render-budget.ts said the same thing
 * in their own words, through the sentence they share:
 *
 *   "Image generation is running on the CPU because no supported GPU path is
 *    active, so it is many times slower than it would be on a card."
 *
 * That is a fault report, and this user has no fault. `CpuRenderFacts` simply
 * did not carry `mode`, although `get_comfy_gpu_status` has returned it all
 * along and vram-handoff was already reading that very reply. It carries it
 * now, as a REQUIRED field, so no construction site can quietly skip the
 * question, and the Force CPU wording is the banner's own two constants rather
 * than a second copy that can drift.
 *
 * Run: npx vitest run src/lib/__tests__/render-notice-names-force-cpu.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  cpuCauseSuffix,
  renderBudgetNotice,
  renderTimeoutNotice,
  swapWarmupNotice,
  type CpuRenderFacts,
} from '../render-budget'
import { FORCE_CPU_REASON, FORCE_CPU_WAY_BACK, comfyCpuBannerText } from '../comfy-cpu-banner'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

/** The measured box: one working NVIDIA card, no AMD, Windows, Force CPU set. */
const FORCED: CpuRenderFacts = { startedCpu: true, mode: 'cpu', hasAmd: false, isWindows: true }
/** The same box before the user touched the switch: LU fell back on its own. */
const FELL_BACK: CpuRenderFacts = { ...FORCED, mode: 'auto' }

describe('THE FIX: the render notices name the press, not a missing GPU path', () => {
  it('a forced CPU render is told it was forced', () => {
    const s = cpuCauseSuffix(FORCED)
    expect(s).toContain(FORCE_CPU_REASON)
    expect(s).toContain('many times slower')
    // the fault report the box disproved
    expect(s).not.toContain('no supported GPU path is active')
  })

  it('and it names the way back, the same way the banner does', () => {
    expect(cpuCauseSuffix(FORCED)).toContain(FORCE_CPU_WAY_BACK)
  })

  it('all three notices carry it, because all three share the sentence', () => {
    const pace = renderBudgetNotice('Image', 40 * 60_000, 10 * 60_000, FORCED)
    const flat = renderTimeoutNotice('Image', 10 * 60_000, 14 * 60_000, FORCED)
    const warm = swapWarmupNotice('Image', 6 * 60_000, FORCED)
    for (const n of [pace, flat, warm]) {
      expect(n).toContain(FORCE_CPU_REASON)
      expect(n).not.toContain('no supported GPU path is active')
    }
  })

  it('no AMD fault report reaches a user who chose the processor himself', () => {
    // He did not hit a driver problem. Telling him LU could not install a
    // PyTorch that drives his card sends him after a fault that is not there.
    const amdWin = cpuCauseSuffix({ startedCpu: true, mode: 'cpu', hasAmd: true, isWindows: true })
    const amdLinux = cpuCauseSuffix({ startedCpu: true, mode: 'cpu', hasAmd: true, isWindows: false })
    for (const s of [amdWin, amdLinux]) {
      expect(s).toContain(FORCE_CPU_REASON)
      expect(s).not.toContain('AMD')
      expect(s).not.toContain('Repair environment')
    }
  })

  it('the banner and the notices say it in the same words, from one source', () => {
    const banner = comfyCpuBannerText({ startedCpu: true, mode: 'cpu', hasAmd: false, isLinux: false })
    expect(banner).toContain(FORCE_CPU_REASON)
    expect(banner).toContain(FORCE_CPU_WAY_BACK)
    // and the notice file borrows them rather than restating them
    const budget = read('src/lib/render-budget.ts')
    expect(budget).toMatch(/import \{ FORCE_CPU_REASON, FORCE_CPU_WAY_BACK, type ComfyGpuModeName \} from '\.\/comfy-cpu-banner'/)
    expect(budget).not.toMatch(/Settings → Hardware → ComfyUI GPU back to Auto/)
  })

  it('the wiring: mode is read off the reply that always carried it', () => {
    const handoff = read('src/api/vram-handoff.ts')
    expect(handoff).toMatch(/mode: asComfyGpuMode\(s\.mode\)/)
    expect(handoff).toMatch(/backendCall<\{ startedCpu\?: boolean \| null; mode\?: string \| null; hasAmd\?: boolean \| null \}>\('get_comfy_gpu_status'\)/)
    const rust = read('src-tauri/src/commands/process.rs')
    expect(rust).toMatch(/"mode": mode, "startedCpu": started_cpu, "hasAmd": has_amd/)
  })

  it('mode is required, so a new call site has to answer the question', () => {
    const budget = read('src/lib/render-budget.ts')
    expect(budget).toMatch(/export interface CpuRenderFacts \{\s*\n\s*startedCpu: boolean\s*\n\s*mode: ComfyGpuModeName/)
  })
})

describe('NEGATIVE CONTROL: everything round 12 settled about these notices', () => {
  it('a plain fallback to the processor keeps its sentence word for word', () => {
    expect(cpuCauseSuffix(FELL_BACK)).toBe(
      ' Image generation is running on the CPU because no supported GPU path is active, so it is many times slower than it would be on a card.',
    )
  })

  it('an AMD card that fell back is still told the way out its own OS has', () => {
    const linux = cpuCauseSuffix({ startedCpu: true, mode: 'auto', hasAmd: true, isWindows: false })
    const win = cpuCauseSuffix({ startedCpu: true, mode: 'auto', hasAmd: true, isWindows: true })
    expect(linux).toContain('Repair environment')
    expect(win).not.toContain('Repair environment')
    expect(win).toContain('on Windows')
  })

  it('a Force GPU pick is not a Force CPU pick', () => {
    // If ComfyUI ended up on the processor anyway, that IS the fault report
    // case, and this user gets it unchanged.
    expect(cpuCauseSuffix({ ...FORCED, mode: 'gpu' })).toContain('no supported GPU path is active')
  })

  it('nothing is claimed when the render had a GPU or we do not know', () => {
    expect(cpuCauseSuffix({ ...FORCED, startedCpu: false })).toBe('')
    expect(cpuCauseSuffix(null)).toBe('')
    expect(cpuCauseSuffix(undefined)).toBe('')
  })

  it('the notices around the sentence are untouched', () => {
    // The advice, the budget arithmetic and the warm-up split all predate this.
    const pace = renderBudgetNotice('Image', 40 * 60_000, 10 * 60_000, FORCED)
    expect(pace).toContain('needs about 40 minutes, more than the 10 minute budget')
    expect(pace).toContain('Try fewer frames, a smaller resolution or fewer steps')
    const warm = swapWarmupNotice('Image', 6 * 60_000, FORCED)
    expect(warm).toContain('the model was still loading and sampling never started')
    expect(warm).not.toContain('Free some VRAM')
    // and a render that DID have a GPU still gets the VRAM advice
    expect(swapWarmupNotice('Image', 6 * 60_000, null)).toContain('Free some VRAM')
  })

  it('no em dash in the new copy', () => {
    const budget = read('src/lib/render-budget.ts')
    const i = budget.indexOf('Round 14 closed the last wrong reason')
    expect(i).toBeGreaterThan(-1)
    expect(budget.slice(i, budget.indexOf('export function cpuCauseSuffix', i))).not.toMatch(/[–—]/)
    expect(read('src/lib/comfy-cpu-banner.ts')).not.toMatch(/[–—]/)
  })
})
