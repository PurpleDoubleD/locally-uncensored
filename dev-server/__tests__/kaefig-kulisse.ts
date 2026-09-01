/**
 * Die KULISSE der Käfig-Anfragen dieses Ordners: ein Wegwerf-Heimatverzeichnis,
 * das für die Dauer EINER echten Anfrage gilt.
 *
 * DER BEFUND, der diese Datei nötig machte — auf einer echten Windows-Maschine
 * gemessen, nicht hergeleitet:
 *
 *     os.tmpdir()  = C:\Users\<u>\AppData\Local\Temp
 *     os.homedir() = C:\Users\<u>
 *
 * Drei Testdateien hier bauten ihre Käfigwurzel mit `mkdtempSync(tmpdir())`
 * und liessen `os.homedir()` auf dem ECHTEN Heim stehen. Unter Windows liegt
 * `tmpdir()` damit INNERHALB von `$HOME\AppData`, und `AppData` steht in
 * `forbiddenRootPrefixes` (src/lib/dev-fs-jail.ts) — neben `.ssh`, `.aws`,
 * `.gnupg`, `.kube`. Das ERSTE Tor des Käfigs (`devCheckWorkspaceRoot`) lehnte
 * die WURZEL also ab, bevor überhaupt ein Pfad geprüft wurde:
 *
 *     WorkspaceRootError: Not an allowed workspace folder (system or credential
 *     directory): C:/Users/<u>/AppData/Local/Temp/lu-sonde-hRkTNC/arbeitsordner
 *
 * `withJsonBody` beantwortet jeden `JailEscapeError` mit 403 — daher neun 403
 * statt 200/400. Auf macOS liegt `tmpdir()` unter `/private/var/…` und fällt
 * unter keine der Regeln; deshalb war dort nichts zu sehen.
 *
 * KEIN PRODUKTBEFUND, und das ist gemessen: derselbe Request mit einem Heim,
 * das die Kulisse NICHT enthält, antwortet auf derselben Windows-Maschine mit
 * 200 und dem Dateiinhalt. Die Containment-Regel funktioniert dort; abgelehnt
 * wurde nur der Ort, an dem die Tests ihre Kulisse aufstellten.
 *
 * WARUM DAS HEIM MITZIEHT UND NICHT DIE KULISSE WANDERT. Der Käfig misst seine
 * Sperrlisten GEGEN `homeDir` — `forbiddenExactRoots` und
 * `forbiddenRootPrefixes` nehmen es als Argument. Wer nur die Kulisse
 * verschiebt, sucht einen Ordner, der auf beiden Plattformen zufällig erlaubt
 * ist, und hängt damit am Ort des Checkouts und am Namen des Benutzers. Wer
 * das Heim mitnimmt, macht die Kulisse PER KONSTRUKTION erlaubt: ein
 * Arbeitsordner im Heimatverzeichnis ist genau der Normalfall, für den der
 * Käfig geschrieben ist. Keine Plattform-Fallunterscheidung, kein `skipIf`,
 * und auf beiden Maschinen wird dieselbe Aussage geprüft.
 *
 * `heim` IST PFLICHT UND STEHT VORNE. In schreiben-ohne-ziel.test.ts war das
 * Heim das dritte, OPTIONALE Argument eines lokalen `fsPost` — drei
 * Aufrufstellen liessen es weg, und genau diese drei waren unter Windows rot.
 * Ein Pflichtargument lässt sich nicht vergessen: der Compiler zählt mit.
 *
 * GEMESSEN, NICHT ANGENOMMEN — die Reihenfolge ist hier NICHT das Problem:
 * `os.homedir()` liest `HOME`/`USERPROFILE` bei JEDEM Aufruf, nicht beim
 * Import. Die sechs Türen in dev-server/fs-routes.ts rufen es pro Request auf
 * (`resolveFsRequestPath(body, os.homedir(), devJail)`), und eine Sonde auf der
 * Windows-Maschine zeigte das Umbiegen noch durchgreifen, lange nachdem
 * fs-routes importiert war. Beide Variablen werden gesetzt, weil `os.homedir()`
 * unter POSIX `HOME` und unter Windows `USERPROFILE` liest; nur eine zu setzen
 * hiesse, auf der jeweils anderen Plattform gegen einen Wegwerf-Pfad zu prüfen,
 * den der Handler nie anfasst — VAKUUM-GRÜN.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connect } from 'vite'
import { anfrage, type AnfrageOptionen, type Antwort } from './echte-anfrage'

/** Die beiden Variablen, aus denen `os.homedir()` sein Ergebnis nimmt. */
const HEIM_VARIABLEN = ['HOME', 'USERPROFILE'] as const

/** Was diese Datei angelegt hat, damit `kulisseAufraeumen` es wieder los wird. */
const angelegt: string[] = []

/**
 * Ein frisches Wegwerf-Heimatverzeichnis.
 *
 * `realpathSync`, weil `/var` auf macOS ein Symlink auf `/private/var` ist und
 * der Käfig Symlinks auflöst: ohne das prüfte der Test gegen eine Wurzel, die
 * der Handler anders schreibt als wir.
 */
export function frischesHeim(): string {
  const heim = realpathSync(mkdtempSync(join(tmpdir(), 'lu-heim-')))
  angelegt.push(heim)
  return heim
}

/** Ein Arbeitsordner IM Wegwerf-Heim — der Normalfall, den der Käfig erlaubt. */
export function arbeitsordnerIn(heim: string, name = 'arbeitsordner'): string {
  return join(heim, name)
}

/** Gehört in das `afterAll` jeder Datei, die `frischesHeim` benutzt. */
export function kulisseAufraeumen(): void {
  for (const p of angelegt.splice(0)) rmSync(p, { recursive: true, force: true })
}

/**
 * Eine echte Anfrage (echter node:http-Server, echte Bytes — siehe
 * echte-anfrage.ts), während der `os.homedir()` auf `heim` zeigt.
 *
 * Umgebogen wird nur FÜR DIE DAUER der Anfrage und danach exakt
 * zurückgesetzt, auch im Fehlerfall: die Handler lesen `os.homedir()`
 * synchron innerhalb dieses `await`, und vitest führt die Fälle einer Datei
 * nacheinander aus.
 */
export async function anfrageImHeim(
  handler: Connect.NextHandleFunction,
  heim: string,
  optionen: AnfrageOptionen = {},
): Promise<Antwort> {
  const vorher = HEIM_VARIABLEN.map((name) => [name, process.env[name]] as const)
  for (const name of HEIM_VARIABLEN) process.env[name] = heim
  try {
    return await anfrage(handler, optionen)
  } finally {
    for (const [name, wert] of vorher) {
      if (wert === undefined) delete process.env[name]
      else process.env[name] = wert
    }
  }
}
