// Built-in tool definitions + executors — replaces hardcoded AGENT_TOOL_DEFS

import type { JSONSchemaProp, MCPToolDefinition } from './types'
import type { ToolRegistry } from './tool-registry'
import { backendCall, fetchExternal } from '../backend'
import { getActiveChatId, getActiveConversationId, getActiveWorkspace, isChatArtifactMode, captureChatArtifact, isReadOnlyShellTurn } from '../agent-context'
import type { AgentRunContext } from '../agent-context'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import { WorkflowEngine } from '../../lib/workflow-engine'
import type { StepResult } from '../../types/agent-workflows'
import { DELEGATE_TASK_TOOL_DEF, buildDelegateExecutor } from '../agents/sub-agent'
import { applyUniqueEdit } from '../../lib/surgical-edit'
import { sliceFileReadResult } from '../../lib/file-read-window'
import { writeTodos, summarizeTodos } from '../../stores/todoStore'
import { isMlxImageHost, generateMlxImageDataUrl, listMlxImageModels, type MlxImageModel } from '../mlx-image'
import { getVideoStatus, listVideoModels, generateVideo as generateMlxVideo, getVideoProgress, cancelVideo, type VideoModel } from '../mlx-video'
import { pathToFileUrl } from '../../lib/local-media-url'
import { RETIRED_MUTATING_NAMES } from '../../lib/retired-tools'

/**
 * Helper: current chat id (+ folder workspace) as a fragment to spread into
 * backendCall payloads. Returns `{}` when no agent loop is active — the Rust
 * side then falls back to `agent-workspace/default/` as the jail root. NOTE:
 * absolute paths are NOT used as-is — the backend jails every path (relative OR
 * absolute) to the resolved workspace root and rejects anything outside it, so
 * a caller that needs an absolute project path to resolve MUST pass the real
 * `workingDirectory` here (it becomes the root).
 */
function chatCtx(run?: AgentRunContext): { chatId?: string; workingDirectory?: string } {
  const id = getActiveChatId(run)
  if (!id) return {}
  // If the agent loop picked a real folder, thread it through so the
  // bridge resolves relative paths against that folder instead of the
  // per-chat sandbox. The workspace pointer is set on loop start by
  // useAgentChat / useCodex (see agent-context.setActiveWorkspace).
  const ws = getActiveWorkspace(run)
  if (ws?.kind === 'folder' && ws.path) {
    return { chatId: id, workingDirectory: ws.path }
  }
  return { chatId: id }
}

// ── Tool Definitions ────────────────────────────────────────────

/**
 * The `settings` sub-schema image_generate and video_generate share (A6).
 *
 * The two carried byte-identical copies of eight properties plus the same
 * paragraph of prose about limits, and every creative turn paid for both. Two
 * copies also drift: video's sampler and width already explained themselves
 * differently from image's for no reason a model can use. One definition, one
 * wording, each tool adding only what is genuinely its own.
 */
const MEDIA_SETTINGS_HINT =
  'Optional fine-tuning. Set ONLY what the user asked for, omit the rest. '
  + 'A value beyond the installed model\'s real limit is rejected with the actual limit. '
  + 'A flat top-level argument wins over the same key here.'

const SHARED_MEDIA_SETTINGS: Record<string, JSONSchemaProp> = {
  steps: { type: 'number', description: 'Sampling steps.' },
  cfg: { type: 'number', description: 'CFG / guidance scale.' },
  sampler: { type: 'string', description: 'Sampler name, must be one this model supports.' },
  scheduler: { type: 'string', description: 'Scheduler name, must be one this model supports.' },
  seed: { type: 'number', description: 'Seed; omit or -1 for random.' },
  width: { type: 'number', description: 'Output width in px.' },
  height: { type: 'number', description: 'Output height in px.' },
  negativePrompt: { type: 'string', description: 'Things to avoid.' },
}

/** The shared eight plus the keys only one of the two pipelines understands. */
function mediaSettingsSchema(own: Record<string, JSONSchemaProp>): JSONSchemaProp {
  return {
    type: 'object',
    description: MEDIA_SETTINGS_HINT,
    additionalProperties: true,
    properties: { ...SHARED_MEDIA_SETTINGS, ...own },
  }
}

// tool-classification.test.ts reads the names out of this array to assert that
// every one of them is classified as mutating or read-only. It parses the file
// rather than importing it, because importing pulls in the tool-registry cycle.
const BUILTIN_TOOLS: MCPToolDefinition[] = [
  // Planning
  {
    name: 'todo_write',
    description:
      'Write and update the plan for a multi-step task. The list is shown to the user live, so it is how they follow a long run. '
      + 'USE FIRST when a task needs more than about three tool calls, then send it again after each step. '
      + 'Send the COMPLETE list every time: it replaces the previous one, it does not merge.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete plan, in order. Replaces the previous list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What this step does, one short line' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'pending = not started, in_progress = working on it now, completed = done and verified',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    category: 'system',
    source: 'builtin',
  },
  // Web
  {
    name: 'web_search',
    description:
      'Search the web via the configured provider (Brave, Tavily, or auto). Returns a ranked list of {title, url, snippet}. '
      + 'Snippets are teasers, not answers: PREFER web_fetch on the promising URLs for the real content. '
      + 'DO NOT run more than 3 similar queries per turn, refine instead of re-searching.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query string' },
        maxResults: { type: 'number', description: 'Maximum results to return (default: 5, max: 20)' },
      },
      required: ['query'],
    },
    category: 'web',
    source: 'builtin',
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a single URL and return its readable text (up to ~24 000 chars), scripts, styles and page furniture stripped. '
      + 'PREFER this over web_search when you already know the target URL. '
      + 'NEVER call it with localhost, a private IP or file://, those are refused. '
      + 'On an empty or 4xx response try a different URL, not the same one again.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL including protocol (http:// or https://)' },
        maxLength: { type: 'number', description: 'Max chars to return (default: 24000)' },
      },
      required: ['url'],
    },
    category: 'web',
    source: 'builtin',
  },

  // Filesystem
  {
    name: 'file_read',
    description:
      'Read a file. PREFER absolute paths; relative paths resolve against the agent workspace. '
      + 'Omitting offset/limit returns the whole file. For LARGE files pass offset (1-based start line) and limit '
      + '(number of lines): the response names the window, the total line count and the offset of the next page. '
      + 'A very long whole-file read gets its middle truncated, so page large files. '
      + 'DO NOT re-read a file you just wrote, the write response already confirmed it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute preferred)' },
        offset: { type: 'number', description: '1-based line to start reading from (optional)' },
        limit: { type: 'number', description: 'Maximum number of lines to return (optional)' },
      },
      required: ['path'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_write',
    description:
      'Write a WHOLE file: use it to CREATE a new file or fully replace one, and PREFER file_edit to change part of an existing one. '
      + 'Creates parent directories if missing. OVERWRITES existing content, there is no append mode. '
      + 'PREFER absolute paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute preferred)' },
        content: { type: 'string', description: 'The complete new content of the file' },
      },
      required: ['path', 'content'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_edit',
    description:
      'Make a SURGICAL edit to an existing file: replace old_string with new_string. PREFER it over file_write for any change to a file that exists. '
      + 'old_string must match EXACTLY ONCE: copy the exact text including indentation from a prior file_read and take enough surrounding lines to be unique. '
      + 'It FAILS with no change when old_string is missing or matches twice; then read the file and retry with more context.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the existing file (absolute preferred)' },
        old_string: { type: 'string', description: 'Exact text to find — must occur exactly once in the file' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_list',
    description:
      'List directory contents. Returns name, isDir, size and full path per entry. '
      + 'Supports recursive=true and a glob pattern ("*.ts", "**/*.py"). '
      + 'PREFER a specific pattern over recursing a whole home or drive, that is slow. '
      + 'For content search use file_search.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default: false)' },
        pattern: { type: 'string', description: 'Glob pattern to filter results (e.g. "*.ts", "**/*.py")' },
      },
      required: ['path'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_search',
    description:
      'Grep-style regex content search across files in a directory. Returns matching lines with file and line number. '
      + 'PREFER it over file_read plus a manual scan when hunting a symbol across many files. '
      + 'Default max 50 results, narrow the pattern or path if you flood. '
      + 'Pattern is Rust regex syntax, not PCRE.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search in (recursive by default)' },
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        maxResults: { type: 'number', description: 'Maximum matching files (default: 50)' },
      },
      required: ['path', 'pattern'],
    },
    category: 'filesystem',
    source: 'builtin',
  },

  // Terminal
  {
    name: 'shell_execute',
    description:
      'THE terminal. Run a shell command: PowerShell on Windows, bash on Unix. Returns stdout, stderr, exit code. '
      + 'Everything runs here: git, tests, package managers, gh, python, platform utilities, and opening files, folders or apps. '
      + 'A recognised test run and the common git commands come back as a parsed summary. '
      + 'Feed a script through `stdin` instead of quoting it: set command to `python3 -` or `bash -s` (fresh process each call, no REPL state). '
      + 'For long work set `background: true` to get a task id back at once, then call again with `task: "status"` and `task_id` (or "list" / "kill"). '
      + 'PREFER dedicated tools where available: file_read over `cat`, file_list over `ls`, file_search over `grep`. '
      + '`--no-verify` is refused, and NEVER delete permanently without confirmation. '
      + 'Default timeout 120 s, test runs 300 s.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The full command to execute. Omit only for task actions.' },
        cwd: { type: 'string', description: 'Working directory (optional, absolute preferred)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
        shell: { type: 'string', description: 'Override shell: "powershell" | "cmd" | "bash" (default: auto)' },
        stdin: { type: 'string', description: 'Text piped to the command\'s stdin, e.g. a Python script for `python3 -`.' },
        background: { type: 'boolean', description: 'Run detached; returns a task id immediately instead of waiting.' },
        task: { type: 'string', enum: ['status', 'list', 'kill'], description: 'Background-task action instead of running a command.' },
        task_id: { type: 'string', description: 'Task id for task "status" or "kill".' },
      },
      required: [],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'pr_resume',
    description:
      'Pick up where a GitHub PR left off. Given a PR URL, fetches title, body, head '
      + 'branch, latest comments, and the full diff via the local `gh` CLI in one call, '
      + 'and returns a markdown summary. USE when the user says "continue this PR" / '
      + '"/resume <url>" / "pick up review of #123".',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'PR URL (https://github.com/owner/repo/pull/N).' },
        cwd: { type: 'string', description: 'Working directory (default: chat workspace).' },
      },
      required: ['url'],
    },
    category: 'terminal',
    source: 'builtin',
  },

  // System

  // Desktop
  {
    name: 'screenshot',
    description:
      'Capture the primary display as a base64 PNG. Zero arguments. '
      + 'USE for visual verification when the user asks "what\'s on my screen" or "look at X". '
      + 'Returns a short summary string (size + filename); the actual image is forwarded to the model via message content. '
      + 'NEVER call in a tight loop — screenshots are expensive and privacy-sensitive.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'desktop',
    source: 'builtin',
  },
  // Opening a folder, a file or an application is deliberately NOT a tool. It
  // is `open` / `Invoke-Item` / `xdg-open`, so a dedicated tool would only wrap
  // a shell command, which is the anti-pattern Anthropic names in "Writing
  // effective tools for AI agents", and which no comparable agent ships. The
  // two tools that used to live here cost ~478 tokens of every system prompt on
  // a registry that already overflows a 4k-context local model, and bought no
  // safety, since shell_execute is behind the same confirmation gate. What the
  // model actually lacked was knowing which OS it is on: see platformPromptLine
  // in lib/host-platform.ts. Removed 2026-08-06.

  // Image
  {
    name: 'image_generate',
    description:
      'Generate an image from a text prompt via the local image pipeline (Apple MLX on macOS; ComfyUI elsewhere, auto-detected). Blocks up to 5 minutes. '
      + 'USE for "draw me", "make an image of", "generate a picture". '
      + 'Pass `inputImage` (a filename from an earlier image_generate result) for image-to-image — restyle / edit an existing image at the given `denoise` strength; omit it for text-to-image. '
      + 'First installed image model is auto-selected (or pass `model`). '
      + 'EXPECT A PAUSE on non-Mac (ComfyUI) single-GPU machines: LU may briefly unload the chat model from VRAM to fit the image model, then reload it after — typically a 30-90s swap. This avoids out-of-memory errors; your conversation is fully preserved across the swap. '
      + 'Rate-limit yourself to 1 call per turn — generations serialize internally so parallel calls will queue, not speed up. '
      + 'Fine-tune through the optional `settings` object; a value beyond the model\'s real limit is REJECTED with the actual limit, never silently changed.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Positive text description of the desired image' },
        negativePrompt: { type: 'string', description: 'Things to avoid (blurry, deformed, etc.)' },
        model: { type: 'string', description: 'Optional image model filename to use. Omit to auto-select the first installed image model.' },
        inputImage: { type: 'string', description: 'Optional. Filename of a previously generated image (from an earlier image_generate result) to use as the base for image-to-image. Omit for text-to-image.' },
        denoise: { type: 'number', description: 'Image-to-image strength 0.05–1.0 (default 0.6). Lower keeps more of the input image, higher follows the prompt more. Only used together with inputImage.' },
        settings: mediaSettingsSchema({
          denoise: { type: 'number', description: 'Image-to-image strength 0.05 to 1.0 (only with inputImage).' },
          lora: { type: ['string', 'array'], items: { type: 'string' }, description: 'LoRA filename, or an ARRAY of filenames to stack several (chained in order). Matched against the installed LoRAs, extension optional; an unknown name is rejected with the installed list.' },
          loraStrength: { type: ['number', 'array'], items: { type: 'number' }, description: 'LoRA strength (~0 to 2). One number applies to every LoRA; an array gives one strength per LoRA in the same order.' },
          vae: { type: 'string', description: 'Override VAE filename.' },
        }),
      },
      required: ['prompt'],
    },
    category: 'image',
    source: 'builtin',
  },
  {
    name: 'video_generate',
    description:
      'Generate a short video clip from a text prompt via the local video pipeline (Apple MLX on macOS; Wan / Hunyuan / AnimateDiff via ComfyUI elsewhere, auto-detected). Local video is slow — this can block up to 60 minutes. '
      + 'USE for "make a video of", "animate", "generate a clip". '
      + 'For a specific length pass `seconds` (e.g. seconds=4 for a 4-second clip) — prefer this over raw frames. Image-to-video (SVD) effectively tops out around 3-4 seconds; text-to-video can run longer. '
      + 'Pass `inputImage` (a filename from an earlier image_generate result) to animate a still image — image-to-video, which auto-selects an installed I2V model such as SVD; omit it for text-to-video. First installed video model is auto-selected (or pass `model`). '
      + 'Write ONE clear prompt and call this ONCE per turn — video generation is slow and ComfyUI queues parallel calls rather than speeding up. '
      + 'EXPECT A PAUSE: LU will briefly unload the chat model from VRAM to fit the (large) video model, then reload it after — typically a 30-90s swap, longer on a cold ComfyUI start. This prevents out-of-memory errors; your conversation is preserved across the swap. '
      + 'Fine-tune through the optional `settings` object; a value beyond the model\'s real limit is REJECTED with the actual limit, never silently changed.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Positive text description of the desired video / motion' },
        negativePrompt: { type: 'string', description: 'Things to avoid (static, blurry, deformed, etc.)' },
        model: { type: 'string', description: 'Optional video model filename to use. Omit to auto-select the first installed video model.' },
        seconds: { type: 'number', description: 'Desired clip length in seconds (e.g. 4). PREFER this over frames for "an N second video". Image-to-video (SVD) effectively maxes near 3-4s; text-to-video can be longer.' },
        frames: { type: 'number', description: 'Advanced: exact frame count (rejected if beyond the model max; e.g. ~81 for Wan, ~25 for SVD). Prefer `seconds`. Omit for the model default.' },
        fps: { type: 'number', description: 'Frames per second of the output clip (e.g. 16). Omit for the model default.' },
        inputImage: { type: 'string', description: 'Optional. Filename of a previously generated image to animate (image-to-video). Requires an installed I2V model such as SVD. Omit for text-to-video.' },
        settings: mediaSettingsSchema({
          seconds: { type: 'number', description: 'Clip length in seconds (preferred length control).' },
          frames: { type: 'number', description: 'Exact frame count, rejected if beyond the model max.' },
          fps: { type: 'number', description: 'Frames per second of the output clip.' },
        }),
      },
      // prompt intentionally NOT required: image-to-video can animate a still
      // without an explicit text prompt, and small models sometimes omit it —
      // LU defaults a gentle-motion prompt rather than rejecting the call.
      required: [],
    },
    category: 'video',
    source: 'builtin',
  },

  // Workflow
  {
    name: 'run_workflow',
    description:
      'Execute a saved agent workflow by name. Runs a nested ReAct with a pre-built step chain. '
      + 'USE for repeatable multi-step tasks: "Research Topic", "Summarize URL", "Code Review", plus any user-created workflows. '
      + 'DO NOT call from inside another workflow tool — depth capped at 5 to prevent recursion fork-bombs. '
      + 'Pass optional input as the starting variable. If the name is unknown, the error lists available names.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the workflow (case-insensitive match)' },
        input: { type: 'string', description: 'Initial input passed as user_input / last_output' },
      },
      required: ['name'],
    },
    category: 'workflow',
    source: 'builtin',
  },

  // Sub-agent delegation (Phase 13 v2.4.0).
  DELEGATE_TASK_TOOL_DEF,

  // Local clock — so the agent never googles "what day is it".
]

// ── Executors ────────────────────────────────────────────────────

async function executeWebSearch(args: Record<string, any>): Promise<string> {
  const { useSettingsStore } = await import('../../stores/settingsStore')
  const searchSettings = useSettingsStore.getState().settings
  const data = await backendCall('web_search', {
    query: args.query,
    count: args.maxResults || 5,
    provider: searchSettings.searchProvider || 'auto',
    braveApiKey: searchSettings.braveApiKey || '',
    tavilyApiKey: searchSettings.tavilyApiKey || '',
  })
  if (Array.isArray(data.results) && data.results.length > 0) {
    const lines = data.results
      .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n')
    // When the configured paid provider failed we still return free-tier
    // results, but say why the configured one didn't answer — a silently
    // swallowed bad API key would look like "search is broken".
    const note = typeof data.providerError === 'string' && data.providerError
      ? `\n\n[Note: configured search provider failed — ${data.providerError}. Results above are from the free fallback (${data.provider || 'fallback'}).]`
      : ''
    return lines + note
  }
  if (typeof data.error === 'string' && data.error) {
    const extra = typeof data.providerError === 'string' && data.providerError ? ` (${data.providerError})` : ''
    return `Web search failed: ${data.error}${extra}`
  }
  return JSON.stringify(data)
}

async function executeWebFetch(args: Record<string, any>): Promise<string> {
  const url = args.url
  if (!url) return 'Error: No URL provided'

  // Preferred path: use the Rust `web_fetch` command which strips HTML
  // aggressively (<script>/<style>/<nav>/<footer> gone, paragraphs kept)
  // and caps at ~24 000 chars. The old path only gave the model the first
  // ~4 000 chars of a half-cleaned body — that's why the agent kept
  // complaining it "only sees the header" of the page.
  try {
    const data = await backendCall<{ url: string; status: number; contentType: string; title: string; text: string; truncated: boolean }>(
      'web_fetch',
      { url }
    )
    const parts: string[] = []
    if (data.title) parts.push(`Title: ${data.title}`)
    parts.push(`URL: ${data.url}`)
    parts.push(`Status: ${data.status}`)
    parts.push('')
    parts.push(data.text || '(empty body)')
    if (data.truncated) parts.push('\n…(truncated to 24 000 chars)')
    return parts.join('\n')
  } catch (e) {
    // Fallback: legacy fetchExternal + htmlToText (used in browser / dev mode
    // where the Rust command isn't reachable).
    try {
      const maxLength = args.maxLength || 24000
      const html = await fetchExternal(url)
      const text = htmlToText(html)
      if (text.length > maxLength) return text.substring(0, maxLength) + '\n\n[...truncated]'
      return text || 'Error: Page returned empty content'
    } catch (fallbackErr) {
      return `Error: web_fetch failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

async function executeFileRead(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const data = await backendCall('fs_read', { path: args.path, ...chatCtx(run) })
  // A binary file comes back as a marker with its size, never as content.
  // Handing the model raw bytes-as-text is a corruption trap: it treats them as
  // content and a later file_write persists that string, mangling the file.
  if (data.encoding === 'binary' || data.encoding === 'base64') {
    const bytes = typeof data.bytes === 'number'
      ? data.bytes
      : Math.floor((String(data.content || '').length * 3) / 4)
    return `[binary file — ${formatBytes(bytes)}, not shown. This tool reads text only; do not write binary content back through file_write.]`
  }
  // Windowed read (audit C1) — see src/lib/file-read-window.ts.
  return sliceFileReadResult(String(data.content || ''), args)
}

/** Last path segment, defaulting to file.txt. */
function artifactBaseName(p: any): string {
  const raw = typeof p === 'string' && p.trim() ? p.trim() : 'file.txt'
  return raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'file.txt'
}

/** MIME from a filename extension — drives the in-chat artifact preview. */
function mimeForName(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain',
    json: 'application/json', js: 'text/javascript', mjs: 'text/javascript',
    ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript',
    py: 'text/x-python', html: 'text/html', htm: 'text/html', css: 'text/css',
    csv: 'text/csv', yml: 'text/yaml', yaml: 'text/yaml', xml: 'application/xml',
    sh: 'text/x-shellscript', sql: 'text/plain', toml: 'text/plain',
    rs: 'text/x-rust', go: 'text/x-go', java: 'text/x-java', c: 'text/x-c', cpp: 'text/x-c++',
  }
  return map[ext] || 'text/plain'
}

async function executeFileWrite(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')
  // Plain-chat artifact mode (ChatGPT-style, David 2026-06-12): in the NORMAL
  // chat, a "file write" must NOT touch disk — capture it so it renders inline
  // with a preview + Download button. The Coding Agent / full Agent leave
  // artifact mode OFF and fall through to the real fs_write below.
  if (isChatArtifactMode(run)) {
    const name = artifactBaseName(args.path)
    captureChatArtifact(name, content, mimeForName(name), run)
    return `Created "${name}" (${formatBytes(content.length)}). It is shown to the user right here in the chat with a preview and a Download button — nothing was written to disk. Do not call file_read on it; just tell the user it's ready.`
  }
  const data = await backendCall('fs_write', { path: args.path, content, ...chatCtx(run) })
  // Rust returns {status: 'saved'|'unchanged', path: <absolute>, bytes}. Surface
  // the real path so the model (and the file-change event) knows WHERE the write
  // landed — especially important when chatId is None and Rust routes a relative
  // path to `agent-workspace/default/`. 'unchanged' means the bytes already
  // matched (EOL/BOM-normalized), so nothing was rewritten — tell the model so
  // it doesn't loop trying to "apply" a change that is already in place.
  if (data.status === 'saved' && data.path) return `File saved: ${data.path}`
  if (data.status === 'unchanged' && data.path) return `File already up to date, no changes written: ${data.path}`
  return JSON.stringify(data)
}

async function executeFileEdit(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  // Plain-chat artifact mode has no files on disk — file_edit makes no sense
  // there. Steer to file_write (which captures a document artifact) instead of
  // silently reaching into the agent sandbox.
  if (isChatArtifactMode(run)) {
    return 'file_edit is not available in plain chat (there are no files on disk here). Use file_write to create or replace a document.'
  }
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return 'Error: file_edit requires a "path".'
  const oldString = typeof args.old_string === 'string' ? args.old_string : ''
  const newString = typeof args.new_string === 'string' ? args.new_string : ''

  // Read the CURRENT content (workspace-aware). file_edit only edits an
  // existing text file — for a new file the model must use file_write.
  let data: any
  try {
    data = await backendCall('fs_read', { path, ...chatCtx(run) })
  } catch (e) {
    return `Error: file_edit could not read ${path}: ${e instanceof Error ? e.message : String(e)}. To create a new file use file_write.`
  }
  if (data.encoding === 'binary' || data.encoding === 'base64') return `Error: file_edit cannot edit a binary file (${path}).`
  const content = typeof data.content === 'string' ? data.content : ''

  const res = applyUniqueEdit(content, oldString, newString)
  if (!res.ok) {
    switch (res.reason) {
      case 'empty_old':
        return 'Error: file_edit requires a non-empty old_string. To create a new file use file_write.'
      case 'noop':
        return 'Error: old_string and new_string are identical, nothing to change.'
      case 'not_found':
        return `Error: old_string was not found in ${path}. Read the file and copy the exact text (including indentation) you want to replace.`
      case 'not_unique':
        return `Error: old_string matches ${res.matches} places in ${path}. Add surrounding lines so it uniquely identifies ONE location, then retry.`
      default:
        return 'Error: file_edit failed.'
    }
  }

  const w = await backendCall('fs_write', { path, content: res.content, ...chatCtx(run) })
  if (w.status === 'saved' && w.path) return `Edited ${w.path} (1 replacement).`
  if (w.status === 'unchanged' && w.path) return `No change written to ${w.path} (content already matched).`
  return JSON.stringify(w)
}

async function executeFileList(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const data = await backendCall('fs_list', {
    path: args.path,
    recursive: args.recursive || false,
    pattern: args.pattern || null,
    // NOTE: the model does NOT get to pick the jail root. `workingDirectory`
    // comes only from chatCtx() (the active, user-chosen workspace). The
    // explorer UI needs to list arbitrary picked folders, so it calls the
    // `fs_list` backend command DIRECTLY (ExplorerPanel.tsx) instead of through
    // this model tool. Security review 2.5.7: passing the model's own
    // `workingDirectory` through here let a prompt-injected model set
    // `workingDirectory: "C:/Users/<user>/.ssh"` and enumerate any directory.
    ...chatCtx(run),
  })
  if (Array.isArray(data.entries)) {
    return data.entries
      .map((e: any) => `${e.isDir ? '[DIR]' : ''} ${e.name} (${formatBytes(e.size)})  ${e.path}`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeFileSearch(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const data = await backendCall('fs_search', {
    path: args.path,
    pattern: args.pattern,
    max_results: args.maxResults || 50,
    ...chatCtx(run),
  })
  if (Array.isArray(data.results)) {
    return data.results
      .map((r: any) => {
        const matches = r.matches?.map((m: any) => `  L${m.line}: ${m.text}`).join('\n') || ''
        return `${r.file}\n${matches}`
      })
      .join('\n\n')
  }
  return JSON.stringify(data)
}

async function executeShellExecute(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  // Background-task actions: the three shell_task_* tools folded in (2.6.6).
  const task = typeof args.task === 'string' ? args.task : ''
  if (task === 'list') return executeShellTaskList()
  if (task === 'status' || task === 'kill') {
    if (task === 'kill' && isReadOnlyShellTurn(run)) {
      return 'Refused: this turn is read-only (/review, Code-Review Mode or Plan mode); killing a task changes state.'
    }
    const id = args.task_id ?? args.id
    if (!id) return `shell_execute: task "${task}" needs a task_id.`
    return task === 'status' ? executeShellTaskStatus({ id }) : executeShellTaskKill({ id })
  }

  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return 'shell_execute: `command` is required (or pass task: "status" | "list" | "kill").'

  const { rejectShellCommand, commandTimeoutMs, commandKind, isReadOnlyCommand } = await import(
    '../../lib/shell-command-classify'
  )
  // Read-only turn (/review …): the classifier is the gate now that the typed
  // read-only inspectors are gone. Conservative on purpose: chained commands
  // are refused outright, a read-only mode that can be talked around is none.
  if (isReadOnlyShellTurn(run) && (args.background || !isReadOnlyCommand(command))) {
    return 'Refused: this turn is read-only (/review, Code-Review Mode or Plan mode). Only inspection commands run here: git status/log/diff/show/blame, ls, cat, pwd. One command, no chaining.'
  }

  if (args.background) return executeShellExecuteBg({ command, cwd: args.cwd })

  // The one refusal that stays hard after the merge: --no-verify on a commit.
  const refusal = rejectShellCommand(command)
  if (refusal) return refusal

  // An explicit timeout wins; otherwise a recognised test run keeps the old
  // run_tests budget (300 s) instead of the shell default.
  const timeout = args.timeout || commandTimeoutMs(command, 120000)
  const data = await backendCall('shell_execute', {
    command,
    args: args.args || null,
    cwd: args.cwd || null,
    timeout,
    shell: args.shell || null,
    stdin: typeof args.stdin === 'string' && args.stdin ? args.stdin : null,
    ...chatCtx(run),
  })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`

  const kind = commandKind(command)
  // Parsed summaries (plan E4 point 4): they used to hang on the typed tool
  // names, small models rely on them, so they hang on the command now.
  if (kind === 'test-run') {
    const { parseForRunner, renderResult } = await import('../agents/test-runner')
    const runner = /vitest/.test(command)
      ? 'vitest'
      : /jest/.test(command)
        ? 'jest'
        : /cargo/.test(command)
          ? 'cargo'
          : /pytest/.test(command)
            ? 'pytest'
            : 'unknown'
    const combined = `${output}\n${err}`.trim()
    const tail = combined.length > 4000 ? `…${combined.slice(-4000)}` : combined
    return `${renderResult(parseForRunner(runner, combined))}\n---\n${tail}`
  }
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  if (kind === 'git-status' && /--porcelain=2/.test(command)) {
    const { parseGitStatus, renderGitStatus } = await import('../agents/git-tools')
    return renderGitStatus(parseGitStatus(output))
  }
  if (kind === 'git-commit') {
    const combined = `${output}\n${err}`.trim()
    const m = combined.match(/\[(\S+)\s+([0-9a-f]{7,40})\]/)
    return m ? `Committed on ${m[1]} as ${m[2]}.\n${combined}` : combined || 'Done.'
  }
  return output || (err ? `stderr: ${err}` : 'Done.')
}

async function executeCodeExecute(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const data = await backendCall('execute_code', { code: args.code, timeout: 30000, ...chatCtx(run) })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  return output || (err ? `stderr: ${err}` : 'Done.')
}

async function runShell(command: string, cwd: string | undefined, timeout = 60000, run?: AgentRunContext) {
  return backendCall('shell_execute', {
    command,
    args: null,
    cwd: cwd || null,
    timeout,
    shell: null,
    ...chatCtx(run),
  })
}

async function executeShellExecuteBg(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { bgStart } = await import('../agents/bg-tasks')
  // Thread the chat context through, or the task starts in LU's own directory
  // instead of the workspace the foreground shell tool uses.
  const { id } = await bgStart({ command: args.command, cwd: args.cwd, ...chatCtx(run) })
  return `Task started: ${id}. Use shell_task_status to poll, shell_task_kill to cancel.`
}

async function executeShellTaskStatus(args: Record<string, any>): Promise<string> {
  const { bgStatus, renderBgStatusOneLine } = await import('../agents/bg-tasks')
  const s = await bgStatus(args.id)
  const head = renderBgStatusOneLine(s)
  const tail = s.output_tail ? `\n---\n${s.output_tail}` : ''
  return `${head}${tail}`
}

async function executeShellTaskKill(args: Record<string, any>): Promise<string> {
  const { bgKill } = await import('../agents/bg-tasks')
  const r = await bgKill(args.id)
  return r.cancelled ? `Cancelled ${args.id}.` : `${args.id}: already finished.`
}

async function executeShellTaskList(): Promise<string> {
  const { bgList, renderBgStatusOneLine } = await import('../agents/bg-tasks')
  const { tasks } = await bgList()
  if (!tasks.length) return '(no background tasks)'
  return tasks.map(renderBgStatusOneLine).join('\n')
}

async function executeGitStatus(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { parseGitStatus, renderGitStatus } = await import('../agents/git-tools')
  const data = await runShell('git status --porcelain=2 --branch', args.cwd, undefined, run)
  if (data.exitCode && data.exitCode !== 0) {
    return `git_status failed: ${data.stderr || data.stdout || `exit ${data.exitCode}`}`
  }
  const parsed = parseGitStatus(data.stdout || '')
  return renderGitStatus(parsed)
}

async function executeGitCommit(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { buildGitCommitCommand } = await import('../agents/git-tools')
  const cmd = buildGitCommitCommand({
    message: args.message,
    files: Array.isArray(args.files) ? args.files : undefined,
    allTracked: !!args.allTracked,
  })
  if (!cmd) return 'git_commit: a non-empty `message` is required.'
  const data = await runShell(cmd, args.cwd, undefined, run)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `git_commit failed (exit ${data.exitCode}):\n${output}`
  }
  const m = output.match(/\[(\S+)\s+([0-9a-f]{7,40})\]/)
  return m ? `Committed on ${m[1]} as ${m[2]}.\n${output}` : output
}

async function executeGitPush(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { shellQuote } = await import('../agents/git-tools')
  const flags: string[] = []
  if (args.setUpstream) flags.push('-u')
  if (args.remote) flags.push(shellQuote(args.remote))
  if (args.branch) flags.push(shellQuote(args.branch))
  const cmd = `git push ${flags.join(' ')}`.trim()
  const data = await runShell(cmd, args.cwd, 120000, run)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `git_push failed (exit ${data.exitCode}):\n${output}`
  }
  return output || 'git push: ok.'
}

async function executeGitLog(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { parseGitLog } = await import('../agents/git-tools')
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 20
  const cmd = `git log --oneline -n ${limit}`
  const data = await runShell(cmd, args.cwd, undefined, run)
  if (data.exitCode && data.exitCode !== 0) {
    return `git_log failed: ${data.stderr || data.stdout || `exit ${data.exitCode}`}`
  }
  const entries = parseGitLog(data.stdout || '')
  if (!entries.length) return '(no commits)'
  return entries.map((e) => `${e.sha} ${e.subject}`).join('\n')
}

async function executeGitDiff(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { shellQuote } = await import('../agents/git-tools')
  const parts = ['git', 'diff']
  if (args.staged) parts.push('--cached')
  if (args.ref) parts.push(shellQuote(String(args.ref)))
  if (args.path) parts.push('--', shellQuote(String(args.path)))
  const data = await runShell(parts.join(' '), args.cwd, 120000, run)
  if (data.exitCode && data.exitCode !== 0 && data.exitCode !== 1) {
    return `git_diff failed: ${data.stderr || `exit ${data.exitCode}`}`
  }
  const out = data.stdout || ''
  if (!out.trim()) return '(no diff)'
  return out.length > 16000 ? `${out.slice(0, 16000)}\n…(truncated)` : out
}

async function executeProjectInit(args: Record<string, any>): Promise<string> {
  const { findRecipe, renderInitPlan, listRecipes } = await import('../agents/project-init')
  const recipeId = typeof args.recipe === 'string' ? args.recipe.trim() : ''
  if (!recipeId) {
    const list = listRecipes()
    return [
      'Available project_init recipes:',
      '',
      ...list.map((r) => `- **${r.id}** — ${r.name}: ${r.summary}`),
      '',
      'Call again with `recipe` set to one of the ids above to get the full plan.',
    ].join('\n')
  }
  const recipe = findRecipe(recipeId)
  if (!recipe) {
    return `project_init: unknown recipe "${recipeId}". Call without args to see the list.`
  }
  return renderInitPlan(recipe)
}

async function executePrResume(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { parsePrUrl, normalisePrJson, renderPrResume } = await import('../agents/pr-resume')
  const { shellQuote } = await import('../agents/git-tools')
  const loc = parsePrUrl(String(args.url ?? ''))
  if (!loc) return 'pr_resume: not a GitHub PR URL (expected https://github.com/owner/repo/pull/N).'
  // Quoted as well as validated. parsePrUrl already rejects anything a shell
  // could act on, but this used to be raw interpolation and the tool is not
  // behind the shell confirm gate, so it does not get to rely on one check.
  const repo = shellQuote(`${loc.owner}/${loc.repo}`)
  const view = await runShell(
    `gh pr view ${loc.number} --repo ${repo} --json title,body,state,headRefName,baseRefName,author,comments`,
    args.cwd,
    60000,
    run,
  )
  if (view.exitCode && view.exitCode !== 0) {
    return `pr_resume: gh pr view failed (exit ${view.exitCode}): ${view.stderr || view.stdout || ''}`
  }
  let raw: any
  try {
    raw = JSON.parse(view.stdout || '{}')
  } catch (e) {
    return `pr_resume: unparseable gh output (${e instanceof Error ? e.message : String(e)})`
  }
  const meta = normalisePrJson(raw, String(args.url))
  const diff = await runShell(
    `gh pr diff ${loc.number} --repo ${repo}`,
    args.cwd,
    60000,
    run,
  )
  return renderPrResume({
    ...meta,
    diff: diff.exitCode === 0 ? diff.stdout || '' : '',
  })
}

async function executeGhPrCreate(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { buildGhPrCreateCommand } = await import('../agents/git-tools')
  const cmd = buildGhPrCreateCommand({
    title: args.title,
    body: args.body ?? '',
    base: args.base,
  })
  if (!cmd) return 'gh_pr_create: a non-empty `title` is required.'
  const data = await runShell(cmd, args.cwd, 60000, run)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `gh_pr_create failed (exit ${data.exitCode}):\n${output}`
  }
  // `gh pr create` prints the URL on stdout.
  const urlMatch = output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)
  return urlMatch ? `Opened PR: ${urlMatch[0]}\n${output}` : output
}

async function executeRunTests(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  const { commandForRunner, detectRunnerFromFiles, parseForRunner, renderResult } =
    await import('../agents/test-runner')

  let runner = args.runner as Runner | undefined
  let command = typeof args.command === 'string' ? args.command : ''

  if (!command) {
    if (!runner) {
      // List the workspace root to find a config marker.
      try {
        const listing = await backendCall('fs_list', {
          path: '.',
          recursive: false,
          ...chatCtx(run),
        })
        // fs_list returns { entries, count } — NOT `items`. Reading the wrong
        // key made `names` always [] → detectRunnerFromFiles([]) = 'unknown' →
        // empty command → "could not detect a test runner" for every project,
        // so the advertised auto-detect never once fired.
        const names: string[] = Array.isArray(listing.entries)
          ? listing.entries.map((it: any) => String(it.name ?? '')).filter(Boolean)
          : []
        runner = detectRunnerFromFiles(names)
      } catch {
        runner = 'unknown'
      }
    }
    command = commandForRunner(runner as Runner)
  }
  if (!command) {
    return 'run_tests: could not detect a test runner. Pass `command` or `runner` explicitly.'
  }

  const shellArgs = {
    command,
    args: null,
    cwd: args.cwd || null,
    timeout: args.timeout || 300000,
    shell: null,
    ...chatCtx(run),
  }
  const data = await backendCall('shell_execute', shellArgs)
  if (data.timedOut) {
    return `Test run timed out after ${shellArgs.timeout / 1000}s. Partial output:\n${(data.stdout || '').slice(-2000)}`
  }
  const combined = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  const parsed = parseForRunner(runner ?? 'unknown', combined)
  return renderResult(parsed)
}
type Runner = 'vitest' | 'cargo' | 'pytest' | 'jest' | 'unknown'

async function executeSystemInfo(): Promise<string> {
  const data = await backendCall('system_info', {})
  return Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n')
}

async function executeProcessList(): Promise<string> {
  const data = await backendCall('process_list', {})
  if (Array.isArray(data.processes)) {
    return data.processes
      .slice(0, 30)
      .map((p: any) => `${p.name} (PID: ${p.pid}) — ${formatBytes(p.memory)} RAM, ${p.cpu?.toFixed(1)}% CPU`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeScreenshot(): Promise<string> {
  const data = await backendCall('screenshot', {})
  if (data.image) {
    return `[Screenshot captured: base64 PNG, ${Math.round(data.image.length / 1024)}KB]`
  }
  return JSON.stringify(data)
}

async function executeImageGenerate(args: Record<string, any>): Promise<string> {
  // Feature EE (v2.5.0): the whole generation flow now goes through the VRAM
  // hand-off orchestrator. It resolves the image model (args.model or first
  // installed), decides whether the resident local text model has to be evicted
  // from VRAM to make room (single-GPU OOM avoidance), runs the ComfyUI
  // workflow exactly as before (buildDynamicWorkflow), then reloads the text
  // model afterwards. The returned string keeps the EXACT F1 contract —
  // `Image generated: <file> (prompt: "...")\n<comfyui /view URL>` — so
  // ToolCallBlock renders it inline and useAgentChat feeds it back unchanged.
  const prompt = args.prompt || args.description || ''
  if (!prompt) return 'Error: No prompt provided for image generation.'
  const settings = (args.settings && typeof args.settings === 'object') ? args.settings : {}
  const flat: Record<string, any> = {}
  for (const [k, v] of Object.entries(args)) if (k !== 'settings' && v !== undefined) flat[k] = v
  const merged: Record<string, any> = { ...settings, ...flat }   // explicit flat args win; undefined never clobbers settings

  // Hard rule: on macOS, local image generation is Apple MLX only — ComfyUI
  // never runs there (see isMlxImageHost() / useCreate.ts's MLX image
  // branch, the reference this mirrors). Route around the ComfyUI-only
  // vram-handoff orchestrator + model-pick gate entirely.
  if (isMlxImageHost()) return executeImageGenerateMlx(prompt, merged)

  // Model-Picker gate (v2.5.3): BEFORE the VRAM swap, let the user pick the
  // ComfyUI model in the tool call (or silently use the saved preference).
  // Returns null when an explicit model arg exists / nothing is installed /
  // ComfyUI is unreachable — the existing pipeline then behaves as before.
  const { pickModelForGeneration } = await import('../model-pick')
  const picked = await pickModelForGeneration('image', merged)
  if (picked) merged.model = picked
  const { vramHandoffGenerate } = await import('../vram-handoff')
  return vramHandoffGenerate('image', merged)
}

async function executeVideoGenerate(args: Record<string, any>): Promise<string> {
  // Feature EE (v2.5.0): text-to-video via the same hand-off orchestrator.
  // Picks the first installed video model (or args.model), detects the video
  // backend (Wan / AnimateDiff), evicts the local text model from VRAM if it
  // won't co-exist, runs buildTxt2VidWorkflow, then reloads the text model.
  // Same inline-render contract as image_generate (the URL may end .webp/.mp4 —
  // ToolCallBlock renders a <video> for those).
  // No prompt guard here: image-to-video can animate a still WITHOUT a text
  // prompt, and small models routinely omit it (gemma4 live). runHandoff
  // defaults a gentle-motion prompt for video, normalizes a snake_case
  // input_image alias, and falls back to the last generated image — so the
  // "animate the image you just made" chain works even with a sloppy call.
  const settings = (args.settings && typeof args.settings === 'object') ? args.settings : {}
  const flat: Record<string, any> = {}
  for (const [k, v] of Object.entries(args)) if (k !== 'settings' && v !== undefined) flat[k] = v
  const merged: Record<string, any> = { ...settings, ...flat }   // explicit flat args win; undefined never clobbers settings

  // Hard rule: on macOS, local video generation is Apple MLX only — ComfyUI
  // never runs there. Route around vram-handoff entirely (no VRAM juggling —
  // there is no local text-model/ComfyUI VRAM contention to manage: MLX runs
  // its own subprocess).
  if (isMlxImageHost()) {
    const prompt = String(args.prompt ?? args.description ?? '').trim() || 'gentle, subtle natural motion'
    return executeVideoGenerateMlx(prompt, merged)
  }

  // Model-Picker gate (v2.5.3) — see executeImageGenerate. T2V and I2V keep
  // separate saved preferences (disjoint capability sets).
  const { pickModelForGeneration } = await import('../model-pick')
  const picked = await pickModelForGeneration('video', merged)
  if (picked) merged.model = picked
  const { vramHandoffGenerate } = await import('../vram-handoff')
  return vramHandoffGenerate('video', merged)
}

// ── macOS MLX generation (hard rule: local image/video on Mac is MLX only,
// never ComfyUI — see api/mlx-image.ts / api/mlx-video.ts module docs) ────

/** Fuzzy-resolve a chat-typed model name against an installed MLX catalog by
 *  id or display name. Same tolerant-matching shape as resolveModelName in
 *  vram-handoff.ts, kept as a separate small helper so this Mac-only path
 *  doesn't pull in the ComfyUI-flavoured module. */
function resolveMlxModel<T extends { id: string; name: string }>(
  requested: string | undefined,
  installed: T[],
): T | null {
  if (installed.length === 0 || !requested) return null
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const r = norm(requested)
  if (!r) return null
  return (
    installed.find((m) => norm(m.id) === r || norm(m.name) === r) ??
    installed.find((m) => norm(m.id).includes(r) || norm(m.name).includes(r)) ??
    installed.find((m) => r.includes(norm(m.id)) || r.includes(norm(m.name))) ??
    null
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * macOS image_generate — hard rule: local image on Mac is MLX only, never
 * ComfyUI (ComfyUI is never even started on this platform). Mirrors the MLX
 * image branch in useCreate.ts (generateMlxImageDataUrl → base64 PNG), then
 * returns the SAME result shape pollAndExtract uses for the ComfyUI path —
 * `${kind} generated: <file> (prompt: "...")\n<url>` — so ToolCallBlock
 * renders it inline; only the url is a local blob: URL instead of a ComfyUI
 * /view URL.
 */
async function executeImageGenerateMlx(prompt: string, merged: Record<string, any>): Promise<string> {
  let installed: MlxImageModel[]
  try {
    installed = (await listMlxImageModels()).filter((m) => m.installed)
  } catch (e) {
    return `Error: Could not query MLX image models — ${e instanceof Error ? e.message : String(e)}.`
  }
  if (installed.length === 0) {
    return 'Error: No local image model is installed yet. The on-device image engine needs a one-time setup before local generation works.'
  }
  const requested = typeof merged.model === 'string' && merged.model ? merged.model : undefined
  let model: MlxImageModel
  if (requested) {
    const resolved = resolveMlxModel(requested, installed)
    if (!resolved) {
      return `Error: No installed MLX image model matches "${requested}". Installed: ${installed.map((m) => m.name).join(', ')}.`
    }
    model = resolved
  } else {
    model = installed.find((m) => m.id === 'sd-turbo') ?? installed[0]
  }

  try {
    const { dataUrl, localPath } = await generateMlxImageDataUrl({
      prompt,
      model: model.id,
      steps: typeof merged.steps === 'number' ? merged.steps : undefined,
      seed: typeof merged.seed === 'number' ? merged.seed : undefined,
      width: typeof merged.width === 'number' ? merged.width : undefined,
      height: typeof merged.height === 'number' ? merged.height : undefined,
      negativePrompt: typeof merged.negativePrompt === 'string' ? merged.negativePrompt : undefined,
    })
    // B3: the result string is PERSISTED with the conversation, so what goes on
    // this line has to outlive the window. The Rust side already wrote the PNG
    // to disk before handing back the bytes, so the path is both stable and
    // free. A blob: URL here used to leak (never revoked) AND die on the next
    // launch, which quietly emptied every generated picture out of the history.
    if (localPath) {
      const filename = localPath.split(/[\\/]/).pop() || `mlx-${Date.now()}.png`
      return `Image generated: ${filename} (prompt: "${prompt}")\n${pathToFileUrl(localPath)}`
    }
    // No path means the disk write failed on the Rust side. The bytes are still
    // in hand, so show them rather than losing the render; a data: URL is
    // self-contained and revokes nothing, it is only bulky.
    const filename = `mlx-${Date.now()}.png`
    return `Image generated: ${filename} (prompt: "${prompt}")\n${dataUrl}`
  } catch (e) {
    return `Image generation failed: ${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * macOS video_generate — hard rule: local video on Mac is MLX only, never
 * ComfyUI. Text-to-video is the primary path. `inputImage` (image-to-video)
 * passes through to mlx-video's `initImage`, which the Rust side validates
 * as an absolute file path on disk — a chat-generated MLX image (data-URL
 * only, never written to disk, per media_cmds.rs) cleanly fails there with
 * "init_image not found: ...", the same honest-rejection shape this codebase
 * uses for every other unsupported value, rather than silently ignoring it.
 */
async function executeVideoGenerateMlx(prompt: string, merged: Record<string, any>): Promise<string> {
  let status: Awaited<ReturnType<typeof getVideoStatus>>
  try {
    status = await getVideoStatus()
  } catch (e) {
    return `Error: Could not query MLX video status — ${e instanceof Error ? e.message : String(e)}.`
  }
  if (!status.available) return 'Error: MLX video is Apple Silicon only.'
  if (!status.mlxInstalled) return 'Error: the local video engine is not set up on this Mac yet (a one-time setup is needed before local video works).'

  let catalog: VideoModel[]
  try {
    catalog = (await listVideoModels()).filter((m) => m.installed)
  } catch (e) {
    return `Error: Could not query MLX video models — ${e instanceof Error ? e.message : String(e)}.`
  }
  if (catalog.length === 0) {
    return 'Error: No local video model is installed yet. The on-device video engine needs a one-time setup before local generation works.'
  }
  const requested = typeof merged.model === 'string' && merged.model ? merged.model : undefined
  let model: VideoModel
  if (requested) {
    const resolved = resolveMlxModel(requested, catalog)
    if (!resolved) {
      return `Error: No installed MLX video model matches "${requested}". Installed: ${catalog.map((m) => m.name).join(', ')}.`
    }
    model = resolved
  } else {
    model = catalog[0]
  }

  const fps = typeof merged.fps === 'number' ? merged.fps : undefined
  let seconds: number | undefined = typeof merged.seconds === 'number' ? merged.seconds : undefined
  if (seconds == null && typeof merged.frames === 'number' && merged.frames > 0) {
    seconds = merged.frames / (fps ?? 24)
  }
  const inputImage = typeof merged.inputImage === 'string' && merged.inputImage ? merged.inputImage : undefined

  let job: Awaited<ReturnType<typeof generateMlxVideo>>
  try {
    job = await generateMlxVideo({
      id: model.id,
      prompt,
      steps: typeof merged.steps === 'number' ? merged.steps : undefined,
      width: typeof merged.width === 'number' ? merged.width : undefined,
      height: typeof merged.height === 'number' ? merged.height : undefined,
      seconds,
      fps,
      seed: typeof merged.seed === 'number' ? merged.seed : undefined,
      initImage: inputImage,
    })
  } catch (e) {
    return `Video generation failed: ${e instanceof Error ? e.message : String(e)}`
  }

  // Local video on Apple Silicon is genuinely slow — a few seconds of footage
  // can take 30-50 min on wan_2. Give it a full hour before giving up, and on
  // timeout actually KILL the mlx-video subprocess (video_cancel → kill_tree),
  // otherwise it keeps churning in the background and pins the machine long
  // after the tool has already reported failure.
  const deadline = Date.now() + 60 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(2000)
    let prog: Awaited<ReturnType<typeof getVideoProgress>>
    try {
      prog = await getVideoProgress()
    } catch (e) {
      return `Video generation failed: ${e instanceof Error ? e.message : String(e)}`
    }
    if (prog.status === 'complete') {
      // Same rule as the image path: the file is already on disk, so the
      // result carries its path and the viewer rebuilds a blob on demand. The
      // old readVideoAsBlobUrl here pulled the whole clip into memory, never
      // released it, and left a dead URL behind after a restart.
      const filename = job.output.split(/[\\/]/).pop() || `mlx-${Date.now()}.mp4`
      return `Video generated: ${filename} (prompt: "${prompt}")\n${pathToFileUrl(job.output)}`
    }
    if (prog.status === 'error') {
      return `Video generation failed: ${prog.error || 'mlx-video failed'}`
    }
  }
  try { await cancelVideo() } catch { /* already finished/gone */ }
  return 'Video generation timed out after 60 minutes; the generation was stopped.'
}

async function executeTodoWrite(args: Record<string, any>, run?: AgentRunContext): Promise<string> {
  // Purely conversation state: no backend call, no permission gate, nothing
  // that can fail on a machine. The one real failure is having no conversation
  // to attach the plan to, which happens when a tool runs outside a loop.
  // The CONVERSATION id, not getActiveChatId(): that one is a filesystem slug
  // derived from id + title, and PlanBar reads the plan out of chatStore by the
  // real id. Keying by the slug wrote the plan where nothing ever looks.
  const convId = getActiveConversationId(run)
  if (!convId) return 'Error: no active conversation to attach a plan to.'

  const todos = writeTodos(convId, args.todos)
  if (todos.length === 0 && Array.isArray(args.todos) && args.todos.length > 0) {
    return 'Error: every item needs a non-empty `content` string. Nothing was written.'
  }
  return summarizeTodos(todos)
}

async function executeGetCurrentTime(_args: Record<string, any>): Promise<string> {
  try {
    const data = await backendCall<{ unix: number; iso_local: string; iso_utc: string; timezone: string; timezone_offset: number }>(
      'get_current_time',
      {},
    )
    return `Local: ${data.iso_local} ${data.timezone}\nUTC:   ${data.iso_utc}\nUnix:  ${data.unix}`
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

let _workflowDepth = 0

async function executeRunWorkflow(args: Record<string, any>): Promise<string> {
  const workflowName = args.name
  if (!workflowName) return 'Error: No workflow name provided'
  if (_workflowDepth >= 5) return 'Error: Maximum workflow nesting depth (5) exceeded'

  const store = useAgentWorkflowStore.getState()
  const workflow = store.workflows.find(w => w.name.toLowerCase() === workflowName.toLowerCase())
  if (!workflow) {
    const available = store.workflows.map(w => w.name).join(', ')
    return `Error: Workflow "${workflowName}" not found. Available: ${available}`
  }

  const results: StepResult[] = []
  let finalOutput = ''
  const callbacks = {
    onStepStart: () => {},
    onStepComplete: (_idx: number, result: StepResult) => { results.push(result) },
    onStepError: () => {},
    onWaitingForInput: () => {},
    onComplete: () => {
      const lastOutput = results.filter(r => r.output).pop()
      finalOutput = lastOutput?.output || 'Workflow completed with no output.'
    },
    onError: (error: string) => { finalOutput = `Workflow error: ${error}` },
  }

  const initialVars = args.input ? { user_input: args.input, last_output: args.input } : {}
  _workflowDepth++
  try {
    const engine = new WorkflowEngine(workflow, 'tool-execution', callbacks, initialVars, _workflowDepth)
    await engine.run()
  } finally {
    _workflowDepth--
  }
  return finalOutput
}

// ── Helpers ─────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function htmlToText(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    doc.querySelectorAll('script, style, nav, header, footer, .nav, .header, .footer, .sidebar, .menu, .ad, .advertisement, [role="navigation"], [role="banner"]').forEach(el => el.remove())
    const main = doc.querySelector('main, article, [role="main"], .content, .article, .post, #content, #main')
    const target = main || doc.body
    if (!target) return ''
    let text = ''
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    let node: Node | null = walker.nextNode()
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim()
        if (t) text += t + ' '
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName.toLowerCase()
        if (['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr'].includes(tag)) text += '\n'
        if (['h1', 'h2', 'h3'].includes(tag)) text += '# '
      }
      node = walker.nextNode()
    }
    return text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim()
  }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ── Registration ────────────────────────────────────────────────

const EXECUTOR_MAP: Record<string, (args: Record<string, any>) => Promise<string>> = {
  todo_write: executeTodoWrite,
  web_search: executeWebSearch,
  web_fetch: executeWebFetch,
  file_read: executeFileRead,
  file_write: executeFileWrite,
  file_edit: executeFileEdit,
  file_list: executeFileList,
  file_search: executeFileSearch,
  shell_execute: executeShellExecute,
  pr_resume: executePrResume,
  screenshot: executeScreenshot,
  image_generate: executeImageGenerate,
  video_generate: executeVideoGenerate,
  run_workflow: executeRunWorkflow,
  delegate_task: buildDelegateExecutor(),
}

export function registerBuiltinTools(registry: ToolRegistry) {
  for (const tool of BUILTIN_TOOLS) {
    const executor = EXECUTOR_MAP[tool.name]
    if (executor) {
      registry.registerBuiltin(tool, executor)
    }
  }
}

// ── Retired tools (2.6.6 merge, plan E5) ────────────────────────
//
// Sixteen typed wrappers left the catalog: their schemas cost ~109 tokens
// each per step while every executor ended in runShell anyway. But a running
// chat, a restored session and every model that saw the old names in its
// context still CALLS them, and "Error: Unknown tool" burns that step. Same
// cure as uselu's RETIRED_MODELS: the old call still runs (through the kept
// executors), and the reply names the new way once.

const RETIRED_HINT: Record<string, string> = {
  git_status: 'shell_execute with command "git status --porcelain=2 --branch"',
  git_log: 'shell_execute with command "git log --oneline -n 20"',
  git_diff: 'shell_execute with command "git diff"',
  git_commit: 'shell_execute with command "git add -A && git commit -m \\"msg\\""',
  git_push: 'shell_execute with command "git push"',
  run_tests: 'shell_execute with the project test command (npm test, npx vitest run, cargo test, pytest)',
  gh_pr_create: 'shell_execute with command "gh pr create --title \\"t\\" --body \\"b\\""',
  project_init: 'shell_execute with the scaffold commands directly',
  code_execute: 'shell_execute with command "python3 -" and the source in stdin',
  system_info: 'the system prompt (OS, shell, time are stated there); for hardware, shell_execute "uname -a" (Windows: Get-ComputerInfo)',
  process_list: 'shell_execute with command "ps aux" (Windows: Get-Process)',
  get_current_time: 'the system prompt, which states date and time at run start',
  shell_execute_background: 'shell_execute with background: true',
  shell_task_status: 'shell_execute with task: "status" and task_id',
  shell_task_kill: 'shell_execute with task: "kill" and task_id',
  shell_task_list: 'shell_execute with task: "list"',
}

const RETIRED_EXECUTORS: Record<string, (args: Record<string, any>, run?: AgentRunContext) => Promise<string>> = {
  git_status: executeGitStatus,
  git_log: executeGitLog,
  git_diff: executeGitDiff,
  git_commit: executeGitCommit,
  git_push: executeGitPush,
  run_tests: executeRunTests,
  gh_pr_create: executeGhPrCreate,
  project_init: executeProjectInit,
  code_execute: executeCodeExecute,
  system_info: executeSystemInfo,
  process_list: executeProcessList,
  get_current_time: executeGetCurrentTime,
  shell_execute_background: executeShellExecuteBg,
  shell_task_status: executeShellTaskStatus,
  shell_task_kill: executeShellTaskKill,
  shell_task_list: executeShellTaskList,
}

// The mutating half moved to lib/retired-tools.ts with A9: the registry's
// permission lookup needs the same split, and a second copy of a set that
// decides "may this run unattended" is exactly the copy that drifts.

/**
 * Names that still resolve through the redirect. The canonical list lives in
 * lib/retired-tools.ts (tool-registry needs it without importing this module);
 * re-exported here for the executors' callers. A test pins both to
 * RETIRED_EXECUTORS' keys.
 */
export { RETIRED_TOOL_NAMES, RETIRED_MUTATING_NAMES } from '../../lib/retired-tools'

export const RETIRED_EXECUTOR_NAMES: ReadonlySet<string> = new Set(Object.keys(RETIRED_EXECUTORS))

/**
 * Run a retired tool under its old name, or return null when the name was
 * never ours. The appended note is one line so the model learns the new way
 * without the step being wasted.
 */
export async function runRetiredTool(
  name: string,
  args: Record<string, any>,
  run?: AgentRunContext,
): Promise<string | null> {
  const exec = RETIRED_EXECUTORS[name]
  if (!exec) return null
  // The read-only gate lives on shell_execute's command classifier; a retired
  // mutating name would walk straight past it via this redirect.
  if (isReadOnlyShellTurn(run) && RETIRED_MUTATING_NAMES.has(name)) {
    return `Refused: this turn is read-only (/review, Code-Review Mode or Plan mode); ${name} changes state.`
  }
  const result = await exec(args, run)
  const hint = RETIRED_HINT[name]
  return hint ? `${result}\n\n(Note: ${name} is retired, next time use ${hint}.)` : result
}
