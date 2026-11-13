import { useState, useRef, useEffect } from 'react'
import { Brain, Download, Upload, Trash2, Search, Plus, X, Check, Pencil, Zap, FileJson, Archive, Sparkles } from 'lucide-react'
import { useMemoryStore, effectiveMemoryBudget, describeMemoryImport } from '../../stores/memoryStore'
import { useRemoteStore } from '../../stores/remoteStore'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
import { getProviderIdFromModel } from '../../api/providers/model-name'
import type { ProviderId } from '../../api/providers/types'
import { useChatStore, persistConversationMemoryScope } from '../../stores/chatStore'
import { getModelMaxTokens } from '../../lib/context-compaction'
import { LongTextField } from '../ui/LongTextField'
// Eine Schreibweise fuer jedes Kontextfenster. Hier stand zweimal
// `Math.round(ctx / 1024)}K`, eine eigene Rechnung: bei 32000 Token sagte
// diese Zeile 31K und der Rest der Oberflaeche 31.3K.
import { formatContextWindow } from '../../lib/formatters'
import { GlowButton } from '../ui/GlowButton'
import { saveOrShare } from '../../lib/save-or-share'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import type { MemoryType, MemoryFile } from '../../types/agent-mode'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import { synchronizeMemoryCollection, type MemorySyncResolution } from '../../lib/memory-sync'
import { reviewPreviousMemories, finalizePreviousMemories, type LegacyMemoryReview } from '../../lib/memory-legacy'
import { MemoryRowDelete, MemoryUndoBar, useMemoryUndo } from '../chat/MemoryDelete'

// ── Subtle type indicator (internal, not user-facing) ─────────

// Vier Kategorien, vier Farben, und keine davon sagt etwas ueber gut oder
// kaputt. `feedback` war gelb und las sich dadurch als Warnung an einem
// Eintrag, der nur eine Sorte ist. Pink ist in dieser Datei sonst nicht
// vergeben (Blau, Lila und Gruen stehen schon hier), und es ist weit genug
// von Rot weg, um nicht wieder nach einem Fehler auszusehen.
const TYPE_DOT_COLORS: Record<MemoryType, string> = {
  user: 'bg-blue-400',
  feedback: 'bg-pink-400',
  project: 'bg-purple-400',
  reference: 'bg-green-400',
}

/**
 * Was ein stiller Extraktionsaufruf kostet, in den Worten des Zahlwegs, auf
 * dem er wirklich landet.
 *
 * Die ersten beiden Saetze sind wortgleich mit
 * the web app. Der dritte ist der Fall,
 * den es im Web nicht gibt: ein Server auf der eigenen Maschine schickt keine
 * Rechnung, und eine zu behaupten waere derselbe Fehler in die andere
 * Richtung.
 */
export const EXTRAKTIONSKOSTEN = {
  cloud: 'This runs a second, hidden model call every 3rd turn, billed like a chat turn. It uses the cheapest model in the catalogue, not the one you chat with.',
  eigenerSchluessel: 'This runs a second, hidden model call every 3rd turn, which adds to your API costs.',
  lokal: 'This runs a second, hidden model call every 3rd turn on your own machine. It costs no money, only time and memory.',
} as const

/** Welcher der drei Saetze fuer dieses Modell gilt. `null` = kein Modell gewaehlt. */
export function extraktionskostenFuer(
  activeModel: string | null,
  istLokal: (providerId: ProviderId) => boolean,
): string | null {
  if (!activeModel) return null
  const providerId = getProviderIdFromModel(activeModel)
  if (providerId === 'lu-cloud') return EXTRAKTIONSKOSTEN.cloud
  return istLokal(providerId) ? EXTRAKTIONSKOSTEN.lokal : EXTRAKTIONSKOSTEN.eigenerSchluessel
}

// ── Component ─────────────────────────────────────────────────

export function MemorySettings() {
  const revision = useMemoryStore(state => state.memoryCollectionRevision)
  return <MemorySettingsPanel key={revision} />
}

function MemorySettingsPanel() {
  const [syncConsent, setSyncConsent] = useState(false)
  const [sensitiveSyncConsent, setSensitiveSyncConsent] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const syncController = useRef<AbortController | null>(null)
  useEffect(() => () => {
    const controller = syncController.current
    syncController.current = null
    controller?.abort()
  }, [])
  const [syncMessage, setSyncMessage] = useState('')
  /**
   * Der Altpfad (R5-30, Entscheid vom 12.09.2026). `legacyReview` ist
   * der angesehene Befund, `confirmLegacyRemoval` das Haekchen darunter. Der
   * Befund lebt nur hier im Fenster: eine alte Kopie, die wir speichern, waere
   * wieder eine zweite Ablage.
   */
  const [legacyReview, setLegacyReview] = useState<LegacyMemoryReview | null>(null)
  const [confirmLegacyRemoval, setConfirmLegacyRemoval] = useState(false)
  const [syncConflicts, setSyncConflicts] = useState<Awaited<ReturnType<typeof synchronizeMemoryCollection>>['conflicts']>([])
  const owner = useCloudAuthStore(state => state.status === 'signed-in' ? state.user?.id : undefined)
  const activeOwner = useMemoryStore(state => state.activeMemoryOwner)
  const [collectionError, setCollectionError] = useState(false)
  const remoteMemoryNotice = useRemoteStore(s => s.memoryNotice)
  const conversation = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId))
  const [savedProject, setSavedProject] = useState<string | null>(null)
  const [projectSaveError, setProjectSaveError] = useState(false)
  const { entries, updateMemory, settings, updateMemorySettings, exportAsMarkdown, importFromMarkdown, exportAsJSON, importFromJSON } = useMemoryStore()
  const [search, setSearch] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  // A27: every delete here can be undone too, same bar as the Memory panel.
  const { removal, failed: undoFailed, remove, undo, dismiss } = useMemoryUndo()
  const [addingNew, setAddingNew] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Only the ASYNC half of the budget line is state; "no model selected" is a
  // fact the render already has and is derived below. Writing it from the
  // effect was a cascading render for something nothing had to be fetched for
  // (React 19 `set-state-in-effect`).
  const activeModel = useModelStore((s) => s.activeModel)
  // R5-41: der stille Aufruf laeuft auf dem Anbieter des aktiven Modells,
  // also sagt der Satz darunter, was DIESER Weg kostet.
  const providers = useProviderStore((s) => s.providers)
  const extraktionsKosten = extraktionskostenFuer(activeModel, (id) => providers[id]?.isLocal === true)
  const [budgetLabel, setBudgetLabel] = useState('')
  // Feature FF: reveal outdated (stale/superseded) entries, read-only.
  const [showOutdated, setShowOutdated] = useState(false)
  const [reembedState, setReembedState] = useState<'idle' | 'running' | 'done'>('idle')
  // Import feedback (a user-session 2026-06-07): report how many memories were
  // imported — or why none were. The import used to fail silently.
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => useMemoryStore.subscribe((state, previous) => {
    // Do not retain cloud previews after local editing or forgetting. A new
    // sync can fetch a fresh review; the durable metadata contains hashes only.
    if (state.entries !== previous.entries) {
      setSyncConflicts([])
      setLegacyReview(null)
      setConfirmLegacyRemoval(false)
    }
  }), [])
  const runSync = async (resolution?: MemorySyncResolution, quelle?: 'review' | 'finalize') => {
    if (activeOwner === null || !syncConsent || syncController.current) return
    const controller = new AbortController()
    syncController.current = controller
    setSyncBusy(true)
    setSyncConflicts([])
    setSyncMessage(quelle ? 'Checking previous memories...' : 'Synchronizing memories...')
    if (quelle !== 'finalize') { setLegacyReview(null); setConfirmLegacyRemoval(false) }
    try {
      if (quelle === 'review') {
        const review = await reviewPreviousMemories(activeOwner, controller.signal)
        if (syncController.current !== controller) return
        setLegacyReview(review)
        setSyncMessage('Review both versions before removing the previous cloud copy.')
        return
      }
      if (quelle === 'finalize') {
        if (!legacyReview || !confirmLegacyRemoval) return
        await finalizePreviousMemories(legacyReview, confirmLegacyRemoval, controller.signal)
        if (syncController.current !== controller) return
        setLegacyReview(null)
        setConfirmLegacyRemoval(false)
        setSyncMessage('Previous cloud copy removed. Older versions can no longer synchronize memories. Conversations keep synchronizing.')
        return
      }
      const result = await synchronizeMemoryCollection(activeOwner, sensitiveSyncConsent, resolution, controller.signal)
      if (syncController.current !== controller) return
      setSyncConflicts(result.conflicts)
      const omittedNote = result.omittedSensitive > 0
        ? ` ${result.omittedSensitive} sensitive ${result.omittedSensitive === 1 ? 'memory was' : 'memories were'} left out (not uploaded).`
        : ''
      setSyncMessage(`Synced ${result.uploaded} uploads and ${result.downloaded} downloads. ${result.conflicts.length} conflicting memories left unchanged.${omittedNote}`)
    } catch (error) {
      if (syncController.current !== controller) return
      if (quelle === 'finalize') { setLegacyReview(null); setConfirmLegacyRemoval(false) }
      const messages = ['This conflict changed. Sync again before choosing a version.',
        'Memory synchronization cancelled. Some changes may already be saved.',
        'Memories changed. Review the previous cloud copy again.',
        'Import and synchronize every previous memory before finalizing.']
      setSyncMessage(error instanceof Error && messages.includes(error.message) ? error.message
        : 'Could not complete memory synchronization. Check this account and try again. Some changes may already be saved.')
    } finally {
      if (syncController.current === controller) {
        syncController.current = null
        setSyncBusy(false)
      }
    }
  }

  // ── New memory form state ───────────────────────────────────
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newSensitive, setNewSensitive] = useState(false)
  const [useProject, setUseProject] = useState(true)
  const [addError, setAddError] = useState<string | null>(null)

  // ── Edit form state ─────────────────────────────────────────
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editScope, setEditScope] = useState('')

  // ── Context budget detection ────────────────────────────────
  const contextBudgetLabel = activeModel ? budgetLabel : 'No model selected'
  useEffect(() => {
    if (!activeModel) return
    let cancelled = false
    getModelMaxTokens(activeModel).then((ctx) => {
      if (cancelled) return
      const override = settings.maxMemoriesOverride
      const budget = effectiveMemoryBudget(ctx, override)
      const manual = override != null && override > 0 ? ' (manual)' : ''
      if (budget.budgetTokens === 0) {
        setBudgetLabel(`${formatContextWindow(ctx)} ctx, memory injection disabled`)
      } else {
        setBudgetLabel(`${formatContextWindow(ctx)} ctx, up to ${budget.maxMemories} memories injected${manual}`)
      }
    }).catch(() => { if (!cancelled) setBudgetLabel('') })
    return () => { cancelled = true }
  }, [activeModel, settings.maxMemoriesOverride])

  const isEntryStale = (e: MemoryFile) => e.stale === true || typeof e.supersededBy === 'string'
  const staleCount = entries.filter(isEntryStale).length

  const filtered = entries.filter(e => {
    // Hide outdated entries unless the user opted to reveal them.
    if (!showOutdated && isEntryStale(e)) return false
    if (search) {
      const q = search.toLowerCase()
      return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q))
    }
    return true
  })

  // ── Handlers ────────────────────────────────────────────────

  // Desktop and browser: a download, as before. Phone: the share sheet
  // (lib/save-or-share.ts). A failure is shown where import messages are.
  const exportMemory = async (filename: string, mime: string, text: string) => {
    const outcome = await saveOrShare({ filename, mime, text }, { via: 'anchor' })
    if (outcome.status === 'error') setImportMsg(`Export failed. ${outcome.error}`)
  }

  const handleExportMd = () => { void exportMemory('memory.md', 'text/markdown', exportAsMarkdown()) }

  const handleExportJSON = () => { void exportMemory('memory.json', 'application/json', exportAsJSON()) }

  // One Import button for BOTH .md and .json. The old UI wired the single
  // button only to the markdown picker, so the JSON path (jsonInputRef /
  // handleImportJSON) was unreachable — a user who imported a .json export saw
  // nothing happen (a user-session 2026-06-07). Route by extension, fall back
  // to sniffing the content, and always report the result.
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const reader = new FileReader()
    // Web gilt: die Sammlung wird an ZWEI Merkmalen festgehalten, nicht an
    // einem. Die Revisionsnummer steigt nur beim Wechsel der ganzen Sammlung;
    // wer waehrend des Lesens einen Eintrag anlegt oder loescht, aendert die
    // Liste, nicht die Nummer, und der Import haette in eine andere Lage
    // geschrieben als die, die der Nutzer vor sich hatte.
    const erwarteteEintraege = useMemoryStore.getState().entries
    const erwarteteRevision = useMemoryStore.getState().memoryCollectionRevision
    reader.onload = (ev) => {
      // Und der Abbruch ist nicht mehr stumm (R5-33). Ein stilles `return`
      // sah aus wie ein Import, der nichts gefunden hat, und der Nutzer
      // probierte dieselbe Datei noch einmal.
      if (
        useMemoryStore.getState().entries !== erwarteteEintraege ||
        useMemoryStore.getState().memoryCollectionRevision !== erwarteteRevision
      ) {
        setImportMsg('Memory collection changed. Choose the file again.')
        return
      }
      const content = ev.target?.result as string
      if (!content) { setImportMsg('Could not read that file.'); return }
      const trimmed = content.trimStart()
      const isJson = /\.json$/i.test(file.name) || trimmed.startsWith('{') || trimmed.startsWith('[')
      const result = isJson ? importFromJSON(content) : importFromMarkdown(content)
      setImportMsg(
        result.added + result.updated + result.alreadyPresent > 0
          ? describeMemoryImport(result)
          : 'No memories found in that file. Use an LU .md or .json export (JSON needs an "entries" or "memories" array).',
      )
    }
    reader.onerror = () => setImportMsg('Could not read that file.')
    reader.readAsText(file)
  }

  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    remove(entries.map(e => e.id))
    setConfirmClear(false)
  }

  // Feature FF: backfill embeddings for memories that don't have one yet
  // (created pre-v2.5.0, or while Ollama was down). Best-effort; the store
  // swallows per-entry failures and the call is idempotent.
  const handleReembed = async () => {
    if (reembedState === 'running') return
    setReembedState('running')
    try {
      await useMemoryStore.getState().ensureMemoryEmbeddings()
      setReembedState('done')
      setTimeout(() => setReembedState('idle'), 2500)
    } catch {
      setReembedState('idle')
    }
  }

  const handleAddMemory = () => {
    // Both fields are required. Give inline feedback instead of a silent no-op
    // so the Save button never looks broken.
    if (!newTitle.trim()) { setAddError('Add a title.'); return }
    if (!newContent.trim()) { setAddError('Add some details.'); return }
    const id = useMemoryStore.getState().addMemory({
      type: 'user',
      title: newTitle.trim().substring(0, 60),
      description: newContent.trim().substring(0, 120),
      content: newContent.trim(),
      tags: [],
      source: 'manual',
      sensitive: newSensitive,
      scope: useProject ? conversation?.memoryScope : undefined,
    })
    // An empty id means the store refused the record, and the only reason left
    // after the two checks above is a memory that is already there. Saying so
    // beats clearing the fields and closing the form, which is what this did
    // until R5-32: the text was gone and the page looked like it had saved.
    if (!id) { setAddError('This memory is already saved.'); return }
    setNewTitle('')
    setNewContent('')
    setNewSensitive(false)
    setAddError(null)
    setAddingNew(false)
  }

  const startEdit = (entry: MemoryFile) => {
    setEditingId(entry.id)
    setEditTitle(entry.title)
    setEditContent(entry.content)
    setEditScope(entry.scope ?? '')
  }

  const saveEdit = () => {
    if (!editingId || !editTitle.trim() || !editContent.trim()) return
    updateMemory(editingId, {
      title: editTitle.trim().substring(0, 60),
      content: editContent.trim(),
      description: editContent.trim().substring(0, 120),
      scope: editScope.trim() || undefined,
    })
    setEditingId(null)
  }

  return (
    <div className="space-y-3">
      <section aria-label="Memory collection" className="space-y-2 rounded-lg border border-gray-200 p-3 text-xs text-gray-700 dark:border-white/10 dark:text-gray-300">
        <p>Memory collection: {activeOwner === null ? 'Local' : 'Signed-in account'}</p>
        <p>Local memories stay separate. Account collections are saved on this device. Cloud sync runs only when explicitly requested below.</p>
        <button className="mr-3 underline" disabled={activeOwner === null} onClick={() => setCollectionError(!useMemoryStore.getState().selectMemoryCollection(null))}>Use local memories</button>
        {owner && <button className="underline" disabled={activeOwner === owner} onClick={() => setCollectionError(!useMemoryStore.getState().selectMemoryCollection(owner))}>Use account memories</button>}
        {collectionError && <p role="alert">Could not open this memory collection. Existing data has not been replaced.</p>}
        {activeOwner !== null && <div className="space-y-2 border-t border-gray-200 pt-2 dark:border-white/10">
          <p>Sync uploads this account collection to LU Cloud and downloads changes. Deletions are shared across devices. Conflicting edits are not overwritten automatically.</p>
          <p>Marking a memory sensitive does not erase existing cloud copies. Delete the memory and sync to request its removal from cloud sync.</p>
          <label className="block"><input type="checkbox" checked={syncConsent} disabled={syncBusy} onChange={event => setSyncConsent(event.target.checked)} /> Allow cloud storage for this account collection</label>
          <label className="block"><input type="checkbox" checked={sensitiveSyncConsent} disabled={syncBusy} onChange={event => setSensitiveSyncConsent(event.target.checked)} /> Also allow cloud storage of sensitive memories</label>
          <button className="mr-3 underline disabled:opacity-50" disabled={!syncConsent || syncBusy} onClick={() => void runSync()}>Sync account memories</button>
          {syncBusy && <button className="ml-3 underline" onClick={() => syncController.current?.abort()}>Cancel synchronization</button>}
          {syncMessage && <p role="status">{syncMessage}</p>}
          {/* R5-30: der Altpfad. Vor dem heutigen Protokoll lag die
              Kontosammlung als EIN Blob in der Wolke. Das Web konnte ihn
              ansehen und entfernen, der Desktop nicht, also blieb er dort
              liegen, wo der Kunde ihn nie zu Gesicht bekam. Ansehen zuerst,
              entfernen nur mit Haekchen: eine alte Kopie ist manchmal die
              einzige, und wer sie ungesehen wegwirft, merkt es spaeter. */}
          <button className="block underline disabled:opacity-50" disabled={!syncConsent || syncBusy} onClick={() => void runSync(undefined, 'review')}>Review previous cloud copy for removal</button>
          {legacyReview && <div className="space-y-2 rounded border border-gray-200 p-2 dark:border-white/10" role="group" aria-label="Legacy memory finalization review">
            <details><summary className="cursor-pointer">Compare both versions</summary>
              <p>Previous cloud copy</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(legacyReview.previous, null, 2)}</pre>
              <p>Synchronized versions, including deletions</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(legacyReview.current, null, 2)}</pre>
            </details>
            <label className="block"><input type="checkbox" checked={confirmLegacyRemoval} disabled={syncBusy} onChange={event => setConfirmLegacyRemoval(event.target.checked)} /> I reviewed these versions and confirm removing the previous cloud copy, including any differences.</label>
            <button className="underline disabled:opacity-50" disabled={!syncConsent || syncBusy || !confirmLegacyRemoval} onClick={() => void runSync(undefined, 'finalize')}>Remove previous cloud copy</button>
          </div>}
          {syncConflicts.map((conflict, index) => {
            const local = entries.find(entry => entry.id === conflict.id)
            const review = conflict.review
            return <div key={conflict.id} role="group" aria-label={`Memory conflict ${index + 1}`} className="space-y-2 border-t border-gray-200 pt-2 dark:border-white/10">
              <p>Conflicting memory: {local?.title ?? conflict.id}</p>
              {review ? <>
                <details><summary className="cursor-pointer">Compare full memory records</summary>
                  <p>Local version</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(local, null, 2)}</pre>
                  <p>Cloud version, revision {review.token.remoteRevision}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(review.cloud, null, 2)}</pre>
                </details>
                <p>Choosing a version replaces the other version, including scope and privacy settings. Newer changes require another review.</p>
                <button className="mr-3 underline disabled:opacity-50" disabled={!syncConsent || syncBusy} onClick={() => void runSync({ ...review.token, choice: 'local' })}>Keep local version</button>
                <button className="underline disabled:opacity-50" disabled={!syncConsent || syncBusy} onClick={() => void runSync({ ...review.token, choice: 'cloud' })}>Use cloud version</button>
              </> : <p>The cloud record is missing or has an inconsistent deletion history. No version was overwritten. Sync again after checking the account.</p>}
            </div>
          })}
        </div>}
      </section>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain size={14} className="text-purple-400" />
          <span className="text-[0.65rem] text-gray-500">
            {entries.length} {entries.length === 1 ? 'memory' : 'memories'}
          </span>
        </div>
      </div>

      {/* Context budget indicator */}
      {contextBudgetLabel && (
        <div className="text-[0.6rem] text-gray-500 bg-gray-100 dark:bg-white/[0.03] rounded-lg px-2.5 py-1.5 border border-gray-200 dark:border-white/5">
          {contextBudgetLabel}
        </div>
      )}

      {/* Manual memory limit — override the context-derived count (the owner
          2026-06-07: "memory limit selber setzen, nicht 32k = 15 memories").
          Blank = auto (tier-based).

          R2-23: das Feld nahm 0 an, und `effectiveMemoryBudget` liest 0 als
          "nicht gesetzt". Wer 0 eintrug, um Erinnerungen abzustellen, bekam
          also den vollen Stufenwert, und das Feld zeigte danach seine eigene 0
          als Beleg. Das Feld beginnt deshalb bei 1: abstellen geht ueber den
          Schalter darueber, nicht ueber eine Zahl, die das Gegenteil bewirkt.
          Ein alter gespeicherter Nullwert wird als "nicht gesetzt" gezeigt,
          also leer mit Platzhalter Auto, und genau so wirkt er auch. */}
      <div className="flex items-center justify-between gap-2 text-[0.6rem] text-gray-500 px-0.5">
        <span>Max memories injected</span>
        <input
          type="number"
          min={1}
          max={100}
          data-testid="memory-max-override"
          value={settings.maxMemoriesOverride || ''}
          placeholder="Auto"
          onChange={(e) => {
            const v = e.target.value.trim()
            const n = v === '' ? null : Math.max(1, Math.min(100, Math.floor(Number(v) || 1)))
            updateMemorySettings({ maxMemoriesOverride: n })
          }}
          className="w-16 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 text-gray-900 dark:text-white text-right placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
          title="How many memories to inject into the prompt. Blank = auto (based on your model's context size)."
        />
      </div>

      {/* Settings toggles */}
      <div className="space-y-1.5 pb-2 border-b border-gray-200 dark:border-white/5">
        <div className="flex items-center justify-between py-0.5">
          <div className="flex items-center gap-1.5">
            {/* Dasselbe Grau wie das Archiv-Symbol eine Zeile tiefer: ein
                Symbol vor einem Schalter ist Schmuck und kein Zustand. Gelb
                machte aus einer Einstellung eine Warnung. */}
            <Zap size={11} className="text-gray-500" />
            <span className="text-[0.65rem] text-gray-400">Auto-extract memories</span>
            <span className="text-[0.5rem] text-gray-600">(extra inference, on out of the box)</span>
          </div>
          <button
            onClick={() => updateMemorySettings({ autoExtractEnabled: !settings.autoExtractEnabled })}
            className={`relative w-7 h-3.5 rounded-full transition-colors ${settings.autoExtractEnabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${settings.autoExtractEnabled ? 'translate-x-3.5' : ''}`} />
          </button>
        </div>

        {settings.autoExtractEnabled && (<>
          {/*
            * Die Kostenzeile stand bis 3.0.0 in Settings > AI Backends, hinter
            * dem Zweig "dieser Anbieter braucht einen Schluessel" (R5-41).
            * `lu-cloud` braucht keinen, also las genau der Kunde sie nie, dem
            * der stille Aufruf wirklich berechnet wird. Sie gehoert neben den
            * Schalter, den sie beschreibt.
            *
            * Drei Faelle, weil der Desktop drei hat und das Web zwei: der
            * Aufruf laeuft auf dem Anbieter des aktiven Modells
            * (`useMemory.resolveSilentCall`). Bei LU Cloud kostet er Guthaben,
            * bei einem eigenen Schluessel Geld beim Anbieter, und auf einem
            * Server auf der eigenen Maschine kostet er kein Geld. Die ersten
            * beiden Saetze sind die des Web, der dritte behauptet keine
            * Rechnung, die es nicht gibt.
            */}
          <p className={`text-[0.55rem] ${HINWEIS_TEXT.ruhig} pl-4 leading-tight`}>
            {extraktionsKosten}
          </p>
          <div className="flex items-center justify-between py-0.5 pl-4">
            <span className="text-[0.6rem] text-gray-500">Also extract outside Agent Mode</span>
            <button
              onClick={() => updateMemorySettings({ autoExtractInAllModes: !settings.autoExtractInAllModes })}
              className={`relative w-7 h-3.5 rounded-full transition-colors ${settings.autoExtractInAllModes ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${settings.autoExtractInAllModes ? 'translate-x-3.5' : ''}`} />
            </button>
          </div>
        </>)}
      </div>

      {/* Search */}
      {conversation && (
        <label className="block text-xs text-gray-500">
          Memory project ID for this conversation
          <input value={conversation.memoryScope ?? ''} maxLength={128}
            onChange={e => useChatStore.getState().setConversationMemoryScope(conversation.id, e.target.value)}
            placeholder="Blank uses global memories only"
            className="block w-full rounded border border-gray-300 bg-transparent p-2" />
          Use the same stable ID in related conversations. Changes apply to future requests, not a running response. Existing memories are not moved, and earlier conversation content is not removed.
          <button type="button" onClick={async () => {
            const key = JSON.stringify([conversation.id, conversation.memoryScope])
            setSavedProject(null)
            setProjectSaveError(false)
            const saved = await persistConversationMemoryScope(conversation.id, conversation.memoryScope)
            if (saved) setSavedProject(key)
            else setProjectSaveError(true)
          }} className="block rounded border p-1">Save project assignment</button>
          {savedProject === JSON.stringify([conversation.id, conversation.memoryScope]) && <span role="status">Project assignment saved</span>}
          {projectSaveError && <span role="alert">Could not verify the saved project assignment. Try again before closing the app.</span>}
        </label>
      )}
      <p className="text-xs text-gray-500">Mark sensitive memories to exclude them from AI requests and embeddings. This does not detect secrets automatically or erase earlier requests. Markdown export omits sensitive and project-scoped entries; JSON export preserves their flags and scope.</p>
      <p className="text-xs text-gray-500" role="note">Remote sessions can retain previously shared memory in their prompts. This control cannot revoke those copies. End the remote session before handling sensitive data.</p>
      {remoteMemoryNotice && <p role="status" className="text-sm text-red-600 dark:text-red-300">{remoteMemoryNotice}</p>}
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memories..."
          className="w-full pl-7 pr-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 text-[0.65rem] text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
        />
      </div>

      {/* Show outdated toggle — only surfaces when there ARE outdated entries */}
      {staleCount > 0 && (
        <div className="flex items-center justify-between py-0.5">
          <div className="flex items-center gap-1.5">
            <Archive size={11} className="text-gray-500" />
            <span className="text-[0.6rem] text-gray-500">Show outdated ({staleCount})</span>
          </div>
          <button
            onClick={() => setShowOutdated((v) => !v)}
            className={`relative w-7 h-3.5 rounded-full transition-colors ${showOutdated ? 'bg-gray-500' : 'bg-gray-300 dark:bg-gray-700'}`}
            aria-label="Toggle outdated memories"
          >
            <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${showOutdated ? 'translate-x-3.5' : ''}`} />
          </button>
        </div>
      )}

      {/* Add new memory */}
      {addingNew ? (
        <div className="space-y-1.5 p-2.5 rounded-lg border border-white/10 bg-white/[0.02]">
          <input
            value={newTitle}
            onChange={(e) => { setNewTitle(e.target.value); if (addError) setAddError(null) }}
            placeholder="What should I remember?"
            maxLength={60}
            className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/20"
            autoFocus
          />
          <LongTextField
            value={newContent}
            onChange={(v) => { setNewContent(v); if (addError) setAddError(null) }}
            storageKey="memory-content"
            label="Memory details"
            placeholder="Details… (required)"
            rows={2}
            className="block w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none"
          />
          {addError && (
            <p className="text-[0.55rem] text-red-400 px-0.5">{addError}</p>
          )}
          <label className="flex gap-2 text-xs">
            <input type="checkbox" checked={newSensitive} onChange={e => setNewSensitive(e.target.checked)} />
            Sensitive: exclude from AI requests
          </label>
          {conversation?.memoryScope && <label className="flex gap-2 text-xs">
            <input type="checkbox" checked={useProject} onChange={e => setUseProject(e.target.checked)} />
            Save in project {conversation.memoryScope}
          </label>}
          <div className="flex gap-1.5">
            <button
              onClick={handleAddMemory}
              disabled={!newTitle.trim() || !newContent.trim()}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-[0.6rem] hover:bg-green-500/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-green-500/20"
            >
              <Check size={10} /> Save
            </button>
            <button onClick={() => { setAddingNew(false); setNewTitle(''); setNewContent(''); setAddError(null) }} className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 text-gray-400 text-[0.6rem] hover:bg-white/10">
              <X size={10} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setAddError(null); setAddingNew(true) }}
          className="w-full flex items-center justify-center gap-1 py-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-300 dark:border-white/10 text-[0.6rem] text-gray-500 hover:text-gray-300 hover:border-white/20 transition-colors"
        >
          <Plus size={10} /> Add Memory
        </button>
      )}

      {/* Entries list */}
      <div className="space-y-0.5 max-h-[280px] overflow-y-auto scrollbar-thin">
        {filtered.length === 0 && (
          <p className="text-[0.65rem] text-gray-500 text-center py-4">
            {entries.length === 0 ? 'No memories yet. The AI will learn about you over time.' : 'No matches.'}
          </p>
        )}
        {filtered.map(entry => {
          if (editingId === entry.id) {
            return (
              <div key={entry.id} className="space-y-1.5 p-2 rounded-lg border border-white/10 bg-white/[0.02]">
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  maxLength={60}
                  className="w-full px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 focus:outline-none"
                />
                <LongTextField
                  value={editContent}
                  onChange={setEditContent}
                  storageKey="memory-content"
                  label="Memory details"
                  rows={2}
                  className="block w-full px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 focus:outline-none"
                />
                <div className="flex gap-1.5">
                  <label className="text-xs">Project ID
                    <input value={editScope} maxLength={128} onChange={e => setEditScope(e.target.value)}
                      placeholder="Blank is global" className="block rounded border p-1" />
                  </label>
                  <button onClick={saveEdit} className="flex items-center gap-1 px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-[0.6rem]">
                    <Check size={10} /> Save
                  </button>
                  <button onClick={() => setEditingId(null)} className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 text-gray-400 text-[0.6rem]">
                    <X size={10} /> Cancel
                  </button>
                </div>
              </div>
            )
          }

          const stale = isEntryStale(entry)
          return (
            <div key={entry.id} className={`flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.03] group ${stale ? 'opacity-50' : ''}`}>
              <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${TYPE_DOT_COLORS[entry.type]}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-[0.65rem] font-medium text-gray-800 dark:text-gray-200 truncate">{entry.title}</p>
                  {stale && (
                    <span className="flex items-center gap-0.5 text-[0.45rem] uppercase tracking-wider text-gray-500 border border-gray-600/40 rounded px-1 py-px shrink-0" title="Outdated, kept for reference, not injected into prompts">
                      <Archive size={8} /> outdated
                    </span>
                  )}
                </div>
                <p className="text-[0.6rem] text-gray-500 break-words line-clamp-2">{entry.content}</p>
                {entry.scope !== undefined && <p className="text-xs text-gray-500 break-words">Project: {entry.scope}</p>}
                <p className="text-xs text-gray-500">Source: {entry.sourceKind ?? (entry.source === 'manual' ? 'manual' : 'unknown')}</p>
                <p className="text-xs text-gray-500">{entry.confirmedAt ? `Reviewed: ${new Date(entry.confirmedAt).toLocaleString('en-US')}` : 'Not reviewed'}</p>
                {!stale && <button className="text-xs text-gray-500 underline" onClick={() => useMemoryStore.getState().confirmMemory(entry.id)}>Confirm reviewed</button>}
                <label className="flex gap-2 text-xs text-gray-500">
                  <input type="checkbox" checked={entry.sensitive === true}
                    onChange={e => updateMemory(entry.id, { sensitive: e.target.checked })} />
                  Sensitive: exclude from AI requests
                </label>
              </div>
              {/* Always visible (A27): behind `group-hover` they never showed
                  where WebKitGTK reports no hover (MemoryDelete.tsx). */}
              <div className="flex items-center gap-0.5 shrink-0">
                {/* Outdated entries are read-only — no edit affordance. */}
                {!stale && (
                  <button
                    onClick={() => startEdit(entry)}
                    className="p-0.5 rounded hover:bg-white/10 text-gray-600 hover:text-gray-300"
                    aria-label="Edit entry"
                  >
                    <Pencil size={10} />
                  </button>
                )}
                <MemoryRowDelete title={entry.title} onDelete={() => remove([entry.id])} />
              </div>
            </div>
          )
        })}
      </div>

      <MemoryUndoBar removal={removal} failed={undoFailed} onUndo={undo} onDismiss={dismiss} />

      {/* Re-embed all — backfills missing memory embeddings (Feature FF) */}
      {entries.length > 0 && (
        <GlowButton
          variant="secondary"
          onClick={handleReembed}
          className="w-full text-[0.6rem] flex items-center justify-center gap-1"
        >
          <Sparkles size={10} />
          {reembedState === 'running' ? 'Re-embedding…' : reembedState === 'done' ? 'Embeddings updated' : 'Re-embed all'}
        </GlowButton>
      )}

      {/* Actions */}
      <div className="flex gap-1.5">
        <GlowButton variant="secondary" onClick={handleExportMd} className="flex-1 text-[0.6rem] flex items-center justify-center gap-1">
          <Download size={10} /> .md
        </GlowButton>
        <GlowButton variant="secondary" onClick={handleExportJSON} className="flex-1 text-[0.6rem] flex items-center justify-center gap-1">
          <FileJson size={10} /> .json
        </GlowButton>
        <GlowButton variant="secondary" onClick={() => fileInputRef.current?.click()} className="flex-1 text-[0.6rem] flex items-center justify-center gap-1">
          <Upload size={10} /> Import
        </GlowButton>
        <GlowButton
          variant={confirmClear ? 'danger' : 'secondary'}
          onClick={handleClear}
          className="text-[0.6rem] flex items-center justify-center gap-1 px-2.5"
        >
          <Trash2 size={10} /> {confirmClear ? 'Sure?' : 'Delete all'}
        </GlowButton>
        <input ref={fileInputRef} type="file" accept=".md,.txt,.json" onChange={handleImport} className="hidden" />
      </div>

      {importMsg && (
        <p className="text-[0.6rem] text-gray-500 dark:text-gray-400 px-0.5">{importMsg}</p>
      )}
    </div>
  )
}
