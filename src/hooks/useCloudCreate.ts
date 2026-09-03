// Cloud twin of useCreate's generate/cancel — port of uselu's useCloudCreate
// onto the desktop cloud client (bearer auth via api/cloud/jobs). Submits the
// current Create state to the hosted render queue instead of local ComfyUI,
// then polls to completion. Store choreography (isGenerating, progress,
// gallery) mirrors the local path so every downstream component works
// unchanged. useCreate itself is untouched: the seam lives in CreateExpProvider.
//
// Desktop delta vs uselu: results keep remoteUrl + jobId in the persisted
// gallery — multi-MB base64 dataUrls would blow the localStorage quota and
// kill all create-store persistence. Signed URLs expire ~1 h after the last
// read, so playback surfaces re-sign lazily via refreshResultUrl().

import { useCallback } from 'react'
import { useCreateStore, type GalleryItem } from '../stores/createStore'
import { intentToJob } from '../lib/render/cloud-jobs'
import {
  cancelJob,
  getJob,
  pollJob,
  submitCloudJob,
  uploadInput,
  CloudJobError,
  type CloudJobParams,
} from '../api/cloud/jobs'
import {
  defaultCloudModel,
  modelForOp,
  resolveOpPick,
  cloudModelById,
  cloudMediaLive,
} from '../stores/cloudCatalogStore'
import { checkPromptSafety, SAFETY_BLOCK_MESSAGE } from '../lib/render/safety'
import { resolveRunSeed } from '../lib/run-seed'

// Character-Studio generation endpoint per trained-LoRA family (fast default;
// mirrors uselu's LORA_GEN_FAMILY — ltx-2 video characters have no image-gen
// lane and qwen has no -lora generation endpoint yet).
const CHARACTER_GEN_DEFAULT: Record<string, string> = {
  flux: 'flux-schnell-lora',
  'z-image': 'z-image-turbo-lora',
}

// Gallery label for ops that never read the composer prompt. Without this
// they inherit whatever was typed last, and the extend picker then shows a
// motion clip wearing the previous t2v prompt as its name (live find
// 2026-07-18: two different clips, identical "…dancing…" label).
const OP_GALLERY_LABEL: Record<string, string> = {
  lipsync: 'Talking character',
  motion: 'Motion transfer',
  removebg: 'Background removed',
  upscale: 'Upscaled image',
  eraser: 'Object erased',
}

// Per-op progress verb — "Rendering" reads wrong for a training run or a song.
function opProgressVerb(op: string): string {
  switch (op) {
    case 'lora-train': return 'Training your character…'
    case 'music': return 'Composing…'
    case 'tts': return 'Generating the voice…'
    case 'lipsync': return 'Syncing the performance…'
    case 'extend': return 'Extending the clip…'
    case 'motion': return 'Transferring the motion…'
    default: return 'Rendering in the cloud…'
  }
}

// What a 429 from the render queue actually means.
//
// The queue answers 429 for three different things (lib/http-status states the
// same policy for the chat path): the per-user burst guard, an upstream
// provider throttle — both transient, both carrying retry-after — and an empty
// wallet, which is the only one paying more fixes. Every one of them used to
// read "Monthly credit budget exhausted, upgrade your plan", so a subscriber
// who was merely clicking too fast, with credits left in the meter next to the
// message, was told to buy a bigger plan. That is a sales pitch for a refusal
// the money would not have prevented, so the wallet case has to be positively
// identified — by the server's own `code`, or failing that by a message that
// actually talks about credits — and everything else says what it is.
export function throttleMessage(err: CloudJobError): string {
  if (err.code === 'credits_exhausted' || /credit/i.test(err.message)) {
    return 'Monthly credit budget exhausted, upgrade your plan or wait for the next period.'
  }
  const secs = err.retryAfterMs && err.retryAfterMs > 0 ? Math.ceil(err.retryAfterMs / 1000) : null
  return secs
    ? `Too many requests right now — the render queue is throttling, not your credit balance. Try again in ${secs}s.`
    : 'Too many requests right now — the render queue is throttling, not your credit balance. Give it a moment and try again.'
}

// Decoded by hand instead of fetch(dataUrl): the webview CSP's connect-src
// (rightly) has no data: entry, so fetching a data URL throws "Load failed"
// and killed every source-needing op before the upload even started.
export function dataUrlToBlob(dataUrl: string): Blob {
  // A blob:/http(s) url here means an ImageRef broke the "url is always a data
  // url" invariant. Parsing it as a data url silently yields a text blob the
  // server 415s ("unsupported image format") — fail loudly at the source.
  if (!dataUrl.startsWith('data:')) {
    throw new Error(`dataUrlToBlob expects a data: URL, got "${dataUrl.slice(0, 16)}…"`)
  }
  const comma = dataUrl.indexOf(',')
  const meta = dataUrl.slice(5, comma)
  const data = dataUrl.slice(comma + 1)
  const mime = meta.split(';')[0] || 'application/octet-stream'
  if (meta.includes('base64')) {
    const bin = atob(data)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  }
  return new Blob([decodeURIComponent(data)], { type: mime })
}

// The in-flight job handle lives at module scope, matching the lifetime of the
// generate() closure (which keeps polling across view switches). Instance refs
// died with the Create view's remount, leaving the Cancel button a no-op
// mid-render. At most one cloud job runs per app (the store-level isGenerating
// gate), so a singleton is correct.
let activeJobId: string | null = null
let activeAbort: AbortController | null = null

/** True while a cloud run (generate or enhance) is in flight. CreateContext
 *  routes Cancel by the backend that STARTED the run, not the current axis —
 *  the header switch (or the 5-min license probe) can flip local/cloud
 *  mid-render, and a mis-routed cancel strands a billing cloud job. */
export const hasActiveCloudRun = (): boolean => activeAbort !== null

export function useCloudCreate(opts: { onQuotaChange?: () => void } = {}) {
  const { onQuotaChange } = opts

  const generate = useCallback(async () => {
    const s = useCreateStore.getState()
    if (s.isGenerating) return
    const intent = s.intent()
    let { kind, op } = intentToJob(intent)
    // Character-Studio 'use' surface: a plain image generate with the trained
    // character attached; 'train' (the intentToJob default) books the trainer.
    const characterUse = intent === 'character' && s.characterTab === 'use'
    if (characterUse) {
      kind = 'image'
      op = 'generate'
    }
    const specialOp =
      op === 'lipsync' || op === 'extend' || op === 'motion' ||
      op === 'music' || op === 'tts' || op === 'lora-train'
    let picked: string
    if (characterUse) {
      picked = CHARACTER_GEN_DEFAULT[s.selectedCharacter?.family ?? ''] ?? 'flux-schnell-lora'
    } else if (specialOp) {
      // Same resolution rule as the chip's display — a pick left over from
      // another intent must not survive into this op's submit (take-01: the
      // lipsync model steered the training job onto the LTX video trainer
      // while the chip showed Flux).
      picked = resolveOpPick(op, s.cloudOpModel)
    } else {
      picked = (kind === 'video' ? s.cloudVideoModel : s.cloudImageModel) || defaultCloudModel(kind)?.id || ''
    }
    // Coerce a leftover/incapable pick onto a model that can run this op
    // (edit→i2i, animate→i2v, video→t2v, specialized ops→their family) so the
    // submit never 400s.
    const model = modelForOp(kind, op, picked)

    s.setError(null)
    if (!cloudMediaLive()) {
      // Server MEDIA_LIVE switch is off — the GPU fleet isn't up, a submit
      // would only 503. Mirror the server's honest "coming soon".
      s.setError('Cloud rendering is coming soon, the GPU fleet is not live yet.')
      return
    }
    if ((op === 'generate' || op === 'music' || op === 'tts') && s.prompt.trim().length === 0) {
      s.setError('Please enter a prompt.')
      return
    }
    // Client-side CSAM gate (UX) over every free-text field this run sends.
    // The server additionally enforces its SFW-cloud policy — its 422 message
    // lands in setError below.
    if (checkPromptSafety(`${s.prompt} ${s.negativePrompt} ${s.musicLyrics} ${s.triggerWord}`).blocked) {
      s.setError(SAFETY_BLOCK_MESSAGE)
      return
    }
    // Per-intent input contracts (client UX; the server re-checks all of it).
    if (characterUse && !s.selectedCharacter) {
      s.setError('Pick a character from your shelf first, or train one.')
      return
    }
    if (op === 'lora-train' && s.trainImages.length < 4) {
      s.setError('Add at least 4 photos of your character (more is better, up to 30).')
      return
    }
    if (op === 'lipsync') {
      if (!s.audioInput && !s.voiceFromJob) {
        s.setError('Add a voice first, upload an audio file or pick a generated one.')
        return
      }
      const needsClip = cloudModelById(model)?.lipsync_source === 'video'
      if (needsClip ? !s.videoInput : !s.source) {
        s.setError(needsClip ? 'Add the video clip to re-sync.' : 'Add a portrait image for your character.')
        return
      }
    }
    if (op === 'extend' && !s.extendSource) {
      s.setError('Pick one of your cloud videos to extend.')
      return
    }
    if (op === 'motion' && (!s.source || !s.videoInput)) {
      s.setError('Motion control needs a character image and a driving video.')
      return
    }
    if (!specialOp && op !== 'generate' && !s.source) {
      s.setError('Add a source image first.')
      return
    }

    s.setIsGenerating(true)
    s.setProgressPhase('queued')
    s.setProgress(5, 'Uploading inputs…')
    // Arm the aborter BEFORE the upload/submit awaits so a Cancel click during
    // "Uploading inputs…" (seconds for large sources/masks) actually stops the
    // run before any credits are claimed — not only once polling has started.
    const ac = new AbortController()
    activeAbort = ac

    // Same rule as the local path (#110): throw the dice here, send that exact
    // number, record that exact number. Leaving the seed out let the provider
    // roll one we never learn, and the gallery wrote 0 for it.
    const runSeed = resolveRunSeed(s.seed)

    try {
      // Utility endpoints (removebg/upscale/eraser) and the 2.5.8 specialized
      // ops take no generation knobs — send only what the op consumes so the
      // submit schema stays honest.
      const isUtility = op === 'removebg' || op === 'upscale' || op === 'eraser'
      const bare = isUtility || specialOp
      const params: CloudJobParams = bare
        ? { op }
        : {
            op,
            negative_prompt: s.negativePrompt || undefined,
            width: s.width,
            height: s.height,
            steps: s.steps,
            cfg: s.cfgScale,
            seed: runSeed,
          }
      if (kind === 'video' && !bare) {
        params.frames = s.frames
        params.fps = s.fps
      }
      if (op === 'music') {
        params.duration = s.musicDuration
        if (s.musicLyrics.trim()) params.lyrics = s.musicLyrics.trim()
      }
      if (op === 'lora-train') {
        params.trigger_word = s.triggerWord || 'oxlu'
        if (s.triggerWord) params.name = s.triggerWord
      }
      if (characterUse && s.selectedCharacter) {
        params.loras = [{ id: s.selectedCharacter.id }]
      }
      if (op === 'edit') {
        params.denoise = s.denoise
        params.grow_mask_by = s.growMaskBy
        // The mask is exported at the SOURCE image's resolution, so the output
        // must match it too — otherwise the painted region no longer aligns.
        // The generation sliders (s.width/height) are unrelated to a dropped
        // source, so drive width/height from the source when we have it.
        if (s.source?.width && s.source?.height) {
          params.width = s.source.width
          params.height = s.source.height
        }
      }
      if (op === 'upscale') {
        params.target_resolution = s.targetResolution
      }
      // ImageRef.url is always a data URL preview; the cloud path re-uploads
      // from it, so a source picked while on the local backend still works.
      if (op !== 'generate' && s.source) {
        params.source_path = await uploadInput(dataUrlToBlob(s.source.url), 'source')
      }
      if (op === 'edit' || op === 'eraser') {
        if (!s.mask) {
          s.setError(
            op === 'eraser'
              ? 'Paint a mask first, the eraser removes what you painted.'
              : 'Paint a mask first, the edit only changes the painted area.',
          )
          s.setIsGenerating(false)
          return
        }
        params.mask_path = await uploadInput(dataUrlToBlob(s.mask.url), 'mask')
      }
      // ── 2.5.8 specialized inputs ──
      if ((op === 'lipsync' || op === 'motion') && s.videoInput) {
        s.setProgress(6, 'Uploading video…')
        params.video_path = await uploadInput(s.videoInput.blob, 'video')
      }
      if (op === 'lipsync') {
        if (s.audioInput) {
          s.setProgress(8, 'Uploading audio…')
          params.audio_path = await uploadInput(s.audioInput.blob, 'audio')
        } else if (s.voiceFromJob) {
          // A prior own render (tts/music) — fresh signed URL, zero re-upload.
          const vj = await getJob(s.voiceFromJob.jobId)
          if (!vj.result_url) throw new Error('That voice has expired, generate it again first.')
          params.audio_url = vj.result_url
        }
      }
      if (op === 'lora-train') {
        const paths: string[] = []
        for (const [i, img] of s.trainImages.entries()) {
          if (ac.signal.aborted) return
          s.setProgress(5, `Uploading training photos… ${i + 1}/${s.trainImages.length}`)
          paths.push(await uploadInput(img.blob, 'train'))
        }
        params.image_paths = paths
      }
      if (op === 'extend' && s.extendSource) {
        const src = await getJob(s.extendSource.jobId)
        if (!src.result_url) throw new Error('The source clip has expired, re-render it first.')
        params.source_url = src.result_url
      }

      // Bail before the (credit-claiming) submit if the user cancelled while
      // we were uploading inputs.
      if (ac.signal.aborted) return

      s.setProgress(10, 'Submitting to the render queue…')
      const { id } = await submitCloudJob({ kind, model, prompt: s.prompt, params })
      // A Cancel during the submit round-trip saw activeJobId still null, so
      // nothing was cancelled server-side. Now that the id exists, cancel the
      // just-queued job so its claimed credits refund instead of orphaning a
      // render we're no longer watching.
      if (ac.signal.aborted) {
        cancelJob(id).then(() => onQuotaChange?.()).catch(() => {})
        return
      }
      activeJobId = id
      onQuotaChange?.()
      if (s.prompt.trim()) s.addToPromptHistory(s.prompt.trim())

      const startedAt = Date.now()
      // Video renders and character training routinely run several minutes
      // and can queue behind other jobs on the shared fleet — give them a
      // much longer client deadline than images.
      const verb = opProgressVerb(op)
      const job = await pollJob(id, {
        timeoutMs: kind === 'video' || op === 'lora-train' ? 45 * 60_000 : 15 * 60_000,
        signal: ac.signal,
        onTick: (j) => {
          const st = useCreateStore.getState()
          const elapsed = Math.round((Date.now() - startedAt) / 1000)
          if (j.status === 'queued') {
            st.setProgressPhase('queued')
            st.setProgress(15, `Waiting for a cloud GPU… ${elapsed}s`)
          } else if (j.status === 'running') {
            st.setProgressPhase('sampling')
            st.setProgress(Math.min(90, 20 + elapsed), `${verb} ${elapsed}s`)
          }
        },
      })

      const st = useCreateStore.getState()
      if (job.status === 'succeeded' && op === 'lora-train') {
        // Training output is a LoRA on the user's shelf, not a media item —
        // flip Character-Studio to the use-surface with a fresh shelf.
        st.setProgressPhase('complete')
        st.setProgress(100, 'Character trained!')
        st.clearTrainImages()
        st.setCharacterTab('use')
        st.bumpCharactersVersion()
      } else if (job.status === 'succeeded' && job.result_url) {
        st.setProgressPhase('complete')
        st.setProgress(100, 'Complete!')
        st.addToGallery({
          id: job.id,
          type: kind,
          filename: '',
          subfolder: '',
          prompt: OP_GALLERY_LABEL[op] ?? s.prompt,
          negativePrompt: s.negativePrompt,
          model,
          modelType: 'unknown',
          seed: runSeed,
          steps: s.steps,
          cfgScale: s.cfgScale,
          sampler: s.sampler,
          scheduler: s.scheduler,
          width: s.width,
          height: s.height,
          batchSize: 1,
          createdAt: Date.now(),
          remoteUrl: job.result_url,
          attestation: job.attestation,
          jobId: job.id,
          intent,
        })
      } else if (job.status === 'canceled') {
        st.setError(null)
      } else {
        st.setError(job.error ?? 'Cloud render failed.')
        onQuotaChange?.() // failure refunds — refresh the meter
      }
    } catch (err) {
      const st = useCreateStore.getState()
      if (err instanceof CloudJobError && err.status === 429) {
        st.setError(throttleMessage(err))
      } else if (err instanceof CloudJobError && err.status === 401) {
        st.setError('Sign in to your LU Cloud account to render in the cloud.')
      } else if (err instanceof CloudJobError && err.message === 'render timed out') {
        // The desktop app has no jobs-history view — point at the account
        // page instead of promising an in-app surface that doesn't exist.
        st.setError('Still rendering, this is taking longer than expected. When it completes you can view it in your account at lu-labs.ai.')
      } else if (!(err instanceof CloudJobError && err.message === 'polling aborted')) {
        st.setError(err instanceof Error ? err.message : String(err))
      }
      onQuotaChange?.()
    } finally {
      activeJobId = null
      activeAbort = null
      const st = useCreateStore.getState()
      st.setIsGenerating(false)
      st.setProgress(0)
    }
  }, [onQuotaChange])

  const cancel = useCallback(async () => {
    const id = activeJobId
    activeAbort?.abort() // stop polling immediately either way
    if (!id) return
    try {
      await cancelJob(id)
      onQuotaChange?.() // queued-cancel refunds
    } catch {
      // 409 (already running/finished) — poll stop is all the client can do
    }
  }, [onQuotaChange])

  // Talking-character voice maker (qwen3-tts speak/design): a small tts run
  // whose result lands as an audio gallery item AND as the lipsync voice pick
  // (voiceFromJob → audio_url at submit, no client-side byte shuffling).
  const makeVoice = useCallback(
    async (opts: { text: string; mode: 'speak' | 'design'; voice?: string; description?: string }) => {
      const s = useCreateStore.getState()
      if (s.isGenerating) return
      const text = opts.text.trim()
      if (!text) {
        s.setError('Type what the character should say.')
        return
      }
      if (checkPromptSafety(`${text} ${opts.description ?? ''}`).blocked) {
        s.setError(SAFETY_BLOCK_MESSAGE)
        return
      }
      s.setError(null)
      s.setIsGenerating(true)
      s.setProgressPhase('queued')
      s.setProgress(10, 'Submitting to the render queue…')
      const ac = new AbortController()
      activeAbort = ac
      try {
        const model = opts.mode === 'design' ? 'qwen3-tts-design' : 'qwen3-tts'
        const params: CloudJobParams = { op: 'tts' }
        if (opts.mode === 'speak' && opts.voice) params.voice = opts.voice
        if (opts.mode === 'design' && opts.description) params.voice_description = opts.description
        const { id } = await submitCloudJob({ kind: 'audio', model, prompt: text, params })
        if (ac.signal.aborted) {
          cancelJob(id).then(() => onQuotaChange?.()).catch(() => {})
          return
        }
        activeJobId = id
        onQuotaChange?.()

        const startedAt = Date.now()
        const job = await pollJob(id, {
          timeoutMs: 15 * 60_000,
          signal: ac.signal,
          onTick: (j) => {
            const st = useCreateStore.getState()
            const elapsed = Math.round((Date.now() - startedAt) / 1000)
            if (j.status === 'running') {
              st.setProgressPhase('sampling')
              st.setProgress(Math.min(90, 20 + elapsed), `Generating the voice… ${elapsed}s`)
            }
          },
        })

        const st = useCreateStore.getState()
        if (job.status === 'succeeded' && job.result_url) {
          st.setProgressPhase('complete')
          st.setProgress(100, 'Voice ready!')
          const label = text.length > 40 ? `${text.slice(0, 40)}…` : text
          st.addToGallery({
            id: job.id,
            type: 'audio',
            filename: '',
            subfolder: '',
            prompt: text,
            negativePrompt: '',
            model,
            modelType: 'unknown',
            seed: 0,
            steps: 0,
            cfgScale: 0,
            sampler: '',
            scheduler: '',
            width: 0,
            height: 0,
            batchSize: 1,
            createdAt: Date.now(),
            remoteUrl: job.result_url,
            attestation: job.attestation,
            jobId: job.id,
            intent: 'lipsync',
          })
          st.setVoiceFromJob({ jobId: job.id, label })
        } else if (job.status !== 'canceled') {
          st.setError(job.error ?? 'Voice generation failed.')
          onQuotaChange?.()
        }
      } catch (err) {
        const st = useCreateStore.getState()
        if (err instanceof CloudJobError && err.status === 429) {
          st.setError(throttleMessage(err))
        } else if (!(err instanceof CloudJobError && err.message === 'polling aborted')) {
          st.setError(err instanceof Error ? err.message : String(err))
        }
        onQuotaChange?.()
      } finally {
        activeJobId = null
        activeAbort = null
        const st = useCreateStore.getState()
        st.setIsGenerating(false)
        st.setProgress(0)
      }
    },
    [onQuotaChange],
  )

  // Video super-resolution on a finished cloud render ("Enhance" in the
  // Lightbox). Re-signs the item's result URL, submits a video:upscale job
  // against the user's own storage clip, polls, and lands the enhanced clip
  // as a new gallery item. Runs through the same isGenerating choreography.
  const enhanceVideo = useCallback(
    async (item: GalleryItem, targetResolution: '720p' | '1080p' = '1080p') => {
      const s = useCreateStore.getState()
      if (s.isGenerating || !item.jobId) return
      s.setError(null)
      s.setIsGenerating(true)
      s.setProgressPhase('queued')
      s.setProgress(5, 'Fetching the source clip…')
      // Same pre-await arming as generate(): a Cancel during the re-sign
      // window must stop the run before the credit-claiming submit.
      const ac = new AbortController()
      activeAbort = ac
      try {
        // Fresh signed URL — the stored one expires ~1 h after the last read.
        const sourceJob = await getJob(item.jobId)
        if (!sourceJob.result_url) throw new Error('The source clip has expired, re-render it first.')

        if (ac.signal.aborted) return

        s.setProgress(10, 'Submitting to the render queue…')
        const { id } = await submitCloudJob({
          kind: 'video',
          model: item.model || 'wan-2.2-720p',
          prompt: '',
          params: { op: 'upscale', source_url: sourceJob.result_url, target_resolution: targetResolution },
        })
        // Same submit-window race as generate(): cancel the just-queued job
        // if the user aborted while the POST was in flight.
        if (ac.signal.aborted) {
          cancelJob(id).then(() => onQuotaChange?.()).catch(() => {})
          return
        }
        activeJobId = id
        onQuotaChange?.()

        const startedAt = Date.now()
        const job = await pollJob(id, {
          timeoutMs: 45 * 60_000,
          signal: ac.signal,
          onTick: (j) => {
            const st = useCreateStore.getState()
            const elapsed = Math.round((Date.now() - startedAt) / 1000)
            if (j.status === 'queued') {
              st.setProgressPhase('queued')
              st.setProgress(15, `Waiting for a cloud GPU… ${elapsed}s`)
            } else if (j.status === 'running') {
              st.setProgressPhase('sampling')
              st.setProgress(Math.min(90, 20 + elapsed), `Enhancing in the cloud… ${elapsed}s`)
            }
          },
        })

        const st = useCreateStore.getState()
        if (job.status === 'succeeded' && job.result_url) {
          st.setProgressPhase('complete')
          st.setProgress(100, 'Complete!')
          st.addToGallery({
            ...item,
            id: job.id,
            createdAt: Date.now(),
            remoteUrl: job.result_url,
            dataUrl: undefined,
            attestation: job.attestation,
            jobId: job.id,
          })
        } else if (job.status !== 'canceled') {
          st.setError(job.error ?? 'Cloud enhance failed.')
          onQuotaChange?.()
        }
      } catch (err) {
        const st = useCreateStore.getState()
        if (err instanceof CloudJobError && err.status === 429) {
          st.setError(throttleMessage(err))
        } else if (!(err instanceof CloudJobError && err.message === 'polling aborted')) {
          st.setError(err instanceof Error ? err.message : String(err))
        }
        onQuotaChange?.()
      } finally {
        activeJobId = null
        activeAbort = null
        const st = useCreateStore.getState()
        st.setIsGenerating(false)
        st.setProgress(0)
      }
    },
    [onQuotaChange],
  )

  return { generate, cancel, enhanceVideo, makeVoice }
}
