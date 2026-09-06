/**
 * Die Ansage "der geteilte lokale Steckplatz hat den Halter gewechselt", und
 * wer darauf hoert.
 *
 * Audit W-T2, zweite Runde. lib/builtin-slot-eviction.ts hat sich die drei
 * Module, die auf einen Steckplatzwechsel reagieren muessen, mit
 * `await import(...)` selbst geholt, mit derselben Begruendung wie damals der
 * providerStore: ein fester Import waere ein Ladekreis. Die Begruendung stimmte
 * wieder, die Aufloesung wieder nicht. `npm run cycles` (ci.yml:78) zaehlt
 * dynamische Kanten mit und meldete am 04.09.2026 fuenf Kreise, alle ueber
 * diese Datei:
 *
 *   builtin-ensure > providerStore > builtin-slot-eviction
 *   lu-engine-switch > providers > openai-provider > builtin-ensure >
 *     providerStore > builtin-slot-eviction
 *   builtin-ensure > providerStore > builtin-slot-eviction > modelStore >
 *     engine
 *   providerStore > builtin-slot-eviction > modelStore > engine
 *   providerStore > builtin-slot-eviction > modelStore > chatStore >
 *     remoteStore
 *
 * Nachgemessen an einer bereinigten Kopie: ohne diese drei Kanten meldet madge
 * "No circular dependency found". Es haengt an ihnen und an nichts sonst.
 *
 * EIN Ereignis, drei Stationen. Der Steckplatz wechselt den Halter, und das
 * weiss nur die Regel in builtin-slot-eviction. Die Wahl im Waehler faellt oder
 * die Engine kommt zurueck, und das kann nur der Modell-Store. Der Nutzer
 * erfaehrt es, und das darf nur api/lu-engine-switch, wo der Satz und die Frist
 * auf den Leser stehen. Keine der drei Stationen darf die naechste importieren,
 * ohne einen Kreis zu schliessen, also liegt die Leitung hier, gehoert keiner
 * von ihnen und hat selbst KEINE einzige Laufzeitkante. Ein Leitungsmodul, das
 * seinerseits irgendwohin zeigt, verschiebt den Kreis nur.
 *
 * WER SICH ANMELDET:
 *   `onBuiltinSlotRegained` und `onBuiltinSlotLostToForeignBackend`
 *      stores/modelStore.ts, beim Laden des Moduls, wie
 *      `onProviderSlotsDarkened` gleich daneben.
 *   `onChatPickLostItsEngine`
 *      api/lu-engine-switch.ts, beim Laden des Moduls.
 *
 * DER PREIS, derselbe, den lib/run-lane-of-model.ts ungeschoent nennt: wer die
 * Anmeldung vergisst, bekommt keine Fehlermeldung, sondern lautlos nichts. Fuer
 * den Modell-Store ist das gedeckt, er ist in beiden Webviews eager geladen,
 * bevor ein Steckplatz sich bewegen kann. Fuer die Wechselzeile nicht: siehe
 * die Anmeldung in api/lu-engine-switch.ts.
 */

/** Der Steckplatz gehoert wieder der eigenen Engine, und sie war schon frei. */
type SlotRegainedListener = () => void
/** Ein eingeschaltetes fremdes Backend hat den Steckplatz uebernommen. */
type SlotLostListener = (taker: string | undefined) => void
/** Eine Wahl ist mit dem Steckplatz gefallen, und der Nutzer weiss es noch nicht. */
type PickLostListener = (gone: string, taker: string | undefined) => void

/**
 * Genau ein Platz je Ansage. Es gibt genau einen Modell-Store und genau eine
 * Wechselzeile; eine Liste wuerde nur verdecken, wenn sich versehentlich
 * zweimal jemand anmeldet, und bei mehreren Zuhoerern an derselben Ansage waere
 * ihre Reihenfolge lasttragend: wer den alten Namen lesen will, muesste vor
 * dem lesen, der ihn raeumt.
 */
let regained: SlotRegainedListener | null = null
let lost: SlotLostListener | null = null
let pickLost: PickLostListener | null = null

/**
 * Zustellen, eine Mikrotask spaeter.
 *
 * Nicht Nebenwirkung, sondern Vertrag. Der frueher hier stehende
 * `await import(...)` kostete dieselbe Mikrotask, und daran haengt Verhalten:
 * `useModels.activateModel` gibt den Steckplatz ab und setzt die Zeile des
 * uebernehmenden Backends ohne `await` unmittelbar danach. Wer synchron
 * zustellt, liest dort noch die alte Zeile und raeumt eine Wahl, die stehen
 * bleiben muss. Ausserdem soll ein Schreiben im Modell-Store nicht mitten in
 * der laufenden `set()`-Runde des providerStore passieren.
 */
function zustellen(fn: (() => void) | null): void {
  if (!fn) return
  void Promise.resolve().then(() => {
    try {
      fn()
    } catch {
      // Der Steckplatzwechsel selbst darf daran nicht scheitern. Die naechste
      // Inventarrunde prueft die Wahl ohnehin erneut, und der Absendeweg
      // versucht die Engine erneut, sobald jemand etwas schreibt.
    }
  })
}

/** Anmelden. Der Modell-Store tut das beim Laden. */
export function onBuiltinSlotRegained(fn: SlotRegainedListener): void {
  regained = fn
}

/** Anmelden. Der Modell-Store tut das beim Laden. */
export function onBuiltinSlotLostToForeignBackend(fn: SlotLostListener): void {
  lost = fn
}

/** Anmelden. api/lu-engine-switch tut das beim Laden. */
export function onChatPickLostItsEngine(fn: PickLostListener): void {
  pickLost = fn
}

/**
 * Die Engine hat den Steckplatz zurueck, nachdem sie ihr Modell schon
 * losgelassen hatte.
 *
 * Ohne Nutzlast: welche Wahl zurueckzuholen ist, weiss der Modell-Store selbst,
 * und er weiss es zum Zustellzeitpunkt genauer als der Ansagende eine Mikrotask
 * vorher.
 */
export function announceBuiltinSlotRegained(): void {
  const fn = regained
  zustellen(fn ? () => fn() : null)
}

/**
 * Ein fremdes Backend haelt den Steckplatz jetzt.
 *
 * Der Anzeigename ist das einzige, was mitgereicht wird, und er ist eine
 * Momentaufnahme mit Absicht: gemeint ist der, der uebernommen hat, nicht der,
 * der eine Mikrotask spaeter zufaellig drinsteht.
 */
export function announceBuiltinSlotLostToForeignBackend(taker: string | undefined): void {
  const fn = lost
  zustellen(fn ? () => fn(taker) : null)
}

/**
 * Die Wahl ist gefallen, und der alte Name ist gleich niemandem mehr bekannt.
 *
 * Angesagt vom Modell-Store, unmittelbar nachdem er geraeumt hat. Nur er hat
 * den Namen noch, und sagen darf ihn nur, wer die Frist auf den Leser kennt.
 */
export function announceChatPickLostItsEngine(gone: string, taker: string | undefined): void {
  const fn = pickLost
  zustellen(fn ? () => fn(gone, taker) : null)
}
