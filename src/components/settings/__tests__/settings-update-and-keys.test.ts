import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Source guards. The Settings page had its own dead-end update button
// (openReleasePage = browser tab) while the header badge ran the real in-app
// download. These pin both surfaces to the store pipeline.
const src = readFileSync(resolve(__dirname, '../SettingsPage.tsx'), 'utf8')
const start = src.indexOf('function UpdateSection')
const end = src.indexOf('interface BackendProbe')
const updateSection = src.slice(start, end)

describe('Settings update section uses the in-app updater', () => {
  it('slices the section it inspects', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it('wires Download and Retry to downloadUpdate, Restart to installAndRestart', () => {
    const downloads = updateSection.match(/void downloadUpdate\(\)/g) ?? []
    expect(downloads.length).toBeGreaterThanOrEqual(2)
    expect(updateSection).toContain('void installAndRestart()')
  })

  it('no longer offers the browser release page as the update CTA', () => {
    expect(updateSection).not.toMatch(/onClick=\{openReleasePage\}[\s\S]{0,300}Download Update/)
  })

  it('keeps openReleasePage out of every lane that can install', () => {
    // One use left, and it is the browser fallback outside Tauri. The second
    // one belonged to the installs the updater refused to touch (an AUR
    // install, an AppImage in a folder the user cannot write to, a binary no
    // package manager claims); there LU now installs itself and the release
    // page is not an answer anybody needs.
    const uses = updateSection.match(/onClick=\{openReleasePage\}/g) ?? []
    expect(uses).toHaveLength(1)
    const fallbackGate = updateSection.indexOf('!isTauri()')
    expect(fallbackGate).toBeGreaterThan(-1)
    expect(updateSection.indexOf('onClick={openReleasePage}')).toBeGreaterThan(fallbackGate)
  })

  it('renders download progress from the store', () => {
    expect(updateSection).toContain('downloadProgress')
    expect(updateSection).toContain('formatBytes(downloadedBytes)')
  })
})

describe('Cloud API Keys section', () => {
  it('exists and points at the account page on lu-labs.ai', () => {
    expect(src).toContain('<Section title="Cloud API Keys">')
    expect(src).toContain('openExternal(`${CLOUD_BASE}/account`)')
  })

  it('names the OpenAI-compatible base URL', () => {
    expect(src).toContain('/api/inference/v1')
  })
})
