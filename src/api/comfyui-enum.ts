import { log } from '../lib/logger'

/**
 * One reader for every ComfyUI dropdown (a COMBO input), because ComfyUI
 * serves that dropdown in more than one shape and every place that guessed
 * one shape broke on the other.
 *
 * Counter-check on the real Windows box, 2026-08-29, ComfyUI answering on
 * 127.0.0.1:8188. The stock loaders still use the legacy shape, the option
 * list sitting in slot 0:
 *
 *   CheckpointLoaderSimple
 *     "ckpt_name": [["Realistic_Vision_V6.0_NV_B1_fp16.safetensors", ...],
 *                   {"tooltip": "..."}]
 *
 * The AnimateDiff-Evolved node, from custom_nodes, answers in the newer
 * schema, where slot 0 is the literal type name and the options moved into
 * the config object:
 *
 *   ADE_LoadAnimateDiffModel
 *     "model_name": ["COMBO", {"multiselect": false,
 *                              "options": ["animatediff_lightning_4step_comfyui.safetensors",
 *                                          "v3_sd15_mm.ckpt"]}]
 *
 * Reading slot 0 there yields the string "COMBO". Everything downstream that
 * treated it as the list of files then either threw ("(intermediate value).map
 * is not a function", which took the whole video discovery down with it, GH
 * #113 round 3) or quietly carried the word COMBO around as if it were a
 * filename.
 *
 * Which shape a node uses is the node author's choice, not ours, and both
 * shapes are live in the same ComfyUI at the same time. So no caller reads a
 * spec by hand any more.
 */

function stringsOf(list: unknown[]): string[] {
  return list.filter((v): v is string => typeof v === 'string')
}

/**
 * The options of one input spec, or `null` when the spec is not a dropdown we
 * can read (a number widget, a connection input, a shape nobody has seen yet).
 *
 * `null` and `[]` are deliberately different answers: `[]` means the dropdown
 * exists and is empty (no files installed), `null` means we could not read it
 * and the caller should say so in the log instead of pretending it was empty.
 */
export function readComboOptions(spec: unknown): string[] | null {
  if (Array.isArray(spec)) {
    const head = spec[0]
    // Legacy shape: the options themselves sit in slot 0.
    if (Array.isArray(head)) return stringsOf(head)
    if (typeof head === 'string') {
      // Newer schema: slot 0 is the type name, options live in the config.
      const cfg = spec[1] as { options?: unknown } | undefined
      if (Array.isArray(cfg?.options)) return stringsOf(cfg.options)
      // A declared COMBO without an options array is an empty dropdown, not a
      // shape we failed to read. Any other type name (INT, STRING, IMAGE, ...)
      // is not a dropdown at all.
      return head.toUpperCase() === 'COMBO' ? [] : null
    }
    return null
  }
  if (spec && typeof spec === 'object' && Array.isArray((spec as { options?: unknown }).options)) {
    return stringsOf((spec as { options: unknown[] }).options)
  }
  return null
}

/** What a spec looks like, for the log line. Never the values themselves: a
 *  model list can be long and a filename is user data. */
export function describeComboShape(spec: unknown): string {
  if (spec === undefined) return 'missing'
  if (spec === null) return 'null'
  if (Array.isArray(spec)) {
    const head = spec[0]
    if (Array.isArray(head)) return `array[array(${head.length}), ...${spec.length - 1}]`
    return `array[${typeof head === 'string' ? `"${head}"` : typeof head}, ...${spec.length - 1}]`
  }
  return typeof spec
}

/**
 * The options of one input of one node in an /object_info answer, tolerant of
 * everything that answer can be: a missing node (ComfyUI replies `{}` with
 * HTTP 200 for a class it does not know), a missing field, a shape we cannot
 * read, or an answer that is not an object at all.
 *
 * Never throws, never returns anything but an array of strings. An unreadable
 * spec costs one log line and that one list, never the discovery around it.
 */
export function nodeComboOptions(data: unknown, node: string, field: string): string[] {
  if (!data || typeof data !== 'object') return []
  const meta = (data as Record<string, unknown>)[node] as
    | { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
    | undefined
  if (!meta || typeof meta !== 'object') return []
  const spec = meta.input?.required?.[field] ?? meta.input?.optional?.[field]
  if (spec === undefined) return []
  const options = readComboOptions(spec)
  if (options === null) {
    log.warn('comfyui.combo_unreadable', { node, field, shape: describeComboShape(spec) })
    return []
  }
  return options
}
