/**
 * Wann die gelbe Cross-Origin-Leiste im Create-Tab noch etwas zu sagen hat.
 *
 * R18 Befund 1, gemessen am echten 2.6.7 Windows Build (2026-08-30, ComfyUI
 * 0.33.0 auf der Box): die Leiste "Your ComfyUI blocks direct loads (v0.19+),
 * so previews use a slower fallback." kam nach JEDEM Render zurueck, auch nach
 * dem Klick auf ihr X. Der Grund stand in zwei Zeilen, die nichts voneinander
 * wussten:
 *
 *   useComfyMedia.onError  ->  setComfyCorsBlocked(true)   (pro Medienelement)
 *   CreateExperimental X   ->  setComfyCorsBlocked(false)  (einmal, fluechtig)
 *
 * `comfyCorsBlocked` lebt im createStore und ist dort ausdruecklich von der
 * Persistenz ausgenommen. Das Wegklicken setzte also genau eine Variable
 * zurueck, die das naechste geladene Vorschaubild sofort wieder auf true zog.
 * Der Nutzer klickt weg, LU sagt es beim naechsten Bild wieder. Zwanzig Renders
 * lang.
 *
 * Ein Hinweis, den der Nutzer weggeklickt hat, bleibt weg, bis sich die Lage
 * aendert. Genau das ist die Regel hier, und "die Lage" ist keine Meinung,
 * sondern eine Signatur: welches ComfyUI, in welcher Version. Dieselbe
 * Signatur heisst dieselbe Ursache und dieselbe Antwort. Eine andere Signatur
 * (der Nutzer aktualisiert ComfyUI, oder zeigt LU auf ein anderes) darf die
 * Leiste ein einziges Mal wieder zeigen, weil dort niemand weggeklickt hat.
 *
 * Der Fix-Weg braucht davon nichts: gelingt "Let me do it for you!", laeuft
 * ComfyUI mit --enable-cors-header, kein Medienelement faellt mehr auf den
 * Proxy zurueck und die Leiste kommt aus eigener Kraft nie wieder.
 *
 * Rein und ohne React, damit die Regel im Test beweisbar ist. Die .tsx rendert
 * der node-Testlauf nicht.
 */

/**
 * Die Signatur, wenn die ComfyUI-Version nicht zu erfahren war.
 *
 * Sehr alte ComfyUI-Staende liefern in /system_stats kein `comfyui_version`.
 * Das ist ein gueltiger Zustand, kein Fehler, und bekommt deshalb einen festen
 * Platzhalter statt eines null, das die Regel unten anders behandeln wuerde.
 */
export const UNKNOWN_COMFY_VERSION = 'unknown'

/**
 * Was gespeichert wird, wenn beim Wegklicken noch gar keine Signatur vorlag.
 *
 * Kann vorkommen: die Signatur wird beim Mount geladen, der Klick koennte
 * theoretisch frueher kommen. Der Wegklick zaehlt trotzdem sofort, und sobald
 * die echte Signatur eintrifft, wird dieser Platzhalter durch sie ersetzt
 * (adoptCorsSignature im Store). Sonst waere der Wegklick beim naechsten
 * Render wieder wertlos gewesen, also genau der Befund von oben.
 */
export const PENDING_SIGNATURE = 'pending'

/**
 * Welches ComfyUI, in welcher Version.
 *
 * Host und Port stehen im Frontend-Spiegel, den AppShell beim Start aus
 * `comfyui_status` fuellt. Die Version kommt aus /system_stats.
 */
export function comfyCorsSignature(
  host: string,
  port: number,
  version: string | null | undefined,
): string {
  const h = String(host ?? '').trim() || 'localhost'
  const v = String(version ?? '').trim() || UNKNOWN_COMFY_VERSION
  return `${h}:${port}|${v}`
}

/**
 * Zeigt die Leiste jetzt etwas an, das der Nutzer nicht schon weggeklickt hat.
 *
 * `blocked`      der Sitzungszustand aus createStore: ein Medienelement musste
 *                ueber den Proxy gerettet werden.
 * `signature`    die aktuelle Ursachensignatur, null solange sie laedt.
 * `dismissedFor` die Signatur, fuer die weggeklickt wurde, null wenn nie.
 *
 * Der Fall `dismissedFor` gesetzt und `signature` noch null ist bewusst still:
 * wer einmal weggeklickt hat, bekommt keine Leiste, solange LU nicht belegen
 * kann, dass sich die Ursache geaendert hat. Ein kurzes Aufblitzen beim Start
 * waere genau die Sorte Laerm, die dieser Befund abstellt.
 */
export function shouldShowCorsNotice(
  blocked: boolean,
  signature: string | null,
  dismissedFor: string | null,
): boolean {
  if (!blocked) return false
  if (!dismissedFor) return true
  if (!signature) return false
  return signature !== dismissedFor
}

/**
 * Die aktuelle Signatur besorgen, oder null, wenn das ComfyUI gerade nichts
 * sagt.
 *
 * Ein einziger Aufruf gegen /system_stats, und nur wenn der Create-Tab offen
 * ist. Kein Dauerfeuer auf Port 8188.
 */
export async function loadComfyCorsSignature(deps: {
  host: () => string
  port: () => number
  version: () => Promise<string | null>
}): Promise<string | null> {
  let version: string | null = null
  try {
    version = await deps.version()
  } catch {
    // Kein Grund, deswegen ohne Signatur dazustehen: der Platzhalter ist eine
    // gueltige Signatur, sie aendert sich nur, wenn sich die Version meldet.
    version = null
  }
  const port = deps.port()
  if (!Number.isFinite(port) || port <= 0) return null
  return comfyCorsSignature(deps.host(), port, version)
}
