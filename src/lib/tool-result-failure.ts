// Hat dieser Werkzeugaufruf wirklich getan, was er sagt?
//
// Werkzeuge geben `Promise<string>` zurueck; einen Fehlerkanal gibt es nicht.
// Wer nicht wirft, gilt als erfolgreich — und ein Werkzeug, das seinen Fehler
// als Text zurueckgibt, wirft nicht. Die Schrittliste zeigt dann einen gruenen
// Haken mit Laufzeit ueber einer Antwort, in der „failed" steht.
//
// Ein Testlauf am 03.09.2026 hat den Preis dafuer aufgeschrieben: dreimal
// `web_search ✓`, dreimal `{"results":[],"error":"All search tiers failed"}`,
// und am Ende eine Vergleichstabelle mit erfundenen Paragraphen und Fristen.
// Das Modell hatte den Fehlertext gelesen und trotzdem geraten — der Kunde
// hatte drei Haken und keinen Grund zu zweifeln.
//
// Fuer die Medien-Werkzeuge hat dieses Haus dasselbe schon einmal geloest
// (`media-result.ts`, D#81 — „it bugs out and not send an image, and it change
// the entire context"). Nur eben nur fuer die. Das hier ist dieselbe Idee fuer
// alle uebrigen.
//
// ── WARUM AM ANFANG UND NIRGENDWO SONST ────────────────────────────────────
//
// Erkannt wird ausschliesslich, was WIR selbst ausgeben, und nur ganz vorn.
// Das ist kein Geiz, sondern der Unterschied zwischen einer Sperre und einem
// Fehlalarm: ein Suchtreffer darf sehr wohl „The mission failed: a
// retrospective" enthalten, aber keine unserer Antworten BEGINNT so. Alles
// Unbekannte gilt als Erfolg. Ein Waechter, der einen echten Treffer rot
// faerbt, ist schlimmer als der Fehler, den er verhindern soll — er wird
// abgeschaltet, und dann faengt gar nichts mehr.

/**
 * Die Formen, in denen `builtin-tools.ts` und `tool-registry.ts` scheitern.
 * `ein-haken-heisst-es-hat-geklappt.test.ts` liest die Quelle und laesst diese
 * Liste rot werden, sobald ein Werkzeug eine neue Form erfindet.
 */
const FEHLERFORM = new RegExp(
  '^\\s*(' +
    // `Error: …` und `Error (1): …` — der Rueckfall von tool-registry.execute
    // und die Haelfte aller Werkzeuge.
    'Error\\s*[:(]' +
    // `Refused: this turn is read-only …`
    '|Refused:' +
    // `Web search failed:` · `Image generation failed:` · `git_commit failed (exit 1)`
    '|[A-Za-z][\\w .\'"-]{0,40}\\bfailed\\b\\s*[:(]' +
    // `run_tests: could not detect …` · `pr_resume: unparseable gh output …`
    '|[\\w_]+:\\s*(could not|unparseable)\\b' +
  ')',
  'i',
)

/** True, wenn diese Werkzeugantwort ein Fehlschlag in Textform ist. */
export function toolResultIsFailure(result: string | null | undefined): boolean {
  if (!result) return false // kein Ergebnis ist eine andere Frage als ein falsches
  return FEHLERFORM.test(result)
}
