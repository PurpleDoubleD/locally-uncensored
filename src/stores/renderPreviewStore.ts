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
}

export const useRenderPreviewStore = create<RenderPreviewState>((set) => ({
  url: null,
  setUrl: (url) => set({ url }),
}))
