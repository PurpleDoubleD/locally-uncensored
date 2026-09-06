import { MessageSquare, Code } from 'lucide-react'
import { useCodexStore } from '../../stores/codexStore'
import type { ChatMode } from '../../types/codex'

const TABS: { mode: ChatMode; label: string; icon: typeof Code; disabled?: boolean; tag?: string }[] = [
  { mode: 'lu', label: 'LU', icon: MessageSquare },
  // 'codex' is the internal mode id; the user-facing label is "Code".
  { mode: 'codex', label: 'Code', icon: Code },
]

export function ChatModeTabs() {
  const chatMode = useCodexStore((s) => s.chatMode)
  const setChatMode = useCodexStore((s) => s.setChatMode)

  return (
    <div className="flex items-center gap-0.5 px-2 py-0.5">
      {TABS.map(({ mode, label, icon: Icon, disabled, tag }) => {
        const isActive = chatMode === mode
        return (
          <button
            key={mode}
            onClick={() => !disabled && setChatMode(mode)}
            disabled={disabled}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[0.55rem] font-medium transition-colors ${
              isActive
                ? 'bg-white/10 text-white border border-white/15'
                : disabled
                  ? 'text-gray-700 cursor-default'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5 border border-transparent'
            }`}
          >
            <Icon size={9} />
            <span>{label}</span>
            {tag && <span className="text-[0.45rem] text-gray-600 ml-0.5">{tag}</span>}
          </button>
        )
      })}
    </div>
  )
}
