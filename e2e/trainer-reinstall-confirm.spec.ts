import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { openCharacterTraining } from './support/character-hub'

/**
 * Z5 (box-gruen/b BERICHT.md, Zusatzpunkt Z5, e2e Windows 18.09.2026): auf
 * einer Box mit bereits installiertem Trainer hat "Reinstall trainer"
 * `install_character_trainer` im selben Moment ausgeloest, in dem geklickt
 * wurde -- keine Bestaetigung, keine Chance, vorher zu sehen, was passiert.
 * Diese Spec beweist den ersten Teil des Fixes: der Klick oeffnet jetzt nur
 * einen Dialog, und `install_character_trainer` wird genau einmal
 * aufgerufen, erst nachdem "Reinstall" gedrueckt wurde.
 *
 * Final Review (19.09.2026, ZURUECK, Blocker): ein erster Entwurf dieses
 * Dialogs hatte ein EDITIERBARES Pfadfeld, vorbelegt mit dem bestehenden
 * Ordner. Ein Kunde, der bloss bestaetigt ohne etwas zu tippen, schickte
 * diesen Ordner dann als nicht-leeren Pfad an install_character_trainer, und
 * die Rust-Seite haelt einen nicht-leeren Pfad fuer "customized" -- genau der
 * Migrationsschutz, den es fuer einen unveraenderten Reinstall nicht geben
 * soll, griff dann ungewollt und liess pip/Torch-Caches umziehen. Der Dialog
 * zeigt den Ordner jetzt nur noch als Text; Bestaetigen schickt dasselbe
 * Argument, das der Knopf vor dem gesamten Z5-Umbau schickte (der
 * Erstsetup-Zustand `installPath`, leer fuer einen Kunden, der ihn nie
 * angefasst hat). Die Tests unten pruefen genau das.
 *
 * Run: npx playwright test e2e/trainer-reinstall-confirm.spec.ts
 */

const SHOT_DIR = process.env.LU_TRAINERCONFIRM_SHOTS ?? resolve(process.cwd(), 'test-results/trainerconfirm')

function trainerStatusMock(overrides: Record<string, unknown> = {}) {
  return {
    envReady: true, basesReady: true, dit: 'x', textEncoder: 'x', vae: 'x',
    root: 'C:\\test-trainer', customized: false, suggestedRoot: null,
    install: { status: 'idle', logs: [] },
    ...overrides,
  }
}

async function gotoReadyTrainer(
  page: import('@playwright/test').Page,
  statusOverrides: Record<string, unknown> = {},
) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const,
  })
  await page.addInitScript((status: Record<string, unknown>) => {
    const bridge = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
    }).__TAURI_INTERNALS__
    const invoke = bridge.invoke
    ;(window as unknown as { __installCalls: unknown[] }).__installCalls = []
    bridge.invoke = async (cmd: string, args: unknown) => {
      if (cmd === 'character_trainer_status') return status
      if (cmd === 'install_character_trainer') {
        ;(window as unknown as { __installCalls: unknown[] }).__installCalls.push(args)
        const installPath = (args as { installPath?: string | null } | null)?.installPath ?? null
        if (installPath && !/^[A-Za-z]:\\|^\//.test(installPath)) {
          throw new Error('The trainer folder must be an absolute path.')
        }
        return { status: 'installing' }
      }
      return invoke(cmd, args)
    }
  }, trainerStatusMock(statusOverrides))
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible()
  await page.getByRole('button', { name: /^Create$/ }).click()
  await openCharacterTraining(page)
}

async function installCalls(page: import('@playwright/test').Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { __installCalls: unknown[] }).__installCalls)
}

test('Reinstall trainer opens a dialog first -- no install call on the bare click (Negativkontrolle)', async ({ page }, testInfo) => {
  await gotoReadyTrainer(page)
  await page.getByRole('button', { name: 'Reinstall trainer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Reinstall the trainer?' })
  await expect(dialog).toBeVisible()
  expect(await installCalls(page)).toHaveLength(0)
  await page.screenshot({ path: `${SHOT_DIR}/${testInfo.titlePath.length}-dialog-open.png` })
})

test('the dialog shows the current trainer folder as read-only text and focuses Cancel', async ({ page }) => {
  await gotoReadyTrainer(page)
  await page.getByRole('button', { name: 'Reinstall trainer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Reinstall the trainer?' })
  await expect(dialog).toBeVisible()
  // A1-Korrektur: kein editierbares Feld mehr -- der Ordner steht nur als
  // Text im Dialog, ein Kunde kann ihn hier nicht mehr aendern.
  await expect(dialog.locator('input')).toHaveCount(0)
  await expect(dialog).toContainText('C:\\test-trainer')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
})

test('Cancel closes the dialog and calls nothing', async ({ page }) => {
  await gotoReadyTrainer(page)
  await page.getByRole('button', { name: 'Reinstall trainer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Reinstall the trainer?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).not.toBeVisible()
  expect(await installCalls(page)).toHaveLength(0)
  // Der Trainer bleibt exakt wie vorher -- der Knopf zeigt wieder sein Ruhe-Label.
  await expect(page.getByRole('button', { name: 'Reinstall trainer', exact: true })).toBeVisible()
})

test('Escape closes the dialog and calls nothing', async ({ page }) => {
  await gotoReadyTrainer(page)
  await page.getByRole('button', { name: 'Reinstall trainer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Reinstall the trainer?' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  expect(await installCalls(page)).toHaveLength(0)
})

test('BLOCKER: confirming an unmodified reinstall does not turn the existing folder into a customized trainer_root', async ({ page }, testInfo) => {
  // customized: false, so an honest reinstall must send the same argument the
  // Reinstall button sent before the confirmation dialog existed at all: no
  // path, not the folder that happens to be showing in the dialog. Sending
  // the folder here would flip trainer_root_is_customized() to true on the
  // Rust side and redirect the pip/HF/torch caches away from the ones
  // already on disk -- exactly the migration a customer who never touched
  // this setting must not trigger.
  await gotoReadyTrainer(page, { customized: false, suggestedRoot: null, root: 'C:\\test-trainer' })
  await page.getByRole('button', { name: 'Reinstall trainer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Reinstall the trainer?' })
  await dialog.getByRole('button', { name: 'Reinstall', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const calls = await installCalls(page)
  expect(calls).toEqual([{ installPath: null }])
  await page.screenshot({ path: `${SHOT_DIR}/${testInfo.titlePath.length}-confirmed-reinstall.png` })
})

test('confirming a reinstall of an already customized install keeps sending that same folder', async ({ page }) => {
  // customized: true means a customer DID set this folder on purpose in the
  // past. Reinstalling must keep using it, not fall back to empty -- that
  // would silently move a deliberate choice back to the app data default.
  await gotoReadyTrainer(page, { customized: true, suggestedRoot: null, root: 'D:\\CustomTrainer' })
  await page.getByRole('button', { name: 'Reinstall trainer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Reinstall the trainer?' })
  await dialog.getByRole('button', { name: 'Reinstall', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const calls = await installCalls(page)
  expect(calls).toEqual([{ installPath: 'D:\\CustomTrainer' }])
})

test('a rejected install still counts as one call -- the note shows the error, not a second attempt', async ({ page }, testInfo) => {
  // The Rust validation runs on whatever path install_character_trainer gets
  // handed, independent of whether a human typed it. B1-Korruktur
  // (review-teil17-lintfix.md): a reinstall now ignores `suggestedRoot`
  // entirely -- it only ever sends a path when the trainer is already
  // customized, and that path is `status.root`. So a broken `root` on an
  // already customized install is the only way left to reach this
  // rejection without an editable field.
  await gotoReadyTrainer(page, { customized: true, suggestedRoot: null, root: 'relative-path-not-allowed' })
  await page.getByRole('button', { name: 'Reinstall trainer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Reinstall the trainer?' })
  await dialog.getByRole('button', { name: 'Reinstall', exact: true }).click()
  // Der Dialog schliesst optimistisch (dieselbe UX wie beim "Set up trainer"
  // des Erstsetup-Gates); die Ablehnung erscheint als Statuszeile. Der Aufruf
  // GEHT raus -- nur die Rust-Validierung dahinter lehnt ab.
  const note = page.getByRole('status').filter({ hasText: 'absolute path' })
  await expect(note).toBeVisible()
  expect(await installCalls(page)).toHaveLength(1)
  await page.screenshot({ path: `${SHOT_DIR}/${testInfo.titlePath.length}-invalid-path-blocked.png` })
  // Erneutes Klicken auf Reinstall haeuft keinen zweiten Aufruf auf den
  // abgelehnten obendrauf -- der Knopf zeigt wieder sein Ruhe-Label.
  await expect(page.getByRole('button', { name: 'Reinstall trainer', exact: true })).toBeVisible()
})
