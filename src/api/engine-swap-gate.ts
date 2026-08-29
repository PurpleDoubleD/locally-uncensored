/**
 * One traffic light for the single built-in engine process.
 *
 * WHAT WENT WRONG (counter-check round 2, installed Windows build,
 * 2026-08-29). Two quick model switches followed by an immediate send put this
 * in the chat bubble:
 *
 *   Error: proxy_localhost_stream_chunked: error sending request for url
 *   (http://127.0.0.1:8127/v1/chat/completions)
 *
 * Timeline from the wire capture: the picker fired swap_bundled_model twice
 * (06:17:05 and 06:17:12), llama-server restarted three times in a row, and at
 * 06:17:32 the send went out into the gap where no process was listening. The
 * engine came up seven seconds later. The app shot at a hole it had dug
 * itself.
 *
 * The house rule is self-healing before an error message, so the send path
 * waits for a swap it can see instead of racing it. This module is what makes
 * the swap visible: `api/engine.ts` registers every start and swap, and
 * `builtin-ensure.ts` waits on it before probing engine health.
 *
 * State lives on globalThis for the same reason agent-context.ts parks its
 * state there: the bundler duplicates small modules, and two copies of this
 * gate would each see an idle engine.
 */

/** How long a send waits for a swap before giving up on it and probing anyway.
 *  A large GGUF on a slow disk takes tens of seconds; past that something is
 *  wrong and the caller is better served by its own health check, which knows
 *  how to say so in English. */
export const ENGINE_SWAP_WAIT_MS = 90_000

const KEY = '__lu_engine_swap_gate__'

interface Gate { current?: Promise<unknown> }

function gate(): Gate {
  const g = globalThis as unknown as Record<string, Gate>
  if (!g[KEY]) g[KEY] = {}
  return g[KEY]
}

/** Test-only: forget any tracked swap. */
export function __resetEngineSwapGateForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[KEY]
}

/** True while a start or swap this app issued is still running. */
export function engineSwapInFlight(): boolean {
  return gate().current !== undefined
}

/**
 * Register an engine start/swap and hand the caller its own promise back
 * unchanged, so error handling at the call site is untouched. The gate holds a
 * failure-proof view of it: a rejected swap clears the light instead of
 * wedging every later send.
 */
export function trackEngineSwap<T>(p: Promise<T>): Promise<T> {
  const g = gate()
  const quiet = p.then(
    () => undefined,
    () => undefined,
  )
  g.current = quiet
  void quiet.then(() => {
    if (g.current === quiet) g.current = undefined
  })
  return p
}

/**
 * Wait for a swap that is already running.
 *
 * 'idle' when there was nothing to wait for, 'settled' when the swap finished
 * (well or badly, the caller re-probes either way), 'timeout' when it outlasted
 * the deadline. Never throws and never rejects: the caller's next step is a
 * health check, and that is what decides what the user is told.
 */
export async function waitForEngineSwap(
  timeoutMs: number = ENGINE_SWAP_WAIT_MS,
): Promise<'idle' | 'settled' | 'timeout'> {
  const current = gate().current
  if (!current) return 'idle'
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    return await Promise.race([current.then(() => 'settled' as const), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
