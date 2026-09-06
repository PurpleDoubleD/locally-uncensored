/**
 * Die Formsprache des Assistenten: zwei Knopf-Behandlungen und zwei Flaechen.
 *
 * Warum es dieses Modul gibt: nach der Zerlegung zeichnen FUENF Dateien
 * dieselben Knoepfe — die Schale (Willkommen, Fertig) und die vier Schritte.
 * Ein Rezept, das in fuenf Dateien je einmal dasteht, ist kein Rezept mehr,
 * sondern fuenf Rezepte, die heute noch zufaellig gleich aussehen. Genau
 * diesen Zerfall hat D-S36 in dieser Komponente vorgefunden: der Primaerknopf
 * hatte sein eigenes Graustufen-Paar, waehrend `.lu-primary` in `index.css`
 * schon lange danebenlag.
 *
 * Was hier NICHT steht: eine neue Farbe, ein neues Rezept, eine neue Zahl.
 * `primaryBtn` traegt `.lu-primary` aus `index.css` und legt nur die Geometrie
 * dazu, die dieser Bildschirm braucht. Die Sekundaerbehandlung bleibt
 * ausdruecklich sekundaer — sonst waere alles gleich laut, und der Assistent
 * haette wieder keinen Vorschlag.
 *
 * `isDark` faehrt hier mit, obwohl es keine Klasse ist: es ist die EINE
 * Entscheidung, aus der alle vier Zeichenketten fallen, und die Schritte
 * rechnen daraus noch ihre eigenen Zweige. Zweimal dasselbe aus dem Store zu
 * lesen waere zwei Abonnements fuer eine Frage.
 */

export interface OnboardingSkin {
  /** Dunkelmodus? Die Schritte leiten daraus ihre eigenen Zweige ab. */
  isDark: boolean
  /** Der Vollbild-Grund, auf dem der Assistent steht. */
  bgClass: string
  /** Die ruhige Karte: Installationsfortschritt, Modellkarte, nomic-Karte. */
  cardClass: string
  /** Die eine betonte Aktion eines Bildschirms. */
  primaryBtn: string
  /** Alles, was daneben steht: Re-Scan, Skip, „I already have …". */
  secondaryBtn: string
}

export function onboardingSkin(isDark: boolean): OnboardingSkin {
  const bgClass = isDark ? 'bg-[#202020] text-white' : 'bg-white text-gray-900'
  const cardClass = isDark ? 'bg-[#202020] border-white/[0.08]' : 'bg-gray-50 border-gray-200'

  // D-S36: `primaryBtn` war `bg-white text-black hover:bg-gray-200` (dunkel)
  // bzw. `bg-gray-900 text-white hover:bg-gray-800` (hell). Der Hover machte
  // den Knopf also DUNKLER als seinen Ruhezustand — im Screenshot des Audits
  // liest Schritt 2 deshalb als deaktiviert. Das Rezept dafuer existiert seit
  // f336b91e genau einmal, in index.css als `.lu-primary`, und rechnet seinen
  // Kontrast nach (#a094f8 auf #111827 = 6.83:1 in Ruhe, #b1a6ff auf #111827
  // = 8.25:1 im Hover — der Hover wird HELLER, nicht dunkler). Er hatte das
  // Onboarding nur nie erreicht; AUDIT-COVERAGE fuehrt das unter D-A8 als
  // ausdruecklichen Rest. Kein eigenes Rezept hier, sondern jenes.
  const primaryBtn = 'lu-primary mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] transition-all'
  const secondaryBtn = `mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] font-medium transition-colors ${
    isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
  }`

  return { isDark, bgClass, cardClass, primaryBtn, secondaryBtn }
}
