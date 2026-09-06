/**
 * Nebenbefund 1 of the R10 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r10-nachmessung.md).
 *
 * The measured frame, twice, with the chip read before and after each click:
 *
 *   | clicked        | active afterwards      |
 *   | DeepSeek V3.2  | Kimi K3                |
 *   | DeepSeek R1    | DeepSeek V4 Flash 0731 |
 *
 * Neither the clicked model nor the same wrong model twice, so a fixed default
 * was ruled out on the spot. The cause was smaller than a wrong default and
 * worse: the rows carried no identity at all. Every row in the LU Cloud strip
 * called the same argument-less `open()`, which opened the cloud gate and
 * nothing else. The gate flipped appMode, and `pickForMode` then did what it
 * does when the active model is out of mode: it handed out `models.find(...)`,
 * the FIRST hosted model in the store, in whatever order the last `/v1/models`
 * answer happened to arrive in. That order is the same unstable order e7b2b440
 * had just sorted out of the DISPLAY, which is why the strip looked stable
 * while the click behind it landed somewhere else.
 *
 * The fix is identity, not a position: the row names its model, the name
 * travels as `pendingCloudModel`, and the mode rule honours that name when the
 * flip lands. The rows that stand for the catalogue as a whole (the rest
 * counter, the logged-out line) name nothing and keep the old fallback.
 *
 * Run: npx vitest run src/lib/__tests__/cloud-teaser-click-identity.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { pickForMode } from '../active-model-mode'
import { cloudTeaserModels } from '../cloud-teaser-models'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

/**
 * The hosted catalogue as `/v1/models` handed it over in the re-measure: not
 * alphabetical, not ranked, just arrival order. Kimi K3 and DeepSeek V4 Flash
 * 0731 are near the head, which is exactly why they are what the two clicks
 * came back with.
 */
const HOSTED = [
  { name: 'kimi-k3', displayName: 'Kimi K3', provider: 'lu-cloud', type: 'text' },
  { name: 'deepseek-v4-flash-0731', displayName: 'DeepSeek V4 Flash 0731', provider: 'lu-cloud', type: 'text' },
  { name: 'deepseek-r1', displayName: 'DeepSeek R1', provider: 'lu-cloud', type: 'text' },
  { name: 'deepseek-v3.2', displayName: 'DeepSeek V3.2', provider: 'lu-cloud', type: 'text' },
  { name: 'deepseek-v3.1', displayName: 'DeepSeek V3.1', provider: 'lu-cloud', type: 'text' },
  { name: 'deepseek-v4-pro-0813', displayName: 'DeepSeek V4 Pro 0813', provider: 'lu-cloud', type: 'text' },
  { name: 'glm-5', displayName: 'GLM 5', provider: 'lu-cloud', type: 'text' },
]

/** The same catalogue, arriving in a different order, which is the whole
 *  reason the wrong model was a different wrong model on the second click. */
const HOSTED_REORDERED = [...HOSTED].reverse()

/** What the local machine has on it in the measured session. */
const LOCAL = { name: 'Hermes-3-Llama-3.2-3B.Q4_K_M', provider: 'openai', type: 'text' }

describe('THE FIX: the clicked LU Cloud row is the model that comes out', () => {
  it('the exact frame of the re-measure: DeepSeek V3.2 lands on DeepSeek V3.2', () => {
    const pick = pickForMode(LOCAL.name, [LOCAL, ...HOSTED], 'cloud', 'deepseek-v3.2')
    expect(pick.next).toBe('deepseek-v3.2')
    expect(pick.change).toBe(true)
    expect(pick.usedRequest).toBe(true)
  })

  it('the second frame: DeepSeek R1 lands on DeepSeek R1', () => {
    const pick = pickForMode(LOCAL.name, [LOCAL, ...HOSTED], 'cloud', 'deepseek-r1')
    expect(pick.next).toBe('deepseek-r1')
    expect(pick.usedRequest).toBe(true)
  })

  it('and it does not depend on the order the catalogue arrived in', () => {
    // This is the half that makes the bug what it was: the same click on the
    // same label used to give two different answers on two different loads.
    for (const catalogue of [HOSTED, HOSTED_REORDERED]) {
      expect(pickForMode(LOCAL.name, [LOCAL, ...catalogue], 'cloud', 'deepseek-v3.2').next)
        .toBe('deepseek-v3.2')
    }
  })

  it('every row the strip shows can be clicked and gets itself back', () => {
    // Walks the actual five rows the strip draws, through the same rule the
    // component uses, so a row is never a label without a working click.
    const { shown } = cloudTeaserModels(
      HOSTED.filter((m) => m.provider === 'lu-cloud' && m.type === 'text'),
      (m) => m.displayName,
    )
    expect(shown.length).toBe(5)
    for (const row of shown) {
      expect(pickForMode(LOCAL.name, [LOCAL, ...HOSTED], 'cloud', row.name).next).toBe(row.name)
    }
  })

  it('the request is answered once, so it cannot steer a later flip', () => {
    const first = pickForMode(LOCAL.name, [LOCAL, ...HOSTED], 'cloud', 'deepseek-v3.2')
    expect(first.usedRequest).toBe(true)
    // The caller drops it here. A second flip with no request behaves exactly
    // as it did before the fix.
    const second = pickForMode('deepseek-v3.2', [LOCAL, ...HOSTED], 'cloud', null)
    expect(second.change).toBe(false)
    expect(second.usedRequest).toBe(false)
  })
})

describe('NEGATIVE CONTROL: the rule without a request is untouched', () => {
  it('no request, an out-of-mode pick: the old fallback, unchanged', () => {
    const pick = pickForMode(LOCAL.name, [LOCAL, ...HOSTED], 'cloud')
    expect(pick.next).toBe('kimi-k3')
    expect(pick.change).toBe(true)
    expect(pick.usedRequest).toBe(false)
  })

  it('an empty list is still not evidence that a model is gone', () => {
    // Befund 3 of the abnahme counter-check, the guard that keeps a persisted
    // pick alive across a restart. A request must not punch through it.
    const pick = pickForMode(LOCAL.name, [], 'cloud', 'deepseek-v3.2')
    expect(pick.change).toBe(false)
    expect(pick.next).toBe(LOCAL.name)
    expect(pick.usedRequest).toBe(false)
  })

  it('a request for a model that is not in the list falls back as before', () => {
    const pick = pickForMode(LOCAL.name, [LOCAL, ...HOSTED], 'cloud', 'a-model-that-left')
    expect(pick.next).toBe('kimi-k3')
    expect(pick.usedRequest).toBe(false)
  })

  it('a hosted request cannot pull a hosted model into LOCAL mode', () => {
    // The rule that stopped a lu-cloud model from billing credits under a
    // switch that said Local (Discord 2026-08-09) still wins.
    const pick = pickForMode(LOCAL.name, [LOCAL, ...HOSTED], 'local', 'deepseek-v3.2')
    expect(pick.next).toBe(LOCAL.name)
    expect(pick.usedRequest).toBe(false)
  })

  it('a request never overrides an in-mode pick the user is already on', () => {
    const pick = pickForMode('deepseek-r1', [LOCAL, ...HOSTED], 'cloud', 'deepseek-r1')
    expect(pick.change).toBe(false)
    expect(pick.next).toBe('deepseek-r1')
  })

  it('an image checkpoint stays out, request or no request', () => {
    const checkpoint = { name: 'flux.safetensors', provider: 'lu-cloud', type: 'image' }
    const pick = pickForMode(null, [checkpoint], 'cloud', 'flux.safetensors')
    expect(pick.next).toBe(null)
    expect(pick.usedRequest).toBe(false)
  })
})

describe('the wiring, so the rule reaches the screen', () => {
  const picker = read('src/components/models/ModelSelector.tsx')
  const shell = read('src/components/layout/AppShell.tsx')
  const gate = read('src/components/cloud/CloudGateModal.tsx')

  it('a model row names its model, and it names it by name', () => {
    expect(picker).toMatch(/onClick=\{\(\) => open\(m\.name\)\}/)
    // The bug in one line: this is what the row used to be.
    expect(picker).not.toMatch(/key=\{m\.name\}\s*\n\s*onClick=\{open\}/)
  })

  it('the row hands the name to the store, it does not select behind the gate', () => {
    expect(picker).toMatch(/setPendingCloudModel\(model \?\? null\)/)
  })

  it('the rows that stand for the whole catalogue name nothing', () => {
    // Two of them: the rest counter and the logged-out line. Passing `open`
    // straight to onClick would hand them a MouseEvent as the model name.
    expect((picker.match(/onClick=\{\(\) => open\(\)\}/g) ?? []).length).toBe(2)
    expect(picker).not.toMatch(/onClick=\{open\}/)
  })

  it('the mode rule is asked with the request, and drops it once answered', () => {
    expect(shell).toMatch(/pickForMode\(activeModel, allModels, appMode, pendingCloudModel\)/)
    expect(shell).toMatch(/if \(pick\.usedRequest\) setPendingCloudModel\(null\)/)
  })

  it('backing out of the gate drops the request', () => {
    expect(gate).toMatch(/setPendingCloudModel\(null\)/)
    expect(gate).toMatch(/<Modal open=\{open\} onClose=\{close\}/)
  })

  it('NEGATIVE CONTROL: the request is never persisted', () => {
    // It describes one click. A persisted one would flip a model on the next
    // start of the app, which is a different bug in the same family.
    const ui = read('src/stores/uiStore.ts')
    const partialize = ui.slice(ui.indexOf('partialize:'), ui.indexOf('partialize:') + 300)
    expect(partialize).not.toMatch(/pendingCloudModel/)
  })
})

describe('the same mistake, swept for elsewhere', () => {
  it('the benchmark bar scales by the longest bar, not by row one', () => {
    // getLeaderboard sorts by score (avgTps × accuracy), so row one is not the
    // fastest row and `leaderboard[0].avgTps` drew bars past 100%.
    const bench = read('src/components/models/ModelBenchmark.tsx')
    expect(bench).toMatch(/Math\.max\(\.\.\.leaderboard\.map\(\(e\) => e\.avgTps\)\)/)
    expect(bench).not.toMatch(/const maxTps = leaderboard\[0\]\.avgTps/)
  })

  it('NEGATIVE CONTROL: the other leaderboard, which was always right, is untouched', () => {
    // BenchmarkView draws the bar from the key it sorted by, and says so.
    const view = read('src/components/models/BenchmarkView.tsx')
    expect(view).toMatch(/const topScore = leaderboard\[0\]\.score/)
  })

  it('the backend dialog re-seeds its choice when the detected list arrives', () => {
    // AppShell mounts it with an empty array and fills it seconds later, so
    // the useState default read `[]` and "Use selected" found nothing.
    //
    // The re-seed used to be a `useEffect(..., [backends])` writing the answer
    // back into state; since the React 19 set-state-in-effect fix the rule is
    // the pure `selectedBackendId` and the dialog derives the row on every
    // render, which settles it ON the render the list arrives in rather than a
    // paint later. Both halves of the rule — "the pick while the list holds it,
    // otherwise row one" — are exercised in
    // src/lib/__tests__/derived-ui-state.test.ts; what is pinned here is that
    // the dialog uses it and grows no effect to undo it.
    const sel = read('src/components/onboarding/BackendSelector.tsx')
    expect(sel).toMatch(/const selected = selectedBackendId\(picked, backends\)/)
    expect(sel).not.toMatch(/useEffect/)
    const det = read('src/lib/backend-detector.ts')
    expect(det).toMatch(/return backends\[0\]\?\.id \|\| ''/)
  })

  it('NEGATIVE CONTROL: it still confirms by id, and a made choice survives', () => {
    const sel = read('src/components/onboarding/BackendSelector.tsx')
    expect(sel).toMatch(/backends\.find\(b => b\.id === selected\)/)
    // A pick the user made before the list settled is not overruled: it is
    // returned as-is whenever the list still holds it.
    const det = read('src/lib/backend-detector.ts')
    expect(det).toMatch(/if \(picked !== null && backends\.some\(\(b\) => b\.id === picked\)\) return picked/)
  })
})
