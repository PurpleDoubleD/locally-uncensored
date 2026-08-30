/**
 * Nebenbefund 3 of the R8 re-measure (2026-08-30, Windows box, installed
 * build). The ComfyUI-is-down hint in the Model Manager reads:
 *
 *   "Open Settings, go to AI Backends, and press Start under ComfyUI
 *    (Image & Video), then come back."
 *
 * Every station of that route exists, and the last one was hidden: the Start
 * button sits inside a collapsed section, so it only appears after a click on
 * the section header that the hint never mentions. Measured on both routes,
 * through the "Open Settings" button and through normal Settings navigation.
 *
 * The button is the fix, not the sentence: it already knew the tab, now it
 * carries the section as well. These hold that route from end to end.
 *
 * Run: npx vitest run src/components/models/__tests__/settings-deeplink-comfyui.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { useUIStore } from '../../../stores/uiStore'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

describe('uiStore settings deep link', () => {
  beforeEach(() => {
    useUIStore.setState({ currentView: 'models', sidebarOpen: true, settingsFocus: null })
  })

  it('openSettingsAt lands on Settings and says which section to unfold', () => {
    useUIStore.getState().openSettingsAt({ tab: 'backends', section: 'comfyui' })
    const s = useUIStore.getState()
    expect(s.currentView).toBe('settings')
    expect(s.settingsFocus).toEqual({ tab: 'backends', section: 'comfyui' })
  })

  it('a tab without a section is still a valid landing', () => {
    useUIStore.getState().openSettingsAt({ tab: 'agent' })
    expect(useUIStore.getState().settingsFocus).toEqual({ tab: 'agent' })
  })

  it('plain navigation afterwards drops the focus instead of firing it late', () => {
    useUIStore.getState().openSettingsAt({ tab: 'backends', section: 'comfyui' })
    useUIStore.getState().setView('chat')
    expect(useUIStore.getState().settingsFocus).toBeNull()
  })

  it('clearSettingsFocus is what SettingsPage uses to consume it', () => {
    useUIStore.getState().openSettingsAt({ tab: 'backends', section: 'comfyui' })
    useUIStore.getState().clearSettingsFocus()
    expect(useUIStore.getState().settingsFocus).toBeNull()
    // Consuming the focus must not bounce the user off the page.
    expect(useUIStore.getState().currentView).toBe('settings')
  })

  it('the focus is never persisted, it describes one navigation', () => {
    const uiStore = read('src/stores/uiStore.ts')
    const partialize = uiStore.slice(uiStore.indexOf('partialize:'))
    expect(partialize).not.toMatch(/settingsFocus/)
  })
})

describe('the hint button walks the whole route', () => {
  const modelManager = read('src/components/models/ModelManager.tsx')
  const settingsPage = read('src/components/settings/SettingsPage.tsx')

  it('Open Settings asks for the AI Backends tab AND the ComfyUI section', () => {
    // Pre-fix: setView('settings') and nothing more. The tab it landed on was
    // whatever localStorage remembered, which on the box happened to be the
    // right one, and the section was closed either way.
    expect(modelManager).toMatch(/openSettingsAt\(\{ tab: 'backends', section: 'comfyui' \}\)/)
    expect(modelManager).not.toMatch(/onClick=\{\(\) => setView\('settings'\)\}/)
  })

  it('SettingsPage opens on the tab the focus names', () => {
    expect(settingsPage).toMatch(/if \(entryFocus\) return entryFocus\.tab/)
  })

  it('and unfolds the ComfyUI section for it', () => {
    expect(settingsPage).toMatch(
      /<Section title="ComfyUI \(Image & Video\)" defaultOpen=\{entryFocus\?\.section === 'comfyui'\}>/,
    )
  })

  it('reads the focus once at mount, not through a live selector', () => {
    // defaultOpen is an INITIAL value. Reading the focus reactively would fold
    // the section back up on the very next render, the moment the store is
    // cleared, which is the whole failure this fix is about.
    expect(settingsPage).toMatch(/useState\(\(\) => useUIStore\.getState\(\)\.settingsFocus\)/)
    expect(settingsPage).toMatch(/useEffect\(\(\) => \{ useUIStore\.getState\(\)\.clearSettingsFocus\(\) \}, \[\]\)/)
  })

  it('NEGATIVE CONTROL: the section still opens closed for everybody else', () => {
    // A fix that just flipped defaultOpen on would be a false pass: the panel
    // is long, and the other sections on the tab stay folded. Only Providers
    // is open by default, and it was before.
    expect(settingsPage).toMatch(/<Section title="Providers" defaultOpen>/)
    expect(settingsPage).not.toMatch(/<Section title="ComfyUI \(Image & Video\)" defaultOpen>/)
    expect(settingsPage).toMatch(/<Section title="Model Storage">/)
  })
})
