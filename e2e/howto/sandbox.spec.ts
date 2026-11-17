import { test, expect } from '@playwright/test'
import { Rec, HOWTO_OUT } from './rec'
import { scriptModel, openChat } from './model'

// What the agent sandbox is and what it is not. Captions are the app's own
// words: the workspace card in the chat (WorkspaceAskCard.tsx), the badge
// next to Agent (AgentWorkspaceBadge.tsx), the default "Ask First" for Shell
// (api/mcp/types.ts DEFAULT_PERMISSIONS), the Approve / Reject card
// (ToolCallBlock.tsx) and the per-chat Tools menu (PermissionOverrideBar.tsx).
// agent.spec.ts shows the Agent switch in general; this one stays on the
// approval and on the limits of the sandbox.
//
// Since 3.1.2 the switch opens no dialog: the first message waits in the chat
// under the card "Where should I work?", and after Sandbox it goes out.
//
// FIXTURES (said in the report too):
//  - the model's answers are scripted (./model.ts): the first turn asks for
//    one shell command that reaches outside the sandbox folder, the second
//    answers after the rejection. The card, its Approve / Reject and
//    everything after are drawn by the app itself. Nothing is run: the
//    command is rejected, and the rig has no real shell anyway.
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test('sandbox', async ({ page }) => {
  test.skip(!HOWTO_OUT, 'set LU_HOWTO_OUT')
  test.setTimeout(120_000)
  const rec = await Rec.boot(page, 'sandbox', 'What the agent sandbox is')
  await scriptModel(page, [
    { text: 'I will check the size of your Documents folder.', toolCalls: [{ name: 'shell_execute', args: { command: 'du -sh ~/Documents' } }] },
    { text: 'Understood, I did not run it.' },
  ])
  const toggle = await openChat(page)

  const composer = page.locator('textarea').first()
  const send = page.getByRole('button', { name: 'Send message' })
  const card = page.getByTestId('workspace-ask')
  const sandbox = page.getByTestId('workspace-ask-sandbox')
  const park = { x: 1200, y: 812 }

  await rec.key()
  rec.scene('Turn Agent on and send your first message.')
  await rec.cam({ x: 757, y: 740 }, 1.5)
  await rec.click(toggle, {
    dur: 0.8, after: 0.3,
    until: () => expect(toggle).toHaveAttribute('title', /Agent Mode is on/i),
  })
  await rec.click(composer, { dur: 0.5, at: { fx: 0.3 }, after: 0.05 })
  await rec.move(park, { dur: 0.3, real: false })
  await rec.type(composer, 'how big is my Documents folder?', { cps: 44 })
  await rec.click(send, {
    dur: 0.45, after: 0.2,
    until: () => expect(card).toBeVisible({ timeout: 30_000 }),
  })

  rec.scene('It asks where to work. Sandbox is a separate folder under ~/agent-workspace.')
  await rec.cam(card, 1.5, 0.9)
  await rec.move(sandbox, { dur: 0.7, at: { fx: 0.8 } })
  rec.hold(1.3)

  rec.scene('It is not a container: commands still run on this computer.')
  await rec.move(page.getByTestId('workspace-ask-boundary'), { dur: 0.6, at: { fx: 0.9, fy: 1.0, dy: 6 } })
  rec.hold(1.5)
  await rec.click(sandbox, {
    dur: 0.6, at: { fx: 0.3 }, after: 0.2,
    until: () => expect(page.getByRole('button', { name: 'Reject' }).first()).toBeVisible({ timeout: 30_000 }),
  })

  rec.scene('Each shell command waits for Approve or Reject. Read it: it runs on this computer.')
  await rec.cam(page.getByRole('button', { name: 'Reject' }).first(), 1.5)
  rec.hold(1.9)
  await rec.click(page.getByRole('button', { name: 'Reject' }).first(), { dur: 0.6, after: 0.3 })

  rec.scene('The badge next to Agent shows where it works; a click picks a real folder.')
  const pill = page.getByTestId('agent-workspace-pill')
  await rec.cam(pill, 1.6)
  await rec.move(pill, { dur: 0.6 })
  rec.hold(1.1)

  rec.scene('Tools switches a category such as Shell on or off for this chat only.')
  const tools = page.getByRole('button', { name: /^Tools/ })
  await rec.cam(tools, 1.5)
  await rec.click(tools, { dur: 0.7, after: 0.4 })
  await rec.click(page.getByRole('button', { name: 'Shell', exact: true }), { dur: 0.5, after: 1.0 })
  rec.finish(1.0)
})
