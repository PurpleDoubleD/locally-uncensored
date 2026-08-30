/**
 * Was der Create-Tab sagt, wenn ComfyUI im Leerlauf wegstirbt.
 *
 * R18 Befund 2, gemessen am echten 2.6.7 Windows Build (2026-08-30): ComfyUI
 * wurde beendet, waehrend die App offen im Leerlauf stand. Der Create-Tab zeigte
 * 180 Sekunden lang NICHTS. Kein Wort, kein Hinweis, die Oberflaeche sah aus wie
 * immer. Erst der naechste Render heilte die Lage, und das tut er zuverlaessig
 * (comfy-restart-guard.ts, R16 Befund 5). Nur weiss der Nutzer davon nichts,
 * solange er nicht auf Create drueckt.
 *
 * Der Grund ist gutartig: `connected` wird beim Mount des Tabs einmal geprueft
 * und danach nie wieder, weil nichts im Leerlauf fragt. Kein Fehler entsteht,
 * also erscheint auch keiner.
 *
 * Was diese Datei tut, und was ausdruecklich NICHT:
 *
 *   - Sie sagt Bescheid. Ruhig, in einem Satz, mit dem was als naechstes
 *     passiert.
 *   - Sie startet NICHTS neu. Ein Neustart im Leerlauf kostet RAM und VRAM fuer
 *     eine Arbeit, die niemand angefordert hat, und der Render-Pfad heilt
 *     bewiesenermassen von selbst. Selbstheilung heisst nicht Vorratsheilung.
 *   - Sie fragt selten. Ein Blick alle 30 Sekunden auf `comfyui_status`, und nur
 *     solange der Create-Tab offen ist und nichts rendert. Kein Dauerfeuer auf
 *     Port 8188.
 *
 * Jede Zeile darf nur behaupten, was in ihrer Lage auch stimmt. Der Satz "It
 * will restart with your next render" gilt genau dann, wenn der Render-Pfad das
 * wirklich tun wird, also bei einem ComfyUI, das LU verwalten darf. Bei einem
 * fremden oder entfernten sagt LU stattdessen, dass es nicht seine Sache ist,
 * statt eine Rettung zu versprechen, die nicht kommt.
 */

import { comfyIsManaged, type ComfyGuardStatus } from './comfy-restart-guard'

/**
 * Abstand zwischen zwei Blicken.
 *
 * Grosszuegig mit Absicht: hier wird nichts gemessen und nichts gewartet, hier
 * wird nur ein stiller Ausfall bemerkt. Eine halbe Minute Verzug gegen 180
 * Sekunden Schweigen ist der ganze Handel.
 */
export const IDLE_WATCH_INTERVAL_MS = 30_000

/** Der Satz fuer ein ComfyUI, das LU beim naechsten Render selbst hochholt. */
export const IDLE_STOPPED_MANAGED = 'ComfyUI stopped. It will restart with your next render.'

/** Ein ComfyUI auf einer anderen Maschine. LU kann es von hier nicht starten. */
export const IDLE_STOPPED_REMOTE =
  'ComfyUI is not answering. It runs on another machine, so it has to be started there.'

/** Lokal, aber es gibt keine brauchbare Installation zum Starten (GH #98). */
export const IDLE_STOPPED_UNUSABLE =
  'ComfyUI is not running, and LU found no working install to start. See Settings, AI Backends.'

/** Es kommt gerade hoch. Kein Alarm, nur die Lage. */
export const IDLE_STARTING = 'ComfyUI is starting up.'

/**
 * Lohnt sich der Blick ueberhaupt.
 *
 * `local`        der Create-Tab rendert lokal. Ein Cloud-Job kommt an das
 *                lokale ComfyUI nie heran, dort waere der Hinweis eine Luege.
 * `isMac`        auf dem Mac laeuft ComfyUI nie (Hausregel MLX only), es gibt
 *                also nichts, dessen Ausfall zu melden waere.
 * `isGenerating` waehrend eines Renders erzaehlt der Fortschritt die Lage, und
 *                der Render-Pfad heilt sie ohnehin. Der Leerlaufwaechter hat
 *                dort nichts zu suchen und wuerde nur doppelt reden.
 */
export function shouldWatchComfyIdle(local: boolean, isMac: boolean, isGenerating: boolean): boolean {
  return local && !isMac && !isGenerating
}

/**
 * Der Satz zur Lage, oder '' wenn es nichts zu sagen gibt.
 *
 * `null` ist ausdruecklich still: das Kommando kann fehlen (Web-Build) oder das
 * Backend gerade nicht antworten. Ueber einen Zustand, den LU nicht kennt, sagt
 * LU nichts.
 */
export function comfyIdleNotice(status: ComfyGuardStatus | null): string {
  if (!status) return ''
  if (status.running === true) return ''
  if (status.starting === true) return IDLE_STARTING
  if (comfyIsManaged(status)) return IDLE_STOPPED_MANAGED
  if (status.isLocal === false) return IDLE_STOPPED_REMOTE
  return IDLE_STOPPED_UNUSABLE
}
