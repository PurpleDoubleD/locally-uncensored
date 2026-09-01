/**
 * Die Datenform einer vorgemerkten Dateiänderung (Stage-and-Approve).
 *
 * Audit W-T2: Die Form stand in stores/stagedChangesStore.ts, und
 * lib/staged-overlay.ts holte sie sich von dort — während der Store umgekehrt
 * `normalizeStagedPath` aus dem Overlay zieht. Zwei Module, die sich
 * gegenseitig importieren, nur weil eine Typdeklaration im falschen Haus
 * wohnte.
 *
 * Der Typ ist reine Beschreibung: er beschreibt, was gestaged wurde, nicht wer
 * es hält. Also gehört er in ein blattnahes Modul, das selbst nichts
 * importiert — Store und Overlay lesen beide von hier. stagedChangesStore
 * exportiert `StagedChange` weiterhin re-exportierend, damit kein Aufrufer
 * seinen Importpfad ändern muss.
 */

export interface StagedChange {
  /** Stable id assigned at stage-time so the UI can key + remove safely. */
  id: string
  /** Path the model called `file_write` with (as the model wrote it — may be relative). */
  path: string
  /**
   * Absolute path resolved against the run's workspace AT STAGE TIME. Apply
   * happens after the run ends, when useCodex's finally has cleared the active
   * chat/workspace context — so a relative `path` would route to
   * agent-workspace/default/ instead of the project folder the agent wrote into.
   * Writing this captured absolute path makes the approved diff land exactly
   * where it should. Falls back to `path` (already absolute / no workspace set).
   */
  resolvedPath?: string
  /**
   * The run's workspace root, captured AT STAGE TIME. Apply runs after the loop
   * ends, when the active chat/workspace context is cleared — so without this
   * the write jails to agent-workspace/default and REJECTS the absolute project
   * path ("escapes the allowed workspace"), silently failing every apply into a
   * real folder. The apply path (a trusted, user-gated UI action) passes this
   * as fs_write's working_directory so the jail root is the real project folder.
   * Undefined for sandbox-mode runs (no real folder), where the per-chat
   * sandbox is the correct root anyway.
   */
  workingDirectory?: string
  /** Full file content before the write — empty string when the target didn't exist. */
  oldContent: string
  /** Full file content the model wants to write. */
  newContent: string
  /** Pre-computed unified diff for snappy rendering — caller decides format. */
  diff: string
  /** Wall-clock when the model staged this change. */
  stagedAt: number
}
