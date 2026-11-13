// The local 3D run (C3D-PLAN 2.3, 2.4): one picture in, one GLB out.
//
// On a Mac the picture goes to LU's own TripoSR engine (api/mlx-3d.ts, a
// process of its own per run). On Windows and Linux it goes to ComfyUI's
// TRELLIS.2 core nodes (lib/local-3d-comfy.ts). Both are called with a
// picture that is already on the Stage: "From text" painted it first, "From
// video" took it from a still frame.
//
// The content gate has run before this is called (useCreate runOnce), on the
// prompt and on where every picture came from (threeDProvenance).
import type { GalleryItem, ImageRef, ThreeDWay } from '../../stores/createStore'
import { THREE_D_TEXT } from './three-d-text'

export const MAC_3D_MODEL = 'TripoSR'
export const PC_3D_MODEL = 'TRELLIS.2'

/** The words that steer the picture of a two-step "From text" towards what an
 *  image-to-3D model reads best: one object, whole, on a plain ground. */
export function threeDPicturePrompt(prompt: string): string {
  const p = prompt.trim().replace(/[.,;\s]+$/, '')
  return `${p}, a single object, whole and centered, plain light background, soft studio light, three-quarter view`
}

/** The text the content gate reads besides the prompt: the names of every
 *  picture the run takes, and what the gallery knows about where they came
 *  from. A picture of the gallery carries its prompt, a file its name. */
export function threeDProvenance(s: { source: ImageRef | null; threeDViews: ImageRef[]; gallery: Pick<GalleryItem, 'prompt' | 'promptOriginal' | 'label' | 'dataUrl' | 'remoteUrl'>[] }): string {
  const pics = [s.source, ...s.threeDViews].filter((p): p is ImageRef => !!p)
  const out: string[] = []
  for (const p of pics) {
    if (p.name) out.push(p.name)
    if (p.filename) out.push(p.filename)
    const from = s.gallery.find((g) => (g.dataUrl && g.dataUrl === p.url) || (g.remoteUrl && g.remoteUrl === p.url))
    if (from) out.push(from.prompt ?? '', from.promptOriginal ?? '', from.label ?? '')
  }
  return out.filter(Boolean).join(' ')
}

/** The gallery entry of a finished local model. */
export function threeDGalleryItem(args: {
  id: string; way: ThreeDWay; model: string; prompt: string; seed: number
  localPath?: string; dataUrl?: string; filename?: string; subfolder?: string; comfyType?: string; sourceName?: string
}): GalleryItem {
  return {
    id: args.id, type: '3d',
    filename: args.filename ?? '', subfolder: args.subfolder ?? '', comfyType: args.comfyType,
    localPath: args.localPath, dataUrl: args.dataUrl,
    prompt: args.prompt, negativePrompt: '',
    label: args.prompt ? undefined : THREE_D_TEXT.gallery[args.way],
    sourceName: args.sourceName,
    model: args.model, modelType: 'unknown', toolModel: args.model,
    seed: args.seed, steps: 0, cfgScale: 0, sampler: '', scheduler: '',
    width: 0, height: 0, batchSize: 1,
    createdAt: Date.now(), builderUsed: 'dynamic', intent: '3d',
  }
}
