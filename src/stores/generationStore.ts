import { create } from 'zustand'
import type { RunLane } from '../lib/run-lanes'

/**
 * Ephemeral per-conversation "a turn is generating" flags. Deliberately NOT
 * persisted — a crash mid-stream must never leave a stale "running" marker that
 * survives a restart.
 *
 * Why this exists (David 2026-06-12): the chat / agent / codex hooks each held a
 * single GLOBAL `isGenerating` boolean. The typing indicator (the 3 dots) and
 * the realtime counter were gated on that global, so generating in ONE chat lit
 * the dots in EVERY other chat you switched to ("die drei ladepunkte kommen in
 * vorherigen chats auch"). Binding the indicators to the conversation that is
 * actually generating fixes it — the dots show only in the chat whose turn is
 * in flight. The Coding Agent uses its own per-thread status (codexStore), so it
 * doesn't need this store; Chat + Agent (which share one useChat instance) do.
 *
 * ── AUFTRAG 2.1: DIE SPUR GEHOERT ZUM LAUF ───────────────────────────────
 *
 * Der Absatz darueber stand bis heute anders da: die Eingabe blieb absichtlich
 * GLOBAL, weil ein zweiter Auftrag aus einem anderen Chat die geteilten
 * Streaming-Refs zerschossen haette. Der Preis dafuer war, dass der
 * Senden-Knopf waehrend JEDES Laufs app-weit "Stop generation" hiess. Ein
 * zweiter Auftrag war nicht absendbar, ohne den ersten abzubrechen, auch in
 * einem voellig anderen Gespraech, und auch dann, wenn der erste Lauf in der
 * Wolke rechnete und mit der Maschine des Nutzers gar nichts zu tun hatte.
 *
 * Was hier dazukommt, ist die eine Tatsache, die dafuer fehlte: AUF WELCHER
 * SPUR ein Lauf rechnet. Cloud-Laeufe duerfen echt gleichzeitig laufen, denn
 * dort steht fremde Kapazitaet dahinter. Lokale Laeufe bleiben serialisiert,
 * weil zwei davon auf einer Karte kein Gewinn sind, sondern VRAM-Umladen; die
 * Begruendung steht ausgeschrieben in `lib/run-lanes.ts`. Der Unterschied
 * muss sichtbar sein, sonst ist er fuer den Kunden Willkuer, und sichtbar
 * machen kann ihn nur, wer ihn ablesen kann.
 *
 * ── DREI TATSACHEN, DREI ORTE, KEINE KOPIE ───────────────────────────────
 *
 * Das Muster, an dem dieses Haus am haeufigsten scheitert, ist "zwei Pfade,
 * einer gepflegt". Deshalb steht hier ausgeschrieben, welche Frage wo
 * beantwortet wird, und dass keine der drei aus einer anderen ableitbar ist:
 *
 *   `generating[id]`  Fliessen hier gerade Token? Der Zustand, an dem die
 *                     Punkte und der Stop-Knopf haengen. Ein wartender Lauf
 *                     hat ihn NICHT.
 *   `runs[id]`        Auf welcher Spur ist hier ein Lauf gebucht, und seit
 *                     wann? Gilt ab dem Anstellen, also schon bevor das
 *                     erste Token fliesst.
 *   `lib/run-lanes`   Wer haelt die eine lokale Spur, und wer wartet in
 *                     welcher Reihenfolge? Modulzustand, kein Spiegel hier.
 *
 * `runs[id]` ist ausdruecklich KEINE zweite Fassung von `generating[id]`. Ein
 * Wartender hat einen Eintrag und keine Fahne; ein Altbestands-Lauf, der
 * `setGenerating` ruft, ohne vorher zu buchen, hat eine Fahne und keinen
 * Eintrag. Wer die beiden zusammenlegt, verliert genau den Zustand, den
 * dieser Auftrag sichtbar machen soll.
 *
 * Gebucht und geraeumt wird an EINER Stelle, `lib/run-slot.ts`. Sie ist auch
 * die einzige, die die Spur bei `run-lanes` nimmt und zurueckgibt.
 */
/**
 * Ein gebuchter Lauf: die Spur, auf der er rechnet, und seit wann er gebucht
 * ist. Kein Status, keine Fahne, kein Abbruchgriff, das steht alles daneben
 * und wird hier bewusst nicht noch einmal gefuehrt.
 */
export interface ActiveRun {
  conversationId: string
  /** Eigene Karte oder fremde Kapazitaet. Entschieden in `lib/run-lane-of-model.ts`. */
  lane: RunLane
  /**
   * ms-Zeitstempel der ERSTEN Buchung. Bleibt beim Nachbuchen stehen, damit
   * "wartet seit" nicht bei jeder Nachfrage von vorn anfaengt und ein lange
   * stehender Lauf nicht aussieht wie ein eben angekommener.
   */
  bookedAt: number
}

interface GenerationState {
  /** conversationId → true while its turn is generating. Absent = idle. */
  generating: Record<string, boolean>
  setGenerating: (conversationId: string | null | undefined, on: boolean) => void
  /**
   * conversationId → abort callback for the in-flight turn (chat stream OR
   * agent loop). Lets a non-hook caller (deleting/closing a chat) stop the
   * work that the owning hook started.
   */
  aborters: Record<string, () => void>
  registerAborter: (conversationId: string | null | undefined, fn: () => void) => void
  clearAborter: (conversationId: string | null | undefined) => void
  /**
   * Abort the in-flight turn for a conversation and clear its flags. Called
   * when a chat is deleted/closed so its activity stops completely instead of
   * running on in the background (David 2026-06-15).
   */
  abortConversation: (conversationId: string | null | undefined) => void
  /**
   * conversationId → der gebuchte Lauf dieses Gespraechs, mit seiner Spur.
   *
   * Geschrieben ausschliesslich von `lib/run-slot.ts`, das auch die Spur bei
   * `lib/run-lanes.ts` nimmt und zurueckgibt. Ein zweiter Schreiber waere
   * genau der Pfad, der irgendwann nicht mehr gepflegt wird.
   */
  runs: Record<string, ActiveRun>
  /** Diesen Lauf mit seiner Spur eintragen. Zweite Buchung behaelt `bookedAt`. */
  bookRun: (conversationId: string | null | undefined, lane: RunLane) => void
  /** Der Lauf ist vorbei. Raeumt nur den Eintrag, nicht die Fahne. */
  endRun: (conversationId: string | null | undefined) => void
}

/**
 * Auf welcher Spur laeuft das Gespraech gerade, falls ueberhaupt?
 *
 * Fuer Aufrufer ohne React. In einer Komponente stattdessen
 * `useGenerationStore((s) => s.runs[id]?.lane)`, sonst malt sie nicht neu,
 * wenn der Lauf die Spur wechselt oder endet.
 */
export function runLaneOf(conversationId: string | null | undefined): RunLane | undefined {
  if (!conversationId) return undefined
  return useGenerationStore.getState().runs[conversationId]?.lane
}

export const useGenerationStore = create<GenerationState>((set, get) => ({
  generating: {},
  aborters: {},
  runs: {},
  setGenerating: (conversationId, on) =>
    set((state) => {
      if (!conversationId) return state
      // No-op when the flag is already in the requested state — avoids an
      // unnecessary store update (and re-render) on every stream tick.
      if (!!state.generating[conversationId] === on) return state
      const next = { ...state.generating }
      if (on) next[conversationId] = true
      else delete next[conversationId]
      return { generating: next }
    }),

  registerAborter: (conversationId, fn) =>
    set((state) => {
      if (!conversationId) return state
      return { aborters: { ...state.aborters, [conversationId]: fn } }
    }),

  clearAborter: (conversationId) =>
    set((state) => {
      if (!conversationId || !state.aborters[conversationId]) return state
      const next = { ...state.aborters }
      delete next[conversationId]
      return { aborters: next }
    }),

  abortConversation: (conversationId) => {
    if (!conversationId) return
    const fn = get().aborters[conversationId]
    if (fn) {
      try { fn() } catch { /* best-effort — the turn is going away anyway */ }
    }
    set((state) => {
      const nextAborters = { ...state.aborters }
      delete nextAborters[conversationId]
      const nextGenerating = { ...state.generating }
      delete nextGenerating[conversationId]
      // Die Buchung geht mit. Bliebe sie stehen, zeigte der abgebrochene Chat
      // weiter "wartet auf die Grafikkarte", fuer einen Lauf, den es nicht
      // mehr gibt. Die Spur selbst gibt `lib/run-slot.ts` in seinem `finally`
      // zurueck, und zwar auch auf diesem Weg.
      const nextRuns = { ...state.runs }
      delete nextRuns[conversationId]
      return { aborters: nextAborters, generating: nextGenerating, runs: nextRuns }
    })
  },

  bookRun: (conversationId, lane) =>
    set((state) => {
      if (!conversationId) return state
      const vorhanden = state.runs[conversationId]
      if (vorhanden && vorhanden.lane === lane) return state
      return {
        runs: {
          ...state.runs,
          [conversationId]: {
            conversationId,
            lane,
            bookedAt: vorhanden?.bookedAt ?? Date.now(),
          },
        },
      }
    }),

  endRun: (conversationId) =>
    set((state) => {
      if (!conversationId || !state.runs[conversationId]) return state
      const next = { ...state.runs }
      delete next[conversationId]
      return { runs: next }
    }),
}))
