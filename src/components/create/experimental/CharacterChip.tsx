// The character on Image, Edit and every video tab (3.0.7, characters
// everywhere). The chip sits next to the model chip and picks a trained local
// character; the note above the prompt says what the run does with it, or why
// it cannot. The run itself is decided in lib/character-run.ts, the same
// rules the note reads, so the two cannot say different things.
import { useEffect, useState } from 'react'
import { useCreateStore } from '../../../stores/createStore'
import { isMlxImageHost } from '../../../api/mlx-image'
import { mlxTalking } from '../../../api/mlx-video'
import { classifyModel } from '../../../api/comfyui'
import { Select } from '../ui/Select'
import { cn } from '../ui/cn'
import { HINWEIS_TEXT } from '../../../lib/hinweis'
import { characterBaseModel } from '../../../lib/character-base'
import { characterLoraFile, isLocalCharacter, listLocalCharacters, type CharacterRef } from '../../../lib/characters'
import { CHARACTER_IMAGE_LANES, CHARACTER_VIDEO_LANES, characterRunPlan, characterVideoLaneEmpty } from '../../../lib/character-run'
import { useLocalPick } from './localPick'

/** The tabs a Mac runs a character on: the image comes from mflux with the
 *  LoRA, the video from MLX with that image (useCreate generateInner). Its
 *  other video tabs have no local engine. Not Edit: a local character is
 *  trained for Z Image, and the Mac edits with Qwen-Image 2.1 only (Z Image
 *  cannot edit there, lib/image-engines), so every run would stop on the
 *  family check. */
const MAC_CHARACTER_LANES: ReadonlySet<string> = new Set(['image', 'video', 'animate'])

/** Motion Control on a Mac (3.0.8) takes the character's image as its start
 *  image, the same chain. Only while its lane can run: with the LoRA missing
 *  the Stage shows its install card, and a chip there would promise a run
 *  that cannot start. */
const macMotionRuns = () => useCreateStore.getState().motionModelList.length > 0
const macTalkRuns = () => mlxTalking(useCreateStore.getState().videoModelList).ready

/** True where the chip is offered: the local lane, on Image, Edit and the
 *  video tabs; on a Mac the tabs it runs itself. Talking Character is one of
 *  them once its run can start (`macTalkReady`, api/mlx-video mlxTalking):
 *  step 2 of the chain is the engine's a2v from the character's portrait. */
export function characterChipShown(backend: string, intent: string, mlxHost = isMlxImageHost(), macMotion = macMotionRuns(), macTalkReady = macTalkRuns()): boolean {
  if (backend !== 'local' || !(CHARACTER_IMAGE_LANES.has(intent) || CHARACTER_VIDEO_LANES.has(intent))) return false
  return !mlxHost || MAC_CHARACTER_LANES.has(intent) || (intent === 'motion' && macMotion) || (intent === 'lipsync' && macTalkReady)
}

/** True when the run makes the start image itself, so a tab that needs a
 *  start image is ready without one. */
export function characterMakesStart(backend: string, intent: string, character: CharacterRef | null, hasSource: boolean, macTalkReady = macTalkRuns()): boolean {
  return characterChipShown(backend, intent, isMlxImageHost(), macMotionRuns(), macTalkReady) && CHARACTER_VIDEO_LANES.has(intent) && isLocalCharacter(character) && !hasSource
}

const NONE = ''

export function CharacterChip() {
  const backend = useCreateStore((s) => s.backend)
  const intent = useCreateStore((s) => s.intent())
  const selected = useCreateStore((s) => s.selectedCharacter)
  const charactersVersion = useCreateStore((s) => s.charactersVersion)
  const loraKey = useCreateStore((s) => s.loraListKey)
  const macTalkReady = useCreateStore((s) => mlxTalking(s.videoModelList).ready)
  const [chars, setChars] = useState<CharacterRef[] | null>(null)
  const macMotion = useCreateStore((s) => s.motionModelList.length > 0)
  const shown = characterChipShown(backend, intent, isMlxImageHost(), macMotion, macTalkReady)

  useEffect(() => {
    if (!shown) return
    let live = true
    listLocalCharacters()
      .then((l) => { if (live) setChars(l) })
      .catch(() => { if (live) setChars([]) })
    return () => { live = false }
  }, [shown, charactersVersion, loraKey])

  if (!shown || chars === null) return null
  const picked = isLocalCharacter(selected) ? selected : null
  // Nothing trained yet and nothing picked: no chip, the Character tab is
  // where one is made.
  if (chars.length === 0 && !picked) return null

  const pick = (id: string) => {
    const store = useCreateStore.getState()
    const before = characterLoraFile(store.selectedCharacter)
    // The LoRA an earlier pick on the Character tab put in the stack goes
    // with it: the run adds the character's LoRA itself.
    if (before && store.selectedLoras.some((l) => l.name === before)) store.toggleLora(before)
    const ref = chars.find((c) => c.id === id) ?? null
    store.setSelectedCharacter(ref)
    const file = characterLoraFile(ref)
    // GH #161 on every image tab: the character brings the model it was
    // trained for. Without one installed the note says so.
    if (file && CHARACTER_IMAGE_LANES.has(store.intent())) {
      const base = characterBaseModel(file, store.imageModelList, store.imageModel)
      if (base && base.name !== store.imageModel) store.setImageModel(base.name, base.type)
    }
  }

  return (
    <Select
      size="sm"
      align="right"
      ariaLabel="Character"
      className="min-w-[110px] max-w-[200px]"
      value={picked?.id ?? NONE}
      options={[
        { value: NONE, label: 'No character' },
        ...chars.map((c) => ({ value: c.id, label: c.name, sublabel: 'Z Image character', title: `Trigger word: ${c.triggerWord}` })),
      ]}
      onChange={pick}
    />
  )
}

/** The line above the prompt for the picked character. */
export function CharacterNote() {
  const backend = useCreateStore((s) => s.backend)
  const intent = useCreateStore((s) => s.intent())
  const selected = useCreateStore((s) => s.selectedCharacter)
  const source = useCreateStore((s) => s.source)
  const mask = useCreateStore((s) => s.mask)
  const imageModelList = useCreateStore((s) => s.imageModelList)
  const videoModelList = useCreateStore((s) => s.videoModelList)
  const lipsyncModelList = useCreateStore((s) => s.lipsyncModelList)
  const motionModelList = useCreateStore((s) => s.motionModelList)
  const setImageModel = useCreateStore((s) => s.setImageModel)
  const macTalkReady = useCreateStore((s) => mlxTalking(s.videoModelList).ready)
  const { list, value } = useLocalPick()
  if (!characterChipShown(backend, intent, isMlxImageHost(), motionModelList.length > 0, macTalkReady) || !isLocalCharacter(selected) || !selected) return null
  const file = characterLoraFile(selected)!
  const imageLane = CHARACTER_IMAGE_LANES.has(intent)
  const imageType = imageLane ? (list.find((m) => m.name === value)?.type ?? classifyModel(value)) : 'unknown'
  const base = characterBaseModel(file, imageModelList, imageLane ? value : '')
  const plan = characterRunPlan({
    intent,
    character: selected,
    hasSource: !!source,
    hasMask: !!mask,
    imageModelType: imageType,
    baseInstalled: !!base,
    videoModel: intent === 'video' ? value : '',
    videoLaneEmpty: !isMlxImageHost() && characterVideoLaneEmpty(intent, { video: videoModelList, lipsync: lipsyncModelList, motion: motionModelList }),
  })
  const name = selected.name
  if (plan.kind === 'error') {
    return (
      <p role="alert" data-testid="character-note" className={cn('t-label text-center flex items-center justify-center gap-2 flex-wrap', HINWEIS_TEXT.fehler)}>
        {plan.message}
        {imageLane && base && !mask && (
          <button onClick={() => setImageModel(base.name, base.type)} className="underline text-gray-300 hover:text-white">
            Switch model
          </button>
        )}
      </p>
    )
  }
  const text = plan.kind === 'image'
    ? `“${selected.triggerWord}” goes into your prompt by itself. Describe the key features too.`
    : plan.kind === 'source-wins'
      ? `Your start image is used. Remove it to start from ${name}.`
      : !base
        ? `${name} was trained for Z Image, and no Z Image model is installed. Get one in the Model Manager to use it.`
        : `First an image of ${name} is made with Z Image, then the video starts from it.`
  return (
    <p data-testid="character-note" className={cn('t-label text-center', !base && plan.kind === 'chain' ? HINWEIS_TEXT.fehler : HINWEIS_TEXT.ruhig)}>
      {text}
    </p>
  )
}
