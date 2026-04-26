#!/usr/bin/env node
/**
 * Real-mobile-browser end-to-end test. Loads /mobile in an actual
 * headless Chromium, types the access code, enables Agent mode, types
 * a multi-tool task, sends it, and observes EXACTLY what the embedded
 * `runToolLoop` JS does — every HTTP request, every chat-event, every
 * console log, every UI render.
 *
 * No shortcuts. No auto-nudge. This is what the user's phone actually
 * sees when they connect.
 *
 * Usage:
 *   node scripts/mobile-real-browser.mjs --url <full mobile url> --code <6 digit>
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

function args() {
  const out = { url: null, code: null, mode: 'agent', task: null, headless: true }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') out.url = argv[++i]
    else if (a === '--code') out.code = argv[++i]
    else if (a === '--mode') out.mode = argv[++i]
    else if (a === '--task') out.task = argv[++i]
    else if (a === '--headed') out.headless = false
  }
  if (!out.url || !out.code) {
    console.error('Usage: --url <full mobile url> --code <6 digit> [--mode agent|codex] [--task "..."] [--headed]')
    exit(2)
  }
  return out
}

// Single explicit task that names every tool with a concrete useful
// purpose. No vague "use all tools" — the model gets a numbered list
// where each tool has a real job. Easier for small models to follow.
const TASK_DEFAULT = `Erstelle für mich einen "System-Audit"-Bericht im Workspace. Mach folgende Schritte EXAKT in dieser Reihenfolge — jeder Schritt MUSS als ein Tool-Aufruf passieren:

1.  get_current_time  → hol die aktuelle Zeit, das ist der Stempel oben im Bericht.
2.  system_info       → OS, CPU-Anzahl und RAM für den Bericht.
3.  process_list      → die Top-Prozesse, wir brauchen 3 davon.
4.  screenshot        → mach EIN Screenshot, notier dass das Format PNG ist.
5.  web_search        → such "ollama models" und merk dir den Titel des ersten Treffers.
6.  web_fetch         → fetche https://example.com und merk dir den <title>.
7.  file_write audit/raw.txt mit ALLEN Rohdaten aus 1-6 untereinander.
8.  shell_execute     → echo "audit started" und merk das stdout.
9.  code_execute      → Python das die Bytes von audit/raw.txt zählt: open('audit/raw.txt','rb').read() len, print das.
10. file_read audit/raw.txt → gib mir die ersten 200 Zeichen wieder.
11. file_search path="audit" query="cpu" → Treffer melden.
12. file_list path="audit" recursive=true → die komplette Liste melden.
13. image_generate prompt="audit illustration" → was auch immer zurück kommt, das error/status-Feld kommentieren.

Schreib zum Schluss audit/REPORT.md mit einer Aufzählung welches Tool was geliefert hat.

Halt dich strikt an die Reihenfolge, übersprich KEINEN Schritt, leere Antworten zwischen den Schritten sind FEHLER.`

// Tools the mobile_landing JS exposes. Source of truth is AGENT_TOOLS in
// src-tauri/src/commands/remote.rs. Codex uses a subset.
const AGENT_TOOL_NAMES = ['web_search','web_fetch','file_read','file_write','file_list','file_search','shell_execute','code_execute','system_info','process_list','screenshot','image_generate','get_current_time']
const CODEX_TOOL_NAMES = ['file_read','file_write','file_list','file_search','shell_execute','code_execute','system_info','get_current_time','web_search','web_fetch']

// Per-tool nudge text. The user types this verbatim into the chat as a
// follow-up message when a tool was not exercised in the previous run.
// Each phrasing is concrete enough that the model can't sidestep with
// prose — it has to call the tool to comply.
const TOOL_NUDGES = {
  web_search:    'Search the web for "ollama best small models 2024" with web_search and tell me the top result.',
  web_fetch:     'Use web_fetch to fetch https://example.com and report its <title>.',
  file_read:     'Read the file gemtest/index.html with file_read and quote the first <h1> tag.',
  file_write:    'Use file_write to create gemtest/notes.md with the text "Mobile E2E proof — all tools".',
  file_list:     'Use file_list with path "gemtest" recursive=true and list the entries.',
  file_search:   'Use file_search with path "gemtest" and query "Hello" and report any matches.',
  shell_execute: 'Run "echo hello-from-shell" via shell_execute and report stdout.',
  code_execute:  'Use code_execute with this Python: print(2+2). Report the stdout.',
  system_info:   'Call system_info and report the os + cpuCount.',
  process_list:  'Call process_list and report the top process by memory.',
  screenshot:    'Call screenshot once and report the image format from the response.',
  image_generate:'Call image_generate with prompt "test". Whatever response comes back, report its error or status field.',
  get_current_time:'Call get_current_time and report the iso_local field.',
}

async function main() {
  const { url, code, mode, task, headless } = args()
  const userTask = task || TASK_DEFAULT

  const outDir = './scripts/mobile-run'
  mkdirSync(outDir, { recursive: true })

  // Network + console buffers (declared outside try so the finally block can save)
  const networkLog = []
  const consoleLog = []
  const chatEvents = []
  const toolCalls = []
  const toolResults = []
  let final = []
  let elapsedMs = 0

  console.log(`[browser] launching headless=${headless}`)
  const browser = await chromium.launch({ headless })
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },        // iPhone 14 size
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    recordHar: { path: `${outDir}/network.har`, mode: 'full' },
    recordVideo: { dir: outDir, size: { width: 390, height: 844 } },
  })
  const page = await ctx.newPage()

  // Always-save guard — runs whether the test passes, fails, or throws.
  const saveAll = () => {
    try {
      writeFileSync(`${outDir}/network.json`, JSON.stringify(networkLog, null, 2))
      writeFileSync(`${outDir}/console.json`, JSON.stringify(consoleLog, null, 2))
      writeFileSync(`${outDir}/tool-calls.json`, JSON.stringify(toolCalls, null, 2))
      writeFileSync(`${outDir}/chat-events.json`, JSON.stringify(chatEvents, null, 2))
      writeFileSync(`${outDir}/transcript.json`, JSON.stringify(final, null, 2))
    } catch (_) {}
  }

  page.on('console', msg => {
    consoleLog.push({ type: msg.type(), text: msg.text(), at: Date.now() })
  })
  page.on('pageerror', err => {
    consoleLog.push({ type: 'pageerror', text: String(err), at: Date.now() })
  })
  page.on('request', req => {
    networkLog.push({ phase: 'request', method: req.method(), url: req.url(), at: Date.now() })
  })
  page.on('response', async res => {
    const u = res.url()
    let body = null
    try {
      const h = res.headers()['content-type'] || ''
      if (h.includes('json') || h.includes('text')) {
        body = await res.text()
      }
    } catch (_) {}
    networkLog.push({ phase: 'response', status: res.status(), url: u, body: body?.slice(0, 4000), at: Date.now() })

    // Targeted parsing: tool calls + chat events
    if (u.endsWith('/remote-api/agent-tool')) {
      try {
        const reqBody = res.request().postDataJSON()
        toolCalls.push({ ts: Date.now(), tool: reqBody?.tool, args: reqBody?.args, chatId: reqBody?.chatId, status: res.status(), responseBody: (body||'').slice(0,800) })
      } catch (_) {}
    }
    if (u.endsWith('/remote-api/chat-event')) {
      try {
        const reqBody = res.request().postDataJSON()
        chatEvents.push({ ts: Date.now(), role: reqBody?.role, content: (reqBody?.content||'').slice(0,500), status: res.status() })
      } catch (_) {}
    }
  })

  try {
  // ── Step 1: load page ──
  console.log(`[browser] navigate → ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})

  // ── Step 2: auth ──
  console.log(`[browser] type access code`)
  try {
    await page.waitForSelector('#auth-code', { timeout: 15000 })
    await page.fill('#auth-code', code)
    await page.screenshot({ path: `${outDir}/00-pre-auth.png` }).catch(() => {})
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
      page.click('button.auth-btn'),
    ])
  } catch (e) {
    console.error(`[browser] auth step failed: ${e}`)
    await page.screenshot({ path: `${outDir}/auth-error.png` }).catch(() => {})
  }
  // Either we're already at the chat UI, or we still see the auth form (auth failed).
  // Probe both.
  let authOk = false
  for (let i = 0; i < 30; i++) {
    const state = await page.evaluate(() => ({
      hasChat: !!document.getElementById('msg-input'),
      hasAuth: !!document.getElementById('auth-code'),
      authErr: (document.getElementById('auth-err')?.textContent || '').trim(),
      hasToken: !!localStorage.getItem('lu-remote-token'),
    })).catch(() => ({ hasChat: false, hasAuth: false }))
    if (state.hasChat) { authOk = true; break }
    if (state.authErr) { console.error(`[browser] auth error from page: "${state.authErr}"`); break }
    await new Promise(r => setTimeout(r, 1000))
  }
  if (!authOk) {
    await page.screenshot({ path: `${outDir}/auth-still-stuck.png` }).catch(() => {})
    throw new Error('Auth failed — chat UI never appeared. See auth-still-stuck.png and console.json.')
  }
  console.log(`[browser] auth ok, msg-input visible`)
  await page.screenshot({ path: `${outDir}/01-after-auth.png`, fullPage: true })

  // ── Step 3: enable Agent mode (or switch to Codex chat) ──
  if (mode === 'agent') {
    // Toggle Agent in the header. The header has a `.header-agent-tag`
    // chip but the actual click handler is wired via `window._toggleAgent()`.
    // Easier: call it directly.
    await page.evaluate(() => window._toggleAgent && window._toggleAgent())
    console.log(`[browser] Agent toggled on`)
  } else if (mode === 'codex') {
    // Open the drawer, switch to a Codex chat. Easier path: set
    // currentChat.mode = 'codex' via JS.
    await page.evaluate(() => {
      const cs = JSON.parse(localStorage.getItem('lu-mobile-chats') || '[]')
      if (cs.length) {
        cs[0].mode = 'codex'
        localStorage.setItem('lu-mobile-chats', JSON.stringify(cs))
      }
    })
    await page.reload()
    await page.waitForSelector('#msg-input', { timeout: 30000 })
    console.log(`[browser] Codex mode active`)
  }

  // ── Step 4: ensure a model is selected. The header model badge auto-loads
  // the first installed model usually. If it's empty, the send falls into
  // _openModelPicker. We pre-set currentModel via JS as a safety net.
  await page.evaluate(() => {
    if (!window.currentModel || window.currentModel === '') {
      // Pull any tag from /api/tags
      return fetch('/api/tags', { headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('lu-remote-token') || '') } })
        .then(r => r.json()).then(d => {
          if (d?.models?.length) {
            window.currentModel = d.models[0].name
            localStorage.setItem('lu-mobile-current-model', window.currentModel)
          }
        }).catch(() => {})
    }
  })
  // Re-check via mobile JS' own internal state
  const modelInfo = await page.evaluate(() => ({
    currentModel: window.currentModel || localStorage.getItem('lu-mobile-current-model'),
    chatId: window.currentChatId || localStorage.getItem('lu-mobile-current-chat'),
    chats: JSON.parse(localStorage.getItem('lu-mobile-chats') || '[]').length,
  }))
  console.log(`[browser] state: ${JSON.stringify(modelInfo)}`)

  // ── Step 5: type the task and send ──
  console.log(`[browser] typing task (${userTask.length} chars)`)
  await page.fill('#msg-input', userTask)
  await page.screenshot({ path: `${outDir}/02-task-typed.png`, fullPage: true })
  await page.click('#send-btn')
  console.log(`[browser] send clicked, waiting for completion…`)

  // ── Step 6: wait for the agent loop to finish ──
  // The mobile JS keeps `agentRunning` / `streaming` / `msgs` in CLOSURE
  // scope (not window). So instead of polling state, we watch network
  // activity: track every /api/chat or /remote-api/agent-tool request
  // in flight. Loop is done when there have been no in-flight requests
  // for ≥ quietWindowMs AND we've seen at least one /api/chat finish.
  const startWait = Date.now()
  const maxWait = 12 * 60 * 1000
  let inFlight = 0
  let chatCompleted = 0
  let lastActivity = Date.now()
  const quietWindowMs = 8000
  page.on('request', r => {
    const u = r.url()
    if (u.endsWith('/api/chat') || u.endsWith('/remote-api/agent-tool')) {
      inFlight++
      lastActivity = Date.now()
    }
  })
  page.on('requestfinished', r => {
    const u = r.url()
    if (u.endsWith('/api/chat') || u.endsWith('/remote-api/agent-tool')) {
      inFlight = Math.max(0, inFlight - 1)
      if (u.endsWith('/api/chat')) chatCompleted++
      lastActivity = Date.now()
    }
  })
  page.on('requestfailed', r => {
    const u = r.url()
    if (u.endsWith('/api/chat') || u.endsWith('/remote-api/agent-tool')) {
      inFlight = Math.max(0, inFlight - 1)
      lastActivity = Date.now()
    }
  })
  console.log(`[browser] watching network…`)
  while (Date.now() - startWait < maxWait) {
    const idle = Date.now() - lastActivity
    if (inFlight === 0 && idle > quietWindowMs && chatCompleted > 0) break
    await new Promise(r => setTimeout(r, 1000))
    if ((Date.now() - startWait) % 15000 < 1100) {
      console.log(`[browser]   inFlight=${inFlight} chatCompleted=${chatCompleted} toolCalls=${toolCalls.length} idleMs=${idle}`)
    }
  }
  console.log(`[browser] network quiet, collecting transcript`)
  await page.screenshot({ path: `${outDir}/03-after-completion.png`, fullPage: true })
  console.log(`[browser] loop ended after ${Math.round((Date.now()-startWait)/1000)}s`)

  // ── Step 7: collect transcript via localStorage (mobile persists chats there) ──
  final = await page.evaluate(() => {
    const chats = JSON.parse(localStorage.getItem('lu-mobile-chats') || '[]')
    const cur = localStorage.getItem('lu-mobile-current-chat') || ''
    const c = chats.find(x => x.id === cur) || chats[0]
    if (!c || !Array.isArray(c.msgs)) return []
    return c.msgs.map(m => ({
      role: m.role,
      content: (m.content || '').slice(0, 4000),
      hidden: !!m.hidden,
      tool_calls: m.tool_calls || null,
      agentSteps: (m.agentSteps || []).map(s => ({
        type: s.type, content: (s.content || '').slice(0, 1000),
        toolName: s.toolName || null,
      })),
    }))
  })
  elapsedMs = Date.now() - startWait

  // ── Save everything ──
  const summary = {
    mode, url, code,
    elapsedMs,
    toolCallCount: toolCalls.length,
    toolCallsByName: toolCalls.reduce((acc, c) => { acc[c.tool] = (acc[c.tool] || 0) + 1; return acc }, {}),
    chatEventCount: chatEvents.length,
    consoleErrors: consoleLog.filter(l => l.type === 'pageerror' || l.type === 'error').length,
  }
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2))
  saveAll()

  console.log(`\n━━ SUMMARY ━━`)
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nTool calls (${toolCalls.length}):`)
  for (const t of toolCalls) {
    const okBadge = t.status === 200 ? '✓' : '✗'
    const errFromBody = (t.responseBody || '').includes('"error"') ? '  ⚠ error in body' : ''
    console.log(`  ${okBadge} ${t.tool}  args=${JSON.stringify(t.args).slice(0,100)} chatId=${t.chatId}${errFromBody}`)
  }
  console.log(`\nFinal assistant content:`)
  const lastAssistant = final.filter(m => m.role === 'assistant').slice(-1)[0]
  console.log(`  "${(lastAssistant?.content || '').slice(0, 500)}"`)
  console.log(`\nArtefacts at ${outDir}/`)

  } catch (e) {
    console.error('[browser] FAILED in main flow:', e)
    saveAll()
    throw e
  } finally {
    saveAll()
    await ctx.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

main().catch(e => { console.error('[browser] fatal:', e); exit(2) })
