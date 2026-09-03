import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Der Test-Knopf in den Einstellungen darf nicht zweimal dasselbe Wort sagen.
 *
 * Persona-Befund vom 03.09.2026: "Connected, obwohl gar kein Chat moeglich
 * ist, er prueft offenbar nur den GET-Pfad". Nachgemessen mit einem
 * OpenAI-kompatiblen Anbieter auf :1234, dessen `GET /v1/models` mit 200
 * antwortet, einmal mit einem Modell und einmal mit einer leeren Liste:
 *
 *   leer  -> "Connected"
 *   eins  -> "Connected"
 *
 * Ein LM Studio mit laufendem Server ohne geladenes Modell ist genau der
 * erste Fall, und dort kann keine einzige Nachricht durchgehen.
 */

/** Ein Anbieter im lokalen Slot, dessen Modellliste der Test vorgibt. */
async function bootAnbieter(page: Page, modelle: string[]) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await page.addInitScript((liste: string[]) => {
    window.localStorage.setItem(
      'lu-providers',
      JSON.stringify({
        state: {
          // Der Waehler "2 local backends detected" legt sich sonst ueber die
          // App und faengt jeden Klick ab: der Mock laesst Ollamas /tags mit
          // einer leeren Liste durchgehen, und der Anbieter unten antwortet
          // auch. Hier geht es um den Test-Knopf, nicht um den Waehler.
          hideBackendSelector: true,
          providers: {
            ollama: { id: 'ollama', name: 'Ollama', enabled: false, baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true },
            // `managed: false`, damit der Weg wirklich ueber checkConnection
            // laeuft und nicht ueber die Abkuerzung fuer den eigenen Motor.
            openai: { id: 'openai', name: 'LM Studio', enabled: true, baseUrl: 'http://localhost:1234/v1', apiKey: '', isLocal: true, managed: false },
            anthropic: { id: 'anthropic', name: 'Anthropic', enabled: false, baseUrl: 'https://api.anthropic.com', apiKey: '', isLocal: false },
            'lu-cloud': { id: 'lu-cloud', name: 'LU Cloud', enabled: false, baseUrl: 'https://lu-labs.ai/api/inference/v1', apiKey: '', isLocal: false },
          },
        },
        version: 1,
      }),
    )
    // Nach dem Tauri-Mock aufgesetzt: :1234 antwortet 200 mit genau dieser
    // Liste. Der Mock selbst weist jeden anderen lokalen Port ab.
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a: unknown) => Promise<unknown> } }
    const orig = w.__TAURI_INTERNALS__?.invoke
    if (orig && w.__TAURI_INTERNALS__) {
      w.__TAURI_INTERNALS__.invoke = (cmd: string, args: unknown) => {
        const url = String((args as { url?: string } | undefined)?.url || '')
        if (cmd === 'proxy_localhost' && url.includes(':1234')) {
          return Promise.resolve(JSON.stringify({
            object: 'list',
            data: liste.map((id) => ({ id, object: 'model' })),
          }))
        }
        // Der Mock laesst Ollamas /tags mit einer leeren Liste durchgehen.
        // Zusammen mit dem Anbieter oben sind das ZWEI erkannte Backends, und
        // dann legt sich der Waehler "2 local backends detected" ueber die App
        // und faengt jeden Klick ab. Hier interessiert der Test-Knopf, also
        // wird der zweite Motor abgewiesen, statt den Waehler wegzuklicken.
        if (cmd === 'proxy_localhost' && url.includes('11434')) {
          return Promise.reject(new Error('connection refused (e2e)'))
        }
        return orig(cmd, args)
      }
    }
  }, modelle)
  await page.goto('/')
}

async function testKnopfDruecken(page: Page) {
  await page.getByRole('button', { name: /^Settings$/ }).first().click()
  const backends = page.getByRole('button', { name: 'AI Backends', exact: true })
  await expect(backends).toBeVisible({ timeout: 15_000 })
  await backends.click()
  const karte = page.getByText('LM Studio').first()
  await expect(karte).toBeVisible({ timeout: 15_000 })
  await karte.click()
  const knopf = page.getByRole('button', { name: /^Test$/ }).first()
  await expect(knopf).toBeVisible({ timeout: 10_000 })
  await knopf.click()
}

test('eine leere Modelliste heisst nicht Connected', async ({ page }) => {
  await bootAnbieter(page, [])
  await testKnopfDruecken(page)

  const zeile = page.getByTestId('provider-no-models')
  await expect(zeile).toBeVisible({ timeout: 15_000 })
  await expect(zeile).toHaveText(/Reachable, no models/)
  await expect(page.getByText('Connected', { exact: true })).toHaveCount(0)
})

test('mit einem Modell steht weiterhin Connected da', async ({ page }) => {
  // Gegenprobe. Ohne sie waere die Zusicherung oben auch dann gruen, wenn der
  // Knopf ueberhaupt nie mehr Connected sagt.
  await bootAnbieter(page, ['qwen2.5-7b'])
  await testKnopfDruecken(page)

  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('provider-no-models')).toHaveCount(0)
})
