import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * N3 (3.1.0), clicked through in the real app with the Tauri bridge mocked:
 *  C74  Linux without lspci: an empty card list names the missing pciutils,
 *       and a card found through sysfs shows up with its note.
 *  C81  The LU Engine died on its own: the chat says how, and Settings →
 *       LU Engine keeps the sentence while no engine runs.
 *  C80  A ComfyUI is found, and a separate one can still be installed:
 *       pick a folder, see the target, nothing starts before the confirm.
 * LU_SHOTS=<folder> writes the screenshots there.
 */
const SHOTS = process.env.LU_SHOTS

const PCIUTILS = 'No graphics card found, and the lspci tool is missing on this system, so LU may simply not see your card. Install pciutils (Fedora/Bazzite: sudo dnf install pciutils, Debian/Ubuntu: sudo apt install pciutils, Arch: sudo pacman -S pciutils). Inside a container (Distrobox, Toolbox) install it there, and make sure the GPU is passed through. Without a detected card ComfyUI gets the slow processor build of PyTorch.'
const SYSFS_CARD = {
  index: 0,
  vendor: 'amd',
  name: 'Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]',
  memory_mib: 16368,
  source: 'sysfs',
  note: 'Found without ROCm tools, so LU cannot confirm the compute backend. Ollama and ComfyUI can still use the card if their ROCm or ZLUDA build is installed. Listed from the kernel (/sys/class/drm) because lspci is not installed.',
  note_severity: 'warn',
}
const DIED = 'The LU Engine stopped unexpectedly (signal 6, SIGABRT). The graphics card ran out of memory. A smaller model, a shorter context or fewer GPU layers usually fixes this. It starts again with your next message; details are in the log.'

async function boot(page: Page, invokeOverrides: Record<string, unknown>) {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.addInitScript(tauriMockInit, { assistantReply: 'ok', modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const, invokeOverrides })
  await seedOnboardingDone(page)
  await page.goto('/')
}

async function openSection(page: Page, title: string, tab = 'General') {
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
  if (tab !== 'General') await page.getByRole('button', { name: tab, exact: true }).first().click()
  const section = page.getByRole('button', { name: title })
  await expect(section.first()).toBeVisible({ timeout: 15_000 })
  if ((await section.first().getAttribute('aria-expanded')) === 'false') await section.first().click()
}

test('C74: an empty card list on Linux without lspci names pciutils', async ({ page }) => {
  await boot(page, { detect_gpus: [], gpu_probe_hint: PCIUTILS })
  await openSection(page, 'Hardware (GPU picker)')
  const hint = page.getByTestId('gpu-probe-hint')
  await expect(hint).toHaveText(PCIUTILS)
  await hint.scrollIntoViewIfNeeded()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c74-1-ohne-lspci-hinweis.png` })
})

test('C74: a card found through sysfs is listed with its note', async ({ page }) => {
  await boot(page, { detect_gpus: [SYSFS_CARD], gpu_probe_hint: PCIUTILS })
  await openSection(page, 'Hardware (GPU picker)')
  await expect(page.getByText(/Navi 21/).first()).toBeVisible()
  await expect(page.getByTestId('gpu-probe-hint')).toHaveCount(0)
  await page.getByText(/Navi 21/).first().scrollIntoViewIfNeeded()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c74-2-karte-aus-sysfs.png` })
})

test('C81: the engine death is named on the engine line and in Settings', async ({ page }) => {
  await boot(page, { bundled_engine_status: { running: false, healthy: false, port: 8127, model_path: null, ctx: null, lastExit: DIED } })
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __E2E_EMIT__?: unknown }).__E2E_EMIT__)).toBe('function')
  await page.getByRole('banner').getByRole('button', { name: 'Models', exact: true }).click()
  // Rust's watch reaped the engine and raises the event, the way engine.rs does.
  await expect.poll(async () => {
    await page.evaluate((message) => {
      const w = window as unknown as { __E2E_EMIT__: (e: string, p: unknown) => void }
      w.__E2E_EMIT__('lu-sidecar-gone', { sidecar: 'engine', port: 8127, signal: 6, exitCode: null, message })
    }, DIED)
    return page.getByTestId('lu-engine-switch-note').count()
  }, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(page.getByTestId('lu-engine-switch-note').first()).toContainText('The LU Engine stopped unexpectedly (signal 6, SIGABRT).')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c81-1-engine-zeile.png` })
  await openSection(page, 'LU Engine (expert)', 'AI Backends')
  await expect(page.getByTestId('builtin-engine-last-exit')).toHaveText(DIED)
  await page.getByTestId('builtin-engine-last-exit').scrollIntoViewIfNeeded()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c81-2-settings-engine.png` })
})

test('C80: a separate ComfyUI next to the found one', async ({ page }) => {
  await boot(page, {
    comfyui_status: { running: false, found: true, complete: true, path: 'C:\\Users\\Sam\\ComfyUI', port: 8188, isLocal: true },
    pick_folder: 'D:\\AI',
  })
  await openSection(page, 'ComfyUI (Image & Video)', 'AI Backends')
  const open = page.getByTestId('separate-comfy-open')
  await page.waitForTimeout(400)
  await open.scrollIntoViewIfNeeded()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c80-1-knopf-settings.png` })
  await open.click()
  const line = page.getByTestId('separate-comfy-target')
  await expect(line).toContainText('D:\\AI\\ComfyUI')
  await page.waitForTimeout(400)
  await page.getByTestId('separate-comfy-confirm').scrollIntoViewIfNeeded()
  await expect(line).toContainText('C:\\Users\\Sam\\ComfyUI')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c80-2-ziel-bestaetigen.png` })
  // The path field: typing alone changes nothing.
  const field = page.getByPlaceholder('C:\\ComfyUI')
  await field.fill('E:\\Other\\ComfyUI')
  await expect(page.getByTestId('comfy-path-connect-hint')).toBeVisible()
  await page.getByTestId('comfy-path-connect-hint').scrollIntoViewIfNeeded()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/c80-3-connect-hinweis.png` })
})
