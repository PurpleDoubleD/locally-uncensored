/**
 * Ein Zug ohne Werkzeugaufruf: fertig oder steckengeblieben?
 *
 * Der Schnitt folgt nicht der Zeilenzahl, sondern der ENTSCHEIDUNG: drei
 * unabhaengige Muster ueber DENSELBEN Text (`turnContent`) ergeben zusammen
 * genau eine Weiche — Schleife weiter oder abbrechen. In useCodex.ts standen
 * die drei Regexe inline in einem `if`-Zweig eines 2358-Zeilen-`useCallback`,
 * und damit war keine von ihnen einzeln erreichbar, obwohl jede eine
 * dokumentierte Geschichte von FEHLALARMEN hat:
 *
 *  • Die frueher umgekehrte Fassung ("anstupsen, ausser ein Abschlusswort
 *    kommt vor") drehte bei bereits beantworteten Fragen durch — David
 *    2026-06-02: der Coding-Agent "antwortet in loops" auf eine simple Frage,
 *    weil "completed" nie auf den Abschluss-Regex passte.
 *
 *  • `asksForInfo` muss "could you please verify the correct path to sum.js?"
 *    fangen (qwen2.5-coder:7b, 2026-06-02) und "I fixed it, please verify the
 *    changes" IN RUHE LASSEN. Deshalb haengt der verify/confirm/clarify-Zweig
 *    an einem Pfad- oder Datei-HAUPTWORT und nicht am Verb allein.
 *
 *  • Ein LEERER Zug stupst nur, wenn noch NICHTS geliefert wurde. Leer NACH
 *    einer echten Antwort heisst fertig; anders blieben die Schreibpunkte
 *    stehen, lange nachdem die Antwort da war (David 2026-06-12: "die punkte
 *    bleiben so lange obwohl keine antwort mehr kam").
 *
 * Die Muster sind woertlich uebernommen. Das Urteil ist eine reine Funktion
 * von (Zugtext, bisherige Antwort).
 */

export interface StallVerdict {
  /** Das Modell hat den naechsten Schritt ERZAEHLT statt ihn zu tun. */
  stalledNarration: boolean
  /** Das Modell fragt nach etwas, das es selbst finden koennte. */
  asksForInfo: boolean
  /** Gar kein Text. */
  emptyTurn: boolean
  /** Das Urteil: anstupsen statt abbrechen. */
  nudgeWorthy: boolean
}

export function codexStallVerdict(turnContent: string, fullContent: string): StallVerdict {
  // Nudge ONLY when the model clearly STALLED mid-task — it narrated the
  // next step ("I'm about to…", "let me…", "next I'll…", "I need to read…")
  // or asked for info it could find itself ("please provide the path",
  // "which file?"), or returned no text at all. A substantive ANSWER
  // matches none of these, so simple Q&A ("2+2 is 4" / "Task completed.
  // The answer is 4.") stops cleanly.
  const stalledNarration = /\b(i(?:'?m| am) about to|i will(?: now)?|i'?ll\b|let me\b|next,?\s*i\b|now i'?ll|going to|first,?\s*i\b|then i'?ll|i (?:need|have|am going) to (?:read|open|check|look|run|see|find))\b/i.test(turnContent)
  // "asksForInfo" also catches the model giving up by asking the user to
  // VERIFY/CONFIRM a path it can discover itself. The verify/confirm/clarify
  // branch is anchored on a path/file NOUN so a genuine completion
  // ("I fixed it, please verify the changes") does NOT match — only
  // "verify the (correct) path/file/location" does.
  const asksForInfo = /\b(please provide|could you (?:please )?(?:provide|share|tell|give|specify|verify|confirm|clarify)|what(?:'s| is) the (?:path|file|name|location)|which file|can you (?:provide|share|specify|tell)|provide (?:the|me) (?:the )?(?:path|file|details|more)|(?:verify|confirm|clarify) (?:the )?(?:correct |right |exact |full )?(?:path|file ?path|location|directory|filename|file name)|need (?:the|more) (?:path|info|details|context))\b/i.test(turnContent)
  const emptyTurn = turnContent.trim().length === 0
  // Only nudge an empty turn when NOTHING has been produced yet (a true
  // early stall). An empty turn AFTER a real answer means the model is
  // finished. Read-only report commands (/review, /explain …) legitimately
  // end on a text answer + an empty follow-up turn.
  const nudgeWorthy = stalledNarration || asksForInfo || (emptyTurn && !fullContent.trim())
  return { stalledNarration, asksForInfo, emptyTurn, nudgeWorthy }
}
