// Kopiert die Wasm-Dateien der Gesichtserkennung (MediaPipe Tasks Vision,
// exakt gepinnt in package.json) aus node_modules nach public/face/, damit die
// App sie selbst ausliefert und zur Laufzeit kein CDN braucht. Laeuft vor
// `vite` und `vite build` (npm run dev/build, also auch vor dem Tauri-Build
// ueber beforeBuildCommand), ohne Netz. Die Kopien stehen in .gitignore;
// das Modell (blaze_face_short_range.tflite) liegt im Repository. Port des
// Web-Stands.
//
//   node scripts/copy-face-assets.mjs
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const out = join(here, '..', 'public', 'face')
mkdirSync(out, { recursive: true })

// Nur die SIMD-Fassung: face-detect.ts laedt keine andere.
for (const name of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  const from = require.resolve(`@mediapipe/tasks-vision/${name}`)
  const to = join(out, name)
  let same = false
  try { same = statSync(to).size === statSync(from).size && statSync(to).mtimeMs >= statSync(from).mtimeMs } catch { same = false }
  if (!same) copyFileSync(from, to)
}
