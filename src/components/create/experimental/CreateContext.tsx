import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { useCreate } from '../../../hooks/useCreate'
import { useCloudCreate, hasActiveCloudRun } from '../../../hooks/useCloudCreate'
import { useCloudSession } from '../../../hooks/useCloudSession'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { getLoraModels, getVAEModels, checkComfyConnection, refreshComfyModels, bundleForVideoIntent } from '../../../api/comfyui'
import { getAllNodeInfo, clearNodeCache } from '../../../api/comfyui-nodes'
import { installCustomNodes, getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, startModelDownload, getDownloadProgress, modelsNotVisibleInComfy, ENUM_SUBFOLDERS } from '../../../api/discover'
import { backendCall, isMacOS, isLinux } from '../../../api/backend'
import { asComfyGpuMode, comfyCpuBannerText, type ComfyCpuBannerFacts } from '../../../lib/comfy-cpu-banner'
import { installMlxStack } from '../../../api/mlx-install'
import { useDownloadStore } from '../../../stores/downloadStore'
import { downloadBundleFiles, waitOrAbort, waitForModelsVisible } from '../../../lib/bundle-install'
import { ensureLocalFilename } from './loadImage'
import { comfyStartupError } from './comfyError'
import { restartComfyForNewNodes } from '../../../api/comfy-restart'
import type { CloudQuota } from '../../../lib/render/cloud-jobs'

/** Hold until nothing is rendering, so a heal never lands on a live job.
 *  Bounded: a render that never reports finished must not park an install
 *  forever, and the caller falls back to the plain-language error either way. */
async function waitForIdleRender(signal?: AbortSignal, attempts = 120): Promise<void> {
  for (let i = 0; i < attempts && useCreateStore.getState().isGenerating; i++) {
    await waitOrAbort(5000, signal)
  }
}

/** Poll until the engine answers again, on the same budget this file uses for
 *  a warm start (ensureComfyRunning: 15 rounds of 2s). Deliberately does NOT
 *  fall through to install_comfyui the way ensureComfyRunning does: after a
 *  restart the engine is installed by definition, and a multi gigabyte install
 *  is not something to start behind a model download. */
async function waitForComfyBack(onStatus?: (m: string) => void, signal?: AbortSignal): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    if (await checkComfyConnection()) return true
    onStatus?.(`Waiting for ComfyUI to come back up… ${i * 2}s`)
    await waitOrAbort(2000, signal)
  }
  return await checkComfyConnection()
}

/**
 * The seam between the redesigned Create surface and the live backend. Replaces
 * the sandbox mockStore's non-persisted actions (generate/cancel) and mockComfy
 * (uploadImage/installCapability/capability lists). Everything else the ported
 * components need is read straight from useCreateStore.
 */
interface CreateExpValue {
  generate: () => void | Promise<void>
  cancel: () => void | Promise<void>
  /** Video super-resolution on a finished cloud render (Lightbox "Enhance"). */
  enhanceVideo: (item: GalleryItem, targetResolution?: '720p' | '1080p') => Promise<void>
  /** Talking-character voice maker (qwen3-tts) — lands an audio gallery item
   *  and pre-selects it as the lipsync voice. Cloud-only. */
  makeVoice: (opts: {
    text: string
    mode: 'speak' | 'design'
    voice?: string
    description?: string
  }) => Promise<void>
  /** ComfyUI /object_info sampler + scheduler names (fallback lists until loaded). */
  samplerList: string[]
  schedulerList: string[]
  /** Installed LoRA + VAE filenames for the Advanced drawer. */
  loraList: string[]
  vaeList: string[]
  /** Re-scan LoRA/VAE lists + node caps on demand (GH #109): the lists load
   *  once per connect, so files dropped in later were invisible until restart. */
  refreshModelLists: () => Promise<void>
  connected: boolean | null
  modelsLoaded: boolean
  modelLoadError: string | null
  /** macOS: which local lanes still have no MLX model. `null` off-Mac and until
   *  the first probe answers, so the setup card never flashes during startup. */
  mlxMissing: { image: boolean; video: boolean } | null
  /** True while the ComfyUI that LU launched runs with --cpu (shd_scorpion,
   *  RX 7900 XTX): surfaces the honest slow-mode warning instead of a silent
   *  20-minute timeout. */
  comfyOnCpu: boolean
  /** The finished banner sentence for that state, '' when there is none. It
   *  differs by WHY the processor is in play (Force CPU vs nothing usable
   *  found) and only mentions AMD on a machine that has an AMD card, see
   *  lib/comfy-cpu-banner.ts. */
  comfyCpuBanner: string
  /** Install a missing capability in place: ensure ComfyUI runs (installing it
   *  first if needed), download the custom node when one is required, restart,
   *  and re-probe until available. Reports progress via the optional callback
   *  and throws on failure. 'rmbg' = the RMBG cutout node; 'inpaint-nodes' =
   *  ComfyUI's core inpaint nodes (nothing to clone — present on any current
   *  install once ComfyUI is up). */
  installCapability: (cap: 'rmbg' | 'inpaint-nodes' | 'dwpose', onProgress?: (msg: string) => void, signal?: AbortSignal) => Promise<void>
  /** One-click "everything you need" for a fresh PC: ensure ComfyUI runs
   *  (installing it first if needed), then download the default starter
   *  bundle for the intent kind (image → SDXL checkpoint, video → Wan 2.1,
   *  2.5.8 lanes → ACE / S2V / VACE starters incl. their node packs)
   *  with streamed progress, refresh ComfyUI's model enums and re-fetch the
   *  model lists. Throws on failure. */
  installModelBundle: (kind: 'image' | 'video' | 'audio' | 'lipsync' | 'motion', onProgress?: (msg: string) => void, signal?: AbortSignal) => Promise<void>
  /** Runtime backend axis: hosted rendering offered for this session? */
  cloudAvailable: boolean
  quota: CloudQuota | null
  refreshQuota: () => Promise<void>
}

const Ctx = createContext<CreateExpValue | null>(null)

export function useCreateExp(): CreateExpValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useCreateExp must be used within <CreateExpProvider>')
  return v
}

export function CreateExpProvider({ children }: { children: ReactNode }) {
  const {
    generate, cancel, samplerList, schedulerList,
    connected, modelsLoaded, modelLoadError, mlxMissing, checkConnection, fetchModels,
  } = useCreate()
  const { cloudAvailable, quota, refreshQuota } = useCloudSession()
  const cloud = useCloudCreate({ onQuotaChange: refreshQuota })
  const backend = useCreateStore((s) => s.backend)
  const setBackend = useCreateStore((s) => s.setBackend)
  const setCaps = useCreateStore((s) => s.setCaps)
  const [loraList, setLoraList] = useState<string[]>([])
  const [vaeList, setVaeList] = useState<string[]>(['auto'])
  const [comfyCpu, setComfyCpu] = useState<ComfyCpuBannerFacts | null>(null)
  const comfyOnCpu = comfyCpu?.startedCpu === true
  const comfyCpuBanner = comfyCpuBannerText(comfyCpu)

  // Never strand the session on a dead axis: losing the license/logging out
  // while 'cloud' is selected falls back to local rendering.
  useEffect(() => {
    if (!cloudAvailable && backend === 'cloud') setBackend('local')
  }, [cloudAvailable, backend, setBackend])

  // Inputs picked while on cloud skip the ComfyUI staging (filename '') —
  // backfill it when the user switches to local so edit/animate keep working.
  useEffect(() => {
    if (backend !== 'local' || connected !== true) return
    const s = useCreateStore.getState()
    if (s.source && !s.source.filename) {
      ensureLocalFilename(s.source, 'source.png')
        .then((ref) => useCreateStore.getState().setSource(ref))
        .catch(() => { /* next generate surfaces the error */ })
    }
    if (s.mask && !s.mask.filename) {
      ensureLocalFilename(s.mask, 'mask.png')
        .then((ref) => useCreateStore.getState().setMask(ref))
        .catch(() => { /* next generate surfaces the error */ })
    }
  }, [backend, connected])

  // Bootstrap the backend exactly like the old CreateView mount did. On macOS
  // skip the ComfyUI probe entirely — hard rule: Mac local media is MLX-only
  // and ComfyUI never auto-starts there (process.rs::auto_start_comfyui).
  // Probing would pin `connected` to false, which is what the Stage's
  // ModelInstallCard reads as "no models" — it would cover a perfectly working
  // MLX catalog with a ComfyUI install card. Leaving it null means "not
  // applicable", which every ComfyUI-gated surface already treats as neutral.
  // fetchModels() still runs unconditionally: it's what loads the MLX
  // image/video catalogs on Mac.
  useEffect(() => {
    if (!isMacOS()) checkConnection()
    fetchModels()
  }, [checkConnection, fetchModels])

  // Surface a CPU-only ComfyUI so a user isn't left staring at a silent
  // 20-minute timeout. The Rust side records the launch mode at every ComfyUI
  // (re)start; re-read it whenever the connection (re)establishes. Desktop-only
  // (web has no such command → no banner).
  //
  // `mode` and `hasAmd` come along since the R12/R13 re-measure: the banner used
  // to tell a user with a working RTX 3060 that no usable GPU had been detected,
  // when he had picked Force CPU himself, and then handed him AMD instructions
  // on a machine with no AMD card. All three facts were already in this reply.
  useEffect(() => {
    if (connected !== true) { setComfyCpu(null); return }
    let cancelled = false
    backendCall<{ startedCpu?: boolean | null; mode?: string | null; hasAmd?: boolean | null }>('get_comfy_gpu_status')
      .then((s) => {
        if (cancelled) return
        setComfyCpu({
          startedCpu: s?.startedCpu === true,
          mode: asComfyGpuMode(s?.mode),
          hasAmd: s?.hasAmd === true,
          isLinux: isLinux(),
        })
      })
      .catch(() => { if (!cancelled) setComfyCpu(null) })
    return () => { cancelled = true }
  }, [connected])

  // Once ComfyUI is reachable, fetch LoRA/VAE lists and probe installed
  // capabilities (RMBG for cutout, inpaint nodes) so the UI gates correctly.
  // Exposed as refreshModelLists because this used to run exactly once per
  // connect: a .safetensors dropped into models/loras afterwards stayed
  // invisible until an app restart, which read as "no LoRA support at all"
  // (GH #109, ElBiggus). The LoRA stack's Rescan button re-runs it on demand;
  // getAllNodeInfo(true) skips the node cache so the scan is really fresh.
  const refreshModelLists = useCallback(async () => {
    if (connected !== true) return
    const [loras, vaes] = await Promise.all([
      getLoraModels().catch(() => [] as string[]),
      getVAEModels().catch(() => [] as string[]),
    ])
    setLoraList(loras)
    setVaeList(['auto', ...vaes])
    try {
      const nodes = await getAllNodeInfo(true)
      const names = new Set(Object.keys(nodes))
      setCaps({
        rmbg: names.has('RMBG'),
        'inpaint-nodes': names.has('VAEEncodeForInpaint') || names.has('InpaintModelConditioning'),
        dwpose: names.has('DWPreprocessor'),
      })
    } catch { /* node probe is best-effort */ }
  }, [connected, setCaps])
  useEffect(() => { void refreshModelLists() }, [refreshModelLists])

  // Rebuild the ComfyUI venv via the same status contract the installer uses,
  // narrating pip's progress (GH #98). Throws with the last log line on error.
  const repairComfyEnv = useCallback(async (onProgress?: (msg: string) => void, signal?: AbortSignal) => {
    onProgress?.("ComfyUI's Python environment is broken. Rebuilding it as an isolated venv now (~2 GB download). Models, outputs and custom nodes are left alone…")
    await backendCall('repair_comfyui_env')
    for (let i = 0; i < 2700; i++) {
      await waitOrAbort(2000, signal)
      const st = await backendCall<{ status?: string; logs?: string[] }>('install_comfyui_status').catch(() => null)
      const lastLog = st?.logs?.length ? String(st.logs[st.logs.length - 1]) : ''
      if (lastLog) onProgress?.(lastLog)
      if (st?.status === 'complete') return
      if (st?.status === 'error' || st?.status === 'cancelled') {
        throw new Error(lastLog || 'The environment repair failed. See Settings, AI Backends for details.')
      }
    }
    throw new Error('The environment repair did not finish. See Settings, AI Backends for details.')
  }, [])

  // Start ComfyUI and wait for its port, reporting 'crashed' the moment the
  // child exits: polling a port that will never open hid every startup crash
  // behind a spinner (GH #98). The ticking counter stays, a line that never
  // changes for 40s reads as frozen (David, Motion Control card).
  const startAndAwait = useCallback(async (rounds: number, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<'up' | 'crashed' | 'timeout'> => {
    onProgress?.('Starting ComfyUI…')
    await backendCall('start_comfyui')
    for (let i = 0; i < rounds; i++) {
      onProgress?.(`Starting ComfyUI… ${i * 2}s`)
      await waitOrAbort(2000, signal)
      if (await checkComfyConnection()) { checkConnection(); return 'up' }
      const out = await backendCall<{ exited?: boolean }>('comfyui_last_output').catch(() => null)
      if (out?.exited) return 'crashed'
    }
    return 'timeout'
  }, [checkConnection])

  // One-click prerequisite: make sure a local ComfyUI is actually running —
  // start it if it's merely stopped, INSTALL it first if it's missing (the
  // "complete noob PC" case: every Create tab's Download & install button must
  // deliver a 100% functional run, not assume ComfyUI exists).
  //
  // joelnewswanger's loop (GH #98): torch in the shared system Python was
  // broken, every start died at import, the crash read as "not installed",
  // and the re-install changed nothing because pip saw each package as
  // already satisfied. A crash now gets ONE venv rebuild; only a start that
  // cannot find an install at all goes down the one-time download path.
  const ensureComfyRunning = useCallback(async (onProgress?: (msg: string) => void, signal?: AbortSignal) => {
    if (await checkComfyConnection()) return
    let repaired = false
    let installedNow = false
    let r: 'up' | 'crashed' | 'timeout' | 'missing'
    try {
      r = await startAndAwait(60, onProgress, signal)
    } catch { r = 'missing' }
    for (;;) {
      if (r === 'up') return
      if (r === 'crashed') {
        const out = await backendCall<{ lines?: string[]; envBroken?: boolean; hint?: string }>('comfyui_last_output').catch(() => null)
        // Ticket 007: envBroken ist seit 2.6.8 enger. Ein Fehler, dessen
        // Ursache ausserhalb des venv liegt (fehlende Visual-C++-Laufzeit,
        // zu alter Grafiktreiber), kommt hier gar nicht mehr an und kostet
        // den Kunden keine Minuten mehr in einem Neubau, der nichts aendert.
        if (out?.envBroken && !repaired) {
          repaired = true
          await repairComfyEnv(onProgress, signal)
          r = await startAndAwait(60, onProgress, signal)
          continue
        }
        // Der Hinweis aus dem Einordner des Installers, wenn es einen gibt.
        // Der allgemeine Satz ueber die Reparatur gehoert hier nicht hin: der
        // Knopf steht in den Einstellungen, nicht in diesem Ablauf.
        throw new Error(comfyStartupError(out?.lines, out?.hint))
      }
      if (r === 'missing' && !installedNow) {
        installedNow = true
        onProgress?.('ComfyUI is not installed. Downloading and installing it now, this is a one time step of a few GB…')
        await backendCall('install_comfyui')
        // Poll the same status contract the Settings installer uses. Generous cap:
        // a slow connection legitimately needs a while for the one-time install.
        for (let i = 0; i < 2700; i++) {
          await waitOrAbort(2000, signal)
          const st = await backendCall<{ status?: string; logs?: string[] }>('install_comfyui_status').catch(() => null)
          const lastLog = st?.logs?.length ? String(st.logs[st.logs.length - 1]) : ''
          if (lastLog) onProgress?.(lastLog)
          if (st?.status === 'complete') break
          if (st?.status === 'error') {
            throw new Error(lastLog || 'ComfyUI install failed. See Settings → AI Backends for details.')
          }
        }
        r = await startAndAwait(60, onProgress, signal)
        continue
      }
      // Timeout, or a state we already tried to fix once: report with the
      // real output instead of guessing.
      const out = await backendCall<{ lines?: string[]; hint?: string }>('comfyui_last_output').catch(() => null)
      throw new Error(comfyStartupError(out?.lines, out?.hint))
    }
    // `checkConnection` stand hier, ohne im Rumpf vorzukommen: aufgerufen wird
    // es von `startAndAwait`, das selbst schon davon abhaengt. Der Eintrag war
    // damit reine Dopplung derselben Invalidierung.
  }, [repairComfyEnv, startAndAwait])

  // Install a capability in place — mirrors the VHS one-click flow (#72):
  // ensure ComfyUI runs, clone the custom node + pip install where one is
  // needed, restart ComfyUI so it registers, then poll /object_info (clearing
  // the node cache each round so we don't read the stale pre-install
  // catalogue) until the node shows up. The BiRefNet / RMBG-2.0 cutout model
  // is fetched by the node itself on the first run.
  const installCapability = useCallback(async (cap: 'rmbg' | 'inpaint-nodes' | 'dwpose', onProgress?: (msg: string) => void, signal?: AbortSignal) => {
    await ensureComfyRunning(onProgress, signal)
    const capsFrom = (names: Set<string>) => ({
      rmbg: names.has('RMBG'),
      'inpaint-nodes': names.has('VAEEncodeForInpaint') || names.has('InpaintModelConditioning'),
      dwpose: names.has('DWPreprocessor'),
    })
    if (cap === 'inpaint-nodes') {
      // Core ComfyUI nodes — nothing to clone. If they're still missing after
      // ComfyUI is up, the install is ancient; re-probe and say so honestly.
      const nodes = await getAllNodeInfo()
      const names = new Set(Object.keys(nodes))
      setCaps(capsFrom(names))
      if (!names.has('VAEEncodeForInpaint') && !names.has('InpaintModelConditioning')) {
        throw new Error(
          'This ComfyUI is missing its core inpaint nodes (VAEEncodeForInpaint). Update ComfyUI to a current version.',
        )
      }
      return
    }
    // Clone-and-pip capabilities share one flow: install the pack, restart
    // ComfyUI, poll /object_info (cache-cleared) until the node registers.
    const pack = cap === 'dwpose' ? 'controlnet-aux' : 'rmbg'
    const nodeClass = cap === 'dwpose' ? 'DWPreprocessor' : 'RMBG'
    onProgress?.(cap === 'dwpose'
      ? 'Downloading & installing the pose extractor (controlnet aux). This can take a minute…'
      : 'Downloading & installing the background removal node. This can take a minute…')
    await installCustomNodes([pack])
    onProgress?.('Restarting ComfyUI to register the node…')
    await restartComfyForNewNodes()
    for (let i = 0; i < 20; i++) {
      onProgress?.(`Waiting for ComfyUI to come back… ${i * 2}s`)
      await waitOrAbort(2000, signal)
      try {
        clearNodeCache()
        const nodes = await getAllNodeInfo()
        const names = new Set(Object.keys(nodes))
        if (names.has(nodeClass)) {
          setCaps(capsFrom(names))
          return
        }
      } catch { /* ComfyUI still restarting — keep polling */ }
    }
    throw new Error(
      `Installed ${pack} and restarted ComfyUI, but it still isn't listing the ${nodeClass} node. ` +
      'Open the Model Manager to finish the install, or check the ComfyUI console for a pip error.',
    )
  }, [setCaps, ensureComfyRunning])

  // One-click starter models for a fresh PC: ensure ComfyUI, then pull the
  // default bundle for the intent kind (image → SDXL checkpoint, video →
  // Wan 2.1 files, 2.5.8 lanes → their own starter bundles) through the
  // existing resumable downloader, streaming percent progress into the card,
  // then refresh ComfyUI's model enums so the new files are pickable without
  // a restart. Bundles that need a custom node pack (GGUF loader, pose
  // extractor) install + register it first — one click really means one click.
  const installModelBundle = useCallback(async (kind: 'image' | 'video' | 'audio' | 'lipsync' | 'motion', onProgress?: (msg: string) => void, signal?: AbortSignal) => {
    // macOS takes the MLX path — engine plus the smallest model of that kind.
    // Everything below this line is the ComfyUI bundle flow, which would start
    // by installing ComfyUI itself; on a Mac that is the one thing that must
    // never happen (Rust refuses it too — see process.rs::comfy_supported_here).
    // Only image and video exist locally there; the other lanes are cloud
    // teasers on a Mac and never render this card.
    if (isMacOS()) {
      if (kind !== 'image' && kind !== 'video') {
        throw new Error('This one runs in LU Cloud on a Mac — local generation covers images and video.')
      }
      await installMlxStack(kind, onProgress, signal)
      await fetchModels()
      return
    }
    await ensureComfyRunning(onProgress, signal)
    // The video lane picks by the SAME rule the gate uses, because the two
    // disagreed: Stage counts an i2v lane as empty unless it sees an i2v
    // model, and this always installed the first bundle, a Wan 2.1 T2V. On
    // Extend Video and Animate Image that meant a 9.2 GB download that could
    // not possibly make the card go away. See bundleForVideoIntent.
    const bundle = kind === 'video'
      ? bundleForVideoIntent(getVideoBundles(), useCreateStore.getState().intent())
      : (
        kind === 'image' ? getImageBundles()
        : kind === 'audio' ? getAudioBundles()
        : kind === 'lipsync' ? getLipsyncBundles()
        : getMotionBundles()
      )[0]
    if (!bundle) throw new Error('No starter bundle available for this intent.')
    if (bundle.customNodes?.length) {
      onProgress?.('Installing the required node packs. This can take a minute…')
      await installCustomNodes(bundle.customNodes)
      onProgress?.('Restarting ComfyUI to register the new nodes…')
      await restartComfyForNewNodes()
      for (let i = 0; i < 20; i++) {
        onProgress?.(`Waiting for ComfyUI to come back… ${i * 2}s`)
        await waitOrAbort(2000, signal)
        if (await checkComfyConnection()) break
      }
      clearNodeCache()
    }
    // Put the transfer in the header Downloads tray BEFORE the first byte.
    // Until now this path talked to the Rust downloader directly and never
    // touched the store, so the tray read "No active downloads" through a
    // 10.5 GB download and its cancel + retry buttons were unreachable
    // (David 2026-07-25). setBundleGroup collapses the files into one row,
    // setMeta is what the tray's retry needs to restart a failed file.
    const dl = useDownloadStore.getState()
    const files = bundle.files.filter((f) => f.downloadUrl && f.filename && f.subfolder)
    if (files.length > 1) dl.setBundleGroup(bundle.name, files.map((f) => f.filename!))
    for (const f of files) dl.setMeta(f.filename!, f.downloadUrl!, f.subfolder!)
    dl.startPolling()

    await downloadBundleFiles(
      files.map((f) => ({
        filename: f.filename!, subfolder: f.subfolder!, downloadUrl: f.downloadUrl!, sizeGB: f.sizeGB,
      })),
      {
        start: startModelDownload,
        progress: getDownloadProgress,
        onStatus: onProgress,
        // The tray's poller auto stops after an idle window, so re-arm it per
        // file instead of assuming the first call holds for the whole bundle.
        keepTrayLive: () => useDownloadStore.getState().startPolling(),
        // Cancel on the card must kill the Rust transfer too, or the download
        // keeps running invisibly after the card says it stopped.
        stop: (filename) => { void useDownloadStore.getState().cancel(filename) },
        signal,
      },
    )
    onProgress?.('Refreshing the model list…')
    const refreshLists = async () => {
      await refreshComfyModels().catch(() => false)
      clearNodeCache()
      await fetchModels()
    }
    await refreshLists()

    // A finished download is not a finished install. ComfyUI only offers what
    // its own directory scan has picked up, and on the big video bundles that
    // scan is still running when the last byte lands. Without this the card
    // stayed on "Refreshing the model list…" forever (C8, Voxyl AI and Aldrich
    // Ironhart 2026-08-13): the install returned happy, and Stage keeps the
    // card up until the lists refill.
    const enumFiles = files.filter((f) => ENUM_SUBFOLDERS.has(f.subfolder!))
    if (enumFiles.length > 0) {
      const wanted = enumFiles.map((f) => f.filename!)
      // The probe itself lives in discover.ts, because the Model Manager
      // download path needs exactly the same one and a second copy would be a
      // second chance to drift (see modelsNotVisibleInComfy).
      const stillMissing = () => modelsNotVisibleInComfy(wanted)
      let missing = await waitForModelsVisible({
        missing: stillMissing, refresh: refreshLists, onStatus: onProgress, signal,
      })
      // Whatever the restart says is the PRECISE reason, and it has to outlive
      // the block so the throw below can prefer it over its own guess.
      let restartSaid = ''
      if (missing.length > 0) {
        // Heal before complaining: a restart rebuilds the model index for
        // certain, and it is the same move that registers a new node pack.
        //
        // Never while a render is in flight. An install runs on for minutes
        // after Stage swapped its card away, so without this guard a bundle
        // that finished downloading could stop the engine in the middle of
        // somebody's video and leave nothing behind but a dead job.
        if (useCreateStore.getState().isGenerating) {
          onProgress?.('Waiting for the current render to finish before restarting ComfyUI…')
          await waitForIdleRender(signal)
        }
        onProgress?.('Restarting ComfyUI so it picks up the new files…')
        try {
          await restartComfyForNewNodes()
        } catch (e) {
          restartSaid = e instanceof Error ? e.message : String(e)
        }
        // The engine has to be listening again before a scan can report
        // anything. The old code went straight into a 10 by 3s wait, which had
        // to cover the boot AND the directory scan, while this same file
        // budgets 30s for a warm boot alone and 60s after an install. On the
        // 12 GB video bundles the scan is the slow half, so a perfectly good
        // install ran out of time and got told its model folder was wrong.
        if (!restartSaid) await waitForComfyBack(onProgress, signal)
        missing = await waitForModelsVisible({
          missing: stillMissing, refresh: refreshLists, onStatus: onProgress, signal,
        })
      }
      if (missing.length > 0) {
        throw new Error(
          restartSaid ||
          `The files downloaded fine, but ComfyUI still does not list ${missing.join(', ')}. ` +
          'Either it is reading a different model folder than LU writes to, or it was started ' +
          'outside LU and cannot be restarted from here. The Model Manager shows where the ' +
          'files landed.',
        )
      }
    }
  }, [ensureComfyRunning, fetchModels])

  const value: CreateExpValue = {
    generate: backend === 'cloud' ? cloud.generate : generate,
    // Cancel routes by the backend that STARTED the run, not the current axis:
    // the header switch (or the license probe) can flip local/cloud mid-render,
    // and routing by the live value would abort a null handle while the real
    // run keeps going (a cloud job keeps billing; a local job keeps rendering).
    cancel: () => (hasActiveCloudRun() ? cloud.cancel() : cancel()),
    enhanceVideo: cloud.enhanceVideo,
    makeVoice: cloud.makeVoice,
    samplerList, schedulerList, loraList, vaeList, refreshModelLists,
    connected, modelsLoaded, modelLoadError, mlxMissing, comfyOnCpu, comfyCpuBanner, installCapability, installModelBundle,
    cloudAvailable, quota, refreshQuota,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
