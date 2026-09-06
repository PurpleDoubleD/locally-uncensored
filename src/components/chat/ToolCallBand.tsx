import { Fragment, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, Check, ChevronDown, Wrench } from 'lucide-react'
import type { AgentBlock, AgentToolCall } from '../../types/agent-mode'
import {
  ToolCallBlock,
  comfyViewUrlFromResult,
  localMediaUrlFromResult,
} from './ToolCallBlock'
import {
  activeToolCall,
  groupDurationLabel,
  groupIsLive,
  type BandNote,
} from '../../lib/tool-call-groups'
import { MOTION_S } from '../ui/motion'

interface Props {
  calls: AgentToolCall[]
  /** G14-4: narration the grouping absorbed from between the calls. Rendered
   * inside the EXPANDED view at its original position; folded away with the
   * rest while collapsed, which is the whole point of the band. */
  notes?: BandNote[]
  renderNote?: (block: AgentBlock) => ReactNode
  pendingApprovalId?: string | null
  onApprove?: () => void
  onReject?: () => void
}

/**
 * One row for a whole run of consecutive tool calls (David 2026-07-31).
 *
 * While the run is live the band renders only the ACTIVE call and morphs in
 * place when the agent moves to the next tool — file_read transitions into
 * file_write at the same position instead of stacking a new chip. When the
 * run is done it collapses to an expandable "N steps" summary.
 *
 * Two things must never disappear into the collapse: an approval request
 * (activeToolCall puts it in front, and ToolCallBlock opens itself for
 * pending_approval), and completed media results (konata 2026-06-07 "and no
 * image") — those calls keep rendering below the band whatever its state.
 */
export function ToolCallBand({ calls, notes, renderNote, pendingApprovalId, onApprove, onReject }: Props) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const expanded = userToggled ?? false
  const live = groupIsLive(calls)
  const active = activeToolCall(calls)
  const anyFailed = calls.some((c) => c.status === 'failed' || c.status === 'rejected')
  const durationLabel = groupDurationLabel(calls)

  const blockFor = (tc: AgentToolCall) => {
    const isPending = !!pendingApprovalId && tc.id === pendingApprovalId
    return (
      <ToolCallBlock
        key={tc.id}
        toolCall={tc}
        onApprove={isPending ? onApprove : undefined}
        onReject={isPending ? onReject : undefined}
      />
    )
  }

  // Completed media calls stay visible outside the collapse/morph.
  const mediaCalls = calls.filter(
    (c) =>
      c.status === 'completed' &&
      (comfyViewUrlFromResult(c.result) || localMediaUrlFromResult(c.result)),
  )

  // A lone call is not spam — render it plain, exactly like before.
  if (calls.length === 1) return blockFor(calls[0])

  if (expanded) {
    return (
      <div className="mb-0.5">
        <BandHeader
          calls={calls}
          live={live}
          anyFailed={anyFailed}
          durationLabel={durationLabel}
          expanded
          onToggle={() => setUserToggled(false)}
        />
        <div className="space-y-0.5 pl-1">
          {calls.map((tc, i) => (
            <Fragment key={tc.id}>
              {blockFor(tc)}
              {renderNote && (notes ?? []).filter((n) => n.afterCall === i).map((n) => (
                <Fragment key={n.block.id}>{renderNote(n.block)}</Fragment>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    )
  }

  if (live) {
    return (
      <div className="mb-0.5">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={active.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: MOTION_S.base }}
          >
            {blockFor(active)}
          </motion.div>
        </AnimatePresence>
        {mediaCalls.filter((c) => c.id !== active.id).map(blockFor)}
      </div>
    )
  }

  return (
    <div className="mb-0.5">
      <BandHeader
        calls={calls}
        live={false}
        anyFailed={anyFailed}
        durationLabel={durationLabel}
        expanded={false}
        onToggle={() => setUserToggled(true)}
      />
      {mediaCalls.map(blockFor)}
    </div>
  )
}

function BandHeader({
  calls,
  live,
  anyFailed,
  durationLabel,
  expanded,
  onToggle,
}: {
  calls: AgentToolCall[]
  live: boolean
  anyFailed: boolean
  durationLabel: string | null
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity min-w-0"
    >
      <Wrench size={10} className="text-gray-500 dark:text-gray-500 shrink-0" />
      <span className="t-micro text-gray-600 dark:text-gray-400">
        {calls.length} steps
      </span>
      {!live &&
        (anyFailed ? (
          <AlertCircle size={9} className="text-red-400/60 shrink-0" />
        ) : (
          <Check size={9} className="text-gray-400 dark:text-gray-500 shrink-0" />
        ))}
      {durationLabel && (
        <span className="text-[0.5rem] text-gray-500 dark:text-gray-600">{durationLabel}</span>
      )}
      <ChevronDown
        size={11}
        className={`text-gray-400 dark:text-gray-500 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
      />
    </button>
  )
}
