// H2 security gate: shared, pure, testable.
//
// Consumed by BOTH loops since G15a (2026-08-07): useCodex gates on it
// directly, and useAgentChat lifts an exec tool to pending_approval when
// the cloud arm says so, on top of its per-tool permission levels. Before
// that, the same cloud model that had to ask in the Code tab ran
// shell_execute unattended on the Agent surface (R23).
//
// The coding agent (useCodex) auto-runs tools unattended by design. These are
// the arbitrary-code-execution tools, the prompt-injection RCE surface (a tool
// result or a read file steering the model into running a command). When the
// user enables `settings.codexConfirmShell`, each of these pauses for an
// explicit confirm before dispatch.
//
// file_write is deliberately NOT here: it is path-jailed to the workspace (C2)
// and has its own Stage-and-Approve mode, so it is not part of this gate.
export const CODEX_CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  'shell_execute',
  'code_execute',
  'shell_execute_background',
])

/** True when this tool call must be confirmed: the gate is enabled AND the tool
 *  is one of the arbitrary-exec tools. */
export function codexNeedsConfirm(toolName: string, confirmEnabled: boolean): boolean {
  return confirmEnabled && CODEX_CONFIRM_TOOLS.has(toolName)
}

/**
 * Per-field cap for the approval preview. Generous on purpose: this is the ONE
 * human checkpoint between a prompt-injected model and arbitrary local code, so
 * it errs toward showing too much. The dialog's `<pre>` scrolls, so length
 * costs the reader nothing but a scrollbar.
 */
const PREVIEW_FIELD_MAX = 8000

/** Fields worth showing, in the order a reader needs them. Everything that
 *  decides WHAT runs comes before everything that decides WHERE. */
const PREVIEW_FIELDS = ['command', 'stdin', 'code', 'script', 'args', 'shell', 'cwd', 'timeout', 'background'] as const

function renderValue(v: unknown): string {
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/**
 * What the user is actually approving, as text.
 *
 * The dialog used to show `args.command` and nothing else, while the
 * shell_execute description points the model at `stdin` for anything
 * multi-line: "Feed a script through `stdin` instead of quoting it: set command
 * to `python3 -`". So the approval card read `python3 -` — the starter — and
 * the payload, the part that is the arbitrary code execution, was invisible.
 * A model steered by a poisoned web page or a poisoned file could get its
 * script past the only human in the loop by putting it where the human was not
 * looking.
 *
 * Every field that shapes the process is rendered, labelled, in full.
 */
export function renderApprovalPreview(
  toolName: string,
  args: Record<string, unknown> | undefined,
  fieldMax = PREVIEW_FIELD_MAX,
): string {
  const a = args ?? {}
  const parts: string[] = []
  for (const key of PREVIEW_FIELDS) {
    const raw = a[key]
    if (raw === undefined || raw === null || raw === '') continue
    const text = renderValue(raw)
    if (!text) continue
    const shown = text.length > fieldMax
      ? `${text.slice(0, fieldMax)}\n… (${text.length - fieldMax} more characters)`
      : text
    // A single-line value reads better inline; a script needs its own block or
    // the indentation of the label corrupts what the user is reading.
    parts.push(shown.includes('\n') ? `${key}:\n${shown}` : `${key}: ${shown}`)
  }
  // Never render an empty card: a tool call whose args we cannot describe is
  // the LAST thing to wave through silently.
  if (parts.length === 0) {
    const keys = Object.keys(a)
    return keys.length === 0
      ? `${toolName} (no arguments)`
      : `${toolName}\n${JSON.stringify(a, null, 2).slice(0, fieldMax)}`
  }
  return parts.join('\n\n')
}

/**
 * Is the confirm gate active for THIS run?
 *
 * David 2026-08-22, replacing G15a (2026-08-07) and the 2.5.9 default:
 * bypass means bypass, on a cloud model too. The 2.5.7 review hard-wired
 * `providerId === 'lu-cloud'` into the gate, 2.5.9 turned that into a visible
 * setting that still defaulted ON, and G15a carried it to the Agent surface.
 * All three kept asking a user who had just said do not ask, which reads as a
 * broken switch rather than a policy. Picking Bypass IS the decision, and the
 * customer who picks it makes it themselves.
 *
 * What stays is the opt-in: `codexCloudConfirmOptIn` is OFF by default, so a
 * cloud model behaves exactly like a local one. Turn it on and the cloud
 * confirm is back in every mode, Bypass included, because that is what opting
 * in means.
 */
export function codexConfirmEnabled(opts: {
  /** settings.codexConfirmShell: confirm for EVERY provider. */
  confirmShell: boolean
  /** settings.codexCloudConfirmOptIn: also confirm on LU Cloud. Default false. */
  cloudOptIn: boolean
  /** Provider driving this run ('lu-cloud' | 'ollama' | 'openai' | ...). */
  providerId: string
}): boolean {
  if (opts.confirmShell) return true
  // `=== true` on purpose: a profile the persist merge never touched carries
  // the key as undefined, and the new policy is what undefined must mean.
  return opts.providerId === 'lu-cloud' && opts.cloudOptIn === true
}
