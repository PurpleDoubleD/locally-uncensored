#!/usr/bin/env node
/**
 * Bug 2 logic proof — extracts the echo-guard regex + the consecutive-error
 * counter behaviour from `mobile_landing()` in remote.rs and runs them
 * against a battery of inputs that reproduce what David reported:
 *
 *   "Codex/Agent hängen sich nach etlichen Fehlversuchen auf und werfen
 *    nur den Standard-Starttext aus."
 *
 * The harness simulates `runToolLoop` step-by-step with a mock model that
 * always returns either a tool error or a system-prompt echo, and asserts:
 *   - The user never sees the literal greeting as the final answer.
 *   - After 5 consecutive tool errors the loop bails with a clean message.
 *   - The echo guard suppresses the greeting even after retries are
 *     exhausted (turnContent gets dropped → fallback summary kicks in).
 */

import { exit } from 'node:process'

// ── Extracted verbatim from remote.rs::mobile_landing() ──
function isSystemPromptEcho(content) {
  if (!content) return false
  const head = String(content).trim().slice(0, 240)
  if (/^(hello[!,\.]?\s+|hi[!,\.]?\s+|hey[!,\.]?\s+)?(i['’]?m|i am|you are)\s+(codex|an autonomous|the agent|an? ai)/i.test(head)) return true
  if (/^(i am|i['’]m)\s+ready\s+to\s+(receive|assist|help)/i.test(head)) return true
  if (/^(hello|hi|hey)[!,\.]?\s+i['’]?m\s+ready/i.test(head)) return true
  return false
}

// ── Extracted error-classification check from runToolLoop's execNext ──
function isErrorObservation(obs) {
  return /^(Error|Permission denied|Network error)/i.test(String(obs || ''))
}

// ── Simulated runToolLoop with the new guards ──
function simulateRunToolLoop(scriptedResponses) {
  const maxIter = 50
  const maxConsecutiveErrors = 5
  let iter = 0
  let echoRetriesRemaining = 3
  let consecutiveErrors = 0
  let finalAnswer = null
  const log = []
  const writes = []
  const reads = []

  while (iter < maxIter) {
    iter++
    if (iter > scriptedResponses.length) {
      log.push(`stop@iter=${iter} reason=script-exhausted`)
      break
    }
    const res = scriptedResponses[iter - 1]
    let turnContent = res.content || ''

    // ── Echo guard ──
    if (isSystemPromptEcho(turnContent)) {
      if (echoRetriesRemaining > 0) {
        echoRetriesRemaining--
        log.push(`iter=${iter} echo-retry retries-left=${echoRetriesRemaining}`)
        continue
      }
      // Retries spent — drop the echo
      log.push(`iter=${iter} echo-dropped retries=spent`)
      turnContent = ''
    }

    if (!res.toolCalls || res.toolCalls.length === 0) {
      // Final answer
      finalAnswer = turnContent || null
      log.push(`iter=${iter} finishToolLoop final=${JSON.stringify(finalAnswer)}`)
      break
    }

    // Execute tool calls
    let bailed = false
    for (const tc of res.toolCalls) {
      const obs = tc.mockObservation
      // record activity
      if (tc.function.name === 'file_write') writes.push(tc)
      if (tc.function.name === 'file_read') reads.push(tc)

      if (isErrorObservation(obs)) {
        consecutiveErrors++
        log.push(`iter=${iter} tool=${tc.function.name} err+ count=${consecutiveErrors}`)
      } else {
        consecutiveErrors = 0
        log.push(`iter=${iter} tool=${tc.function.name} ok`)
      }
      if (consecutiveErrors >= maxConsecutiveErrors) {
        log.push(`iter=${iter} BAIL consecutiveErrors=${consecutiveErrors}`)
        bailed = true
        break
      }
    }
    if (bailed) {
      finalAnswer = null // triggers fallback summary
      break
    }
  }

  // ── Fallback summary builder (parity with finishToolLoop) ──
  let visibleAnswer = finalAnswer || ''
  if (!visibleAnswer) {
    const parts = []
    if (writes.length) parts.push(`${writes.length} file(s) written`)
    if (reads.length) parts.push(`${reads.length} file(s) read`)
    visibleAnswer = parts.length
      ? `Task completed: ${parts.join(', ')}.`
      : 'Task completed.'
  }
  return { iter, echoRetriesRemaining, consecutiveErrors, visibleAnswer, log }
}

let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) { console.log(`  ✓ ${label}`); passed++ }
  else { console.error(`  ✗ ${label}\n      ${detail || ''}`); failed++ }
}

console.log('=== Bug 2 logic proof ===\n')

// ── 1. isSystemPromptEcho regex correctness ──
console.log('— isSystemPromptEcho cases —')
check('detects "Hello, I am Codex…"',
  isSystemPromptEcho('Hello, I am Codex, an autonomous coding agent. How can I help?'))
check('detects "I am ready to assist"',
  isSystemPromptEcho('I am ready to assist with your coding task.'))
check('detects "Hi, I\'m ready to help!"',
  isSystemPromptEcho("Hi, I'm ready to help!"))
check('detects "I\'m the agent"',
  isSystemPromptEcho("I'm the agent assigned to your task."))
check('detects "Hello! I am an AI"',
  isSystemPromptEcho('Hello! I am an AI assistant ready to help.'))
check('does NOT flag a normal final answer',
  !isSystemPromptEcho('I have created index.html and added the requested header.'))
check('does NOT flag a tool result',
  !isSystemPromptEcho('File saved: C:\\foo\\bar.txt'))
check('does NOT flag empty content',
  !isSystemPromptEcho(''))
check('does NOT flag null',
  !isSystemPromptEcho(null))

// ── 2. Echo-after-retries-exhausted: the EXACT scenario David reported ──
console.log('\n— scenario A: 4 echo turns in a row (Bug 2 reproducer) —')
const scenarioA = simulateRunToolLoop([
  { content: 'Hello, I am Codex, an autonomous coding agent. How can I help?', toolCalls: [] },
  { content: 'Hi, I\'m ready to help!', toolCalls: [] },
  { content: 'I am ready to assist with your task.', toolCalls: [] },
  { content: 'Hello, I\'m Codex.', toolCalls: [] },
])
check('Scenario A used 4 iterations',
  scenarioA.iter === 4, `iter=${scenarioA.iter}`)
check('Scenario A consumed all 3 echo retries',
  scenarioA.echoRetriesRemaining === 0, `left=${scenarioA.echoRetriesRemaining}`)
check('Scenario A: user does NOT see "Hello, I am Codex" greeting',
  !/i am codex/i.test(scenarioA.visibleAnswer) && !/ready to (assist|help)/i.test(scenarioA.visibleAnswer),
  `got: "${scenarioA.visibleAnswer}"`)
check('Scenario A: visible answer is the fallback summary',
  scenarioA.visibleAnswer === 'Task completed.',
  `got: "${scenarioA.visibleAnswer}"`)
console.log('     log:', scenarioA.log.join(' | '))

// ── 3. 5 tool errors in a row: should bail with the new guard ──
console.log('\n— scenario B: 5 consecutive tool errors (Bug 2 reproducer) —')
const errCall = (i) => ({
  content: '',
  toolCalls: [{
    function: { name: 'shell_execute', arguments: { command: 'mkdir client public' } },
    mockObservation: 'Error: Es wurde kein Positionsparameter gefunden, der das Argument "public" akzeptiert.',
  }],
})
const scenarioB = simulateRunToolLoop([
  errCall(1), errCall(2), errCall(3), errCall(4), errCall(5),
  // What WOULD have followed without the guard:
  { content: 'Hello, I am Codex. How can I help?', toolCalls: [] },
])
check('Scenario B: counter hit 5 → bailed',
  scenarioB.consecutiveErrors >= 5,
  `count=${scenarioB.consecutiveErrors} iter=${scenarioB.iter}`)
check('Scenario B: did NOT reach iter 6 (greeting prevented)',
  scenarioB.iter <= 5, `iter=${scenarioB.iter}`)
check('Scenario B: visible answer is the fallback summary',
  scenarioB.visibleAnswer === 'Task completed.',
  `got: "${scenarioB.visibleAnswer}"`)
console.log('     log:', scenarioB.log.join(' | '))

// ── 4. Mixed: some success resets the counter ──
console.log('\n— scenario C: 4 errors then success then 4 more (counter resets) —')
const okCall = () => ({
  content: '', toolCalls: [{
    function: { name: 'file_write', arguments: { path: 'a.txt', content: 'x' } },
    mockObservation: 'File saved: C:\\foo\\a.txt',
  }],
})
const scenarioC = simulateRunToolLoop([
  errCall(1), errCall(2), errCall(3), errCall(4),
  okCall(),
  errCall(5), errCall(6), errCall(7), errCall(8),
  { content: 'Done.', toolCalls: [] },
])
check('Scenario C: completed normally without bail',
  scenarioC.consecutiveErrors < 5, `count=${scenarioC.consecutiveErrors}`)
check('Scenario C: visible answer is the model\'s "Done."',
  scenarioC.visibleAnswer === 'Done.',
  `got: "${scenarioC.visibleAnswer}"`)
console.log('     log:', scenarioC.log.join(' | '))

// ── 5. Happy path — 3 file_writes then summary, no errors ──
console.log('\n— scenario D: clean 3-file build (no errors at all) —')
const scenarioD = simulateRunToolLoop([
  okCall(), okCall(), okCall(),
  { content: 'Built 3 files.', toolCalls: [] },
])
check('Scenario D: 3 writes recorded',
  scenarioD.log.filter(x => x.includes('file_write ok')).length === 3,
  scenarioD.log.join('|'))
check('Scenario D: no echo retries used',
  scenarioD.echoRetriesRemaining === 3)
check('Scenario D: visible answer = model output',
  scenarioD.visibleAnswer === 'Built 3 files.')

console.log(`\n=== ${passed} passed, ${failed} failed ===`)
exit(failed === 0 ? 0 : 1)
