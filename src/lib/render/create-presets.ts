import { STUDIO_MODELS, studioBaseCredits } from './studio-contract'
import { runCredits } from '../../stores/cloudCatalogStore'
import { type StepRole } from './preset-models'
import type { RenderKind, RenderOp } from './cloud-jobs'
// `role` is what the step DOES. The model named here is the preset's
// suggestion; the role decides which other models the customer may pick
// instead. See lib/render/preset-models.ts.
// `models` grenzt die Auswahl dieses Schrittes auf eine Teilmenge seiner Rolle
// ein. 19.09.2026, Entscheid von David: bei Horror passen Prefect Pony und
// Neta Lumina nicht, auch wenn sie offen sind. Die Rolle bleibt, was sie ist;
// der Schritt sagt, welche ihrer Mitglieder er wirklich verantworten kann.
export interface PresetStep { model: string; kind: RenderKind; op: RenderOp; title: string; role: StepRole; models?: string[] }
export interface CreatePreset { id: string; title: string; summary: string; category: 'Character'|'Horror'|'Product'|'Video'|'Audio'; adult: boolean; accent: string; steps: PresetStep[]; note?: string }
const image = (model:string,models?:string[]): PresetStep => ({model:'preset-'+model,kind:'image',op:'studio',title:'Create the image',role:'image',...(models?{models}:{})})
const animate = (model:string): PresetStep => ({model:'preset-'+model,kind:'video',op:'studio',title:'Bring it to life',role:'animate'})
const studio = (model:string,title:string,role:StepRole): PresetStep => ({model,kind:STUDIO_MODELS[model].kind,op:'studio',title,role})
// Die Bildmodelle, die eine Horrorszene wirklich tragen. Geprueft am
// 19.09.2026 an einem identischen Prompt mit gleichem Seed ueber alle offenen
// Bildmodelle des Katalogs: Prefect Pony und Neta Lumina liefern Illustration
// statt Szene und stehen hier deshalb nicht, obwohl sie offen sind. Die vier
// neuen stellen die Szene fotorealistisch und weichen sie nicht auf; FLUX SRPO
// lehnte denselben Prompt ab, Anima liefert Stilbild statt Foto.
const HORROR_IMAGE = ['preset-chroma', 'z-image', 'nucleus-image', 'jib-mix-qwen', 'wan-2.2-realism']
export const CREATE_PRESETS: CreatePreset[] = [
  {id:'spicy-character',title:'Uncensored Character Clip',summary:'Create a character, animate the scene, then add sound.',category:'Character',adult:true,accent:'rose',steps:[image('prefect-pony'),animate('wan-2.2-spicy'),studio('mmaudio-v2','Add a soundtrack','soundtrack')]},
  {id:'horror-creature',title:'Horror Creature',summary:'From creature concept to a cinematic clip with native audio.',category:'Horror',adult:true,accent:'emerald',steps:[image('chroma',HORROR_IMAGE),studio('open-video','Animate with native audio','animate')]},
  {id:'horror-negative',title:'Horror • More Control',summary:'Shape the atmosphere and exclude unwanted details with a negative prompt.',category:'Horror',adult:true,accent:'emerald',steps:[image('chroma',HORROR_IMAGE),animate('wan-2.7-spicy')]},
  {id:'spicy-anime',title:'Uncensored Anime',summary:'Illustrate an anime scene, add motion and finish with sound.',category:'Character',adult:true,accent:'rose',steps:[image('neta-lumina'),animate('wan-2.2-spicy'),studio('mmaudio-v2','Add a soundtrack','soundtrack')]},
  {id:'your-character',title:'Your Character • OpenVideo',summary:'Animate a character reference with native audio and style controls.',category:'Character',adult:true,accent:'rose',steps:[studio('open-video-lora','Animate your reference','animate')],note:'OpenVideo accepts curated style LoRAs. It does not accept your trained Character Studio weights. Use an image of your character as the reference.'},
  {id:'long-spicy-cut',title:'Long Uncensored Cut',summary:'Continue a clip from your gallery into the next scene.',category:'Video',adult:true,accent:'rose',steps:[{model:'preset-wan-2.2-spicy-extend',kind:'video',op:'studio',title:'Continue your clip',role:'extend'}]},
  {id:'talking-avatar',title:'Talking Avatar',summary:'Write the words, create a voice and bring your portrait to life.',category:'Character',adult:false,accent:'violet',steps:[{model:'preset-qwen3-tts',kind:'audio',op:'studio',title:'Create the voice',role:'speech'},studio('infinitetalk','Animate the speaker','talking')]},
  {id:'two-speakers',title:'Two-Character Dialogue',summary:'One image, two voices. Choose who speaks first.',category:'Character',adult:false,accent:'violet',steps:[studio('infinitetalk-multi','Direct the conversation','duo')]},
  {id:'product-360',title:'Product 360° Views',summary:'Explore your product from new camera angles.',category:'Product',adult:false,accent:'amber',steps:[studio('qwen-image-angles','Choose the camera angle','angles')],note:'Each run creates one still image from the selected angle, not a rotating video.'},
  {id:'product-scene',title:'Product in a Scene',summary:'Keep your product. Reimagine the setting.',category:'Product',adult:false,accent:'amber',steps:[studio('minimax-h3-edit','Set the scene','edit')]},
  {id:'animate-character',title:'Animate a Character',summary:'Transfer movement from a reference video to your character.',category:'Character',adult:false,accent:'violet',steps:[studio('scail-2','Transfer the movement','motion')]},
  {id:'restyle-video',title:'Restyle a Video',summary:'Give an existing clip a completely different visual style.',category:'Video',adult:false,accent:'sky',steps:[studio('wan-ditto','Choose your style','restyle')]},
  {id:'sharpen-4k',title:'Sharpen to 4K',summary:'Make a finished clip sharp. Up to 4K, or 8K on Crystal.',category:'Video',adult:false,accent:'sky',steps:[studio('flashvsr','Sharpen your clip','upscale')]},
  {id:'song-from-words',title:'Song from Words',summary:'Describe a song and get a finished track with vocals.',category:'Audio',adult:false,accent:'violet',steps:[studio('minimax-music','Write the song','music')]},
  {id:'presenter-script',title:'Presenter Reads Your Script',summary:'Write the words. A presenter says them on camera.',category:'Character',adult:false,accent:'violet',steps:[{model:'preset-qwen3-tts',kind:'audio',op:'studio',title:'Create the voice',role:'speech'},studio('heygen-twin','Pick your presenter','presenter')]},
]
// Desktop port (P2): the web sums this from its own price table
// (mediaCredits(s.kind, s.model, 5, s.op)), which the desktop does not have.
// Here a non-studio step prices from the live catalog via runCredits, the
// same reasoning as classicCredits in preset-models.ts. `null` for the whole
// preset when ANY step has no catalog price: a partial total would read as a
// real quote when it is not one.
export function presetBaseCredits(preset: CreatePreset): number | null {
  let total = 0
  for (const s of preset.steps) {
    if (s.op === 'studio') { total += studioBaseCredits(s.model); continue }
    const priced = runCredits(s.kind, s.op, s.model, 5, Number.NaN)
    if (!Number.isFinite(priced)) return null
    total += priced
  }
  return total
}
