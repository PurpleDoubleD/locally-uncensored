import { useState } from 'react'
import { FileText, Download, Check, Copy } from 'lucide-react'
import type { ChatArtifact } from '../../types/chat'
import { isTauri, backendCall } from '../../api/backend'
import { downloadFile } from '../../lib/chat-export'

/**
 * In-chat file artifact (David 2026-06-12). In PLAIN chat a "file write" never
 * touches disk — the model's file lands here and shows like a ChatGPT artifact:
 * filename + a scrollable preview + a Download button (native Save-As in Tauri,
 * blob-download in the browser).
 */

function extOf(name: string): string {
  const e = name.split('.').pop()
  return e && e !== name ? e : 'txt'
}

const PREVIEW_LINES = 200

export function ChatArtifactCard({ artifact }: { artifact: ChatArtifact }) {
  const [copied, setCopied] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'done'>('idle')

  const lines = artifact.content.split('\n')
  const preview = lines.slice(0, PREVIEW_LINES).join('\n')
  const hiddenLines = lines.length - Math.min(lines.length, PREVIEW_LINES)
  const sizeLabel =
    artifact.content.length < 1024
      ? `${artifact.content.length} B`
      : `${(artifact.content.length / 1024).toFixed(1)} KB`

  const handleDownload = async () => {
    if (saveState === 'saving') return
    setSaveState('saving')
    // Tauri → native Save-As (returns the path, or null when the user cancels).
    // If the command itself throws, fall back to a blob download. Browser → blob.
    if (isTauri()) {
      try {
        await backendCall<string | null>('save_text_file_dialog', {
          content: artifact.content,
          defaultName: artifact.name,
          extension: extOf(artifact.name),
          extLabel: extOf(artifact.name).toUpperCase(),
        })
      } catch {
        downloadFile(artifact.content, artifact.name, artifact.mime)
      }
    } else {
      downloadFile(artifact.content, artifact.name, artifact.mime)
    }
    setSaveState('done')
    setTimeout(() => setSaveState('idle'), 2000)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(artifact.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="my-1 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02] overflow-hidden">
      {/* Header: filename + meta + actions */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-gray-200 dark:border-white/[0.06]">
        <FileText size={13} className="text-blue-500 shrink-0" />
        <span className="text-[0.72rem] font-medium text-gray-800 dark:text-gray-100 truncate flex-1" title={artifact.name}>
          {artifact.name}
        </span>
        <span className="text-[0.55rem] text-gray-400 dark:text-gray-500 shrink-0 whitespace-nowrap">
          {lines.length} {lines.length === 1 ? 'line' : 'lines'} · {sizeLabel}
        </span>
        <button
          onClick={handleCopy}
          title={copied ? 'Copied' : 'Copy contents'}
          className="p-1 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors shrink-0"
        >
          {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
        </button>
        <button
          onClick={handleDownload}
          disabled={saveState === 'saving'}
          title="Download / Save as…"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded t-micro font-medium bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 border border-blue-500/30 transition-colors disabled:opacity-50 shrink-0"
        >
          {saveState === 'done' ? <Check size={11} /> : <Download size={11} />}
          <span>{saveState === 'done' ? 'Saved' : saveState === 'saving' ? '…' : 'Download'}</span>
        </button>
      </div>
      {/* Scrollable preview */}
      <pre className="px-2.5 py-1.5 t-micro leading-snug text-gray-700 dark:text-gray-300 font-mono overflow-auto max-h-64 scrollbar-thin whitespace-pre">
        {preview}
        {hiddenLines > 0 ? `\n\n… ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'}. Download for the full file` : ''}
      </pre>
    </div>
  )
}
