/**
 * The greyed-out microphone says why it is grey (Gegenprobe 2026-08-30).
 *
 * The Abschluss-Gegenprobe took faster_whisper out of every Python on the
 * Windows box. The button locked correctly, but the hint read "Speech-to-text
 * off. Enable it in Settings, Voice & Remote", so it blamed a switch. There is
 * no such switch: the mic is gated on `sttAvailable`, a probe of what is
 * installed, and the persisted `sttEnabled` flag is read by nobody and offered
 * nowhere. The user landed in the right place reading a wrong reason.
 *
 * Pinned here because the wording IS the fix.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { micUnavailableHint } from '../VoiceButton'

describe('the mic hint names the real cause', () => {
  it('local mode: the package is missing and the install lives in Voice & Remote', () => {
    const hint = micUnavailableHint(false)
    expect(hint).toBe(
      'Speech-to-text is not installed. Install faster-whisper in Settings → Voice & Remote.'
    )
  })

  it('cloud mode: dictation is hosted, so the way out is the account', () => {
    // Settings deliberately shows no install button in cloud mode, so sending
    // the user to Voice & Remote for an install would be a dead end.
    const hint = micUnavailableHint(true)
    expect(hint).toBe(
      'Cloud dictation needs a signed-in account with credits. Sign in under Settings → Account.'
    )
  })

  it('negative control: neither wording blames a speech-to-text switch', () => {
    // The exact sentence the Gegenprobe read off the build, plus the shape of
    // it. Both hints must name a state (not installed / not signed in), never
    // an "off" toggle the user could go looking for.
    for (const hint of [micUnavailableHint(false), micUnavailableHint(true)]) {
      expect(hint).not.toMatch(/Speech-to-text off/i)
      expect(hint).not.toMatch(/\benable it\b/i)
      expect(hint).not.toMatch(/turn (it )?on\b/i)
    }
  })

  it('both wordings are plain English sentences, no bare error code', () => {
    for (const hint of [micUnavailableHint(false), micUnavailableHint(true)]) {
      expect(hint).toMatch(/^[A-Z]/)
      expect(hint.trim().endsWith('.')).toBe(true)
      expect(hint).not.toMatch(/ModuleNotFoundError|Traceback|errno|HTTP \d{3}/)
      // House rule: no em dashes anywhere.
      expect(hint).not.toContain('—')
    }
  })
})

describe('the button actually renders that hint', () => {
  // Comments stripped: the doc comment on micUnavailableHint quotes the old
  // wrong sentence on purpose, and that quote must not count as the component
  // still rendering it.
  const source = readFileSync(resolve(__dirname, '..', 'VoiceButton.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('the unavailable branch uses micUnavailableHint and no hardcoded copy', () => {
    // Negative control for the wiring: a correct helper nobody calls would
    // leave the old sentence on screen, which is exactly the bug.
    expect(source).toMatch(/const hint = micUnavailableHint\(appMode === "cloud"\)/)
    expect(source).not.toMatch(/Speech-to-text off\. Enable it/)
  })

  it('cloud and local are told apart by the app mode, not by the dead flag', () => {
    expect(source).toMatch(/useSettingsStore\(\(s\) => s\.settings\.appMode\)/)
    expect(source).not.toMatch(/sttEnabled/)
  })
})

describe('sttEnabled stays a dead flag until David decides', () => {
  const store = readFileSync(resolve(__dirname, '..', '..', '..', 'stores', 'voiceStore.ts'), 'utf8')

  it('nothing gates on it, so it is marked unused where it is declared', () => {
    // If someone wires it up later, this test is the place that says the
    // tooltip copy has to be revisited with it.
    expect(store).toMatch(/UNUSED, kept only so a persisted store/)
  })
})
