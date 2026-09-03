import { describe, it, expect } from 'vitest'
import { summarizeTurn, type TurnToolCall } from '../turn-summary'

// D#81, second half. The first half stopped a failed generation from counting
// as a delivered one. This half is about what the user then reads. The model
// usually says nothing after calling image_generate, so this text IS the reply.

const failedImage = (result: string): TurnToolCall => ({
  toolName: 'image_generate',
  status: 'failed',
  result,
})

describe('summarizeTurn', () => {
  describe('a failed picture', () => {
    it('THE FIX: says what went wrong instead of "Task completed: 1 failed."', () => {
      const text = summarizeTurn({
        calls: [failedImage('Image generation failed: ComfyUI rejected workflow: 400 Bad Request')],
        imageGenDone: 0,
        videoGenDone: 0,
        visionFeedbackGiven: false,
      })
      expect(text).toContain('400 Bad Request')
      expect(text).not.toContain('Task completed')
    })

    it('never calls a turn completed when nothing completed', () => {
      const text = summarizeTurn({
        calls: [failedImage('Error: fetch failed')],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text.toLowerCase()).not.toContain('completed')
    })

    it('tells the user how to retry', () => {
      const text = summarizeTurn({
        calls: [failedImage('Cannot generate: wan2.1 supports at most 81 frames (you requested 200).')],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('again')
    })

    it('names video when the video tool is the one that failed', () => {
      const text = summarizeTurn({
        calls: [{ toolName: 'video_generate', status: 'failed', result: 'Video generation timed out after 10 minutes.' }],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('video')
      expect(text).toContain('timed out')
    })

    it('still says something useful when no reason came back', () => {
      const text = summarizeTurn({
        calls: [{ toolName: 'image_generate', status: 'failed', result: '' }],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('ComfyUI')
      expect(text).not.toContain('undefined')
    })
  })

  describe('a picture that landed', () => {
    it('stays silent unless the model actually saw it', () => {
      const call: TurnToolCall = { toolName: 'image_generate', status: 'completed', result: '/view?filename=a.png' }
      expect(summarizeTurn({ calls: [call], imageGenDone: 1, videoGenDone: 0, visionFeedbackGiven: false })).toBe('')
      expect(summarizeTurn({ calls: [call], imageGenDone: 1, videoGenDone: 0, visionFeedbackGiven: true })).toContain('Bild')
    })

    it('mentions both when an image and a clip landed', () => {
      const text = summarizeTurn({
        calls: [], imageGenDone: 1, videoGenDone: 1, visionFeedbackGiven: true,
      })
      expect(text).toContain('Bild')
      expect(text).toContain('Video')
    })
  })

  describe('ordinary tool turns are unchanged', () => {
    it('counts writes and reads', () => {
      const text = summarizeTurn({
        calls: [
          { toolName: 'file_write', status: 'completed' },
          { toolName: 'file_read', status: 'completed' },
          { toolName: 'file_read', status: 'completed' },
        ],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toBe('Task completed: 1 file written, 2 files read.')
    })

    it('a partial run says partly done, not completed', () => {
      const text = summarizeTurn({
        calls: [
          { toolName: 'file_write', status: 'completed' },
          { toolName: 'shell_execute', status: 'failed', result: 'Error: exit 1' },
        ],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('partly done')
      expect(text).toContain('1 step failed')
    })

    it('a non-media failure does not borrow the picture wording', () => {
      const text = summarizeTurn({
        calls: [{ toolName: 'web_search', status: 'failed', result: 'Error: fetch failed' }],
        imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).not.toContain('did not come out')
      expect(text).toContain('1 step failed')
    })

    it('falls back to the rephrase hint when nothing ran at all', () => {
      const text = summarizeTurn({
        calls: [], imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
      })
      expect(text).toContain('rephrase')
    })
  })
})

// G27, witnessed on the fresh Mac build 2026-08-07 (R01b): the run stopped
// after three of thirty-one steps and the closing line read "Task completed:
// 3 operations completed." while the PlanBar right beside it read 1 of 31.
// The G16 reconcile steers the MODEL, with a budget of two; when that budget
// is spent the run ends anyway, and THIS function writes the sentence the
// user is left with.
describe('an open plan outranks a cheerful ending (G27)', () => {
  const threeOk: TurnToolCall[] = [
    { toolName: 'todo_write', status: 'completed' },
    { toolName: 'get_current_time', status: 'completed' },
    { toolName: 'system_info', status: 'completed' },
  ]
  const gap = { done: 1, total: 31, next: 'Use system_info to report the operating system' }

  it('R01b: never says completed while the plan says 1 of 31', () => {
    const text = summarizeTurn({
      calls: threeOk, imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false, planGap: gap,
    })
    expect(text).not.toContain('Task completed')
    expect(text).toContain('1 of 31')
    expect(text).toContain('Use system_info to report the operating system')
    expect(text).toContain('continue')
  })

  it('a picture that landed is still reported, with the caveat', () => {
    const text = summarizeTurn({
      calls: threeOk, imageGenDone: 1, videoGenDone: 0, visionFeedbackGiven: true, planGap: gap,
    })
    expect(text).toContain('your image is above')
    expect(text).toContain('1 of 31')
  })

  it('NEGATIVE CONTROL: no plan at all leaves every wording untouched', () => {
    const text = summarizeTurn({
      calls: threeOk, imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false, planGap: null,
    })
    expect(text).toBe('Task completed: 3 operations completed.')
    // omitting the field entirely behaves the same as passing null
    expect(summarizeTurn({
      calls: threeOk, imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
    })).toBe(text)
  })

  it('NEGATIVE CONTROL: a FINISHED plan is not a gap, so the run may say completed', () => {
    // openPlanGap returns null once every item is done; this asserts the
    // contract from this side, so a future caller cannot pass a done plan in.
    const text = summarizeTurn({
      calls: threeOk, imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false, planGap: null,
    })
    expect(text).toContain('Task completed')
  })

  it('NEGATIVE CONTROL: a failed picture still explains itself, plan or not', () => {
    const text = summarizeTurn({
      calls: [failedImage('Image generation failed: ComfyUI rejected workflow: 400 Bad Request')],
      imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false, planGap: null,
    })
    expect(text).toContain('400 Bad Request')
  })
})

// The plan note is a SUFFIX, never a replacement. Written after the first cut
// of the G27 fix returned the note ALONE for a failed picture, which would
// have re-opened D#81 (the user sees "the run stopped" and never learns the
// generation failed or why).
describe('G27 must not eat the D#81 explanation', () => {
  const gap = { done: 2, total: 10, next: 'Use video_generate for a two second clip' }

  it('a failed picture keeps its reason AND gains the plan note', () => {
    const text = summarizeTurn({
      calls: [failedImage('Image generation failed: ComfyUI rejected workflow: 400 Bad Request')],
      imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false, planGap: gap,
    })
    expect(text).toContain('400 Bad Request')
    expect(text).toContain('did not come out')
    expect(text).toContain('2 of 10')
  })

  it('a picture that landed but was not fed back still surfaces the open plan', () => {
    // Without a plan this case returns '' on purpose (the block shows the
    // picture). With one, the note is the only thing worth saying.
    const text = summarizeTurn({
      calls: [], imageGenDone: 1, videoGenDone: 0, visionFeedbackGiven: false, planGap: gap,
    })
    expect(text).toContain('2 of 10')
    expect(summarizeTurn({
      calls: [], imageGenDone: 1, videoGenDone: 0, visionFeedbackGiven: false, planGap: null,
    })).toBe('')
  })

  it('NEGATIVE CONTROL: nothing ran at all, plan open, the hint is not lost', () => {
    const text = summarizeTurn({
      calls: [], imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false, planGap: gap,
    })
    expect(text).toContain('2 of 10')
  })
})

// ── Gezaehlt werden Dateien, nicht Schreibvorgaenge (Persona B3) ─────────

describe('zweimal dieselbe Datei ist EINE Datei', () => {
  /**
   * Persona-Lauf vom 03.09.2026, Befund 10. Der Agent schrieb
   * `interview-leitfaden.txt` zweimal: Schritt 1 korrekt mit drei Zeilen,
   * Schritt 4 kaputt mit literalen Backslash-n. Die Schlusszeile lautete
   *
   *     „Task partly done: 2 files written, 1 operation completed.
   *      3 steps failed."
   *
   * Es war EINE Datei. Und die zweite Fassung war schlechter als die erste —
   * das merkte niemand, weil die Zeile nur Erfolge zaehlt. Ihre Worte: „Gezaehlt
   * werden Schreibvorgaenge, nicht Dateien; und dass das Ergebnis am Ende
   * schlechter war als nach Schritt 1, merkt niemand."
   */
  const schrieb = (path: string): TurnToolCall => ({
    toolName: 'file_write', status: 'completed', result: `File saved: ${path}`, args: { path },
  })

  it('zaehlt die Datei einmal, nicht zweimal', () => {
    const text = summarizeTurn({
      calls: [schrieb('interview-leitfaden.txt'), schrieb('interview-leitfaden.txt')],
      imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
    })
    expect(text).toContain('1 file written')
    expect(text).not.toContain('2 files written')
  })

  it('sagt, dass nur die letzte Fassung auf der Platte liegt', () => {
    const text = summarizeTurn({
      calls: [schrieb('interview-leitfaden.txt'), schrieb('interview-leitfaden.txt')],
      imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
    })
    expect(text).toContain('interview-leitfaden.txt')
    expect(text).toMatch(/2×|twice/)
    expect(text).toMatch(/last version/i)
  })

  it('zwei verschiedene Dateien bleiben zwei', () => {
    const text = summarizeTurn({
      calls: [schrieb('a.txt'), schrieb('b.txt')],
      imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
    })
    expect(text).toContain('2 files written')
    expect(text).not.toMatch(/last version/i)
  })

  it('ohne Pfadangabe bleibt es beim Zaehlen der Aufrufe', () => {
    // Aeltere gespeicherte Bloecke tragen keine args. Lieber die alte,
    // ungenaue Zahl als eine Ausnahme im Schlusssatz.
    const ohne: TurnToolCall = { toolName: 'file_write', status: 'completed', result: 'File saved: x' }
    const text = summarizeTurn({
      calls: [ohne, ohne], imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
    })
    expect(text).toContain('2 files written')
  })

  it('derselbe Pfad, anders geschrieben, zaehlt trotzdem einmal', () => {
    const text = summarizeTurn({
      calls: [schrieb('./notiz.txt'), schrieb('notiz.txt')],
      imageGenDone: 0, videoGenDone: 0, visionFeedbackGiven: false,
    })
    expect(text).toContain('1 file written')
  })
})
