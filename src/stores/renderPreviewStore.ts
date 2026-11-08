import { create } from 'zustand'

/**
 * B28 (3.0.9): the newest live preview of the render that runs now, as a data
 * URL. Discord .molot, 28.10.2026: a video ran for minutes with no picture,
 * so a wrong start was only seen at the end. ComfyUI sends a preview per
 * sampling step when the prompt asks for it (api/comfyui submitWorkflow);
 * Create keeps the newest here and drops it when the run ends.
 *
 * Its own store, not createStore: that one is persisted, and a picture of a
 * run in flight must never reach storage or survive a restart.
 */
interface RenderPreviewState {
  url: string | null
  setUrl: (url: string | null) => void
  /** C45 (3.1.0): this run asked ComfyUI for previews. With none arriving
   *  by the time it samples, the waiting area says why instead of staying
   *  blank (an older ComfyUI ignores the request, and not every model has
   *  a preview decoder). */
  asked: boolean
  setAsked: (asked: boolean) => void
}

export const useRenderPreviewStore = create<RenderPreviewState>((set) => ({
  url: null,
  setUrl: (url) => set({ url }),
  asked: false,
  setAsked: (asked) => set({ asked }),
}))
