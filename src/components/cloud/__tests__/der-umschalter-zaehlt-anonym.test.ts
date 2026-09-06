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

  it('names the same four events in TypeScript and in Rust', () => {
    const ts = read('src/api/funnel.ts')
    const rs = read('src-tauri/src/commands/funnel.rs')
    const tsEvents = [...ts.matchAll(/'(cloud_switch_[a-z]+)'/g)].map((m) => m[1])
    const rsBlock = rs.slice(rs.indexOf('FUNNEL_EVENTS'), rs.indexOf('];', rs.indexOf('FUNNEL_EVENTS')))
    const rsEvents = [...rsBlock.matchAll(/"(cloud_switch_[a-z]+)"/g)].map((m) => m[1])
    const uniq = (a: string[]) => [...new Set(a)].sort()
    expect(uniq(tsEvents)).toEqual(['cloud_switch_arm', 'cloud_switch_enter', 'cloud_switch_gate', 'cloud_switch_leave'])
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
    expect(settings).toContain('Cloud switch')
    expect(settings).toContain('anonymous')
  })
})
