// Bug BB v2.5.0 — Discord 2026-05-26. GPU picker UI. Detects GPUs via
// the Rust `detect_gpus` command, lets the user pick vendor + indices, and
// forwards the selection to AppState via `set_gpu_selection`. Applied on
// next Ollama / ComfyUI spawn (current processes need a restart).

import { useEffect, useMemo, useState } from 'react'
import { freeAfterRenderMode } from '../../lib/free-after-render'
import { useSettingsStore } from '../../stores/settingsStore'
import { backendCall, isTauri } from '../../api/backend'
import { isMlxImageHost } from '../../api/mlx-image'
import { restartComfyForNewNodes } from '../../api/comfy-restart'
import { Cpu, RefreshCw, AlertTriangle, RotateCcw } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { GpuRolesPicker } from './GpuRolesPicker'

interface DetectedGpu {
  index: number
  vendor: string
  name: string
  memory_mib: number | null
  source: string
  /** Set when the card was found but its compute stack was not. */
  note?: string | null
}

type GpuVendor = 'auto' | 'nvidia' | 'amd' | 'intel'

const VENDOR_LABELS: Record<GpuVendor, string> = {
  auto: 'Auto (let runtime decide)',
  nvidia: 'NVIDIA (CUDA_VISIBLE_DEVICES)',
  amd: 'AMD (HIP_VISIBLE_DEVICES)',
  intel: 'Intel (ONEAPI_DEVICE_SELECTOR)',
}

/** What a ComfyUI LU does not own gets told when Restart ComfyUI is pressed
 *  here. LU passes --cpu only to a ComfyUI it starts itself, so for that one
 *  the GPU mode does nothing at all, restart or not. */
const COMFY_GPU_OUTSIDE_LU =
  'Your ComfyUI is running outside LU, so LU cannot restart it, and the ComfyUI GPU setting only applies to a ComfyUI that LU starts.'

const VENDOR_HELP: Record<GpuVendor, string> = {
  auto: 'No env-var set. Ollama / ComfyUI use whatever the driver picks first. This matches pre-v2.5.0 behaviour.',
  nvidia: 'Forwards CUDA_VISIBLE_DEVICES. Use on NVIDIA-only or NVIDIA+iGPU setups.',
  amd: 'Forwards HIP_VISIBLE_DEVICES + ROCR_VISIBLE_DEVICES. Works on ROCm Linux, ROCm-on-Windows and ZLUDA. The ROCm command line tools are not required for the card to be listed here.',
  intel: 'Forwards ONEAPI_DEVICE_SELECTOR. For Intel Arc / Iris with IPEX-LLM. Ollama support is limited, verify your engine first.',
}

export function HardwareSettings() {
  const { settings, updateSettings } = useSettingsStore()
  const [gpus, setGpus] = useState<DetectedGpu[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRestartHint, setShowRestartHint] = useState(false)
  // 3.0.7: its own flag. The hint above only showed when a vendor or a card
  // was picked, so Force GPU with the vendor on Auto changed the mode without
  // a word, and the running ComfyUI kept the flags it was started with.
  const [comfyModeChanged, setComfyModeChanged] = useState(false)
  const [comfyRestart, setComfyRestart] = useState<{ busy: boolean; done: boolean; error: string }>({ busy: false, done: false, error: '' })

  const vendor = (settings.gpuVendor || 'auto') as GpuVendor
  // Das `|| []` erzeugte bei jedem Render ein frisches Array. Der Effekt unten
  // haengt an `indices` und schickte deshalb bei JEDEM Render ein
  // `set_gpu_selection` ans Backend, statt nur bei einer echten Aenderung.
  const indices = useMemo(() => settings.gpuIndices || [], [settings.gpuIndices])

  const detect = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await backendCall<DetectedGpu[]>('detect_gpus')
      setGpus(Array.isArray(result) ? result : [])
    } catch (e) {
      setError(`GPU detection failed: ${e instanceof Error ? e.message : String(e)}`)
      setGpus([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    detect()
  }, [])

  // Push selection to AppState on every change so the next ollama / comfyui
  // spawn picks it up. No-op when not running in Tauri (dev mode).
  useEffect(() => {
    backendCall('set_gpu_selection', { selection: { vendor, indices } }).catch(() => {})
  }, [vendor, indices])

  const gpusForVendor = useMemo(() => {
    if (vendor === 'auto') return gpus
    return gpus.filter(g => g.vendor === vendor)
  }, [gpus, vendor])

  const setVendor = (v: GpuVendor) => {
    updateSettings({ gpuVendor: v, gpuIndices: [] }) // reset indices when vendor changes
    setShowRestartHint(true)
  }

  const toggleIndex = (idx: number) => {
    const next = indices.includes(idx)
      ? indices.filter(i => i !== idx)
      : [...indices, idx].sort((a, b) => a - b)
    updateSettings({ gpuIndices: next })
    setShowRestartHint(true)
  }

  // 3.0.8: what LU installs into a ComfyUI environment on this machine, read
  // from the same plan the installer uses, so the line cannot promise a build
  // the install would not fetch. Desktop only, no network behind it.
  const [torchPlan, setTorchPlan] = useState<{ kind: string; summary: string } | null>(null)
  useEffect(() => {
    if (!isTauri() || isMlxImageHost()) return
    let cancelled = false
    backendCall<{ kind?: string; summary?: string }>('comfy_torch_plan')
      .then((p) => { if (!cancelled && p?.summary) setTorchPlan({ kind: String(p.kind ?? ''), summary: p.summary }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const comfyGpuMode = (settings.comfyGpuMode || 'auto') as 'auto' | 'cpu' | 'gpu'
  const freeAfter = freeAfterRenderMode(settings.freeAfterRender)
  const setComfyGpuMode = (mode: 'auto' | 'cpu' | 'gpu') => {
    updateSettings({ comfyGpuMode: mode })
    // Desktop-only command; the web build points at a remote ComfyUI and never
    // starts a local one, so this is a no-op there.
    if (isTauri()) backendCall('set_comfy_gpu_mode', { mode }).catch(() => {})
    setShowRestartHint(true)
    setComfyModeChanged(true)
    setComfyRestart({ busy: false, done: false, error: '' })
  }

  // The same restart the node pack screens use: stop, make sure the port went
  // quiet, start. The mode is sent once more first, so a click right after the
  // switch cannot start ComfyUI before the backend has the new mode.
  const restartComfy = async () => {
    setComfyRestart({ busy: true, done: false, error: '' })
    try {
      await backendCall('set_comfy_gpu_mode', { mode: comfyGpuMode })
      await restartComfyForNewNodes(COMFY_GPU_OUTSIDE_LU)
      setComfyRestart({ busy: false, done: true, error: '' })
    } catch (e) {
      setComfyRestart({ busy: false, done: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="space-y-3">
      {/* Eine Zeile, kein Kasten: das hier erklaert nur, wofuer der Abschnitt
          gut ist. Frueher stand derselbe Satz in einem gelben Rahmen mit
          gelber Fuellung und trug damit das Gewicht eines Absturzes. Regel:
          lib/hinweis.ts. */}
      <Hinweis icon={<Cpu size={11} className="shrink-0 mt-[3px]" />}>
        GPU picker. Forwards CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES / ONEAPI_DEVICE_SELECTOR to Ollama + ComfyUI on next spawn. Use only on multi-GPU / multi-vendor systems where the driver picks the wrong device by default.
      </Hinweis>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[0.7rem] text-gray-700 dark:text-gray-300 font-medium">Vendor</span>
          <button
            onClick={detect}
            disabled={loading}
            className="text-[0.6rem] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 disabled:opacity-50"
            aria-label="Re-detect GPUs"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
            Re-detect
          </button>
        </div>
        <div className="grid grid-cols-1 gap-1">
          {(Object.keys(VENDOR_LABELS) as GpuVendor[]).map(v => (
            <label key={v} className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-white/[0.04] border border-transparent has-[input:checked]:border-white/10 has-[input:checked]:bg-white/[0.03]">
              <input
                type="radio"
                name="gpu-vendor"
                checked={vendor === v}
                onChange={() => setVendor(v)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[0.65rem] text-gray-300">{VENDOR_LABELS[v]}</div>
                <div className="text-[0.55rem] text-gray-500 mt-0.5 leading-relaxed">{VENDOR_HELP[v]}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[0.7rem] text-gray-700 dark:text-gray-300 font-medium mb-1">Detected GPUs</div>
        {error && (
          <Hinweis ton="fehler" className="mb-1.5" icon={<AlertTriangle size={11} className="shrink-0 mt-[3px]" />}>
            {error}
          </Hinweis>
        )}
        {!error && gpus.length === 0 && !loading && (
          <Hinweis className="italic">
            No GPUs detected via nvidia-smi / rocm-smi / lspci / wmic. The "Auto" vendor option still works, Ollama will use whatever the driver picks.
          </Hinweis>
        )}
        {gpusForVendor.length > 0 && (
          <div className="space-y-1">
            {gpusForVendor.map(g => {
              const checked = indices.includes(g.index)
              const isAuto = vendor === 'auto'
              return (
                <label
                  key={`${g.vendor}-${g.index}-${g.name}`}
                  className={`flex items-center gap-2 p-1.5 rounded border ${
                    isAuto ? 'border-white/5 opacity-60 cursor-not-allowed' : 'border-white/8 hover:bg-white/[0.04] cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked && !isAuto}
                    disabled={isAuto}
                    onChange={() => toggleIndex(g.index)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.65rem] text-gray-200 truncate">
                      <span className="font-mono text-gray-500">#{g.index}</span> {g.name}
                    </div>
                    <div className="text-[0.55rem] text-gray-500">
                      {g.vendor}
                      {g.memory_mib ? ` · ${(g.memory_mib / 1024).toFixed(1)} GB` : ''}
                      {` · via ${g.source}`}
                    </div>
                    {/* An honest state beats a silent one: the card is listed
                        and selectable, and the line says what LU could not
                        verify, so nobody rebuilds a working install chasing
                        a driver problem that is not there. */}
                    {/* Ein Ton statt zwei. Die Zeile war gelb, sobald der
                        Rueckgabewert nicht 'info' sagte, und genau danach
                        fragte hypocritical_rj im Hilfe-Chat (26.08.): ob das
                        Gelb ein Problem sei. Es war nie eins. Die eine Meldung
                        nennt ROCm-Version und Architektur, die andere sagt,
                        dass LU die Rechenschicht nicht pruefen konnte, und die
                        Karte laeuft in beiden Faellen. Beide sind ruhiges Grau,
                        und die Schwere vom Backend wird hier nicht mehr
                        gelesen. Regel: lib/hinweis.ts. */}
                    {g.note && (
                      <div className={`text-[0.55rem] mt-0.5 leading-relaxed ${HINWEIS_TEXT.ruhig}`}>
                        {g.note}
                      </div>
                    )}
                  </div>
                </label>
              )
            })}
          </div>
        )}
        {vendor !== 'auto' && gpusForVendor.length === 0 && gpus.length > 0 && !loading && (
          <Hinweis className="italic mt-1">
            No {vendor.toUpperCase()} GPUs detected on this system. Either install the vendor tool ({vendor === 'nvidia' ? 'nvidia-smi' : vendor === 'amd' ? 'rocm-smi' : 'driver providing lspci/wmic info'}) or switch back to "Auto".
          </Hinweis>
        )}
      </div>

      {/* 3.0.8 (A2): a card per task, only with two or more cards and never
          on the Mac (one GPU, and ComfyUI does not run there). */}
      {!isMlxImageHost() && <GpuRolesPicker gpus={gpus} />}

      {/* ComfyUI GPU selection is meaningless on the Mac — MLX runs on Metal and
          ComfyUI never launches there. */}
      {!isMlxImageHost() && (
      <div className="pt-2 border-t border-white/[0.06]">
        <div className="text-[0.7rem] text-gray-700 dark:text-gray-300 font-medium mb-1">ComfyUI GPU (image / video)</div>
        <div className="grid grid-cols-1 gap-1">
          {([
            ['auto', 'Auto (recommended)', 'NVIDIA runs on the GPU. On an AMD, Intel Arc or other card LU checks whether your ComfyUI has a GPU-capable torch (ROCm, ZLUDA or Intel XPU) and uses it, otherwise falls back to CPU.'],
            ['gpu', 'Force GPU', 'Never fall back to CPU. Use if you run a ComfyUI of your own whose GPU torch LU cannot detect. If your ComfyUI has no working GPU torch it will fail to start. The ComfyUI log then says why and what fixes it.'],
            ['cpu', 'Force CPU', 'Always run image / video on the CPU. Slow but stable, useful if generation crashes your GPU by running out of VRAM.'],
          ] as const).map(([val, label, help]) => (
            <label key={val} className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-white/[0.04] border border-transparent has-[input:checked]:border-white/10 has-[input:checked]:bg-white/[0.03]">
              <input
                type="radio"
                name="comfy-gpu-mode"
                checked={comfyGpuMode === val}
                onChange={() => setComfyGpuMode(val)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[0.65rem] text-gray-300">{label}</div>
                <div className="text-[0.55rem] text-gray-500 mt-0.5 leading-relaxed">{help}</div>
              </div>
            </label>
          ))}
        </div>
        {/* Written before 2.6.7 and untrue since: LU picks the wheels by card
            now (57196b31, 6d5dc61e, 3570ce53), so "installs an NVIDIA / CPU
            ComfyUI by default" would send an AMD user looking for a ComfyUI of
            his own that the app has already installed for him. The families no
            wheel carries kernels for are named too, because staying on the
            processor there is a decision and not a failure. */}
        {torchPlan && (
          <div className="text-[0.55rem] text-gray-400 mt-1 leading-relaxed" data-testid="comfy-torch-plan">
            <span className="text-gray-300">What LU installs on this machine:</span> {torchPlan.summary}
          </div>
        )}
        <div className="text-[0.55rem] text-gray-500 mt-1 leading-relaxed">
          AMD image / video: on Linux LU installs the ROCm build of PyTorch, except for the cards
          no ROCm wheel carries kernels for, which stay on the processor build on purpose. On
          Windows LU installs AMD's own ROCm build for RX 7000 and RX 9000 cards (also Radeon PRO
          W7000, AI PRO R9700 and Ryzen AI APUs), and the processor build for everything else.
          Intel Arc gets the XPU build of PyTorch. This applies when the ComfyUI environment is
          built: Install ComfyUI, or Repair environment in Settings, ComfyUI for an environment
          that already exists. Takes effect on next ComfyUI start.
        </div>
        {comfyModeChanged && (
          <div className="mt-2 space-y-1" data-testid="comfy-gpu-restart-hint">
            <p className={`t-micro leading-relaxed ${HINWEIS_TEXT.ruhig}`}>
              ComfyUI only reads this when it starts, so the ComfyUI that is running now keeps its old mode.
              Restart ComfyUI to apply it. After the restart, the Device line under Status in AI Backends,
              ComfyUI (Image &amp; Video) shows what ComfyUI runs on: cuda or xpu is the card, cpu is the processor.
            </p>
            {isTauri() && (
              <button
                onClick={() => { void restartComfy() }}
                disabled={comfyRestart.busy}
                className="px-2 py-1 rounded t-micro bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30 inline-flex items-center gap-1"
              >
                <RotateCcw size={10} className={comfyRestart.busy ? 'animate-spin' : ''} />
                {comfyRestart.busy ? 'Restarting ComfyUI' : 'Restart ComfyUI'}
              </button>
            )}
            {comfyRestart.done && (
              <p className="t-micro text-emerald-400">ComfyUI is starting again with the new mode.</p>
            )}
            {comfyRestart.error && (
              <p role="alert" className={`t-micro ${HINWEIS_TEXT.fehler}`}>{comfyRestart.error}</p>
            )}
          </div>
        )}
      </div>
      )}

      {/* B27 (3.0.9): give ComfyUI's memory back after a render. Not on the
          Mac: its image engine lets go of its model when the picture is out. */}
      {!isMlxImageHost() && (
      <div className="pt-2 border-t border-white/[0.06]" data-testid="free-after-render">
        <div className="t-label text-gray-700 dark:text-gray-300 font-medium mb-1">After a render</div>
        <div className="grid grid-cols-1 gap-1">
          {([
            ['idle', 'Free memory after 5 minutes (recommended)', 'Renders in a row stay fast. When nothing renders for 5 minutes, the image and video models leave the graphics card and the RAM.'],
            ['now', 'Free memory right away', 'The models leave the graphics card and the RAM a few seconds after each render. The next render loads them again, which can take a minute.'],
            ['keep', 'Keep the models loaded', 'The fastest next render. The memory stays taken until ComfyUI stops.'],
          ] as const).map(([val, label, help]) => (
            <label key={val} className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-white/[0.04] border border-transparent has-[input:checked]:border-white/10 has-[input:checked]:bg-white/[0.03]">
              <input
                type="radio"
                name="free-after-render"
                checked={freeAfter === val}
                onChange={() => updateSettings({ freeAfterRender: val })}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="t-micro text-gray-300">{label}</div>
                <div className="t-micro text-gray-500 mt-0.5 leading-relaxed">{help}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
      )}

      {showRestartHint && (vendor !== 'auto' || indices.length > 0) && (
        <Hinweis className="italic">
          GPU pick takes effect on next Ollama / ComfyUI spawn. Restart ComfyUI under AI Backends, ComfyUI (Image &amp; Video), or close LU to apply it to both.
        </Hinweis>
      )}
    </div>
  )
}
