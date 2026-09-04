/**
 * Ein Rust-Befehl lehnt mit einer ZEICHENKETTE ab, nicht mit einem Error.
 *
 * `backendCall` reicht `invoke()` unveraendert durch, und `invoke` verwirft mit
 * dem `Err(String)` der Rust-Seite. Der Store fragte aber
 * `err instanceof Error ? err.message : '<Ersatztext>'`, und eine Zeichenkette
 * ist kein Error. Also griff in JEDEM echten Fall der Ersatztext, und der Grund,
 * den Rust extra mitgeschickt hatte, fiel auf den Boden. Der Nutzer las
 * "Failed to start", waehrend "winget is not installed on this system" in der
 * Hand lag.
 *
 * Lauf: npx vitest run src/stores/__tests__/die-absage-aus-rust-kommt-als-satz-an.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
}))

const { useComfyInstallStore } = await import('../comfyInstallStore')

const store = () => useComfyInstallStore.getState()

/** Was `invoke` aus einem Rust-`Err(String)` macht: kein Error, nur Text. */
const rustSagtNein = (grund: string) => () => Promise.reject(grund)

beforeEach(() => {
  store().reset()
  backendCall.mockReset()
})
afterEach(() => { store().reset() })

describe('der Grund aus Rust erreicht die Karte', () => {
  it('beim Python-Schritt', async () => {
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'python_check') return { available: false }
      if (cmd === 'install_python') return rustSagtNein('winget is not installed on this system')()
      return {}
    })
    await store().runInstall('')
    expect(store().phase).toBe('error')
    expect(store().error).toBe('winget is not installed on this system')
  })

  it('beim Installieren von ComfyUI', async () => {
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'python_check') return { available: true }
      if (cmd === 'install_comfyui') return rustSagtNein('target folder is not writable')()
      return {}
    })
    await store().runInstall('/pfad')
    expect(store().phase).toBe('error')
    expect(store().error).toBe('target folder is not writable')
  })

  it('beim Update', async () => {
    backendCall.mockImplementation(rustSagtNein('git is missing'))
    await store().runUpdate()
    expect(store().phase).toBe('error')
    expect(store().error).toBe('git is missing')
  })

  it('bei der Reparatur', async () => {
    backendCall.mockImplementation(rustSagtNein('venv is locked by another process'))
    await store().runRepair()
    expect(store().phase).toBe('error')
    expect(store().error).toBe('venv is locked by another process')
  })

  it('und beim Abbrechen, wo der Knopf sonst auf Cancelling stehen bleibt', async () => {
    backendCall.mockImplementation(rustSagtNein('no install is running'))
    await store().cancel()
    expect(store().cancelling).toBe(false)
    expect(store().error).toBe('no install is running')
  })
})

describe('was der Ersatztext noch abfaengt', () => {
  it('eine Absage ganz ohne Text bekommt weiter unseren Satz', async () => {
    backendCall.mockImplementation(() => Promise.reject(''))
    await store().runUpdate()
    expect(store().error).toBe('Failed to start the update')
  })

  it('ein echter Error wird weiterhin gelesen', async () => {
    backendCall.mockImplementation(() => Promise.reject(new Error('the pipe broke')))
    await store().runRepair()
    expect(store().error).toBe('the pipe broke')
  })
})
