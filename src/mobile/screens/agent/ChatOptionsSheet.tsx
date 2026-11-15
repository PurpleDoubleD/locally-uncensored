/**
 * C5 Chat options. Sheet "chat-options", opened with nav.openSheet('chat-options'), strand 2 (Agent and knowledge).
 *
 * Opened by the chat page with { chatId, section } (parts/options/sections.ts).
 * The first page is this file, every sub page is a file in parts/options/.
 * A chat without an id has the key "new": what is set here moves to the chat
 * with its first message (parts/chat-ref.ts).
 *
 * From mobile-docs/design/DESIGN.md (German, element texts in English):
 *
 *   **C5 Chat options** (Blatt mit Unterseiten)
 *   Zweck: Alles, was am Desktop als Knopfreihe ueber und unter dem Eingabefeld sitzt.
 *   Aufbau: drei Gruppen. Unterseiten oeffnen im selben Blatt mit Zurueck-Pfeil in der Blattkopfzeile.
 *   Elemente Gruppe 1 (Schalter, wirken sofort):
 *   - C5.1 "Agent mode" (Zusatz "Let the model use tools step by step"): schaltet je Chat. Beim ersten Einschalten
 *   zeigt eine Unterseite die Einfuehrung mit "Turn on" und "Not now".
 *   - C5.2 "Thinking": schaltet. Bei Modellen, die immer denken, gesperrt an mit dem Zusatz "Always on for this
 *   model". Bei Modellen ohne Denken nicht gezeigt.
 *   - C5.3 "Reasoning effort" (nur wenn Thinking an ist): Segment Low, Medium, High, Max.
 *   - C5.4 "Web search" (Zusatz "Search and read pages when needed"): schaltet die Chat-Werkzeuge Suche und Seite
 *   holen.
 *   - C5.5 "Write files" (Zusatz "Let the model save files into this chat"): schaltet das Werkzeug Datei
 *   schreiben.
 *   - C5.6 "Small model mode" (nur lokal): schaltet das schlanke Werkzeugprofil.
 *   Elemente Gruppe 2 (fuehren auf Unterseiten):
 *   - C5.7 "Persona": Unterseite mit Schalter "Use a persona in this chat", Radioliste der Personas und "Manage
 *   personas" (E6).
 *   - C5.8 "Group chat": oeffnet C13.
 *   - C5.9 "Caveman mode": Unterseite mit Segment Off, Lite, Full, Ultra.
 *   - C5.10 "Memory": oeffnet E7 als Seite.
 *   - C5.11 "Workflows": Unterseite mit der Liste der Workflows, Tippen startet den Workflow in diesem Chat.
 *   "Manage workflows" fuehrt zu E10.
 *   Elemente Gruppe 3:
 *   - C5.12 "Sampling": Unterseite mit Reglern Temperature, Top P, Max length und "Reset to defaults".
 *   - C5.13 "Context window": Unterseite mit Fuellstand als Balken, Auswahl der Fenstergroesse (nur Werte, die das
 *   Geraet traegt) und "Compact now".
 *   - C5.14 "Permissions for this chat": Unterseite mit je einer Zeile pro Werkzeuggruppe (Web, Files, Memory,
 *   Workflows, Sub agents) und Segment Blocked, Ask, Auto. "Use app defaults" setzt zurueck.
 *   - C5.15 "Set a goal": Unterseite mit Textfeld und "Set goal" (entspricht `/goal`).
 *   - C5.16 "Repeat a task": Unterseite mit Textfeld, Intervall und "Start loop" (entspricht `/loop`), Hinweis
 *   "Runs only while LU is open."
 *   - C5.17 "Close".
 *   Zustaende: Gesperrte Zeilen zeigen den Grund im Zusatz, nie nur grau.
 */
import { useEffect, useRef } from 'react'
import { Bot, Box, Brain, Cloud, Coins, Database, FileText, Gauge, Globe, ListChecks, Repeat, Shield, SlidersHorizontal, Target, User, Users, Volume1, Workflow, Zap } from 'lucide-react'
import { agentBlockReason, toolModelFitsThisPhone, useAgentToolSupport, type AgentBlockReason } from './parts/tool-support'
import { useDevice } from '../models/parts/device'
import { storePolicy } from '../../policy/storePolicy'
import { formatContextWindow } from '../../../lib/formatters'
import { isGroupChat } from '../../../lib/group-chat'
import { useActiveContextWindow } from '../../../hooks/useActiveContextWindow'
import { useAgentGoalStore } from '../../../stores/agentGoalStore'
import { useConversationLoop } from '../../../stores/agentLoopStore'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'
import { useMemoryStore } from '../../../stores/memoryStore'
import { usePermissionStore } from '../../../stores/permissionStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useModelStore } from '../../../stores/modelStore'
import { useRAGStore } from '../../../stores/ragStore'
import { isDeviceModel } from '../../lib/model-place'
import { isCloudModel } from '../chat/parts/consent'
import { chatModelLabel } from '../chat/parts/model-name'
import { shownPersona } from '../../policy/personas'
import { nav, useSheet } from '../../nav'
import { AGENT_STRINGS as T } from '../../strings/agent'
import { Button, ListGroup, Row, Segmented, Sheet } from '../../ui'
import './parts/agent.css'
import { chatKey, useConversation } from './parts/chat-ref'
import { chatDiffers } from './parts/permission-groups'
import { useActiveModelIsLocal, useThinkingState } from './parts/model-state'
import { AgentIntroPage } from './parts/options/AgentIntroPage'
import { CavemanPage } from './parts/options/CavemanPage'
import { setChatCategory, useChatCategoryLevel, useChatSettings } from './parts/options/chat-settings'
import { ContextPage } from './parts/options/ContextPage'
import { GoalPage } from './parts/options/GoalPage'
import { LoopPage } from './parts/options/LoopPage'
import { PermissionsPage } from './parts/options/PermissionsPage'
import { PersonaPage } from './parts/options/PersonaPage'
import { SamplingPage } from './parts/options/SamplingPage'
import { isOptionsSub, subPageOf, type ChatOptionsProps } from './parts/options/sections'
import { WorkflowsPage } from './parts/options/WorkflowsPage'

const S = T.options
const AGENT_STATUS = T.status

/** The sentence for each reason Agent mode is locked (parts/tool-support.ts, agentBlockReason). */
const AGENT_BLOCK_TEXT: Record<AgentBlockReason, string> = {
  'none-fits-packing': S.agentNoToolsFitPacking,
  'none-fits': S.agentNoToolsFit,
  packing: S.agentNoToolsPacking,
  device: S.agentNoToolsDevice,
  provider: S.agentNoTools,
}

/** The row a section of the first page scrolls to. */
const SECTION_ROW: Record<string, string> = { agent: 'm-options-agent', thinking: 'm-options-thinking' }

export default function ChatOptionsSheet() {
  const sheet = useSheet<ChatOptionsProps | undefined>()
  const key = chatKey(sheet.props?.chatId)
  const section = sheet.props?.section
  const chat = useChatSettings(key)

  // Open at the place the caller asked for, once per sheet.
  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (opened.current === sheet.key) return
    opened.current = sheet.key
    const sub = subPageOf(section)
    if (sub) {
      if (sheet.sub === null) sheet.pushSub(sub)
      return
    }
    const rowId = section ? SECTION_ROW[section] : undefined
    if (rowId) document.querySelector(`[data-testid="${rowId}"]`)?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.key])

  const sub = isOptionsSub(sheet.sub) ? sheet.sub : null
  if (sub === 'agent-intro') return <AgentIntroPage chat={chat} />
  if (sub === 'persona') return <PersonaPage chat={chat} />
  if (sub === 'caveman') return <CavemanPage />
  if (sub === 'workflows') return <WorkflowsPage chat={chat} />
  if (sub === 'sampling') return <SamplingPage chat={chat} />
  if (sub === 'context') return <ContextPage chat={chat} />
  if (sub === 'permissions') return <PermissionsPage chatKey={key} />
  if (sub === 'goal') return <GoalPage chatKey={key} />
  if (sub === 'loop') return <LoopPage chat={chat} />
  return <FirstPage chatKey={key} />
}

function FirstPage({ chatKey: key }: { chatKey: string }) {
  const sheet = useSheet()
  const chat = useChatSettings(key)
  const tools = useAgentToolSupport()
  const thinking = useThinkingState()
  const local = useActiveModelIsLocal()
  const conversation = useConversation(key)
  const ctx = useActiveContextWindow()
  const smallModel = useSettingsStore((s) => s.settings.smallModelMode)
  const caveman = useSettingsStore((s) => s.settings.cavemanMode)
  const personasEnabled = useSettingsStore((s) => s.settings.personasEnabled)
  const persona = shownPersona(useSettingsStore((s) => s.personas.find((p) => p.id === s.activePersonaId)))
  const memoryCount = useMemoryStore((s) => s.entries.length)
  const goal = useAgentGoalStore((s) => s.goals[key]?.text ?? '')
  const loop = useConversationLoop(key)
  const ownPermissions = usePermissionStore((s) => chatDiffers(s.conversationOverrides[key], s.globalPermissions))
  const webLevel = useChatCategoryLevel(key, 'web')
  const fileLevel = useChatCategoryLevel(key, 'filesystem')
  const activeModel = useModelStore((s) => s.activeModel)
  const models = useModelStore((s) => s.models)
  const docCount = useRAGStore((s) => s.documents[key]?.length ?? 0)
  const inCloud = useSettingsStore((s) => s.settings.appMode === 'cloud')
  const modelWhere = !activeModel ? undefined : isDeviceModel(activeModel) ? S.modelPhone : isCloudModel(activeModel) ? S.modelCloud : S.modelOther

  // Chat tools are always on since 3.0.7 (lib/chat-tools-reach.ts), in plain chat as in Agent.
  const webOn = webLevel !== 'blocked'
  const filesOn = fileLevel !== 'blocked'
  const groupModels = conversation?.groupModels
  const groupCount = isGroupChat(groupModels) ? groupModels.length : 0
  // The reason a model without tools gets: for a model of this phone the catalogue decided, and "Small model mode" does not change that.
  // No model with the Tools mark fits this phone: "Pick a model with the Tools mark" would send the user to a list
  // without one. The row says why, and the row below it leads to the models that work (small iPhone, K5).
  const { device } = useDevice()
  const noneFits = tools.deviceWithoutTools && toolModelFitsThisPhone(device, { unfilteredCatalog: storePolicy().unfilteredCatalog }) === false
  const noTools = AGENT_BLOCK_TEXT[agentBlockReason({ deviceWithoutTools: tools.deviceWithoutTools, packedTooSmall: tools.packedTooSmall, noneFits })]
  const cloudSignedIn = useCloudAuthStore((s) => s.status === 'signed-in')
  const agentBlocked = chat.agentOn || tools.canUseTools ? null : tools.modelName ? noTools : S.agentNoModel
  const personaValue = personasEnabled && chat.personaOnChat && (chat.personaName || persona) ? (chat.personaName ?? S.personaOwn) : S.personaOff
  const window = ctx.sendWindow > 0 ? ctx.sendWindow : ctx.contextWindow

  const setAgent = (on: boolean) => {
    if (on && !useAgentModeStore.getState().tutorialCompleted) {
      sheet.pushSub('agent-intro')
      return
    }
    chat.setAgent(on)
  }

  return (
    <Sheet
      title={S.title}
      testid="m-options"
      footer={
        <Button block onPress={() => sheet.close()} testid="m-options-done" el="C5.17">
          {S.done}
        </Button>
      }
    >
      {/* Prompt v2 (14.11.2026): what stood around the field (model choice, documents chip, cloud chip) is here. */}
      <ListGroup testid="m-options-group-model">
        <Row
          title={S.model}
          subtitle={modelWhere}
          icon={Box}
          value={activeModel ? chatModelLabel(models, activeModel) : S.modelNone}
          onPress={() => {
            sheet.close()
            nav.openSheet('model', {})
          }}
          testid="m-options-model"
          el="C2.6"
        />
        {chat.saved && docCount > 0 ? (
          <Row title={S.documents} subtitle={S.documentsSub} icon={FileText} value={AGENT_STATUS.documents(docCount)} onPress={() => { sheet.close(); nav.push('/chat/:id/documents', { id: key }) }} testid="m-options-documents" el="C2.11" />
        ) : null}
        {inCloud ? (
          <Row title={S.cost} subtitle={S.costSub} icon={Coins} onPress={() => { sheet.close(); nav.openSheet('price', { chatId: key }) }} testid="m-options-cost" el="C2.13" />
        ) : null}
      </ListGroup>
      <ListGroup title={S.groupNow} testid="m-options-group-now">
        <Row
          title={S.agent}
          subtitle={chat.agentOn && !tools.canUseTools ? (tools.modelName ? noTools : S.agentNoModel) : S.agentSub}
          icon={Bot}
          switch={{ checked: chat.agentOn, onChange: setAgent }}
          disabled={!!agentBlocked}
          disabledReason={agentBlocked ?? undefined}
          testid="m-options-agent"
          el="C5.1"
        />
        {agentBlocked && noneFits ? (
          <Row
            title={S.agentOtherModel}
            subtitle={cloudSignedIn ? S.agentOtherModelSub : S.agentOtherModelSubSignedOut}
            icon={Cloud}
            onPress={() => {
              sheet.close()
              nav.openSheet('model', { segment: 'cloud' })
            }}
            testid="m-options-agent-other-model"
            el="C5.1"
          />
        ) : null}
        <Row
          title={S.webSearch}
          subtitle={webOn ? S.webSearchSub : S.webSearchBlocked}
          icon={Globe}
          switch={{ checked: webOn, onChange: (on) => setChatCategory(key, 'web', on, 'auto') }}
          testid="m-options-web"
          el="C5.4"
        />
        <Row
          title={S.writeFiles}
          subtitle={filesOn ? S.writeFilesSub : S.writeFilesBlocked}
          icon={FileText}
          switch={{ checked: filesOn, onChange: (on) => setChatCategory(key, 'filesystem', on, 'confirm') }}
          testid="m-options-files"
          el="C5.5"
        />
      </ListGroup>
      {/* What follows is kept in the settings of the app and holds for every chat. It stands under its own
          heading: under "This chat" a switch that was on in every other chat as well read as a fault
          (acceptance on the large iPhone, G5). */}
      {thinking.lockedOn || thinking.canThink || local ? (
        <ListGroup title={S.groupAll} testid="m-options-group-all">
          {thinking.lockedOn ? (
            <Row title={S.thinking} subtitle={S.thinkingAlways} icon={Brain} switch={{ checked: true, onChange: () => {} }} disabled disabledReason={S.thinkingAlways} testid="m-options-thinking" el="C5.2" />
          ) : thinking.canThink ? (
            <Row
              title={S.thinking}
              subtitle={S.thinkingSub}
              icon={Brain}
              switch={{ checked: thinking.on, onChange: (on) => useSettingsStore.getState().updateSettings({ thinkingEnabled: on }) }}
              testid="m-options-thinking"
              el="C5.2"
            />
          ) : null}
          {thinking.on && thinking.effortSteps.length > 1 ? (
            <div className="m-ag-seg-row" data-testid="m-options-effort-row">
              <span className="m-ag-seg-title">{S.effort}</span>
              <Segmented
                label={S.effort}
                value={thinking.effort}
                onChange={(next) => useSettingsStore.getState().updateSettings({ reasoningEffort: next })}
                options={thinking.effortSteps.map((value) => ({ value, label: S.effortLevels[value] ?? value, testid: `m-options-effort-${value}` }))}
                testid="m-options-effort"
                el="C5.3"
              />
            </div>
          ) : null}
          {local ? (
            <Row
              title={S.smallModel}
              subtitle={S.smallModelSub}
              icon={Zap}
              switch={{ checked: smallModel, onChange: (on) => useSettingsStore.getState().updateSettings({ smallModelMode: on }) }}
              testid="m-options-small"
              el="C5.6"
            />
          ) : null}
        </ListGroup>
      ) : null}
      <ListGroup title={S.groupMore} testid="m-options-group-more">
        <Row title={S.persona} icon={User} value={personaValue} onPress={() => sheet.pushSub('persona')} testid="m-options-persona" el="C5.7" />
        <Row
          title={S.group}
          subtitle={S.groupSub}
          icon={Users}
          value={groupCount > 0 ? S.groupOn(groupCount) : undefined}
          disabled={!chat.saved}
          disabledReason={S.needsSavedChat}
          onPress={() => nav.push('/chat/:id/group', { id: key })}
          testid="m-options-group"
          el="C5.8"
        />
        <Row title={S.caveman} icon={Volume1} value={S.cavemanLevels[caveman]} onPress={() => sheet.pushSub('caveman')} testid="m-options-caveman-row" el="C5.9" />
        <Row title={S.memory} subtitle={S.memorySub} icon={Database} value={memoryCount > 0 ? S.memoryCount(memoryCount) : undefined} onPress={() => nav.push('/settings/memory')} testid="m-options-memory" el="C5.10" />
        <Row title={S.workflows} subtitle={S.workflowsSub} icon={Workflow} onPress={() => sheet.pushSub('workflows')} testid="m-options-workflows-row" el="C5.11" />
      </ListGroup>
      <ListGroup title={S.groupFine} testid="m-options-group-fine">
        <Row title={S.sampling} icon={SlidersHorizontal} value={chat.ownSampling ? S.samplingOwn : S.samplingDefault} onPress={() => sheet.pushSub('sampling')} testid="m-options-sampling" el="C5.12" />
        <Row title={S.context} subtitle={S.contextSub} icon={Gauge} value={window > 0 ? formatContextWindow(window) : undefined} onPress={() => sheet.pushSub('context')} testid="m-options-context" el="C5.13" />
        <Row title={S.permissions} icon={Shield} value={ownPermissions ? S.permissionsOwn : S.permissionsDefault} onPress={() => sheet.pushSub('permissions')} testid="m-options-permissions-row" el="C5.14" />
        <Row title={S.goal} icon={Target} subtitle={goal ? goal : undefined} value={goal ? S.goalSet : undefined} onPress={() => sheet.pushSub('goal')} testid="m-options-goal" el="C5.15" />
        <Row title={S.loop} icon={loop ? ListChecks : Repeat} value={loop ? S.loopRunning : undefined} onPress={() => sheet.pushSub('loop')} testid="m-options-loop" el="C5.16" />
      </ListGroup>
    </Sheet>
  )
}
