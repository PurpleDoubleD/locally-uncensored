// Cloud twin of useCreate's generate/cancel — port of the web app's useCloudCreate
// onto the desktop cloud client (bearer auth via api/cloud/jobs). Submits the
// current Create state to the hosted render queue instead of local ComfyUI,
// then polls to completion. Store choreography (isGenerating, progress,
// gallery) mirrors the local path so every downstream component works
// unchanged. useCreate itself is untouched: the seam lives in CreateExpProvider.
//
// Desktop delta vs the web app: results keep remoteUrl + jobId in the persisted
// gallery — multi-MB base64 dataUrls would blow the localStorage quota and
// kill all create-store persistence. Signed URLs expire ~1 h after the last
// read, so playback surfaces re-sign lazily via refreshResultUrl().

import { dataUrlToBlob } from '../lib/render/data-url'
import { useCallback } from 'react'
import { isMobile } from '../lib/device-kind'
import { limitSentence } from '../lib/limit-sentence'
import { platformText } from '../lib/platform-text'
import { forgetPendingCloudJob, noteCloudSubmitIntent, notePendingCloudJob, settleCloudSubmitIntent, unwatchCloudJob } from '../lib/pending-cloud-jobs'
import type { CloudSubmitIntent } from '../lib/pending-cloud-jobs'
import { useCreateStore, type GalleryItem } from '../stores/createStore'
import { intentToJob, galleryItemFromJob } from '../lib/render/cloud-jobs'
import {
  cancelJob,
  getJob,
  pollJob,
  submitCloudJob,
  uploadInput,
  CloudJobError,
  QuoteChangedError,
  type CloudJobParams,
  type CloudJob,
} from '../api/cloud/jobs'
import { defaultCloudModel, editNeedsMask, modelForOp, utilityOpModel, resolveOpPick, cloudModelById, cloudMediaLive, resolveCharacterModel, lengthCredits, lengthPrice } from '../stores/cloudCatalogStore'
import { checkPromptSafety, blockMessageFor, type SafetyVerdict } from '../lib/render/safety'
import { contentPolicySnapshot, loadContentPolicy } from './useContentPolicy'
import { effectiveContentPolicy } from '../lib/content-policy-cap'
import { signalCreditsExhausted } from '../lib/credits-exhausted'
import { resolveRunSeed } from '../lib/run-seed'
import { intentRoles, intentRequiredInputs, isStudioModel, resolveIntentPick, studioExtraPhotoSlots } from '../lib/render/create-studio'
import { bumpSeed, runImageCount } from '../lib/render/image-count'
import { STUDIO_MODELS, studioFields } from '../lib/render/studio-contract'
import { modelLabel } from '../lib/render/preset-models'
import { IMPROVING_PROMPT } from '../lib/render/improve-prompt'
import { improveKindForRun } from '../lib/render/music-ui'
import { intentTakesPrompt } from '../components/create/experimental/intents'
import { rewrittenByName } from '../lib/render/qwen-enhancer'
import { elapsedLine } from '../lib/elapsed-line'
import { improvePrompt } from '../lib/render/improve-prompt-run'
import { currentChatModelList, currentHelperModel } from '../lib/cloud-helper-model'
import { bookedVideoSeconds } from '../lib/render/video-duration'
import { studioQuote, StudioQuoteChangedError } from '../api/cloud/studio'
// LU Cloud outage (lib/cloud-outage.ts): a request that failed reads the
// server's sentence instead of the raw error while one is announced.
import { outageAfterFailure } from '../lib/cloud-outage-watch'
import { MIN_TRAIN_IMAGES, maxTrainImages } from '../lib/train-image-cap'
import { forgetStaged, stagedMayBeStale, uploadTrainPhotos } from '../lib/train-upload'

// B3 (review-w2ui.md, 18.09.2026): the CSAM floor above runs regardless of
// tier, but the adult half of safety.ts (ADULT_SOFT_TERMS/ADULT_HARD_TERMS)
// only ever fires on tier: 'cloud', which no caller passed until now, making
// half the module unreachable. R5-9 exists precisely so "the rejection comes
// before the upload" for the cloud path too, matching the web app's own
// useCloudCreate (the web app, clientSafety()).
//
// If the account policy has not loaded yet, this checks CSAM only ('off'):
// never block on a guessed rule, the server is the authority for the rest,
// same reasoning as the web app's own comment on clientSafety().
function clientSafety(text: string, negative?: string): SafetyVerdict {
  const account = contentPolicySnapshot()
  if (!account) void loadContentPolicy() // for the next run
  // A store build of the phone app caps the level (lib/content-policy-cap.ts):
  // an account set to Off on the website is still checked with the filtered
  // level here, and an unknown level is the cap, never 'off'. No cap on the
  // desktop: the line is what it was.
  const policy = effectiveContentPolicy(account)
  return checkPromptSafety(text, { tier: 'cloud', policy: policy ?? 'off', negative })
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
// The queue answers 429 for five different things (lib/http-status states the
// same policy for the chat path): the per-user burst guard and an upstream
// provider throttle, both transient and both carrying retry-after, and three
// that are about money, each with a different way out. Every one of them used
// to read "Monthly credit budget exhausted, upgrade your plan", so a subscriber
// who was merely clicking too fast, with credits left in the meter next to the
// message, was told to buy a bigger plan.
//
// The repair after that asked `/credit/i` about the message, and the server's
// video-budget sentence carries the word "credits". The wrong branch won and
// the customer was offered a plan change instead of the pack that unblocks him
// (R5-49). `trainings_exhausted` carries the word nowhere and fell into the
// throttle text, which points at a clock that never runs out (R5-50). So the
// code the server sends decides, in that order, and the heuristic is gone: a
// message is prose, a code is a decision. Wordings come from the web
// (the web app), because the same refusal must not read
// differently depending on which of the two apps the customer happens to use.
export function throttleMessage(err: CloudJobError): string {
  switch (err.code) {
    case 'credits_exhausted':
      // R5-52: the buy dialog had exactly one caller and it sat in the chat
      // path, so a render that ran the wallet dry left the customer with a red
      // line and no way to pay.
      signalCreditsExhausted('credits')
      return "You're out of credits. Load up your credits or upgrade your plan."
    case 'video_budget_exhausted':
      // R5-51: this cap and 'trainings_exhausted' below used to only print a
      // line and never opened the dialog, so a Create render that hit either
      // one left the customer with prose and no way to act on it, same gap
      // R5-52 had already found and closed for 'credits_exhausted'.
      signalCreditsExhausted('video_budget')
      return "This month's video budget is used up. Top-up credits keep video going, or upgrade your plan."
    case 'trainings_exhausted':
      signalCreditsExhausted('trainings')
      // B1 (review-a1.md): a pack buyer with topup credits can still start a
      // training the moment this fires, the server race between quota read
      // and submit is what triggers it. The old sentence only offered a plan
      // change and hid that path, so it now matches the web word for word
      // (89055415, the web app).
      return 'Your included character trainings are used up. Top-up credits keep training going, or upgrade your plan.'
  }
  // On a phone the server's own sentence is the message (lib/request-limit.ts
  // through lib/limit-sentence.ts): only the server knows whose limit it was.
  if (isMobile()) return limitSentence(err)
  const secs = err.retryAfterMs && err.retryAfterMs > 0 ? Math.ceil(err.retryAfterMs / 1000) : null
  return secs
    ? `Too many requests at once. Wait ${secs}s and try again.`
    : 'Too many requests at once. Wait a moment and try again.'
}

// Lives in lib/render/data-url.ts; exported from here for the Create tab's own callers.
export { dataUrlToBlob }

/** On a phone a staged upload ends with the run's own Cancel: a clip that
 *  goes up over a phone line can take minutes, and nothing else could stop it.
 *  The desktop call stays exactly the two arguments it always was. */
function uploadEnds(ac: AbortController): [] | [{ signal: AbortSignal }] {
  return isMobile() ? [{ signal: ac.signal }] : []
}

/** True for the rejection a cancelled upload leaves behind on a phone. It is
 *  the user's own Stop, so it is not an error to show. */
function uploadWasCancelled(err: unknown, ac: AbortController): boolean {
  return isMobile() && ac.signal.aborted && !(err instanceof CloudJobError)
}

/** How long the live run waits for a job of this kind. */
function runDeadlineMs(kind: string, op: string): number {
  return kind === 'video' || op === 'lora-train' ? 45 * 60_000 : 15 * 60_000
}

/**
 * submitCloudJob with its intent written down first (durchsicht-mobile H2).
 *
 * The client_request_id goes to disk BEFORE the request leaves, so a phone
 * that kills the app between the tap and the answer still knows which job to
 * ask the server for. A clear answer ends the intent here (a "no" booked
 * nothing); a "yes" keeps it until the caller has written the jobs into the
 * ledger and calls settleCloudSubmitIntent itself. An answer that leaves the
 * fate of the booking open (line dropped, 5xx) keeps the intent, and the next
 * resume pass asks for the id. No-op bookkeeping on a desktop.
 */
async function submitNoted(
  submit: Parameters<typeof submitCloudJob>[0],
  meta: Pick<CloudSubmitIntent, 'timeoutMs' | 'landing' | 'items'> & { op: string; prompt: string },
): Promise<Awaited<ReturnType<typeof submitCloudJob>>> {
  const requestId = submit.params.client_request_id
  if (!requestId) return submitCloudJob(submit)
  const count = typeof submit.params.count === 'number' && submit.params.count > 1 ? submit.params.count : 1
  noteCloudSubmitIntent({
    requestId, count, kind: submit.kind, op: meta.op, model: submit.model, prompt: meta.prompt,
    sentAt: Date.now(), timeoutMs: meta.timeoutMs, landing: meta.landing, items: meta.items,
  })
  try {
    return await submitCloudJob(submit)
  } catch (err) {
    const status = err instanceof CloudJobError ? err.status : 0
    settleCloudSubmitIntent(requestId, status >= 400 && status < 500 && status !== 408)
    throw err
  }
}

/**
 * pollJob, plus the bookkeeping of lib/pending-cloud-jobs.ts.
 *
 * A job that reached an end state is struck from the ledger, and so is one the
 * server refuses for good. Everything else (the client deadline, a dead line,
 * a Cancel whose answer never came) leaves the entry in place and only gives
 * up the watch, so resumePendingCloudJobs() asks again later and lands or
 * drops it by the server's own word. On a desktop the ledger is empty and both
 * calls find nothing to do.
 */
async function pollTracked(id: string, opts: Parameters<typeof pollJob>[1]): Promise<CloudJob> {
  try {
    const job = await pollJob(id, opts)
    forgetPendingCloudJob(id)
    return job
  } catch (err) {
    const status = err instanceof CloudJobError ? err.status : 0
    const definitive = status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
    if (definitive) forgetPendingCloudJob(id)
    else unwatchCloudJob(id)
    throw err
  }
}

// The in-flight job handle lives at module scope, matching the lifetime of the
// generate() closure (which keeps polling across view switches). Instance refs
// died with the Create view's remount, leaving the Cancel button a no-op
// mid-render. At most one cloud job runs per app (the store-level isGenerating
// gate), so a singleton is correct.
/** Shown when Cancel reaches a job a GPU already took. */
export const RENDER_CANNOT_STOP =
  "This render already started and can't be stopped. It will finish, is charged, and lands in your gallery."

/** Shown when the cloud answers 401 to a render, a voice or an enhance. */
export const SIGN_IN_TO_RENDER = 'Sign in to your LU Cloud account to render in the cloud.'

let activeJobId: string | null = null
// Alle Auftraege eines Laufs mit mehreren Bildern; der erste steht auch in
// activeJobId. Cancel bricht jeden einzelnen ab.
let activeJobIds: string[] = []
let activeAbort: AbortController | null = null

/** True while a cloud run (generate or enhance) is in flight. CreateContext
 *  routes Cancel by the backend that STARTED the run, not the current axis —
 *  the header switch (or the 5-min license probe) can flip local/cloud
 *  mid-render, and a mis-routed cancel strands a billing cloud job. */
export const hasActiveCloudRun = (): boolean => activeAbort !== null

/** Why the last generate() was refused, when the reason holds for the next run
 *  too. A batch over several source images (lib/batch-edit) reads it after each
 *  image to decide whether going on makes sense. A code, never the message. */
export interface CloudRunStop { reason: 'credits' | 'price' | 'auth' | 'throttle'; retryAfterMs?: number }
let lastRunStop: CloudRunStop | null = null
/** Reads the reason once and clears it. */
export function takeCloudRunStop(): CloudRunStop | null {
  const stop = lastRunStop
  lastRunStop = null
  return stop
}

export function useCloudCreate(opts: { onQuotaChange?: () => void } = {}) {
  const { onQuotaChange } = opts

  const generate = useCallback(async () => {
    const s = useCreateStore.getState()
    if (s.isGenerating) return
    lastRunStop = null
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
    // Portplan P7: the four role intents (lipsync/music/extend/motion) reach
    // the Studio track through the SAME picker as their classic op-specialized
    // models (create-studio.ts, ported P2); resolveIntentPick's list already
    // contains both, so it replaces resolveOpPick for exactly these four.
    // Character-use never touches Studio: it stays on its fixed -lora family.
    const roleIntent = !characterUse && intentRoles(intent).length > 0
    let picked: string
    if (characterUse) {
      picked = resolveCharacterModel(s.selectedCharacter?.family ?? '', s.cloudOpModel) ?? ''
    } else if (roleIntent) {
      picked = resolveIntentPick(intent, s.cloudOpModel)
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
    // submit never 400s. Seit 02.10.2026 fuehren Image, Edit, Video und Animate
    // auch Studio-Modelle (Web-Paritaet), also laeuft die Wahl IMMER durch
    // modelForOp, und erst das Ergebnis sagt, ob der Lauf ein Studio-Lauf ist.
    // Eine Rollen-Absicht behaelt ihre Wahl.
    const model = roleIntent ? picked : modelForOp(kind, op, picked)
    // A Studio pick runs its own schema-driven endpoint (op: 'studio'), never a
    // classic op shape. The character use-surface stays on its fixed -lora family.
    const studioModel = !characterUse && isStudioModel(model) ? model : undefined
    if (studioModel) kind = STUDIO_MODELS[studioModel].kind
    // The result carries the customer's own pick. A utility op that swapped a
    // Studio pick out (utilityOpModel) must not make addToGallery jump the
    // picker to the default or overwrite a saved choice.
    const galleryModel = !roleIntent && model !== picked && model === utilityOpModel(kind, op, picked) ? picked : model

    // Bilder in diesem Lauf: nur Bild und Bearbeiten kennen mehr als eins.
    const count = runImageCount(intent, s.cloudImageCount, characterUse)
    // The prompt of this run. A view without a prompt field (Talking Character,
    // Motion Control, the utility ops, training) sends none: the store holds one
    // prompt for every tab, and the text left from another tab would steer the
    // run unseen or fail the content check for words nobody sees here.
    const prompt = intentTakesPrompt(intent, characterUse) ? s.prompt : ''
    s.setError(null)
    if (!cloudMediaLive()) {
      // Server MEDIA_LIVE switch is off — the GPU fleet isn't up, a submit
      // would only 503. Mirror the server's honest "coming soon".
      s.setError('Cloud rendering is coming soon, the GPU fleet is not live yet.')
      return
    }
    if ((op === 'generate' || op === 'music' || op === 'tts') && prompt.trim().length === 0) {
      s.setError('Please enter a prompt.')
      return
    }
    // Client-side CSAM + account-adult-policy gate (UX) over every free-text
    // field this run sends. The server additionally enforces its own policy
    // read fresh from the account row, its 422 message lands in setError
    // below either way; this only saves the round trip when the client
    // already knows the verdict (B3).
    {
      // The negative prompt is read apart (B30, safety.ts). Only what this
      // run sends is read, same conditions as the params below: the store
      // keeps negative prompt, lyrics and trigger word across modes, and a
      // field this mode neither shows nor sends must not block it unseen
      // (B30, web fix fb714de4).
      const sendsClassicKnobs = !studioModel && !specialOp && op !== 'removebg' && op !== 'upscale' && op !== 'eraser'
      const lyrics = op === 'music' && !studioModel ? s.musicLyrics : ''
      const triggerWord = op === 'lora-train' ? s.triggerWord : ''
      const verdict = clientSafety(`${prompt} ${lyrics} ${triggerWord}`, sendsClassicKnobs ? s.negativePrompt : '')
      if (verdict.blocked) {
        s.setError(blockMessageFor(verdict.reason))
        return
      }
    }
    // Per-intent input contracts (client UX; the server re-checks all of it).
    if (characterUse && !s.selectedCharacter) {
      s.setError('Pick a character from your shelf first, or train one.')
      return
    }
    if (characterUse && !model) {
      s.setError('No generation model works with this character right now.')
      return
    }
    if (op === 'lora-train' && s.trainImages.length < MIN_TRAIN_IMAGES) {
      s.setError(`Add at least ${MIN_TRAIN_IMAGES} photos of your character (more is better, up to ${maxTrainImages('cloud')}).`)
      return
    }
    // Staged locally, where the limit is higher, then switched to Cloud: the
    // job API refuses more than its cap, so say how many to remove first.
    if (op === 'lora-train' && s.trainImages.length > maxTrainImages('cloud')) {
      s.setError(`Cloud training takes up to ${maxTrainImages('cloud')} photos. Remove ${s.trainImages.length - maxTrainImages('cloud')} and try again.`)
      return
    }
    // A Studio pick names its own required inputs (studio-contract.ts's
    // schema). A presenter endpoint (HeyGen) reads only the voice and needs
    // no photo at all, unlike every classic lipsync model.
    const studioRequired = studioModel ? intentRequiredInputs(intent, studioModel) : []
    if (op === 'lipsync') {
      if (!s.audioInput && !s.voiceFromJob) {
        s.setError('Add a voice first, upload an audio file or pick a generated one.')
        return
      }
      if (studioModel) {
        if (studioRequired.includes('source_path') && !s.source) {
          s.setError('Add a portrait image for your character.')
          return
        }
        if (studioRequired.includes('video_path') && !s.videoInput) {
          s.setError('Add the video clip to re-sync.')
          return
        }
      } else {
        const needsClip = cloudModelById(model)?.lipsync_source === 'video'
        if (needsClip ? !s.videoInput : !s.source) {
          s.setError(needsClip ? 'Add the video clip to re-sync.' : 'Add a portrait image for your character.')
          return
        }
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
    // Studio: only the fields THIS endpoint's schema actually knows,
    // stored options are per-model in the store (cloudOpModel keyed), but
    // setCloudOpModel already drops them on a model switch (createStore, P5)
    // and this filter is the second net: a stray key from a schema this
    // model does not share must not go out, or the request looks like it
    // asked for something it never did (Portplan: "wirft einen Rest aus
    // einem anderen Modell weg, statt ihn mitzuschicken"). Full type
    // validation against the schema happens server-side (prepareStudio());
    // studio-contract.ts's own `studioOptions()` is used for the on-screen
    // PRICE PREVIEW only (useStudioPrice), never to gate or reshape a submit.
    const studioOptionsFiltered = studioModel
      ? Object.fromEntries(
          Object.entries(s.cloudStudioOptions).filter(([key]) => studioFields(studioModel)[key] !== undefined),
        )
      : undefined

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
    // Idempotency key (Portplan Abschnitt 4/6): a retried submit after a
    // dropped response replays the SAME booking server-side instead of
    // charging twice (CloudJobSubmitResult.replayed).
    const requestId = crypto.randomUUID()

    try {
      // Utility endpoints (removebg/upscale/eraser) and the 2.5.8 specialized
      // ops take no generation knobs — send only what the op consumes so the
      // submit schema stays honest.
      const isUtility = op === 'removebg' || op === 'upscale' || op === 'eraser'
      const bare = isUtility || specialOp
      // Whether this run sends negative prompt, steps and CFG (the classic
      // shape below). The gallery entry records them only then.
      const classicKnobs = !studioModel && !bare
      // Studio: a schema-driven step booked against its own `studio_options`,
      // never one of the fixed classic shapes below. max_credits is filled
      // in once the price is confirmed, after the uploads (Portplan Abschnitt
      // 3, GEBUCHT wird nur gegen den bestaetigten Serverpreis).
      const params: CloudJobParams = studioModel
        ? { op: 'studio', studio_options: studioOptionsFiltered, client_request_id: requestId }
        : bare
          ? { op, client_request_id: requestId }
          : {
              op,
              client_request_id: requestId,
              negative_prompt: s.negativePrompt || undefined,
              width: s.width,
              height: s.height,
              steps: s.steps,
              cfg: s.cfgScale,
              seed: runSeed,
            }
      // Ein Studio-Modell traegt Laenge und Aufloesung in studio_options (sein
      // Schema), nicht in frames/fps: bookedVideoSeconds kennt nur die klassischen
      // Laengenlisten und wuerfe fuer ein Studio-Modell einen Fehler.
      if (kind === 'video' && !bare && !studioModel) {
        // dd29f359 (Portplan Abschnitt 6), review A2 (Runde 2): book exactly
        // a length the model prices, read from the SAME catalog-first list
        // LaneControls shows (effectiveVideoDurations, in video-duration.ts),
        // never the static JSON alone, that mismatch silently booked a
        // shorter clip than the one shown and priced (review-studio-A.md
        // B2). bookedVideoSeconds throws loud, in English, if frames/fps
        // still fall outside the model's list, before any credit is claimed.
        // Review A kleiner Punkt 1 (studio-r2): reads the cloud track's OWN
        // cloudFrames/cloudFps, the same fields LaneControls' Length control
        // writes, not the local track's shared frames/fps.
        const seconds = bookedVideoSeconds(model, { frames: s.cloudFrames, fps: s.cloudFps })
        params.frames = seconds * 16
        params.fps = 16
      }
      if (op === 'music' && !studioModel) {
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
      // Instruction editors (maskless in the catalog, every studio editor) edit
      // from the prompt alone: no mask demand, no inpaint knobs, and a leftover
      // painted mask is not sent (the endpoint has no input for it).
      const editIsMaskless = op === 'edit' && !editNeedsMask(model)
      if (op === 'edit' && !studioModel) {
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
      // Ein Studio-Upscaler traegt sein Ziel in studio_options.
      if (op === 'upscale' && !studioModel) {
        params.target_resolution = s.targetResolution
      }
      // ImageRef.url is always a data URL preview; the cloud path re-uploads
      // from it, so a source picked while on the local backend still works.
      // Also exactly what a Studio role's `image` input needs (source_path),
      // the SAME staged upload, studio-contract.ts just names it a schema
      // field instead of a fixed param.
      if (op !== 'generate' && s.source) {
        params.source_path = await uploadInput(dataUrlToBlob(s.source.url), 'source', ...uploadEnds(ac))
        // Ein Studio-Modell, das eine Bilderliste liest (Edit mit mehreren
        // Vorlagen, Referenz zu Video), bekommt das Standbild der Oberflaeche als
        // einzigen Eintrag. Liest es kein source_path, geht das Bild nur dorthin.
        if (studioModel) {
          const reads = Object.values(STUDIO_MODELS[studioModel].inputs)
          if (reads.includes('image_paths')) {
            // Das Standbild ist das erste Foto, die Leiste liefert die weiteren
            // bis zur Grenze dieses Modells. Jedes geht in die eigene Ablage.
            const extras = intent === 'edit' || intent === 'animate'
              ? s.references.slice(0, studioExtraPhotoSlots(studioModel)) : []
            const more: string[] = []
            for (const [i, ref] of extras.entries()) {
              if (ac.signal.aborted) return
              s.setProgress(6, `Uploading photos… ${i + 2}/${extras.length + 1}`)
              more.push(await uploadInput(dataUrlToBlob(ref.url), 'source', ...uploadEnds(ac)))
            }
            params.image_paths = [params.source_path, ...more]
          }
          if (!reads.includes('source_path')) delete params.source_path
        }
      }
      if ((op === 'edit' && !editIsMaskless) || op === 'eraser') {
        if (!s.mask) {
          s.setError(
            op === 'eraser'
              ? 'Paint a mask first, the eraser removes what you painted.'
              : 'Paint a mask first, the edit only changes the painted area.',
          )
          s.setIsGenerating(false)
          return
        }
        params.mask_path = await uploadInput(dataUrlToBlob(s.mask.url), 'mask', ...uploadEnds(ac))
      }
      // ── 2.5.8 specialized inputs ──
      if ((op === 'lipsync' || op === 'motion') && s.videoInput) {
        s.setProgress(6, 'Uploading video…')
        params.video_path = await uploadInput(s.videoInput.blob, 'video', ...uploadEnds(ac))
      }
      if (op === 'lipsync') {
        if (s.audioInput) {
          s.setProgress(8, 'Uploading audio…')
          params.audio_path = await uploadInput(s.audioInput.blob, 'audio', ...uploadEnds(ac))
        } else if (s.voiceFromJob && studioModel) {
          // A Studio role's `audio` input is always a staged path
          // (studio-models.json never lists `audio_url`), re-upload rather
          // than pass the signed URL through, unlike the classic branch below.
          s.setProgress(8, 'Fetching the voice…')
          const vj = await getJob(s.voiceFromJob.jobId)
          if (!vj.result_url) throw new Error('That voice has expired, generate it again first.')
          const res = await fetch(vj.result_url)
          if (!res.ok) throw new Error('Could not load the generated voice.')
          params.audio_path = await uploadInput(await res.blob(), 'audio', ...uploadEnds(ac))
        } else if (s.voiceFromJob) {
          // A prior own render (tts/music) — fresh signed URL, zero re-upload.
          const vj = await getJob(s.voiceFromJob.jobId)
          if (!vj.result_url) throw new Error('That voice has expired, generate it again first.')
          params.audio_url = vj.result_url
        }
      }
      if (op === 'lora-train') {
        if (isMobile()) {
          // On a phone the line drops. Photos that went up in an earlier
          // attempt keep their staged path, so "Try again" goes on where it
          // stopped (lib/train-upload.ts).
          const paths = await uploadTrainPhotos(s.trainImages.map((img) => img.blob), {
            upload: (photo) => uploadInput(photo, 'train', ...uploadEnds(ac)),
            aborted: () => ac.signal.aborted,
            onStep: ({ index, total }) => s.setProgress(5, `Uploading training photos… ${index + 1}/${total}`),
          })
          if (!paths) return
          params.image_paths = paths
        } else {
          const paths: string[] = []
          for (const [i, img] of s.trainImages.entries()) {
            if (ac.signal.aborted) return
            s.setProgress(5, `Uploading training photos… ${i + 1}/${s.trainImages.length}`)
            paths.push(await uploadInput(img.blob, 'train', ...uploadEnds(ac)))
          }
          params.image_paths = paths
        }
      }
      if (op === 'extend' && s.extendSource) {
        const src = await getJob(s.extendSource.jobId)
        if (!src.result_url) throw new Error('The source clip has expired, re-render it first.')
        if (studioModel) {
          // A Studio extend role reads a staged `video_path`, not a URL the
          // provider would have to fetch itself, re-upload the finished clip
          // (mirrors the Preset Workshop's own adopt()).
          s.setProgress(6, 'Fetching the clip to extend…')
          const res = await fetch(src.result_url)
          if (!res.ok) throw new Error('Could not load the clip to extend.')
          params.video_path = await uploadInput(await res.blob(), 'video', ...uploadEnds(ac))
        } else {
          params.source_url = src.result_url
        }
      }

      // "Improve my prompt": the chat model the user picked rewrites the prompt
      // for this model before the run. On LU Cloud that is a small chat call,
      // billed like chat. The run sends the rewrite and the gallery keeps both.
      // A rewrite that fails never stops the run.
      let runPrompt = prompt
      let promptOriginal: string | undefined
      let rewrittenBy: string | undefined
      let improveFailed = false
      const improveKind = s.improvePrompt && !characterUse ? improveKindForRun(intent, model) : null
      if (improveKind && prompt.trim() && !ac.signal.aborted) {
        const improving = elapsedLine((text) => s.setProgress(8, text), IMPROVING_PROMPT)
        const out = await improvePrompt(prompt, { kind: improveKind, modelLabel: modelLabel(model) }, ac.signal).finally(improving.stop)
        // The safety check covers the rewrite too: the user wrote an allowed
        // prompt, the model must not turn it into a refusal.
        if (out.status === 'improved' && !clientSafety(out.prompt).blocked) {
          runPrompt = out.prompt
          promptOriginal = prompt
          rewrittenBy = rewrittenByName('chat', currentHelperModel(), currentChatModelList())
        } else if (out.status !== 'unchanged' && !ac.signal.aborted) {
          improveFailed = true
        }
      }

      // Bail before the (credit-claiming) submit if the user cancelled while
      // we were uploading inputs.
      if (ac.signal.aborted) return

      // Review A1/B3 (Runde 2, 20.09.2026): a Studio run books against a
      // SERVER-CONFIRMED number, never the client formula alone
      // (studio-contract.ts's createStudioCost is a PREVIEW for the meter,
      // this call is what actually gets charged). Fetched HERE, right after
      // the uploads and right before the credits claim, against the SAME
      // staged paths the submit below sends, that is "before the render
      // starts" for every Studio pick, including the 17 price.mode
      // 'input'/'both' endpoints (talking/presenter/duo/motion/restyle/
      // upscale/extend) that Composer's live meter can only PREVIEW: those
      // price off the uploaded file's measured length, which the provider
      // only knows once the file is staged, so a true confirmed number
      // cannot exist before this point without uploading a file the
      // customer might never submit. useStudioPrice (Composer's live meter)
      // already confirms output/characters-mode picks continuously while
      // typing; this call re-confirms fresh, right before the claim, so a
      // stale live quote can never book either.
      //
      // Bewusste Abweichung von der Web-Referenz (Portplan Abschnitt 4/7):
      // the web app sendet `max_credits` NIE aus dem
      // normalen Create-Weg, nur die Preset-Werkstatt tut das
      // (PresetWorkshop.tsx:191). Das Web bucht also aus dem Create-Tab ohne
      // Deckel, genau das Risiko 1 des Portplans. Der Desktop weicht hier
      // bewusst ab und deckelt auch den Create-Tab. Der Eigner sollte den
      // Web-Client nachziehen (review-studio-A.md B1, review-studio-B.md B3).
      if (studioModel) {
        s.setProgress(9, 'Confirming the price…')
        const quoteFields: Record<string, unknown> = {}
        for (const k of ['source_path', 'image_paths', 'mask_path', 'audio_path', 'audio2_path', 'video_path', 'last_image_path', 'shot_type'] as const) {
          if (params[k] !== undefined) quoteFields[k] = params[k]
        }
        const quote = await studioQuote(studioModel, runPrompt, {
          op: 'studio',
          studio_options: studioOptionsFiltered ?? {},
          ...quoteFields,
        })
        // Review A kleiner Punkt 1 (Runde 3, 20.09.2026): the cap is the
        // SERVER's confirmed number, not the number the customer actually
        // saw before pressing Create. That protects LU (never books more
        // than the provider confirms) but not the customer (a quote that
        // came back higher than the shown price would still book, silently,
        // just like the bug this whole mechanism exists to close). Compare
        // against `s.cloudStudioCredits`, the same value CreditsMeter/the
        // Composer meter rendered at the moment this run started: a HIGHER
        // confirmed number is treated exactly like a 409 quote_changed (new
        // price shown, a second click required, nothing booked this time). A
        // LOWER or equal confirmed number books directly, same as before,
        // since the customer never sees a bill bigger than what was shown.
        // `cloudStudioCredits` can be null in the narrow race before the
        // meter's first paint; nothing to compare against there, so that
        // case books as before rather than blocking on nothing.
        if (s.cloudStudioCredits !== null && quote.credits > s.cloudStudioCredits) {
          throw new StudioQuoteChangedError(
            'The price changed. Review the new quote before starting.',
            quote.credits,
            quote.seconds,
          )
        }
        params.max_credits = quote.credits
      } else if (lengthPrice(model, op)) {
        // A classic model the provider meters by the length of its input (lip
        // sync, motion): the ceiling is the figure on the meter, the price of
        // the length the Composer measured. The server measures itself; when
        // its figure is higher it answers 409 quote_changed with the new
        // price (the catch below shows it and asks for a second click), and
        // a start without a ceiling only gets what the catalogue figure
        // covers. A server from before length billing ignores the field.
        params.max_credits = s.cloudStudioCredits ?? lengthCredits(model)
      }

      // Der Titel geht mit an den Server, sonst hiesse der Eintrag nach dem
      // naechsten Laden wieder nur nach seiner Gattung (Portplan Abschnitt 1,
      // Punkt 9). A Studio run with no prompt (or a schema whose prompt field
      // is something else entirely, e.g. a picked visual style) needs the
      // SAME fallback name classic ops already have via OP_GALLERY_LABEL;
      // galleryLabel.ts also falls back to modelLabel(model), which reads
      // STUDIO_MODELS too, so this is a convenience for the server's own
      // list view (GET /api/jobs), not the only source of the gallery name.
      let label: string | undefined
      if (studioModel) {
        label = prompt.trim() ? undefined : modelLabel(studioModel)
        if (label) params.label = label
      } else if (OP_GALLERY_LABEL[op]) {
        label = OP_GALLERY_LABEL[op]
        params.label = label
      }

      s.setProgress(10, 'Submitting to the render queue…')
      // Mehrere Bilder: der Server bucht jedes als eigenen Auftrag und nennt alle.
      if (count > 1) params.count = count
      const timeoutMs = runDeadlineMs(kind, op)
      // What this run adds to the bare job. One builder for the result that
      // lands live and for the one a phone picks up after a restart.
      const resultFields = (index = 0) => ({
        model: galleryModel,
        // The text that ran and nothing else: a lane without a prompt field
        // leaves this empty, and the name of such a run stands in `label`.
        prompt: runPrompt,
        promptOriginal,
        rewrittenBy,
        improveFailed: improveFailed || undefined,
        label,
        // D9 (3.0.7): the entry keeps what the run was sent. A Studio model
        // and a run without the classic knobs (`bare`) got no negative
        // prompt, steps, CFG or sampler, so none is written for them; the
        // panel of the result leaves a 0 out (lib/render/run-settings.ts).
        negativePrompt: classicKnobs ? s.negativePrompt : '',
        // Jeder Auftrag eines Laufs rechnet mit Keim + Index (der Server bumpt
        // den klassischen Keim; ein Studio-Lauf schickt keinen).
        seed: studioModel ? runSeed : bumpSeed(runSeed, index),
        steps: classicKnobs ? s.steps : 0,
        cfgScale: classicKnobs ? s.cfgScale : 0,
        sampler: classicKnobs ? s.sampler : '',
        scheduler: classicKnobs ? s.scheduler : '',
        width: s.width,
        height: s.height,
        intent,
      })
      let submitted: Awaited<ReturnType<typeof submitCloudJob>>
      try {
        submitted = await submitNoted({ kind, model, prompt: runPrompt, params }, {
          op, prompt: OP_GALLERY_LABEL[op] ?? runPrompt, timeoutMs,
          landing: op === 'lora-train' ? 'character' : 'gallery',
          items: Array.from({ length: count }, (_, index) => resultFields(index)),
        })
      } catch (err) {
        // The server did not take the training. An answer that may be about
        // the staged photos themselves makes the next attempt upload them all
        // again. Anything else (line dropped, wallet empty) keeps them.
        if (op === 'lora-train' && err instanceof CloudJobError && stagedMayBeStale(err.status)) {
          forgetStaged(s.trainImages.map((img) => img.blob))
        }
        throw err
      }
      // The server has the photos now: their staged paths are used up.
      if (op === 'lora-train') forgetStaged(s.trainImages.map((img) => img.blob))
      const id = submitted.id
      // Ein Server, der die Anzahl nicht kennt, bucht genau einen Auftrag und
      // nennt keine Liste: dann laeuft ein Bild, und der Kunde erfaehrt es.
      const ids = submitted.jobs?.map((j) => j.id) ?? [id]
      const oneOnly = count > 1 && !submitted.jobs
      // A Cancel during the submit round-trip saw activeJobId still null, so
      // nothing was cancelled server-side. Now that the id exists, cancel the
      // just-queued job so its claimed credits refund instead of orphaning a
      // render we're no longer watching.
      if (ac.signal.aborted) {
        settleCloudSubmitIntent(requestId, true)
        for (const jid of ids) cancelJob(jid).then(() => onQuotaChange?.()).catch(() => {})
        return
      }
      activeJobId = id
      activeJobIds = ids
      onQuotaChange?.()
      if (prompt.trim()) s.addToPromptHistory(prompt.trim())

      const startedAt = Date.now()
      // Video renders and character training routinely run several minutes
      // and can queue behind other jobs on the shared fleet — give them a
      // much longer client deadline than images.
      const verb = opProgressVerb(op)
      const addResult = (job: CloudJob, index = 0) => useCreateStore.getState().addToGallery({
        ...galleryItemFromJob(job),
        ...resultFields(index),
      })
      // Written down before the first poll: from here on the job is paid, and
      // a phone may freeze or kill the app at any line (no-op on a desktop).
      ids.forEach((jid, index) => notePendingCloudJob({
        id: jid, kind, op, model, prompt: OP_GALLERY_LABEL[op] ?? runPrompt,
        startedAt, deadlineAt: startedAt + timeoutMs,
        landing: op === 'lora-train' ? 'character' : 'gallery',
        item: resultFields(index),
      }))
      // The ids are in the ledger: the intent written before the submit is done.
      settleCloudSubmitIntent(requestId, true)

      if (ids.length > 1) {
        // Jedes Bild landet in der Galerie, sobald es fertig ist. Ein Auftrag,
        // der scheitert, stoppt die anderen nicht und gibt nur seinen Preis zurueck.
        if (submitted.stopped === 'credits_exhausted') {
          signalCreditsExhausted('credits')
          lastRunStop = { reason: 'credits' }
        }
        const finished = new Set<string>()
        const outcomes = await Promise.allSettled(ids.map(async (jid, index) => {
          const job = await pollTracked(jid, {
            timeoutMs,
            signal: ac.signal,
            onTick: (j) => {
              const st = useCreateStore.getState()
              const elapsed = Math.round((Date.now() - startedAt) / 1000)
              const base = 20 + Math.round((70 * finished.size) / ids.length)
              if (j.status === 'running') st.setProgressPhase('sampling')
              st.setProgress(Math.min(90, Math.max(base, 20 + elapsed)), `${verb} ${finished.size} of ${ids.length} done, ${elapsed}s`)
            },
          })
          finished.add(jid)
          if (job.status === 'succeeded' && job.result_url) addResult(job, index)
          return job
        }))
        const jobs = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []))
        const landed = jobs.filter((j) => j.status === 'succeeded' && j.result_url).length
        const failed = jobs.filter((j) => j.status === 'failed')
        const lost = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason] : []))
          .filter((e) => !(e instanceof CloudJobError && e.message === 'polling aborted'))
        const st = useCreateStore.getState()
        if (landed > 0) {
          st.setProgressPhase('complete')
          st.setProgress(100, 'Complete!')
        }
        const notes: string[] = []
        if (failed.length) notes.push(`${failed.length} of ${ids.length} images failed${failed[0].error ? `: ${failed[0].error}` : ''}. Failed images are refunded.`)
        if (lost.some((e) => e instanceof CloudJobError && e.message === 'render timed out')) {
          notes.push(platformText('renderStillRunningSome'))
        } else if (lost.length) {
          notes.push((await outageAfterFailure(lost[0])) ?? (lost[0] instanceof Error ? lost[0].message : String(lost[0])))
        }
        if (submitted.stopped) {
          notes.push(
            `Started ${ids.length} of ${submitted.requested ?? count} images. ` +
            (submitted.stopped === 'credits_exhausted' ? 'There were not enough credits for the rest.' : 'The rest could not be prepared. Nothing was charged for them.'),
          )
        }
        if (notes.length) st.setError(notes.join(' '))
        onQuotaChange?.() // Abbruch und Fehlschlag geben die Einheiten zurueck
        return
      }

      const job = await pollTracked(id, {
        timeoutMs,
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
        addResult(job)
        if (oneOnly) st.setError('This server renders one image per run, so one image was made and charged.')
      } else if (job.status === 'canceled') {
        st.setError(null)
      } else {
        st.setError(job.error ?? 'Cloud render failed.')
        onQuotaChange?.() // failure refunds — refresh the meter
      }
    } catch (err) {
      const st = useCreateStore.getState()
      if (err instanceof QuoteChangedError || err instanceof StudioQuoteChangedError) {
        // 409 quote_changed (Portplan Abschnitt 3/4, review A1/B3 Runde 2):
        // the confirmed number went stale between the pre-submit
        // studioQuote() call above and the server's own booking check
        // (QuoteChangedError), or the quote call itself came back stale
        // (StudioQuoteChangedError, e.g. the provider's price moved between
        // two calls, or the shown-price guard right above this catch block
        // rejected a quote higher than what the customer saw). Either way:
        // show the NEW price and stop, never silently rebook against it.
        //
        // Review B6 (Runde 4, 20.09.2026): this used to only setError, never
        // touching cloudStudioCredits, the ONE value the shown-price guard
        // compares the next quote against (Composer.tsx's meter is the only
        // writer otherwise, and nothing re-primes it unless the price key
        // itself changes). Without this line a rejected run stayed rejected
        // forever: click again, same stale low number, same rejection, on
        // and on, even though the error text promised "hit Create again"
        // would work. Setting it here means the SECOND click compares the
        // new quote against the number this message just showed, and books.
        st.setCloudStudioCredits(err.credits)
        st.setError(`The price changed to ${err.credits.toLocaleString('en-US')} credits. Review it, then hit Create again.`)
        lastRunStop = { reason: 'price' }
      } else if (err instanceof CloudJobError && err.status === 429) {
        st.setError(throttleMessage(err))
        // The three money codes end a batch, a plain "too fast" only pauses it.
        lastRunStop = err.code === 'credits_exhausted' || err.code === 'video_budget_exhausted' || err.code === 'trainings_exhausted'
          ? { reason: 'credits' }
          : { reason: 'throttle', retryAfterMs: err.retryAfterMs }
      } else if (err instanceof CloudJobError && err.status === 401) {
        st.setError(SIGN_IN_TO_RENDER)
        lastRunStop = { reason: 'auth' }
      } else if (err instanceof CloudJobError && err.message === 'render timed out') {
        // The desktop app has no jobs-history view — point at the account
        // page instead of promising an in-app surface that doesn't exist.
        st.setError(platformText('renderStillRunning'))
      } else if (uploadWasCancelled(err, ac)) {
        // The user's own Stop ended an upload. Nothing was booked, nothing to say.
      } else if (!(err instanceof CloudJobError && err.message === 'polling aborted')) {
        st.setError((await outageAfterFailure(err)) ?? (err instanceof Error ? err.message : String(err)))
      }
      onQuotaChange?.()
    } finally {
      activeJobId = null
      activeJobIds = []
      activeAbort = null
      const st = useCreateStore.getState()
      st.setIsGenerating(false)
      st.setProgress(0)
    }
  }, [onQuotaChange])

  const cancel = useCallback(async () => {
    const ids = activeJobIds.length ? activeJobIds : activeJobId ? [activeJobId] : []
    if (!ids.length) {
      activeAbort?.abort()
      return
    }
    // Bei mehreren Bildern wird jeder Auftrag einzeln abgebrochen: die noch
    // wartenden geben ihren Preis zurueck, ein schon laufender nicht.
    const results = await Promise.allSettled(ids.map((id) => cancelJob(id)))
    // 409: a GPU already took the job (bug hunt 01.10.2026, K7). The cancel
    // used to stop the polling and say nothing, so it looked cancelled while
    // it finished and kept its credits, and the desktop has no job list to
    // bring it back later. Say so, and keep polling so the result lands.
    const running = results.some((r) => r.status === 'rejected' && r.reason instanceof CloudJobError && r.reason.status === 409)
    if (running) {
      useCreateStore.getState().setError(RENDER_CANNOT_STOP)
      if (results.some((r) => r.status === 'fulfilled')) onQuotaChange?.() // the queued ones refunded
      return
    }
    activeAbort?.abort()
    if (results.some((r) => r.status === 'fulfilled')) onQuotaChange?.() // queued-cancel refunds
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
      const voiceVerdict = clientSafety(`${text} ${opts.description ?? ''}`)
      if (voiceVerdict.blocked) {
        s.setError(blockMessageFor(voiceVerdict.reason))
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
        const requestId = crypto.randomUUID()
        const params: CloudJobParams = { op: 'tts', client_request_id: requestId }
        // The price on the button (SpecialIntentControls) is the price of
        // these characters, and it goes along as the ceiling: without one the
        // server starts only what the catalogue figure covers.
        if (lengthPrice(model, 'tts')) params.max_credits = lengthCredits(model, Array.from(text).length)
        if (opts.mode === 'speak' && opts.voice) params.voice = opts.voice
        if (opts.mode === 'design' && opts.description) params.voice_description = opts.description
        const { id } = await submitNoted({ kind: 'audio', model, prompt: text, params }, {
          op: 'tts', prompt: text, timeoutMs: 15 * 60_000, landing: 'voice', items: [{ prompt: text, intent: 'lipsync' }],
        })
        if (ac.signal.aborted) {
          settleCloudSubmitIntent(requestId, true)
          cancelJob(id).then(() => onQuotaChange?.()).catch(() => {})
          return
        }
        activeJobId = id
        onQuotaChange?.()

        const startedAt = Date.now()
        notePendingCloudJob({
          id, kind: 'audio', op: 'tts', model, prompt: text,
          startedAt, deadlineAt: startedAt + 15 * 60_000,
          landing: 'voice', item: { prompt: text, intent: 'lipsync' },
        })
        settleCloudSubmitIntent(requestId, true)
        const job = await pollTracked(id, {
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
            ...galleryItemFromJob(job),
            prompt: text,
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
        } else if (err instanceof CloudJobError && err.status === 401) {
          // Same sentence as generate(): the bare "not signed in" of the
          // client named no next step.
          st.setError(SIGN_IN_TO_RENDER)
        } else if (!(err instanceof CloudJobError && err.message === 'polling aborted')) {
          st.setError((await outageAfterFailure(err)) ?? (err instanceof Error ? err.message : String(err)))
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
        const requestId = crypto.randomUUID()
        // The enhanced clip keeps the facts of the clip it was made from.
        const { id: _id, jobId: _jobId, createdAt: _at, remoteUrl: _url, dataUrl: _data, attestation: _att,
          unavailable: _un, unavailableReason: _why, reloadKey: _key, ...kept } = item
        const { id } = await submitNoted({
          kind: 'video',
          model: item.model || 'wan-2.2-720p',
          prompt: '',
          params: {
            op: 'upscale', source_url: sourceJob.result_url, target_resolution: targetResolution,
            client_request_id: requestId,
          },
        }, { op: 'upscale', prompt: item.prompt ?? '', timeoutMs: 45 * 60_000, landing: 'gallery', items: [kept] })
        // Same submit-window race as generate(): cancel the just-queued job
        // if the user aborted while the POST was in flight.
        if (ac.signal.aborted) {
          settleCloudSubmitIntent(requestId, true)
          cancelJob(id).then(() => onQuotaChange?.()).catch(() => {})
          return
        }
        activeJobId = id
        onQuotaChange?.()

        const startedAt = Date.now()
        notePendingCloudJob({
          id, kind: 'video', op: 'upscale', model: item.model || 'wan-2.2-720p', prompt: item.prompt ?? '',
          startedAt, deadlineAt: startedAt + 45 * 60_000,
          landing: 'gallery', item: kept,
        })
        settleCloudSubmitIntent(requestId, true)
        const job = await pollTracked(id, {
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
        } else if (err instanceof CloudJobError && err.status === 401) {
          // Same sentence as generate(): the bare "not signed in" of the
          // client named no next step.
          st.setError(SIGN_IN_TO_RENDER)
        } else if (!(err instanceof CloudJobError && err.message === 'polling aborted')) {
          st.setError((await outageAfterFailure(err)) ?? (err instanceof Error ? err.message : String(err)))
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
