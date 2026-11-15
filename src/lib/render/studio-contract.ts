// Provider api_schema snapshot, reviewed 2026-10-02. Mirrored in the worker.
import definitions from './studio-models.json'
import schemas from './provider-schemas.json'
import endpoints from './provider-endpoints.json'
import { isRetiredMediaModel } from './retired-models'
export type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; default?: unknown; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; maxLength?: number; items?: Schema; description?: string; disabled?: boolean; format?: string; 'x-lu-views'?: string[] }
// Stufe und Herkunft jedes Cloud-Modells (02.10.2026, Entscheid des Inhabers).
// `tier` ordnet die Waehler: 'best' steht oben, 'older' gesammelt unten.
// `weights` sagt, ob genau diese Version offene Gewichte hat ('open'), nur ihre
// Familie ('open-family') oder nie ('closed'). Beides traegt JEDES Modell.
export type ModelTier = 'best' | 'standard' | 'older'
export type ModelWeights = 'open' | 'open-family' | 'closed'
export interface StudioModel {
  baselineUsd: number; sourceModel?: string; promptField?: string
  label: string; endpoint: string; kind: 'image' | 'video' | 'audio' | '3d'; adult: boolean
  /** The usual run time in seconds (3D, shown while the cloud builds). */
  typical_s?: number
  /** 14.11.2026 (3.1.0): in the catalogue, not measured yet. See unmeasuredHidden. */
  unmeasured?: boolean
  tier: ModelTier; weights: ModelWeights
  inputs: Record<string, string>; defaults: Record<string, unknown>
  // `resolutionField` / `durationField`: nicht jeder Endpunkt nennt die beiden
  // Groessen gleich. Die Upscaler rechnen ueber `target_resolution`, die
  // ElevenLabs-Musik ueber `music_length_ms`. `unitDivisor` bringt Millisekunden
  // auf Sekunden, `blockSeconds` bildet einen angefangenen Block ab (ElevenLabs
  // rechnet je angefangene Minute), `minSeconds` die Mindestlaenge einer
  // gemessenen Eingabe. Alle vier sind an POST /model/price gemessen.
  // `perReference` (wie im Web, 03.11.2026): jedes Bild der Bilderliste kostet
  // extra, auch das erste, weil das Video die Vorlage ist und kein Bild
  // (Swap Character: 0,02 $ je Person). Gezaehlt werden die Bilder, die der
  // Lauf wirklich schickt.
  price: { mode: string; rates: Record<string, number>; maxSeconds?: number; extraImage?: number; perReference?: number
    resolutionField?: string; durationField?: string; unitDivisor?: number; blockSeconds?: number; minSeconds?: number
    perUnitField?: string
    // `qualityField` (29.10.2026, GPT Image 2, web catalogue): the price hangs
    // on two fields, resolution and quality. The rate then stands under
    // "<resolution>/<quality>".
    qualityField?: string
    // `extraViews` (14.11.2026, Hunyuan3D 3): one flat surcharge as soon as a
    // run has more than one picture, however many further sides it has.
    extraViews?: number }
  // `maxSide` (08.11.2026, web catalogue): the longest side in pixels the
  // upstream renders where its schema does not say so. A larger size is scaled
  // down to fit with its aspect kept (fitSize), it is never refused.
  maxSide?: number
}
/** Every studio model, the retired ones included (retired-models.ts, from the
 *  web): their schema, price and name stay resolvable for old runs and saved
 *  picks. */
export const STUDIO_MODELS_WITH_RETIRED = definitions as Record<string, StudioModel>
/** The studio models on offer. Every picker, role and list reads this. */
export const STUDIO_MODELS: Record<string, StudioModel> = Object.fromEntries(
  Object.entries(STUDIO_MODELS_WITH_RETIRED).filter(([id]) => !isRetiredMediaModel(id)),
)
/** A studio model the catalogue marks `unmeasured` (14.11.2026, 3.1.0): its
 *  price and filter are not checked by a paid run yet, so no picker, role or
 *  list shows it. Unless the live catalogue entry carries `unmeasured: true`:
 *  the server sends that only while its switch for the paid measurement
 *  (NEXT_PUBLIC_SHOW_UNMEASURED_MODELS on the web) is on. An older server that
 *  lists such a model without the mark does not put it in front of anyone. */
export function unmeasuredHidden(entry: { id: string; unmeasured?: boolean }): boolean {
  return STUDIO_MODELS_WITH_RETIRED[entry.id]?.unmeasured === true && entry.unmeasured !== true
}
export function studioSchema(id: string): Schema {
  const model = STUDIO_MODELS_WITH_RETIRED[id]
  if (!model) throw new Error('Unknown studio model')
  return (schemas as Record<string, Schema>)[model.endpoint]
}
export function supportsProviderField(id: string, field: string, op = 'generate', lora = false): boolean {
  const m = (endpoints as Record<string, Record<string, string>>)[id]
  const key = op === 'animate' || op === 'edit' ? 'i2' : 't2'
  const path = STUDIO_MODELS_WITH_RETIRED[id]?.endpoint ?? (lora ? m?.[key + 'Lora'] : undefined) ?? m?.[key] ?? m?.i2
  return !!path && !!(schemas as Record<string, Schema>)[path]?.properties?.[field]
}
const HIDDEN = new Set(['enable_base64_output', 'enable_sync_mode'])
// Ein Feld, das eine Datei oder eine Adresse tragen kann und nicht ueber
// `inputs` laeuft (02.10.2026). Ueber `inputs` gehen eigene Dateien: gepruefte
// Groesse, ffprobe, eigene Ablage, Preis aus der echten Laenge. Liesse die
// Optionspruefung so ein Feld durch, gaebe ein roher POST beliebige fremde
// Adressen an den Anbieter. Zaehlt: format uri, oder ein Name mit url, image,
// video, audio, mask oder reference, sofern das Feld Text oder eine Liste
// nimmt (ein Schalter, eine Zahl oder eine feste Auswahl kann keine Adresse
// tragen). Namen auf _id sind Kennungen des Anbieters, keine Dateien.
const MEDIA_NAME = /url|image|video|audio|mask|reference/i
export function isMediaField(key: string, s: Schema): boolean {
  if (/_id$/.test(key)) return false
  const free = (s.type === 'string' && !s.enum) || s.type === 'array' || s.type === undefined
  return free && (s.format === 'uri' || MEDIA_NAME.test(key))
}
export function studioFields(id: string): Record<string, Schema> {
  const m = STUDIO_MODELS_WITH_RETIRED[id]
  return Object.fromEntries(Object.entries(studioSchema(id).properties ?? {}).filter(([key,s]) =>
    !m.inputs[key] && key !== (m.promptField ?? 'prompt') && !HIDDEN.has(key) && !s.disabled && !isMediaField(key, s)))
}
// Freie Groesse als Text: Breite und Hoehe je zwischen Schema-Grenze und 4096,
// sonst 256 bis 4096. Der Anbieter rechnet die Flaeche, also Preis und
// Speicher haengen daran.
const SIZE_MIN = 256, SIZE_MAX = 4096
function validSize(value: unknown, schema: Schema): boolean {
  if (typeof value !== 'string' || !/^\d+\*\d+$/.test(value)) return false
  const lo = Math.max(schema.minimum ?? SIZE_MIN, SIZE_MIN), hi = Math.min(schema.maximum ?? SIZE_MAX, SIZE_MAX)
  return value.split('*').every(v => Number(v) >= lo && Number(v) <= hi)
}
/** A "w*h" size scaled down so its longer side is at most `maxSide`, the
 *  aspect kept. Both sides land on a multiple of 16 and stay between 256 and
 *  `maxSide`. A size that fits stays exactly as it was asked for. Same rule as
 *  the web catalogue (08.11.2026). */
export function fitSize(value: string, maxSide: number): string {
  const m = /^(\d+)\*(\d+)$/.exec(value)
  if (!m) return value
  const w = Number(m[1]), h = Number(m[2])
  if (Math.max(w, h) <= maxSide) return value
  const scale = maxSide / Math.max(w, h)
  const side = (v: number) => Math.min(maxSide, Math.max(SIZE_MIN, Math.floor(v * scale / 16) * 16))
  return `${side(w)}*${side(h)}`
}
// The strongest a LoRA may be applied (08.11.2026, web). A scale outside is
// brought to the nearest end, never refused.
export const LORA_SCALE_MAX = 4
function fitLoras(value: unknown, schema: Schema): unknown {
  if (!Array.isArray(value)) return value
  const s = schema.items?.properties?.scale
  if (!s) return value
  const lo = s.minimum ?? 0, hi = Math.min(s.maximum ?? LORA_SCALE_MAX, LORA_SCALE_MAX)
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const scale = (row as Record<string, unknown>).scale
    if (typeof scale !== 'number' || !Number.isFinite(scale)) return row
    return { ...row, scale: Math.min(hi, Math.max(lo, scale)) }
  })
}
/** The longest side a free "w*h" size may have on this model: the measured
 *  `maxSide`, the schema maximum and our own ceiling, whichever is smallest. */
export function sizeLimit(model: Pick<StudioModel, 'maxSide'>, schema: Schema): number {
  return Math.min(model.maxSide ?? SIZE_MAX, schema.maximum ?? SIZE_MAX, SIZE_MAX)
}
/** A value of a model option brought inside the limits the upstream keeps. */
function fitOption(key: string, value: unknown, schema: Schema, model: StudioModel): unknown {
  if (key === 'size' && !schema.enum && validSize(value, {})) return fitSize(value as string, sizeLimit(model, schema))
  if (key === 'loras') return fitLoras(value, schema)
  return value
}
function validate(value: unknown, schema: Schema, name: string): void {
  if(name==='size'&&!schema.enum&&!validSize(value,schema))throw new Error('Size must be width*height in pixels, each side 256 to 4096')
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Choose a supported ${name}`)
  if (schema.type === 'string' && (typeof value !== 'string' || value.length > (schema.maxLength ?? 4000))) throw new Error(`Invalid ${name}`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid ${name}`)
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) ||
      (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`Invalid ${name}`)
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 30)) throw new Error(`Invalid ${name}`)
    for (const v of value) validate(v,schema.items ?? {},name)
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`)
    const obj = value as Record<string, unknown>
    for (const required of schema.required ?? []) if (obj[required] === undefined) throw new Error(`Missing ${name}.${required}`)
    for (const [k,v] of Object.entries(obj)) {
      if (!schema.properties?.[k]) throw new Error(`Unsupported ${name}.${k}`)
      validate(v,schema.properties[k],`${name}.${k}`)
    }
  }
}
export function studioOptions(id: string, prompt: string, raw: unknown, checkPrompt = true): Record<string, unknown> {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Invalid model options')
  const schema = studioSchema(id), m = STUDIO_MODELS_WITH_RETIRED[id], fields = studioFields(id)
  const options: Record<string, unknown> = { ...m.defaults }
  for (const [k,s] of Object.entries(fields)) if (s.default !== undefined && !(k in options)) options[k] = s.default
  for (const [k,asked] of Object.entries((raw ?? {}) as Record<string,unknown>)) {
    if (!fields[k]) throw new Error(`Unsupported model option: ${k}`)
    const v = fitOption(k, asked, fields[k], m)
    validate(v, fields[k],k); options[k] = v
  }
  for (const [key,value] of Object.entries(options)) {
    if (!schema.properties?.[key]) throw new Error(`Unsupported default: ${key}`)
    validate(value,schema.properties[key],key)
  }
  const promptField=m.promptField??'prompt'
  if (checkPrompt && schema.required?.includes(promptField) && !prompt.trim()) throw new Error('Enter a prompt before starting')
  if (checkPrompt && schema.properties?.[promptField]) validate(prompt,schema.properties[promptField],'prompt')
  for (const k of schema.required ?? []) if (!m.inputs[k] && k !== promptField && options[k] === undefined) throw new Error(`Missing ${k}`)
  return options
}
export function studioCredits(id: string, options: Record<string,unknown>, measuredSeconds?: number, imageCount = 1, promptLength = 100, referenceCount = 0): number {
  const m = STUDIO_MODELS_WITH_RETIRED[id]; if (!m) throw new Error('Unknown studio model')
  const resolution = String(options[m.price.resolutionField ?? 'resolution'] ?? 'default')
  const rate = m.price.rates[m.price.qualityField ? `${resolution}/${String(options[m.price.qualityField])}` : resolution]
  if (rate === undefined) throw new Error('Unpriced resolution')
  let seconds = m.price.mode === 'characters' ? Math.max(1,promptLength/100) : 1
  if (m.price.mode === 'output') {
    seconds = Number(options[m.price.durationField ?? 'duration']) / (m.price.unitDivisor ?? 1)
    // Ein angefangener Block zaehlt voll, weil der Anbieter ihn voll berechnet.
    if (m.price.blockSeconds) seconds = Math.ceil(seconds / m.price.blockSeconds - 1e-9) * m.price.blockSeconds
  }
  // 'input' zahlt die gemessene Eingabe, 'both' die Eingabe UND die angehaengte
  // Laenge: Seedance berechnet beim Verlaengern den ganzen fertigen Clip.
  // 'inout' (Video-Edit bei MiniMax H3, am 02.10.2026 an
  // /model/price gemessen): der halbe Satz auf die ganzen Eingabesekunden plus
  // der halbe Satz auf die Ausgabedauer. Ohne `duration` gilt die Eingabelaenge.
  if (m.price.mode === 'input' || m.price.mode === 'both' || m.price.mode === 'inout') {
    if (!measuredSeconds || !Number.isFinite(measuredSeconds) || measuredSeconds > (m.price.maxSeconds ?? 120)) throw new Error(`Input must be no longer than ${m.price.maxSeconds ?? 120} seconds`)
    seconds = Math.max(m.price.minSeconds ?? 3,Math.ceil(measuredSeconds))
    if (m.price.mode === 'both') seconds += Number(options[m.price.durationField ?? 'duration'])
    if (m.price.mode === 'inout') {
      const out = options[m.price.durationField ?? 'duration'] === undefined ? seconds : Number(options[m.price.durationField ?? 'duration'])
      seconds = (seconds + out) / 2
    }
  }
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid duration')
  // Ein Endpunkt, der nach Bildpunkten abrechnet, bringt seinen eigenen Faktor
  // mit (Crystal: Preis je Megapixel je Sekunde).
  // Ein abgeschaltetes Feld (num_images) fehlt in den Optionen: der Anbieter nimmt dann seinen Standard 1.
  const units = m.price.perUnitField ? Number(options[m.price.perUnitField] ?? 1) : 1
  if (!Number.isFinite(units) || units <= 0) throw new Error('Invalid size')
  return Math.ceil((rate * seconds * units + (m.price.extraImage ?? 0) * Math.max(0,imageCount-1) + (imageCount > 1 ? m.price.extraViews ?? 0 : 0) + (m.price.perReference ?? 0) * referenceCount) * 100000 - 1e-8)
}
export function studioBaseCredits(id: string): number {
  const schema = studioSchema(id), m = STUDIO_MODELS_WITH_RETIRED[id]
  const options: Record<string, unknown> = { ...m.defaults }
  // A disabled field never goes out (14.11.2026): the provider takes its own
  // default, which the run's price already is (Hi3D's resolution).
  for (const [key, s] of Object.entries(schema.properties ?? {})) if (!(key in options) && s.default !== undefined && !s.disabled) options[key] = s.default
  return studioCredits(id,options,5)
}

export function studioPreviewCredits(id: string, raw: Record<string,unknown>, seconds?: number, imageCount = 1, promptLength = 100, referenceCount = 0): number | null {
  try { return studioCredits(id,studioOptions(id,'',raw,false),seconds,imageCount,promptLength,referenceCount) } catch { return null }
}
