/**
 * What the AI Backends list may say about the app's own built-in engine
 * BEFORE anyone has probed it.
 *
 * GH #118 leftover, found by the counter-check on the real 2.6.7 build
 * (2026-08-29): Settings, AI Backends showed the Built-in Engine as "Failed"
 * straight after app start, with no model loaded. A click on Test then put
 * `GET http://127.0.0.1:8127/v1/models net::ERR_CONNECTION_REFUSED` in the
 * console and flipped the same row to "Connected". The engine was healthy the
 * whole time. The display was wrong twice: it called an engine that had never
 * been started a failure, and it produced a red console line to find that out.
 *
 * A server the app has not started yet is not a failed server. The app owns
 * that process and can ask the Rust side whether it runs, which costs no
 * socket and cannot be refused by a port nobody is listening on. Only when
 * that answer is ambiguous is a real probe worth making.
 */

export type SlotStatus = 'idle' | 'connected' | 'failed' | 'stopped' | 'no-models'

/** The engine status the Rust `bundled_engine_status` command returns. */
export interface EngineHealth {
  running?: boolean
  healthy?: boolean
}

/**
 * The status the built-in slot may claim from the engine answer alone.
 *
 *  - healthy            -> 'connected', it is answering right now
 *  - not running        -> 'stopped', nothing to fail yet
 *  - running, unhealthy -> null, the process is up and the port may still be
 *                          binding, so this one IS worth a real probe
 *  - no answer at all   -> null, we know nothing, fall back to the probe
 *
 * Never returns 'failed': a verdict of failure has to come from a probe that
 * actually ran.
 */
export function builtinSlotStatus(engine: EngineHealth | null | undefined): SlotStatus | null {
  if (!engine) return null
  if (engine.healthy) return 'connected'
  if (engine.running) return null
  return 'stopped'
}

/**
 * "Connected" darf nicht heissen "der Port hat geantwortet".
 *
 * Persona-Befund vom 03.09.2026: der Test-Knopf meldete Connected, obwohl kein
 * Chat moeglich war. Nachgemessen im laufenden Build mit einem
 * OpenAI-kompatiblen Anbieter, der auf `GET /v1/models` mit 200 und einer
 * LEEREN Liste antwortet:
 *
 *   Test-Knopf mit einem Modell   -> "Connected"
 *   Test-Knopf mit null Modellen  -> "Connected"
 *
 * Zweimal dasselbe Wort fuer zwei sehr verschiedene Lagen. Die Meldung war
 * also richtig: `checkConnection()` fragt bei den lokalen Anbietern nur den
 * GET-Pfad (`/v1/models` bzw. `/api/tags`) und liest davon nur `res.ok`. Ein
 * LM Studio mit laufendem Server und ohne geladenes Modell, ein frisches
 * Ollama ohne einen einzigen Pull, ein llama.cpp-Server im Leerlauf: alle drei
 * antworten 200 und koennen keine einzige Nachricht beantworten.
 *
 * Erreichbarkeit bleibt, was sie ist. Sie bekommt nur nicht mehr das Wort, das
 * nach "du kannst jetzt chatten" klingt.
 *
 * `models === null` heisst "konnte nicht gefragt werden" (Anbieter ohne Liste,
 * Fehler beim Holen). Dann bleibt es bei `connected`: ein Unwissen darf nie
 * mehr behaupten als das, was schon gemessen wurde, aber auch nicht weniger.
 */
export function reachVerdict(reachable: boolean, models: number | null): SlotStatus {
  if (!reachable) return 'failed'
  if (models === 0) return 'no-models'
  return 'connected'
}

/**
 * Derselbe Schluss, aber aus der LAUFENDEN Schleife statt aus einer Sonde, die
 * einmal beim Aufbauen lief.
 *
 * Gegenprobe G2, 04.09.2026, im echten Build gemessen: der Punkt neben
 * "LU Engine DEFAULT LOCAL" blieb 150 Sekunden lang gruen, nachdem der
 * Engine-Prozess von aussen getoetet worden war, waehrend derselbe Bildschirm
 * zwei Zentimeter tiefer binnen einer Sekunde "Engine not running" meldete.
 * Der Punkt hat weder `title` noch `aria-label`, es gab also auch keinen Text,
 * der die Farbe erklaert haette.
 *
 * Null heisst hier immer "diese Zeile weiss es von hier aus nicht", und dann
 * bleibt der Sondenwert stehen: fuer jede fremde Zeile, fuer eine Engine, die
 * laeuft und noch nicht antwortet, und solange noch gar keine Antwort da war.
 */
export function liveSlotStatus(
  id: string,
  config: { managed?: boolean } | null | undefined,
  engine: { status: EngineHealth | null; geantwortet: boolean },
): SlotStatus | null {
  if (id !== 'openai' || config?.managed !== true) return null
  if (!engine.geantwortet) return null
  return builtinSlotStatus(engine.status)
}
