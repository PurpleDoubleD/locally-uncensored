// Wie viele Bilder ein Lauf in der Cloud liefert (02.10.2026). Server und
// Oberflaeche lesen dieselbe Grenze: der Server weist alles ausserhalb von
// 1 bis MAX_IMAGE_COUNT ab, die Oberflaeche bietet nichts darueber an.

/** Hoechstzahl Bilder pro Lauf, fuer Bild und Bearbeiten. */
export const MAX_IMAGE_COUNT = 4

export function clampImageCount(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 1
  return Math.max(1, Math.min(MAX_IMAGE_COUNT, v))
}

/** Kennt diese Unterkategorie eine Anzahl? Nur Bild und Bearbeiten. */
export function imageCountApplies(intent: string): boolean {
  return intent === 'image' || intent === 'edit'
}

/** Die Anzahl, mit der ein Lauf wirklich startet: nur Bild und Bearbeiten in der
 *  Cloud kennen sie, jede andere Unterkategorie ist ein einzelner Auftrag. */
export function runImageCount(intent: string, count: number, characterUse = false): number {
  return imageCountApplies(intent) && !characterUse ? clampImageCount(count) : 1
}

const SEED_MAX = 2_147_483_647

/** Der Keim des i-ten Auftrags eines Laufs: Keim + Index. Server und Oberflaeche
 *  rechnen mit derselben Zeile, damit die Galerie den Keim zeigt, mit dem das Bild
 *  wirklich entstand. */
export function bumpSeed(seed: number, index: number): number {
  return (seed + index) % SEED_MAX
}

/** Hoechstzahl Bilder pro lokalem Lauf (Batch size, createStore setBatchSize). */
export const LOCAL_BATCH_MAX = 8

/**
 * D23: wo der Composer die Bildanzahl neben Create zeigt, und bis wohin.
 * Null heisst: dieser Lauf kennt keine Anzahl, also kein Regler.
 *   Cloud: Bild und Bearbeiten, 1 bis MAX_IMAGE_COUNT (runImageCount).
 *   Mac lokal: Bild und Bearbeiten, je Bild ein eigener Lauf (useCreate).
 *   ComfyUI lokal: Bild (batchSize im leeren Latent) und Bearbeiten (B35:
 *   der Latent des Quellbilds wird wiederholt, api/edit-batch).
 */
export function composerImageCountMax(backend: 'local' | 'cloud', intent: string): number | null {
  if (backend === 'cloud') return imageCountApplies(intent) ? MAX_IMAGE_COUNT : null
  if (intent === 'image' || intent === 'edit') return LOCAL_BATCH_MAX
  return null
}
