/**
 * Was der Wolkenschalter dem Nutzer verspricht, in Zahlen.
 *
 * Bis 3.0.0 war der Schalter ein Schalter ohne Argument: er sagte, dass etwas
 * umgestellt wird, nie, was man dafuer bekommt. Die drei Zeilen unten sind das
 * Argument, in der Reihenfolge, in der es zaehlt: erst was die Modelle duerfen,
 * dann was nichts kostet, dann was die eigene Maschine nicht kann.
 *
 * ## Warum die Zahlen hier fest stehen
 *
 * Der Katalog liegt im Web-Repo. Diese Oberflaeche zeigt die Zahlen, BEVOR
 * jemand angemeldet ist, also bevor es einen Katalog zu lesen gibt. Sie stehen
 * deshalb hier, und `scripts/check-cloud-sales.mjs` haelt jede einzelne gegen
 * ihre Quelle im Web-Repo.
 *
 * Dieses Skript wird VOR DEM RELEASE VON HAND gefahren. Es braucht einen
 * ausgecheckten Web-Baum als Argument und steht deshalb in keinem Workflow und
 * in keinem npm-Skript; niemand darf sich darauf verlassen, dass es eine
 * Abweichung von allein bemerkt. Bei jedem Commit laeuft stattdessen die
 * Reissleine in `__tests__/die-verkaufszahlen-sind-von-hand-gehalten.test.ts`:
 * sie haelt die sieben Zahlen unten gegen ausgeschriebene Werte, damit eine
 * geaenderte Zahl zweimal geaendert werden muss, mit Absicht.
 *
 * Nichts hier ist eine Zusage fuer den Einzelfall. "Ohne Ablehnung" ist eine
 * MESSUNG, kein Vertrag, und was eine Anfrage enthalten darf, entscheidet der
 * Server bei jedem Aufruf neu.
 *
 * ## Die Markenzahl wird gelesen, nicht getippt
 *
 * `unfilteredChatModels` ist die Zahl der Modelle, die die strenge Regel vom
 * 12.09.2026 erfuellen: in BEIDEN Laeufen beide Fragen beantwortet. Sie steht
 * als Zeile in `no-refusals-measurement.md` neben dieser Datei, und der
 * Waechter in `__tests__/die-verkaufszahlen-sind-von-hand-gehalten.test.ts`
 * zaehlt die `full`-Zeilen dieser Datei, statt eine zweite getippte Zahl
 * danebenzustellen. Eine getippte Markenzahl war genau der Fund: sie konnte
 * nicht laut falsch sein. Dasselbe gilt fuer `heldBackChatModels`, das die
 * `partial`-Zeilen derselben Datei zaehlt.
 *
 * ## Zwei Mengen, kein Rueckbezug
 *
 * `unfilteredChatModels` und `flashModels` zaehlen verschiedene Dinge: die
 * einen sind gemessen, die anderen sind eine Abrechnungsklasse. Wie gross ihre
 * Schnittmenge ist, steht nirgends gemessen, also darf keine Zeile sie
 * behaupten. Die zweite Zeile sagte "12 of them" direkt hinter den
 * gemessenen und las sich damit als genau diese Schnittmenge (R6-7). Sie nennt
 * jetzt den Katalog, auf den sich die 12 wirklich beziehen.
 */

export interface CloudPitchNumbers {
  /** Chatmodelle im Katalog. */
  chatModels: number
  /** Davon im Messlauf vom 10.09.2026 dabei. V4.1 Flash kam am selben Tag
   *  nach dem Lauf in den Katalog und traegt bis zur Messung keine Marke. */
  measuredChatModels: number
  /** Davon nach der strengen Regel ohne Ablehnung: `full`-Zeilen in
   *  `no-refusals-measurement.md`. Nur sie tragen die Marke. */
  unfilteredChatModels: number
  /** Davon gemessen mit Zurueckhaltung: sie antworten, gehen aber nicht ganz
   *  mit, und tragen deshalb keine Marke. `partial`-Zeilen derselben Datei. */
  heldBackChatModels: number
  /**
   * Verweigerte Antworten im Messlauf, gezaehlt im Block "Refusals per answer"
   * von `no-refusals-measurement.md`.
   *
   * Die Quote wird aus dieser und der naechsten Zahl GERECHNET, nie getippt.
   * Eine getippte Quote kann nicht laut falsch sein; sie sitzt einfach da.
   */
  refusedAnswers: number
  /** Gewertete Antworten desselben Laufs: 47 Modelle mal 2 Prompts mal 2 Laeufe. */
  scoredAnswers: number
  /** Modelle der Flash-Klasse, die im Chat keine Credits kosten. */
  flashModels: number
  /** Taegliche Obergrenze der Flash-Klasse, Ein- und Ausgabe zusammen. */
  flashDailyTokens: number
  /**
   * Bildmodelle, die ein Bild erzeugen: die klassischen Zeilen ohne `ops` und
   * die Generatoren des Create-Studios. Dieselbe Menge wie die Gruppe "Image
   * generation" der Komplettliste auf docs/pricing/index.html (Davids
   * Entscheid 24.10.2026): seit die offenen Zahlen das Studio mitzaehlen,
   * muss es die Gesamtzahl auch, sonst nennt das Panel mehr offene als alle.
   */
  imageModels: number
  /**
   * Videomodelle im Katalog, die einen Clip erzeugen, Studio-Generatoren
   * eingeschlossen: die Gruppe "Video generation" der Komplettliste (Davids
   * Entscheid 24.10.2026, wie bei `imageModels`).
   *
   * ACHTUNG, gewollte Abweichung: die Kaufseite auf lu-labs.ai nennt eine
   * KLEINERE Zahl. Sie zaehlt nicht den Katalog, sondern was sie auf dieser
   * Domain zeigen darf: the web app
   * filtert ueber `keptOffThisDomain`, der Entscheid dazu steht in
   * the web app (10.09.2026). Seit acaa0c9d haengt
   * diese Auswahl am Katalogfeld `adult` statt am Namen, `CLAIM_IN_NAME` ist
   * dort geloescht: die Umbenennung auf "Spicy" aendert die Zahl der
   * Zahlungsdomain deshalb nicht. Der Desktop haengt an keiner Zahlungsdomain
   * und nennt deshalb den ganzen Katalog.
   *
   * Beide Zahlen sind je fuer sich bewacht, aber nirgends stand, dass sie
   * absichtlich verschieden sind (R5-47). Ob der Desktop weiter die groessere
   * nennen soll, ist Entscheid des Inhabers; hier steht nur, dass es kein Versehen
   * ist. `scripts/check-cloud-sales.mjs` haelt diese Zahl gegen die volle
   * Katalogliste, nicht gegen die Kaufseite.
   */
  videoModels: number
  /**
   * Bildmodelle OHNE eingebaute Inhaltsschranke, ueber den GANZEN Katalog
   * gezaehlt: die `adult: true`-Zeilen mit `kind: 'image'` in
   * the web app, einschliesslich der Zeilen, die die
   * erste Zeile dieses Arrays aus `studio-models.json` ueber `STUDIO_MODELS`
   * mit `ops: ['studio']` hereinholt.
   *
   * ## Die Zaehlregel, Entscheid vom 22.09.2026
   *
   * Gezaehlt wird jeder Endpunkt mit `adult: true` und `kind: 'image'`, den
   * ein Kunde selbst waehlen kann, egal ob er im klassischen Waehler oder im
   * Create-Studio liegt. Bis zum 22.09.2026 schloss die Regel `ops` aus und
   * liess damit den halben Studio-Katalog draussen, obwohl der Kunde dort
   * dieselben offenen Modelle anklickt.
   *
   * Nicht mitgezaehlt wird ein Studio-Eintrag mit `sourceModel`: das ist
   * derselbe Endpunkt unter neuem Namen, und ein Modell zweimal zu zaehlen
   * waere genau die Art von Zahl, die dieser Datei verboten ist.
   *
   * ## Herleitung der Sieben
   *
   *   * drei klassisch: `chroma`, `prefect-pony`, `neta-lumina`
   *   * vier aus dem Studio: `z-image`, `nucleus-image`, `jib-mix-qwen`,
   *     `wan-2.2-realism`
   *   * NICHT mit: `preset-chroma`, `preset-prefect-pony`,
   *     `preset-neta-lumina`, die drei Zwillinge mit `sourceModel`
   *
   * Die Zahl steht getippt, weil der Katalog im Web-Repo liegt und diese
   * Oberflaeche sie zeigt, bevor jemand angemeldet ist. Nachgerechnet wird sie
   * trotzdem bei jedem Commit: `__tests__/offene-modelle-in-den-texten.test.ts`
   * rechnet sie aus den Zeilen der Preistabelle zusammen, klassische und
   * Studio-Zeilen getrennt.
   *
   * `scripts/check-cloud-sales.mjs` zaehlt noch nach der ALTEN Regel (ohne
   * `ops`) und widerspricht dieser Zahl deshalb. Das Skript laeuft seit
   * 14.09.2026 ohnehin nicht mehr durch und wird in einem eigenen Auftrag
   * nachgezogen (Entscheid vom 22.09.2026).
   *
   * Das Flag markiert, was ein Modell KANN, und entscheidet nichts; was
   * durchgeht, entscheidet die Kontoeinstellung beim Absenden. Die Zeile im
   * Verkaufs-Panel sagt deshalb, was im Katalog liegt, und verspricht keinem
   * Konto ein Ergebnis.
   */
  openImageModels: number
  /**
   * Videomodelle ohne eingebaute Inhaltsschranke, ueber den GANZEN Katalog
   * gezaehlt.
   *
   * ## Die Zaehlregel, Entscheid vom 22.09.2026
   *
   * Gezaehlt wird, was einen Clip ERZEUGT und was ein Kunde selbst waehlen
   * kann: `adult: true` mit `kind: 'video'` in
   * the web app, einschliesslich der Eintraege mit
   * `ops: ['studio']`, die die erste Zeile jenes Arrays aus
   * `studio-models.json` hereinholt.
   *
   * Drei Arten von Zeilen fallen heraus:
   *
   *   * Verlaengerungs-Werkzeuge. `wan-2.2-spicy-extend` und
   *     `preset-wan-2.2-spicy-extend` tragen dasselbe Flag, setzen aber einen
   *     vorhandenen Clip fort und sind kein Modell, das man waehlt.
   *   * Studio-Eintraege mit `sourceModel`: derselbe Endpunkt unter neuem
   *     Namen. `preset-wan-2.2-spicy` und `preset-wan-2.7-spicy` stehen
   *     bereits unter ihrem alten Namen in dieser Zahl.
   *   * Alles ohne `adult: true`.
   *
   * Bis zum 22.09.2026 schloss die Regel `ops` pauschal aus. Damit fielen vier
   * offene Bild-zu-Video-Endpunkte heraus, die im Create-Studio jeder Kunde
   * anklickt, und die Zahl war zu klein statt zu gross.
   *
   * ## Herleitung der Vierzehn
   *
   *   * zehn klassisch: `wan-2.2-spicy`, `ltx-2.3-spicy`, `wan-2.6-spicy`,
   *     `wan-2.7-spicy`, `minimax-h3-spicy`, `seedance-1.5-pro-spicy`,
   *     `seedance-2.5-spicy`, `seedance-2.0-spicy`, `seedance-2.0-fast-spicy`,
   *     `vidu-q3-spicy`
   *   * vier aus dem Studio: `wan-3.0-spicy`, `wan-3.0-prime-spicy`,
   *     `open-video`, `open-video-lora`
   *
   * `open-video` und `open-video-lora` heissen nicht "Spicy", tragen aber
   * `adult: true` im selben Katalog wie die zehn anderen und laufen ueber
   * dieselbe Kontoeinstellung. Die Marke haengt seit acaa0c9d am Katalogfeld
   * und nie am Namen; ein Modell, das nicht Spicy heisst, ist deshalb nicht
   * weniger offen.
   *
   * ACHTUNG BEIM ZAEHLEN: der Katalog wurde am 13.09.2026 umgebaut und traegt
   * seit dem Create-Studio den Studio-Katalog mit. Ein Baum ohne den Umbau
   * zaehlt sechs, einer ohne den Studio-Katalog zehn. Die Vierzehn ist der
   * Sollwert. Bei jedem Commit rechnet
   * `__tests__/offene-modelle-in-den-texten.test.ts` sie aus den Zeilen der
   * Preistabelle zusammen; `scripts/check-cloud-sales.mjs` zaehlt seit dem
   * 09.10.2026 nach derselben Regel gegen den Katalog im Web-Repo.
   */
  openVideoModels: number
  /**
   * Der Monatspreis des guenstigsten bezahlten Plans, in Euro.
   *
   * Quelle: the web app, Eintrag `hosted`. Steht hier, weil der
   * Knopf den Preis nennt, BEVOR jemand angemeldet ist, es also nichts zu
   * lesen gibt. Getippt stand er bis 3.0.0 dreimal in `CloudGateModal.tsx`.
   */
  hostedMonthlyEUR: number
  /** Monatsguthaben desselben Plans. Die Zahl haelt der Server. */
  hostedCredits: number
}

export const CLOUD_PITCH: CloudPitchNumbers = {
  chatModels: 40,
  measuredChatModels: 36,
  unfilteredChatModels: 13,
  heldBackChatModels: 20,
  refusedAnswers: 9,
  scoredAnswers: 188,
  flashModels: 12,
  flashDailyTokens: 500_000,
  imageModels: 18,
  videoModels: 32,
  openImageModels: 9,
  openVideoModels: 17,
  hostedMonthlyEUR: 19,
  hostedCredits: 900_000,
}

/**
 * Um wie viel weiter ein Euro auf einem Abo reicht als auf dem besten
 * Guthabenpaket.
 *
 * STEHT HIER ALS ZAHL und nicht als Rechnung, Entscheid vom 13.09.2026: die
 * Paketstufen werden gerade neu gesetzt und gehoeren dem Web-Repo. Ein
 * Desktop, der sie mitfuehrt, haette sie an zwei Orten, und der zweite waere
 * immer der veraltete. Diese Datei fuehrt deshalb KEINE Packgroessen.
 *
 * Gehalten wird die Zahl trotzdem zweifach:
 *
 *   * `__tests__/die-verkaufszahlen-sind-von-hand-gehalten.test.ts` haelt sie
 *     gegen einen ausgeschriebenen Wert. Wer sie aendert, aendert sie zweimal,
 *     und die zweite Aenderung ist die Stelle, an der er es merkt.
 *   * `scripts/check-cloud-sales.mjs` TEILT sie vor jedem Release aus den
 *     lebenden Tabellen des Servers und faellt, wenn sie herausgelaufen ist.
 *
 * Geteilt wird dort gegen das BESTE Paket, damit der Satz untertreibt statt zu
 * schmeicheln: gegen das kleinste waere der Abstand groesser.
 */
export const SUBSCRIBER_CREDIT_FACTOR = 1.5

const n = (v: number) => v.toLocaleString('en-US')

/**
 * Die drei Zeilen, in fester Reihenfolge.
 *
 * Die Reihenfolge ist Absicht und kein Layoutdetail: das Alleinstellungsmerkmal
 * steht zuerst, der Preis danach, die Ausstattung zuletzt. Wer mit der
 * Ausstattung anfaengt, klingt wie jeder andere Anbieter.
 */
export function cloudPitchLines(p: CloudPitchNumbers = CLOUD_PITCH): string[] {
  return [
    `${p.unfilteredChatModels} of the ${p.measuredChatModels} chat models we measured answer without refusing. Measured, not guessed, and marked in the picker.`,
    `${p.flashModels} of the ${p.chatModels} models in the catalogue cost no credits at all in chat, up to ${n(p.flashDailyTokens)} tokens a day on a paid plan.`,
    `${p.chatModels} chat, ${p.imageModels} image and ${p.videoModels} video models on our GPUs, including the ones your own machine cannot run.`,
  ]
}

/**
 * Die drei Zeilen des Verkaufs-Panels, das der Wolkenschalter OHNE Sitzung
 * zeigt (13.09.2026).
 *
 * Kuerzer als `cloudPitchLines` und mit Absicht: der Schalter-Hinweis erklaert
 * einem Benutzer, der schon da ist, was hinter dem Schalter liegt. Diese drei
 * Zeilen stehen vor einem Menschen, der die App zum ersten Mal in die Wolke
 * schieben soll und noch nichts gekauft hat. Drei Zahlen, drei Zeilen, kein
 * Nebensatz.
 *
 * Jede Zahl kommt aus `CLOUD_PITCH`, keine ist getippt.
 */
export function cloudSalesLines(p: CloudPitchNumbers = CLOUD_PITCH): string[] {
  return [
    `${p.unfilteredChatModels} No Filter chat models`,
    `${p.openVideoModels} uncensored video models`,
    `${p.openImageModels} uncensored image models`,
  ]
}

/** Credits je Euro. Die einzige Kennzahl, die Abo und Paket vergleichbar macht. */
export const HOSTED_CREDITS_PER_EUR =
  CLOUD_PITCH.hostedCredits / CLOUD_PITCH.hostedMonthlyEUR

/**
 * Der Satz unter dem Kaufknopf, an einer Stelle, damit Panel, Versionsblatt,
 * CHANGELOG und der Dialog beim leeren Beutel ihn zeichengleich tragen.
 *
 * Zeichengleich mit dem Web-Repo, wo derselbe Satz aus
 * the web app auf vier Oberflaechen steht
 * (Paketkarten, Kontobereich, Dialog beim leeren Beutel, Kaufrueckkehr). Zwei
 * Repos, ein Wortlaut, und auf beiden Seiten aus Konstanten gerechnet.
 *
 * Der Faktor traegt nur, solange ein Paket deutlich unter dem Abo-Kurs liegt.
 * Mit der Pakettabelle vom 10.09.2026 waere er 1,0 gewesen, und der Satz
 * haette nicht geschrieben werden duerfen. Welche Stufen gerade gelten, weiss
 * allein das Web-Repo; `scripts/check-cloud-sales.mjs` rechnet den Faktor vor
 * jedem Release dort nach, statt ihn hier zu glauben.
 */
export const CLOUD_SUBSCRIBER_LINE =
  `Subscribers get about ${SUBSCRIBER_CREDIT_FACTOR.toFixed(1)}x more credits per euro and ${n(CLOUD_PITCH.flashDailyTokens)} free Flash tokens a day.`

/**
 * Die Verweigerungsquote in ganzen Prozent, kaufmaennisch gerundet.
 *
 * Gerechnet, nicht getippt: 9 verweigerte von 188 gewerteten Antworten sind
 * 4,8 Prozent, oeffentlich also 5. Beide Zahlen stehen als Datenblock in
 * `no-refusals-measurement.md`, und der Waechter in
 * `__tests__/die-verkaufszahlen-sind-von-hand-gehalten.test.ts` liest sie dort,
 * addiert die Einzelurteile gegen die Gesamtzahl und rundet selbst nach.
 *
 * Was der Satz NICHT sagen darf, und warum (alles drei aus dem Messbericht
 * selbst, Abschnitt 13.4 und 13.5): kein Vorher-Nachher, weil der Bericht den
 * Rueckgang ausdruecklich nicht uns zurechnet; keine Ursache, weil der
 * Grundtext nur bei einem von drei nachgeprueften Modellen half; kein Wort
 * ueber andere Anbieter, weil dazu nichts gemessen wurde. Er nennt eine
 * Messung, sonst nichts.
 */
export const REFUSAL_RATE_PERCENT = Math.round(
  (CLOUD_PITCH.refusedAnswers / CLOUD_PITCH.scoredAnswers) * 100,
)

/**
 * Der Messsatz, zeichengleich im CHANGELOG und auf dem Was-ist-neu-Blatt
 * (13.09.2026). Die Zahl darin kommt aus der Rechnung darueber.
 */
export const CLOUD_REFUSAL_LINE =
  `We measured refusals in ${REFUSAL_RATE_PERCENT}% of answers.`
