/**
 * E11 Voice. Route /settings/voice, page, strand 5 (Account, cloud, settings).
 *
 * Dictation and the Cloud voices run on LU Cloud. The page picks the voice,
 * plays a preview, and switches reading aloud. A Cloud preview is a real
 * request and uses credits like any other; the page says so.
 *
 * The voice of the phone itself comes from ONE door, src/mobile/lib/speech.ts
 * (the WebView, else the native bridge, else none). The page lists what that
 * door lists, lets every voice be heard, and says "no voice installed" only
 * when the door answered 'none'. The pick is saved as `ttsVoice` in the voice
 * store, which is what reading aloud in the chat looks up.
 *
 * There is no switch for dictation: the logic layer shows the microphone
 * whenever Cloud voice is usable (hooks/useVoice.ts), so a switch here would
 * switch nothing. The row says On or Off and, when it is off, exactly why and
 * what to do (parts/voice-state.ts).
 *
 * "Use the system voice when Cloud is off" is saved under
 * `lu-mobile-settings-prefs` (field `systemVoiceFallback`). Whoever reads
 * aloud asks `systemVoiceFallbackAllowed()` from src/lib/mobile-prefs.ts
 * before it falls back to the voice of the phone.
 */
import { useEffect, useRef, useState } from 'react'
import { ExternalLink, LogIn, Mic, Play, Square } from 'lucide-react'
import { ensureAiConsent } from './parts/policy'
import { playNeuralAudio, stopNeuralAudio, synthesizeCloud } from '../../../api/voice'
import { deriveCloudAvailable, useCloudAuthStore } from '../../../stores/cloudAuthStore'
import { useVoiceStore } from '../../../stores/voiceStore'
import { listPhoneVoices, sortVoicesFor, sourceHasPitch, speakOnDevice, stopDeviceSpeech, type PhoneVoices } from '../../lib/speech'
import { nav } from '../../nav'
import { isOnline, openSystemSettings } from '../../platform'
import { useCloudOnline } from '../../resilience/useOnline'
import { SETTINGS_STRINGS } from '../../strings/settings'
import { Button, IconButton, ListGroup, Notice, Page, Row, Slider, toast } from '../../ui'
import { Block, Hint } from './parts/layout'
import { useMobilePrefs } from './parts/prefs'
import { dictationState, type DictationState } from './parts/voice-state'
import { CLOUD_VOICES, pickedCloudVoice, previewFailure } from './parts/voices'

const T = SETTINGS_STRINGS.voice

/** Read when shown: some of these texts have a wording per store build (strings/settings.ts). */
function dictationText(state: DictationState): string {
  const texts: Record<DictationState, string> = {
    ready: T.dictationReady,
    checking: T.dictationChecking,
    blocked: T.dictationBlocked,
    'signed-out': T.dictationSignedOut,
    'no-plan': T.dictationNoPlan,
    offline: T.dictationOffline,
  }
  return texts[state]
}

/** Whether the system refused the microphone for LU. null while unknown or not answerable. */
function useMicDenied(): boolean {
  const [denied, setDenied] = useState(false)
  useEffect(() => {
    let alive = true
    let status: PermissionStatus | null = null
    const read = () => {
      if (alive && status) setDenied(status.state === 'denied')
    }
    const permissions = typeof navigator !== 'undefined' ? navigator.permissions : undefined
    if (!permissions?.query) return
    permissions
      .query({ name: 'microphone' as PermissionName })
      .then((result) => {
        status = result
        read()
        result.addEventListener('change', read)
      })
      .catch(() => {
        /* this WebView cannot say: no notice */
      })
    return () => {
      alive = false
      status?.removeEventListener('change', read)
    }
  }, [])
  return denied
}

/** The voices of this phone from the one door. null while it is being asked. */
function usePhoneVoices(): { phone: PhoneVoices | null; lookAgain: () => void } {
  const [phone, setPhone] = useState<PhoneVoices | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    let alive = true
    void listPhoneVoices({ fresh: round > 0 }).then((found) => {
      if (alive) setPhone(found)
    })
    return () => {
      alive = false
    }
  }, [round])
  return {
    phone,
    lookAgain: () => {
      setPhone(null)
      setRound((n) => n + 1)
    },
  }
}

/** The preview sentence is English. Without a picked voice the phone is told so, or a German phone reads it with its German voice. */
const PREVIEW_LANG = 'en-US'

/** So many voices of the language of the phone are listed before "Show all". */
const NEAR_VOICES_MAX = 6

export default function VoicePage() {
  const status = useCloudAuthStore((s) => s.status)
  const signedIn = useCloudAuthStore((s) => s.status === 'signed-in' && !!s.user)
  const cloudUsable = useCloudAuthStore(deriveCloudAvailable)
  const ttsEnabled = useVoiceStore((s) => s.ttsEnabled)
  const autoRead = useVoiceStore((s) => s.autoReadAloud)
  const savedVoice = useVoiceStore((s) => s.cloudTtsVoice)
  const rate = useVoiceStore((s) => s.ttsRate)
  const pitch = useVoiceStore((s) => s.ttsPitch)
  const update = useVoiceStore((s) => s.updateVoiceSettings)
  const systemFallback = useMobilePrefs((s) => s.systemVoiceFallback)
  const remoteReadAloud = useMobilePrefs((s) => s.remoteVoiceReadAloud)
  const setPref = useMobilePrefs((s) => s.setPref)
  const micDenied = useMicDenied()
  const online = useCloudOnline()
  const savedPhoneVoice = useVoiceStore((s) => s.ttsVoice)
  const { phone, lookAgain } = usePhoneVoices()
  const [allVoices, setAllVoices] = useState(false)
  const hasPhoneVoice = !!phone && phone.source !== 'none'
  const noVoiceAtAll = !!phone && phone.source === 'none' && !cloudUsable
  const voice = pickedCloudVoice(savedVoice)

  /** The voice whose preview is loading or playing, 'system' for the system voice. */
  const [playing, setPlaying] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [phoneFailure, setPhoneFailure] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const stop = () => {
    abort.current?.abort()
    abort.current = null
    stopNeuralAudio()
    void stopDeviceSpeech()
    setPlaying(null)
    setLoading(false)
  }
  // Leaving the page ends a preview.
  useEffect(() => stop, [])

  const preview = async (id: string) => {
    stop()
    setFailure(null)
    if (!isOnline()) {
      setFailure(T.previewOffline)
      return
    }
    // The preview is a request to LU Cloud like every read-aloud: same consent (M1).
    if (!(await ensureAiConsent())) {
      setFailure(T.previewNeedsConsent)
      return
    }
    const controller = new AbortController()
    abort.current = controller
    setPlaying(id)
    setLoading(true)
    try {
      const url = await synthesizeCloud(T.previewText, id, controller.signal)
      if (controller.signal.aborted) return
      setLoading(false)
      await playNeuralAudio(url)
    } catch (err) {
      if (controller.signal.aborted) return
      const why = previewFailure(err, isOnline())
      setFailure(why === 'offline' ? T.previewOffline : why === 'no-credits' ? T.previewNoCredits : T.previewFailed)
    } finally {
      if (abort.current === controller) {
        abort.current = null
        setPlaying(null)
        setLoading(false)
      }
    }
  }

  /** Hear a voice of this phone. `id` is the voice, '' the default of the phone. */
  const previewPhone = async (id: string) => {
    stop()
    setPhoneFailure(null)
    const key = `phone:${id}`
    setPlaying(key)
    try {
      const result = await speakOnDevice(T.previewText, { voiceId: id || undefined, rate, pitch, lang: PREVIEW_LANG })
      if (!result.spoken) setPhoneFailure(T.phoneNoneText)
    } catch {
      setPhoneFailure(T.phoneFailed)
    } finally {
      setPlaying((current) => (current === key ? null : current))
    }
  }

  const openSettings = async () => {
    const result = await openSystemSettings()
    if (!result.opened) toast(T.systemSettingsFailed, { tone: 'error', testid: 'system-settings-failed' })
  }

  const cloudState = status === 'probing' ? 'probing' : !signedIn ? 'signed-out' : cloudUsable ? 'ready' : 'no-plan'
  const dictation = dictationState({ probing: status === 'probing', signedIn, cloudUsable, micDenied, online })

  // The voices of this phone: those of its language first, the rest behind "Show all". The picked one is always in sight.
  const language = typeof navigator !== 'undefined' ? navigator.language : ''
  const sorted = sortVoicesFor(phone?.voices ?? [], language)
  const near = sorted.near.length > 0 ? sorted.near.slice(0, NEAR_VOICES_MAX) : (phone?.voices ?? []).slice(0, NEAR_VOICES_MAX)
  // A saved voice this phone no longer has reads as the default, which is what then speaks.
  const pickedPhone = (phone?.voices ?? []).some((v) => v.id === savedPhoneVoice) ? savedPhoneVoice : ''
  const total = phone?.voices.length ?? 0
  const shown = allVoices ? (phone?.voices ?? []) : near.some((v) => v.id === pickedPhone) || !pickedPhone ? near : [...near, ...(phone?.voices ?? []).filter((v) => v.id === pickedPhone)]
  const phoneKey = `phone:${pickedPhone}`

  return (
    <Page title={T.title} screen="settings-voice">
      <div data-testid="m-settings-voice-state" data-state={cloudState}>
        <Block lead>
          <Hint testid="m-settings-voice-intro">{!phone ? T.intro : hasPhoneVoice ? T.introPhoneVoice : T.introCloudOnly}</Hint>
        </Block>

        {cloudState === 'signed-out' ? (
          <Notice
            title={hasPhoneVoice ? T.signedOutTitle : T.signedOutTitleNoVoice}
            testid="m-settings-voice-signed-out"
            actions={
              <Button compact icon={LogIn} onPress={() => nav.push('/settings/account')} testid="m-settings-voice-signin">
                {SETTINGS_STRINGS.common.signIn}
              </Button>
            }
          >
            {hasPhoneVoice ? T.signedOutText : T.signedOutTextNoVoice}
          </Notice>
        ) : null}
        {cloudState === 'no-plan' ? (
          <Notice
            title={T.noPlanTitle}
            testid="m-settings-voice-no-plan"
            actions={
              <Button compact icon={ExternalLink} onPress={() => nav.push('/cloud')} risk="paid" testid="m-settings-voice-plans">
                {T.seePlans}
              </Button>
            }
          >
            {T.noPlanText}
          </Notice>
        ) : null}
        {micDenied ? (
          <Notice
            variant="warn"
            title={T.micDeniedTitle}
            testid="m-settings-voice-mic-denied"
            actions={
              <Button compact onPress={() => void openSettings()} risk="leaves-app" testid="m-settings-voice-open-system">
                {T.openSystemSettings}
              </Button>
            }
          >
            {T.micDeniedText}
          </Notice>
        ) : null}

        <ListGroup title={T.stateGroup}>
          <Row
            icon={Mic}
            title={T.dictation}
            subtitle={dictationText(dictation)}
            value={dictation === 'checking' ? undefined : dictation === 'ready' ? T.dictationOn : T.dictationOff}
            testid="m-settings-voice-dictation"
          />
          <Row
            title={T.readAloud}
            subtitle={T.readAloudSub}
            disabled={noVoiceAtAll}
            disabledReason={T.readAloudNoVoice}
            switch={{ checked: ttsEnabled && !noVoiceAtAll, onChange: (next) => update(next ? { ttsEnabled: true } : { ttsEnabled: false, autoReadAloud: false }) }}
            testid="m-settings-voice-read-aloud"
          />
          <Row
            title={T.auto}
            subtitle={T.autoSub}
            disabled={!ttsEnabled || noVoiceAtAll}
            disabledReason={noVoiceAtAll ? T.readAloudNoVoice : T.readAloudOff}
            switch={{ checked: autoRead && ttsEnabled && !noVoiceAtAll, onChange: (next) => update({ autoReadAloud: next }) }}
            testid="m-settings-voice-auto"
            el="E11.4"
          />
        </ListGroup>

        <div data-testid="m-settings-voice-dictation-state" data-state={dictation}>
          <Block>
            <Hint>{T.dictationWhy}</Hint>
          </Block>
        </div>

        <div data-testid="m-settings-voice-phone" data-source={phone ? phone.source : 'looking'}>
          {!phone ? (
            <Block>
              <Hint testid="m-settings-voice-phone-looking">{T.phoneLooking}</Hint>
            </Block>
          ) : null}
          {phone && !hasPhoneVoice ? (
            <Notice
              title={T.phoneNoneTitle}
              testid="m-settings-voice-phone-none"
              actions={
                <Button compact onPress={lookAgain} testid="m-settings-voice-phone-again">
                  {T.phoneLookAgain}
                </Button>
              }
            >
              {T.phoneNoneText}
            </Notice>
          ) : null}
          {phone && hasPhoneVoice ? (
            <>
              <ListGroup title={T.phoneGroup} role="radiogroup" label={T.phoneGroup} testid="m-settings-voice-phone-list">
                <Row
                  title={T.phoneDefault}
                  radio={{ checked: pickedPhone === '', onSelect: () => update({ ttsVoice: '' }) }}
                  testid="m-settings-voice-phone-pick-default"
                  trailing={
                    <IconButton
                      icon={playing === 'phone:' ? Square : Play}
                      label={playing === 'phone:' ? T.stopPreview : T.previewOf(T.phoneDefault)}
                      onPress={() => (playing === 'phone:' ? stop() : void previewPhone(''))}
                      testid="m-settings-voice-phone-preview-default"
                    />
                  }
                />
                {shown.map((v, index) => {
                  const key = `phone:${v.id}`
                  const isPlaying = playing === key
                  return (
                    <Row
                      key={v.id}
                      id={v.id}
                      title={v.name}
                      subtitle={[v.lang, v.local ? '' : T.phoneVoiceOnline].filter(Boolean).join(', ') || undefined}
                      radio={{ checked: pickedPhone === v.id, onSelect: () => update({ ttsVoice: v.id }) }}
                      testid={`m-settings-voice-phone-pick-${index}`}
                      trailing={
                        <IconButton
                          icon={isPlaying ? Square : Play}
                          label={isPlaying ? T.stopPreview : T.previewOf(v.name)}
                          onPress={() => (isPlaying ? stop() : void previewPhone(v.id))}
                          testid={`m-settings-voice-phone-preview-${index}`}
                        />
                      }
                    />
                  )
                })}
              </ListGroup>
              <Block>
                {total > near.length ? (
                  <Button block variant="quiet" onPress={() => setAllVoices((all) => !all)} testid="m-settings-voice-phone-all">
                    {allVoices ? T.phoneShowFewer : T.phoneShowAll(total)}
                  </Button>
                ) : null}
              </Block>
              <ListGroup title={T.systemGroup}>
                <Row
                  title={T.systemVoice}
                  subtitle={T.systemVoiceSub}
                  switch={{ checked: systemFallback, onChange: (next) => setPref('systemVoiceFallback', next) }}
                  testid="m-settings-voice-system"
                  el="E11.5"
                />
              </ListGroup>
              <Block lead>
                <Slider label={T.speed} value={rate} onChange={(value) => update({ ttsRate: value })} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}x`} testid="m-settings-voice-speed" el="E11.2" />
                {/* The native voice has no pitch: a slider that moves nothing is not shown. */}
                {sourceHasPitch(phone.source) ? (
                  <Slider label={T.pitch} value={pitch} onChange={(value) => update({ ttsPitch: value })} min={0.5} max={2} step={0.1} format={(v) => v.toFixed(1)} testid="m-settings-voice-pitch" el="E11.3" />
                ) : null}
                <Hint strong testid="m-settings-voice-system-state">
                  {systemFallback ? T.systemVoiceOn : T.systemVoiceOff}
                </Hint>
                <Hint>{sourceHasPitch(phone.source) ? T.systemVoiceNote : T.systemVoiceNoteSpeed}</Hint>
                <Button block icon={playing === phoneKey ? Square : Play} onPress={() => (playing === phoneKey ? stop() : void previewPhone(pickedPhone))} testid="m-settings-voice-test-system">
                  {playing === phoneKey ? T.stop : T.testSystem}
                </Button>
              </Block>
            </>
          ) : null}
          {phoneFailure ? (
            <Notice variant="error" testid="m-settings-voice-phone-failed">
              {phoneFailure}
            </Notice>
          ) : null}
        </div>

        <ListGroup title={T.voiceGroup} role="radiogroup" label={T.voiceGroup} testid="m-settings-voice-list" el="E11.1">
          {CLOUD_VOICES.map((v) => {
            const isPlaying = playing === v.id
            return (
              <Row
                key={v.id}
                title={v.label}
                radio={{ checked: voice === v.id, onSelect: () => update({ cloudTtsVoice: v.id }) }}
                testid={`m-settings-voice-pick-${v.id}`}
                trailing={
                  <IconButton
                    icon={isPlaying ? Square : Play}
                    label={isPlaying ? T.stopPreview : T.previewOf(v.label)}
                    disabled={!cloudUsable}
                    onPress={() => (isPlaying ? stop() : void preview(v.id))}
                    risk="paid" testid={`m-settings-voice-preview-${v.id}`}
                  />
                }
              />
            )
          })}
        </ListGroup>
        <Block>
          <Hint testid="m-settings-voice-cost">{T.cost}</Hint>
          {loading ? (
            <Hint strong testid="m-settings-voice-loading">
              {T.previewLoading}
            </Hint>
          ) : null}
          {failure ? (
            <Notice variant="error" testid="m-settings-voice-failed">
              {failure}
            </Notice>
          ) : null}
          <Button
            block
            icon={playing === voice ? Square : Play}
            disabled={!cloudUsable}
            disabledReason={T.voiceNeedsCloud}
            onPress={() => (playing === voice ? stop() : void preview(voice))}
            risk="paid" testid="m-settings-voice-test"
          >
            {playing === voice ? T.stop : T.test}
          </Button>
        </Block>

        <ListGroup title={T.remoteGroup} testid="m-settings-voice-remote">
          <Row
            title={T.remoteReadAloud}
            subtitle={T.remoteReadAloudSub}
            switch={{ checked: remoteReadAloud, onChange: (next) => setPref('remoteVoiceReadAloud', next) }}
            testid="m-settings-voice-remote-read"
          />
        </ListGroup>
        <Block>
          <Hint testid="m-settings-voice-remote-how">{T.remoteHow}</Hint>
        </Block>
      </div>
    </Page>
  )
}
