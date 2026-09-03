import { usePermissionStore } from '../../stores/permissionStore'
import { useChatStore } from '../../stores/chatStore'
import type { ToolCategory } from '../../api/mcp/types'
import { useToolSupport } from '../../hooks/useToolSupport'
import { FolderOpen, Terminal, Monitor, Globe, Cpu, Image, Film, GitBranch, Lock } from 'lucide-react'

// Image AND video generation are LIVE (chat agent → ComfyUI; video unlocked
// in v2.5.3 — T2V via Wan/Hunyuan/AnimateDiff, I2V via SVD/FramePack). The
// LOCKED set stays as the mechanism for future not-yet-shipped categories.
const LOCKED: Set<ToolCategory> = new Set()

const CATEGORIES: { key: ToolCategory; icon: typeof Globe; label: string }[] = [
  { key: 'web', icon: Globe, label: 'Web' },
  { key: 'system', icon: Cpu, label: 'System' },
  { key: 'filesystem', icon: FolderOpen, label: 'Files' },
  { key: 'terminal', icon: Terminal, label: 'Shell' },
  { key: 'desktop', icon: Monitor, label: 'Screenshot' },
  { key: 'image', icon: Image, label: 'Image' },
  { key: 'video', icon: Film, label: 'Video' },
  { key: 'workflow', icon: GitBranch, label: 'Workflows' },
]

export function PermissionOverrideBar() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const { getEffectivePermissions, setConversationOverride } = usePermissionStore()
  // 2.5.9: a model that cannot call tools makes every row here a lie — flipping
  // one on changed nothing except how long the failure took to arrive.
  const { canUseTools, reason } = useToolSupport()

  if (!activeConversationId) return null

  const permissions = getEffectivePermissions(activeConversationId)

  const toggleTool = (cat: ToolCategory) => {
    if (LOCKED.has(cat) || !canUseTools) return
    const current = permissions[cat]
    setConversationOverride(activeConversationId, cat, current === 'blocked' ? 'auto' : 'blocked')
  }

  return (
    <div>
      {!canUseTools && (
        <div className="px-1.5 py-1 text-[0.5rem] leading-snug text-amber-600 dark:text-amber-400/90">
          {reason}
        </div>
      )}
      {CATEGORIES.map(({ key, icon: Icon, label }) => {
        const isLocked = LOCKED.has(key)
        const isDisabled = isLocked || !canUseTools
        const isOn = !isDisabled && permissions[key] !== 'blocked'
        return (
          <button
            key={key}
            onClick={() => toggleTool(key)}
            disabled={isDisabled}
            title={!canUseTools ? reason : undefined}
            className={`flex items-center gap-1.5 w-full px-1.5 py-[3px] text-[0.5rem] transition-colors ${
              isDisabled
                ? 'text-gray-400 dark:text-gray-700 cursor-default'
                : isOn
                  ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5'
                  : 'text-gray-400 dark:text-gray-600 hover:bg-gray-100 dark:hover:bg-white/5'
            }`}
          >
            {isLocked ? (
              <Lock size={8} className="text-gray-700" />
            ) : (
              <Icon size={8} className={isOn ? 'text-green-400' : 'text-gray-600'} />
            )}
            <span className={`flex-1 text-left ${isLocked ? 'line-through' : ''}`}>{label}</span>
            {isLocked ? (
              <span className="text-[0.45rem] text-gray-700">soon</span>
            ) : (
              <div className={`w-1 h-1 rounded-full ${isOn ? 'bg-green-400' : 'bg-gray-700'}`} />
            )}
          </button>
        )
      })}
    </div>
  )
}
