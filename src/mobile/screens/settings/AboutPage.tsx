/**
 * E20 About LU. Route /settings/about, page, strand 5 (Account, cloud, settings).
 *
 * Name, version, and the ways out: what is new, licenses, website, source.
 * A store build is updated by its store and the page says so. The open
 * Android package has no store: it shows "Update to X" (lib/app-update.ts).
 */
import { Code2, Download, Copy, FileText, Globe, Mail, ScrollText, ShieldCheck, Sparkles } from 'lucide-react'
import { nav } from '../../nav'
import { copyText, mobileOS } from '../../platform'
import { appLinkAllowed } from '../../policy/links'
import { COMMON } from '../../strings/common'
import { SETTINGS_STRINGS } from '../../strings/settings'
import { ListGroup, Monogram, Page, Row, toast } from '../../ui'
import { APP_VERSION } from './parts/app-info'
import { Block, Hint } from './parts/layout'
import { contactSupport } from './parts/contact'
import { LINKS, SUPPORT_EMAIL, openLink } from './parts/links'
import { storePolicy } from './parts/policy'
import { openUpdate, useShownUpdate, useUpdateCheck } from './parts/UpdateRow'
import { updateHintOffered } from '../../lib/app-update'

const T = SETTINGS_STRINGS.about
const C = SETTINGS_STRINGS.common

const OS_NAME: Record<string, string> = { ios: 'iOS', android: 'Android' }

export default function AboutPage() {
  const os = mobileOS()
  const osName = os ? OS_NAME[os] : undefined
  const build = osName ? `${APP_VERSION} (${osName})` : APP_VERSION
  useUpdateCheck()
  const update = useShownUpdate()

  const copyVersion = async () => {
    const ok = await copyText(`${T.name} ${build}`)
    toast(ok ? T.versionCopied : C.copyFailed, { tone: ok ? 'default' : 'error', testid: ok ? 'version-copied' : 'copy-failed' })
  }

  // A mail app where there is one. Where none comes to the front (a phone without a mail app set up says nothing
  // by itself), the address goes to the clipboard and the toast says so (parts/contact.ts).
  const contact = async () => {
    const outcome = await contactSupport()
    if (outcome === 'mail-app') return
    toast(outcome === 'copied' ? `${T.contactFailed(SUPPORT_EMAIL)} ${T.contactCopied}.` : T.contactFailed(SUPPORT_EMAIL), { testid: 'contact-fallback' })
  }

  const copyAddress = async () => {
    const ok = await copyText(SUPPORT_EMAIL)
    toast(ok ? T.contactCopied : C.copyFailed, { tone: ok ? 'default' : 'error', testid: ok ? 'contact-copied' : 'copy-failed' })
  }

  return (
    <Page title={T.title} screen="settings-about">
      <div className="m-empty" style={{ paddingBottom: 'var(--m-s4)' }}>
        {/* The mark alone, no name under it. A screen reader hears the name from the mark. */}
        <Monogram size={56} className="m-empty-mark" label={COMMON.markName} />
        <p>{T.tagline}</p>
      </div>

      <ListGroup>
        <Row
          title={T.version}
          label={T.versionCopy(build)}
          end={
            <span className="m-mono" data-testid="m-settings-about-version-value">
              {build}
            </span>
          }
          chevron={false}
          onPress={() => void copyVersion()}
          testid="m-settings-about-version"
          el="E20.4"
        />
        {/* Which store rules this build carries (M5): a build that was made as the wrong one shows it here. */}
        <Row
          title={T.storeBuild}
          end={
            <span className="m-cap" data-testid="m-settings-about-build-value" data-m-preset={storePolicy().preset}>
              {T.storeBuildNames[storePolicy().preset]}
            </span>
          }
          chevron={false}
          testid="m-settings-about-build"
        />
      </ListGroup>

      {update ? (
        <ListGroup>
          <Row icon={Download} title={T.updateTo(update.version)} subtitle={T.updateSub} chevron={false} onPress={() => void openUpdate(update)} risk="leaves-app" testid="m-settings-about-update" />
        </ListGroup>
      ) : null}

      <ListGroup>
        <Row icon={Sparkles} title={T.whatsNew} onPress={() => nav.push('/whats-new')} testid="m-settings-about-whats-new" el="E20.1" />
        <Row icon={FileText} title={T.licenses} onPress={() => nav.openSheet('settings-licenses')} testid="m-settings-about-licenses" el="E20.2" />
        {/* Store switch externalLinks: a build with the legal links only has neither the website nor the repository here. */}
        {appLinkAllowed(LINKS.website) ? <Row icon={Globe} title={T.website} subtitle={C.onLuLabs} chevron={false} onPress={() => void openLink(LINKS.website)} risk="leaves-app" testid="m-settings-about-website" el="E20.3" /> : null}
        {appLinkAllowed(LINKS.source) ? <Row icon={Code2} title={T.source} subtitle={T.sourceOpens} chevron={false} onPress={() => void openLink(LINKS.source)} risk="leaves-app" testid="m-settings-about-source" /> : null}
      </ListGroup>

      {storePolicy().contactInfo ? (
        <ListGroup title={T.contactGroup} testid="m-settings-about-contact-group">
          <Row icon={Mail} title={T.contact} subtitle={SUPPORT_EMAIL} chevron={false} onPress={() => void contact()} risk="leaves-app" testid="m-settings-about-contact" />
          <Row icon={Copy} title={T.contactCopy} subtitle={T.contactCopySub} chevron={false} onPress={() => void copyAddress()} testid="m-settings-about-contact-copy" />
          <Row icon={ShieldCheck} title={T.privacyPolicy} subtitle={C.onLuLabs} chevron={false} onPress={() => void openLink(LINKS.privacy)} risk="leaves-app" testid="m-settings-about-privacy" />
          <Row icon={ScrollText} title={T.terms} subtitle={C.onLuLabs} chevron={false} onPress={() => void openLink(LINKS.terms)} risk="leaves-app" testid="m-settings-about-terms" />
        </ListGroup>
      ) : null}

      <Block lead>
        <Hint>{updateHintOffered(storePolicy().preset, os) ? T.updatesOpen : T.updates}</Hint>
        <Hint>{T.license}</Hint>
      </Block>
    </Page>
  )
}
