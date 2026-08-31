/**
 * Phase 5 (v2.4.0) — Side-effect key derivation.
 *
 * When a ReAct turn emits multiple tool calls, we want to run them
 * concurrently for speed, BUT two calls that touch the same shared
 * resource must be serialized. The scheduler groups calls by
 * sideEffectKey and runs one group in parallel but within-group in
 * sequence.
 *
 *   - Pure reads (file_read, web_fetch, web_search, file_list,
 *     file_search, screenshot) → no key (fully parallel-safe).
 *
 *   - file_write, file_edit → key is `file_write:<normalized-path>`. Two
 *     mutations of the SAME path serialize; mutations of DIFFERENT paths
 *     remain parallel. The `file_write:` prefix is a shared namespace for
 *     "something rewrites this file", not the tool name: keys are compared as
 *     plain strings across tools (tool-executor groups by the key alone), so
 *     file_write + file_edit on one path land in one serial group — which is
 *     what we want, since an edit's old_string match depends on whatever the
 *     write left behind.
 *
 *     file_edit used to fall through to `default` and therefore ran keyless.
 *     Two edits of the same file in one batch (the normal shape of a refactor
 *     round) then ran concurrently on a read-modify-write: last writer won,
 *     the other edit was lost silently, and BOTH reported success. In Stage
 *     mode the user reviewed a queue that was missing an approved change.
 *
 *   - shell_execute → key 'exec'. We do not know what a shell command
 *     touches, and concurrent repo writes race on `.git/index.lock`, so all
 *     shell calls share a single queue. (Since the 2.6.6 merge the shell IS
 *     git, tests and background starts, so this one case covers them all.)
 *
 *   - image_generate, video_generate, run_workflow → key 'comfyui'. ComfyUI
 *     serializes internally and workflows do heavy I/O; running in parallel
 *     provides no win and competes for the GPU + the VRAM hand-off.
 */

export function deriveSideEffectKey(
  toolName: string,
  args: Record<string, any>
): string | undefined {
  switch (toolName) {
    case 'file_write':
    // Same path → same key as file_write, on purpose (see header).
    case 'file_edit': {
      const path = typeof args?.path === 'string' ? normalizePath(args.path) : ''
      return path ? `file_write:${path}` : 'file_write:unknown'
    }
    case 'shell_execute':
    // Retired names (2.6.6 merge) still execute via the registry redirect,
    // so a model batching git_commit + git_push under the old names must
    // still land on the same queue.
    case 'code_execute':
    case 'shell_execute_background':
    case 'run_tests':
    case 'git_commit':
    case 'git_push':
    // `gh pr create` pushes the branch and writes refs, so it raced the same
    // `.git/index.lock` as git_commit/git_push while it ran keyless.
    case 'gh_pr_create':
      // Everything that shells out shares ONE serial queue. We can't know
      // what a command touches, and two concurrent git writes race on
      // `.git/index.lock` and one fails.
      return 'exec'
    case 'image_generate':
    case 'video_generate':
    case 'run_workflow':
      // All ComfyUI work shares one GPU + one VRAM hand-off. video_generate was
      // missing here, so an image+video in the same turn ran concurrently —
      // both queued on the hand-off and a back-to-back gen could survive Stop.
      return 'comfyui'
    default:
      // file_read, file_list, file_search, web_search, web_fetch, screenshot,
      // pr_resume (read-only `gh pr view`/`diff`).
      //
      // Deliberately keyless although they are classified as mutating:
      //   - todo_write   — synchronous in-memory conversation state, no file.
      //   - project_init — renders a scaffold PLAN as text, runs nothing.
      //   - shell_task_status / _kill / _list — backend task-manager calls,
      //     they spawn no shell. A kill must NOT queue behind the long shell
      //     command it is meant to cancel.
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
