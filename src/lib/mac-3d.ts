// The 3D lane on a Mac, as Create sees it: one model of the 3D engine
// (TripoSR, src-tauri/src/commands/mesh3d.rs). Kept free of imports, so the
// store, the intent rules and the stage can read it without pulling the
// engine's commands along (api/mlx-3d.ts has those).

/** The name the picker and the gallery give the one model (`MODEL_NAME`). */
export const MAC_3D_MODEL_NAME = 'TripoSR'

/** The id of the one model (`MODEL_ID`). */
export const MAC_3D_MODEL_ID = 'triposr'

/** The grid side per step of Detail. Rust takes 64 to 384 on steps of 32
 *  (`resolution_for` in mesh3d.rs); 256 is TripoSR's own default. */
export const MAC_3D_RESOLUTION = { draft: 128, standard: 256, fine: 384 } as const

export type Mac3dDetail = keyof typeof MAC_3D_RESOLUTION

export function mac3dResolution(detail: Mac3dDetail | undefined): number {
  return MAC_3D_RESOLUTION[detail ?? 'standard'] ?? MAC_3D_RESOLUTION.standard
}

/** The phases Rust reports (`View.phase`), in the order a run goes through them. */
export type Mesh3dPhase = 'load' | 'cutout' | 'shape' | 'paint' | 'save'

/** What the progress line says for each phase (plan 1.8). */
export const MESH3D_PHASE_TEXT: Record<Mesh3dPhase, string> = {
  load: 'Getting the model ready…',
  cutout: 'Cutting out your object…',
  shape: 'Building the shape…',
  paint: 'Painting the surface…',
  save: 'Saving your model…',
}

/** The line under the progress bar: the phase in the app's words, and the
 *  seconds so far. An unknown phase reads as the first one. */
export function mesh3dRunLine(progress: { phase?: string | null }, elapsedSec: number): string {
  const phase = (progress.phase ?? '') as Mesh3dPhase
  const text = MESH3D_PHASE_TEXT[phase] ?? MESH3D_PHASE_TEXT.load
  return `${text} (${Math.max(0, Math.round(elapsedSec))}s)`
}

/** The words for a picture in which no object was found (`NO_OBJECT`). */
export const MESH3D_NO_OBJECT = 'LU could not find a clear object in this picture. Try one with a plain background.'
