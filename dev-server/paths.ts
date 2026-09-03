/**
 * Der Projektstamm, von den Dev-Server-Modulen aus gesehen.
 *
 * Diese Rechnung stand als `const __dirname = dirname(fileURLToPath(
 * import.meta.url))` in `vite.config.ts`, und weil DIESE Datei im Stamm liegt,
 * traf `resolve(__dirname, '.env')` dort die richtige Datei. Die Module hier
 * liegen eine Ebene tiefer: ohne das `..` schriebe /local-api/set-comfyui-path
 * seinen COMFYUI_PATH nach `dev-server/.env`, wo dotenv ihn nie wieder liest,
 * und /local-api/transcribe suchte `whisper_server.py` im falschen Ordner.
 */
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

/** Der Ordner, in dem package.json und vite.config.ts liegen. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Dieselbe .env, die vite.config.ts beim Start lädt. */
export const ENV_FILE = resolve(PROJECT_ROOT, '.env')
