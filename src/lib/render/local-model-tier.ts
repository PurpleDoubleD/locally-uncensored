// Welche Stufe ein lokales ComfyUI-Modell traegt (02.10.2026).
//
// Die Cloud-Waehler lesen `tier` aus dem Katalog. Ein lokales Modell ist eine
// Datei auf der Platte, und die Datei weiss nichts von einer Stufe, also wird sie
// hier aus der Architektur (und bei zwei Familien aus dem Namen) gelesen. Die
// Bundles im Katalog (api/model-bundles.ts) tragen dieselbe Stufe als Feld; ein
// Test haelt beide Seiten gleich, damit der Model Manager und der Waehler nie
// verschiedener Meinung sind.
//
// Die Stufe ordnet und kennzeichnet, sie versteckt nichts. Alle lokalen Modelle
// sind offene Gewichte, darum gibt es hier kein `weights`.
//
// Diese Datei ist rein und kennt api/comfyui nicht (die Typen kommen als String
// herein), damit lib/render und api keinen Importkreis bilden.

import type { ModelTier } from './model-tier'

/** Heutiger Stand der Technik unter den offenen Gewichten, lokal lauffaehig. */
const BEST = new Set([
  'ltx25', // Video mit Ton (MiniMax H3 ist seit 3.1.3 nicht mehr im Angebot)
  'qwenimage', 'zimage', 'flux2', 'krea2', 'ernie_image', // Bild
  'yue2', // Musik
  'trellis2', // 3D (Windows und Linux, api/model-bundles getThreeDBundles)
])

/** Von einer neueren Familie abgeloest. Nicht versteckt, nur nach unten gesammelt. */
const OLDER = new Set([
  'sdxl', 'sd15', 'flux', // Bild: SDXL-Klassiker, FLUX 1
  'ltx', 'wan', 'wanvace', 'hunyuan', 'mochi', 'cosmos', 'svd', 'framepack', // Video
  'animatediff', 'cogvideo', 'pyramidflow', 'allegro',
])

/** ACE Step 1.5 ist der aktuelle Stand, v1 die leichtere Variante daneben. */
const ACE_15 = /1[._-]?5/

/**
 * Die Stufe eines lokalen Modells. Alles, was keine der Listen nennt (Wan 2.2,
 * Chroma, HiDream, SD 3.5, Lumina 2, Qwen-Image 1, Wan 2.2 in allen Formen, ACE
 * Step v1, ein unbekannter Dateiname), bleibt 'standard': gewohnte Reihenfolge, keine Marke.
 */
export function localTier(m: { name: string; type: string }): ModelTier {
  // Die 14B-Wan-Mischungen auf 2.2-Basis (Rapid AIO) tragen den Typ 'wan' wie
  // Wan 2.1, sind aber nicht aelter als Wan 2.2 selbst.
  if (m.type === 'wan' && /wan[._-]?2[._-]?2/i.test(m.name)) return 'standard'
  if (m.type === 'ace') {
    const stem = m.name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/^.*ace[_-]?step/, '')
    return ACE_15.test(stem) ? 'best' : 'standard'
  }
  if (BEST.has(m.type)) return 'best'
  if (OLDER.has(m.type)) return 'older'
  return 'standard'
}
