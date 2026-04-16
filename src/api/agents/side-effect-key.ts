/**
 * Phase 5 (v2.4.0) — Side-effect key derivation.
 *
 * When a ReAct turn emits multiple tool calls, we want to run them
 * concurrently for speed, BUT two calls that touch the same shared
 * resource must be serialized. The scheduler groups calls by
 * sideEffectKey and runs one group in parallel but within-group in
 * sequence.
 *
 *   - Pure reads (file_read, web_fetch, web_search, system_info,
 *     process_list, file_list, file_search, get_current_time,
 *     screenshot) → no key (fully parallel-safe).
 *
 *   - file_write → key is `file_write:<normalized-path>`. Two writes to
 *     the SAME path serialize; writes to DIFFERENT paths remain parallel.
 *
 *   - shell_execute, code_execute → key 'exec'. We do not know what a
 *     shell command touches, so batch all exec-class calls onto a single
 *     queue.
 *
 *   - image_generate, run_workflow → key 'comfyui'. ComfyUI serializes
 *     internally and workflows do heavy I/O; running in parallel provides
 *     no win and competes for the GPU.
 */

export function deriveSideEffectKey(
  toolName: string,
  args: Record<string, any>
): string | undefined {
  switch (toolName) {
    case 'file_write': {
      const path = typeof args?.path === 'string' ? normalizePath(args.path) : ''
      return path ? `file_write:${path}` : 'file_write:unknown'
    }
    case 'shell_execute':
    case 'code_execute':
      return 'exec'
    case 'image_generate':
    case 'run_workflow':
      return 'comfyui'
    default:
      // file_read, file_list, file_search, web_search, web_fetch,
      // system_info, process_list, get_current_time, screenshot.
      return undefined
  }
}

function normalizePath(p: string): string {
  // Windows paths case-insensitively; Unix paths case-sensitively. Keep
  // behaviour conservative: lowercase on Windows, preserve on Unix.
  const isWindowsLike = /^[A-Za-z]:[\\\/]/.test(p) || p.startsWith('\\\\')
  let out = p.trim().replace(/\\/g, '/')
  // Collapse trailing slash so "./foo" and "./foo/" collide.
  out = out.replace(/\/+$/, '')
  // Collapse double slashes.
  out = out.replace(/\/{2,}/g, '/')
  return isWindowsLike ? out.toLowerCase() : out
}
