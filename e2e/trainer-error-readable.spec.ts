import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { openCharacterTraining } from './support/character-hub'

for (const ready of [false, true]) {
  test(`trainer failure remains readable with environment ready=${ready}`, async ({ page }) => {
    await page.addInitScript(tauriMockInit, {
      assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const,
    })
    await page.addInitScript(({ ready }) => {
      const bridge = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
      }).__TAURI_INTERNALS__
      const invoke = bridge.invoke
      bridge.invoke = async (cmd: string, args: unknown) => {
        if (cmd === 'character_trainer_status') return {
          envReady: ready, basesReady: ready, dit: null, textEncoder: null, vae: null,
          root: 'C:\\test-trainer', install: { status: 'idle', logs: [] },
        }
        if (cmd === 'install_character_trainer') {
          throw new Error(Array.from({ length: 80 }, (_, i) => `Diagnostic line ${i + 1}: setup failed.`).join('\n'))
        }
        return invoke(cmd, args)
      }
    }, { ready })
    await seedOnboardingDone(page)
    await routeCloud(page, { license: 'active', access: true, mediaLive: true })
    await page.goto('/')
    await expect(cloudSwitch(page)).toBeVisible()
    await page.getByRole('button', { name: /^Create$/ }).click()
    await openCharacterTraining(page)
    await page.getByRole('button', { name: ready ? 'Reinstall trainer' : 'Set up trainer', exact: true }).click()
    // Z5: "Reinstall trainer" oeffnet jetzt nur den Bestaetigungsdialog; der
    // Install-Befehl feuert erst nach "Reinstall" darin, nicht beim ersten Klick.
    if (ready) await page.getByRole('dialog').getByRole('button', { name: 'Reinstall', exact: true }).click()
    const note = page.getByRole('status').filter({ hasText: 'Diagnostic line 80' })
    await expect(note).toBeVisible()
    const result = await note.evaluate((el) => {
      const style = getComputedStyle(el)
      el.focus()
      el.scrollTop = el.scrollHeight
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return {
        scrollable: el.scrollHeight > el.clientHeight && el.scrollTop > 0,
        selectable: style.userSelect, focused: document.activeElement === el,
        selectedEnd: selection.toString().includes('Diagnostic line 80: setup failed.'),
      }
    })
    expect(result).toEqual({ scrollable: true, selectable: 'text', focused: true, selectedEnd: true })
  })
}
