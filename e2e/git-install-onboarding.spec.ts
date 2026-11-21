import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'

/**
 * "Install Git" in the onboarding (3.1.3, Davids Wunsch 21.11.).
 *
 * David's new, empty Windows PC: the ComfyUI install stopped with "Installing
 * ComfyUI did not finish" because git was missing. Now the step shows an
 * "Install Git" button, and once git is there the install goes on by itself
 * to "ComfyUI is ready". The backend answers are the mock's; the real
 * download is proven on Windows (report 313-KLEINFIXES, GIT-INSTALL).
 */
async function installMock(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await page.addInitScript(() => {
    type Bridge = { invoke: (command: string, args?: unknown) => Promise<unknown> }
    const w = window as unknown as { __TAURI_INTERNALS__: Bridge; __E2E_GIT__: { installs: number; git: boolean; gitCalls: number } }
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const state = { installs: 0, git: false, gitCalls: 0 }
    w.__E2E_GIT__ = state
    const missing = 'Git is not installed. Press Install Git and LU sets up its own Git (about 40 MB, no admin rights needed). Or install Git for Windows from https://git-scm.com/download/win and restart LU.'
    bridge.invoke = (command, args) => {
      switch (command) {
        case 'python_check':
          return Promise.resolve({ available: true, path: 'C:\\Python312\\python.exe' })
        case 'install_comfyui':
          state.installs += 1
          return Promise.resolve({ status: 'started' })
        case 'install_comfyui_status':
          return Promise.resolve(state.git
            ? { status: 'complete', logs: ['ComfyUI installed.'] }
            : { status: 'error', logs: ['Starting ComfyUI installation...', missing] })
        case 'install_git':
          state.gitCalls += 1
          return Promise.resolve({ status: 'downloading' })
        case 'install_git_status':
          state.git = true
          return Promise.resolve({ status: 'complete', installed: true, logs: ['git version 2.56.1.windows.1 is ready.'] })
        default:
          return invoke(command, args)
      }
    }
  })
}

test('git missing -> Install Git -> the ComfyUI install goes on to ready', async ({ page }) => {
  await installMock(page)
  await page.goto('/')
  await page.getByRole('button', { name: /Get Started/i }).click()
  await page.getByRole('button', { name: /Continue/i }).click()

  await page.getByRole('button', { name: /Install ComfyUI/i }).click()
  await expect(page.getByText(/Installing ComfyUI did not finish/)).toBeVisible({ timeout: 15_000 })
  const gitButton = page.getByRole('button', { name: /Install Git/i })
  await expect(gitButton).toBeVisible()

  await gitButton.click()
  await expect(page.getByText('ComfyUI is ready')).toBeVisible({ timeout: 20_000 })
  const seen = await page.evaluate(() => (window as unknown as { __E2E_GIT__: { installs: number; gitCalls: number } }).__E2E_GIT__)
  expect(seen.gitCalls).toBe(1)
  expect(seen.installs).toBe(2)
})
