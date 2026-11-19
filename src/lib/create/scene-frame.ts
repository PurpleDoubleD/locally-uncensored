// Scene to Video (3.1.3, port of the web's lib/create/scene-frame.ts of
// 16.11.2026): the optional first frame step and what a run reads from the
// store. Without React, like swap-frame.ts: uploading, submitting and polling
// come from outside.
//
// The step takes the first frame of the scene video (drawn in the app) and
// has an image editor on LU Cloud give it the look of the prompt, with the
// structure kept (SCENE_FRAME_SUFFIX, lib/render/scene.ts). The result is the
// customer's own first frame at once (SceneStage); a frame in use is the start
// image or reference of the video run. In Local mode the step is not offered
// (it would run on the cloud): an own frame there is an upload.

import type { CloudJob, CloudJobSubmit, UploadRole } from '../../api/cloud/jobs'
import { dataUrlToBlob } from '../render/data-url'
import { SCENE_FRAME_MODEL, sceneFrameCredits, sceneFrameOptions, sceneFramePrompt } from '../render/scene'
import { STUDIO_MODELS } from '../render/studio-contract'
import type { SceneFrame, SceneState } from '../../stores/createStore'

/** The frame in use, only while it belongs to the scene video on screen. */
export function sceneFrameFor(scene: SceneState, videoUrl: string | undefined): SceneFrame | null {
  return scene.frame && videoUrl && scene.frame.videoUrl === videoUrl ? scene.frame : null
}

export interface SceneFrameRequest {
  /** The first frame of the scene video as a data: URL, with its size. */
  first: { url: string; width: number; height: number } | null
  /** The look, the same words as the video run. */
  look: string
  /** The price on the button: the cap of the booking. */
  credits: number | null
}

/** What stops the step, as a sentence for the customer, or null. */
export function sceneFrameProblem(req: SceneFrameRequest): string | null {
  if (!req.first) return 'Add your scene video first.'
  if (!req.look.trim()) return 'Write a prompt first.'
  return null
}

/** The price of the step for this frame. */
export function sceneFramePrice(first: { width: number; height: number } | null): number | null {
  return sceneFrameCredits(SCENE_FRAME_MODEL, first?.width ?? 16, first?.height ?? 9)
}

/** The body for POST /api/jobs. */
export function sceneFrameSubmit(framePath: string, req: SceneFrameRequest): CloudJobSubmit {
  const model = SCENE_FRAME_MODEL
  // The grey frame goes where the editor reads a picture (all of them read
  // a list today).
  const reads = Object.values(STUDIO_MODELS[model]?.inputs ?? {})
  return {
    kind: 'image',
    model,
    prompt: sceneFramePrompt(req.look),
    params: {
      op: 'studio',
      ...(reads.includes('image_paths') ? { image_paths: [framePath] } : { source_path: framePath }),
      studio_options: sceneFrameOptions(model, req.first?.width ?? 0, req.first?.height ?? 0),
      ...(req.credits != null ? { max_credits: req.credits } : {}),
      label: 'Scene first frame',
    },
  }
}

/** The three ways to the queue, handed in like swap-frame.ts's. */
export interface SceneFrameDeps {
  submitCloudJob: (submit: CloudJobSubmit) => Promise<{ id: string }>
  pollJob: (id: string, opts: { signal?: AbortSignal; timeoutMs?: number }) => Promise<CloudJob>
  cancelJob: (id: string) => Promise<unknown>
  uploadInput: (file: Blob, role: UploadRole) => Promise<string>
  signal?: AbortSignal
  onStep?: (text: string) => void
}

/** Uploads the first frame, runs the editor and waits for it. Throws with the
 *  sentence for the customer when something is missing. */
export async function runSceneFrame(req: SceneFrameRequest, deps: SceneFrameDeps): Promise<CloudJob> {
  const problem = sceneFrameProblem(req)
  if (problem) throw new Error(problem)
  deps.onStep?.('Uploading…')
  const path = await deps.uploadInput(dataUrlToBlob(req.first!.url), 'source')
  if (deps.signal?.aborted) throw new Error('Canceled.')
  deps.onStep?.('Generating…')
  const { id } = await deps.submitCloudJob(sceneFrameSubmit(path, req))
  // A Cancel during the submit found no id yet: the job just taken is
  // canceled at once, so its credits go back (as runCloudJob in engine.ts).
  if (deps.signal?.aborted) {
    void deps.cancelJob(id).catch(() => {})
    throw new Error('Canceled.')
  }
  return deps.pollJob(id, { signal: deps.signal, timeoutMs: 10 * 60_000 })
}
