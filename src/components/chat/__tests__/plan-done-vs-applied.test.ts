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
  // David, 14.11.2026: a plan that is through shows its count and the greyed
  // list, no tick and no "every step done". The Morgan line stays.
  it('says nothing more when nothing is waiting', () => {
    expect(planDoneLabel(0)).toBeNull()
  })

  it('names the changes that still need approval', () => {
    expect(planDoneLabel(1)).toBe('1 change still waiting for your approval')
    expect(planDoneLabel(6)).toBe('6 changes still waiting for your approval')
  })
})

describe('the bar reads the staging queue', () => {
  it('PlanBar subscribes to stagedChangesStore', () => {
    const src = read('../PlanBar.tsx')
    expect(src).toMatch(/useStagedChangesStore/)
    expect(src).toMatch(/planDoneLabel\(pending\)/)
  })

  it('the warning stands under the list whatever its fold, once the run is over', () => {
    const src = read('../PlanBar.tsx')
    // Collapsed-only once hid the Morgan line where the list started open.
    // Since CA (13.11.2026) the closing box hangs on the run, not on the fold.
    expect(src).toMatch(/\{!runActive && allDone && waiting && \(/)
  })
})

describe('the plan is pinned under the newest message (CA, 13.11.2026)', () => {
  // C2 (2.6.6) moved it into the Code panel, 2026-08-22 put it at the bottom of
  // that column and into a header band on the LU tab. David, 13.11.2026: like
  // the Claude Code desktop app, under the newest message, in both tabs. The
  // invariant that it never enters the prompt window lives in
  // the-prompt-window-is-the-prompt-window.test.ts.
  it('the clear button and the staged count came along, unchanged', () => {
    const src = read('../PlanBar.tsx')
    expect(src).toMatch(/clearTodos\(conversationId\)/)
    expect(src).toMatch(/s\.byChat\[conversationId\]\?\.length \?\? 0/)
  })

  it('the coding composer carries no plan', () => {
    const src = read('../CodexView.tsx')
    expect(src).not.toMatch(/composerAbove/)
    expect(src).toMatch(/<LoopBar onStop=\{stopCodex\} \/>/)
    expect(src).toMatch(/<GoalBar \/>/)
    expect(src).not.toMatch(/PlanApprovalBar/)
  })

  it('the Code tab renders it after the run anchor, inside the transcript', () => {
    const src = read('../CodexView.tsx')
    const anchor = src.indexOf('<WorkingAnchor')
    const plan = src.indexOf('<PlanBar conversationId={activeConversationId}')
    expect(plan).toBeGreaterThan(anchor)
    expect(src.indexOf('<ChatInput')).toBeGreaterThan(plan)
  })

  it('the LU tab renders it at the end of MessageList, not in a band above', () => {
    const list = read('../MessageList.tsx')
    expect(list.indexOf('<PlanBar conversationId={conversation.id}')).toBeGreaterThan(list.indexOf('<WorkingAnchor'))
    expect(read('../ChatView.tsx')).not.toMatch(/<PlanBar\b/)
  })

  it('and the right column no longer repeats it', () => {
    const src = read('../ExplorerPanel.tsx')
    expect(src).not.toMatch(/<PlanBar\b/)
    expect(src).toMatch(/<PlanApprovalBar onApprove=\{onApprovePlan\} \/>/)
  })
})
