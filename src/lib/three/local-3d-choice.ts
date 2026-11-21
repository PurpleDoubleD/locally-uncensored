// Which local 3D model this machine should get, before anything is downloaded.
//
// The rule, in one place:
//  - Windows and Linux have one local model, TRELLIS.2 through ComfyUI. It was
//    measured at 11.1 GB peak on a 12 GB card, so 12 GB of VRAM is "fits".
//    Below that the card says so and the download stays possible, because
//    ComfyUI can offload to RAM at a large cost in time.
//  - A Mac has TripoSR and Stable Fast 3D, both asking for 16 GB of memory.
//    TripoSR is recommended: it is smaller and needs no account. Stable Fast
//    3D is recommended once a Hugging Face token is there and the Mac has
//    24 GB or more, because it gives the sharper result.
//
// Until 3.1.3 "Download & install" took the model picked in the chip on a Mac
// (TripoSR unless changed) and the first bundle on a PC, without a word.

export type ThreeDFit = 'good' | 'tight' | 'unknown'

export interface ThreeDChoice {
  id: string
  name: string
  sizeGB: number
  fit: ThreeDFit
  /** One short sentence on this machine and this model. */
  fitLine: string
  recommended: boolean
  /** Needs a Hugging Face token that is not there yet. */
  blocked: boolean
}

/** The memory facts the rule reads. 0 means unknown. */
export interface ThreeDMachine {
  vramGb: number
  ramGb: number
}

export const TRELLIS_MIN_VRAM_GB = 12
const SF3D_RECOMMENDED_RAM_GB = 24

const gb = (n: number) => `${Math.round(n)} GB`

export function pcThreeDChoices(machine: ThreeDMachine, model: { id: string; name: string; sizeGB: number }): ThreeDChoice[] {
  // A card sold as 12 GB reports a little less.
  const fits = machine.vramGb >= TRELLIS_MIN_VRAM_GB - 0.5
  const known = machine.vramGb > 0
  return [{
    ...model,
    fit: !known ? 'unknown' : fits ? 'good' : 'tight',
    fitLine: !known
      ? `Needs ${TRELLIS_MIN_VRAM_GB} GB of graphics memory. LU could not read this card.`
      : fits
        ? `Fits your ${gb(machine.vramGb)} graphics card.`
        : `Your card has ${gb(machine.vramGb)}, this model wants ${TRELLIS_MIN_VRAM_GB} GB. It will be very slow or stop.`,
    recommended: true,
    blocked: false,
  }]
}

export interface MacThreeDModelFacts {
  id: string
  name: string
  sizeGB: number
  minRamGB: number
  gated?: boolean
  hasToken?: boolean
}

export function macThreeDChoices(machine: ThreeDMachine, models: readonly MacThreeDModelFacts[]): ThreeDChoice[] {
  const canSf3d = models.some((m) => m.gated && m.hasToken) && machine.ramGb >= SF3D_RECOMMENDED_RAM_GB
  const best = canSf3d ? models.find((m) => m.gated) : models.find((m) => !m.gated)
  return models.map((m) => {
    const known = machine.ramGb > 0
    const fits = machine.ramGb >= m.minRamGB - 0.5
    return {
      id: m.id,
      name: m.name,
      sizeGB: m.sizeGB,
      fit: !known ? 'unknown' : fits ? 'good' : 'tight',
      fitLine: !known
        ? `Needs ${m.minRamGB} GB of memory.`
        : fits
          ? `Fits your ${gb(machine.ramGb)} of memory.`
          : `Your Mac has ${gb(machine.ramGb)}, this model wants ${m.minRamGB} GB.`,
      recommended: m.id === best?.id,
      blocked: !!m.gated && !m.hasToken,
    }
  })
}

/** The choice to start on: the one the user already picked when it can be
 *  installed, else the recommended one. */
export function startingChoice(choices: readonly ThreeDChoice[], picked?: string | null): string | null {
  const own = choices.find((c) => c.id === picked && !c.blocked)
  return (own ?? choices.find((c) => c.recommended) ?? choices[0])?.id ?? null
}

/**
 * How far the setup card moves to stand over the prompt window. The gallery
 * rail takes room at the right of the Stage only, so the Stage's own middle is
 * left of the prompt's (39 px at 1400 wide). Never so far that the card leaves
 * the Stage on a narrow window.
 */
export function axisShift(stageMid: number, promptMid: number, stageWidth: number, cardWidth: number): number {
  const room = Math.max(0, (stageWidth - cardWidth) / 2)
  return Math.round(Math.min(room, Math.max(-room, promptMid - stageMid)))
}
