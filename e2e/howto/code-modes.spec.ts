import { test, expect } from '@playwright/test'
import { Rec, HOWTO_OUT } from './rec'
import { scriptModel, openCode } from './model'

// How Code works: modes. Captions are the mode dropdown's own descriptions
// (src/lib/codex-mode.ts), the Pending panel (StagedChangesPanel.tsx) and the
// plan card (PlanApprovalBar.tsx).
//
// FIXTURES (said in the report too):
//  - the model's answers are scripted (./model.ts): one turn that writes a
//    file, one closing line, one plan. The rig has no model otherwise.
//  - `files`: the rig's own option for what a file read returns, so the staged
//    edit has something to diff against.
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const BEFORE = 'def greet(name):\n    return "Hello " + name\n'
const AFTER = 'def greet(name="world"):\n    return f"Hello, {name}!"\n'
const PLAN = '## Plan\n1. Read greet.py\n2. Add farewell(name) next to greet\n\n## Check\nRun pytest\n\n## Risk\nCallers that import by position'

test('code-modes', async ({ page }) => {
  test.skip(!HOWTO_OUT, 'set LU_HOWTO_OUT')
  test.setTimeout(120_000)
  const rec = await Rec.boot(page, 'code-modes', 'How Code works: modes', { tauri: { files: { 'greet.py': BEFORE } } })
  await scriptModel(page, [
    { text: 'Adding a default name.', toolCalls: [{ name: 'file_write', args: { path: 'greet.py', content: AFTER } }] },
    { text: 'The edit to greet.py is staged for your review.' },
    { text: PLAN },
  ])
  await openCode(page)

  const composer = page.locator('textarea').first()
  const mode = page.getByRole('main').getByRole('button', { name: /^(Ask|Bypass|Plan)$/ }).first()
  const send = page.getByRole('button', { name: 'Send message' })
  const park = { x: 1040, y: 800 }
  const low = { x: 580, y: 780 } // the composer and the menu that opens above it

  await rec.key()
  rec.scene('Ask confirms commands and lets you review edits before they land.')
  await rec.cam(low, 1.9)
  await rec.click(mode, { dur: 0.7, after: 1.9 })
  await rec.click(page.getByRole('button', { name: /^Ask permissions/ }), { dur: 0.45, after: 0.15 })
  await rec.click(composer, { dur: 0.4, at: { fx: 0.3 }, after: 0.1 })
  await rec.move(park, { dur: 0.3, real: false })
  await rec.type(composer, 'give greet a default name', { cps: 30 })
  await rec.cam({ x: 596, y: 240 }, 1.35, 1.0)
  await rec.click(send, {
    dur: 0.45, after: 0.2,
    until: () => expect(page.getByText('The edit to greet.py is staged')).toBeVisible({ timeout: 30_000 }),
  })

  rec.scene('The edits wait for your review: accept or reject each part, each file, or all at once.')
  await rec.move(page.getByTitle('Accept file'), { dur: 0.7 })
  rec.hold(0.8)
  await rec.move(page.getByTestId('apply-all'), { dur: 0.5 })
  rec.hold(0.8)

  await rec.cam(low, 1.9, 0.9)
  await rec.click(mode, { dur: 0.7, after: 0 })
  rec.scene('Plan mode is read only: it writes a plan, then waits for approval.')
  rec.hold(0.8)
  await rec.click(page.getByRole('button', { name: /^Plan mode/ }), { dur: 0.45, after: 0.15 })
  await rec.move(park, { dur: 0.3, real: false })
  await rec.type(composer, 'plan a farewell function', { cps: 30 })
  await rec.cam({ x: 1270, y: 760 }, 1.8, 1.0)
  await rec.click(send, {
    dur: 0.45, after: 0.3,
    until: () => expect(page.getByTestId('plan-approval-panel')).toBeVisible({ timeout: 30_000 }),
  })

  rec.scene('Approve and run names the mode the plan will run in.')
  await rec.move(page.getByRole('button', { name: /^Approve and run/ }), { dur: 0.7 })
  rec.hold(1.2)
  rec.finish(1.2)
})
