import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { openNewChat } from './support/ui'

/**
 * Auftrag 2.4: der Model-Schritt gehoert auch dem erfahrenen Nutzer.
 *
 * ── Der Befund ──
 *
 * Der Schritt „Model" wurde uebersprungen, sobald `/api/tags` irgendein
 * chatfaehiges Modell meldete (`existingModelCount > 0` → `setStep('embeddings')`).
 * Der Assistent lief damit an der einzigen Stelle vorbei, an der jemand sagen
 * kann, WOMIT er chatten will. Was danach passierte, entschied nicht der
 * Nutzer, sondern `modelStore.setModels`: es setzt, wenn keine Wahl vorliegt,
 * den ERSTEN chatfaehigen Eintrag der Liste. Eine Persona landete so im Chat
 * auf einem Qwen3-4B, das sie nie angefasst hatte.
 *
 * ── Warum diese Spec zwei Faelle fahren muss ──
 *
 * Davids aeltere Anweisung P4 lautete „Empfehlungen nur, wenn der User noch
 * gar kein Modell installiert hat". Das ist kein Widerspruch zu diesem
 * Auftrag, sondern die Trennlinie: die EMPFEHLUNG (das Abzeichen
 * „Recommended") verschwindet fuer erfahrene Nutzer, die AUSWAHL nicht. Eine
 * Spec, die nur den ersten Fall pruefte, koennte durch „Abzeichen immer
 * zeigen" gruen werden. Deshalb steht der zweite Fall daneben.
 *
 * ── Was hier wirklich gemessen wird ──
 *
 * Nicht, dass ein Bildschirm erscheint, sondern dass die Wahl ANKOMMT: die
 * letzte Zusicherung liest den Modellknopf des Composers, also den Zustand,
 * mit dem die naechste Nachricht hinausgeht. Gewaehlt wird bewusst das
 * ZWEITE installierte Modell, denn das erste ist genau das, was die
 * Selbstauswahl von `setModels` ohnehin nehmen wuerde: eine Zusicherung auf
 * das erste waere auch ohne jede Wahl gruen.
 *
 * Lauf: npx playwright test e2e/modellauswahl-bleibt-und-kommt-an.spec.ts
 */

/** Steht in der Liste vorn und ist damit das, was die Selbstauswahl nimmt. */
const ERSTES = 'qwen3:4b'
/** Die bewusste Wahl. Absichtlich NICHT das erste. */
const GEWAEHLT = 'llama3.1:8b'
/** Kann nicht chatten und darf deshalb nicht zur Wahl stehen. */
const EINBETTUNG = 'nomic-embed-text:latest'

/**
 * Bis zum Model-Schritt. Kein `seedOnboardingDone`, denn das setzt
 * `onboardingDone: true` und ist fuer eine Onboarding-Spec der falsche
 * Zustand; hier laeuft der Assistent wie beim Erststart (Vorbild:
 * e2e/onboarding-builtin.spec.ts).
 *
 * `platform: 'mac'` ist gepinnt, weil der ComfyUI-Bildschirm auf dem Mac
 * entfaellt (`nextStepAfterBackends`). Ohne das Pinnen haengt die Zahl der
 * Klicks an der Maschine, auf der die Spec laeuft.
 */
async function bisZumModellschritt(page: Page, ollamaModels: string[]) {
  // Der Typ steht dran, damit `platform` als 'mac' und nicht als `string`
  // hinausgeht: `addInitScript` leitet den Argumenttyp aus dem Literal ab,
  // und ein aufgeweiteter String passt nicht mehr auf `TauriMockOptions`.
  const opts: TauriMockOptions = {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'mac',
    ollamaModels,
  }
  await page.addInitScript(tauriMockInit, opts)
  await page.goto('/')

  // Willkommen
  await page.getByRole('button', { name: /Get Started/i }).click()
  // Maschine: die eingebaute ist vorausgewaehlt, der Rest liegt unter einer
  // zugeklappten Leiste und faellt fuer Playwright als verborgen weg.
  await page.getByRole('button', { name: /Continue/i }).click()
}

test('mit installierten Modellen bleibt der Schritt stehen, listet sie, und die Wahl kommt im Chat an', async ({ page }) => {
  await bisZumModellschritt(page, [ERSTES, GEWAEHLT, EINBETTUNG])

  // Erst warten, bis der Assistent seine Entscheidung getroffen hat, dann
  // fragen, welche es war. Der Sprung fiel FRUEHER nicht sofort, sondern
  // erst nachdem `/api/tags` geantwortet hatte. Ein sofortiges
  // `toHaveCount(0)` auf den Dokumenten-Schritt waere gruen gewesen, bevor
  // der Fehler ueberhaupt eintreten konnte (Falle „Momentaufnahme statt
  // wartender Zusicherung").
  await expect(page.getByText(/Models you already have|Document Chat/).first()).toBeVisible()
  // Der Befund in einer Zeile: hier stand der Dokumenten-Schritt, weil der
  // Modellschritt sich selbst uebersprungen hat.
  await expect(page.getByRole('heading', { name: /Document Chat/i })).toHaveCount(0)

  // Der Schritt ist da und nennt sich nach dem, was er hier tut.
  await expect(page.getByRole('heading', { name: /Pick your chat model/i })).toBeVisible()

  // Er stellt die eigenen Modelle zur Wahl …
  await expect(page.getByRole('button', { name: /qwen3:4b/ })).toBeVisible()
  const wahl = page.getByRole('button', { name: /llama3\.1:8b/ })
  await expect(wahl).toBeVisible()
  // … und nur die chatfaehigen davon.
  await expect(page.getByRole('button', { name: /nomic-embed-text/ })).toHaveCount(0)

  // P4 bleibt unangetastet: Auswahl ja, Werbung nein.
  await expect(page.getByText('Recommended', { exact: true })).toHaveCount(0)

  await wahl.click()
  await page.getByRole('button', { name: /Continue/i }).click()
  // Dokumente ueberspringen, fertig, hinein in den Chat.
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await page.getByRole('button', { name: /Get Started/i }).click()
  await openNewChat(page)

  // Der Modellknopf des Composers. Er kuerzt die Groessenangabe bewusst weg
  // (`displayModelName(activeModel).split(':')[0]` in ModelSelector), zeigt
  // also die Familie und nicht die volle Kennung. Ein Waechter, der hier die
  // volle Kennung verlangte, wuerde die Anzeige festnageln statt die Wahl.
  const picker = page.getByRole('button', { name: /Select chat model/i })
  await expect(picker).toBeVisible({ timeout: 20_000 })
  await expect(picker).toHaveAttribute('title', /Model: llama3\.1,/, { timeout: 20_000 })

  // Und der eigentliche Beweis am Payload statt am Bildschirm: mit welchem
  // Modell geht die naechste Nachricht wirklich hinaus? Hausregel seit dem
  // 03.09.2026 (`__E2E_CHAT_BODIES__`, Commits 21ad48af / e0bf9112).
  await page.evaluate(() => {
    (window as never as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ = []
  })
  const feld = page.locator('textarea').first()
  await feld.click()
  await feld.fill('which model is answering?')
  await page.getByRole('button', { name: /Send message/i }).click()

  await expect.poll(async () => (await koerper(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)
  const erster = JSON.parse((await koerper(page))[0]) as { model?: string }
  expect(erster.model).toBe(GEWAEHLT)
})

async function koerper(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as never as { __E2E_CHAT_BODIES__?: string[] }).__E2E_CHAT_BODIES__ ?? [],
  )
}

test('ohne installierte Modelle steht die Empfehlung weiterhin da', async ({ page }) => {
  await bisZumModellschritt(page, [])

  await expect(page.getByRole('heading', { name: /Pick a starter model/i })).toBeVisible()
  // Genau das, was P4 erlaubt: der frische Nutzer bekommt eine Empfehlung.
  await expect(page.getByText('Recommended', { exact: true })).toBeVisible()
  // Und keine Liste eigener Modelle, weil es keine gibt.
  await expect(page.getByText(/Models you already have/i)).toHaveCount(0)
})
