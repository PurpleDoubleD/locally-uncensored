import { describe, it, expect } from 'vitest'
import {
  comfyStartupError,
  comfyCrashAdvice,
  REPAIR_ADVICE,
  COMFY_INSTALLED_BUT_DEAD,
  COMFY_START_FAILED,
  comfyStartThrowText,
} from '../comfyError'

// GH #98: "did not come up" used to be a dead end. The error must carry the
// crash tail when there is one, and stay the old pointer when there is not.
describe('comfyStartupError', () => {
  it('falls back to the settings pointer without output', () => {
    expect(comfyStartupError(COMFY_INSTALLED_BUT_DEAD)).toContain('Check Settings')
    expect(comfyStartupError(COMFY_INSTALLED_BUT_DEAD, [])).toContain('Check Settings')
    expect(comfyStartupError(COMFY_INSTALLED_BUT_DEAD, ['  ', ''])).toContain('Check Settings')
  })

  it('carries the last meaningful lines of a crash', () => {
    const lines = [
      '[start] python main.py --port 8188',
      'Traceback (most recent call last):',
      '  File "main.py", line 1, in <module>',
      "ModuleNotFoundError: No module named 'torch'",
    ]
    const msg = comfyStartupError(COMFY_INSTALLED_BUT_DEAD, lines)
    expect(msg).toContain('did not come up')
    expect(msg).toContain("ModuleNotFoundError: No module named 'torch'")
  })

  it('keeps only the tail of a long log', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    const msg = comfyStartupError(COMFY_INSTALLED_BUT_DEAD, lines)
    expect(msg).toContain('line 49')
    expect(msg).not.toContain('line 40\n')
  })

  // Ticket 007 (falcon bob): unter der Ausgabe stand immer derselbe allgemeine
  // Satz, obwohl der Einordner des Installers wusste, was WinError 1114
  // bedeutet. Jetzt reicht Rust den konkreten Rat mit, und er gewinnt.
  it('haengt den mitgelieferten Rat unter die Ausgabe', () => {
    const msg = comfyStartupError(COMFY_INSTALLED_BUT_DEAD, ['OSError: [WinError 1114]'], 'Install the runtime.')
    expect(msg).toContain('OSError: [WinError 1114]')
    expect(msg).toContain('Install the runtime.')
  })

  it('bleibt ohne Rat genau die alte Meldung', () => {
    const lines = ['boom']
    const base = COMFY_INSTALLED_BUT_DEAD
    expect(comfyStartupError(base, lines, '')).toBe(comfyStartupError(base, lines))
    expect(comfyStartupError(base, lines, '   ')).toBe(comfyStartupError(base, lines))
    expect(comfyStartupError(base, undefined, '')).toContain('Check Settings')
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

/**
 * P3: derselbe Anfangssatz fuer beide Wege war fuer einen von beiden immer
 * falsch. Der Tester hat in den Einstellungen auf Start gedrueckt und
 * "Installed ComfyUI but it did not come up." bekommen; installiert hatte er
 * nichts. Solange die Meldung im Startpfad ohnehin fast nie erschien, ist das
 * niemandem aufgefallen.
 */
describe('der Anfang gehoert dem Aufrufer', () => {
  it('der Startknopf spricht nicht von einer Installation', () => {
    expect(COMFY_START_FAILED).not.toContain('Installed')
    const msg = comfyStartupError(COMFY_START_FAILED, ['boom'])
    expect(msg).toContain('boom')
    expect(msg).not.toContain('Installed ComfyUI')
  })

  it('und der Create-Weg behaelt seinen', () => {
    // Gegengewicht: der Satz ist nicht abgeschafft, er ist nur nicht mehr der
    // einzige.
    expect(comfyStartupError(COMFY_INSTALLED_BUT_DEAD, ['boom'])).toContain('Installed ComfyUI')
    expect(COMFY_INSTALLED_BUT_DEAD).not.toBe(COMFY_START_FAILED)
  })
})

/**
 * P3, 7.2: sein torch starb an einem umbenannten c10.dll, also beim ersten
 * Import und weit innerhalb der zwei Sekunden, die Rust dem Start zuschaut.
 * Dieser Weg WIRFT, und ein Wurf plant keinen Beobachter, also blieb der
 * Kunde bei "exited right after starting" stehen. Der Satz ueber die
 * Visual-C++-Laufzeit lag die ganze Zeit im Einordner des Installers, und wer
 * eine Sekunde spaeter abstuerzte, bekam ihn.
 */
describe('comfyStartThrowText', () => {
  // Die Meldung, die `comfy_startup_failure` in den Wurf legt: Interpreter,
  // Exit-Code und die letzten Zeilen des Kindes.
  const geworfen = [
    'ComfyUI exited right after starting (python=C:\\ComfyUI\\venv\\Scripts\\python.exe, exit code 1).',
    '',
    'Last output:',
    'OSError: [WinError 1114] a DLL initialization routine failed. Error loading "c10.dll"',
  ].join('\n')

  it('nennt die Visual-C++-Laufzeit auch beim Absturz binnen zwei Sekunden', () => {
    const hint =
      'A Microsoft Visual C++ runtime library is missing on this machine: VCOMP140.DLL. ' +
      'Repair environment does not help here, it is not inside the venv.'
    const msg = comfyStartThrowText(geworfen, { hint, envBroken: false })
    expect(msg).toContain('Visual C++')
    expect(msg).toContain('Repair environment does not help here')
    // Und alles, was der Wurf selbst schon sagte, bleibt stehen.
    expect(msg).toContain('exit code 1')
    expect(msg).toContain('[WinError 1114]')
  })

  it('haengt nichts an, wenn der Einordner nichts zu sagen hat', () => {
    // Die Gegenprobe: ohne sie stuende der Satz unter jedem Absturz.
    const sauber = 'ComfyUI exited right after starting (python=python, exit code 1).'
    expect(comfyStartThrowText(sauber, { hint: '', envBroken: false })).toBe(sauber)
    expect(comfyStartThrowText(sauber, null)).toBe(sauber)
    expect(comfyStartThrowText(sauber)).toBe(sauber)
  })

  it('eine kaputte Umgebung bekommt weiter den allgemeinen Satz, und nur einmal', () => {
    const sauber = 'ComfyUI exited right after starting (python=python, exit code 1).'
    expect(comfyStartThrowText(sauber, { envBroken: true })).toContain(REPAIR_ADVICE)
    // Steht er schon in der Meldung, kommt er nicht ein zweites Mal.
    const schon = `${sauber}\n\n${REPAIR_ADVICE}`
    expect(comfyStartThrowText(schon, { envBroken: true })).toBe(schon)
  })

  /**
   * Die Verantwortung bleibt in Rust. Wer hier einen zweiten Uebersetzer
   * einbaut, hat zwei Tore fuer einen Strom, und eines davon ist irgendwann
   * das schwaechere.
   */
  it('uebersetzt selbst nichts: eine deutsche Zeile geht unveraendert durch', () => {
    const deutsch = 'OSError: [WinError 126] Das angegebene Modul wurde nicht gefunden.'
    expect(comfyStartThrowText(deutsch)).toBe(deutsch)
    expect(comfyStartupError(COMFY_START_FAILED, [deutsch])).toContain(deutsch)
  })
})
