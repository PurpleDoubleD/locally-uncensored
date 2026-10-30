import { useRef, useState } from 'react'
import { usePopoverPlatz } from '../../../hooks/usePopoverPlatz'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Wand2 } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { classifyModel } from '../../../api/comfyui'
import { improveKindForIntent } from '../../../lib/render/improve-prompt'
import { improvePrompt, useImproveAvailability } from '../../../lib/render/improve-prompt-run'
import {
  FAMILY_LABEL, TEMPLATES, buildFromTemplate, familyFor, refineTarget,
} from '../../../lib/render/prompt-assistant'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { useClickAway } from '../ui/useClickAway'

/**
 * The prompt assistant (B43): a few keywords and a template for the model's
 * family make a draft at once, offline. "Refine" hands the draft to the chat
 * model through the same call as "Improve my prompt". Nothing replaces the
 * prompt until the user presses Use.
 */
export function PromptAssistant({ onUse }: { onUse: (prompt: string) => void }) {
  const intent = useCreateStore((s) => s.intent())
  const kind = improveKindForIntent(intent)
  const runModel = useCreateStore((s) =>
    kind === 'music' ? s.localOpModel : kind === 'video' ? s.videoModel : s.imageModel,
  )
  const listType = useCreateStore((s) =>
    (kind === 'video' ? s.videoModelList : s.imageModelList).find((m) => m.name === runModel)?.type,
  )
  const chat = useImproveAvailability()
  const [open, setOpen] = useState(false)
  const [keywords, setKeywords] = useState('')
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [refined, setRefined] = useState<string | null>(null)
  const [refining, setRefining] = useState(false)
  const [note, setNote] = useState('')
  const abort = useRef<AbortController | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panel = usePopoverPlatz(panelRef, open, { bevorzugt: 'oben', abstand: 6 })

  const close = () => {
    abort.current?.abort()
    setOpen(false)
  }
  useClickAway(ref, close, open)

  if (!kind) return null
  const family = familyFor(kind, listType ?? classifyModel(runModel), runModel)
  const templates = TEMPLATES[family]
  const template = templates.find((t) => t.id === templateId) ?? templates[0]
  const draft = buildFromTemplate(template, keywords)
  const result = refined ?? draft

  const refine = async () => {
    if (!draft) return
    const own = new AbortController()
    abort.current = own
    setRefining(true)
    setNote('')
    const out = await improvePrompt(draft, refineTarget(kind, family, runModel), own.signal)
    abort.current = null
    setRefining(false)
    if (out.status === 'improved') setRefined(out.prompt)
    else if (out.status === 'unchanged') setNote('The chat model kept the draft as it is.')
    else if (!own.signal.aborted) setNote('The chat model did not answer. The draft is still yours to use.')
  }

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="sm"
        icon={Sparkles}
        iconOnly
        title="Prompt assistant"
        onClick={() => (open ? close() : setOpen(true))}
      />
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            style={panel.style}
            initial={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: panel.nachOben ? 4 : -4 }}
            transition={{ duration: 0.12 }}
            className={cn('lu-elevated absolute left-0 z-50 w-80 rounded-lg p-2.5 space-y-2 overflow-y-auto scrollbar-thin', panel.nachOben ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}
            data-testid="prompt-assistant"
            data-family={family}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="t-label text-gray-400">Prompt assistant</span>
              <span className="t-micro text-gray-500" title={runModel || undefined}>{FAMILY_LABEL[family]}</span>
            </div>
            <textarea
              value={keywords}
              onChange={(e) => { setKeywords(e.target.value); setRefined(null); setNote('') }}
              placeholder="A few keywords, separated by commas: red fox, snowy forest, dusk"
              rows={2}
              className="w-full resize-none rounded-md bg-white/[0.04] border border-white/[0.08] px-2 py-1.5 t-control text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-white/20"
              data-testid="prompt-assistant-keywords"
              autoFocus
            />
            <div role="radiogroup" aria-label="Template" className="flex flex-wrap gap-1">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={t.id === template.id}
                  onClick={() => { setTemplateId(t.id); setRefined(null); setNote('') }}
                  className={cn(
                    'rounded-md border px-2 py-0.5 t-control transition-colors',
                    t.id === template.id ? 'border-white/20 bg-white/[0.07] text-gray-200' : 'border-white/[0.07] text-gray-500 hover:text-gray-300',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p
              className={cn('rounded-md bg-black/20 px-2 py-1.5 t-control min-h-[3rem] whitespace-pre-wrap break-words', result ? 'text-gray-300' : 'text-gray-600')}
              data-testid="prompt-assistant-result"
            >
              {result || 'The prompt appears here as you type.'}
            </p>
            {note && <p className="t-micro text-gray-500">{note}</p>}
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                disabled={!refining && (!draft || !chat.available)}
                onClick={() => (refining ? abort.current?.abort() : void refine())}
                title={refining ? 'Stop refining' : chat.hint}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 t-control text-gray-400 hover:text-gray-200 hover:bg-white/[0.05] disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="prompt-assistant-refine"
              >
                <Wand2 size={12} />
                {refining ? 'Refining… (stop)' : 'Refine with chat model'}
              </button>
              <button
                type="button"
                disabled={!result || refining}
                onClick={() => { onUse(result); close() }}
                className="rounded-md px-2.5 py-1 t-control bg-white/10 text-gray-100 hover:bg-white/15 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="prompt-assistant-use"
              >
                Use
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
