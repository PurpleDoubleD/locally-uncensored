import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { intentToJob, quotaCostKind, type RenderKind, type RenderOp } from '../../../lib/render/cloud-jobs'
import { lengthCredits, lengthPrice, runCredits } from '../../../stores/cloudCatalogStore'
import { createRunModel, createStudioCost, isStudioModel, startImageCount } from '../../../lib/render/create-studio'
import { STUDIO_MODELS } from '../../../lib/render/studio-contract'
import { runImageCount } from '../../../lib/render/image-count'

/** What the cloud run on screen costs. One reader for the meter chip and for
 *  the list of several source images, so both name the same number. */
export interface RunCredits {
  kind: RenderKind
  op: RenderOp
  /** One result. */
  unitCost: number
  /** Results per run (1 to 4 for Image and Edit). */
  imageCount: number
  /** One run: unitCost times imageCount. */
  cost: number
}

/** Null while there is no quota yet, or no run to price. */
export function useRunCredits(): RunCredits | null {
  const { quota } = useCreateExp()
  const intent = useCreateStore((s) => s.intent())
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const characterTab = useCreateStore((s) => s.characterTab)
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  // Review A kleiner Punkt 1: this meter is cloud-only (Composer renders it
  // only for backend 'cloud'), so it must price the SAME length the cloud
  // Length control shows and useCloudCreate books, cloudFrames/cloudFps, not
  // the local track's frames/fps.
  const frames = useCreateStore((s) => s.cloudFrames)
  const fps = useCreateStore((s) => s.cloudFps)
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const targetResolution = useCreateStore((s) => s.targetResolution)
  const cloudStudioOptions = useCreateStore((s) => s.cloudStudioOptions)
  const cloudStudioCredits = useCreateStore((s) => s.cloudStudioCredits)
  const prompt = useCreateStore((s) => s.prompt)
  const cloudImageCount = useCreateStore((s) => s.cloudImageCount)
  const references = useCreateStore((s) => s.references)
  if (!quota) return null
  // No character picked yet: there is no run to price (resolveCharacterModel
  // would fall onto the family's first model and show a number for a run
  // nobody asked for). the web app fixed the same false reading.
  if (intent === 'character' && characterTab === 'use' && !selectedCharacter) return null

  let { kind, op } = intentToJob(intent)
  // Mirror Composer's creditsOk pick exactly: meter and gate must show the
  // same number: the character use-surface prices the family's real
  // generation endpoint (never a hardcoded single default), the role
  // intents (lipsync/music/extend/motion) run whichever Studio or classic
  // op-picker model is chosen, everything else prices the per-kind
  // picker's model.
  const characterUse = intent === 'character' && characterTab === 'use'
  if (characterUse) {
    kind = 'image'
    op = 'generate'
  }
  // Dieselbe Aufloesung wie Composer, Speicher und Start (createRunModel): eine
  // Wahl, die die Unterkategorie nicht fahren kann, rechnet hier als das Modell,
  // das wirklich laeuft.
  const model = createRunModel(
    intent,
    { image: cloudImageModel, video: cloudVideoModel, op: cloudOpModel },
    characterUse ? selectedCharacter?.family ?? '' : undefined,
  )
  // Ein Studio-Modell rechnet nach seinem eigenen Schema, auch aus Image, Edit,
  // Video und Animate (seit 02.10.2026).
  const studioPick = !characterUse && isStudioModel(model) ? model : undefined
  if (studioPick) kind = STUDIO_MODELS[studioPick].kind
  const seconds =
    op === 'music'
      ? musicDuration
      : kind === 'video' && (op === 'generate' || op === 'animate') && fps > 0
        ? frames / fps
        : undefined
  // A Studio model prices from its own provider schema, never runCredits()
  // (P3's guard there returns the caller's fallback on purpose, Portplan
  // Abschnitt 7, Risiko 1). The Composer fetches the live number once
  // (useStudioPrice) and leaves it here; this chip never asks twice for the
  // same figure.
  const extraPhotos = intent === 'edit' || intent === 'animate' ? references.length : 0
  // Lip sync, voice, motion: the provider bills the length of the input. The
  // Composer measures it and stores the price, and the same figure goes along
  // with the start as its ceiling. Until then a voice counts its characters
  // and everything else the catalogue length.
  const lengthRate = studioPick ? undefined : lengthPrice(model, op)
  const unitCost = lengthRate
    ? cloudStudioCredits ?? lengthCredits(model, lengthRate.basis === 'chars' ? Array.from(prompt).length || undefined : undefined)
    : studioPick
    ? cloudStudioCredits ?? createStudioCost(studioPick, cloudStudioOptions, Array.from(prompt).length, undefined, startImageCount(studioPick, extraPhotos) ?? 1)
    : runCredits(kind, op, model, seconds, quota.costs[quotaCostKind(kind)], targetResolution)
  // Mehrere Bilder: jedes ist ein eigener Auftrag zum vollen Preis, die Summe
  // ist, was der Lauf bindet. Der Zaehler "noch N Bilder" rechnet je Bild.
  const imageCount = runImageCount(intent, cloudImageCount, characterUse)
  const cost = unitCost * imageCount
  return { kind, op, unitCost, imageCount, cost }
}
