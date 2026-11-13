// Provider api_schema snapshot, reviewed 2026-10-02. Mirrored in the worker.
import definitions from './studio-models.json'
import schemas from './provider-schemas.json'
import endpoints from './provider-endpoints.json'
export type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; default?: unknown; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; items?: Schema; description?: string; disabled?: boolean; format?: string }
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
  tier: ModelTier; weights: ModelWeights
  inputs: Record<string, string>; defaults: Record<string, unknown>
  // `resolutionField` / `durationField`: nicht jeder Endpunkt nennt die beiden
  // Groessen gleich. Die Upscaler rechnen ueber `target_resolution`, die
  // ElevenLabs-Musik ueber `music_length_ms`. `unitDivisor` bringt Millisekunden
  // auf Sekunden, `blockSeconds` bildet einen angefangenen Block ab (ElevenLabs
  // rechnet je angefangene Minute), `minSeconds` die Mindestlaenge einer
  // gemessenen Eingabe. Alle vier sind an POST /model/price gemessen.
  price: { mode: string; rates: Record<string, number>; maxSeconds?: number; extraImage?: number
    resolutionField?: string; durationField?: string; unitDivisor?: number; blockSeconds?: number; minSeconds?: number
    perUnitField?: string }
}
export const STUDIO_MODELS = definitions as Record<string, StudioModel>
export function studioSchema(id: string): Schema {
  const model = STUDIO_MODELS[id]
  if (!model) throw new Error('Unknown studio model')
  return (schemas as Record<string, Schema>)[model.endpoint]
}
export function supportsProviderField(id: string, field: string, op = 'generate', lora = false): boolean {
  const m = (endpoints as Record<string, Record<string, string>>)[id]
  const key = op === 'animate' || op === 'edit' ? 'i2' : 't2'
  const path = STUDIO_MODELS[id]?.endpoint ?? (lora ? m?.[key + 'Lora'] : undefined) ?? m?.[key] ?? m?.i2
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
  const m = STUDIO_MODELS[id]
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
function validate(value: unknown, schema: Schema, name: string): void {
  if(name==='size'&&!schema.enum&&!validSize(value,schema))throw new Error('Size must be width*height in pixels, each side 256 to 4096')
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Choose a supported ${name}`)
  if (schema.type === 'string' && (typeof value !== 'string' || value.length > 4000)) throw new Error(`Invalid ${name}`)
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
  const schema = studioSchema(id), m = STUDIO_MODELS[id], fields = studioFields(id)
  const options: Record<string, unknown> = { ...m.defaults }
  for (const [k,s] of Object.entries(fields)) if (s.default !== undefined && !(k in options)) options[k] = s.default
  for (const [k,v] of Object.entries((raw ?? {}) as Record<string,unknown>)) {
    if (!fields[k]) throw new Error(`Unsupported model option: ${k}`)
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
export function studioCredits(id: string, options: Record<string,unknown>, measuredSeconds?: number, imageCount = 1, promptLength = 100): number {
  const m = STUDIO_MODELS[id]; if (!m) throw new Error('Unknown studio model')
  const resolution = String(options[m.price.resolutionField ?? 'resolution'] ?? 'default'), rate = m.price.rates[resolution]
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
  return Math.ceil((rate * seconds * units + (m.price.extraImage ?? 0) * Math.max(0,imageCount-1)) * 100000 - 1e-8)
}
export function studioBaseCredits(id: string): number {
  const schema = studioSchema(id), m = STUDIO_MODELS[id]
  const options: Record<string, unknown> = { ...m.defaults }
  for (const [key, s] of Object.entries(schema.properties ?? {})) if (!(key in options) && s.default !== undefined) options[key] = s.default
  return studioCredits(id,options,5)
}

export function studioPreviewCredits(id: string, raw: Record<string,unknown>, seconds?: number, imageCount = 1, promptLength = 100): number | null {
  try { return studioCredits(id,studioOptions(id,'',raw,false),seconds,imageCount,promptLength) } catch { return null }
}
