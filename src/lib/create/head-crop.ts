// Kopf-Zuschnitt der Figurfotos fuer den Bildschritt des Swaps (14.11.2026),
// Port des Web-Stands.
//
// Echttest vom 14.11.: Mit Ganzkoerperfotos uebernahm der offene Editor oft
// Kleidung und Koerper der Fotos statt der Szene. Mit Fotos, die nur Kopf,
// ganzes Haar und ein Stueck Hals zeigen, blieb die Szene erhalten. Darum
// schneidet der Browser jedes Figurfoto vor dem Hochladen auf den Kopf zu,
// mit einer Gesichtserkennung, die hier im Browser laeuft (face-detect.ts,
// lazy geladen). Findet sie kein Gesicht oder laedt sie nicht, geht das ganze
// Foto hoch wie bisher. Nur die Gesichtsvorlagen des Editors werden
// beschnitten; der Videoschritt bekommt weiter, was er heute bekommt.
//
// Hier steht die Geometrie als reine Funktion und der Ablauf mit
// austauschbaren Helfern, damit beides ohne Browser pruefbar ist.

/** Ein gefundenes Gesicht in Pixeln des Fotos. */
export interface FaceBox { x: number; y: number; width: number; height: number; score: number }

/** Der Ausschnitt, ganzzahlig, in Pixeln des Fotos. */
export interface CropBox { x: number; y: number; width: number; height: number }

export const HEAD_CROP = {
  /** Breite des Ausschnitts als Vielfaches der Gesichtsbreite. */
  widen: 2.2,
  /** Hoehe des Ausschnitts als Vielfaches der Gesichtshoehe. */
  tall: 2.6,
  /** Rand ueber dem Gesicht (Stirn, Haar) als Vielfaches der Gesichtshoehe.
   *  Der Rest der Hoehe liegt unter der Box (Hals): 2,6 = 1,2 + 1 + 0,4.
   *  BlazeFace legt die Box etwas unter das Kinn; mehr als 0,4 darunter
   *  zeigt im Echttest (14.11.) schon viel Kleidung. */
  above: 1.2,
  /** Kleinere Ausschnitte (Breite oder Hoehe) bleiben das ganze Foto. */
  minSide: 256,
  /** Deckt der Ausschnitt mindestens diesen Teil der Flaeche, bleibt es das
   *  ganze Foto (es ist schon ein Kopfbild). */
  keepWhole: 0.9,
  /** Gesichter unter dieser Sicherheit zaehlen nicht. */
  minScore: 0.5,
  /** Nur Gesichter, die hoechstens so viel unsicherer sind als das sicherste,
   *  kommen fuer die Wahl nach Groesse in Frage. */
  scoreBand: 0.1,
} as const

/** Das sicherste Gesicht; unter fast gleich sicheren (scoreBand) das
 *  groesste, bei gleicher Groesse das sicherere.
 *
 *  Echter Lauf am Desktop (14.11.2026, sam-altman.png, 1657 x 2629): BlazeFace
 *  fand das echte Gesicht (378 px, 0,83) und auf Pullover und Haenden ein
 *  groesseres Scheingesicht (443 px, 0,52). Nach Groesse allein wurde der
 *  Bauch ausgeschnitten. */
export function pickFace(faces: readonly FaceBox[]): FaceBox | null {
  const ok = faces.filter((f) => f.score >= HEAD_CROP.minScore && f.width > 0 && f.height > 0)
  if (!ok.length) return null
  const top = Math.max(...ok.map((f) => f.score))
  let best: FaceBox | null = null
  for (const f of ok) {
    if (f.score < top - HEAD_CROP.scoreBand) continue
    if (!best) { best = f; continue }
    const a = f.width * f.height
    const b = best.width * best.height
    if (a > b || (a === b && f.score > best.score)) best = f
  }
  return best
}

/** Legt ein Stueck der Laenge `len` moeglichst bei `start` in [0, max]:
 *  erst verschieben, dann, wenn es nicht passt, kuerzen. Waagrecht, wo ein
 *  verschobener Rand nur Hintergrund oder Schulter zeigt. */
function fit(start: number, len: number, max: number): [number, number] {
  if (len >= max) return [0, max]
  const s = Math.min(Math.max(start, 0), max - len)
  return [s, len]
}

/** Der Kopfausschnitt fuer ein Foto, oder null fuer das ganze Foto (kein
 *  sicheres Gesicht, Ausschnitt zu klein oder fast so gross wie das Foto). */
export function headCropBox(size: { width: number; height: number }, faces: readonly FaceBox[]): CropBox | null {
  const W = Math.floor(size.width)
  const H = Math.floor(size.height)
  if (!(W > 0) || !(H > 0)) return null
  const face = pickFace(faces)
  if (!face) return null
  const w = face.width * HEAD_CROP.widen
  const h = face.height * HEAD_CROP.tall
  const left = face.x + face.width / 2 - w / 2
  const top = face.y - face.height * HEAD_CROP.above
  const [x, cw] = fit(Math.round(left), Math.round(w), W)
  // Senkrecht wird gekappt, nicht verschoben: Stoesst das Haar oben an den
  // Rand, rutschte ein verschobener Ausschnitt unten in die Kleidung.
  const y = Math.max(0, Math.round(top))
  const ch = Math.min(H, Math.round(top + h)) - y
  if (cw < HEAD_CROP.minSide || ch < HEAD_CROP.minSide) return null
  // Fast das ganze Foto: Schneiden bringt nichts, das Foto bleibt, wie es ist.
  if (cw * ch >= W * H * HEAD_CROP.keepWhole) return null
  return { x, y, width: cw, height: ch }
}

/** Was der Ablauf vom Browser braucht. */
export interface HeadCropDeps {
  /** Masse des Fotos und die Gesichter darin. Wirft, wenn die Erkennung
   *  nicht laedt oder das Foto nicht lesbar ist. */
  detect: (photo: Blob) => Promise<{ width: number; height: number; faces: FaceBox[] }>
  /** Schneidet den Ausschnitt aus dem Foto, im Format des Fotos. */
  cut: (photo: Blob, box: CropBox) => Promise<Blob>
}

/** Laenger wartet der Upload nicht auf die Erkennung (erstes Laden der
 *  Erkennung eingeschlossen); danach geht das ganze Foto hoch. */
export const HEAD_CROP_TIMEOUT_MS = 20_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('face detection timed out')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** Schneidet ein Figurfoto auf den Kopf zu. Gibt bei jedem Fehler und ohne
 *  Gesicht das Foto unveraendert zurueck; wirft nie. */
export async function headCropPhoto(photo: Blob, deps: HeadCropDeps = browserHeadCrop, timeoutMs = HEAD_CROP_TIMEOUT_MS): Promise<Blob> {
  try {
    const found = await withTimeout(deps.detect(photo), timeoutMs)
    const box = headCropBox(found, found.faces)
    if (!box) return photo
    return await deps.cut(photo, box)
  } catch (err) {
    console.warn('head crop skipped, uploading the whole photo:', err instanceof Error ? err.message : err)
    return photo
  }
}

/** Der Weg im Browser: die Erkennung kommt erst beim ersten Bedarf, als
 *  eigener Teil des Bundles. */
export const browserHeadCrop: HeadCropDeps = {
  detect: async (photo) => (await import('./face-detect')).detectFaces(photo),
  cut: async (photo, box) => (await import('./face-detect')).cutPhoto(photo, box),
}
