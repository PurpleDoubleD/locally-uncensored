import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch, type CloudScenario } from './support/cloud-mock'

/**
 * P9 Integration: das Studio auf der Wolken-Spur, und sein Fehlen ueberall
 * sonst (Portplan Abschnitt 5, P9 "offen fuer P9" der Pakete P4/P6).
 *
 * (a) Cloud-Spur mit Studio-Katalog: die Preset-Schiene erscheint, ein Klick
 *     oeffnet die Werkstatt, Preis erscheint, Escape UND das X schliessen sie.
 * (b) lokale Spur: keine Schiene, der Expert-Abschnitt bleibt, wie er war
 *     (e2e/create-expert-section.spec.ts ist der eigentliche Beweis dafuer;
 *     hier nur die Randbedingung, dass das Studio ihn nicht verdraengt).
 * (c) ein aelterer Server (Katalog ohne `quote_required` auf irgendeinem
 *     Eintrag) zeigt keine Schiene. Erkennung laeuft nur ueber das Feld,
 *     nie eine Versionsnummer (Portplan Abschnitt 4).
 * (d) `studio-quote` antwortet 404: Start bleibt gesperrt, der feste Satz
 *     steht da, nie ein Rueckfall auf die eigene Formel.
 * (e) die Laengen-Knoepfe im Composer folgen `clip.durations` aus dem
 *     Katalog, nicht einem festen 5s/8s-Paar (dd29f359).
 */

const WINDOWS_OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'windows',
}

async function bootIntoCloudCreate(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, WINDOWS_OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, scenario)
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

async function bootIntoLocalCreate(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, WINDOWS_OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, scenario) // still mocked: nothing here should be reached
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
}

const presetShelf = (page: Page) => page.locator('aside[aria-label="Presets"]')
const expandPresets = (page: Page) => page.getByRole('button', { name: 'Expand presets' })

test('cloud track with a Studio catalog: the shelf appears, opens the workshop, prices, and both Escape and the X close it', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true, studioCatalog: true })

  await expect(presetShelf(page)).toBeVisible({ timeout: 15_000 })
  await expandPresets(page).click()
  await expect(page.getByText('Song from Words')).toBeVisible()

  await page.getByRole('button', { name: /Song from Words/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Song from Words' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })

  await page.getByLabel('Preset prompt').fill('a bright acoustic tune about a summer road trip')
  await expect(page.getByText('1,500 credits')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /^Generate$/ })).toBeEnabled()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Reopen the same preset for the X case. Escape's own test above already
  // proved it, this proves the OTHER half of the popup house rule
  // (feedback-sampling-popup-mit-x.md: a popup is X AND Escape, never just
  // one of the two). The shelf itself is still expanded (Escape only closed
  // the dialog on top of it), so no second "Expand presets" click here.
  await page.getByRole('button', { name: /Song from Words/ }).click()
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})

test('local track: no shelf at all, even with a Studio catalog on the wire', async ({ page }) => {
  await bootIntoLocalCreate(page, { license: 'active', access: true, mediaLive: true, studioCatalog: true })

  await expect(presetShelf(page)).toHaveCount(0)
  // The expert section still opens on the local track exactly as before:
  // the Studio port replaces AdvancedDrawer's body only behind a Studio
  // pick (backend === 'cloud' AND a resolved Studio model), never on local.
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  await expect(page.getByRole('button', { name: 'Expert', exact: true })).toBeVisible({ timeout: 15_000 })
})

test('an older server (catalog with no quote_required entry) shows no shelf', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true }) // studioCatalog left unset

  await expect(page.getByRole('radio', { name: /Enhance Image/i })).toBeVisible({ timeout: 15_000 })
  await expect(presetShelf(page)).toHaveCount(0)
})

test('studio-quote answers 404: start stays locked, the version-gap message shows, never a fallback price', async ({ page }) => {
  await bootIntoCloudCreate(page, {
    license: 'active', access: true, mediaLive: true, studioCatalog: true, studioQuoteStatus: 404,
  })

  await expandPresets(page).click()
  await page.getByRole('button', { name: /Song from Words/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Song from Words' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })

  await page.getByLabel('Preset prompt').fill('a bright acoustic tune about a summer road trip')
  await expect(page.getByRole('alert')).toHaveText('This feature needs a newer LU Cloud server. Try again later.', { timeout: 15_000 })
  await expect(page.getByRole('button', { name: /^Generate$/ })).toBeDisabled()
  // The dialog still shows its own client-side PREVIEW ("≈ NNN credits",
  // studio-contract.ts's formula), and that is allowed: it is clearly marked
  // as an estimate and never what the run would book. What must NOT appear
  // is a CONFIRMED price (no "≈"): that string only ever comes from a
  // successful studio-quote() call, and would mean the app fell back to
  // booking its own formula, exactly what Portplan Abschnitt 4/7 (Risiko 1)
  // forbids.
  await expect(dialog.getByText(/^[\d,]+ credits$/)).toHaveCount(0)
  await expect(dialog.getByText(/^≈ [\d,]+ credits$/)).toBeVisible()
})

test('the presenter picker opens inline, not as a popup (P4, offen fuer P9)', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true, studioCatalog: true })

  await expandPresets(page).click()
  await page.getByRole('button', { name: 'Explore individual cloud models' }).click()
  await page.getByRole('option', { name: 'HeyGen Presenter' }).click()

  const dialog = page.getByRole('dialog', { name: 'HeyGen Presenter' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })

  // AvatarPicker (SchemaControl's 'avatar' field) is a field that opens in
  // the normal document flow below its button, not a floating dialog of its
  // own. The popup house rule (X + Escape) only applies where the source
  // actually renders a floating overlay, and this field never did (P4's
  // report on AvatarPicker.tsx). Proven two ways: no second dialog appears,
  // and Escape here closes the WORKSHOP dialog, not just a picker inside it.
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('the cloud Length control follows clip.durations from the catalog, not a fixed 5s/8s pair', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true, studioCatalog: true })

  await page.getByRole('radio', { name: /^Video$/ }).click()
  // Segmented (Composer.tsx's LabeledControl) does not wire an aria-label
  // onto the "Length" radiogroup itself ("Length" is a sibling <span>, not
  // an aria-labelledby target), so the three second-values themselves are
  // the only reliable locator; they read as plain "Ns" nowhere else on the
  // Create surface (the Size control's options are "Xp", the steps slider
  // has no radio role at all).
  await expect(page.getByRole('radio', { name: '4s' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('radio', { name: '6s' })).toBeVisible()
  await expect(page.getByRole('radio', { name: '9s' })).toBeVisible()
  // The old fixed pair is gone, not just outnumbered.
  await expect(page.getByRole('radio', { name: '5s' })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: '8s' })).toHaveCount(0)
})

// Review B1 (review-studio-B.md): the Composer's role-intent picker
// (Extend, Motion) is gated on `quote_required` too now, the same way
// PresetShelf already was. Measured on the un-fixed branch: Extend resolved
// to the Studio twin `preset-wan-2.2-spicy-extend` (price.mode 'output'),
// which called studio-quote, hit 404/CORS on this catalog, and showed the
// version-gap alert on a lane that used to just work; Motion resolved to
// `scail-2` (price.mode 'input'), which never calls studio-quote at all, so
// the button stayed enabled and the run only failed once the OLD server
// rejected `op: 'studio'`. Both must now stay on their classic twins.
test('an older server (no quote_required): Extend and Motion behave exactly as before the Studio port', async ({ page }) => {
  const studioQuoteCalls: string[] = []
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true }) // studioCatalog left unset
  page.on('request', (req) => { if (req.url().includes('/api/jobs/studio-quote')) studioQuoteCalls.push(req.url()) })

  await page.getByRole('radio', { name: 'Extend Video' }).click()
  // The classic twin from the mocked catalog, not a Studio id: proves
  // resolveIntentPick fell back instead of picking a model this server
  // never announced.
  await expect(page.getByRole('button', { name: /Wan 2\.2 Uncensored Extend/ })).toBeVisible({ timeout: 15_000 })
  // The old, pre-Studio failure mode: no version-gap alert, because no
  // studio-quote call was ever made for a classic pick. (This app always
  // shows an unrelated "ComfyUI is not running" banner on the cloud track
  // with no local engine mocked, hence checking the TEXT, not alert count.)
  await expect(page.getByText('This feature needs a newer LU Cloud server')).toHaveCount(0)

  await page.getByRole('radio', { name: 'Motion Control' }).click()
  await expect(page.getByRole('button', { name: /Wan 2\.2 Animate/ })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('This feature needs a newer LU Cloud server')).toHaveCount(0)

  expect(studioQuoteCalls, studioQuoteCalls.join(', ')).toHaveLength(0)
})

// Review B2 (review-studio-B.md): the Preset window used to abandon its
// paid-for step state whenever Escape/X closed it (Modal's default
// AnimatePresence unmount). `keepMounted` (Modal.tsx) fixes it by never
// unmounting the workshop while `selectedPreset` still names it; this proves
// the actual customer-visible contract, not the implementation: step 1
// stays finished, and Continue does NOT re-book it.
test('closing the workshop with Escape and reopening keeps a finished step finished (Review B2)', async ({ page }) => {
  const submitCalls: string[] = []
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true, studioCatalog: true })
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/jobs') submitCalls.push(req.url())
  })

  await expandPresets(page).click()
  await page.getByRole('button', { name: /Song from Words/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Song from Words' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })

  await page.getByLabel('Preset prompt').fill('a bright acoustic tune about a summer road trip')
  await expect(page.getByRole('button', { name: /^Generate$/ })).toBeEnabled({ timeout: 15_000 })
  await page.getByRole('button', { name: /^Generate$/ }).click()
  await expect(page.getByText('Saved to your gallery')).toBeVisible({ timeout: 15_000 })
  expect(submitCalls).toHaveLength(1)

  // Close with Escape (the exact path B2 found broken), not the Done button.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Reopen via the shelf's own "Continue" affordance. Scoped to the shelf
  // itself: a preset card's own accessible name can otherwise collide with
  // a loose "Continue" match elsewhere on the page.
  await presetShelf(page).getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(dialog).toBeVisible({ timeout: 15_000 })

  // The finished result is still there: no second upload/prompt/generate
  // round-trip, and critically no second booking.
  await expect(dialog.getByText('Saved to your gallery')).toBeVisible()
  expect(submitCalls, 'must not re-book a step the customer already paid for').toHaveLength(1)
})

// Review A kleiner Punkt 1: the cloud Length control used to read/write the
// SAME frames/fps the local video lane's own Frames slider owns, so picking
// a cloud length silently rewrote what the local track would remember.
// cloudFrames/cloudFps (createStore.ts) are now separate fields; this proves
// it from the customer's side: pick a non-default cloud length, switch to
// local, and the local Frames slider still shows its untouched default.
test('picking a cloud clip length leaves the local Frames slider untouched (Review A kleiner Punkt 1)', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true, studioCatalog: true })

  await page.getByRole('radio', { name: /^Video$/ }).click()
  await expect(page.getByRole('radio', { name: '9s' })).toBeVisible({ timeout: 15_000 })
  // Default snaps to the shortest option (4s); pick a different one so any
  // leak into the local frames/fps would actually be visible below.
  await page.getByRole('radio', { name: '9s' }).click()
  await expect(page.getByRole('radio', { name: '9s' })).toBeChecked()

  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).not.toBeChecked()
  await page.getByRole('radio', { name: /^Video$/ }).click()

  // Local video's own Frames slider: unchanged default is 24 frames at 8fps
  // (3.0s), the format Composer's LaneControls Slider uses. A leak from the
  // 9s cloud pick would show "144f" (9 * 16) instead.
  await expect(page.getByText('24f · 3.0s')).toBeVisible({ timeout: 15_000 })
})
