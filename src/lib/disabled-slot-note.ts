/**
 * Was unter einem abgeschalteten Anbieter steht.
 *
 * Es stand dort ein Satz fuer alle: "Switched off, so its models are not
 * offered in the chat model picker." Fuer jeden fremden Anbieter stimmt er,
 * `getEnabledProviders` laesst dessen Modelle aus der Liste fallen.
 *
 * Fuer unsere eigene Engine stimmt er nicht. Ihre Zeilen kommen nicht von
 * `/v1/models`, sondern aus dem Ordner mit den GGUF-Dateien, und der wird
 * gelesen, egal ob der Steckplatz an ist. Die Nachpruefung G3 hat das am
 * 04.09.2026 gesehen: abgeschaltet, und der Waehler bot weiter alle fuenf an.
 *
 * Die Zeilen stehen zu lassen ist richtig, denn ein Klick darauf holt den
 * Steckplatz zurueck und sagt es auch. Falsch war nur, das Gegenteil zu
 * behaupten.
 */
export function disabledSlotNote(managed: boolean): string {
  return managed
    ? 'Switched off. Its models stay in the chat model picker, and picking one switches it back on for the chat. Press Enable to switch it on without picking a model.'
    : 'Switched off, so its models are not offered in the chat model picker. Press Enable to use it again.'
}
