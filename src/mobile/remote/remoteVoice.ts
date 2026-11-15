/**
 * Voice over remote (GitHub #212): talk to LU on the computer and hear the answer.
 *
 * The phone records one take at a time, the computer writes it down with its
 * own speech recognition (src-tauri/src/commands/remote_voice.rs), and the text
 * goes into the chat like a typed message. The answer is read with the voice
 * of this phone; a phone without one asks the computer to speak it.
 *
 *   GET  /remote-api/voice             what the computer can do right now
 *   POST /remote-api/voice/transcribe  a WAV take, answers { text }
 *   POST /remote-api/voice/speak       { text }, answers a WAV
 *
 * Only inside the sealed channel, like Create and the shared chats. This file
 * holds the calls and the pure parts (when a sentence ended, what of an answer
 * is read aloud); screens/remote/parts/RemoteVoice.tsx drives them.
 */
import type { DesktopChannel } from './remoteClientStore'
import { RemoteError } from './remoteErrors'
import { sealedErrorPinned } from './sealedChannel'

export const FEATURE_VOICE = 'voice'

export const VOICE_PATHS = {
  status: '/remote-api/voice',
  transcribe: '/remote-api/voice/transcribe',
  speak: '/remote-api/voice/speak',
} as const

export const VOICE_TEXT = {
  unreachable: 'The computer did not answer.',
  protocol: 'The computer sent an answer this phone cannot read.',
  tooLong: 'That was too long. Keep a message under two minutes.',
  noListen: 'Speech recognition is not set up on the computer.',
  failed: 'The computer could not write down what you said.',
  tooOld: 'LU on the computer is too old for voice. Update it to 3.1.0 or newer.',
} as const

export interface ComputerVoice {
  /** The computer can write down a take. */
  listen: boolean
  /** The computer can read an answer aloud. */
  speak: boolean
  maxTakeBytes: number
  maxTakeMs: number
  maxSpeakChars: number
  /** The one thing to tell the user when `listen` is false, as the computer said it. */
  why: string | null
}

export type VoiceErrorCode = 'unreachable' | 'too-long' | 'no-listen' | 'no-speak' | 'failed' | 'too-old' | 'protocol' | 'aborted'

export class VoiceError extends Error {
  readonly code: VoiceErrorCode
  constructor(code: VoiceErrorCode, message: string) {
    super(message)
    this.name = 'VoiceError'
    this.code = code
  }
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function count(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** A sentence from the computer, kept short and plain. */
function sentence(v: unknown, max = 300): string {
  if (typeof v !== 'string') return ''
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Pure: the status answer of the computer. Anything missing counts as "cannot". */
export function readComputerVoice(raw: unknown): ComputerVoice {
  const o = rec(raw)
  return {
    listen: o?.listen === true,
    speak: o?.speak === true,
    maxTakeBytes: count(o?.max_take_bytes, 4 * 1024 * 1024),
    maxTakeMs: count(o?.max_take_ms, 120_000),
    maxSpeakChars: count(o?.max_speak_chars, 1500),
    why: sentence(o?.why) || null,
  }
}

/** Pure: an answer that is not 2xx, as what to tell the user. */
export function voiceErrorOf(status: number, body: unknown): VoiceError {
  const o = rec(body)
  const said = sentence(o?.message)
  if (status === 404 || status === 405) return new VoiceError('too-old', VOICE_TEXT.tooOld)
  if (status === 413) return new VoiceError('too-long', said || VOICE_TEXT.tooLong)
  if (status === 409 && o?.error === 'no_listen') return new VoiceError('no-listen', said || VOICE_TEXT.noListen)
  if (status === 409 && o?.error === 'no_speak') return new VoiceError('no-speak', said || VOICE_TEXT.failed)
  if (status === 502) return new VoiceError('failed', said || VOICE_TEXT.failed)
  if (status === 503) return new VoiceError('unreachable', said || VOICE_TEXT.unreachable)
  return new VoiceError('protocol', said || VOICE_TEXT.protocol)
}

function viaTunnel(ch: DesktopChannel): boolean {
  try {
    return new URL(ch.address).protocol === 'https:'
  } catch {
    return false
  }
}

function channelError(err: unknown, ch: DesktopChannel): VoiceError {
  if (err instanceof VoiceError) return err
  if (err instanceof Error && err.name === 'AbortError') return new VoiceError('aborted', 'Stopped.')
  const e = err instanceof RemoteError ? err : sealedErrorPinned(err, viaTunnel(ch))
  if (e.code === 'aborted') return new VoiceError('aborted', 'Stopped.')
  return new VoiceError('unreachable', e.userMessage || VOICE_TEXT.unreachable)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(bin)
}

export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

let callNumber = 0

/** One sealed request with a binary body or answer. */
async function sealedCall(
  ch: DesktopChannel,
  path: string,
  init: { method: 'GET' | 'POST'; contentType?: string; bytes?: Uint8Array; timeoutMs: number; signal?: AbortSignal },
): Promise<{ status: number; bytes: Uint8Array }> {
  callNumber += 1
  const callId = `voice-${Date.now().toString(36)}-${callNumber}`
  const onAbort = () => void ch.invoke('remote_sealed_cancel', { callId }).catch(() => {})
  init.signal?.addEventListener('abort', onAbort, { once: true })
  let answer: { status?: unknown; bodyBase64?: unknown }
  try {
    if (init.signal?.aborted) throw new VoiceError('aborted', 'Stopped.')
    answer = (await ch.invoke('remote_sealed_request', {
      baseUrl: ch.address,
      desktopId: ch.pin.desktopId,
      x25519: ch.pin.x25519,
      path,
      method: init.method,
      headers: { ...(init.contentType ? { 'content-type': init.contentType } : {}), accept: 'application/json, audio/wav' },
      body: null,
      bodyBase64: init.bytes ? bytesToBase64(init.bytes) : null,
      timeoutMs: init.timeoutMs,
      callId,
      deviceName: null,
    })) as { status?: unknown; bodyBase64?: unknown }
  } catch (err) {
    throw channelError(err, ch)
  } finally {
    init.signal?.removeEventListener('abort', onAbort)
  }
  const status = Number(answer?.status)
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(String(answer?.bodyBase64 ?? ''))
  } catch {
    bytes = new Uint8Array()
  }
  return { status: Number.isInteger(status) ? status : 0, bytes }
}

function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/** What the computer can do right now. */
export async function getComputerVoice(ch: DesktopChannel, signal?: AbortSignal): Promise<ComputerVoice> {
  const { status, bytes } = await sealedCall(ch, VOICE_PATHS.status, { method: 'GET', timeoutMs: 15_000, signal })
  if (status < 200 || status >= 300) throw voiceErrorOf(status, jsonOf(bytes))
  return readComputerVoice(jsonOf(bytes))
}

/**
 * The text of a take. The first take after the computer started can wait for
 * its speech recognition to load, hence the long time.
 */
export async function transcribeOnComputer(ch: DesktopChannel, wav: Uint8Array, signal?: AbortSignal): Promise<string> {
  const { status, bytes } = await sealedCall(ch, VOICE_PATHS.transcribe, { method: 'POST', contentType: 'audio/wav', bytes: wav, timeoutMs: 180_000, signal })
  const data = jsonOf(bytes)
  if (status < 200 || status >= 300) throw voiceErrorOf(status, data)
  const text = rec(data)?.text
  if (typeof text !== 'string') throw new VoiceError('protocol', VOICE_TEXT.protocol)
  return text.trim()
}

/** A WAV of `text` in the voice of the computer. */
export async function speakOnComputer(ch: DesktopChannel, text: string, signal?: AbortSignal): Promise<Uint8Array> {
  const body = new TextEncoder().encode(JSON.stringify({ text }))
  const { status, bytes } = await sealedCall(ch, VOICE_PATHS.speak, { method: 'POST', contentType: 'application/json', bytes: body, timeoutMs: 60_000, signal })
  if (status < 200 || status >= 300) throw voiceErrorOf(status, jsonOf(bytes))
  return bytes
}

// ── pure: what of an answer is read aloud ───────────────────────

/**
 * Pure: the words of an answer, without what a voice should not read: code
 * blocks, the thought of a model, links written out, the marks of Markdown.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pure: the text in pieces of at most `max` characters, cut after a sentence where one ends in time. */
export function speechPieces(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const end = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n'))
    const space = window.lastIndexOf(' ')
    const cut = end > max / 3 ? end + 1 : space > max / 3 ? space : max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

// ── pure: when a sentence ended (hands free) ────────────────────

/** Above this level the phone hears speech. The meter's level is 0 to 1 (useVoice.ts, levelFromSamples). */
export const SPEECH_LEVEL = 0.1
/** Below this level it is quiet again. Lower than SPEECH_LEVEL, so a word that fades does not cut the take. */
export const QUIET_LEVEL = 0.05
/** Speech has to last this long to count; a cough or a click does not start a take. */
export const SPEECH_MIN_MS = 250
/** This much quiet after speech ends the sentence. */
export const END_QUIET_MS = 1100
/** Hands free stops listening after this long without anything said. */
export const GIVE_UP_MS = 30_000

export interface TurnState {
  /** When listening started. */
  since: number
  /** When the current run of loud readings started, or null. */
  loudSince: number | null
  /** Speech has been heard in this take. */
  heard: boolean
  /** When the current quiet started after speech, or null. */
  quietSince: number | null
}

export type TurnEvent = 'speech' | 'end' | 'give-up' | null

export function startTurn(now: number): TurnState {
  return { since: now, loudSince: null, heard: false, quietSince: null }
}

/**
 * Pure: one reading of the level. Hands free starts a take only after real
 * speech, ends it after a pause, and gives up after a long silence.
 */
export function nextTurn(state: TurnState, level: number, now: number): { state: TurnState; event: TurnEvent } {
  const l = Number.isFinite(level) ? level : 0
  if (!state.heard) {
    if (l >= SPEECH_LEVEL) {
      const loudSince = state.loudSince ?? now
      if (now - loudSince >= SPEECH_MIN_MS) return { state: { ...state, loudSince, heard: true, quietSince: null }, event: 'speech' }
      return { state: { ...state, loudSince }, event: null }
    }
    const next = { ...state, loudSince: l >= QUIET_LEVEL ? state.loudSince : null }
    if (now - state.since >= GIVE_UP_MS) return { state: next, event: 'give-up' }
    return { state: next, event: null }
  }
  if (l >= QUIET_LEVEL) return { state: { ...state, quietSince: null }, event: null }
  const quietSince = state.quietSince ?? now
  if (now - quietSince >= END_QUIET_MS) return { state: { ...state, quietSince }, event: 'end' }
  return { state: { ...state, quietSince }, event: null }
}

/** Pure: a press shorter than this on the microphone is a tap (hands free), a longer one is push to talk. */
export const HOLD_MS = 300

export function pressKind(downAt: number, upAt: number): 'tap' | 'hold' {
  return upAt - downAt >= HOLD_MS ? 'hold' : 'tap'
}

/** A take shorter than this holds no word and is not sent. */
export const MIN_TAKE_MS = 400
