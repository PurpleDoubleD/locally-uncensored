import { useState } from 'react'
import { Folder, Shield, Check, Plus, X } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { backendCall } from '../../api/backend'
import type { AgentWorkspace } from '../../types/agent-workspace'

interface Props {
  open: boolean
  conversationId: string
  /** Called with the chosen workspace; parent persists + closes. */
  onChoose: (workspace: AgentWorkspace) => void
  onClose: () => void
  /**
   * When set to an existing FOLDER workspace, the dialog opens straight into
   * the multi-repo "extras" manager for it (used by the workspace badge so a
   * folder chat can add repos / set remember-as-default later). Omitted on the
   * first agent activation → the dialog starts at the kind picker, and picking
   * a folder there commits immediately (no second confirmation step).
   */
  initialWorkspace?: AgentWorkspace | null
}

/**
 * Asks the user where this agent chat should operate on disk. Shown once
 * per chat when agent mode is enabled and no workspace has been picked
 * yet. Re-openable later from the agent-mode bar.
 *
 * Two phases:
 *   1. Pick a workspace kind (Sandbox / Use last folder / Pick folder).
 *   2. (Folder only) Optionally add more repos so the agent can sync
 *      multiple checkouts at once — primary stays the resolution anchor
 *      for relative paths; extras land in the system prompt as absolute
 *      paths the model can address directly.
 */
export function AgentWorkspaceDialog({
  open,
  conversationId,
  onChoose,
  onClose,
  initialWorkspace,
}: Props) {
  const lastFolder = useAgentModeStore((s) => s.lastFolder)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Re-opened on an existing folder chat → jump straight to the extras
  // manager. Fresh activation → null → kind picker (folder pick commits).
  const [draft, setDraft] = useState<AgentWorkspace | null>(
    initialWorkspace && initialWorkspace.kind === 'folder' ? initialWorkspace : null,
  )
  const [rememberAsDefault, setRememberAsDefault] = useState(false)

  const handleSandbox = () => {
    setError(null)
    onChoose({ kind: 'sandbox' })
  }

  const handleUseLast = () => {
    if (!lastFolder) return
    setError(null)
    // Selecting a folder IS the decision — commit + close (parity with Sandbox).
    onChoose({ kind: 'folder', path: lastFolder, extraPaths: [] })
  }

  const handlePick = async () => {
    setPicking(true)
    setError(null)
    try {
      // pick_folder returns the chosen path as a STRING (or null on cancel) —
      // NOT an object. Reading res.path here was the real bug: it was always
      // undefined, so onChoose never fired and the dialog never closed.
      const res = await backendCall<string | null>('pick_folder', {})
      if (res) {
        // Commit + close right after the folder is chosen. Picking IS the
        // decision — the dialog must go away (David 2026-06-06). Multi-repo
        // extras / remember-as-default are managed later via the badge.
        onChoose({ kind: 'folder', path: res, extraPaths: [] })
        return
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Folder picker unavailable (bridge offline?)',
      )
    }
    // Only reached on cancel/error — the dialog stays open.
    setPicking(false)
  }

  const handleAddExtra = async () => {
    setPicking(true)
    setError(null)
    try {
      // pick_folder returns the path as a STRING (or null), not an object.
      const res = await backendCall<string | null>('pick_folder', {})
      if (!res) {
        setPicking(false)
        return
      }
      setDraft((d) => {
        if (!d || d.kind !== 'folder') return d
        const extras = d.extraPaths ?? []
        if (extras.includes(res) || res === d.path) return d
        return { ...d, extraPaths: [...extras, res] }
      })
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Folder picker unavailable (bridge offline?)',
      )
    } finally {
      setPicking(false)
    }
  }

  const handleRemoveExtra = (path: string) => {
    setDraft((d) => {
      if (!d || d.kind !== 'folder') return d
      return { ...d, extraPaths: (d.extraPaths ?? []).filter((p) => p !== path) }
    })
  }

  const handleSave = () => {
    if (!draft) return
    if (rememberAsDefault && draft.kind === 'folder' && draft.path) {
      useSettingsStore.getState().updateSettings({ defaultWorkspace: draft })
    }
    onChoose(draft)
  }

  const phase: 'pick' | 'extras' = draft ? 'extras' : 'pick'

  return (
    <Modal open={open} onClose={onClose} title="" ariaLabel="Agent workspace">
      <div className="space-y-4">
        <div className="text-center space-y-1">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            {phase === 'pick' ? 'Where should the agent work?' : 'Add more repos?'}
          </h3>
          <p className="text-[0.7rem] text-gray-500">
            {phase === 'pick'
              ? 'Pick a folder to edit your real files, or use a sandbox to keep this chat isolated. You can change this later.'
              : 'Primary anchors relative paths. Extras give the agent absolute access, perfect for "sync the API in repo-A with the client in repo-B".'}
          </p>
        </div>

        {phase === 'pick' && (
          <div className="space-y-2" data-testid="agent-workspace-options">
            <WorkspaceOption
              icon={<Shield size={16} className="text-emerald-500" />}
              title="Sandbox"
              body="Isolated workspace under ~/agent-workspace/. Nothing outside it can be touched."
              onClick={handleSandbox}
              disabled={picking}
            />

            {lastFolder && (
              <WorkspaceOption
                icon={<Check size={16} className="text-blue-500" />}
                title="Use last folder"
                body={lastFolder}
                monoBody
                onClick={handleUseLast}
                disabled={picking}
              />
            )}

            <WorkspaceOption
              icon={<Folder size={16} className="text-amber-500" />}
              title={picking ? 'Opening picker…' : 'Pick a folder…'}
              body="Choose a real directory. The agent edits files in there directly, like the Coding Agent."
              onClick={handlePick}
              disabled={picking}
            />
          </div>
        )}

        {phase === 'extras' && draft?.kind === 'folder' && (
          <div className="space-y-2" data-testid="agent-workspace-extras">
            <div className="rounded-lg border border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/[0.04] px-3 py-2">
              <div className="text-[0.55rem] uppercase tracking-widest text-amber-700 dark:text-amber-300/80 mb-0.5">
                Primary
              </div>
              <div className="text-[0.7rem] font-mono text-gray-800 dark:text-gray-200 truncate">
                {draft.path}
              </div>
            </div>

            {(draft.extraPaths ?? []).map((p) => (
              <div
                key={p}
                className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-white/10 px-3 py-2"
              >
                <span className="text-[0.7rem] font-mono text-gray-700 dark:text-gray-300 truncate flex-1 min-w-0">
                  {p}
                </span>
                <button
                  onClick={() => handleRemoveExtra(p)}
                  title="Remove"
                  className="p-1 rounded hover:bg-red-500/10 text-red-500"
                >
                  <X size={11} />
                </button>
              </div>
            ))}

            <button
              onClick={handleAddExtra}
              disabled={picking}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-300 dark:border-white/10 text-[0.7rem] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-white/[0.04] disabled:opacity-50"
              data-testid="agent-workspace-add-extra"
            >
              <Plus size={11} /> {picking ? 'Opening picker…' : 'Add another repo'}
            </button>

            <label className="flex items-center gap-2 pt-1 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberAsDefault}
                onChange={(e) => setRememberAsDefault(e.target.checked)}
                className="w-3 h-3"
                data-testid="agent-workspace-remember-default"
              />
              <span className="text-[0.65rem] text-gray-600 dark:text-gray-400">
                Remember as default. Future chats open here without asking.
              </span>
            </label>
          </div>
        )}

        {error && (
          <p className="text-[0.65rem] text-red-500 text-center">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-[0.7rem] text-gray-500 hover:text-gray-800 dark:hover:text-white transition-colors"
            data-conversation-id={conversationId}
          >
            Cancel
          </button>
          {phase === 'extras' && (
            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded-lg text-[0.7rem] font-medium bg-emerald-500 hover:bg-emerald-600 text-white transition-colors"
              data-testid="agent-workspace-save"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

interface OptionProps {
  icon: React.ReactNode
  title: string
  body: string
  monoBody?: boolean
  onClick: () => void
  disabled?: boolean
}

function WorkspaceOption({ icon, title, body, monoBody, onClick, disabled }: OptionProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.02] hover:bg-gray-50 dark:hover:bg-white/[0.04] transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-[0.75rem] font-medium text-gray-900 dark:text-white">
          {title}
        </span>
        <span
          className={`block text-[0.65rem] text-gray-500 truncate ${
            monoBody ? 'font-mono' : ''
          }`}
        >
          {body}
        </span>
      </span>
    </button>
  )
}
