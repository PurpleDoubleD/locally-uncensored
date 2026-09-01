/**
 * Was ein Neustart vom Download uebrig laesst
 *
 * Beide Seiten hielten den Download-Zustand rein im Speicher. Ein Neustart der
 * App waehrend eines Multi-GB-Transfers hinterliess damit eine `.download`-Datei
 * ohne Zeile, ohne Knopf und ohne Weg zurueck — und, schlimmer, ohne den
 * `destDir`, den der Retry braucht: ein GGUF-Textmodell landete danach in einem
 * Verzeichnis, in dem kein Backend es findet.
 *
 * Hier wird beides geprueft: dass die Metadaten den Neustart ueberleben, und
 * dass die gefundenen Teildateien wieder als fortsetzbare Zeilen auftauchen.
 *
 * Run: npx vitest run src/stores/__tests__/downloadStore-orphans.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// zustand/persist writes through `localStorage`, and the store picks its
// backing store up at module scope. In the node test env the shim therefore has
// to exist BEFORE the import runs — vi.hoisted is the only thing that gets
// ahead of an ESM import. Without it persist silently no-ops and this file
// would prove nothing.
//
// Deliberately NOT shimming `window`: the store registers real event listeners
// behind a `typeof window` check, and a half-faked window breaks the import.
vi.hoisted(() => {
  const backing = new Map<string, string>()
  // defineProperty rather than an assignment through a cast: the descriptor's
  // `value` is untyped, so the shim goes in without claiming to BE a Storage.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
      key: (i: number) => [...backing.keys()][i] ?? null,
      get length() { return backing.size },
    },
  })
})

const findOrphanDownloads = vi.fn(async (_extra: string[]): Promise<OrphanDownload[]> => [])
const deleteOrphanDownload = vi.fn(async () => {})
const resumeDownload = vi.fn(async () => {})
const getDownloadProgress = vi.fn(async (): Promise<Record<string, DownloadProgress>> => ({}))

vi.mock('../../api/discover', async () => {
  const actual = await vi.importActual<typeof import('../../api/discover')>('../../api/discover')
  return {
    getDownloadProgress: (...a: unknown[]) => getDownloadProgress(...(a as [])),
    pauseDownload: vi.fn(async () => {}),
    cancelDownload: vi.fn(async () => {}),
    clearDownloadEntry: vi.fn(async () => {}),
    resumeDownload: (...a: unknown[]) => resumeDownload(...(a as [])),
    startModelDownload: vi.fn(async () => {}),
    startModelDownloadToPath: vi.fn(async () => {}),
    lookupFileMeta: () => undefined,
    findOrphanDownloads: (...a: unknown[]) => findOrphanDownloads(...(a as [string[]])),
    deleteOrphanDownload: (...a: unknown[]) => deleteOrphanDownload(...(a as [])),
    catalogFilenames: () => ['wan_2.1_vae.safetensors'],
    orphanFilename: actual.orphanFilename,
    isPermanentDownloadError: actual.isPermanentDownloadError,
    modelsNotVisibleInComfy: vi.fn(async () => []),
    ENUM_SUBFOLDERS: actual.ENUM_SUBFOLDERS,
  }
})

import { useDownloadStore, orphanRows, flushDownloadPersist } from '../downloadStore'
import type { DownloadProgress } from '../../types/downloads'
import type { OrphanDownload } from '../../api/discover'

const GGUF_DIR = '/Users/x/.lmstudio/models'

beforeEach(() => {
  vi.clearAllMocks()
  useDownloadStore.setState({ downloads: {}, downloadMeta: {}, orphans: {}, bundleMap: {} })
  useDownloadStore.getState().stopPolling()
})

describe('download meta survives a restart', () => {
  it('persists url, subfolder AND destDir', async () => {
    useDownloadStore.getState().setMeta('m.gguf', 'https://example.test/m.gguf', 'gguf', GGUF_DIR, {
      expectedBytes: 4_000_000_000,
      sha256: 'a'.repeat(64),
    })
    // Der Schreibvorgang ist gebuendelt (der Poller setzt einmal pro Sekunde);
    // beim Schliessen der App wird genauso geflusht.
    await flushDownloadPersist()

    const raw = localStorage.getItem('locally-uncensored-downloads')
    expect(raw, 'nichts geschrieben — der Neustart verliert alles').toBeTruthy()
    const stored = JSON.parse(raw as string)
    expect(stored.state.downloadMeta['m.gguf']).toEqual({
      url: 'https://example.test/m.gguf',
      subfolder: 'gguf',
      // Ohne destDir faellt der Retry auf den subfolder-Zweig zurueck und
      // schreibt das Modell dorthin, wo kein Backend es sucht.
      destDir: GGUF_DIR,
      expectedBytes: 4_000_000_000,
      sha256: 'a'.repeat(64),
    })
    // Der Live-Zustand gehoert Rust und darf nicht mitgeschrieben werden:
    // "downloading" ohne laufenden Transfer waere eine Luege nach dem Start.
    expect(stored.state.downloads).toBeUndefined()
    expect(stored.state.orphans).toBeUndefined()
    expect(stored.version).toBe(1)
  })
})

describe('orphaned partials', () => {
  it('turns a leftover .download into a resumable row', async () => {
    findOrphanDownloads.mockResolvedValueOnce([
      { stem: 'wan_2.1_vae', path: '/comfy/models/vae/wan_2.1_vae.download', dir: '/comfy/models/vae', bytes: 9_000_000_000 },
    ])

    await useDownloadStore.getState().scanOrphans()

    // `with_extension` ersetzt die Endung, der Stamm allein steht auf der
    // Platte — der echte Name kommt aus Meta bzw. Katalog zurueck.
    const orphan = useDownloadStore.getState().orphans['wan_2.1_vae']
    expect(orphan.filename).toBe('wan_2.1_vae.safetensors')

    const row = useDownloadStore.getState().downloads['wan_2.1_vae.safetensors']
    expect(row?.status).toBe('paused')
    expect(row?.progress).toBe(9_000_000_000)
  })

  it('hands the persisted destDirs to the scan · a GGUF lives outside the ComfyUI tree', async () => {
    useDownloadStore.getState().setMeta('m.gguf', 'https://example.test/m.gguf', 'gguf', GGUF_DIR)
    await useDownloadStore.getState().scanOrphans()

    expect(findOrphanDownloads).toHaveBeenCalledWith([GGUF_DIR])
  })

  it('lists a partial it cannot name, but never offers to resume it', async () => {
    findOrphanDownloads.mockResolvedValueOnce([
      { stem: 'something-a-user-dropped-here', path: '/comfy/models/vae/x.download', dir: '/comfy/models/vae', bytes: 12 },
    ])
    await useDownloadStore.getState().scanOrphans()

    expect(useDownloadStore.getState().orphans['something-a-user-dropped-here'].filename).toBeNull()
    expect(Object.keys(useDownloadStore.getState().downloads)).toHaveLength(0)
    await useDownloadStore.getState().resumeOrphan('something-a-user-dropped-here')
    expect(resumeDownload).not.toHaveBeenCalled()
  })

  it('a live transfer takes the row back from the adopted orphan', async () => {
    findOrphanDownloads.mockResolvedValueOnce([
      { stem: 'wan_2.1_vae', path: '/comfy/models/vae/wan_2.1_vae.download', dir: '/comfy/models/vae', bytes: 9_000_000_000 },
    ])
    await useDownloadStore.getState().scanOrphans()

    getDownloadProgress.mockResolvedValueOnce({
      'wan_2.1_vae.safetensors': {
        progress: 9_500_000_000, total: 12_000_000_000, speed: 5_000_000,
        filename: 'wan_2.1_vae.safetensors', status: 'downloading',
      },
    })
    await useDownloadStore.getState().refresh()

    expect(useDownloadStore.getState().downloads['wan_2.1_vae.safetensors'].status).toBe('downloading')
    expect(useDownloadStore.getState().orphans['wan_2.1_vae']).toBeUndefined()
    useDownloadStore.getState().stopPolling()
  })

  it('discarding one deletes the file and drops the row for good', async () => {
    findOrphanDownloads.mockResolvedValueOnce([
      { stem: 'wan_2.1_vae', path: '/comfy/models/vae/wan_2.1_vae.download', dir: '/comfy/models/vae', bytes: 9_000_000_000 },
    ])
    await useDownloadStore.getState().scanOrphans()
    await useDownloadStore.getState().discardOrphan('wan_2.1_vae')

    expect(deleteOrphanDownload).toHaveBeenCalledWith('/comfy/models/vae/wan_2.1_vae.download', ['/comfy/models/vae'])
    expect(useDownloadStore.getState().orphans['wan_2.1_vae']).toBeUndefined()
    expect(useDownloadStore.getState().downloads['wan_2.1_vae.safetensors']).toBeUndefined()

    // Und die naechste Runde darf sie nicht zurueckholen.
    getDownloadProgress.mockResolvedValueOnce({})
    await useDownloadStore.getState().refresh()
    expect(useDownloadStore.getState().downloads['wan_2.1_vae.safetensors']).toBeUndefined()
    useDownloadStore.getState().stopPolling()
  })

  it('sizes the bar from the remembered estimate, without claiming completeness', () => {
    const rows = orphanRows(
      { s: { stem: 's', path: '/p/s.download', dir: '/p', bytes: 5, filename: 'm.safetensors' } },
      { 'm.safetensors': { url: 'u', subfolder: 'vae', expectedBytes: 100 } },
    )
    expect(rows['m.safetensors']).toMatchObject({ progress: 5, total: 100, status: 'paused' })
    // Ohne gemerkte Groesse bleibt die Gesamtzahl offen, statt geraten zu werden.
    const blind = orphanRows(
      { s: { stem: 's', path: '/p/s.download', dir: '/p', bytes: 5, filename: 'm.safetensors' } },
      {},
    )
    expect(blind['m.safetensors'].total).toBe(0)
  })
})
