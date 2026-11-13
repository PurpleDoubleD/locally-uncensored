/**
 * Die Zeilen, die frueher IM Eingabefeld standen.
 *
 * 21.09.2026, am echten Windows-Bau, mehrfach und veraergert: „NICHTS
 * im prompt fenster!" Gemeint ist woertlich alles, was ueber, in oder
 * unmittelbar an der Eingabezeile hing. Gemessen am Bau stand dort unter
 * anderem eine Leiste mit x und dem Satz „…is gone from the model list, so
 * the chat switched to…", also ein Hinweis mitten im Kasten, in den der
 * Nutzer gerade schreiben wollte.
 *
 * Kein Hinweis geht dabei verloren, er zieht um. Meldungen ZUM MODELL gehen
 * in den Modellwaehler (`ModelSelector`, oben im Aufklapper, plus Punkt am
 * Knopf). Fehler EINER Nachricht stehen seit jeher an der Nachricht. Was
 * danach uebrig bleibt, landet hier und wird oben im Verlauf gezeigt
 * (`ChatNotices`), als ruhige Zeile mit x.
 *
 * Warum ein Speicher und keine Requisite: die beiden Zeilen, die hier
 * wirklich durchmuessen, entstehen im Composer selbst (ein angehaengtes PDF,
 * ein Bild an einem blinden Modell) und werden eine Etage hoeher gezeichnet.
 * Alles, was der Verlauf ohnehin schon weiss (die Wartezeile der lokalen
 * Spur, der Retrieval-Fehler), geht NICHT durch diesen Speicher, sondern
 * wird dort direkt gezeichnet. Ein Briefkasten fuer Nachrichten, die es
 * ohnehin gibt, waere ein Umweg mit zwei Wahrheiten.
 *
 * Ausdruecklich KEIN allgemeines Toastsystem: es gibt in dieser App keins
 * (nachgesehen am 21.09.2026), und eins zu erfinden, um drei Zeilen
 * umzuhaengen, waere mehr Bauwerk als Befund. Es gibt einen Platz, eine
 * Form, und jede Zeile hat einen Namen.
 */

import { create } from 'zustand'
import type { HinweisTon } from '../lib/hinweis'
import { useChatStore } from './chatStore'

/** Die Zeilen, die es gibt. Kein freier Schluessel: eine Aufzaehlung laesst
 *  sich nachzaehlen, ein String-Schluessel waechst unbemerkt. */
export type ChatNoticeId = 'document-belongs-in-docs' | 'model-cannot-see-images' | 'image-attach' | 'file-attach' | 'binary-summary-only' | 'file-cut' | 'agent-outside-workspace' | 'agent-for-local-files' | 'create-save'

export interface ChatNotice {
  id: ChatNoticeId
  text: string
  ton: HinweisTon
}

/** Wie lange eine Zeile steht, bevor sie sich selbst raeumt. Dieselben acht
 *  Sekunden, die der Anhang-Hinweis im Composer hatte. */
export const CHAT_NOTICE_MS = 8_000

interface ChatNoticeState {
  notices: ChatNotice[]
  /**
   * Zeigen. Derselbe Name zweimal ersetzt die Zeile, statt sie zu stapeln.
   *
   * `ttlMs` ist fuer Zeilen ueber ein EREIGNIS ("diese Datei ist zu gross"):
   * die sind nach dem Lesen erledigt. Eine Zeile ueber einen
   * ZUSTAND ("dieses Modell sieht keine Bilder") bekommt keine Uhr, sonst
   * ginge sie weg, waehrend sie noch stimmt; sie wird von dem geraeumt, der
   * sie gesetzt hat, sobald der Zustand endet.
   */
  show: (id: ChatNoticeId, text: string, ton?: HinweisTon, ttlMs?: number) => void
  /** Wegdruecken, von Hand oder von der Uhr. */
  dismiss: (id: ChatNoticeId) => void
  clear: () => void
}

/** Die laufenden Uhren, damit ein zweites `show` die erste nicht weiterlaufen
 *  laesst und eine spaete Uhr keine frische Zeile abraeumt. */
const uhren = new Map<ChatNoticeId, ReturnType<typeof setTimeout>>()

function uhrStoppen(id: ChatNoticeId): void {
  const t = uhren.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    uhren.delete(id)
  }
}

export const useChatNoticeStore = create<ChatNoticeState>((set, get) => ({
  notices: [],
  show: (id, text, ton = 'ruhig', ttlMs) => {
    uhrStoppen(id)
    set((s) => ({ notices: [...s.notices.filter((n) => n.id !== id), { id, text, ton }] }))
    if (ttlMs === undefined) return
    uhren.set(id, setTimeout(() => { uhren.delete(id); get().dismiss(id) }, ttlMs))
  },
  dismiss: (id) => {
    uhrStoppen(id)
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
  },
  clear: () => {
    for (const id of [...uhren.keys()]) uhrStoppen(id)
    set({ notices: [] })
  },
}))

/**
 * Zeilen ueber die LETZTE Nachricht einer Unterhaltung. Sie gehoeren zu dieser
 * Unterhaltung: in der 3.0.4-Box blieb "The agent can only open files in this
 * chat's folder" in einem neuen Chat mit ausgeschaltetem Agent stehen.
 */
export const CONVERSATION_BOUND: ReadonlySet<ChatNoticeId> = new Set(['agent-outside-workspace', 'agent-for-local-files', 'binary-summary-only', 'file-cut'])

// Wechselt die Unterhaltung, gehen sie. Von "keine" zur gerade angelegten
// nicht: das ist dieselbe Unterhaltung, die erste Nachricht legt sie erst an.
useChatStore.subscribe((s, prev) => {
  if (prev.activeConversationId === null || s.activeConversationId === prev.activeConversationId) return
  for (const id of CONVERSATION_BOUND) useChatNoticeStore.getState().dismiss(id)
})
