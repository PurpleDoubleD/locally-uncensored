/**
 * Zielpfade der Modell-Download-Endpunkte des Dev-Servers — mit Käfig.
 *
 * SICHERHEITSBEFUND, deshalb gibt es diese Datei. Vier Endpunkte in
 * `vite.config.ts` bauten einen Pfad aus Feldern des Request-Körpers und
 * schrieben oder lasen dann mit echten fs-Aufrufen darauf:
 *
 *   POST /local-api/download-model      { subfolder, filename }
 *   POST /local-api/resume-download     { subfolder, id }
 *   POST /local-api/check-model-sizes   { files: [{ subfolder, filename }] }
 *   POST /local-api/install-custom-node { nodeName, repoUrl }
 *
 * Keiner davon prüfte den Wert. `join(comfyPath, 'models', subfolder)` mit
 *
 *   { "url": "http://…/beliebig", "subfolder": "../../../../../..",
 *     "filename": ".ssh/authorized_keys" }
 *
 * legt die heruntergeladene Datei irgendwo ausserhalb von ComfyUI ab —
 * `node:path.join` normalisiert `..` klaglos weg. Der Dev-Server ist kein
 * Entwickler-Spielzeug: `setup.sh`/`start.bat` liefern ihn als Laufzeit des
 * Benutzers aus.
 *
 * Die Regel ist dieselbe wie in `src/lib/dev-fs-jail.ts` (dem Port der
 * Rust-Grenze): ein Wurzelverzeichnis, und alles muss lexikalisch darin
 * liegen. Nur die Wurzel ist hier eine andere — nicht der Agenten-Arbeitsordner,
 * sondern die ComfyUI-Installation.
 *
 * REINE STRINGS, ABSICHTLICH: kein `node:path`, kein `node:fs` — dieselbe
 * Regel, unter der `dev-fs-jail.ts` steht, damit das Modul in `src` neben
 * seinem Test liegen kann.
 */

import { containWithin, lexicalNormalize } from '../lib/dev-fs-jail'

/**
 * Wann gilt ein `subfolder` als Pfad in `custom_nodes/` statt in `models/`?
 *
 * Die drei Endpunkte haben das nie gleich entschieden, und das bleibt hier
 * sichtbar statt stillschweigend vereinheitlicht zu werden:
 *
 *   'separator' — `/local-api/download-model`: nur mit Trenner dahinter
 *                 (`custom_nodes/foo`), so wie es dort stand.
 *   'prefix'    — `/local-api/check-model-sizes`: schon der blosse Präfix
 *                 (`custom_nodes_alt` zählte dort mit).
 *   'never'     — `/local-api/resume-download`: kannte den Fall gar nicht,
 *                 alles landete unter `models/`.
 */
export type CustomNodeRule = 'separator' | 'prefix' | 'never'

function isCustomNodeSubfolder(subfolder: string, rule: CustomNodeRule): boolean {
  if (rule === 'never') return false
  if (rule === 'prefix') return subfolder.startsWith('custom_nodes')
  return /^custom_nodes[/\\]/.test(subfolder)
}

/**
 * Der Zielpfad einer Modell-Datei innerhalb der ComfyUI-Installation.
 *
 * Wirft `JailEscapeError` (aus `dev-fs-jail`), sobald `subfolder` oder
 * `filename` aus der Wurzel herausführen — die Wurzel ist `<comfy>/models`
 * bzw. `<comfy>` für die `custom_nodes`-Zweige.
 */
export function comfyDestPath(
  comfyPath: string,
  subfolder: string,
  filename: string,
  rule: CustomNodeRule,
): string {
  const root = isCustomNodeSubfolder(subfolder, rule)
    ? lexicalNormalize(comfyPath)
    : lexicalNormalize(`${comfyPath}/models`)
  return containWithin(root, `${subfolder}/${filename}`)
}

/**
 * Der Zielpfad von `/local-api/download-model-to-path`.
 *
 * `destDir` ist hier ABSICHTLICH frei: der Endpunkt existiert, um ein GGUF
 * neben eine fremde Installation zu legen (LM Studio, Jan, …), und das
 * Verzeichnis kommt aus `/local-api/detect-model-path`. Was NICHT frei sein
 * muss, ist `filename` — ein `../` darin hat mit dem Zweck nichts zu tun.
 * Der Käfig ist deshalb `destDir` selbst.
 */
export function downloadToPathDest(destDir: string, filename: string): string {
  return containWithin(lexicalNormalize(destDir), filename)
}

/**
 * `basename(url, '.git')` ohne `node:path`: das letzte Segment hinter `/`
 * oder `\`, ohne die Endung `.git`.
 */
export function repoBasename(repoUrl: string): string {
  const last = repoUrl.split(/[/\\]/).filter((s) => s !== '').pop() ?? ''
  return last.endsWith('.git') ? last.slice(0, -4) : last
}

/**
 * Das Zielverzeichnis von `/local-api/install-custom-node`.
 *
 * `nodeName` kam ungeprüft aus dem Körper und wurde an `custom_nodes/`
 * angehängt; `nodeName: '../../..'` liess `git clone` ausserhalb von ComfyUI
 * landen. Fällt `nodeName` weg, entscheidet der letzte Pfadteil der Repo-URL —
 * der ist genauso fremd und wandert durch denselben Käfig.
 */
export function customNodeDir(comfyPath: string, nodeName: string, repoUrl: string): string {
  const root = lexicalNormalize(`${comfyPath}/custom_nodes`)
  const name = nodeName.trim() || repoBasename(repoUrl)
  if (!name) throw new Error('Missing nodeName and unusable repoUrl')
  return containWithin(root, name)
}

/**
 * Die Kandidaten-Verzeichnisse von `/local-api/detect-model-path`, als
 * Segmente RELATIV zum Home-Verzeichnis.
 *
 * Spiegelt die Verzweigung des Rust-Kommandos (`commands/download.rs`
 * `detect_model_path`). Ein unbekannter Anbieter bekommt eine leere Liste und
 * fällt beim Aufrufer in das app-eigene Modellverzeichnis — genau wie dort.
 */
export function modelDirCandidates(provider: string): string[][] {
  const asked = provider.toLowerCase()
  if (asked === 'ollama') return [['.ollama', 'models']]
  if (asked === 'lm studio' || asked === 'lmstudio') {
    return [
      ['.lmstudio', 'models'],
      ['.cache', 'lm-studio', 'models'],
      ['AppData', 'Local', 'LM Studio', 'models'],
      ['.local', 'share', 'lm-studio', 'models'],
    ]
  }
  if (asked === 'jan') return [['.jan', 'models'], ['jan', 'models']]
  if (asked === 'gpt4all') return [['.cache', 'gpt4all']]
  return []
}
