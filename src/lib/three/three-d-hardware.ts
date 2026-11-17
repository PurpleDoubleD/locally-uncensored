// Local 3D on Windows and Linux runs TRELLIS.2 in ComfyUI, which asks for a
// graphics card with 12 GB or more (measured on a 12 GB RTX 3060: Draft
// peaked at 11.1 GB). Below that, or with ComfyUI on the processor, a run
// loads for a long time and then fails in a loader ("DefaultCPUAllocator: not
// enough memory", RX 6600 with 8 GB, Discord 17.11.2026). This line says so
// before the setup and before a run. It is a hint, not a lock: setting up and
// starting stay possible.
//
// A Mac is not asked here. TripoSR and Stable Fast 3D run on its shared
// memory and have no measured limit.

/** The graphics memory TRELLIS.2 asks for, in GB. */
export const TRELLIS_MIN_VRAM_GB = 12

export interface ThreeDHardwareFacts {
  /** The card's own memory in whole GB, null while unknown or on a Mac. */
  cardGb: number | null
  /** ComfyUI runs on the processor this session. */
  comfyOnCpu: boolean
}

/** The line for a machine that does not fit local 3D, or null when it fits
 *  or nothing is known yet. */
export function threeDHardwareLine({ cardGb, comfyOnCpu }: ThreeDHardwareFacts): string | null {
  if (comfyOnCpu) return `Local 3D needs a graphics card with ${TRELLIS_MIN_VRAM_GB} GB or more. ComfyUI runs on the processor here.`
  if (cardGb !== null && cardGb > 0 && cardGb < TRELLIS_MIN_VRAM_GB) {
    return `Local 3D needs a graphics card with ${TRELLIS_MIN_VRAM_GB} GB or more. Yours has ${cardGb} GB.`
  }
  return null
}

/** The way out after the line, a button when LU Cloud can be used. */
export const THREE_D_USE_CLOUD = 'Use a LU Cloud 3D model instead.'
