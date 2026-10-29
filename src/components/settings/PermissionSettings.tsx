import { usePermissionStore } from '../../stores/permissionStore'
import type { ToolCategory, PermissionLevel } from '../../api/mcp/types'
import { FolderOpen, Terminal, Monitor, Globe, Cpu, Image, Film, GitBranch, Plug, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useComputerStore } from '../../stores/computerStore'
import { useModelStore } from '../../stores/modelStore'
import { forgetAlwaysAllowedApp } from '../../api/computer-use'
import { executorCandidates, modelSeesImages } from '../../api/computer-executor'
import { getComputerStatus } from '../../api/computer'
import { isMacOS } from '../../api/backend'
import { ComputerPermissionRows, PERMISSION_STALE_HINT, allPermissionsGranted, useComputerPermissions } from '../computer/ComputerPermissions'
import { useGraphicsCardGb } from '../../hooks/useGraphicsMemory'
import {
  BETA_SCREEN_MODEL_NOTE,
  BETA_SCREEN_MODEL_TAG,
  chatScreenModelHint,
  betaScreenModel,
  separateScreenModelHint,
  separateScreenModelTag,
} from '../../lib/computer/screen-model-hint'
import { Select, type SelectOption } from '../create/ui/Select'
import { displayModelName } from '../../api/providers'
import { ToggleSwitch } from '../ui/ToggleSwitch'
import { computerOffLimitsLine } from '../../lib/mac-pc-words'
import { BetaMark } from '../ui/BetaMark'
import { betaNote, computerControlMacNote } from '../../lib/beta'
import { declaredVision } from '../../lib/model-compatibility'

// Image generation is fully wired in the chat agent path and shares the exact
// confirm-gate the live `video` category uses, but this selector stayed locked
// ("Coming Soon") on the desktop, so users could not switch image gen to Auto.
// That was a user's "you cannot change image generation to auto accept" (web
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
  // "anywhere" stimmte nie: die Dateiwerkzeuge bleiben im Arbeitsordner des
  // Chats, der Sandbox oder dem Ordner aus dem Dialog (resolve_path in
  // commands/filesystem.rs). Discord 28.09.2026: alles auf Auto und
  // trotzdem kein Zugriff auf die eigenen Dateien.
  // Confirm fragt nur vor dem Schreiben: Lesen im eigenen Ordner laeuft ohne
  // Karte (WORKSPACE_READ_TOOLS, Gegenprobe 01.10.2026), das sagt der Satz.
  { key: 'filesystem', label: 'Filesystem', description: "Read, write, search files in the chat's working folder. Reading there never asks", icon: FolderOpen, risk: 'medium' },
  { key: 'image', label: 'Image Generation', description: 'Generate images', icon: Image, risk: 'medium' },
  { key: 'video', label: 'Video Generation', description: 'Generate video', icon: Film, risk: 'medium' },
  // B12: MCP tools hingen frueher an dieser Zeile, ohne dass es dastand.
  { key: 'workflow', label: 'Workflows', description: 'Saved agent workflows and sub agents. Not MCP server tools', icon: GitBranch, risk: 'medium' },
  // Eigene Zeile fuer jedes Werkzeug eines MCP-Servers: ein Server kann
  // Befehle ausfuehren und Dateien schreiben, und Terminal oder Filesystem
  // decken ihn nicht ab. Darum steht sie per Vorgabe auf Ask First.
  { key: 'mcp', label: 'MCP / External Tools', description: 'Every tool of a connected MCP server, including ones that run commands or write files', icon: Plug, risk: 'high' },
  { key: 'terminal', label: 'Terminal / Shell', description: 'Execute commands, run code', icon: Terminal, risk: 'high' },
  { key: 'desktop', label: 'Desktop Control', description: 'Screenshots. Blocked also switches computer control off', icon: Monitor, risk: 'high' },
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
  const computerEnabled = useComputerStore((s) => s.enabled)
  const setComputerEnabled = useComputerStore((s) => s.setEnabled)
  const alwaysAllowed = useComputerStore((s) => s.alwaysAllowed)

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
            <div className="flex gap-0.5 shrink-0" role="group" aria-label={label}>
              {LEVEL_OPTIONS.map(({ value, label: lvlLabel }) => {
                const isActive = globalPermissions[key] === value
                return (
                  <button
                    key={value}
                    onClick={() => setGlobalPermission(key, value)}
                    aria-pressed={isActive}
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

      {/* Computer control. Off until the user turns it on: while it is off the
          tool is not offered to any model, so existing chats do not change. */}
      <div className="mt-3 px-3 py-2 rounded-lg border bg-white/[0.02] border-white/[0.06]" data-testid="computer-control-settings">
        <div className="flex items-center gap-3">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          <Monitor size={14} className="text-gray-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="t-body text-gray-300 font-medium flex items-center gap-1.5">
              <span>Computer control</span>
              <BetaMark feature="computer-control" />
            </p>
            <p className="t-micro text-gray-600">
              Lets a model see your screen and use mouse and keyboard in apps you approve. You confirm every action unless you switch a session to autonomous.
            </p>
          </div>
          <ToggleSwitch enabled={computerEnabled} onChange={setComputerEnabled} ariaLabel="Computer control" />
        </div>
        {/* Said in the open here, not only on hover: this is the switch. */}
        {betaNote('computer-control') && (
          <p className="t-micro text-gray-600 mt-2" data-testid="computer-control-beta-note">{betaNote('computer-control')}</p>
        )}
        {computerControlMacNote(isMacOS()) && (
          <p className="t-micro text-gray-400 mt-2" data-testid="computer-control-mac-note">{computerControlMacNote(isMacOS())}</p>
        )}
        <p className="t-micro text-gray-600 mt-2">
          {computerOffLimitsLine(isMacOS())}
        </p>
        {computerEnabled && isMacOS() && <MacPermissions />}
        <ScreenModelPicker />
        <p className="t-micro text-gray-500 mt-2">Always allowed apps</p>
        {alwaysAllowed.length === 0 ? (
          <p className="t-micro text-gray-600">None. An app lands here when you choose "Always allow" in its question.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {alwaysAllowed.map((app) => (
              <li key={app.key} className="flex items-center gap-2">
                <span className="t-micro text-gray-300 min-w-0 truncate">{app.name}</span>
                <span className="t-micro font-mono text-gray-600 min-w-0 truncate flex-1">{app.key}</span>
                <button
                  onClick={() => void forgetAlwaysAllowedApp(app.key)}
                  aria-label={`Stop always allowing ${app.name}`}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded t-micro text-gray-500 hover:text-gray-300 border border-white/[0.06] hover:border-white/10"
                >
                  <X size={10} /> Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        onClick={resetToDefaults}
        className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors mt-2"
      >
        Reset to defaults
      </button>
    </div>
  )
}

/**
 * macOS grants computer control two permissions, and until it has, nothing
 * works. Shown right under the switch, so they can be granted before the
 * first task instead of in the middle of it. Gone once both are there.
 */
function MacPermissions() {
  const granted = useComputerPermissions(true)
  if (!granted || allPermissionsGranted(granted)) return null
  return (
    <div className="mt-2" data-testid="computer-permissions-settings">
      <p className="t-micro text-gray-400">macOS has to allow computer control before it works:</p>
      <ComputerPermissionRows granted={granted} className="mt-1.5" />
      <p className="t-micro text-gray-600 mt-1.5">{PERMISSION_STALE_HINT}</p>
    </div>
  )
}

const CHAT_MODEL = ''

/**
 * Which model looks at the screen during a task. The chat model does, also
 * when it cannot see: it then works from the element list of the window, and
 * is told so here. A second local model is offered with what it costs.
 */
function ScreenModelPicker() {
  const models = useModelStore((s) => s.models)
  const activeModel = useModelStore((s) => s.activeModel)
  const chosen = useComputerStore((s) => s.executorModel)
  const setExecutorModel = useComputerStore((s) => s.setExecutorModel)
  const cardGb = useGraphicsCardGb()
  const candidates = useMemo(() => executorCandidates(models), [models])
  // A choice that left the list (a deleted download) counts as no choice,
  // which is also how a task treats it.
  const picked = chosen ? candidates.find((c) => c.name === chosen) ?? null : null
  const value = picked ? picked.name : CHAT_MODEL
  // The answer belongs to the model it was asked for. Until it is in, nothing is claimed.
  const chatDeclares = useModelStore((s) => declaredVision(s.models.find((m) => m.name === s.activeModel)))
  const [checked, setChecked] = useState<{ model: string; sees: boolean } | null>(null)
  const chatSees = checked && checked.model === activeModel ? checked.sees : null
  const [treeAvailable, setTreeAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    if (!activeModel) return
    let current = true
    const note = (sees: boolean) => { if (current) setChecked({ model: activeModel, sees }) }
    void modelSeesImages(activeModel).then(note, () => note(false))
    return () => { current = false }
    // Asked again when the list changes its mind about the model: an image
    // part that was just added turns a model that could not see into one
    // that can, under the same name.
  }, [activeModel, chatDeclares])

  useEffect(() => {
    let current = true
    void getComputerStatus().then(
      (status) => { if (current) setTreeAvailable(status.ok && status.treeAvailable) },
      () => { if (current) setTreeAvailable(false) },
    )
    return () => { current = false }
  }, [])

  const options = useMemo<SelectOption[]>(() => {
    const tag = separateScreenModelTag(cardGb)
    const marks = (name: string, separate: boolean) => {
      const tags = [
        ...(separate && tag ? [{ label: tag, tone: 'quiet' as const }] : []),
        ...(betaScreenModel(name) ? [{ label: BETA_SCREEN_MODEL_TAG, tone: 'quiet' as const }] : []),
      ]
      return tags.length > 0 ? tags : undefined
    }
    const note = (name: string, text: string | null) =>
      [text, betaScreenModel(name) ? BETA_SCREEN_MODEL_NOTE : null].filter(Boolean).join(' ') || undefined
    return [
      { value: CHAT_MODEL, label: 'Same as the chat model' },
      // The chat model picked by name is still one model: nothing to swap, nothing to warn about.
      ...candidates.filter((c) => c.where === 'local').map((c) => (c.name === activeModel
        ? { value: c.name, label: c.label, group: 'On this computer', title: note(c.name, null), tags: marks(c.name, false) }
        : {
            value: c.name, label: c.label, group: 'On this computer', title: note(c.name, separateScreenModelHint(cardGb)),
            tags: marks(c.name, true),
          })),
      ...candidates.filter((c) => c.where === 'cloud').map((c) => ({ value: c.name, label: c.label, group: 'LU Cloud' })),
    ]
  }, [candidates, cardGb, activeModel])

  const baseHint = picked && picked.name !== activeModel
    ? picked.where === 'local'
      ? separateScreenModelHint(cardGb)
      : 'It gets the screenshots and picks each click. The pictures of your screen go to LU Cloud for that.'
    : chatScreenModelHint({
        chatModel: activeModel ? displayModelName(activeModel) : null,
        sees: chatSees,
        treeAvailable,
      })
  // The model that does the looking, whether picked here or as the chat model.
  const looking = picked?.name ?? activeModel
  const hint = looking && betaScreenModel(looking) ? `${baseHint} ${BETA_SCREEN_MODEL_NOTE}` : baseHint

  return (
    <div className="mt-2" data-testid="computer-screen-model">
      <div className="flex items-center justify-between gap-2">
        <span className="t-micro text-gray-500">Model that looks at the screen</span>
        {/* The app's own list, a sheet that stays inside the window. */}
        <Select
          ariaLabel="Model that looks at the screen"
          options={options}
          value={value}
          onChange={(next) => setExecutorModel(next === CHAT_MODEL ? null : next)}
          size="sm"
          align="right"
          className="w-[230px] shrink-0"
        />
      </div>
      <p className="t-micro text-gray-600 mt-1" data-testid="computer-screen-model-hint">{hint}</p>
    </div>
  )
}
