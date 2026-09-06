/**
 * Schritt „Image & video": ComfyUI finden, auswaehlen oder installieren —
 * und, wenn noetig, vorher Python.
 *
 * Warum es dieses Modul gibt: dieser Bildschirm haelt sechs Zustaende, die
 * KEIN anderer Bildschirm liest — der Auto-Scan, sein Ergebnis, die
 * Mehrfach-Install-Auswahl (Bug #3), der handeingetragene Pfad, das
 * „bereit"-Flag und die Wiedereintrittssperre des Scans. Nach aussen gibt er
 * genau eine Nachricht: `setStep('models')`. Ein geschlossenerer Schnitt ist
 * in dieser Datei nicht zu haben.
 *
 * Was er sich trotzdem teilt: die beiden Installer-Maschinen (ComfyUI und
 * Python) kommen aus `useInstallerFleet`, nicht von hier. Sie muessen dort
 * liegen, weil sie sich mit Ollama und LM Studio EINEN Takt teilen — vier
 * Anzeigen, eine Uhr (AS-09). Faenge dieser Schritt seine eigenen an, waeren
 * es wieder zwei Uhren.
 *
 * `step` faehrt als Prop mit, obwohl dieses Bauteil nur auf diesem Schritt
 * gezeichnet wird: der Auto-Scan-Effekt haengt daran, und er steht hier
 * unveraendert. Waehrend die Karte ausblendet, ist sie noch montiert und
 * `step` steht schon auf dem naechsten — die Bedingung im Effekt ist also
 * nicht ueberfluessig, sie ist genau fuer diesen Moment da.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Check, Download, RefreshCw, ArrowRight, ChevronRight, FolderOpen, Image as ImageIcon, AlertTriangle } from 'lucide-react'
import { withInstallerOutput, withDetail } from '../../lib/error-text'
import { ICON_LG } from '../ui/icon-size'
import { Hinweis } from '../ui/Hinweis'
import { ProgressBar } from '../ui/ProgressBar'
import { backendCall, isMacOS } from '../../api/backend'
import { formatBytes } from '../../lib/formatters'
import { isRunning, formatElapsed, lastLog, type InstallerStatusResponse } from './installer-state'
import type { Step } from './wizard-steps'
import type { OnboardingSkin } from './onboarding-skin'
import type { InstallerFleet } from './use-installer-fleet'

interface ComfyStepProps {
  skin: OnboardingSkin
  fleet: InstallerFleet
  step: Step
  setStep: (step: Step) => void
}

export function ComfyStep({ skin, fleet, step, setStep }: ComfyStepProps) {
  const { isDark, cardClass, primaryBtn, secondaryBtn } = skin
  const { comfyInstall, comfyDo, pythonInstall, pythonDo, secondsOf } = fleet

  // ComfyUI step state. `comfyFound.complete` distinguishes a working
  // install from a half-cloned carcass — see is_comfyui_install_complete in
  // process.rs. UI uses `complete:false` to surface a Re-install option
  // instead of "ComfyUI detected, Continue".
  // Der Scan laeuft ab dem ERSTEN Bild, nicht erst ab dem zweiten. Vorher
  // stand hier `useState(false)` und einen Effekt weiter unten ein
  // `setComfyDetecting(true)` — ein zweiter Render fuer eine Aussage, die
  // beim Montieren schon feststand, denn dieses Bauteil existiert genau
  // dann, wenn der Schritt erreicht ist. Solange alles in einer
  // 1909-Zeilen-Funktion lag, hat der Compiler hinter
  // `react-hooks/set-state-in-effect` diese Funktion nicht gelesen und
  // geschwiegen; klein genug, meldet er sie. Die Bedingung ist dieselbe
  // geblieben, die auch der Effekt fuehrt: auf dem Mac wird hier nichts
  // gesucht (harte Regel — Bild/Video ist dort MLX, nie ComfyUI).
  const [comfyDetecting, setComfyDetecting] = useState(() => !isMacOS())
  const [comfyFound, setComfyFound] = useState<{ found: boolean; path?: string; complete?: boolean } | null>(null)

  const [comfyPathInput, setComfyPathInput] = useState('')
  const [comfyReady, setComfyReady] = useState(false)
  // Bug #3 (ninjastic2008 v2.4.3): multi-install disambiguation. When
  // `detect_all_comfyui_installs` returns more than one hit the user picks
  // explicitly instead of LU auto-picking the first scan match. Picking
  // the wrong install caused "ComfyUI loaded endlessly" because their
  // manual install's `python_embeded` was incompatible with our default
  // System-Python launcher.
  type ComfyInstallChoice = {
    path: string
    complete: boolean
    has_embedded_python: boolean
    source: string
  }
  const [comfyChoices, setComfyChoices] = useState<ComfyInstallChoice[]>([])

  /** Der Auto-Scan laeuft einmal pro Mount, sobald der comfyui-Schritt erreicht
   *  ist. Ref statt State: der Wert steuert keinen Render, sondern verhindert
   *  nur den Wiedereintritt in den Effekt. */
  const comfyAutoDetectStarted = useRef(false)

  // Auto-detect ComfyUI when entering the comfyui step. We mark the install
  // as "ready" (=> Continue button) only when both `found` AND `complete`
  // are true. A `found && !complete` carcass (P14) keeps the install option
  // visible so the user can re-trigger and let LU rebuild torch/deps.
  useEffect(() => {
    // Belt-and-suspenders: nextStepAfterBackends() already routes macOS
    // straight past this step, so `step` should never actually be 'comfyui'
    // there — but never auto-detect/install ComfyUI on Mac regardless (hard
    // rule: Mac local image/video is MLX only).
    if (step === 'comfyui' && !isMacOS() && !comfyAutoDetectStarted.current) {
      // Die Wiedereintritts-Sperre steckte bisher in `!comfyFound &&
      // !comfyDetecting`. Als Dependencies notiert waeren genau diese beiden
      // eine Endlosschleife: der Mehrfach-Install-Zweig setzt `comfyFound`
      // absichtlich wieder auf null und `finally` setzt `comfyDetecting` auf
      // false — der Effekt haette sich damit selbst nachgetriggert und den
      // Backend-Scan in Dauerschleife gefahren. Die Sperre ist Lauf-Zustand,
      // kein Render-Zustand, und liegt deshalb in einer Ref.
      comfyAutoDetectStarted.current = true
      // First: enumerate ALL installs (Bug #3). When >1 we show a picker
      // BEFORE auto-picking — preventing the ninjastic2008 trap where LU
      // detected their manual install while they wanted the empty placeholder
      // path. `find_comfyui` is the auto-pick fallback for the single-install
      // case, which keeps the existing happy-path behaviour intact.
      backendCall<ComfyInstallChoice[]>('detect_all_comfyui_installs')
        .then(async installs => {
          if (Array.isArray(installs) && installs.length > 1) {
            setComfyChoices(installs)
            setComfyFound(null)
            return
          }
          if (Array.isArray(installs) && installs.length === 1) {
            const only = installs[0]
            setComfyFound({ found: true, path: only.path, complete: only.complete })
            if (only.complete) setComfyReady(true)
            // Persist the auto-pick so process.rs uses it on start_comfyui.
            //
            // Level (b): the user finds out, the wizard carries on. Nobody
            // clicked anything here — the single install was auto-picked — but
            // if the path does not stick, the panel above says "found" while
            // start_comfyui will look somewhere else entirely, and the failure
            // then surfaces minutes later with no visible cause.
            try {
              await backendCall('set_comfyui_path', { path: only.path })
            } catch (e) {
              comfyDo({ type: 'warn', error: withDetail(
                `LU found ComfyUI at ${only.path} but could not save that location. Starting it may not work; set the path by hand below.`,
                e,
              ) })
            }
            return
          }
          // Zero matches — fall back to legacy find_comfyui (env var, config
          // file overrides that aren't on the scan list).
          const legacy = await backendCall<{ found: boolean; path?: string; complete?: boolean }>('find_comfyui')
          setComfyFound(legacy)
          if (legacy.found && legacy.complete !== false) setComfyReady(true)
        })
        .catch(async () => {
          // Older builds without detect_all_comfyui_installs — degrade
          // gracefully to the previous single-pick API.
          try {
            const legacy = await backendCall<{ found: boolean; path?: string; complete?: boolean }>('find_comfyui')
            setComfyFound(legacy)
            if (legacy.found && legacy.complete !== false) setComfyReady(true)
          } catch {
            setComfyFound({ found: false, complete: false })
          }
        })
        .finally(() => setComfyDetecting(false))
    }
    // `comfyDo` ist der Dispatch eines `useReducer` und hat eine stabile
    // Identitaet — er steht hier, weil die Regel ihn sehen will, und er kann
    // den Effekt nicht nachtriggern.
  }, [step, comfyDo])

  // Pick one of the multiple installs from the disambiguation dialog. The
  // chosen path is persisted via set_comfyui_path so start_comfyui hits it
  // without further user intervention.
  const pickComfyInstall = async (choice: ComfyInstallChoice) => {
    // Level (c): the user picked one of several installs and this call is the
    // whole point of that click — without it the pick is not recorded anywhere
    // and start_comfyui keeps using the old one. The lines below close the
    // dialog and report "found", so a swallowed failure here leaves the wizard
    // confidently showing a choice that was never made.
    comfyDo({ type: 'warn', error: '' })
    try {
      await backendCall('set_comfyui_path', { path: choice.path })
    } catch (e) {
      comfyDo({ type: 'warn', error: withDetail(
        `Could not switch ComfyUI to ${choice.path}. LU will keep using the location it had — try the pick again, or enter the path by hand below.`,
        e,
      ) })
      return
    }
    setComfyFound({ found: true, path: choice.path, complete: choice.complete })
    if (choice.complete) setComfyReady(true)
    setComfyChoices([])
  }

  // P14 pre-flight: ensure Python is on the box before triggering ComfyUI's
  // pip install. On fresh Windows, `python` is the Microsoft Store stub
  // and pip silently exit-1's, leaving a carcass on disk and a
  // "not responding" message in the UI. Returns true once Python is ready.
  // If Python is already installed, this is a no-op single round trip.
  const ensurePythonInstalled = async (): Promise<boolean> => {
    try {
      const probe = await backendCall<{ available: boolean; path?: string | null }>('python_check')
      if (probe?.available) return true
    } catch {
      // Treat as "not available" and continue to install.
    }

    pythonDo({ type: 'start', at: Date.now(), log: 'Installing Python 3.12 via winget…' })

    try {
      await backendCall('install_python')
    } catch (err) {
      pythonDo({ type: 'fail', error: err instanceof Error ? err.message : 'Python install failed to start' })
      return false
    }

    return await new Promise<boolean>((resolve) => {
      const poll = setInterval(async () => {
        try {
          const status = await backendCall<InstallerStatusResponse>('install_python_status')
          pythonDo({ type: 'progress', status: status.status, logs: status.logs || [] })
          if (status.status === 'complete' || status.status === 'already_installed') {
            clearInterval(poll)
            pythonDo({ type: 'ready' })
            resolve(true)
          } else if (status.status === 'error') {
            clearInterval(poll)
            pythonDo({ type: 'fail', error: withInstallerOutput('Installing Python did not finish.', lastLog(status.logs)) })
            resolve(false)
          }
        } catch { /* keep polling */ }
      }, 2000)
    })
  }

  // Die Platzwarnung kommt als Logzeile mit fuehrendem Warndreieck aus
  // comfy_install.rs. Das Zeichen ist die Markierung IM Protokoll, nicht Teil
  // des Satzes. Hier wird es abgeschnitten, damit die Zeile ein Symbol traegt
  // und nicht zwei. Der Ton ist `fehler`, weil unter 5 GB frei die
  // Installation nicht durchlaeuft und jemand Platz schaffen muss.
  const diskPressure = comfyInstall.logs.find(l => l.startsWith('⚠'))?.replace(/^⚠\s*/, '')

  return (
    <>
      {/* D-S39: hier stand ein nackter 13,8px-Punkt in `bg-purple-400`
          — im Screenshot des Audits nicht von einem fehlgeschlagenen
          Icon-Load zu unterscheiden. Jetzt das Zeichen, um das es auf
          diesem Schritt geht, auf der Leiterstufe ICON_LG (20px, siehe
          ui/icon-size.ts) in einer weichen Akzentflaeche — dieselbe
          Behandlung, die `Loader2` zwei Zeilen weiter unten bekommt. */}
      <div className="mx-auto w-9 h-9 rounded-full bg-lu-accent-soft flex items-center justify-center">
        <ImageIcon size={ICON_LG} className="text-lu-accent" />
      </div>
      <h2 className="text-base font-semibold">Image & Video Generation</h2>
      <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        Generate images and videos right from the app. We'll set everything up for you.
      </p>

      {/* Auto-detecting */}
      {comfyDetecting && (
        <div className="flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin text-gray-400" />
          <span className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Looking for ComfyUI...</span>
        </div>
      )}

      {/* Bug #3: multi-install picker. When the scan found more than
          one ComfyUI directory, LU asks the user explicitly rather
          than guessing. Each option shows whether it's complete and
          whether it ships its own python_embeded — both matter for
          start_comfyui's launcher decision. */}
      {!comfyDetecting && comfyChoices.length > 1 && !comfyFound && (
        <div className="space-y-2 text-left">
          {/* Hier stand ein gelber Kasten mit Rahmen und 10px Polster. Auf dem
              ersten Bildschirm nach der Installation liest sich das wie ein
              Defekt, dabei ist es eine Frage: es gibt mehrere Ordner, welcher
              soll es sein. Jetzt eine Ueberschrift und eine ruhige Zeile
              darunter, ohne Flaeche. Begruendung in lib/hinweis.ts. */}
          <div className="space-y-0.5">
            <p className="text-[0.7rem] font-medium">
              Multiple ComfyUI installs detected
            </p>
            <Hinweis>
              Pick the one you want LU to use. We'll remember your choice, and you can change it later in Settings → ComfyUI.
            </Hinweis>
          </div>
          <div className="space-y-1.5 max-h-44 overflow-y-auto">
            {comfyChoices.map((c) => (
              <button
                key={c.path}
                onClick={() => pickComfyInstall(c)}
                className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                  isDark ? 'border-white/[0.08] hover:bg-white/[0.04]' : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[0.65rem] font-mono truncate ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{c.path}</span>
                  {/* „needs setup" war gelb und stand damit neben „ready" wie
                      ein halber Defekt. Es ist ein ruhiger Zustand: dieser
                      Ordner ist da, nur noch nicht fertig. Grau, dieselbe
                      Entscheidung wie PUNKT_FARBE.aus in lib/hinweis.ts. */}
                  <span className={`text-[0.5rem] px-1.5 py-[1px] rounded shrink-0 ${
                    c.complete
                      ? (isDark ? 'bg-green-500/15 text-green-400' : 'bg-green-100 text-green-700')
                      : (isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-100 text-gray-600')
                  }`}>
                    {c.complete ? 'ready' : 'needs setup'}
                  </span>
                </div>
                <div className={`flex items-center gap-2 mt-0.5 text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                  <span>found via {c.source}</span>
                  {c.has_embedded_python && (
                    <span className={isDark ? 'text-blue-300' : 'text-blue-600'}>• bundles python_embeded</span>
                  )}
                </div>
              </button>
            ))}
          </div>
          <button
            onClick={() => { setComfyChoices([]); setComfyFound({ found: false, complete: false }) }}
            className={`text-[0.55rem] ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'} underline`}
          >
            None of these, let me install a fresh one
          </button>
        </div>
      )}

      {/* Found AND complete (a working install). The carcass case
          is handled in the install-options block below. */}
      {comfyFound?.found && comfyFound.complete !== false && !isRunning(comfyInstall) && (
        <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
          <div className="flex items-center gap-2 justify-center">
            <Check size={14} className="text-green-400" />
            <span className="text-[0.7rem] font-medium">ComfyUI detected</span>
          </div>
          <p className={`text-[0.55rem] font-mono mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{comfyFound.path}</p>
        </div>
      )}

      {/* Not found OR found-but-incomplete — install options.
          P14: a found-but-incomplete dir is the ComfyUI carcass case;
          the same install button restarts the flow (Python pre-flight
          + git pull + pip install). */}
      {comfyFound && (!comfyFound.found || comfyFound.complete === false) && !isRunning(comfyInstall) && !isRunning(pythonInstall) && !comfyReady && (
        <div className="space-y-2">
          {/* Auch das war ein gelber Kasten. Der Satz sagt, was da liegt und
              welcher Knopf es zu Ende bringt. Er informiert, also ruhig und
              ohne Flaeche. */}
          {comfyFound.found && comfyFound.complete === false && (
            <Hinweis className="text-left">
              Found a previous ComfyUI install at <code className="font-mono">{comfyFound.path}</code> but it's missing PyTorch, looks like a previous install was interrupted. Click below to finish it.
            </Hinweis>
          )}
          <button
            onClick={async () => {
              // P14 pre-flight, install Python first if missing,
              // then proceed with the original ComfyUI flow. Both
              // progress cards animate from this single click; the
              // user never has to interact mid-flight.
              const pythonOk = await ensurePythonInstalled()
              if (!pythonOk) return

              comfyDo({ type: 'start', at: Date.now(), log: 'Starting ComfyUI installation...' })
              try {
                await backendCall('install_comfyui')
                // Poll installation status
                const poll = setInterval(async () => {
                  try {
                    const status = await backendCall<InstallerStatusResponse>('install_comfyui_status')
                    comfyDo({
                      type: 'progress',
                      status: status.status,
                      logs: status.logs || [],
                      received: status.download_progress || 0,
                      total: status.download_total || 0,
                      speed: status.download_speed || 0,
                    })
                    if (status.status === 'complete' || status.status === 'done') {
                      clearInterval(poll)
                      comfyDo({ type: 'ready' })
                      setComfyReady(true)
                      // Auto-start ComfyUI.
                      //
                      // Level (b): the install DID finish, which is what
                      // this step was for, so the wizard moves on to its
                      // ready state either way. But "ready" would then be
                      // claiming something that is not running, so say so.
                      try {
                        await backendCall('start_comfyui')
                      } catch (e) {
                        // `warn`, nicht `fail`: die Installation IST
                        // durch — nur der Start danach nicht.
                        comfyDo({ type: 'warn', error: withDetail(
                          'ComfyUI is installed but did not start. You can start it from Settings → ComfyUI later; the rest of the setup is unaffected.',
                          e,
                        ) })
                      }
                    } else if (status.status === 'cancelled') {
                      // Bug #1: install cancelled by user, close the
                      // progress card and surface the install options
                      // again so they can retry or pick another drive.
                      clearInterval(poll)
                      comfyDo({ type: 'fail', error: 'Install cancelled.' })
                    } else if (status.status === 'error') {
                      clearInterval(poll)
                      comfyDo({ type: 'fail', error: withInstallerOutput('Installing ComfyUI did not finish.', lastLog(status.logs)) })
                    }
                  } catch { /* keep polling */ }
                }, 2000)
              } catch (err) {
                comfyDo({ type: 'fail', error: err instanceof Error ? err.message : 'Installation failed' })
              }
            }}
            className="lu-primary w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[0.7rem] transition-all"
          >
            <Download size={14} /> Install ComfyUI (Recommended)
          </button>
          <button
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'text'
              // Show path input inline
              setComfyPathInput('')
              setComfyFound({ found: false })
            }}
            // D-S39, zweite Haelfte („vier Buttons in vier Behandlungen"):
            // dieser Knopf trug die Sekundaerbehandlung und stellte seine
            // Geometrie daneben per `style` wieder um — Breite und Ausrichtung
            // kamen aus einem Inline-Stil, waehrend sein Nachbar
            // („Install ComfyUI") genau dasselbe mit `w-full` und
            // `justify-center` sagt. Ein Knopf, dessen Form aus einer zweiten
            // Quelle kommt, ist eine eigene Behandlung, auch wenn er zufaellig
            // gleich aussieht. Jetzt dieselbe Vokabel wie der Nachbar, nur in
            // der leisen Rolle — er ist die Nebenaktion und bleibt es.
            className={`${secondaryBtn} w-full justify-center`}
          >
            <FolderOpen size={14} /> I already have ComfyUI
          </button>

          {/* Manual path input */}
          {comfyPathInput !== undefined && (
            <div className="flex gap-1.5">
              <input
                type="text"
                value={comfyPathInput}
                onChange={e => setComfyPathInput(e.target.value)}
                placeholder="C:\ComfyUI"
                className={`flex-1 px-2 py-1.5 rounded-lg border text-[0.65rem] font-mono ${
                  isDark ? 'bg-black border-white/10 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              />
              <button
                onClick={async () => {
                  if (!comfyPathInput.trim()) return
                  try {
                    await backendCall('set_comfyui_path', { path: comfyPathInput.trim() })
                    setComfyReady(true)
                    // Level (b): the path — the thing the user typed —
                    // was saved, so this stays out of the outer catch and
                    // `ready` stands. Only the convenience auto-start
                    // failed, and that is worth one line rather than
                    // undoing a save that worked.
                    try {
                      await backendCall('start_comfyui')
                    } catch (e) {
                      comfyDo({ type: 'warn', error: withDetail(
                        'The path was saved, but ComfyUI did not start from it. Check that the folder holds a complete ComfyUI install, then start it from Settings → ComfyUI.',
                        e,
                      ) })
                    }
                  } catch (err) {
                    comfyDo({ type: 'warn', error: err instanceof Error ? err.message : 'Invalid path' })
                  }
                }}
                className={primaryBtn}
              >
                Connect
              </button>
            </div>
          )}
        </div>
      )}

      {/* P14: Python install progress card. Animates while winget
          pulls Python.Python.3.12 (~30 MB) and runs the silent
          installer. Sits ABOVE the ComfyUI install card so the user
          can see the dependency chain (Python → ComfyUI) when both
          run back-to-back from a single click. */}
      {isRunning(pythonInstall) && (
        <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-purple-400" />
              <span className="text-[0.7rem] font-medium">Installing Python 3.12...</span>
            </div>
            <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              {formatElapsed(secondsOf(pythonInstall.startedAt))}
            </span>
          </div>
          <p className={`text-[0.55rem] mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            ComfyUI needs Python to run pip. We're installing it via winget, about 30 MB and 30 to 60 s on a typical connection.
          </p>
          <div className={`text-[0.55rem] font-mono max-h-24 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {pythonInstall.logs.slice(-6).map((log, i) => (
              <p key={i}>{log}</p>
            ))}
          </div>
        </div>
      )}
      {pythonInstall.error && !isRunning(pythonInstall) && (
        <Hinweis ton="fehler" className="whitespace-pre-line">{pythonInstall.error}</Hinweis>
      )}

      {/* Installing progress */}
      {isRunning(comfyInstall) && (
        <div className={`p-3 rounded-lg border ${cardClass} text-left`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-purple-400" />
              <span className="text-[0.7rem] font-medium">
                {comfyInstall.logs.some(l => l.toLowerCase().includes('cancel')) ? 'Cancelling ComfyUI install…' : 'Installing ComfyUI...'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-[0.55rem] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {formatElapsed(secondsOf(comfyInstall.startedAt))}
                {/* Bug #1: rolling ETA from download bytes when known. */}
                {comfyInstall.speed > 0 && comfyInstall.total > 0 && comfyInstall.received < comfyInstall.total && (() => {
                  const remaining = comfyInstall.total - comfyInstall.received
                  const etaSec = Math.round(remaining / Math.max(1, comfyInstall.speed))
                  const m = Math.floor(etaSec / 60)
                  const s = etaSec % 60
                  return ` • ETA ${m}:${String(s).padStart(2, '0')}`
                })()}
              </span>
              {/* Cancel button (Bug #1 — techx69) */}
              <button
                onClick={async () => {
                  // Level (c): Cancel is the only way out of a multi-GB
                  // download. If the call fails the progress bar keeps
                  // filling and the button looks broken — and the user is
                  // still paying for the bandwidth.
                  comfyDo({ type: 'warn', error: '' })
                  try {
                    await backendCall('cancel_comfyui_install')
                  } catch (e) {
                    comfyDo({ type: 'warn', error: withDetail(
                      'The install could not be cancelled and is still running. Try Cancel once more; if it keeps going, closing LU stops the download.',
                      e,
                    ) })
                  }
                }}
                // D-S39, zweite Haelfte: die vierte Behandlung. Dieser Knopf
                // hatte sein eigenes Rezept — 8,8px Schrift, 1px senkrechtes
                // Polster, eigener Radius, rote Kante — und war damit weder
                // primaer noch sekundaer, sondern ein Einzelstueck mit einer
                // Trefferflaeche von rund elf Pixeln Hoehe.
                //
                // Er traegt jetzt `.lu-control` aus index.css, das neutrale
                // Rezept des Hauses, mit `data-active` fuer den sichtbaren
                // Behaelter. Das ist keine Erfindung fuer diesen Knopf,
                // sondern GENAU die Entscheidung, die dieses Haus fuer Stop
                // in der Prompt-Zeile schon getroffen und dort aufgeschrieben
                // hat: „Rot heisst in dieser App an rund hundert Stellen
                // kaputt oder wird geloescht". Abbrechen ist der normale
                // Ausgang aus einem laufenden Vorgang, nicht dessen Defekt —
                // dieselbe Rolle wie Stop, also dieselbe Behandlung.
                // Auffindbar bleibt er ueber den Behaelter, nicht ueber die
                // Fehlerfarbe, und er bekommt nebenbei die 26px des Hauses
                // statt seiner elf.
                data-active="true"
                className="lu-control"
                title="Cancel ComfyUI install"
              >
                Cancel
              </button>
            </div>
          </div>
          {/* Disk pressure warning (push from Rust side) */}
          {diskPressure && (
            <Hinweis ton="fehler" icon={<AlertTriangle size={11} className="mt-[1px] shrink-0" />} className="mb-2 text-left">
              {diskPressure}
            </Hinweis>
          )}
          {/* Download progress bar (shown during download phase) */}
          {comfyInstall.logs.some(l => l.includes('Downloading')) && comfyInstall.total > 0 && (
            <div className="space-y-1 mb-2">
              <ProgressBar progress={comfyInstall.total > 0 ? (comfyInstall.received / comfyInstall.total) * 100 : 0} />
              <div className="flex justify-between">
                <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {formatBytes(comfyInstall.received)} / {formatBytes(comfyInstall.total)}
                </span>
                <span className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {comfyInstall.speed > 0 ? `${formatBytes(comfyInstall.speed)}/s` : ''}
                </span>
              </div>
            </div>
          )}
          <div className={`text-[0.55rem] font-mono max-h-24 overflow-y-auto space-y-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {comfyInstall.logs.slice(-8).map((log, i) => (
              <p key={i}>{log}</p>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {comfyInstall.error && (
        <Hinweis ton="fehler" className="whitespace-pre-line">{comfyInstall.error}</Hinweis>
      )}

      {/* Ready state */}
      {comfyReady && (
        <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
          <div className="flex items-center gap-2 justify-center">
            <Check size={14} className="text-green-400" />
            <span className="text-[0.7rem] font-medium">ComfyUI is ready</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-center gap-2 pt-1">
        {/* Continue only when ComfyUI is actually usable. A
            found-but-incomplete carcass shouldn't qualify — that
            install will fail at first generation. */}
        {((comfyFound?.found && comfyFound.complete !== false) || comfyReady) && (
          <button
            onClick={() => setStep('models')}
            className={primaryBtn}
          >
            Continue <ArrowRight size={14} />
          </button>
        )}
        {!isRunning(comfyInstall) && !isRunning(pythonInstall) && (!comfyFound?.found || comfyFound.complete === false) && !comfyReady && (
          <>
            <button
              onClick={() => {
                setComfyDetecting(true)
                setComfyFound(null)
                backendCall<{ found: boolean; path?: string; complete?: boolean }>('find_comfyui')
                  .then(result => { setComfyFound(result); if (result.found && result.complete !== false) setComfyReady(true) })
                  .catch(() => setComfyFound({ found: false, complete: false }))
                  .finally(() => setComfyDetecting(false))
              }}
              className={secondaryBtn}
            >
              <RefreshCw size={12} /> Re-Scan
            </button>
            <button
              onClick={() => setStep('models')}
              className={`${secondaryBtn} opacity-60`}
            >
              Skip for now <ChevronRight size={12} />
            </button>
          </>
        )}
      </div>
    </>
  )
}
