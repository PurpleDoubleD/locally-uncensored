/**
 * Die Namen der app-eigenen Verzeichnisse, TypeScript-Seite.
 *
 * Spiegel von `src-tauri/src/app_identity.rs`. Die ausführliche Begründung
 * steht dort; kurz: die Namen standen als Literale an acht Stellen im
 * Quelltext, und ein Build, der sich verrechnet, schreibt in ein fremdes
 * Datenverzeichnis. Genau das ist am 2026-08-31 passiert und hat dort ein
 * Store-Backup überschrieben.
 *
 * Zwei Sprachen, zwei Dateien, unvermeidlich, aber nicht unbeaufsichtigt:
 * `__tests__/app-identity.test.ts` liest die Rust-Konstanten aus
 * `app_identity.rs` und schlägt fehl, sobald die beiden Seiten auseinander
 * laufen. Sie MÜSSEN übereinstimmen: die Rust-Seite (Tauri-App) und die
 * TS-Seite (`npm run dev` im Browser, vite-Middlewares) legen dieselben
 * Dateien an, und ein Jail, das anders rechnet als der Ordner, in den
 * geschrieben wird, lehnt jeden Zugriff ab.
 */

/**
 * Sandkasten-Wurzel der Agenten unter `$HOME`.
 * Rust: `app_identity::AGENT_WORKSPACE_DIR`.
 */
export const AGENT_WORKSPACE_DIR = 'agent-workspace'

/**
 * Ordner der `config.json` (ComfyUI-Pfad/-Port, Ollama-Basis).
 * Rust: `app_identity::APP_CONFIG_DIR`.
 */
export const APP_CONFIG_DIR = 'locally-uncensored'

/**
 * Haupt-Datenverzeichnis (Daten, Cache, Config).
 * Rust: `app_identity::APP_DIR`.
 *
 * Auf der TS-Seite bisher nur zur Vollständigkeit — sobald eine
 * vite-Middleware dorthin greift, kommt der Name von hier.
 */
export const APP_DIR = 'lu-labs'

/**
 * Anzeige-Schreibweise (Modellordner der eingebauten Engine,
 * `%APPDATA%`-Ordner der Store-Backups).
 * Rust: `app_identity::APP_DISPLAY_DIR`.
 */
export const APP_DISPLAY_DIR = 'Locally Uncensored'
