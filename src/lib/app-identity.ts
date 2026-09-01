/**
 * Die Namen der app-eigenen Verzeichnisse — TypeScript-Seite.
 *
 * Spiegel von `src-tauri/src/app_identity.rs`. Die ausführliche Begründung
 * steht dort; kurz: dieser Branch (`experiment/audits-komplett`) hat BEWUSST
 * eigene Verzeichnisse, weil der Experiment-Build am 2026-08-31 in das
 * Datenverzeichnis der ECHTEN App geschrieben und dort ein Store-Backup
 * überschrieben hat.
 *
 * Zwei Sprachen, zwei Dateien — unvermeidlich, aber nicht unbeaufsichtigt:
 * `__tests__/app-identity.test.ts` liest die Rust-Konstanten aus
 * `app_identity.rs` und schlägt fehl, sobald die beiden Seiten auseinander
 * laufen. Sie MÜSSEN übereinstimmen: die Rust-Seite (Tauri-App) und die
 * TS-Seite (`npm run dev` im Browser, vite-Middlewares) legen dieselben
 * Dateien an, und ein Jail, das anders rechnet als der Ordner, in den
 * geschrieben wird, lehnt jeden Zugriff ab.
 *
 * In der echten App gehört hier der Name OHNE Suffix hin.
 */

/**
 * Sandkasten-Wurzel der Agenten unter `$HOME`.
 * Rust: `app_identity::AGENT_WORKSPACE_DIR`.
 */
export const AGENT_WORKSPACE_DIR = 'agent-workspace-experiment'

/**
 * Ordner der `config.json` (ComfyUI-Pfad/-Port, Ollama-Basis).
 * Rust: `app_identity::APP_CONFIG_DIR`.
 */
export const APP_CONFIG_DIR = 'locally-uncensored-experiment'

/**
 * Haupt-Datenverzeichnis (Daten, Cache, Config).
 * Rust: `app_identity::APP_DIR`.
 *
 * Auf der TS-Seite bisher nur zur Vollständigkeit — sobald eine
 * vite-Middleware dorthin greift, kommt der Name von hier.
 */
export const APP_DIR = 'lu-labs-experiment'

/**
 * Anzeige-Schreibweise (Modellordner der eingebauten Engine,
 * `%APPDATA%`-Ordner der Store-Backups).
 * Rust: `app_identity::APP_DISPLAY_DIR`.
 */
export const APP_DISPLAY_DIR = 'Locally Uncensored-experiment'
