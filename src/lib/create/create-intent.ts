// The flat creation intents of the Create page. Split out of
// stores/createStore.ts (3.1.0) so character-hub.ts can use the type without
// an import cycle; createStore.ts re-exports both names.

/** 2.5.8 specialized Create categories (2026-07-17):
 *  Character-Studio (LoRA training + generation), talking character (lipsync),
 *  music, video extend and motion control. Like `utilityOp`, an escape hatch
 *  over the image/video mode axis: when set it wins the intent derivation. */
export type CloudOp = 'character' | 'lipsync' | 'music' | 'extend' | 'motion' | '3d' | 'swap_character' | 'scene'

/**
 * The redesigned Create page's flat creation intents, derived over
 * mode / image sub-mode / video sub-mode / removebg. The `mode` + sub-mode
 * enums stay the load-bearing state; `intent` is a derived view over them.
 */
export type CreateIntent =
  | 'image' | 'edit' | 'removebg' | 'video' | 'animate' | 'upscale' | 'eraser'
  | CloudOp
