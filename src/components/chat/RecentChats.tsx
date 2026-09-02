/**
 * The recent-chats list on the empty chat screen.
 *
 * Ported from apps/web/components/chat/CloudLauncher.tsx:66-115. David asked
 * for the web behaviour: while the side panel is collapsed the latest chats
 * live in the main area, and the moment the panel is expanded they belong to
 * the panel again and disappear from here. ChatView owns that condition; this
 * component is only the list.
 */
import { motion } from 'framer-motion'
import { MessageSquare } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useUIStore } from '../../stores/uiStore'
import { useCodexStore } from '../../stores/codexStore'
import { timeAgo } from '../../lib/time-ago'

/** Same cut as the web list: plain chats only, newest first, eight rows. */
const MAX_ROWS = 8

export function RecentChats() {
  const conversations = useChatStore((s) => s.conversations)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setView = useUIStore((s) => s.setView)
  const setChatMode = useCodexStore((s) => s.setChatMode)

  const recents = conversations
    .filter((c) => (c.mode ?? 'lu') === 'lu')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ROWS)

  // Opening a row is the same three steps as in the web launcher: back to
  // plain chat mode, select the conversation, land on the chat view.
  const openChat = (id: string) => {
    setChatMode('lu')
    setActiveConversation(id)
    setView('chat')
  }

  if (recents.length === 0) {
    return (
      <p data-testid="home-recent-chats" className="text-[0.7rem] text-gray-400 dark:text-gray-500">
        No chats yet.
      </p>
    )
  }

  return (
    <motion.div
      data-testid="home-recent-chats"
      className="w-full max-w-[340px]"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
    >
      <div className="mb-1 px-1 text-[0.58rem] font-medium uppercase tracking-[0.08em] text-gray-400 dark:text-gray-600">
        Recent chats
      </div>
      <ul>
        {recents.map((c, i) => (
          <motion.li
            key={c.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: 0.03 + i * 0.03, ease: 'easeOut' }}
          >
            <button
              type="button"
              onClick={() => openChat(c.id)}
              className="w-full flex items-center gap-2 rounded-md px-1.5 py-[5px] text-left hover:bg-gray-50 dark:hover:bg-white/[0.04] transition-colors"
            >
              <MessageSquare size={11} className="shrink-0 text-gray-300 dark:text-gray-600" />
              <span className="flex-1 truncate text-[0.7rem] text-gray-600 dark:text-gray-300">
                {c.title}
              </span>
              <span className="shrink-0 text-[0.6rem] tabular-nums text-gray-300 dark:text-gray-600">
                {timeAgo(c.updatedAt)}
              </span>
            </button>
          </motion.li>
        ))}
      </ul>
    </motion.div>
  )
}
