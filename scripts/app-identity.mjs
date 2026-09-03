/**
 * Verzeichnisnamen dieses Builds für die Node-Skripte (Smoke-Harnesse).
 *
 * Kein dritter Ort mit denselben Strings: die Namen werden aus
 * `src/lib/app-identity.ts` GELESEN, das seinerseits gegen
 * `src-tauri/src/app_identity.rs` getestet wird
 * (`src/lib/__tests__/app-identity.test.ts`).
 *
 * Hintergrund: dieser Branch (`experiment/audits-komplett`) hat bewusst eigene
 * Datenverzeichnisse, weil der Experiment-Build am 2026-08-31 in das
 * Verzeichnis der ECHTEN App geschrieben hat. Die Zusicherungen in den
 * Smoke-Skripten ("der Pfad liegt NICHT im Standard-Sandkasten") wären mit
 * einem fest verdrahteten `agent-workspace` still immer erfüllt und würden
 * nichts mehr fangen.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(resolve(repoRoot, 'src/lib/app-identity.ts'), 'utf8')

function readConst(name) {
  const m = new RegExp(`export const ${name} = '([^']+)'`).exec(src)
  if (!m) throw new Error(`${name} nicht in src/lib/app-identity.ts gefunden`)
  return m[1]
}

/** Sandkasten-Wurzel der Agenten unter `$HOME` (ohne Home-Präfix). */
export const AGENT_WORKSPACE_DIR = readConst('AGENT_WORKSPACE_DIR')

/** Der Ordner, in den ein Remote-Aufruf OHNE gewählten Projektordner fiele. */
export const REMOTE_FALLBACK_DIR = `${AGENT_WORKSPACE_DIR}/__remote__`
