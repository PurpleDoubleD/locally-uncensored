/**
 * Start ComfyUI again when a render finds it gone.
 *
 * R16 Befund 5, measured on the Windows box (2026-08-30): ComfyUI was killed
 * while the app kept running. Every press of Create then answered "ComfyUI is
 * not running. Wait for it to start." and nothing ever started it. Ten minutes
 * later port 8188 was still shut. The sentence was not just unhelpful, it was
 * untrue: nobody was going to start it. The app boots ComfyUI itself at launch
 * (process.rs::auto_start_comfyui), and that is the one and only moment it
 * ever did, so a ComfyUI that dies later stays dead for the rest of the
 * session.
 *
 * House rule, self healing before an error message: if LU started it, LU can
 * start it again. The rules this file follows:
 *
 *   - Only a ComfyUI LU could have started is restarted. A remote host and a
 *     missing or half installed local one are somebody else's to fix, and
 *     saying so beats pretending to work on it.
 *   - A start that is already under way is waited out, never doubled. Two
 *     ComfyUI processes on one port is a worse state than none.
 *   - Attempts are bounded and spaced. A ComfyUI that crashes on boot must not
 *     turn one click into an endless restart loop.
 *   - Every state has its own words, and every one of them says what is
 *     happening or what the user has to do. No line promises an actor that
 *     does not exist.
 */

/** The fields of `comfyui_status` this guard reads. */
export interface ComfyGuardStatus {
  /** The port answers. */
  running?: boolean
  /** A process is alive but has not bound the port yet. */
  starting?: boolean
  /** The configured host is this machine. A remote ComfyUI is not ours. */
  isLocal?: boolean
  /** An install was found on disk. */
  found?: boolean
  /** That install is usable (torch reachable), not a carcass. */
  complete?: boolean
}

/** How the guard left things. Every one of them is an answer, not a shrug. */
export type ComfyGuardOutcome =
  /** It was up, or it came up on its own while we watched. */
  | 'running'
  /** It was down, we started it, and the port answered. */
  | 'restarted'
  /** Not ours to start: a remote host, or no usable local install. */
  | 'unmanaged'
  /** Ours, we tried, and it did not come up. */
  | 'failed'

/** How many starts one click may cost. */
export const RESTART_ATTEMPTS = 3
/** Rounds of `RESTART_DELAY_MS` spent waiting for the port after each start. */
export const RESTART_ROUNDS = 30
export const RESTART_DELAY_MS = 2000
/** The pause before a second and third attempt. Index 0 is the first try. */
export const RESTART_BACKOFF_MS = [0, 3000, 10_000]

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Is this a ComfyUI LU is allowed to start.
 *
 * All three have to hold. `isLocal` false is a ComfyUI on another machine,
 * `found` false is nothing to start, and `complete` false is the carcass case
 * from GH #98, where starting it only produces the same crash again.
 */
export function comfyIsManaged(status: ComfyGuardStatus | null): boolean {
  if (!status) return false
  return status.isLocal === true && status.found === true && status.complete === true
}

/**
 * What to tell the user when the guard could not get ComfyUI up.
 *
 * Both lines name the next move. The unmanaged one does not claim LU is
 * working on it, because LU is not.
 */
export function comfyGuardMessage(outcome: 'unmanaged' | 'failed'): string {
  return outcome === 'unmanaged'
    ? 'ComfyUI is not running, and this one is not managed by LU. Start it yourself, or set it up under Settings, AI Backends.'
    : 'ComfyUI is not running and could not be restarted. See Settings, AI Backends for what it said on the way down.'
}

/** The line shown while the guard is working. Said once, so tests can hold it. */
export const RESTARTING_LINE = 'Restarting ComfyUI...'

/**
 * Make sure ComfyUI is up, starting it if it is ours and it is down.
 *
 * `probe` is the port check, `status` is `comfyui_status`, `start` is
 * `start_comfyui`. `onProgress` gets a line for every second of waiting, so a
 * minute of booting never looks frozen (the same reason CreateContext's
 * startAndAwait ticks its counter).
 */
export async function ensureComfyForRender(deps: {
  probe: () => Promise<boolean>
  status: () => Promise<ComfyGuardStatus | null>
  start: () => Promise<void>
  onProgress?: (line: string) => void
  wait?: (ms: number) => Promise<void>
  attempts?: number
  rounds?: number
  delayMs?: number
}): Promise<ComfyGuardOutcome> {
  const { probe, status, start } = deps
  const wait = deps.wait ?? sleep
  const attempts = deps.attempts ?? RESTART_ATTEMPTS
  const rounds = deps.rounds ?? RESTART_ROUNDS
  const delayMs = deps.delayMs ?? RESTART_DELAY_MS
  const say = deps.onProgress ?? (() => {})

  if (await probe().catch(() => false)) return 'running'

  const s = await status().catch(() => null)

  // Already on its way up, from the app's own boot or an earlier click. Wait
  // it out rather than starting a second process on the same port.
  if (s?.starting === true) {
    say(RESTARTING_LINE)
    for (let i = 0; i < rounds; i++) {
      await wait(delayMs)
      say(`${RESTARTING_LINE} ${(i + 1) * Math.round(delayMs / 1000)}s`)
      if (await probe().catch(() => false)) return 'running'
    }
    return 'failed'
  }

  if (!comfyIsManaged(s)) return 'unmanaged'

  for (let attempt = 0; attempt < attempts; attempt++) {
    const backoff = RESTART_BACKOFF_MS[attempt] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1]
    if (backoff > 0) await wait(backoff)
    say(RESTARTING_LINE)
    try {
      await start()
    } catch {
      // A start that will not even dispatch is not going to dispatch on the
      // next round either.
      return 'failed'
    }
    for (let i = 0; i < rounds; i++) {
      await wait(delayMs)
      say(`${RESTARTING_LINE} ${(i + 1) * Math.round(delayMs / 1000)}s`)
      if (await probe().catch(() => false)) return 'restarted'
    }
  }
  return 'failed'
}
