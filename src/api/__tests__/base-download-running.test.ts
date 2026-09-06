/**
 * The Character Studio panel picks a running base-file download back up when
 * it is mounted again (Phase G finding, 2026-09-06). Pins the predicate and the
 * mount hook.
 *
 * Run: npx vitest run src/api/__tests__/base-download-running.test.ts
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { baseDownloadRunning, TRAINER_BASE_FILES } from '../trainer'

describe('baseDownloadRunning', () => {
  it('is true while any base file downloads or connects', () => {
    for (const f of TRAINER_BASE_FILES) {
      expect(baseDownloadRunning({ [f.filename]: { status: 'downloading' } })).toBe(true)
      expect(baseDownloadRunning({ [f.filename]: { status: 'connecting' } })).toBe(true)
    }
  })

  it('is false when the base files are done, failed, absent, or another file downloads', () => {
    const [a, b, c] = TRAINER_BASE_FILES.map((f) => f.filename)
    expect(baseDownloadRunning({})).toBe(false)
    expect(baseDownloadRunning({ [a]: { status: 'complete' }, [b]: { status: 'error' }, [c]: undefined })).toBe(false)
    expect(baseDownloadRunning({ 'some-other-model.gguf': { status: 'downloading' } })).toBe(false)
  })

  it('is asked by the panel on mount, before the button decides what it says', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'create', 'experimental', 'SpecialIntentControls.tsx'), 'utf8')
    const mount = src.indexOf('if (live && baseDownloadRunning(prog)) setBusy(\'bases\')')
    const button = src.indexOf("'Download base files'")
    expect(mount).toBeGreaterThan(0)
    expect(button).toBeGreaterThan(mount)
  })
})
