// Wie ein Eintrag der Galerie heisst.
//
// 19.09.2026, gemeldet vom Inhaber: "Danach kommt nur noch Cloud-Videos. Man kann
// gar nicht mehr identifizieren, welches Video denn was ist." Zwei Ursachen:
// die Listenroute gab den Prompt nicht heraus, also hiess nach jedem Neuladen
// alles gleich; und ein Lauf ohne Prompt (Schaerfen, Verlaengern, ein Schritt
// aus einem Preset) hatte ueberhaupt nie einen Namen.
//
// Die Reihenfolge steht hier einmal, und jede Ansicht ruft sie auf. Vorher trug
// jede Stelle ihren eigenen Notnamen ("Cloud video", "Generated audio",
// "Audio"), und keiner davon sagte, was der Eintrag ist.
//
// Port aus the web app: der Desktop haelt den
// Katalog in einem Store statt in einer statischen Liste, deshalb kommt
// cloudModelById hier aus cloudCatalogStore statt aus cloud-models.
import type { GalleryItem } from '../../stores/createStore'
import { modelLabel as resolveModelLabel } from './preset-models'

/** Was der Lauf getan hat, wenn niemand etwas geschrieben hat. */
const OP_NAME: Record<string, string> = {
  removebg: 'Background removed',
  upscale: 'Upscaled',
  eraser: 'Object erased',
  extend: 'Extended clip',
  motion: 'Motion transfer',
  lipsync: 'Talking character',
  'lora-train': 'Character trained',
}

const TYPE_NAME: Record<GalleryItem['type'], string> = {
  image: 'Image',
  video: 'Clip',
  audio: 'Audio',
  '3d': '3D model',
}

// Review A kleiner Punkt 3: this used to be its own copy (STUDIO_MODELS
// first, catalog second), while preset-models.ts's exported `modelLabel`
// (what useCloudCreate.ts sends as `params.label`) checks the catalog twin
// FIRST. A model that is both a Studio entry and a catalog twin with a
// DIFFERENT label could read one name before a reload (this file, from the
// job) and another after (preset-models.ts's version, from the picker),
// exactly the mix-up gallery-label.ts exists to prevent. One function now,
// imported, not two that can drift apart.
function modelLabel(id: string): string | undefined {
  const label = resolveModelLabel(id)
  return label === id ? undefined : label
}

/** Der Name des Eintrags. Nie leer: eine Kachel ohne Namen ist von der
 *  daneben nicht zu unterscheiden, und genau das war der Fehler. */
export function galleryLabel(item: GalleryItem): string {
  const prompt = item.prompt?.trim()
  const label = item.label?.trim()
  // Beides, wenn es beides gibt: der Titel sagt, was der Lauf war, der Prompt
  // sagt, welcher von den dreien es ist. Am 19.09.2026 zum Ergebnis
  // eines Presets: "das Endprodukt soll dann auch als ein Ganzes stehen und
  // erkennbar sein, was es ist."
  if (label && prompt) return label === prompt ? label : `${label} · ${prompt}`
  if (prompt) return prompt
  if (label) return label
  const tat = item.intent ? OP_NAME[item.intent] : undefined
  const modell = modelLabel(item.model)
  if (tat) return modell ? `${tat} · ${modell}` : tat
  // Bleibt nur die Gattung, dann wenigstens mit dem Modell daneben: "Clip ·
  // Wan 2.2 Realism" sagt mehr als "Cloud video" und unterscheidet zwei Laeufe.
  return modell ? `${TYPE_NAME[item.type]} · ${modell}` : TYPE_NAME[item.type]
}

/** Derselbe Name, auf eine Zeile gekuerzt. Das Auslassungszeichen steht nur
 *  da, wo wirklich etwas fehlt. */
export function galleryLabelShort(item: GalleryItem, max = 40): string {
  const name = galleryLabel(item)
  return name.length > max ? `${name.slice(0, max).trimEnd()}…` : name
}
