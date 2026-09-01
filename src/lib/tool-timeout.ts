/**
 * One timeout rule for every tool call, shared by useCodex and useAgentChat
 * (audit B8/B9): the two loops used to disagree — Codex raced every call
 * against a generous cap while Agent mode had NO ceiling at all (a hung tool
 * wedged the whole run), and Agent never injected the long shell default, so
 * the same build that passed in the Code tab died at the Rust side's 120 s
 * default in Agent mode.
 *
 * The cap is a BACKSTOP above the tool's own deadline, never the working
 * limit: shell/code/test/git enforce their real timeout in the Rust backend
 * (args.timeout), image/video in the vram-handoff poll
 * (imageGen/videoGenTimeoutMinutes). The JS race only exists so a tool whose
 * own timer never fires cannot hold the loop forever.
 */

/** Default args.timeout the loops inject for the exec tools (ms). Building an
 * app (npm install, cargo/gradle) routinely runs minutes; the old 30 s
 * default + 60 s JS cap killed every real build (David 2026-06-04). */
export const SHELL_EXECUTE_DEFAULT_TIMEOUT_MS = 600_000

const LONG_RUNNING = new Set([
  'shell_execute',
])

export interface ToolTimeoutSettings {
  imageGenTimeoutMinutes?: number
  videoGenTimeoutMinutes?: number
}

/** The JS race ceiling for one tool call, in ms. */
export function toolCallCapMs(
  name: string,
  args: Record<string, unknown> | undefined,
  settings: ToolTimeoutSettings,
): number {
  if (name === 'image_generate') {
    return Math.max(1, Number(settings.imageGenTimeoutMinutes) || 20) * 60_000 + 120_000
  }
  if (name === 'video_generate') {
    return Math.max(1, Number(settings.videoGenTimeoutMinutes) || 60) * 60_000 + 120_000
  }
  if (LONG_RUNNING.has(name)) {
    const own = Number(args?.timeout)
    return Number.isFinite(own) && own > 0 ? own + 15_000 : SHELL_EXECUTE_DEFAULT_TIMEOUT_MS + 15_000
  }
  return 60_000
}

/**
 * Race a tool run against its cap. The timer is CLEARED when the tool wins
 * (audit B10) — the old inline race left every winner's setTimeout parked
 * for up to 615 s with the whole closure alive, times 200 iterations.
 */
export function raceWithToolTimeout(run: Promise<string>, name: string, capMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<string>((_, reject) => {
    timer = setTimeout(
      // The tool name was passed in by both callers but never used, so every
      // timeout reached the model as an anonymous "Tool execution timed out"
      // — in a parallel batch it could not tell which tool had died.
      () => reject(new Error(`Tool execution timed out: ${name} (${Math.round(capMs / 1000)}s)`)),
      capMs,
    )
  })
  return Promise.race([run, deadline]).finally(() => clearTimeout(timer))
}
