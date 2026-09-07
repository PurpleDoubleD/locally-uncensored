/**
 * B5 (David 2026-08-04): the example-video stage is gone and the path to the
 * cloud is one click shorter.
 *
 * The reason this file exists rather than trusting the diff: the in-app login
 * used to hang off a SINGLE step. "Already got an account? Sign in" appeared
 * only on the plans step, so any change to where "Get LU Cloud" leads could
 * silently take the login away from every existing subscriber, and nothing
 * would have failed. The sign-in entry now sits on both signed-out steps, and
 * these tests are what keeps it there.
 *
 * There is no render harness in this repo (no @testing-library), so this guards
 * the source, the same way DownloadBadge-autoclose.test.ts does. The click path
 * itself is covered by e2e/cloud-create.spec.ts.
 *
 * Run: npx vitest run src/components/cloud/__tests__/cloud-path-shortened.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

const gate = read('src/components/cloud/CloudGateModal.tsx')
const teaser = read('src/components/cloud/CloudTeaserModal.tsx')

describe('the example-video stage is gone', () => {
  it('the component, its assets and its build scripts no longer exist', () => {
    expect(existsSync(resolve(ROOT, 'src/components/cloud/CloudExampleModal.tsx'))).toBe(false)
    // 3.4 MB of webm shipped in every bundle on all three platforms.
    expect(existsSync(resolve(ROOT, 'public/teasers'))).toBe(false)
    expect(existsSync(resolve(ROOT, 'scripts/teasers'))).toBe(false)
  })

  it('nothing references it any more', () => {
    for (const f of [
      'src/components/layout/AppShell.tsx',
      'src/stores/uiStore.ts',
      'src/components/cloud/CloudTeaserModal.tsx',
      'package.json',
    ]) {
      const src = read(f)
      expect(src, `${f} still mentions the example modal`).not.toMatch(/CloudExampleModal|cloudExampleVideo/)
      expect(src, `${f} still mentions the teaser assets`).not.toMatch(/teasers\//)
    }
  })

  it('the teaser sheet opens the pricing page from both surfaces', () => {
    // The intent branch used to call setCloudExampleVideo, then both branches
    // went to the in-app gate. Since 2026-09-07 the one button opens the
    // pricing page in the browser (prices first, login second), and the gate
    // is no longer referenced from the sheet at all.
    expect(teaser).toMatch(/openExternal\(`\$\{CLOUD_BASE\}\/pricing`\)/)
    expect(teaser).not.toMatch(/setCloudGateOpen/)
    expect(teaser).not.toMatch(/setCloudExampleVideo/)
    // The branch itself is gone, not just its call.
    expect(teaser).not.toMatch(/if \(t\.surface === 'intent'\)/)
  })
})

describe('the in-app login survives wherever Get LU Cloud leads', () => {
  it('the sign-in entry appears on the intro step, not only on plans', () => {
    // Two occurrences: one per signed-out step. One occurrence means the intro
    // step lost it again, which is the regression this file is here for.
    const entries = gate.match(/Already got an account\? Sign in/g) ?? []
    expect(entries.length, 'sign-in entry must be on BOTH signed-out steps').toBe(2)
  })

  it('both entries actually reach the login step', () => {
    const toLogin = gate.match(/setStep\('login'\)/g) ?? []
    expect(toLogin.length).toBeGreaterThanOrEqual(2)
  })

  it('the intro step carries one of them', () => {
    // Cut the intro branch out at the plans branch, so the assertion cannot
    // pass on the plans copy.
    const start = gate.indexOf("step === 'intro' ? (")
    const end = gate.indexOf("step === 'plans' ?")
    expect(start, 'intro branch not found').toBeGreaterThan(-1)
    expect(end, 'plans branch not found').toBeGreaterThan(start)
    const intro = gate.slice(start, end)
    expect(intro).toMatch(/Already got an account\? Sign in/)
    expect(intro).toMatch(/setStep\('login'\)/)
  })

  it('the login step is still reachable back from plans', () => {
    expect(gate).toMatch(/step === 'login'/)
    expect(gate).toMatch(/Back to plans/)
  })
})
