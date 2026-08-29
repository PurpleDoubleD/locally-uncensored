/**
 * Hardware capability probes for UI gating (e.g. the image-tool discovery noti).
 *
 * Sources, both already shipped + registered as Tauri commands:
 *  - `detect_gpus`  → DetectedGpu[] with `memory_mib` (nvidia-smi / rocm-smi /
 *                     lspci / wmic → covers NVIDIA, AMD, Intel). Max across GPUs.
 *  - `system_info`  → `{ totalMemory: <bytes> }` (sysinfo). Total physical RAM.
 *
 * Both fail-soft to 0 (e.g. dev/browser where the command isn't wired, or a
 * machine with no vendor tool) so a probe failure simply means "not capable" —
 * the noti then stays hidden, which is the desired "sonst keine noti" behaviour.
 */

import { backendCall } from "../api/backend";

interface DetectedGpu {
  index: number;
  vendor: string;
  name: string;
  memory_mib: number | null;
  source: string;
}

/**
 * Pure threshold for "is image generation worth surfacing on this machine?".
 * David 2026-06-06: show the image-tool noti only when there is ≥12 GB VRAM
 * OR ≥16 GB system RAM — otherwise no noti.
 */
export function meetsImageGenThreshold(maxVramGb: number, totalRamGb: number): boolean {
  return maxVramGb >= 12 || totalRamGb >= 16;
}

/** Largest single-GPU VRAM in GB across all detected GPUs (0 if none/unknown). */
export async function getMaxVramGb(): Promise<number> {
  try {
    const gpus = await backendCall<DetectedGpu[]>("detect_gpus");
    const mibs = (Array.isArray(gpus) ? gpus : []).map((g) => g.memory_mib ?? 0);
    return mibs.length ? Math.max(...mibs) / 1024 : 0;
  } catch {
    return 0;
  }
}

/** Total physical RAM in GB (0 if unknown). */
export async function getTotalRamGb(): Promise<number> {
  try {
    const info = await backendCall<{ totalMemory?: number }>("system_info");
    const bytes = typeof info?.totalMemory === "number" ? info.totalMemory : 0;
    return bytes / 1_073_741_824;
  } catch {
    return 0;
  }
}

/** True when the machine clears the image-gen hardware bar (VRAM≥12 OR RAM≥16). */
export async function isImageGenCapable(): Promise<boolean> {
  const [vram, ram] = await Promise.all([getMaxVramGb(), getTotalRamGb()]);
  return meetsImageGenThreshold(vram, ram);
}

// ─── Bundle VRAM requirement ────────────────────────────────────────

/** What a media bundle's `vramRequired` string is worth in GB.
 *
 *  The catalogue writes this field for humans: "6-8 GB", "12+ GB",
 *  "16 GB best, offloads on less", and for the small add-ons simply "any".
 *  The old reader took the first number it found and fell back to 99 when it
 *  found none, so "any" meant 99 GB and the two add-ons (a 0.33 GB SDXL VAE
 *  and a 0.17 GB LoRA) were stamped "Too big for your GPU" on a 12 GB card
 *  (counter-check on the Windows box, 2026-08-29). A number the catalogue
 *  never wrote is not a reason to call a 170 MB LoRA too big.
 *
 *  Order of trust: the number in the string, then the bundle's own download
 *  size (weights on disk are the honest floor for weights in VRAM), then 0,
 *  which reads as "nothing here says this will not fit" and only ever drives
 *  a hint, never a gate.
 *
 *  - "6-8 GB"  -> 8   (the upper bound is what it really wants)
 *  - "12+ GB"  -> 14  (a plus means more than the number)
 *  - "8 GB"    -> 8
 *  - "any"     -> the bundle size, e.g. 0.33
 */
export function bundleVramNeedGb(bundle: { vramRequired?: string; totalSizeGB?: number }): number {
  const s = bundle.vramRequired ?? ''
  if (s.includes('+')) {
    const plus = s.match(/(\d+)\+/)
    if (plus) return parseInt(plus[1]) + 2
  }
  const range = s.match(/(\d+)\s*-\s*(\d+)/)
  if (range) return parseInt(range[2])
  const single = s.match(/(\d+)/)
  if (single) return parseInt(single[1])
  return bundle.totalSizeGB ?? 0
}
