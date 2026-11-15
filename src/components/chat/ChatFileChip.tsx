import { AtSign, File as FileIcon, X } from 'lucide-react'
import type { FileAttachment } from '../../types/chat'
import { formatBytes } from '../../lib/formatters'
import { chipCutLabel } from '../../lib/chat-file-fit'
import { isBinaryAttachment } from '../../lib/chat-files'

/**
 * Where a binary goes, in two words on the chip (Discord feature request: load
 * binary files such as ROMs directly). In Agent and Code the file itself is put
 * in the working folder for the tools; in a plain chat the model gets a summary
 * of its bytes and nothing more. The tooltip said it, the chip did not.
 */
export function binaryReachLabel(file: FileAttachment, reachesTools?: boolean): string | null {
  if (!isBinaryAttachment(file)) return null
  if (file.workspacePath) return 'file in the working folder'
  if (reachesTools === true) return 'goes to the working folder'
  return 'summary only'
}

/**
 * One attached file as a chip: name, the type read from its bytes, its size.
 *
 * The same chip stands in the composer (with the x) and in the transcript
 * (without it). It shows a description, never the file: the bytes are not in
 * the chat (lib/chat-files.ts), so there is nothing here to open or save.
 */
export function ChatFileChip({ file, onRemove, testId = 'chat-file-chip', reachesTools, mention }: {
  file: FileAttachment
  /** Composer only: take the file off the draft again. */
  onRemove?: () => void
  testId?: string
  /** Composer only: whether a send copies the file into a working folder
   *  (Agent and Code). Unset in the transcript, where the file says it. */
  reachesTools?: boolean
  /** Composer only: the file came from an `@` mention (lib/file-mentions.ts). */
  mention?: boolean
}) {
  const where = file.absolutePath
    ? `\nOn this computer: ${file.absolutePath}`
    : file.workspacePath ? `\nIn the working folder: ${file.workspacePath}` : ''
  const reach = binaryReachLabel(file, reachesTools)
  // GH #171: a text that went out shorter says so on the chip, for as long as
  // the message is there, not only in the line that showed at send time.
  const cut = chipCutLabel(file)
  return (
    <div
      data-testid={testId}
      data-mention={mention ? 'true' : undefined}
      title={`${file.name}\n${file.kind}, ${formatBytes(file.size)}${cut ? `\nOnly part of the text reached the model: ${cut}` : ''}\nSHA-256 ${file.sha256}${where}`}
      className="flex items-center gap-1.5 max-w-[240px] pl-2 pr-1.5 py-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] text-left"
    >
      {mention ? <AtSign size={13} className="shrink-0 text-gray-400" /> : <FileIcon size={13} className="shrink-0 text-gray-400" />}
      <span className="min-w-0 flex flex-col leading-tight">
        <span className="truncate t-mono text-gray-800 dark:text-gray-200">{mention ? `@${file.name}` : file.name}</span>
        <span className="truncate t-micro text-gray-500 dark:text-gray-400">{file.kind}, {formatBytes(file.size)}</span>
        {cut && <span data-testid="chat-file-cut" className="truncate t-micro text-gray-500 dark:text-gray-400">{cut}</span>}
        {reach && <span data-testid="chat-file-reach" className="truncate t-micro text-gray-500 dark:text-gray-400">{reach}</span>}
      </span>
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
        >
          <X size={9} />
        </button>
      )}
    </div>
  )
}
