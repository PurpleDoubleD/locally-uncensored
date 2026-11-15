// The 3D lane on a Mac, as Create sees it: the models of the 3D engine
// (TripoSR in src-tauri/src/commands/mesh3d.rs, Stable Fast 3D in
// mesh3d_sf3d.rs). Kept free of imports, so the store, the intent rules and
// the stage can read it without pulling the engine's commands along
// (api/mlx-3d.ts has those).

/** The name the picker and the gallery give the first model (`MODEL_NAME`). */
export const MAC_3D_MODEL_NAME = 'TripoSR'

/** The id of the first model (`MODEL_ID`), the one a run takes when none is named. */
export const MAC_3D_MODEL_ID = 'triposr'

export type Mac3dModelId = 'triposr' | 'sf3d'

/** What the picker says about each model before anything is asked of Rust. */
export interface Mac3dModelInfo {
  id: Mac3dModelId
  name: string
  /** One short line for the picker. */
  line: string
  /** The weights are gated: the user accepts a licence and needs a Hugging Face token. */
  gated: boolean
}

/** Every local 3D model of a Mac, in the order the picker shows them. */
export const MAC_3D_MODELS: readonly Mac3dModelInfo[] = [
  { id: 'triposr', name: 'TripoSR', line: 'Fast, colours on the surface. 1.7 GB.', gated: false },
  { id: 'sf3d', name: 'Stable Fast 3D', line: 'Sharper, with a painted texture. 4 GB, needs a Hugging Face token.', gated: true },
]

export function mac3dModel(id: string | null | undefined): Mac3dModelInfo {
  return MAC_3D_MODELS.find((m) => m.id === id) ?? MAC_3D_MODELS[0]
}

/** The texture side of Stable Fast 3D per step of Detail. Rust takes these
 *  three (`texture_for` in mesh3d_sf3d.rs). */
export const MAC_3D_TEXTURE = { draft: 512, standard: 1024, fine: 2048 } as const

export function mac3dTexture(detail: keyof typeof MAC_3D_TEXTURE | undefined): number {
  return MAC_3D_TEXTURE[detail ?? 'standard'] ?? MAC_3D_TEXTURE.standard
}

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
