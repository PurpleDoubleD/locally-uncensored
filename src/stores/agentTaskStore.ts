import { create } from 'zustand'
import {
  applyTaskRing,
  isTerminal,
  type AgentTask,
  type AgentTaskStatus,
} from '../lib/agent-tasks'

/**
 * Hintergrund-Agenten, je Konversation.
 *
 * NICHT PERSISTIERT, und das ist eine Aussage über Ehrlichkeit, nicht über
 * Bequemlichkeit. Eine laufende Aufgabe ist ein lebendes Versprechen: ein
 * offener Stream, ein AbortController, eine Zusage an einen Elternzug, den es
 * nach einem Neustart nicht mehr gibt. Eine wiederhergestellte Zeile mit
 * `status: 'running'` würde über den Zustand der Maschine lügen, und zwar
 * genau dort, wo der Nutzer einen Abbrechen-Knopf sieht, der nichts mehr
 * abbricht. Dieselbe Begründung wie bei toolAuditStore und generationStore.
 *
 * Der Ring steht in lib/agent-tasks.ts und wird bei JEDEM Zufügen angewandt.
 * Warum überhaupt einer: codexStore und toolAuditStore tragen beide denselben
 * Deckel, und der Kommentar im ersten sagt, was ohne ihn passiert — ungekappte
 * Werkzeugausgaben, "tens of megabytes held for as long as the app is open".
 * Eine Aufgabe hier hält ein ganzes Modellgespräch. Der dritte Anlauf desselben
 * Fehlers wäre keiner mehr, den man Zufall nennen kann.
 */

/** Abbruchsteuerung lebt außerhalb des Zustands: ein Controller ist kein Wert. */
const controllers = new Map<string, AbortController>()

interface AgentTaskState {
  byConv: Record<string, AgentTask[]>

  /**
   * `controller` ist PFLICHT, nicht Bequemlichkeit.
   *
   * Ein Wächter hat den Fall gefunden: eine laufende Zeile ohne Controller
   * zählt `cancelAll` nicht mit und `cancel` bricht sie nicht ab — das Panel
   * zeigt trotzdem einen Stopp-Knopf, weil der nur am Zustand 'running'
   * hängt. Ein Knopf, der nichts tut, ist schlimmer als keiner: er lässt den
   * Nutzer glauben, er habe gestoppt.
   *
   * Einen fehlenden hier ersatzweise selbst zu erzeugen wäre die falsche
   * Reparatur — dann bräche `cancel` ein Signal ab, auf das niemand hört, und
   * meldete Erfolg. Der Griff muss der des LAUFS sein. Also verlangt der Typ
   * ihn, und der schlechte Zustand ist nicht mehr baubar.
   */
  start: (task: Omit<AgentTask, 'status' | 'inbox' | 'reported' | 'toolCalls' | 'iterations'> & {
    controller: AbortController
  }) => void
  update: (id: string, patch: Partial<AgentTask>) => void
  finish: (id: string, patch: { status: AgentTaskStatus; output?: string; error?: string; endedAt: number }) => void
  /** Nachricht des Hauptagenten an eine laufende Aufgabe. */
  post: (id: string, message: string) => boolean
  /** Posteingang leeren und zurückgeben — der Lauf liest ihn genau einmal. */
  drainInbox: (id: string) => string[]
  cancel: (id: string) => boolean
  /** Alle Aufgaben einer Konversation abbrechen (der Elternlauf wurde gestoppt). */
  cancelAll: (convId: string) => number
  /** Fertige, noch nicht gemeldete Aufgaben — und sie gelten danach als gemeldet. */
  takeUnreported: (convId: string) => AgentTask[]
  get: (id: string) => AgentTask | undefined
  forConv: (convId: string) => AgentTask[]
  clearConv: (convId: string) => void
}

/** Die eine Stelle, an der eine Aufgabe über alle Konversationen gefunden wird. */
function locate(byConv: Record<string, AgentTask[]>, id: string): { convId: string; index: number } | null {
  for (const [convId, list] of Object.entries(byConv)) {
    const index = list.findIndex((t) => t.id === id)
    if (index >= 0) return { convId, index }
  }
  return null
}

export const useAgentTaskStore = create<AgentTaskState>((set, get) => ({
  byConv: {},

  start: ({ controller, ...task }) => {
    controllers.set(task.id, controller)
    set((s) => {
      const list = s.byConv[task.convId] ?? []
      const voll: AgentTask = {
        ...task,
        status: 'running',
        inbox: [],
        reported: false,
        toolCalls: 0,
        iterations: 0,
      }
      return { byConv: { ...s.byConv, [task.convId]: applyTaskRing([...list, voll]) } }
    })
  },

  update: (id, patch) => set((s) => {
    const wo = locate(s.byConv, id)
    if (!wo) return s
    const list = s.byConv[wo.convId].slice()
    list[wo.index] = { ...list[wo.index], ...patch }
    return { byConv: { ...s.byConv, [wo.convId]: list } }
  }),

  finish: (id, patch) => {
    controllers.delete(id)
    set((s) => {
      const wo = locate(s.byConv, id)
      if (!wo) return s
      const list = s.byConv[wo.convId].slice()
      // Der Posteingang wird beim Beenden geleert: was niemand mehr liest,
      // soll auch nicht als ungelesen dastehen.
      list[wo.index] = { ...list[wo.index], ...patch, inbox: [] }
      return { byConv: { ...s.byConv, [wo.convId]: applyTaskRing(list) } }
    })
  },

  post: (id, message) => {
    const t = get().get(id)
    if (!t || isTerminal(t.status)) return false
    get().update(id, { inbox: [...t.inbox, message] })
    return true
  },

  drainInbox: (id) => {
    const t = get().get(id)
    if (!t || !t.inbox.length) return []
    const posteingang = t.inbox
    get().update(id, { inbox: [] })
    return posteingang
  },

  cancel: (id) => {
    const c = controllers.get(id)
    // Der Zustand wird hier NICHT auf 'cancelled' gesetzt. Das tut der Lauf
    // selbst, wenn sein Signal feuert — sonst zeigte das Panel "abgebrochen",
    // während im Hintergrund noch gerechnet wird. Eine Anzeige, die dem
    // Wunsch statt der Wirklichkeit folgt, ist schlimmer als gar keine.
    if (!c) return false
    c.abort()
    return true
  },

  cancelAll: (convId) => {
    let n = 0
    for (const t of get().forConv(convId)) {
      if (t.status === 'running' && get().cancel(t.id)) n++
    }
    return n
  },

  takeUnreported: (convId) => {
    const fertig = get().forConv(convId).filter((t) => isTerminal(t.status) && !t.reported)
    if (!fertig.length) return []
    set((s) => ({
      byConv: {
        ...s.byConv,
        [convId]: (s.byConv[convId] ?? []).map((t) =>
          fertig.some((f) => f.id === t.id) ? { ...t, reported: true } : t,
        ),
      },
    }))
    // Die zurueckgegebenen Zeilen tragen `reported: true`, nicht den Stand von
    // vor dem Schreiben. Vorher waren es Schnappschuesse mit `false` darin —
    // heute harmlos, weil renderTaskReport nur id/status/output/error liest,
    // aber ein Aufrufer, der die Objekte behaelt, laese eine Zahl, die im
    // Store schon nicht mehr gilt. Eine Rueckgabe, die dem Speicher
    // widerspricht, ist eine Falle mit Verfallsdatum.
    return fertig.map((t) => ({ ...t, reported: true }))
  },

  get: (id) => {
    const wo = locate(get().byConv, id)
    return wo ? get().byConv[wo.convId][wo.index] : undefined
  },

  forConv: (convId) => get().byConv[convId] ?? [],

  clearConv: (convId) => {
    // ABBRECHEN, dann vergessen — in dieser Reihenfolge.
    //
    // Die erste Fassung loeschte nur die Controller-Eintraege. Ein Agent, der
    // gerade Werkzeuge auf der Maschine des Nutzers fuhr, lief dann weiter,
    // waehrend seine Zeile aus dem Panel verschwand: kein Stopp-Knopf mehr,
    // keine Spur, und beim Beenden schreibt er in einen Store, der ihn nicht
    // mehr kennt. Ein geloeschter Chat muss seine Agenten mitnehmen.
    for (const t of get().forConv(convId)) {
      if (t.status === 'running') controllers.get(t.id)?.abort()
      controllers.delete(t.id)
    }
    set((s) => {
      const rest = { ...s.byConv }
      delete rest[convId]
      return { byConv: rest }
    })
  },
}))

/** Nur für Tests: die Controller-Karte ist Modulzustand, kein Store-Zustand. */
export function _controllerCount(): number {
  return controllers.size
}
