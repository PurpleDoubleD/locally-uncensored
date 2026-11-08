import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch, cloudSwitchBehindModal, type CloudScenario } from './support/cloud-mock'

/**
 * Das Verkaufs-Panel am Wolkenschalter (13.09.2026).
 *
 * Bis 3.0.0 zeigte ein Klick auf den Schalter ohne Sitzung ein Login-Fenster,
 * also die falsche Frage: wer noch nichts gekauft hat, kann sich nicht
 * anmelden. Jetzt steht dort das Argument, und die Anmeldung ist der Nebenweg
 * fuer den, der schon zahlt.
 *
 * Zwei Wege, und der zweite ist die Gegenprobe:
 *
 *  (a) OHNE Sitzung oeffnet der Schalter das Panel. Der Kaufknopf geht in den
 *      Browser, nie in die App. X, Escape und ein Klick daneben schliessen.
 *  (b) MIT gueltiger Sitzung darf sich nichts geaendert haben: kein Panel, und
 *      der Zwei-Klick-Schutz vor dem Wechsel in die Wolke steht weiter.
 *
 * Lauf: npx playwright test e2e/cloud-sales-panel.spec.ts
 */

async function boot(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, scenario)
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
}

const panel = (page: Page) => page.getByTestId('cloud-sales-panel')

test('without a session one click opens the sales panel, not a login form', async ({ page }) => {
  await boot(page, { license: 'none' })
  await cloudSwitch(page).click()

  await expect(panel(page)).toBeVisible({ timeout: 20_000 })

  // Kicker, Ueberschrift, Untertitel, Fussnote.
  await expect(panel(page).getByText('Cloud', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Run uncensored models in the cloud, no GPU needed.' }),
  ).toBeVisible()
  await expect(panel(page)).toContainText('Turn on Cloud to reach the full catalogue from any machine.')
  await expect(panel(page)).toContainText('Your local models keep working exactly as they do now.')
  await expect(panel(page)).toContainText('Cancel anytime. Local mode stays free and offline.')

  // Die drei gezaehlten Zeilen.
  const lines = page.getByTestId('cloud-sales-lines')
  await expect(lines).toContainText('13 No Filter chat models')
  await expect(lines).toContainText('17 uncensored video models')
  await expect(lines).toContainText('9 uncensored image models')

  // Der Abo-Satz unter dem Knopf.
  await expect(panel(page)).toContainText(
    'Subscribers get about 1.5x more credits per euro and 500,000 free Flash tokens a day.',
  )

  // Gegenprobe: das Anmeldefeld steht NICHT im Weg, es ist einen Klick weiter.
  await expect(page.getByPlaceholder('Email')).toBeHidden()

  // Der Schalter bleibt aus, solange das Panel steht.
  await expect(cloudSwitchBehindModal(page)).toHaveAttribute('aria-checked', 'false')
})

test('the purchase button carries the price and leaves for the browser', async ({ page }) => {
  await boot(page, { license: 'none' })
  await cloudSwitch(page).click()
  await expect(panel(page)).toBeVisible({ timeout: 20_000 })

  const buy = page.getByRole('button', { name: 'Start Cloud for 19 EUR / month' })
  await expect(buy).toBeVisible()
  await buy.click()

  const opened = await page.evaluate(
    () => (window as unknown as { __E2E_OPENED_URLS__?: string[] }).__E2E_OPENED_URLS__ ?? [],
  )
  expect(opened.some((u) => u.endsWith('/pricing'))).toBe(true)
  // Gekauft wird auf der Website. Die App hat nie eine Zahlung angefasst.
  expect(opened.some((u) => /stripe|checkout\/start/i.test(u))).toBe(false)
  // Und der Schalter ist davon nicht umgesprungen.
  await expect(cloudSwitchBehindModal(page)).toHaveAttribute('aria-checked', 'false')
})

test('Already subscribed? Sign in reaches the existing login form', async ({ page }) => {
  await boot(page, { license: 'none' })
  await cloudSwitch(page).click()
  await expect(panel(page)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /Already subscribed\? Sign in/i }).click()

  await expect(page.getByPlaceholder('Email')).toBeVisible()
  await expect(page.getByPlaceholder('Password')).toBeVisible()
  await expect(panel(page)).toBeHidden()

  // Und zurueck fuehrt an die Stelle, von der man kam.
  await page.getByRole('button', { name: /^Back$/ }).click()
  await expect(panel(page)).toBeVisible()
})

test('the X, Escape and a click beside it all close the panel', async ({ page }) => {
  await boot(page, { license: 'none' })

  // Das X.
  await cloudSwitch(page).click()
  await expect(panel(page)).toBeVisible({ timeout: 20_000 })
  await page.locator('[data-dialog-close]').click()
  await expect(panel(page)).toBeHidden()

  // Escape.
  await cloudSwitch(page).click()
  await expect(panel(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()

  // Ein Klick daneben, auf den Hintergrund.
  await cloudSwitch(page).click()
  await expect(panel(page)).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(panel(page)).toBeHidden()

  // Nach dreimal Schliessen steht die App unveraendert auf Local.
  await expect(cloudSwitch(page)).not.toBeChecked()
})

/**
 * GEGENPROBE. Der bestehende Kunde darf nichts merken.
 *
 * Ohne diesen Fall waere der Auftrag nur halb geprueft: ein Panel, das auch
 * einem angemeldeten Abonnenten in den Weg springt, haette jeden Test oben
 * bestanden und trotzdem jeden zahlenden Kunden einen Klick gekostet.
 */
test('with a valid session the switch flips as before, and no panel appears', async ({ page }) => {
  await boot(page, { license: 'active', tier: 'hosted-max', access: true })

  // Einmal anmelden, danach ist die Sitzung gueltig und der Schalter frei.
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await expect(panel(page)).toBeHidden()

  // Zurueck auf Local: EIN Klick, ohne Rueckfrage.
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).not.toBeChecked()
  await expect(panel(page)).toBeHidden()

  // Und wieder hinein: der Zwei-Klick-Schutz steht unveraendert. Der erste
  // Klick spannt nur, das Panel bleibt weg.
  await cloudSwitch(page).click()
  await expect(panel(page)).toBeHidden()
  await expect(page.getByTestId('cloud-switch-label')).toHaveAttribute('data-state', 'armed')
  await expect(cloudSwitch(page)).not.toBeChecked()

  // Der zweite Klick schaltet um.
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).toBeChecked()
  await expect(panel(page)).toBeHidden()
})
