import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Alt-Fehler (gefunden waehrend der Flash-Popup-Arbeit, Runde 4, 19.09.2026,
 * Wurzel-Fix neu gefasst Runde 5): bei 360px Fensterbreite fasst die
 * Aktionszeile des Composers (Clip, Voice, Think, Effort, die view-eigenen
 * Actions, Sampling, der Modellwaehler, Send) mehr Knoepfe, als die Zeile
 * breit ist (gemessen: `scrollWidth` 586 gegen `clientWidth` 207,
 * `ChatInput.tsx` traegt selbst keinen eigenen Bildlauf). Ein Klick auf einen
 * Ausloeser, der teilweise oder ganz ausserhalb der sichtbaren Zeile lag,
 * loeste Playwrights eigene Actionability-Pruefung aus, die vor jedem
 * `.click()` das Ziel per `scrollIntoView` in Sicht holt, auch wenn keine
 * echte Maus das je koennte. Das traf den gemeinsamen `overflow-hidden`-
 * Vorfahren (`ChatView.tsx`, umschliesst Verlauf UND Composer), und
 * `overflow: hidden` erlaubt programmatisches Scrollen trotz fehlender
 * Bildlaufleiste. Das Ergebnis: die ganze Spalte verschob sich seitlich,
 * Verlauf inklusive, dauerhaft, auch nach dem Schliessen des Menues
 * (gemessen vor dem Fix: 290 bis 357px).
 *
 * Der Fix (`ChatView.tsx`): der gemeinsame Vorfahr traegt jetzt
 * `overflow-clip` statt `overflow-hidden`. Das clippt genauso (CSS Overflow
 * Module Level 3), lehnt aber `scrollLeft`-Zuweisungen darauf ab, egal ob
 * von einer echten Interaktion oder von Playwrights Assist. Die drei Popups
 * (ModelSelector, SamplingControls, PluginsDropdown) bleiben
 * `position: absolute`, unveraendert gegenueber dem Stand vor Runde 4.
 *
 * Nachmessung Runde 5: bei 360px liegt der Modellwaehler-Ausloeser selbst
 * bei `x` 525, "Sampling" bei 423, "Send message" bei 732, alle drei
 * vollstaendig hinter dem 360px-Fensterrand, unabhaengig vom Fix. Das ist
 * dieselbe Zeilen-Enge, die oben beschrieben ist, nur jetzt ohne den
 * Playwright-Assist, der sie bisher verdeckt hat: eine echte Maus haette
 * diese Knoepfe bei 360px nie erreicht. Diese Spec prueft den Leck-Fix
 * deshalb bei 360px an den Knoepfen, die dort WIRKLICH erreichbar sind
 * (Clip, Voice, Think, alle innerhalb des 360px-Fensters gemessen), plus
 * direkt am Vorfahren selbst (Negativkontrolle unten); bei 900 und 1280px,
 * wo die Zeile keinen Ueberlauf hat (`scrollWidth === clientWidth`,
 * gemessen), laeuft der volle Oeffnen/Waehlen/Schliessen-Weg am
 * Modellwaehler selbst.
 *
 * Seit 3.0.9 (P2, schmales Fenster) bricht die Aktionszeile unter 26rem in
 * zwei Zeilen um: bei 360px laeuft sie nicht mehr ueber (`scrollWidth ===
 * clientWidth`, gemessen 233), Modellwaehler und Send liegen im Fenster. Der
 * Vorfahr hat dort also von sich aus nichts mehr zu verschieben. Damit die
 * Pruefung unten weiter etwas misst, gibt `erzwingeUeberlauf` ihm zur Laufzeit
 * einen ueberbreiten Inhalt; der Schutz (`overflow-clip`) bleibt, was geprueft
 * wird.
 */

/**
 * Der gemeinsame Vorfahr, der Verlauf UND Composer umschliesst
 * (`ChatView.tsx`, `flex-1 flex overflow-clip min-h-0`). Gemessen (nicht nur
 * angenommen): `getComputedStyle().overflowX`/`overflowY` melden fuer diesen
 * Knoten `'clip'`, NICHT `'hidden'`, die beiden Rechenwerte des CSS Overflow
 * Module Level 3 sind unterschiedlich. Die Suche prueft deshalb auf beide
 * Werte, sonst faende sie den naechsten `overflow-hidden`-Vorfahren weiter
 * oben (`MAIN.overflow-hidden`), der selbst keinen eigenen Ueberlauf hat
 * (`scrollWidth === clientWidth`) und die Messung stumm bedeutungslos macht.
 */
async function findeSchneidendenVorfahren(page: Page) {
  return page.evaluateHandle(() => {
    const btn = document.querySelector('[aria-label="Select chat model"]') as HTMLElement
    let p: HTMLElement | null = btn
    while (p) {
      const cs = getComputedStyle(p)
      if (cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || cs.overflowX === 'clip' || cs.overflowY === 'clip') return p
      p = p.parentElement
    }
    return null
  })
}

/** Ein 2000px breiter, leerer Inhalt im Vorfahren, damit er etwas zu
 *  verschieben haette: ohne Ueberlauf bliebe jede `scrollLeft`-Zuweisung 0,
 *  mit `clip` wie mit `hidden`, und die Pruefung saehe nichts. */
async function erzwingeUeberlauf(page: Page, handle: Awaited<ReturnType<typeof findeSchneidendenVorfahren>>) {
  const breit = await page.evaluate((el) => {
    const node = el as HTMLElement | null
    if (!node) return null
    const platz = document.createElement('div')
    platz.setAttribute('aria-hidden', 'true')
    platz.style.cssText = 'flex: 0 0 2000px; width: 2000px; height: 1px'
    node.appendChild(platz)
    return node.scrollWidth > node.clientWidth
  }, handle)
  expect(breit, 'der Vorfahr muss jetzt ueberlaufen').toBe(true)
}

async function scrollLeftVon(page: Page, handle: Awaited<ReturnType<typeof findeSchneidendenVorfahren>>) {
  return page.evaluate((el) => (el as HTMLElement | null)?.scrollLeft ?? null, handle)
}

/**
 * `--ui-scale` ist die CSS-Variable, die `zoom` auf `#root` treibt
 * (`index.css:381/518`), Standardwert 1.15. Ohne Ueberschreibung testet jeder
 * Lauf also schon den Standard; die zweite Stufe (1) wird hier explizit
 * gesetzt, um beide Werte aus der Aufgabe abzudecken.
 */
async function boot(page: Page, width: number, height: number, uiScale = 1.15): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.goto('/')
  if (uiScale !== 1.15) {
    await page.evaluate((s) => document.documentElement.style.setProperty('--ui-scale', String(s)), uiScale)
  }
  await page.getByRole('button', { name: /New Chat/i }).first().click()
}

const WIDE_SIZES: Array<{ label: string; width: number; height: number }> = [
  { label: '900x600 (kleines Fenster)', width: 900, height: 600 },
  { label: '1280x800 (breiter Desktop)', width: 1280, height: 800 },
]

for (const { label, width, height } of WIDE_SIZES) {
  for (const uiScale of [1, 1.15]) {
  test(`scrollLeft bleibt 0 durch Oeffnen, Waehlen, Schliessen bei ${label}, --ui-scale ${uiScale}`, async ({ page }) => {
    await boot(page, width, height, uiScale)
    const vorfahr = await findeSchneidendenVorfahren(page)
    expect(await scrollLeftVon(page, vorfahr)).toBe(0)

    const trigger = page.getByRole('button', { name: 'Select chat model', exact: true })
    await trigger.click()
    expect(await scrollLeftVon(page, vorfahr), 'nach dem Oeffnen').toBe(0)

    const menu = page.getByTestId('model-picker-menu')
    await expect(menu).toBeVisible()
    // Das Menue selbst muss vollstaendig bedienbar bleiben: nicht nur
    // "gefunden" (`toBeVisible` prueft CSS-Sichtbarkeit, nicht Lage im
    // Fenster), das X-lose Menue hat hier keinen eigenen Schliessknopf, also
    // wird die erste Modellzeile direkt vermessen.
    const row = page.locator('[data-testid="model-picker-menu"] [role="button"]').first()
    await expect(row).toBeVisible()
    const kasten = await row.boundingBox()
    expect(kasten, 'die Modellzeile muss ein messbares Rechteck haben').not.toBeNull()
    if (kasten) {
      expect(kasten.x).toBeGreaterThanOrEqual(0)
      expect(kasten.y).toBeGreaterThanOrEqual(0)
      expect(kasten.x + kasten.width).toBeLessThanOrEqual(width + 0.5)
      expect(kasten.y + kasten.height).toBeLessThanOrEqual(height + 0.5)
    }

    await row.click()
    await expect(menu).toBeHidden()
    expect(await scrollLeftVon(page, vorfahr), 'nach der Wahl, Menue zu').toBe(0)

    // Nochmal oeffnen und mit Escape schliessen, der zweite Weg hinaus.
    await trigger.click()
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    expect(await scrollLeftVon(page, vorfahr), 'nach Escape').toBe(0)
  })
  }
}

/**
 * 360px: der Modellwaehler selbst ist nicht erreichbar (siehe Dateikopf),
 * unabhaengig vom Fix. Geprueft wird hier trotzdem der volle Umfang des
 * Fixes bei genau dieser Breite: `scrollLeft` startet bei 0, bleibt 0 durch
 * eine echte Interaktion mit einem Knopf, der bei 360px WIRKLICH im Fenster
 * liegt (Clip, gemessen bei x 106 bis 136), und eine direkte Zuweisung auf
 * den Vorfahren selbst (das ist exakt die Operation, die `scrollIntoView`
 * vorher ausgeloest hat) bleibt wirkungslos.
 */
for (const uiScale of [1, 1.15]) {
test(`scrollLeft bleibt 0 bei 360px, auch nach einer echten Interaktion in der Zeile, --ui-scale ${uiScale}`, async ({ page }) => {
  await boot(page, 360, 720, uiScale)
  const vorfahr = await findeSchneidendenVorfahren(page)
  expect(await scrollLeftVon(page, vorfahr)).toBe(0)

  // Ein Knopf, der bei 360px WIRKLICH im Fenster liegt (nicht der
  // Modellwaehler, siehe Dateikopf): das Clip-Icon, ganz links in der Zeile.
  const clip = page.getByRole('button', { name: /Attach images/ })
  const box = await clip.boundingBox()
  expect(box, 'der Clip-Knopf muss messbar sein').not.toBeNull()
  if (box) {
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(360)
  }
  await clip.click()
  expect(await scrollLeftVon(page, vorfahr), 'nach dem Klick auf einen erreichbaren Knopf').toBe(0)

  // Genau die Operation, die vor dem Fix ueber `scrollIntoView` auf diesem
  // Vorfahren landete: eine direkte `scrollLeft`-Zuweisung. `overflow: clip`
  // lehnt sie ab, `overflow: hidden` (der Zustand vor dem Fix) haette sie
  // angenommen, siehe die Negativkontrolle unten.
  await erzwingeUeberlauf(page, vorfahr)
  await page.evaluate((el) => {
    const node = el as HTMLElement | null
    if (node) node.scrollLeft = 300
  }, vorfahr)
  expect(await scrollLeftVon(page, vorfahr), 'nach direkter scrollLeft-Zuweisung').toBe(0)
})
}

/**
 * Negativkontrolle: beweist, dass die Messung oben wirklich etwas prueft.
 *
 * Am LAUFENDEN, echten Baum wird der Fix zur Laufzeit zurueckgedreht (keine
 * Quelldatei angefasst, `page.evaluate` setzt nur die Inline-Stilregel des
 * gefundenen Vorfahren zurueck): er bekommt wieder `overflow: hidden`, genau
 * der Zustand vor diesem Fix, in dem `scrollLeft`-Zuweisungen wirken.
 */
test('Negativkontrolle: ohne overflow-clip auf dem Vorfahren wirkt eine scrollLeft-Zuweisung', async ({ page }) => {
  await boot(page, 360, 720)
  const vorfahr = await findeSchneidendenVorfahren(page)
  expect(await scrollLeftVon(page, vorfahr)).toBe(0)

  await erzwingeUeberlauf(page, vorfahr)
  await page.evaluate((el) => {
    (el as HTMLElement | null)?.style.setProperty('overflow', 'hidden')
  }, vorfahr)

  await page.evaluate((el) => {
    const node = el as HTMLElement | null
    if (node) node.scrollLeft = 300
  }, vorfahr)

  const nachher = await scrollLeftVon(page, vorfahr)
  expect(nachher, 'mit overflow: hidden statt clip nimmt der Vorfahr die Zuweisung an').not.toBe(0)
})

/** 3.0.9: bei 360px bricht die Zeile um, statt ueberzulaufen; Modellwaehler
 *  und Send liegen ganz im Fenster, eine echte Maus erreicht sie. */
for (const uiScale of [1, 1.15]) {
test(`bei 360px laeuft die Zeile nicht ueber, Modellwaehler und Send liegen im Fenster, --ui-scale ${uiScale}`, async ({ page }) => {
  await boot(page, 360, 720, uiScale)
  const vorfahr = await findeSchneidendenVorfahren(page)
  const masse = await page.evaluate((el) => {
    const node = el as HTMLElement
    return { sw: node.scrollWidth, cw: node.clientWidth }
  }, vorfahr)
  expect(masse.sw).toBeLessThanOrEqual(masse.cw)
  for (const knopf of [
    page.getByRole('button', { name: 'Select chat model', exact: true }),
    page.getByTestId('composer-send-slot'),
    page.getByTestId('sampling-trigger'),
  ]) {
    const box = await knopf.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(360)
  }
  await page.getByRole('button', { name: 'Select chat model', exact: true }).click()
  await expect(page.getByTestId('model-picker-menu')).toBeVisible()
  expect(await scrollLeftVon(page, vorfahr), 'nach dem Oeffnen bei 360px').toBe(0)
})
}

/**
 * Sichtbarkeitsfall fuer den VoiceButton-Tooltip: diese Runde ruehrt
 * `ChatInput.tsx`s Werkzeugzeile selbst nicht an (anders als Runde 4, die
 * die Zeile auf `overflow-x-auto` umstellte und damit `overflow-y` auf
 * `auto` mitzog, was den Tooltip, der `bottom-full` ueber die Zeile hinaus
 * oeffnet, abschnitt, siehe Review-Blocker 3). Der Fix dieser Runde aendert
 * nur den VIEL groesseren `ChatView.tsx`-Vorfahren, dessen Kasten den
 * Tooltip an dieser Stelle bei weitem nicht beruehrt. Gemessen bei 360px,
 * wo im Testaufbau kein STT installiert ist (`sttSupported` false), also
 * "Microphone unavailable" mit eigenem Tooltip.
 */
test('VoiceButton-Tooltip bleibt bei 360px vollstaendig sichtbar, nicht abgeschnitten', async ({ page }) => {
  await boot(page, 360, 720)
  const mic = page.getByRole('button', { name: 'Microphone unavailable' })
  await expect(mic).toBeVisible()
  await mic.hover()
  const tooltip = page.locator('.group\\/mic .absolute.bottom-full')
  await expect(tooltip).toHaveCSS('opacity', '1')
  const kasten = await tooltip.boundingBox()
  expect(kasten, 'der Tooltip muss ein messbares Rechteck haben').not.toBeNull()
  if (kasten) {
    expect(kasten.y, 'oberer Rand nicht negativ, also nicht ueber das Fenster hinaus').toBeGreaterThanOrEqual(0)
    expect(kasten.height, 'eine echte Hoehe, nicht auf 0 geclippt').toBeGreaterThan(10)
  }
})

/**
 * Derselbe Leck-Pfad, jetzt im Code-Reiter (`CodexView.tsx`, gefixt auf
 * Weisung des Orchestrators, gleiche Runde wie `d18d05a8`): dort sitzen
 * dieselben drei Ausloeser (Modellwaehler, CodexModeDropdown,
 * PluginsDropdown) in einer eigenen Zeile mit einem EIGENEN, NAEHEREN
 * `overflow-hidden`-Vorfahren (`CodexView.tsx`, das "Main panel" umschliesst,
 * verschachtelt INNERHALB von ChatView.tsx's bereits gefixtem Vorfahren).
 * `findeSchneidendenVorfahren` findet den naechsten Vorfahren zuerst, misst
 * hier also den CodexView-eigenen Knoten, nicht den von ChatView.tsx.
 */
async function bootCode(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.goto('/')
  // Modus zuerst, dann Chat: der Moduswechsel raeumt die aktive Unterhaltung
  // weg (wie in coding-agent.spec.ts's boot() dokumentiert).
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await page.getByRole('button', { name: /New Chat/i }).first().click()
}

test('Code-Reiter: scrollLeft bleibt 0 durch Oeffnen, Waehlen, Schliessen bei 1280x800', async ({ page }) => {
  await bootCode(page, 1280, 800)
  const vorfahr = await findeSchneidendenVorfahren(page)
  expect(await scrollLeftVon(page, vorfahr)).toBe(0)

  const trigger = page.getByRole('button', { name: 'Select chat model', exact: true })
  await trigger.click()
  expect(await scrollLeftVon(page, vorfahr), 'nach dem Oeffnen').toBe(0)

  const menu = page.getByTestId('model-picker-menu')
  await expect(menu).toBeVisible()
  const row = page.locator('[data-testid="model-picker-menu"] [role="button"]').first()
  await expect(row).toBeVisible()
  await row.click()
  await expect(menu).toBeHidden()
  expect(await scrollLeftVon(page, vorfahr), 'nach der Wahl, Menue zu').toBe(0)

  await trigger.click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  expect(await scrollLeftVon(page, vorfahr), 'nach Escape').toBe(0)
})

/**
 * Negativkontrolle fuer den Code-Reiter, gleiches Muster wie oben fuer den
 * Chat-Reiter: der echte, laufende Baum bekommt seinen CodexView-Vorfahren
 * zur Laufzeit auf `overflow: hidden` zurueckgesetzt (keine Quelldatei
 * angefasst), eine direkte `scrollLeft`-Zuweisung wirkt dann wieder.
 */
test('Negativkontrolle Code-Reiter: ohne overflow-clip auf dem CodexView-Vorfahren wirkt eine scrollLeft-Zuweisung', async ({ page }) => {
  // 360px, nicht 1280px: die geteilte `ChatInput`-Werkzeugzeile (Chat und
  // Code teilen sich dieselbe Komponente) laeuft dort tatsaechlich ueber
  // (derselbe Befund wie im Dateikopf fuer den Chat-Reiter), sonst gaebe es
  // nichts zu scrollen und die Negativkontrolle waere wirkungslos, egal ob
  // `hidden` oder `clip`.
  await bootCode(page, 360, 720)
  const vorfahr = await findeSchneidendenVorfahren(page)
  expect(await scrollLeftVon(page, vorfahr)).toBe(0)

  await page.evaluate((el) => {
    (el as HTMLElement | null)?.style.setProperty('overflow', 'hidden')
  }, vorfahr)

  await page.evaluate((el) => {
    const node = el as HTMLElement | null
    if (node) node.scrollLeft = 300
  }, vorfahr)

  const nachher = await scrollLeftVon(page, vorfahr)
  expect(nachher, 'mit overflow: hidden statt clip nimmt der Vorfahr die Zuweisung an').not.toBe(0)
})
