#!/usr/bin/env node
/**
 * All-tools-in-one-run E2E. Mimics what an agent does over the course of
 * one multi-step task — exercising every Remote tool sequentially in a
 * single authenticated session, the same way `runToolLoop` would dispatch
 * them. Proves that nothing leaks paths into ~/agent-workspace/__remote__/
 * and that the tool chain works end-to-end with the user-picked workspace.
 *
 * Task being simulated:
 *   "Build a tiny static site (index.html, style.css), grep for a tag,
 *    list the tree, run a shell + python diagnostic, capture system info,
 *    and write a final summary file."
 *
 * Usage:
 *   node scripts/remote-all-tools-e2e.mjs --base http://<ip>:<port> --code <6-digit>
 */

import { argv, exit } from 'node:process'

function parseArgs() {
  const out = { base: null, code: null, chatId: 'all-tools-e2e' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--code') out.code = argv[++i]
    else if (a === '--chat-id') out.chatId = argv[++i]
  }
  if (!out.base || !out.code) { console.error('Usage: --base <url> --code <6-digit>'); exit(2) }
  return out
}

async function authenticate(base, code) {
  const r = await fetch(`${base}/remote-api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: code }),
  })
  if (!r.ok) throw new Error(`auth ${r.status}: ${await r.text()}`)
  const data = await r.json()
  return data.token
}

async function tool(base, token, chatId, name, args) {
  const r = await fetch(`${base}/remote-api/agent-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ tool: name, args, chatId }),
  })
  return await r.json()
}

let pass = 0, fail = 0
function check(label, ok, detail) {
  if (ok) { console.log(`  ✓ ${label}`); pass++ }
  else { console.error(`  ✗ ${label}\n      ${detail}`); fail++ }
}

const NOT_REMOTE = (s) => !String(s || '').replaceAll('\\', '/').includes('agent-workspace/__remote__')

async function step(label, fn) {
  console.log(`\n━━ ${label} ━━`)
  return await fn()
}

async function main() {
  const { base, code, chatId } = parseArgs()
  const token = await authenticate(base, code)
  console.log(`[e2e] auth ok, chatId=${chatId}`)

  const startedAt = Date.now()
  const toolsHit = new Set()
  const T = (n) => { toolsHit.add(n); return n }

  // ── 1. Time check (no permissions) ──
  await step('1. get_current_time — kick off the run', async () => {
    const t = await tool(base, token, chatId, T('get_current_time'), {})
    check('time tool returned', !!t && (t.iso || t.iso_local || t.unix), JSON.stringify(t))
  })

  // ── 2. System info ──
  await step('2. system_info — capture host facts', async () => {
    const s = await tool(base, token, chatId, T('system_info'), {})
    check('system_info returned object', !!s && typeof s === 'object', JSON.stringify(s))
    check('system_info had at least one of os/platform/cpu/osName',
      s && (s.os || s.platform || s.cpu || s.osName), JSON.stringify(s))
  })

  // ── 3. file_write — index.html ──
  let writePath
  await step('3. file_write index.html — start the site build', async () => {
    const w = await tool(base, token, chatId, T('file_write'), {
      path: 'site/index.html',
      content: '<!doctype html><html><head><title>LU E2E</title>' +
        '<link rel="stylesheet" href="style.css"></head>' +
        '<body><h1 id="hero">Hello LU E2E</h1></body></html>\n',
    })
    check('file_write status=saved', w?.status === 'saved', JSON.stringify(w))
    check('file_write path NOT in __remote__', NOT_REMOTE(w?.path), w?.path)
    writePath = w?.path
  })

  // ── 4. file_write — style.css ──
  await step('4. file_write style.css — second artefact', async () => {
    const w = await tool(base, token, chatId, T('file_write'), {
      path: 'site/style.css',
      content: 'body{font-family:sans-serif;background:#111;color:#eee}\n#hero{font-size:32px}\n',
    })
    check('css saved', w?.status === 'saved', JSON.stringify(w))
    check('css path NOT in __remote__', NOT_REMOTE(w?.path), w?.path)
  })

  // ── 5. file_list — confirm both files exist ──
  await step('5. file_list site/ — verify the layout', async () => {
    const l = await tool(base, token, chatId, T('file_list'), { path: 'site' })
    const names = (l?.entries || []).map(e => String(e.name || ''))
    check('file_list returned array', Array.isArray(l?.entries), JSON.stringify(l))
    check('found index.html', names.some(n => /index\.html$/.test(n)), names.join('|'))
    check('found style.css', names.some(n => /style\.css$/.test(n)), names.join('|'))
  })

  // ── 6. file_list recursive — full tree ──
  await step('6. file_list recursive — full tree', async () => {
    const l = await tool(base, token, chatId, T('file_list'), { path: '.', recursive: true })
    check('recursive list returned entries',
      Array.isArray(l?.entries) && l.entries.length >= 2, JSON.stringify(l).slice(0,200))
  })

  // ── 7. file_read — read the index back ──
  await step('7. file_read index.html — round-trip content', async () => {
    const r = await tool(base, token, chatId, T('file_read'), { path: 'site/index.html' })
    check('file_read returned content', typeof r?.content === 'string', JSON.stringify(r))
    check('file_read content includes "<h1 id=\\"hero\\">"',
      typeof r?.content === 'string' && r.content.includes('<h1 id="hero">'),
      r?.content?.slice?.(0, 200))
  })

  // ── 8. file_search — grep for the hero id ──
  await step('8. file_search "hero" — grep regex', async () => {
    const s = await tool(base, token, chatId, T('file_search'), {
      path: 'site', query: 'hero',
    })
    check('file_search returned results array', Array.isArray(s?.results), JSON.stringify(s))
    const hit = (s?.results || []).find(r => /index\.html$/.test(r.file || ''))
    check('grep hit index.html', !!hit, JSON.stringify(s?.results))
    check('hit file path NOT in __remote__',
      hit ? NOT_REMOTE(hit.file) : false, JSON.stringify(hit))
  })

  // ── 9. shell_execute — list files via a real shell command ──
  await step('9. shell_execute — sanity diagnostic', async () => {
    const cmd = process.platform === 'win32'
      ? 'Get-ChildItem -Recurse | Select-Object -First 10 | ForEach-Object { $_.FullName }'
      : 'find . -maxdepth 2 | head -20'
    const sh = await tool(base, token, chatId, T('shell_execute'), { command: cmd })
    check('shell_execute had stdout', typeof sh?.stdout === 'string', JSON.stringify(sh))
    check('shell_execute exitCode 0', sh?.exitCode === 0, JSON.stringify(sh))
    check('shell saw site/index.html in cwd',
      typeof sh?.stdout === 'string' && /site/i.test(sh.stdout),
      sh?.stdout?.slice?.(0, 300))
    check('shell stdout NOT mentioning __remote__',
      typeof sh?.stdout === 'string' && NOT_REMOTE(sh.stdout),
      sh?.stdout?.slice?.(0, 300))
  })

  // ── 10. code_execute — Python writes a JSON manifest ──
  await step('10. code_execute Python — emit manifest.json', async () => {
    const code = `
import os, json
files = []
for root, dirs, names in os.walk('.'):
  for n in names:
    p = os.path.join(root, n)
    files.append({'path': p, 'size': os.path.getsize(p)})
with open('manifest.json','w',encoding='utf-8') as f:
  json.dump({'cwd': os.getcwd(), 'files': files}, f, indent=2)
print('manifest written, file count =', len(files))
`.trim()
    const py = await tool(base, token, chatId, T('code_execute'), { code, timeout: 30000 })
    check('python exitCode 0', py?.exitCode === 0, JSON.stringify(py))
    check('python printed file count',
      typeof py?.stdout === 'string' && /file count = \d+/.test(py.stdout),
      py?.stdout)
  })

  // ── 11. file_read manifest.json — round trip ──
  await step('11. file_read manifest.json — verify python output', async () => {
    const r = await tool(base, token, chatId, T('file_read'), { path: 'manifest.json' })
    check('manifest read', typeof r?.content === 'string', JSON.stringify(r))
    let parsed = null
    try { parsed = JSON.parse(r.content) } catch (_) {}
    check('manifest is valid JSON', !!parsed, r?.content?.slice?.(0, 200))
    check('manifest cwd is the override folder',
      parsed && typeof parsed.cwd === 'string' && NOT_REMOTE(parsed.cwd),
      parsed?.cwd)
    check('manifest lists ≥ 3 files (index, style, manifest)',
      parsed && Array.isArray(parsed.files) && parsed.files.length >= 3,
      JSON.stringify(parsed?.files?.length))
  })

  // ── 12. shell_execute with explicit relative cwd ──
  await step('12. shell_execute cwd=site — relative cwd resolves', async () => {
    const cmd = process.platform === 'win32' ? '$pwd.Path' : 'pwd'
    const sh = await tool(base, token, chatId, T('shell_execute'), { command: cmd, cwd: 'site' })
    check('shell saw site as cwd',
      typeof sh?.stdout === 'string' && /site/i.test(sh.stdout) && NOT_REMOTE(sh.stdout),
      sh?.stdout?.slice?.(0, 300))
  })

  // ── 13. file_write — final summary ──
  await step('13. file_write summary.md — wrap-up artefact', async () => {
    const w = await tool(base, token, chatId, T('file_write'), {
      path: 'summary.md',
      content: `# LU Remote Multi-Tool E2E\n\nRun completed at ${new Date().toISOString()}.\nTools exercised: ${[...toolsHit].join(', ')}\n`,
    })
    check('summary saved', w?.status === 'saved', JSON.stringify(w))
  })

  // ── 14. image_generate — graceful unsupported ──
  await step('14. image_generate — graceful "desktop only" error', async () => {
    const i = await tool(base, token, chatId, T('image_generate'), { prompt: 'cat' })
    check('image_generate returned graceful error',
      typeof i?.error === 'string' && /desktop|create tab/i.test(i.error),
      JSON.stringify(i))
  })

  // ── Summary ──
  const elapsed = Date.now() - startedAt
  console.log(`\n━━ Run summary ━━`)
  console.log(`Tools exercised in this single run: ${[...toolsHit].sort().join(', ')}`)
  console.log(`Total duration: ${elapsed} ms`)
  console.log(`\n${pass} passed, ${fail} failed.`)
  exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('[e2e] fatal:', e); exit(2) })
