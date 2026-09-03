/**
 * Der EINE Zwischenspeicher, in den drei Transporte malen.
 *
 * Der geteilte veraenderliche Zustand sind die zwei Zeilen `livePaintPending`
 * und `livePaintFrame`. In useCodex.ts standen sie in der Schleife, und
 * angefasst wurden sie von DREI Transportzweigen (Ollama, OpenAI-kompatibel,
 * Hermes-XML) plus drei `settleLivePaint()`-Aufrufen, die bis zu 400 Zeilen
 * weiter unten liegen. Wer den Puffer fuellt und wer ihn abraeumt, gehoert
 * zusammen — das ist derselbe Schnitt, mit dem `dev-server/comfy.ts` seinen
 * Kindprozess samt Logpuffer bekommen hat.
 *
 * ZWEI REGELN HAENGEN DARAN, und beide waren in der grossen Datei nicht
 * pruefbar:
 *
 *  1. ZUSAMMENFASSEN PRO BILD (Pruefung D1). Codex schrieb frueher bei JEDEM
 *     Token in den Speicher und zeichnete damit das ganze Gespraech neu.
 *     Mehrere `feed()` in einem Bild ergeben genau EINEN Schreibvorgang, und
 *     zwar mit dem ZULETZT eingespeisten Text.
 *
 *  2. `settle()` LOESCHT EIN NOCH NICHT GEFEUERTES BILD. Ohne das konnte ein
 *     wartendes Bild NACH dem letzten direkten Schreiben feuern und alten
 *     Inhalt ueber den fertigen Text malen. Deshalb raeumt jeder Transport
 *     sofort ab, wenn der Stream-Aufruf zurueckkehrt.
 *
 * `schedule` ist ein Parameter und kein fest verdrahtetes
 * `requestAnimationFrame`: die App reicht das echte durch, und ein Test kann
 * die Bilder von Hand ausloesen. Ohne diese Naht waere die Regel "settle
 * verhindert das Nachmalen" ueberhaupt nicht zu zeigen — `requestAnimationFrame`
 * gibt es in der node-Umgebung der Tests gar nicht.
 */

export interface LivePaintDeps {
  /** Wird `true`, solange der Text nicht in den Chat darf (Echo-Wache). */
  suppress: (content: string) => boolean
  /** Was diesem Zug schon vorausging; leer heisst "nichts davor". */
  prefix: () => string
  /** Der tatsaechliche Schreibvorgang in den Chat-Speicher. */
  paint: (text: string) => void
  /** Voreinstellung: das echte Bild des Browsers. */
  schedule?: (cb: () => void) => void
}

export interface LivePaint {
  feed: (content: string) => void
  settle: () => void
}

export function createLivePaint(deps: LivePaintDeps): LivePaint {
  const schedule = deps.schedule ?? ((cb: () => void) => { requestAnimationFrame(cb) })
  let livePaintPending: string | null = null
  let livePaintFrame = false

  const settle = () => {
    livePaintPending = null
  }

  const feed = (c: string) => {
    if (deps.suppress(c)) return
    const before = deps.prefix()
    livePaintPending = before ? before + '\n\n' + c : c
    if (livePaintFrame) return
    livePaintFrame = true
    schedule(() => {
      livePaintFrame = false
      if (livePaintPending !== null) {
        deps.paint(livePaintPending)
        livePaintPending = null
      }
    })
  }

  return { feed, settle }
}
