#!/usr/bin/env node
/**
 * Run the mobile-real-browser test for all 4 mode/transport combos
 * sequentially. Each run gets its own subfolder under scripts/runs/.
 *
 * Reads --code-lan and optionally --code-internet (with --url-internet)
 * from CLI. If --code-internet is missing, only LAN runs.
 *
 * Usage:
 *   node scripts/mobile-all-modes.mjs --code-lan 123456 --base-lan http://192.168.x.y:11435
 *   node scripts/mobile-all-modes.mjs --code-lan 123456 --base-lan ... --code-net 654321 --base-net https://....trycloudflare.com
 */

import { execSync } from 'node:child_process'
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { argv, exit } from 'node:process'

function args() {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--code-lan') out.codeLan = argv[++i]
    else if (a === '--base-lan') out.baseLan = argv[++i]
    else if (a === '--code-net') out.codeNet = argv[++i]
    else if (a === '--base-net') out.baseNet = argv[++i]
    else if (a === '--task') out.task = argv[++i]
    else if (a === '--headed') out.headed = true
  }
  return out
}

const RUNS = []

function runOne(label, mode, baseUrl, code, taskOverride, headed) {
  const url = baseUrl.endsWith('/mobile') ? baseUrl : (baseUrl.replace(/\/$/, '') + '/mobile')
  const outDir = `scripts/runs/${label}`
  rmSync(outDir, { recursive: true, force: true })
  rmSync('scripts/mobile-run', { recursive: true, force: true })

  let cmd = `node scripts/mobile-real-browser.mjs --url "${url}" --code ${code} --mode ${mode}`
  if (taskOverride) cmd += ` --task ${JSON.stringify(taskOverride)}`
  if (headed) cmd += ' --headed'

  console.log(`\n━━━━━━━━━━ ${label} ━━━━━━━━━━`)
  console.log(`  cmd: ${cmd}`)
  let exitCode = 0
  let logBuf = ''
  try {
    logBuf = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    exitCode = e.status ?? 2
    logBuf = (e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '')
  }
  // Move artefacts
  if (existsSync('scripts/mobile-run')) {
    renameSync('scripts/mobile-run', outDir)
  } else {
    mkdirSync(outDir, { recursive: true })
  }
  writeFileSync(`${outDir}/runner.log`, logBuf)

  // Pull summary
  const summary = existsSync(`${outDir}/summary.json`)
    ? JSON.parse(readFileSync(`${outDir}/summary.json`, 'utf8'))
    : { error: 'no summary.json' }
  RUNS.push({ label, mode, baseUrl, exitCode, summary })
  console.log(`  → ${exitCode === 0 ? 'OK' : 'FAIL'}, tools: ${JSON.stringify(summary.toolCallsByName || {})}, calls: ${summary.toolCallCount || 0}`)
}

function main() {
  const a = args()
  if (!a.codeLan || !a.baseLan) { console.error('Need --code-lan and --base-lan'); exit(2) }

  // Run order: Agent-LAN, Codex-LAN, Agent-Net, Codex-Net
  runOne('agent-lan', 'agent', a.baseLan, a.codeLan, a.task, a.headed)
  runOne('codex-lan', 'codex', a.baseLan, a.codeLan, a.task, a.headed)
  if (a.codeNet && a.baseNet) {
    runOne('agent-net', 'agent', a.baseNet, a.codeNet, a.task, a.headed)
    runOne('codex-net', 'codex', a.baseNet, a.codeNet, a.task, a.headed)
  }

  // ── Summary table ──
  console.log('\n\n╔════════════════════════════════════════════════════════════════╗')
  console.log('║                     ALL-MODES SUMMARY                          ║')
  console.log('╚════════════════════════════════════════════════════════════════╝')
  for (const r of RUNS) {
    const tools = Object.keys(r.summary?.toolCallsByName || {}).sort()
    console.log(`\n[${r.label}] mode=${r.mode}`)
    console.log(`  exit:        ${r.exitCode}`)
    console.log(`  toolCount:   ${r.summary?.toolCallCount || 0}`)
    console.log(`  toolsByName: ${JSON.stringify(r.summary?.toolCallsByName || {})}`)
    console.log(`  uniqueTools: ${tools.length} (${tools.join(', ')})`)
    console.log(`  elapsedMs:   ${r.summary?.elapsedMs}`)
    console.log(`  consoleErr:  ${r.summary?.consoleErrors || 0}`)
  }
  writeFileSync('scripts/runs/summary.json', JSON.stringify(RUNS, null, 2))
  console.log(`\nFull artefacts at scripts/runs/`)
}

main()
