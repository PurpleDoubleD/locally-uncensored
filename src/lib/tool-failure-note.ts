// Was das Modell zu sehen bekommt, wenn ein Werkzeug NICHT gelaufen ist.
//
// Persona-Lauf vom 03.09.2026, `llama3.2:3b`, zwei Faelle derselben Sorte:
//
//   • `shell_execute` brach mit `task "status" needs a task_id` ab — der
//     Befehl lief nie. Der Assistent nannte trotzdem `10.15` als
//     Betriebssystemversion. Richtig waere `26.3.1` gewesen.
//   • `web_search` lieferte fuenf Trefferlisten ohne Antwort. Der Assistent
//     erfand einen Namen UND schob eine Wikipedia-Seite als Beleg unter, die
//     er nie geoeffnet hatte.
//
// Ihr Satz dazu: sie merkt es nur, wenn sie die Werkzeugkarte aufklappt und
// den Fehler selbst liest. Genau deshalb steht hier ein Satz mehr in der
// Historie: der Fehltext allein ("needs a task_id") sagt einem kleinen Modell
// nicht, dass es jetzt NICHT raten soll.
//
// Vorbild ist D#81: nach einer fehlgeschlagenen Bildgenerierung wurde die
// „liegt auf dem Schirm"-Notiz weggelassen, weil genau sie das Modell dazu
// brachte, ein Bild anzukuendigen, das es nie gab. Dasselbe Prinzip, andere
// Richtung.
//
// GRENZE, ehrlich: dass der Satz ANKOMMT, ist pruefbar und geprueft. Ob ein
// 3B-Modell daraufhin wirklich aufhoert zu erfinden, ist es nicht — das
// entscheidet das Modell.

/** Der Zusatz fuer einen Werkzeuglauf, der nicht geliefert hat. Leer, wenn alles gut ging. */
export function toolFailureNote(status: string): string {
  // 'rejected' hat schon einen eigenen, staerkeren Satz ("User rejected this
  // action") — ein zweiter davor waere nur Laerm.
  if (status !== 'failed' && status !== 'error' && status !== 'timeout') return ''
  return '\n\nThis tool did NOT run, so there is no output. Do not state or guess what it would have returned. Either call it again with corrected arguments, or tell the user plainly that this step failed.'
}
