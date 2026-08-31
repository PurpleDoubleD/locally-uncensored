import { useState, useRef, useEffect } from 'react'
import { Brain, Download, Upload, Trash2, Search, Plus, X, Check, Pencil, Zap, FileJson, Archive, Sparkles } from 'lucide-react'
import { useMemoryStore, effectiveMemoryBudget } from '../../stores/memoryStore'
import { useModelStore } from '../../stores/modelStore'
import { getModelMaxTokens } from '../../lib/context-compaction'
import { GlowButton } from '../ui/GlowButton'
import type { MemoryType, MemoryFile } from '../../types/agent-mode'

// ── Subtle type indicator (internal, not user-facing) ─────────

const TYPE_DOT_COLORS: Record<MemoryType, string> = {
  user: 'bg-blue-400',
  feedback: 'bg-amber-400',
  project: 'bg-purple-400',
  reference: 'bg-green-400',
}

// ── Component ─────────────────────────────────────────────────

export function MemorySettings() {
  const { entries, removeMemory, updateMemory, clearAll, settings, updateMemorySettings, exportAsMarkdown, importFromMarkdown, exportAsJSON, importFromJSON } = useMemoryStore()
  const [search, setSearch] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [addingNew, setAddingNew] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Only the ASYNC half of the budget line is state; "no model selected" is a
  // fact the render already has and is derived below. Writing it from the
  // effect was a cascading render for something nothing had to be fetched for
  // (React 19 `set-state-in-effect`).
  const activeModel = useModelStore((s) => s.activeModel)
  const [budgetLabel, setBudgetLabel] = useState('')
  // Feature FF: reveal outdated (stale/superseded) entries, read-only.
  const [showOutdated, setShowOutdated] = useState(false)
  const [reembedState, setReembedState] = useState<'idle' | 'running' | 'done'>('idle')
  // Import feedback (konata-session 2026-06-07): report how many memories were
  // imported — or why none were. The import used to fail silently.
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── New memory form state ───────────────────────────────────
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  // ── Edit form state ─────────────────────────────────────────
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')

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
        setBudgetLabel(`${Math.round(ctx / 1024)}K ctx, memory injection disabled`)
      } else {
        setBudgetLabel(`${Math.round(ctx / 1024)}K ctx, up to ${budget.maxMemories} memories injected${manual}`)
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

  const handleExportMd = () => {
    const md = exportAsMarkdown()
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'memory.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleExportJSON = () => {
    const json = exportAsJSON()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'memory.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  // One Import button for BOTH .md and .json. The old UI wired the single
  // button only to the markdown picker, so the JSON path (jsonInputRef /
  // handleImportJSON) was unreachable — a user who imported a .json export saw
  // nothing happen (konata-session 2026-06-07). Route by extension, fall back
  // to sniffing the content, and always report the result.
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target?.result as string
      if (!content) { setImportMsg('Could not read that file.'); return }
      const trimmed = content.trimStart()
      const isJson = /\.json$/i.test(file.name) || trimmed.startsWith('{') || trimmed.startsWith('[')
      const count = isJson ? importFromJSON(content) : importFromMarkdown(content)
      setImportMsg(
        count > 0
          ? `Imported ${count} ${count === 1 ? 'memory' : 'memories'}.`
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
    clearAll()
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
    useMemoryStore.getState().addMemory({
      type: 'user',
      title: newTitle.trim().substring(0, 60),
      description: newContent.trim().substring(0, 120),
      content: newContent.trim(),
      tags: [],
      source: 'manual',
    })
    setNewTitle('')
    setNewContent('')
    setAddError(null)
    setAddingNew(false)
  }

  const startEdit = (entry: MemoryFile) => {
    setEditingId(entry.id)
    setEditTitle(entry.title)
    setEditContent(entry.content)
  }

  const saveEdit = () => {
    if (!editingId || !editTitle.trim() || !editContent.trim()) return
    updateMemory(editingId, {
      title: editTitle.trim().substring(0, 60),
      content: editContent.trim(),
      description: editContent.trim().substring(0, 120),
    })
    setEditingId(null)
  }

  return (
    <div className="space-y-3">
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

      {/* Manual memory limit — override the context-derived count (David
          2026-06-07: "memory limit selber setzen, nicht 32k = 15 memories").
          Blank = auto (tier-based). */}
      <div className="flex items-center justify-between gap-2 text-[0.6rem] text-gray-500 px-0.5">
        <span>Max memories injected</span>
        <input
          type="number"
          min={0}
          max={100}
          value={settings.maxMemoriesOverride ?? ''}
          placeholder="Auto"
          onChange={(e) => {
            const v = e.target.value.trim()
            const n = v === '' ? null : Math.max(0, Math.min(100, Math.floor(Number(v) || 0)))
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
            <Zap size={11} className="text-amber-400" />
            <span className="text-[0.65rem] text-gray-400">Auto-extract memories</span>
            <span className="text-[0.5rem] text-gray-600">(extra inference)</span>
          </div>
          <button
            onClick={() => updateMemorySettings({ autoExtractEnabled: !settings.autoExtractEnabled })}
            className={`relative w-7 h-3.5 rounded-full transition-colors ${settings.autoExtractEnabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${settings.autoExtractEnabled ? 'translate-x-3.5' : ''}`} />
          </button>
        </div>

        {settings.autoExtractEnabled && (
          <div className="flex items-center justify-between py-0.5 pl-4">
            <span className="text-[0.6rem] text-gray-500">Also extract outside Agent Mode</span>
            <button
              onClick={() => updateMemorySettings({ autoExtractInAllModes: !settings.autoExtractInAllModes })}
              className={`relative w-7 h-3.5 rounded-full transition-colors ${settings.autoExtractInAllModes ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${settings.autoExtractInAllModes ? 'translate-x-3.5' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {/* Search */}
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
          <textarea
            value={newContent}
            onChange={(e) => { setNewContent(e.target.value); if (addError) setAddError(null) }}
            placeholder="Details… (required)"
            rows={2}
            className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none resize-none"
          />
          {addError && (
            <p className="text-[0.55rem] text-red-400 px-0.5">{addError}</p>
          )}
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
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={2}
                  className="w-full px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 focus:outline-none resize-none"
                />
                <div className="flex gap-1.5">
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
                  <p className="text-[0.65rem] font-medium text-gray-200 truncate">{entry.title}</p>
                  {stale && (
                    <span className="flex items-center gap-0.5 text-[0.45rem] uppercase tracking-wider text-gray-500 border border-gray-600/40 rounded px-1 py-px shrink-0" title="Outdated, kept for reference, not injected into prompts">
                      <Archive size={8} /> outdated
                    </span>
                  )}
                </div>
                <p className="text-[0.6rem] text-gray-500 break-words line-clamp-2">{entry.content}</p>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
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
                <button
                  onClick={() => removeMemory(entry.id)}
                  className="p-0.5 rounded hover:bg-red-500/20 text-gray-600 hover:text-red-400"
                  aria-label="Delete entry"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

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
          <Trash2 size={10} /> {confirmClear ? 'Sure?' : 'Clear'}
        </GlowButton>
        <input ref={fileInputRef} type="file" accept=".md,.txt,.json" onChange={handleImport} className="hidden" />
      </div>

      {importMsg && (
        <p className="text-[0.6rem] text-gray-500 dark:text-gray-400 px-0.5">{importMsg}</p>
      )}
    </div>
  )
}
