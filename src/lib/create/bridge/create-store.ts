// The Create subcategories as the web app names them. The web keeps
// 'video_upscale' as its own intent; on the desktop the Create tab reaches it
// from the gallery, and the type that carries all thirteen is StudioIntent.
import type { StudioIntent } from '../../render/create-studio'
// The three ways of the 3D tab are studio intents of the Create tab only:
// chat does not make 3D models (lib/create/order.ts chatKind).
//
// Swap Character is left out, as on the web (chat-catalog ChatIntent): Create
// in chat cannot order it, it needs the customer's video and one photo per
// person, and the chat order has no such places. The Create tab runs it
// through useCloudCreate and lib/create/swap-run.ts, not through engine.ts.
//
// Scene to Video (3.1.3) is left out the same way, as on the web: it needs the
// customer's scene video, which a chat order has no place for.
export type CreateIntent = Exclude<StudioIntent, '3d-text' | '3d-image' | '3d-video' | 'swap_character' | 'scene'>
