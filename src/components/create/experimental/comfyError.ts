/** Turn the ComfyUI output tail into an error a person can act on. The last
 *  lines of a startup crash name the real problem (a torch import error, a
 *  missing DLL, an OOM); without them the message was a dead end (GH #98).
 *  `advice` is the sentence under the output, see comfyCrashAdvice. */
export function comfyStartupError(lines?: string[], advice?: string): string {
  const tail = (lines ?? []).map((l) => l.trim()).filter(Boolean).slice(-6)
  const base = 'Installed ComfyUI but it did not come up.'
  const rat = (advice ?? '').trim()
  const msg = tail.length ? `${base} Its last output:\n${tail.join('\n')}` : `${base} Check Settings → AI Backends.`
  return rat ? `${msg}\n\n${rat}` : msg
}

/** Der bisherige allgemeine Satz. Er gilt weiter fuer jeden Absturz, den ein
 *  Neubau der Umgebung wirklich beheben kann. */
export const REPAIR_ADVICE =
  'The Python environment looks broken. Repair environment below rebuilds it in place; models, outputs and custom nodes are left alone.'

/** Der Satz unter der Ausgabe, aus einer Stelle statt aus zweien.
 *
 *  Ticket 007 (falcon bob, 01.09. bis 02.09.): sein torch starb an einem
 *  WinError 1114, und die Oberflaeche haengte trotzdem den allgemeinen Satz
 *  an. Der Einordner des Installers kannte diesen Fehler die ganze Zeit, also
 *  gewinnt sein Hinweis, sobald Rust einen mitliefert. Bleibt keiner uebrig,
 *  bleibt es beim alten Satz, und den gibt es nur noch, wenn Rust die
 *  Umgebung als reparierbar meldet. */
export function comfyCrashAdvice(out?: { hint?: string; envBroken?: boolean } | null): string {
  const hint = (out?.hint ?? '').trim()
  if (hint) return hint
  return out?.envBroken ? REPAIR_ADVICE : ''
}
