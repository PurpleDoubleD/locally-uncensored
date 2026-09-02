/**
 * Did the backend ANSWER, or did the call simply not get through.
 *
 * A14 second review: the boot resume gets one shot per app session, and the
 * flag that spends it was raised before the call. That is right for a machine
 * that has no sidecar and will never have one, and wrong for the moment this
 * actually runs: right after launch, with the antivirus still scanning the
 * fresh install and the Tauri command layer coming up behind the window. A
 * first call that loses that race used to spend the only shot, and the engine
 * the user left running yesterday stayed dead until he re-picked the model by
 * hand. That is GH #118 again, one door further along.
 *
 * So the shot is spent on an ANSWER, and a refusal counts as one: a backend
 * that says "I do not have that command" has answered, and waiting will not
 * change its mind. A timeout or a dead transport has said nothing at all.
 */

/** Rejections that mean "this build does not have that command". Lower-cased
 *  fragments, matched against the message Tauri hands across as a string. */
const NO_SUCH_COMMAND = [
  // Tauri's own wording for a command that is not in the invoke handler, and
  // the shapes the HTTP bridge and the web build produce for the same thing.
  'not found',
  'unknown command',
  'no such command',
  'invalid command',
  'command not allowed',
  'not allowed by scope',
  'not implemented',
  // No Tauri at all: `backendCall` outside the desktop build.
  'not running in tauri',
  'is not a function',
  'not available in this build',
]

/** The message behind an unknown thrown value. */
export function commandFailureText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err ?? '')
}

/**
 * True when the failure is the backend saying it does not have this command.
 *
 * Deliberately the narrow half. Everything unrecognised counts as "no answer"
 * and is retried, because the cost of retrying is one extra command on the
 * next model refresh and the cost of not retrying is a dead engine for the
 * rest of the session.
 */
export function commandIsUnavailable(err: unknown): boolean {
  const msg = commandFailureText(err).toLowerCase()
  if (!msg) return false
  return NO_SUCH_COMMAND.some((m) => msg.includes(m))
}
