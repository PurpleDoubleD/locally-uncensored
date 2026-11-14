/**
 * Options of one remote chat. Sheet "remote-options", strand 6 (C5 for R4).
 *
 * Agent mode, thinking, persona and the short way of speaking (Caveman).
 * All four are settings of the client: the desktop only ever sees the
 * finished system prompt, the think flag and the tool list of a request.
 * What a tool may do is decided on the desktop, by the switches there. The
 * personas are the ones the web page of the desktop offers
 * (mobile-client/personas.js), so nothing is written a third time.
 */
import { PERSONAS } from '../../../../mobile-client/personas.js'
import { nav, useSheet } from '../../nav'
import { storePolicy } from '../../policy/storePolicy'
import { isThinkingModel } from '../../remote/remoteClient'
import { REMOTE_STRINGS as S } from '../../strings/remote'
import { ListGroup, Row, Sheet } from '../../ui'
import { remoteToolsFor, type CavemanLevel } from '../../remote/remoteAgent'
import { remote, useRemote } from './parts/session'
import { remoteModelLabel } from './parts/view'
import { agentAbilities } from './parts/view'
import './parts/remote.css'

const NO_FEATURES: readonly string[] = []

interface Persona {
  id: string
  name: string
  prompt: string
}

/** The persona without any system prompt is offered only where the build offers every content level. */
function personas(): Persona[] {
  const all = PERSONAS as Persona[]
  return storePolicy().contentLevels === 'all' ? all : all.filter((persona) => persona.prompt !== '')
}

const CAVEMAN: Array<{ level: CavemanLevel; title: string; subtitle?: string }> = [
  { level: 'off', title: S.options.cavemanOff },
  { level: 'lite', title: S.options.cavemanLite, subtitle: S.options.cavemanLiteSub },
  { level: 'full', title: S.options.cavemanFull, subtitle: S.options.cavemanFullSub },
  { level: 'ultra', title: S.options.cavemanUltra, subtitle: S.options.cavemanUltraSub },
]

export default function RemoteOptionsSheet() {
  const sheet = useSheet<{ chatId?: string } | undefined>()
  const chatId = sheet.props?.chatId ?? ''
  const chat = useRemote((s) => s.chats.find((c) => c.id === chatId))
  const permissions = useRemote((s) => s.permissions)
  const features = useRemote((s) => (s.connection?.pin ? s.features : NO_FEATURES))

  if (!chat) {
    return (
      <Sheet title={S.options.title}>
        <p className="m-remote-sheet-text">{S.chatMenu.none}</p>
      </Sheet>
    )
  }

  const canThink = isThinkingModel(chat.model)
  return (
    <Sheet title={S.options.title}>
      <ListGroup testid="m-remote-options-group-model">
        <Row
          title={S.options.model}
          subtitle={S.options.modelSub}
          value={remoteModelLabel(chat.model) || S.chat.modelNone}
          onPress={() => {
            sheet.close()
            nav.openSheet('remote-model', { chatId: chat.id })
          }}
          testid="m-remote-options-model"
          el="R4.4"
        />
      </ListGroup>
      <ListGroup>
        <Row
          title={S.options.agent}
          subtitle={S.options.agentSub(agentAbilities(permissions, remoteToolsFor(null, features)).join(', '))}
          switch={{ checked: chat.agentMode, onChange: (on) => remote().setAgentMode(chat.id, on) }}
          testid="m-remote-options-agent"
        />
        <Row
          title={S.options.thinking}
          subtitle={S.options.thinkingOn}
          switch={{ checked: canThink && chat.thinkEnabled, onChange: (on) => remote().setThinkEnabled(chat.id, on) }}
          disabled={!canThink}
          disabledReason={S.options.thinkingUnsupported}
          testid="m-remote-options-thinking"
        />
      </ListGroup>
      <p className="m-remote-sheet-text">{S.options.agentHint}</p>
      <ListGroup title={S.options.personaTitle} role="radiogroup" testid="m-remote-options-personas">
        <Row
          title={S.options.personaDefault}
          subtitle={S.options.personaDefaultSub}
          radio={{ checked: chat.systemPrompt === null, onSelect: () => remote().setSystemPrompt(chat.id, null) }}
          testid="m-remote-options-persona-default"
        />
        {personas().map((persona) => (
          <Row
            key={persona.id}
            title={persona.name}
            radio={{ checked: chat.systemPrompt === persona.prompt, onSelect: () => remote().setSystemPrompt(chat.id, persona.prompt) }}
            testid={`m-remote-options-persona-${persona.id}`}
          />
        ))}
      </ListGroup>
      <ListGroup title={S.options.cavemanTitle} role="radiogroup" testid="m-remote-options-caveman">
        {CAVEMAN.map((entry) => (
          <Row
            key={entry.level}
            title={entry.title}
            subtitle={entry.subtitle}
            radio={{ checked: chat.caveman === entry.level, onSelect: () => remote().setCaveman(chat.id, entry.level) }}
            testid={`m-remote-options-caveman-${entry.level}`}
          />
        ))}
      </ListGroup>
    </Sheet>
  )
}
