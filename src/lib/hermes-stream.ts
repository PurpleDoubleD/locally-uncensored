/**
 * Display filter for streaming a Hermes-XML tool turn.
 *
 * The prompt-transport models answer with prose that may contain
 * `<tool_call>{...}</tool_call>` blocks. When such a turn is streamed, the
 * raw XML must never flash into the chat bubble — but everything around it
 * should appear token by token. This filter decides, per delta, which part
 * of the text is SAFE to show: it withholds the longest tail that could
 * still turn into an opening tag, and swallows everything between a
 * confirmed opening tag and its close.
 *
 * It is UI-only. The caller still accumulates the FULL raw text and runs
 * parseHermesToolCalls / stripToolCallTags on it at the end, exactly like
 * the non-streaming path — so call extraction cannot behave differently
 * just because the turn was streamed.
 */

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

export interface HermesDisplayFilter {
  /** Feed one stream delta; returns the text that is safe to display now. */
  feed(delta: string): string
  /** Stream is over: returns whatever held-back text turned out to be prose. */
  flush(): string
  /** True while inside an unclosed <tool_call> block (UI can show a hint). */
  inToolCall(): boolean
}

/** Longest suffix of `text` that is a prefix of `tag` (possible cut tag). */
function cutTagSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1)
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

export function createHermesDisplayFilter(): HermesDisplayFilter {
  let pending = ''
  let inCall = false

  return {
    feed(delta: string): string {
      pending += delta
      let out = ''
      while (true) {
        if (inCall) {
          const close = pending.indexOf(CLOSE_TAG)
          if (close === -1) {
            // Keep only what could still be part of the close tag; the call
            // body itself is never shown, so it can be dropped from pending.
            const keep = cutTagSuffix(pending, CLOSE_TAG)
            pending = keep > 0 ? pending.slice(pending.length - keep) : ''
            return out
          }
          pending = pending.slice(close + CLOSE_TAG.length)
          inCall = false
          continue
        }
        const open = pending.indexOf(OPEN_TAG)
        if (open !== -1) {
          out += pending.slice(0, open)
          pending = pending.slice(open + OPEN_TAG.length)
          inCall = true
          continue
        }
        // No full opening tag: emit everything except a tail that might
        // still become one ("<tool_ca" at the end of this delta).
        const hold = cutTagSuffix(pending, OPEN_TAG)
        out += pending.slice(0, pending.length - hold)
        pending = pending.slice(pending.length - hold)
        return out
      }
    },

    flush(): string {
      // An unfinished opening-tag prefix was ordinary prose after all. An
      // unclosed call stays swallowed — the raw-text parse at turn end is
      // what decides how a malformed call is handled, not the display.
      const rest = inCall ? '' : pending
      pending = ''
      inCall = false
      return rest
    },

    inToolCall(): boolean {
      return inCall
    },
  }
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

export interface ThinkStreamSplitter {
  /** Feed one display-safe delta; returns what goes where RIGHT NOW. */
  feed(delta: string): { prose: string; thinking: string }
  /** Stream over: classify whatever is still held back. */
  flush(): { prose: string; thinking: string }
  inThink(): boolean
}

/**
 * Route `<think>` spans out of a live stream and into the thinking channel
 * (G35, David 2026-08-07: the thought must stream inside the same bounded
 * 3-line window everywhere, never full-height into the bubble).
 *
 * `startInThink` exists because the Qwen3 chat templates put the OPENING
 * `<think>` into the prompt: the reply begins mid-thought and only ever sends
 * the closer, so a splitter that waits for an opener would classify the whole
 * thought as prose. Callers pass their keep-thinking gate here. If the model
 * then answers without any think tags after all, everything streamed into the
 * thinking channel and the authoritative end-of-turn parse (which reruns on
 * the FULL raw text) puts it back into content: the UI self-heals at turn
 * end, the failure mode is cosmetic and transient.
 *
 * Like the tool-call filter this is UI-only: callers still accumulate the
 * full raw text and the turn-end parse decides what counts.
 */
export function createThinkStreamSplitter(opts?: { startInThink?: boolean }): ThinkStreamSplitter {
  let pending = ''
  let inThink = opts?.startInThink === true

  return {
    feed(delta: string): { prose: string; thinking: string } {
      pending += delta
      let prose = ''
      let thinking = ''
      while (true) {
        if (inThink) {
          const close = pending.indexOf(THINK_CLOSE)
          if (close === -1) {
            const keep = cutTagSuffix(pending, THINK_CLOSE)
            thinking += pending.slice(0, pending.length - keep)
            pending = keep > 0 ? pending.slice(pending.length - keep) : ''
            return { prose, thinking }
          }
          thinking += pending.slice(0, close)
          pending = pending.slice(close + THINK_CLOSE.length)
          inThink = false
          continue
        }
        const open = pending.indexOf(THINK_OPEN)
        if (open !== -1) {
          prose += pending.slice(0, open)
          pending = pending.slice(open + THINK_OPEN.length)
          inThink = true
          continue
        }
        const hold = cutTagSuffix(pending, THINK_OPEN)
        prose += pending.slice(0, pending.length - hold)
        pending = pending.slice(pending.length - hold)
        return { prose, thinking }
      }
    },

    flush(): { prose: string; thinking: string } {
      const res = inThink ? { prose: '', thinking: pending } : { prose: pending, thinking: '' }
      pending = ''
      inThink = false
      return res
    },

    inThink(): boolean {
      return inThink
    },
  }
}

/**
 * The two live reasoning sources of ONE turn, merged in one place.
 *
 * A prompt-transport turn can be handed its reasoning two different ways at
 * the same time, and 2.6.7 lost one of them on both agent paths:
 *
 *   - inline, as `<think>` spans inside the visible text, which is what
 *     `createThinkStreamSplitter` pulls out; and
 *   - natively, as the provider's `thinking` chunks, which is what
 *     llama-server produces once it parses `<think>` into `reasoning_content`
 *     for us, and what every cloud reasoner sends.
 *
 * They differ in shape: the splitter emits DELTAS, the provider callback hands
 * over the CUMULATIVE text. Merging them by hand in each hook is how the
 * Coding path ended up with no live thinking at all and the Agent path with a
 * native answer that overwrote the inline one. This holds both, keeps them
 * apart, and answers the only question the UI has: what should the thinking
 * block show right now.
 *
 * Live display only. The end-of-turn parse on the full raw text stays
 * authoritative for what is finally stored on the message.
 */
export interface TurnThinkingSink {
  /** One `<think>` delta out of the visible stream. */
  inline(delta: string): void
  /** The provider's reasoning channel, cumulative. */
  native(full: string): void
  /** What the thinking block should show right now, '' when there is nothing. */
  live(): string
}

export function createTurnThinkingSink(): TurnThinkingSink {
  let inlineText = ''
  let nativeText = ''
  return {
    inline(delta: string) {
      if (!delta) return
      // A pre-opened thought (Qwen3 templates put the opener in the PROMPT)
      // can still carry a literal opener when the model repeats it. It is a
      // marker, never reasoning the user wants to read.
      inlineText += delta.replace(/<think>/g, '')
    },
    native(full: string) {
      nativeText = full ?? ''
    },
    live() {
      return [nativeText, inlineText].filter(Boolean).join('\n\n')
    },
  }
}
