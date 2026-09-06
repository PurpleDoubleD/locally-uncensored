// Feature CC v2.5.0 — Chatbot export importer (MikeS++ Discord 2026-05-27).
// User picks an export file (ChatGPT / Claude / Gemini, .json or .zip),
// we parse it, render the conversation list with checkboxes, and on
// "Import" we feed each selected conversation into the RAG pipeline as
// if the user had dropped a markdown file.
//
// Why RAG instead of memoryStore: RAG is the right surface for bulk
// transfer (potentially thousands of past Q+A turns). memoryStore is
// curated facts. The Settings copy steers the user accordingly.

import { useState } from 'react'
import { Upload, FileText, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { parseExportFile, conversationToFile, type NormalisedConversation, type ChatbotPlatform } from '../../lib/parsers/chatbot-export'
import { useRAG } from '../../hooks/useRAG'
import { useChatStore } from '../../stores/chatStore'

const PLATFORM_LABEL: Record<ChatbotPlatform, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  unknown: 'Unknown',
}

export function ChatbotImporter() {
  const conversationId = useChatStore(s => s.activeConversationId)
  // useRAG takes `string | null` and already handles the null case; the old
  // `|| undefined` handed it a value its own signature does not admit.
  const rag = useRAG(conversationId)
  const uploadDocument = rag.uploadDocument

  const [conversations, setConversations] = useState<NormalisedConversation[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState(0)
  const [detectedPlatform, setDetectedPlatform] = useState<ChatbotPlatform>('unknown')
  const [doneCount, setDoneCount] = useState<number>(0)

  const handleFile = async (file: File) => {
    setParsing(true)
    setError(null)
    setConversations([])
    setSelected(new Set())
    setDoneCount(0)
    try {
      const result = await parseExportFile(file)
      setConversations(result.conversations)
      setSkipped(result.skipped)
      setDetectedPlatform(result.detectedPlatform)
      // Pre-select everything; user can deselect noisy ones.
      setSelected(new Set(result.conversations.map(c => c.id)))
      if (result.conversations.length === 0) {
        setError('No conversations found. The file may be in an unsupported format. Supported: ChatGPT conversations.json, Claude conversations.json, Gemini activity JSON.')
      }
    } catch (e) {
      setError(`Parse failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setParsing(false)
    }
  }

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) handleFile(f)
  }

  const toggleSelection = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(conversations.map(c => c.id)))
  const selectNone = () => setSelected(new Set())

  const handleImport = async () => {
    if (!conversationId) {
      setError('Open or create a chat first, imports attach to whichever conversation is currently active in the chat view.')
      return
    }
    const toImport = conversations.filter(c => selected.has(c.id))
    if (toImport.length === 0) return
    setImporting(true)
    setImportProgress({ current: 0, total: toImport.length })
    setError(null)
    setDoneCount(0)
    let done = 0
    const failed: string[] = []
    for (const conv of toImport) {
      try {
        const file = conversationToFile(conv)
        await uploadDocument(file)
        done++
      } catch (e) {
        failed.push(`${conv.title}: ${e instanceof Error ? e.message : String(e)}`)
      }
      setImportProgress({ current: done + failed.length, total: toImport.length })
      setDoneCount(done)
    }
    setImporting(false)
    setImportProgress(null)
    if (failed.length > 0) {
      setError(`${done} imported, ${failed.length} failed:\n${failed.slice(0, 5).join('\n')}${failed.length > 5 ? `\n…+${failed.length - 5} more` : ''}`)
    }
  }

  const allSelected = conversations.length > 0 && selected.size === conversations.length
  const someSelected = selected.size > 0

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 p-2.5 rounded-lg border border-blue-200 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-500/[0.08] text-blue-900 dark:text-blue-200">
        <Upload size={14} className="mt-0.5 shrink-0" />
        <div className="t-micro leading-relaxed">
          <strong>Import past conversations</strong> from ChatGPT, Claude, or Gemini exports. Each conversation lands in the active chat's RAG store, your local model can reference past turns just like any other document you upload. Stays on your machine.
        </div>
      </div>

      <div>
        <label className="block cursor-pointer">
          <input
            type="file"
            accept=".json,.zip,application/json,application/zip"
            onChange={onFileInput}
            disabled={parsing || importing}
            className="sr-only"
          />
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 text-[0.7rem] ${
            parsing || importing
              ? 'border-white/8 text-gray-500 cursor-not-allowed'
              : 'border-white/15 hover:border-white/30 text-gray-300 hover:bg-white/[0.03]'
          }`}>
            {parsing ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            <span>
              {parsing ? 'Parsing…' : 'Choose export file (.json or .zip)'}
            </span>
          </div>
        </label>
        <div className="text-[0.55rem] text-gray-500 mt-1 leading-relaxed">
          ChatGPT: <code className="font-mono">conversations.json</code> from the official data export. Claude: <code className="font-mono">conversations.json</code> from Settings → Privacy → Export. Gemini: Google Takeout activity JSON.
        </div>
      </div>

      {/* Der Fehler stand in einem roten Kasten mit Rahmen und Fuellflaeche.
          Die Farbe traegt hier schon alles, was der Kasten dazutun sollte;
          das Kreuz zum Wegklicken bringt <Hinweis> selbst mit. */}
      {error && (
        <Hinweis
          ton="fehler"
          icon={<AlertTriangle size={12} className="mt-0.5 shrink-0" />}
          onDismiss={() => setError(null)}
          className="whitespace-pre-wrap"
        >
          {error}
        </Hinweis>
      )}

      {conversations.length > 0 && (
        <>
          <div className="flex items-center justify-between t-micro">
            <span className="text-gray-400">
              Detected: <strong>{PLATFORM_LABEL[detectedPlatform]}</strong>
              {' · '}
              {conversations.length} conversation{conversations.length === 1 ? '' : 's'}
              {skipped > 0 ? ` · ${skipped} skipped` : ''}
              {' · '}
              {selected.size} selected
            </span>
            <div className="flex gap-2">
              <button
                onClick={allSelected ? selectNone : selectAll}
                className="text-gray-400 hover:text-white"
                disabled={importing}
              >
                {allSelected ? 'Select none' : 'Select all'}
              </button>
            </div>
          </div>

          <div className="space-y-1 max-h-80 overflow-y-auto pr-1 scrollbar-thin">
            {conversations.map(c => {
              const isOn = selected.has(c.id)
              return (
                <label
                  key={c.id}
                  className={`flex items-start gap-2 p-1.5 rounded border ${
                    isOn ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 hover:bg-white/[0.02]'
                  } cursor-pointer`}
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => toggleSelection(c.id)}
                    disabled={importing}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="t-micro text-gray-200 truncate">{c.title}</div>
                    <div className="text-[0.55rem] text-gray-500">
                      {c.messageCount} message{c.messageCount === 1 ? '' : 's'}
                      {c.timestamp ? ` · ${new Date(c.timestamp).toLocaleDateString()}` : ''}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleImport}
              disabled={!someSelected || importing || !conversationId}
              className="px-3 py-1.5 rounded text-[0.7rem] font-medium bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white inline-flex items-center gap-1.5"
            >
              {importing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              Import {selected.size} → RAG
            </button>
            {importProgress && (
              <span className="t-micro text-gray-400">
                {importProgress.current} / {importProgress.total}
              </span>
            )}
            {!importing && doneCount > 0 && !error && (
              <span className="t-micro text-green-400 inline-flex items-center gap-1">
                <CheckCircle2 size={10} /> {doneCount} imported
              </span>
            )}
          </div>
          {/* Diese Zeile war gelb und kursiv, obwohl nichts kaputt ist: sie
              sagt nur, in welcher Reihenfolge die zwei Schritte gehen. Ruhig,
              wie jeder Satz, den man wissen darf und nicht sofort braucht. */}
          {!conversationId && (
            <Hinweis>
              Open or create a chat first, imports attach to the active conversation's RAG store.
            </Hinweis>
          )}
        </>
      )}
    </div>
  )
}
