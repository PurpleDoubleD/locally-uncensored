/**
 * Die Fortschrittsmeldung des Rust-Downloaders, so wie sie über
 * `get_download_progress` hereinkommt.
 *
 * Audit W-T2: Die Form stand in api/discover.ts. lib/bundle-install.ts braucht
 * nur diesen Typ von dort — und discover.ts holt sich umgekehrt
 * `waitForModelsVisible` aus bundle-install.ts. Das war ein Zyklus, den
 * discover.ts mit einem `await import()` mitten in der Funktion umgangen hat
 * ("bundle-install.ts points back at this module").
 *
 * Der Typ beschreibt Daten, keine Zuständigkeit, also wohnt er hier — in einem
 * Modul, das selbst nichts importiert. discover.ts re-exportiert ihn, damit
 * kein Aufrufer seinen Importpfad ändern muss, und darf bundle-install.ts
 * seither ganz normal statisch importieren.
 */

export interface DownloadProgress {
  progress: number
  total: number
  speed: number
  filename: string
  status: 'connecting' | 'downloading' | 'pausing' | 'paused' | 'complete' | 'error'
  error?: string
}
