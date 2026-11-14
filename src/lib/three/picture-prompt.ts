// The words a two-step "From text" adds to the prompt of its picture, locally
// (hooks/useCreate.ts) and in the cloud (lib/three/cloud-picture-first.ts).

/** Steers the picture towards what an image-to-3D model reads best: one
 *  object, whole, on a plain ground. */
export function threeDPicturePrompt(prompt: string): string {
  const p = prompt.trim().replace(/[.,;\s]+$/, '')
  return `${p}, a single object, whole and centered, plain light background, soft studio light, three-quarter view`
}
