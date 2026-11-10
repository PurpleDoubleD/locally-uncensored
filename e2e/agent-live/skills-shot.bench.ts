/** Screenshot of Settings → Agent → Skills (C59 A7). Runs only with LU_BENCH_SKILLS_SHOT=<png path>. */
import { test, expect } from '@playwright/test'
import { seedOnboardingDone } from '../support/cloud-mock'

const OUT = process.env.LU_BENCH_SKILLS_SHOT

test('C59 skills section', async ({ page }) => {
  test.skip(!OUT, 'set LU_BENCH_SKILLS_SHOT')
  await page.setViewportSize({ width: 1280, height: 4000 })
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.evaluate(async () => {
    const path = '/src/stores/skillStore.ts'
    const { useSkillStore } = await import(/* @vite-ignore */ path)
    const st = useSkillStore.getState()
    st.addSkill({ name: 'rechnungsnummer', description: 'Schema für Rechnungsnummern dieses Betriebs.', body: '## Procedure\n1. RE-<Jahr>-<Nummer>-<Kürzel>, Nummer +7.', status: 'active' })
    st.addSkill({ name: 'release-notes', description: 'How to write LU release notes.', body: '## When to use\nBefore a release.\n\n## Procedure\n1. One line per change, plain English.\n2. No marketing words.\n\n## Verification\nEvery line names what the user notices.', status: 'proposed', source: 'agent' })
  })
  await page.getByRole('button', { name: /settings/i }).first().click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const head = page.getByText('Proposed (1)')
  if (!(await head.isVisible().catch(() => false))) await page.getByRole('button', { name: /^Skills/ }).first().click()
  await expect(head).toBeVisible()
  await page.waitForTimeout(1500)
  const top = await page.getByRole('button', { name: /^Skills/ }).first().boundingBox()
  const imp = await page.getByText('Import a SKILL.md from this computer').boundingBox()
  await page.screenshot({ path: OUT!, clip: top && imp ? { x: Math.max(0, top.x - 16), y: top.y - 8, width: 820, height: imp.y + imp.height - top.y + 24 } : undefined })
})
