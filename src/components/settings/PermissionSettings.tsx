import { usePermissionStore } from '../../stores/permissionStore'
import type { ToolCategory, PermissionLevel } from '../../api/mcp/types'
import { FolderOpen, Terminal, Monitor, Globe, Cpu, Image, Film, GitBranch } from 'lucide-react'

// Image generation is fully wired in the chat agent path and shares the exact
// confirm-gate the live `video` category uses, but this selector stayed locked
// ("Coming Soon") on the desktop, so users could not switch image gen to Auto.
// That was konata's "you cannot change image generation to auto accept" (web
// app, 2026-06-23), unlocked for WEB only at the time with the note that the
// desktop .exe keeps 2.5.5 behavior "until a desktop release flips it there
// too". 2.5.9 is that release: the lock is gone on both surfaces, matching
// PermissionOverrideBar, which has had an empty LOCKED set all along.
//
// `video` was missing from this list entirely even though it is a real category
// with a real permission (live since 2.5.3) — so the chat bar could toggle it
// while Settings could not see it. Added.

const CATEGORIES: {
  key: ToolCategory
  label: string
  description: string
  icon: typeof FolderOpen
  risk: 'low' | 'medium' | 'high'
}[] = [
  { key: 'web', label: 'Web Access', description: 'Search & fetch web pages', icon: Globe, risk: 'low' },
  { key: 'system', label: 'System Info', description: 'OS info, process list', icon: Cpu, risk: 'low' },
  { key: 'filesystem', label: 'Filesystem', description: 'Read, write, search files anywhere', icon: FolderOpen, risk: 'medium' },
  { key: 'image', label: 'Image Generation', description: 'Generate images', icon: Image, risk: 'medium' },
  { key: 'video', label: 'Video Generation', description: 'Generate video', icon: Film, risk: 'medium' },
  { key: 'workflow', label: 'Workflows', description: 'Execute saved agent workflows', icon: GitBranch, risk: 'medium' },
  { key: 'terminal', label: 'Terminal / Shell', description: 'Execute commands, run code', icon: Terminal, risk: 'high' },
  { key: 'desktop', label: 'Desktop Control', description: 'Screenshots, screen interaction', icon: Monitor, risk: 'high' },
]

// Eine Leiter, eine Achse: Risiko waechst, also waechst Rot. Die mittlere
// Stufe war gelb, und Gelb heisst in dieser Oberflaeche nichts mehr, seit es
// fuenf verschiedene Dinge gleichzeitig hiess (lib/hinweis.ts). Ein
// abgeschwaechtes Rot sagt dasselbe wie das volle, nur leiser, und braucht
// dafuer keinen dritten Farbton.
const RISK_COLORS = {
  low: 'bg-green-500',
  medium: 'bg-red-500/50',
  high: 'bg-red-500',
}

const LEVEL_OPTIONS: { value: PermissionLevel; label: string }[] = [
  { value: 'blocked', label: 'Blocked' },
  { value: 'confirm', label: 'Ask First' },
  { value: 'auto', label: 'Auto' },
]

export function PermissionSettings() {
  const { globalPermissions, setGlobalPermission, resetToDefaults } = usePermissionStore()

  return (
    <div className="space-y-2">
      <p className="text-[0.6rem] text-gray-500 mb-3">
        Control what the Agent can access. Per-category permissions apply to all tools in that category.
      </p>

      {CATEGORIES.map(({ key, label, description, icon: Icon, risk }) => {
        return (
          <div
            key={key}
            className="flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors bg-white/[0.02] border-white/[0.06] hover:border-white/10"
          >
            {/* Risk dot */}
            <div className={`w-1.5 h-1.5 rounded-full ${RISK_COLORS[risk]} shrink-0`} />

            {/* Icon */}
            <Icon size={14} className="text-gray-500 shrink-0" />

            {/* Label + Description */}
            <div className="flex-1 min-w-0">
              <p className="text-[0.7rem] text-gray-300 font-medium">{label}</p>
              <p className="text-[0.55rem] text-gray-600 truncate">{description}</p>
            </div>

            {/* Permission Level Selector */}
            <div className="flex gap-0.5 shrink-0">
              {LEVEL_OPTIONS.map(({ value, label: lvlLabel }) => {
                const isActive = globalPermissions[key] === value
                return (
                  <button
                    key={value}
                    onClick={() => setGlobalPermission(key, value)}
                    // "Ask First" war gelb und sah damit aus wie eine Warnung,
                    // obwohl es die vorsichtigste der drei Einstellungen ist.
                    // Rot und Gruen sind hier schon vergeben, Blau nicht, und
                    // Blau traegt in den Einstellungen ohnehin die neutralen
                    // Knoepfe (der Installierknopf im Speech-Abschnitt).
                    className={`px-2 py-0.5 rounded text-[0.55rem] font-medium transition-all ${
                      isActive
                        ? value === 'blocked'
                          ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                          : value === 'confirm'
                            ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                            : 'bg-green-500/15 text-green-400 border border-green-500/30'
                        : 'text-gray-600 hover:text-gray-400 border border-transparent'
                    }`}
                  >
                    {lvlLabel}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      <button
        onClick={resetToDefaults}
        className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors mt-2"
      >
        Reset to defaults
      </button>
    </div>
  )
}
