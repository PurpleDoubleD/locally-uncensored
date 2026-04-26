#!/usr/bin/env node
/**
 * Real agent E2E driven through the Remote bridge. Replicates exactly
 * what mobile_landing()'s runToolLoop does:
 *   1. Auth via /remote-api/auth (passcode → JWT).
 *   2. Build messages: system + user.
 *   3. POST to /api/chat (proxied to Ollama) with native `tools` array.
 *   4. Ollama returns tool_calls; we execute each via /remote-api/agent-tool.
 *   5. Push observations back as tool messages, loop until done.
 *
 * Two modes:
 *   --mode agent  → AGENT_PROMPT (autonomous file-writer)
 *   --mode codex  → CODEX_PROMPT (autonomous coding agent)
 *
 * Usage:
 *   node scripts/remote-agent-e2e.mjs --base http://<ip>:<port> --code <6-digit> --mode agent --model gemma4:e4b
 */

import { argv, exit } from 'node:process'

function parseArgs() {
  const out = {
    base: null, code: null, model: 'gemma4:e4b',
    mode: 'agent', chatId: 'agent-e2e',
    task: null,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--code') out.code = argv[++i]
    else if (a === '--model') out.model = argv[++i]
    else if (a === '--mode') out.mode = argv[++i]
    else if (a === '--chat-id') out.chatId = argv[++i]
    else if (a === '--task') out.task = argv[++i]
  }
  if (!out.base || !out.code) { console.error('Usage: --base <url> --code <6-digit> [--mode agent|codex]'); exit(2) }
  if (!['agent', 'codex'].includes(out.mode)) { console.error('--mode must be agent or codex'); exit(2) }
  return out
}

// ── Tool definitions — full 13-tool AGENT_TOOLS array from remote.rs::mobile_landing()
// (parity with src/api/mcp/builtin-tools.ts). 10 of these are exposed to Codex too. ──
const AGENT_TOOLS = [
  { name: 'web_search', description: 'Search the web via the configured provider. Returns ranked {title, url, snippet}.',
    parameters: [
      { name: 'query', type: 'string', description: 'The search query', required: true },
      { name: 'maxResults', type: 'number', description: 'Max results (default 5)', required: false },
    ] },
  { name: 'web_fetch', description: 'Fetch a single URL and return readable text up to 24000 chars.',
    parameters: [
      { name: 'url', type: 'string', description: 'Full URL with http(s)://', required: true },
    ] },
  { name: 'file_read', description: 'Read a UTF-8 text file. Returns full contents.',
    parameters: [
      { name: 'path', type: 'string', description: 'Path (relative or absolute)', required: true },
    ] },
  { name: 'file_write', description: 'Write a UTF-8 text file. Creates parent directories automatically. Relative paths resolve to the chat workspace folder.',
    parameters: [
      { name: 'path', type: 'string', description: 'Target file path', required: true },
      { name: 'content', type: 'string', description: 'File contents', required: true },
    ] },
  { name: 'file_list', description: 'List directory contents. Set recursive:true for full tree.',
    parameters: [
      { name: 'path', type: 'string', description: 'Directory path', required: true },
      { name: 'recursive', type: 'boolean', description: 'Include all subdirectories', required: false },
    ] },
  { name: 'file_search', description: 'Regex grep across files in a directory.',
    parameters: [
      { name: 'path', type: 'string', description: 'Directory to search', required: true },
      { name: 'query', type: 'string', description: 'Regex pattern', required: true },
    ] },
  { name: 'shell_execute', description: 'Run a shell command. PowerShell on Windows. cwd defaults to chat workspace.',
    parameters: [
      { name: 'command', type: 'string', description: 'Shell command', required: true },
    ] },
  { name: 'code_execute', description: 'Run a Python script. Runs from the chat workspace.',
    parameters: [
      { name: 'code', type: 'string', description: 'Python source code', required: true },
    ] },
  { name: 'system_info', description: 'Return OS, architecture, hostname, RAM, CPU count.',
    parameters: [] },
  { name: 'process_list', description: 'List top 30 running processes by memory.',
    parameters: [] },
  { name: 'screenshot', description: 'Capture the primary display as a base64 PNG.',
    parameters: [] },
  { name: 'image_generate', description: 'Generate an image from text via local ComfyUI. (Returns graceful error in Remote.)',
    parameters: [
      { name: 'prompt', type: 'string', description: 'Positive text description', required: true },
    ] },
  { name: 'get_current_time', description: 'Return current local date, time, timezone.',
    parameters: [] },
]

const CODEX_TOOL_NAMES = ['file_read','file_write','file_list','file_search','shell_execute','code_execute','system_info','get_current_time','web_search','web_fetch']
const AGENT_TOOL_NAMES = AGENT_TOOLS.map(t => t.name)

function buildToolDefs(tools) {
  return tools.map(t => {
    const props = {}
    const req = []
    for (const p of t.parameters || []) {
      props[p.name] = { type: p.type, description: p.description }
      if (p.required) req.push(p.name)
    }
    return {
      type: 'function',
      function: { name: t.name, description: t.description,
        parameters: { type: 'object', properties: props, required: req } },
    }
  })
}

const AGENT_PROMPT = 'You are an autonomous AI agent inside Locally Uncensored. You execute tasks end-to-end via tools — you do NOT just describe what to do.\n\nAUTONOMY CONTRACT:\n- When asked to BUILD / CREATE / WRITE something, execute it via tools.\n- NEVER produce a code block followed by "save this as X". Execute it via file_write.\n- NEVER say "Now I will create X" as plain prose and stop. Do the next step right now as a tool call.\n\nFile rules:\n- file_write AUTOMATICALLY creates missing parent directories — do NOT shell out to mkdir / New-Item.\n- Relative paths resolve to the current chat workspace folder. Use relative paths.\n\nBe concise. All the work happens in tool calls.'

const CODEX_PROMPT = 'You are Codex, an autonomous coding agent. Execute coding tasks end-to-end by reading files, writing code, and running shell commands. You MUST use tools.\n\nAUTONOMY CONTRACT:\n- COMPLETE multi-step tasks without prompting between steps.\n- NEVER say "Now I will create X" and stop. Execute the next step.\n- Chain ALL N steps in one session as concrete tool calls.\n\nWorkflow: explore → plan → implement (file_write) — chain ALL writes without stopping → final 1-3 sentence summary.\n\nFile & directory rules:\n- file_write AUTOMATICALLY creates missing parent directories. Never `mkdir` / `New-Item -ItemType Directory`.\n- All relative paths resolve to the current chat workspace.\n- shell_execute runs inside the workspace folder by default.\n- After 2-3 failures of the same approach, switch strategy.\n\nBe concise. Respond in the same language the user uses.'

// Tasks force EVERY tool in the relevant set to be exercised in one run
// ("überall alle testen pflicht ALLE IMMER"). Agent has 13, Codex 10.
const TASK_AGENT = `You are running an agent compliance test. Build a tiny static greeting site inside folder "gemtest" AND prove every Remote tool works.

You MUST call ALL 13 tools below at least once during this run. Do NOT emit a final answer until every tool listed has been used:
  1. get_current_time      → record start time
  2. system_info           → capture host facts
  3. process_list          → snapshot running processes (just call it once)
  4. file_write            → gemtest/index.html with <h1 id="hero">Hello LU E2E</h1> and <link rel="stylesheet" href="style.css">
  5. file_write            → gemtest/style.css (body sans-serif on dark bg, #hero = 32px)
  6. file_write            → gemtest/MARKER.txt containing exactly "MAGIC_LU_AGENT_E2E"
  7. file_search           → grep gemtest/ for "MAGIC_LU_AGENT_E2E" (must hit MARKER.txt)
  8. file_list             → list gemtest/ with recursive=true
  9. file_read             → read gemtest/index.html back
 10. code_execute          → Python that lists gemtest/ and writes gemtest/manifest.json
 11. shell_execute         → "Get-ChildItem gemtest" or "ls gemtest" to confirm layout
 12. screenshot            → call screenshot once (do not embed result, just confirm tool works)
 13. web_search            → query "locally uncensored github" with maxResults 1
 14. web_fetch             → fetch "https://example.com" (must succeed)
 15. image_generate        → prompt "test" (Remote returns a graceful "desktop only" error — that still counts as "tool reachable")

After every required tool was called, write a 1-2 sentence final summary listing which tools you used. DO NOT SKIP ANY TOOL.`

const TASK_CODEX = `You are running a Codex compliance test. Build a Python utility "wordcount.py" in folder "wctest" AND prove every Codex tool works.

You MUST call ALL 10 Codex tools below at least once during this run. Do NOT emit a final answer until every tool below has been used:
  1. get_current_time   → record start time
  2. system_info        → capture host facts
  3. file_write         → wctest/wordcount.py (reads argv[1], prints JSON {"file","lines","words","bytes"})
  4. file_write         → wctest/sample.txt with exactly 3 lines, including "MAGIC_LU_CODEX_E2E"
  5. file_search        → grep wctest/ for "MAGIC_LU_CODEX_E2E" (must hit sample.txt)
  6. file_list          → wctest/ recursive=true
  7. file_read          → wctest/wordcount.py back
  8. shell_execute      → "python wctest/wordcount.py wctest/sample.txt"
  9. code_execute       → Python that writes wctest/runinfo.json with timing + result
 10. web_search         → query "python json module" with maxResults 1
 11. web_fetch          → fetch "https://example.com"

After every required tool was called, write a 1-2 sentence final summary listing which tools you used. DO NOT SKIP ANY TOOL.`

async function authenticate(base, code) {
  const r = await fetch(`${base}/remote-api/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: code }),
  })
  if (!r.ok) throw new Error(`auth ${r.status}: ${await r.text()}`)
  return (await r.json()).token
}

async function runTool(base, token, chatId, tool, args) {
  const r = await fetch(`${base}/remote-api/agent-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ tool, args, chatId }),
  })
  return await r.json()
}

function observationToString(data) {
  if (!data) return ''
  if (typeof data.error === 'string') return 'Error: ' + data.error
  if (typeof data.content === 'string') return data.content
  if (data.status === 'saved') return 'File saved: ' + (data.path || '')
  if (Array.isArray(data.entries)) return JSON.stringify(data.entries.slice(0, 50), null, 2)
  if (Array.isArray(data.results)) return JSON.stringify(data.results.slice(0, 20), null, 2)
  if (data.exitCode !== undefined) {
    if (data.timedOut) return 'Execution timed out.'
    if (data.exitCode !== 0) return `Error (${data.exitCode}):\n${data.stderr || data.stdout}`
    return data.stdout || 'Done.'
  }
  if (data.iso || data.iso_local) return JSON.stringify(data)
  return JSON.stringify(data)
}

// runToolLoop logic ported from mobile_landing()
function isSystemPromptEcho(content) {
  if (!content) return false
  const head = String(content).trim().slice(0, 240)
  if (/^(hello[!,\.]?\s+|hi[!,\.]?\s+|hey[!,\.]?\s+)?(i['’]?m|i am|you are)\s+(codex|an autonomous|the agent|an? ai)/i.test(head)) return true
  if (/^(i am|i['’]m)\s+ready\s+to\s+(receive|assist|help)/i.test(head)) return true
  if (/^(hello|hi|hey)[!,\.]?\s+i['’]?m\s+ready/i.test(head)) return true
  return false
}

function repairToolCallArgs(tc) {
  if (!tc?.function) return tc
  let a = tc.function.arguments
  if (typeof a === 'string') {
    try { tc.function.arguments = JSON.parse(a) } catch (_) {}
  }
  return tc
}

async function chat(base, token, model, messages, tools) {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: 0.2 } }),
  })
  if (!r.ok) throw new Error(`/api/chat ${r.status}: ${await r.text()}`)
  return await r.json()
}

async function runAgentLoop({ base, token, model, chatId, system, task, allowedNames }) {
  const filtered = AGENT_TOOLS.filter(t => allowedNames.includes(t.name))
  const tools = buildToolDefs(filtered)
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ]
  const transcript = []
  const usedTools = new Set()
  const maxIter = 60 // doubled to give nudges room
  let echoRetries = 3
  let consecutiveErrors = 0
  const maxConsecutiveErrors = 5
  let final = null
  let nudgesUsed = 0
  const maxNudges = 3 // up to 3 follow-up nudges if the model stops early

  for (let iter = 1; iter <= maxIter; iter++) {
    process.stdout.write(`  · iter ${iter}: model thinking...`)
    const t0 = Date.now()
    const res = await chat(base, token, model, messages, tools)
    const ms = Date.now() - t0
    process.stdout.write(` (${ms}ms)\n`)
    const msg = res.message || {}
    let content = msg.content || ''
    let toolCalls = (msg.tool_calls || []).map(repairToolCallArgs)

    if (isSystemPromptEcho(content)) {
      if (echoRetries > 0) {
        echoRetries--
        console.log(`    · echo detected → silent retry (left=${echoRetries})`)
        messages.push({ role: 'user', content: 'Continue the task. Do not introduce yourself again. Resume from the last successful step using the appropriate tool call.' })
        continue
      }
      console.log(`    · echo retries spent → dropping content`)
      content = ''
    }

    if (!toolCalls.length) {
      // Compliance check: if there are still mandated tools that haven't
      // been touched, nudge the model to use them before letting it finish.
      const missing = allowedNames.filter(n => !usedTools.has(n))
      if (missing.length > 0 && nudgesUsed < maxNudges) {
        nudgesUsed++
        console.log(`    · model wants to stop but ${missing.length} tools still missing → nudge ${nudgesUsed}/${maxNudges}: ${missing.join(', ')}`)
        // Push the model's would-be final as an assistant message so the
        // history stays coherent, then add a user nudge.
        messages.push({ role: 'assistant', content: content || '' })
        messages.push({ role: 'user', content:
          `You stopped before exercising every required tool. Still missing: ${missing.join(', ')}. ` +
          `Call each of those tools NOW (one per turn is fine) with a small useful invocation, then write the final summary. ` +
          `Tools list reminder: ${allowedNames.join(', ')}.`
        })
        continue
      }
      final = content || null
      transcript.push({ kind: 'final', content: final })
      console.log(`    · no toolCalls → finalAnswer (after ${nudgesUsed} nudges)\n      "${(final || '(empty → fallback summary will kick in on the UI)').slice(0, 200)}"`)
      break
    }

    messages.push({ role: 'assistant', content, tool_calls: toolCalls.map(tc => ({ function: { name: tc.function.name, arguments: tc.function.arguments } })) })

    for (const tc of toolCalls) {
      const name = tc.function.name
      usedTools.add(name)
      const args = tc.function.arguments || {}
      const argsPretty = JSON.stringify(args).slice(0, 200)
      console.log(`    → ${name} ${argsPretty}`)
      const data = await runTool(base, token, chatId, name, args)
      const obs = observationToString(data)
      const isErr = /^(Error|Permission denied|Network error)/i.test(obs)
      if (isErr) consecutiveErrors++; else consecutiveErrors = 0
      const obsShort = obs.slice(0, 220).replaceAll('\n', ' ')
      console.log(`      ${isErr ? '✗' : '✓'} ${obsShort}${obs.length > 220 ? '…' : ''}`)
      transcript.push({ kind: 'tool', name, args, observation: obs, error: isErr })
      messages.push({ role: 'tool', content: obs })

      if (consecutiveErrors >= maxConsecutiveErrors) {
        console.log(`    ! consecutiveErrors=${consecutiveErrors} → bailing`)
        final = null
        break
      }
    }
    if (consecutiveErrors >= maxConsecutiveErrors) break
  }

  return { final, transcript, usedTools, consecutiveErrors, echoRetries, nudgesUsed }
}

async function main() {
  const { base, code, mode, model, chatId, task } = parseArgs()
  const token = await authenticate(base, code)
  console.log(`[e2e] Authenticated. Mode=${mode} Model=${model} ChatId=${chatId}`)
  const system = mode === 'codex' ? CODEX_PROMPT : AGENT_PROMPT
  const userTask = task || (mode === 'codex' ? TASK_CODEX : TASK_AGENT)
  console.log(`[e2e] Task:\n  ${userTask.replaceAll('\n', '\n  ')}\n`)

  const allowedNames = mode === 'codex' ? CODEX_TOOL_NAMES : AGENT_TOOL_NAMES
  console.log(`[e2e] Tools available: ${allowedNames.length} (${allowedNames.join(', ')})\n`)
  const t0 = Date.now()
  const result = await runAgentLoop({ base, token, model, chatId, system, task: userTask, allowedNames })
  const elapsed = Date.now() - t0

  const missing = allowedNames.filter(n => !result.usedTools.has(n))
  console.log(`\n━━ Run summary ━━`)
  console.log(`Mode:                       ${mode}`)
  console.log(`Tools available:            ${allowedNames.length}`)
  console.log(`Tools exercised (${result.usedTools.size}):       ${[...result.usedTools].sort().join(', ')}`)
  console.log(`Tools NOT exercised (${missing.length}):    ${missing.length ? missing.join(', ') : '(none — all tools hit ✓)'}`)
  console.log(`Tool turns recorded:        ${result.transcript.filter(t => t.kind === 'tool').length}`)
  console.log(`Errors during run:          ${result.transcript.filter(t => t.kind === 'tool' && t.error).length}`)
  console.log(`Echo retries used:          ${3 - result.echoRetries}`)
  console.log(`Consecutive-err count:      ${result.consecutiveErrors}`)
  console.log(`Tool-coverage nudges used:  ${result.nudgesUsed}`)
  console.log(`Total wall time:            ${elapsed} ms`)
  const hasGreeting = result.final && /^(hello|hi|hey).{0,40}(codex|the agent|an ai)/i.test(result.final)
  console.log(`Final answer was a greeting: ${hasGreeting ? 'YES (BUG)' : 'NO ✓'}`)
  console.log(`Final answer:\n  "${(result.final || '(no final, fallback would kick in)').slice(0, 400)}"`)
  exit(hasGreeting || missing.length > 0 ? 1 : 0)
}

main().catch(e => { console.error('[e2e] fatal:', e); exit(2) })
