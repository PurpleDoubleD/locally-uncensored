/**
 * Der Request-Körper der `/local-api`-Endpunkte des Dev-Servers — Dekodierung
 * und Feldzugriff an der Grenze.
 *
 * Warum das eine eigene Datei ist: `vite.config.ts` hat diesen Block
 * zwanzigmal wortgleich stehen —
 *
 *     let body = ''
 *     req.on('data', (c) => { body += c })
 *     req.on('end', () => { const { path } = JSON.parse(body) ... })
 *
 * — und darin stecken zwei Fehler, die zwanzigmal mitkopiert wurden:
 *
 *  1. `body += c` dekodiert JEDEN Chunk einzeln nach UTF-8. Ein Zeichen, das
 *     über eine Chunk-Grenze fällt (Node schneidet bei ~64 KiB, mitten im
 *     Zeichen), wird zweimal halb dekodiert und kommt als U+FFFD an. Für
 *     `/local-api/file-write` heisst das: die Datei auf der Platte bekommt
 *     kaputte Zeichen, sobald der Inhalt gross genug ist. `decodeBodyChunks`
 *     dekodiert stattdessen EINMAL über die zusammengesetzten Bytes.
 *
 *  2. `JSON.parse(body)` ohne `try` in einem `end`-Handler. Der Handler läuft
 *     lange nachdem die Middleware zurückgekehrt ist; niemand fängt den
 *     Wurf mehr ab, und ein einziger POST mit kaputtem Körper beendet den
 *     ganzen `npm run dev`-Prozess. `parseJsonBody` gibt ein Ergebnis zurück
 *     statt zu werfen, damit es keinen Aufrufer mehr gibt, der es vergessen
 *     kann.
 *
 * Fremde Daten → `unknown` plus Prüfung an der Grenze: der geparste Körper
 * verlässt dieses Modul als `unknown`, und die Feldleser darunter sind dünne
 * Hüllen um `src/types/json-guards.ts` — kein zweiter Werkzeugkasten, nur die
 * beiden Bequemlichkeiten (Feldname statt Wert, Alias-Namen), die die
 * Endpunkte tatsächlich brauchen.
 *
 * REINE STRINGS UND BYTES, ABSICHTLICH: kein `node:*`-Import. Das App-tsconfig
 * kennt keine Node-Typen, und ein Helfer, der sie bräuchte, könnte nicht in
 * `src` neben seinem Test liegen — dieselbe Regel, unter der schon
 * `src/lib/dev-fs-jail.ts` steht. `Uint8Array` reicht: ein Node-`Buffer` IST
 * ein `Uint8Array`.
 */

import { asNumber, asString, isRecord, prop } from '../types/json-guards'

/**
 * Die Chunks eines Requests zu einem String — EINE Dekodierung über alles.
 *
 * Genau das ist der Unterschied zu `body += chunk`: ein `TextDecoder` über
 * die Gesamtbytes sieht ein mehrbyte-Zeichen auch dann, wenn es in zwei
 * Chunks zerfällt.
 */
export function decodeBodyChunks(chunks: readonly Uint8Array[]): string {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/** Was `parseJsonBody` zurückgibt — nie ein Wurf, immer ein Ergebnis. */
export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/**
 * `JSON.parse` als Ergebnis statt als Wurf.
 *
 * Ein leerer Körper ist kein JSON und wird auch nicht so behandelt: die
 * Endpunkte, die ohne Felder auskommen, bekommen `undefined` als Wert und
 * kommen damit durch ihre eigenen Pflichtfeld-Prüfungen.
 */
export function parseJsonBody(raw: string): JsonBodyResult {
  if (raw.trim() === '') return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Ein String-Feld des Körpers, oder `undefined`. Nichts wird gecastet. */
export function bodyString(body: unknown, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(prop(body, key))
    if (value !== undefined) return value
  }
  return undefined
}

/** Ein endliches Zahlenfeld des Körpers, oder `undefined`. */
export function bodyNumber(body: unknown, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(prop(body, key))
    if (value !== undefined) return value
  }
  return undefined
}

/** Ein Wahrheitsfeld des Körpers — alles Nicht-Boolesche gilt als `false`. */
export function bodyFlag(body: unknown, key: string): boolean {
  return prop(body, key) === true
}

/**
 * Ein Feld, dessen Wert selbst wieder eine Liste von Objekten ist —
 * `/local-api/check-model-sizes` bekommt so seine Dateiliste. Alles, was kein
 * Objekt ist, fällt heraus statt den Aufrufer zu überraschen.
 */
export function bodyRecords(body: unknown, key: string): Record<string, unknown>[] {
  const value = prop(body, key)
  return Array.isArray(value) ? value.filter(isRecord) : []
}
