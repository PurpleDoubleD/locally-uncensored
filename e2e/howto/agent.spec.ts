import { test, expect } from '@playwright/test'
import { Rec, HOWTO_OUT } from './rec'
import { scriptModel, openChat } from './model'

// How Agent works. Captions are the workspace card's own words
// (WorkspaceAskCard.tsx), the per-chat Tools menu (PermissionOverrideBar.tsx)
// and the approval strip (ApprovalDialog.tsx).
//
// Since 3.1.2 the switch opens no dialog: the first message waits in the chat
// under the card "Where should I work?", and after Sandbox it goes out.
//
// FIXTURES (said in the report too):
//  - the model's answer is scripted (./model.ts): one turn that asks for a
//    shell command. The approval strip that follows is the app's own.
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test('agent', async ({ page }) => {
  test.skip(!HOWTO_OUT, 'set LU_HOWTO_OUT')
  test.setTimeout(120_000)
  const rec = await Rec.boot(page, 'agent', 'How Agent works')
  await scriptModel(page, [
    { text: 'I will list the folder first.', toolCalls: [{ name: 'shell_execute', args: { command: 'ls -la' } }] },
    { text: 'Done.' },
  ])
  const toggle = await openChat(page)

  const composer = page.locator('textarea').first()
  const send = page.getByRole('button', { name: 'Send message' })
  const card = page.getByTestId('workspace-ask')
  const park = { x: 1200, y: 812 }
  const low = { x: 757, y: 740 }

  await rec.key()
  rec.scene('Turn Agent on at the start of a chat.')
  await rec.cam(low, 1.5)
  await rec.click(toggle, {
    dur: 0.9, after: 0.6,
    until: () => expect(toggle).toHaveAttribute('title', /Agent Mode is on/i),
  })

  rec.scene('Tools switches tool categories on or off for this chat only.')
  await rec.click(page.getByRole('button', { name: /^Tools/ }), { dur: 0.6, after: 0.9 })
  await rec.click(page.getByRole('button', { name: 'Video', exact: true }), { dur: 0.5, after: 0.9 })
  await page.keyboard.press('Escape')

  await rec.click(composer, { dur: 0.5, at: { fx: 0.3 }, after: 0.05 })
  await rec.move(park, { dur: 0.3, real: false })
  await rec.type(composer, 'list what is in this folder', { cps: 30 })
  await rec.click(send, {
    dur: 0.45, after: 0.2,
    until: () => expect(card).toBeVisible({ timeout: 30_000 }),
  })
  rec.scene('With your first message it asks where to work.')
  await rec.cam(card, 1.45, 0.9)
  rec.hold(1.6)

  rec.scene('Sandbox is a separate folder. Commands still run on this computer.')
  await rec.move(page.getByTestId('workspace-ask-boundary'), { dur: 0.6, at: { fx: 0.85, fy: 1.0, dy: 6 } })
  rec.hold(1.5)
  await rec.click(page.getByTestId('workspace-ask-sandbox'), {
    dur: 0.6, after: 0.2,
    until: () => expect(page.getByTitle('Show arguments')).toBeVisible({ timeout: 30_000 }),
  })
  await rec.cam(low, 1.6, 1.0)

  rec.scene('Before a command runs you approve or reject it; the arrow shows its arguments.')
  await rec.click(page.getByTitle('Show arguments'), { dur: 0.7, after: 1.6, settle: 700 })
  rec.finish(1.2)
})
