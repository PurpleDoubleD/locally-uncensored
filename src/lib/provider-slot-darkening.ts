/**
 * Die Ansage "diese Backend-Slots sind gerade abgeschaltet worden" — und wer
 * darauf hört.
 *
 * Der providerStore weiß, wann ein Slot dunkel wird; der modelStore muss dann
 * eine Modellwahl räumen, die von diesem Slot bedient wurde (sonst bietet der
 * Composer weiter ein Modell an, dessen Backend aus ist, und jedes Senden
 * scheitert mit model-not-found). Die fachliche Regel steht unverändert in
 * beiden Stores; hier steht nur die Leitung dazwischen.
 *
 * Audit W-T2: providerStore.ts hat sich den modelStore dafür mit
 * `void import('./modelStore')` selbst geholt, mit dem Kommentar "a static edge
 * would close that circle at module-init time". Der Kreis war echt
 * (providerStore → modelStore → engine → providerStore, und ein zweites Mal
 * über chatStore → remoteStore), der dynamische Import hat ihn nur unsichtbar
 * gemacht statt aufgelöst.
 *
 * Zwei Zustandsspeicher, die sich gegenseitig lesen, sind kein Grund für einen
 * versteckten Import: der eine sagt an, der andere hört zu, und die Ansage
 * gehört keinem von beiden. Dieselbe Bauform, die dieses Repo mit
 * `onLocalSlotChanged` (lib/builtin-slot-eviction.ts) für die
 * Speicher-Freigabe schon benutzt, und dieselbe Umkehr wie `setRetiredRunner`
 * in api/mcp/tool-registry.ts.
 */

import type { ProviderId } from '../api/providers/types'

type DarkenedSlotsListener = (darkened: readonly ProviderId[]) => void

/**
 * Genau ein Zuhörer. Es gibt genau einen Modell-Store; eine Liste würde nur
 * verdecken, wenn sich versehentlich zweimal jemand anmeldet.
 */
let listener: DarkenedSlotsListener | null = null

/** Anmelden. Der modelStore tut das beim Laden. */
export function onProviderSlotsDarkened(fn: DarkenedSlotsListener): void {
  listener = fn
}

/**
 * Ansagen. Ohne Zuhörer passiert nichts — genauso wie der frühere dynamische
 * Import mit `.catch(() => {})` endete: die nächste Inventar-Aktualisierung
 * prüft die Wahl ohnehin erneut.
 *
 * Die Zustellung ist nachgelagert, weil der frühere `import()` es auch war: der
 * Aufruf lief hinter der laufenden `set()`-Runde des providerStore, und dabei
 * bleibt es — ein Schreiben im Modell-Store soll nicht mitten im Schreiben des
 * Provider-Stores passieren.
 */
export function announceDarkenedSlots(darkened: readonly ProviderId[]): void {
  if (darkened.length === 0) return
  const fn = listener
  if (!fn) return
  void Promise.resolve().then(() => {
    try {
      fn(darkened)
    } catch { /* best-effort: the next inventory refresh re-checks */ }
  })
}

/** Test-only: die Anmeldung vergessen, damit Tests isoliert bleiben. */
export function __resetProviderSlotDarkeningForTests(): void {
  listener = null
}
