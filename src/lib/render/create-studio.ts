// Die Bruecke zwischen dem Create-Tab und der Studio-Registrierung.
//
// 19.09.2026, Entscheid des Inhabers: die neuen Endpunkte sollen nicht nur in den
// Presets waehlbar sein, sondern auch in den Unterkategorien von Create. Bis
// heute war der Studio-Pfad ausschliesslich im Preset-Fenster zu Hause, und
// keine der Unterkategorien konnte ein Studio-Modell fahren.
//
// Statt eine zweite Liste zu pflegen, bekommt jede spezialisierte Absicht die
// Rolle, die sie ohnehin schon meint. Damit sind Preset-Fenster und Create-Tab
// per Bauart dieselbe Menge, und der Vertragstest in preset-models.test.ts
// deckt beide Oberflaechen ab.

import { STUDIO_MODELS, studioBaseCredits, studioFields, studioPreviewCredits, studioSchema } from './studio-contract'
import { presetModels, requiredRoleInputs, type PresetModel, type StepRole } from './preset-models'
import { defaultCloudModel, modelForOp, opPickerModels, resolveCharacterModel, resolveOpPick } from '../../stores/cloudCatalogStore'
import { intentToJob, type CreateIntentLike } from './cloud-jobs'

// Desktop port (P2, checked again in P9): the web's CreateIntent already
// carries 'video_upscale' as a distinct intent from the plain 'upscale'
// (image upscale). The desktop's CreateIntent (in stores/createStore.ts,
// P5's file, merged) still has a single 'upscale' that serves BOTH image and
// video upscale via the older utility-op path. This is not a leftover type
// gap: components/create/experimental/intents.ts documents (comment at the
// 'upscale' intent, predates the Studio port) that a separate video-upscale
// intent is "a feature decision for the owner ... out of scope here": it needs
// a new IntentBar tile and Composer wiring, a UI feature addition, not an
// integration fold. StudioIntent stays as the local shim until that decision
// is made; the video_upscale role list below (STUDIO_MODELS entries
// video-upscaler, flashvsr, video-upscaler-pro, ultimate-video-upscaler,
// crystal-upscaler, flux-3-upscale) is correctly wired and tested, but
// reachable only by calling these functions directly with 'video_upscale',
// which no UI path does today.
export type StudioIntent = CreateIntentLike | 'video_upscale'

/** Die Rolle, die eine Create-Unterkategorie faehrt. Absichten ohne Eintrag
 *  (Bild, Video, Animate, Edit) haben ihre eigenen, aelteren Waehler. */
const INTENT_ROLE: Partial<Record<StudioIntent, StepRole[]>> = {
  // Ein Foto plus eine Stimme. Der Presenter braucht nicht einmal das Foto,
  // gehoert aber in dieselbe Zeile: der Kunde will hier jemanden sprechen sehen.
  lipsync: ['talking', 'presenter'],
  music: ['music'],
  extend: ['extend'],
  motion: ['motion'],
  video_upscale: ['upscale'],
}

export function intentRoles(intent: StudioIntent): StepRole[] {
  return INTENT_ROLE[intent] ?? []
}

/** Die Rolle, unter der ein bestimmtes Modell in dieser Absicht laeuft. */
export function intentRoleFor(intent: StudioIntent, model: string): StepRole | undefined {
  return intentRoles(intent).find((role) => presetModels(role).some((m) => m.id === model))
}

/** Alle Modelle, die diese Unterkategorie fahren koennen.
 *
 *  Die klassischen Mitglieder stehen zuerst: sie sind die, die der Kunde schon
 *  kennt, und ein Wechsel der Liste darf seine bisherige Wahl nicht verschieben.
 *  `lipsync` fuehrt zusaetzlich die beiden Nachvertonungsmodelle, die einen
 *  fertigen Clip statt eines Fotos lesen. Die sind kein Rollenmitglied, gehoeren
 *  in der Oberflaeche aber seit jeher hierher.
 *
 *  Ein Studio-Mitglied erscheint NUR, wenn der lebende Katalog genau dieses
 *  Modell fuehrt (preset-models.ts, studioKnown). Ein aelterer Server sagt damit
 *  selbst, welche Studio-Endpunkte er nicht kennt, und diese EINE Stelle traegt
 *  die Regel fuer alle Aufrufer (Composer, CreditsMeter, CreateExperimental,
 *  ModelChip direkt, useCloudCreate ueber resolveIntentPick). Review B1
 *  (Runde 2, 20.09.2026): vorher wich jede Rolle auf ihr erstes Studio-Mitglied
 *  aus, und Extend/Motion liefen auf einem Server ohne Studio ins Leere. Jede
 *  klassische Absicht (lipsync/music) faellt auf ihre klassischen Mitglieder
 *  zurueck, genau wie vor dem Port. */
export function intentPickerModels(intent: StudioIntent): PresetModel[] {
  const roles = intentRoles(intent)
  if (!roles.length) return []
  const out: PresetModel[] = []
  const seen = new Set<string>()
  const add = (m: PresetModel) => { if (!seen.has(m.id)) { seen.add(m.id); out.push(m) } }
  if (intent === 'lipsync') for (const m of opPickerModels('lipsync')) {
    add({ id: m.id, label: m.label, kind: m.kind, op: 'lipsync', adult: m.adult === true, tier: m.tier, weights: m.weights })
  }
  for (const role of roles) for (const m of presetModels(role)) add(m)
  return out
}

/** Die Wahl, auf die diese Absicht wirklich laeuft.
 *
 *  Waehler und Absenden benutzen denselben Aufruf. Stuende die Regel zweimal
 *  da, zeigte der Waehler irgendwann ein anderes Modell an als das, was
 *  abgerechnet wird. */
export function resolveIntentPick(intent: StudioIntent, picked: string): string {
  const list = intentPickerModels(intent)
  if (!list.length) return picked
  return list.some((m) => m.id === picked) ? picked : list[0].id
}

/** The model the tab on screen would run in the cloud right now, from the three
 *  pickers.
 *
 *  One rule for the Create button, the meter, the settings drawer and the
 *  store. `characterFamily` is set on Character Studio's use surface only: that
 *  run is a plain image generate on a model of the character's family. */
export function createRunModel(
  intent: StudioIntent,
  picks: { image: string; video: string; op: string },
  characterFamily?: string,
): string {
  if (characterFamily !== undefined) {
    return modelForOp('image', 'generate', resolveCharacterModel(characterFamily, picks.op) ?? '')
  }
  if (intentRoles(intent).length > 0) return resolveIntentPick(intent, picks.op)
  const { kind, op } = intentToJob(intent as CreateIntentLike)
  // Character training is the one specialized intent without a role.
  const picked = intent === 'character'
    ? resolveOpPick(op, picks.op)
    : (kind === 'video' ? picks.video : picks.image) || defaultCloudModel(kind)?.id || ''
  return modelForOp(kind, op, picked)
}

/** Das Studio-Modell, auf dem ein Cloud-Lauf dieser Unterkategorie wirklich
 *  laeuft, oder `undefined`. Dieselbe Aufloesung wie Waehler, Zaehler und Start
 *  (createRunModel). Der Character-Weg bleibt auf seiner festen -lora-Familie
 *  und das Training faehrt nie Studio. Die Schublade mit den Einstellungen
 *  liest das, um ihr Schema zu zeigen. */
export function studioPickFor(
  intent: StudioIntent,
  s: { cloudImageModel: string; cloudVideoModel: string; cloudOpModel: string },
): string | undefined {
  if (intent === 'character') return undefined
  const model = createRunModel(intent, { image: s.cloudImageModel, video: s.cloudVideoModel, op: s.cloudOpModel })
  return isStudioModel(model) ? model : undefined
}

export function isStudioModel(id: string): boolean {
  return !!STUDIO_MODELS[id]
}

/** Die Eingaben, ohne die dieses Modell nicht starten kann. */
export function intentRequiredInputs(intent: StudioIntent, model: string): string[] {
  const role = intentRoleFor(intent, model)
  return role ? requiredRoleInputs(role, model) : []
}

/** Der Preis eines Studio-Laufs fuer Zaehler und Startknopf im Create-Tab.
 *
 *  Endpunkte, die nach der gewuenschten Laenge abrechnen, stehen hier genau.
 *  Endpunkte, die die HOCHGELADENE Laenge abrechnen, bekommen die im Browser
 *  gemessene Laenge herein und stehen damit ebenfalls genau. Ohne Datei bleibt
 *  der Preis eines Laufs von fuenf Sekunden als Anhaltspunkt stehen. */
export function createStudioCost(
  model: string,
  options: Record<string, unknown>,
  promptLength = 100,
  seconds?: number,
  imageCount = 1,
): number {
  return studioPreviewCredits(model, options, seconds, imageCount, promptLength) ?? studioBaseCredits(model)
}

/** What a control of this model shows: the customer's own value, else the
 *  value the run sends when he sets nothing. The server fills an unset field
 *  with the model's own default first and the schema's second (studioOptions);
 *  every surface reads the same order here, so the control never names 720p
 *  while the run renders the model's 480p. */
export function studioShownValue(model: string, options: Record<string, unknown>, key: string): unknown {
  const studio = STUDIO_MODELS[model]
  // A classic model has no schema of its own: its control shows what was set.
  if (!studio) return options[key]
  return options[key] ?? studio.defaults[key] ?? studioFields(model)[key]?.default
}

/** Mehr als so viele eigene Fotos nimmt die Oberflaeche in einem Lauf nicht an,
 *  auch wenn ein Endpunkt bis zu zehn liest: darueber hilft mehr Material
 *  selten, und jedes Foto ist ein Upload und beim Anbieter oft ein Aufpreis. */
export const MAX_STUDIO_PHOTOS = 5

/** Wie viele eigene Fotos (das grosse Standbild eingerechnet) dieses Modell in
 *  einem Lauf liest. 0, wo es keine Bilderliste hat. Die Grenze ist die des
 *  Anbieter-Schemas (maxItems), gedeckelt auf MAX_STUDIO_PHOTOS. */
export function studioPhotoCap(model: string): number {
  const m = STUDIO_MODELS[model]
  const field = m && Object.entries(m.inputs).find(([, key]) => key === 'image_paths')?.[0]
  if (!field) return 0
  return Math.min(studioSchema(model).properties?.[field]?.maxItems ?? 1, MAX_STUDIO_PHOTOS)
}

/** Liest dieses Studio-Modell ein Endbild (last_image_path)? Animate bietet
 *  dann neben dem Startbild ein zweites Feld an (B38, Discord 30.10.2026). */
export function studioReadsEndImage(model: string | null | undefined): boolean {
  if (!model) return false
  return Object.values(STUDIO_MODELS[model]?.inputs ?? {}).includes('last_image_path')
}

/** Wie viele WEITERE Fotos neben dem Standbild die Referenzleiste fuer dieses
 *  Modell anbietet. */
export function studioExtraPhotoSlots(model: string): number {
  return Math.max(0, studioPhotoCap(model) - 1)
}

/** Das Studio-Modell, das Bearbeiten oder Animate gerade fahren wuerde, wenn es
 *  mehrere Fotos lesen kann. Dieselbe Aufloesung wie der Start (studioPickFor),
 *  damit die Leiste nie ein Modell meint, das der Start dann umbiegt. */
export function referenceModel(
  intent: StudioIntent,
  s: { cloudImageModel: string; cloudVideoModel: string; cloudOpModel: string },
): string | undefined {
  if (intent !== 'edit' && intent !== 'animate') return undefined
  const model = studioPickFor(intent, s)
  return model && studioPhotoCap(model) > 1 ? model : undefined
}

/** Wie viele Bilder der Start eines Studio-Modells im Create-Tab schickt: das
 *  Standbild der Oberflaeche plus die Fotos der Referenzleiste, soweit das Modell
 *  sie liest (Einzelbild oder Liste). `extra` ist die Zahl der Leistenfotos.
 *  `undefined`, wo ein Modell mehr als Bilder liest (Ton, Video) oder keines.
 *  Dann gibt es keinen Vorab-Preis ohne Datei. */
export function startImageCount(model: string, extra = 0): number | undefined {
  const reads = Object.values(STUDIO_MODELS[model]?.inputs ?? {})
  if (!reads.length || reads.some((k) => k !== 'source_path' && k !== 'image_paths' && k !== 'last_image_path')) return undefined
  return 1 + Math.min(Math.max(0, Math.floor(extra)), studioExtraPhotoSlots(model))
}

/** Haengt der Preis dieses Modells an der Laenge einer hochgeladenen Datei?
 *
 *  Nur solche Modelle brauchen eine Messung im Browser. Alle anderen kann der
 *  Anbieter sofort beziffern, weil nichts zu messen ist. */
export function pricesByInput(model: string): boolean {
  const mode = STUDIO_MODELS[model]?.price.mode
  return mode === 'input' || mode === 'both' || mode === 'inout'
}
