import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { openNewChat } from './support/ui'

/**
 * David am 07.09.2026: das Kontextfenster im Chat ist abgeschnitten, "wenn man
 * den Context neu ausfuellen moechte".
 *
 * Nachgemessen bei 1280x800, vor der Reparatur: die Liste stand von y=686 bis
 * y=874. Das Fenster endet bei 800, der `<main>`-Kasten mit `overflow-hidden`
 * (die abgerundete Pane) schon bei 790,8. Sichtbar waren 105 von 188 px, die
 * halbe Auswahl fehlte, und `32K` und der Hinweis darunter waren gar nicht zu
 * erreichen.
 *
 * Die Ursache war eine Annahme, keine Klasse: das Menue ging fest nach unten
 * auf (`top-full`), und sein Ausloeser ist mit dem 2.6.8-Umbau der
 * Eingabezeile von oberhalb des Verlaufs an den unteren Rand gewandert, direkt
 * ueber den Composer. Darunter sind rund 100 px Platz.
 *
 * Gemessen wird hier gegen die Flaeche, die WIRKLICH abschneidet, und nicht
 * gegen das Fenster: die beiden liegen 9 px auseinander, und wer gegen das
 * Fenster prueft, laesst genau diese 9 px durchgehen.
 */

async function completeBuiltinOnboarding(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await page.goto('/')

  await expect(page.getByRole('button', { name: /Get Started/i })).toBeVisible()
  await page.getByRole('button', { name: /Get Started/i }).click()
  await expect(page.getByRole('button', { name: /Continue/i })).toBeVisible()
  await page.getByRole('button', { name: /Continue/i }).click()
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible()
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await expect(page.getByRole('heading', { name: /Pick a starter model/i })).toBeVisible()
  await page.getByRole('button', { name: /Qwen 2\.5 0\.5B/i }).click()
  await page.getByRole('button', { name: /Install \d+ model/i }).click()
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await expect(page.getByRole('button', { name: /Get Started/i })).toBeVisible()
  await page.getByRole('button', { name: /Get Started/i }).click()
}

/** Liste, Fensterhoehe und die Kanten der abschneidenden Flaeche. */
async function messen(page: Page) {
  const auto = page.getByRole('button', { name: /^Auto/ })
  await expect(auto).toBeVisible()
  return auto.locator('xpath=..').evaluate((el) => {
    let oben = 0
    let unten = window.innerHeight
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
        const b = p.getBoundingClientRect()
        oben = b.top
        unten = b.bottom
        break
      }
    }
    const r = el.getBoundingClientRect()
    return {
      top: r.top,
      bottom: r.bottom,
      hoehe: r.height,
      sichtbar: el.clientHeight,
      inhalt: el.scrollHeight,
      grenzeOben: oben,
      grenzeUnten: unten,
    }
  })
}

test('die Kontextliste bleibt ganz in der Flaeche, die sie abschneiden koennte', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await completeBuiltinOnboarding(page)
  await openNewChat(page)

  const trigger = page.getByRole('button', { name: 'Context window' })
  await expect(trigger).toHaveCount(1)
  await trigger.click()

  const m = await messen(page)
  // Die eigentliche Zusage, in beide Richtungen.
  expect(m.bottom, `die Liste ragt ${Math.round(m.bottom - m.grenzeUnten)} px unter die abschneidende Kante`)
    .toBeLessThanOrEqual(m.grenzeUnten)
  expect(m.top, `die Liste ragt ${Math.round(m.grenzeOben - m.top)} px ueber die abschneidende Kante`)
    .toBeGreaterThanOrEqual(m.grenzeOben)

  // Und sie ist nicht dadurch "ganz drin", dass sie ihren Inhalt weggekuerzt
  // hat: in diesem Fenster ist Platz genug, also steht sie vollstaendig da,
  // von der obersten Auswahl bis zur letzten Zeile. Ohne diese beiden Faelle
  // waere ein Menue gruen, das die Kante haelt und trotzdem an der Auswahl
  // vorbeigeht.
  await expect(page.getByRole('button', { name: /^32K$/ })).toBeInViewport({ ratio: 1 })
  await expect(page.getByText('Reloads the model on change.')).toBeInViewport({ ratio: 1 })
})

test('im flachen Fenster scrollt sie, statt aus der Flaeche zu laufen', async ({ page }) => {
  // Die Gegenprobe zum Kippen: hier reicht WEDER oben noch unten. Ohne die
  // Hoehendeckelung waere das Menue wieder abgeschnitten, und mit einer
  // Mindesthoehe waere es das auch: der erste Anlauf hatte 96 px als
  // Untergrenze und stand damit hier 6 px im Geschnittenen.
  await page.setViewportSize({ width: 1280, height: 300 })
  await completeBuiltinOnboarding(page)
  await openNewChat(page)

  const trigger = page.getByRole('button', { name: 'Context window' })
  await trigger.click()

  const m = await messen(page)
  expect(m.bottom).toBeLessThanOrEqual(m.grenzeUnten)
  expect(m.top).toBeGreaterThanOrEqual(m.grenzeOben)
  // Gedeckelt, also gescrollt, und nicht ueber die Kante gewachsen.
  expect(m.inhalt, 'die Liste haette hier scrollen muessen').toBeGreaterThan(m.sichtbar)
})
