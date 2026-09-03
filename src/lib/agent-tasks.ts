/**
 * Hintergrund-Agenten: die reine Hälfte.
 *
 * Kein React, kein Store, kein Netz — nur die Regeln, nach denen eine
 * delegierte Aufgabe entsteht, altert, gemeldet und verworfen wird. Sie liegen
 * hier und nicht im Store, weil sie prüfbar sein müssen, ohne dass ein Fenster
 * offen ist: die teuersten Fehler dieses Bereichs sind Lebensdauer-Fehler, und
 * die zeigen sich in einer Rechnung, nicht in einem Screenshot.
 *
 * Das Vokabular ist bewusst dasselbe wie bei den Hintergrund-SHELL-Prozessen
 * (api/agents/bg-tasks.ts): `running`, `cancelled`, ein `[id8] phase (dauer)`
 * in der Statuszeile. Die App hat schon einen Begriff von "Hintergrundaufgabe";
 * ein zweiter, leicht anderer wäre eine Zumutung für den, der beide sieht.
 */

import { truncateToolResult } from './truncate-tool-result'

/**
 * Wie viele Aufgaben eine Konversation behält.
 *
 * Der Ring ist nicht Vorsicht, sondern ein bezahlter Fehler: `codexStore`
 * (CODEX_EVENT_LOG_MAX = 500) und `toolAuditStore` (AUDIT_MAX_PER_CONV = 500)
 * tragen beide denselben Deckel, und der Kommentar im ersten sagt warum —
 * "each terminal_output carries the UNTRUNCATED shell result … tens of
 * megabytes held for as long as the app is open". Eine Aufgabe hier hält ein
 * ganzes Modellgespräch samt Werkzeugausgaben. Ohne Ring wäre das derselbe
 * Fehler zum dritten Mal, in einem Repo, das ihn zweimal behoben hat.
 *
 * 40 und nicht 500: eine Aufgabe wiegt viel mehr als ein Auditeintrag, und
 * niemand blättert im Panel durch 500 erledigte Delegationen.
 */
export const AGENT_TASKS_MAX_PER_CONV = 40

/**
 * Was von einer einzelnen Werkzeugausgabe im Gedächtnis der Aufgabe bleibt.
 *
 * Der Sub-Agenten-Lauf legt Werkzeugergebnisse UNGEKAPPT in sein
 * Nachrichtenfeld — `registry.execute` liefert roh, und anders als die beiden
 * Hauptschleifen (useCodex, useAgentChat, beide über truncateToolResult) hat
 * er nie gekappt. Ein `file_read` auf ein 4-MB-Protokoll landete damit als
 * 4-MB-Zeichenkette in einer Store-Zeile, die niemand mehr löscht.
 *
 * 8000 statt der 1500 der Hauptschleifen: dieses Feld ist nicht die Nutzlast
 * des nächsten Aufrufs, sondern das Gedächtnis für eine mögliche Fortsetzung.
 * Es darf großzügiger sein als ein Prompt — nur nicht unbegrenzt.
 */
export const TASK_RESULT_CHARS = 8000

export type AgentTaskStatus = 'running' | 'done' | 'failed' | 'cancelled'

/**
 * Was eine Aufgabe an Tokens gekostet hat.
 *
 * ── DAS IST EIN VERBRAUCHSZAEHLER, KEIN FUELLSTAND ──────────────────────────
 *
 * Die wichtigste Zeile dieser Datei, weil die Verwechslung teuer und
 * naheliegend ist. `message.usage` (types/chat.ts:74) traegt fast dieselben
 * Felder und meint etwas anderes: dort gilt "der letzte Zug gewinnt", weil
 * `promptEvalCount` den GANZEN Kontext eines Zuges misst und der letzte Zug
 * den vollsten Prompt hatte. Das ist ein Fuellstand, und TokenCounter zeigt
 * ihn gegen das Kontextfenster.
 *
 * Hier wird SUMMIERT, ueber alle Zuege eines Agentenlaufs. Ein Agent mit
 * zwanzig Werkzeugschritten schickt den wachsenden Verlauf zwanzigmal, und
 * genau das ist, was er gekostet hat. Wer diese Summe an ein Kontextfenster
 * haelt, liest 400k auf einem 32k-Modell und meldet einen Fehler, den es
 * nicht gibt.
 *
 * Getrennte Felder statt einer Summe: bezahlt wird verschieden. Ein Prompt-
 * Token kostet bei jedem Anbieter weniger als ein erzeugtes, und ein Lauf,
 * der viel liest und wenig schreibt, sieht nur getrennt richtig aus. Kein
 * `total`-Feld daneben, weil eine mitgefuehrte Summe die dritte Zahl ist, die
 * den beiden anderen widersprechen kann. `taskTokenTotal` rechnet sie aus.
 */
export interface TaskTokens {
  prompt: number
  completion: number
  /**
   * Geraten statt gemessen.
   *
   * Kein Schoenheitsfehler: der Hermes-XML-Transport und jeder Anbieter ohne
   * `usage` liefern gar keine Zahlen, und eine Schaetzung, die sich als
   * Messung ausgibt, wird zur Abrechnungsfrage. Die Anzeige muss es zeigen
   * (`formatTaskTokens` setzt die Tilde davor).
   */
  estimated: boolean
}

/** Die Summe der beiden. Ausgerechnet und nicht mitgefuehrt, siehe oben. */
export function taskTokenTotal(t: TaskTokens | undefined): number {
  return t ? t.prompt + t.completion : 0
}

export const NO_TASK_TOKENS: TaskTokens = { prompt: 0, completion: 0, estimated: false }

/**
 * Zwei Staende zusammenzaehlen.
 *
 * DIE REGEL, DIE MAN LEICHT FALSCH BAUT: geschaetzt STECKT AN. Eine Summe aus
 * einer gemessenen und einer geratenen Haelfte ist keine gemessene Zahl, auch
 * wenn die gemessene die groessere war. Nebenan in hooks/codex/turn-usage.ts
 * steht die verwandte Regel fuer den Fuellstand ("eine SCHAETZUNG darf eine
 * ECHTE Zahl NIE ueberschreiben"); hier ist die Entsprechung fuers Summieren.
 * Ohne sie verliert ein Lauf seine Tilde beim ersten Zug, der echte Zahlen
 * meldet, und behauptet danach Genauigkeit fuer neunzehn geratene.
 */
export function addTaskTokens(a: TaskTokens | undefined, b: TaskTokens | undefined): TaskTokens {
  if (!a) return b ?? NO_TASK_TOKENS
  if (!b) return a
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    estimated: a.estimated || b.estimated,
  }
}

/** Der Stand mehrerer Aufgaben, fuers Panel. Dieselbe Ansteckungsregel. */
export function sumTaskTokens(tasks: ReadonlyArray<{ tokens?: TaskTokens }>): TaskTokens {
  return tasks.reduce<TaskTokens>((acc, t) => addTaskTokens(acc, t.tokens), NO_TASK_TOKENS)
}

/**
 * Die Zahlen EINES Modellzuges, gemessen wo moeglich, sonst geschaetzt.
 *
 * `chatWithTools` liefert `promptEvalCount`/`evalCount` (api/providers/types.ts:221),
 * aber nur, wenn der Anbieter sie meldet. Fehlen sie, wird geschaetzt und die
 * Zeile traegt es aus.
 *
 * `estimate` kommt als Argument herein und wird hier NICHT importiert. Die
 * Hausschaetzung ist `estimateTokens` (lib/context-compaction.ts:22, also
 * `ceil(Zeichen/4)+1` und nicht das blosse Zeichen/4, das man erwartet). Ihr
 * Modul zieht ueber `getProviderForModel` und `useModelStore` den halben
 * Anbieterbaum mit. agent-tasks.ts haengt bis heute an genau einem Import, und
 * das soll so bleiben, weil es die reine Haelfte dieses Bereichs ist. Eine
 * zweite eigene Schaetzformel hier waere schlimmer als der Import: dann gaebe
 * es zwei, die auseinanderlaufen koennen. Also reicht der Aufrufer die eine
 * herein.
 *
 * Eine 0 gilt als "nicht gemeldet", nicht als gemessene Null. Das ist die
 * Auslegung, die reportTurnUsage schon trifft (`if (turn.promptEvalCount ||
 * turn.evalCount)`); zwei verschiedene Auslegungen derselben 0 in einem Haus
 * waeren die schlimmere Wahl.
 */
export function tokensFromTurn(
  counts: { promptEvalCount?: number; evalCount?: number },
  texte: { prompt: string; completion: string },
  estimate: (text: string) => number,
): TaskTokens {
  const p = counts.promptEvalCount
  const c = counts.evalCount
  const echtPrompt = typeof p === 'number' && p > 0
  const echtCompletion = typeof c === 'number' && c > 0
  return {
    prompt: echtPrompt ? p : estimate(texte.prompt),
    completion: echtCompletion ? c : estimate(texte.completion),
    // Nur wenn BEIDE Haelften gemessen sind, ist die Zeile eine Messung.
    estimated: !(echtPrompt && echtCompletion),
  }
}

/**
 * Die Zahl fuers Panel, mit der Tilde bei einer Schaetzung.
 *
 * Die Tilde ist die Hauskonvention fuer eine geratene Zahl in einer engen
 * Zeile (lib/formatters.ts:23, `~${...} left`). TokenCounter.tsx traegt sie
 * NICHT: dort steht das Wort "Estimated:" im Tooltip und die Zahl bleibt
 * nackt. Das geht dort, weil daneben ein Balken steht und Platz ist; eine
 * Aufgabenzeile hat 240 Pixel und keinen Balken. Also beides: die Tilde in
 * der Zeile, das Wort im Tooltip (`describeTaskTokens`).
 *
 * Bildschirmtext, deshalb englisch.
 */
export function formatTaskTokens(t: TaskTokens | undefined): string {
  if (!t) return ''
  const gesamt = taskTokenTotal(t)
  if (gesamt <= 0) return ''
  const k = gesamt >= 1000 ? `${(gesamt / 1000).toFixed(1)}k` : String(gesamt)
  return `${t.estimated ? '~' : ''}${k} tok`
}

/** Der Tooltip dazu. Trennt die beiden Haelften und benennt die Schaetzung. */
export function describeTaskTokens(t: TaskTokens | undefined): string {
  if (!t || taskTokenTotal(t) <= 0) return ''
  const kopf = t.estimated
    ? 'Estimated tokens for this delegation'
    : 'Tokens for this delegation, as reported by the model'
  return `${kopf}: ${t.prompt.toLocaleString()} in, ${t.completion.toLocaleString()} out, summed over every step of the run`
}

/** Endzustände. Nur diese dürfen aus dem Ring fallen. */
export const TERMINAL: readonly AgentTaskStatus[] = ['done', 'failed', 'cancelled']

export function isTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL.includes(status)
}

export interface AgentTask {
  id: string
  convId: string
  goal: string
  context: string
  status: AgentTaskStatus
  /**
   * Läuft im Hintergrund, der Elternzug wartet also nicht.
   *
   * `false` heisst Vordergrund: der Elternzug steht und wartet auf die
   * Antwort (`sub-agent.ts`, `return await runner(...)`). Solche Laeufe
   * bekamen frueher gar keine Zeile. Sie waren unsichtbar, und mit ihnen
   * ihre Tokens, ihre Werkzeugzaehlung und die Zahl der Agenten, die gerade
   * arbeiten. Das Feld allein reicht nicht, damit eine Vordergrundzeile
   * gefahrlos mitlaeuft; was daran haengt, steht bei `taskAnswerDelivered`.
   */
  background: boolean
  startedAt: number
  endedAt?: number
  /** Die Antwort, sobald es eine gibt. */
  output?: string
  error?: string
  toolCalls: number
  iterations: number
  /**
   * Woran der Lauf GERADE arbeitet — die Werkzeugnamen des letzten Schritts.
   *
   * Ohne dieses Feld zeigte das Panel eine laufende Aufgabe nur als "running
   * (47s)". Das ist von "haengt fest" nicht zu unterscheiden, und genau in
   * dieser Ungewissheit bricht ein Nutzer einen Lauf ab, der gleich fertig
   * gewesen waere. Der Zaehler `toolCalls` sagt WIE VIEL, dieses Feld sagt WAS
   * — und nur das Zweite beantwortet die Frage, die der Mensch tatsaechlich
   * hat, wenn er auf den Balken schaut.
   *
   * Bewusst nur die NAMEN, nicht die Argumente: ein Pfad oder eine Suchanfrage
   * kann beliebig lang sein und stuende in einer 240 Pixel breiten Spalte
   * abgeschnitten. Und die Argumente sind Nutzerdaten — sie gehoeren in die
   * Werkzeugansicht, nicht in eine Statuszeile.
   */
  activity?: string
  /** Was der Hauptagent hineingerufen hat und der Lauf noch nicht gelesen hat. */
  inbox: string[]
  /**
   * Das Modellgespräch, für eine Fortsetzung per message_agent.
   *
   * `undefined` heißt schlicht: der Lauf hat noch nichts abgelegt. Es gibt
   * keinen Zustand "Aufgabe da, Gedächtnis verworfen" — der Ring entfernt die
   * ganze Zeile, und `message_agent` sagt dann ehrlich, dass es sie nicht mehr
   * gibt, statt stillschweigend neu anzufangen.
   *
   * Die erste Fassung behauptete diesen Zwischenzustand und hatte sogar eine
   * Funktion dafür (`forgetTaskContext`) — die nie jemand aufrief. Ein
   * Kommentar, der eine Fähigkeit verspricht, die es nicht gibt, ist
   * schlimmer als gar keiner: er wird geglaubt.
   */
  messages?: unknown[]
  /**
   * Wurde das Ende dem Elternagenten schon gemeldet?
   *
   * Gilt NUR fuer Hintergrundaufgaben. Eine Vordergrundzeile wird nie
   * gemeldet, weil ihre Antwort den Elternagenten auf dem direkten Weg
   * erreicht hat. Siehe `taskAnswerDelivered`.
   */
  reported: boolean
  /**
   * Was der Lauf gekostet hat. `undefined` heisst: noch nichts gezaehlt.
   *
   * OPTIONAL mit Absicht, und das ist eine Vertragsentscheidung, keine
   * Bequemlichkeit: `agentTaskStore.start` nimmt die Aufgabe als
   * `Omit<AgentTask, 'status' | 'inbox' | ...>`, ein Pflichtfeld hier
   * verlangte also sofort eine Aenderung an jeder Aufrufstelle in
   * sub-agent.ts. Diese Datei und sub-agent.ts sollen unabhaengig voneinander
   * geaendert werden koennen; optional macht genau das moeglich.
   */
  tokens?: TaskTokens
}

/**
 * Ist die Antwort dieser Aufgabe schon beim Elternagenten angekommen?
 *
 * ── DIE SPERRKLINKE, DIE EINE VORDERGRUNDZEILE SONST VERKANTET ──────────────
 *
 * `reported` allein beantwortet das nur fuer Hintergrundaufgaben. Bei denen
 * setzt `takeUnreported` den Merker in dem Moment, in dem die Antwort in den
 * Verlauf des Elternzugs geht. Eine VORDERGRUNDaufgabe durchlaeuft diesen Weg
 * nie: ihr Ergebnis ist der Rueckgabewert des Werkzeugaufrufs, es ist beim
 * Elternagenten, bevor die Zeile ueberhaupt fertig geschrieben ist. Ihr
 * `reported` bleibt fuer immer `false`.
 *
 * Zwei Dinge haengen daran, und beide gehen ohne diese Funktion schief:
 *
 *  1. DER RING (`applyTaskRing`) opfert in Rang 1 die, deren Antwort schon
 *     angekommen ist, und schuetzt in Rang 2 die ungelesenen. Eine
 *     Vordergrundzeile mit `reported: false` sieht wie eine ungelesene
 *     Antwort aus und geniesst den Schutz, der den wirklich ungelesenen
 *     gehoert. Vierzig fertige Vordergrunddelegationen verdraengten damit
 *     Hintergrundantworten, die noch nie jemand gesehen hat, also genau den
 *     Verlust, gegen den die zwei Raenge ueberhaupt gebaut wurden.
 *  2. DIE MELDUNG (`takeUnreported`) holt alle beendeten, ungemeldeten
 *     Zeilen. Eine Vordergrundzeile faende sich dort wieder und ginge ein
 *     ZWEITES Mal an das Modell, diesmal als `[background-task]`: dieselbe
 *     Antwort, die es eine Runde vorher schon als Werkzeugergebnis bekommen
 *     hat. Ein Agent, der seine eigene Antwort zweimal liest, korrigiert sich
 *     gegen sich selbst.
 */
export function taskAnswerDelivered(t: AgentTask): boolean {
  return !t.background || t.reported
}

/** Kappt eine Werkzeugausgabe auf das, was eine Aufgabe behalten darf. */
export function clampTaskResult(text: string): string {
  return truncateToolResult(text, TASK_RESULT_CHARS)
}

/**
 * Der Ring: was von den Aufgaben einer Konversation übrig bleibt.
 *
 * Laufende Aufgaben fallen NIE heraus, egal wie viele es sind. Der Deckel ist
 * gegen Anhäufung gedacht, nicht gegen Nebenläufigkeit — die begrenzt
 * SUB_AGENT_MAX_PARALLEL, und zwar an der einzig richtigen Stelle: bevor
 * gestartet wird. Eine laufende Aufgabe hier wegzuwerfen hieße, ihren
 * Abbruchknopf wegzuwerfen, während sie weiterrechnet.
 */
export function applyTaskRing(tasks: AgentTask[], max = AGENT_TASKS_MAX_PER_CONV): AgentTask[] {
  if (tasks.length <= max) return tasks
  const ueberzaehlig = tasks.length - max

  // Zwei Ränge, und der zweite ist der eigentliche Fund.
  //
  // Die erste Fassung opferte die ältesten BEENDETEN Aufgaben, ohne zu
  // fragen, ob ihre Antwort schon jemanden erreicht hat. Ein Wächter hat das
  // gemessen: 45 laufende Aufgaben, dann `finish` auf eine — und genau die
  // eben fertig gewordene fiel im selben Zug aus dem Ring, weil sie die
  // älteste beendete war. Ihre Antwort war weg, bevor `takeUnreported` sie je
  // gesehen hatte. Kein Fehler, keine Zeile im Protokoll: ein Agent hat
  // gearbeitet, und niemand hat je erfahren, was herauskam.
  //
  // Also: erst die, deren Antwort schon angekommen ist. Eine ungemeldete
  // Antwort ist kein Altpapier, sondern das Einzige, was von der Arbeit übrig
  // ist. Sie geht erst, wenn gar nichts anderes mehr da ist — und dann ist
  // der Speicher wirklich das kleinere Übel.
  //
  // `taskAnswerDelivered` und nicht `t.reported`: eine Vordergrundzeile wird
  // nie gemeldet und traegt den Merker deshalb ewig auf `false`. Am rohen
  // Merker gemessen saesse sie im Schutzrang der ungelesenen Antworten und
  // verdraengte genau die. Die Begruendung steht ganz bei der Funktion.
  const opferbar = (t: AgentTask, rang: 1 | 2) =>
    isTerminal(t.status) && (rang === 1 ? taskAnswerDelivered(t) : true)

  let weg = 0
  const raus = new Set<string>()
  for (const rang of [1, 2] as const) {
    for (const t of tasks) {
      if (weg >= ueberzaehlig) break
      if (raus.has(t.id)) continue
      if (opferbar(t, rang)) { raus.add(t.id); weg++ }
    }
    if (weg >= ueberzaehlig) break
  }
  // Laufende bleiben immer. Der Deckel ist gegen Anhäufung, nicht gegen
  // Nebenläufigkeit — die begrenzt SUB_AGENT_MAX_PARALLEL, bevor gestartet
  // wird. Eine laufende Aufgabe hier wegzuwerfen hieße, ihren
  // Abbrechen-Knopf wegzuwerfen, während sie weiterrechnet.
  return tasks.filter((t) => !raus.has(t.id))
}

/**
 * Sekunden — abgeschnitten, nicht gerundet.
 *
 * `Math.floor` und nicht `Math.round`, weil renderBgStatusOneLine bei den
 * Shell-Aufgaben abschneidet. Der Kopf dieser Datei verspricht, dass beide
 * Panels gleich lesen; mit Runden läse eine 2,6-Sekunden-Aufgabe hier "3s"
 * und dort "2s". Ein Versprechen, das an der zweiten Nachkommastelle bricht,
 * ist keins.
 */
export function taskElapsedSeconds(t: AgentTask, now: number): number {
  const ende = t.endedAt ?? now
  return Math.max(0, Math.floor((ende - t.startedAt) / 1000))
}

/**
 * Eine Zeile über eine Aufgabe, für das Modell und fürs Panel.
 *
 * ── DIE KENNUNG STEHT GANZ DA, UND ZWAR MIT ABSICHT ────────────────────────
 *
 * Hier stand `t.id.slice(0, 8)` — abgeschaut von den Shell-Hintergrund-
 * aufgaben, wo die Kennung ein Zufalls-Hash ist und acht Zeichen davon
 * eindeutig bleiben. Bei einer Agentenaufgabe heisst sie aber
 * `task-<lfd>-<zufall6>`, und acht Zeichen davon sind:
 *
 *     task-1-a4f2k9   →   "task-1-a"
 *     task-12-b7c3d1  →   "task-12-"
 *     task-100-e9f0a2 →   "task-100"
 *
 * Der Zufallsteil — der einzige, der ueberhaupt unterscheidet — faellt in
 * jedem Fall weg. Das war nicht nur haesslich: `check_tasks` gibt diese Zeile
 * an das MODELL, und `message_agent` verlangt danach die Kennung zurueck. Das
 * Modell las `task-1-a`, schickte `task-1-a` und bekam "unbekannte Aufgabe" —
 * eine Sackgasse, die aussieht, als haette der Agent nicht existiert.
 *
 * Gefunden erst durch eine Ueberpruefung von aussen, weil der Test dieser
 * Zeile Kennungen wie `task-a1b2c3d4` benutzte: eine Form, die es in der App
 * nirgends gibt. Ein Test mit erfundenen Eingaben prueft die eigene Erfindung.
 * Die Sperrklinke baut ihre Kennungen jetzt mit `makeTaskId`, derselben
 * Funktion, die auch der Lauf benutzt.
 */
export function renderTaskOneLine(t: AgentTask, now: number): string {
  const phase = t.status === 'running'
    ? 'running'
    : t.status === 'done'
      ? 'ok'
      : t.status
  return `[${t.id}] ${phase} (${taskElapsedSeconds(t, now)}s), ${t.goal}`
}

/**
 * Die Kennung einer Agentenaufgabe.
 *
 * Steht hier und nicht in sub-agent.ts, damit die Sperrklinken dieselbe Form
 * bauen koennen wie der Lauf — der abgeschnittene Kurzname oben ueberlebte
 * genau deshalb so lange, weil die Tests eine andere Form erfanden.
 */
export function makeTaskId(seq: number): string {
  return `task-${seq}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Die Meldung, die der Elternagent über fertige Hintergrundaufgaben bekommt.
 *
 * Sie geht als NUTZER-Material in den Verlauf, und das ist die tragende
 * Entscheidung dieses ganzen Bereichs:
 *
 *  - Als `role:'system'` ginge es nicht: eine Systemnachricht an anderer
 *    Stelle als Index 0 lehnen strenge Jinja-Vorlagen ab ("System message must
 *    be at the beginning"). Dieselbe Regel, an der schon die
 *    Verdichtungsnotiz hängt (context-compaction.ts).
 *  - Als `role:'tool'` ginge es auch nicht: die braucht eine `tool_call_id`,
 *    die zu einem WIRKLICH gestellten Aufruf gehört. Eine erfundene lässt
 *    openai, anthropic und lu-cloud mit 400/422 abbrechen — genau der Fehler,
 *    den sub-agent.ts sich beim Zuordnen doppelter Aufrufe schon einmal
 *    eingefangen hat.
 *
 * Nutzer-Material ist auf allen drei Werkzeugschemata (native, template_fix,
 * hermes_xml) und allen vier Anbietern gleich gültig. Es ist der einzige
 * Kanal, der überall funktioniert.
 */
export function renderTaskReport(fertige: AgentTask[], now: number): string {
  if (!fertige.length) return ''
  const zeilen = fertige.map((t) => {
    const kopf = renderTaskOneLine(t, now)
    const leib = t.status === 'done'
      ? (t.output || '(no answer)')
      : (t.error || `(${t.status})`)
    return `${kopf}\n${leib}`
  })
  const wort = fertige.length === 1 ? 'task' : 'tasks'
  return `[background-${wort}]\n${zeilen.join('\n\n')}\n[/background-${wort}]`
}


/**
 * Die Aktivitaetszeile aus den Werkzeugaufrufen eines Schritts.
 *
 * Eigene Funktion, weil hier drei Entscheidungen stecken, die man sonst
 * nirgends nachlesen und nirgends pruefen koennte — in `sub-agent.ts` waeren
 * sie eine Zeile im Vorbeigehen, und der ganze Lauf dort hat keinen Test,
 * weil er eine Modellantwort braucht.
 *
 *  1. DOPPELTE ZUSAMMENFASSEN. Ein Schritt, der drei Dateien liest, ist
 *     "read_file", nicht "read_file, read_file, read_file". Die Wiederholung
 *     traegt keine Auskunft und frisst die Spaltenbreite.
 *  2. NAMENLOSES WEGLASSEN, ABER NICHT VERSCHWEIGEN. Ein Aufruf ohne Namen
 *     kommt vor (kaputtes Werkzeug-JSON eines kleinen Modells). Ihn
 *     stillschweigend zu schlucken hiesse: leere Zeile, obwohl gearbeitet
 *     wird. Bleibt nach dem Filtern nichts uebrig, steht dort 'working'.
 *  3. KAPPEN. Ein Schritt mit acht verschiedenen Werkzeugen ergaebe eine
 *     Zeile, die in keine 240-Pixel-Spalte passt; abgeschnitten mitten im
 *     Namen liest sie sich wie ein anderes Werkzeug.
 */
export const ACTIVITY_MAX_TOOLS = 3

export function describeToolCalls(namen: ReadonlyArray<string | undefined>): string {
  const echte = [...new Set(namen.filter((n): n is string => !!n && n.trim() !== ''))]
  if (echte.length === 0) return 'working'
  if (echte.length <= ACTIVITY_MAX_TOOLS) return echte.join(', ')
  return `${echte.slice(0, ACTIVITY_MAX_TOOLS).join(', ')} +${echte.length - ACTIVITY_MAX_TOOLS}`
}
