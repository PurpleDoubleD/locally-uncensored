import type { AgentWorkspace } from '../../types/agent-workspace'

/**
 * EIN Ordner, vier Bewerber — und die Sperre muss denselben nennen wie der
 * Systemprompt.
 *
 * Der Schnitt folgt dem GETEILTEN ZUSTAND "welcher Ordner", nicht der
 * Zeilenzahl. In useCodex.ts standen drei Rechnungen (`workspacePath`,
 * `workDir`, `runWorkspace`) untereinander, die alle dieselbe Frage
 * beantworten, und ZWEI VERBRAUCHER haengen daran, die auseinanderlaufen
 * koennen:
 *
 *   • `workDir` ist, was dem Modell im Systemprompt als Arbeitsverzeichnis
 *     GESAGT wird (und was in jeden `file_*`-Pfad und in `shell_execute.cwd`
 *     injiziert wird);
 *   • `runWorkspace` ist, was `beginAgentRun` als SPERRE setzt.
 *
 * Genau diese beiden sind am 2026-07-11 live auseinandergelaufen:
 * `resolveWorkspace()` sieht nur den Agent-Modus-Speicher pro Chat und
 * `settings.defaultWorkspace` — es SIEHT DEN ORDNER NICHT, den die
 * Explorer-Auswahl des Code-Reiters in `codexStore.workingDirectory` legt, und
 * das ist der Hauptweg, ein Repo im Code-Reiter zu waehlen. Die Sperre blieb
 * dann auf der Sandbox pro Chat stehen, waehrend dem Modell ein echter Ordner
 * genannt wurde, und jedes `file_list`/`file_read` des Arbeitsverzeichnisses
 * scheiterte mit "path escapes the allowed workspace".
 *
 * Die Zusicherung, die deshalb hier steht und nirgends sonst: fuer jede
 * Eingabe, bei der `workDir` einen echten Ordner nennt, nennt `runWorkspace`
 * DENSELBEN Pfad. Das war in der 2642-Zeilen-Datei nicht pruefbar, weil die
 * Rechnung mitten in einem 2358-Zeilen-`useCallback` stand.
 */

export interface WorkspacePrecedenceInput {
  /** `thread.workingDirectory` — die Ordnerauswahl im Datei-Baum des Reiters. */
  threadWorkingDirectory: string | null | undefined
  /** Das Ergebnis von `resolveWorkspace({ perChat, defaultWorkspace })`. */
  codexWorkspace: AgentWorkspace | null
  /** `codexStore.workingDirectory` — die globale Auswahl des Code-Reiters. */
  storeWorkingDirectory: string | null | undefined
}

export interface WorkspacePrecedence {
  /** Der Ordner-Pfad des aufgeloesten Workspace, sonst `null`. */
  workspacePath: string | null
  /** Was dem Modell gesagt wird. `'.'` bedeutet Sandbox pro Chat. */
  workDir: string
  /** Was die Sperre bekommt — im Ordnerfall derselbe Pfad wie `workDir`. */
  runWorkspace: AgentWorkspace | null
}

/**
 * Reihenfolge, unveraendert aus useCodex.ts uebernommen:
 *   1. Ausdrueckliches `thread.workingDirectory` (Datei-Baum-Auswahl)
 *   2. Der aufgeloeste Agent-Workspace-Pfad (wenn Ordner-Art)
 *   3. Globales `codexStore.workingDirectory`
 *   4. `'.'` (Sandbox pro Chat der Bruecke)
 */
export function resolveCodexWorkspace({
  threadWorkingDirectory,
  codexWorkspace,
  storeWorkingDirectory,
}: WorkspacePrecedenceInput): WorkspacePrecedence {
  const workspacePath =
    codexWorkspace && codexWorkspace.kind === 'folder' && codexWorkspace.path
      ? codexWorkspace.path
      : null
  const workDir =
    (threadWorkingDirectory && threadWorkingDirectory !== '.' ? threadWorkingDirectory : null) ||
    workspacePath ||
    storeWorkingDirectory ||
    '.'

  // Die Sperre auf DENSELBEN Ordner heften, der dem Modell genannt wird.
  // `extraPaths` ueberlebt aus dem aufgeloesten Workspace, damit ein
  // Mehr-Repo-Lauf seine Zusatzpfade behaelt.
  const runWorkspace =
    workDir && workDir !== '.'
      ? {
          kind: 'folder' as const,
          path: workDir,
          extraPaths: codexWorkspace && codexWorkspace.kind === 'folder' ? codexWorkspace.extraPaths : undefined,
        }
      : codexWorkspace

  return { workspacePath, workDir, runWorkspace }
}
