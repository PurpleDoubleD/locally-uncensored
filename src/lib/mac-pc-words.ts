// Sentences that were written from a Windows PC and still stood on the Mac
// (persona walk of the Mac app, 09.10.2026, Fund 24).
//
// A Mac has no Run dialog and no "windows with administrator rights", no
// graphics card of its own to offload layers to, and "no GPU needed" asks
// for something its owner never had to think about. Each function takes
// `mac` and returns the old sentence, letter for letter, where it is false:
// Windows and Linux read what they always did.

/**
 * What computer control never touches. The Mac list names what the blocklist
 * holds for macOS (`commands/computer/desk/blocklist.rs`): Terminal, the
 * password managers, SecurityAgent and loginwindow, Spotlight with Raycast
 * and Alfred, and System Settings.
 */
export function computerOffLimitsLine(mac: boolean): string {
  return mac
    ? 'Always off limits, and not a setting: LU itself, terminals and shells, password managers, sign-in and permission dialogs, Spotlight and other launchers, and System Settings.'
    : 'Always off limits, and not a setting: LU itself, terminals and shells, password managers, sign-in and permission dialogs, the Run dialog and system launchers, security settings and windows with administrator rights.'
}

/** The row label of the layer offload in the expert settings of the LU Engine. */
export function gpuLayersLabel(mac: boolean): string {
  return mac ? 'Graphics layers' : 'GPU layers'
}

/** Its tooltip. On a PC "-1" is auto, not "all" (GH #156): the start puts as
 *  many layers on the card as fit, and a user who read "every layer" took the
 *  slower result for a bug. The Mac sentences are left as they were. */
export function gpuLayersTitle(mac: boolean): string {
  return mac
    ? '-1 = run every layer on the graphics unit of this Mac (default). 0 = processor only. N = run the first N layers there. Use it when the model and its context do not fit in memory.'
    : '-1 = as many layers on the GPU as fit (default). 0 = CPU only. N = offload the first N layers, for when the model and its KV cache do not fit your VRAM.'
}

/** The line under the field. */
export function gpuLayersHint(mac: boolean): string {
  return mac
    ? '-1 = all layers on the graphics unit · 0 = processor only · N = part of them, for models bigger than your memory.'
    : '-1 = as many layers on GPU as fit · 0 = CPU only · N = partial offload for models bigger than your VRAM.'
}

/** The headline of the Cloud panel. */
export function cloudGateHeadline(mac: boolean): string {
  return mac ? 'Run uncensored models in the cloud, no powerful Mac needed.' : 'Run uncensored models in the cloud, no GPU needed.'
}

/**
 * The standing line of the running engine ("GPU layers: 18"), in the words of
 * the row above it. Null stays null.
 */
export function engineOffloadWords(line: string | null, mac: boolean): string | null {
  if (!line || !mac) return line
  return line.replace(/^GPU layers/, gpuLayersLabel(true)).replace(/\bthe GPU\b/g, 'the graphics unit')
}
