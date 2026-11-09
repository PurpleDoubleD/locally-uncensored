/**
 * Phase 7 (v2.4.0) — Per-tool error-recovery hints.
 *
 * When a tool fails, the raw error string (`Error: ENOENT: no such file`)
 * is often opaque to a small model and triggers redundant retries. A short
 * structured hint appended to the error ("Path not found. Use file_list
 * first to discover existing paths.") yields dramatically better recovery
 * behaviour — the agent reaches for the right follow-up tool instead of
 * retrying the same bad call.
 *
 * Design rules:
 *   - Hints are ≤ ~30 tokens (roughly one sentence) to avoid bloat in the
 *     ReAct history window.
 *   - Match is conservative (RegExp.test on the error string). When no
 *     pattern matches, explainError returns undefined and the caller keeps
 *     the bare error message.
 *   - Hints are plain text, no code fencing, no Markdown headers.
 */

import { OUTSIDE_WORKSPACE } from '../../lib/workspace-refusal'
import { platformText } from '../../lib/platform-text'

type HintRule = { pattern: RegExp; hint: string }

/**
 * The file tools only work inside the chat's working folder (the Sandbox or a
 * picked folder, commands/filesystem.rs). The bare refusal left a small model
 * with "I can't access your files" (Discord 2026-09-28). Worded for
 * both surfaces, the Agent chat and the Code tab, and checked first.
 */
const OUTSIDE_WORKSPACE_HINT: HintRule = {
  pattern: OUTSIDE_WORKSPACE,
  hint: platformText('outsideWorkspaceHint'),
}

/**
 * A NEW file has no reason to live outside the folder. Asked to write
 * C:\Users\Public\Desktop\poem.txt, Mistral asked the user for another path
 * and wrote nothing (3.0.4 box run). The customer wanted the poem.
 */
const OUTSIDE_WORKSPACE_WRITE_HINT: HintRule = {
  pattern: /escapes the allowed workspace/i,
  hint: 'Outside this chat\'s working folder. Write the file inside it instead, same name as a relative path (e.g. poem.txt), and tell the user.',
}

/** Shared across any tool — checked last as a catch-all. */
const GENERIC_HINTS: HintRule[] = [
  { pattern: /ECONNREFUSED|fetch failed|network/i, hint: 'Network unreachable. Check connectivity or retry once.' },
  { pattern: /timed out|ETIMEDOUT/i, hint: 'Call timed out. Narrow the input or try a simpler approach.' },
  { pattern: /aborted/i, hint: 'Call was aborted. Do not retry; the user may have cancelled.' },
]

/** Per-tool hint rules. Order matters: first match wins within a tool. */
const TOOL_HINTS: Record<string, HintRule[]> = {
  file_read: [
    OUTSIDE_WORKSPACE_HINT,
    { pattern: /ENOENT|no such file|not found|does not exist/i, hint: 'Path not found. Use file_list first to discover existing paths.' },
    { pattern: /EACCES|EPERM|permission denied|access is denied/i, hint: 'Permission denied. Try a path inside the chat\'s working folder.' },
    { pattern: /EISDIR|is a directory/i, hint: 'Path is a directory, not a file. Use file_list on it instead.' },
    { pattern: /file too large|large file/i, hint: 'File too large to read whole. Use file_search for targeted grep instead.' },
  ],
  file_write: [
    OUTSIDE_WORKSPACE_WRITE_HINT,
    OUTSIDE_WORKSPACE_HINT,
    { pattern: /EACCES|EPERM|permission denied|access is denied/i, hint: 'Permission denied. Pick a writable directory, e.g. the agent workspace.' },
    { pattern: /ENOSPC|no space left/i, hint: 'Disk full. Cannot write. Surface this to the user and stop.' },
    { pattern: /EROFS|read-only/i, hint: 'Filesystem is read-only. Choose a different path.' },
    { pattern: /ENOTDIR|not a directory/i, hint: 'Parent path exists but is not a directory. Pick a different path.' },
  ],
  file_list: [
    OUTSIDE_WORKSPACE_HINT,
    { pattern: /ENOENT|no such file|not found/i, hint: 'Directory does not exist. Check the parent with file_list.' },
    { pattern: /ENOTDIR|not a directory/i, hint: 'Path is a file, not a directory. Use file_read instead.' },
    { pattern: /EACCES|EPERM|permission denied/i, hint: 'Permission denied to list. Try a path inside the chat\'s working folder.' },
  ],
  file_search: [
    OUTSIDE_WORKSPACE_HINT,
    { pattern: /ENOENT|no such file|not found/i, hint: 'Search root does not exist. Check the path with file_list.' },
    { pattern: /invalid regex|parse error|unmatched/i, hint: 'Regex pattern is invalid. Escape special characters or simplify.' },
    { pattern: /max results|too many matches/i, hint: 'Too many matches. Narrow the pattern or search a subtree.' },
  ],
  file_edit: [
    OUTSIDE_WORKSPACE_HINT,
  ],
  shell_execute: [
    { pattern: /not recognized|command not found|No such file or directory/i, hint: 'Command is not installed or not on PATH. Try a different tool or surface this to the user.' },
    { pattern: /timed out/i, hint: 'Command timed out. Either break into smaller steps or raise the timeout.' },
    { pattern: /exit code ([1-9]|1\d|2\d)/i, hint: 'Command exited non-zero. Read stderr for the root cause before retrying.' },
    { pattern: /permission denied|EACCES/i, hint: 'Permission denied. The command or its target requires elevated privileges.' },
  ],
  web_fetch: [
    { pattern: /refused|private IP|localhost|loopback/i, hint: 'Target URL was refused for safety. Use a public https:// URL only.' },
    { pattern: /404|not found/i, hint: 'Page 404. Search for the canonical URL via web_search first.' },
    { pattern: /403|forbidden/i, hint: 'Site blocked the fetch. Try a different source or use web_search for an excerpt.' },
    { pattern: /5\d\d|server error/i, hint: 'Server error. Do not retry immediately; try a different URL.' },
    { pattern: /empty body|empty content/i, hint: 'Page returned empty body. Try a different URL or a web_search snippet instead.' },
  ],
  web_research: [
    { pattern: /unavailable right now/i, hint: 'Do not search again in this answer. Answer from what you know and say that search was unavailable.' },
    { pattern: /none could be read/i, hint: 'Pages were found but not readable. Try web_search for links, or other words.' },
  ],
  web_search: [
    // 3.0.8: every tier failed. The sentence itself says what to do; the
    // hints below (rate limit, no results) would invite another search.
    { pattern: /unavailable right now/i, hint: 'Do not search again in this answer. Answer from what you know and say that search was unavailable.' },
    { pattern: /api key|unauthorized|401/i, hint: 'Search provider not configured. Tell the user to set Brave/Tavily key in Settings.' },
    { pattern: /rate limit|429/i, hint: 'Rate limited by provider. Wait or use a different tool.' },
    { pattern: /empty|no results/i, hint: 'No results. Broaden the query or switch to web_fetch with a known URL.' },
  ],
  image_generate: [
    { pattern: /no image models|not available|ComfyUI has no/i, hint: 'No image model installed. Surface to the user, they need to install one in Model Manager.' },
    { pattern: /timed out|timeout/i, hint: 'Generation timed out. Try a smaller resolution or simpler prompt.' },
    { pattern: /CUDA|out of memory|OOM/i, hint: 'GPU out of memory. Pick a lighter model or lower resolution.' },
    // Do not name the engine here. This hint goes into the agent's context, and
    // on a Mac the image backend is MLX — telling the model "ComfyUI returned
    // an error" made it advise users to check software their machine has never
    // had. The raw error the hint is appended to already names the real one.
    { pattern: /Generation failed/i, hint: 'The image backend returned an error. Surface the full error to the user; do not retry without changes.' },
  ],
  run_workflow: [
    { pattern: /not found/i, hint: 'Workflow name unknown. The error already lists available names, pick one.' },
    { pattern: /depth|nesting/i, hint: 'Workflow nesting limit reached. Do not call run_workflow from inside another workflow.' },
  ],
  screenshot: [
    { pattern: /permission|denied/i, hint: 'Screen capture denied. Tell the user to grant screen permission.' },
  ],
}

/**
 * Explain a tool failure with a short recovery hint, or return undefined
 * when nothing matched. The hint is appended to the error string by the
 * executor so the ReAct trace reads `<error> — <hint>`.
 */
export function explainError(toolName: string, error: string): string | undefined {
  if (!error) return undefined

  const perTool = TOOL_HINTS[toolName]
  if (perTool) {
    for (const rule of perTool) {
      if (rule.pattern.test(error)) return rule.hint
    }
  }

  for (const rule of GENERIC_HINTS) {
    if (rule.pattern.test(error)) return rule.hint
  }

  return undefined
}

/** Expose the rule table for tests and docs. */
export const __internal = { TOOL_HINTS, GENERIC_HINTS }
