/**
 * SLOT in C2, filled by strand 2 (Agent and knowledge).
 *
 * Strand 1 passes <ComposerStatus chatId={id} /> as `status` to ui/Composer.
 * It draws the status chips Agent (C2.10), documents (C2.11), Thinking,
 * Persona, Group and Caveman (C2.12). A chip is only there while its thing
 * is on, and each one opens the place where it is changed.
 */
import { useEffect } from 'react'
import { AlertTriangle, Bot, Brain, FileText, User, Users, Volume1 } from 'lucide-react'
import { agentMustTurnOff, useAgentToolSupport } from './parts/tool-support'
import { isGroupChat } from '../../../lib/group-chat'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { useChatStore } from '../../../stores/chatStore'
import { useRAGStore } from '../../../stores/ragStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { offeredPersonas } from '../../policy/personas'
import { nav } from '../../nav'
import { AGENT_STRINGS as T } from '../../strings/agent'
import { Chip, toast } from '../../ui'
import type { ChatOptionsProps } from './parts/options/sections'
import { useThinkingState } from './parts/model-state'
import { personaNameFor } from './parts/options/chat-settings'

export interface ComposerStatusProps {
  chatId: string
}

function openOptions(props: ChatOptionsProps): void {
  nav.openSheet('chat-options', props)
}

/**
 * Agent was on and a model of this phone without tools was chosen after that:
 * off, and said (round 5).
 *
 * The rule stood inside the chips below, and the chat page draws those only
 * for a chat that has an id. In a new chat that is still empty nobody ran it:
 * the switch in the chat options stood on and could be used, next to the
 * sentence that this model cannot use tools, and the lock only came with the
 * first send (round 9, N5 on Android). The chat page mounts this for every
 * chat now, under the key a new chat has (parts/chat-ref.ts, chatKey).
 */
export function AgentToolGuard({ chatKey }: { chatKey: string }) {
  const agentOn = useAgentModeStore((s) => s.agentModeActive[chatKey] ?? false)
  const tools = useAgentToolSupport()
  const turnOff = agentMustTurnOff(agentOn, tools.modelName)
  useEffect(() => {
    if (!turnOff) return
    useAgentModeStore.getState().setAgentModeActive(chatKey, false)
    toast(T.status.agentTurnedOff, { testid: 'agent-turned-off' })
  }, [turnOff, chatKey])
  return null
}

/**
 * Prompt v2 (14.11.2026): what was a row of chips above the field is now the grey summary next to the ONE
 * settings button under it. The parts in the order of the old chips, each only while its thing is on.
 * `changed`: something differs from a plain chat (the dot at the button).
 */
export function useComposerStatusParts(chatId: string | null, agentKey: string): { parts: string[]; changed: boolean } {
  const agentOn = useAgentModeStore((s) => s.agentModeActive[agentKey] ?? false)
  const docCount = useRAGStore((s) => (chatId ? (s.documents[chatId]?.length ?? 0) : 0))
  const thinking = useThinkingState()
  const caveman = useSettingsStore((s) => s.settings.cavemanMode)
  const personasEnabled = useSettingsStore((s) => s.settings.personasEnabled)
  const personas = offeredPersonas(useSettingsStore((s) => s.personas))
  const activePersonaId = useSettingsStore((s) => s.activePersonaId)
  const personaOnChat = useChatStore((s) => (chatId ? s.conversations.find((c) => c.id === chatId)?.personaEnabled === true : false))
  const ownPrompt = useChatStore((s) => (chatId ? (s.conversations.find((c) => c.id === chatId)?.systemPrompt ?? '').trim() : ''))
  const groupCount = useChatStore((s) => {
    const models = chatId ? s.conversations.find((c) => c.id === chatId)?.groupModels : undefined
    return isGroupChat(models) ? models.length : 0
  })
  const personaName = ownPrompt ? (personaNameFor(true, ownPrompt, personas, personas.find((p) => p.id === activePersonaId)?.name ?? null) ?? T.status.personaOwn) : null
  const showPersona = personasEnabled && personaOnChat && !!personaName
  const parts: string[] = []
  if (agentOn) parts.push(T.status.agent)
  if (docCount > 0) parts.push(T.status.documents(docCount))
  if (thinking.on) parts.push(T.status.thinking)
  if (showPersona && personaName) parts.push(personaName)
  if (groupCount > 0) parts.push(T.status.group(groupCount))
  if (caveman !== 'off') parts.push(T.status.caveman)
  return { parts, changed: agentOn || showPersona || groupCount > 0 || caveman !== 'off' }
}

/**
 * The warnings that still stand above the field in prompt v2: Agent is on and the model cannot use tools.
 * Everything else that was a chip here is in the summary of the settings button.
 */
export function ComposerAlerts({ chatKey: key }: { chatKey: string }) {
  const agentOn = useAgentModeStore((s) => s.agentModeActive[key] ?? false)
  const tools = useAgentToolSupport()
  if (!agentOn || tools.canUseTools) return null
  return (
    <Chip kind="action" mini tone="warn" icon={AlertTriangle} label={T.status.agentNoTools} onPress={() => openOptions({ chatId: key, section: 'agent' })} testid="m-chat-status-agent" el="C2.10">
      {T.status.agent}
    </Chip>
  )
}

export function ComposerStatus({ chatId }: ComposerStatusProps) {
  const agentOn = useAgentModeStore((s) => s.agentModeActive[chatId] ?? false)
  const tools = useAgentToolSupport()
  const docCount = useRAGStore((s) => s.documents[chatId]?.length ?? 0)
  const docsOn = useRAGStore((s) => s.ragEnabled[chatId] ?? false)
  const thinking = useThinkingState()
  const caveman = useSettingsStore((s) => s.settings.cavemanMode)
  const personasEnabled = useSettingsStore((s) => s.settings.personasEnabled)
  // What this build lists (policy/personas.ts): a persona it hides gets no chip, the plain one its store name.
  const personas = offeredPersonas(useSettingsStore((s) => s.personas))
  const activePersonaId = useSettingsStore((s) => s.activePersonaId)
  // The same reading the send path makes (lib/system-prompt.ts): on only when the chat says so, and
  // with the persona text the chat started with, which need not be the active persona any more.
  const personaOnChat = useChatStore((s) => s.conversations.find((c) => c.id === chatId)?.personaEnabled === true)
  const ownPrompt = useChatStore((s) => (s.conversations.find((c) => c.id === chatId)?.systemPrompt ?? '').trim())
  const personaName = personaNameFor(true, ownPrompt, personas, personas.find((p) => p.id === activePersonaId)?.name ?? null)
  const persona = ownPrompt ? { name: personaName ?? T.status.personaOwn } : null
  const groupCount = useChatStore((s) => {
    const models = s.conversations.find((c) => c.id === chatId)?.groupModels
    return isGroupChat(models) ? models.length : 0
  })
  const showPersona = personasEnabled && personaOnChat && !!persona

  if (!agentOn && docCount === 0 && !thinking.on && !showPersona && groupCount === 0 && caveman === 'off') return null

  return (
    <>
      {agentOn ? (
        <Chip
          kind="action"
          mini
          tone={tools.canUseTools ? 'ok' : 'warn'}
          icon={tools.canUseTools ? Bot : AlertTriangle}
          label={tools.canUseTools ? T.status.agentName : T.status.agentNoTools}
          onPress={() => openOptions({ chatId, section: 'agent' })}
          testid="m-chat-status-agent"
          el="C2.10"
        >
          {T.status.agent}
        </Chip>
      ) : null}
      {docCount > 0 ? (
        <Chip
          kind="action"
          mini
          tone={docsOn ? 'ok' : 'default'}
          icon={FileText}
          label={T.status.documentsName(docCount, docsOn)}
          onPress={() => nav.push('/chat/:id/documents', { id: chatId })}
          testid="m-chat-status-documents"
          el="C2.11"
        >
          {docsOn ? T.status.documents(docCount) : T.status.documentsOff(docCount)}
        </Chip>
      ) : null}
      {thinking.on ? (
        <Chip kind="action" mini icon={Brain} label={T.status.thinkingName} onPress={() => openOptions({ chatId, section: 'thinking' })} testid="m-chat-status-thinking" el="C2.12">
          {T.status.thinking}
        </Chip>
      ) : null}
      {showPersona && persona ? (
        <Chip kind="action" mini icon={User} label={T.status.personaName(persona.name)} onPress={() => openOptions({ chatId, section: 'persona' })} testid="m-chat-status-persona" el="C2.12">
          {T.status.persona(persona.name)}
        </Chip>
      ) : null}
      {groupCount > 0 ? (
        <Chip kind="action" mini icon={Users} label={T.status.groupName(groupCount)} onPress={() => nav.push('/chat/:id/group', { id: chatId })} testid="m-chat-status-group" el="C2.12">
          {T.status.group(groupCount)}
        </Chip>
      ) : null}
      {caveman !== 'off' ? (
        <Chip kind="action" mini icon={Volume1} label={T.status.cavemanName(caveman)} onPress={() => openOptions({ chatId, section: 'caveman' })} testid="m-chat-status-caveman" el="C2.12">
          {T.status.caveman}
        </Chip>
      ) : null}
    </>
  )
}
