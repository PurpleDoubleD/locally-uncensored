/**
 * Kopf-Zuschnitt der Figurfotos fuer den Bildschritt des Swaps (14.11.2026):
 * die Geometrie, die Wahl des Gesichts, der Rueckfall aufs ganze Foto und die
 * festgehaltene Pruefsumme des Modells.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { headCropBox, headCropPhoto, pickFace, HEAD_CROP, type FaceBox, type HeadCropDeps } from '../head-crop'
import { FACE_MODEL_PATH, FACE_MODEL_SHA256, searchRegions } from '../face-detect'

const face = (x: number, y: number, width: number, height: number, score = 0.9): FaceBox => ({ x, y, width, height, score })

describe('headCropBox: Kopf, Haar, ein Stueck Hals', () => {
  it('erweitert die Gesichtsbox auf 2,2 x Breite und 2,6 x Hoehe, oben mehr Rand als unten', () => {
    // Gesicht 200 x 240 mitten in einem grossen Foto.
    const box = headCropBox({ width: 2000, height: 3000 }, [face(900, 800, 200, 240)])!
    expect(box.width).toBe(440)
    expect(box.height).toBe(624)
    // Waagrecht mittig um das Gesicht.
    expect(box.x + box.width / 2).toBe(1000)
    // Ueber dem Gesicht 1,2 x Hoehe (Haar), darunter 0,4 x Hoehe (Hals).
    const above = 800 - box.y
    const below = box.y + box.height - (800 + 240)
    expect(above).toBe(288)
    expect(below).toBe(96)
    expect(above).toBeGreaterThan(below)
  })

  it('waagrecht verschoben, senkrecht gekappt: unten nie tiefer als der Hals', () => {
    // Gesicht oben links: waagrecht rutscht der Ausschnitt ins Foto, oben
    // fehlt das Stueck ueber dem Rand, unten endet er weiter am Hals.
    const box = headCropBox({ width: 1200, height: 1600 }, [face(10, 20, 200, 240)])!
    expect(box).toEqual({ x: 0, y: 0, width: 440, height: 20 + 240 + 96 })
    // Gesicht unten rechts: rechts verschoben, unten gekappt.
    const low = headCropBox({ width: 1200, height: 1600 }, [face(1000, 1300, 200, 240)])!
    expect(low.x + low.width).toBe(1200)
    expect(low.width).toBe(440)
    expect(low.y).toBe(1300 - 288)
    expect(low.y + low.height).toBe(1600)
  })

  it('kappt auf die Bildgrenzen, wenn der Ausschnitt breiter ist als das Foto', () => {
    // Nahaufnahme: 2,2 x 400 = 880 > 700 Breite, die Hoehe passt.
    const box = headCropBox({ width: 700, height: 2000 }, [face(150, 600, 400, 400)])!
    expect(box.x).toBe(0)
    expect(box.width).toBe(700)
    expect(box.height).toBe(1040)
  })

  it('bleibt beim ganzen Foto, wenn der Ausschnitt kleiner als 256 px waere', () => {
    expect(HEAD_CROP.minSide).toBe(256)
    // 100 x 110 Gesicht: 220 x 286, zu schmal.
    expect(headCropBox({ width: 1000, height: 1500 }, [face(400, 300, 100, 110)])).toBeNull()
    // Knapp darueber geht es.
    expect(headCropBox({ width: 1000, height: 1500 }, [face(400, 300, 117, 110)])).not.toBeNull()
  })

  it('bleibt beim ganzen Foto, wenn der Ausschnitt das ganze Foto waere', () => {
    expect(headCropBox({ width: 500, height: 600 }, [face(100, 100, 300, 350)])).toBeNull()
  })

  it('ohne Gesicht, mit unsicherem Gesicht oder kaputten Massen: null', () => {
    expect(headCropBox({ width: 1000, height: 1500 }, [])).toBeNull()
    expect(headCropBox({ width: 1000, height: 1500 }, [face(400, 300, 200, 240, 0.3)])).toBeNull()
    expect(headCropBox({ width: 0, height: 1500 }, [face(400, 300, 200, 240)])).toBeNull()
    expect(headCropBox({ width: NaN, height: 1500 }, [face(400, 300, 200, 240)])).toBeNull()
  })

  it('liefert ganze Pixel innerhalb des Fotos', () => {
    const box = headCropBox({ width: 1657, height: 2629 }, [face(512.4, 233.7, 201.3, 199.9)])!
    for (const v of Object.values(box)) expect(Number.isInteger(v)).toBe(true)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(1657)
    expect(box.y + box.height).toBeLessThanOrEqual(2629)
  })
})

describe('pickFace: das groesste sichere Gesicht', () => {
  it('nimmt das groesste, nicht das erste', () => {
    expect(pickFace([face(0, 0, 50, 50), face(100, 100, 200, 200), face(400, 0, 120, 120)])).toEqual(face(100, 100, 200, 200))
  })
  it('laesst unsichere Gesichter aus, auch wenn sie groesser sind', () => {
    expect(pickFace([face(0, 0, 400, 400, 0.2), face(500, 0, 150, 150, 0.8)])).toEqual(face(500, 0, 150, 150, 0.8))
  })
  it('ein groesseres, aber deutlich unsichereres Scheingesicht verliert (echter Lauf sam-altman.png)', () => {
    // Gemessen am 14.11.2026 im Webview-Lauf: Gesicht oben, Scheingesicht auf
    // Pullover und Haenden.
    const echt = face(447, 255, 378, 378, 0.826)
    const schein = face(234, 1163, 443, 443, 0.521)
    expect(pickFace([echt, schein])).toEqual(echt)
    expect(pickFace([schein, echt])).toEqual(echt)
    const box = headCropBox({ width: 1657, height: 2629 }, [schein, echt])!
    // Der Ausschnitt endet am Hals, nicht im Bauch.
    expect(box.y).toBe(0)
    expect(box.y + box.height).toBe(Math.round(255 + 378 * 1.4))
  })
  it('unter fast gleich sicheren Gesichtern bleibt es das groesste', () => {
    expect(pickFace([face(0, 0, 100, 100, 0.9), face(200, 0, 200, 200, 0.85)])).toEqual(face(200, 0, 200, 200, 0.85))
  })
  it('bei gleicher Groesse das sicherere', () => {
    expect(pickFace([face(0, 0, 100, 100, 0.6), face(200, 0, 100, 100, 0.95)])!.score).toBe(0.95)
  })
  it('leer: null', () => {
    expect(pickFace([])).toBeNull()
  })
})

describe('headCropPhoto: Rueckfall aufs ganze Foto', () => {
  const photo = new Blob(['ganzes foto'], { type: 'image/png' })

  it('schneidet zu, wenn ein Gesicht da ist', async () => {
    const cut = vi.fn(async () => new Blob(['kopf'], { type: 'image/png' }))
    const deps: HeadCropDeps = { detect: async () => ({ width: 1657, height: 2629, faces: [face(600, 200, 220, 260)] }), cut }
    const out = await headCropPhoto(photo, deps)
    expect(await out.text()).toBe('kopf')
    expect(cut).toHaveBeenCalledWith(photo, { x: 468, y: 0, width: 484, height: 200 + 260 + 104 })
  })

  it('ohne Gesicht: das ganze Foto, nichts geschnitten', async () => {
    const cut = vi.fn(async () => new Blob(['kopf']))
    const out = await headCropPhoto(photo, { detect: async () => ({ width: 800, height: 1200, faces: [] }), cut })
    expect(out).toBe(photo)
    expect(cut).not.toHaveBeenCalled()
  })

  it('wenn die Erkennung nicht laedt: das ganze Foto', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await headCropPhoto(photo, { detect: async () => { throw new Error('wasm failed') }, cut: async () => new Blob(['x']) })
    expect(out).toBe(photo)
    warn.mockRestore()
  })

  it('wenn das Schneiden scheitert: das ganze Foto', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await headCropPhoto(photo, {
      detect: async () => ({ width: 1657, height: 2629, faces: [face(600, 200, 220, 260)] }),
      cut: async () => { throw new Error('canvas') },
    })
    expect(out).toBe(photo)
    warn.mockRestore()
  })

  it('wenn die Erkennung haengt: nach der Wartezeit das ganze Foto', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await headCropPhoto(photo, { detect: () => new Promise(() => {}), cut: async () => new Blob(['x']) }, 20)
    expect(out).toBe(photo)
    warn.mockRestore()
  })

  it('ohne Browser (kein createImageBitmap): der echte Weg faellt aufs ganze Foto zurueck', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await headCropPhoto(photo)).toBe(photo)
    warn.mockRestore()
  })
})

describe('Modell und Suchbereiche', () => {
  it('das Modell im Repository hat die festgehaltene Pruefsumme', () => {
    const file = join(__dirname, '..', '..', '..', '..', 'public', FACE_MODEL_PATH)
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(FACE_MODEL_SHA256)
    expect(FACE_MODEL_SHA256).toBe('b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f')
  })

  it('sucht erst im ganzen Foto, bei hohen Fotos dann oben', () => {
    const r = searchRegions(1657, 2629)
    expect(r[0]).toEqual({ x: 0, y: 0, width: 1657, height: 2629 })
    expect(r[1]).toEqual({ x: 0, y: 0, width: 1657, height: 1657 })
    for (const b of r) {
      expect(b.x + b.width).toBeLessThanOrEqual(1657)
      expect(b.y + b.height).toBeLessThanOrEqual(2629)
    }
    // Ein quadratisches Foto bekommt kein eigenes oberes Quadrat.
    expect(searchRegions(1000, 1000).filter((b) => b.width === 1000)).toHaveLength(1)
  })
})
