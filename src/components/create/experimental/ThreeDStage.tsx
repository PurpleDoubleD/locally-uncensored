// What the Stage of the 3D tab shows before there is anything to show: the
// one-time setup of the local engine, and the hint for a video.
//
// Local 3D has its own setup, not the starter-bundle gate of requiresModels:
// on a Mac it is an engine of its own per model (TripoSR in
// commands/mesh3d.rs, Stable Fast 3D in commands/mesh3d_sf3d.rs, through
// api/mlx-3d.ts), on Windows and Linux a ComfyUI bundle (TRELLIS.2,
// lib/local-3d-comfy.ts). A model with a licence to accept (Stable Fast 3D)
// says it on the card before anything is downloaded.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Box, Film } from 'lucide-react'
import { isMlxImageHost } from '../../../api/mlx-image'
import { openExternal } from '../../../api/backend'
import type { Mesh3dModel } from '../../../api/mlx-3d'
import { mac3dModel, type Mac3dModelId } from '../../../lib/mac-3d'
import { getMaxVramGb, getSharedMemoryGb } from '../../../lib/hardware'
import { getThreeDBundles } from '../../../api/model-bundles'
import { axisShift, macThreeDChoices, pcThreeDChoices, startingChoice, type ThreeDChoice } from '../../../lib/three/local-3d-choice'
import { THREE_D_TEXT as T } from '../../../lib/three/three-d-text'
import { stageAnswers } from '../../../lib/create/stage-answers'
import { useCreateStore } from '../../../stores/createStore'
import { useUIStore } from '../../../stores/uiStore'
import { useCreateExp } from './CreateContext'
import { Button } from '../ui/Button'

export const SETUP_TEXT = {
  macTitle: '3D on this Mac needs a one-time download',
  macBody: 'This sets up the 3D engine and the TripoSR model, about 1.7 GB. It turns one picture into a 3D model on this Mac. Local 3D is never filtered.',
  pcTitle: 'Local 3D needs a one-time download',
  pcBody: 'This sets up ComfyUI itself if it is missing, plus the TRELLIS.2 model files, about 9 GB. It needs a graphics card with 12 GB or more. Local 3D is never filtered.',
  sf3dTitle: 'Stable Fast 3D needs a one-time download',
  sf3dBody: 'This sets up its own 3D engine and the Stable Fast 3D model, about 4 GB. It turns one picture into a 3D model with a painted texture, on this Mac.',
  licenseLink: 'Open the model page',
  tokenNeeded: 'Add your Hugging Face token first. Accept the licence on the model page with the same account.',
  tokenButton: 'Open Settings',
  install: 'Download & install',
  recommended: 'Recommended',
  needsToken: 'Needs a Hugging Face token.',
  cancel: 'Cancel',
  checking: 'Checking for the 3D engine…',
}

interface ThreeDAnswer {
  ok: boolean
  card: Mesh3dModel | null
  choices: ThreeDChoice[]
}

const NO_CHOICES: ThreeDChoice[] = []

export interface ThreeDSetup {
  /** null while the check runs. */
  ready: boolean | null
  /** The Mac model the card is for, with its licence when it has one. */
  card: Mesh3dModel | null
  /** What this machine can install, with the recommended one marked. */
  choices: ThreeDChoice[]
  needsSetup: boolean
  installing: boolean
  line: string | null
  error: string | null
  install: () => void
  cancel: () => void
}

/** Whether the local 3D engine of this machine is there, and the means to
 *  set it up. Asks nothing while `active` is false. */
export function useThreeDLocal(active: boolean): ThreeDSetup {
  const mac = isMlxImageHost()
  const macModel = mac3dModel(useCreateStore((s) => s.threeDMacModel)).id
  const { installModelBundle, connected } = useCreateExp()
  // The answer belongs to the model it was asked for. The last known one
  // stands while the check runs again, so a visit does not start from nothing.
  const key = mac ? `3d:mac:${macModel}` : '3d:pc'
  const [live, setLive] = useState<ThreeDAnswer & { key: string } | null>(null)
  const known = live?.key === key ? live : stageAnswers.get<ThreeDAnswer>(key)
  const ready = known?.ok ?? null
  const card = known?.card ?? null
  const choices = known?.choices ?? NO_CHOICES
  const [installing, setInstalling] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const check = useCallback(async (): Promise<ThreeDAnswer & { sure: boolean }> => {
    try {
      if (mac) {
        const { getMesh3dStatus, mesh3dModelOf } = await import('../../../api/mlx-3d')
        const ticket = stageAnswers.ticket()
        const st = await getMesh3dStatus()
        const model = mesh3dModelOf(st, macModel)
        const ramGb = await getSharedMemoryGb()
        const models = st.models ?? (st.model ? [st.model] : [])
        const offered = macThreeDChoices({ vramGb: 0, ramGb }, models)
        // One status names every model, so picking another on the card has its
        // answer at once and the card does not blink.
        for (const m of models) {
          if (m.id !== macModel) stageAnswers.answer(`3d:mac:${m.id}`, { ok: !!m.installed, card: m, choices: offered }, ticket)
        }
        return { ok: !!model?.installed, card: model, choices: offered, sure: true }
      }
      const { comfyThreeDReady } = await import('../../../lib/local-3d-comfy')
      const ok = await comfyThreeDReady()
      let offered: ThreeDChoice[] = []
      if (!ok) {
        const [bundle] = getThreeDBundles()
        if (bundle) {
          const vramGb = await getMaxVramGb()
          offered = pcThreeDChoices({ vramGb, ramGb: 0 }, { id: bundle.workflow ?? bundle.name, name: 'TRELLIS.2', sizeGB: bundle.totalSizeGB ?? 0 })
        }
      }
      // ComfyUI down says nothing about the files: shown, never remembered.
      return { ok, card: null, choices: offered, sure: connected === true }
    } catch {
      return { ok: false, card: null, choices: NO_CHOICES, sure: false }
    }
  }, [mac, macModel, connected])

  useEffect(() => {
    if (!active || (!mac && connected === null)) return
    let alive = true
    const ask = () => {
      const ticket = stageAnswers.ticket()
      void check().then(({ ok, card: model, choices: offered, sure }) => {
        // A reply overtaken by a model change is not the state after it.
        if (!alive || ticket !== stageAnswers.ticket()) return
        if (sure) stageAnswers.answer(key, { ok, card: model, choices: offered }, ticket)
        setLive({ key, ok, card: model, choices: offered })
      })
    }
    ask()
    window.addEventListener('comfyui-model-downloaded', ask)
    return () => {
      alive = false
      window.removeEventListener('comfyui-model-downloaded', ask)
    }
  }, [active, check, key, mac, connected])

  const install = useCallback(() => {
    if (installing) return
    const controller = new AbortController()
    abort.current = controller
    setInstalling(true)
    setError(null)
    void (async () => {
      try {
        if (mac) {
          const api = await import('../../../api/mlx-3d')
          await api.installMesh3d(macModel)
          for (;;) {
            if (controller.signal.aborted) {
              await api.cancelMesh3dInstall().catch(() => undefined)
              break
            }
            const st = await api.getMesh3dInstallStatus()
            setLine(installLine(st))
            if (st.status === 'complete') break
            if (st.status === 'error') throw new Error(st.error ?? 'The 3D setup stopped.')
            await new Promise((r) => setTimeout(r, 1000))
          }
        } else {
          await installModelBundle('3d', (msg) => setLine(msg), controller.signal)
        }
        const after = await check()
        if (after.sure) stageAnswers.set(key, { ok: after.ok, card: after.card, choices: after.choices })
        setLive({ key, ok: after.ok, card: after.card, choices: after.choices })
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstalling(false)
        setLine(null)
        abort.current = null
      }
    })()
  }, [installing, mac, macModel, key, check, installModelBundle])

  const cancel = useCallback(() => abort.current?.abort(), [])

  return { ready, card, choices, needsSetup: active && ready === false, installing, line, error, install, cancel }
}

function installLine(st: { status: string; download_progress?: number; download_total?: number; logs?: string[] }): string | null {
  if (st.download_total && st.download_total > 0) {
    const pct = Math.min(100, Math.floor(((st.download_progress ?? 0) / st.download_total) * 100))
    return `Downloading… ${pct}%`
  }
  return st.logs?.length ? st.logs[st.logs.length - 1] : null
}

/** The sideways shift that puts `ref` over the 3D row of the prompt window. */
function usePromptAxis(ref: RefObject<HTMLElement | null>): number {
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const card = ref.current
    const stage = card?.closest('[data-testid="create-stage"]')
    if (!card || !stage) return
    const measure = () => {
      const prompt = document.querySelector('[data-testid="three-d-controls"]')
      if (!prompt) return
      const s = stage.getBoundingClientRect()
      const p = prompt.getBoundingClientRect()
      // The app is drawn at a UI scale. The rectangles are in screen pixels,
      // a translateX is in the card's own.
      const scale = s.width / ((stage as HTMLElement).offsetWidth || s.width) || 1
      setShift(axisShift((s.x + s.width / 2) / scale, (p.x + p.width / 2) / scale, s.width / scale, card.offsetWidth))
    }
    measure()
    // The card's own width and the prompt row settle a frame after the mount.
    const frame = requestAnimationFrame(measure)
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(frame)
    const watch = new ResizeObserver(measure)
    watch.observe(stage)
    watch.observe(card)
    const prompt = document.querySelector('[data-testid="three-d-controls"]')
    if (prompt) watch.observe(prompt)
    return () => {
      cancelAnimationFrame(frame)
      watch.disconnect()
    }
  }, [ref])
  return shift
}

export function ThreeDSetupCard({ setup }: { setup: ThreeDSetup }) {
  const mac = isMlxImageHost()
  const openSettingsAt = useUIStore((s) => s.openSettingsAt)
  // The picked model decides the card, also before (or without) an answer
  // from the engine: with Stable Fast 3D picked the card never offers TripoSR.
  const picked = mac3dModel(useCreateStore((s) => s.threeDMacModel))
  const gated = mac && (setup.card?.gated ?? picked.gated)
  const title = !mac ? SETUP_TEXT.pcTitle : gated ? SETUP_TEXT.sf3dTitle : SETUP_TEXT.macTitle
  const body = !mac ? SETUP_TEXT.pcBody : gated ? SETUP_TEXT.sf3dBody : SETUP_TEXT.macBody
  const tokenMissing = gated && !setup.card?.hasToken
  const licenseUrl = setup.card?.licenseUrl
  const setMacModel = useCreateStore((s) => s.setThreeDMacModel)
  // The recommended model is preselected once, and nothing loads until the
  // button is pressed. A model already picked in the chip stays picked.
  const choiceKey = setup.choices.map((c) => c.id).join()
  const offered = useRef('')
  useEffect(() => {
    if (!mac || !choiceKey || offered.current === choiceKey) return
    offered.current = choiceKey
    const start = startingChoice(setup.choices, picked.id)
    if (start && start !== picked.id) setMacModel(start as Mac3dModelId)
  }, [mac, choiceKey, setup.choices, picked.id, setMacModel])
  const cardRef = useRef<HTMLDivElement>(null)
  const shift = usePromptAxis(cardRef)
  const selected = mac ? picked.id : setup.choices[0]?.id
  const selectedChoice = setup.choices.find((c) => c.id === selected)
  return (
    <div ref={cardRef} style={shift ? { transform: `translateX(${shift}px)` } : undefined} className="m-auto w-full flex flex-col items-center gap-3 max-w-[440px] max-h-full overflow-y-auto text-center p-6" data-testid="three-d-setup">
      <Box size={30} className="text-gray-400" />
      <h3 className="t-title text-gray-100">{title}</h3>
      <p className="t-body text-gray-400">{body}</p>
      {setup.choices.length > 0 && (
        <div role="radiogroup" aria-label="3D model" className="w-full flex flex-col" data-testid="three-d-choices">
          {setup.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === selected}
              disabled={setup.installing || !mac}
              onClick={() => setMacModel(c.id as Mac3dModelId)}
              data-testid={`three-d-choice-${c.id}`}
              className={`w-full flex items-start gap-2 px-2 py-1.5 text-left rounded-md transition-colors ${c.id === selected ? 'bg-gray-500/10' : mac ? 'hover:bg-gray-500/5' : ''}`}
            >
              <span aria-hidden className={`mt-1 w-2.5 h-2.5 shrink-0 rounded-full border ${c.id === selected ? 'border-lu-accent bg-lu-accent' : 'border-gray-500'}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="t-control text-gray-200">{c.name}{c.recommended && <span className="ml-2 t-micro text-gray-500">{SETUP_TEXT.recommended}</span>}</span>
                  <span className="t-micro text-gray-500 shrink-0 lu-hud-num">{c.sizeGB.toFixed(1)} GB</span>
                </span>
                <span className={`block t-micro ${c.fit === 'tight' ? 'text-amber-500 dark:text-amber-300' : 'text-gray-500'}`}>{c.blocked ? SETUP_TEXT.needsToken : c.fitLine}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {gated && setup.card?.licenseText && (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-2" data-testid="three-d-license">
          <p className="t-micro leading-snug text-gray-400 text-left">{setup.card.licenseText}</p>
          {licenseUrl && (
            <button type="button" className="t-body text-gray-300 underline" onClick={() => void openExternal(licenseUrl)}>
              {SETUP_TEXT.licenseLink}
            </button>
          )}
        </div>
      )}
      {tokenMissing && !setup.installing && (
        <>
          <p className="t-body text-gray-300" data-testid="three-d-token-needed">{SETUP_TEXT.tokenNeeded}</p>
          <Button variant="secondary" onClick={() => openSettingsAt({ tab: 'backends' })}>{SETUP_TEXT.tokenButton}</Button>
        </>
      )}
      {setup.installing ? (
        <>
          <p className="t-body text-gray-300" data-testid="three-d-setup-line">{setup.line ?? T.phases.ready}</p>
          <Button variant="secondary" onClick={setup.cancel}>{SETUP_TEXT.cancel}</Button>
        </>
      ) : (
        <Button variant="primary" onClick={setup.install} disabled={tokenMissing || !!selectedChoice?.blocked} data-testid="three-d-setup-install">{SETUP_TEXT.install}</Button>
      )}
      {setup.error && <p className="t-body text-red-300" role="alert">{setup.error}</p>}
    </div>
  )
}

/** The empty Stage of "From video": the video goes in the Composer, and the
 *  first still frame will stand here. */
export function ThreeDVideoHint() {
  return (
    <div className="m-auto flex flex-col items-center gap-2 max-w-[420px] text-center p-6" data-testid="three-d-video-hint">
      <Film size={28} className="text-gray-400" />
      <p className="t-body text-gray-300">{T.dropVideo}</p>
      <p className="t-body text-gray-500">{T.dropVideoSub}</p>
    </div>
  )
}
