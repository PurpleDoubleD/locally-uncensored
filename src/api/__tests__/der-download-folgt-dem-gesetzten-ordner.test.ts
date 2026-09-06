/**
 * Was der Text im Panel verspricht, muss der Download auch tun.
 *
 * "LU downloads GGUFs here and reads every .gguf in a folder you set, up to
 * four levels down." Persona P2 hat am 04.09.2026 am echten Build gemessen:
 * gelesen wurde der gesetzte Ordner wirklich, heruntergeladen wurde aber
 * weiter ins Roaming-Profil. Zweimal mit verschiedenen Modellen, beide Male
 *   destDir: "C:\\Users\\ddrob\\AppData\\Roaming\\Locally Uncensored\\models"
 * bei gesetztem und bestaetigtem C:\lu-test-p2. Der erste Halbsatz des Textes
 * stimmte nicht.
 *
 * Run: npx vitest run src/api/__tests__/der-download-folgt-dem-gesetzten-ordner.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const backendCall = vi.fn(async () => 'C:\\Users\\x\\AppData\\Roaming\\Locally Uncensored\\models')

vi.mock('../backend', async () => {
  const actual = await vi.importActual<typeof import('../backend')>('../backend')
  return { ...actual, backendCall: (...a: unknown[]) => backendCall(...(a as [])) }
})

const { luEngineDownloadDir } = await import('../discover')
const { useSettingsStore } = await import('../../stores/settingsStore')

const APP_ORDNER = 'C:\\Users\\x\\AppData\\Roaming\\Locally Uncensored\\models'

describe('luEngineDownloadDir', () => {
  beforeEach(() => {
    backendCall.mockClear()
    useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '' })
  })

  it('nimmt den Ordner, den der Nutzer gesetzt hat', async () => {
    useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: 'C:\\lu-test-p2' })
    expect(await luEngineDownloadDir()).toBe('C:\\lu-test-p2')
    // Und fragt die Rust-Seite gar nicht erst.
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('ohne gesetzten Ordner bleibt es beim eigenen', async () => {
    expect(await luEngineDownloadDir()).toBe(APP_ORDNER)
    expect(backendCall).toHaveBeenCalledWith('detect_model_path', { provider: 'builtin' })
  })

  it('Leerraum ist kein Ordner', async () => {
    // Negativkontrolle: ein Feld, in dem nur Leerzeichen stehen, darf den
    // Download nicht ins Nichts schicken.
    useSettingsStore.getState().updateSettings({ hfDownloadPathOverride: '   ' })
    expect(await luEngineDownloadDir()).toBe(APP_ORDNER)
  })
})

describe('und beide Tueren gehen hindurch', () => {
  const lies = (p: string) =>
    readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

  it('die Discover-Seite', () => {
    const src = lies('components/models/DiscoverModels.tsx')
    expect(src).toContain('return await luEngineDownloadDir()')
    expect(src).not.toContain('detectProviderModelPath(BUILTIN_BACKEND_ID)')
  })

  it('und der Einstieg beim ersten Start', () => {
    const src = lies('components/onboarding/ModelsStep.tsx')
    expect(src).toContain('destDir = await luEngineDownloadDir()')
    expect(src).not.toContain('detectProviderModelPath(BUILTIN_BACKEND_ID)')
  })
})
