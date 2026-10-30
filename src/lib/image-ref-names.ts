// How a prompt names the images of a multi-image edit (Discord help-18,
// 23.10.2026: "it says IMAGE 2 is the reference photo, should i just put
// image 2, or IMAGE 2.? is it case or space sensitive?").
//
// The reference strip tells the user to write "image 2", but the encoders do
// not label the images that way:
//   - Qwen-Image 2.1 (TextEncodeQwenImage21 in comfy/text_encoders/
//     qwen_image21.py, and mflux qwen21 prompt_encoder.py on the Mac) puts
//     "<image1>", "<image2>" ... in front of each vision block, and the
//     official template note and prompt enhancer both say to refer to them
//     as `<image1>`, `<image2>`.
//   - Qwen-Image-Edit 2509/2511 (TextEncodeQwenImageEditPlus) labels them
//     "Picture 1: ", "Picture 2: ".
//   - MiniMax H3 ref2va (MiniMaxH3ReferenceToVideo, B38) asks the prompt for
//     "<Picture 1>", "<Picture 2>", the tags its node description names.
// So right before the graph is built, every way a user writes the number of
// an image that is really there is rewritten to the label the encoder put in
// front of it. The prompt the user typed, in the history and the gallery,
// stays as typed.

export type ImageRefStyle = 'qwen21' | 'qwenEditPlus' | 'minimaxH3'

/** The label an encoder puts in front of image `n` (1 is the source). */
export function canonicalImageRef(n: number, style: ImageRefStyle): string {
  return style === 'qwen21' ? `<image${n}>` : style === 'minimaxH3' ? `<Picture ${n}>` : `Picture ${n}`
}

// A word that names an image, then the number, in any case:
//   <image2>, image 2, Image2, image #2, image no. 2, image nr 2, image-2,
//   image_2, img 2, picture 2, pic 2, photo 2, Picture 2: (the colon stays).
// A plural ("images 2 and 3") does not match.
// Not "reference 2" or "ref 2": the strip numbers the source as 1, so the
// first reference could be meant as 1 or as 2, and a guess would point the
// edit at the wrong image.
// The number must stand on its own: "image 20", "image 2.5", "image 2k",
// "image 2x" and "2 images" are left alone.
const REF = /(<\s*)?\b(image|img|picture|pic|photo)(?:\s*(?:#|no\.?|nr\.?|number)\s*|[\s_-]*)(\d{1,3})(?![\d\p{L}_]|[.,]\d|\s*(?:%|px|mm|cm|m|meters?|metres?|ft|feet|inch(?:es)?|in|kg|x\b))(\s*>)?/giu

function rewrite(text: string, count: number, style: ImageRefStyle): string {
  return text.replace(REF, (whole: string, open: string | undefined, _word: string, digits: string, close: string | undefined) => {
    const n = Number(digits)
    if (!(n >= 1 && n <= count)) return whole
    // A half tag ("<image2" without ">") is kept as written; a ">" after a
    // plain name ("image 2 > image 3") is not part of it and stays.
    if (open && !close) return whole
    return canonicalImageRef(n, style) + (open ? '' : close ?? '')
  })
}

/**
 * Every reference to image 1 to `count` in `prompt`, rewritten to the label
 * the encoder uses. `count` is the number of images the edit carries, the
 * source counted. With fewer than two images nothing changes: the official
 * prompt enhancer names a single image in plain words, and there is nothing
 * to tell apart. Text in double quotes is text to render in the picture
 * ("a sign that says \"image 2\"") and is kept as written.
 */
export function canonicalImageRefs(prompt: string, count: number, style: ImageRefStyle): string {
  if (!prompt || !(count >= 2)) return prompt
  // Straight and curly quotes, each pair kept apart from the rest.
  return prompt
    .split(/("[^"]*"|“[^”]*”)/u)
    .map((part, i) => (i % 2 === 1 ? part : rewrite(part, count, style)))
    .join('')
}

/** The words the reference strip asks the prompt to use for image `n`. */
export function imageRefWords(n: number): string {
  return `image ${n}`
}

/** `prompt` with the name of image `n` added at its end, a space between. */
export function withImageRef(prompt: string, n: number): string {
  const words = imageRefWords(n)
  if (!prompt.trim()) return words
  return /\s$/.test(prompt) ? `${prompt}${words}` : `${prompt} ${words}`
}

/** The source above the reference strip is the first image a prompt names. */
export const SOURCE_IS_IMAGE_1 = 'The image above is image 1.'
