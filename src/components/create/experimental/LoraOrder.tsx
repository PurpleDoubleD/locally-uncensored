import { ArrowDown, ArrowUp } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import type { LoraPick } from '../../../lib/render/lora-lanes'

/**
 * D4 (3.0.9, Discord, a follow-up to B24): the LoRAs a run chains, in the
 * order it chains them, with a button to move each one up or down. The list
 * above it is sorted by file name and says nothing about the order, which was
 * the order of the clicks. Shown from two picks on; the order is saved with
 * the picks (createStore `selectedLoras`, per lane in `loraLanes`).
 */
export function LoraOrder({ picks, labelOf }: { picks: LoraPick[]; labelOf: (name: string) => string }) {
  const moveLora = useCreateStore((s) => s.moveLora)
  if (picks.length < 2) return null
  const among = picks.map((p) => p.name)
  return (
    <div data-testid="lora-order" className="space-y-1">
      <div className="t-micro text-gray-500">Order of the run, first applied first</div>
      <ol className="space-y-0.5">
        {picks.map((p, i) => {
          const label = labelOf(p.name)
          return (
            <li key={p.name} className="flex items-center gap-1.5 t-control text-gray-300">
              <span className="t-mono text-gray-600 w-4 shrink-0 text-right">{i + 1}</span>
              <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">{label}</span>
              <button
                onClick={() => moveLora(p.name, -1, among)}
                disabled={i === 0}
                aria-label={`Move ${label} up`}
                title="Move up"
                className="p-0.5 rounded text-gray-500 hover:text-gray-200 disabled:opacity-30 disabled:hover:text-gray-500"
              >
                <ArrowUp className="w-3 h-3" />
              </button>
              <button
                onClick={() => moveLora(p.name, 1, among)}
                disabled={i === picks.length - 1}
                aria-label={`Move ${label} down`}
                title="Move down"
                className="p-0.5 rounded text-gray-500 hover:text-gray-200 disabled:opacity-30 disabled:hover:text-gray-500"
              >
                <ArrowDown className="w-3 h-3" />
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
