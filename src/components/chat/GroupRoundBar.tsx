// The group round, as controls in the session strip (3.0.9, GH #200).
//
// Before a round: the speaking order, one chip per member ("1 Walt",
// "2 Baron"). A click sets a member to sit out the NEXT round only; the
// round that starts takes the pick away. While a round runs: who speaks,
// "Skip speaker" (end this turn, go on with the next) and "Stop round".
//
// Controls, not sentences: nothing here is a notice to read, so the rule
// that keeps notices away from the prompt box is not touched.
import { useMemo } from 'react'
import { Users, SkipForward, Square } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useGroupRoundStore, skipGroupSpeaker } from '../../stores/groupRoundStore'
import { availableGroupMembers, groupSpeakers, isGroupChat } from '../../lib/group-chat'
import { displayModelName } from '../../api/providers'

/** The name a member goes by in this chat: its persona, else its model. */
export function memberLabel(model: string, speakers: Record<string, { name: string; personaId?: string }>): string {
  const s = speakers[model]
  return s?.personaId ? s.name : displayModelName(model)
}

export function GroupRoundBar({ onStop }: { onStop: () => void }) {
  const convId = useChatStore((s) => s.activeConversationId)
  // Three fields, not the conversation: the conversation object changes on
  // every streaming frame, these only when the group does.
  const groupModels = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.groupModels)
  const groupPersonas = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.groupPersonas)
  const sitOutPick = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.groupSitOut)
  const setGroupSitOut = useChatStore((s) => s.setGroupSitOut)
  const models = useModelStore((s) => s.models)
  const inventoryLoaded = useModelStore((s) => s.inventoryLoaded)
  const personas = useSettingsStore((s) => s.personas)
  const live = useGroupRoundStore((s) => (convId ? s.live[convId] : undefined))
  const table = useMemo(
    () => availableGroupMembers(groupModels ?? [], models, inventoryLoaded),
    [groupModels, models, inventoryLoaded],
  )
  const speakers = useMemo(() => groupSpeakers(table, groupPersonas, personas), [table, groupPersonas, personas])

  if (!convId || !isGroupChat(groupModels)) return null

  if (live) {
    return (
      <div data-testid="group-round-bar" data-state="running" className="flex items-center gap-1 min-w-0 t-micro text-gray-500">
        <Users size={10} className="shrink-0 text-purple-400" />
        <span className="flex items-center gap-1 min-w-0" data-testid="group-round-speaker">
          {/* The place first: a long model name is cut, the place never. */}
          <span className="lu-hud-num shrink-0">{live.index + 1}/{live.total}</span>
          <span className="truncate">{memberLabel(live.speaker, speakers)}</span>
        </span>
        <button
          onClick={() => skipGroupSpeaker(convId, live.index)}
          disabled={live.index + 1 >= live.total}
          data-testid="group-skip-speaker"
          title={live.index + 1 >= live.total ? 'This is the last speaker of the round' : 'Stop this speaker and go on with the next one'}
          className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/[0.08] hover:border-gray-400 dark:hover:border-white/20 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <SkipForward size={9} /> Skip speaker
        </button>
        <button
          onClick={onStop}
          data-testid="group-stop-round"
          title="Stop the whole round"
          className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/[0.08] hover:border-red-400/60 hover:text-red-500 transition-colors"
        >
          <Square size={8} /> Stop round
        </button>
      </div>
    )
  }

  const sitOut = sitOutPick ?? []
  const answering = table.filter((m) => !sitOut.includes(m))
  return (
    // overflow-hidden und ein kuerzbares Etikett (Issue 309 T1, 375 px): die
    // Leiste darf schmaler werden als "Next round:", und ein nicht
    // schrumpfendes Etikett lief dann ueber den Fuellstand daneben.
    <div data-testid="group-round-bar" data-state="idle" className="flex items-center gap-1 min-w-0 overflow-hidden t-micro text-gray-500">
      <Users size={10} className="shrink-0 text-purple-400" />
      <span className="truncate">Next round:</span>
      <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto scrollbar-thin">
        {table.map((model, i) => {
          const out = sitOut.includes(model)
          // The last one answering cannot sit out too: a round needs a speaker.
          const lastOne = !out && answering.length <= 1
          return (
            <button
              key={model}
              data-testid="group-next-speaker"
              data-model={model}
              aria-pressed={!out}
              disabled={lastOne}
              onClick={() => setGroupSitOut(convId, out ? sitOut.filter((m) => m !== model) : [...sitOut, model])}
              title={out
                ? `${memberLabel(model, speakers)} sits out the next round. Click to let it answer.`
                : lastOne
                  ? 'At least one member answers'
                  : `Click to let ${memberLabel(model, speakers)} sit out the next round only`}
              className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors ${
                out
                  ? 'border-dashed border-gray-300 dark:border-white/10 text-gray-400 line-through'
                  : 'border-purple-400/40 text-purple-600 dark:text-purple-300 hover:border-purple-400'
              } disabled:cursor-default`}
            >
              <span className="lu-hud-num">{i + 1}</span>
              <span className="truncate max-w-[9rem]">{memberLabel(model, speakers)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
