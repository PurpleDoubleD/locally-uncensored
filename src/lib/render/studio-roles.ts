// Welche Studio-Modelle welche Create-Unterkategorie fahren.
//
// Blattdatei ohne eigene Abhaengigkeiten ausser der Registrierung, damit sowohl
// cloud-models.ts (Waehler und Op-Aufloesung) als auch preset-models.ts (Rollen
// der Preset-Schritte) dieselbe Quelle lesen. Stuende die Regel in beiden, wuerde
// der Waehler irgendwann ein Modell zeigen, das der Start dann umbiegt.
//
// Deklarierte Listen sind Absicht, keine Vermutung: wo sich ein Modell nicht aus
// seinen Eingaben ablesen laesst (Bearbeiten und Verlaengern lesen beide ein
// Video plus Text), steht seine Id hier ausdruecklich.

import { STUDIO_MODELS, studioSchema } from './studio-contract'

/** Die Job-Parameter, ohne die dieses Modell nicht starten kann, sortiert. */
export function studioRequiredParams(id: string): string[] {
  const required = studioSchema(id).required ?? []
  return Object.entries(STUDIO_MODELS[id].inputs)
    .filter(([field]) => required.includes(field))
    .map(([, key]) => key)
    .sort()
}

function ids(match: (id: string, m: (typeof STUDIO_MODELS)[string]) => boolean): string[] {
  return Object.entries(STUDIO_MODELS).filter(([id, m]) => match(id, m)).map(([id]) => id)
}

/** Text zu Bild: ein Bild aus Worten, keine Eingabedatei. Ein Studio-Zwilling
 *  (`sourceModel`) steht schon unter seinem klassischen Namen im Waehler. */
export function studioTextToImage(): string[] {
  return ids((_, m) => m.kind === 'image' && !Object.keys(m.inputs).length && !m.sourceModel)
}

/** Text zu Video: ein Clip aus Worten, keine Eingabedatei. */
export function studioTextToVideo(): string[] {
  return ids((_, m) => m.kind === 'video' && !Object.keys(m.inputs).length)
}

/** Bild zu Video: genau ein Standbild geht hinein, sonst nichts Pflicht. */
export function studioImageToVideo(): string[] {
  return ids((id, m) => m.kind === 'video' && studioRequiredParams(id).join() === 'source_path')
}

/** Referenz zu Video: Referenzbilder sind erlaubt, aber keine Pflicht. Das
 *  Standbild der Oberflaeche geht als einzige Referenz hinein. */
export function studioReferenceVideo(): string[] {
  return ids((id, m) => m.kind === 'video' && Object.values(m.inputs).includes('image_paths') && !studioRequiredParams(id).length)
}

/** Bildbearbeitung per Anweisung, ohne Maske. Das Standbild der Oberflaeche geht
 *  hinein, kein Pinsel noetig. */
export const STUDIO_EDIT_MODELS: readonly string[] = [
  'minimax-h3-edit', 'qwen-image-3-edit', 'seedream-5-edit', 'qwen-image-2.1-edit', 'flux-3-klein-edit',
  // 29.10.2026 (W3): die geschlossenen Spitzenmodelle, wo der Anbieter einen
  // Bearbeiten-Weg hat. Midjourney und Recraft haben keinen.
  'gpt-image-2-edit', 'nano-banana-pro-edit', 'flux-2-max-edit', 'grok-imagine-quality-edit', 'kling-image-o3-edit',
]
