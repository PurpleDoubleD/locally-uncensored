// A13, Windows counter-check 2026-09-02: "wer waehrend des Repairs den
// Einstellungsbereich wechselt, verliert den Fortschrittstext; beim
// Zurueckkommen steht dort nichts mehr, obwohl pip weiterlaeuft".
//
// The run itself was never the problem. It lives in Rust, and the poll is a
// plain setInterval that no unmount ever touched. What died was the STATE: the
// phase, the log lines and the download counters sat in useState inside the
// ComfyUI panel, so switching to Providers and back left a panel that knew
// nothing while a two gigabyte PyTorch download kept going.
//
// So the state moves here, next to the timer that feeds it. Runtime only, on
// purpose: an install that is over when the app restarts must not come back as
// a ghost on the next start, which is exactly what persisting it would do.

import { create } from 'zustand'
import { backendCall } from '../api/backend'
import { withInstallerOutput } from '../lib/error-text'
// Every run below reaches Rust through `backendCall`, which hands an invoke()
// rejection straight on. A Rust `Err(String)` therefore arrives as a plain
// STRING, not as an Error, so the old `err instanceof Error ? err.message : ...`
// took the fallback every single time and the user read "Failed to start" while
// the reason, "winget is not installed on this system", was in hand
// (counter-check 2026-09-04). `errorText` reads a string, an Error and a
// `{ message }` alike.
import { errorText } from '../types/json-guards'

/** Which card the panel draws. `checking` is the Python probe, `python` the
 *  winget install that only some boxes need. */
export type ComfyInstallPhase = 'idle' | 'checking' | 'python' | 'comfyui' | 'repair' | 'error'

/** Which long run is in flight. Install and update share the `comfyui` phase,
 *  and they need different sentences when they end. */
export type ComfyInstallKind = 'install' | 'update' | 'repair'

/** How a closing line reads. 'warn' is amber, 'ok' is not. A15 review: the
 *  panel painted every closing line amber, so "Repair finished. ComfyUI is
 *  ready." arrived in the colour of a warning. */
export type ComfyNoticeKind = 'ok' | 'warn'

/** What the user is told once a cancelled run has really stopped. A cancel
 *  that leaves the panel blank reads as "nothing happened", and after a repair
 *  that is a lie: the venv is half rebuilt at that point. */
export const COMFY_CANCEL_NOTICE: Record<ComfyInstallKind, string> = {
  install: 'Install cancelled. ComfyUI is not set up yet, you can start the install again at any time.',
  update: 'Update cancelled. ComfyUI may be updated only in part, so run Update ComfyUI again to finish it.',
  repair: 'Repair cancelled. The environment is only half rebuilt, so run Repair environment again before you start ComfyUI.',
}

/** Headline of the failure text per run. The installer's own last log line is
 *  appended to it, which is where the actual pip or git error shows up. */
const FAILED: Record<ComfyInstallKind, string> = {
  install: 'Installing ComfyUI did not finish.',
  update: 'Updating ComfyUI did not finish.',
  repair: 'Repairing the environment did not finish.',
}

const POLL_MS = 2000

/** How many status reads in a row may fail before the poll gives up.
 *
 *  Review 2026-09-02: every failure was swallowed and retried forever, so a
 *  status channel that stopped answering for good left a spinner turning with
 *  no end and no word. Thirty ticks is a minute of silence, long enough to sit
 *  out a busy box and short enough that nobody watches a dead spinner. */
const MAX_POLL_MISSES = 30

/** What the panel says when the installer stopped answering. */
export const LOST_CONTACT = 'Lost contact with the installer. Check the log and try again.'

/** The same for the winget step that runs before it. */
export const LOST_CONTACT_PYTHON = 'Lost contact with the Python installer. Check the log and try again.'

/** True while the ComfyUI section has something the user must not miss: a run
 *  in flight, a failure nobody has dismissed yet, or the closing line a run
 *  left behind.
 *
 *  A15, Windows Nachlauf 02.09.: the section is an ordinary accordion, so a
 *  trip to General and back folded it up again while a twenty minute repair was
 *  still running. The progress itself survives the remount (that is what this
 *  store is for), but it survives behind a closed lid, and a user who does not
 *  think to open it sees an app that looks idle.
 *
 *  Review 03.09.: the first cut asked about the phase alone, and the panel
 *  renders the closing line only while the phase is idle. So the one state the
 *  line exists in was the one state that folded the section shut, and the
 *  result of a run that had just taken eight minutes was gone on the next
 *  section switch. Both halves are asked about now. */
export function comfySectionShouldOpen(
  run: { phase: ComfyInstallPhase; notice: string },
): boolean {
  return run.phase !== 'idle' || run.notice !== ''
}

/** The one poll in flight, module level so it outlives every mount. */
let timer: ReturnType<typeof setInterval> | null = null

/** Which poll is the current one. A status read that was already in flight
 *  when the poll was stopped still resolves afterwards, and without this it
 *  would write its answer into a run that is over: a dismissed failure coming
 *  back by itself, or a fresh run wearing the old one's log lines. Every tick
 *  carries the generation it was born in and drops out when that is no longer
 *  the current one. */
let generation = 0

function stopTimer() {
  generation++
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** True while a poll is running. Tests read this to prove the loop is not tied
 *  to a component. */
export function comfyInstallPolling(): boolean {
  return timer !== null
}

interface InstallStatusPayload {
  status?: string
  logs?: string[]
  /** One closing line the backend wants kept after the run. A15, Windows
   *  Nachlauf 02.09.: a ComfyUI requirements.txt pip cannot install is skipped
   *  and the run finishes on the packages LU knows about, which used to end in
   *  a green idle panel that said nothing about the file it passed over. */
  notice?: string
  /** How that line reads: 'ok' for a run that simply worked, 'warn' for one
   *  that finished with something the user has to know. */
  notice_kind?: string
  download_progress?: number
  download_total?: number
  download_speed?: number
}

interface ComfyInstallState {
  phase: ComfyInstallPhase
  kind: ComfyInstallKind | null
  logs: string[]
  dl: { progress: number; total: number; speed: number }
  error: string
  /** Cancel requested, run not stopped yet. */
  cancelling: boolean
  /** The one line a finished or cancelled run leaves behind. */
  notice: string
  /** Whether that line is good news or not, which decides its colour. */
  noticeKind: ComfyNoticeKind
  /** Put the closing line away. Review 03.09.: nothing ever cleared it, so a
   *  single finished run kept the section unfolding itself on every visit for
   *  the rest of the session. */
  clearNotice: () => void
  /** Install ComfyUI, installing Python first when the box has none. */
  runInstall: (installPath: string) => Promise<void>
  /** git pull plus a dependency refresh on an existing checkout. */
  runUpdate: () => Promise<void>
  /** Rebuild the venv from scratch. */
  runRepair: () => Promise<void>
  /** Ask Rust to stop whatever is running. */
  cancel: () => Promise<void>
  /** Back to a clean panel. Used by tests and by a fresh start. */
  reset: () => void
}

const IDLE = {
  phase: 'idle' as ComfyInstallPhase,
  kind: null,
  logs: [] as string[],
  dl: { progress: 0, total: 0, speed: 0 },
  error: '',
  cancelling: false,
  notice: '',
  noticeKind: 'ok' as ComfyNoticeKind,
}

export const useComfyInstallStore = create<ComfyInstallState>()((set, get) => {
  /** Poll `install_comfyui_status` until the run reaches a terminal state.
   *  Complete, cancelled and failed are three different answers, and the panel
   *  says which one it was. */
  const watch = (kind: ComfyInstallKind) => {
    stopTimer()
    const mine = generation
    let misses = 0
    timer = setInterval(async () => {
      if (generation !== mine) return
      let data: InstallStatusPayload
      try {
        data = (await backendCall<InstallStatusPayload>('install_comfyui_status')) ?? {}
      } catch {
        if (generation !== mine) return
        // Transient, the next tick asks again. Not transient any more once it
        // has been a minute of nothing.
        if (++misses >= MAX_POLL_MISSES) {
          stopTimer()
          set({ phase: 'error', cancelling: false, error: LOST_CONTACT })
        }
        return
      }
      // The answer took a while; the run it belongs to may be over by now.
      if (generation !== mine) return
      misses = 0
      set({
        logs: data.logs ?? [],
        dl: {
          progress: data.download_progress || 0,
          total: data.download_total || 0,
          speed: data.download_speed || 0,
        },
      })
      if (data.status === 'complete') {
        stopTimer()
        set({
          phase: 'idle',
          kind: null,
          cancelling: false,
          notice: String(data.notice ?? ''),
          noticeKind: data.notice_kind === 'warn' ? 'warn' : 'ok',
        })
      } else if (data.status === 'cancelled') {
        // A cancel the user asked for is not a failure.
        stopTimer()
        set({
          phase: 'idle',
          kind: null,
          cancelling: false,
          notice: COMFY_CANCEL_NOTICE[kind],
          // A half rebuilt venv is not good news, whoever asked for it.
          noticeKind: 'warn',
        })
      } else if (data.status === 'error') {
        stopTimer()
        const lastLog = data.logs?.length ? String(data.logs[data.logs.length - 1]) : ''
        set({ phase: 'error', cancelling: false, error: withInstallerOutput(FAILED[kind], lastLog) })
      }
    }, POLL_MS)
  }

  const begin = (phase: ComfyInstallPhase, kind: ComfyInstallKind, firstLog: string) => {
    stopTimer()
    set({ ...IDLE, phase, kind, logs: firstLog ? [firstLog] : [] })
  }

  const fail = (message: string) => {
    stopTimer()
    set({ phase: 'error', cancelling: false, error: message })
  }

  return {
    ...IDLE,

    runInstall: async (installPath: string) => {
      // Pre-flight: pip needs a Python before ComfyUI can be installed. The
      // carcass case lands here too, the previous run may have died on the
      // Microsoft Store stub.
      //
      // Review 2026-09-02: the phase used to jump to `python` before the probe
      // had answered, so a box that has Python flashed "Installing Python 3.12
      // (~30 MB)" for an install that never happened. The probe gets its own
      // neutral phase and `python` now means what it says.
      begin('checking', 'install', '')
      let pythonOk = false
      try {
        const probe = await backendCall<{ available?: boolean }>('python_check')
        pythonOk = !!probe?.available
      } catch {
        pythonOk = false
      }
      if (!pythonOk) {
        set({ phase: 'python', logs: ['Installing Python 3.12 via winget…'] })
        try {
          await backendCall('install_python')
        } catch (err) {
          fail(errorText(err) || 'Could not start Python install')
          return
        }
        pythonOk = await new Promise<boolean>((resolve) => {
          stopTimer()
          const mine = generation
          let misses = 0
          timer = setInterval(async () => {
            // A run that was reset or replaced does not get to answer any
            // more, but the promise must still settle or runInstall hangs.
            if (generation !== mine) { resolve(false); return }
            let data: InstallStatusPayload
            try {
              data = (await backendCall<InstallStatusPayload>('install_python_status')) ?? {}
            } catch {
              if (generation !== mine) { resolve(false); return }
              // Review 2026-09-02: without this the promise never settled. A
              // Python status channel that stopped answering left runInstall
              // waiting for ever in phase `python`, with no Cancel, no Dismiss
              // and no buttons. It resolves false rather than rejecting, since
              // the caller is a fire-and-forget click and a rejection here
              // would only become an unhandled one.
              if (++misses >= MAX_POLL_MISSES) {
                stopTimer()
                set({ error: LOST_CONTACT_PYTHON })
                resolve(false)
              }
              return
            }
            if (generation !== mine) { resolve(false); return }
            misses = 0
            set({ logs: data.logs ?? [] })
            if (data.status === 'complete' || data.status === 'already_installed') {
              stopTimer()
              resolve(true)
            } else if (data.status === 'error') {
              stopTimer()
              const lastLog = data.logs?.length ? String(data.logs[data.logs.length - 1]) : ''
              set({ error: withInstallerOutput('Installing Python did not finish.', lastLog) })
              resolve(false)
            }
          }, POLL_MS)
        })
        if (!pythonOk) {
          set({ phase: 'error', cancelling: false })
          return
        }
      }
      set({ phase: 'comfyui', logs: ['Installing ComfyUI…'] })
      try {
        await backendCall('install_comfyui', installPath ? { installPath } : {})
      } catch (err) {
        fail(errorText(err) || 'Failed to start')
        return
      }
      watch('install')
    },

    runUpdate: async () => {
      begin('comfyui', 'update', 'Updating ComfyUI…')
      try {
        await backendCall('update_comfyui')
      } catch (err) {
        fail(errorText(err) || 'Failed to start the update')
        return
      }
      watch('update')
    },

    runRepair: async () => {
      begin('repair', 'repair', 'Repairing the ComfyUI environment…')
      try {
        await backendCall('repair_comfyui_env')
      } catch (err) {
        fail(errorText(err) || 'Failed to start the repair')
        return
      }
      watch('repair')
    },

    // Rust checks the same flag in every step of the installer and of the
    // repair, so the run stops at the next step boundary. Until it does, the
    // panel says it is cancelling instead of pretending the click did nothing.
    cancel: async () => {
      if (get().cancelling) return
      set({ cancelling: true })
      try {
        await backendCall('cancel_comfyui_install')
      } catch (err) {
        // The flag is the only thing that can stop the run. If setting it
        // failed, a button stuck on "Cancelling…" would be the second lie.
        set({ cancelling: false, error: errorText(err) || 'Could not cancel the run' })
      }
    },

    clearNotice: () => set({ notice: '', noticeKind: 'ok' }),

    reset: () => {
      stopTimer()
      set({ ...IDLE })
    },
  }
})
