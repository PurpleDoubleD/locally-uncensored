// The two words of the 3D tab, apart from the store, so the texts and the
// cloud pick can name them without importing the store (no import cycle).

/** The three ways of the 3D tab (3.1.0). */
export type ThreeDWay = 'text' | 'image' | 'video'
/** The Detail step of the 3D tab. Each model maps it onto its own field. */
export type ThreeDDetail = 'draft' | 'standard' | 'fine'
