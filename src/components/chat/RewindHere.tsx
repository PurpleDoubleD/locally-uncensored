// "Rewind" under a user message (CA U4, lib/agent-core/checkpoints.ts).
//
// Shown only where the agent wrote files from this message on. The menu says
// what goes back before anything happens, names what cannot, and says plainly
// that changes made by commands stay.

import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  dropCheckpointsFrom, planSize, rewindFiles, rewindPlan, rewindSummary, useCheckpointStore,
} from '../../lib/agent-core/checkpoints'
import { useChatStore } from '../../stores/chatStore'
import { useComposerFillStore } from '../../stores/composerFillStore'
import { CHAT_NOTICE_MS, useChatNoticeStore } from '../../stores/chatNoticeStore'
import { useGenerationStore } from '../../stores/generationStore'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import type { Message } from '../../types/chat'

interface Props {
  conversationId: string
  message: Pick<Message, 'id' | 'timestamp' | 'content' | 'displayContent'>
}

const WHY: Record<'binary' | 'too-big' | 'unreadable', string> = {
  binary: 'not a text file',
  'too-big': 'too large to keep',
  unreadable: 'could not be read before the change',
}

function base(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

export function RewindHere({ conversationId, message }: Props) {
  // A run is going: rewinding under it would fight its writes.
  const busy = useGenerationStore((s) => !!s.generating[conversationId])
  const list = useCheckpointStore((s) => s.byConv[conversationId])
  const trimmed = useCheckpointStore((s) => s.trimmedBefore[conversationId])
  const plan = useMemo(() => rewindPlan(conversationId, message.timestamp),
    // The store slices are the inputs; rewindPlan reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, message.timestamp, list, trimmed])
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [open])

  if (planSize(plan) === 0) return null

  const files = [...plan.restore, ...plan.remove]
  const go = async (withChat: boolean) => {
    setWorking(true)
    try {
      const res = await rewindFiles(conversationId, message.timestamp)
      useChatNoticeStore.getState().show('rewind', rewindSummary(res), res.failed.length ? 'fehler' : 'ruhig', CHAT_NOTICE_MS)
      if (withChat) {
        const text = message.displayContent ?? message.content
        useChatStore.getState().deleteMessagesAfter(conversationId, message.id)
        dropCheckpointsFrom(conversationId, message.timestamp)
        useComposerFillStore.getState().put(text)
      }
    } finally {
      setWorking(false)
      setOpen(false)
    }
  }

  return (
    <div ref={box} className="relative" data-rewind={message.id}>
      <button
        type="button"
        disabled={busy || working}
        onClick={() => setOpen((v) => !v)}
        title={busy ? 'Stop the run first' : 'Put the files back as they were before this message'}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded t-micro text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.06] disabled:opacity-40 disabled:pointer-events-none transition-colors"
      >
        <RotateCcw size={11} />
        Rewind
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Rewind to before this message"
          className="absolute right-0 top-full mt-1 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-[#1c1c1e] shadow-lg p-3 text-left"
        >
          <div className="t-body font-medium text-gray-800 dark:text-gray-100">Rewind to before this message?</div>
          <ul className="mt-1.5 space-y-0.5 max-h-32 overflow-auto">
            {files.slice(0, 6).map((e) => (
              <li key={e.target.path} className="t-micro text-gray-600 dark:text-gray-300 truncate" title={e.target.path}>
                <span className="font-mono">{base(e.target.path)}</span>
                {e.before.kind === 'missing' ? ' is removed again' : ' goes back'}
              </li>
            ))}
            {files.length > 6 && <li className="t-micro text-gray-500">and {files.length - 6} more</li>}
          </ul>
          {plan.unkept.length > 0 && (
            <div className={`mt-1.5 t-micro ${HINWEIS_TEXT.ruhig}`}>
              Stays as it is: {plan.unkept.map((u) => `${base(u.path)} (${WHY[u.why]})`).join(', ')}
            </div>
          )}
          {plan.partial && (
            <div className={`mt-1 t-micro ${HINWEIS_TEXT.ruhig}`}>Older changes were not kept, to save memory.</div>
          )}
          <div className="mt-1.5 t-micro text-gray-500 dark:text-gray-400">Changes made by commands stay.</div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              autoFocus
              disabled={working}
              onClick={() => void go(true)}
              className="lu-control lu-primary px-3 t-control font-medium"
            >
              Files and chat
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => void go(false)}
              className="lu-control px-3 t-control text-gray-800 dark:text-gray-100 border border-gray-300 dark:border-white/15 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
            >
              Only the files
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="lu-control px-2 t-control text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
