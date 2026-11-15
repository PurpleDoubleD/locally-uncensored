/**
 * Voice over remote in a chat with the computer (GitHub #212).
 *
 * The microphone in the composer knows two ways:
 *
 *   hold   push to talk. The take runs while the finger is on the microphone
 *          and is sent when it lifts.
 *   tap    hands free. LU listens, hears the end of a sentence by itself
 *          (remote/remoteVoice.ts, nextTurn), sends it, reads the answer aloud
 *          and listens again, until End or a long silence.
 *
 * The computer writes the take down (remote_voice.rs), the text goes into the
 * chat like a typed message. The answer is read with the voice of this phone
 * and the voice the user picked in Settings, Voice; a phone without a voice
 * asks the computer to speak it. Whether the answer is read at all is the one
 * switch in Settings, Voice ("Voice with your computer").
 *
 * While a turn runs, the text field gives its place to one line: the level of
 * the microphone, what happens, and End. Nothing else is added to the page.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Volume2 } from 'lucide-react'
import { createAudioRecorder, playNeuralAudio, stopNeuralAudio, type AudioRecorder } from '../../../../api/voice'
import { startLevelMeter, startRecorderWithStream, voiceLevel, type LevelMeter } from '../../../../hooks/useVoice'
import { systemVoiceFallbackAllowed } from '../../../../lib/mobile-prefs'
import { useVoiceStore } from '../../../../stores/voiceStore'
import { listPhoneVoices, speakOnDevice, stopDeviceSpeech } from '../../../lib/speech'
import {
  getComputerVoice,
  MIN_TAKE_MS,
  nextTurn,
  pressKind,
  speakableText,
  speakOnComputer,
  speechPieces,
  startTurn,
  transcribeOnComputer,
  VoiceError,
  type ComputerVoice,
  type TurnState,
} from '../../../remote/remoteVoice'
import type { DesktopChannel } from '../../../remote/remoteClientStore'
import { REMOTE_STRINGS } from '../../../strings/remote'
import { Icon, Spinner, toast, type ComposerMicHold } from '../../../ui'
import { LevelBars, useClock } from '../../chat/parts/ComposerParts'
import { readingLanguage } from '../../chat/parts/voice-pref'
import { useMobilePrefs } from '../../settings/parts/prefs'

const S = REMOTE_STRINGS.voice

export type VoicePhase = 'off' | 'recording' | 'sending' | 'waiting' | 'speaking'
export type VoiceMode = 'hold' | 'free'

export interface RemoteVoiceOptions {
  /** The sealed channel to the computer, or null: then there is no microphone. */
  channel: () => DesktopChannel | null
  /** The computer offers voice (feature `voice`) and the chat can be written to. */
  ready: boolean
  /** Put the text into the chat as a message. False when it could not be sent; the page says why. */
  send: (text: string) => boolean | Promise<boolean>
  /** An answer is being written. */
  busy: boolean
  /** The last answer of the chat, to read the new one aloud. */
  lastAnswer: { id: string; text: string } | null
}

export interface RemoteVoice {
  phase: VoicePhase
  mode: VoiceMode | null
  since: number | null
  /** For the composer: undefined while the computer offers no voice. */
  micHold: ComposerMicHold | undefined
  /** For the composer's microphone slot. */
  dictation: 'recording' | 'transcribing' | undefined
  end: () => void
  /** Stop reading and listen (hands free) or stop (push to talk). */
  interrupt: () => void
}

/** How often hands free reads the level. The meter itself measures every 90 ms (useVoice.ts). */
const TURN_EVERY_MS = 90
/** The status of the computer is asked again after this long. */
const VOICE_STATUS_MS = 30_000

interface Run {
  token: number
  recorder: AudioRecorder | null
  meter: LevelMeter | null
  starting: Promise<boolean> | null
  downAt: number
  startAt: number
  /** The finger lifted before the recorder was ready: what it decided. */
  pendingUp: 'tap' | 'hold' | null
  turn: TurnState | null
  timer: number | null
  abort: AbortController | null
  answerBefore: string | null
  computer: { at: number; voice: ComputerVoice } | null
}

function microphoneMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return S.micDenied
  return S.noMic
}

export function useRemoteVoice(options: RemoteVoiceOptions): RemoteVoice {
  const [phase, setPhase] = useState<VoicePhase>('off')
  const [mode, setMode] = useState<VoiceMode | null>(null)
  const [since, setSince] = useState<number | null>(null)
  const live = useRef(options)
  live.current = options
  const modeRef = useRef<VoiceMode | null>(null)
  const run = useRef<Run>({ token: 0, recorder: null, meter: null, starting: null, downAt: 0, startAt: 0, pendingUp: null, turn: null, timer: null, abort: null, answerBefore: null, computer: null })

  const setModeBoth = (next: VoiceMode | null) => {
    modeRef.current = next
    setMode(next)
  }

  const stopListening = () => {
    const r = run.current
    if (r.timer !== null) window.clearInterval(r.timer)
    r.timer = null
    r.turn = null
    try {
      r.meter?.stop()
    } catch {
      /* the meter goes anyway */
    }
    r.meter = null
  }

  const end = useCallback(() => {
    const r = run.current
    r.token += 1
    stopListening()
    r.abort?.abort()
    r.abort = null
    const recorder = r.recorder
    r.recorder = null
    r.starting = null
    r.pendingUp = null
    if (recorder) void recorder.stop().catch(() => {})
    void stopDeviceSpeech()
    stopNeuralAudio()
    setPhase('off')
    setModeBoth(null)
    setSince(null)
  }, [])

  useEffect(() => end, [end])

  /** What the computer can do, asked at most every 30 s. */
  const computer = async (ch: DesktopChannel): Promise<ComputerVoice> => {
    const r = run.current
    if (r.computer && Date.now() - r.computer.at < VOICE_STATUS_MS) return r.computer.voice
    const voice = await getComputerVoice(ch)
    r.computer = { at: Date.now(), voice }
    return voice
  }

  // Ask early, so the first press does not wait for it.
  useEffect(() => {
    if (!options.ready) return
    const ch = options.channel()
    if (ch) void computer(ch).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.ready])

  const fail = (message: string) => {
    end()
    toast(message, { tone: 'error', testid: 'm-remote-voice-failed' })
  }

  /** Start a take. Hands free also starts listening for the end of a sentence. */
  const startTake = (token: number): Promise<boolean> => {
    const r = run.current
    const recorder = createAudioRecorder()
    const starting = (async () => {
      let stream: MediaStream | null
      try {
        stream = await startRecorderWithStream(recorder)
      } catch (err) {
        if (token === r.token) fail(microphoneMessage(err))
        return false
      }
      if (token !== r.token) {
        void recorder.stop().catch(() => {})
        return false
      }
      r.recorder = recorder
      r.meter = stream ? startLevelMeter(stream) : null
      r.startAt = Date.now()
      setSince(r.startAt)
      setPhase('recording')
      return true
    })()
    r.starting = starting
    return starting
  }

  const listenFree = (token: number) => {
    const r = run.current
    r.turn = startTurn(Date.now())
    if (r.timer !== null) window.clearInterval(r.timer)
    r.timer = window.setInterval(() => {
      if (token !== r.token || !r.turn) return
      const { state, event } = nextTurn(r.turn, voiceLevel(), Date.now())
      r.turn = state
      if (event === 'end') void finishTake(token)
      else if (event === 'give-up') {
        end()
        toast(S.gaveUp, { testid: 'm-remote-voice-gave-up' })
      }
    }, TURN_EVERY_MS)
  }

  /** Hands free: listen for the next sentence. */
  const listenAgain = async (token: number) => {
    if (token !== run.current.token) return
    if (await startTake(token)) listenFree(token)
  }

  const finishTake = async (token: number) => {
    const r = run.current
    if (token !== r.token) return
    const recorder = r.recorder
    r.recorder = null
    stopListening()
    if (!recorder) return
    const free = modeRef.current === 'free'
    const heard = free ? true : Date.now() - r.startAt >= MIN_TAKE_MS
    const blob = await recorder.stop().catch(() => null)
    if (token !== r.token) return
    if (!heard || !blob || blob.size <= 44) {
      if (free) return void listenAgain(token)
      end()
      toast(S.nothingHeard, { testid: 'm-remote-voice-nothing' })
      return
    }
    setPhase('sending')
    const ch = live.current.channel()
    if (!ch) return fail(S.notConnected)
    const abort = new AbortController()
    r.abort = abort
    let text: string
    try {
      text = await transcribeOnComputer(ch, new Uint8Array(await blob.arrayBuffer()), abort.signal)
    } catch (err) {
      if (token !== r.token || (err instanceof VoiceError && err.code === 'aborted')) return
      // The computer may have changed: ask it again next time.
      r.computer = null
      return fail(err instanceof Error ? err.message : String(err))
    } finally {
      if (r.abort === abort) r.abort = null
    }
    if (token !== r.token) return
    if (!text) {
      if (free) return void listenAgain(token)
      end()
      toast(S.nothingHeard, { testid: 'm-remote-voice-nothing' })
      return
    }
    r.answerBefore = live.current.lastAnswer?.id ?? null
    if (!(await live.current.send(text))) {
      end()
      return
    }
    if (token !== r.token) return
    setPhase('waiting')
  }

  const afterAnswer = (token: number) => {
    if (token !== run.current.token) return
    if (modeRef.current === 'free') void listenAgain(token)
    else end()
  }

  const speakAnswer = async (token: number, answer: string) => {
    const words = speakableText(answer)
    if (!useMobilePrefs.getState().remoteVoiceReadAloud || !words) return afterAnswer(token)
    setPhase('speaking')
    try {
      const phone = await listPhoneVoices()
      if (token !== run.current.token) return
      if (phone.source !== 'none' && systemVoiceFallbackAllowed()) {
        const v = useVoiceStore.getState()
        await speakOnDevice(words, { voiceId: v.ttsVoice || undefined, rate: v.ttsRate, pitch: v.ttsPitch, lang: readingLanguage(words, navigator.language) })
      } else {
        const ch = live.current.channel()
        if (!ch) return fail(S.notConnected)
        const can = await computer(ch)
        if (!can.speak) return afterAnswer(token)
        const pieces = speechPieces(words, can.maxSpeakChars)
        // The next piece is fetched while this one plays.
        let next: Promise<Uint8Array> | null = pieces.length ? speakOnComputer(ch, pieces[0]) : null
        for (let i = 0; i < pieces.length && next; i++) {
          const wav = await next
          if (token !== run.current.token) return
          next = i + 1 < pieces.length ? speakOnComputer(ch, pieces[i + 1]) : null
          await playNeuralAudio(URL.createObjectURL(new Blob([wav as BlobPart], { type: 'audio/wav' })))
          if (token !== run.current.token) return
        }
      }
    } catch {
      if (token !== run.current.token) return
      toast(S.speakFailed, { testid: 'm-remote-voice-speak-failed' })
    }
    afterAnswer(token)
  }

  // The answer is there when the chat is no longer busy and its last answer is a new one.
  const answerId = options.lastAnswer?.id ?? null
  const answerText = options.lastAnswer?.text ?? ''
  useEffect(() => {
    if (phase !== 'waiting' || options.busy) return
    if (!answerId || answerId === run.current.answerBefore) return
    void speakAnswer(run.current.token, answerText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, options.busy, answerId, answerText])

  const onDown = async () => {
    const r = run.current
    // A press while the answer is read: the reading stops and a new take starts (barge in).
    if (phase === 'speaking' || phase === 'waiting') {
      r.token += 1
      r.abort?.abort()
      void stopDeviceSpeech()
      stopNeuralAudio()
    } else if (phase === 'recording' && modeRef.current === 'free') {
      // Hands free, a tap while it listens: the sentence is done, send it now.
      return void finishTake(r.token)
    } else if (phase !== 'off') {
      return
    }
    const ch = live.current.channel()
    if (!ch) return fail(S.notConnected)
    const token = r.token
    r.downAt = Date.now()
    r.pendingUp = null
    setModeBoth(null)
    try {
      const can = await computer(ch)
      if (token !== r.token) return
      if (!can.listen) return fail(can.why || S.notConnected)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    const started = await startTake(token)
    if (!started || token !== r.token) return
    // The finger may have lifted while the recorder started.
    if (r.pendingUp) decide(token, r.pendingUp)
  }

  const decide = (token: number, kind: 'tap' | 'hold') => {
    const r = run.current
    r.pendingUp = null
    if (kind === 'hold') {
      setModeBoth('hold')
      void finishTake(token)
    } else {
      setModeBoth('free')
      listenFree(token)
    }
  }

  const onUp = () => {
    const r = run.current
    const kind = pressKind(r.downAt, Date.now())
    if (modeRef.current === 'free') return
    if (!r.recorder) {
      r.pendingUp = kind
      return
    }
    decide(r.token, kind)
  }

  const interrupt = () => {
    const r = run.current
    r.token += 1
    void stopDeviceSpeech()
    stopNeuralAudio()
    if (modeRef.current === 'free') void listenAgain(r.token)
    else end()
  }

  return {
    phase,
    mode,
    since,
    micHold: options.ready ? { onDown: () => void onDown(), onUp, label: S.mic } : undefined,
    dictation: phase === 'recording' ? 'recording' : phase === 'sending' ? 'transcribing' : undefined,
    end,
    interrupt,
  }
}

function Clock({ since }: { since: number }) {
  return <span className="m-rvoice-clock">{useClock(since)}</span>
}

/** The line in place of the text field while a voice turn runs. Null when nothing runs. */
export function RemoteVoiceLine({ voice }: { voice: RemoteVoice }): ReactNode {
  const { phase, mode, since } = voice
  if (phase === 'off') return null
  // While the finger is on the microphone, letting go ends the take: no End there.
  const endButton = phase === 'recording' && mode !== 'free' ? null : (
    <button type="button" className="m-rvoice-end" aria-label={S.endName} data-testid="m-remote-voice-end" onClick={voice.end}>
      {S.end}
    </button>
  )
  if (phase === 'recording' && since !== null) {
    return (
      <div className="m-rvoice" role="status" data-testid="m-remote-voice" data-state="recording" data-m-mode={mode ?? 'pending'}>
        <LevelBars since={since} />
        <Clock since={since} />
        <span className="m-rvoice-hint">{mode === 'free' ? S.listening : S.talk}</span>
        {endButton}
      </div>
    )
  }
  if (phase === 'speaking') {
    return (
      <div className="m-rvoice" data-testid="m-remote-voice" data-state="speaking" data-m-mode={mode ?? undefined}>
        <button type="button" className="m-rvoice-tap" onClick={voice.interrupt} data-testid="m-remote-voice-interrupt">
          <Icon icon={Volume2} small />
          <span className="m-rvoice-hint">{S.speaking}</span>
          <span className="m-rvoice-sub">{S.interrupt}</span>
        </button>
        {endButton}
      </div>
    )
  }
  const label = phase === 'sending' ? S.sending : S.waiting
  return (
    <div className="m-rvoice" role="status" data-testid="m-remote-voice" data-state={phase} data-m-mode={mode ?? undefined}>
      <Spinner label={label} />
      <span className="m-rvoice-hint">{label}</span>
      {endButton}
    </div>
  )
}
