/**
 * Test-Driven Loop (Sprint B #4) — runner detection + output parsing.
 *
 * Pure helpers: no shell, no fetch. The `run_tests` builtin tool calls
 * these on the bridge's `shell_execute` result so the model gets a
 * structured payload — pass/fail counts, failing test names, a clipped
 * tail of the runner output — instead of an opaque stdout dump.
 */

export type Runner = 'vitest' | 'cargo' | 'pytest' | 'jest' | 'node' | 'unknown'

export interface ParsedTestRun {
  runner: Runner
  passed: boolean
  total: number
  passedCount: number
  failedCount: number
  failedTests: string[]
  /** Last ~40 lines of runner output for the model — full log when small. */
  outputTail: string
}

/**
 * Picks a runner from the contents of the working directory. Heuristic
 * order: vitest > jest > cargo > pytest. The caller decides whether to
 * use it or override via the tool argument.
 */
export function detectRunnerFromFiles(filenames: string[]): Runner {
  const set = new Set(filenames.map((f) => f.toLowerCase()))
  if (set.has('vitest.config.ts') || set.has('vitest.config.js')) return 'vitest'
  if (set.has('cargo.toml')) return 'cargo'
  if (set.has('jest.config.js') || set.has('jest.config.ts')) return 'jest'
  if (set.has('pyproject.toml') || set.has('pytest.ini') || set.has('setup.cfg')) return 'pytest'
  if (set.has('package.json')) {
    // package.json without an explicit runner — assume vitest since LU
    // itself uses vitest; consumers can override per-call.
    return 'vitest'
  }
  return 'unknown'
}

/**
 * Returns the shell command for a runner. Caller is responsible for cwd.
 * We use `--no-color` flags where they exist to keep parser regex simple.
 */
export function commandForRunner(runner: Runner): string {
  switch (runner) {
    case 'vitest':
      return 'pnpm exec vitest run --reporter=verbose --no-color'
    case 'jest':
      return 'npx jest --colors=false'
    case 'cargo':
      return 'cargo test --color never'
    case 'pytest':
      return 'pytest -v --color=no'
    default:
      return ''
  }
}

function tailLines(s: string, n: number): string {
  const lines = s.split('\n')
  if (lines.length <= n) return s
  return lines.slice(-n).join('\n')
}

// ── Parsers ─────────────────────────────────────────────────────────

/**
 * Vitest summary lines look like:
 *   Test Files  3 failed | 100 passed (103)
 *   Tests       5 failed | 2249 passed (2254)
 *   ❯ src/foo.test.ts > module > some test name
 */
export function parseVitest(out: string): ParsedTestRun {
  const lines = out.split('\n')
  let passedCount = 0
  let failedCount = 0
  for (const line of lines) {
    const m = line.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i)
    if (m) {
      failedCount = m[1] ? parseInt(m[1], 10) : 0
      passedCount = parseInt(m[2], 10)
      break
    }
  }
  const failedTests: string[] = []
  for (const line of lines) {
    // The verbose vitest reporter prefixes failures with × or ✗ or FAIL.
    const m = line.match(/^\s*(?:×|✗|FAIL)\s+(.+?)(?:\s+\d+ms)?$/)
    if (m && m[1]) failedTests.push(m[1].trim())
  }
  const total = passedCount + failedCount
  return {
    runner: 'vitest',
    passed: failedCount === 0 && total > 0,
    total,
    passedCount,
    failedCount,
    failedTests,
    outputTail: tailLines(out, 40),
  }
}

/**
 * Cargo summary:
 *   test result: ok. 80 passed; 0 failed; 0 ignored; 0 measured
 *   test commands::repo_map::tests::pagerank_handles_empty_graph ... ok
 *   test commands::repo_map::tests::pagerank_handles_empty_graph ... FAILED
 */
export function parseCargo(out: string): ParsedTestRun {
  let passedCount = 0
  let failedCount = 0
  const lines = out.split('\n')
  for (const line of lines) {
    const m = line.match(/test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/)
    if (m) {
      passedCount = parseInt(m[1], 10)
      failedCount = parseInt(m[2], 10)
      break
    }
  }
  const failedTests: string[] = []
  for (const line of lines) {
    const m = line.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED/)
    if (m) failedTests.push(m[1])
  }
  const total = passedCount + failedCount
  return {
    runner: 'cargo',
    passed: failedCount === 0 && total > 0,
    total,
    passedCount,
    failedCount,
    failedTests,
    outputTail: tailLines(out, 40),
  }
}

/**
 * Pytest summary:
 *   ===== 12 passed, 1 failed in 0.42s =====
 *   FAILED tests/test_foo.py::test_bar - AssertionError: ...
 */
export function parsePytest(out: string): ParsedTestRun {
  let passedCount = 0
  let failedCount = 0
  const lines = out.split('\n')
  for (const line of lines) {
    const pm = line.match(/(\d+)\s+passed/)
    const fm = line.match(/(\d+)\s+failed/)
    if (pm) passedCount = parseInt(pm[1], 10)
    if (fm) failedCount = parseInt(fm[1], 10)
    if (pm || fm) break
  }
  const failedTests: string[] = []
  for (const line of lines) {
    const m = line.match(/^FAILED\s+(\S+?)(?:\s+-.*)?$/)
    if (m) failedTests.push(m[1])
  }
  const total = passedCount + failedCount
  return {
    runner: 'pytest',
    passed: failedCount === 0 && total > 0,
    total,
    passedCount,
    failedCount,
    failedTests,
    outputTail: tailLines(out, 40),
  }
}

/**
 * Node's built-in runner (`node --test`, often behind `npm test`):
 *   ℹ tests 6        (spec reporter)    # tests 6   (TAP reporter)
 *   ℹ pass 6                            # pass 6
 *   ℹ fail 0                            # fail 0
 *   ✖ evicts the least recently used (1.2ms)     not ok 3 - evicts …
 */
export function parseNodeTest(out: string): ParsedTestRun {
  const count = (name: string) => {
    const m = out.match(new RegExp(`^\\s*[ℹ#]\\s*${name}\\s+(\\d+)\\s*$`, 'm'))
    return m ? parseInt(m[1], 10) : 0
  }
  const passedCount = count('pass')
  const failedCount = count('fail')
  const total = Math.max(count('tests'), passedCount + failedCount)
  const failedTests: string[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(?:✖\s+(.+?)(?:\s+\([\d.]+ms\))?|not ok \d+ - (.+))$/)
    const name = m && (m[1] ?? m[2])
    if (name && !/^failing tests:?$/i.test(name.trim()) && !failedTests.includes(name.trim())) failedTests.push(name.trim())
  }
  return {
    runner: 'node',
    passed: failedCount === 0 && total > 0,
    total,
    passedCount,
    failedCount,
    failedTests,
    outputTail: tailLines(out, 40),
  }
}

/**
 * The runner read off the output, for a command that does not name one
 * (`npm test`, `make test`). A green `node --test` behind `npm test` was
 * headed "NO TESTS / UNPARSEABLE (unknown): 0/0" (CA bench CO10, 14.11.).
 */
export function sniffRunner(out: string): Runner {
  if (/^\s*[ℹ#]\s*(?:tests|pass)\s+\d+\s*$/m.test(out)) return 'node'
  if (/test result:\s+\w+\.\s+\d+\s+passed/.test(out)) return 'cargo'
  if (/^\s*Tests\s+(?:\d+\s+failed\s*\|\s*)?\d+\s+passed/m.test(out)) return 'vitest'
  if (/^=+ .*\d+ (?:passed|failed).* =+$/m.test(out)) return 'pytest'
  return 'unknown'
}

export function parseForRunner(runner: Runner, out: string): ParsedTestRun {
  if (runner === 'unknown') runner = sniffRunner(out)
  switch (runner) {
    case 'node':
      return parseNodeTest(out)
    case 'vitest':
    case 'jest':
      return { ...parseVitest(out), runner }
    case 'cargo':
      return parseCargo(out)
    case 'pytest':
      return parsePytest(out)
    default:
      return {
        runner: 'unknown',
        passed: false,
        total: 0,
        passedCount: 0,
        failedCount: 0,
        failedTests: [],
        outputTail: tailLines(out, 40),
      }
  }
}

/** Renders a ParsedTestRun as a string for the model. Compact + greppable. */
export function renderResult(r: ParsedTestRun, exitCode?: number | null): string {
  // No summary found: the exit code is the only honest verdict left. "NO
  // TESTS" over a run that printed six green ticks sent models back to run
  // the tests again.
  const head = r.total === 0 && typeof exitCode === 'number'
    ? exitCode === 0
      ? 'RAN (exit 0): the test summary was not recognised, read the output below.'
      : `FAILED (exit ${exitCode}): the test summary was not recognised, read the output below.`
    : `${r.passed ? 'PASSED' : r.total === 0 ? 'NO TESTS / UNPARSEABLE' : 'FAILED'} (${r.runner}): ${r.passedCount}/${r.total} passed, ${r.failedCount} failed.`
  const failed = r.failedTests.length
    ? `\nFailing tests:\n${r.failedTests.map((t) => `- ${t}`).join('\n')}`
    : ''
  const tail = r.outputTail ? `\n---\n${r.outputTail}` : ''
  return `${head}${failed}${tail}`
}
