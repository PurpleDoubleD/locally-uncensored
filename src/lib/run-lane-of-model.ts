/**
 * Auf welcher Spur laeuft dieses Modell: auf der Karte des Nutzers oder
 * woanders?
 *
 * Die Frage sieht nach einer Nachschlagetabelle aus und ist keine. Der
 * Slot-Bezeichner im Modellnamen (`ollama::`, `openai::`, ...) sagt, WELCHER
 * Anbieterzugang benutzt wird, nicht, WO gerechnet wird. Bei zwei der vier
 * Slots faellt das auseinander, und zwar in beide Richtungen:
 *
 *   ollama::qwen3:8b   auf localhost           →  lokal, eigene Karte
 *   ollama::qwen3:8b   auf 192.168.0.54:11434  →  fremde Karte, also cloud
 *   openai::gpt-oss    im mitgelieferten Motor →  lokal, eigene Karte
 *   openai::llama3     in LM Studio, localhost →  lokal, eigene Karte
 *   openai::gpt-4o     bei OpenAI selbst       →  cloud
 *
 * ── ES GIBT SCHON EINE LOKALITAETSFRAGE, UND SIE PASST NICHT ────────────────
 *
 * `api/agents/model-locality.ts` (`isLocalModelByName`) beantwortet etwas, das
 * genauso klingt, und wird hier bewusst NICHT benutzt. Der Unterschied ist
 * keine Geschmacksfrage:
 *
 *   Dort ist die Frage "verlaesst mein Text die Maschine?", also eine nach
 *   Vertraulichkeit, gestellt fuer den Architekten-Waehler. Hier ist die Frage
 *   "streiten sich zwei Laeufe um dieselbe Karte?", also eine nach VRAM.
 *
 * Bei einem Ollama auf einem anderen Rechner im eigenen Netz gehen die
 * Antworten auseinander: die Daten bleiben beim Nutzer (die dortige Antwort
 * ist `true`, Zeile 41, ohne jede Ruecksicht auf die Adresse), aber gerechnet
 * wird auf FREMDEM VRAM, wo unsere Warteschlange nichts zu regeln hat. Wer
 * die beiden Fragen zu einer zusammenlegt, macht eine von beiden falsch. Der
 * Waechter zu dieser Datei nagelt den Unterschied fest, damit das Zusammen-
 * legen nicht als Aufraeumen durchgeht.
 *
 * NICHT gefragt wird `settings.appMode`. Das ist ein Schalter der Oberflaeche
 * darueber, welche Auswahl ein Nutzer sehen will. Was ein bereits laufender
 * Lauf gerade wirklich belegt, steht dort nicht drin, und ein Umlegen des
 * Schalters mitten im Lauf wuerde die Antwort ruecklings aendern.
 *
 * ── ZWEI HAELFTEN, UND WARUM ────────────────────────────────────────────────
 *
 * Die Tatsachen, an denen es haengt, sind nicht rein: der providerStore und
 * Modulzustand in backend.ts. Eine Regel, die man nur mit aufgebautem Store
 * pruefen kann, wird irgendwann nicht mehr geprueft. Also: `laneOf` ist die
 * REGEL und nimmt die Antworten als Argumente, `currentLaneFacts()` ist die
 * einzige Stelle, die sie beschafft. Der Aufrufer schreibt
 * `laneOf(model, currentLaneFacts())`.
 *
 * Die Zugriffe stehen statisch hier drin und nicht hinter einer Anmeldung von
 * aussen. Der Kreis, den model-name.ts in seinem Kopf beschreibt
 * (providers/index → openai-provider → builtin-ensure → providerStore →
 * modelStore/engine → providers/index), entsteht dabei nicht; nachgemessen
 * mit `npm run cycles`, 0 Kreise. Eine Anmeldung von aussen waere die teurere
 * Loesung fuer ein Problem, das es hier nicht gibt: wer sie vergisst, bekommt
 * keine Fehlermeldung, sondern lautlos die falsche Spur.
 */
import type { ProviderId } from '../api/providers/types'
import { getProviderIdFromModel } from '../api/providers/model-name'
import { isManagedBuiltinSlot } from '../api/builtin-ensure'
import { isOllamaLocal } from '../api/backend'
import { useProviderStore } from '../stores/providerStore'
import type { RunLane } from './run-lanes'

export type { RunLane }

/** Die zwei Tatsachen, an denen sich die Spur entscheidet. */
export interface LaneFacts {
  /**
   * Der `openai`-Slot zeigt auf einen Server AUF DIESER MASCHINE.
   *
   * NICHT `isManagedBuiltinSlot()` allein, und das ist der Fallstrick dieses
   * Moduls. Der Slot ist dreifach belegt, nicht doppelt:
   *
   *   managed: true,  127.0.0.1:8127   der mitgelieferte Motor
   *   managed: false, localhost:1234   LM Studio (Onboarding.tsx:178)
   *   managed: false, api.openai.com   die echte fremde API
   *
   * Nur der dritte ist cloud. Haenge man die Frage an `managed`, zaehlte LM
   * Studio als cloud und liefe damit ohne Warteschlange neben einem
   * lokalen Ollama auf DERSELBEN Karte. Das ist genau der VRAM-Tausch, gegen
   * den run-lanes.ts gebaut ist, nur an der Stelle, an der ihn niemand sucht.
   */
  openaiSlotIsLocal: boolean
  /** `isOllamaLocal()`: die Ollama-Adresse zeigt auf diese Maschine. */
  ollamaBaseIsLocal: boolean
}

/**
 * Fuer JEDEN Slot ein Urteil, als totale Tabelle und nicht als Vergleichskette.
 *
 * Dieselbe Bauform wie `RUN_ACTIVE_BY_STATUS` in types/codex.ts, und aus
 * demselben Grund: ein fuenfter Anbieter ohne Eintrag ist ein Compilerfehler.
 * Als `if (id === 'anthropic' || ...)` waere er stillschweigend lokal oder
 * stillschweigend cloud, je nachdem, wohin der Rueckfall zeigt, und niemand
 * bemerkte es, bis eine Karte umraeumt oder eine Warteschlange stockt. Genau
 * das ist in model-locality.ts passiert: `lu-cloud` hat dort keinen Zweig und
 * faellt ans Ende durch. Die Antwort stimmt, aber sie ist nicht entschieden.
 */
const LANE_BY_PROVIDER: Record<ProviderId, (f: LaneFacts) => RunLane> = {
  // Die eigene Wolke und Anthropic haben gar keinen lokalen Fall.
  'lu-cloud': () => 'cloud',
  anthropic: () => 'cloud',
  // Der mehrfach belegte Slot: eigener Motor, LM Studio, oder fremde API.
  openai: (f) => (f.openaiSlotIsLocal ? 'local' : 'cloud'),
  // Ollama kann auf einer fremden Maschine stehen. Dann ist es deren VRAM,
  // und unsere Warteschlange haette dort nichts zu regeln.
  ollama: (f) => (f.ollamaBaseIsLocal ? 'local' : 'cloud'),
}

/** Die Spur eines Slots. Getrennt exportiert, wo der Slot schon feststeht. */
export function laneOfProvider(id: ProviderId, facts: LaneFacts): RunLane {
  const urteil = LANE_BY_PROVIDER[id]
  // Ein Bezeichner, den der Typ nicht kennt, kann nur aus einem gespeicherten
  // Modellnamen kommen: der Praefix ist eine Zeichenkette aus dem Speicher,
  // kein geprueftes Feld. `cloud` als Rueckfall ist die harmlose Haelfte: ein
  // Unbekannter startet dann sofort, statt einen Platz in einer Spur zu
  // belegen, die gar nicht seine ist.
  return urteil ? urteil(facts) : 'cloud'
}

/**
 * Die Spur eines Modellnamens.
 *
 * Ueber `getProviderIdFromModel` und NICHT ueber `getProviderForModel`
 * (registry.ts:71): das Zweite baut nebenbei einen Anbieter-Client und wirft
 * `Provider not configured`, wenn der Slot nicht eingerichtet ist. Fuer die
 * blosse Frage, wo gerechnet wird, waere beides falsch: ein Nebeneffekt und
 * ein Fehlerpfad, wo eine reine Auskunft genuegt. Der Praefix allein reicht,
 * und die reine Fassung dafuer gibt es seit Audit W-T2 (model-name.ts).
 *
 * Ein Name ohne Praefix ist Altbestand und heisst Ollama, dieselbe Auslegung
 * wie ueberall sonst im Haus, sie steht in model-name.ts.
 */
export function laneOf(model: string, facts: LaneFacts): RunLane {
  return laneOfProvider(getProviderIdFromModel(model), facts)
}

/**
 * Zeigt diese Adresse auf die Maschine, auf der wir laufen?
 *
 * Dieselbe Liste, die `isOllamaLocal` (api/backend.ts:595) benutzt, und die
 * dritte Kopie davon im Haus (die zweite steht in
 * components/settings/SettingsPage.tsx:624). Sie hier NICHT auszuschreiben
 * hiesse, `api/backend.ts` fuer eine fremde URL umzubauen, und das ist eine
 * gesperrte Datei in diesem Auftrag. Die Zusammenfuehrung ist gemeldet, nicht
 * heimlich gemacht.
 *
 * Nicht parsbar heisst NICHT lokal: ein Lauf startet dann ohne Warteschlange,
 * also so wie vor diesem Modul. Der andere Rueckfall belegte einen Platz in
 * einer Spur, in der er nichts zu suchen hat.
 */
function hostIsThisMachine(url: string | undefined): boolean {
  if (!url) return false
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0'
  } catch {
    return false
  }
}

/**
 * Die zwei Tatsachen, jetzt gerade. Die EINZIGE Stelle, die dafuer in die
 * Anbieterschicht greift.
 *
 * Faellt ein Zugriff aus, etwa in einem Test ohne aufgebauten Store oder bei
 * einem Aufruf, bevor beim Hochfahren irgendetwas eingerichtet ist, dann gilt
 * wieder das Vorsichtige: nicht lokal.
 */
export function currentLaneFacts(): LaneFacts {
  return {
    openaiSlotIsLocal: frage(openaiSlotLokal),
    ollamaBaseIsLocal: frage(isOllamaLocal),
  }
}

/**
 * Der mitgelieferte Motor ODER irgendein anderer Server auf dieser Maschine.
 *
 * `isManagedBuiltinSlot()` zuerst, weil es die staerkere Auskunft ist: bei
 * `managed` gehoert der Prozess der App, sie hat ihn gestartet und kennt
 * seinen Port. Die Adressfrage danach faengt den zweiten lokalen Fall, den
 * `managed` nicht kennt (LM Studio, llama.cpp von Hand).
 *
 * Bewusst NICHT `cfg.isLocal`: das ist ein Merker, den Vorlagen und der
 * Einrichtungsassistent schreiben, kein gemessener Zustand. Wer LM Studio auf
 * einen Rechner im Netz zeigen laesst, behaelt `isLocal: true` und bekaeme
 * eine Warteschlange fuer eine Karte, die ihm nicht gehoert. Die Adresse ist
 * die Tatsache, der Merker ist eine Absichtserklaerung.
 */
function openaiSlotLokal(): boolean {
  if (isManagedBuiltinSlot()) return true
  const cfg = useProviderStore.getState().providers.openai
  return !!cfg?.enabled && hostIsThisMachine(cfg.baseUrl)
}

function frage(f: () => boolean): boolean {
  try {
    return f()
  } catch {
    return false
  }
}
