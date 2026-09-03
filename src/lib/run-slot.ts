/**
 * Einen Platz auf der Spur nehmen, den Lauf fahren, den Platz zurueckgeben.
 * An EINER Stelle.
 *
 * ── WARUM DAS NICHT JEDER SELBST MACHT ──────────────────────────────────────
 *
 * `run-lanes.ts` schreibt die Pflicht in seinen Kopf, in Grossbuchstaben: wer
 * `'started'` bekommt, MUSS `release` mit derselben Kennung rufen, im
 * `finally`, auch bei Fehler und Abbruch. Ein nicht zurueckgegebener Platz
 * haelt die lokale Spur fuer den Rest der Sitzung besetzt; jeder weitere
 * lokale Lauf reiht sich dann in eine Schlange ein, die nie wieder
 * abgearbeitet wird. Das ist die einzige Art, wie die Spur die App zum Stehen
 * bringen kann.
 *
 * Eine Pflicht, die an jeder Aufrufstelle neu eingehalten werden muss, wird
 * irgendwann an einer Aufrufstelle nicht eingehalten, und zwar nicht durch
 * Nachlaessigkeit: die Sendewege im Haus sind lang, haben mehrere
 * Fehlerpfade, ein `return` mittendrin und Abbruchbehandlung an drei Stellen.
 * Wer dort ein `finally` uebersieht, sieht nichts Rotes. Er sieht ein
 * funktionierendes Programm, bis der zweite lokale Lauf kommt.
 *
 * Deshalb gibt der Aufrufer hier seinen RUMPF ab statt eine Zusicherung. Das
 * `finally` steht dann genau einmal im Haus, und ein Waechter
 * (`__tests__/run-slot.test.ts`) haelt fest, dass `admit` und `release` sonst
 * nirgends geholt werden.
 *
 * ── WAS HIER SONST NOCH HINEINGEHOERT, UND WARUM ────────────────────────────
 *
 * Der Abbruchgriff wird SCHON BEIM ANSTELLEN gesetzt, nicht erst wenn der
 * Lauf anlaeuft. Sonst haette Stop an einem wartenden Lauf nichts zu greifen:
 * der Rumpf, der den Griff sonst registriert, hat ja noch nicht angefangen.
 * Der Nutzer sieht ein Warteplaettchen, drueckt Stop, und nichts passiert.
 *
 * Ein verschachtelter Lauf bekommt gar keinen zweiten Platz. `admit` laesst
 * dieselbe Konversation absichtlich noch einmal durch, weil ein
 * Vordergrund-Sub-Agent sonst auf eine Spur wartete, die sein eigener
 * Elternlauf haelt. Ohne Zaehler hier naehme der innere Lauf dieses
 * `'started'` fuer bare Muenze und raeumte in seinem `finally` den Platz des
 * Aeusseren, waehrend der noch rechnet. Genau ein `finally` zu viel, und die
 * ganze Sperre ist weg.
 */
import { admit, release, type RunLane } from './run-lanes'
import { useGenerationStore } from '../stores/generationStore'

export interface RunSlotOptions {
  /** Der sichtbare Lauf. Dieselbe Kennung, die der Stop-Knopf benennt. */
  conversationId: string
  /** Eigene Karte oder fremde Kapazitaet: `laneOf(model, currentLaneFacts())`. */
  lane: RunLane
  /**
   * Abbrechen, waehrend der Rumpf schon laeuft.
   *
   * Optional, weil die Sendewege ihren eigenen Griff registrieren, sobald sie
   * ihren `AbortController` haben; der ueberschreibt den hiesigen dann. Fuer
   * die Zeit davor, also das Warten in der Schlange, sorgt dieses Modul
   * selbst: dort wird nichts abgebrochen, sondern ausgereiht.
   */
  abort?: () => void
}

/**
 * Wie der Lauf ausging, aus Sicht der Spur.
 *
 * `'cancelled-while-queued'` heisst: der Rumpf hat NIE angefangen. Kein
 * Token, keine Antwort, nichts aufzuraeumen. Wer davor schon etwas in den
 * Chat geschrieben hat, muss das selbst wieder wegnehmen; hier ist nichts
 * passiert, was zurueckzunehmen waere.
 */
export type RunSlotOutcome = 'ran' | 'cancelled-while-queued'

/** Warum das Warten zu Ende ist: drangekommen, oder vorher abgesagt. */
type Weckgrund = 'drangekommen' | 'ausgereiht'

/**
 * Wie viele Laeufe je Konversation gerade IN diesem Modul stecken.
 *
 * Nur der aeusserste nimmt und gibt den Platz. Modulzustand aus demselben
 * Grund wie in `run-lanes.ts` und `run-stop.ts`: die Frage ueberlebt jedes
 * Aus- und Einhaengen der Ansicht.
 */
const tiefe = new Map<string, number>()

/**
 * Den Lauf fahren, sobald seine Spur frei ist.
 *
 * Cloud faengt sofort an. Lokal faengt sofort an, wenn die Karte frei ist,
 * und stellt sich sonst an; der Rumpf laeuft dann an, wenn der Vordermann
 * fertig ist. Der Rueckgabewert sagt, ob er ueberhaupt gelaufen ist.
 *
 * Fehler aus dem Rumpf kommen unveraendert heraus. Dieses Modul faengt
 * nichts: es entscheidet nur, WANN gelaufen wird, und raeumt danach auf.
 */
export async function runInLane(
  options: RunSlotOptions,
  body: () => Promise<void>,
): Promise<RunSlotOutcome> {
  const { conversationId, lane, abort } = options

  // Ein Lauf ohne Kennung nimmt keinen Platz, dieselbe Entscheidung wie in
  // `admit`: er koennte ihn nie zurueckgeben, weil `release` ihn ueber genau
  // diese Kennung findet. Zwei lokale Laeufe nebeneinander sind langsam, eine
  // fuer immer besetzte Spur ist tot.
  if (!conversationId) {
    await body()
    return 'ran'
  }

  const verschachtelt = (tiefe.get(conversationId) ?? 0) > 0
  if (verschachtelt) {
    tiefe.set(conversationId, (tiefe.get(conversationId) ?? 0) + 1)
    try {
      await body()
      return 'ran'
    } finally {
      const rest = (tiefe.get(conversationId) ?? 1) - 1
      if (rest > 0) tiefe.set(conversationId, rest)
      else tiefe.delete(conversationId)
    }
  }

  let zustand: 'wartend' | 'laeuft' | 'ausgereiht' = 'wartend'
  let wecken: ((grund: Weckgrund) => void) | null = null

  /**
   * Stop, aus Sicht dieses Laufs.
   *
   * Zwei voellig verschiedene Dinge, je nachdem wo der Lauf steht, und genau
   * deshalb steht der Griff hier und nicht im Rumpf: waehrend des Wartens
   * gibt es keinen Strom zum Abbrechen, es gibt eine Zeile in einer
   * Schlange, die verschwinden muss. Bliebe sie stehen, bekaeme sie spaeter
   * die Karte fuer einen Lauf, den der Nutzer laengst abgesagt hat.
   */
  const abbruchgriff = (): void => {
    if (zustand === 'wartend') {
      zustand = 'ausgereiht'
      // `release` auf einen Wartenden nimmt ihn aus der Schlange und rueckt
      // NIEMANDEN nach, denn der Halter rechnet ja weiter.
      release(conversationId)
      wecken?.('ausgereiht')
      return
    }
    abort?.()
  }

  const store = useGenerationStore.getState()
  store.registerAborter(conversationId, abbruchgriff)
  store.bookRun(conversationId, lane)

  const urteil = admit(lane, conversationId, () => {
    // Der Vordermann ist fertig. Dieser Aufruf WECKT nur; der Rumpf laeuft
    // erst im naechsten Mikrotask, also ausserhalb des `finally` des
    // vorigen Laufs. Genau darum darf `release` seinen Rueckgabewert weiter
    // unten im `finally` gerufen werden, ohne die beiden Laeufe zu
    // verbinden: ein Fehler des Nachrueckenden kann hier nicht entstehen.
    if (zustand !== 'wartend') return
    zustand = 'laeuft'
    wecken?.('drangekommen')
  })

  // Warum das Wecken seinen Grund mittraegt, statt dass hier `zustand`
  // gelesen wird: `zustand` wird ausschliesslich in Rueckrufen gesetzt, und
  // die sieht der Fluss dieser Funktion nicht. Der Uebersetzer haelt die
  // Zuweisungen fuer unerreichbar und die Abfrage danach fuer sinnlos
  // (TS2367, "no overlap"). Er hat recht mit dem, was er sieht; die Antwort
  // ist, sie ihm mitzugeben, statt ihn zu ueberstimmen.
  let grund: Weckgrund = 'drangekommen'
  if (urteil === 'started') {
    zustand = 'laeuft'
  } else {
    grund = await new Promise<Weckgrund>((aufloesen) => {
      // Zwischen `admit` und hier liegt kein `await`, der Startaufruf kann
      // also noch nicht gefallen sein. Die Abfrage steht trotzdem da: sie
      // kostet nichts und haelt den Fall aus, dass jemand die Reihenfolge
      // spaeter umbaut.
      if (zustand === 'ausgereiht') { aufloesen('ausgereiht'); return }
      if (zustand === 'laeuft') { aufloesen('drangekommen'); return }
      wecken = aufloesen
    })
  }

  if (grund === 'ausgereiht') {
    aufraeumen(conversationId, abbruchgriff)
    return 'cancelled-while-queued'
  }

  tiefe.set(conversationId, 1)
  try {
    await body()
    return 'ran'
  } finally {
    tiefe.delete(conversationId)
    aufraeumen(conversationId, abbruchgriff)
    // DIE PFLICHT AUS DEM KOPF VON run-lanes.ts, an ihrer einzigen Stelle.
    // Der Platz ist beim Zurueckkehren aus `release` schon an den Naechsten
    // vergeben; wer den Rueckgabewert verwirft, laesst die Spur haengen.
    release(conversationId)?.()
  }
}

/**
 * Buchung weg, eigener Abbruchgriff weg.
 *
 * Der Griff wird nur geloescht, wenn er noch UNSERER ist. Der Sendeweg
 * registriert im Rumpf seinen eigenen und ueberschreibt diesen dabei; ihn
 * danach blind wegzuraeumen, naehme dem Nutzer den Stop-Knopf fuer einen
 * Lauf, der noch ausrollt.
 */
function aufraeumen(conversationId: string, eigenerGriff: () => void): void {
  const store = useGenerationStore.getState()
  store.endRun(conversationId)
  if (useGenerationStore.getState().aborters[conversationId] === eigenerGriff) {
    store.clearAborter(conversationId)
  }
}

/** Nur fuer Tests: der Zaehler lebt sonst eine ganze Sitzung lang. */
export function __resetRunSlotsForTests(): void {
  tiefe.clear()
}
