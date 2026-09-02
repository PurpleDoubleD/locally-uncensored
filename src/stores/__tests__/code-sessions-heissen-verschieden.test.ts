/**
 * Eine Code-Sitzung traegt ihren eigenen Namen, nicht den ihrer Gattung.
 *
 * ── DER BEFUND ─────────────────────────────────────────────────────────────
 *
 * David am 02.09.2026: "Code bereich heisst im Chat immer nur Coding Chat. da
 * brauchen wir das selbe verhalten wie im normalen Chat, das sauber erkennbar
 * ist, welche Session, welche war."
 *
 * Nachgemessen in chatStore.ts. Zwei Stellen greifen ineinander:
 *
 *   createConversation  mode 'codex'  → title = 'Coding Agent'   (fest)
 *   addMessage          benennt um, WENN title === 'New Chat'
 *
 * Eine Code-Konversation startet also mit einem Titel, den die Umbenennung
 * nicht kennt, und behaelt ihn fuer immer. Zehn Code-Sitzungen heissen zehnmal
 * gleich; in der Seitenleiste stehen sie untereinander und sind nur noch am
 * Datum auseinanderzuhalten. Der normale Chat hat das Problem nicht, weil
 * 'New Chat' genau der Wert ist, auf den die Umbenennung horcht.
 *
 * ── WARUM DAS KEIN FLUECHTIGKEITSFEHLER WAR ────────────────────────────────
 *
 * Es gab dazu einen gruenen Test, chatStore-operations.test.ts, "does NOT
 * auto-rename Codex/Remote chats", mit dem Kommentar "auto-rename only kicks
 * on title === 'New Chat'". Der Test hat die EINSCHRAENKUNG zugesichert, nicht
 * eine Anforderung — er beschrieb, was der Code tut, und begruendete es mit
 * dem Code selbst. Solange er stand, sah die Stelle geprueft aus.
 *
 * Er ist jetzt umgeschrieben, und diese Datei sagt warum: die Bedingung haengt
 * ab jetzt am STANDARDTITEL DES MODUS, nicht an einer einzelnen Zeichenkette.
 *
 * ── WAS AUSDRUECKLICH NICHT MITGEAENDERT WURDE ─────────────────────────────
 *
 * Remote-Chats heissen weiter 'Remote Chat 1', '… 2', '… 3'. Sie tragen eine
 * laufende Nummer, sind also bereits unterscheidbar — das war eine bewusste
 * frühere Entscheidung ("Auto-number remote chats so users can distinguish
 * sessions in the sidebar"), und Davids Auftrag nannte den Code-Bereich. Die
 * Zusicherung unten haelt das fest, damit die Auslassung als Entscheidung
 * lesbar bleibt und nicht als vergessener Fall.
 *
 * Lauf: npx vitest run src/stores/__tests__/code-sessions-heissen-verschieden.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../chatStore'
import type { Message } from '../../types/chat'

const msg = (over: Partial<Message> = {}): Message => ({
  id: Math.random().toString(36).slice(2),
  role: 'user',
  content: 'hallo',
  timestamp: Date.now(),
  ...over,
})

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
})

const titelVon = (id: string) =>
  useChatStore.getState().conversations.find((c) => c.id === id)!.title

describe('Eine Code-Sitzung heisst nach ihrer ersten Nachricht', () => {
  it('uebernimmt den Titel aus der ersten Nutzernachricht — wie der normale Chat', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'codex')
    expect(titelVon(id)).toBe('Coding Agent')

    useChatStore.getState().addMessage(id, msg({ content: 'Build a website' }))
    expect(titelVon(id)).toBe('Build a website')
  })

  it('zwei Code-Sitzungen heissen verschieden — der eigentliche Zweck', () => {
    // Die Zusicherung, die Davids Satz woertlich nimmt: "das sauber erkennbar
    // ist, welche Session, welche war". Vorher waren beide 'Coding Agent'.
    const a = useChatStore.getState().createConversation('gemma4', '', 'codex')
    const b = useChatStore.getState().createConversation('gemma4', '', 'codex')
    useChatStore.getState().addMessage(a, msg({ content: 'fix the login redirect' }))
    useChatStore.getState().addMessage(b, msg({ content: 'add a dark mode toggle' }))

    expect(titelVon(a)).not.toBe(titelVon(b))
    expect(titelVon(a)).toBe('fix the login redirect')
    expect(titelVon(b)).toBe('add a dark mode toggle')
  })

  it('der normale Chat verhaelt sich unveraendert', () => {
    // Gegenprobe: die Aenderung darf den Weg, der schon funktionierte, nicht
    // anfassen. Ohne diese Zeile koennte die neue Bedingung den alten Fall
    // stillschweigend mitnehmen.
    const id = useChatStore.getState().createConversation('gemma4', '', 'lu')
    useChatStore.getState().addMessage(id, msg({ content: 'was ist ein Monade' }))
    expect(titelVon(id)).toBe('was ist ein Monade')
  })

  it('eine bereits umbenannte Sitzung wird NICHT ueberschrieben', () => {
    // Der Fall, an dem eine zu grosszuegige Bedingung zerbricht: wer seiner
    // Sitzung einen Namen gegeben hat, verliert ihn bei der naechsten
    // Nachricht nicht.
    const id = useChatStore.getState().createConversation('gemma4', '', 'codex')
    useChatStore.getState().renameConversation(id, 'Zahlungsfluss')
    useChatStore.getState().addMessage(id, msg({ content: 'und jetzt die Tests' }))
    expect(titelVon(id)).toBe('Zahlungsfluss')
  })

  it('eine Antwort des Modells benennt nichts um', () => {
    // Nur `role: 'user'` zaehlt. Sonst hiesse die Sitzung nach dem, was das
    // Modell zuerst gesagt hat.
    const id = useChatStore.getState().createConversation('gemma4', '', 'codex')
    useChatStore.getState().addMessage(id, msg({ role: 'assistant', content: 'Klar, ich fange an.' }))
    expect(titelVon(id)).toBe('Coding Agent')
  })

  it('Remote behaelt seine laufende Nummer — Entscheidung, kein vergessener Fall', () => {
    const a = useChatStore.getState().createConversation('gemma4', '', 'remote')
    const b = useChatStore.getState().createConversation('gemma4', '', 'remote')
    useChatStore.getState().addMessage(a, msg({ content: 'irgendwas' }))
    expect(titelVon(a)).toBe('Remote Chat 1')
    expect(titelVon(b)).toBe('Remote Chat 2')
    // Sie sind auch so unterscheidbar — das war der Grund fuer die Nummer.
    expect(titelVon(a)).not.toBe(titelVon(b))
  })
})
