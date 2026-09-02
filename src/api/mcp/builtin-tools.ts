// Built-in tool definitions + executors — replaces hardcoded AGENT_TOOL_DEFS

import type { JSONSchemaProp, MCPToolDefinition, ToolArgs } from './types'
import type {
  ShellExecResult, FsReadResult, FsWriteResult, FsListResult, FsSearchResult,
  WebSearchResult, WebFetchResult, ProcessListResult, ScreenshotResult, CurrentTimeResult,
} from '../../types/bridge'
import type { ToolRegistry } from './tool-registry'
import { backendCall, fetchExternal } from '../backend'
import { getActiveChatId, getActiveConversationId, getActiveWorkspace, isChatArtifactMode, captureChatArtifact, isReadOnlyShellTurn } from '../agent-context'
import type { AgentRunContext } from '../agent-context'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import { WorkflowEngine } from '../../lib/workflow-engine'
import type { StepResult } from '../../types/agent-workflows'
import { DELEGATE_TASK_TOOL_DEF, buildDelegateExecutor } from '../agents/sub-agent'
import {
  CHECK_TASKS_TOOL_DEF,
  MESSAGE_AGENT_TOOL_DEF,
  buildCheckTasksExecutor,
  buildMessageAgentExecutor,
} from '../agents/agent-task-tools'
import { applyUniqueEdit } from '../../lib/surgical-edit'
import { sliceFileReadResult } from '../../lib/file-read-window'
import { writeTodos, summarizeTodos } from '../../stores/todoStore'
import { isMlxImageHost, generateMlxImageDataUrl, listMlxImageModels, type MlxImageModel } from '../mlx-image'
import { getVideoStatus, listVideoModels, generateVideo as generateMlxVideo, getVideoProgress, cancelVideo, type VideoModel } from '../mlx-video'
import { pathToFileUrl } from '../../lib/local-media-url'
import { RETIRED_MUTATING_NAMES } from '../../lib/retired-tools'
import { resolveMlxModel, defaultMlxImageModel } from '../../lib/mlx-model-match'
import type { Runner } from '../agents/test-runner'
import type { VramHandoffArgs } from '../vram-handoff'

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

/**
 * Argument readers.
 *
 * A tool's `args` come from the MODEL: the declared `inputSchema` is a hint in
 * a prompt, not a contract anything enforces before the executor runs. So a
 * `path` can arrive as a number and `background` as the string "false". These
 * three are the only sanctioned way into that object — each one checks the
 * type it promises instead of trusting the schema.
 */
function argString(args: ToolArgs, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function argNumber(args: ToolArgs, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** `undefined` rather than '' — for the many payload fields that mean "unset". */
function argOptString(args: ToolArgs, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Die fehlende Pflichtangabe — geprüft DA, WO DIE ANFRAGE ENTSTEHT (KF-18).
 *
 * `inputSchema.required` ist ein Hinweis in einem Prompt, kein Vertrag: zwischen
 * Modell und Executor erzwingt ihn nichts. Ein weggelassenes `path` kommt hier
 * als `undefined` an, fällt bei `JSON.stringify` aus dem Körper — und die Bridge
 * bekommt eine Anfrage, die ihr Ziel nie genannt hat. Das ist nicht theoretisch:
 * ein `file_write` ohne `path` hat live `~/agent-workspace-experiment/default`
 * als 0-Byte-DATEI angelegt, wo eine Arbeitsverzeichnis-WURZEL gemeint war.
 * Dev-Server (KF-12) und gepackter Bau (KF-15) weisen sie inzwischen ab — das
 * sind die zweite und die dritte Ebene. Hier ENTSTEHT sie, also fällt sie hier
 * zuerst auf.
 *
 * Die Form folgt den Prüfungen, die diese Datei schon von Hand schreibt
 * (`shell_execute: \`command\` is required …`, `git_commit: a non-empty
 * \`message\` is required.`): ein ZURÜCKGEGEBENER Text, kein `throw`. Das
 * Werkzeugergebnis ist der einzige Rückkanal zum Modell — eine zurückgegebene
 * Zeile nennt die fehlende Angabe und lässt es sich im nächsten Schritt selbst
 * korrigieren, ein Wurf käme als unlesbarer Absturz an.
 *
 * Gelesen wird über `argString`, also fällt ein `path: 42` genauso durch wie ein
 * fehlendes: die Bridge bekommt nur Zeichenketten, oder gar keine Anfrage.
 */
function missingArgs(tool: string, args: ToolArgs, ...keys: string[]): string | null {
  const missing = keys.filter((key) => !argString(args, key))
  if (missing.length === 0) return null
  const named = missing.map((key) => `\`${key}\``).join(' and ')
  const verb = missing.length > 1 ? 'are' : 'is'
  const them = missing.length > 1 ? 'them' : 'it'
  return `${tool}: ${named} ${verb} required — a non-empty string. `
    + `Nothing was sent to the backend; call ${tool} again with ${them} set.`
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

  // Sub-agent delegation (Phase 13 v2.4.0), plus die beiden Werkzeuge, mit
  // denen ein Hauptagent seine Hintergrundagenten erreicht (2.6.8).
  DELEGATE_TASK_TOOL_DEF,
  CHECK_TASKS_TOOL_DEF,
  MESSAGE_AGENT_TOOL_DEF,

  // Local clock — so the agent never googles "what day is it".
]

// ── Executors ────────────────────────────────────────────────────

async function executeWebSearch(args: ToolArgs): Promise<string> {
  const bad = missingArgs('web_search', args, 'query')
  if (bad) return bad
  const { useSettingsStore } = await import('../../stores/settingsStore')
  const searchSettings = useSettingsStore.getState().settings
  const data = await backendCall<WebSearchResult>('web_search', {
    query: argString(args, 'query'),
    count: args.maxResults || 5,
    provider: searchSettings.searchProvider || 'auto',
    braveApiKey: searchSettings.braveApiKey || '',
    tavilyApiKey: searchSettings.tavilyApiKey || '',
  })
  if (Array.isArray(data.results) && data.results.length > 0) {
    const lines = data.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
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

async function executeWebFetch(args: ToolArgs): Promise<string> {
  const url = argString(args, 'url')
  if (!url) return 'Error: No URL provided'

  // Preferred path: use the Rust `web_fetch` command which strips HTML
  // aggressively (<script>/<style>/<nav>/<footer> gone, paragraphs kept)
  // and caps at ~24 000 chars. The old path only gave the model the first
  // ~4 000 chars of a half-cleaned body — that's why the agent kept
  // complaining it "only sees the header" of the page.
  try {
    const data = await backendCall<WebFetchResult>('web_fetch', { url })
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
      const maxLength = argNumber(args, 'maxLength') || 24000
      const html = await fetchExternal(url)
      const text = htmlToText(html)
      if (text.length > maxLength) return text.substring(0, maxLength) + '\n\n[...truncated]'
      return text || 'Error: Page returned empty content'
    } catch (fallbackErr) {
      // The fallback's OWN reason comes first. `fallbackErr` was caught and
      // then thrown away here, and that was not cosmetic: in browser/dev mode
      // the Rust command is never reachable, so `e` is the same constant
      // "backend unavailable" sentence on every single failure. The only text
      // that says what actually went wrong — DNS, CORS, 404, timeout — lives
      // in `fallbackErr`, and the model got none of it. Thirty lines up,
      // executeWebSearch already writes the rule down: a silently swallowed
      // provider error "would look like search is broken".
      const why = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
      const primary = e instanceof Error ? e.message : String(e)
      return `Error: web_fetch failed: ${why} (the backend path failed first: ${primary})`
    }
  }
}

async function executeFileRead(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const bad = missingArgs('file_read', args, 'path')
  if (bad) return bad
  const data = await backendCall<FsReadResult>('fs_read', { path: argString(args, 'path'), ...chatCtx(run) })
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
function artifactBaseName(p: unknown): string {
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

async function executeFileWrite(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  // VOR der Betriebsart-Weiche, und vor jedem Byte: die Anfrage prüft hier ihre
  // eigenen Argumente. Ohne diese Zeile fiel `path: undefined` bei
  // `JSON.stringify` aus dem Körper, und die Bridge schrieb in die Wurzel
  // (`~/agent-workspace-experiment/default`, 0 Bytes, als Datei) — KF-18. Auch
  // im Artefakt-Modus geprüft: dort erfand `artifactBaseName` sonst still
  // "file.txt" für eine Datei, die das Modell nie benannt hat.
  const bad = missingArgs('file_write', args, 'path')
  if (bad) return bad
  const path = argString(args, 'path')
  // `content` getrennt geprüft, weil '' hier ETWAS ANDERES heißt als bei
  // `path`: eine absichtlich leere Datei ist ein gültiger Auftrag, ein
  // fehlendes Feld nicht. Vorher wurde beides zu '' zusammengezogen — genau die
  // Verwechslung, die aus einem vergessenen Argument eine 0-Byte-Datei machte.
  if (typeof args.content !== 'string') {
    return 'file_write: `content` is required — the COMPLETE new text of the file, as a string. '
      + 'Pass "" only if you really mean an empty file. Nothing was written; call file_write again with it set.'
  }
  const content = args.content
  // Plain-chat artifact mode (ChatGPT-style, David 2026-06-12): in the NORMAL
  // chat, a "file write" must NOT touch disk — capture it so it renders inline
  // with a preview + Download button. The Coding Agent / full Agent leave
  // artifact mode OFF and fall through to the real fs_write below.
  if (isChatArtifactMode(run)) {
    const name = artifactBaseName(path)
    captureChatArtifact(name, content, mimeForName(name), run)
    return `Created "${name}" (${formatBytes(content.length)}). It is shown to the user right here in the chat with a preview and a Download button — nothing was written to disk. Do not call file_read on it; just tell the user it's ready.`
  }
  const data = await backendCall<FsWriteResult>('fs_write', { path, content, ...chatCtx(run) })
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

async function executeFileEdit(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  // Plain-chat artifact mode has no files on disk — file_edit makes no sense
  // there. Steer to file_write (which captures a document artifact) instead of
  // silently reaching into the agent sandbox.
  if (isChatArtifactMode(run)) {
    return 'file_edit is not available in plain chat (there are no files on disk here). Use file_write to create or replace a document.'
  }
  // Alle drei Pflichtangaben VOR dem fs_read: eine unvollständige Anfrage geht
  // gar nicht erst hinaus (KF-18). Der Text zu `old_string` stand schon in der
  // Auswertung von `applyUniqueEdit` weiter unten; neu ist nur der Zeitpunkt.
  const bad = missingArgs('file_edit', args, 'path')
  if (bad) return bad
  const path = argString(args, 'path')
  const oldString = argString(args, 'old_string')
  if (!oldString) return 'Error: file_edit requires a non-empty old_string. To create a new file use file_write.'
  // `new_string` wie `content` bei file_write: '' ist ein gültiger Auftrag
  // (Text löschen), ein fehlendes Feld nicht. `argString` zog beides zu ''
  // zusammen — ein vergessenes Argument löschte damit still den Fundtext.
  if (typeof args.new_string !== 'string') {
    return 'file_edit: `new_string` is required — the replacement text. '
      + 'Pass "" to delete old_string. Nothing was changed; call file_edit again with it set.'
  }
  const newString = args.new_string

  // Read the CURRENT content (workspace-aware). file_edit only edits an
  // existing text file — for a new file the model must use file_write.
  let data: FsReadResult
  try {
    data = await backendCall<FsReadResult>('fs_read', { path, ...chatCtx(run) })
  } catch (e) {
    return `Error: file_edit could not read ${path}: ${e instanceof Error ? e.message : String(e)}. To create a new file use file_write.`
  }
  if (data.encoding === 'binary' || data.encoding === 'base64') return `Error: file_edit cannot edit a binary file (${path}).`
  const content = typeof data.content === 'string' ? data.content : ''

  const res = applyUniqueEdit(content, oldString, newString)
  if (!res.ok) {
    switch (res.reason) {
      // Über DIESEN Pfad nicht mehr erreichbar (`old_string` wird oben geprüft,
      // bevor gelesen wird); der Zweig bleibt, weil `EditFailReason` ein
      // geteilter Typ ist — staged-writes.ts wertet dieselben vier Gründe aus.
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

  const w = await backendCall<FsWriteResult>('fs_write', { path, content: res.content, ...chatCtx(run) })
  if (w.status === 'saved' && w.path) return `Edited ${w.path} (1 replacement).`
  if (w.status === 'unchanged' && w.path) return `No change written to ${w.path} (content already matched).`
  return JSON.stringify(w)
}

async function executeFileList(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const bad = missingArgs('file_list', args, 'path')
  if (bad) return bad
  const data = await backendCall<FsListResult>('fs_list', {
    path: argString(args, 'path'),
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
      .map((e) => `${e.isDir ? '[DIR]' : ''} ${e.name} (${formatBytes(e.size)})  ${e.path}`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeFileSearch(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const bad = missingArgs('file_search', args, 'path', 'pattern')
  if (bad) return bad
  const data = await backendCall<FsSearchResult>('fs_search', {
    path: argString(args, 'path'),
    pattern: argString(args, 'pattern'),
    max_results: args.maxResults || 50,
    ...chatCtx(run),
  })
  if (Array.isArray(data.results)) {
    return data.results
      .map((r) => {
        const matches = r.matches?.map((m) => `  L${m.line}: ${m.text}`).join('\n') || ''
        return `${r.file}\n${matches}`
      })
      .join('\n\n')
  }
  return JSON.stringify(data)
}

async function executeShellExecute(
  args: ToolArgs,
  run?: AgentRunContext,
  signal?: AbortSignal,
): Promise<string> {
  // Stop reaches the terminal tool now (audit M1). What it can guarantee
  // depends on the phase:
  //   - not started yet  → refused here, nothing runs;
  //   - background task  → really killed, via shell_task_kill;
  //   - foreground, already spawned → the bridge has NO cancel for it. Rust
  //     `shell_execute` takes no run id and there is no shell_execute_cancel,
  //     so the child keeps running to its own timeout. The executor stops
  //     WAITING on it (tool-executor raceAbort), which ends the run and the
  //     UI, but the process survives. Closing that hole needs a bridge command
  //     — noted in the audit report, deliberately not faked here.
  const abort = signal ?? run?.abortSignal
  if (abort?.aborted) return 'Cancelled: the user stopped the run before this command started.'
  // Background-task actions: the three shell_task_* tools folded in (2.6.6).
  const task = argString(args, 'task')
  if (task === 'list') return executeShellTaskList()
  if (task === 'status' || task === 'kill') {
    if (task === 'kill' && isReadOnlyShellTurn(run)) {
      return 'Refused: this turn is read-only (/review, Code-Review Mode or Plan mode); killing a task changes state.'
    }
    const id = argString(args, 'task_id', 'id')
    if (!id) return `shell_execute: task "${task}" needs a task_id.`
    return task === 'status' ? executeShellTaskStatus({ id }) : executeShellTaskKill({ id })
  }

  const command = argString(args, 'command').trim()
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

  // The one refusal that stays hard after the merge: --no-verify on a commit.
  // VOR der Hintergrund-Weiche: die Sperre gilt dem KOMMANDO, nicht der
  // Betriebsart. Stand sie darunter, streifte ein Modell sie durch simples
  // Anhaengen von `background: true` ab — eine harte Sperre, die man mit einem
  // Flag abwaehlt, ist keine.
  const refusal = rejectShellCommand(command)
  if (refusal) return refusal

  // `shell` muss mit: das Backend leitet die Argumentform seit ba9557df aus dem
  // Shell-NAMEN ab (shell::shell_argv), das Durchreichen ist also folgenlos
  // richtig. `stdin`, `args` und `timeout` bleiben absichtlich draussen — die
  // kennt StartArgs auf der Rust-Seite gar nicht.
  if (args.background) return executeShellExecuteBg({ command, cwd: args.cwd, shell: args.shell }, run, abort)

  // An explicit timeout wins; otherwise a recognised test run keeps the old
  // run_tests budget (300 s) instead of the shell default.
  const timeout = argNumber(args, 'timeout') || commandTimeoutMs(command, 120000)
  const data = await backendCall<ShellExecResult>('shell_execute', {
    command,
    args: args.args || null,
    cwd: args.cwd || null,
    timeout,
    shell: args.shell || null,
    stdin: argOptString(args, 'stdin') ?? null,
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

async function executeCodeExecute(
  args: ToolArgs,
  run?: AgentRunContext,
  signal?: AbortSignal,
): Promise<string> {
  // Same contract as shell_execute: a stopped run does not START new code.
  if ((signal ?? run?.abortSignal)?.aborted) {
    return 'Cancelled: the user stopped the run before this code ran.'
  }
  // Erreichbar nur noch über runRetiredTool, also OHNE die Prüfungen von
  // executeShellExecute — die eigene braucht es hier trotzdem.
  const bad = missingArgs('code_execute', args, 'code')
  if (bad) return bad
  const data = await backendCall<ShellExecResult>('execute_code', { code: argString(args, 'code'), timeout: 30000, ...chatCtx(run) })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  return output || (err ? `stderr: ${err}` : 'Done.')
}

async function runShell(
  command: string,
  cwd: string | undefined,
  timeout = 60000,
  run?: AgentRunContext,
): Promise<ShellExecResult> {
  return backendCall<ShellExecResult>('shell_execute', {
    command,
    args: null,
    cwd: cwd || null,
    timeout,
    shell: null,
    ...chatCtx(run),
  })
}

async function executeShellExecuteBg(
  args: ToolArgs,
  run?: AgentRunContext,
  signal?: AbortSignal,
): Promise<string> {
  const { bgStart, bgKill } = await import('../agents/bg-tasks')
  const command = argString(args, 'command')
  // Aus demselben Grund wie die `--no-verify`-Sperre darunter doppelt: über den
  // zurückgezogenen Namen kommt der Aufruf an executeShellExecute vorbei, und
  // ohne diese Zeile startete er eine Hintergrundaufgabe mit leerem Kommando.
  const bad = missingArgs('shell_execute', args, 'command')
  if (bad) return bad
  // ZWEITER Eingang derselben Sperre. executeShellExecute prueft schon vor der
  // Hintergrund-Weiche, aber der zurueckgezogene Name `shell_execute_background`
  // laeuft ueber runRetiredTool DIREKT hierher und sieht executeShellExecute nie
  // — dort waere `--no-verify` sonst weiterhin frei. Doppelt geprueft auf dem
  // Hauptpfad, das ist ein Regex und der Preis fuer eine Sperre ohne Hintertuer.
  // Whitespace ist kein Schlupfloch: commandKind() trimmt selbst, ein
  // ungetrimmtes `command` aus dem Redirect wird also genauso erkannt.
  const { rejectShellCommand } = await import('../../lib/shell-command-classify')
  const refusal = rejectShellCommand(command)
  if (refusal) return refusal
  // Thread the chat context through, or the task starts in LU's own directory
  // instead of the workspace the foreground shell tool uses.
  const { id } = await bgStart({
    command,
    cwd: argOptString(args, 'cwd'),
    // Das Schema bewirbt `shell` fuer BEIDE Pfade; der Hintergrundpfad hat es
    // bisher stillschweigend weggeworfen, ein `{shell:"bash", background:true}`
    // lief in der Plattform-Default-Shell. `argOptString` statt des vorderen
    // `args.shell || null`: fuer einen echten String identisch, aber es filtert
    // Nicht-Strings raus, die der Bridge sonst als Deserialisierungsfehler um
    // die Ohren fliegen — und `bgStart` nimmt ohnehin nur `string | undefined`.
    shell: argOptString(args, 'shell'),
    ...chatCtx(run),
  })
  // A detached task outlives the turn that started it BY DESIGN, but it must
  // not outlive the user pressing Stop: nothing polls it after the run ends, so
  // an unattended `npm run build`/deploy script would keep writing to the repo
  // with no owner and no way to reach it from the UI. This is the one shell
  // path the bridge can genuinely cancel, so it does.
  const abort = signal ?? run?.abortSignal
  if (abort) {
    if (abort.aborted) {
      void bgKill(id).catch(() => {})
      return `Task ${id} was started and immediately cancelled — the user stopped the run.`
    }
    abort.addEventListener('abort', () => { void bgKill(id).catch(() => {}) }, { once: true })
  }
  return `Task started: ${id}. Use shell_task_status to poll, shell_task_kill to cancel.`
}

async function executeShellTaskStatus(args: ToolArgs): Promise<string> {
  const id = argString(args, 'id')
  // Wortgleich mit der Prüfung in executeShellExecute: über den
  // zurückgezogenen Namen kommt der Aufruf an jener vorbei.
  if (!id) return 'shell_execute: task "status" needs a task_id.'
  const { bgStatus, renderBgStatusOneLine } = await import('../agents/bg-tasks')
  const s = await bgStatus(id)
  const head = renderBgStatusOneLine(s)
  const tail = s.output_tail ? `\n---\n${s.output_tail}` : ''
  return `${head}${tail}`
}

async function executeShellTaskKill(args: ToolArgs): Promise<string> {
  const id = argString(args, 'id')
  if (!id) return 'shell_execute: task "kill" needs a task_id.'
  const { bgKill } = await import('../agents/bg-tasks')
  const r = await bgKill(id)
  return r.cancelled ? `Cancelled ${id}.` : `${id}: already finished.`
}

async function executeShellTaskList(): Promise<string> {
  const { bgList, renderBgStatusOneLine } = await import('../agents/bg-tasks')
  const { tasks } = await bgList()
  if (!tasks.length) return '(no background tasks)'
  return tasks.map(renderBgStatusOneLine).join('\n')
}

async function executeGitStatus(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { parseGitStatus, renderGitStatus } = await import('../agents/git-tools')
  const data = await runShell('git status --porcelain=2 --branch', argOptString(args, 'cwd'), undefined, run)
  if (data.exitCode && data.exitCode !== 0) {
    return `git_status failed: ${data.stderr || data.stdout || `exit ${data.exitCode}`}`
  }
  const parsed = parseGitStatus(data.stdout || '')
  return renderGitStatus(parsed)
}

async function executeGitCommit(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { buildGitCommitCommand } = await import('../agents/git-tools')
  // `files` is shell-quoted per entry downstream, so a non-string in the list
  // would have been interpolated as "[object Object]" into a `git add`.
  const files = Array.isArray(args.files)
    ? args.files.filter((f): f is string => typeof f === 'string')
    : undefined
  const cmd = buildGitCommitCommand({
    message: argString(args, 'message'),
    files,
    allTracked: !!args.allTracked,
  })
  if (!cmd) return 'git_commit: a non-empty `message` is required.'
  const data = await runShell(cmd, argOptString(args, 'cwd'), undefined, run)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `git_commit failed (exit ${data.exitCode}):\n${output}`
  }
  const m = output.match(/\[(\S+)\s+([0-9a-f]{7,40})\]/)
  return m ? `Committed on ${m[1]} as ${m[2]}.\n${output}` : output
}

async function executeGitPush(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { shellQuote } = await import('../agents/git-tools')
  const flags: string[] = []
  if (args.setUpstream) flags.push('-u')
  const remote = argOptString(args, 'remote')
  if (remote) flags.push(shellQuote(remote))
  const branch = argOptString(args, 'branch')
  if (branch) flags.push(shellQuote(branch))
  const cmd = `git push ${flags.join(' ')}`.trim()
  const data = await runShell(cmd, argOptString(args, 'cwd'), 120000, run)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `git_push failed (exit ${data.exitCode}):\n${output}`
  }
  return output || 'git push: ok.'
}

async function executeGitLog(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { parseGitLog } = await import('../agents/git-tools')
  const rawLimit = argNumber(args, 'limit')
  const limit = rawLimit === undefined ? 20 : Math.max(1, Math.min(200, rawLimit))
  const cmd = `git log --oneline -n ${limit}`
  const data = await runShell(cmd, argOptString(args, 'cwd'), undefined, run)
  if (data.exitCode && data.exitCode !== 0) {
    return `git_log failed: ${data.stderr || data.stdout || `exit ${data.exitCode}`}`
  }
  const entries = parseGitLog(data.stdout || '')
  if (!entries.length) return '(no commits)'
  return entries.map((e) => `${e.sha} ${e.subject}`).join('\n')
}

async function executeGitDiff(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { shellQuote } = await import('../agents/git-tools')
  const parts = ['git', 'diff']
  if (args.staged) parts.push('--cached')
  if (args.ref) parts.push(shellQuote(String(args.ref)))
  if (args.path) parts.push('--', shellQuote(String(args.path)))
  const data = await runShell(parts.join(' '), argOptString(args, 'cwd'), 120000, run)
  if (data.exitCode && data.exitCode !== 0 && data.exitCode !== 1) {
    return `git_diff failed: ${data.stderr || `exit ${data.exitCode}`}`
  }
  const out = data.stdout || ''
  if (!out.trim()) return '(no diff)'
  return out.length > 16000 ? `${out.slice(0, 16000)}\n…(truncated)` : out
}

async function executeProjectInit(args: ToolArgs): Promise<string> {
  const { findRecipe, renderInitPlan, listRecipes } = await import('../agents/project-init')
  const recipeId = argString(args, 'recipe').trim()
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

async function executePrResume(args: ToolArgs, run?: AgentRunContext): Promise<string> {
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
    argOptString(args, 'cwd'),
    60000,
    run,
  )
  if (view.exitCode && view.exitCode !== 0) {
    return `pr_resume: gh pr view failed (exit ${view.exitCode}): ${view.stderr || view.stdout || ''}`
  }
  let raw: unknown
  try {
    raw = JSON.parse(view.stdout || '{}')
  } catch (e) {
    return `pr_resume: unparseable gh output (${e instanceof Error ? e.message : String(e)})`
  }
  const meta = normalisePrJson(raw, String(args.url))
  const diff = await runShell(
    `gh pr diff ${loc.number} --repo ${repo}`,
    argOptString(args, 'cwd'),
    60000,
    run,
  )
  return renderPrResume({
    ...meta,
    diff: diff.exitCode === 0 ? diff.stdout || '' : '',
  })
}

async function executeGhPrCreate(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { buildGhPrCreateCommand } = await import('../agents/git-tools')
  const cmd = buildGhPrCreateCommand({
    title: argString(args, 'title'),
    body: argString(args, 'body'),
    base: argOptString(args, 'base'),
  })
  if (!cmd) return 'gh_pr_create: a non-empty `title` is required.'
  const data = await runShell(cmd, argOptString(args, 'cwd'), 60000, run)
  const output = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  if (data.exitCode && data.exitCode !== 0) {
    return `gh_pr_create failed (exit ${data.exitCode}):\n${output}`
  }
  // `gh pr create` prints the URL on stdout.
  const urlMatch = output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)
  return urlMatch ? `Opened PR: ${urlMatch[0]}\n${output}` : output
}

async function executeRunTests(args: ToolArgs, run?: AgentRunContext): Promise<string> {
  const { commandForRunner, detectRunnerFromFiles, parseForRunner, renderResult } =
    await import('../agents/test-runner')

  let runner = argRunner(args)
  let command = argString(args, 'command')

  if (!command) {
    if (!runner) {
      // List the workspace root to find a config marker.
      try {
        const listing = await backendCall<FsListResult>('fs_list', {
          path: '.',
          recursive: false,
          ...chatCtx(run),
        })
        // fs_list returns { entries, count } — NOT `items`. Reading the wrong
        // key made `names` always [] → detectRunnerFromFiles([]) = 'unknown' →
        // empty command → "could not detect a test runner" for every project,
        // so the advertised auto-detect never once fired.
        const names: string[] = Array.isArray(listing.entries)
          ? listing.entries.map((it) => it.name).filter(Boolean)
          : []
        runner = detectRunnerFromFiles(names)
      } catch {
        runner = 'unknown'
      }
    }
    command = commandForRunner(runner ?? 'unknown')
  }
  if (!command) {
    return 'run_tests: could not detect a test runner. Pass `command` or `runner` explicitly.'
  }

  const shellArgs = {
    command,
    args: null,
    cwd: args.cwd || null,
    timeout: argNumber(args, 'timeout') || 300000,
    shell: null,
    ...chatCtx(run),
  }
  const data = await backendCall<ShellExecResult>('shell_execute', shellArgs)
  if (data.timedOut) {
    return `Test run timed out after ${shellArgs.timeout / 1000}s. Partial output:\n${(data.stdout || '').slice(-2000)}`
  }
  const combined = `${data.stdout || ''}\n${data.stderr || ''}`.trim()
  const parsed = parseForRunner(runner ?? 'unknown', combined)
  return renderResult(parsed)
}
/**
 * `runner` as the model may send it. A value the runner list does not know
 * becomes 'unknown', which `commandForRunner` maps to the empty command — the
 * same refusal an unrecognised string produced before, now without an `as`
 * that let any string through as a Runner.
 */
function argRunner(args: ToolArgs): Runner | undefined {
  const v = args.runner
  if (!v) return undefined // absent: auto-detect from the workspace, as before
  if (typeof v === 'string') {
    switch (v) {
      case 'vitest':
      case 'cargo':
      case 'pytest':
      case 'jest':
      case 'unknown':
        return v
    }
  }
  return 'unknown'
}

async function executeSystemInfo(): Promise<string> {
  const data = await backendCall<Record<string, unknown>>('system_info', {})
  return Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n')
}

async function executeProcessList(): Promise<string> {
  const data = await backendCall<ProcessListResult>('process_list', {})
  if (Array.isArray(data.processes)) {
    return data.processes
      .slice(0, 30)
      .map((p) => `${p.name} (PID: ${p.pid}) — ${formatBytes(p.memory)} RAM, ${p.cpu?.toFixed(1)}% CPU`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeScreenshot(): Promise<string> {
  const data = await backendCall<ScreenshotResult>('screenshot', {})
  if (data.image) {
    return `[Screenshot captured: base64 PNG, ${Math.round(data.image.length / 1024)}KB]`
  }
  return JSON.stringify(data)
}

async function executeImageGenerate(args: ToolArgs): Promise<string> {
  // Feature EE (v2.5.0): the whole generation flow now goes through the VRAM
  // hand-off orchestrator. It resolves the image model (args.model or first
  // installed), decides whether the resident local text model has to be evicted
  // from VRAM to make room (single-GPU OOM avoidance), runs the ComfyUI
  // workflow exactly as before (buildDynamicWorkflow), then reloads the text
  // model afterwards. The returned string keeps the EXACT F1 contract —
  // `Image generated: <file> (prompt: "...")\n<comfyui /view URL>` — so
  // ToolCallBlock renders it inline and useAgentChat feeds it back unchanged.
  const rawPrompt = args.prompt || args.description || ''
  if (!rawPrompt) return 'Error: No prompt provided for image generation.'
  const prompt = String(rawPrompt)
  const merged = mergeMediaArgs(args)

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

async function executeVideoGenerate(args: ToolArgs): Promise<string> {
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
  const merged = mergeMediaArgs(args)

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
async function executeImageGenerateMlx(prompt: string, merged: VramHandoffArgs): Promise<string> {
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
    // Dynamic, like the ComfyUI gate's store reads in api/model-pick.ts: a
    // static import of the create store pulls api/comfyui in at module load
    // and closes an import cycle through the tool registry.
    const { useCreateStore } = await import('../../stores/createStore')
    model = defaultMlxImageModel(installed, useCreateStore.getState().imageModel)!
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
async function executeVideoGenerateMlx(prompt: string, merged: VramHandoffArgs): Promise<string> {
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

async function executeTodoWrite(args: ToolArgs, run?: AgentRunContext): Promise<string> {
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

async function executeGetCurrentTime(_args: ToolArgs): Promise<string> {
  try {
    const data = await backendCall<CurrentTimeResult>('get_current_time', {})
    return `Local: ${data.iso_local} ${data.timezone}\nUTC:   ${data.iso_utc}\nUnix:  ${data.unix}`
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

let _workflowDepth = 0

async function executeRunWorkflow(args: ToolArgs): Promise<string> {
  const workflowName = argString(args, 'name')
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

  // The engine interpolates these variables into prompts as text. The schema
  // says `input` is a string, but the value comes from a model, so a number or
  // object reaching this line has to become text here rather than deeper in.
  const initialVars: Record<string, string> = args.input
    ? { user_input: String(args.input), last_output: String(args.input) }
    : {}
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

/**
 * Fold a media tool's call into the one settings object the generation
 * pipeline takes: the nested `settings` first, then the flat top-level args on
 * top (an explicit flat argument wins; `undefined` never clobbers a setting).
 *
 * The result is a `VramHandoffArgs`, whose named fields the pipeline reads
 * with its own `typeof` guards and whose index signature carries everything
 * else. The keys are copied one by one rather than spread because a spread
 * would have to claim the arbitrary foreign values match the named fields;
 * writing through the index signature claims nothing that isn't true.
 */
function mergeMediaArgs(args: ToolArgs): VramHandoffArgs {
  const rawSettings = args.settings
  const settings: Record<string, unknown> =
    rawSettings && typeof rawSettings === 'object' ? { ...rawSettings } : {}
  const merged: VramHandoffArgs = {}
  for (const [k, v] of Object.entries(settings)) merged[k] = v
  for (const [k, v] of Object.entries(args)) {
    if (k !== 'settings' && v !== undefined) merged[k] = v
  }
  return merged
}

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

const EXECUTOR_MAP: Record<
  string,
  (args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal) => Promise<string>
> = {
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
  check_tasks: buildCheckTasksExecutor(),
  message_agent: buildMessageAgentExecutor(),
}

export function registerBuiltinTools(registry: ToolRegistry) {
  for (const tool of BUILTIN_TOOLS) {
    const executor = EXECUTOR_MAP[tool.name]
    if (executor) {
      registry.registerBuiltin(tool, executor)
    }
  }
  // M7 / Audit W-T2: der Redirect für zurückgezogene Namen wird hier ANGEMELDET,
  // statt dass execute() ihn sich per `await import('./builtin-tools')` zurück-
  // holt. Der alte Rück-Import konnte nie in einen eigenen Chunk splitten
  // (mcp/index.ts lädt dieses Modul ohnehin statisch) und war damit genau das
  // Muster, das M7 anprangert. Die Richtung stimmt jetzt: die konkreten Tools
  // kennen die Registry, nicht umgekehrt.
  registry.setRetiredRunner(runRetiredTool)
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

const RETIRED_EXECUTORS: Record<string, (args: ToolArgs, run?: AgentRunContext) => Promise<string>> = {
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
  args: ToolArgs,
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
