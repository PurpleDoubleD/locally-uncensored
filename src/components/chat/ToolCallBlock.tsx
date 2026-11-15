import { useState, useEffect, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Globe, BookOpenText, AppWindowMac as AppWindow, FileText, FileEdit, Terminal, Image, Film, Loader2, Check, X, Clock, AlertCircle, FolderOpen, Monitor, GitBranch, GitCommitHorizontal, GitPullRequest, FlaskConical, History, Users, Database, Download, Square } from 'lucide-react'
import type { AgentToolCall } from '../../types/agent-mode'
import { getBlockToolCalls } from '../../api/agents/block-helpers'
import { getComfyHost, getComfyPort, downloadComfyFile } from '../../api/backend'
import { useComfyViewRescueState, isInlineVideoUrl } from './comfyViewRescue'
import { useModelPickStore } from '../../stores/modelPickStore'
import { useGenerationStore } from '../../stores/generationStore'
import { ModelPickerCard, ChangeModelInline, pickKindForToolCall } from './ModelPickerCard'
import { CopyText } from '../create/experimental/CopyText'
import { DiffView } from './DiffView'
import { ScreenTaskSteps } from './ScreenTaskSteps'
import { ScreenShotStrip } from '../computer/ScreenShotStrip'
import { ComputerChatPermission, useComputerChatAsk } from '../computer/ComputerChatPermission'
import { SettingChangeAsk, SettingChangeDone, SelfControlDone } from './SettingChangeCard'
import { WebSourceCards, WebUrlAsk } from './WebSourceCards'
import { BrowserControls, BrowserShot } from './BrowserControls'
import { parseSourceCards, stripSourcesMarker } from '../../lib/web-evidence'
import { useWebUrlConfirmStore, pendingUrlForCall } from '../../stores/webUrlConfirmStore'
import { useSettingsConfirmStore, pendingForCall } from '../../stores/settingsConfirmStore'
import { parseSettingChanges } from '../../api/mcp/settings-tools'
import { parseSelfControlAction } from '../../api/mcp/self-control-defs'
import { WorkflowCardAsk, WorkflowCardDone } from './WorkflowInstallCard'
import { useWorkflowCardStore, workflowCardForCall } from '../../stores/workflowInstallConfirmStore'
import { parseWorkflowMark } from '../../api/mcp/workflow-mark'
import { isSelfControlToolName } from '../../lib/settings-tool-names'
import { useChatStore } from '../../stores/chatStore'
import { useCommandRulesStore } from '../../stores/commandRulesStore'
import { useCodexConfirmStore } from '../../stores/codexConfirmStore'
import { suggestRuleFor } from '../../lib/agent-core/command-rules'
import { toolCallTitle, diffStat, shellExitCode, hasToolTitle, stripAnsi } from '../../lib/tool-call-title'
import { toolRegistry } from '../../api/mcp/tool-registry'
import { commandIcon } from '../../lib/shell-command-classify'
import { requestGenerationCancel } from '../../api/vram-handoff'
import { cancelBackgroundJob } from '../../lib/background-cancels'
import { fileUrlToPath, readLocalFileAsBlobUrl, displayableMedia, type MediaRead } from '../../lib/local-media-url'
import { hiddenFromTranscript } from '../../lib/transcript-visibility'
import { MOTION_S } from '../ui/motion'
import { HINWEIS_TEXT } from '../../lib/hinweis'

// F1 (konata3602 commitment 2026-05-23) + render fix (konata3602 bug 2026-06-07)
// — when image_generate / video_generate / screenshot produce a ComfyUI output,
// the user must SEE the picture, not a path string. The tool result embeds a
// ComfyUI /view URL whose exact form depends on the runtime:
//   - packaged desktop (Tauri):     http://localhost:8188/view?filename=…
//   - custom / remote ComfyUI host: http://<host>:<port>/view?filename=…
//   - browser / dev (Vite proxy):   /comfyui/view?filename=…   ← a user's case
// The original localhost-only regex silently failed on the latter two, so
// A user (running the web build behind the /comfyui proxy) saw the raw
// "/comfyui/view?…" text and NO image. comfyViewUrlFromResult() now accepts any
// of those forms, but ONLY when the URL points at OUR ComfyUI — a relative
// proxy path, a loopback host, or the user-configured comfy host — and carries
// a filename. A third-party URL in a tool result is never auto-loaded (CSP +
// privacy). Exported for unit testing (see __tests__/ToolCallBlock-image.test.ts).
/** Where a result line keeps its address: the last line of a multi-line
 *  result (A13). The prompt is quoted on the first one, and an address in the
 *  prompt was shown instead of the picture. One-line results stay whole. */
function mediaLine(result: string): string {
  const at = result.lastIndexOf('\n')
  return at < 0 ? result : result.slice(at + 1)
}

export function comfyViewUrlFromResult(result: string | null | undefined): string | null {
  if (!result) return null
  const m = mediaLine(result).match(/(https?:\/\/[^\s)\]]+\/view\?[^\s)\]]+|\/comfyui\/view\?[^\s)\]]+|\/view\?[^\s)\]]+)/i)
  if (!m) return null
  const url = m[1]
  if (!/[?&]filename=/i.test(url)) return null               // must be a real ComfyUI output view
  if (url.startsWith('/comfyui/view') || url.startsWith('/view?')) return url   // our own proxy path — safe
  try {
    const host = new URL(url).hostname.toLowerCase()
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    if (loopback || host === getComfyHost().toLowerCase()) return url
  } catch { /* not a parseable absolute URL — fall through to null */ }
  return null
}

// Feature EE (v2.5.0): .mp4/.webm outputs render in a <video>, see
// isInlineVideoUrl in comfyViewRescue.ts (shared with the reply's Markdown).
export { isInlineVideoUrl }

// 2026-06-12 ("alle tools in chat, mit download"): pull the ComfyUI
// filename/subfolder/type back out of a /view URL so the inline image/video
// gets a Download button (downloadComfyFile fetches the real bytes → native
// Save-As in Tauri / anchor download in the browser). Returns null if the URL
// has no filename. Exported for unit testing.
export function comfyViewParams(url: string | null | undefined): { filename: string; subfolder: string; type: string } | null {
  if (!url) return null
  try {
    const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
    const p = new URLSearchParams(q)
    const filename = p.get('filename')
    if (!filename) return null
    return { filename, subfolder: p.get('subfolder') || '', type: p.get('type') || 'output' }
  } catch {
    return null
  }
}

// Mac MLX media (hard rule: local image/video on Mac is MLX, never ComfyUI —
// see api/mcp/builtin-tools.ts's executeImageGenerateMlx / executeVideoGenerateMlx).
// There is no ComfyUI /view route for these, so the result carries a local
// `file://` URL pointing at the render the Rust side already wrote to disk.
// Same F1 result shape as the ComfyUI path — `<kind> generated: <file>
// (prompt: "...")\n<url>` — just a different url scheme. Exported for unit
// testing.
export function localMediaUrlFromResult(result: string | null | undefined): string | null {
  if (!result) return null
  // `file://` is the 2.6.3 form (B3): the result carries the PATH of a file the
  // app already wrote, so it still resolves after a restart. `blob:` only
  // appears in conversations recorded BEFORE that change, where it is already
  // dead; it stays matched so those messages can say so plainly.
  const m = mediaLine(result).match(/(file:\/\/[^\s)\]]+|blob:[^\s)\]]+|data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[^\s)\]]+)/i)
  return m ? m[1] : null
}

/**
 * Resolve a `file://` result line into something an element can display.
 *
 * The blob is created when the block mounts and revoked when it unmounts, so a
 * long conversation full of generated images holds exactly the ones on screen
 * rather than every one ever produced. Anything that is not one of our file
 * URLs is handed straight back.
 */
function useDisplayableMediaUrl(url: string | null): { url: string | null; missing: boolean } {
  const path = url ? fileUrlToPath(url) : null
  // Only the READ is state now; what the element shows is derived from it by
  // displayableMedia (lib/local-media-url), which also carries the "a stored
  // blob: URL is necessarily dead" rule. The two resets this hook used to write
  // back from the effect body — no path at all, and a new path whose read has
  // not landed yet — were cascading renders for facts the render already had
  // (React 19 `set-state-in-effect`), and the `missing` one could land late
  // enough to paint the previous file's "gone" over the new one.
  const [read, setRead] = useState<MediaRead | null>(null)

  useEffect(() => {
    if (!path) return
    let live = true
    let made: string | null = null
    readLocalFileAsBlobUrl(path)
      .then((blobUrl) => {
        // Unmounted while reading: revoke immediately, nothing will show it.
        if (!live) { URL.revokeObjectURL(blobUrl); return }
        made = blobUrl
        setRead({ path, url: blobUrl, missing: false })
      })
      .catch(() => { if (live) setRead({ path, url: null, missing: true }) })
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [path])

  return displayableMedia(url, path, read)
}

// Pull the "<file>" back out of the "<kind> generated: <file> (prompt: …"
// prefix so the local-media Download button can suggest a real filename
// (blob:/data: URLs carry no filename of their own, unlike a ComfyUI /view
// URL's `filename=` query param). Exported for unit testing.
export function localMediaFilenameFromResult(result: string | null | undefined): string | null {
  if (!result) return null
  const m = result.match(/^(?:Image|Video) generated:\s*(\S+)/)
  return m ? m[1] : null
}

interface Props {
  toolCall: AgentToolCall
  onApprove?: () => void
  onReject?: () => void
}

// Complete over the registry (audit D4): 16 of 29 tools had no entry and fell
// back to the Terminal icon, so a git_commit looked like a shell command and
// a surgical file_edit like a plain write. Every builtin has a face now.
// Since the 2.6.6 merge, shell_execute derives its face from the COMMAND
// (commandIcon), so a commit still looks like a commit.
/** Web tools: they may ask before an address and they carry source cards. */
const WEB_URL_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'web_research', 'browser_open', 'browser_snapshot', 'browser_scroll', 'browser_click_link', 'browser_screenshot'])

const TOOL_ICONS: Record<string, typeof Search> = {
  web_search: Search,
  web_fetch: Globe,
  web_research: BookOpenText,
  browser_open: AppWindow,
  browser_snapshot: AppWindow,
  browser_scroll: AppWindow,
  browser_click_link: AppWindow,
  browser_screenshot: AppWindow,
  file_read: FileText,
  file_write: FileEdit,
  file_edit: FileEdit,
  file_list: FolderOpen,
  file_search: Search,
  shell_execute: Terminal,
  pr_resume: GitPullRequest,
  screenshot: Monitor,
  computer_use: Monitor,
  computer_task: Monitor,
  image_generate: Image,
  video_generate: Film,
  run_workflow: GitBranch,
  delegate_task: Users,
}

// The per-command faces of the merged shell tool (plan E4 point 6).
const SHELL_COMMAND_ICONS: Record<string, typeof Search> = {
  'git-read': GitBranch,
  'git-commit': GitCommitHorizontal,
  'git-push': GitBranch,
  test: FlaskConical,
  read: FileText,
  terminal: Terminal,
  // A backgrounded call or a task handle is a job, not a command.
  background: History,
}

/**
 * Which SHELL_COMMAND_ICONS face a shell call wears.
 *
 * Returns the KEY, not the component. React 19's `static-components` rule
 * cannot see through a helper that hands a component back, and it is right to
 * be strict: a component built during render loses its state every time. The
 * lookup itself therefore has to stay visible as a lookup, at the use site.
 */
function shellIconKey(toolCall: AgentToolCall): string {
  const command = toolCall.args?.command
  if (toolCall.args?.background || typeof toolCall.args?.task === 'string') return 'background'
  if (typeof command !== 'string') return 'terminal'
  return commandIcon(command)
}

const STATUS_ICONS = {
  pending_approval: Clock,
  running: Loader2,
  completed: Check,
  failed: AlertCircle,
  rejected: X,
  // Phase 6 (v2.4.0): cached result from in-turn cache, no re-execution.
  cached: Database,
  // bau/wfprogress.md Runde 2: Stop ended the run, nothing broke, so this
  // gets a calm square, not the red AlertCircle 'failed' wears.
  stopped: Square,
}

// memo (audit D2): the Codex/Agent transcript re-renders on every streamed
// frame, and each un-memoised block re-rendered with it. Block updates
// replace the toolCall object, so reference equality is the right check.
//
// The gate sits OUTSIDE the implementation on purpose: a tool that another
// surface already owns must not mount the block at all, and an early return
// inside ToolCallBlockImpl would have to come after its hooks. See
// lib/transcript-visibility.ts for which calls those are and why.
/** The conversation whose agent turn holds this tool call, or null. */
export function conversationOfToolCall(callId: string): string | null {
  const { conversations, activeConversationId } = useChatStore.getState()
  for (const conv of conversations) {
    for (const m of conv.messages) {
      for (const block of m.agentBlocks ?? []) {
        if (getBlockToolCalls(block).some((c) => c.id === callId)) return conv.id
      }
    }
  }
  return activeConversationId
}

export const ToolCallBlock = memo(function ToolCallBlockGate(props: Props) {
  if (hiddenFromTranscript(props.toolCall)) return null
  return <ToolCallBlockImpl {...props} />
})

function ToolCallBlockImpl({ toolCall, onApprove, onReject }: Props) {
  // Default: collapsed (closed)
  const [open, setOpen] = useState(toolCall.status === 'pending_approval')

  // A workflow-progress step (klein 2, bau/wfprogress.md) carries its own
  // dynamic label ("Step 2 of 6: <name>") as toolName, so it can never match
  // TOOL_ICONS by exact key the way a real tool call does. Same GitBranch
  // face the "run_workflow" tool itself already wears.
  const ToolIcon = toolCall.toolName === 'shell_execute'
    ? (SHELL_COMMAND_ICONS[shellIconKey(toolCall)] ?? Terminal)
    : toolCall.toolName.startsWith('Step ') || toolCall.toolName.startsWith('Workflow')
      ? GitBranch
      : (TOOL_ICONS[toolCall.toolName] || Terminal)
  const StatusIcon = STATUS_ICONS[toolCall.status]
  const isRunning = toolCall.status === 'running'
  const isPending = toolCall.status === 'pending_approval'
  const isFailed = toolCall.status === 'failed' || toolCall.status === 'rejected'
  // The Code tab keeps a call 'running' while its confirm card waits; the row
  // says it waits, not that it runs (CA U1).
  const waitsOnCard = useCodexConfirmStore((st) =>
    isRunning && !!st.pending && st.pending.toolName === toolCall.toolName
    && JSON.stringify(st.pending.args ?? {}) === JSON.stringify(toolCall.args ?? {}),
  )
  const title = toolCallTitle(toolCall.toolName, toolCall.args, waitsOnCard ? 'pending_approval' : toolCall.status, toolRegistry.displayName(toolCall.toolName))
  const stat = diffStat(toolCall.diff)
  const isShell = toolCall.toolName === 'shell_execute'
  const exitCode = isShell ? shellExitCode(toolCall.result) : null
  // The raw arguments where the title cannot say what the call does, and on
  // every call that waits for a yes: what it would write is part of the question.
  const knownTool = hasToolTitle(toolCall.toolName) && !(isPending && !isShell)
  // CA K4: "Always allow `npm test` here", for a waiting shell call that knows its folder.
  const alwaysRule = isPending && toolCall.toolName === 'shell_execute' && toolCall.ruleScope && typeof toolCall.args?.command === 'string'
    ? suggestRuleFor(toolCall.args.command)
    : null
  // The first use of computer control in a chat waits here for the user's yes.
  const chatAsk = useComputerChatAsk(toolCall.toolName, isRunning, useChatStore((s) => s.activeConversationId))
  // A11 / C60: a change LU makes to itself waits here for Accept, and stays
  // with Undo: one setting, several on one card, or an action.
  const isSetSetting = isSelfControlToolName(toolCall.toolName) && toolCall.toolName !== 'get_settings' && toolCall.toolName !== 'lu_open_settings' && toolCall.toolName !== 'watcher_list'
  const settingAsk = useSettingsConfirmStore((s) => (isSetSetting && isRunning ? pendingForCall(s.queue, toolCall.id) : null))
  const settingChanges = isSetSetting && toolCall.status === 'completed' ? parseSettingChanges(toolCall.result) : []
  const selfAction = isSetSetting && toolCall.status === 'completed' ? parseSelfControlAction(toolCall.result) : null
  // P-L: a web address the model made up waits here for Open; the sources of
  // a web tool stay visible under it, from the tool result and not the model.
  const isWebTool = WEB_URL_TOOLS.has(toolCall.toolName)
  const urlAsk = useWebUrlConfirmStore((s) => (isWebTool && isRunning ? pendingUrlForCall(s.queue, toolCall.id) : null))
  const sourceCards = isWebTool && toolCall.status === 'completed' ? parseSourceCards(toolCall.result) : []
  // C60-S5: a workflow install or assignment waits here with its traffic
  // light check, and stays with Undo for the assignment.
  const isWorkflowWrite = toolCall.toolName === 'workflow_install' || toolCall.toolName === 'workflow_assign'
  const workflowAsk = useWorkflowCardStore((s) => (isWorkflowWrite && isRunning ? workflowCardForCall(s.queue, toolCall.id) : null))
  const workflowMark = isWorkflowWrite && toolCall.status === 'completed' ? parseWorkflowMark(toolCall.result) : null
  // Real cancel (2026-06-16): only image/video generation supports a true
  // abort (ComfyUI /interrupt + loop abort). Local "cancelling" state flips the
  // mini button to a "stopping…" indicator the moment it's clicked.
  const isGenTool = toolCall.toolName === 'image_generate' || toolCall.toolName === 'video_generate'
  // 3.0.8 (A2): went on in the background, the turn is over. Its Stop ends
  // this one job, never the chat's other generations or a running turn.
  const inBackground = isRunning && toolCall.background?.state === 'running'
  const [cancelling, setCancelling] = useState(false)
  const genPrompt = isGenTool && typeof toolCall.args?.prompt === 'string' ? toolCall.args.prompt.trim() : ''

  // Inline media preview URL (image_generate / video_generate / screenshot).
  // Computed once; rendered ALWAYS-visible below the header (even while the
  // tool block is collapsed) so an auto-approved generation shows its picture
  // without the user having to expand the block — a user's "and no image".
  // Two possible sources: a ComfyUI /view URL (Windows/Linux), or a local
  // blob:/data: URL from the Mac MLX path (executeImageGenerateMlx /
  // executeVideoGenerateMlx in api/mcp/builtin-tools.ts — no ComfyUI /view
  // route exists for those).
  const comfyPreviewUrl = comfyViewUrlFromResult(toolCall.result)
  const rawLocalUrl = comfyPreviewUrl ? null : localMediaUrlFromResult(toolCall.result)
  // B3: a `file://` line is read off disk here and released when this block
  // unmounts. Everything else passes through untouched.
  const { url: localPreviewUrl, missing: localMediaMissing } = useDisplayableMediaUrl(rawLocalUrl)
  const previewUrl = comfyPreviewUrl ?? localPreviewUrl

  // Model-Picker (v2.5.3): while a generation tool call is RUNNING and the
  // executor's pre-VRAM-swap gate is waiting, render the picker inside this
  // block. Once a preference is saved (no picker shows), a mini "Change
  // model" line takes its place so the choice stays one click away.
  const pendingPick = useModelPickStore((s) => s.pending)
  const genKind = pickKindForToolCall(toolCall)
  const showPicker = !!genKind && !!pendingPick && pendingPick.kind === genKind && isRunning

  // Proxy-independent loading (a user 2026-06-08). In browser/dev the tool
  // result carries the RELATIVE `/comfyui/view?…` Vite-proxy path, which loads
  // fine under `npm run dev` (verified E2E). But a built frontend served
  // WITHOUT that dev proxy (e.g. `vite preview` or a static host) would 404 the
  // relative path → no image. If the primary src errors, retry with an ABSOLUTE
  // URL straight to the ComfyUI host: <img>/<video> display is not CORS-gated,
  // so it loads with no server-side proxy. Tauri results are already absolute
  // (they never start with '/') and are unaffected.
  const [imgFailed, setImgFailed] = useState(false)
  // Desktop: a blocked direct load of an absolute /view URL is fetched through
  // the app's localhost proxy instead (comfyViewRescue.ts, Discord 15.10.2026).
  const { url: rescuedUrl, waiting: rescueWaiting } = useComfyViewRescueState(comfyPreviewUrl, imgFailed)
  const effectivePreviewUrl = (() => {
    if (!previewUrl) return null
    if (rescuedUrl) return rescuedUrl
    // blob:/data: URLs (Mac MLX) are self-contained in this session — the
    // ComfyUI-host retry below only ever applies to a relative /view path.
    if (imgFailed && previewUrl.startsWith('/')) {
      const path = previewUrl.startsWith('/comfyui/') ? previewUrl.slice('/comfyui'.length) : previewUrl
      return `http://${getComfyHost()}:${getComfyPort()}${path}`
    }
    return previewUrl
  })()
  // A blob:/data: URL carries no `filename=` query param for isInlineVideoUrl
  // to key off, so fall back to the tool name — accurate since the MLX video
  // executor never produces an image result and vice versa.
  // Keyed off the RAW result line, not the resolved one: a file:// URL takes a
  // moment to read off disk, and the kind of element to render must not depend
  // on whether that read has landed yet. The same goes for a ComfyUI /view
  // URL: once the desktop rescue swaps in a blob: URL, that URL has no
  // filename left to read, and keying off it turned every rescued clip into a
  // broken <img> "Generated image" (3.0.8 A1, minimax-h3 on Windows, .molot).
  const isVideoResult = rawLocalUrl
    ? toolCall.toolName === 'video_generate'
    : !!comfyPreviewUrl && isInlineVideoUrl(comfyPreviewUrl)

  return (
    <div className="mb-0.5" data-tool={toolCall.toolName} data-status={toolCall.status}>
      {/* Header line — monochrome, only status icon has subtle color */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 py-1 text-left hover:opacity-80 transition-opacity flex-1 min-w-0"
          title={toolCall.toolName}
        >
          <ToolIcon size={13} className="text-gray-400 dark:text-gray-500 shrink-0" />
          {/* CA U1: what the call did, in words; the internal name is the tooltip. */}
          <span data-testid="tool-title" className={`t-control truncate min-w-0 ${isRunning && !waitsOnCard ? 'lu-tool-shimmer' : 'text-gray-600 dark:text-gray-400'}`}>
            {title.verb}
            {title.target && (
              <>
                {' '}
                <span className={title.mono ? 'font-mono text-gray-800 dark:text-gray-200' : 'text-gray-800 dark:text-gray-200'}>{title.target}</span>
              </>
            )}
          </span>
          {stat && (
            <span className="t-mono shrink-0" data-testid="tool-diffstat">
              <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>{' '}
              <span className="text-red-500 dark:text-red-400">−{stat.removed}</span>
            </span>
          )}
          {exitCode !== null && (
            <span className="t-micro shrink-0 text-red-500 dark:text-red-400" data-testid="tool-exit">exit {exitCode}</span>
          )}
          {isRunning && (
            <span className="flex items-center gap-[3px] shrink-0" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="lu-band-dot w-[3px] h-[3px] rounded-full bg-gray-400 dark:bg-gray-500"
                  style={{ animationDelay: `${i * 0.2}s` }}
                />
              ))}
            </span>
          )}
          {/* „Wartet auf Zustimmung" ist eine Entscheidung, kein Zwischenfall,
              und traegt deshalb den ruhigen Ton (`lib/hinweis.ts`). Gelb hat
              die Uhr hier neben das rote Fehlerzeichen gestellt, als waere ein
              offener Werkzeugaufruf ein halber Absturz. Gesehen wird er ueber
              die Uhr, ueber Approve/Reject darunter und ueber die Rueckfrage
              am Eingabefeld, nicht ueber die Farbe. */}
          <StatusIcon size={11} className={`shrink-0 ${
            toolCall.status === 'completed' ? 'text-gray-400 dark:text-gray-500' :
            isFailed ? 'text-red-400/60' :
            isPending ? HINWEIS_TEXT.ruhig :
            'text-gray-500'
          } ${isRunning ? 'animate-spin' : ''}`} />
          {isRunning && !waitsOnCard && toolCall.duration == null && (
            <RunningFor since={toolCall.startedAt ?? toolCall.timestamp} />
          )}
          {toolCall.duration != null && (
            <span className="t-micro text-gray-500 dark:text-gray-500">
              {toolCall.duration < 1000 ? `${toolCall.duration}ms` : `${(toolCall.duration / 1000).toFixed(1)}s`}
            </span>
          )}
        </button>
        {/* Real abort (2026-06-16): stop a running image/video generation.
            Fires ComfyUI /interrupt AND aborts the agent loop so it won't
            auto-start a replacement. VRAM is restored by runHandoff's finally. */}
        {isRunning && isGenTool && (
          cancelling ? (
            <span className="flex items-center gap-1 text-[0.55rem] text-gray-400 dark:text-gray-500 shrink-0 pr-1">
              <Loader2 size={9} className="animate-spin" /> stopping…
            </span>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setCancelling(true)
                if (inBackground && toolCall.background) {
                  // Nothing to stop here any more (the app restarted): the
                  // block is left as it is and says so after a reload.
                  if (!cancelBackgroundJob(toolCall.background.jobId)) setCancelling(false)
                  return
                }
                // A13: this block's own conversation only. The old app-wide
                // Stop also ended the replies and renders of every other chat.
                const cid = conversationOfToolCall(toolCall.id)
                if (cid) {
                  requestGenerationCancel(cid)
                  useGenerationStore.getState().aborters[cid]?.()
                } else {
                  requestGenerationCancel()
                  const { generating, aborters } = useGenerationStore.getState()
                  Object.keys(generating).forEach((id) => aborters[id]?.())
                }
              }}
              title="Stop generation"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.55rem] font-medium text-red-700 dark:text-red-300 bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 dark:border-red-500/25 transition-colors shrink-0"
            >
              <X size={10} /> Stop
            </button>
          )
        )}
      </div>

      {inBackground && (
        <div className="pl-5 pt-0.5" data-testid="tool-background-note">
          <span className="t-micro text-gray-500 dark:text-gray-400">
            Rendering in the background. You can keep chatting, the {toolCall.toolName === 'video_generate' ? 'video' : 'picture'} appears here when it is done.
          </span>
        </div>
      )}
      {toolCall.background?.state === 'interrupted' && (
        <div className="pl-5 pt-0.5">
          <span className="t-micro text-gray-500 dark:text-gray-400">{toolCall.error}</span>
        </div>
      )}
      {chatAsk && <div className="ml-3.5 pl-2"><ComputerChatPermission ask={chatAsk} /></div>}
      {settingAsk && <div className="ml-3.5 pl-2"><SettingChangeAsk req={settingAsk} /></div>}
      {settingChanges.map((c) => <div key={c.key} className="ml-3.5 pl-2"><SettingChangeDone change={c} /></div>)}
      {selfAction && <div className="ml-3.5 pl-2"><SelfControlDone action={selfAction} /></div>}
      {urlAsk && <div className="ml-3.5 pl-2"><WebUrlAsk req={urlAsk} /></div>}
      {sourceCards.length > 0 && <div className="ml-3.5 pl-2"><WebSourceCards cards={sourceCards} /></div>}
      {toolCall.toolName === 'browser_screenshot' && <div className="ml-3.5 pl-2"><BrowserShot toolCallId={toolCall.id} /></div>}
      {toolCall.toolName.startsWith('browser_') && <div className="ml-3.5 pl-2"><BrowserControls live={isRunning} /></div>}
      {workflowAsk && <div className="ml-3.5 pl-2"><WorkflowCardAsk req={workflowAsk} /></div>}
      {workflowMark && <div className="ml-3.5 pl-2"><WorkflowCardDone mark={workflowMark} /></div>}
      {isRunning && toolCall.toolName === 'computer_task' && <ScreenTaskSteps />}
      {(toolCall.toolName === 'computer_task' || toolCall.toolName === 'computer_use') && (
        <ScreenShotStrip callId={toolCall.id} className="ml-3.5 mb-1 pl-2" />
      )}

      {/* Model-Picker (v2.5.3) — LU's own pre-VRAM-swap model choice, shown
          while the executor gate awaits the pick. Falls back to the mini
          "Change model" line once a preference is saved. */}
      {showPicker && pendingPick && <ModelPickerCard request={pendingPick} />}
      {!showPicker && genKind && <ChangeModelInline kind={genKind} />}

      {/* Inline media preview — ALWAYS visible for a completed image/video
          generation, even while the tool block stays collapsed. Before the
A user 2026-06-07 fix this lived inside the collapsed details, so a
          user with auto-approve (block closed) saw "Image generated: …" text
          and no picture. A .mp4/.webm output renders in a <video>; everything
          else — including animated .webp — in an <img>. URL is bounded to OUR
          ComfyUI by comfyViewUrlFromResult (never auto-loads arbitrary URLs). */}
      {/* B3: the file behind this result is gone, or it was recorded as a
          session-scoped blob: URL before 2.6.3 and died with that window. An
          honest line beats a broken picture frame. */}
      {localMediaMissing && (
        <div className="pl-5 pt-0.5">
          <span className="t-micro text-gray-500 dark:text-gray-500">
            This render is no longer on disk.
          </span>
        </div>
      )}
      {previewUrl && effectivePreviewUrl && (
        <div className="pl-5 pt-0.5 space-y-1">
          {/* The direct load failed and ComfyUI is not answering yet, as right
              after the app starts or while ComfyUI restarts. The rescue keeps
              asking (comfyViewRescue.ts); a calm line instead of a broken frame
              until the bytes arrive. */}
          {rescueWaiting ? (
            <div className="flex items-center gap-1.5 t-micro text-gray-500 dark:text-gray-500" data-testid="tool-media-waiting">
              <Loader2 size={10} className="animate-spin" />
              {isVideoResult ? 'Loading the video' : 'Loading the picture'}, waiting for ComfyUI…
            </div>
          ) : isVideoResult ? (
            <video
              src={effectivePreviewUrl}
              controls
              loop
              playsInline
              preload="metadata"
              aria-label="Generated video"
              data-testid="tool-media-video"
              onError={() => { if (!imgFailed) setImgFailed(true) }}
              className="block max-w-full max-h-[320px] rounded border border-gray-200 dark:border-white/[0.06]"
            />
          ) : (
            <a href={effectivePreviewUrl} target="_blank" rel="noopener noreferrer" className="block">
              <img
                src={effectivePreviewUrl}
                alt="Generated image"
                onError={() => { if (!imgFailed) setImgFailed(true) }}
                className="max-w-full max-h-[320px] rounded border border-gray-200 dark:border-white/[0.06]"
                loading="lazy"
              />
            </a>
          )}
          {/* The prompt the picture or the clip was made from, readable without
              opening the tool block, with a button that copies it. Taken from
              the call's own arguments, so a call without one shows no line. */}
          {genPrompt && (
            <div className="flex max-w-xl items-start gap-3 text-gray-500 dark:text-gray-400" data-testid="tool-media-prompt">
              <span className="t-micro min-w-0 flex-1 max-h-20 overflow-y-auto scrollbar-thin select-text whitespace-pre-wrap break-words">{genPrompt}</span>
              <CopyText text={genPrompt} label="Copy prompt" />
            </div>
          )}
          {/* Download (2026-06-12): generated media shows in the chat with
              a Download button, ChatGPT-style — downloadComfyFile pulls the real
              bytes and saves via the native dialog. Mac MLX results have no
              ComfyUI /view route to re-fetch from, so a plain anchor download
              off the blob:/data: URL already in hand does the same job. */}
          {(() => {
            const p = comfyViewParams(comfyPreviewUrl ?? effectivePreviewUrl)
            if (p) {
              return (
                <button
                  onClick={() => { void downloadComfyFile(p.filename, p.subfolder, p.type) }}
                  title="Download"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded t-micro font-medium bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 border border-blue-500/30 transition-colors"
                >
                  <Download size={11} /> Download
                </button>
              )
            }
            if (!localPreviewUrl) return null
            const filename = localMediaFilenameFromResult(toolCall.result) || (isVideoResult ? 'video.mp4' : 'image.png')
            return (
              <a
                href={effectivePreviewUrl}
                download={filename}
                title="Download"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded t-micro font-medium bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 border border-blue-500/30 transition-colors"
              >
                <Download size={11} /> Download
              </a>
            )
          })()}
        </div>
      )}

      {/* Expandable details */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: MOTION_S.base }}
            className="overflow-hidden"
          >
            <div className="pl-5 pb-1.5 space-y-1">
              {/* Arguments: only where the title does not already say them, and
                  for a shell call as the terminal block below. */}
              {!knownTool && (
                <pre className="t-mono leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-x-auto scrollbar-thin">
                  {JSON.stringify(toolCall.args, null, 2)}
                </pre>
              )}

              {/* Diff for the write tools (audit D5): a change view where a
                  change happened, not raw result text. */}
              {toolCall.diff && (
                <div className="max-h-[300px] overflow-auto scrollbar-thin">
                  <DiffView diff={toolCall.diff} />
                </div>
              )}

              {/* Result (raw text). The inline media preview now renders
                  always-visible above the collapsible (a user 2026-06-07). */}
              {isShell && (
                <pre data-testid="tool-terminal" className="lu-on-dark t-mono leading-relaxed rounded-md bg-gray-950 dark:bg-black/50 text-gray-100 px-3 py-2 overflow-auto scrollbar-thin max-h-[300px] whitespace-pre-wrap break-words">
                  <span className="select-none text-gray-500">$ </span>{typeof toolCall.args?.command === 'string' ? toolCall.args.command : ''}
                  {toolCall.result ? `\n${stripAnsi(toolCall.result)}` : ''}
                </pre>
              )}
              {toolCall.result && !toolCall.diff && !isShell && (
                <pre className="t-mono leading-relaxed text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-auto scrollbar-thin max-h-[300px] whitespace-pre-wrap break-words">
                  {isWebTool ? stripSourcesMarker(toolCall.result) : toolCall.result}
                </pre>
              )}

              {/* Error. Not when the result above already says it: a refused
                  path showed "Path escapes the allowed workspace" twice
                  (3.0.4 box run). */}
              {toolCall.error && !(toolCall.result ?? '').includes(toolCall.error.trim()) && (
                <pre className="t-mono leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 whitespace-pre-wrap break-words">
                  {toolCall.error}
                </pre>
              )}

              {/* Approval buttons — subtle green / red as the user
                  asked for ("approve grün, reject rot, sauber, keine
                  Neonfarben"). Sits inline in the pending tool block
                  instead of a popup over the input. Enter / Esc still
                  trigger the head-of-queue approval (handled in
                  ChatView). */}
              {isPending && onApprove && onReject && (
                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); onApprove() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 dark:bg-emerald-500/10 hover:bg-emerald-500/15 dark:hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors"
                  >
                    <Check size={10} /> Approve
                  </button>
                  {alwaysRule && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        useCommandRulesStore.getState().allow(toolCall.ruleScope!, alwaysRule)
                        onApprove()
                      }}
                      data-testid="approve-always-here"
                      title="Approves this command, and from now on commands that start like this run without asking in this folder. You can remove the rule in Settings → Agent."
                      className="flex items-center gap-1 px-2.5 py-1 rounded t-micro text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-white/15 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
                    >
                      Always allow <code className="font-mono">{alwaysRule}</code> here
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onReject() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-red-700 dark:text-red-300 bg-red-500/10 dark:bg-red-500/10 hover:bg-red-500/15 dark:hover:bg-red-500/15 border border-red-500/20 dark:border-red-500/25 transition-colors"
                  >
                    <X size={10} /> Reject
                  </button>
                  <span className="ml-1 t-micro text-gray-400 dark:text-gray-600 font-mono">⏎ / Esc</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * CA U1: seconds on a call that is still going, so a long `npm install` reads
 * as working, not stuck. Quiet for the first 3 s: most reads end before that.
 */
function RunningFor({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.floor((now - since) / 1000)
  if (!Number.isFinite(s) || s < 3) return null
  return (
    <span className="t-micro tabular-nums text-gray-500 dark:text-gray-500" data-testid="tool-running-for">
      {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}
    </span>
  )
}
