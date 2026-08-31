/**
 * Was "Wiederholen" anfassen darf — und was auf keinen Fall (2026-07-28 / DD-1)
 *
 * Zwei Befunde in einer Datei, weil sie dieselbe Zeile betreffen.
 *
 * 2026-07-28: Ein fehlgeschlagener Eintrag lebt auch in der Rust-Map. retry()
 * loeschte nur die Zeile im Frontend, und download_model bricht mit "exists" ab,
 * wenn die Datei schon auf der Platte liegt, ohne die Map je anzufassen. Das
 * naechste refresh() las den alten Fehler wieder ein und die gerade
 * wiederholte Karte kam zurueck.
 *
 * DD-1: Die Loesung dafuer war cancelDownload(id) — und cancel entfernt fuer
 * 'paused' und 'error' die Teildatei. Damit loeschte genau der Knopf, den die
 * Fehlermeldung empfiehlt ("start it again to resume"), die Bytes, ab denen er
 * fortsetzen wollte. Bei einem 40-GB-Bundle auf instabiler Leitung konvergiert
 * das nie: jeder Versuch faengt wieder bei null an.
 *
 * Run: npx vitest run src/stores/__tests__/downloadStore-retry.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cancelDownload = vi.fn(async () => {})
const clearDownloadEntry = vi.fn(async () => {})
const startModelDownload = vi.fn(async () => {})
const startModelDownloadToPath = vi.fn(async () => {})
const getDownloadProgress = vi.fn(async () => ({}))
const resumeDownload = vi.fn(async () => {})

vi.mock('../../api/discover', async () => {
  // isPermanentDownloadError ist reine Logik und genau die Vertragsstelle
  // zwischen Rust-Fehlertext und UI — die echte Implementierung testen, nicht
  // eine Attrappe davon.
  const actual = await vi.importActual<typeof import('../../api/discover')>('../../api/discover')
  return {
    getDownloadProgress: (...a: any[]) => getDownloadProgress(...(a as [])),
    pauseDownload: vi.fn(async () => {}),
    cancelDownload: (...a: any[]) => cancelDownload(...(a as [])),
    clearDownloadEntry: (...a: any[]) => clearDownloadEntry(...(a as [])),
    resumeDownload: (...a: any[]) => resumeDownload(...(a as [])),
    startModelDownload: (...a: any[]) => startModelDownload(...(a as [])),
    startModelDownloadToPath: (...a: any[]) => startModelDownloadToPath(...(a as [])),
    lookupFileMeta: () => undefined,
    findOrphanDownloads: vi.fn(async () => []),
    deleteOrphanDownload: vi.fn(async () => {}),
    catalogFilenames: () => [],
    orphanFilename: actual.orphanFilename,
    isPermanentDownloadError: actual.isPermanentDownloadError,
    modelsNotVisibleInComfy: vi.fn(async () => []),
    ENUM_SUBFOLDERS: actual.ENUM_SUBFOLDERS,
  }
})

import { useDownloadStore } from '../downloadStore'

function seedErrored(id: string, error = 'boom') {
  useDownloadStore.setState({
    downloads: {
      [id]: { progress: 10, total: 100, speed: 0, filename: id, status: 'error', error } as any,
    },
    downloadMeta: { [id]: { url: 'https://example.test/m.safetensors', subfolder: 'checkpoints' } },
    orphans: {},
  })
}

describe('downloadStore.retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDownloadStore.setState({ downloads: {}, downloadMeta: {}, orphans: {} })
    useDownloadStore.getState().stopPolling()
  })

  it('clears the errored entry on the Rust side before restarting', async () => {
    seedErrored('model.safetensors')
    await useDownloadStore.getState().retry('model.safetensors')

    expect(clearDownloadEntry).toHaveBeenCalledWith('model.safetensors')
    expect(startModelDownload).toHaveBeenCalledWith(
      'https://example.test/m.safetensors',
      'checkpoints',
      'model.safetensors',
      undefined,
      undefined,
    )
    expect(useDownloadStore.getState().downloads['model.safetensors']).toBeUndefined()
    useDownloadStore.getState().stopPolling()
  })

  /** DD-1. cancelDownload ist der Weg, der die .download-Datei entfernt.
   *  Wiederholen darf ihn nicht gehen — sonst faengt jeder Versuch bei 0 an. */
  it('never routes a retry through cancel, so the partial file survives', async () => {
    seedErrored('big-video-bundle.gguf', 'Download ended early: 38000000000 of 42000000000 bytes received. Start it again to resume.')
    await useDownloadStore.getState().retry('big-video-bundle.gguf')

    expect(cancelDownload).not.toHaveBeenCalled()
    expect(clearDownloadEntry).toHaveBeenCalledWith('big-video-bundle.gguf')
    expect(startModelDownload).toHaveBeenCalled()
    useDownloadStore.getState().stopPolling()
  })

  it('does not cancel a transfer that is merely paused', async () => {
    useDownloadStore.setState({
      downloads: {
        'm.gguf': { progress: 5, total: 100, speed: 0, filename: 'm.gguf', status: 'paused' } as any,
      },
      downloadMeta: { 'm.gguf': { url: 'https://example.test/m.gguf', subfolder: 'unet' } },
    })
    await useDownloadStore.getState().retry('m.gguf')

    expect(cancelDownload).not.toHaveBeenCalled()
    expect(clearDownloadEntry).not.toHaveBeenCalled()
    expect(startModelDownload).toHaveBeenCalled()
    useDownloadStore.getState().stopPolling()
  })

  /** Ein umbenanntes oder gated Repo antwortet immer gleich. Ein Neustart ist
   *  kein Fix, sondern derselbe Fehlschlag noch einmal. */
  it('refuses to restart a download whose address is gone', async () => {
    seedErrored(
      'wan_2.1_vae.safetensors',
      'wan_2.1_vae.safetensors is not at this address any more (HTTP 404). The repository was renamed, moved or taken down, so trying again cannot help.',
    )
    await useDownloadStore.getState().retry('wan_2.1_vae.safetensors')

    expect(startModelDownload).not.toHaveBeenCalled()
    expect(clearDownloadEntry).not.toHaveBeenCalled()
    expect(cancelDownload).not.toHaveBeenCalled()
    // Die Karte bleibt mit ihrer Begruendung stehen, statt still zu scheitern.
    expect(useDownloadStore.getState().downloads['wan_2.1_vae.safetensors']?.status).toBe('error')
  })

  it('still restarts a download that failed for a temporary reason', async () => {
    seedErrored('m.safetensors', 'The host could not serve m.safetensors right now (HTTP 503).')
    await useDownloadStore.getState().retry('m.safetensors')

    expect(startModelDownload).toHaveBeenCalled()
    useDownloadStore.getState().stopPolling()
  })

  /** Dieselbe Falle, ein Klick daneben: das X auf einer roten Karte ist kein
   *  Beschluss, mehrere Gigabyte wegzuwerfen. */
  it('dismissing an error card clears the row, not the bytes', () => {
    seedErrored('model.safetensors')
    useDownloadStore.getState().dismiss('model.safetensors')

    expect(cancelDownload).not.toHaveBeenCalled()
    expect(clearDownloadEntry).toHaveBeenCalledWith('model.safetensors')
    expect(useDownloadStore.getState().downloads['model.safetensors']).toBeUndefined()
  })

  /** Abbrechen bleibt Abbrechen: der eine Weg, der aufraeumen darf. */
  it('cancel is still the path that removes the partial', async () => {
    seedErrored('model.safetensors')
    await useDownloadStore.getState().cancel('model.safetensors')

    expect(cancelDownload).toHaveBeenCalledWith('model.safetensors')
    expect(clearDownloadEntry).not.toHaveBeenCalled()
  })
})
