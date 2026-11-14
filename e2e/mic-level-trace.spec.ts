import { mkdirSync } from 'fs'
import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { appModules, openNewChat, type AppWindow } from './support/ui'

/**
 * The live trace of the microphone while dictating (David, 14.11.2026): a
 * slim waveform that moves with the voice, the running time, and "No sound
 * from mic" when nothing arrives for a few seconds.
 *
 * The microphone is a WebAudio stream made in the page: an oscillator whose
 * loudness swings like speech, or nothing at all. It goes through the real
 * path of the app: the recorder asks getUserMedia, the level meter listens
 * through an AnalyserNode, the composer draws it. Speech-to-text is switched
 * on directly; it is not the subject here.
 *
 * LU_SHOTS_DIR=<dir> also saves the screens, light and dark.
 */

const VOICE_STORE = '/src/stores/voiceStore.ts'

async function boot(page: Page, mic: 'speech' | 'silent') {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await page.addInitScript((kind) => {
    const devices = navigator.mediaDevices
    devices.getUserMedia = async () => {
      const ctx = new AudioContext()
      const out = ctx.createMediaStreamDestination()
      if (kind === 'speech') {
        const tone = ctx.createOscillator()
        tone.frequency.value = 220
        const voice = ctx.createGain()
        voice.gain.value = 0.35
        // A slow swing of the loudness, like syllables.
        const lfo = ctx.createOscillator()
        lfo.frequency.value = 3
        const depth = ctx.createGain()
        depth.gain.value = 0.3
        lfo.connect(depth).connect(voice.gain)
        tone.connect(voice).connect(out)
        tone.start()
        lfo.start()
      }
      return out.stream
    }
  }, mic)
  await seedOnboardingDone(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await appModules(page, [VOICE_STORE])
  await openNewChat(page)
  await page.evaluate((path) => {
    (window as unknown as AppWindow).__APP__[path].useVoiceStore.getState().setSttAvailable(true)
  }, VOICE_STORE)
}

const bars = (page: Page) => page.getByTestId('mic-level-bars').locator('i').evaluateAll((all) =>
  all.map((bar) => Number(/scaleY\(([\d.]+)\)/.exec((bar as HTMLElement).style.transform)?.[1] ?? 0)))

async function shot(page: Page, name: string) {
  const dir = process.env.LU_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const composer = page.locator('textarea[data-lu-composer]').locator('xpath=ancestor::div[contains(@class,"rounded")][1]')
  await composer.screenshot({ path: `${dir}/${name}-composer.png` })
  await page.screenshot({ path: `${dir}/${name}-page.png` })
}

for (const theme of ['dark', 'light'] as const) {
  test(`speech moves the trace, the clock runs, no warning (${theme})`, async ({ page }) => {
    await boot(page, 'speech')
    if (theme === 'light') await page.getByRole('button', { name: 'Light Mode' }).click()
    await expect(page.getByTestId('mic-level-trace')).toHaveCount(0)

    await page.getByRole('button', { name: 'Start voice input' }).click()
    const trace = page.getByTestId('mic-level-trace')
    await expect(trace).toBeVisible()
    await expect.poll(async () => Math.max(...(await bars(page))), { timeout: 5_000 }).toBeGreaterThan(0.5)
    // A waveform, not one block: the bars stand at different heights.
    await expect.poll(async () => new Set((await bars(page)).map((h) => h.toFixed(2))).size).toBeGreaterThan(3)
    await expect(page.getByTestId('mic-level-clock')).toHaveText('0:02', { timeout: 5_000 })
    await page.waitForTimeout(1_500)
    await expect(page.getByTestId('mic-level-quiet')).toHaveCount(0)
    await shot(page, `mic-sprache-${theme}`)

    await page.getByRole('button', { name: 'Stop recording' }).click()
    await expect(trace).toHaveCount(0)
  })

  test(`a silent microphone stays flat and says so after a few seconds (${theme})`, async ({ page }) => {
    await boot(page, 'silent')
    if (theme === 'light') await page.getByRole('button', { name: 'Light Mode' }).click()
    await page.getByRole('button', { name: 'Start voice input' }).click()
    await expect(page.getByTestId('mic-level-trace')).toBeVisible()
    await expect(page.getByTestId('mic-level-quiet')).toHaveCount(0)
    await expect(page.getByTestId('mic-level-quiet')).toHaveText('No sound from mic', { timeout: 6_000 })
    expect(Math.max(...(await bars(page)))).toBeLessThan(0.1)
    await shot(page, `mic-stille-${theme}`)
  })
}
