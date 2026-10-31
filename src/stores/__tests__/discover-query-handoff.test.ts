/**
 * N2 (3.0.9): Neurons' "Get the original" opens Discover searching for the
 * original model. The query rides along with the target, is never saved, and
 * the Models page reads it once.
 *
 * Run: npx vitest run src/stores/__tests__/discover-query-handoff.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useUIStore } from '../uiStore'

describe('Discover search hand-off', () => {
  it('carries a query with the target, and none without one', () => {
    useUIStore.getState().openDiscoverFor('builtin', '  Qwen3.5 9B ')
    expect(useUIStore.getState()).toMatchObject({ currentView: 'models', discoverTarget: 'builtin', discoverQuery: 'Qwen3.5 9B' })
    useUIStore.getState().clearDiscoverQuery()
    expect(useUIStore.getState().discoverQuery).toBeNull()
    useUIStore.getState().openDiscoverFor('builtin')
    expect(useUIStore.getState().discoverQuery).toBeNull()
  })

  it('is not saved, and the Models page starts its search with it once', () => {
    const store = readFileSync(resolve(__dirname, '../uiStore.ts'), 'utf8')
    const kept = store.slice(store.indexOf('partialize:'))
    expect(kept.slice(0, kept.indexOf('}),'))).not.toMatch(/discoverQuery/)
    const page = readFileSync(resolve(__dirname, '../../components/models/ModelManager.tsx'), 'utf8')
    expect(page).toMatch(/useState\(\(\) => useUIStore\.getState\(\)\.discoverQuery \?\? ''\)/)
    expect(page).toMatch(/clearDiscoverQuery\(\)/)
  })
})
