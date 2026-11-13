import { useMemo } from 'react'
import { resolveWorkspace, resolveWorkspacePath } from '../api/agents/workspace-resolve'
import { resolveCodexWorkspace } from './codex/workspace-precedence'
import { useAgentModeStore } from '../stores/agentModeStore'
import { useChatStore } from '../stores/chatStore'
import { useCodexStore } from '../stores/codexStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { MentionRoot } from '../lib/file-mentions'

/**
 * Which folder the `@` list of a composer reads (U8). The SAME precedence the
 * run uses, so the list never shows files of a folder the model does not
 * work in:
 *
 *   Code tab: hooks/codex/workspace-precedence.ts (Explorer pick first).
 *   Chat:     api/agents/workspace-resolve.ts (folder pinned on this chat,
 *             then the default folder).
 *
 * Without a real folder, Agent mode and Code fall back to the per-chat
 * sandbox once a run of this chat has named it (the slug is pinned then);
 * looking never creates one. Plain chat offers mentions only when a real
 * folder is known: it has no sandbox of its own.
 *
 * Returns null when nothing can be listed (the popup says so) and undefined
 * when this surface has no mentions at all.
 */
export function useMentionRoot(surface: 'code' | 'agent' | 'chat'): MentionRoot | null | undefined {
  const conversationId = useChatStore((s) => s.activeConversationId)
  const perChat = useAgentModeStore((s) => (conversationId ? s.workspaces[conversationId] : undefined))
  const slug = useAgentModeStore((s) => (conversationId ? s.workspaceSlugs?.[conversationId] : undefined))
  const defaultWorkspace = useSettingsStore((s) => s.settings.defaultWorkspace)
  const threadDir = useCodexStore((s) => (conversationId ? s.threads[conversationId]?.workingDirectory : undefined))
  const storeDir = useCodexStore((s) => s.workingDirectory)

  return useMemo(() => {
    if (surface === 'code') {
      const { workDir } = resolveCodexWorkspace({
        threadWorkingDirectory: threadDir,
        codexWorkspace: resolveWorkspace({ perChat, defaultWorkspace }),
        storeWorkingDirectory: storeDir,
      })
      if (workDir && workDir !== '.') return { workingDirectory: workDir }
      return slug ? { chatId: slug } : null
    }
    const folder = resolveWorkspacePath({ perChat, defaultWorkspace })
    if (folder) return { workingDirectory: folder }
    if (surface === 'agent') return slug ? { chatId: slug } : null
    return undefined
  }, [surface, threadDir, perChat, defaultWorkspace, storeDir, slug])
}
