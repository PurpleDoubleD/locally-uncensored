import { appendFileSync } from 'node:fs'
import { stripVTControlCharacters } from 'node:util'
import type { Reporter, TestCase } from '@playwright/test/reporter'

/**
 * CI gives a red test one more try (playwright.config.ts, David's decision for 3.0.9). A test that is red and then
 * green on that try is "flaky", and Playwright's list output says so in one line between 1,700 others. In 3.0.8 that
 * was how two real races (one of them an app bug) went unseen for days. This reporter names every flaky test where
 * it is read: a warning on the run, and a table in the job summary. A run with none says nothing.
 */
export type Flaky = { title: string; file: string; line: number; error: string }

export function flakySummary(flaky: Flaky[]): string {
  if (!flaky.length) return ''
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  return [
    `### ${flaky.length} flaky e2e ${flaky.length === 1 ? 'test' : 'tests'} (red, then green on the CI retry)`,
    '',
    'Each one is a race in the test or in the app. The retry kept the run green; it does not make the finding go away.',
    '',
    '| Test | Where | First error |',
    '|---|---|---|',
    ...flaky.map((f) => `| ${cell(f.title)} | \`${f.file}:${f.line}\` | ${cell(f.error).slice(0, 200)} |`),
    '',
  ].join('\n')
}

export function flakyAnnotation(f: Flaky): string {
  const escape = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  return `::warning file=${f.file},line=${f.line},title=Flaky e2e test::${escape(`${f.title}: ${f.error}`)}`
}

export default class FlakyReport implements Reporter {
  private flaky: Flaky[] = []

  onTestEnd(test: TestCase) {
    // Called once per attempt. After the red first one the outcome is still "unexpected"; the green retry makes it flaky.
    if (test.outcome() !== 'flaky') return
    const first = test.results.find((r) => r.status !== 'passed' && r.status !== 'skipped')
    this.flaky.push({
      title: test.titlePath().filter(Boolean).join(' › '),
      file: test.location.file.replace(`${process.cwd()}/`, ''),
      line: test.location.line,
      error: stripVTControlCharacters(first?.error?.message ?? first?.status ?? 'unknown').split('\n')[0],
    })
  }

  onEnd() {
    if (!this.flaky.length) return
    for (const f of this.flaky) console.log(flakyAnnotation(f))
    const summary = process.env.GITHUB_STEP_SUMMARY
    if (summary) appendFileSync(summary, flakySummary(this.flaky))
  }

  printsToStdio() {
    return false
  }
}
