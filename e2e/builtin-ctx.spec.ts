import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { openNewChat } from './support/ui'

/**
 * ENG-5 acceptance — the built-in engine's context window is HONEST end to end:
 *
 *   1. The Context dropdown relaunches the engine with the chosen ctx (the
 *      tuning is injected from settings into swap_bundled_model), and the
 *      TokenCounter denominator follows the engine's reported ctx — not a
 *      hardcoded guess (the pre-2.6.0 counter lied with a fixed 16k).
 *   2. The Settings → AI Backends expert panel (ENG-2) shows the live engine
 *      status incl. its real ctx and "Apply & Restart Engine" relaunches with
 *      the edited tuning.
 *
 * The Tauri mock mirrors ENG-1 Rust semantics: every start/swap derives the
 * engine ctx from the injected tuning and `bundled_engine_status` reports it.
 *
 * ── Warum Test 1 seit D-S06 (b3f0f786) anders fragt ─────────────────────────
 *
 * Er suchte den Waehler ueber seine Beschriftung "ctx 8K" und den Fuellstand
 * als zweites, danebenstehendes Element ("/8.2k"). Genau diese ZWEI Anzeigen
 * hat der Design-Audit zu einer zusammengelegt: dieselbe Zahl stand 24 px
 * nebeneinander in zwei Schreibweisen, und wer den Unterschied las, suchte
 * einen, den es nicht gibt. Der Fuellstand ist jetzt die Beschriftung des
 * Waehlers — der Messwert sitzt auf dem Regler, der ihn bewegt.
 *
 * Der Spec hielt damit einen ERSETZTEN Entwurf fest. Die Behauptung dahinter
 * gilt unveraendert, also prueft er sie jetzt am neuen Entwurf, und zwar
 * schaerfer als vorher:
 *
 *   • EIN Bedienelement. Gefunden ueber `aria-label="Context window"` — eine
 *     stabile Rolle mit stabilem Namen, nicht ueber seinen wechselnden Text.
 *     Das ist staerker als der alte Texttreffer UND staerker als ein Muster
 *     auf `\d+/[\d.]+k`, das jede beliebige Zahlenpaarung akzeptiert haette.
 *   • Der Fuellstand steht IN diesem Knopf (`trigger.getByText`), nicht
 *     daneben. Das ist die Zusammenlegung selbst, und nur diese Verschachtelung
 *     unterscheidet den neuen Entwurf vom alten.
 *   • Die beiden Schreibweisen sind NIE gleichzeitig zu sehen — sobald ein
 *     Fuellstand da ist, ist "ctx 8K" fort. Der alte Entwurf zeigte beides.
 *   • ENG-3 (beide lesen dieselbe `status.ctx`) wird an DEMSELBEN Knopf in
 *     seinen beiden Lesarten gemessen: im leeren Chat traegt er
 *     `ctx {fmt(ctx.contextWindow)}` — das ist die Lesart des WAEHLERS —, mit
 *     Nachrichten den Nenner des Fuellstands, den `TokenCounter` ueber seine
 *     EIGENE `useActiveContextWindow()`-Instanz aufloest. Zwei unabhaengige
 *     Ableitungen, eine Zahl, vorher und nach dem Wechsel auf 16K.
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

test('context dropdown relaunches the built-in engine and the counter follows', async ({ page }) => {
  await completeBuiltinOnboarding(page)

  // Der eine Waehler, weiterhin ueber seinen Namen gegriffen und nie ueber
  // das, was gerade darin steht.
  //
  // KF-9 hat `exact: true` gekostet, und zwar begruendet. Der Name war
  // „Context window" — ein `aria-label`, das den SICHTBAREN Text („117/16.4k")
  // ersetzte statt ihn zu enthalten. Das ist der Verstoss gegen WCAG 2.5.3
  // (Label in Name), und seit D-S06 ist dieser Knopf die einzige Stelle, an
  // der die Zahl noch steht: fuer einen Screenreader war sie nirgends mehr zu
  // holen. Der Name lautet jetzt „Context window 117/16.4k" (unsichtbares
  // Praefix via `aria-labelledby`, dahinter der gerenderte Text).
  //
  // Beides zugleich — Messwert hoerbar UND Name buchstabengleich stabil — geht
  // nicht: ein exakter Name „Context window" schliesst die Zahl per Definition
  // aus. Was stabil BLEIBT, ist das Praefix, und genau darauf greift der
  // Teilstring-Treffer hier. Er ist keine Lockerung: „Context window" trifft
  // in dieser App weiterhin genau ein Bedienelement, und der Zaehler dahinter
  // wird unten ohnehin Ziffer fuer Ziffer geprueft.
  const trigger = page.getByRole('button', { name: 'Context window' })

  await openNewChat(page)
  // Der Teilstring trifft genau einen Knopf — sonst waere die Lockerung oben
  // eine Verschlechterung und nicht bloss eine andere Schreibweise.
  await expect(trigger).toHaveCount(1)
  // Leerer Chat: `TokenCounter` liefert `null`, also traegt der Knopf die
  // Lesart des WAEHLERS — `ctx.contextWindow` aus seiner eigenen
  // `useActiveContextWindow(tick)`-Instanz. Default-Tuning = -c 8192.
  await expect(trigger).toHaveText(/ctx 8K/)

  // Chat once so the TokenCounter renders (it needs messages).
  const composer = page.locator('textarea').first()
  await composer.fill('ping the built-in engine')
  await page.getByRole('button', { name: /Send message/i }).click()
  await expect(page.getByText(/PONG_BUILTIN_OK/)).toBeVisible({ timeout: 20_000 })

  // Jetzt IST der Fuellstand die Beschriftung: derselbe Knopf, aber die Zahl
  // kommt aus `TokenCounter` — 8.2k ist derselbe 8192er Wert, ueber eine
  // zweite, unabhaengige Aufloesung derselben `status.ctx` (ENG-3).
  await expect(trigger.getByText(/\/8\.2k/)).toBeVisible()
  // …und die zweite Anzeige ist wirklich fort, nicht bloss verschoben. Beide
  // Schreibweisen nebeneinander waren der Befund von D-S06.
  await expect(page.getByText(/ctx \d+K/)).toHaveCount(0)

  // Pick 16K → apply() persists tuning.ctx and swaps the running engine.
  // The preset list is capped at the model's TRAINED ceiling (32k from the
  // GGUF header via the listing) — no 64K/128K options for a 32k model.
  await trigger.click()
  await expect(page.getByRole('button', { name: /^32K$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^64K$/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^128K$/ })).toHaveCount(0)
  await page.getByRole('button', { name: /^16K$/ }).click()

  // Der Nenner des Fuellstands folgt der neuen Engine-ctx …
  await expect(trigger.getByText(/\/16\.4k/)).toBeVisible({ timeout: 10_000 })
  // … und die Lesart des Waehlers ebenso: ein frischer, leerer Chat zeigt
  // wieder `ctx N`, und das N ist die vom Backend GEMELDETE ctx, nicht die
  // gespeicherte Einstellung. Ohne diesen Schritt wuerde nur noch eine der
  // beiden Lesarten geprueft, und ENG-3 waere halb gemessen.
  await openNewChat(page)
  await expect(trigger).toHaveText(/ctx 16K/, { timeout: 10_000 })

  // The relaunch carried the settings-injected tuning, aimed at the loaded GGUF.
  const swap = await page.evaluate(() => {
    const calls = (window as unknown as { __E2E_ENGINE_CALLS__?: { cmd: string; modelPath?: string; tuning?: { ctx?: number } }[] }).__E2E_ENGINE_CALLS__ || []
    return calls.filter((c) => c.cmd === 'swap_bundled_model').pop() ?? null
  })
  expect(swap?.tuning?.ctx).toBe(16384)
  expect(swap?.modelPath).toContain(DEFAULT_MODEL_NAME)
})

test('expert panel shows live engine status and Apply & Restart uses the edited tuning', async ({ page }) => {
  await completeBuiltinOnboarding(page)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: /AI Backends/i }).click()

  // The expert section only renders while the managed built-in engine
  // occupies the openai slot — which the onboarding just configured. It is
  // a collapsed <Section>; open it first.
  await page.getByRole('button', { name: /Built-in Engine \(expert\)/i }).click()
  await expect(page.getByText(/Expert settings for the built-in engine/i)).toBeVisible()
  await expect(page.getByText(/Engine running/)).toBeVisible()
  await expect(page.getByText(/ctx 8,192/)).toBeVisible()

  // Raise the context, then Apply & Restart → swap with the new tuning and
  // the status line re-reads the engine's real ctx.
  const ctxInput = page.locator('input[placeholder="8192"]')
  await ctxInput.fill('32768')
  await page.getByRole('button', { name: /Apply & Restart Engine/i }).click()
  await expect(page.getByText(/ctx 32,768/)).toBeVisible({ timeout: 10_000 })

  const swap = await page.evaluate(() => {
    const calls = (window as unknown as { __E2E_ENGINE_CALLS__?: { cmd: string; tuning?: { ctx?: number; cacheTypeK?: string } }[] }).__E2E_ENGINE_CALLS__ || []
    return calls.filter((c) => c.cmd === 'swap_bundled_model').pop() ?? null
  })
  expect(swap?.tuning?.ctx).toBe(32768)
  // The full tuning blob rides along (not just ctx) — the whole point of ENG-2.
  expect(swap?.tuning?.cacheTypeK).toBeDefined()
})
