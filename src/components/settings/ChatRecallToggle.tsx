import { useSettingsStore } from '../../stores/settingsStore'
import { useEmbedLane } from '../../hooks/useEmbedLane'
import { laneIsOnThisMachine } from '../../api/embed-availability'
import { InlineToggle } from './InlineToggle'

/**
 * B33: the switch for recall in long chats, under Auto-compact. Off by
 * default. Without a local embedder it cannot be switched on and says why;
 * a stored "on" then simply does nothing (the runner asks the lane again).
 */
export function ChatRecallToggle() {
  const on = useSettingsStore((s) => s.settings.chatRecall === true)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const lane = useEmbedLane(true)
  const usable = lane !== null && laneIsOnThisMachine(lane.lane)
  const why = lane === null
    ? 'Checking for a local embedding model…'
    : lane.lane === 'ollama-remote'
      ? 'Your Ollama runs on another computer. Recall only runs on this one, so it stays off.'
      : lane.lane === 'none'
        ? 'Needs a local embedding model (nomic-embed-text). Install it from Document Chat.'
        : ''

  return (
    <div data-testid="chat-recall-setting" data-usable={usable ? 'yes' : 'no'}>
      <InlineToggle
        label="Recall older messages"
        enabled={on && usable}
        onChange={() => { if (usable || on) updateSettings({ chatRecall: !on }) }}
      />
      <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed pt-0.5">
        After a compaction, the messages the summary stands for are indexed on this computer. With each new message, the few that relate to it most are sent along word for word, so details the summary dropped are not lost.
        {why && <span className="block text-amber-600 dark:text-amber-400/80 pt-0.5">{why}</span>}
      </div>
    </div>
  )
}
