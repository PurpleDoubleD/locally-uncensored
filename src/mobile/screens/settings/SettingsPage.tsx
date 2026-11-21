/**
 * E1 Settings. Route /settings, tab root, strand 5 (Account, cloud, settings).
 *
 * The account card on top, below it five groups. Every row shows its current
 * value where it has one and leads to a page. Rows E1.4, E1.5, E1.7 to E1.10
 * and E1.13 lead to pages of the strands 2 and 4.
 */

import { Download,
  Bot,
  Brain,
  Cpu,
  Database,
  Globe,
  HardDrive,
  Info,
  KeyRound,
  LifeBuoy,
  MessageSquareText,
  MonitorSmartphone,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Volume2,
  Workflow,
} from 'lucide-react'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useVoiceStore } from '../../../stores/voiceStore'
import { nav } from '../../nav'
import type { ThemePref } from '../../platform'
import { useRemoteClientStore } from '../../remote/remoteClientStore'
import { SETTINGS_STRINGS } from '../../strings/settings'
import { ListGroup, RootPage, Row } from '../../ui'
import { openUpdate, useShownUpdate } from './parts/UpdateRow'
import { AccountCard } from './parts/AccountCard'
import { storePolicy } from './parts/policy'
import { APP_VERSION } from './parts/app-info'
import { useThemePref } from './parts/theme-pref'

const T = SETTINGS_STRINGS.root
const C = SETTINGS_STRINGS.common


const THEME_NAME: Record<ThemePref, string> = { system: T.themeSystem, dark: T.themeDark, light: T.themeLight }

export default function SettingsPage() {
  const theme = useThemePref()
  const personasOn = useSettingsStore((s) => s.settings.personasEnabled)
  const temperature = useSettingsStore((s) => s.settings.temperature)
  const voiceOn = useVoiceStore((s) => s.ttsEnabled)
  const remoteStatus = useRemoteClientStore((s) => s.status)
  const policy = storePolicy()

  const update = useShownUpdate()
  return (
    <RootPage title={T.title} screen="settings">
      <AccountCard />
      {update ? (
        <ListGroup>
          <Row icon={Download} title={SETTINGS_STRINGS.about.updateTo(update.version)} subtitle={SETTINGS_STRINGS.about.updateSub} chevron={false} onPress={() => void openUpdate(update)} risk="leaves-app" testid="m-settings-update" />
        </ListGroup>
      ) : null}

      <ListGroup title={T.groupApp}>
        <Row icon={Palette} title={T.appearance} value={THEME_NAME[theme]} onPress={() => nav.push('/settings/appearance')} testid="m-settings-theme" el="E1.2" />
        <Row icon={SlidersHorizontal} title={T.chatDefaults} subtitle={T.chatDefaultsSub(temperature.toFixed(1))} onPress={() => nav.push('/settings/chat')} testid="m-settings-chat" el="E1.3" />
        <Row icon={UserRound} title={T.personas} value={personasOn ? C.on : C.off} onPress={() => nav.push('/settings/personas')} testid="m-settings-personas" el="E1.4" />
        <Row icon={Brain} title={T.memory} onPress={() => nav.push('/settings/memory')} testid="m-settings-memory" el="E1.5" />
        <Row icon={Volume2} title={T.voice} value={voiceOn ? C.on : C.off} onPress={() => nav.push('/settings/voice')} testid="m-settings-voice" el="E1.6" />
      </ListGroup>

      <ListGroup title={T.groupAgent}>
        <Row icon={Bot} title={T.agent} onPress={() => nav.push('/settings/agent')} testid="m-settings-agent" el="E1.7" />
        <Row icon={Globe} title={T.search} onPress={() => nav.push('/settings/search')} testid="m-settings-search" el="E1.8" />
        <Row icon={Workflow} title={T.workflows} onPress={() => nav.push('/settings/workflows')} testid="m-settings-workflows" el="E1.9" />
      </ListGroup>

      <ListGroup title={T.groupModels}>
        <Row icon={Cpu} title={T.engine} onPress={() => nav.push('/settings/engine')} testid="m-settings-engine" el="E1.10" />
        {/* Store switches externalProviders and remoteDesktop: a build without them has neither row (the pages are closed too, policy/gates.ts). */}
        {policy.externalProviders ? <Row icon={KeyRound} title={T.providers} onPress={() => nav.push('/settings/providers')} testid="m-settings-providers" el="E1.11" /> : null}
        {policy.remoteDesktop ? (
          <Row
            icon={MonitorSmartphone}
            title={T.remote}
            value={remoteStatus === 'connected' ? T.remoteConnected : T.remoteOff}
            onPress={() => nav.push('/settings/remote')}
            testid="m-settings-remote"
            el="E1.12"
          />
        ) : null}
        <Row icon={HardDrive} title={T.storage} onPress={() => nav.push('/settings/storage')} testid="m-settings-storage" el="E1.13" />
      </ListGroup>

      <ListGroup title={T.groupData}>
        <Row icon={Database} title={T.data} onPress={() => nav.push('/settings/data')} testid="m-settings-data" el="E1.14" />
        <Row icon={ShieldCheck} title={T.privacy} onPress={() => nav.push('/settings/privacy')} testid="m-settings-privacy" el="E1.15" />
        <Row icon={MessageSquareText} title={T.contentPolicy} onPress={() => nav.push('/settings/content-policy')} testid="m-settings-content-policy" el="E1.16" />
      </ListGroup>

      <ListGroup title={T.groupHelp}>
        <Row icon={LifeBuoy} title={T.troubleshooting} onPress={() => nav.push('/settings/troubleshooting')} testid="m-settings-troubleshooting" el="E1.17" />
        <Row icon={Info} title={T.about} value={APP_VERSION} onPress={() => nav.push('/settings/about')} testid="m-settings-about" el="E1.18" />
      </ListGroup>
    </RootPage>
  )
}
