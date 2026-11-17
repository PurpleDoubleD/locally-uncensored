/**
 * Agent fragt im Chat, wo er arbeiten soll (3.1.2).
 *
 * Bis 3.1.1 ging beim Einschalten von Agent Mode ein Dialog auf (Sandbox oder
 * Ordner). David wollte das umgekehrt: Agent laesst sich einfach einschalten,
 * und erst die erste Nachricht in diesem Chat fuehrt zur Frage, und zwar im
 * Verlauf, als Karte im Stil der Werkzeugkarten. Die Nachricht selbst bleibt
 * stehen und laeuft nach der Wahl genau so weiter, als waere die Frage nie
 * gestellt worden.
 *
 * Was sich NICHT aendert: die Wahl gilt je Chat (`agentModeStore.workspaces`),
 * ein gemerkter Vorgabeordner wird vor dem Ueberspringen gefragt
 * (`rememberedFolderRefusal`), der Ordnerwaehler bleibt der native Dialog mit
 * `asWorkspace: true` und seinen Ablehnungen. Auf dem Handy gibt es keinen
 * Ordner, dort wird nie gefragt (`setWorkspace` nimmt dort ohnehin nur die
 * Sandbox).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import { safeJSONStorage } from './storage-quota'
import { isMobile } from './device-kind'
import { useAgentModeStore } from '../stores/agentModeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useChatStore } from '../stores/chatStore'
import { rememberedFolderRefusal } from '../api/agents/workspace-validate'
import type { AgentWorkspace } from '../types/agent-workspace'
import type { ImageAttachment } from '../types/chat'
import type { ChatFileInput } from './chat-files'
import type { PendingMedia } from './create/chat-attachments'

/** Eine offene Frage in einem Chat. */
export interface WorkspaceAsk {
  /** Die geparkten Nutzernachrichten, in der Reihenfolge, in der sie kamen. */
  messageIds: string[]
  /** Warum ein gemerkter Vorgabeordner nicht genommen wurde, sonst null. */
  error: string | null
}

/** Was nicht in eine Nachricht passt (Dateien, Clips): nur im Speicher. */
interface Extras { files?: ChatFileInput[]; media?: PendingMedia[] }
const extras = new Map<string, Extras>()

interface AskState {
  asks: Record<string, WorkspaceAsk>
  park: (conversationId: string, messageId: string, error: string | null) => void
  clear: (conversationId: string) => void
}

/**
 * Gespeichert, damit die Frage einen Neustart uebersteht: sonst stuende die
 * Nachricht nach einem Neuladen im Verlauf, und nichts wuerde sie je senden.
 */
export const useWorkspaceAskStore = create<AskState>()(
  persist(
    (set) => ({
      asks: {},
      park: (conversationId, messageId, error) =>
        set((s) => {
          const prev = s.asks[conversationId]
          return {
            asks: {
              ...s.asks,
              [conversationId]: {
                messageIds: [...(prev?.messageIds ?? []), messageId],
                error: prev?.error ?? error,
              },
            },
          }
        }),
      clear: (conversationId) =>
        set((s) => {
          if (!s.asks[conversationId]) return s
          const next = { ...s.asks }
          delete next[conversationId]
          return { asks: next }
        }),
    }),
    { name: 'locally-uncensored-workspace-ask', storage: safeJSONStorage() },
  ),
)

/**
 * Muss dieser Chat vor dem ersten Agentenzug fragen? `null` heisst nein.
 * Sonst der Grund, warum ein gemerkter Vorgabeordner nicht taugt, oder ''
 * fuer die gewoehnliche erste Frage.
 *
 * Dieselbe Weiche wie frueher `maybeOpenWorkspaceDialog` in
 * AgentModeToggle: ein Ordner je Chat gewinnt, ein gemerkter Vorgabeordner
 * wird gefragt, bevor er die Frage ersetzt.
 */
export async function workspaceAskNeeded(conversationId: string): Promise<string | null> {
  if (isMobile()) return null
  if (useAgentModeStore.getState().workspaces[conversationId]) return null
  const fallback = useSettingsStore.getState().settings.defaultWorkspace
  if (fallback) {
    if (fallback.kind !== 'folder' || !fallback.path) return null
    const refusal = await rememberedFolderRefusal(fallback.path)
    return refusal ?? null
  }
  return ''
}

/** Steht in diesem Chat schon eine Frage offen? */
export function hasOpenAsk(conversationId: string): boolean {
  return !!useWorkspaceAskStore.getState().asks[conversationId]
}

/**
 * Parkt eine Nutzernachricht vor der Frage. Sie steht sofort im Verlauf, wie
 * jede gesendete Nachricht; gesendet wird sie erst nach der Wahl.
 */
export function parkForWorkspaceAsk(
  conversationId: string,
  content: string,
  reason: string,
  images?: ImageAttachment[],
  files?: ChatFileInput[],
  media?: PendingMedia[],
): void {
  const id = uuid()
  useChatStore.getState().addMessage(conversationId, {
    id, role: 'user', content, timestamp: Date.now(),
    ...(images?.length ? { images } : {}),
  })
  if (files?.length || media?.length) extras.set(id, { files, media })
  useWorkspaceAskStore.getState().park(conversationId, id, reason || null)
}

export type Resend = (
  content: string,
  images?: ImageAttachment[],
  files?: ChatFileInput[],
  media?: PendingMedia[],
) => unknown

/**
 * Die Wahl ist gefallen: Ordner setzen, die geparkte Nachricht aus dem
 * Verlauf nehmen und genau sie wieder senden. Der Sendeweg legt sie dabei
 * neu an, so steht sie am Ende einmal da und nicht doppelt.
 *
 * Mehrere geparkte Nachrichten (jemand schrieb weiter, statt zu waehlen)
 * gehen als eine hinaus, in ihrer Reihenfolge: zwei Agentenzuege
 * nacheinander anzustossen wuerde den zweiten an der Sperre fuer laufende
 * Zuege verlieren.
 */
export async function resolveWorkspaceAsk(
  conversationId: string,
  workspace: AgentWorkspace,
  resend: Resend,
): Promise<void> {
  const ask = useWorkspaceAskStore.getState().asks[conversationId]
  useAgentModeStore.getState().setWorkspace(conversationId, workspace)
  if (!ask) return
  useWorkspaceAskStore.getState().clear(conversationId)
  const chat = useChatStore.getState()
  const messages = chat.conversations.find((c) => c.id === conversationId)?.messages ?? []
  const parked = ask.messageIds
    .map((id) => messages.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
  const texts: string[] = []
  const images: ImageAttachment[] = []
  const files: ChatFileInput[] = []
  const media: PendingMedia[] = []
  for (const m of parked) {
    if (m.content) texts.push(m.content)
    if (m.images?.length) images.push(...m.images)
    const x = extras.get(m.id)
    if (x?.files) files.push(...x.files)
    if (x?.media) media.push(...x.media)
    extras.delete(m.id)
    chat.deleteMessage(conversationId, m.id)
  }
  if (!texts.length && !images.length && !files.length && !media.length) return
  await resend(
    texts.join('\n\n'),
    images.length ? images : undefined,
    files.length ? files : undefined,
    media.length ? media : undefined,
  )
}

/** Nur fuer Tests. */
export function __resetWorkspaceAskForTests(): void {
  extras.clear()
  useWorkspaceAskStore.setState({ asks: {} })
}
