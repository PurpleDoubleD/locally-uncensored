// Watchers: the window's half. Rust's clock says a watcher is due
// (`watchers-due`); this runs it as a normal agent turn in the watcher's own
// chat, the same way a turn from the paired phone runs
// (lib/remote-chats-start.ts): open the chat, put the watcher's rights over it
// as a cap, send the task through the composer's own send path, read the
// answer, report back, notify.
//
// The send path is the one a typed message takes, so every guard of a normal
// run is there: the loop guard and the search spiral, the working-folder
// jail, Autocompact, the cost notices. No credit cap on top (David,
// 14.11.2026): the user decides what a watcher may cost.
//
// Nobody sits in front of the run. A question it still asks (a per-tool "ask",
// a made-up web address, a settings card) is answered no at once, so the run
// goes on or ends instead of waiting ten minutes for a card nobody sees.
//
// Everything this file touches comes in through `RunnerDeps`, so the rules
// are tested without React or Tauri.
import type { PermissionMap } from '../../api/mcp/types'
import { watcherCaps } from './caps'
import { clockText } from './schedule'
import type { Watcher, WatcherListing, WatcherPatch, WatcherRun } from './types'

export const DUE_EVENT = 'watchers-due'
export const CHANGED_EVENT = 'watchers-changed'
const SUMMARY_MAX = 280

export interface RunnerView {
  convId: string | null
  restore: () => void
}

export interface RunnerDeps {
  now: () => number
  /** Does the chat still exist (the user may have deleted it). */
  chatExists: (convId: string) => boolean
  /** A new Agent chat for the watcher; returns its id. */
  createChat: (w: Watcher) => string
  /** The working folder of the run: the watcher's folder, else the chat's own. */
  setWorkspace: (convId: string, folder: string | null, extra: string[]) => void
  setCaps: (convId: string, caps: Partial<PermissionMap>) => void
  clearCaps: (convId: string) => void
  /** Waits while someone types at the desktop (lib/remote-desk-gate). */
  waitForDesk: (convId: string, title: string) => Promise<boolean>
  /** What is open now, and how to go back to it after the run. */
  currentView: () => RunnerView
  focus: (convId: string) => void
  /** Picks the watcher's model; returns how to put the user's back. */
  useModel: (model: string | null) => () => void
  /** Runs one turn like the composer; resolves at its end. */
  send: (convId: string, content: string) => Promise<void>
  /** The last answer in the chat after `since`: its text and error, if any. */
  lastAnswer: (convId: string, since: number) => { text: string; error?: string } | null
  wasStopped: (convId: string) => boolean
  /** Answers every question of this chat with no while the run lasts. */
  denyQuestions: (convId: string) => () => void
  update: (id: string, patch: WatcherPatch) => Promise<unknown>
  finished: (id: string, run: WatcherRun) => Promise<unknown>
  notify: (title: string, body: string, sound: boolean) => Promise<unknown>
  notifySettings: () => { notify: boolean; sound: boolean; notifyOn: 'all' | 'errors' }
}

/** The order the model gets: the task, and that nobody can answer now. */
export function watcherPrompt(w: Watcher, at: number): string {
  return `${w.task.trim()}\n\n(Watcher "${w.name}", run of ${clockText(at)}. Nobody is watching this run: `
    + 'do not ask questions, do the task with the tools you have, and end with a short result.)'
}

/** A short line out of an answer, for the list and the notification. */
export function summaryOf(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > SUMMARY_MAX ? `${plain.slice(0, SUMMARY_MAX - 1)}…` : plain
}

/** Does this run get a notification under these settings. */
export function shouldNotify(status: WatcherRun['status'], s: { notify: boolean; notifyOn: 'all' | 'errors' }): boolean {
  if (!s.notify || status === 'stopped') return false
  return s.notifyOn === 'all' || status === 'failed'
}

export function createWatcherRunner(deps: RunnerDeps) {
  // One run at a time: two watchers due in the same minute run one after the
  // other, never two turns fighting over the open chat.
  let chain: Promise<void> = Promise.resolve()

  async function run(w: Watcher): Promise<void> {
    const started = deps.now()
    let convId = w.conversation_id && deps.chatExists(w.conversation_id) ? w.conversation_id : null
    if (!convId) {
      convId = deps.createChat(w)
      await deps.update(w.id, { conversationId: convId }).catch(() => null)
    }
    deps.setWorkspace(convId, w.folder, w.rights.extra_folders)
    deps.setCaps(convId, watcherCaps(w.rights))
    const undeny = deps.denyQuestions(convId)
    let restoreModel: (() => void) | null = null
    let view: RunnerView | null = null
    let status: WatcherRun['status'] = 'done'
    let summary = ''
    try {
      const go = await deps.waitForDesk(convId, w.name)
      if (!go) {
        status = 'stopped'
        summary = 'Stopped before it ran.'
      } else {
        view = deps.currentView()
        deps.focus(convId)
        restoreModel = deps.useModel(w.model)
        await deps.send(convId, watcherPrompt(w, started))
        const answer = deps.lastAnswer(convId, started)
        if (answer?.error) {
          status = 'failed'
          summary = summaryOf(answer.error)
        } else if (answer && answer.text.trim()) {
          summary = summaryOf(answer.text)
        } else if (deps.wasStopped(convId)) {
          status = 'stopped'
          summary = 'Stopped.'
        } else {
          status = 'failed'
          summary = 'The run ended without an answer.'
        }
      }
    } catch (e) {
      status = 'failed'
      summary = summaryOf(e instanceof Error ? e.message : String(e))
    } finally {
      undeny()
      deps.clearCaps(convId)
      restoreModel?.()
      // Back to what was open, unless the user went somewhere else meanwhile.
      if (view && view.convId !== convId && deps.currentView().convId === convId) view.restore()
    }
    await deps.finished(w.id, { at: started, ms: Math.max(0, deps.now() - started), status, summary }).catch(() => null)
    const s = deps.notifySettings()
    if (shouldNotify(status, s)) {
      const title = status === 'done' ? w.name : `${w.name} failed`
      await deps.notify(title, summary || 'Done.', s.sound).catch(() => null)
    }
  }

  return {
    /** A watcher is due. Queued behind a run that is still going. */
    due(w: Watcher): Promise<void> {
      chain = chain.then(() => run(w)).catch(() => {})
      return chain
    },
  }
}

// ── The real window ──────────────────────────────────────────────

let started: Promise<() => void> | null = null

/** Listen for the clock for the life of the window. Once. */
export function startWatcherRunner(): Promise<() => void> {
  if (started) return started
  started = (async () => {
    const [
      { backendCall, isTauri }, { listen },
      { useChatStore }, { useUIStore }, { useCodexStore }, { useModelStore }, { useAgentModeStore },
      { useWatcherStore, useWatcherSettingsStore }, caps, approvals, senders, runStop,
      { useSettingsConfirmStore }, { useWebUrlConfirmStore },
    ] = await Promise.all([
      import('../../api/backend'), import('@tauri-apps/api/event'),
      import('../../stores/chatStore'), import('../../stores/uiStore'), import('../../stores/codexStore'), import('../../stores/modelStore'),
      import('../../stores/agentModeStore'), import('../../stores/watcherStore'), import('../remote-turn-caps'), import('../approval-queue'),
      import('../remote-chat-senders'), import('../run-stop'),
      import('../../stores/settingsConfirmStore'), import('../../stores/webUrlConfirmStore'),
    ])
    if (!isTauri()) return () => {}
    const refresh = async (cmd = 'watchers_list') => {
      try { useWatcherStore.getState().set(await backendCall<WatcherListing>(cmd)) } catch { /* the list stays as it was */ }
    }
    // A run the old page had started is gone with it.
    await refresh('watchers_runner_ready')

    const deps: RunnerDeps = {
      now: () => Date.now(),
      chatExists: (id) => useChatStore.getState().conversations.some((c) => c.id === id),
      createChat: (w) => {
        const store = useChatStore.getState()
        const model = w.model || useModelStore.getState().activeModel || ''
        const id = store.createConversation(model, '', 'lu')
        useAgentModeStore.getState().setAgentModeActive(id, true)
        store.renameConversation(id, `Watcher · ${w.name}`)
        return id
      },
      setWorkspace: (convId, folder, extra) => {
        useAgentModeStore.getState().setWorkspace(convId, folder
          ? { kind: 'folder', path: folder, ...(extra.length ? { extraPaths: extra } : {}) }
          : { kind: 'sandbox', ...(extra.length ? { extraPaths: extra } : {}) })
      },
      setCaps: caps.setCapMap,
      clearCaps: caps.clearTurnCaps,
      waitForDesk: async (convId, title) => {
        const gate = (await import('../remote-desk-gate')).windowDeskGate()
        return gate ? gate.wait(convId, title).ready : true
      },
      currentView: () => {
        const convId = useChatStore.getState().activeConversationId
        const view = useUIStore.getState().currentView
        const mode = useCodexStore.getState().chatMode
        return {
          convId,
          restore: () => {
            useCodexStore.getState().setChatMode(mode)
            if (convId) useChatStore.getState().setActiveConversation(convId)
            useUIStore.getState().setView(view)
          },
        }
      },
      focus: (convId) => {
        useCodexStore.getState().setChatMode('lu')
        useChatStore.getState().setActiveConversation(convId)
        useUIStore.getState().setView('chat')
      },
      useModel: (model) => {
        const before = useModelStore.getState().activeModel
        if (!model || model === before || !useModelStore.getState().models.some((m) => m.name === model)) return () => {}
        useModelStore.getState().setActiveModel(model)
        return () => { if (before && useModelStore.getState().activeModel === model) useModelStore.getState().setActiveModel(before) }
      },
      send: async (convId, content) => {
        const sender = await senders.waitForChatSender('chat')
        if (!sender) throw new Error('The chat did not open in the window.')
        if (useChatStore.getState().activeConversationId !== convId) throw new Error('Another chat was opened before the run could start.')
        runStop.beginRun(convId)
        await sender.send(content, [], [])
      },
      lastAnswer: (convId, since) => {
        const conv = useChatStore.getState().conversations.find((c) => c.id === convId)
        const last = [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && (m.timestamp ?? 0) >= since)
        if (!last) return null
        return { text: last.content ?? '', error: last.error ? (last.error.detail || `The run failed (${last.error.kind}).`) : undefined }
      },
      wasStopped: (convId) => runStop.isRunStopped(convId),
      denyQuestions: (convId) => {
        const answerAll = () => {
          for (const call of approvals.listApprovals(convId)) approvals.answerApproval(convId, call.id, false, 'desktop')
          for (const w of useSettingsConfirmStore.getState().queue) if (w.req.conversationId === convId) useSettingsConfirmStore.getState().answer(w.req.id, false)
          for (const w of useWebUrlConfirmStore.getState().queue) if (w.req.conversationId === convId) useWebUrlConfirmStore.getState().answer(w.req.id, false)
        }
        const offs = [approvals.subscribeApprovals(answerAll), useSettingsConfirmStore.subscribe(answerAll), useWebUrlConfirmStore.subscribe(answerAll)]
        return () => { for (const off of offs) off() }
      },
      update: async (id, patch) => {
        // The chat counts as the watcher's at once, not only when Rust's
        // `watchers-changed` comes back: the run that starts right after must
        // already be refused the watcher and settings tools
        // (lib/self-control-policy.ts, hooks/useChat.ts wantsWatcherTools).
        if (patch.conversationId) {
          const { watchers, hints } = useWatcherStore.getState()
          useWatcherStore.getState().set({ watchers: watchers.map((w) => (w.id === id ? { ...w, conversation_id: patch.conversationId! } : w)), hints })
        }
        return backendCall('watchers_update', { id, patch })
      },
      finished: (id, run) => backendCall('watchers_finished', { id, run }),
      notify: (title, body, sound) => backendCall('watchers_notify', { title, body, sound }),
      notifySettings: () => {
        const s = useWatcherSettingsStore.getState()
        return { notify: s.notify, sound: s.sound, notifyOn: s.notifyOn }
      },
    }
    const runner = createWatcherRunner(deps)
    const offDue = await listen<Watcher>(DUE_EVENT, (e) => { void runner.due(e.payload) })
    const offChanged = await listen(CHANGED_EVENT, () => { void refresh() })
    return () => { offDue(); offChanged() }
  })()
  return started
}
