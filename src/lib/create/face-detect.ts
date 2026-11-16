// Gesichtserkennung im Webview fuer den Kopf-Zuschnitt (head-crop.ts), Port
// des Web-Stands.
//
// MediaPipe Tasks Vision (Google, Apache-2.0, im package.json exakt gepinnt)
// mit dem Modell BlazeFace short range. Alles kommt aus der App selbst:
// die Wasm-Dateien kopiert scripts/copy-face-assets.mjs vor dev und build aus
// node_modules nach public/face/, das Modell liegt dort im Repository. Zur
// Laufzeit geht keine Anfrage an ein CDN.
//
// Diese Datei wird nur ueber import() aus head-crop.ts geladen, also erst,
// wenn der Bildschritt des Swaps Fotos hochlaedt.

import type { CropBox, FaceBox } from './head-crop-boxes'

/** Wo die Dateien liegen (public/face/). */
export const FACE_ASSET_BASE = '/face'
export const FACE_MODEL_PATH = `${FACE_ASSET_BASE}/blaze_face_short_range.tflite`

/** SHA-256 des Modells, wie es am 14.11.2026 von der offiziellen Quelle kam:
 *  storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite
 *  Ein anderes Modell wird nicht geladen; dann geht das ganze Foto hoch. */
export const FACE_MODEL_SHA256 = 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f'

interface Detector {
  detect: (image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas) => { detections: { categories: { score: number }[]; boundingBox?: { originX: number; originY: number; width: number; height: number } }[] }
}

let loading: Promise<Detector> | null = null

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function load(): Promise<Detector> {
  const res = await fetch(FACE_MODEL_PATH)
  if (!res.ok) throw new Error(`face model: HTTP ${res.status}`)
  const model = await res.arrayBuffer()
  if ((await sha256Hex(model)) !== FACE_MODEL_SHA256) throw new Error('face model: checksum mismatch')
  const { FaceDetector } = await import('@mediapipe/tasks-vision')
  // Nur die SIMD-Fassung liegt aus; jeder heutige Browser kann sie. Ohne
  // SIMD scheitert das Laden, und das ganze Foto geht hoch.
  return FaceDetector.createFromOptions(
    { wasmLoaderPath: `${FACE_ASSET_BASE}/vision_wasm_internal.js`, wasmBinaryPath: `${FACE_ASSET_BASE}/vision_wasm_internal.wasm` },
    { baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.5 },
  ) as unknown as Promise<Detector>
}

/** Die Erkennung, einmal geladen. Scheitert das Laden, versucht der naechste
 *  Aufruf es neu. */
function detector(): Promise<Detector> {
  if (!loading) loading = load().catch((err) => { loading = null; throw err })
  return loading
}

function canvasOf(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

function context2d(c: OffscreenCanvas | HTMLCanvasElement) {
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('no 2d canvas')
  return ctx
}

/** Die Bereiche, in denen gesucht wird: erst das ganze Foto. BlazeFace short
 *  range sieht ein Bild mit 128 Pixeln Kantenlaenge; auf einem Ganzkoerperfoto
 *  ist das Gesicht darin zu klein. Dann das obere Quadrat (dort steht bei
 *  einem hohen Foto der Kopf) und dessen obere Haelften links, mittig, rechts. */
export function searchRegions(width: number, height: number): CropBox[] {
  const out: CropBox[] = [{ x: 0, y: 0, width, height }]
  const side = Math.min(width, height)
  if (height > width * 1.2) out.push({ x: 0, y: 0, width: side, height: side })
  const half = Math.round(side / 2)
  if (half >= 128) {
    for (const x of [0, Math.round((width - half) / 2), width - half]) {
      for (const y of [0, Math.round(half / 2)]) out.push({ x, y, width: half, height: half })
    }
  }
  return out
}

function facesIn(det: Detector, source: ImageBitmap, region: CropBox, full: boolean): FaceBox[] {
  let input: ImageBitmap | OffscreenCanvas | HTMLCanvasElement = source
  if (!full) {
    const c = canvasOf(region.width, region.height)
    context2d(c).drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height)
    input = c
  }
  return det.detect(input).detections.flatMap((d) => d.boundingBox
    ? [{ x: d.boundingBox.originX + region.x, y: d.boundingBox.originY + region.y, width: d.boundingBox.width, height: d.boundingBox.height, score: d.categories[0]?.score ?? 0 }]
    : [])
}

/** Masse des Fotos und die Gesichter darin, in Pixeln des Fotos. */
export async function detectFaces(photo: Blob): Promise<{ width: number; height: number; faces: FaceBox[] }> {
  const bitmap = await createImageBitmap(photo)
  try {
    const det = await detector()
    const { width, height } = bitmap
    for (const [i, region] of searchRegions(width, height).entries()) {
      const faces = facesIn(det, bitmap, region, i === 0)
      if (faces.some((f) => f.score >= 0.5)) return { width, height, faces }
    }
    return { width, height, faces: [] }
  } finally {
    bitmap.close()
  }
}

/** Schneidet den Ausschnitt aus dem Foto: JPEG bleibt JPEG, alles andere wird
 *  PNG (wie die Fotos bisher hochgingen). */
export async function cutPhoto(photo: Blob, box: CropBox): Promise<Blob> {
  const bitmap = await createImageBitmap(photo)
  try {
    const c = canvasOf(box.width, box.height)
    context2d(c).drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height)
    const type = photo.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    if ('convertToBlob' in c) return await c.convertToBlob({ type, quality: 0.92 })
    return await new Promise<Blob>((resolve, reject) => {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas export failed'))), type, 0.92)
    })
  } finally {
    bitmap.close()
  }
}
