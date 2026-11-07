// The Create subcategories as the web app names them. The web keeps
// 'video_upscale' as its own intent; on the desktop the Create tab reaches it
// from the gallery, and the type that carries all thirteen is StudioIntent.
//
// Swap Character is left out, as on the web (chat-catalog ChatIntent): Create
// in chat cannot order it, it needs the customer's video and one photo per
// person, and the chat order has no such places. The Create tab runs it
// through useCloudCreate and lib/create/swap-run.ts, not through engine.ts.
import type { StudioIntent } from '../../render/create-studio'
export type CreateIntent = Exclude<StudioIntent, 'swap_character'>
