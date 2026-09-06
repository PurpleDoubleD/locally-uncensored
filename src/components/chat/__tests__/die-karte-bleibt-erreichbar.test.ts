/**
 * t10 on the box (2026-09-06, GLM 5.3, Plan mode, "Approve and run (Ask)"):
 * two staged files filled the whole coding column, the transcript below shrank
 * to a height of zero, and the shell approval card of step 3 sat behind the
 * composer where no scroll could reach it. The run waited 15 minutes on
 * "Waiting for your approval" and the customer read it as "stuck at step 2".
 *
 * Four source contracts keep that from coming back:
 *   1. the Pending list is capped and scrolls inside itself,
 *   2. the transcript keeps a floor,
 *   3. the approval card scrolls itself into view when it appears,
 *   4. the Bypass description does not promise a cloud confirm that is off by
 *      default (settings.codexCloudConfirmOptIn = false).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')

describe('the approval card stays reachable', () => {
  it('caps the Pending list inside the column and lets it scroll on its own', () => {
    const src = read('../StagedChangesPanel.tsx')
    const list = src.slice(src.indexOf('data-testid="staged-changes-list"') - 200, src.indexOf('data-testid="staged-changes-list"'))
    expect(list).toMatch(/max-h-\[40vh\]/)
    expect(list).toMatch(/overflow-y-auto/)
    // The panel itself never grows at the transcript's expense.
    expect(src).toMatch(/className="shrink-0 border-b[^"]*" data-testid="staged-changes-panel"/)
  })

  it('gives the transcript a floor so no side panel can squeeze it to nothing', () => {
    const src = read('../CodexView.tsx')
    expect(src).toMatch(/ref=\{scrollRef\} className="flex-1 min-h-\[10rem\] overflow-y-auto[^"]*" data-testid="codex-transcript"/)
  })

  it('scrolls the approval card into view the moment it exists', () => {
    const src = read('../CodexConfirmDialog.tsx')
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(pending\) card\.current\?\.scrollIntoView\(\{ block: 'nearest' \}\)\s*\}, \[pending\]\)/)
    expect(src).toMatch(/<div ref=\{card\} className="px-1 py-0\.5" data-codex-confirm>/)
  })

  it('does not describe Bypass with a cloud confirm that is off by default', () => {
    const modes = read('../../../lib/codex-mode.ts')
    expect(modes).not.toMatch(/Cloud shell still confirms/)
    expect(modes).toMatch(/bypass: 'Run without asking\. Commands and edits land as they come'/)
    const defaults = read('../../../lib/constants.ts')
    expect(defaults).toMatch(/codexCloudConfirmOptIn: false/)
  })
})
