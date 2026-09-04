/**
 * @vitest-environment jsdom
 *
 * P3, zweiter Teil des Befundes: eine ComfyUI-Kopie mit einem fehlenden Modul
 * stuerzte beim Start ab, und in der Oberflaeche kam GAR KEINE Meldung. Der
 * Grund waren zwei geschlossene Tore. Rust schaut nach dem Spawn 2 Sekunden zu,
 * und hier stand ein einziges setTimeout ueber 6 Sekunden. ComfyUI importiert
 * 20 bis 60 Sekunden, bevor es den Port bindet, also ist ein Absturz beim
 * Import fuer beide zu spaet, und danach hat nie wieder jemand hingesehen.
 *
 * Diese Datei prueft nicht, ob eine Zeichenkette im Quelltext vorkommt. Sie
 * stellt die Uhr.
 *
 * Der Takt, gegen den die Zeiten hier gerechnet sind: der Statuspoll des
 * Panels laeuft ab dem Mounten alle 5 s, der Beobachter ab dem Startklick alle
 * 2 s. Geklickt wird bei Sekunde 1, damit die beiden nicht auf demselben
 * Zeitpunkt liegen.
 *
 * Run: npx vitest run src/components/settings/__tests__/ein-spaeter-absturz-wird-noch-gemeldet.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const backendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
  setComfyPort: vi.fn(),
  setComfyHost: vi.fn(),
}))

const { ComfyUISettings } = await import('../SettingsPage')
const { useComfyInstallStore } = await import('../../../stores/comfyInstallStore')

const TRACEBACK = "ModuleNotFoundError: No module named 'comfy.ldm.models'"

/** Die Ausgabe eines Starts, der noch importiert. Der Ringpuffer traegt immer
 *  die Kopfzeile, deshalb war "mehr als eine Zeile" nie ein Beweis. */
const IMPORTING = { exited: false, lines: ['[start] python main.py --port 8188'], envBroken: false, hint: '' }
const CRASHED = {
  exited: true,
  lines: ['[start] python main.py --port 8188', TRACEBACK],
  envBroken: true,
  hint: '',
}

/** Ab wann `comfyui_last_output` `exited` meldet. Unter falschen Uhren zieht
 *  `vi.advanceTimersByTimeAsync` auch `Date.now()` mit. */
let exitedAb = Number.POSITIVE_INFINITY
/** Was `comfyui_status` gerade antwortet. */
let laeuft = false
/** Womit `start_comfyui` wirft, wenn das Kind schon vor der Antwort tot war. */
let startWirft: string | null = null
/** Der Befund des Installers zu diesem Absturz, den Rust mitliefert. */
let hinweis = ''

beforeEach(() => {
  vi.useFakeTimers()
  useComfyInstallStore.getState().reset()
  exitedAb = Number.POSITIVE_INFINITY
  laeuft = false
  startWirft = null
  hinweis = ''
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'comfyui_status') {
      return { running: laeuft, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true }
    }
    if (cmd === 'start_comfyui' && startWirft) throw new Error(startWirft)
    if (cmd === 'comfyui_last_output') {
      return Date.now() >= exitedAb ? { ...CRASHED, hint: hinweis } : IMPORTING
    }
    if (cmd === 'install_comfyui_status') return { status: 'idle', logs: [] }
    return {}
  })
})
afterEach(() => {
  cleanup()
  useComfyInstallStore.getState().reset()
  vi.useRealTimers()
})

async function uhrVor(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** Panel mounten und bei Sekunde 1 auf Start druecken. */
async function startGedruecktBeiSekundeEins() {
  render(createElement(ComfyUISettings))
  await uhrVor(1_000)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })) })
}

describe('ein Absturz nach dem Startfenster erreicht die Oberflaeche', () => {
  it('meldet einen Absturz nach zehn Sekunden, und vorher nichts', async () => {
    render(createElement(ComfyUISettings))
    await uhrVor(1_000)
    exitedAb = Date.now() + 10_000
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })) })

    // Der alte Blick sass genau hier, 6 Sekunden nach dem Klick. Zu diesem
    // Zeitpunkt importiert das Kind noch, `exited` ist falsch, und es gibt
    // nichts zu melden. Ein Fix, der die 6 Sekunden bloss hochdreht, kommt an
    // dieser Haelfte des Tests vorbei.
    await uhrVor(6_000)
    expect(screen.queryByRole('alert')).toBeNull()

    // Und dann stirbt es. Vorher hat das niemand mehr gesehen: das Panel fiel
    // still auf Stopped zurueck und der Traceback blieb im Ringpuffer liegen.
    await uhrVor(14_000)
    const alarm = screen.getByRole('alert')
    expect(alarm.textContent).toContain(TRACEBACK)
    // Der Anfang gehoert dem Startknopf, nicht dem Installationsweg: hier hat
    // niemand etwas installiert.
    expect(alarm.textContent).not.toContain('Installed ComfyUI')
  })

  it('ein Start, der hochkommt, meldet nie einen Absturz', async () => {
    // Der adoptierte Waise: LU haelt keinen Prozess, also ist `exited` wahr,
    // obwohl auf dem Port ein einwandfreies ComfyUI antwortet. Ohne die
    // Statusfrage vor der Meldung faerbt das Panel hier rot. Und ohne diesen
    // Test ist der Test darueber auch mit "melde immer" zufrieden.
    exitedAb = 0
    await startGedruecktBeiSekundeEins()
    laeuft = true

    await uhrVor(60_000)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ein Stop erfindet keinen Absturz aus der Ausgabe des vorigen Laufs', async () => {
    // Nach einem Stop haelt LU keinen Prozess mehr, `exited` ist wahr, und der
    // Ringpuffer traegt noch die Zeilen des Laufs, der gerade beendet wurde
    // (geleert wird er erst beim naechsten Start). Ein Beobachter, den der
    // Stop nicht abloest, meldet die als frischen Absturz. Der Restart-Knopf
    // loest genau diese Reihenfolge bei jedem Klick aus.
    // Das Zeitfenster ist genau ausgemessen, sonst prueft der Test nichts: der
    // Beobachter hoert von selbst auf, sobald er running sieht. Hier importiert
    // ComfyUI bis Sekunde 9,5, die Statusantwort bei Sekunde 10 bringt den
    // Stop-Knopf, und der naechste Tick des Beobachters kommt bei Sekunde 11.
    // Dazwischen wird geklickt, und genau das tut auch der Restart-Knopf.
    await startGedruecktBeiSekundeEins()
    await uhrVor(8_500)
    laeuft = true
    await uhrVor(1_000)

    exitedAb = 0
    laeuft = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })) })

    await uhrVor(20_000)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  /**
   * P3, 7.2: ein umbenanntes c10.dll toetet torch beim ersten Import, also weit
   * innerhalb der zwei Sekunden, die Rust dem Start zuschaut. Dieser Weg wirft,
   * und ein Wurf plant keinen Beobachter, also erreichte der Kunde nur
   * "exited right after starting" plus Traceback. Der Satz ueber die
   * Visual-C++-Laufzeit lag die ganze Zeit im Einordner des Installers, und wer
   * eine Sekunde spaeter starb, bekam ihn.
   */
  it('ein Absturz binnen der zwei Sekunden nennt die Laufzeit, die fehlt', async () => {
    startWirft = [
      'ComfyUI exited right after starting (python=C:\\ComfyUI\\venv\\Scripts\\python.exe, exit code 1).',
      '',
      'Last output:',
      'OSError: [WinError 1114] a DLL initialization routine failed. Error loading "c10.dll"',
    ].join('\n')
    exitedAb = 0
    hinweis =
      'A Microsoft Visual C++ runtime library is missing on this machine: VCOMP140.DLL. ' +
      'Repair environment does not help here, it is not inside the venv.'

    await startGedruecktBeiSekundeEins()
    await uhrVor(0)

    const alarm = screen.getByRole('alert')
    // Was der Wurf selbst schon sagte, steht weiter da.
    expect(alarm.textContent).toContain('exit code 1')
    expect(alarm.textContent).toContain('[WinError 1114]')
    // Und der Satz, der bisher nur den spaeten Abstuerzen vorbehalten war.
    expect(alarm.textContent).toContain('Visual C++')
    expect(alarm.textContent).toContain('Repair environment does not help here')
  })

  it('und erfindet keinen Rat, wo der Einordner keinen hat', async () => {
    // Die Gegenprobe: ohne sie haengt der Hinweis unter jedem Wurf, und dann
    // sagt der Test darueber nichts mehr aus.
    startWirft = 'Failed to start ComfyUI (python=python): the file was not found (os error 2)'
    exitedAb = Number.POSITIVE_INFINITY

    await startGedruecktBeiSekundeEins()
    await uhrVor(0)

    const alarm = screen.getByRole('alert')
    expect(alarm.textContent).toContain('Failed to start ComfyUI')
    expect(alarm.textContent).not.toContain('Visual C++')
    expect(alarm.textContent).not.toContain('Repair environment')
  })
})
