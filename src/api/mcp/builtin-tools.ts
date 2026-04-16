// Built-in tool definitions + executors — replaces hardcoded AGENT_TOOL_DEFS

import type { MCPToolDefinition } from './types'
import type { ToolRegistry } from './tool-registry'
import { backendCall, fetchExternal } from '../backend'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import { WorkflowEngine } from '../../lib/workflow-engine'
import type { StepResult } from '../../types/agent-workflows'
import { DELEGATE_TASK_TOOL_DEF, buildDelegateExecutor } from '../agents/sub-agent'

// ── Tool Definitions ────────────────────────────────────────────

const BUILTIN_TOOLS: MCPToolDefinition[] = [
  // Web
  {
    name: 'web_search',
    description:
      'Search the web via the configured provider (Brave, Tavily, or auto). Returns a ranked list of {title, url, snippet}. '
      + 'PREFER web_fetch on promising URLs for full content — snippets are teasers, not answers. '
      + 'DO NOT call more than 3x per turn with similar queries; refine the query instead of re-searching. '
      + 'For current date/time, use get_current_time — do NOT web_search for it.',
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
      'Fetch a single URL and return its readable text (up to ~24 000 chars). '
      + 'Strips <script>, <style>, <nav>, <header>, <footer>, <aside>, <form> — returns main content only. '
      + 'PREFER this over web_search when you already know the target URL. '
      + 'NEVER call with localhost, private IPs (10.*, 192.168.*, 172.16-31.*), or file:// — they are refused. '
      + 'If response is empty or 4xx, try a different URL rather than retrying the same one.',
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
      'Read the complete contents of a file. PREFER absolute paths; relative paths resolve against the agent workspace (~/agent-workspace). '
      + 'The entire file is returned — there is no pagination or range parameter. '
      + 'DO NOT re-read a file you just wrote with file_write; the write response already confirmed the save. '
      + 'For directory listings use file_list; for content search across many files use file_search.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute preferred)' },
      },
      required: ['path'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_write',
    description:
      'Write a file. Creates parent directories if missing. OVERWRITES existing content — there is NO append mode. '
      + 'To preserve existing content and append, use file_read FIRST then file_write with the combined content. '
      + 'PREFER absolute paths. '
      + 'Writes to the same path within one turn are serialized automatically via the sideEffectKey scheduler.',
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
    name: 'file_list',
    description:
      'List directory contents. Returns entries with name, isDir, size, full path. '
      + 'Supports recursive=true for full tree and glob pattern ("*.ts", "**/*.py"). '
      + 'PREFER a specific pattern over recursive listing of large trees — recursing home / C:\\ is slow. '
      + 'For content search (grep), use file_search instead.',
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
      'Grep-style regex content search across files in a directory. Returns matching lines with file + line number. '
      + 'PREFER over file_read + manual scan when hunting for a symbol across many files. '
      + 'Use file_list first if you do not know the layout. '
      + 'Default max 50 results — narrow the pattern or path if you flood. '
      + 'Pattern uses Rust regex syntax, not PCRE.',
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
      'Run a shell command. PowerShell on Windows, bash on Unix. Returns stdout, stderr, exit code. '
      + 'PREFER dedicated tools where available: file_read over `cat`, file_list over `ls`/`dir`, file_search over `grep`, get_current_time over `date`. '
      + 'Use shell_execute for git, npm, cargo, docker, package managers, or platform utilities without a dedicated tool. '
      + 'NEVER use to permanently delete without confirmation (rm -rf, Remove-Item -Recurse, git reset --hard). '
      + 'Default timeout 120 s; set higher only for known long-running builds.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The full command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, absolute preferred)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
        shell: { type: 'string', description: 'Override shell: "powershell" | "cmd" | "bash" (default: auto)' },
      },
      required: ['command'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'code_execute',
    description:
      'Execute Python code in a fresh subprocess. Returns stdout, stderr, exit code. '
      + 'Use for math, data transforms, JSON/CSV parsing, one-off scripts. '
      + 'NOT a REPL — state does not persist between calls; import everything you need each time. '
      + 'For system commands and shell utilities, PREFER shell_execute. '
      + 'Default timeout 30 s.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The Python source to execute (UTF-8)' },
        language: { type: 'string', description: 'Programming language: "python" or "shell"', enum: ['python', 'shell'] },
      },
      required: ['code'],
    },
    category: 'terminal',
    source: 'builtin',
  },

  // System
  {
    name: 'system_info',
    description:
      'Return desktop system info: OS, architecture, hostname, username, total RAM, CPU count. Zero arguments. '
      + 'Call once when output needs to be tailored to the user\'s platform; do not call repeatedly in a loop.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'system',
    source: 'builtin',
  },
  {
    name: 'process_list',
    description:
      'List the top 30 running processes sorted by memory: {name, pid, memory, cpu%}. Zero arguments. '
      + 'Use for task-manager-style queries ("is Chrome running?", "which process is eating RAM?"). '
      + 'There is NO process_kill tool — to kill a process use shell_execute with taskkill (Windows) or kill (Unix).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'system',
    source: 'builtin',
  },

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

  // Image
  {
    name: 'image_generate',
    description:
      'Generate an image from a text prompt via the local ComfyUI pipeline. Blocks up to 5 minutes. '
      + 'USE for "draw me", "make an image of", "generate a picture". '
      + 'NOT for photo editing — this is text-to-image only; no inpainting via this tool. '
      + 'First installed image model is auto-selected. '
      + 'Rate-limit yourself to 1 call per turn — ComfyUI serializes generations internally so parallel calls will queue, not speed up.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Positive text description of the desired image' },
        negativePrompt: { type: 'string', description: 'Things to avoid (blurry, deformed, etc.)' },
      },
      required: ['prompt'],
    },
    category: 'image',
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
  {
    name: 'get_current_time',
    description:
      "Return the user's current local date, time, and timezone. Zero arguments. "
      + "USE FIRST for any 'what day / time / date is it' question — do NOT web_search or shell_execute `date`. "
      + "The Rust backend probes the OS timezone on every call, so this is always authoritative.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    category: 'system',
    source: 'builtin',
  },
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
  if (Array.isArray(data.results)) {
    return data.results
      .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n')
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
      return `Error: web_fetch failed — ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

async function executeFileRead(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_read', { path: args.path })
  return data.content || ''
}

async function executeFileWrite(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_write', { path: args.path, content: args.content })
  return data.status === 'saved' ? `File saved: ${data.path}` : JSON.stringify(data)
}

async function executeFileList(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_list', {
    path: args.path,
    recursive: args.recursive || false,
    pattern: args.pattern || null,
  })
  if (Array.isArray(data.entries)) {
    return data.entries
      .map((e: any) => `${e.isDir ? '[DIR]' : ''} ${e.name} (${formatBytes(e.size)})  ${e.path}`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeFileSearch(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_search', {
    path: args.path,
    pattern: args.pattern,
    max_results: args.maxResults || 50,
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

async function executeShellExecute(args: Record<string, any>): Promise<string> {
  const data = await backendCall('shell_execute', {
    command: args.command,
    args: args.args || null,
    cwd: args.cwd || null,
    timeout: args.timeout || 120000,
    shell: args.shell || null,
  })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  return output || (err ? `stderr: ${err}` : 'Done.')
}

async function executeCodeExecute(args: Record<string, any>): Promise<string> {
  const data = await backendCall('execute_code', { code: args.code, timeout: 30000 })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  return output || (err ? `stderr: ${err}` : 'Done.')
}

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
  const prompt = args.prompt || args.description || ''
  if (!prompt) return 'Error: No prompt provided for image generation.'
  try {
    const { buildDynamicWorkflow } = await import('../dynamic-workflow')
    const { submitWorkflow, getHistory, classifyModel, getImageModels } = await import('../comfyui')
    const models = await getImageModels()
    if (models.length === 0) return 'Error: No image models available in ComfyUI.'
    const model = models[0]
    const workflow = await buildDynamicWorkflow({
      prompt, negativePrompt: '', model: model.name,
      sampler: 'euler', scheduler: 'normal', steps: 20, cfgScale: 7,
      width: 1024, height: 1024, seed: -1, batchSize: 1,
    }, classifyModel(model.name))
    const promptId = await submitWorkflow(workflow)
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const history = await getHistory(promptId)
      if (history?.status?.completed) {
        const outputs = history.outputs ?? {}
        for (const nodeId of Object.keys(outputs)) {
          const files = [...(outputs[nodeId].images ?? []), ...(outputs[nodeId].gifs ?? [])]
          if (files.length > 0) return `Image generated: ${files[0].filename} (prompt: "${prompt}")`
        }
        return 'Generation completed but no output produced.'
      }
      if (history?.status?.status_str === 'error') return `Generation failed: ${history.status.messages?.[0]?.[1]?.message || 'Unknown error'}`
    }
    return 'Generation timed out after 5 minutes.'
  } catch (err) {
    return `Generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
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
  web_search: executeWebSearch,
  web_fetch: executeWebFetch,
  file_read: executeFileRead,
  file_write: executeFileWrite,
  file_list: executeFileList,
  file_search: executeFileSearch,
  shell_execute: executeShellExecute,
  code_execute: executeCodeExecute,
  system_info: executeSystemInfo,
  process_list: executeProcessList,
  screenshot: executeScreenshot,
  image_generate: executeImageGenerate,
  run_workflow: executeRunWorkflow,
  get_current_time: executeGetCurrentTime,
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
