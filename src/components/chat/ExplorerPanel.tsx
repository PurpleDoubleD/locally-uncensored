/**
 * The right column of the Code tab (2.6.6 C2 + C3): a real lazy file tree, the
 * preview of a clicked file underneath it, and at the BOTTOM the model's plan
 * plus the Approve-and-run card that goes with it.
 *
 * Both plan pieces are here because the prompt window is the prompt window and
 * shows nothing about plans (2026-08-22, fifth time of asking). They are
 * at the BOTTOM of the column rather than the top for the same reading, filed
 * the same day: opening the Code tab, the eye wants the files first, and a plan
 * sitting above the folder picker made no sense to him.
 *
 * What changed against the old FileTree:
 *   - Folders EXPAND in place. They used to replace the workspace root, which
 *     moved the agent's jail every time somebody browsed, and the way back was
 *     a string split on "/" that breaks on a Windows backslash (plan R2). The
 *     root is now set by the picker only, and every listing carries it as
 *     `workingDirectory`.
 *   - node_modules, .git, target and dist are filtered, and the backend's
 *     500-entry cap is shown instead of silently looking complete.
 *   - The panel is resizable and collapsible, and remembers both (uiStore).
 *
 * Like before, the panel calls `fs_list` DIRECTLY and never the model's tool
 * executor, so a model-supplied workingDirectory can never pick its own jail
 * root (security review 2.5.7).
 */

import { Fragment, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  ListTodo,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  FolderX,
} from 'lucide-react'
import { useCodexStore } from '../../stores/codexStore'
import { useAnyAgentLoopActive } from '../../stores/agentLoopStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore, clampExplorerWidth, isNarrowViewport } from '../../stores/uiStore'
import {
  CODEX_WORKDIR_LOCK_TITLE,
  codexBusyReason,
  codexFallbackLabel,
} from '../../lib/codex-workdir'
import { resolveWorkspacePath } from '../../api/agents/workspace-resolve'
import { rememberedFolderRefusal } from '../../api/agents/workspace-validate'
import { backendCall, isTauri, isMacOS } from '../../api/backend'
import {
  EMPTY_LISTING,
  EXPLORER_IGNORED,
  FS_LIST_CAP,
  flattenTree,
  loadChildren,
  toggleExpanded,
  type ExplorerListing,
  type ExplorerNode,
  type FsList,
} from '../../lib/explorer-tree'
import { PlanBar } from './PlanBar'
import { PlanApprovalBar } from './PlanApprovalBar'
import { FilePreview } from './FilePreview'
import { useChatStore } from '../../stores/chatStore'
import { useTodoStore } from '../../stores/todoStore'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { workspacePickRefusedMessage } from '../../lib/workspace-rejected'

const fsList: FsList = (args) => backendCall('fs_list', args as unknown as Record<string, unknown>)

interface Props {
  /** Runs the approved plan. Threaded in from CodexView, which owns the send. */
  onApprovePlan: (instruction: string) => void
}

export function ExplorerPanel({ onApprovePlan }: Props) {
  const root = useCodexStore((s) => s.workingDirectory)
  const setWorkingDirectory = useCodexStore((s) => s.setWorkingDirectory)
  const clearWorkingDirectory = useCodexStore((s) => s.clearWorkingDirectory)
  const fileTreeVersion = useCodexStore((s) => s.fileTreeVersion)

  // A8 (2.6.8): the folder is GLOBAL, so moving it mid-run would send the next
  // turn somewhere the user is not looking. Locked with a reason on the button
  // while that is the case, not hidden, and the SAME lock on both buttons: a
  // picker that stays free while Remove is held is the same hole (review S8).
  //
  // Only Coding Agent signals count. Reading every conversation's generating
  // flag locked this column whenever any Chat tab was streaming (review S3).
  //
  // Der Status eines Fadens allein ist kein Beweis, dass noch etwas laeuft:
  // Stop raeumt die Erzeugungsfahne sofort, der Status kommt erst zurueck,
  // wenn der Lauf sich abgewickelt hat. Beide Karten kommen deshalb herein und
  // werden in `codexBusyReason` versoehnt.
  const sendsInFlight = useCodexStore((s) => s.sendsInFlight)
  const threads = useCodexStore((s) => s.threads)
  const generating = useGenerationStore((s) => s.generating)
  // Read up here because the workspace fallback below needs it too. The plan
  // moved into this column, so a collapsed column would hide it, and with it
  // the only Approve-and-run button there is. The rail says so instead.
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  // The working directory is GLOBAL across every Codex conversation (A8), so
  // a loop running in ANY of them still must not have the folder yanked out
  // from under it, deliberately not scoped to the active conversation.
  const loop = useAnyAgentLoopActive()
  const lockReason = codexBusyReason({ sendsInFlight, threads, generating, loop })
  const lockTitle = lockReason ? CODEX_WORKDIR_LOCK_TITLE[lockReason] : null

  // Issue 309 T1: gegen das aktuelle Fenster geklemmt, nicht nur beim Ziehen.
  // Im schmalen Fenster ist das Panel zu (uiStore, NARROW_VIEWPORT_WIDTH);
  // klappt es dort jemand auf, liegt es UEBER dem Verlauf statt daneben, sonst
  // blieben dem Composer die ~25 px aus der Messung.
  const viewportWidth = useUIStore((s) => s.viewportWidth)
  const storedWidth = useUIStore((s) => s.explorerWidth)
  const width = clampExplorerWidth(storedWidth, viewportWidth)
  const overlay = isNarrowViewport(viewportWidth)
  const collapsed = useUIStore((s) => s.explorerCollapsed)
  const setExplorerWidth = useUIStore((s) => s.setExplorerWidth)
  const setExplorerCollapsed = useUIStore((s) => s.setExplorerCollapsed)

  // Where the agent ACTUALLY goes while the picker is empty. The empty state
  // used to promise ~/agent-workspace flat out, which is wrong for anybody who
  // pinned a folder on this chat or set a default workspace: both beat an
  // empty picker in the run resolver (review S4).
  const perChatWorkspace = useAgentModeStore((s) =>
    activeConversationId ? s.workspaces[activeConversationId] : undefined,
  )
  const defaultWorkspace = useSettingsStore((s) => s.settings.defaultWorkspace)
  const fallbackLabel = codexFallbackLabel(
    resolveWorkspacePath({ perChat: perChatWorkspace, defaultWorkspace }),
  )

  const [listings, setListings] = useState<Record<string, ExplorerListing>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [busy, setBusy] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  // R2-43: a folder-pick REFUSAL used to share `error` with the root-load
  // failure. A later, unrelated load of the (still valid) current root
  // succeeding cleared `error` on its way, wiping a refusal message the user
  // had not read yet. Its own state survives any load that isn't about it.
  const [pickError, setPickError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ExplorerNode | null>(null)

  const planWaiting = useCodexStore((s) =>
    activeConversationId ? !!s.planApprovalByConversation[activeConversationId] : false,
  )
  const planSteps = useTodoStore((s) =>
    activeConversationId ? (s.byConversation[activeConversationId]?.length ?? 0) : 0,
  )
  const planHasSomething = planWaiting || planSteps > 0

  const load = async (dir: string) => {
    setBusy((b) => (b.includes(dir) ? b : [...b, dir]))
    try {
      const listing = await loadChildren(dir, root, fsList)
      setListings((prev) => ({ ...prev, [dir]: listing }))
      if (dir === root) setError(null)
    } catch (e) {
      if (dir === root) setError(e instanceof Error ? e.message : 'Failed to read directory')
      setListings((prev) => ({ ...prev, [dir]: EMPTY_LISTING }))
    } finally {
      setBusy((b) => b.filter((p) => p !== dir))
    }
  }

  // A new root is a new tree: nothing expanded, nothing previewed.
  //
  // R2-20: `root` (codexStore.workingDirectory) is a THIRD path that sets a
  // remembered folder without a dialog, next to "Use last folder" and
  // settings.defaultWorkspace (see api/agents/workspace-validate.ts). It
  // survives an app restart in the browser's own storage, so a fresh install,
  // cleared data, or a moved allowlist file can leave it pointing at a folder
  // Rust no longer accepts, the very same "pick it again to allow it" dead end
  // Fehler D closed for the picker itself. `rememberedFolderRefusal` asks
  // BEFORE the first `fs_list` of a session, so the header shows the real
  // reason instead of a bare "Failed to read directory".
  useEffect(() => {
    setListings({})
    setExpanded([])
    setSelected(null)
    setError(null)
    setPickError(null)
    if (root) {
      void (async () => {
        const refusal = await rememberedFolderRefusal(root)
        if (refusal) {
          setError(refusal)
          return
        }
        load(root)
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // Refresh after the agent wrote or ran something. codexStore bumps
  // fileTreeVersion on file_change / terminal_output. Reload the root and every
  // open folder, so an expanded subtree stays expanded across a write.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!root) return
    load(root)
    for (const dir of expanded) load(dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTreeVersion])

  const refresh = () => {
    if (!root) return
    load(root)
    for (const dir of expanded) load(dir)
  }

  const onToggleDir = (node: ExplorerNode) => {
    const next = toggleExpanded(expanded, node.path)
    setExpanded(next)
    if (next.includes(node.path) && !listings[node.path]) load(node.path)
  }

  // Der Ordner-Dialog der gepackten App (Fehler D, ein Nutzer,
  // 08.09.2026).
  //
  // `asWorkspace: true` laesst die Rust-Seite einen Ordner, den sie nicht als
  // Arbeitsordner annimmt, MELDEN statt den Pfad zurueckzugeben, als waere
  // nichts gewesen. Vorher landete so ein Ordner in der Kopfzeile, und jede
  // Dateioperation darunter antwortete mit "pick it again to allow it", also
  // genau mit dem, was der Nutzer gerade getan hatte. Ein abgelehnter Ordner
  // wird deshalb GAR NICHT gesetzt.
  //
  // Der getippte Pfad als RUECKFALL ist weg, und nur er. Auf die
  // Erlaubnisliste der gepackten App kommt ein Ordner ausschliesslich ueber
  // `system::pick_folder` (weiter zu `remember_picked_root`); ein in ein
  // `window.prompt` getippter Pfad war dort also ein Arbeitsordner, der nie
  // funktionieren konnte, und der Weg heraus aus dem Fehler war derselbe
  // Prompt. Im Browser des Dev-Servers ist es umgekehrt: dort gibt es weder
  // einen nativen Dialog noch ueberhaupt eine Erlaubnisliste (die Begruendung
  // steht in lib/dev-fs-jail.ts), der getippte Pfad ist der vorgesehene Weg
  // und er funktioniert. Deshalb steht er dort und nur dort.
  const pickFolder = async () => {
    setPickError(null)
    if (!isTauri()) {
      const typed = window.prompt('Enter folder path:', root || (isMacOS() ? '/Users/' : 'C:\\Users'))
      if (typed) setWorkingDirectory(typed)
      return
    }
    try {
      const picked = await backendCall<string | null>('pick_folder', {
        defaultPath: root || undefined,
        asWorkspace: true,
      })
      if (picked) setWorkingDirectory(picked)
    } catch (e) {
      setPickError(workspacePickRefusedMessage(e))
    }
  }

  // Give the folder back (A8). Users reported no way out of a folder they had
  // opened by mistake, one of them was ready to reinstall the app over it.
  // Clearing the store also unpins every open thread, so the CURRENT chat falls
  // back to its own sandbox instead of keeping the tree it was born with.
  const removeFolder = () => {
    if (lockReason) return
    clearWorkingDirectory()
  }

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: PointerEvent) => {
      // The panel is on the right, so dragging left makes it wider.
      setExplorerWidth(startWidth + (startX - ev.clientX), window.innerWidth)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (collapsed) {
    return (
      <div className="w-7 shrink-0 flex flex-col items-center py-1 border-l border-gray-200 dark:border-white/[0.04] bg-gray-50 dark:bg-white/[0.01]">
        <button
          onClick={() => setExplorerCollapsed(false)}
          title="Show the explorer"
          data-testid="explorer-expand"
          className="p-1 rounded text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        >
          <PanelRightOpen size={12} />
        </button>
        {planHasSomething && (
          <button
            onClick={() => setExplorerCollapsed(false)}
            title={planWaiting ? 'A plan is waiting for your approval' : 'Show the plan'}
            data-testid="explorer-plan-waiting"
            className={`mt-1 p-1 rounded transition-colors hover:bg-gray-100 dark:hover:bg-white/5 ${
              planWaiting ? 'text-lu-accent' : 'text-gray-400 dark:text-gray-500'
            }`}
          >
            <ListTodo size={12} />
          </button>
        )}
      </div>
    )
  }

  const rootListing = listings[root]
  const rows = flattenTree(root, listings, expanded)
  const loadingRoot = busy.includes(root)

  const panel = (
    <aside
      style={{ width: `${width}px` }}
      className={`${overlay ? 'absolute right-0 top-0 z-30 shadow-lg bg-gray-50 dark:bg-lu-panel' : 'relative shrink-0 bg-gray-50 dark:bg-white/[0.01]'} h-full flex flex-col border-l border-gray-200 dark:border-white/[0.04]`}
    >
      {/* Drag handle on the panel edge. */}
      <div
        onPointerDown={startDrag}
        title="Drag to resize"
        data-testid="explorer-resize-handle"
        className="absolute left-0 top-0 h-full w-1 -ml-0.5 z-10 cursor-col-resize hover:bg-white/10 active:bg-white/20 transition-colors"
      />

      <div className="flex items-center gap-1 p-1.5 border-b border-gray-200 dark:border-white/[0.04]">
        <button
          onClick={pickFolder}
          disabled={!!lockReason}
          data-testid="explorer-pick-folder"
          title={lockTitle || root || 'Pick the folder the agent works in'}
          className="flex-1 disabled:opacity-40 min-w-0 flex items-center gap-1 px-1.5 py-1 rounded bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 transition-colors text-left"
        >
          <FolderOpen size={10} className="text-gray-500 shrink-0" />
          {root ? (
            <span className="text-[0.5rem] text-gray-700 dark:text-gray-300 font-mono truncate flex-1">{root}</span>
          ) : (
            <span className="text-[0.5rem] text-gray-400 dark:text-gray-600 flex-1">Select folder...</span>
          )}
        </button>
        {root && (
          <button
            onClick={removeFolder}
            disabled={!!lockReason}
            data-testid="explorer-remove-folder"
            aria-label="Remove the working directory"
            title={
              lockTitle ||
              `Remove this folder. The agent falls back to ${fallbackLabel} until you pick a new one.`
            }
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 disabled:opacity-30 disabled:hover:text-gray-400 transition-colors shrink-0"
          >
            <FolderX size={11} />
          </button>
        )}
        <button
          onClick={refresh}
          disabled={!root}
          title="Refresh"
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 dark:text-gray-600 disabled:opacity-30 transition-colors shrink-0"
        >
          <RefreshCw size={10} className={loadingRoot ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => setExplorerCollapsed(true)}
          title="Hide the explorer"
          data-testid="explorer-collapse"
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 dark:text-gray-600 transition-colors shrink-0"
        >
          <PanelRightClose size={12} />
        </button>
      </div>

      {/* Warum die beiden Knoepfe darueber tot sind, in Worten.
          Der Grund hing bisher nur als `title` an ihnen, und ein `disabled`
          Knopf nimmt keine Mauszeiger-Ereignisse an: der Hinweis ist also nie
          erschienen. Uebrig blieben zwei graue Knoepfe ohne Erklaerung. Ruhiger
          Ton, keine Warnfarbe: gesperrt ist kein Fehler, sondern ein Zustand,
          der von selbst endet (`lib/hinweis.ts`). */}
      {lockTitle && (
        <p
          data-testid="explorer-workdir-lock"
          className={`px-1.5 py-1 text-[0.45rem] leading-relaxed border-b border-gray-200 dark:border-white/[0.04] ${HINWEIS_TEXT.ruhig}`}
        >
          {lockTitle}
        </p>
      )}

      <div className={`overflow-y-auto scrollbar-thin p-1 ${selected ? 'max-h-[45%] shrink-0' : 'flex-1 min-h-0'}`}>
        {/* R2-15: der leere Zustand stand VOR der Fehlerzeile. Wird ein Ordner
            abgelehnt, bleibt `root` leer, also gewann "No folder picked." und
            der Grund verschwand ungelesen. Der Nutzer sah einen Klick, der
            nichts tat, und den einzigen Satz, der ihm haette sagen koennen,
            warum, bekam er nie. Der Fehler steht deshalb zuerst. */}
        {pickError || error ? (
          <p
            data-testid="explorer-error"
            className="text-[0.5rem] text-red-500/80 px-1 py-2 break-words"
          >
            {pickError || error}
          </p>
        ) : !root ? (
          <p
            data-testid="explorer-no-folder"
            className="text-[0.5rem] text-gray-400 dark:text-gray-600 px-1 py-2 leading-relaxed"
          >
            No folder picked. The agent works in {fallbackLabel} until you
            click "Select folder..." above.
          </p>
        ) : !rootListing ? (
          <p className="text-[0.5rem] text-gray-400 dark:text-gray-600 px-1 py-2">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-[0.5rem] text-gray-400 dark:text-gray-600 px-1 py-2">Empty directory</p>
        ) : (
          <>
            <ListingHints listing={rootListing} depth={0} />
            {rows.map((row) => {
              const isOpen = row.expanded
              const childListing = listings[row.node.path]
              const isBusy = busy.includes(row.node.path)
              const isSelected = selected?.path === row.node.path
              return (
                <Fragment key={row.node.path}>
                  <button
                    onClick={() =>
                      row.node.isDirectory ? onToggleDir(row.node) : setSelected(row.node)
                    }
                    title={row.node.path}
                    style={{ paddingLeft: `${row.depth * 8 + 4}px` }}
                    className={`flex items-center gap-1 w-full pr-1 py-[2px] text-[0.5rem] rounded transition-colors text-left ${
                      isSelected
                        ? 'bg-gray-200/70 dark:bg-white/[0.07] text-gray-800 dark:text-gray-100'
                        : row.node.isDirectory
                          ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5'
                          : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5'
                    }`}
                  >
                    {row.node.isDirectory ? (
                      isBusy ? (
                        <Loader2 size={8} className="text-gray-500 shrink-0 animate-spin" />
                      ) : isOpen ? (
                        <ChevronDown size={8} className="text-gray-500 shrink-0" />
                      ) : (
                        <ChevronRight size={8} className="text-gray-500 shrink-0" />
                      )
                    ) : (
                      <span className="w-2 shrink-0" />
                    )}
                    {row.node.isDirectory ? (
                      <Folder size={8} className="text-gray-500 shrink-0" />
                    ) : (
                      <FileText size={8} className="text-gray-400 dark:text-gray-600 shrink-0" />
                    )}
                    <span className="truncate">{row.node.name}</span>
                  </button>
                  {isOpen && childListing && (
                    <ListingHints listing={childListing} depth={row.depth + 1} />
                  )}
                </Fragment>
              )
            })}
          </>
        )}
      </div>

      {selected && (
        // Keyed on the path: another file is another component, so the
        // per-file script opt-in cannot survive the switch.
        <FilePreview key={selected.path} node={selected} root={root} onClose={() => setSelected(null)} />
      )}

      {/* Bottom of the column, and the only place either of these renders.
          `shrink-0` so a long file tree can never squeeze the plan, and with
          it the Approve-and-run button, down to nothing. */}
      <div className="shrink-0 border-t border-gray-200 dark:border-white/[0.04]">
        <PlanApprovalBar onApprove={onApprovePlan} />
        <PlanBar variant="panel" />
      </div>
    </aside>
  )

  // Ein Rahmen ohne eigene Breite traegt die Ueberlagerung, wie die
  // Chatspalte in Sidebar.tsx: so braucht kein Vorfahre `relative`, und kein
  // anderes absolut gesetztes Element bekommt einen neuen Bezugsrahmen.
  return overlay ? (
    <div data-testid="explorer-overlay" className="relative shrink-0 w-0 h-full">
      {panel}
    </div>
  ) : panel
}

/** The two things a listing has to admit: the backend cut it off at 500, and
 *  the ignore filter took entries out. Both silently looked like "this is the
 *  whole folder" before. */
function ListingHints({ listing, depth }: { listing: ExplorerListing; depth: number }) {
  if (!listing.truncated && listing.hidden === 0) return null
  return (
    <div style={{ paddingLeft: `${depth * 8 + 4}px` }} className="py-[1px]">
      {listing.truncated && (
        // Ruhiger Ton, nicht Gelb: die Liste ist vollstaendig bis zur Grenze,
        // sie ist nicht kaputt. Etwas kraeftiger als die Zeile darunter, weil
        // „hier fehlt der Rest" die groessere der zwei Auskuenfte ist
        // (`lib/hinweis.ts`).
        <p className={`text-[0.45rem] ${HINWEIS_TEXT.ruhig}`} data-testid="explorer-truncated">
          shortened, first {FS_LIST_CAP} entries only
        </p>
      )}
      {listing.hidden > 0 && (
        <p className="text-[0.45rem] text-gray-400 dark:text-gray-600" title={EXPLORER_IGNORED.join(', ')}>
          {listing.hidden} hidden ({EXPLORER_IGNORED.join(', ')})
        </p>
      )}
    </div>
  )
}
