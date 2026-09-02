/**
 * P4 (2.5.7): the BackendSelector modal now offers *alternatives* to the
 * app-managed built-in engine, which owns the `openai` slot by default.
 *
 *  - Skipping keeps the built-in engine (relabeled "Keep built-in engine").
 *  - Picking an external openai-compat backend must clear the `managed` flag,
 *    otherwise the fixed-URL / `list_bundled_models` behavior stays pinned
 *    while the URL now points at LM Studio / vLLM / etc.
 *
 * Source-level guard (matches the repo's AppShell-backend-autoenable pattern)
 * — we assert the wiring, not a full React mount.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const src = readFileSync(join(__dirname, '../BackendSelector.tsx'), 'utf8')

describe('BackendSelector built-in engine awareness', () => {
  it('clears the managed flag when switching to an external backend', () => {
    // handleConfirm's external branch must explicitly write managed:false.
    expect(src).toMatch(/managed:\s*false/)
  })

  it('reads whether the built-in engine is the active default', () => {
    // Drives the relabeled skip action + the reassurance copy.
    expect(src).toContain('builtinActive')
    expect(src).toMatch(/providers\.openai\.managed\s*===\s*true/)
  })

  it('relabels the dismiss action to keep the LU Engine', () => {
    expect(src).toMatch(/Keep LU Engine/i)
  })

  it('still persists the opt-out and can enable a picked external backend', () => {
    // Non-destructive to the existing wiring: opt-out + external enable remain.
    expect(src).toContain('setHideBackendSelector')
    expect(src).toContain("setProviderConfig('openai',")
  })
})
