// ─────────────────────────────────────────────────────────────────────
// Framework-agnostic mask painting engine. Owns a mask buffer at SOURCE
// resolution (hard invariant — never display resolution, or ComfyUI's
// LoadImageMask misaligns). Exports white-where-painted on black (ComfyUI
// mask convention). Pure TS — ports back to src/components/create unchanged.
// ─────────────────────────────────────────────────────────────────────
export type Tool = 'brush' | 'eraser'

const UNDO_CAP = 20

/**
 * The brush a fresh engine starts with: 6% of the longest source edge.
 *
 * Exported because the editor's brush-size slider has to show this number from
 * its very first render. Reading it back off a just-constructed engine inside
 * an effect meant a setState in an effect body (React 19 `set-state-in-effect`)
 * for a value that is a plain function of the source dimensions the editor
 * already holds. The constructor uses it too, so the two cannot drift apart.
 */
export function defaultBrushSize(width: number, height: number): number {
  return Math.round(Math.max(Math.max(1, Math.round(width)), Math.max(1, Math.round(height))) * 0.06)
}

export class MaskCanvasEngine {
  readonly width: number
  readonly height: number
  private mask: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private undoStack: ImageData[] = []
  private redoStack: ImageData[] = []
  private painting = false
  private lastX = 0
  private lastY = 0

  tool: Tool = 'brush'
  brushSize: number

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.mask = document.createElement('canvas')
    this.mask.width = this.width
    this.mask.height = this.height
    // willReadFrequently: undo snapshots + hasPaint do frequent getImageData.
    this.ctx = this.mask.getContext('2d', { willReadFrequently: true })!
    this.brushSize = defaultBrushSize(this.width, this.height)
  }

  // ── stroke lifecycle (coords are in SOURCE pixels) ──
  beginStroke(x: number, y: number) {
    this.pushUndo()
    this.redoStack = []
    this.painting = true
    this.lastX = x
    this.lastY = y
    this.dab(x, y)
  }

  strokeTo(x: number, y: number) {
    if (!this.painting) return
    this.applyStyle()
    this.ctx.lineWidth = this.brushSize
    this.ctx.beginPath()
    this.ctx.moveTo(this.lastX, this.lastY)
    this.ctx.lineTo(x, y)
    this.ctx.stroke()
    this.lastX = x
    this.lastY = y
  }

  endStroke() { this.painting = false }

  private dab(x: number, y: number) {
    this.applyStyle()
    this.ctx.beginPath()
    this.ctx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2)
    this.ctx.fill()
  }

  private applyStyle() {
    this.ctx.lineCap = 'round'
    this.ctx.lineJoin = 'round'
    if (this.tool === 'eraser') {
      this.ctx.globalCompositeOperation = 'destination-out'
      this.ctx.fillStyle = 'rgba(0,0,0,1)'
      this.ctx.strokeStyle = 'rgba(0,0,0,1)'
    } else {
      this.ctx.globalCompositeOperation = 'source-over'
      this.ctx.fillStyle = '#ffffff'
      this.ctx.strokeStyle = '#ffffff'
    }
  }

  // ── operations ──
  clear() {
    this.pushUndo()
    this.redoStack = []
    this.ctx.clearRect(0, 0, this.width, this.height)
  }

  invert() {
    this.pushUndo()
    this.redoStack = []
    const tmp = document.createElement('canvas')
    tmp.width = this.width; tmp.height = this.height
    const tctx = tmp.getContext('2d')!
    tctx.fillStyle = '#ffffff'
    tctx.fillRect(0, 0, this.width, this.height)
    tctx.globalCompositeOperation = 'destination-out'
    tctx.drawImage(this.mask, 0, 0)
    this.ctx.globalCompositeOperation = 'source-over'
    this.ctx.clearRect(0, 0, this.width, this.height)
    this.ctx.drawImage(tmp, 0, 0)
  }

  hasPaint(): boolean {
    const { data } = this.ctx.getImageData(0, 0, this.width, this.height)
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true
    return false
  }

  // ── undo / redo (capped ring) ──
  private snapshot(): ImageData { return this.ctx.getImageData(0, 0, this.width, this.height) }
  private pushUndo() {
    this.undoStack.push(this.snapshot())
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift()
  }
  canUndo() { return this.undoStack.length > 0 }
  canRedo() { return this.redoStack.length > 0 }
  undo() {
    const prev = this.undoStack.pop()
    if (!prev) return
    this.redoStack.push(this.snapshot())
    this.ctx.globalCompositeOperation = 'source-over'
    this.ctx.putImageData(prev, 0, 0)
  }
  redo() {
    const next = this.redoStack.pop()
    if (!next) return
    this.undoStack.push(this.snapshot())
    this.ctx.globalCompositeOperation = 'source-over'
    this.ctx.putImageData(next, 0, 0)
  }

  // ── rendering / export ──
  /** Paint the mask, tinted red, onto a source-res overlay context. */
  renderOverlay(octx: CanvasRenderingContext2D) {
    octx.clearRect(0, 0, this.width, this.height)
    octx.globalCompositeOperation = 'source-over'
    octx.drawImage(this.mask, 0, 0)
    octx.globalCompositeOperation = 'source-in'
    octx.fillStyle = 'rgba(239,68,68,0.5)'
    octx.fillRect(0, 0, this.width, this.height)
    octx.globalCompositeOperation = 'source-over'
  }

  /** White-where-painted on black — the ComfyUI LoadImageMask convention. */
  exportMaskBlob(): Promise<Blob> {
    const out = document.createElement('canvas')
    out.width = this.width; out.height = this.height
    const octx = out.getContext('2d')!
    octx.fillStyle = '#000000'
    octx.fillRect(0, 0, this.width, this.height)
    octx.globalCompositeOperation = 'source-over'
    octx.drawImage(this.mask, 0, 0)
    return new Promise((resolve) => out.toBlob((b) => resolve(b!), 'image/png'))
  }
}
