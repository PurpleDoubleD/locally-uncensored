/**
 * T-67 · die Custom-Node-Installation leert den /object_info-Cache nicht.
 *
 * `getAllNodeInfo` haelt ComfyUIs vollstaendigen Knotenkatalog fuenf Minuten
 * im Speicher (comfyui-nodes.ts:60). Wer waehrend dieser fuenf Minuten ein
 * Knotenpaket installiert, aendert die Wirklichkeit, aber nicht die Antwort:
 * der Workflow-Bauer liest weiter den Katalog von vorher und raet dem Nutzer,
 * zu installieren, was er gerade installiert hat.
 *
 * Der Befund ist ein Fall des Musters, das dieses Projekt immer wieder trifft:
 * ZWEI PFADE, DIE DASSELBE TUN SOLLEN, UND NUR EINER WIRD GEPFLEGT. Es gab
 * `installCustomNodes` — und eine handkopierte Schleife in `installBundle`,
 * die dasselbe Backend-Kommando rief. Keiner der beiden brach den Cache; drei
 * Aufrufer im UI holten das per Hand nach, jeder auf seine Weise
 * (CreateContext.tsx:346 und :407, useCreate.ts:991), der vierte — der
 * Download-Pfad — gar nicht. Der Neustart der Kopie war ausserdem ein
 * stop / 2 s schlafen / start, das ein fremdes ComfyUI nicht erkennt.
 *
 * Zusammengefuehrt: `installCustomNodes` ist der eine Weg, bricht den Cache
 * selbst und faehrt den Neustart ueber `restartComfyForNewNodes`. Diese Tests
 * pinnen genau das.
 *
 * Der Cache hier ist der ECHTE aus comfyui-nodes.ts, nicht nachgebaut: die
 * Tests zaehlen, wie oft /object_info wirklich abgerufen wird. Ersetzt ist nur
 * die Tauri-Bruecke, die es im Node-Lauf ohnehin nicht gibt.
 *
 * Lauf: npx vitest run src/api/__tests__/custom-node-cache-break.test.ts
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import type { ModelBundle } from '../discover'

const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
const localFetch = vi.fn<(url: string, opts?: unknown) => Promise<Response>>()

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  localFetch: (...a: unknown[]) => localFetch(...(a as [string, unknown])),
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  fetchExternal: vi.fn(),
  fetchLocalhostBytes: vi.fn(),
  isTauri: () => true,
}))

import { installCustomNodes, installBundleComplete } from '../discover'
import { getAllNodeInfo, clearNodeCache } from '../comfyui-nodes'

/** Wie oft der volle Knotenkatalog wirklich vom Server geholt wurde. */
let objectInfoAbrufe = 0
/** Wie oft jemand gefragt hat, ob auf dem Port noch etwas laeuft. Genau das
 *  unterscheidet `restartComfyForNewNodes` von der Kopie, die es ersetzt hat:
 *  die schlief zwei Sekunden und startete blind. */
let lebendfragen = 0

const KNOTEN = { VHS_VideoCombine: { input: { required: {} }, output: [] } }

beforeAll(() => {
  // installBundleComplete verkuendet seine Urteile auf window; der Node-Lauf
  // hat keins.
  ;(globalThis as unknown as { window: EventTarget }).window = new EventTarget()
})

beforeEach(() => {
  objectInfoAbrufe = 0
  lebendfragen = 0
  clearNodeCache()
  backendCall.mockReset().mockResolvedValue({ status: 'installed' })
  localFetch.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/object_info')) {
      objectInfoAbrufe++
      return new Response(JSON.stringify(KNOTEN), { status: 200 })
    }
    if (url.endsWith('/system_stats')) {
      lebendfragen++
      // Der Port ist still: LU hat sein eigenes ComfyUI beendet. Der Fall
      // "da antwortet ein fremdes ComfyUI" gehoert zu
      // `restartComfyForNewNodes` selbst und steht in comfy-restart.test.ts.
      return new Response('{}', { status: 503 })
    }
    return new Response('{}', { status: 200 })
  })
})

describe('T-67 · der Cache ueberlebt die Installation nicht', () => {
  it('der Cache ist echt: zweimal fragen holt einmal', async () => {
    // Ohne diese Zeile beweist der Test darunter nichts — ein Cache, der nie
    // greift, wird durch jeden "Bruch" scheinbar bestaetigt.
    await getAllNodeInfo()
    await getAllNodeInfo()
    expect(objectInfoAbrufe).toBe(1)
  })

  it('nach der Installation muss die Knotenliste neu geholt werden', async () => {
    await getAllNodeInfo()
    await getAllNodeInfo()
    expect(objectInfoAbrufe).toBe(1)

    await installCustomNodes(['videohelpersuite'])

    await getAllNodeInfo()
    expect(objectInfoAbrufe, 'die Installation hat den /object_info-Cache nicht gebrochen').toBe(2)
  })

  it('auch eine gescheiterte Installation bricht den Cache', async () => {
    // Ein Paket, dessen `pip install` auf halber Strecke stirbt, kann seine
    // Knoten trotzdem registriert haben — und ein Fehlschlag ist genau der
    // Moment, in dem niemand ans Aufraeumen denkt. Deshalb steht der Bruch in
    // einem `finally`.
    await getAllNodeInfo()
    expect(objectInfoAbrufe).toBe(1)

    backendCall.mockResolvedValue({ status: 'update_failed' })
    await expect(installCustomNodes(['videohelpersuite'])).rejects.toThrow(/update_failed/)

    await getAllNodeInfo()
    expect(objectInfoAbrufe).toBe(2)
  })

  it('ein unbekannter Schluessel aendert nichts und wirft nicht', async () => {
    await installCustomNodes(['gibt-es-nicht'])
    expect(backendCall).not.toHaveBeenCalled()
  })
})

describe('T-67 · der Bruch NACH dem Neustart ist der, auf den es ankommt', () => {
  it('was waehrend des Neustarts gelesen wurde, gilt danach nicht mehr', async () => {
    // Zwischen Klonen und Neustart sind die neuen Knoten noch nicht
    // registriert. Fragt in diesem Fenster jemand — der Model Manager pollt,
    // die Create-Oberflaeche baut einen Workflow —, bekommt er die alte
    // Antwort und schreibt sie wieder in den Cache. Ein einziger Bruch direkt
    // nach dem Klonen waere damit wertlos.
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'stop_comfyui') await getAllNodeInfo() // jemand fragt dazwischen
      return { status: 'installed' }
    })

    await installCustomNodes(['videohelpersuite'], { restart: true })

    const vorDerFrage = objectInfoAbrufe
    await getAllNodeInfo()
    expect(objectInfoAbrufe, 'der Cache aus dem Neustart-Fenster steht noch').toBe(vorDerFrage + 1)
  })

  it('der Neustart laeuft ueber restartComfyForNewNodes, nicht ueber stop/schlafen/start', async () => {
    await installCustomNodes(['videohelpersuite'], { restart: true })
    expect(backendCall.mock.calls.map((c) => c[0]))
      .toEqual(['install_custom_node', 'stop_comfyui', 'start_comfyui'])
    // Und dazwischen wurde gefragt, ob der Port frei geworden ist. Genau das
    // tat die ersetzte Kopie nicht — sie schlief zwei Sekunden und startete.
    // Was passiert, wenn der Port belegt bleibt, steht in comfy-restart.test.ts.
    expect(lebendfragen).toBeGreaterThan(0)
  })

  it('ohne restart bleibt der Neustart Sache des Aufrufers', async () => {
    // Die drei Aufrufer in der Create-Oberflaeche fahren ihren Neustart mit
    // eigenem Fortschrittstext. Ihnen darf hier keiner dazwischenfunken.
    await installCustomNodes(['videohelpersuite'])
    expect(backendCall.mock.calls.map((c) => c[0])).toEqual(['install_custom_node'])
  })
})

describe('T-67 · der Download-Pfad geht denselben Weg', () => {
  const buendel = (): ModelBundle => ({
    name: 'Talking Character',
    description: '',
    tags: [],
    totalSizeGB: 1,
    vramRequired: '8 GB',
    customNodes: ['videohelpersuite'],
    files: [{
      name: '', description: '', pulls: '', tags: [], updated: '',
      downloadUrl: 'https://example.test/m.safetensors',
      filename: 'm.safetensors',
      subfolder: 'diffusion_models',
      sizeGB: 1,
    }],
  } as unknown as ModelBundle)

  const backend = () => backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'check_model_sizes') return []
    if (cmd === 'check_download_space') return { fits: true }
    if (cmd === 'download_model') return { status: 'started', id: '1' }
    return { status: 'installed' }
  })

  it('der Bruch des Knoten-Caches passiert auf diesem Pfad ueberhaupt', async () => {
    // Der Kern von T-67. Der Download-Pfad hatte seine eigene Kopie der
    // Installationsschleife und brach nur ComfyUIs MODELL-Verzeichnisscan
    // (`refreshComfyModels`) — ein voellig anderer Cache. Der Knotenkatalog
    // blieb fuenf Minuten stehen.
    backend()
    await getAllNodeInfo()
    expect(objectInfoAbrufe).toBe(1)

    await installBundleComplete(buendel())
    // Die Knoteninstallation laeuft absichtlich neben dem Download her.
    await vi.waitFor(() => expect(backendCall.mock.calls.map((c) => c[0])).toContain('start_comfyui'))

    await getAllNodeInfo()
    expect(objectInfoAbrufe, 'der Download-Pfad hat den Knoten-Cache stehen lassen').toBe(2)
  }, 30_000)

  it('und zwar ueber denselben Weg, nicht ueber eine zweite Kopie', async () => {
    backend()
    await installBundleComplete(buendel())
    await vi.waitFor(() => expect(backendCall.mock.calls.map((c) => c[0])).toContain('start_comfyui'))

    // Die ersetzte Kopie schlief zwei Sekunden und rief `start_comfyui`
    // bedingungslos. Wer hier fragt, ob der Port frei geworden ist, ist
    // `restartComfyForNewNodes` — also der gemeinsame Weg.
    expect(lebendfragen).toBeGreaterThan(0)
  }, 30_000)
})
