import { useState, useEffect } from 'react'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { createPortal } from 'react-dom'
import { Brain, X, Plus, Trash2, ChevronDown, Archive } from 'lucide-react'
import { useMemoryStore } from '../../stores/memoryStore'
import { useModelStore } from '../../stores/modelStore'
import { getModelMaxTokens } from '../../lib/context-compaction'
import { AnimatePresence, motion } from 'framer-motion'

// Memory button. Lives in the TOP BAR next to the model picker (David
// 2026-06-06: "memory button raus aus chat/code/agent, neben den modelloader
// oben als gehirn icon"). One brain icon → an EDITABLE popover where the user
// views / ADDS / DELETES the remembered context that gets injected into every
// prompt. Always visible (even with 0 memories) so the first one can be added.
export function MemoryDebugToggle() {
  const [open, setOpen] = useState(false)
  const entryCount = useMemoryStore((s) => s.entries.length)

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        title="Memory: view, add or delete the context injected into prompts"
        className={
          'relative flex items-center justify-center h-[var(--control-h-sm)] w-[var(--control-h-sm)] rounded-md border transition-colors ' +
          (open
            ? 'border-purple-400/50 text-purple-500 dark:text-purple-300 bg-purple-500/[0.08]'
            : 'border-gray-300 dark:border-white/[0.08] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 dark:hover:border-white/15')
        }
      >
        <Brain size={13} />
        {entryCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-[3px] flex items-center justify-center rounded-full text-[0.5rem] font-bold bg-purple-500 text-white">
            {entryCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && <MemoryPopover onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  )
}

function MemoryPopover({ onClose }: { onClose: () => void }) {
  useDismissOnEscape(true, onClose)
  const entries = useMemoryStore((s) => s.entries)
  const addMemory = useMemoryStore((s) => s.addMemory)
  const removeMemory = useMemoryStore((s) => s.removeMemory)
  const activeModel = useModelStore((s) => s.activeModel)
  const [injectedPreview, setInjectedPreview] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')

  // Injection preview uses the SAME embedding-first path the chat hooks use, so
  // it matches what actually lands in the prompt. Re-runs when memories change.
  useEffect(() => {
    if (!activeModel) return
    let cancelled = false
    getModelMaxTokens(activeModel)
      .then((tokens) => useMemoryStore.getState().getMemoriesForPromptAsync('', tokens))
      .then((preview) => { if (!cancelled) setInjectedPreview(preview) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeModel, entries.length])

  // Vier Kategorien, vier Farben. `project` stand auf Gelb, und Gelb ist in
  // dieser App keine Kategorie mehr, sondern gar nichts (`lib/hinweis.ts`).
  // Cyan ist die naechste Farbe, die in diesem Panel noch frei war: Blau,
  // Gruen und Grau haengen an den drei anderen Kategorien, Violett traegt die
  // Panel-Umrandung, Rot den Loeschknopf.
  const typeColors: Record<string, string> = {
    user: 'text-blue-400', feedback: 'text-green-400',
    project: 'text-cyan-400', reference: 'text-gray-400',
  }

  const handleAdd = () => {
    const content = newContent.trim()
    if (!content) return
    const title = newTitle.trim() || content.slice(0, 60)
    addMemory({
      type: 'user',
      title,
      description: content.slice(0, 120),
      content,
      tags: [],
      source: 'manual',
    })
    setNewTitle('')
    setNewContent('')
    setAdding(false)
  }

  // Portal to document.body: this is a `fixed inset-0` overlay, but the brain
  // button lives in the Header's center column which carries Tailwind's
  // `-translate-x-1/2`. A CSS transform on ANY ancestor makes that ancestor the
  // containing block for `position: fixed`, so without the portal the overlay
  // was clamped to the header-center's ~132px width on every viewport ≥1024px
  // (David flagged the squeezed Memory panel). Portaling out of the transformed
  // subtree restores true viewport-anchored full-screen positioning.
  return createPortal(
    <motion.div
      initial={{ opacity: 0, y: -5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -5 }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-14"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-h-[68vh] lu-elevated rounded-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2">
            <Brain size={12} className="text-purple-400" />
            <span className="t-micro font-semibold text-gray-700 dark:text-gray-300">Memory ({entries.length})</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setAdding((a) => !a)}
              title="Add a memory"
              className={'flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.55rem] font-medium transition-colors ' + (adding ? 'bg-purple-500/15 text-purple-300' : 'text-gray-500 hover:text-gray-300 hover:bg-white/10')}
            >
              <Plus size={11} /> Add
            </button>
            <button onClick={onClose} className="p-0.5 rounded hover:bg-white/10 text-gray-500"><X size={12} /></button>
          </div>
        </div>

        {/* Add form */}
        {adding && (
          <div className="px-3 py-2 border-b border-white/[0.06] bg-white/[0.02] space-y-1.5 shrink-0">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Title (optional)"
              className="w-full px-2 py-1 rounded bg-black/20 border border-white/10 t-micro text-gray-200 placeholder-gray-600 focus:outline-none focus:border-purple-500/40"
            />
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="What should the model always remember? (injected into every prompt)"
              rows={3}
              className="w-full px-2 py-1 rounded bg-black/20 border border-white/10 t-micro text-gray-200 placeholder-gray-600 focus:outline-none focus:border-purple-500/40 resize-none"
            />
            <div className="flex justify-end gap-1.5">
              <button onClick={() => { setAdding(false); setNewTitle(''); setNewContent('') }} className="px-2 py-1 rounded t-micro text-gray-400 hover:text-gray-200 hover:bg-white/10">Cancel</button>
              <button onClick={handleAdd} disabled={!newContent.trim()} className="flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium bg-purple-500/20 border border-purple-500/30 text-purple-200 hover:bg-purple-500/30 disabled:opacity-40">
                <Plus size={10} /> Save memory
              </button>
            </div>
          </div>
        )}

        {/* Memory list — each row deletable on hover */}
        <div className="overflow-y-auto flex-1 scrollbar-thin">
          {entries.length === 0 ? (
            <p className="t-micro text-gray-600 px-3 py-5 text-center">No memories yet, click <span className="text-purple-400">Add</span> to write one.</p>
          ) : (
            entries.slice(0, 50).map((entry) => {
              const stale = entry.stale === true || typeof entry.supersededBy === 'string'
              return (
                <div key={entry.id} className={`group px-3 py-1.5 border-b border-white/[0.03] hover:bg-white/[0.02] ${stale ? 'opacity-50' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[0.5rem] uppercase font-bold tracking-wider ${typeColors[entry.type] || 'text-gray-500'}`}>{entry.type}</span>
                    <span className="t-micro text-gray-300 font-medium truncate flex-1">{entry.title}</span>
                    {stale && (
                      <span className="flex items-center gap-0.5 text-[0.45rem] uppercase tracking-wider text-gray-500 shrink-0" title="Outdated, not injected"><Archive size={8} /> outdated</span>
                    )}
                    <button
                      onClick={() => removeMemory(entry.id)}
                      title="Delete this memory"
                      className="shrink-0 p-0.5 rounded text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <p className="text-[0.55rem] text-gray-600 truncate mt-0.5">{entry.content.substring(0, 120)}</p>
                </div>
              )
            })
          )}
        </div>

        {/* Injection preview — exactly what gets prepended to the prompt */}
        {injectedPreview && (
          <div className="border-t border-white/[0.06] px-3 py-2 shrink-0">
            <div className="flex items-center gap-1 mb-1">
              <ChevronDown size={10} className="text-gray-600" />
              <span className="text-[0.5rem] uppercase tracking-wider text-gray-600 font-semibold">Injected into prompt</span>
            </div>
            <pre className="text-[0.5rem] text-gray-500 font-mono whitespace-pre-wrap max-h-20 overflow-y-auto scrollbar-thin leading-relaxed">{injectedPreview.substring(0, 800)}</pre>
          </div>
        )}
      </div>
    </motion.div>,
    document.body,
  )
}
