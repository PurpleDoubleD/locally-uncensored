import { backendCall } from '../../api/backend'
import type { RulesReader } from '../../lib/lurules'

/**
 * Der EINE Dateizugriff des Coding-Agenten, der den echten Projektordner sieht.
 *
 * Der Schnitt folgt keiner Zeilenzahl: VIER Stellen in useCodex.ts brauchten
 * dieselbe Regel, und drei davon trugen den identischen Ausdruck woertlich noch
 * einmal —
 *
 *   workDir && workDir !== '.'
 *     ? { chatId: workspaceSlug, workingDirectory: workDir }
 *     : { chatId: workspaceSlug }
 *
 * einmal fuer die Vorlese-Runde vor `file_write` (`readCtx`), einmal in
 * `stageFileWrite` und einmal in `stageFileEdit` (`stageReadCtx`). Drei Kopien
 * einer Regel, die in allen drei Faellen dasselbe entscheiden muss, sind genau
 * der Fall, den ZB-7 nach nebenan legt statt in eines der drei.
 *
 * WAS DIE REGEL ENTSCHEIDET, steht in den Kommentaren der drei alten Kopien und
 * gilt hier einmal: es MUSS `fs_read` sein, der werkstattbewusste Befehl, nicht
 * das aeltere `file_read`. `file_read` sperrt jeden Pfad in die Sandbox pro Chat
 * (`agent-workspace/<id>`) und WEIST damit den absoluten Projektpfad ZURUECK.
 * Diese stille Ablehnung hat zweimal etwas gekostet:
 *
 *   • `.lurules` wurde in einem echten Ordner-Workspace nie geladen, weil der
 *     absolute Regelpfad an der Sperre haengenblieb;
 *   • jede Vorlese-Runde lieferte '' zurueck, und jeder Unterschied, den der
 *     Nutzer VOR dem Freigeben sehen sollte, wurde als 100 % Einfuegung
 *     gezeichnet — die Loeschungen und Ueberschreibungen waren unsichtbar.
 *
 * `workingDirectory` setzt die Wurzel der Sperre auf den wirklichen
 * Projektordner, und deshalb loest sich der absolute Pfad dort auf.
 *
 * DER UNTERSCHIED ZWISCHEN DEN BEIDEN FORMEN IST ABSICHT, nicht Nachlaessigkeit:
 * `makeLurulesReader` reicht `workingDirectory` IMMER durch, auch als '.',
 * waehrend `codexReadCtx` das Feld im Sandbox-Fall weglaesst. Beide Formen sind
 * hier unveraendert uebernommen; eine Vereinheitlichung waere eine
 * Verhaltensaenderung und gehoert nicht in eine Umstrukturierung.
 */

/** Der Kontext, den `fs_read` braucht, um im echten Ordner zu lesen. */
export interface CodexFsCtx {
  chatId?: string
  workingDirectory?: string
}

/** Was `fs_read` zurueckgibt, soweit der Coding-Agent es liest. */
export interface CodexFileRead {
  content?: string
  encoding?: string
}

/**
 * Der Lesekontext fuer einen Lauf: im Ordner-Workspace mit Wurzel, in der
 * Sandbox ohne. Frueher dreimal woertlich in useCodex.ts.
 */
export function codexReadCtx(workspaceSlug: string, workDir: string): CodexFsCtx {
  return workDir && workDir !== '.'
    ? { chatId: workspaceSlug, workingDirectory: workDir }
    : { chatId: workspaceSlug }
}

/** Ein Lesevorgang ueber den werkstattbewussten Befehl. */
export function readWorkspaceFile(path: string, ctx: CodexFsCtx): Promise<CodexFileRead> {
  return backendCall<CodexFileRead>('fs_read', { path, ...ctx })
}

/**
 * Der Leser, den `loadLurules` erwartet. Fehler fallen weiterhin auf `null`
 * zurueck, damit `loadLurules()` "Datei fehlt" und "Lesefehler" gleich
 * behandelt und die Codex-Schleife trotzdem startet.
 */
export function makeLurulesReader(chatId: string, workDir: string): RulesReader {
  return {
    async read(path: string): Promise<string | null> {
      try {
        const r = await backendCall<{ content?: string }>('fs_read', {
          path,
          chatId,
          workingDirectory: workDir,
        })
        return r?.content ?? null
      } catch {
        return null
      }
    },
  }
}
