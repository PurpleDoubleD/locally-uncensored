import { useState } from 'react'
import { Folder, Shield, Check, Plus, X } from 'lucide-react'
import { HowItWorks } from '../ui/HowItWorks'
import { HOWTO } from '../../lib/howto'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { backendCall } from '../../api/backend'
import { rememberedFolderRefusal } from '../../api/agents/workspace-validate'
import type { AgentWorkspace } from '../../types/agent-workspace'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { pathKey } from '../../lib/dev-fs-jail'

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
  /**
   * Warum dieser Dialog ueberhaupt aufgeht. Gesetzt, wenn der gemerkte
   * Vorgabeordner die Pruefung der Rust-Seite nicht bestanden hat: dann wird
   * er NICHT gesetzt, und der Nutzer soll den Grund lesen, statt vor einem
   * Dialog zu stehen, der ohne Anlass erscheint.
   */
  initialError?: string | null
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
  initialError,
}: Props) {
  const lastFolder = useAgentModeStore((s) => s.lastFolder)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)
  // Re-opened on an existing folder chat → jump straight to the extras
  // manager. Fresh activation → null → kind picker (folder pick commits).
  const [draft, setDraft] = useState<AgentWorkspace | null>(
    initialWorkspace && initialWorkspace.kind === 'folder' ? initialWorkspace : null,
  )
  const [rememberAsDefault, setRememberAsDefault] = useState(false)
  // Der gemerkte Vorgabeordner, als Pfad. null, wenn keiner gemerkt ist.
  const rememberedDefault = useSettingsStore(
    (s) => (s.settings.defaultWorkspace?.kind === 'folder' ? s.settings.defaultWorkspace.path : null),
  )

  const handleSandbox = () => {
    setError(null)
    onChoose({ kind: 'sandbox' })
  }

  const handleUseLast = async () => {
    if (!lastFolder) return
    setError(null)
    // Der gemerkte Ordner wird GEFRAGT, nicht geglaubt. Dieser Knopf ist kein
    // Dialog: kommt der Pfad aus einer frischen Installation, aus geleerten
    // Daten oder liegt er direkt unter $HOME, kennt die Erlaubnisliste ihn
    // nicht, und gesetzt wuerde er jede spaetere Dateioperation mit einem Satz
    // beantworten, den hier niemand befolgen kann. Abgelehnt heisst: nicht
    // gesetzt, Grund sichtbar, und der Weg heraus ist der Dialog darunter.
    setPicking(true)
    const refusal = await rememberedFolderRefusal(lastFolder)
    setPicking(false)
    if (refusal) {
      setError(refusal)
      return
    }
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
      //
      // `asWorkspace: true` (Fehler D): eine Wurzel, die die Rust-Seite nicht
      // annimmt, kommt jetzt als Fehler zurueck und landet im Kasten darunter,
      // statt als Pfad ausgeliefert zu werden, den spaeter jede
      // Dateioperation mit "pick it again to allow it" beantwortet.
      const res = await backendCall<string | null>('pick_folder', { asWorkspace: true })
      if (res) {
        // Commit + close right after the folder is chosen. Picking IS the
        // decision — the dialog must go away (2026-06-06). Multi-repo
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
      // Ein Zusatzpfad ist genauso eine Kaefigwurzel wie der Hauptordner, also
      // dieselbe Meldung (Fehler D).
      const res = await backendCall<string | null>('pick_folder', { asWorkspace: true })
      if (!res) {
        setPicking(false)
        return
      }
      setDraft((d) => {
        if (!d || d.kind !== 'folder') return d
        const extras = d.extraPaths ?? []
        // R2-41: a raw string compare missed the same folder picked with a
        // different case or trailing slash on Windows (`D:\code` vs
        // `d:/CODE/`); `pathKey` is the same normalization the workspace
        // dedup in agent-context.ts uses.
        const key = pathKey(res)
        if (extras.some((p) => pathKey(p) === key) || (d.path && key === pathKey(d.path))) return d
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

  // GH #223 (07.11.2026): wer einmal einen Ordner gewaehlt hatte, kam an den
  // Hauptordner nicht mehr heran. Der Dialog sprang beim Wiederoeffnen in die
  // Zusatzordner, und dort liessen sich nur Extras hinzufuegen und entfernen.
  // Jetzt laesst sich der Hauptordner tauschen, ein Extra zum Hauptordner
  // machen und der Hauptordner entfernen.
  const handleChangePrimary = async () => {
    setPicking(true)
    setError(null)
    try {
      const res = await backendCall<string | null>('pick_folder', { asWorkspace: true })
      if (!res) return
      setDraft((d) => {
        if (!d || d.kind !== 'folder') return d
        const key = pathKey(res)
        // Der neue Hauptordner stand vielleicht schon als Extra da: dann nicht doppelt.
        return { ...d, path: res, extraPaths: (d.extraPaths ?? []).filter((p) => pathKey(p) !== key) }
      })
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Folder picker unavailable (bridge offline?)',
      )
    } finally {
      setPicking(false)
    }
  }

  /** Tauscht: das Extra wird Hauptordner, der bisherige Hauptordner ein Extra. */
  const handleMakePrimary = (path: string) => {
    setDraft((d) => {
      if (!d || d.kind !== 'folder') return d
      const rest = (d.extraPaths ?? []).filter((p) => p !== path)
      return { ...d, path, extraPaths: d.path ? [d.path, ...rest] : rest }
    })
  }

  /**
   * Gibt es Extras, rueckt das erste nach. Ohne Extras geht es zurueck zur
   * Auswahl (Sandbox, letzter Ordner, anderer Ordner); Abbrechen laesst dann
   * alles, wie es war.
   */
  const handleRemovePrimary = () => {
    setDraft((d) => {
      if (!d || d.kind !== 'folder') return d
      const [next, ...rest] = d.extraPaths ?? []
      return next ? { ...d, path: next, extraPaths: rest } : null
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
    <Modal open={open} onClose={onClose} title={phase === 'pick' ? 'Where should the agent work?' : 'Workspace folders'} ariaLabel="Agent workspace">
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-[0.7rem] text-gray-500">
            {phase === 'pick'
              ? 'Pick a folder to edit your real files, or use a separate workspace for this chat. You can change this later.'
              : 'Primary anchors relative paths, change or remove it here. Extras give the agent absolute access, perfect for "sync the API in repo-A with the client in repo-B".'}
          </p>
          <p className="text-[0.7rem] text-gray-500" data-testid="workspace-security-boundary">
            Workspace protection is a folder path jail, not a container or virtual machine.
            Commands run on this computer. Review tool requests before allowing them.
          </p>
          {HOWTO.sandbox && <HowItWorks topic="sandbox" variant="line" placement="below-end" />}
        </div>

        {/* Drei Wahlmoeglichkeiten, drei Farben, und keine davon sagt etwas
            ueber Gefahr aus: sie halten die Zeilen nur auseinander. Der Ordner
            trug Gelb und las sich damit wie eine Warnung vor der eigenen
            Auswahl. Violett war in diesem Dialog noch frei, Gruen und Blau
            haengen an den beiden Zeilen darueber, Rot am Entfernen-Knopf und
            an der Fehlerzeile (`lib/hinweis.ts`). */}
        {phase === 'pick' && (
          <div className="space-y-2" data-testid="agent-workspace-options">
            <WorkspaceOption
              icon={<Shield size={16} className="text-emerald-500" />}
              title="Sandbox"
              body="Separate folder under ~/agent-workspace/, protected by the file tool path jail."
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
              icon={<Folder size={16} className="text-purple-500" />}
              title={picking ? 'Opening picker…' : 'Pick a folder…'}
              body="Choose a real directory. The agent edits files in there directly, like the Coding Agent."
              onClick={handlePick}
              disabled={picking}
            />
          </div>
        )}

        {/* Der Hauptordner steht jetzt im selben neutralen Rahmen wie die
            Zusatzordner darunter. Sein gelber Kasten hat einen ausgewaehlten
            Pfad wie eine Warnmeldung aussehen lassen; unterschieden wird er
            durch die Beschriftung, nicht durch die Farbe. */}
        {phase === 'extras' && draft?.kind === 'folder' && (
          <div className="space-y-2" data-testid="agent-workspace-extras">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-white/10 px-3 py-2" data-testid="agent-workspace-primary">
              <div className="flex-1 min-w-0">
                <div className={`text-[0.55rem] uppercase tracking-widest ${HINWEIS_TEXT.ruhig} mb-0.5`}>
                  Primary
                </div>
                <div className="text-[0.7rem] font-mono text-gray-800 dark:text-gray-200 truncate">
                  {draft.path}
                </div>
              </div>
              <button
                type="button"
                onClick={handleChangePrimary}
                disabled={picking}
                className="shrink-0 t-micro text-gray-500 underline hover:text-gray-800 dark:hover:text-white disabled:opacity-50"
                data-testid="agent-workspace-change-primary"
              >
                Change…
              </button>
              <button
                type="button"
                onClick={handleRemovePrimary}
                disabled={picking}
                title="Remove"
                aria-label="Remove primary folder"
                className="p-1 rounded hover:bg-red-500/10 text-red-500 disabled:opacity-50"
                data-testid="agent-workspace-remove-primary"
              >
                <X size={11} />
              </button>
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
                  type="button"
                  onClick={() => handleMakePrimary(p)}
                  className="shrink-0 t-micro text-gray-500 underline hover:text-gray-800 dark:hover:text-white"
                  data-testid="agent-workspace-make-primary"
                >
                  Make primary
                </button>
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
              <span className="t-micro text-gray-600 dark:text-gray-400">
                Remember as default. Future chats open here without asking.
              </span>
            </label>

            {/* Die zweite Haelfte des Berichts vom 01.09.2026: "Ordner wechseln
                loest es nicht". Ein einmal gemerkter Vorgabeordner ueberspringt
                die Frage in JEDEM neuen Agentenchat, und es gab keine Stelle,
                an der man ihn wieder los wurde. Der Satz sagt, was gespeichert
                ist, der Knopf loescht es. */}
            {rememberedDefault && (
              <div className="flex items-center justify-between gap-2 pt-1" data-testid="agent-workspace-default-note">
                <span className="t-micro text-gray-500 truncate">
                  Every new agent chat opens in {rememberedDefault} without asking.
                </span>
                <button
                  type="button"
                  onClick={() => useSettingsStore.getState().updateSettings({ defaultWorkspace: null })}
                  className="shrink-0 t-micro text-gray-500 underline hover:text-gray-800 dark:hover:text-white"
                  data-testid="agent-workspace-forget-default"
                >
                  Forget it
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="t-micro text-red-500">{error}</p>
        )}

        <ModalActions>
          <ModalButton variant="quiet" onClick={onClose} data-conversation-id={conversationId}>
            Cancel
          </ModalButton>
          {phase === 'extras' && (
            <ModalButton variant="primary" onClick={handleSave} data-testid="agent-workspace-save">
              Save
            </ModalButton>
          )}
        </ModalActions>
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
        <span className="block text-[12px] font-medium text-gray-900 dark:text-white">
          {title}
        </span>
        <span
          className={`block t-micro text-gray-500 truncate ${
            monoBody ? 'font-mono' : ''
          }`}
        >
          {body}
        </span>
      </span>
    </button>
  )
}
