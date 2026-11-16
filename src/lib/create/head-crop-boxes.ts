// Die zwei Rechtecke des Kopf-Zuschnitts, ohne Abhaengigkeiten, damit
// head-crop.ts und face-detect.ts sie beide nutzen koennen.

/** Ein gefundenes Gesicht in Pixeln des Fotos. */
export interface FaceBox { x: number; y: number; width: number; height: number; score: number }

/** Der Ausschnitt, ganzzahlig, in Pixeln des Fotos. */
export interface CropBox { x: number; y: number; width: number; height: number }
