import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Search, MessageSquare, Trash2, Edit3, Check, X } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { formatDate, truncate } from '../../lib/formatters'

export function Sidebar() {
  const { conversations, activeConversationId, createConversation, deleteConversation, renameConversation, setActiveConversation } = useChatStore()
  const { sidebarOpen, setView } = useUIStore()
  const { activeModel } = useModelStore()
  const { getActivePersona } = useSettingsStore()
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const filtered = search
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(search.toLowerCase()) ||
          c.messages.some((m) => m.content.toLowerCase().includes(search.toLowerCase()))
      )
    : conversations

  const handleNewChat = () => {
    const persona = getActivePersona()
    if (activeModel) {
      createConversation(activeModel, persona?.systemPrompt || '')
      setView('chat')
    }
  }

  const handleRename = (id: string) => {
    if (editTitle.trim()) {
      renameConversation(id, editTitle.trim())
    }
    setEditingId(null)
  }

  return (
    <AnimatePresence>
      {sidebarOpen && (
        <motion.aside
          className="w-72 h-full border-r border-gray-200 dark:border-white/[0.06] bg-gray-50 dark:bg-[#0e0e0e] flex flex-col z-20 overflow-hidden"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 288, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="p-3 space-y-3">
            <button
              onClick={handleNewChat}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg bg-gray-200 dark:bg-white/[0.08] border border-gray-300 dark:border-white/[0.1] text-gray-800 dark:text-white hover:bg-gray-300 dark:hover:bg-white/[0.12] transition-all"
            >
              <Plus size={18} />
              <span className="text-sm font-medium">New Chat</span>
            </button>

            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                placeholder="Search conversations..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-gray-100 dark:bg-white/[0.04] border border-gray-300 dark:border-white/[0.08] text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2 space-y-0.5 scrollbar-thin">
            {filtered.map((conv) => (
              <motion.div
                key={conv.id}
                className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                  conv.id === activeConversationId
                    ? 'bg-gray-200 dark:bg-white/[0.08] border border-gray-300 dark:border-white/[0.1]'
                    : 'hover:bg-gray-100 dark:hover:bg-white/[0.04] border border-transparent'
                }`}
                onClick={() => {
                  setActiveConversation(conv.id)
                  setView('chat')
                }}
                layout
              >
                <MessageSquare size={16} className="text-gray-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  {editingId === conv.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleRename(conv.id)}
                        className="w-full bg-white/10 rounded px-1 py-0.5 text-sm text-white focus:outline-none"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button onClick={(e) => { e.stopPropagation(); handleRename(conv.id) }} className="text-green-400" aria-label="Confirm rename"><Check size={14} /></button>
                      <button onClick={(e) => { e.stopPropagation(); setEditingId(null) }} className="text-gray-400" aria-label="Cancel rename"><X size={14} /></button>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-gray-800 dark:text-white truncate">{truncate(conv.title, 30)}</p>
                      <p className="text-xs text-gray-500">{formatDate(conv.updatedAt)}</p>
                    </>
                  )}
                </div>
                {editingId !== conv.id && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingId(conv.id)
                        setEditTitle(conv.title)
                      }}
                      className="p-1 rounded hover:bg-white/10 text-gray-400"
                      aria-label="Rename conversation"
                    >
                      <Edit3 size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteConversation(conv.id)
                      }}
                      className="p-1 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-400"
                      aria-label="Delete conversation"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </motion.div>
            ))}

            {filtered.length === 0 && (
              <p className="text-center text-gray-500 text-sm py-8">
                {search ? 'No results found' : 'No conversations yet'}
              </p>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
