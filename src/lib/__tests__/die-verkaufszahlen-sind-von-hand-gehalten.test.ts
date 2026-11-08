/**
 * Die Reissleine unter `CLOUD_PITCH`.
 *
 * R2-46: zwei Kommentare versprachen eine Automatik, die es nicht gibt.
 * `scripts/check-cloud-sales.mjs` haelt die sieben Zahlen gegen den Katalog im
 * Web-Repo, steht aber in keinem Workflow, in keiner `ci.yml` und in keinem
 * npm-Skript, weil es einen zweiten Checkout als Argument braucht. Es wird vor
 * einem Release von Hand gefahren, und ob es ins CI kommt, ist Entscheid des Inhabers.
 *
 * Bis dahin haelt diese Datei die Stelle: dasselbe Muster wie die Reissleine
 * unter den Preisen (`pricing-page.test.ts`). Die Werte sind ausgeschrieben,
 * nicht aus der Konstante gelesen; eine Reissleine, die ihre Quelle liest,
 * reisst nie. Wer eine Zahl aendert, aendert sie zweimal, und die zweite
 * Aenderung ist die Stelle, an der er merkt, dass die andere Seite mitgehoert.
 *
 * Stand 3.0.0: 47 im Katalog, 46 im Messlauf.
 *
 * ZWEI der Zahlen stehen NICHT hier, und das ist Absicht (Entscheid vom
 * 12.09.2026). `unfilteredChatModels` und `heldBackChatModels` haengen an der
 * strengen Regel, und deren Ergebnis liegt als Tabelle in
 * `src/lib/no-refusals-measurement.md`. Eine ausgeschriebene Markenzahl waere
 * genau der Fehler, den dieser Waechter verhindern soll: sie kann nicht laut
 * falsch sein, weil sie nur sich selbst bestaetigt. Der Waechter zaehlt
 * stattdessen die Zeilen der Messdatei. Wer die Marke verschieben will,
 * aendert die Messung, nicht die Zahl.
 *
 * Run: npx vitest run src/lib/__tests__/die-verkaufszahlen-sind-von-hand-gehalten.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CLOUD_PITCH,
  CLOUD_REFUSAL_LINE,
  REFUSAL_RATE_PERCENT,
  SUBSCRIBER_CREDIT_FACTOR,
} from '../cloud-pitch'

/**
 * Die sechs von Hand gehaltenen Felder, ausgeschrieben. Die zwei aus der
 * Messdatei stehen darunter. Ein neues Feld gehoert in eine der beiden Listen,
 * sonst faellt es durch.
 */
const ERWARTET = {
  chatModels: 40,
  measuredChatModels: 36,
  flashModels: 12,
  flashDailyTokens: 500_000,
  imageModels: 18,
  videoModels: 32,
  // 13.09.2026, Verkaufs-Panel: die zwei Teilmengen ohne eingebaute
  // Inhaltsschranke (`adult: true` im Medienkatalog des Web-Repos) und die
  // zwei Zahlen des Einstiegsabos, die der Kaufknopf und der Abo-Satz nennen.
  //
  // Gezaehlt wird, was ERZEUGT und was ein Kunde selbst waehlt: `adult: true`
  // mit passender `kind`, quer durch den ganzen Katalog. Seit dem Entscheid
  // vom 22.09.2026 zaehlen die Studio-Eintraege (`ops: ['studio']`) mit, denn
  // der Kunde klickt sie im Create-Studio genauso an. Heraus fallen weiter die
  // Verlaengerungs-Werkzeuge, die einen vorhandenen Clip fortsetzen, und die
  // Studio-Zwillinge mit `sourceModel`, die denselben Endpunkt ein zweites Mal
  // fuehren.
  //
  // Herleitung: zehn klassische Videomodelle plus wan-3.0-spicy,
  // wan-3.0-prime-spicy, open-video und open-video-lora sind vierzehn; drei
  // klassische Bildmodelle plus z-image, nucleus-image, jib-mix-qwen und
  // wan-2.2-realism sind sieben. Die Herleitung selbst rechnet
  // `offene-modelle-in-den-texten.test.ts` gegen die Preisseite nach.
  //
  // Ein Baum, der den Katalogumbau vom 13.09.2026 nicht hat, zaehlt sechs;
  // einer ohne den Create-Studio-Katalog zehn.
  openImageModels: 9,
  openVideoModels: 17,
  hostedMonthlyEUR: 19,
  hostedCredits: 900_000,
} as const

/**
 * Der Abo-Faktor, ausgeschrieben wie die Zahlen darueber.
 *
 * Er steht nicht in `CLOUD_PITCH`, also faellt er nicht unter die
 * Feldpruefung unten und braucht seine eigene Zeile. Die Packstufen, aus
 * denen er sich ergibt, fuehrt der Desktop bewusst NICHT: sie gehoeren dem
 * Web-Repo, und `scripts/check-cloud-sales.mjs` teilt den Faktor vor jedem
 * Release dort nach.
 */
const ERWARTETER_ABO_FAKTOR = 1.5

/** Die Felder, deren Wert aus der Messdatei gezaehlt wird statt hier zu stehen. */
const AUS_DER_MESSDATEI = [
  'unfilteredChatModels',
  'heldBackChatModels',
  'refusedAnswers',
  'scoredAnswers',
] as const

/**
 * Die Zeilen der Messtabelle, eine je Modell.
 *
 * Kopf- und Trennzeile fallen heraus, weil ihre letzte Spalte keine Marke
 * traegt. Eine zerschossene Datei liefert damit null Zeilen, und die Erwartung
 * unten faellt darauf sofort durch.
 */
function messzeilen(): { id: string; marke: string }[] {
  const datei = readFileSync(resolve(__dirname, '..', 'no-refusals-measurement.md'), 'utf8')
  return datei.split('\n')
    .map(zeile => zeile.split('|').map(feld => feld.trim()))
    .filter(felder => felder.length === 6 && felder[0] === '' && ['full', 'partial', 'none'].includes(felder[4]))
    .map(felder => ({ id: felder[1], marke: felder[4] }))
}

describe('die Zahlen des Wolkentors', () => {
  it('stehen auf dem Stand, den jemand von Hand gesetzt hat', () => {
    for (const [feld, wert] of Object.entries(ERWARTET)) {
      expect(CLOUD_PITCH[feld as keyof typeof ERWARTET], feld).toBe(wert)
    }
  })

  it('und kein Feld entkommt der Reissleine', () => {
    // Sonst waechst die Konstante um eine ungehaltene Zahl, und der Waechter
    // darueber meldet weiter alles in Ordnung. Wer ein Feld anlegt, schreibt
    // seinen Wert oben als eigene Zeile dazu.
    const ungehalten = Object.keys(CLOUD_PITCH).filter((k) => !(k in ERWARTET) && !AUS_DER_MESSDATEI.includes(k as typeof AUS_DER_MESSDATEI[number]))
    expect(ungehalten, `neues Feld in CLOUD_PITCH, gehoert als Zeile nach ERWARTET: ${ungehalten.join(', ')}`)
      .toEqual([])
    const verschwunden = Object.keys(ERWARTET).filter((k) => !(k in CLOUD_PITCH))
    expect(verschwunden, `Feld weg, die Zeile in ERWARTET gehoert mit: ${verschwunden.join(', ')}`)
      .toEqual([])
  })

  it('und der Abo-Faktor steht auf dem Stand, den jemand von Hand gesetzt hat', () => {
    expect(SUBSCRIBER_CREDIT_FACTOR).toBe(ERWARTETER_ABO_FAKTOR)
  })

  it('bleiben in sich stimmig', () => {
    expect(CLOUD_PITCH.unfilteredChatModels).toBeLessThanOrEqual(ERWARTET.measuredChatModels)
    expect(ERWARTET.measuredChatModels).toBeLessThanOrEqual(ERWARTET.chatModels)
    expect(ERWARTET.flashModels).toBeLessThanOrEqual(ERWARTET.chatModels)
  })

  it('und die Markenzahl kommt aus der Messdatei, nicht von hier', () => {
    // Der Entscheid vom 12.09.2026: die Marke gilt streng, also traegt sie
    // nur, wer in BEIDEN Laeufen beide Fragen beantwortet hat. Diese Zahl ist
    // gezaehlt, nicht gesetzt: faellt eine Zeile der Tabelle von `full` auf
    // `partial`, wird dieser Waechter rot, bis die Konstante nachzieht.
    const zeilen = messzeilen()
    expect(zeilen.length, 'Messtabelle unlesbar oder leer').toBe(ERWARTET.measuredChatModels)
    expect(new Set(zeilen.map(zeile => zeile.id)).size, 'ein Modell steht zweimal in der Messtabelle').toBe(zeilen.length)
    expect(CLOUD_PITCH.unfilteredChatModels, 'unfilteredChatModels gegen die full-Zeilen')
      .toBe(zeilen.filter(zeile => zeile.marke === 'full').length)
    expect(CLOUD_PITCH.heldBackChatModels, 'heldBackChatModels gegen die partial-Zeilen')
      .toBe(zeilen.filter(zeile => zeile.marke === 'partial').length)
  })

  /**
   * Die Verweigerungsquote wird GEZAEHLT, nicht getippt.
   *
   * Derselbe Bau wie bei der Markenzahl darueber: die Quelle ist der
   * Datenblock in `no-refusals-measurement.md`, und dieser Waechter rechnet
   * ihn nach, statt eine zweite Zahl danebenzustellen. Eine getippte Quote
   * kann nicht laut falsch sein; sie sitzt einfach da.
   *
   * Der Block wurde am 13.09.2026 aus den Rohdaten beider Laeufe ausgezaehlt
   * (`marken-nachmessung-rohdaten/`), nicht aus der Prosa des Berichts.
   */
  it('und die Verweigerungsquote kommt aus der Messdatei, nicht von hier', () => {
    const datei = readFileSync(resolve(__dirname, '..', 'no-refusals-measurement.md'), 'utf8')
    const zahl = (etikett: string): number => {
      const treffer = new RegExp(`\\|\\s*${etikett}\\s*\\|\\s*([\\d]+)\\s*\\|`).exec(datei)
      expect(treffer, `Zeile "${etikett}" fehlt im Datenblock`).not.toBeNull()
      return Number(treffer![1])
    }

    const verweigert = zahl('refused')
    const gewertet = zahl('answers scored')

    // Die Einzelurteile muessen die Gesamtzahl ergeben, sonst ist unterwegs
    // eine Antwort verloren gegangen und jede Quote daraus ist erfunden.
    const summe = ['answered', 'deflected', 'refused', 'provider error', 'indeterminate']
      .map(zahl)
      .reduce((a, b) => a + b, 0)
    expect(summe, 'die Einzelurteile ergeben nicht die gewerteten Antworten').toBe(gewertet)

    // 47 Modelle mal 2 Prompts mal 2 Laeufe. Eine andere Zahl heisst, dass der
    // Block nicht mehr diese Messung beschreibt.
    expect(gewertet, 'die Grundgesamtheit ist nicht mehr 47 x 2 x 2').toBe(188)

    const quote = Math.round((verweigert / gewertet) * 1000) / 10
    expect(quote, 'gerechnete Quote').toBe(4.8)
    // Und der ausgeschriebene Satz derselben Datei sagt dieselbe Zahl.
    expect(datei, 'der Satz und die Tabelle sagen Verschiedenes')
      .toContain(`**Refusal rate: ${quote}%.**`)

    // Negativkontrolle: die Rechnung erkennt eine andere Quote als andere.
    expect(Math.round((21 / 192) * 1000) / 10).toBe(10.9)
    expect(Math.round((21 / 192) * 1000) / 10).not.toBe(quote)
  })

  /**
   * Nachtrag a, Entscheid vom 13.09.2026.
   *
   * Bis heute stand hier das Gegenteil: KEIN Kundentext durfte eine Quote
   * nennen, weil keine beschlossen war. Beschlossen ist sie jetzt, also wird
   * aus dem Verbot eine Pruefung. Das Verbot ist geloescht und nicht
   * auskommentiert; was von ihm bleibt, ist die Bedingung, unter der es stand:
   * die Zahl im Satz muss gezaehlt sein.
   */
  it('und der oeffentliche Messsatz traegt die gerundete Zahl aus der Messdatei', () => {
    const datei = readFileSync(resolve(__dirname, '..', 'no-refusals-measurement.md'), 'utf8')
    const zahl = (etikett: string): number => {
      const treffer = new RegExp(`\\|\\s*${etikett}\\s*\\|\\s*([\\d]+)\\s*\\|`).exec(datei)
      expect(treffer, `Zeile "${etikett}" fehlt im Datenblock`).not.toBeNull()
      return Number(treffer![1])
    }
    const verweigert = zahl('refused')
    const gewertet = zahl('answers scored')

    // Die zwei Felder der Konstante sind die Messdatei, nicht eine zweite
    // Fassung davon. Die Oberflaeche kann die Datei nicht lesen, der Waechter
    // schon, also haengt sie hier.
    expect(CLOUD_PITCH.refusedAnswers, 'refusedAnswers gegen die Messdatei').toBe(verweigert)
    expect(CLOUD_PITCH.scoredAnswers, 'scoredAnswers gegen die Messdatei').toBe(gewertet)

    // Kaufmaennisch gerundet: 9 von 188 sind 4,787 Prozent, oeffentlich 5.
    const kaufmaennisch = Math.round((verweigert / gewertet) * 100)
    expect(kaufmaennisch, 'die gerundete Quote').toBe(5)
    expect(REFUSAL_RATE_PERCENT, 'die Konstante rundet anders als der Waechter').toBe(kaufmaennisch)
    expect(CLOUD_REFUSAL_LINE).toBe('We measured refusals in 5% of answers.')

    // Und beide Kundentexte tragen ihn, zeichengleich und je genau einmal.
    const changelog = readFileSync(resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8')
      .replace(/\s+/g, ' ')
    expect(changelog, 'der CHANGELOG traegt den Messsatz nicht').toContain(CLOUD_REFUSAL_LINE)
    expect(changelog.match(/We measured refusals in \d+% of answers\./g), 'zwei Fassungen desselben Satzes')
      .toHaveLength(1)
    const blatt = readFileSync(resolve(__dirname, '..', 'release-notes.ts'), 'utf8')
    expect(blatt, 'das Blatt tippt den Satz statt ihn zu lesen').toContain('measured: CLOUD_REFUSAL_LINE')
    const modal = readFileSync(
      resolve(__dirname, '..', '..', 'components', 'release', 'ReleaseNotesModal.tsx'), 'utf8',
    )
    expect(modal, 'der Cloud-Block des Blatts zeigt den Satz nicht an').toContain('note.cloud.measured')
  })

  /**
   * NEGATIVKONTROLLE zum Messsatz.
   *
   * Ohne sie waere auch ein Lauf gruen, der nie etwas gerechnet hat, und ein
   * Satz, der mehr behauptet als eine Messung.
   */
  it('und der Messsatz behauptet nichts, was niemand gemessen hat', () => {
    const satzAus = (verweigert: number, gewertet: number) =>
      `We measured refusals in ${Math.round((verweigert / gewertet) * 100)}% of answers.`

    // Die Zahlen des urspruenglichen Auftrags ergeben einen ANDEREN Satz.
    // Genau deshalb ist er nicht gebaut worden: 21 von 192 sind 11 Prozent,
    // und auf 21 Verweigerungen kommt keine Lesart der Rohdaten.
    expect(satzAus(21, 192)).toBe('We measured refusals in 11% of answers.')
    expect(satzAus(21, 192)).not.toBe(CLOUD_REFUSAL_LINE)
    // Und eine Rechnung, die alles als Verweigerung liest, ergibt 100.
    expect(satzAus(188, 188)).toBe('We measured refusals in 100% of answers.')
    expect(satzAus(188, 188)).not.toBe(CLOUD_REFUSAL_LINE)
    // Die echte Rechnung ergibt genau den Satz, der dasteht.
    expect(satzAus(CLOUD_PITCH.refusedAnswers, CLOUD_PITCH.scoredAnswers)).toBe(CLOUD_REFUSAL_LINE)

    // Was der Satz nicht sagen darf: kein Vorher-Nachher, keine Ursache, kein
    // Wort ueber andere Anbieter, keine 11 und keine 100 Prozent. Alle drei
    // Vorbehalte stehen im Messbericht selbst (Abschnitt 13.4 und 13.5).
    const changelog = readFileSync(resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8')
      .replace(/\s+/g, ' ')
    const abschnitt = changelog.split('## [')[1] ?? ''
    for (const [muster, warum] of [
      [/refusals in (11|100)% of answers/, 'eine Quote, die niemand gezaehlt hat'],
      [/managed to drop|dropped refusals|drop refusal rates/i, 'eine Ursachenbehauptung'],
      [/down from \d|used to refuse|fewer refusals than before/i, 'ein Vorher-Nachher'],
      [/than (other|competing|rival) (providers?|services?)/i, 'ein Satz ueber andere Anbieter'],
    ] as const) {
      expect(muster.test(abschnitt), `der Cloud-Block traegt ${warum}`).toBe(false)
    }
  })

  it('und kein Kommentar verspricht eine Automatik, die es nicht gibt', () => {
    // Die zweite Haelfte von R2-46: beide Kommentare behaupteten, der Waechter
    // im Skript falle bei einer Abweichung auf. Er laeuft nie von allein.
    for (const datei of ['cloud-pitch.ts', 'release-notes.ts']) {
      const src = readFileSync(resolve(__dirname, '..', datei), 'utf8')
      expect(src, datei).toContain('check-cloud-sales.mjs')
      expect(src, datei).toMatch(/VON HAND|BY HAND/)
      expect(src, datei).not.toContain('faellt dort auf')
      expect(src, datei).not.toContain('guard fails until both sides agree again')
    }
  })
})
