import { describe, it, expect } from 'vitest'
import { comfyStartupError, comfyCrashAdvice, REPAIR_ADVICE } from '../comfyError'

// GH #98: "did not come up" used to be a dead end. The error must carry the
// crash tail when there is one, and stay the old pointer when there is not.
describe('comfyStartupError', () => {
  it('falls back to the settings pointer without output', () => {
    expect(comfyStartupError()).toContain('Check Settings')
    expect(comfyStartupError([])).toContain('Check Settings')
    expect(comfyStartupError(['  ', ''])).toContain('Check Settings')
  })

  it('carries the last meaningful lines of a crash', () => {
    const lines = [
      '[start] python main.py --port 8188',
      'Traceback (most recent call last):',
      '  File "main.py", line 1, in <module>',
      "ModuleNotFoundError: No module named 'torch'",
    ]
    const msg = comfyStartupError(lines)
    expect(msg).toContain('did not come up')
    expect(msg).toContain("ModuleNotFoundError: No module named 'torch'")
  })

  it('keeps only the tail of a long log', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    const msg = comfyStartupError(lines)
    expect(msg).toContain('line 49')
    expect(msg).not.toContain('line 40\n')
  })

  // Ticket 007 (falcon bob): unter der Ausgabe stand immer derselbe allgemeine
  // Satz, obwohl der Einordner des Installers wusste, was WinError 1114
  // bedeutet. Jetzt reicht Rust den konkreten Rat mit, und er gewinnt.
  it('haengt den mitgelieferten Rat unter die Ausgabe', () => {
    const msg = comfyStartupError(['OSError: [WinError 1114]'], 'Install the runtime.')
    expect(msg).toContain('OSError: [WinError 1114]')
    expect(msg).toContain('Install the runtime.')
  })

  it('bleibt ohne Rat genau die alte Meldung', () => {
    const lines = ['boom']
    expect(comfyStartupError(lines, '')).toBe(comfyStartupError(lines))
    expect(comfyStartupError(lines, '   ')).toBe(comfyStartupError(lines))
    expect(comfyStartupError(undefined, '')).toContain('Check Settings')
  })
})

describe('comfyCrashAdvice', () => {
  it('der konkrete Hinweis schlaegt den allgemeinen Satz', () => {
    const hint = 'A Microsoft Visual C++ runtime library is missing on this machine: VCOMP140.DLL.'
    expect(comfyCrashAdvice({ hint, envBroken: false })).toBe(hint)
    // Auch wenn beide da waeren: der konkrete Satz gewinnt.
    expect(comfyCrashAdvice({ hint, envBroken: true })).toBe(hint)
  })

  it('ohne Hinweis bleibt es beim bisherigen Satz, aber nur bei kaputter Umgebung', () => {
    expect(comfyCrashAdvice({ envBroken: true })).toBe(REPAIR_ADVICE)
    expect(comfyCrashAdvice({ hint: '  ', envBroken: true })).toBe(REPAIR_ADVICE)
    expect(comfyCrashAdvice({ envBroken: false })).toBe('')
    expect(comfyCrashAdvice(null)).toBe('')
    expect(comfyCrashAdvice()).toBe('')
  })

  it('der allgemeine Satz schickt weiter in die Reparatur, der konkrete darf das nicht muessen', () => {
    expect(REPAIR_ADVICE).toContain('Repair environment')
    // Ticket 007: ein Fehler ausserhalb des venv erreicht diesen Satz nicht
    // mehr, weil Rust envBroken dafuer nicht mehr setzt.
    expect(comfyCrashAdvice({ hint: 'Repair environment does not help here.', envBroken: false }))
      .not.toContain('rebuilds it in place')
  })
})
