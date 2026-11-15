/**
 * E2 Account. Route /settings/account, page, strand 5 (Account, cloud, settings).
 *
 * Signed out: sign in or create an account with email and password, or
 * continue with Google or GitHub in the system browser. The way back from
 * the browser is the link lu://oauth/callback, which the logic layer finishes
 * by itself (lib/incoming-url.ts). On an iPhone or iPad "Sign in with Apple"
 * stands above the two (store switch appleSignIn, the sheet of the system,
 * no browser): Apple's rule 4.8 asks for it wherever a sign in through a
 * third party is offered. A build without sign in through a third party
 * (store switch thirdPartySignIn) does not show Google and GitHub. One
 * sentence under the buttons says that another way to sign in can mean
 * another account. Signed in: plan, credits and the links that manage them
 * on the website. Nothing is bought inside the app.
 *
 * The account state is read from cloudAuthStore. The hook that keeps it
 * fresh is mounted once by the frame of the shell, never here.
 */
import { useEffect, useRef, useState } from 'react'
import { Brain, CircleUserRound, CreditCard, ExternalLink, KeyRound, LogOut, MessageSquareText, MessagesSquare, Plus, RefreshCw, UserRoundX, WifiOff } from 'lucide-react'
import type { OAuthProvider } from '../../../api/cloud/supabase'
import { countUnsyncedAccountMemories } from '../../../lib/memory-unsynced'
import { PAST_DUE_WALLET_LINE, pastDueLine } from '../../../lib/past-due'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'
import { iapOfferedToAccount } from '../../lib/iap'
import { nav } from '../../nav'
import { isOnline } from '../../platform'
import { useOnline } from '../../resilience/useOnline'
import { SETTINGS_STRINGS } from '../../strings/settings'
import { Button, Card, Field, Icon, ListGroup, Notice, Page, Progress, Row, Segmented, Spinner, toast } from '../../ui'
import { takeAccountStart } from './parts/account-start'
import { creditsView, planName } from './parts/account-view'
import { AppleSheetError, appleSignInOffered, refreshAccount, signIn, signInWithApple, signInWithProvider, signOut, signUp } from './parts/auth'
import { authErrorText, classifyAuthError, isOAuthCancel, isOAuthNotOpened, validateCredentials } from './parts/auth-errors'
import { Block, Hint } from './parts/layout'
import { LINKS, openLink } from './parts/links'
import { useNoLinkBack } from './parts/no-link-back'
import { storePolicy } from './parts/policy'
import { buyHint, showsBuyLinks, showsBuyText } from './parts/store-rules'
import { SecretField } from './parts/PasswordField'
import { UserAvatar } from './parts/UserAvatar'
import { ComputerSignIn } from './parts/ComputerSignIn'

const T = SETTINGS_STRINGS.account
type Mode = 'signin' | 'signup'

function SignedOut() {
  const online = useOnline()
  // "Sign in" first, except right after "Create account" on the page LU Cloud (parts/account-start.ts).
  const [mode, setMode] = useState<Mode>(takeAccountStart)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field: 'email' | 'password' | 'form' } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [waiting, setWaiting] = useState<OAuthProvider | null>(null)
  /** A browser is really in front. Only then does the page say that it waits for one (iPhone, round 22, N5). */
  const [browserOpen, setBrowserOpen] = useState(false)
  /** The provider page did not open: said, with a way to try again. Never an endless wait. */
  const [notOpened, setNotOpened] = useState<OAuthProvider | null>(null)
  /**
   * Back in the app from the browser, and no link came (round 43): the account server led
   * somewhere else. Said, with a way to try again, and the wait ends instead of running on.
   */
  const [notBack, setNotBack] = useState<OAuthProvider | null>(null)
  /** When the present wait for the browser began, for the look on the return. */
  const [waitSince, setWaitSince] = useState<number | null>(null)
  const browserOpenRef = useRef(false)
  const [appleBusy, setAppleBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const thirdParty = storePolicy().thirdPartySignIn
  const apple = appleSignInOffered()

  // Leaving the page ends a wait for the browser; the link that comes back later is still offered (G14).
  useEffect(() => () => abort.current?.abort(), [])

  useNoLinkBack(waitSince, () => {
    // Only a browser that was really in front can fail to come back. The sheet of an iPhone hands the link back itself.
    if (!waiting || !browserOpenRef.current) return
    setNotBack(waiting)
    abort.current?.abort()
  })

  const fail = (kind: ReturnType<typeof classifyAuthError>) => {
    const field = kind === 'email-invalid' || kind === 'exists' ? 'email' : kind === 'wrong-password' || kind === 'password-short' ? 'password' : 'form'
    setError({ text: authErrorText(kind), field })
  }

  const submit = async () => {
    if (busy) return
    setNotice(null)
    setNotBack(null)
    const invalid = validateCredentials(email, password, mode)
    if (invalid) return fail(invalid)
    if (!isOnline()) return fail('offline')
    setBusy(true)
    setError(null)
    try {
      if (mode === 'signin') {
        await signIn(email, password)
      } else if ((await signUp(email, password)) === 'confirm') {
        setPassword('')
        setMode('signin')
        setNotice(T.confirmSent)
        return
      }
      if (useCloudAuthStore.getState().status === 'signed-in') {
        setPassword('')
        toast(T.signedInToast, { testid: 'signed-in' })
      } else {
        // The password was right but the account could not be read: say so instead of showing nothing.
        fail(isOnline() ? 'server' : 'offline')
      }
    } catch (err) {
      const kind = classifyAuthError(err, isOnline())
      if (kind === 'not-confirmed') {
        setError(null)
        setNotice(T.errNotConfirmed)
      } else {
        fail(kind)
      }
    } finally {
      setBusy(false)
    }
  }

  const withProvider = async (provider: OAuthProvider) => {
    if (waiting || busy || appleBusy) return
    if (!isOnline()) return fail('offline')
    const ctrl = new AbortController()
    abort.current = ctrl
    setWaiting(provider)
    setBrowserOpen(false)
    browserOpenRef.current = false
    setWaitSince(Date.now())
    setNotOpened(null)
    setNotBack(null)
    setError(null)
    setNotice(null)
    try {
      await signInWithProvider(provider, ctrl.signal, () => {
        browserOpenRef.current = true
        setBrowserOpen(true)
      })
      if (useCloudAuthStore.getState().status === 'signed-in') toast(T.signedInToast, { testid: 'signed-in' })
    } catch (err) {
      // Closing the sheet or the browser, and Cancel here, lead back without a word.
      if (ctrl.signal.aborted || isOAuthCancel(err)) return
      if (isOAuthNotOpened(err)) setNotOpened(provider)
      else fail(classifyAuthError(err, isOnline()))
    } finally {
      if (abort.current === ctrl) abort.current = null
      setWaiting(null)
      setBrowserOpen(false)
      browserOpenRef.current = false
      setWaitSince(null)
    }
  }

  const withApple = async () => {
    if (appleBusy || waiting || busy) return
    if (!isOnline()) return fail('offline')
    setAppleBusy(true)
    setNotBack(null)
    setError(null)
    setNotice(null)
    try {
      // Closing the sheet of the system is not an error: nothing is said.
      if ((await signInWithApple()) === 'cancelled') return
      if (useCloudAuthStore.getState().status === 'signed-in') toast(T.signedInToast, { testid: 'signed-in' })
      else fail(isOnline() ? 'server' : 'offline')
    } catch (err) {
      if (err instanceof AppleSheetError) {
        // The sentence of the system sheet, as it is.
        setError({ text: err.message, field: 'form' })
      } else {
        const kind = classifyAuthError(err, isOnline())
        // The account server refused the token: none of the sentences about a password fits.
        if (kind === 'offline' || kind === 'too-many' || kind === 'server') fail(kind)
        else setError({ text: T.errApple, field: 'form' })
      }
    } finally {
      setAppleBusy(false)
    }
  }

  return (
    <>
      <Block lead>
        <Segmented<Mode>
          label={T.modeLabel}
          value={mode}
          onChange={(next) => {
            setMode(next)
            setError(null)
            setNotice(null)
          }}
          options={[
            { value: 'signin', label: T.modeSignIn, testid: 'm-account-mode-signin' },
            { value: 'signup', label: T.modeSignUp, testid: 'm-account-mode-signup' },
          ]}
          testid="m-account-mode"
          el="E2.1"
        />
        <Hint>{T.intro}</Hint>
      </Block>

      {!online ? (
        <Notice variant="warn" icon={WifiOff} testid="m-account-offline">
          {T.errOffline}
        </Notice>
      ) : null}
      {notice ? (
        <Notice testid="m-account-notice">{notice}</Notice>
      ) : null}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Block>
          <Field
            label={T.email}
            type="email"
            inputMode="email"
            autoComplete={mode === 'signin' ? 'username' : 'email'}
            placeholder={T.emailPlaceholder}
            value={email}
            onChange={setEmail}
            error={error?.field === 'email' ? error.text : undefined}
            disabled={busy}
            testid="m-account-email"
            el="E2.2"
          />
          <SecretField
            label={T.password}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={setPassword}
            onSubmit={() => void submit()}
            error={error?.field === 'password' ? error.text : undefined}
            hint={mode === 'signup' ? T.passwordHintNew : undefined}
            disabled={busy}
            testid="m-account-password"
            showTestid="m-account-password-show"
            el="E2.3"
          />
          {error?.field === 'form' ? (
            <p className="m-field-error" role="alert" data-testid="m-account-error" style={{ margin: 0 }}>
              {error.text}
            </p>
          ) : null}
          <Button variant="primary" block type="submit" busy={busy} label={busy ? T.checking : undefined} testid="m-account-signin" el="E2.4">
            {mode === 'signin' ? T.submitSignIn : T.submitSignUp}
          </Button>
        </Block>
      </form>
      {/* Right under the form, where a forgotten password is noticed (iOS N19), not below the other ways to sign in. */}
      <ListGroup>
        <Row icon={KeyRound} title={T.forgot} subtitle={T.forgotSub} onPress={() => nav.openSheet('settings-forgot-password', { email: email.trim() })} testid="m-account-forgot" el="E2.7" />
      </ListGroup>

      {/* R53: the paired computer signs this phone in to its own session (behind a switch until the web part is live). */}
      <ComputerSignIn disabled={busy || waiting !== null || appleBusy} />

      {/* The other ways in. "Sign in with Apple" (store switch appleSignIn, iOS only) stands first: rule 4.8 wants it at least as
          prominent as Google and GitHub (store switch thirdPartySignIn). */}
      {apple || thirdParty ? (
        <>
          <Block>
            <Hint>{T.orContinue}</Hint>
            {apple ? (
              <Button variant="apple" block busy={appleBusy} disabled={waiting !== null} onPress={() => void withApple()} testid="m-account-apple" el="E2.15">
                <span className="m-apple-logo" aria-hidden="true">
                  {'\uF8FF'}
                </span>
                {T.apple}
              </Button>
            ) : null}
            {thirdParty ? (
              <>
                <Button block busy={waiting === 'google'} disabled={waiting === 'github' || appleBusy} onPress={() => void withProvider('google')} testid="m-account-google" el="E2.5">
                  {T.google}
                </Button>
                <Button block busy={waiting === 'github'} disabled={waiting === 'google' || appleBusy} onPress={() => void withProvider('github')} testid="m-account-github" el="E2.6">
                  {T.github}
                </Button>
              </>
            ) : null}
            {/* Another way in can be another account (an Apple address that hides the real one, for example). Said, not solved. */}
            <Hint testid="m-account-same-signin">{T.sameSignIn}</Hint>
          </Block>
          {waiting && browserOpen ? (
            <Notice
              testid="m-account-oauth-waiting"
              actions={
                <Button compact onPress={() => abort.current?.abort()} testid="m-account-oauth-cancel">
                  {T.oauthCancel}
                </Button>
              }
            >
              {T.oauthWaiting}
            </Notice>
          ) : null}
          {notBack && !waiting ? (
            <Notice
              variant="error"
              testid="m-account-oauth-not-back"
              actions={
                <Button compact variant="primary" onPress={() => void withProvider(notBack)} testid="m-account-oauth-not-back-retry">
                  {T.oauthRetry}
                </Button>
              }
            >
              {T.oauthNotBack}
            </Notice>
          ) : null}
          {notOpened && !waiting ? (
            <Notice
              variant="error"
              testid="m-account-oauth-not-opened"
              actions={
                <Button compact variant="primary" onPress={() => void withProvider(notOpened)} testid="m-account-oauth-retry">
                  {T.oauthRetry}
                </Button>
              }
            >
              {T.oauthNotOpened}
            </Notice>
          ) : null}
        </>
      ) : null}

      {storePolicy().accountDeletion ? (
        <Notice
          title={T.deleteSignedOutTitle}
          testid="m-account-delete-signed-out"
          actions={
            <Button compact icon={ExternalLink} onPress={() => void openLink(LINKS.deleteAccount)} risk="destructive" testid="m-account-delete-website">
              {T.deleteOnWebsite}
            </Button>
          }
        >
          {T.deleteSignedOut}
        </Notice>
      ) : null}

      <ListGroup>
        <Row icon={CircleUserRound} title={T.whatIsCloud} onPress={() => nav.push('/cloud')} testid="m-account-what-is-cloud" el="E2.8" />
      </ListGroup>
    </>
  )
}

function SignedIn() {
  const user = useCloudAuthStore((s) => s.user)
  const offline = useCloudAuthStore((s) => s.offline)
  const licenseActive = useCloudAuthStore((s) => s.licenseActive)
  const tier = useCloudAuthStore((s) => s.tier)
  const pastDue = useCloudAuthStore((s) => s.pastDue)
  const pastDueTier = useCloudAuthStore((s) => s.pastDueTier)
  const quota = useCloudAuthStore((s) => s.quota)
  const [refreshing, setRefreshing] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const credits = licenseActive ? creditsView(quota) : null
  // Plans, packs, the invoice and the subscription live on the website. Whether this page may link there is the store's call.
  const policy = storePolicy()
  const links = showsBuyLinks(policy.purchase)
  const hint = buyHint(policy.purchase)
  const addCredits = !offline && iapOfferedToAccount()
  // The name of a plan is a word about buying: a build without such words says "Active".
  const plan = offline ? T.planUnknown : licenseActive ? ((policy.pricingWords ? planName(quota?.tier ?? tier) : null) ?? T.planActive) : T.planNone

  const doSignOut = async () => {
    setSigningOut(true)
    setSignOutError(null)
    try {
      await signOut()
      toast(T.signedOutToast, { testid: 'signed-out' })
    } catch {
      // The logic layer keeps the account signed in when the saved session survived. Say that, in the phone's words.
      setSignOutError(T.signOutFailed)
    } finally {
      setSigningOut(false)
    }
  }

  const askSignOut = async () => {
    if (signingOut) return
    const open = await countUnsyncedAccountMemories().catch(() => 0)
    if (open > 0) {
      const anyway = await nav.confirm({
        title: T.signOutUnsyncedTitle(open),
        text: T.signOutUnsyncedText,
        confirmLabel: T.signOutConfirm,
        cancelLabel: T.signOutSyncFirst,
        tone: 'danger',
        testid: 'signout-unsynced',
      })
      if (!anyway) {
        nav.push('/settings/memory')
        return
      }
    } else {
      const yes = await nav.confirm({
        title: T.signOutQuestion,
        text: T.signOutText,
        confirmLabel: T.signOutConfirm,
        cancelLabel: T.signOutKeep,
        tone: 'danger',
        testid: 'signout',
      })
      if (!yes) return
    }
    await doSignOut()
  }

  return (
    <>
      <div style={{ paddingTop: 'var(--m-s3)' }}>
        <Card testid="m-account-signedin">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--m-s3)', minWidth: 0 }}>
            <UserAvatar size={44} fallback={<Icon icon={CircleUserRound} />} testid="m-account-avatar" />
            <span className="m-row-text">
              <span className="m-row-title" data-testid="m-account-email-shown">
                {user?.email ?? user?.id}
              </span>
              <span className="m-row-sub" data-testid="m-account-plan">
                {T.cardPlan}: {plan}
              </span>
              {quota?.period && !offline ? <span className="m-row-sub">{T.period(quota.period)}</span> : null}
            </span>
          </div>
          {credits ? (
            <div style={{ marginTop: 'var(--m-s4)' }} data-testid={credits.empty ? 'm-account-credits-empty' : 'm-account-credits'}>
              <span className="m-field-label" style={{ display: 'block', marginBottom: 6 }}>
                {T.credits}
              </span>
              <Progress
                label={T.credits}
                value={credits.share}
                tone="cloud"
                hidePercent
                detail={credits.empty ? T.creditsEmpty : T.creditsLeft(credits.left)}
                meta={T.creditsUsed(credits.used, credits.limit)}
                state={credits.empty ? 'error' : 'running'}
              />
              {credits.topup ? (
                <p className="m-cap" style={{ margin: '8px 0 0' }}>
                  {T.topup(credits.topup)}
                </p>
              ) : null}
            </div>
          ) : !offline && !pastDue && links ? (
            <p className="m-cap" style={{ margin: '12px 0 0' }}>
              {T.noPlanText}
            </p>
          ) : null}
          {hint ? (
            <p className="m-cap" style={{ margin: '12px 0 0' }} data-testid="m-account-plans-text">
              {hint}
            </p>
          ) : null}
        </Card>
      </div>

      {offline ? (
        <Notice variant="warn" icon={WifiOff} title={T.offlineTitle} testid="m-account-offline-kept">
          {T.offlineText}
        </Notice>
      ) : null}

      {pastDue ? (
        <Notice
          variant="error"
          title={showsBuyText(policy.purchase) ? T.pastDueTitle : undefined}
          testid="m-account-past-due"
          actions={
            links ? (
              <Button compact icon={ExternalLink} onPress={() => void openLink(LINKS.account)} risk="paid" testid="m-account-pay-invoice" el="E2.10">
                {T.payInvoice}
              </Button>
            ) : undefined
          }
        >
          {showsBuyText(policy.purchase) ? pastDueLine(pastDueTier) : T.pausedPlain}
          {licenseActive && showsBuyText(policy.purchase) ? ` ${PAST_DUE_WALLET_LINE}` : ''}
        </Notice>
      ) : null}

      {signOutError ? (
        <Notice variant="error" testid="m-account-signout-error">
          {signOutError}
        </Notice>
      ) : null}

      <ListGroup>
        {links && !(pastDue && !licenseActive) ? (
          <Row
            icon={CreditCard}
            title={licenseActive ? T.manage : T.viewPlans}
            subtitle={SETTINGS_STRINGS.common.onLuLabs}
            chevron={false}
            onPress={() => void openLink(licenseActive ? LINKS.account : LINKS.pricing)}
            risk="paid" testid="m-account-manage"
            el="E2.9"
          />
        ) : null}
        {links && licenseActive ? (
          <Row icon={ExternalLink} title={T.addCredits} subtitle={SETTINGS_STRINGS.common.onLuLabs} chevron={false} onPress={() => void openLink(LINKS.pricing)} risk="paid" testid="m-account-buy" el="E2.9" />
        ) : null}
        {/* Round 17, store switch purchase 'in-app' (iOS, in no preset): credits through the store of the system. Not a link, nothing leaves the app. */}
        {addCredits ? <Row icon={Plus} title={SETTINGS_STRINGS.iap.open} chevron={false} onPress={() => nav.openSheet('settings-add-credits')} testid="m-account-add-credits" /> : null}
        <Row icon={Brain} title={T.syncMemories} subtitle={T.syncMemoriesSub} onPress={() => nav.push('/settings/memory')} testid="m-account-sync-memories" el="E2.11" />
        <Row icon={MessagesSquare} title={T.chatsStayHere} subtitle={policy.remoteDesktop ? T.chatsStayHereSubRemote : T.chatsStayHereSub} chevron={false} testid="m-account-chats-stay" />
        <Row icon={MessageSquareText} title={T.contentPolicy} onPress={() => nav.push('/settings/content-policy')} testid="m-account-content-policy" el="E2.12" />
      </ListGroup>

      {/* API keys are made on the account page of the website. A build that may not lead there does not speak of them. */}
      {policy.externalLinks === 'all' ? (
        <ListGroup title={T.apiKeysTitle}>
          <Row title={T.apiKeysText} />
          {links ? <Row icon={ExternalLink} title={T.openAccount} subtitle={SETTINGS_STRINGS.common.onLuLabs} chevron={false} onPress={() => void openLink(LINKS.account)} risk="leaves-app" testid="m-account-api-keys" el="E2.13" /> : null}
        </ListGroup>
      ) : null}

      <ListGroup>
        <Row
          icon={RefreshCw}
          title={T.refresh}
          chevron={false}
          end={refreshing ? <Spinner label={T.checking} /> : undefined}
          onPress={() => {
            if (refreshing) return
            setRefreshing(true)
            void refreshAccount().finally(() => setRefreshing(false))
          }}
          testid="m-account-refresh"
        />
        <Row icon={LogOut} title={T.signOut} danger chevron={false} disabled={signingOut} onPress={() => void askSignOut()} risk="destructive" testid="m-account-signout" el="E2.14" />
      </ListGroup>

      {policy.accountDeletion ? (
        <ListGroup>
          <Row icon={UserRoundX} title={T.deleteRow} subtitle={T.deleteRowSub} danger onPress={() => nav.openSheet('settings-delete-account')} risk="destructive" testid="m-account-delete" />
        </ListGroup>
      ) : null}
    </>
  )
}

export default function AccountPage() {
  const status = useCloudAuthStore((s) => s.status)
  const user = useCloudAuthStore((s) => s.user)
  const state = status === 'probing' ? 'loading' : status === 'signed-in' && user ? 'signed-in' : 'signed-out'
  return (
    <Page title={T.title} screen="account" needsNetwork>
      <div data-testid="m-account-state" data-state={state}>
        {status === 'probing' ? (
          <Block lead testid="m-account-checking">
            <Progress label={T.checking} detail={T.checking} />
          </Block>
        ) : status === 'signed-in' && user ? (
          <SignedIn />
        ) : (
          <SignedOut />
        )}
      </div>
    </Page>
  )
}
