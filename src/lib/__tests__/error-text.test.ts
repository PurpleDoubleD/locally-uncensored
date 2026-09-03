/**
 * The new rule, 2026-08-22: an error a user reads is English, always.
 *
 * Two halves. The Rust half is fixed at the source, where the operating
 * system's own wording is replaced before it ever leaves the backend. This is
 * the other half: text written by a program that is not ours. A German Windows
 * runs a German winget, and the last line of its log used to BE our error
 * message, with no subject and no hint of who said it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { detailOf, withDetail, withInstallerOutput } from '../error-text'

describe('detailOf', () => {
  it('reads a string, an Error and anything else', () => {
    expect(detailOf('boom')).toBe('boom')
    expect(detailOf(new Error('boom'))).toBe('boom')
    expect(detailOf(404)).toBe('404')
  })

  it('is empty for nothing at all, so a frame stays a clean sentence', () => {
    expect(detailOf(null)).toBe('')
    expect(detailOf(undefined)).toBe('')
    expect(detailOf(new Error(''))).toBe('')
  })
})

describe('withDetail', () => {
  it('our sentence comes first and the foreign text is labelled', () => {
    const out = withDetail('The update could not be installed.', 'Zugriff verweigert')
    expect(out.startsWith('The update could not be installed.')).toBe(true)
    expect(out).toContain('Details:')
    // The detail is kept. It is the only thing that says what actually failed.
    expect(out).toContain('Zugriff verweigert')
  })

  it('with nothing to add it is just the sentence', () => {
    expect(withDetail('Install failed.', '')).toBe('Install failed.')
    expect(withDetail('Install failed.', null)).toBe('Install failed.')
  })

  it('does not frame our own sentence twice on the way up', () => {
    const once = withDetail('Install failed.', 'pip exploded')
    expect(withDetail('Install failed.', once)).toBe(once)
  })

  it('the installer frame names who is talking', () => {
    const out = withInstallerOutput('Installing Python failed.', 'Fehler beim Installieren')
    expect(out).toContain('Last output from the installer')
    expect(out.startsWith('Installing Python failed.')).toBe(true)
  })
})

describe('the surfaces that used to set foreign text as the whole message', () => {
  const read = (p: string) =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', p), 'utf8')

  it('first run frames every installer log tail', () => {
    // Onboarding is the highest visibility surface in the app and it had four
    // of these, one per installer. A bare log tail there is the first thing a
    // new user ever reads from us.
    //
    // PATH ONLY (W-T3, 2026-09-01): the four installers used to sit in one
    // 1909-line Onboarding.tsx. Two of them (Ollama, LM Studio) now live in
    // BackendsStep.tsx and two (ComfyUI, Python) in ComfyStep.tsx. Both files
    // are read here, so the claim still covers all four — reading only the
    // shell would have made this test green by looking at a file that no
    // longer contains a single installer.
    const src = [
      read('components/onboarding/BackendsStep.tsx'),
      read('components/onboarding/ComfyStep.tsx'),
    ].join('\n')
    expect(src).toContain('withInstallerOutput')
    expect(src).not.toMatch(/set\w*Error\(lastLog\)/)
    expect(src).not.toMatch(/setPythonInstallError\(lastLog\)/)
    // And the shell really is out of the installer business now.
    expect(read('components/onboarding/Onboarding.tsx')).not.toContain('lastLog')
  })

  it('Settings frames its installer log tails too', () => {
    // PATH ONLY (2026-09-02): SettingsPage.tsx used to hold the ComfyUI and
    // Python install state and framed the log tails where it set them. That
    // state moved into stores/comfyInstallStore.ts so install and repair
    // progress survives a section switch; SettingsPage renders the store now
    // and sets no install error of its own. The store is read here too, so
    // the claim still covers the whole Settings surface instead of going
    // green on a file that no longer frames anything.
    const src = [
      read('components/settings/SettingsPage.tsx'),
      read('stores/comfyInstallStore.ts'),
    ].join('\n')
    expect(src).toContain('withInstallerOutput')
    // The shape the frame replaced: a log tail set as the whole message.
    expect(src).not.toMatch(/error: lastLog\b/)
    // And Settings itself really is out of the installer business, so there is
    // no second, unframed path left behind in the file that renders it.
    expect(read('components/settings/SettingsPage.tsx')).not.toContain('lastLog')
  })

  it('the updater frames what the update plugin reports', () => {
    // This one is third party Rust we do not own, so it cannot be fixed at the
    // source the way our own commands were.
    const src = read('stores/updateStore.ts')
    expect(src).toContain('withDetail')
    expect(src).not.toMatch(/errorMessage: e instanceof Error \? e\.message :/)
  })
})
