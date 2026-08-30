/**
 * R14 Nebenbefund 2 (2026-08-30, ergebnis-r14-nachmessung.md): "der Wartekreis
 * im CPU-Modus zeigte frueher ein CPU-Chip-Symbol, jetzt steht in beiden Modi
 * derselbe Funke."
 *
 * Nothing was lost. The chip was never a device marker. `phaseIcon` maps the
 * PHASE of the render: chip while a model, text encoder or VAE loads, spark
 * while sampling, image icon while decoding. R13 photographed a load phase and
 * R14 photographed two sampling phases, so the two runs compared different
 * moments of the same unchanged mapping. `git log -L` on the function says it
 * has not been touched since the Create surface was ported in eaeff304
 * (2026-07-04), well before 2.6.7.
 *
 * So this file pins the mapping instead of restoring an icon that never
 * existed: a later round must not turn the phase icon into a device icon and
 * call it a repair. The device is stated in words by the Create tab banner
 * (comfyCpuBannerText), which round 14 made honest.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/waiting-icon-is-a-phase-icon.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../../..')
const view = readFileSync(resolve(repo, 'src/components/create/experimental/OutputView.tsx'), 'utf8')

/** The body of phaseIcon, which is the whole subject of this file. */
const body = (() => {
  const start = view.indexOf('function phaseIcon(')
  expect(start).toBeGreaterThan(-1)
  const end = view.indexOf('\n}', start)
  return view.slice(start, end)
})()

describe('the waiting circle icon', () => {
  it('marks the loading phases with the chip and sampling with the spark', () => {
    expect(body).toMatch(/phase === 'loading-model'[\s\S]*?<Cpu /)
    expect(body).toMatch(/phase === 'loading-clip'/)
    expect(body).toMatch(/phase === 'loading-vae'/)
    expect(body).toMatch(/phase === 'sampling'[\s\S]*?<Sparkles /)
    expect(body).toMatch(/phase === 'decoding'[\s\S]*?<ImageDown /)
  })

  it('NEGATIVE: it reads no device fact, so it cannot claim one', () => {
    // The two facts that describe the device live in get_comfy_gpu_status and
    // are rendered as text. If either name ever appears in this function, an
    // icon has started making a claim about hardware that a phase cannot know.
    expect(body).not.toMatch(/startedCpu/)
    expect(body).not.toMatch(/get_comfy_gpu_status/)
    expect(body).not.toMatch(/comfyOnCpu/)
  })
})
