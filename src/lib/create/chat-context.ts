// What a conversation has in media, as material for handles, and the
// environment of the two chat tools.
//
// The desktop twin of the web app. Not mirrored: this
// is the file that names the app's own stores and routes. Same shape, same
// rules: the attachments are the images, clips and sound tracks of the
// customer's messages in this conversation, the gallery is the Create tab's,
// the results are the finished runs of this conversation's orders.

import { v4 as uuid } from 'uuid'
import { useChatStore } from '../../stores/chatStore'
import { useCreateStore } from '../../stores/createStore'
import { useCreateOrderStore } from '../../stores/createOrderStore'
import { galleryLabel } from '../render/gallery-label'
import { checkPromptSafety } from '../render/safety'
import { cloudFetch } from '../../api/cloud/client'
import { getQuota } from '../../api/cloud/jobs'
import { listLoras } from '../../api/cloud/loras'
import { loadContentPolicy } from './bridge/content-policy'
import type { HandleAttachment, HandleContext } from './handles'
import type { CreateToolEnv } from './chat-tools'
import { messageMediaBlob } from './chat-attachments'
import { CREATE_CHAT_ORIGIN, originHeaders } from './chat-origin'

export function chatHandleContext(conversationId: string, now = Date.now()): Omit<HandleContext, 'items'> {
  const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId)
  const attachments: HandleAttachment[] = []
  for (const m of conv?.messages ?? []) {
    if (m.role !== 'user') continue
    const images = m.images ?? []
    images.forEach((img, i) => {
      if (img.mimeType.startsWith('image/')) {
        attachments.push({ messageId: m.id, index: i + 1, mimeType: img.mimeType, name: img.name, data: img.data })
      }
    })
    // Clips and sound tracks count on behind the images. The session holds
    // their bytes (chat-attachments.ts); after a restart they are gone, and
    // the handle then says the file has to be attached again.
    ;(m.media ?? []).forEach((file, i) => {
      attachments.push({
        messageId: m.id, index: images.length + i + 1, mimeType: file.mimeType, name: file.name, kind: file.kind,
        blob: messageMediaBlob(m.id, i),
      })
    })
  }
  // Only what the cloud made: a local render has no job on the server that a
  // run could take as an input (handles.ts, isCloud).
  const gallery = useCreateStore.getState().gallery
    .filter((g) => !!g.jobId)
    .map((g) => ({
      id: g.id,
      jobId: g.jobId,
      kind: g.type,
      remoteUrl: g.remoteUrl,
      createdAt: g.createdAt,
      title: galleryLabel(g),
    }))
  return { results: useCreateOrderStore.getState().results(conversationId), gallery, attachments, now }
}

/** The environment of the two tools in the chat: the real stores and routes.
 *  The conversation is the one of the running turn (api/agent-context.ts). */
export function defaultCreateToolEnv(conversationId: string | null): CreateToolEnv {
  const policy = () => loadContentPolicy()
  return {
    conversationId,
    handles: () => chatHandleContext(conversationId ?? ''),
    openAllowed: async () => (await policy()) === 'off',
    checkSafety: async () => {
      const p = await policy()
      return (text: string, negative?: string) => checkPromptSafety(text, { tier: 'cloud', policy: p, negative })
    },
    characters: async () => {
      try {
        return (await listLoras()).map((l) => ({ id: l.id, name: l.name, family: l.base_family }))
      } catch {
        return []
      }
    },
    credits: async () => {
      try {
        return (await getQuota()).remaining.credits
      } catch {
        return null
      }
    },
    spentBefore: (id) => useCreateOrderStore.getState().spent(id),
    // The price request of an order names the chat as its origin, like its
    // runs (stores/createOrderStore.ts cloudOrderDeps). It goes through
    // cloudFetch: base address, bearer token, deadline.
    priceDeps: {
      fetch: (url, init) => cloudFetch(url, {
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), ...originHeaders(CREATE_CHAT_ORIGIN) },
      }),
    },
    addOrder: (order) => useCreateOrderStore.getState().add(order),
    newId: () => uuid(),
    now: () => Date.now(),
  }
}
