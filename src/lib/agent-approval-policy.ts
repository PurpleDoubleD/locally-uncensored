/**
 * Wo die Freigabe-Entscheidung EINMAL faellt: vorne, fuer den ganzen Lauf.
 *
 * Auftrag 2.3, am 04.09.2026: "hintergrund bzw multiagents sollen
 * NIEMALS freigabe brauchen. ist bei claude code desktop auch nicht so
 * richtig?" Der Vergleich stimmt im Kern: dort stellt ein Unteragent keine
 * eigenen Freigabefragen, es gilt der Berechtigungsmodus der Sitzung, in der
 * er gestartet wurde.
 *
 * Gemessen an HEAD, mit den Vorgaben aus DEFAULT_PERMISSIONS: drei
 * delegate_task-Aufrufe in einem Zug erzeugten drei Dialoge, weil
 * delegate_task in der Kategorie 'workflow' liegt und die auf 'confirm' steht.
 * Ein file_write im Unterauftrag kam als vierter dazu. Vier Unterbrechungen
 * fuer einen Lauf, der "im Hintergrund" heisst.
 *
 * Die saubere Form ist "einmal vorne", NICHT "gar nicht". Deshalb stehen hier
 * zwei Regeln nebeneinander, und die zweite ist die wichtigere:
 *
 *  1. Was der Nutzer vorne erlaubt hat, gilt fuer den Lauf UND fuer alles, was
 *     er delegiert. Keine zweite Frage pro Unteragent.
 *  2. Was nie erlaubt war, bekommt ein Unteragent auch nicht dadurch, dass er
 *     ein Unteragent ist. 'blocked' bleibt 'blocked', ein lesend gestellter
 *     Lauf bleibt lesend, und auf der Code-Oberflaeche gilt fuer den
 *     Unterlauf genau der Gate, den der Hauptlauf auch haette.
 *
 * Warum delegate_task, check_tasks und message_agent selbst nicht mehr fragen:
 * keines der drei fasst die Maschine des Nutzers an. check_tasks liest
 * App-Zustand, message_agent legt einen Nutzer-Turn in ein Gespraech, und
 * delegate_task startet einen Lauf, dessen JEDER Werkzeugaufruf wieder durch
 * diesen Gate hier geht. Ueber diesen Kanal ist keine Erlaubnis zu bekommen,
 * die vorher nicht da war, also ist die Rueckfrage Zeremonie und kein Schutz.
 * Das ist wortgleich die Begruendung, mit der check_tasks und message_agent
 * schon seit ihrer Einfuehrung in der Kategorie 'system' stehen (siehe
 * agent-task-tools.ts); delegate_task zieht jetzt nach.
 *
 * Ein sichtbarer Weg zurueck bleibt: die Kategorie 'workflow' auf 'blocked'
 * schaltet die Delegation ganz ab, und eine ausdrueckliche Einzelregel fuer
 * delegate_task (perToolOverrides) holt die Rueckfrage zurueck.
 */

import type { PermissionLevel } from '../api/mcp/types'
import { allowedInReadOnlyTurn } from './mutating-tools'
import { CODEX_CONFIRM_TOOLS } from '../hooks/codexShellGate'

/**
 * Die Werkzeuge, mit denen ein Lauf seine Hintergrundagenten startet und
 * steuert. Genau diese drei meint der Satz des Inhabers, und mehr steht hier nicht
 * drin: ein Werkzeug, das selbst etwas anfasst, gehoert nie in diese Liste.
 */
export const BACKGROUND_AGENT_TOOLS: ReadonlySet<string> = new Set([
  'delegate_task',
  'check_tasks',
  'message_agent',
])

/**
 * Lesen im Ordner des Laufs. Diese drei kommen nur in den Ordner, den der
 * Nutzer dem Agent gegeben hat (Sandbox oder gewaehlter Ordner, der Riegel in
 * commands/filesystem.rs), und aendern nichts. Die Kategorie 'filesystem'
 * steht auf 'confirm' wegen des Schreibens; dass sie das Lesen mitfragte, war
 * eine Freigabekarte vor jedem file_read in der eigenen Sandbox (Gegenprobe
 * 01.10.2026). Der Code-Tab fragt in Ask ebenfalls nur vor dem Schreiben.
 */
export const WORKSPACE_READ_TOOLS: ReadonlySet<string> = new Set([
  'file_read',
  'file_list',
  'file_search',
])

/**
 * Tools that carry their own, stricter gate (Astra computer use, 06.10.2026).
 *
 * The approval card decides once per call and by tool name. computer_use
 * decides per action and per app, in Rust: a screenshot asks nothing, the
 * first action in an app asks for that app, every action is confirmed unless
 * the session is autonomous, and sending, buying, deleting and permission
 * changes are confirmed even then. A card on top would ask twice, and 'auto'
 * on the category must not switch any of that off. So the card steps aside;
 * 'blocked' and a read-only run still refuse, as for every tool.
 */
export const SELF_GATED_TOOLS: ReadonlySet<string> = new Set([
  'computer_use',
  // A screen task is a row of computer_use calls. Each of them asks itself.
  'computer_task',
])

/**
 * Die Entscheidung, die vor dem Lauf schon feststand, in einem Objekt.
 *
 * Sie wird NICHT pro Werkzeugaufruf neu erfunden: `codexMode` und
 * `execApproval` kommen aus dem Lauf-Kontext (dort einmal beim Start gesetzt),
 * die beiden Stufen aus dem Berechtigungs-Store, den der Nutzer in den
 * Einstellungen fuehrt.
 */
export interface FrontDecision {
  /** Kategorie-Stufe aus dem Berechtigungs-Store fuer dieses Gespraech. */
  categoryLevel: PermissionLevel
  /** Ausdrueckliche Einzelregel des Nutzers fuer genau dieses Werkzeug. */
  override?: PermissionLevel
  /**
   * Preset des Code-Laufs ('ask' | 'bypass' | 'plan'), null ausserhalb der
   * Code-Oberflaeche. Das Feld sagt zugleich, WELCHE Oberflaeche den Lauf
   * gestartet hat, und davon haengt ab, welche Entscheidung "die von vorne"
   * ist: im Agent-Chat der Berechtigungs-Store, im Code-Tab das Preset.
   */
  codexMode: string | null
  /**
   * Fragt dieser Lauf vor Werkzeugen mit beliebiger Ausfuehrung nach?
   * Das ist codexModeKnobs().confirmExec, einmal beim Start aufgeloest, damit
   * Hauptschleife und Unterlauf nicht zwei Rechnungen mit verschiedenen
   * Eingaben aufmachen koennen.
   */
  execConfirm?: boolean
  /** Der Lauf ist lesend gestellt (Plan-Modus, Code-Review, Nur-Lesen-Zug). */
  readOnlyRun: boolean
  /**
   * Das Werkzeug kommt von einem externen MCP-Server (REA, eigene Server).
   * Unter Ask fragt es vor jeder Ausfuehrung, unter Bypass nicht (Davids
   * Entscheidung 26.10.2026, A37: "Ask und Bypass soll da auch klappen").
   */
  external?: boolean
}

/**
 * Fragt die Code-Oberflaeche vor diesem Aufruf? Ask fragt vor den Werkzeugen
 * mit beliebiger Ausfuehrung UND vor jedem externen Werkzeug: ein MCP-Server
 * wie REA startet Programme (Ghidra headless), die der Nutzer unter Ask nie
 * ungefragt laufen sehen wollte. Bypass fragt nichts davon, ausser der Nutzer
 * hat die Cloud-Rueckfrage selbst eingeschaltet (execConfirm, nur die
 * Ausfuehrungswerkzeuge).
 */
export function codexAsksBefore(
  toolName: string,
  d: { codexMode: string | null; execConfirm?: boolean; external?: boolean },
): boolean {
  if (d.codexMode === 'ask' && d.external === true) return true
  return d.execConfirm === true && CODEX_CONFIRM_TOOLS.has(toolName)
}

/**
 * Die Stufe, die fuer diesen einen Aufruf gilt.
 *
 * Reihenfolge ist Absicht: die beiden Sperren zuerst, damit keine spaetere
 * Zeile sie aufweichen kann.
 */
export function resolveApprovalLevel(toolName: string, d: FrontDecision): PermissionLevel {
  const gespeichert = d.override ?? d.categoryLevel

  // 1. Nie erlaubt bleibt nie erlaubt. Eine abgeschaltete Kategorie ist auf
  //    beiden Oberflaechen dasselbe: der Hauptlauf bekommt das Werkzeug gar
  //    nicht erst angeboten (getAvailableTools), also darf es ein Unterlauf
  //    auch nicht ausfuehren.
  if (gespeichert === 'blocked') return 'blocked'

  // 2. Ein lesend gestellter Lauf bleibt lesend, auch ueber eine Delegation.
  //    Der Hauptlauf kann in Plan-Modus, Code-Review oder einem Nur-Lesen-Zug
  //    physisch nicht schreiben, weil die veraendernden Werkzeuge aus dem
  //    Katalog fallen. Ein Unteragent bekommt den vollen Katalog
  //    (toolRegistry.getAll in sub-agent.ts), also muss die Sperre HIER
  //    stehen. shell_execute ist die bekannte Ausnahme: es traegt seit dem
  //    Werkzeug-Zusammenzug die Git-Leser, sein Gate ist der Klassifikator im
  //    Ausfuehrer und nicht der Name. Dieselbe Weiche wie in
  //    codexModeRuleset, damit die beiden nicht auseinanderlaufen.
  if (d.readOnlyRun && !allowedInReadOnlyTurn(toolName)) return 'blocked'

  // 3. Ein Werkzeug mit eigenem Riegel fragt selbst (siehe SELF_GATED_TOOLS).
  if (SELF_GATED_TOOLS.has(toolName)) return 'auto'
  // tool_search reads the tool catalog of this run and touches nothing
  // (lib/tool-search.ts, C59). It is not in the registry, so its category
  // would read as the unknown tool's 'confirm'.
  if (toolName === 'tool_search') return 'auto'

  if (d.codexMode !== null) {
    // Code-Oberflaeche: das Preset IST die Entscheidung von vorne. Der
    // Hauptlauf dort liest die Kategorien des Berechtigungs-Stores gar nicht
    // fuer die Freigabe, er fragt nur, was knobs.confirmExec sagt. Wuerde ein
    // Unterlauf hier die Kategorien lesen, gaebe es beide Fehler auf einmal:
    // in Bypass eine Rueckfrage, die im Code-Tab niemand anzeigt (die
    // Warteschlange haengt am Chat), und in Ask ein unbeaufsichtigtes
    // shell_execute, sobald jemand 'terminal' fuer den Agent-Chat auf 'auto'
    // gestellt hat.
    if (BACKGROUND_AGENT_TOOLS.has(toolName)) return 'auto'
    return codexAsksBefore(toolName, d) ? 'confirm' : 'auto'
  }

  // Agent-Chat: der Berechtigungs-Store ist die Entscheidung von vorne.
  // Eine ausdrueckliche Einzelregel ist die genaueste Ansage des Nutzers und
  // gewinnt in BEIDE Richtungen, auch gegen die Ausnahme unten.
  if (d.override) return d.override
  if (BACKGROUND_AGENT_TOOLS.has(toolName)) return 'auto'
  if (WORKSPACE_READ_TOOLS.has(toolName) && d.categoryLevel === 'confirm') return 'auto'
  return d.categoryLevel
}
