/**
 * The plan bar reports the MODEL's progress. In Stage-and-Approve the writes
 * still sit in the queue, so "every step done" on its own reads as "your files
 * are written" when nothing was. Morgan (2026-08-11) saw exactly that: plan
 * 6 of 6, every step done, and six file changes that had all been refused.
 *
 * Since 2.6.6 C2 the coding tab shows this in the right-hand panel instead of
 * above the prompt, so the same claims are now tested on the panel variant:
 * the staged-changes coupling and the clear button moved with it. Since
 * 2026-08-22 the panel section sits at the BOTTOM of that column, the LU tab
 * shows its plan in the header band, and no composer anywhere carries a plan.
 * The invariant behind that lives in
 * the-prompt-window-is-the-prompt-window.test.ts; what is checked here is that
 * the Morgan warning survived both moves.
 *
 * Run: npx vitest run src/components/chat/__tests__/plan-done-vs-applied.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { planDoneLabel } from '../PlanBar'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('planDoneLabel', () => {
  it('says done, plainly, when nothing is waiting', () => {
    expect(planDoneLabel(0)).toBe('every step done')
  })

  it('names the changes that still need approval', () => {
    expect(planDoneLabel(1)).toBe('every step done, 1 change still waiting for your approval')
    expect(planDoneLabel(6)).toBe('every step done, 6 changes still waiting for your approval')
  })
})

describe('the bar reads the staging queue', () => {
  it('PlanBar subscribes to stagedChangesStore', () => {
    const src = read('../PlanBar.tsx')
    expect(src).toMatch(/useStagedChangesStore/)
    expect(src).toMatch(/planDoneLabel\(pending\)/)
  })

  it('the warning survives the panel, where the list is open by default', () => {
    const src = read('../PlanBar.tsx')
    // Collapsed-only would have hidden the Morgan line in the panel, because
    // the panel starts expanded.
    expect(src).toMatch(/\(panel \|\| !expanded\) && allDone/)
    expect(src).toMatch(/useState\(panel\)/)
  })
})

describe('the plan moved into the panel (C2)', () => {
  it('PlanBar has a panel variant and a header variant, no composer one', () => {
    const src = read('../PlanBar.tsx')
    expect(src).toMatch(/variant = 'header'/)
    expect(src).toMatch(/panel = variant === 'panel'/)
    // The old 70% wrapper was the composer's; in a 280px column it squeezed the
    // plan into a third of the panel, and at the prompt box it had no business
    // being at all. The panel therefore still owns its full column width and
    // must never pick up a measure or a percentage.
    expect(src).toMatch(/panel \? 'w-full p-1\.5'/)
    const panelBranch = src.slice(src.indexOf("panel ? 'w-full p-1.5'"))
    expect(panelBranch.slice(0, panelBranch.indexOf(':'))).not.toMatch(/max-w-|70%/)
    // The header band, by contrast, sits directly above the transcript and
    // rides the SAME measure column and gutter as the bubbles (design wave 1) —
    // a status band running the full window width above 760px of answers read
    // as a second layout stacked on the first.
    expect(src).toMatch(/mx-auto w-full max-w-\[var\(--lu-measure\)\] px-3 pt-1/)
  })

  it('the clear button and the staged count came along, unchanged', () => {
    const src = read('../PlanBar.tsx')
    expect(src).toMatch(/clearTodos\(activeConversationId\)/)
    expect(src).toMatch(/s\.byChat\[activeConversationId\]\?\.length \?\? 0/)
  })

  it('the coding composer carries no plan, not even the approval card', () => {
    const src = read('../CodexView.tsx')
    // C1 had put the plan APPROVAL card here (a button plus the plan text the
    // user is approving). It went down into the panel too on 2026-08-22: the
    // prompt window is the prompt window.
    expect(src).toMatch(/composerAbove=\{<><LoopBar onStop=\{stopCodex\} \/><GoalBar \/><\/>\}/)
    expect(src).not.toMatch(/PlanBar/)
    expect(src).not.toMatch(/PlanApprovalBar/)
  })

  it('the panel renders it, below the tree', () => {
    const src = read('../ExplorerPanel.tsx')
    expect(src).toMatch(/<PlanBar variant="panel" \/>/)
    const plan = src.indexOf('<PlanBar variant="panel" />')
    const tree = src.indexOf('{rows.map((row) => {')
    expect(plan).toBeGreaterThan(-1)
    expect(plan).toBeGreaterThan(tree)
  })

  it('and the chat tab shows it in the header band, not at its composer', () => {
    // The Chat and Agent surface has no right-hand column, so the plan sits
    // with the standing status controls above the transcript instead.
    const src = read('../ChatView.tsx')
    expect(src).toMatch(/<PlanBar \/>/)
    expect(src.indexOf('<PlanBar />')).toBeLessThan(src.indexOf('<MessageList'))
  })
})
