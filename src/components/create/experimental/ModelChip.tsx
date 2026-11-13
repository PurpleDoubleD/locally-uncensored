import { useCreateStore } from '../../../stores/createStore'
import {
  useCloudCatalogStore, cloudModelById, defaultCloudModel, opPickerModels, modelCostHint, shortCount,
  editCapableModels, animatePickerModels, videoPickerModels, studioOnlyImageModels,
  resolveCharacterModel, characterGenerationModels,
} from '../../../stores/cloudCatalogStore'
import { DEFAULT_MODEL_IDS } from '../../../lib/render/cloud-models'
import { groupForPicker, sortByTier, tierGroup, tierMarks } from '../../../lib/render/model-tier'
import { localTier } from '../../../lib/render/local-model-tier'
import { intentPickerModels, intentRoles, createStudioCost, isStudioModel } from '../../../lib/render/create-studio'
import type { RenderOp } from '../../../lib/render/cloud-jobs'
import type { PresetModel } from '../../../lib/render/preset-models'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useUIStore } from '../../../stores/uiStore'
import { useContentPolicy } from '../../../hooks/useContentPolicy'
import { Select, type SelectOption, type SelectTag } from '../ui/Select'
import { TYPE_LABEL } from './badges'
import { UNFILTERED_MARK_LABEL } from '../../../lib/unfiltered-mark'
import { useLocalPick } from './localPick'
import { useLocalModelFits } from '../../../hooks/useLocalModelFit'
import { vramFitLabel } from '../../../lib/vram-fit'
import { localModelLabel } from '../../../lib/local-model-name'
import { isMlxImageHost, mlxPickerFamily } from '../../../api/mlx-image'
import { ref2vRefusal, ref2vRowNote } from '../../../api/comfyui'

// Portplan P7: lipsync/music/extend/motion reach the Studio track through the
// SAME picker as their classic op-specialized twins, one list, matching what
// useCloudCreate.ts and CreditsMeter.tsx already resolve through.
// intentPickerModels() (create-studio.ts, P2) already merges both worlds;
// this only prices each row, since a PresetModel carries no `credits` field.
function pickerCostHint(m: PresetModel, musicDuration: number): string | undefined {
  const classic = cloudModelById(m.id)
  if (classic && !isStudioModel(m.id)) return modelCostHint(classic, m.op as RenderOp, m.op === 'music' ? musicDuration : undefined)
  return studioCostHint(m.id)
}

/** A Studio row prices from its own schema: no options chosen yet (this is the
 *  picker row, not the run), so the model's own baseline preview, the same
 *  figure studio-contract.ts's studioBaseCredits() would compute. */
function studioCostHint(id: string): string | undefined {
  return isStudioModel(id) ? `${shortCount(createStudioCost(id, {}, 100))} cr` : undefined
}

const CLOUD_BADGE: SelectTag = { label: 'Cloud' }
// C2: the measured mark (lib/unfiltered-mark) on models the provider ships with its own
// filter off (CloudModel.adult, web parity: the web app).
// The mark says what the MODEL can do and
// decides nothing itself: while the account's content policy still filters
// (anything but 'off'), it stays pale, since the account setting is the
// boundary, not the model. No adult vocabulary here, this surface sits on
// the payment domain.
// No accent since 2026-10-09: the accent belongs to the statement mark of the
// chat picker, this mark is the quiet one everywhere.
const noRefusalsBadge = (policyOff: boolean): SelectTag =>
  (policyOff ? { label: UNFILTERED_MARK_LABEL } : { label: UNFILTERED_MARK_LABEL, tone: 'quiet' })

// Local-mode discovery (2.5.8): hosted models ride at the bottom of the local
// picker as teaser rows — picking one opens the Cloud sheet instead of
// changing the selection. Value prefix keeps them apart from real checkpoints.

const TEASER_PREFIX = 'lu-cloud-teaser:'
const TEASER_ROWS = 4
/** The heading over the hosted rows at the end of the local picker. The list
 *  draws a heading only where the group changes, so rows without one ran on
 *  under "Older models" (the box, 03.10.2026). A hosted model is not an older
 *  one, with or without a tier from the server. */
export const CLOUD_GROUP = 'LU Cloud'

// Badge-aware model picker (replaces the raw <select>). Local backend lists
// the installed checkpoints; the cloud backend lists the hosted catalog
// (server-driven via cloudCatalogStore) and writes the cloud model slugs.
export function ModelChip() {
  const backend = useCreateStore((s) => s.backend)
  return backend === 'cloud' ? <CloudModelChip /> : <LocalModelChip />
}

function CloudModelChip() {
  const mode = useCreateStore((s) => s.mode)
  const intent = useCreateStore((s) => s.intent())
  const characterTab = useCreateStore((s) => s.characterTab)
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const setCloudImageModel = useCreateStore((s) => s.setCloudImageModel)
  const setCloudVideoModel = useCreateStore((s) => s.setCloudVideoModel)
  const setCloudOpModel = useCreateStore((s) => s.setCloudOpModel)
  // Subscribed, not read once: the music sublabel must follow the length
  // slider live so the shown price is the billed price (A3).
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const models = useCloudCatalogStore((s) => s.models)
  const contentPolicy = useContentPolicy()

  const isVideo = mode === 'video'
  const kind = isVideo ? 'video' : 'image'
  const characterUse = intent === 'character' && characterTab === 'use'
  // The 2.5.8 specialized intents pick from their op's own family (both
  // trainer kinds together for Character-Studio TRAIN) and store into
  // cloudOpModel. Character-Studio USE is its own thing: it picks a
  // GENERATION endpoint compatible with the trained LoRA's family, not a
  // trainer. A picker showing trainers there would be a lie (the web app main
  // 5be5dec3).
  const special =
    (intent === 'character' && !characterUse) || intent === 'lipsync' || intent === 'music' ||
    intent === 'extend' || intent === 'motion'
  // Portplan P7: lipsync/music/extend/motion reach the Studio track through
  // the SAME picker as their classic op-specialized twins.
  // intentPickerModels() (create-studio.ts, P2) already merges both worlds.
  const roleIntent = !characterUse && intentRoles(intent).length > 0
  const roleModels: PresetModel[] = roleIntent ? intentPickerModels(intent) : []
  const characterModels = characterUse ? characterGenerationModels(selectedCharacter?.family ?? '') : []
  // List only the models that can run the current op — otherwise the picker
  // offers checkpoints that useCloudCreate silently swaps out at submit, so the
  // user's choice was a lie. Edit needs masked-img2img (flux-dev); Animate needs
  // i2v; Video needs t2v (absent flag = capable, so today's dual-capable fleet
  // lists in full, and a future t2v-only model that sets i2v:false is excluded).
  //
  // 02.10.2026 (Web-Paritaet): Edit, Video und Animate fuehren hinter den
  // klassischen Modellen die Studio-Modelle, die der Server kennt (siehe
  // cloudCatalogStore.studioEntries); Image fuehrt die Studio-Bildmodelle, die
  // in keinem klassischen Eintrag stehen. R5-58: Edit sieht auch die op-
  // spezialisierten Endpunkte (qwen-image-edit hat `ops: ['edit']`).
  const list =
    intent === 'edit' ? editCapableModels()
    : intent === 'animate' ? animatePickerModels()
    : intent === 'video' ? videoPickerModels()
    : intent === 'character' && !characterUse ? opPickerModels('lora-train')
    : kind === 'image' ? [...models.filter((m) => m.kind === 'image' && !m.ops), ...studioOnlyImageModels()]
    : models.filter((m) => m.kind === kind && !m.ops)
  const current = characterUse
    ? (resolveCharacterModel(selectedCharacter?.family ?? '', cloudOpModel) ?? '')
    : special || roleIntent
      ? cloudOpModel
      : (isVideo ? cloudVideoModel : cloudImageModel) || defaultCloudModel(kind)?.id || ''
  // Reflect the model the run will really use, so a leftover pick the current op
  // can't perform doesn't show as "selected".
  const roleOrCharacterIds = roleIntent ? roleModels : characterModels
  // Faellt die Wahl heraus, gilt das Standardmodell dieser Unterkategorie (wie in
  // modelForOp), und erst dahinter der erste Eintrag.
  const standard = intent === 'edit' ? DEFAULT_MODEL_IDS.edit : intent === 'animate' ? DEFAULT_MODEL_IDS.animate : (defaultCloudModel(kind)?.id ?? '')
  const value = roleIntent || characterUse
    ? (roleOrCharacterIds.some((m) => m.id === current) ? current : (roleOrCharacterIds[0]?.id ?? current))
    : list.some((m) => m.id === current) ? current : list.some((m) => m.id === standard) ? standard : (list[0]?.id ?? current)

  // The op this picker's models will run as, so the sublabel prices correctly
  // (a trainer bills a training run, not an image).
  const op: RenderOp =
    characterUse ? 'generate'
    : intent === 'character' ? 'lora-train'
    : intent === 'lipsync' ? 'lipsync'
    : intent === 'music' ? 'music'
    : intent === 'extend' ? 'extend'
    : intent === 'motion' ? 'motion'
    : intent === 'edit' ? 'edit'
    : intent === 'animate' ? 'animate'
    : 'generate'
  const options: SelectOption[] = roleIntent
    ? groupForPicker(roleModels).map(({ model: m, group }) => ({
        value: m.id,
        label: m.label,
        sublabel: pickerCostHint(m, musicDuration),
        group,
        tags: tierMarks(m),
        badge: m.adult
          ? noRefusalsBadge(contentPolicy === 'off')
          : CLOUD_BADGE,
      }))
    : characterUse
      ? groupForPicker(characterModels).map(({ model: m, group }) => ({
          value: m.id,
          label: m.label,
          sublabel: modelCostHint(m, 'generate', undefined),
          group,
          tags: tierMarks(m),
          badge: m.adult
            ? noRefusalsBadge(contentPolicy === 'off')
            : CLOUD_BADGE,
        }))
      : groupForPicker(list).map(({ model: m, group }) => ({
          value: m.id,
          label: m.label,
          sublabel: isStudioModel(m.id) ? studioCostHint(m.id) : modelCostHint(m, op, op === 'music' ? musicDuration : undefined),
          // Nach Familie gruppiert, Beste zuerst, Aeltere gesammelt unten unter
          // einer Zwischenzeile, nichts verschwindet (lib/render/model-tier).
          // Die Marken stehen nur in der aufgeklappten Liste.
          group,
          tags: tierMarks(m),
          // adult models keep the standard Cloud badge everywhere EXCEPT the row
          // itself, where "No Filter" is strictly more informative, matching web.
          badge: m.adult
            ? noRefusalsBadge(contentPolicy === 'off')
            : CLOUD_BADGE,
        }))

  return (
    <Select
      size="sm"
      searchable
      align="right"
      className="min-w-[150px] max-w-[230px]"
      options={options}
      value={value}
      // "Use character" lists the models of the picked character's family.
      // With no character picked there is no list yet, and the bare
      // "Select..." asked for a model that cannot be chosen.
      placeholder={characterUse && !selectedCharacter ? 'Pick a character first' : undefined}
      onChange={(v) =>
        special || roleIntent || characterUse ? setCloudOpModel(v) : isVideo ? setCloudVideoModel(v) : setCloudImageModel(v)
      }
    />
  )
}

/** The Train tab on a Mac: the run trains on Z-Image Turbo whatever image
 *  model is picked (api/mlx-train), so the chip names that and offers no
 *  list. The picked image model showed there before ("MLX SD Turbo"). */
function MacTrainBaseChip() {
  return (
    <span
      className="lu-control t-control px-2 shrink-0"
      data-testid="mac-train-base"
      title="Characters train on Z-Image Turbo, the image model Use character runs them on."
    >
      Trains on Z-Image Turbo
    </span>
  )
}

/** The Train tab on Windows and Linux (GH #210, 31.10.2026): the local
 *  trainer trains on Z-Image Base alone (api/trainer TRAINER_BASE_FILES), and
 *  the training call carries no model. The picker stood here with every image
 *  model, and a tester picked Qwen-Image 2.1 as the training model. In the
 *  cloud lane this chip is the training model, so the look was a fair guess. */
function LocalTrainBaseChip() {
  return (
    <span
      className="lu-control t-control px-2 shrink-0"
      data-testid="local-train-base"
      title="The local trainer makes Z-Image characters and styles. Use character runs them on a Z-Image model. Training for other models is in LU Cloud."
    >
      Local training uses Z-Image
    </span>
  )
}

function LocalModelChip() {
  const intent = useCreateStore((s) => s.intent())
  const characterTab = useCreateStore((s) => s.characterTab)
  if (intent === 'character' && characterTab !== 'use') return isMlxImageHost() ? <MacTrainBaseChip /> : <LocalTrainBaseChip />
  return <LocalModelPicker />
}

function LocalModelPicker() {
  const setImageModel = useCreateStore((s) => s.setImageModel)
  const setVideoModel = useCreateStore((s) => s.setVideoModel)
  const setLocalOpModel = useCreateStore((s) => s.setLocalOpModel)
  const teasersEnabled = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const setCloudTeaser = useUIStore((s) => s.setCloudTeaser)
  const catalogModels = useCloudCatalogStore((s) => s.models)

  // Which model a run takes lives in localPick, shared with the waiting area.
  const { isVideo, laneList, list, value } = useLocalPick()
  const intent = useCreateStore((s) => s.intent())
  // A model that does not sit comfortably on the detected card says so on its
  // row, here, where it is picked. Never at the prompt field. A model that
  // fits, and a machine without a detected card, add nothing.
  const { cardGb, fitOf } = useLocalModelFits(list)
  const fitMarks = (name: string) => {
    const fit = fitOf(name)
    return fit === 'tight' || fit === 'big' ? [{ label: vramFitLabel(fit, cardGb) }] : []
  }

  // Beste oben mit der Marke "Best", Aeltere gesammelt unten unter "Older
  // models", der Rest in gewohnter Reihenfolge; nichts verschwindet. Die
  // lokalen Modelle bleiben in dieser Ordnung, nach Familie gruppiert werden
  // nur die Cloud-Listen oben. `value` oben haelt sich an die ungeordnete Liste, denn die
  // zeigt, welches Modell ein Lauf wirklich nimmt.
  // On the Mac a model's family is the one its catalogue id says, for the tag
  // and for the tier: the type alone called SD Turbo "SD 1.5" and sorted it
  // under "Older models" (api/mlx-image mlxPickerFamily).
  const mac = isMlxImageHost()
  const family = (m: { name: string }) => (mac && !isVideo && !laneList ? mlxPickerFamily(m.name) : null)
  const options: SelectOption[] = sortByTier(list.map((m) => ({ m, tier: localTier({ name: m.name, type: family(m)?.type ?? m.type }) }))).map(({ m, tier }) => ({
    value: m.name,
    // The catalogue's name for a file it knows (lib/local-model-name); any
    // other file as before.
    ...localModelLabel(m.name),
    // The whole name is the tooltip: the file name on Windows and Linux,
    // the catalogue name on the Mac. It is what is left where a name is cut
    // off after all (a narrow window, a very long file name).
    title: isVideo && intent === 'animate' && ref2vRefusal(m.name) ? `${m.name}\n${ref2vRefusal(m.name)}` : m.name,
    sublabel: isVideo ? ref2vRowNote(m.name, intent) : undefined,
    badge: { label: family(m)?.label ?? TYPE_LABEL[m.type] },
    group: tierGroup({ tier }),
    tags: [...tierMarks({ tier }), ...fitMarks(m.name)],
  }))
  // Discovery rows: a few hosted models of this kind at the list's tail.
  // Picking one opens the Cloud sheet; the local selection stays untouched.
  if (teasersEnabled && !laneList) {
    const kind = isVideo ? 'video' : 'image'
    for (const m of catalogModels.filter((c) => c.kind === kind && !c.ops).slice(0, TEASER_ROWS)) {
      options.push({
        value: `${TEASER_PREFIX}${m.id}`,
        label: m.label,
        sublabel: modelCostHint(m, 'generate'),
        badge: CLOUD_BADGE,
        group: CLOUD_GROUP,
      })
    }
  }

  return (
    <Select
      size="sm"
      searchable
      align="right"
      // A name ends in what tells two packs of one model apart ("… 4-bit",
      // "… 8-bit", "… Turbo 8-bit" on the Mac, "… (INT8)" or a quant
      // elsewhere), and 230 px cut exactly that off: "MLX Qwen-Im…" three
      // times (persona walk, Fund 17). The row has the room, so the chip may
      // take it, on every platform.
      className="min-w-[150px] max-w-[360px]"
      options={options}
      value={value}
      onChange={(v) => {
        if (v.startsWith(TEASER_PREFIX)) {
          setCloudTeaser({
            surface: 'create-model',
            kind: isVideo ? 'video' : 'image',
            modelId: v.slice(TEASER_PREFIX.length),
          })
          return
        }
        if (laneList) setLocalOpModel(v)
        else if (isVideo) setVideoModel(v)
        else {
          const m = list.find((x) => x.name === v)
          setImageModel(v, m?.type ?? 'unknown')
        }
      }}
    />
  )
}
