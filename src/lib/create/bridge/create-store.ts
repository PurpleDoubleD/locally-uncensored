// The Create subcategories as the web app names them. The web keeps
// 'video_upscale' as its own intent; on the desktop the Create tab reaches it
// from the gallery, and the type that carries all thirteen is StudioIntent.
import type { StudioIntent } from '../../render/create-studio'
// The three ways of the 3D tab are studio intents of the Create tab only:
// chat does not make 3D models (lib/create/order.ts chatKind).
export type CreateIntent = Exclude<StudioIntent, '3d-text' | '3d-image' | '3d-video'>
