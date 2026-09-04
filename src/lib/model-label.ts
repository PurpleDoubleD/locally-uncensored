/**
 * Wie ein Modellname in einer schmalen Zeile aussieht, ohne dass zwei
 * verschiedene Modelle gleich aussehen.
 *
 * Gegenprobe G1, 04.09.2026, echter Windows-Build. Sobald LM Studio als
 * Provider dazukommt, reicht die Anwendung dessen interne Kennungen
 * unveraendert an zwei Oberflaechen durch, je sechs Stueck:
 *
 *     qwen/qwen3-4b                        Herstellerpraefix mit Schraegstrich
 *     qwen/qwen3-4b/qwen3-4b-q4_k_m.gguf   ganzer Pfad samt Dateiendung
 *     qwen/qwen2.5-vl-7b                   Herstellerpraefix
 *     qwen2.5-0.5b-instruct@q4_k_m         interne Quant-Kennung mit @
 *     qwen2.5-0.5b-instruct@q8_0           interne Quant-Kennung mit @
 *     mlabonne_gemma-3-4b-it-abliterated   Hochlader-Praefix
 *
 * Der Anzeigefehler dazu wiegt schwerer als das Aussehen: das Aufklappmenue
 * kuerzt am ENDE, also standen `qwen2.5-0.5b-instruct@...` und
 * `qwen2.5-0.5b-instruct...` untereinander und sahen GLEICH aus. Der Kunde
 * kann q4_k_m und q8_0 nicht auseinanderhalten, obwohl es zwei verschiedene
 * Modelle sind. Genau das Zeichen, das die beiden unterscheidet, war das
 * erste, das weggeschnitten wurde.
 *
 * Zwei Regeln, beide ohne Raten:
 *
 *  1. Was ein Dateisystem oder eine Registrierung dazugetan hat, faellt weg:
 *     fuehrende Pfadteile und die Endung `.gguf`. Der letzte Teil bleibt
 *     unangetastet, also auch jedes Praefix, das zum Namen selbst gehoert
 *     (`mlabonne_` bleibt, es steht so in der Datei des Kunden).
 *  2. Der Quant-Teil am Ende wird vom Rest getrennt, damit die Kuerzung in der
 *     MITTE greift und die Unterscheidung stehen bleibt.
 */

// Dieselbe Marke, die lib/lmstudio-match zum Vergleichen benutzt, hier zum
// Anzeigen. Ein zweites, abweichendes Muster waere genau die Art Drift, die
// zwei Modelle wieder gleich aussehen laesst.
const QUANT_TAIL = /[@._-]((?:ud-)?(?:iq\d|q\d|f16|f32|bf16)[a-z0-9_]*)$/i

/**
 * Der Name ohne Pfad und ohne Dateiendung.
 *
 * Nur Zutaten der Ablage fallen weg. Alles, was zum Namen gehoert, bleibt:
 * ein Kunde, der `mlabonne_gemma-3-4b-it-abliterated` heruntergeladen hat,
 * muss diese Datei unter diesem Namen wiederfinden.
 */
export function shortModelLabel(name: string): string {
  const letzter = name.split(/[\\/]/).pop() || name
  return letzter.replace(/\.gguf$/i, '')
}

/**
 * Derselbe Name, aufgeteilt in einen Kopf, der gekuerzt werden darf, und ein
 * Ende, das stehen bleiben muss.
 *
 * Ohne Quant am Ende ist das Ende leer und die Zeile verhaelt sich wie
 * vorher. Mit Quant wandert die Auslassung in die Mitte.
 */
export function splitForMiddleEllipsis(name: string): { head: string; tail: string } {
  const kurz = shortModelLabel(name)
  const m = kurz.match(QUANT_TAIL)
  if (!m) return { head: kurz, tail: '' }
  return { head: kurz.slice(0, kurz.length - m[0].length), tail: m[0] }
}
