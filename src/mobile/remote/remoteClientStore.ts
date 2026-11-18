/**
 * Zustand des Remote-Clients in der Mobile-Shell.
 *
 * Haelt die Verbindung zu einem Desktop-LU, die Chats, die ueber dessen
 * Modelle laufen, und den Entwurf je Chat. Die Protokollarbeit macht
 * `remoteClient.ts`, das Netz kommt ueber den hereingereichten Transport.
 *
 * Persistenz: IndexedDB ueber `idbStorage`, gesammelt geschrieben ueber
 * `coalescedJSONStorage`. Nicht localStorage, Verlaeufe werden gross. Das
 * Token liegt NICHT im persistierten Zustand, sondern im `TokenVault`.
 *
 * Hintergrund: geht die App weg, wird ein laufender Chat sofort beendet, der
 * Teilstand als "interrupted" markiert und geschrieben. Kommt sie zurueck,
 * wird die Verbindung geprueft. Wird die App im Hintergrund vom System
 * beendet, findet der naechste Start hoechstens eine Nachricht im Zustand
 * "pending" und macht daraus "interrupted".
 *
 * Runde 2:
 *   - Jeder Chat gehoert einem Desktop (`baseUrl`). Nach dem Wechsel auf einen
 *     anderen Desktop bleiben die alten Chats lesbar, werden dort aber nicht
 *     fortgesetzt.
 *   - Bilder an einer Nachricht. Persistiert wird je Bild nur ein kleines
 *     Vorschaubild; die Daten fuer das Modell leben im Arbeitsspeicher dieser
 *     Sitzung. So waechst der gespeicherte Zustand nicht um Megabytes je Foto.
 *   - Agentenmodus je Chat: die Schleife steht in `remoteAgent.ts`, die
 *     Werkzeuge laufen auf dem Desktop mit dessen Schaltern.
 *   - Sprechweise (Caveman) je Chat und der Rechnername des Desktops.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { persist, type StateStorage } from 'zustand/middleware'
import { coalescedJSONStorage } from '../../lib/coalescedStorage'
import { idbStorage } from '../../lib/idbStorage'
import { classifyHost, displayAddress, isNotWifiAddress, parsePairingInput, type PairingTarget, type RemoteRoute } from './pairingLink'
import {
  KEEPALIVE_INTERVAL_MS,
  RemoteConnectionLostError,
  RemoteError,
  RemoteInvalidAddressError,
  RemoteMemoryRevokedError,
  RemoteSessionExpiredError,
  RemoteTimeoutError,
  RemoteUnreachableError,
  createRemoteClient,
  resolveThinkFlag,
  toRemoteErrorInfo,
  type RemoteApiMessage,
  type RemoteClient,
  type RemoteErrorInfo,
  type RemoteFetch,
  type RemoteHostConfig,
  type RemotePermissions,
  type RemoteTimeouts,
} from './remoteClient'
import { IMAGE_KEEP_RECENT, dropOldImages } from '../../../mobile-client/agent-core.js'
import {
  buildRemoteSystemPrompt,
  cavemanReminder,
  isCavemanLevel,
  remoteCreateRunner,
  remoteToolsFor,
  runRemoteAgentLoop,
  type CavemanLevel,
  type RemoteAgentEnd,
  type RemoteAgentStep,
  type RemoteStepMedia,
} from './remoteAgent'
import { RemoteToolsUnsupportedError } from './remoteErrors'
import { createDefaultTokenVault, type TokenVault } from './tokenVault'
import { lookupDesktopAddress, type LookupFetch } from './addressLookup'
import {
  candidateAddresses,
  chooseChannel,
  createSealedFetch,
  guardPlainFetch,
  readDesktopStatus,
  sealedForget,
  deviceFingerprint,
  sealedPair,
  type DesktopStatus,
  type SealedInvoke,
  type SealedPin,
} from './sealedChannel'
import {
  RemoteNotLuError,
  RemoteOpenPairingError,
  RemotePairingDeniedError,
  RemoteScanNeededError,
  RemoteStaleAddressError,
  RemoteUnpairedError,
  RemoteUpdateDesktopError,
  NOT_WIFI_TEXT,
  atPairStep,
  type PairStep,
} from './remoteErrors'

export type { CavemanLevel, RemoteAgentEnd, RemoteAgentStep } from './remoteAgent'

// ── Typen ────────────────────────────────────────────────────────

export type RemoteStatus =
  /** Keine Adresse hinterlegt. */
  | 'unpaired'
  /** Adresse oder Sitzung wird gerade geprueft. */
  | 'connecting'
  /** Desktop erreichbar, aber kein gueltiges Token: Code eingeben. */
  | 'needs-code'
  /** Der Code ist unterwegs. */
  | 'pairing'
  | 'connected'
  /** Adresse bekannt, Desktop antwortet nicht. */
  | 'offline'
  /** Der Desktop hat die Sitzung gesperrt (Erinnerungen geaendert). */
  | 'blocked'

export type RemoteMessageState =
  | 'done'
  /** Antwort wird erwartet oder laeuft ein. */
  | 'pending'
  /** Der Nutzer hat gestoppt. */
  | 'stopped'
  /** App ging in den Hintergrund, wurde beendet, oder die Verbindung riss. */
  | 'interrupted'
  | 'failed'

/** Hoechstens so viele Bilder je Nachricht. */
export const MAX_REMOTE_IMAGES = 4
/** Ein Vorschaubild, das groesser ist, wird nicht gespeichert (die Nachricht zeigt dann nur die Zahl der Bilder). */
export const MAX_THUMB_CHARS = 60_000

/** Was von einem Bild gespeichert wird: nie die Daten fuer das Modell. */
export interface RemoteImage {
  mimeType: string
  /** Kleines Vorschaubild als rohes base64, oder '' wenn es keins gibt. */
  thumb: string
  name?: string
}

/** Ein Bild beim Senden: Vorschau plus die Daten fuer das Modell (rohes base64 ohne data-Praefix). */
export interface RemoteImageInput extends RemoteImage {
  data: string
}

export interface RemoteMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  createdAt: number
  state: RemoteMessageState
  /** Nur bei 'failed' und 'interrupted': was los war, anzeigbar. */
  error?: RemoteErrorInfo
  /** Nur Nutzernachrichten: ist sie im Desktop-Chat angekommen? */
  mirrored?: boolean
  /** Nur Nutzernachrichten: angehaengte Bilder (Vorschau, siehe RemoteImage). */
  images?: RemoteImage[]
  /** Nur Antworten im Agentenmodus: die Werkzeugschritte auf dem Desktop. */
  steps?: RemoteAgentStep[]
  /** Nur Antworten im Agentenmodus: warum der Lauf endete, wenn nicht mit einer Antwort. */
  agentEnd?: Extract<RemoteAgentEnd, 'max-iterations' | 'tool-errors' | 'looping' | 'cost-limit'>
}

export interface RemoteChat {
  id: string
  title: string
  model: string
  thinkEnabled: boolean
  /**
   * Eigener Systemprompt fuer diesen Chat (zum Beispiel eine Persona).
   * null = der Prompt, den der Desktop beim Freigeben mitgegeben hat.
   */
  systemPrompt: string | null
  /** Agentenmodus: das Modell darf Werkzeuge auf dem Desktop benutzen. */
  agentMode: boolean
  /** Knappe Sprechweise, wie auf der Handy-Webseite des Desktops. */
  caveman: CavemanLevel
  /**
   * Der Desktop, mit dem dieser Chat gefuehrt wird. null nur bei Chats aus
   * einem Stand ohne diese Angabe und ohne gespeicherte Verbindung; ein
   * solcher Chat gehoert dem Desktop, mit dem er das naechste Mal benutzt wird.
   */
  baseUrl: string | null
  createdAt: number
  updatedAt: number
  messages: RemoteMessage[]
}

export interface RemoteConnection {
  baseUrl: string
  /** Anzeigeform ohne Schema. */
  address: string
  route: RemoteRoute
  secure: boolean
  /** Zeitpunkt des letzten erfolgreichen Koppelns, ms. */
  pairedAt: number | null
  /** Zeitpunkt der letzten gelungenen Pruefung, ms. */
  lastOkAt: number | null
  serverVersion: string
  /** Rechnername, falls der Desktop einen mitschickt. Sonst ''. */
  hostName: string
  /**
   * Versiegelter Kanal (3.0.7): der festgenagelte Desktop. Gesetzt, sobald die
   * Kopplung gelungen ist. Dann geht nie wieder etwas im Klartext an ihn
   * (R50-PRUEFUNG M2), auch nicht im WLAN.
   */
  pin?: SealedPin | null
  /** Versiegelt: die Adresse, ueber die der Desktop zuletzt erreicht wurde (WLAN oder Tunnel). */
  via?: string | null
}

/** Der Desktop fragt seinen Nutzer, ob er dieses Handy zulaesst. */
export interface ConfirmOnDesktop {
  name: string
  /**
   * Vergleichscode, sechs Ziffern. Der Desktop zeigt ihn auf beiden Wegen
   * (`comparisonCode`, Desktop `f72041dab`): beim QR-Weg sofort aus dem
   * Handschlag, beim Code-Weg nach dem Aufdecken. null, wenn Rust keinen nennt.
   */
  sas: string | null
  /**
   * Fingerabdruck dieses Handys ("3F2A 9C01"), derselbe, den der Desktop in
   * seiner Rueckfrage zeigt. '' wenn die Kennung fehlt.
   */
  fingerprint: string
}

/** Was Create und die Anmeldung vom Kanal brauchen. Kein Schluessel, kein Token. */
export interface DesktopChannel {
  /** RemoteFetch ueber `remote_sealed_request`; der Ursprung der URL zaehlt nicht. */
  fetch: RemoteFetch
  /** Die Adresse, unter der der Desktop gerade erreicht wird (WLAN oder Tunnel). */
  address: string
  pin: SealedPin
  /** Die Rust-Kommandos `remote_sealed_*` (Stuecke, Anmeldung, Abbruch). */
  invoke: SealedInvoke
  features: string[]
}

export type SendOutcome =
  | 'sent'
  | 'empty'
  | 'busy'
  | 'not-connected'
  | 'no-model'
  | 'no-chat'
  /** Der Chat gehoert einem anderen Desktop als dem verbundenen. */
  | 'other-desktop'
  /** Erneut senden: die Bilder der Nachricht sind nicht mehr im Arbeitsspeicher. */
  | 'images-lost'

export interface SendOptions {
  images?: RemoteImageInput[]
}

export interface RemoteClientState {
  // ── persistiert ──
  connection: RemoteConnection | null
  chats: RemoteChat[]
  activeChatId: string
  /** Entwurf je Chat. Der Schluessel '' gehoert zum Zustand ohne Chat. */
  drafts: Record<string, string>

  // ── fluechtig ──
  /** false, bis Zustand und Token von der Platte gelesen sind. */
  hydrated: boolean
  status: RemoteStatus
  /** Letzter Verbindungsfehler, anzeigbar. null, wenn alles gut ist. */
  error: RemoteErrorInfo | null
  /** Ab wann nach einer Sperre wieder ein Code probiert werden darf, ms. */
  retryAt: number | null
  token: string
  hostConfig: RemoteHostConfig | null
  models: string[]
  permissions: RemotePermissions | null
  /** Chat, in dem gerade eine Antwort laeuft. */
  streamingChatId: string | null
  /**
   * Ein Link, den das System der App zugestellt hat und der auf Bestaetigung
   * wartet. Nie automatisch verbinden: jede App auf dem Handy kann einen
   * `lu://remote`-Link ausloesen.
   */
  pendingLink: PairingTarget | null
  /** Waehrend der Desktop seinen Nutzer fragt (Status 'pairing'). */
  confirmOnDesktop: ConfirmOnDesktop | null
  /**
   * Was der verbundene Desktop im angemeldeten Status anbietet (`status/full`),
   * nur im versiegelten Kanal gesetzt. Leer, solange nicht verbunden. Create
   * ("My computer") und "Sign in with my computer" haengen daran.
   */
  features: string[]
  /**
   * Das WLAN des Rechners ist gesperrt (meist die Windows-Firewall): der
   * Desktop meldet `lan_blocked` im Status, oder das WLAN schwieg und die App
   * ging ueber den Tunnel. Die Zeile der Verbindung sagt es dann dazu.
   */
  lanBlocked: boolean

  /**
   * Der versiegelte Kanal zum verbundenen Desktop, fuer Create und die
   * Anmeldung. Null, wenn nicht versiegelt gekoppelt oder nicht verbunden:
   * es gibt keinen Weg im Klartext dorthin.
   */
  desktopChannel: () => DesktopChannel | null

  // ── Verbindung ──
  /** Link merken, bis der Nutzer zustimmt. false, wenn er nicht lesbar ist. */
  offerLink: (input: string) => boolean
  dismissLink: () => void
  /** Adresse (und optional Code) uebernehmen, pruefen, koppeln. */
  connect: (input: string, code?: string | null) => Promise<void>
  submitCode: (code: string) => Promise<void>
  /** Erreichbarkeit und Sitzung pruefen. Der Weg zurueck aus 'offline'. */
  verifyConnection: () => Promise<void>
  /** Lebenszeichen, das die Sitzung verlaengert. Still bei Netzfehlern. */
  keepalive: () => Promise<void>
  refreshModels: () => Promise<void>
  /** Sitzung beenden, Adresse behalten. */
  disconnect: () => Promise<void>
  /** Sitzung beenden und Adresse vergessen. Chats bleiben. */
  forget: () => Promise<void>
  clearError: () => void

  // ── Chats ──
  newChat: () => string
  selectChat: (id: string) => void
  deleteChat: (id: string) => void
  renameChat: (id: string, title: string) => void
  setChatModel: (id: string, model: string) => void
  setThinkEnabled: (id: string, on: boolean) => void
  setSystemPrompt: (id: string, prompt: string | null) => void
  setAgentMode: (id: string, on: boolean) => void
  setCaveman: (id: string, level: CavemanLevel) => void
  setDraft: (chatId: string, text: string) => void

  // ── Nachrichten ──
  sendMessage: (text?: string, options?: SendOptions) => Promise<SendOutcome>
  /** Letzte, nicht fertig gewordene Antwort neu anfordern. */
  retryLast: (chatId?: string) => Promise<SendOutcome>
  /**
   * Eine Antwort verwerfen und neu anfordern. Die Antwort und alles nach ihr
   * faellt weg, die Frage davor bleibt und wird erneut gestellt (wie
   * `_regenMsg` der Webseite des Desktops).
   */
  regenerate: (chatId: string, messageId: string) => Promise<SendOutcome>
  /**
   * Eine eigene Nachricht aendern und neu senden. Alles nach ihr faellt weg
   * (wie `_editMsg` der Webseite). Ihre Bilder bleiben an ihr.
   */
  editAndResend: (chatId: string, messageId: string, text: string) => Promise<SendOutcome>
  stopStreaming: () => void

  // ── Lebenszyklus ──
  handleBackground: () => Promise<void>
  handleForeground: () => Promise<void>
}

type Persisted = Pick<RemoteClientState, 'connection' | 'chats' | 'activeChatId' | 'drafts'>

export interface LifecycleEnv {
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document?: Pick<Document, 'addEventListener' | 'removeEventListener'> & { visibilityState?: string }
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface RemoteClientStoreDeps {
  /** Transport. Auf dem Geraet ein Rust-Kommando, sonst `fetch`. Steht immer hinter dem Waechter `guardPlainFetch`. */
  fetch?: RemoteFetch
  /** Der versiegelte Kanal (Rust-Kommandos remote_sealed_*). Ohne ihn kennt die App nur den alten Weg im WLAN. */
  sealed?: { invoke: SealedInvoke; deviceName?: () => string | undefined }
  /** Fuer die Adressauskunft (ausgeschaltet, siehe addressLookup.ts). */
  lookupFetch?: LookupFetch
  /** Abstand der Nachfragen, waehrend der Desktop seinen Nutzer fragt. Vorgabe 2 s. */
  pairPollMs?: number
  /** So lange wartet die App auf die Antwort am Desktop. Vorgabe 2 min (PROTOKOLL 5.1). */
  pairWaitMs?: number
  /** Speicher fuer den Zustand. Vorgabe: IndexedDB ueber `idbStorage`. */
  storage?: StateStorage
  /** Ablage fuer das Token. Vorgabe: eigener Schluessel im selben Speicher. */
  vault?: TokenVault
  /** Name des Eintrags im Speicher. */
  name?: string
  /** Nach dem Laden von selbst die Verbindung pruefen. Vorgabe: ja. */
  autoResume?: boolean
  timeouts?: Partial<RemoteTimeouts>
  /**
   * So lange bekommt das WLAN einen Vorsprung, wenn auch ein Tunnel bekannt
   * ist. Antwortet es in der Zeit nicht, geht die App gleich ueber den Tunnel,
   * statt den ganzen Zeitablauf abzuwarten (Windows-Firewall, 21.10.2026). Vorgabe 3 s.
   */
  wifiHeadStartMs?: number
  /** Netz des Handys ('wifi', 'cellular', ...). Ohne: unbekannt. Im Mobilfunk sagt ein stummes WLAN nichts. */
  networkKind?: () => Promise<string>
  now?: () => number
  /** Ruhezeit des gesammelten Schreibens, fuer Tests. */
  persistWaitMs?: number
}

export interface RemoteClientStore {
  useStore: UseBoundStore<StoreApi<RemoteClientState>>
  /** Erfuellt, sobald Zustand und Token gelesen sind. */
  ready: Promise<void>
  /** Ausstehendes Schreiben jetzt erledigen. Erfuellt, wenn es gelandet ist. */
  flush: () => Promise<void>
  /** pagehide, visibilitychange und Lebenszeichen anbinden. Gibt die Abmeldung zurueck. */
  attachLifecycle: (env?: LifecycleEnv) => () => void
}

export const REMOTE_STORE_KEY = 'lu-mobile-remote'
const NEW_CHAT_TITLE = 'New Chat'

function uid(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  return `${prefix}-${id}`
}

function sanitizeImages(raw: unknown): RemoteImage[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteImage[] = []
  for (const image of raw as Array<Partial<RemoteImage> | null>) {
    if (!image || typeof image !== 'object') continue
    const thumb = typeof image.thumb === 'string' && image.thumb.length <= MAX_THUMB_CHARS && /^[A-Za-z0-9+/=]*$/.test(image.thumb) ? image.thumb : ''
    out.push({
      mimeType: typeof image.mimeType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(image.mimeType) ? image.mimeType : 'image/jpeg',
      thumb,
      ...(typeof image.name === 'string' && image.name ? { name: image.name.slice(0, 120) } : {}),
    })
    if (out.length >= MAX_REMOTE_IMAGES) break
  }
  return out
}

/** A17: die Bilder und Videos eines Schritts, nur Verweise auf die Galerie des Handys. */
function sanitizeMedia(raw: unknown): RemoteStepMedia[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteStepMedia[] = []
  for (const m of raw.slice(0, 4) as Array<Partial<RemoteStepMedia> | null>) {
    if (!m || typeof m.id !== 'string' || !/^pc_[A-Za-z0-9_.-]{1,100}$/.test(m.id)) continue
    if (m.kind !== 'image' && m.kind !== 'video') continue
    out.push({ id: m.id, kind: m.kind, mime: typeof m.mime === 'string' && /^(image|video)\/[a-z0-9.+-]{1,40}$/.test(m.mime) ? m.mime : m.kind === 'image' ? 'image/png' : 'video/mp4' })
  }
  return out
}

function sanitizeSteps(raw: unknown): RemoteAgentStep[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteAgentStep[] = []
  for (const step of raw as Array<Partial<RemoteAgentStep> | null>) {
    if (!step || typeof step.id !== 'string' || typeof step.tool !== 'string') continue
    out.push({
      id: step.id,
      tool: step.tool,
      args: typeof step.args === 'string' ? step.args : '',
      // Ein Schritt, der beim letzten Mal noch lief, ist nie fertig geworden.
      state: step.state === 'done' ? 'done' : 'failed',
      result: typeof step.result === 'string' ? step.result : '',
      ...(typeof step.needsPermission === 'string' && step.needsPermission ? { needsPermission: step.needsPermission } : {}),
      ...(sanitizeMedia(step.media).length > 0 ? { media: sanitizeMedia(step.media) } : {}),
    })
  }
  return out
}

/**
 * Was von der Platte kommt, ist fremde Eingabe: nur Bekanntes uebernehmen.
 * `fallbackBaseUrl` bekommt ein Chat aus einem Stand, der noch keinen Desktop
 * je Chat kannte: er wurde mit dem damals gespeicherten Desktop gefuehrt.
 */
function sanitizeChats(raw: unknown, fallbackBaseUrl: string | null = null): RemoteChat[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteChat[] = []
  for (const c of raw as Array<Partial<RemoteChat>>) {
    if (!c || typeof c.id !== 'string') continue
    const messages: RemoteMessage[] = []
    for (const m of Array.isArray(c.messages) ? (c.messages as Array<Partial<RemoteMessage>>) : []) {
      if (!m || typeof m.id !== 'string' || (m.role !== 'user' && m.role !== 'assistant')) continue
      // Eine Antwort, die beim letzten Mal noch lief, ist nie fertig geworden:
      // die App wurde beendet. Sie darf nicht ewig als "laeuft" dastehen.
      const state: RemoteMessageState = m.state === 'pending' ? 'interrupted' : (m.state ?? 'done')
      messages.push({
        id: m.id,
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
        thinking: typeof m.thinking === 'string' ? m.thinking : '',
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
        state,
        ...(m.error ? { error: m.error } : {}),
        ...(m.role === 'user' ? { mirrored: m.mirrored === true } : {}),
        ...(m.role === 'user' && Array.isArray(m.images) && m.images.length > 0 ? { images: sanitizeImages(m.images) } : {}),
        ...(m.role === 'assistant' && Array.isArray(m.steps) && m.steps.length > 0 ? { steps: sanitizeSteps(m.steps) } : {}),
        ...(m.role === 'assistant' && (m.agentEnd === 'max-iterations' || m.agentEnd === 'tool-errors' || m.agentEnd === 'looping' || m.agentEnd === 'cost-limit') ? { agentEnd: m.agentEnd } : {}),
      })
    }
    out.push({
      id: c.id,
      title: typeof c.title === 'string' && c.title ? c.title : NEW_CHAT_TITLE,
      model: typeof c.model === 'string' ? c.model : '',
      thinkEnabled: c.thinkEnabled === true,
      systemPrompt: typeof c.systemPrompt === 'string' ? c.systemPrompt : null,
      agentMode: c.agentMode === true,
      caveman: isCavemanLevel(c.caveman) ? c.caveman : 'off',
      baseUrl: typeof c.baseUrl === 'string' && c.baseUrl ? c.baseUrl : fallbackBaseUrl,
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
      updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
      messages,
    })
  }
  return out
}

/**
 * Hat dieser Desktop je funktioniert: einmal gekoppelt oder einmal mit Sitzung erreicht.
 *
 * `connect()` legt die Verbindung an, BEVOR der Desktop geantwortet hat, weil die
 * Seiten des laufenden Versuchs sie brauchen (Fehlerbox, "Try again", Code-Feld).
 * Gemerkt wird sie damit nicht: ein Versuch, der in "took too long to answer"
 * endet, ist kein Desktop dieses Telefons (Gegenpruefung iPhone, Runde 22, N10).
 * Auf die Platte kommt nur eine Verbindung, die das hier besteht, und beim Start
 * wird nur eine solche geladen: so verschwinden auch die Fehleintraege, die
 * aeltere Versionen geschrieben haben.
 */
export function connectionEverWorked(connection: Pick<RemoteConnection, 'pairedAt' | 'lastOkAt'> | null | undefined): boolean {
  if (!connection) return false
  const stamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0
  return stamp(connection.pairedAt) || stamp(connection.lastOkAt)
}

function sanitizePin(raw: unknown): SealedPin | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!o || typeof o.desktopId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(o.desktopId)) return null
  if (typeof o.x25519 !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(o.x25519)) return null
  return {
    desktopId: o.desktopId,
    x25519: o.x25519,
    name: typeof o.name === 'string' ? o.name.slice(0, 64) : '',
    lan: typeof o.lan === 'string' ? o.lan : null,
    tunnel: typeof o.tunnel === 'string' ? o.tunnel : null,
  }
}

function routeOf(address: string): RemoteRoute {
  try {
    return classifyHost(new URL(address).hostname)
  } catch {
    return 'public'
  }
}

function isWifi(address: string): boolean {
  const r = routeOf(address)
  return r === 'lan' || r === 'loopback'
}

function isInternet(address: string): boolean {
  return !isWifi(address)
}

export function createRemoteClientStore(deps: RemoteClientStoreDeps = {}): RemoteClientStore {
  const storage = deps.storage ?? idbStorage
  const vault = deps.vault ?? createDefaultTokenVault(storage)
  const now = deps.now ?? (() => Date.now())
  const name = deps.name ?? REMOTE_STORE_KEY

  let hydratedFlag = false
  const persistStorage = coalescedJSONStorage<Persisted>(storage, {
    // Vor dem Laden wuerde der leere Anfangszustand die Chats ueberschreiben.
    ready: () => hydratedFlag,
    ...(deps.persistWaitMs !== undefined ? { waitMs: deps.persistWaitMs } : {}),
  })

  let markReady!: () => void
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })

  /**
   * Der Lauf, dem der Eingabebereich gerade gehoert. Verglichen wird ueber die
   * Identitaet: ein gestoppter Lauf wickelt sich noch ab, waehrend der naechste
   * schon laeuft, und darf dessen Nachricht nicht anfassen.
   */
  let activeRun: { ctrl: AbortController; chatId: string } | null = null
  /** Zaehler gegen ueberholte Verbindungspruefungen. */
  let verifySeq = 0
  let clientCache: { baseUrl: string; client: RemoteClient; sealed: boolean } | null = null
  /** Status des WLAN-Listeners fuer den Code-Weg (Desktop 3.0.7), je Adresse. Nie persistiert. */
  let codeStatus: { baseUrl: string; status: DesktopStatus } | null = null
  /**
   * Die veraltete Adresse, die die laufende neue Suche ausgeloest hat. Findet
   * die Suche nichts, bleibt es bei ihrem Satz (neuer QR-Code, WLAN) statt
   * "nicht erreichbar".
   */
  let staleCause: RemoteStaleAddressError | null = null
  /** Der alte Weg, immer hinter dem Waechter: ueber das Internet nur der nackte Status. */
  const plainFetch: RemoteFetch = guardPlainFetch(deps.fetch ?? ((url, init) => globalThis.fetch(url, init)))
  // Wird unten an den Zustand gebunden; vorher ruft ihn niemand.
  let sealedFetch: RemoteFetch = () => Promise.reject(new RemoteUnpairedError('not ready'))
  /**
   * Die Bilddaten fuer das Modell, je Nachricht. Nur im Arbeitsspeicher: im
   * gespeicherten Zustand steht je Bild ein Vorschaubild und sonst nichts.
   */
  const imageData = new Map<string, string[]>()

  const useStore = create<RemoteClientState>()(
    persist(
      (set, get) => {
        if (deps.sealed) {
          const sealedDeps = deps.sealed
          sealedFetch = createSealedFetch({
            invoke: sealedDeps.invoke,
            pin: () => get().connection?.pin ?? null,
            address: () => get().connection?.via ?? get().connection?.baseUrl ?? null,
            deviceName: sealedDeps.deviceName,
          })
        }
        // ── Hilfen ───────────────────────────────────────────────

        function clientFor(baseUrl: string): RemoteClient {
          const pinned = !!get().connection?.pin
          if (clientCache?.baseUrl === baseUrl && clientCache.sealed === pinned) return clientCache.client
          const client = createRemoteClient({
            baseUrl,
            fetch: pinned ? sealedFetch : plainFetch,
            sealed: pinned,
            timeouts: deps.timeouts,
            getToken: () => (get().connection?.baseUrl === baseUrl ? get().token : ''),
            onToken: (token) => {
              // Ein Token, das fuer eine inzwischen ersetzte Adresse eintrifft, verfaellt.
              if (get().connection?.baseUrl !== baseUrl) return
              set({ token })
              void vault.save(baseUrl, token).catch(() => {})
            },
          })
          clientCache = { baseUrl, client, sealed: pinned }
          return client
        }

        /** Nur fuer den Status: immer Klartext, immer hinter dem Waechter. */
        function statusClient(address: string, probeMs?: number): RemoteClient {
          return createRemoteClient({ baseUrl: address, fetch: plainFetch, timeouts: probeMs ? { ...deps.timeouts, probeMs } : deps.timeouts })
        }

        /** Das WLAN schwieg, ein anderer Weg kam durch (in diesem Lauf). */
        let lanSilent = false

        /** Ein stummes WLAN zaehlt als gesperrt, ausser das Handy ist gar nicht im WLAN. */
        async function noteLanSilent(): Promise<void> {
          const kind = deps.networkKind ? await deps.networkKind().catch(() => 'unknown') : 'unknown'
          lanSilent = kind !== 'cellular' && kind !== 'none'
        }

        /** Gekoppelt im Sinn von "darf Anfragen stellen": Token (alter Weg) oder Nagel (Kanal). */
        function authed(): boolean {
          return !!get().token || !!get().connection?.pin
        }

        function dropPin(): void {
          const c = get().connection
          if (c?.pin) set({ connection: { ...c, pin: null, via: null } })
          clientCache = null
        }

        function sleepMs(ms: number): Promise<void> {
          return new Promise((r) => setTimeout(r, ms))
        }

        /** Status einer Adresse lesen. Null, wenn sie nicht antwortet; 'gone' bei 404 (die Adresse gehoert ihm nicht mehr). */
        async function readStatus(address: string, probeMs?: number): Promise<DesktopStatus | 'gone' | 'silent' | null> {
          try {
            return readDesktopStatus(await statusClient(address, probeMs).probe())
          } catch (err) {
            if (err instanceof RemoteTimeoutError) return 'silent'
            return err instanceof RemoteNotLuError && err.status === 404 ? 'gone' : null
          }
        }

        /** Eine Tunnel-Adresse, die 404 gab, ist tot: sie kommt nie zurueck (jeder Tunnelstart hat einen neuen Namen). */
        function forgetStaleTunnel(address: string): void {
          const c = get().connection
          if (!c?.pin || isWifi(address) || c.pin.tunnel !== address) return
          set({ connection: { ...c, pin: { ...c.pin, tunnel: null }, via: c.via === address ? null : c.via } })
        }

        /**
         * Nach der Kopplung: der Desktop fragt seinen Nutzer. Alle 2 s nach
         * dem Stand fragen, hoechstens 2 Minuten (PROTOKOLL 5.1).
         */
        async function awaitDesktop(seq: number): Promise<boolean> {
          const until = now() + (deps.pairWaitMs ?? 120_000)
          for (;;) {
            if (seq !== verifySeq) return false
            const client = current()
            if (!client) return false
            let state = ''
            try {
              const res = await sealedFetch(`${client.baseUrl}/remote-api/pair/status`, { method: 'GET' })
              const data = (await res.json().catch(() => null)) as { state?: unknown; error?: unknown } | null
              state = typeof data?.state === 'string' ? data.state : res.status === 403 && data?.error === 'pairing_denied' ? 'denied' : ''
            } catch (err) {
              if (err instanceof RemoteError && err.code === 'pairing-denied') state = 'denied'
              else if (err instanceof RemoteError && err.code !== 'unreachable' && err.code !== 'timeout') throw err
            }
            if (seq !== verifySeq) return false
            if (state === 'paired') return true
            if (state === 'denied' || now() >= until) throw new RemotePairingDeniedError(state || 'no answer')
            await sleepMs(deps.pairPollMs ?? 2_000)
          }
        }

        /** Eine Kopplung des Kanals uebernehmen und zu Ende bringen. */
        async function finishSealedPairing(
          outcome: Awaited<ReturnType<typeof sealedPair>>,
          address: string,
          seq: number,
        ): Promise<void> {
          const c = get().connection
          if (!c || seq !== verifySeq) return
          const pin: SealedPin = {
            desktopId: outcome.desktopId,
            x25519: outcome.x25519,
            name: outcome.name,
            lan: outcome.lan ?? (isWifi(address) ? address : (c.pin?.lan ?? null)),
            tunnel: outcome.tunnel ?? (!isWifi(address) ? address : (c.pin?.tunnel ?? null)),
          }
          clientCache = null
          set({ connection: { ...c, pin, via: address, hostName: c.hostName || outcome.name } })
          if (outcome.state === 'pending') {
            // Der Vergleichscode nur beim Code-Weg: dort zeigt ihn auch der Rechner (PROTOKOLL 5.2).
            // Der Rechner zeigt Vergleichscode und Fingerabdruck auf beiden Wegen: das Handy auch.
            set({ status: 'pairing', confirmOnDesktop: { name: outcome.name, sas: outcome.sas, fingerprint: deviceFingerprint(outcome.deviceId) } })
            try {
              const ok = await awaitDesktop(seq)
              if (!ok) return
            } catch (err) {
              if (seq !== verifySeq) return
              dropPin()
              set({ status: 'needs-code', confirmOnDesktop: null, error: toRemoteErrorInfo(err) })
              return
            }
          }
          set({ confirmOnDesktop: null })
          patchConnection({ pairedAt: now() })
          const client = current()
          if (client) await bootstrap(client, seq)
        }

        /**
         * Den festgenagelten Desktop wiederfinden: WLAN, dann Adressauskunft
         * (ausgeschaltet bis Web liefert), dann die letzte Tunnel-Adresse. Die
         * erste Adresse, deren Status den Kanal anbietet, wird genommen. Bietet
         * ein Status ihn nicht an, wird NICHT auf Klartext zurueckgefallen
         * (M2): die Adresse zaehlt nicht, und am Ende steht ein ehrlicher Fehler.
         */
        async function resumeSealed(seq: number): Promise<void> {
          const c = get().connection
          const pin = c?.pin
          if (!c || !pin) return
          if (!deps.sealed) throw new RemoteUpdateDesktopError('this app cannot open the sealed channel')
          const lookedUp = deps.lookupFetch ? await lookupDesktopAddress(pin.desktopId, { fetch: deps.lookupFetch }) : null
          if (seq !== verifySeq) return
          let refusal: RemoteError | null = null
          /** Eine Adresse gab 404 auf Status oder Kanal: veraltet, nicht "zu alt" (R55). */
          let stale: RemoteStaleAddressError | null = staleCause
          staleCause = null
          lanSilent = false
          /** Das WLAN antwortete gar nicht (nicht: abgewiesen). */
          let wifiSilent = false
          const candidates = candidateAddresses(pin, lookedUp)
          for (const [i, address] of candidates.entries()) {
            // Ist danach noch ein Weg ueber das Internet bekannt, bekommt das WLAN nur einen Vorsprung.
            const headStart = isWifi(address) && candidates.slice(i + 1).some((a) => !isWifi(a)) ? (deps.wifiHeadStartMs ?? 3_000) : undefined
            const st = await readStatus(address, headStart)
            if (seq !== verifySeq) return
            if (st === 'silent') {
              if (isWifi(address)) wifiSilent = true
              continue
            }
            if (st === 'gone') {
              stale = new RemoteStaleAddressError(isInternet(address), 'status 404')
              forgetStaleTunnel(address)
              continue
            }
            if (!st) continue
            const choice = chooseChannel({ route: routeOf(address), features: st.features, pinned: true })
            if (choice.kind !== 'sealed') {
              refusal = choice.kind === 'refuse' ? choice.error : refusal
              continue
            }
            const known = get().connection?.pin ?? pin
            if (wifiSilent && !isWifi(address)) await noteLanSilent()
            if (seq !== verifySeq) return
            patchConnection({
              via: address,
              pin: { ...known, ...(isWifi(address) ? { lan: address } : { tunnel: address }) },
            })
            const client = current()
            if (!client) return
            try {
              await bootstrap(client, seq)
            } catch (err) {
              if (!(err instanceof RemoteStaleAddressError) || seq !== verifySeq) throw err
              // Der Status antwortete, der Kanal nicht: die naechste Adresse versuchen.
              stale = err
              forgetStaleTunnel(address)
              continue
            }
            return
          }
          const tunnelOnly = isInternet(pin.tunnel ?? c.baseUrl) && !pin.lan
          throw (
            refusal ??
            stale ??
            // Nichts kam durch, und das WLAN schwieg ganz: das ist meist die Firewall des Rechners.
            (wifiSilent ? new RemoteTimeoutError('no answer on Wi-Fi', { step: 'probe', call: 'GET /remote-api/status' }) : null) ??
            new RemoteUnreachableError(tunnelOnly, 'no address answered', tunnelOnly ? undefined : { step: 'probe', call: 'GET /remote-api/status', notWifi: isNotWifiAddress(pin.lan) })
          )
        }

        function current(): RemoteClient | null {
          const c = get().connection
          return c ? clientFor(c.baseUrl) : null
        }

        function patchConnection(patch: Partial<RemoteConnection>): void {
          const c = get().connection
          if (c) set({ connection: { ...c, ...patch } })
        }

        function patchChat(id: string, fn: (c: RemoteChat) => Partial<RemoteChat>): void {
          set((s) => ({
            chats: s.chats.map((c) => (c.id === id ? { ...c, ...fn(c), updatedAt: now() } : c)),
          }))
        }

        function patchMessage(chatId: string, messageId: string, patch: Partial<RemoteMessage>): void {
          set((s) => ({
            chats: s.chats.map((c) =>
              c.id !== chatId
                ? c
                : { ...c, updatedAt: now(), messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) },
            ),
          }))
        }

        function dropToken(): void {
          set({ token: '' })
          void vault.clear().catch(() => {})
        }

        /** Einen Fehler aus einem beliebigen Aufruf in den Verbindungszustand uebersetzen. */
        /**
         * `research`: eine veraltete Adresse (404 unter der bekannten Adresse eines
         * gekoppelten Desktops) loest genau eine neue Suche aus (WLAN, Auskunft,
         * letzte Tunnel-Adresse). Die Suche selbst ruft mit false, so gibt es keine Schleife.
         */
        function applyConnectionError(err: unknown, research = true): RemoteErrorInfo {
          const info = toRemoteErrorInfo(err)
          if (err instanceof RemoteStaleAddressError) {
            set({ status: 'offline', error: info })
            const c = get().connection
            if (c?.via) forgetStaleTunnel(c.via)
            if (research && c?.pin) {
              staleCause = err
              queueMicrotask(() => void get().verifyConnection())
            }
            return info
          }
          if (err instanceof RemoteSessionExpiredError) {
            dropToken()
            set({ status: 'needs-code', error: info })
          } else if (err instanceof RemoteUnpairedError) {
            // Der Desktop kennt dieses Handy nicht mehr: neu koppeln.
            dropPin()
            set({ status: 'needs-code', error: info })
          } else if (err instanceof RemoteError && (err.code === 'new-key' || err.code === 'downgrade' || err.code === 'update-desktop')) {
            set({ status: 'offline', error: info })
          } else if (err instanceof RemoteMemoryRevokedError) {
            set({ status: 'blocked', error: info })
          } else if (err instanceof RemoteUnreachableError || err instanceof RemoteTimeoutError) {
            set({ status: 'offline', error: info })
          } else if (err instanceof RemoteError && err.code === 'not-lu') {
            set({ status: 'offline', error: info })
          }
          return info
        }

        function defaultModel(): string {
          const { hostConfig, models } = get()
          if (hostConfig?.model && (models.length === 0 || models.includes(hostConfig.model))) return hostConfig.model
          return models[0] ?? ''
        }

        /** Nach gelungener Anmeldung: Konfiguration, Modelle, Rechte holen. */
        /** Ein Aufruf eines Schritts im WLAN: antwortet er nicht, nennt der Fehler Schritt und Aufruf (A17). */
        function stepCall<T>(p: Promise<T>, step: PairStep, call: string, address: string): Promise<T> {
          if (!isWifi(address) && !isNotWifiAddress(address)) return p
          return p.catch((err: unknown) => {
            throw atPairStep(err, { step, call, notWifi: isNotWifiAddress(address) })
          })
        }

        async function bootstrap(client: RemoteClient, seq: number): Promise<void> {
          const at = get().connection?.via ?? client.baseUrl
          const [session, hostConfig, models, permissions] = await Promise.all([
            stepCall(client.checkSession(), 'bootstrap', 'GET /remote-api/status/full', at),
            stepCall(client.getConfig(), 'bootstrap', 'GET /remote-api/config', at),
            stepCall(client.listModels(), 'bootstrap', 'GET /api/tags', at),
            stepCall(client.getPermissions(), 'bootstrap', 'GET /remote-api/permissions', at),
          ])
          if (seq !== verifySeq || get().connection?.baseUrl !== client.baseUrl) return
          // Faehigkeiten nur aus dem Kanal: ueber den alten Weg bietet die App weder Create noch Anmeldung an.
          const features = get().connection?.pin ? session.features : []
          // Der Desktop sagt selbst, dass sein WLAN gesperrt ist, oder es schwieg in diesem Lauf.
          const lanBlocked = session.lanBlocked || lanSilent
          set({ hostConfig, models, permissions, features, lanBlocked, status: 'connected', error: null, retryAt: null })
          patchConnection({ lastOkAt: now(), serverVersion: session.version, hostName: session.hostName })
          // Ein Chat DIESES Desktops, dessen Modell es dort nicht mehr gibt, bekommt das
          // Standardmodell. Chats anderer Desktops behalten, was sie hatten.
          const fallback = defaultModel()
          if (fallback) {
            set((s) => ({
              chats: s.chats.map((c) =>
                (c.baseUrl === null || c.baseUrl === client.baseUrl) && (!c.model || (models.length > 0 && !models.includes(c.model))) ? { ...c, model: fallback } : c,
              ),
            }))
          }
        }

        function apiMessages(chat: RemoteChat): RemoteApiMessage[] {
          const out: RemoteApiMessage[] = []
          const hostConfig = get().hostConfig
          const system = buildRemoteSystemPrompt({
            caveman: chat.caveman,
            persona: chat.systemPrompt,
            desktopPrompt: hostConfig?.systemPrompt ?? '',
            agent: chat.agentMode,
            platformLine: hostConfig?.platformLine ?? '',
            now: new Date(now()),
            shareClock: hostConfig?.shareClock !== false,
          })
          if (system) out.push({ role: 'system', content: system })
          const reminder = cavemanReminder(chat.caveman)
          for (const m of chat.messages) {
            // Leere Antworten (abgebrochen, bevor etwas kam) gehoeren nicht in den Verlauf.
            if (m.role === 'assistant' && !m.content) continue
            if (m.role === 'assistant') {
              out.push({ role: 'assistant', content: m.content })
              continue
            }
            const content = reminder ? `${reminder}\n${m.content}` : m.content
            const data = imageData.get(m.id)
            if (data && data.length > 0) {
              out.push({ role: 'user', content, images: [...data] })
            } else if (m.images && m.images.length > 0) {
              // Das Bild hat das Modell gesehen, als es antwortete. Die Daten sind seit einem Neustart weg.
              out.push({ role: 'user', content: `${content}\n[${m.images.length} image(s) from an earlier message omitted]` })
            } else {
              out.push({ role: 'user', content })
            }
          }
          // Nur die neuesten Nachrichten mit Bildern schicken sie erneut, wie auf der Webseite.
          dropOldImages(out, IMAGE_KEEP_RECENT)
          return out
        }

        /** Gehoert der Chat dem verbundenen Desktop? Ein Chat ohne Angabe wird ihm jetzt zugeordnet. */
        function claimChat(chatId: string): boolean {
          const chat = get().chats.find((c) => c.id === chatId)
          const baseUrl = get().connection?.baseUrl
          if (!chat || !baseUrl) return false
          if (chat.baseUrl === baseUrl) return true
          if (chat.baseUrl !== null) return false
          set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? { ...c, baseUrl } : c)) }))
          return true
        }

        function autoTitle(chatId: string): void {
          const chat = get().chats.find((c) => c.id === chatId)
          if (!chat || chat.title !== NEW_CHAT_TITLE) return
          const first = chat.messages.find((m) => m.role === 'user')
          const title = first?.content.replace(/\s+/g, ' ').trim().slice(0, 32) || (first?.images?.length ? 'Photo' : '')
          if (title) patchChat(chatId, () => ({ title }))
        }

        /**
         * Einen Lauf von aussen beenden: Zustand der Nachricht sofort setzen,
         * Lauf abkoppeln, dann erst abbrechen. Die Reihenfolge zaehlt: nach
         * dieser Funktion kann die App eingefroren werden, und was dann nicht
         * im Zustand steht, wird nicht mehr geschrieben.
         */
        function endRun(state: 'stopped' | 'interrupted'): boolean {
          const run = activeRun
          if (!run) return false
          activeRun = null
          const chat = get().chats.find((c) => c.id === run.chatId)
          const last = chat?.messages.at(-1)
          if (chat && last && last.role === 'assistant' && last.state === 'pending') {
            // Ein Werkzeugschritt, der gerade lief, ist nicht fertig geworden.
            const steps = last.steps?.map((step) => (step.state === 'running' ? { ...step, state: 'failed' as const } : step))
            patchMessage(chat.id, last.id, steps ? { state, steps } : { state })
          }
          set({ streamingChatId: null })
          run.ctrl.abort()
          return true
        }

        /**
         * Den Verlauf ab einer Nachricht neu aufrollen. `role` sagt, welche
         * Nachricht gemeint ist: bei 'assistant' die Antwort (die Frage davor
         * wird erneut gestellt), bei 'user' die Frage selbst, mit neuem Text.
         * Geprueft wird alles, bevor etwas wegfaellt: ein Nein laesst den
         * Verlauf, wie er war.
         */
        async function resendFrom(chatId: string, messageId: string, role: 'assistant' | 'user', text?: string): Promise<SendOutcome> {
          const s = get()
          if (s.streamingChatId || activeRun) return 'busy'
          if (s.status !== 'connected' || !current()) return 'not-connected'
          const chat = s.chats.find((c) => c.id === chatId)
          if (!chat) return 'no-chat'
          if (chat.baseUrl !== null && chat.baseUrl !== s.connection?.baseUrl) return 'other-desktop'
          const at = chat.messages.findIndex((m) => m.id === messageId)
          if (at < 0 || chat.messages[at].role !== role) return 'empty'
          const askedAt = role === 'assistant' ? at - 1 : at
          const asked = chat.messages[askedAt]
          if (!asked || asked.role !== 'user') return 'empty'
          const body = role === 'user' ? (text ?? '').trim() : asked.content
          const hasImages = !!asked.images && asked.images.length > 0
          if (role === 'user' && !body && !hasImages) return 'empty'
          if (!chat.model) return 'no-model'
          // Ohne die Bilddaten waere es eine andere Frage (siehe retryLast).
          if (hasImages && !imageData.has(asked.id)) return 'images-lost'
          if (!claimChat(chatId)) return 'no-chat'
          patchChat(chatId, (c) => ({
            messages: c.messages.slice(0, askedAt + 1).map((m, i) =>
              // Eine geaenderte Frage ist fuer den Desktop-Chat eine neue: sie wird wieder gespiegelt.
              i === askedAt && role === 'user' && m.content !== body ? { ...m, content: body, mirrored: false } : m,
            ),
          }))
          return runTurn(chatId)
        }

        /** Antwort fuer den Chat anfordern. Erwartet, dass die letzte Nachricht vom Nutzer ist. */
        async function runTurn(chatId: string): Promise<SendOutcome> {
          const client = current()
          const chat = get().chats.find((c) => c.id === chatId)
          if (!client || !chat) return 'no-chat'

          // Die Frage in den Desktop-Chat spiegeln, falls das noch nicht
          // gelungen ist. Bei einem Senden mit abgelaufener Sitzung scheitert
          // es, und der zweite Versuch nach dem Koppeln holt es hier nach.
          const asked = chat.messages.at(-1)
          if (asked && asked.role === 'user' && !asked.mirrored) {
            void client
              .postChatEvent({ role: 'user', content: asked.content, model: chat.model, chatId, chatTitle: get().chats.find((c) => c.id === chatId)?.title ?? chat.title })
              .then((ok) => {
                if (ok) patchMessage(chatId, asked.id, { mirrored: true })
              })
          }

          const messages = apiMessages(chat)
          const reply: RemoteMessage = {
            id: uid('m'),
            role: 'assistant',
            content: '',
            thinking: '',
            createdAt: now(),
            state: 'pending',
          }
          patchChat(chatId, (c) => ({ messages: [...c.messages, reply] }))

          const run = { ctrl: new AbortController(), chatId }
          activeRun = run
          set({ streamingChatId: chatId })
          const mine = () => activeRun === run
          const patch = (p: Partial<RemoteMessage>) => {
            if (mine()) patchMessage(chatId, reply.id, p)
          }

          const mirrorAnswer = (content: string) => {
            if (!content) return
            void client.postChatEvent({
              role: 'assistant',
              content,
              model: chat.model,
              chatId,
              chatTitle: get().chats.find((c) => c.id === chatId)?.title ?? '',
            })
          }

          try {
            if (chat.agentMode) {
              // Die Schalter des Desktops koennen sich seit dem Koppeln geaendert haben.
              const permissions = await client.getPermissions(run.ctrl.signal)
              if (!mine()) return 'sent'
              set({ permissions })
              const result = await runRemoteAgentLoop({
                client,
                model: chat.model,
                messages,
                tools: remoteToolsFor(permissions, get().connection?.pin ? get().features : []),
                createRunner: remoteCreateRunner(),
                chatId,
                think: resolveThinkFlag(chat.model, chat.thinkEnabled),
                keepThinking: chat.thinkEnabled,
                signal: run.ctrl.signal,
                stepId: () => uid('s'),
                onSteps: (steps) => patch({ steps }),
                onProgress: (p) => patch({ content: p.content, thinking: p.thinking }),
              })
              if (!mine()) return 'sent'
              const steps = result.steps.length > 0 ? { steps: result.steps } : {}
              if (result.end === 'no-tools') {
                patch({ state: 'failed', error: new RemoteToolsUnsupportedError().toInfo() })
              } else if (result.end === 'aborted') {
                patch({ content: result.content, thinking: result.thinking, ...steps, state: 'stopped' })
              } else {
                patch({
                  content: result.content,
                  thinking: result.thinking,
                  ...steps,
                  state: 'done',
                  ...(result.end === 'done' ? {} : { agentEnd: result.end }),
                })
                patchConnection({ lastOkAt: now() })
                mirrorAnswer(result.content)
              }
              return 'sent'
            }
            const result = await client.streamChat({
              model: chat.model,
              messages,
              think: resolveThinkFlag(chat.model, chat.thinkEnabled),
              keepThinking: chat.thinkEnabled,
              signal: run.ctrl.signal,
              onUpdate: (p) => patch({ content: p.content, thinking: p.thinking }),
            })
            if (!mine()) return 'sent'
            if (result.completed) {
              patch({ content: result.content, thinking: result.thinking, state: 'done' })
              patchConnection({ lastOkAt: now() })
              mirrorAnswer(result.content)
            } else {
              patch({ content: result.content, thinking: result.thinking, state: 'stopped' })
            }
          } catch (err) {
            if (!mine()) return 'sent'
            const info = applyConnectionError(err)
            if (err instanceof RemoteConnectionLostError) {
              patch({ content: err.partial.content, thinking: err.partial.thinking, state: 'interrupted', error: info })
              // Ob der Desktop noch da ist, weiss nach einem Abriss niemand.
              void get().verifyConnection()
            } else {
              patch({ state: 'failed', error: info })
            }
          } finally {
            if (mine()) {
              activeRun = null
              set({ streamingChatId: null })
            }
            // Eine fertige Antwort soll auf der Platte sein, bevor die
            // Oberflaeche den Lauf als beendet meldet.
            await persistStorage.flush()
          }
          return 'sent'
        }

        /**
         * QR-Code v2: koppeln ueber die WLAN-Adresse, sonst ueber den Tunnel.
         * Das Ticket wird erst verbraucht, wenn der Desktop es gesehen hat;
         * eine Adresse, die gar nicht antwortet, kostet es also nicht.
         */
        async function pairWithLink(target: PairingTarget): Promise<void> {
          const link = target.sealed
          if (!link) return
          endRun('stopped')
          const seq = ++verifySeq
          const previous = get().connection
          const sameDesktop = previous?.pin?.desktopId === link.desktopId
          if (!sameDesktop) dropToken()
          clientCache = null
          set({
            connection: {
              baseUrl: sameDesktop && previous ? previous.baseUrl : target.baseUrl,
              address: displayAddress(sameDesktop && previous ? previous.baseUrl : target.baseUrl),
              route: target.route,
              secure: target.secure,
              pairedAt: sameDesktop ? (previous?.pairedAt ?? null) : null,
              lastOkAt: sameDesktop ? (previous?.lastOkAt ?? null) : null,
              serverVersion: sameDesktop ? (previous?.serverVersion ?? '') : '',
              hostName: link.name,
              pin: null,
              via: null,
            },
            ...(sameDesktop ? {} : { hostConfig: null, models: [], permissions: null }),
            features: [],
            lanBlocked: false,
            pendingLink: null,
            error: null,
            retryAt: null,
            status: 'pairing',
            confirmOnDesktop: null,
          })
          if (!deps.sealed) {
            set({ status: 'needs-code', error: new RemoteUpdateDesktopError('this app cannot open the sealed channel').toInfo() })
            return
          }
          let lastError: unknown = null
          lanSilent = false
          let skipLan = false
          if (link.lan && link.tunnel) {
            // Mit Tunnel im QR-Code: erst kurz fragen, ob das WLAN antwortet. Schweigt es, gleich ueber
            // den Tunnel koppeln, statt den Zeitablauf abzuwarten (das Ticket gilt nur einmal: kein Wettlauf).
            const st = await readStatus(link.lan, deps.wifiHeadStartMs ?? 3_000)
            if (seq !== verifySeq) return
            if (st === 'silent') {
              skipLan = true
              await noteLanSilent()
              if (seq !== verifySeq) return
            }
          }
          for (const address of [skipLan ? null : link.lan, link.tunnel]) {
            if (!address) continue
            try {
              const outcome = await stepCall(
                sealedPair(deps.sealed.invoke, {
                  baseUrl: address,
                  link: link.uri,
                  deviceName: deps.sealed.deviceName?.(),
                }),
                'auth',
                'POST /remote-api/sealed (pair)',
                address,
              )
              if (seq !== verifySeq) return
              await finishSealedPairing(outcome, address, seq)
              return
            } catch (err) {
              if (seq !== verifySeq) return
              lastError = err
              if (err instanceof RemoteUnreachableError || err instanceof RemoteTimeoutError) continue
              // 404 unter dieser Adresse: das Ticket ist nicht verbraucht, die naechste Adresse des QR-Codes kann es noch.
              if (err instanceof RemoteError && err.code === 'scan-again' && err.detail === 'not_supported') continue
              break
            }
          }
          const info = toRemoteErrorInfo(lastError)
          set({ status: lastError instanceof RemoteUnreachableError || lastError instanceof RemoteTimeoutError ? 'offline' : 'needs-code', error: info, confirmOnDesktop: null })
        }

        // ── Zustand und Aktionen ─────────────────────────────────

        return {
          connection: null,
          chats: [],
          activeChatId: '',
          drafts: {},

          hydrated: false,
          status: 'unpaired',
          error: null,
          retryAt: null,
          token: '',
          hostConfig: null,
          models: [],
          permissions: null,
          streamingChatId: null,
          pendingLink: null,
          confirmOnDesktop: null,
          features: [],
          lanBlocked: false,

          desktopChannel: () => {
            const st = get()
            const pin = st.connection?.pin
            const address = st.connection?.via ?? st.connection?.baseUrl ?? null
            if (!deps.sealed || !pin || !address || st.status !== 'connected') return null
            return { fetch: sealedFetch, address, pin, invoke: deps.sealed.invoke, features: st.features }
          },

          offerLink: (input) => {
            const target = parsePairingInput(input)
            if (!target) return false
            set({ pendingLink: target })
            return true
          },

          dismissLink: () => set({ pendingLink: null }),

          connect: async (input, code) => {
            const target = parsePairingInput(input)
            if (!target) {
              set({ error: new RemoteInvalidAddressError(input.slice(0, 120)).toInfo() })
              return
            }
            if (target.sealed) {
              await pairWithLink(target)
              return
            }
            const previous = get().connection
            if (previous?.baseUrl !== target.baseUrl) {
              endRun('stopped')
              dropToken()
              set({
                connection: {
                  baseUrl: target.baseUrl,
                  address: displayAddress(target.baseUrl),
                  route: target.route,
                  secure: target.secure,
                  pairedAt: null,
                  lastOkAt: null,
                  serverVersion: '',
                  hostName: '',
                  pin: null,
                  via: null,
                },
                hostConfig: null,
                features: [],
                lanBlocked: false,
                models: [],
                permissions: null,
              })
            }
            set({ pendingLink: null, error: null, retryAt: null })
            await get().verifyConnection()
            const useCode = code ?? target.code
            // Nach einem Fehler der Pruefung (etwa "nur mit QR ueber das Internet") geht kein Code raus.
            if (useCode && get().status === 'needs-code' && !get().error) await get().submitCode(useCode)
          },

          submitCode: async (code) => {
            const client = current()
            if (!client) return
            const retryAt = get().retryAt
            if (retryAt && now() < retryAt) return
            const seq = ++verifySeq
            set({ status: 'pairing', error: null })
            if (!isWifi(client.baseUrl)) {
              // E2: ueber das Internet nie ein Code, weder alt noch versiegelt.
              set({ status: 'needs-code', error: new RemoteScanNeededError('code over the internet').toInfo() })
              return
            }
            const lanKey = codeStatus?.baseUrl === client.baseUrl ? codeStatus.status : null
            if (lanKey && deps.sealed && lanKey.desktopId && lanKey.x25519) {
              // Desktop 3.0.7 im WLAN: der Code ist das psk des Handschlags, danach der Vergleichscode.
              try {
                const outcome = await stepCall(
                  sealedPair(deps.sealed.invoke, {
                    baseUrl: client.baseUrl,
                    code,
                    desktopId: lanKey.desktopId,
                    x25519: lanKey.x25519,
                    deviceName: deps.sealed.deviceName?.(),
                  }),
                  'auth',
                  'POST /remote-api/sealed (pair with code)',
                  client.baseUrl,
                )
                if (seq !== verifySeq) return
                codeStatus = null
                await finishSealedPairing(outcome, client.baseUrl, seq)
              } catch (err) {
                if (seq !== verifySeq) return
                const info = toRemoteErrorInfo(err)
                set({
                  status: 'needs-code',
                  error: info,
                  confirmOnDesktop: null,
                  ...(info.code === 'rate-limited' ? { retryAt: now() + (info.retryAfterSeconds ?? 60) * 1000 } : {}),
                })
              }
              return
            }
            try {
              await stepCall(client.pair(code), 'auth', 'POST /remote-api/auth', client.baseUrl)
              patchConnection({ pairedAt: now() })
              await bootstrap(client, seq)
            } catch (err) {
              if (seq !== verifySeq) return
              const info = toRemoteErrorInfo(err)
              if (info.code === 'invalid-code') {
                set({ status: 'needs-code', error: info })
              } else if (info.code === 'rate-limited') {
                set({ status: 'needs-code', error: info, retryAt: now() + (info.retryAfterSeconds ?? 60) * 1000 })
              } else {
                set({ status: 'needs-code', error: info })
                applyConnectionError(err)
              }
            }
          },

          verifyConnection: async () => {
            const client = current()
            if (!client) {
              set({ status: 'unpaired' })
              return
            }
            const seq = ++verifySeq
            // Eine laufende Antwort nicht als "verbindet" ueberblenden.
            if (get().status !== 'connected') set({ status: 'connecting' })
            try {
              if (get().connection?.pin) {
                try {
                  await resumeSealed(seq)
                } catch (err) {
                  if (seq !== verifySeq) return
                  applyConnectionError(err, false)
                  if (get().status === 'connecting') set({ status: 'offline', error: toRemoteErrorInfo(err) })
                }
                return
              }
              const st = readDesktopStatus(await stepCall(statusClient(client.baseUrl).probe(), 'probe', 'GET /remote-api/status', client.baseUrl))
              if (seq !== verifySeq) return
              const choice = chooseChannel({ route: routeOf(client.baseUrl), features: st.features, pinned: false })
              codeStatus = null
              if (choice.kind === 'refuse') {
                const info = choice.error.toInfo()
                // A17: eine Hamachi- oder Tailscale-Adresse sieht fuer die App aus wie das Internet. Sie sagt, welche gemeint ist.
                set({ status: 'needs-code', error: isNotWifiAddress(client.baseUrl) ? { ...info, message: `${info.message} ${NOT_WIFI_TEXT}` } : info })
                return
              }
              if (choice.kind === 'pair-code') {
                if (!deps.sealed) {
                  // Ohne Kanal in dieser App nicht koppeln, nie Klartext an 3.0.7.
                  set({ status: 'needs-code', error: new RemoteUpdateDesktopError('this app cannot open the sealed channel').toInfo() })
                  return
                }
                if (!st.desktopId || !st.x25519) {
                  // H1: Schluessel und Name nennt der WLAN-Status nur bei offenem Kopplungsfenster.
                  // Ein neues Lesen (Try again, Rueckkehr in die App) holt sie, sobald es offen ist.
                  set({ status: 'needs-code', error: new RemoteOpenPairingError('no key in the Wi-Fi status').toInfo() })
                  return
                }
                codeStatus = { baseUrl: client.baseUrl, status: st }
                set({ status: 'needs-code', error: null })
                return
              }
              if (!get().token) {
                set({ status: 'needs-code', error: null })
                return
              }
              await bootstrap(client, seq)
            } catch (err) {
              if (seq !== verifySeq) return
              applyConnectionError(err)
              // Alles, was applyConnectionError nicht einordnet, laesst den Desktop als nicht nutzbar zurueck.
              if (get().status === 'connecting') set({ status: 'offline', error: toRemoteErrorInfo(err) })
            }
          },

          keepalive: async () => {
            const client = current()
            if (!client || get().status !== 'connected' || !authed()) return
            try {
              await client.checkSession()
              patchConnection({ lastOkAt: now() })
            } catch (err) {
              // Ein verpasstes Lebenszeichen ist kein Ereignis. Ein abgelaufenes
              // Token schon: dann stimmt die Anzeige "verbunden" nicht mehr.
              if (err instanceof RemoteSessionExpiredError || err instanceof RemoteMemoryRevokedError) applyConnectionError(err)
            }
          },

          refreshModels: async () => {
            const client = current()
            if (!client || !authed()) return
            try {
              const models = await client.listModels()
              if (get().connection?.baseUrl === client.baseUrl) set({ models })
            } catch (err) {
              applyConnectionError(err)
            }
          },

          disconnect: async () => {
            endRun('stopped')
            verifySeq += 1
            const client = current()
            const pin = get().connection?.pin
            if (pin) {
              // Entkoppeln: der Desktop streicht dieses Handy (wenn erreichbar), der Nagel faellt weg.
              if (deps.sealed) await sealedForget(deps.sealed.invoke, pin, get().connection?.via ?? null)
              dropPin()
            } else if (client && get().token) {
              // Am Desktop abmelden, damit das Token dort sofort wertlos ist.
              // Gelingt das nicht, laeuft es von selbst ab.
              try {
                await client.disconnect()
              } catch {
                /* bestmoeglich */
              }
            }
            dropToken()
            set({ status: get().connection ? 'needs-code' : 'unpaired', error: null, retryAt: null, permissions: null, confirmOnDesktop: null, features: [], lanBlocked: false })
            await persistStorage.flush()
          },

          forget: async () => {
            await get().disconnect()
            clientCache = null
            set({ connection: null, status: 'unpaired', hostConfig: null, models: [], pendingLink: null, lanBlocked: false })
            await persistStorage.flush()
          },

          clearError: () => set({ error: null }),

          newChat: () => {
            const t = now()
            const chat: RemoteChat = {
              id: uid('c'),
              title: NEW_CHAT_TITLE,
              model: defaultModel(),
              thinkEnabled: false,
              systemPrompt: null,
              agentMode: false,
              caveman: 'off',
              baseUrl: get().connection?.baseUrl ?? null,
              createdAt: t,
              updatedAt: t,
              messages: [],
            }
            set((s) => ({ chats: [chat, ...s.chats], activeChatId: chat.id }))
            return chat.id
          },

          selectChat: (id) => {
            if (get().chats.some((c) => c.id === id)) set({ activeChatId: id })
          },

          deleteChat: (id) => {
            if (activeRun?.chatId === id) endRun('stopped')
            for (const m of get().chats.find((c) => c.id === id)?.messages ?? []) imageData.delete(m.id)
            set((s) => {
              const chats = s.chats.filter((c) => c.id !== id)
              const drafts = { ...s.drafts }
              delete drafts[id]
              return { chats, drafts, activeChatId: s.activeChatId === id ? (chats[0]?.id ?? '') : s.activeChatId }
            })
          },

          renameChat: (id, title) => {
            const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80)
            if (clean) patchChat(id, () => ({ title: clean }))
          },

          setChatModel: (id, model) => patchChat(id, () => ({ model })),
          setThinkEnabled: (id, on) => patchChat(id, () => ({ thinkEnabled: on })),
          setSystemPrompt: (id, prompt) => patchChat(id, () => ({ systemPrompt: prompt })),
          setAgentMode: (id, on) => patchChat(id, () => ({ agentMode: on })),
          setCaveman: (id, level) => patchChat(id, () => ({ caveman: isCavemanLevel(level) ? level : 'off' })),

          setDraft: (chatId, text) => {
            set((s) => {
              const drafts = { ...s.drafts }
              if (text) drafts[chatId] = text
              else delete drafts[chatId]
              return { drafts }
            })
          },

          sendMessage: async (text, options) => {
            const s = get()
            if (s.streamingChatId || activeRun) return 'busy'
            if (s.status !== 'connected' || !current()) return 'not-connected'
            const known = s.chats.find((c) => c.id === s.activeChatId)
            // Ein Chat eines anderen Desktops wird hier nicht fortgesetzt und auch nicht still ersetzt.
            if (known && known.baseUrl !== null && known.baseUrl !== s.connection?.baseUrl) return 'other-desktop'
            const images = (options?.images ?? []).filter((image) => typeof image.data === 'string' && image.data.length > 0).slice(0, MAX_REMOTE_IMAGES)
            const typed = (text ?? s.drafts[known?.id ?? ''] ?? s.drafts[''] ?? '').trim()
            if (!typed && images.length === 0) return 'empty'
            const chatId = known ? known.id : get().newChat()
            const body = typed
            if (!claimChat(chatId)) return 'no-chat'
            let chat = get().chats.find((c) => c.id === chatId)
            if (!chat) return 'no-chat'
            if (!chat.model) {
              const fallback = defaultModel()
              if (!fallback) return 'no-model'
              patchChat(chatId, () => ({ model: fallback }))
              chat = get().chats.find((c) => c.id === chatId)!
            }

            const user: RemoteMessage = {
              id: uid('m'),
              role: 'user',
              content: body,
              thinking: '',
              createdAt: now(),
              state: 'done',
              mirrored: false,
              ...(images.length > 0 ? { images: sanitizeImages(images) } : {}),
            }
            if (images.length > 0) imageData.set(user.id, images.map((image) => image.data))
            patchChat(chatId, (c) => ({ messages: [...c.messages, user] }))
            // Der Entwurf verschwindet erst, wenn die Nachricht im Verlauf steht.
            get().setDraft(chatId, '')
            get().setDraft('', '')
            autoTitle(chatId)
            return runTurn(chatId)
          },

          retryLast: async (chatId) => {
            const s = get()
            if (s.streamingChatId || activeRun) return 'busy'
            if (s.status !== 'connected' || !current()) return 'not-connected'
            const id = chatId ?? s.activeChatId
            const chat = s.chats.find((c) => c.id === id)
            if (!chat) return 'no-chat'
            if (chat.baseUrl !== null && chat.baseUrl !== s.connection?.baseUrl) return 'other-desktop'
            const last = chat.messages.at(-1)
            if (!last) return 'empty'
            if (last.role === 'assistant' && last.state === 'done') return 'empty'
            const asked = last.role === 'assistant' ? chat.messages.at(-2) : last
            if (!asked || asked.role !== 'user') return 'empty'
            if (!chat.model) return 'no-model'
            // Die Frage trug Bilder, und die Daten dafuer gibt es seit einem Neustart nicht mehr:
            // ohne sie waere es eine andere Frage. Die Antwort bleibt stehen, der Aufrufer sagt es.
            if (asked.images && asked.images.length > 0 && !imageData.has(asked.id)) return 'images-lost'
            if (!claimChat(id)) return 'no-chat'
            if (last.role === 'assistant') patchChat(id, (c) => ({ messages: c.messages.slice(0, -1) }))
            return runTurn(id)
          },

          regenerate: (chatId, messageId) => resendFrom(chatId, messageId, 'assistant'),

          editAndResend: (chatId, messageId, text) => resendFrom(chatId, messageId, 'user', text),

          stopStreaming: () => {
            if (endRun('stopped')) void persistStorage.flush()
          },

          handleBackground: async () => {
            endRun('interrupted')
            await persistStorage.flush()
          },

          handleForeground: async () => {
            if (get().hydrated && get().connection) await get().verifyConnection()
          },
        }
      },
      {
        name,
        version: 1,
        storage: persistStorage,
        partialize: (s): Persisted => ({
          // Nur ein Desktop, der je funktioniert hat. Ein laufender oder gescheiterter Versuch lebt im Speicher.
          connection: connectionEverWorked(s.connection) ? s.connection : null,
          chats: s.chats,
          activeChatId: s.activeChatId,
          drafts: s.drafts,
        }),
        // Ein Speicher, dessen Lesen scheitert, meldet das hier und nirgends
        // sonst. Die Oberflaeche soll dann trotzdem bedienbar werden.
        onRehydrateStorage: () => (_state, error) => {
          if (error) queueMicrotask(() => void finishHydration())
        },
        merge: (persisted, currentState) => {
          const p = (persisted ?? {}) as Partial<Persisted>
          // Ein Eintrag, der nie funktioniert hat, ist ein gescheiterter Versuch einer aelteren Version: nicht laden.
          const connection =
            p.connection && typeof p.connection.baseUrl === 'string' && connectionEverWorked(p.connection)
              ? {
                  ...p.connection,
                  hostName: typeof p.connection.hostName === 'string' ? p.connection.hostName : '',
                  pin: sanitizePin(p.connection.pin),
                  via: typeof p.connection.via === 'string' ? p.connection.via : null,
                }
              : null
          const chats = sanitizeChats(p.chats, connection?.baseUrl ?? null)
          return {
            ...currentState,
            connection,
            chats,
            activeChatId: chats.some((c) => c.id === p.activeChatId) ? (p.activeChatId as string) : (chats[0]?.id ?? ''),
            drafts: p.drafts && typeof p.drafts === 'object' ? p.drafts : {},
          }
        },
      },
    ),
  )

  // Nach dem Laden des Zustands das Token holen. Erst danach ist der Store
  // "hydrated", und erst danach darf geschrieben werden.
  let hydrationStarted = false
  async function finishHydration(): Promise<void> {
    if (hydrationStarted) return
    hydrationStarted = true
    const connection = useStore.getState().connection
    let token = ''
    if (connection) {
      try {
        token = (await vault.load(connection.baseUrl)) ?? ''
      } catch {
        token = ''
      }
    }
    hydratedFlag = true
    useStore.setState({
      token,
      hydrated: true,
      status: connection ? (token || connection.pin ? 'connecting' : 'needs-code') : 'unpaired',
    })
    markReady()
    if (connection && deps.autoResume !== false) void useStore.getState().verifyConnection()
  }

  if (useStore.persist.hasHydrated()) void finishHydration()
  else useStore.persist.onFinishHydration(() => void finishHydration())

  function attachLifecycle(env: LifecycleEnv = {}): () => void {
    const win = env.window ?? (typeof window !== 'undefined' ? window : undefined)
    const doc = env.document ?? (typeof document !== 'undefined' ? document : undefined)
    const startTimer = env.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
    const stopTimer = env.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))

    const onHide = () => {
      void useStore.getState().handleBackground()
    }
    const onVisibility = () => {
      if (!doc) return
      if (doc.visibilityState === 'hidden') onHide()
      else if (doc.visibilityState === 'visible') void useStore.getState().handleForeground()
    }
    win?.addEventListener('pagehide', onHide)
    doc?.addEventListener('visibilitychange', onVisibility)
    const timer = startTimer(() => {
      if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return
      void useStore.getState().keepalive()
    }, KEEPALIVE_INTERVAL_MS)

    return () => {
      win?.removeEventListener('pagehide', onHide)
      doc?.removeEventListener('visibilitychange', onVisibility)
      stopTimer(timer)
    }
  }

  return { useStore, ready, flush: () => persistStorage.flush(), attachLifecycle }
}

// ── Die eine Instanz der App ─────────────────────────────────────

let defaultStore: RemoteClientStore | null = null

/**
 * Die Instanz, die die Mobile-Shell benutzt. Wird beim ersten Zugriff
 * angelegt, nicht beim Import, damit ein Import allein weder IndexedDB
 * oeffnet noch ins Netz geht. Der Transport muss VOR dem ersten Zugriff
 * gesetzt sein, siehe `configureRemoteClientStore`.
 */
export function getRemoteClientStore(): RemoteClientStore {
  if (!defaultStore) defaultStore = createRemoteClientStore(defaultDeps)
  return defaultStore
}

let defaultDeps: RemoteClientStoreDeps = {}

/** Transport und Token-Ablage der App-Instanz festlegen. Nur vor dem ersten Zugriff wirksam. */
export function configureRemoteClientStore(deps: RemoteClientStoreDeps): void {
  if (defaultStore) throw new Error('configureRemoteClientStore must run before the store is first used')
  defaultDeps = deps
}

/** Hook fuer Komponenten: `useRemoteClientStore((s) => s.status)`. */
export function useRemoteClientStore<T>(selector: (state: RemoteClientState) => T): T {
  return getRemoteClientStore().useStore(selector)
}
