// What a group round costs, said out loud above the composer (2.6.6, plan A4).
//
// The group is the only surface where one Enter buys more than one answer, and
// nothing on screen said so: the user picks three models in the Plugins
// dropdown, types a question, and the app quietly bills three completions on
// the shared history. A per-model send budget takes the runaway growth out of
// it, but the multiplier itself is the feature, not a bug, so the honest fix is
// to name it where the user is about to press send.
//
// Only rendered when a line-up is actually active, and never in a single-model
// chat, where it would be noise.

import { Users } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { useChatStore } from '../../stores/chatStore'
import { useProviderStore } from '../../stores/providerStore'
import { isGroupChat } from '../../lib/group-chat'
import { COMPOSER_MAX_W } from './composer-width'

/** The line itself. Kept pure so the wording is testable without a renderer.
 *
 *  `builtinSpeakers` is how many of the line-up run on the app's own engine.
 *  From two upwards that costs time rather than money: llama-server holds one
 *  model, so the engine is stopped and started again between those speakers.
 *  The counter-check found the app hiding this by not reloading at all and
 *  answering every speaker with the same model, which is the one thing we will
 *  not do, so the wait gets named here before the user presses send. */
export function groupCostHintText(models: number, builtinSpeakers = 0): string {
  const base = `1 round = ${models} answers = ${models}x the cost`
  return builtinSpeakers >= 2
    ? `${base}, and the LU Engine reloads between local speakers`
    : base
}

export function GroupCostHint() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const groupModels = useChatStore((s) =>
    activeConversationId
      ? s.conversations.find((c) => c.id === activeConversationId)?.groupModels
      : undefined,
  )

  // Only the app-managed engine has the one-model-at-a-time problem. A LAN
  // OpenAI-compatible server in the same slot serves many models at once.
  const managedBuiltin = useProviderStore(
    (s) => !!s.providers.openai?.enabled && s.providers.openai?.managed === true,
  )

  if (!isGroupChat(groupModels)) return null

  const builtinSpeakers = managedBuiltin
    ? groupModels.filter((m) => m.startsWith('openai::')).length
    : 0

  // Eine Zeile, kein Kasten: der Vervielfacher ist eine Auskunft, kein Alarm.
  // Vorher trug die Zeile einen gelben Rahmen mit gelber Fuellung und ein
  // gelbes Symbol, also die Bauform einer Warnung fuer einen Satz, der nur
  // sagt, was der naechste Enter kostet. Die Begruendung steht in
  // `lib/hinweis.ts`.
  return (
    <div className={`w-full ${COMPOSER_MAX_W} mx-auto px-3 pb-1 flex justify-center`}>
      <Hinweis className="w-full" icon={<Users size={9} className="shrink-0 mt-[3px]" />}>
        <span className="block truncate" title={groupModels.join(', ')}>
          <span className="uppercase tracking-wider">group</span>{' '}
          {groupCostHintText(groupModels.length, builtinSpeakers)}
        </span>
      </Hinweis>
    </div>
  )
}
