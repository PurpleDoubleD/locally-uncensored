#!/usr/bin/env node
/**
 * Remote-Access smoke harness — talks to the LU desktop app's local
 * remote server (the same one the mobile page uses). Lets us exercise
 * the file/agent endpoints from a Node script so we can reproduce + fix
 * Remote bugs without burning the user's time on phone clicks.
 *
 * Bootstrap (one-time per session):
 *   1. Launch the LU desktop exe.
 *   2. Open Remote drawer → click "LAN" → click Dispatch on a chat → pick a folder.
 *   3. The drawer shows a URL like `http://192.168.1.42:8765` and a 6-digit code.
 *   4. Run this script with both:
 *        node scripts/remote-smoke.mjs \
 *          --base http://192.168.1.42:8765 \
 *          --code 123456 \
 *          --chat-id <slug from drawer / any string the desktop assigns>
 *
 * What it does:
 *   - POST /remote-api/auth   to swap the 6-digit code for a JWT token
 *   - POST /remote-api/agent-tool  with file_write / file_list calls
 *   - Verifies the resulting paths land in the user-picked folder, NOT
 *     in `~/agent-workspace/__remote__/`.
 *
 * Exit code 0 = all assertions passed, 1 = at least one failure.
 */

import { argv, exit } from 'node:process'
import { join } from 'node:path'

function parseArgs() {
  const out = { base: null, code: null, chatId: 'remote-smoke' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--code') out.code = argv[++i]
    else if (a === '--chat-id') out.chatId = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log('Usage: remote-smoke.mjs --base <url> --code <6-digit> [--chat-id <slug>]')
      exit(0)
    }
  }
  if (!out.base || !out.code) {
    console.error('Missing --base or --code. Run with --help for usage.')
    exit(2)
  }
  return out
}

async function authenticate(base, code) {
  const r = await fetch(`${base}/remote-api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Server expects `passcode` (matches AuthRequest struct in remote.rs).
    body: JSON.stringify({ passcode: code }),
  })
  if (!r.ok) {
    const txt = await r.text()
    throw new Error(`auth failed: ${r.status} ${txt}`)
  }
  const data = await r.json()
  if (!data.token) throw new Error(`auth response missing token: ${JSON.stringify(data)}`)
  return data.token
}

async function agentTool(base, token, chatId, tool, args) {
  const r = await fetch(`${base}/remote-api/agent-tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ tool, args, chatId }),
  })
  const text = await r.text()
  let data = null
  try { data = JSON.parse(text) } catch (_) {}
  if (!r.ok && !data) throw new Error(`HTTP ${r.status}: ${text}`)
  return data ?? text
}

let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}\n      ${detail || '(no detail)'}`)
    failed++
  }
}

async function main() {
  const { base, code, chatId } = parseArgs()
  console.log(`[remote-smoke] base=${base} chat=${chatId}`)
  const token = await authenticate(base, code)
  console.log(`[remote-smoke] authenticated (token ${token.slice(0, 8)}…)`)

  // 1) file_write — should succeed, returns absolute path. The path field
  // tells us where the desktop actually wrote the bytes.
  console.log('\n— file_write —')
  const writeRes = await agentTool(base, token, chatId, 'file_write', {
    path: 'remote-smoke/hello.txt',
    content: 'hello from the smoke harness\n',
  })
  check('file_write returned object', writeRes && typeof writeRes === 'object', JSON.stringify(writeRes))
  check('file_write status=saved', writeRes?.status === 'saved', JSON.stringify(writeRes))
  check('file_write returned path', typeof writeRes?.path === 'string', JSON.stringify(writeRes))
  const writePath = writeRes?.path || ''
  console.log(`     wrote to: ${writePath}`)
  check('file_write path is NOT ~/agent-workspace/__remote__/',
    !writePath.replaceAll('\\', '/').includes('agent-workspace/__remote__/'),
    `path was ${writePath} — bug 1 still present`)

  // 2) file_list — same relative folder. Should return one entry (hello.txt).
  console.log('\n— file_list —')
  const listRes = await agentTool(base, token, chatId, 'file_list', {
    path: 'remote-smoke',
  })
  check('file_list returned object', listRes && typeof listRes === 'object', JSON.stringify(listRes))
  check('file_list has entries', Array.isArray(listRes?.entries), JSON.stringify(listRes))
  const found = (listRes?.entries || []).find(e => /hello\.txt$/.test(e.name || e.path || ''))
  check('file_list found hello.txt we just wrote', !!found,
    `entries: ${JSON.stringify(listRes?.entries)}`)

  // 3) file_list with a NON-EXISTENT relative path → should error gracefully
  console.log('\n— file_list (non-existent) —')
  const list404 = await agentTool(base, token, chatId, 'file_list', {
    path: 'this-folder-does-not-exist-anywhere',
  })
  check('file_list non-existent returns error field',
    typeof list404?.error === 'string',
    JSON.stringify(list404))

  // 4) file_read of the file we just wrote → confirms round-trip
  console.log('\n— file_read —')
  const readRes = await agentTool(base, token, chatId, 'file_read', {
    path: 'remote-smoke/hello.txt',
  })
  check('file_read returns content', typeof readRes?.content === 'string',
    JSON.stringify(readRes))
  check('file_read content matches what we wrote',
    readRes?.content === 'hello from the smoke harness\n',
    `got: ${JSON.stringify(readRes?.content)}`)

  // 5) shell_execute → should default cwd to workspace, runs `pwd` (or `cd`)
  console.log('\n— shell_execute (cwd default) —')
  const cmd = process.platform === 'win32' ? '$pwd.Path' : 'pwd'
  const shellRes = await agentTool(base, token, chatId, 'shell_execute', {
    command: cmd,
  })
  check('shell_execute returned object', shellRes && typeof shellRes === 'object',
    JSON.stringify(shellRes))
  check('shell_execute has stdout', typeof shellRes?.stdout === 'string',
    JSON.stringify(shellRes))
  if (typeof shellRes?.stdout === 'string') {
    console.log(`     cwd seen by shell: ${shellRes.stdout.trim()}`)
    check('shell_execute cwd is NOT ~/agent-workspace/__remote__/',
      !shellRes.stdout.replaceAll('\\', '/').includes('agent-workspace/__remote__'),
      `stdout was ${shellRes.stdout}`)
  }

  // 6) shell_execute with explicit relative cwd → should resolve against override too
  console.log('\n— shell_execute (relative cwd) —')
  const shellRel = await agentTool(base, token, chatId, 'shell_execute', {
    command: cmd,
    cwd: 'remote-smoke',
  })
  if (typeof shellRel?.stdout === 'string') {
    console.log(`     cwd: ${shellRel.stdout.trim()}`)
    check('shell_execute resolved relative cwd into override folder',
      shellRel.stdout.includes('remote-smoke') &&
      !shellRel.stdout.replaceAll('\\', '/').includes('agent-workspace/__remote__'),
      `stdout was ${shellRel.stdout}`)
  } else {
    check('shell_execute (relative cwd) returned stdout', false, JSON.stringify(shellRel))
  }

  // 7) file_search — write a known marker file, then grep for it
  console.log('\n— file_search —')
  await agentTool(base, token, chatId, 'file_write', {
    path: 'remote-smoke/grepme.txt',
    content: 'GREP_MARKER_LU_REMOTE_SMOKE\nsecond line\n',
  })
  const searchRes = await agentTool(base, token, chatId, 'file_search', {
    path: 'remote-smoke',
    query: 'GREP_MARKER_LU_REMOTE_SMOKE',
  })
  check('file_search returns results array',
    Array.isArray(searchRes?.results),
    JSON.stringify(searchRes))
  const hit = (searchRes?.results || []).find(r =>
    /grepme\.txt$/.test(r.file || ''))
  check('file_search found the marker we just wrote', !!hit,
    JSON.stringify(searchRes?.results))
  check('file_search hit file path is NOT under agent-workspace/__remote__/',
    hit ? !String(hit.file).replaceAll('\\', '/').includes('agent-workspace/__remote__') : false,
    `hit was ${JSON.stringify(hit)}`)

  // 8) file_list with recursive=true → should include both files we wrote
  console.log('\n— file_list (recursive) —')
  const listRec = await agentTool(base, token, chatId, 'file_list', {
    path: 'remote-smoke',
    recursive: true,
  })
  const recNames = (listRec?.entries || []).map(e => String(e.name || ''))
  check('file_list recursive returned entries',
    Array.isArray(listRec?.entries) && listRec.entries.length > 0,
    JSON.stringify(listRec))
  check('file_list recursive included hello.txt',
    recNames.some(n => /hello\.txt$/.test(n)),
    `entries: ${JSON.stringify(recNames)}`)
  check('file_list recursive included grepme.txt',
    recNames.some(n => /grepme\.txt$/.test(n)),
    `entries: ${JSON.stringify(recNames)}`)

  // 9) code_execute (Python) → relative file write inside the override folder
  console.log('\n— code_execute (Python) —')
  const pyRes = await agentTool(base, token, chatId, 'code_execute', {
    code: "import os; open('from-python.txt','w').write('hi'); print(os.getcwd())",
    timeout: 30000,
  })
  check('code_execute returned object', pyRes && typeof pyRes === 'object',
    JSON.stringify(pyRes))
  check('code_execute exitCode 0',
    pyRes?.exitCode === 0,
    `exitCode=${pyRes?.exitCode} stderr=${pyRes?.stderr}`)
  if (typeof pyRes?.stdout === 'string') {
    console.log(`     python cwd: ${pyRes.stdout.trim()}`)
    check('code_execute cwd is NOT ~/agent-workspace/__remote__/',
      !pyRes.stdout.replaceAll('\\', '/').includes('agent-workspace/__remote__'),
      `stdout was ${pyRes.stdout}`)
  }
  // Confirm via file_read that python's relative write landed in the override
  const pyReadBack = await agentTool(base, token, chatId, 'file_read', {
    path: 'from-python.txt',
  })
  check('python-written file is readable via the override workspace',
    pyReadBack?.content === 'hi',
    JSON.stringify(pyReadBack))

  // 10) get_current_time — no permissions, no path arg, should always work
  console.log('\n— get_current_time —')
  const timeRes = await agentTool(base, token, chatId, 'get_current_time', {})
  const hasTimeShape = timeRes && (typeof timeRes.iso === 'string' ||
    typeof timeRes.iso_local === 'string' || typeof timeRes.iso_utc === 'string' ||
    typeof timeRes.timestamp === 'number' || typeof timeRes.unix === 'number' ||
    typeof timeRes.now === 'string' || typeof timeRes.utc === 'string')
  check('get_current_time returned a time-shaped object', hasTimeShape,
    JSON.stringify(timeRes))

  // 11) system_info — no permissions, returns hardware/OS facts
  console.log('\n— system_info —')
  const sysRes = await agentTool(base, token, chatId, 'system_info', {})
  check('system_info returned object', sysRes && typeof sysRes === 'object',
    JSON.stringify(sysRes))
  check('system_info has at least one expected field',
    sysRes && (sysRes.os || sysRes.platform || sysRes.cpu || sysRes.osName),
    JSON.stringify(sysRes))

  // 12) image_generate → expected to return graceful "desktop only" error
  console.log('\n— image_generate (graceful unsupported) —')
  const imgRes = await agentTool(base, token, chatId, 'image_generate', {
    prompt: 'placeholder',
  })
  check('image_generate returned object', imgRes && typeof imgRes === 'object',
    JSON.stringify(imgRes))
  check('image_generate returned a graceful error string (not an HTTP 500)',
    typeof imgRes?.error === 'string' && /desktop|create tab/i.test(imgRes.error),
    JSON.stringify(imgRes))

  // 13) Bug-1 regression — file_write to a NESTED relative path that doesn't
  // exist yet. Auto-create-parent must work, AND the resolved path must NOT
  // contain agent-workspace/__remote__.
  console.log('\n— file_write deep nested (Bug 1 regression) —')
  const deep = await agentTool(base, token, chatId, 'file_write', {
    path: 'remote-smoke/a/b/c/deep.txt',
    content: 'auto-created parents\n',
  })
  check('deep file_write status=saved', deep?.status === 'saved',
    JSON.stringify(deep))
  check('deep file_write path is NOT under agent-workspace/__remote__/',
    typeof deep?.path === 'string' &&
    !deep.path.replaceAll('\\', '/').includes('agent-workspace/__remote__'),
    `path was ${deep?.path}`)

  // 14) Wrong-arg shape → should come back as a clean {error} (graceful 200),
  // NOT an HTTP 500. This is the contract the mobile JS depends on.
  console.log('\n— graceful error shape —')
  const bad = await agentTool(base, token, chatId, 'file_read', {
    path: '',
  })
  check('missing-path file_read returns {error} string',
    typeof bad?.error === 'string',
    JSON.stringify(bad))

  console.log(`\n[remote-smoke] ${passed} passed, ${failed} failed.`)
  exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[remote-smoke] fatal:', err)
  exit(2)
})
