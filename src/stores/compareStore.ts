import { create } from 'zustand'
import type { Message, MessageError } from '../types/chat'
import { useUIStore } from './uiStore'

interface ModelStats {
  tokens: number
  timeMs: number
  tokensPerSec: number
}

interface CompareState {
  isComparing: boolean
  modelA: string
  modelB: string
  messagesA: Message[]
  messagesB: Message[]
  statsA: ModelStats | null
  statsB: ModelStats | null
  isStreamingA: boolean
  isStreamingB: boolean
  setComparing: (on: boolean) => void
  setModelA: (name: string) => void
  setModelB: (name: string) => void
  addContentA: (content: string) => void
  addContentB: (content: string) => void
  startRound: (userMessage: Message) => void
  /**
   * End a side's turn. A side whose request failed passes `stats: null` and
   * its `error`: the column then shows why it did not answer instead of an
   * empty answer under "0.0 t/s", which read like a result (C5).
   */
  finishA: (content: string, stats: ModelStats | null, error?: MessageError) => void
  finishB: (content: string, stats: ModelStats | null, error?: MessageError) => void
  setStreamingA: (on: boolean) => void
  setStreamingB: (on: boolean) => void
  reset: () => void
}

export const useCompareStore = create<CompareState>()((set) => ({
  isComparing: false,
  modelA: '',
  modelB: '',
  messagesA: [],
  messagesB: [],
  statsA: null,
  statsB: null,
  isStreamingA: false,
  isStreamingB: false,

  setComparing: (on) => set({ isComparing: on }),
  setModelA: (name) => set({ modelA: name }),
  setModelB: (name) => set({ modelB: name }),

  addContentA: (content) => set((s) => {
    const msgs = [...s.messagesA]
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = { ...last, content: last.content + content }
    }
    return { messagesA: msgs }
  }),

  addContentB: (content) => set((s) => {
    const msgs = [...s.messagesB]
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = { ...last, content: last.content + content }
    }
    return { messagesB: msgs }
  }),

  startRound: (userMessage) => set((s) => ({
    messagesA: [...s.messagesA, userMessage, { id: `a-${Date.now()}`, role: 'assistant', content: '', timestamp: Date.now() }],
    messagesB: [...s.messagesB, userMessage, { id: `b-${Date.now()}`, role: 'assistant', content: '', timestamp: Date.now() }],
    statsA: null,
    statsB: null,
    isStreamingA: true,
    isStreamingB: true,
  })),

  finishA: (content, stats, error) => set((s) => {
    const msgs = [...s.messagesA]
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = error ? { ...last, content, error } : { ...last, content }
    }
    return { messagesA: msgs, statsA: stats, isStreamingA: false }
  }),

  finishB: (content, stats, error) => set((s) => {
    const msgs = [...s.messagesB]
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = error ? { ...last, content, error } : { ...last, content }
    }
    return { messagesB: msgs, statsB: stats, isStreamingB: false }
  }),

  setStreamingA: (on) => set({ isStreamingA: on }),
  setStreamingB: (on) => set({ isStreamingB: on }),

  reset: () => set({
    messagesA: [],
    messagesB: [],
    statsA: null,
    statsB: null,
    isStreamingA: false,
    isStreamingB: false,
  }),
}))

/**
 * „Compare" einschalten. Das ist kein View, sondern ein Flag PLUS ein Wechsel
 * nach Chat — die A/B-Spalten übernehmen den Chatbereich. Diese zwei Zeilen
 * standen im Header zweimal wörtlich da (Leiste und Überlaufmenü); die
 * Kommandopalette wäre die dritte Abschrift geworden. Jetzt rufen alle drei
 * dieselbe Funktion.
 */
export function openCompare(): void {
  useCompareStore.getState().setComparing(true)
  useUIStore.getState().setView('chat')
}
