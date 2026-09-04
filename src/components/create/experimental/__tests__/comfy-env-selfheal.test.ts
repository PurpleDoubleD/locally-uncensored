/**
 * GH #98, zweite Welle (joelnewswanger 14.08.): sein torch lebte im geteilten
 * System-Python und starb beim Import. Der Absturz las sich als "nicht
 * installiert", der Re-Install aenderte nichts (pip: already satisfied), und
 * der Settings-Startknopf kippte still auf Stopped, weil der Crash erst nach
 * dem 2-Sekunden-Spawn-Fenster kam.
 *
 * Der Fix: ein Absturz wird sofort erkannt, ein env-kaputter Absturz baut
 * GENAU EINMAL ein frisches venv (repair_comfyui_env) und startet neu, und
 * der Download-Pfad laeuft nur noch, wenn wirklich keine Installation da ist.
 * Quellgepinnt, weil jede dieser Weichen eine Bedingung ist, die kein
 * bestehender Test sieht.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const hier = dirname(fileURLToPath(import.meta.url))
const kontext = () => readFileSync(resolve(hier, '..', 'CreateContext.tsx'), 'utf8')
const settings = () => readFileSync(resolve(hier, '..', '..', '..', 'settings', 'SettingsPage.tsx'), 'utf8')
// A13: der Lauf selbst wohnt seit dem Umbau im Store, damit ein Wechsel des
// Einstellungsbereichs den Fortschritt nicht mehr wegwirft. Der Knopf sitzt
// weiter in den Settings, das Kommando steht jetzt daneben.
const installStore = () => readFileSync(resolve(hier, '..', '..', '..', '..', 'stores', 'comfyInstallStore.ts'), 'utf8')

describe('#98: die ComfyUI-Umgebung heilt sich selbst', () => {
  it('ein Absturz in der Wartschleife wird sofort erkannt, nicht als Timeout verbrannt', () => {
    const src = kontext()
    expect(src).toMatch(/const startAndAwait = useCallback/)
    expect(src).toMatch(/if \(out\?\.exited\) return 'crashed'/)
  })

  it('ein env-kaputter Absturz repariert genau einmal und startet dann neu', () => {
    const src = kontext()
    expect(src).toMatch(/out\?\.envBroken && !repaired/)
    expect(src).toMatch(/backendCall\('repair_comfyui_env'\)/)
  })

  it('der Download-Pfad laeuft nur noch fuer eine wirklich fehlende Installation', () => {
    const src = kontext()
    expect(src).toMatch(/r === 'missing' && !installedNow/)
  })

  // P3: seit der Launcher einen Start mit kaputtem venv verweigert, trifft
  // dieser Weg einen echten Fall. Jedes Err aus start_comfyui wurde hier zu
  // 'missing' und damit zum Download von mehreren Gigabyte fuer eine
  // Installation, die vollstaendig auf der Platte liegt.
  it('ein gescheiterter Start ist kein fehlendes ComfyUI', () => {
    const src = kontext()
    expect(src, 'jeder Startfehler wird wieder als fehlende Installation gelesen')
      .not.toMatch(/catch \{ r = 'missing' \}/)
    expect(src).toMatch(/if \(st\?\.found && st\?\.complete !== false\) throw e/)
  })

  it('die Settings haben einen Repair-Knopf am selben Kommando', () => {
    const src = settings()
    expect(src).toMatch(/Repair environment/)
    expect(src).toMatch(/runRepair\(\)/)
    expect(installStore()).toMatch(/backendCall\('repair_comfyui_env'\)/)
  })

  // P3: hier stand ein Test, der nur nachsah, ob die Zeichenketten
  // `comfyui_last_output` und `envBroken` irgendwo in SettingsPage.tsx
  // vorkommen. Beides war unter dem einmaligen Blick nach 6 Sekunden wahr, und
  // genau deshalb galt dieser Defekt als abgedeckt, waehrend ein Absturz nach
  // 20 Sekunden gar nichts meldete. Was der Startversuch wirklich tut, steht
  // jetzt in settings/__tests__/ein-spaeter-absturz-wird-noch-gemeldet.test.ts
  // und laeuft dort gegen die gerenderte Oberflaeche. Hier bleibt der Anker
  // gegen die Rueckkehr des Einmalblicks.
  it('der Settings-Start sieht wiederholt hin, nicht einmal nach sechs Sekunden', () => {
    const src = settings()
    expect(src).toMatch(/comfyui_last_output/)
    expect(src).toMatch(/const watchForLateCrash/)
    expect(src, 'der einmalige Blick nach 6 Sekunden ist zurueck').not.toMatch(/\}, 6000\)/)
    // Das zweite stille Tor: der Puffer traegt immer die Kopfzeile `[start]`,
    // also fiel ein Absturz ganz ohne Ausgabe auch dann durch, wenn `exited`
    // stimmte.
    expect(src).not.toMatch(/lines\.length > 1/)
  })
})

/**
 * Ticket 007 (falcon bob, 01.09. bis 02.09.): der Einordner des Installers
 * kannte WinError 1114 seit 2.6.7, der Startfehler-Pfad hat ihn nie gefragt.
 * Der Kunde bekam den allgemeinen Satz, drueckte Repair, wartete den Neubau ab
 * und stand vor derselben Meldung. Beide Oberflaechen holen den Rat jetzt aus
 * derselben Stelle, damit der gepflegte Pfad nicht wieder der einzige bleibt.
 */
describe('Ticket 007: der Rat unter der Ausgabe kommt aus einer Stelle', () => {
  it('die Settings entscheiden nicht mehr selbst, welcher Satz drunter steht', () => {
    const src = settings()
    expect(src).toMatch(/comfyCrashAdvice\(out\)/)
    // Der allgemeine Satz wohnt jetzt in comfyError.ts. Stuende er hier noch
    // einmal, waere die naechste Aenderung wieder eine von zwei Kopien.
    expect(src).not.toMatch(/The Python environment looks broken/)
  })

  it('der Create-Pfad reicht den konkreten Hinweis an den Kunden durch', () => {
    const src = kontext()
    expect(src).toMatch(/comfyStartupError\(COMFY_INSTALLED_BUT_DEAD, out\?\.lines, out\?\.hint\)/)
    expect(src).toMatch(/hint\?: string/)
  })

  it('der Rat selbst steht in comfyError.ts, samt Vorrang des konkreten Hinweises', () => {
    const fehler = readFileSync(resolve(hier, '..', 'comfyError.ts'), 'utf8')
    expect(fehler).toMatch(/export const REPAIR_ADVICE/)
    expect(fehler).toMatch(/export function comfyCrashAdvice/)
  })
})
