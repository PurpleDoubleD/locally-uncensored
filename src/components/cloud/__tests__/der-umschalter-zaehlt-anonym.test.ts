/**
 * The Cloud switch reports every press to the anonymous counter, and the
 * allowlist is the same on both sides of the bridge. Source contract, the way
 * the header and the trainer pin theirs.
 *
 * Run: npx vitest run src/components/cloud/__tests__/der-umschalter-zaehlt-anonym.test.ts
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(__dirname, '..', '..', '..', '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('the Cloud switch counts its presses', () => {
  it('reports the outcome of a press before acting on it', () => {
    const src = read('src/components/cloud/CloudSwitch.tsx')
    expect(src).toContain("import { reportCloudSwitch } from '../../api/funnel'")
    const report = src.indexOf('reportCloudSwitch(action)')
    const act = src.indexOf('switch (action)')
    expect(report).toBeGreaterThan(0)
    expect(act).toBeGreaterThan(report)
  })

  it('names the same events in TypeScript and in Rust', () => {
    const ts = read('src/api/funnel.ts')
    const rs = read('src-tauri/src/commands/funnel.rs')
    const tsEvents = [...ts.matchAll(/'(cloud_(?:switch|gate|teaser|offer|onboarding)_[a-z_]+)'/g)].map((m) => m[1])
    const rsBlock = rs.slice(rs.indexOf('FUNNEL_EVENTS'), rs.indexOf('];', rs.indexOf('FUNNEL_EVENTS')))
    const rsEvents = [...rsBlock.matchAll(/"(cloud_(?:switch|gate|teaser|offer|onboarding)_[a-z_]+)"/g)].map((m) => m[1])
    const uniq = (a: string[]) => [...new Set(a)].sort()
    expect(uniq(tsEvents)).toEqual([
      'cloud_gate_main_pack', 'cloud_gate_main_sub',
      'cloud_gate_model_click', 'cloud_gate_pick_credits', 'cloud_gate_pick_sub',
      'cloud_gate_plan_click', 'cloud_gate_signin',
      'cloud_offer_click', 'cloud_onboarding_hint',
      'cloud_switch_arm', 'cloud_switch_enter', 'cloud_switch_gate', 'cloud_switch_leave',
      'cloud_teaser_hide', 'cloud_teaser_pack', 'cloud_teaser_sub',
    ])
    expect(uniq(rsEvents)).toEqual(uniq(tsEvents))
  })

  it('sends nothing user-shaped', () => {
    const ts = read('src/api/funnel.ts')
    for (const word of ['email', 'userId', 'token', 'prompt', 'navigator']) {
      expect(ts).not.toContain(word)
    }
  })

  it('is written into Settings so the privacy text stays true', () => {
    const settings = read('src/components/settings/SettingsPage.tsx')
    // What goes with a press, and that it carries no identifier.
    expect(settings).toContain('counts each press of the Cloud switch with LU Labs: which way it was pressed, platform and app version, no identifier')
    // Signed in, the same press is counted for the account too (api/funnel.ts).
    expect(settings).toContain('a press of the Cloud switch is counted for your account as well')
    // The clicks in the gate pop-up are counted too, without the model.
    expect(settings).toContain('A click on a way into LU Cloud counts the same way (a model, a plan, a pack, the sign in, or hiding the Cloud features), never which model.')
    // A counter and "no telemetry" do not go on the same page.
    expect(settings).not.toMatch(/no telemetry/i)
  })
})
