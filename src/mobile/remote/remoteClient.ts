/**
 * Remote-Client: reine Protokollfunktionen gegen ein Desktop-LU.
 *
 * Gegenstueck zur Handy-Webseite `mobile-client/client.js`, die der Desktop
 * unter `/mobile` ausliefert. Die Protokollbeschreibung steht in
 * `mobile-docs/REMOTE-PROTOKOLL.md`, die Quelle der Wahrheit ist
 * `src-tauri/src/commands/remote.rs`.
 *
 * Diese Datei kennt keinen Store, keine Oberflaeche und kein Tauri. Der
 * Transport wird hereingereicht (`RemoteFetch`), weil die WebView auf dem
 * Handy den Desktop nicht selbst erreichen kann: der Server sendet keine
 * CORS-Kopfzeilen, und Klartext-http ins WLAN ist aus der WebView gesperrt.
 * Auf dem Geraet laeuft der Transport deshalb ueber ein Rust-Kommando, im Test
 * ueber das fetch von Node.
 */

import { THINKING_COMPATIBLE, isPlainTextPlanner, stripNonCanonicalTags } from '../../../mobile-client/personas.js'
import { PASSCODE_LENGTH, classifyHost, normalizePasscode } from './pairingLink'
import {
  RemoteAbortedError,
  RemoteBackendError,
  RemoteConnectionLostError,
  RemoteError,
  RemoteInvalidCodeError,
  RemoteMemoryRevokedError,
  RemoteNotLuError,
  RemotePermissionError,
  RemoteProtocolError,
  RemoteRateLimitedError,
  RemoteSessionExpiredError,
  RemoteTimeoutError,
  RemoteUnreachableError,
} from './remoteErrors'

export * from './remoteErrors'

// ── Transport ────────────────────────────────────────────────────

export interface RemoteFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/**
 * Die eine Naht zum Netz. Absichtlich die Teilmenge von `fetch`, die das
 * Protokoll braucht, damit `globalThis.fetch` ohne Huelle passt und ein
 * Rust-Transport nur diese vier Felder bedienen muss.
 *
 * Vertrag:
 *   - Jeder HTTP-Status wird als Response geliefert, auch 401, 403, 429, 409.
 *   - Geworfen wird nur, wenn keine Antwort zustande kam (Netz, DNS, Abbruch).
 *   - Ein Abbruch ueber `signal` wirft einen Fehler mit `name === 'AbortError'`.
 *   - Die Antwort-Kopfzeilen `x-lu-refreshed-token` und
 *     `x-lu-remote-memory-revoked` muessen lesbar sein, sonst endet jede
 *     Sitzung hart nach 60 Minuten.
 */
export type RemoteFetch = (url: string, init?: RemoteFetchInit) => Promise<Response>

/** Kopfzeile, in der der Server ein verlaengertes Token zurueckgibt. */
export const REFRESH_HEADER = 'x-lu-refreshed-token'
/** Kopfzeile neben dem Status 409, wenn der Desktop die Sitzung gesperrt hat. */
export const MEMORY_REVOKED_HEADER = 'x-lu-remote-memory-revoked'

/** Lebensdauer eines Tokens (remote.rs, JWT_TTL_SECS). */
export const TOKEN_TTL_MS = 60 * 60 * 1000
/** Harte Obergrenze einer Sitzung trotz Verlaengerung (remote.rs, MAX_SESSION_SECS). */
export const MAX_SESSION_MS = 24 * 60 * 60 * 1000
/** Abstand der Lebenszeichen, wie in client.js. */
export const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000
/** Groesste Nachricht, die der Desktop als Spiegelung annimmt (remote.rs, CHAT_EVENT_MAX_CONTENT). */
export const CHAT_EVENT_MAX_BYTES = 100 * 1024
/** Antwortlaenge, die client.js anfordert. */
export const DEFAULT_NUM_PREDICT = 16384

// ── Typen des Protokolls ─────────────────────────────────────────

export interface RemoteHostConfig {
  /** Modell, das am Desktop beim Freigeben gewaehlt war. Kann leer sein. */
  model: string
  /** Systemprompt, der am Desktop mitgegeben wurde. Kann leer sein. */
  systemPrompt: string
  /** Satz ueber das Betriebssystem des DESKTOPS, fuer Agentenlaeufe. */
  platformLine: string
  /** 3.1.2 (A39): false when the desktop switched the clock off. Older
   *  desktops do not send it, which means on. */
  shareClock?: boolean
}

export interface RemoteSessionInfo {
  app: string
  version: string
  connectedDevices: number
  /**
   * Name des Rechners, falls der Desktop einen mitschickt (`hostname` oder
   * `name` in `/remote-api/status/full`). 3.0.5 schickt keinen, dann ''.
   */
  hostName: string
  /**
   * Was der Desktop im angemeldeten Status anbietet (PROTOKOLL 11): im Kanal
   * `sealed`, `pending`, `signin` und, wenn das Recht `create` fuer dieses
   * Handy an ist, `create-image` und `create-video`. 3.0.6 schickt nichts.
   */
  features: string[]
  /** Der Desktop meldet, dass sein WLAN gesperrt ist (`lan_blocked`, meist die Windows-Firewall). */
  lanBlocked: boolean
}

/** Laengster Rechnername, den die Oberflaeche zeigt. */
export const HOST_NAME_MAX = 48

/**
 * Ein Rechnername ist fremde Eingabe: nur druckbare Zeichen, Leerraum
 * zusammengezogen, gekuerzt. Alles andere ergibt '' und die Oberflaeche zeigt
 * wie bisher die Adresse.
 */
export function cleanHostName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
  return text.slice(0, HOST_NAME_MAX).trim()
}

export interface RemotePermissions {
  filesystem: boolean
  downloads: boolean
  process_control: boolean
  shell: boolean
}

export interface RemoteDevice {
  id: string
  ip: string
  user_agent: string
  last_seen: number
}

export interface RemoteApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Rohes base64 ohne data-Praefix, wie Ollama es erwartet. */
  images?: string[]
  tool_calls?: RemoteToolCall[]
}

export interface RemoteToolCall {
  function: { name: string; arguments: unknown }
}

export interface ChatRequest {
  model: string
  messages: RemoteApiMessage[]
  /** true, false oder weglassen. Siehe `resolveThinkFlag`. */
  think?: boolean
  numPredict?: number
  signal?: AbortSignal
}

export interface StreamChatRequest extends ChatRequest {
  /** Denktext behalten oder verwerfen. Aus = er erreicht den Aufrufer nie. */
  keepThinking?: boolean
  /** Nach jedem Stueck mit dem bereinigten Zwischenstand. */
  onUpdate?: (partial: { content: string; thinking: string }) => void
}

export interface StreamChatResult {
  content: string
  thinking: string
  /** false, wenn der Aufrufer abgebrochen hat. */
  completed: boolean
  stopReason: 'done' | 'aborted'
}

export interface ToolChatRequest extends ChatRequest {
  /** Werkzeugliste im OpenAI-Format, wie `buildToolDefs` in agent-core.js sie baut. */
  tools: unknown[]
}

export interface ToolChatResult {
  content: string
  thinking: string
  toolCalls: RemoteToolCall[]
}

export interface AgentToolResult {
  /** false, wenn der Desktop `{error}` meldet oder der Aufruf scheiterte. */
  ok: boolean
  /** Der geparste Antwortkoerper, unveraendert. */
  data: unknown
  error?: string
  /** Name des Schalters, der am Desktop fehlt. */
  needsPermission?: string
}

export interface ChatEvent {
  role: 'user' | 'assistant'
  content: string
  model?: string
  mode?: 'lu' | 'codex'
  chatId: string
  chatTitle?: string
}

export interface RemoteClientOptions {
  /** Ursprung ohne Pfad, aus `normalizeRemoteBase`. */
  baseUrl: string
  fetch?: RemoteFetch
  /** Aktuelles Token. Wird vor jedem Aufruf neu gelesen. */
  getToken?: () => string | null | undefined
  /** Bekommt jedes neue Token: nach dem Koppeln und nach jeder Verlaengerung. */
  onToken?: (token: string) => void
  timeouts?: Partial<RemoteTimeouts>
  /**
   * Versiegelter Kanal (REMOTE-PROTOKOLL v2): der Transport beweist die
   * Kennung des Handys selbst, es gibt kein Token und kein `pair` mit Code.
   */
  sealed?: boolean
}

export interface RemoteTimeouts {
  probeMs: number
  authMs: number
  requestMs: number
  /** Ganzer Chat-Aufruf. Der Desktop gibt seinem Backend 600 s. */
  chatMs: number
  /** Ein Werkzeugaufruf. Shell-Befehle duerfen lange laufen. */
  toolMs: number
}

const DEFAULT_TIMEOUTS: RemoteTimeouts = {
  probeMs: 6_000,
  authMs: 10_000,
  requestMs: 20_000,
  chatMs: 660_000,
  toolMs: 330_000,
}

// ── Denken ───────────────────────────────────────────────────────

/** Wie `isThinkingCompatible` in client.js: Praefixvergleich auf dem Modellnamen. */
export function isThinkingModel(model: string | null | undefined): boolean {
  if (!model) return false
  const base = String(model)
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/:.*$/, '')
    .replace(/-abliterated/g, '')
    .replace(/-uncensored/g, '')
  return (THINKING_COMPATIBLE as string[]).some((prefix) => base.startsWith(prefix))
}

/**
 * Der dreiwertige `think`-Schalter aus client.js:
 *   - Modell kann nicht denken: Feld weglassen.
 *   - Denken an: true.
 *   - Denken aus: false, ausser bei Gemma 3 und 4. Dort fuehrt false zu einem
 *     Planungstext im Klartext, den kein Filter entfernen kann. Weglassen
 *     laesst das Modell getaggt denken, und die Tags werden verworfen.
 */
export function resolveThinkFlag(model: string, enabled: boolean): boolean | undefined {
  if (!isThinkingModel(model)) return undefined
  if (enabled) return true
  return isPlainTextPlanner(model) ? undefined : false
}

// ── Stream-Parser ────────────────────────────────────────────────

export interface ChatStreamParser {
  /** Text aus dem Netz anhaengen. Gibt true zurueck, wenn sich etwas Sichtbares geaendert hat. */
  push(text: string): boolean
  /** Rest ohne Zeilenende verarbeiten. */
  end(): void
  readonly content: string
  readonly thinking: string
  /** Die Abschlusszeile `done: true` ist angekommen. */
  readonly done: boolean
  /** Fehlerzeile des Backends, falls eine kam. */
  readonly error: string | null
}

/**
 * Liest den NDJSON-Strom von `/api/chat` (Ollama-Form): eine JSON-Zeile je
 * Stueck, `message.content` und `message.thinking`, am Ende `done: true`.
 *
 * Die Zustandsmaschine fuer `<think>` entspricht `pushChunkContent` in
 * client.js. Eine Abweichung, bewusst: der Rohtext bleibt erhalten und wird
 * fuer die Anzeige jedes Mal neu bereinigt. client.js bereinigt den
 * gespeicherten Text selbst, wodurch nach einem nie geschlossenen `<thought>`
 * spaetere Zeichen wieder sichtbar werden.
 */
export function createChatStreamParser(keepThinking: boolean): ChatStreamParser {
  let buf = ''
  let visible = ''
  let thinking = ''
  let inThink = false
  let discarded = ''
  let done = false
  let error: string | null = null

  function pushContent(text: string): void {
    for (const ch of text) {
      if (!inThink) {
        visible += ch
        if (visible.endsWith('<think>')) {
          visible = visible.slice(0, -7)
          inThink = true
          discarded = ''
        }
      } else if (keepThinking) {
        thinking += ch
        if (thinking.endsWith('</think>')) {
          thinking = thinking.slice(0, -8)
          inThink = false
        }
      } else {
        discarded += ch
        if (discarded.endsWith('</think>')) {
          discarded = ''
          inThink = false
        }
      }
    }
  }

  function line(raw: string): boolean {
    const ln = raw.trim()
    if (!ln) return false
    let j: unknown
    try {
      j = JSON.parse(ln)
    } catch {
      return false
    }
    if (!j || typeof j !== 'object') return false
    const o = j as { message?: { content?: unknown; thinking?: unknown }; done?: unknown; error?: unknown }
    let changed = false
    if (typeof o.error === 'string' && o.error) {
      error = o.error
      changed = true
    }
    if (o.message && typeof o.message === 'object') {
      if (typeof o.message.thinking === 'string' && o.message.thinking && keepThinking) {
        thinking += o.message.thinking
        changed = true
      }
      if (typeof o.message.content === 'string' && o.message.content) {
        pushContent(o.message.content)
        changed = true
      }
    }
    if (o.done === true) done = true
    return changed
  }

  return {
    push(text: string): boolean {
      buf += text
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      let changed = false
      for (const l of lines) changed = line(l) || changed
      return changed
    },
    end(): void {
      if (buf) {
        line(buf)
        buf = ''
      }
    },
    get content(): string {
      return String(stripNonCanonicalTags(visible))
    },
    get thinking(): string {
      return thinking
    },
    get done(): boolean {
      return done
    },
    get error(): string | null {
      return error
    },
  }
}

// ── Hilfen ───────────────────────────────────────────────────────

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError'
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Der Desktop nennt die Wartezeit im Text: "Too many attempts. Try again in 42s". */
export function parseRetryAfterSeconds(text: string): number {
  const m = /(\d+)\s*s/.exec(text || '')
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : 60
}

/** Meldet das Backend, dass das Modell keine Werkzeuge kann? */
export function isToolsUnsupported(err: unknown): boolean {
  return err instanceof RemoteBackendError && /does not support tools?/i.test(err.detail ?? '')
}

interface RawResponse {
  status: number
  text: string
  memoryRevoked: boolean
}

// ── Client ───────────────────────────────────────────────────────

export interface RemoteClient {
  readonly baseUrl: string
  /** Erreichbar und wirklich ein LU? Ohne Token. Gibt den Status zurueck (mit `features` ab 3.0.7). */
  probe(signal?: AbortSignal): Promise<Record<string, unknown>>
  /** Code gegen Token tauschen. Das Token geht auch an `onToken`. */
  pair(code: string, signal?: AbortSignal): Promise<string>
  /** Gilt das Token noch? Verlaengert die Sitzung, wenn sie ueber der Haelfte ist. */
  checkSession(signal?: AbortSignal): Promise<RemoteSessionInfo>
  getConfig(signal?: AbortSignal): Promise<RemoteHostConfig>
  listModels(signal?: AbortSignal): Promise<string[]>
  getPermissions(signal?: AbortSignal): Promise<RemotePermissions>
  /** Die eigene Zeile in der Geraeteliste des Desktops. */
  getOwnDevice(signal?: AbortSignal): Promise<RemoteDevice | null>
  /** Die eigene Sitzung am Desktop beenden. Danach ist das Token wertlos. */
  disconnect(signal?: AbortSignal): Promise<void>
  streamChat(req: StreamChatRequest): Promise<StreamChatResult>
  chatWithTools(req: ToolChatRequest): Promise<ToolChatResult>
  runAgentTool(call: { tool: string; args?: unknown; chatId?: string; signal?: AbortSignal }): Promise<AgentToolResult>
  /** Nachricht in den Desktop-Chat spiegeln. false, wenn sie nicht ankam. Wirft nie. */
  postChatEvent(ev: ChatEvent): Promise<boolean>
}

export function createRemoteClient(options: RemoteClientOptions): RemoteClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const doFetch: RemoteFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const timeouts: RemoteTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
  const route = (() => {
    try {
      return classifyHost(new URL(baseUrl).hostname)
    } catch {
      return null
    }
  })()
  const viaTunnel = route === 'tunnel' || route === 'public'
  /** A request that got no answer on the Wi-Fi way names the firewall (A17, Windows box). */
  const onWifi = route === 'lan'

  function absorb(res: Response): void {
    try {
      const fresh = res.headers.get(REFRESH_HEADER)
      if (fresh) options.onToken?.(fresh)
    } catch {
      /* ein Transport ohne Kopfzeilen darf den Aufruf nicht kosten */
    }
  }

  function headersFor(auth: boolean, hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {}
    if (hasBody) h['Content-Type'] = 'application/json'
    if (auth && !options.sealed) {
      const token = options.getToken?.()
      if (!token) throw new RemoteSessionExpiredError('missing')
      h.Authorization = `Bearer ${token}`
    }
    return h
  }

  /**
   * Ein Aufruf mit Frist. Die Frist deckt auch das Lesen des Koerpers, denn
   * ein Server, der Kopfzeilen schickt und dann schweigt, haengt genauso.
   */
  async function open(
    path: string,
    init: { method?: string; body?: string; auth: boolean; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ res: Response; finish: () => void; reason: () => 'user' | 'timeout' | null }> {
    const headers = headersFor(init.auth, init.body !== undefined)
    if (init.signal?.aborted) throw new RemoteAbortedError()

    const ctrl = new AbortController()
    let why: 'user' | 'timeout' | null = null
    const onUser = () => {
      why = why ?? 'user'
      ctrl.abort()
    }
    init.signal?.addEventListener('abort', onUser, { once: true })
    const timer = setTimeout(() => {
      why = why ?? 'timeout'
      ctrl.abort()
    }, init.timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', onUser)
    }

    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: ctrl.signal,
      })
      absorb(res)
      return { res, finish, reason: () => why }
    } catch (err) {
      finish()
      throw transportError(err, why)
    }
  }

  function transportError(err: unknown, why: 'user' | 'timeout' | null): RemoteError {
    if (err instanceof RemoteError) return err
    if (why === 'user') return new RemoteAbortedError()
    if (why === 'timeout') return new RemoteTimeoutError(String(err), undefined, { wifi: onWifi })
    if (isAbortError(err)) return new RemoteAbortedError()
    return new RemoteUnreachableError(viaTunnel, String((err as { message?: unknown })?.message ?? err))
  }

  async function raw(
    path: string,
    init: { method?: string; body?: string; auth: boolean; timeoutMs: number; signal?: AbortSignal },
  ): Promise<RawResponse> {
    const { res, finish, reason } = await open(path, init)
    try {
      const text = await res.text()
      return { status: res.status, text, memoryRevoked: isMemoryRevoked(res, res.status, text) }
    } catch (err) {
      throw transportError(err, reason())
    } finally {
      finish()
    }
  }

  function isMemoryRevoked(res: Response, status: number, text: string): boolean {
    if (status !== 409) return false
    let flagged = false
    try {
      flagged = res.headers.get(MEMORY_REVOKED_HEADER) === '1'
    } catch {
      /* siehe absorb */
    }
    // Ein Transport, der Kopfzeilen verliert, behaelt wenigstens den Text.
    return flagged || /Remote memory context was revoked/i.test(text)
  }

  /** Alles ausser 2xx in die passende Fehlerklasse uebersetzen. */
  function fail(r: RawResponse): RemoteError {
    const { status, text } = r
    if (status === 401) {
      const reason = /Missing authorization/i.test(text) ? 'missing' : /Session ended/i.test(text) ? 'ended' : 'expired'
      return new RemoteSessionExpiredError(reason, text)
    }
    if (r.memoryRevoked) return new RemoteMemoryRevokedError(text)
    if (status === 429) return new RemoteRateLimitedError(parseRetryAfterSeconds(text), text)
    if (status === 403) {
      // Versiegelt: Rechte je Geraet, {"error":"forbidden","right":"files"} (PROTOKOLL 12).
      const inner = asRecord(parseJson(text))
      if (inner?.error === 'forbidden' && typeof inner.right === 'string') {
        return new RemotePermissionError(undefined, text, inner.right.slice(0, 20))
      }
      const m = /(filesystem|downloads|process[_ ]control|shell)/i.exec(text)
      return new RemotePermissionError(m ? m[1].toLowerCase().replace(' ', '_') : undefined, text)
    }
    // 524: der Tunnel hat auf den Desktop gewartet und aufgegeben. Der Desktop
    // schickt Kopfzeilen erst, wenn die ganze Antwort fertig ist, eine lange
    // Antwort kann ueber den Tunnel also genau so enden.
    if (status === 524) return new RemoteTimeoutError(`HTTP 524 ${text.slice(0, 120)}`)
    if (viaTunnel && status >= 500 && /cloudflare|<html/i.test(text)) return new RemoteUnreachableError(true, `HTTP ${status}`)
    return new RemoteBackendError(status, text)
  }

  async function json(
    path: string,
    init: { method?: string; body?: string; auth: boolean; timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const r = await raw(path, init)
    if (r.status < 200 || r.status >= 300) throw fail(r)
    const data = parseJson(r.text)
    // Unbekannte Pfade leitet der Desktop auf die HTML-Seite /mobile um. Wer
    // hier HTML bekommt, spricht mit einem anderen oder einem zu alten Server.
    if (data === undefined) throw new RemoteProtocolError(r.status, r.text.slice(0, 200))
    return data
  }

  function chatBody(req: ChatRequest, stream: boolean, tools?: unknown[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream,
      options: { num_predict: req.numPredict ?? DEFAULT_NUM_PREDICT },
    }
    if (tools) body.tools = tools
    if (req.think !== undefined) body.think = req.think
    return body
  }

  const client: RemoteClient = {
    baseUrl,

    async probe(signal) {
      const r = await raw('/remote-api/status', { auth: false, timeoutMs: timeouts.probeMs, signal })
      const data = asRecord(parseJson(r.text))
      if (r.status === 200 && data?.status === 'ok') return data
      if (viaTunnel && r.status >= 500) throw new RemoteUnreachableError(true, `HTTP ${r.status}`)
      throw new RemoteNotLuError(r.status, r.text.slice(0, 200))
    },

    async pair(code, signal) {
      // Der Code-Login ist im Kanal verboten (PROTOKOLL 8); gekoppelt wird dort ueber remote_sealed_pair.
      if (options.sealed) throw new RemoteProtocolError(undefined, 'pair over the sealed channel')
      const clean = normalizePasscode(code)
      // Kein Netzaufruf fuer eine Eingabe, die nie stimmen kann: drei falsche
      // Versuche sperren die Adresse fuer 60 Sekunden.
      if (!clean) throw new RemoteInvalidCodeError(`expected ${PASSCODE_LENGTH} digits`)
      const r = await raw('/remote-api/auth', {
        method: 'POST',
        body: JSON.stringify({ passcode: clean }),
        auth: false,
        timeoutMs: timeouts.authMs,
        signal,
      })
      if (r.status === 403) throw new RemoteInvalidCodeError(r.text)
      if (r.status === 429) throw new RemoteRateLimitedError(parseRetryAfterSeconds(r.text), r.text)
      if (r.status < 200 || r.status >= 300) {
        throw r.status >= 500 ? new RemoteBackendError(r.status, r.text) : new RemoteNotLuError(r.status, r.text.slice(0, 200))
      }
      const token = asRecord(parseJson(r.text))?.token
      if (typeof token !== 'string' || !token) throw new RemoteNotLuError(r.status, r.text.slice(0, 200))
      options.onToken?.(token)
      return token
    },

    async checkSession(signal) {
      const data = asRecord(await json('/remote-api/status/full', { auth: true, timeoutMs: timeouts.requestMs, signal }))
      if (!data || data.app !== 'LU') throw new RemoteNotLuError(200, JSON.stringify(data).slice(0, 200))
      return {
        app: 'LU',
        version: typeof data.version === 'string' ? data.version : '',
        connectedDevices: typeof data.connected_devices === 'number' ? data.connected_devices : 0,
        hostName: cleanHostName(data.hostname) || cleanHostName(data.name),
        features: Array.isArray(data.features)
          ? data.features.filter((f): f is string => typeof f === 'string' && /^[a-z0-9_-]{1,32}$/.test(f)).slice(0, 32)
          : [],
        lanBlocked: data.lan_blocked === true,
      }
    },

    async getConfig(signal) {
      const data = asRecord(await json('/remote-api/config', { auth: true, timeoutMs: timeouts.requestMs, signal })) ?? {}
      return {
        model: typeof data.model === 'string' ? data.model : '',
        systemPrompt: typeof data.systemPrompt === 'string' ? data.systemPrompt : '',
        platformLine: typeof data.platformLine === 'string' ? data.platformLine : '',
        shareClock: data.shareClock !== false,
      }
    },

    async listModels(signal) {
      const data = asRecord(await json('/api/tags', { auth: true, timeoutMs: timeouts.requestMs, signal }))
      const list = Array.isArray(data?.models) ? data.models : []
      const names: string[] = []
      for (const m of list) {
        const o = asRecord(m)
        const name = typeof o?.name === 'string' && o.name ? o.name : typeof o?.model === 'string' ? o.model : ''
        if (name && !names.includes(name)) names.push(name)
      }
      return names
    },

    async getPermissions(signal) {
      const data = asRecord(await json('/remote-api/permissions', { auth: true, timeoutMs: timeouts.requestMs, signal })) ?? {}
      return {
        filesystem: data.filesystem === true,
        downloads: data.downloads === true,
        process_control: data.process_control === true,
        shell: data.shell === true,
      }
    },

    async getOwnDevice(signal) {
      const data = await json('/remote-api/devices', { auth: true, timeoutMs: timeouts.requestMs, signal })
      const row = Array.isArray(data) ? asRecord(data[0]) : null
      if (!row || typeof row.id !== 'string') return null
      return {
        id: row.id,
        ip: typeof row.ip === 'string' ? row.ip : '',
        user_agent: typeof row.user_agent === 'string' ? row.user_agent : '',
        last_seen: typeof row.last_seen === 'number' ? row.last_seen : 0,
      }
    },

    async disconnect(signal) {
      const own = await client.getOwnDevice(signal)
      if (!own) return
      const r = await raw('/remote-api/disconnect', {
        method: 'POST',
        body: JSON.stringify({ id: own.id }),
        auth: true,
        timeoutMs: timeouts.requestMs,
        signal,
      })
      if (r.status < 200 || r.status >= 300) throw fail(r)
    },

    async streamChat(req) {
      const keepThinking = req.keepThinking === true
      const parser = createChatStreamParser(keepThinking)
      const snapshot = () => ({ content: parser.content, thinking: parser.thinking })
      const aborted = (): StreamChatResult => ({ ...snapshot(), completed: false, stopReason: 'aborted' })

      const send = async (withThink: boolean) => {
        const body = chatBody(withThink ? req : { ...req, think: undefined }, true)
        return open('/api/chat', {
          method: 'POST',
          body: JSON.stringify(body),
          auth: true,
          timeoutMs: timeouts.chatMs,
          signal: req.signal,
        })
      }

      let opened: Awaited<ReturnType<typeof open>>
      try {
        opened = await send(true)
        // Altes Ollama oder ein Modell, das das Feld ablehnt: einmal ohne.
        if (opened.res.status === 400 && req.think !== undefined) {
          opened.finish()
          await opened.res.text().catch(() => '')
          opened = await send(false)
        }
      } catch (err) {
        if (err instanceof RemoteAbortedError) return aborted()
        throw err
      }

      const { res, finish, reason } = opened
      try {
        if (res.status < 200 || res.status >= 300) {
          const text = await res.text().catch(() => '')
          throw fail({ status: res.status, text, memoryRevoked: isMemoryRevoked(res, res.status, text) })
        }

        if (!res.body) {
          // Transport ohne Stream: der ganze Text auf einmal. Das ist kein
          // Rueckschritt, der Desktop liefert die Antwort ohnehin am Stueck.
          parser.push(await res.text())
        } else {
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (parser.push(dec.decode(value, { stream: true }))) req.onUpdate?.(snapshot())
          }
          parser.push(dec.decode())
        }
        parser.end()

        if (parser.error) throw new RemoteBackendError(undefined, parser.error)
        if (!parser.done) throw new RemoteConnectionLostError(snapshot(), 'stream ended without a done line')
        const result = { content: parser.content.trim(), thinking: parser.thinking }
        req.onUpdate?.(result)
        return { ...result, completed: true, stopReason: 'done' }
      } catch (err) {
        if (err instanceof RemoteError && !(err instanceof RemoteAbortedError)) throw err
        const why = reason()
        if (why === 'user' || err instanceof RemoteAbortedError || (why === null && isAbortError(err) && req.signal?.aborted)) {
          return aborted()
        }
        if (why === 'timeout') throw new RemoteTimeoutError(String(err))
        throw new RemoteConnectionLostError(snapshot(), String((err as { message?: unknown })?.message ?? err))
      } finally {
        finish()
      }
    },

    async chatWithTools(req) {
      const post = (withThink: boolean) =>
        raw('/api/chat', {
          method: 'POST',
          body: JSON.stringify(chatBody(withThink ? req : { ...req, think: undefined }, false, req.tools)),
          auth: true,
          timeoutMs: timeouts.chatMs,
          signal: req.signal,
        })
      let r = await post(true)
      if (r.status === 400 && req.think !== undefined) r = await post(false)
      if (r.status < 200 || r.status >= 300) throw fail(r)
      const data = asRecord(parseJson(r.text))
      if (!data) throw new RemoteProtocolError(r.status, r.text.slice(0, 200))
      if (typeof data.error === 'string' && data.error) throw new RemoteBackendError(undefined, data.error)
      const msg = asRecord(data.message) ?? {}
      const toolCalls: RemoteToolCall[] = []
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = asRecord(asRecord(tc)?.function)
          if (fn && typeof fn.name === 'string') toolCalls.push({ function: { name: fn.name, arguments: fn.arguments } })
        }
      }
      return {
        content: typeof msg.content === 'string' ? msg.content : '',
        thinking: typeof msg.thinking === 'string' ? msg.thinking : '',
        toolCalls,
      }
    },

    async runAgentTool(call) {
      const r = await raw('/remote-api/agent-tool', {
        method: 'POST',
        body: JSON.stringify({ tool: call.tool, args: call.args ?? {}, chatId: call.chatId ?? '' }),
        auth: true,
        timeoutMs: timeouts.toolMs,
        signal: call.signal,
      })
      if (r.status === 401 || r.memoryRevoked) throw fail(r)
      const data = parseJson(r.text)
      const obj = asRecord(data)
      // Der Desktop meldet jeden Werkzeugfehler als 200 mit {error}, damit das
      // Modell ihn als Beobachtung lesen und sich erholen kann.
      // Versiegelt: das Recht fehlt fuer dieses Geraet (PROTOKOLL 12). Ehrlich sagen, wo es fehlt.
      if (r.status === 403 && obj?.error === 'forbidden' && typeof obj.right === 'string') {
        const err = new RemotePermissionError(undefined, r.text, obj.right.slice(0, 20))
        return { ok: false, data, error: err.userMessage, needsPermission: obj.right.slice(0, 20) }
      }
      if (obj && typeof obj.error === 'string') {
        const needs = obj.needs_permission === true && typeof obj.permission === 'string' ? obj.permission : undefined
        return { ok: false, data, error: obj.error, ...(needs ? { needsPermission: needs } : {}) }
      }
      if (r.status < 200 || r.status >= 300) {
        return { ok: false, data: data ?? r.text, error: `HTTP ${r.status}: ${r.text.slice(0, 300)}` }
      }
      return { ok: true, data: data ?? r.text }
    },

    async postChatEvent(ev) {
      if (!ev.content) return false
      if (new TextEncoder().encode(ev.content).length > CHAT_EVENT_MAX_BYTES) return false
      try {
        const r = await raw('/remote-api/chat-event', {
          method: 'POST',
          body: JSON.stringify({
            role: ev.role,
            content: ev.content,
            model: ev.model ?? '',
            mode: ev.mode ?? 'lu',
            chat_id: ev.chatId,
            chat_title: ev.chatTitle ?? '',
          }),
          auth: true,
          timeoutMs: timeouts.requestMs,
        })
        return r.status >= 200 && r.status < 300
      } catch {
        return false
      }
    },
  }

  return client
}
