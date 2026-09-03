import { getImageModels, getVideoModels, isI2VModel, isT2VCapable } from './comfyui'
import type { ModelPickKind } from '../stores/modelPickStore'
import type { ToolArgs } from './mcp/types'

/**
 * Model-Picker gate (v2.5.3). Runs inside executeImageGenerate /
 * executeVideoGenerate BEFORE vramHandoffGenerate — i.e. before the VRAM
 * swap — and returns the model name the generation should use, or null to
 * leave the existing auto-selection untouched. The pick is OURS (LU UI),
 * not the LLM's:
 *
 *   - explicit `model` arg from the user/LLM   → no picker (intent wins)
 *   - Create tab selection installed           → silent use (the user's
 *     visible model choice in the product, see chooseFromUserSelection)
 *   - saved preference installed               → silent use (Change-Model
 *     affordance shows in the tool call instead)
 *   - nothing chosen anywhere (or it got uninstalled) → ModelPickerCard
 *     renders in the running tool call; save icon persists the choice
 *   - ComfyUI unreachable / no models          → null (the existing decide
 *     phase reports its own actionable error — UX identical to before)
 *
 * Model filtering mirrors vram-handoff's decide phase exactly: image =
 * getImageModels; video splits by inputImage into I2V (isI2VModel) vs T2V
 * (the rest). The preference keys are per-kind because the sets are
 * disjoint (SVD can't T2V, Wan 1.3B can't I2V).
 */
/**
 * The model the user has ALREADY chosen for this kind, in order of authority,
 * or null when neither choice fits this call.
 *
 * The Create tab comes first. It is the model selection the user can see and
 * changed last, so a Create tab set to Z-Image has to answer a chat request
 * for a picture with Z-Image. Nebenbefund N1 of the D1 counter-check (Windows
 * build, 2026-08-29): with an empty `model` argument the chat tool ignored
 * that and built a Realistic Vision graph in two runs out of two, because the
 * saved picker preference was the only choice this gate ever read.
 *
 * `saved` (the ModelPickerCard preference) stays as the second source, so an
 * install that never opened Create behaves exactly as before. Both have to be
 * in `names`, the installed and eligible set for THIS call: an uninstalled or
 * wrong-capability choice falls through to the picker instead of building a
 * graph around a file ComfyUI does not have.
 */
export function chooseFromUserSelection(
  names: string[],
  createChoice: string | null | undefined,
  saved: string | null | undefined,
): string | null {
  for (const choice of [createChoice, saved]) {
    if (typeof choice === 'string' && choice && names.includes(choice)) return choice
  }
  return null
}

export async function pickModelForGeneration(
  kind: 'image' | 'video',
  args: ToolArgs,
): Promise<string | null> {
  if (typeof args.model === 'string' && args.model) return null

  // Same alias normalization as runHandoff — the pick must classify the call
  // the same way the decide phase will (input_image / image → inputImage).
  const inputImage = args.inputImage ?? args.input_image ?? args.image
  const wantI2V = kind === 'video' && typeof inputImage === 'string' && !!inputImage
  const pickKind: ModelPickKind = kind === 'image' ? 'image' : wantI2V ? 'video-i2v' : 'video-t2v'

  let names: string[]
  try {
    const models = kind === 'image' ? await getImageModels() : await getVideoModels()
    // T2V uses isT2VCapable (NOT !isI2VModel): Wan 2.2 TI2V is dual T2V/I2V,
    // so it must appear in BOTH picker lists — the old negation hid it from
    // the T2V picker (live find 2026-06-11, first wan22 T2V pick on the 3060).
    const eligible = kind === 'image'
      ? models
      : models.filter((m) => (wantI2V ? isI2VModel(m.name) : isT2VCapable(m.name)))
    names = eligible.map((m) => m.name)
  } catch {
    return null
  }
  if (names.length === 0) return null

  const { useSettingsStore } = await import('../stores/settingsStore')
  const prefKey =
    pickKind === 'image' ? 'preferredImageModel'
    : pickKind === 'video-t2v' ? 'preferredVideoT2VModel'
    : 'preferredVideoI2VModel'
  const saved = useSettingsStore.getState().settings[prefKey]

  // The Create tab's own model selection, read through the same store the
  // Create page writes it to. For video the two sub-kinds share one Create
  // selection; `names` already carries the I2V/T2V filter, so a T2V-only
  // choice simply does not answer an image-to-video call.
  const { useCreateStore } = await import('../stores/createStore')
  const createState = useCreateStore.getState()
  const createChoice = pickKind === 'image' ? createState.imageModel : createState.videoModel

  const chosen = chooseFromUserSelection(names, createChoice, saved)
  if (chosen) return chosen

  const { useModelPickStore } = await import('../stores/modelPickStore')
  const choice = await useModelPickStore.getState().request(pickKind, names, names[0])
  if (!choice) return names[0]
  if (choice.save) {
    useSettingsStore.getState().updateSettings({ [prefKey]: choice.model })
  }
  return choice.model
}
