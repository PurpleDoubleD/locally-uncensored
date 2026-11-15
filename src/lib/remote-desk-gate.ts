/**
 * A phone turn for a chat that is not open on the desktop, while someone
 * types at the desktop: LU does not jump away from what they are doing.
 * Instead a bar says "Your phone continued <Chat>. Open", and the turn runs
 * once they open it, or once nobody typed for a minute. When nobody typed
 * in the last minute, the turn runs at once, as before (CHATS-V1.md).
 *
 * Pure with an injected clock and timers; the window wires it to keydown and
 * to the chat that is open (lib/remote-chats-start.ts).
 */
import { create } from 'zustand'

/** Typing this recently counts as "someone is at the desktop". */
export const DESK_BUSY_MS = 60_000

export interface WaitingTurn {
  /** One per waiting turn. */
  key: string
  convId: string
  title: string
}

interface DeskGateState {
  waiting: WaitingTurn[]
}

/** What the bar shows. */
export const useDeskGateStore = create<DeskGateState>(() => ({ waiting: [] }))

let windowGate: DeskGate | null = null

/** The gate of this window, set once by lib/remote-chats-start.ts. */
export function setWindowDeskGate(gate: DeskGate | null): void {
  windowGate = gate
}

/** The gate of this window, for another turn nobody typed (a watcher). */
export function windowDeskGate(): DeskGate | null {
  return windowGate
}

/** "Open" in the bar (components/remote/PhoneContinuedBar.tsx). */
export function openWaitingTurn(key: string): void {
  windowGate?.open(key)
}

export interface DeskGateDeps {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Is this chat the one open on the desktop right now. */
  isOpen: (convId: string) => boolean
}

export interface GateTicket {
  ready: Promise<boolean>
  cancel: () => void
  /** True when the turn has to wait (the bar shows). */
  waiting: boolean
}

export interface DeskGate {
  /** Someone typed at the desktop. */
  typed: () => void
  /**
   * Resolves `true` when the turn may run (and the chat may be brought to
   * the front), `false` when it was cancelled while it waited.
   */
  wait: (convId: string, title: string) => GateTicket
  /** "Open" in the bar: run this one now. */
  open: (key: string) => void
  /** The open chat changed: a turn whose chat is open now runs. */
  check: () => void
}

export function createDeskGate(deps: DeskGateDeps): DeskGate {
  let lastTyped = Number.NEGATIVE_INFINITY
  let seq = 0
  const pending = new Map<string, { resolve: (ok: boolean) => void; timer: unknown }>()

  const show = () => useDeskGateStore.setState({ waiting: [...waiting] })
  const waiting: WaitingTurn[] = []

  function finish(key: string, ok: boolean) {
    const p = pending.get(key)
    if (!p) return
    pending.delete(key)
    deps.clearTimer(p.timer)
    const i = waiting.findIndex((w) => w.key === key)
    if (i >= 0) waiting.splice(i, 1)
    show()
    p.resolve(ok)
  }

  /** Sets the timer of one waiting turn to the end of the quiet minute. */
  function arm(key: string) {
    const p = pending.get(key)
    if (!p) return
    deps.clearTimer(p.timer)
    const left = lastTyped + DESK_BUSY_MS - deps.now()
    p.timer = deps.setTimer(() => {
      // Typing after the timer was set moves the end of the minute.
      if (deps.now() - lastTyped >= DESK_BUSY_MS) finish(key, true)
      else arm(key)
    }, Math.max(0, left))
  }

  return {
    typed: () => {
      lastTyped = deps.now()
    },
    wait: (convId, title) => {
      if (deps.isOpen(convId) || deps.now() - lastTyped >= DESK_BUSY_MS) {
        return { ready: Promise.resolve(true), cancel: () => {}, waiting: false }
      }
      const key = `t${++seq}`
      const ready = new Promise<boolean>((resolve) => {
        pending.set(key, { resolve, timer: null })
      })
      waiting.push({ key, convId, title })
      show()
      arm(key)
      return { ready, cancel: () => finish(key, false), waiting: true }
    },
    open: (key) => finish(key, true),
    check: () => {
      for (const w of [...waiting]) if (deps.isOpen(w.convId)) finish(w.key, true)
    },
  }
}
