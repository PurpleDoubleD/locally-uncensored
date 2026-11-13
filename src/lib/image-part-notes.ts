/**
 * A22: the sentences a refused picture gets when the LU Engine's image part
 * (mmproj) is the reason. Each starts with a fixed head, so the reader of
 * app-written notes (lib/logic-notes.ts) knows it is not the model's answer.
 * Pure: no engine, no store.
 */
export const IMAGE_PART_NONE_HEAD = 'No image part installed:'
export const IMAGE_PART_NOT_LOADED_HEAD = 'Image part not loaded:'
export const IMAGE_PART_RELOADED_HEAD = 'Image part loaded again:'

export function noImagePartSentence(model: string): string {
  return `${IMAGE_PART_NONE_HEAD} ${model} cannot see the picture without it. ` +
    'Add its image part (the mmproj file) on the Models page, or switch to a model that has one, then send again.'
}

export function imagePartNotLoadedSentence(model: string, note: string | null): string {
  const why = note ? `: ${note.replace(/^Loaded without image input: /, '')}` : '.'
  const help = /smaller context/i.test(note ?? '')
    ? 'Lower the context in the engine settings, then send again.'
    : 'Restart the engine from the model picker, then send again.'
  return `${IMAGE_PART_NOT_LOADED_HEAD} ${model} can read images, but the LU Engine is running it without its image part (mmproj)${why}` +
    ` LU tried to load it again and it did not come up. ${help}`
}

export function imagePartReloadedSentence(model: string): string {
  return `${IMAGE_PART_RELOADED_HEAD} ${model} was running without its image part (mmproj). ` +
    'LU has loaded it again: send the message again and it will see the picture.'
}
