/**
 * How big a context the built-in engine gets when a swap restarts it.
 *
 * WHAT WENT WRONG (counter-check round 2, installed Windows build,
 * 2026-08-29). During a two-model group chat the header read "ctx 32K" and the
 * token counter "555/32.8k", while every `swap_bundled_model` of that same
 * round asked for `"ctx": 8192` and llama-server's /props confirmed 8192. The
 * user was shown four times the context that was actually loaded, and anybody
 * writing near the edge would silently lose history.
 *
 * WHERE THE 32K CAME FROM. `ensureBuiltinAgentCtx` had raised the engine for
 * an earlier agent turn (min of the GGUF's trained ctx and AGENT_CONTEXT_CAP).
 * The group round then went through `ensureBuiltinEngineAlive`, which restarts
 * with the RAW settings tuning, and the untouched default there is 8192. So
 * the swap did not merely fail to match the display: it handed context back
 * that the machine had already proved it could allocate, on every speaker
 * change.
 *
 * THE CHOICE. Of the two ways to end the lie, this is the one that helps the
 * user: the swap keeps what the engine already runs instead of the display
 * being talked down to 8192. It is also the cautious half of the pair, because
 * it never asks for more than this machine has already granted once, and never
 * more than the GGUF header states the model was trained for. Where the header
 * says nothing, nothing is raised (no RoPE extrapolation on a guess) and the
 * display re-read that `loadBuiltinModel` fires after every start covers the
 * rest: whatever the engine comes back with is what the header shows.
 *
 * An expert ctx set by hand wins outright in both directions, exactly as it
 * does in `ensureBuiltinAgentCtx`.
 */

/** The ctx llama-server is started with when nobody has said otherwise. A
 *  settings value equal to it counts as "never touched". */
export const ENGINE_DEFAULT_CTX = 8192

export interface SwapCtxInput {
  /** `settings.builtinEngine.ctx` — the expert tuning value. */
  tuningCtx?: number | null
  /** `bundled_engine_status.ctx` — what the running engine was started with. */
  currentCtx?: number | null
  /** `ctx_train` of the GGUF that is about to be loaded (header value). */
  ctxTrain?: number | null
}

/**
 * The ctx to put in the swap tuning, or undefined to leave the tuning alone.
 *
 * undefined on purpose rather than a number: "do not touch the user's tuning"
 * and "use 8192" are different intentions, and only the caller knows what the
 * rest of the tuning object holds.
 */
export function preservedSwapCtx(input: SwapCtxInput): number | undefined {
  const tuning = num(input.tuningCtx)
  // An expert value that is anything other than the untouched default is a
  // decision, not an accident. Never second-guess it.
  if (tuning > 0 && tuning !== ENGINE_DEFAULT_CTX) return undefined

  const base = tuning > 0 ? tuning : ENGINE_DEFAULT_CTX
  const current = num(input.currentCtx)
  if (current <= base) return undefined // nothing is being given back

  const train = num(input.ctxTrain)
  if (train <= 0) return undefined // the header is silent, do not guess

  const keep = Math.min(current, train)
  return keep > base ? keep : undefined
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}
