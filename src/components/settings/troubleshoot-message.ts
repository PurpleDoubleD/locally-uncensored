// Was die Troubleshoot-Seite sagt, wenn die Sonde selbst nicht laeuft.
//
// Eine Persona oeffnete am 03.09.2026 die Seite, die ihr sagen soll, was mit
// ihrer Installation los ist, und las dort:
//
//     system_health failed: Unknown backend command: system_health
//
// Sie schloss daraus, die App sei kaputt. Beides war falsch: der Befehl ist in
// `main.rs` registriert und laeuft in der Desktop-App; sie sass in der reinen
// Browser-Oberflaeche des Dev-Servers, die keinen Rust-Prozess hinter sich hat.
// Der Text hat ihr einen internen Befehlsnamen gezeigt statt einer Auskunft —
// ausgerechnet auf der Seite, deren einzige Aufgabe Auskunft ist.
//
// Deshalb steht die Formulierung hier als reine Funktion und nicht inline im
// JSX: so laesst sie sich pruefen, ohne die ganze Settings-Seite zu rendern.

export interface TroubleshootHinweis {
  /**
   * 'grenze' = diese Oberflaeche kann es nicht, und das ist in Ordnung.
   * 'fehler' = etwas ist wirklich schiefgegangen.
   * Die Seite faerbt danach: ein roter Kasten fuer eine Grenze ist selbst
   * schon eine Falschaussage.
   */
  art: 'grenze' | 'fehler'
  /** Der Satz, der gross dasteht. Ohne Befehlsnamen, ohne Fehlerklasse. */
  titel: string
  /** Die technische Zeile darunter, oder null wenn sie nichts erklaert. */
  detail: string | null
}

/** Erkennt genau den Fall „dieser Befehl existiert auf dieser Oberflaeche nicht". */
function befehlFehlt(text: string): boolean {
  return /unknown backend command/i.test(text)
}

/**
 * @param fehler  Was `backendCall('system_health')` geworfen hat.
 * @param imDesktop  `isTauri()` — laeuft die App in ihrer eigenen Huelle?
 */
export function troubleshootHinweis(fehler: unknown, imDesktop: boolean): TroubleshootHinweis {
  const text = fehler instanceof Error ? fehler.message : String(fehler)

  // Browser-Oberflaeche: kein Fehler, sondern eine Grenze. Sie zu benennen ist
  // die Auskunft — der Befehlsname darunter waere nur Rauschen.
  if (!imDesktop && befehlFehlt(text)) {
    return {
      art: 'grenze',
      titel: 'The diagnostics probe only runs in the desktop app. Nothing is wrong with this browser tab — it has no local backend behind it.',
      detail: null,
    }
  }

  // In der Desktop-App bedeutet derselbe Text etwas ganz anderes: die Huelle
  // laeuft, kennt den Befehl aber nicht. Das ist eine veraltete Installation.
  if (befehlFehlt(text)) {
    return {
      art: 'fehler',
      titel: 'This version of the app cannot run the diagnostics probe. Updating usually fixes it.',
      detail: text,
    }
  }

  return {
    art: 'fehler',
    titel: 'The diagnostics probe could not finish.',
    detail: text || null,
  }
}
