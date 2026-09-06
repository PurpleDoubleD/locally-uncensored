// The closing line an agent turn shows when the model itself said nothing.
//
// That is not a rare corner: a model very often calls image_generate and stops,
// leaving this function to write the entire visible reply. Which is why the old
// version mattered so much. It counted tool calls into "Task completed: 1
// failed." and dropped the reason on the floor, so a user whose ComfyUI
// returned a 400 saw a green sounding sentence, a block labelled "Failed:
// image_generate", and nothing at all about what went wrong. TheRealNovelist
// read that as the app losing the picture and scrambling the chat (D#81).
//
// Rules encoded here:
//   - a failed picture is never a completed task
//   - when a picture fails, the reason we already have gets shown
//   - a partial run says partial, not completed

import { isMediaTool } from './media-result'

export interface TurnToolCall {
  toolName: string
  status?: string
  result?: string | null
  /** Die Argumente des Aufrufs. Gebraucht wird daraus nur `path`, um zwei
   *  Schreibvorgaenge auf DIESELBE Datei nicht als zwei Dateien zu zaehlen.
   *  Optional, weil aeltere gespeicherte Bloecke sie nicht tragen. */
  args?: Record<string, unknown>
}

export interface TurnSummaryInput {
  calls: TurnToolCall[]
  /** Media that really landed this turn, already validated by the caller. */
  imageGenDone: number
  videoGenDone: number
  /** True only when an image was fed back to a vision-capable model. */
  visionFeedbackGiven: boolean
  /** The run's own plan, when one is open (G27). The G16 reconcile steers the
   *  MODEL back to work, but its budget is two; once it is spent the run ends
   *  anyway and this function writes the last thing the user reads. On R01b
   *  (Mac, 2026-08-07) that sentence was "Task completed: 3 operations
   *  completed." while the PlanBar beside it read 1 of 31. The closing line
   *  must never claim completion the plan contradicts. */
  planGap?: { done: number; total: number; next: string } | null
}

const NOTHING_AT_ALL =
  "I couldn't produce a response for that. Please rephrase, or turn off Think and send again."

/**
 * Returns the text to show, or '' to leave the bubble empty (the tool block
 * already carries the picture, so a robotic "your video is above" only adds
 * noise · David 2026-06-16).
 */
export function summarizeTurn(input: TurnSummaryInput): string {
  const { calls, imageGenDone, videoGenDone, visionFeedbackGiven, planGap } = input
  const completed = calls.filter((c) => c.status === 'completed')
  const failed = calls.filter((c) => c.status === 'failed')

  // G27: an open plan outranks every cheerful ending below. It is a SUFFIX,
  // never a replacement: the D#81 rule that a failed picture always shows its
  // reason stands, and a picture that landed is still worth saying. Only the
  // claim of completion is taken away.
  const planNote = planGap
    ? `The run stopped with the plan unfinished: ${planGap.done} of ${planGap.total} steps done. Next open step: "${planGap.next}". Send "continue" to carry on.`
    : ''
  const withPlan = (text: string) => (planNote ? (text ? `${text}\n\n${planNote}` : planNote) : text)

  if (planGap && imageGenDone === 0 && videoGenDone === 0) {
    const failedMediaNow = failed.filter((c) => isMediaTool(c.toolName))
    // A failed picture keeps its own headline (D#81); the plan note follows it.
    if (failedMediaNow.length === 0) return planNote
  }

  if (imageGenDone > 0 || videoGenDone > 0) {
    // The empty return stays empty when the plan is done: the tool block
    // already shows the picture and a robotic line only adds noise. With an
    // open plan the note is the whole point, so it survives on its own.
    if (!visionFeedbackGiven) return withPlan('')
    if (imageGenDone > 0 && videoGenDone > 0) {
      return withPlan('Fertig, dein Bild und dein Video sind oben. / Done, your image and video are above.')
    }
    return withPlan(videoGenDone > 0
      ? 'Fertig, dein Video ist oben. / Done, your video is above.'
      : 'Fertig, dein Bild ist oben. / Done, your image is above.')
  }

  // Nothing landed. If a picture or clip was attempted and failed, that is the
  // headline, and the tool already told us why.
  const failedMedia = failed.filter((c) => isMediaTool(c.toolName))
  if (failedMedia.length) {
    const kind = failedMedia.some((c) => c.toolName === 'video_generate') ? 'video' : 'image'
    const why = (failedMedia[0].result ?? '').trim()
    return withPlan(why
      ? `That ${kind} did not come out: ${why}\n\nSay "again" to retry, or change the prompt or model and send it once more.`
      : `That ${kind} did not come out and no reason came back. Check that ComfyUI is still running, then try again.`)
  }

  const schreibAufrufe = completed.filter((c) => c.toolName === 'file_write')
  // Persona-Befund 10 (03.09.2026): der Agent schrieb DIESELBE Datei zweimal —
  // Schritt 1 korrekt, Schritt 4 kaputt — und die Schlusszeile meldete „2 files
  // written". Es war eine Datei, und die zweite Fassung war schlechter als die
  // erste. Gezaehlt werden deshalb Ziele, nicht Vorgaenge; und wo ein Ziel
  // mehrfach beschrieben wurde, steht das ausdruecklich dabei, weil genau dort
  // eine gute Fassung von einer schlechteren ueberschrieben worden sein kann.
  const zielVon = (c: TurnToolCall): string | null => {
    const roh = c.args?.path
    if (typeof roh !== 'string' || !roh.trim()) return null
    return roh.trim().replace(/^\.\//, '').replace(/\\/g, '/')
  }
  const proZiel = new Map<string, number>()
  let ohneZiel = 0
  for (const c of schreibAufrufe) {
    const ziel = zielVon(c)
    if (ziel === null) ohneZiel++
    else proZiel.set(ziel, (proZiel.get(ziel) ?? 0) + 1)
  }
  const writes = proZiel.size + ohneZiel
  const mehrfach = [...proZiel.entries()].filter(([, n]) => n > 1)
  const reads = completed.filter((c) => c.toolName === 'file_read').length
  const otherOk = completed.length - schreibAufrufe.length - reads
  const parts: string[] = []
  if (writes) parts.push(`${writes} file${writes === 1 ? '' : 's'} written`)
  if (reads) parts.push(`${reads} file${reads === 1 ? '' : 's'} read`)
  if (otherOk) parts.push(`${otherOk} operation${otherOk === 1 ? '' : 's'} completed`)

  const failedNote = `${failed.length} step${failed.length === 1 ? '' : 's'} failed`
  // Hoechstens zwei Namen: der Hinweis soll die Zeile nicht ersetzen.
  const rewriteNote = mehrfach.length
    ? ' ' + mehrfach.slice(0, 2).map(([ziel, n]) => `${ziel} was written ${n}×`).join(', ') +
      (mehrfach.length > 2 ? `, and ${mehrfach.length - 2} more` : '') +
      ' — only the last version is on disk.'
    : ''
  if (parts.length) {
    return failed.length
      ? `Task partly done: ${parts.join(', ')}. ${failedNote}.${rewriteNote}`
      : `Task completed: ${parts.join(', ')}.${rewriteNote}`
  }
  return failed.length ? `That did not work out. ${failedNote}, nothing else ran.` : NOTHING_AT_ALL
}
