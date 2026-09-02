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

/** Which card the panel draws. `python` is the pre-flight winget step. */
export type ComfyInstallPhase = 'idle' | 'python' | 'comfyui' | 'repair' | 'error'

/** Which long run is in flight. Install and update share the `comfyui` phase,
 *  and they need different sentences when they end. */
export type ComfyInstallKind = 'install' | 'update' | 'repair'

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

/** The one poll in flight, module level so it outlives every mount. */
let timer: ReturnType<typeof setInterval> | null = null

function stopTimer() {
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
  /** The one line left behind after a cancelled run. */
  notice: string
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
}

export const useComfyInstallStore = create<ComfyInstallState>()((set, get) => {
  /** Poll `install_comfyui_status` until the run reaches a terminal state.
   *  Complete, cancelled and failed are three different answers, and the panel
   *  says which one it was. */
  const watch = (kind: ComfyInstallKind) => {
    stopTimer()
    timer = setInterval(async () => {
      let data: InstallStatusPayload
      try {
        data = (await backendCall<InstallStatusPayload>('install_comfyui_status')) ?? {}
      } catch {
        return // transient, the next tick asks again
      }
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
        set({ phase: 'idle', kind: null, cancelling: false })
      } else if (data.status === 'cancelled') {
        // A cancel the user asked for is not a failure.
        stopTimer()
        set({ phase: 'idle', kind: null, cancelling: false, notice: COMFY_CANCEL_NOTICE[kind] })
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
      begin('python', 'install', '')
      // Pre-flight: pip needs a Python before ComfyUI can be installed. The
      // carcass case lands here too, the previous run may have died on the
      // Microsoft Store stub.
      let pythonOk = false
      try {
        const probe = await backendCall<{ available?: boolean }>('python_check')
        pythonOk = !!probe?.available
      } catch {
        pythonOk = false
      }
      if (!pythonOk) {
        set({ logs: ['Installing Python 3.12 via winget…'] })
        try {
          await backendCall('install_python')
        } catch (err) {
          fail(err instanceof Error ? err.message : 'Could not start Python install')
          return
        }
        pythonOk = await new Promise<boolean>((resolve) => {
          stopTimer()
          timer = setInterval(async () => {
            let data: InstallStatusPayload
            try {
              data = (await backendCall<InstallStatusPayload>('install_python_status')) ?? {}
            } catch {
              return
            }
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
        fail(err instanceof Error ? err.message : 'Failed to start')
        return
      }
      watch('install')
    },

    runUpdate: async () => {
      begin('comfyui', 'update', 'Updating ComfyUI…')
      try {
        await backendCall('update_comfyui')
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Failed to start the update')
        return
      }
      watch('update')
    },

    runRepair: async () => {
      begin('repair', 'repair', 'Repairing the ComfyUI environment…')
      try {
        await backendCall('repair_comfyui_env')
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Failed to start the repair')
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
        set({ cancelling: false, error: err instanceof Error ? err.message : 'Could not cancel the run' })
      }
    },

    reset: () => {
      stopTimer()
      set({ ...IDLE })
    },
  }
})
