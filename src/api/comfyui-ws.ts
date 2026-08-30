/**
 * ComfyUI WebSocket client for real-time generation progress.
 *
 * Connects to ws://localhost:8188/ws and provides events for:
 * - Model loading (CheckpointLoaderSimple, UNETLoader, CLIPLoader, VAELoader)
 * - Sampling progress (KSampler step value/max)
 * - Execution completion / errors
 */

import { v4 as uuid } from 'uuid'
import { log } from '../lib/logger'
import { comfyuiWsUrl, isTauri } from './backend'

export type ComfyWSEvent =
  | { type: 'status'; data: { queue_remaining: number } }
  | { type: 'execution_start'; data: { prompt_id: string } }
  | { type: 'executing'; data: { node: string | null; prompt_id: string } }
  | { type: 'progress'; data: { value: number; max: number; prompt_id: string } }
  | { type: 'executed'; data: { node: string; prompt_id: string } }
  | { type: 'execution_complete'; data: { prompt_id: string } }
  | { type: 'execution_error'; data: { prompt_id: string; exception_message?: string; node_type?: string } }
  | { type: 'execution_cached'; data: { prompt_id: string; nodes: string[] } }

export type ComfyWSListener = (event: ComfyWSEvent) => void

// Loader node class types that indicate model loading. The GGUF loaders must
// be here too: without them a GGUF video run never shows "Loading model" and
// sits on "Queued" until the first sampling event (David 2026-08-02).
export const LOADER_NODES = new Set([
  'CheckpointLoaderSimple', 'UNETLoader', 'CheckpointLoader',
  'UnetLoaderGGUF', 'UnetLoaderGGUFAdvanced',
])
export const CLIP_LOADER_NODES = new Set([
  'CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader', 'CLIPVisionLoader',
])
export const VAE_LOADER_NODES = new Set([
  'VAELoader',
])
export const SAMPLER_NODES = new Set([
  'KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced',
])
export const DECODE_NODES = new Set([
  'VAEDecode', 'VAEDecodeTiled',
])

/** Every LU submission carries a client id with this prefix, so a later LU
 *  session can recognise a dead session's job in ComfyUI's queue and clean it
 *  up (G19-3: a killed app left its render burning the GPU, queued four deep).
 *  Foreign clients (a user's own ComfyUI tab) never carry it. */
export const LU_CLIENT_PREFIX = 'lu-'

/** Shared client ID used for both WS connection and workflow submission */
export const CLIENT_ID = `${LU_CLIENT_PREFIX}${uuid()}`

/**
 * How many frames the replay buffer keeps.
 *
 * A render's own events are a handful (`execution_start`, one `executing` per
 * node, one `progress` per step, `execution_complete`), so the only way to
 * push a run's opening events out of a 400 entry window is a long sampling run
 * whose steps have already been seen. Which is exactly when nothing needs
 * replaying.
 */
export const WS_REPLAY_BUFFER = 400

class ComfyWSClient {
  private ws: WebSocket | null = null
  private listeners = new Set<ComfyWSListener>()
  /** The last frames that came in, newest last, for `on(listener, since)`. */
  private buffer: { seq: number; event: ComfyWSEvent }[] = []
  private seq = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private _connected = false
  private connectPromise: Promise<void> | null = null
  private tauriListenersReady: Promise<void> | null = null

  get connected() { return this._connected }

  /**
   * Connect and return a promise that resolves when the WS is open.
   *
   * Desktop (Tauri) connects through the Rust WS proxy instead of a raw
   * browser WebSocket: ComfyUI 0.19+ rejects the WebView's cross-origin
   * upgrade from http://tauri.localhost unless the user passes
   * `--enable-cors-header`, which silently killed the live progress bar.
   * Rust's client handshake carries no Origin header, so it always passes —
   * same reason all ComfyUI HTTP already goes through the Rust proxy.
   * The web build keeps the raw WebSocket (Vite dev proxy / same-origin).
   */
  connect(timeoutMs = 3000): Promise<void> {
    if (this._connected && (isTauri() || this.ws?.readyState === WebSocket.OPEN)) {
      return Promise.resolve()
    }
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = isTauri() ? this.connectViaProxy() : this.connectRaw(timeoutMs)
    return this.connectPromise
  }

  /** Tauri: open the socket Rust-side; resolve = onopen, reject = onerror. */
  private async connectViaProxy(): Promise<void> {
    try {
      await this.ensureTauriListeners()
      const { invoke } = await import('@tauri-apps/api/core')
      // Rust settles within 5s (internal handshake timeout), so no extra
      // JS-side timer is needed — the promise can never hang (see the
      // onerror comment below for why settling is critical).
      await invoke('comfy_ws_connect', { clientId: CLIENT_ID })
      this._connected = true
      this.reconnectDelay = 1000
      log.info('[ComfyWS] Connected (Rust proxy)')
    } catch (e) {
      // Raw path gets its retry loop from onclose firing after onerror;
      // mirror that here so a down ComfyUI keeps the same backoff-retry.
      this.scheduleReconnect()
      throw new Error(`WebSocket connection error: ${e}`)
    } finally {
      this.connectPromise = null
    }
  }

  /** One-time registration of the Tauri event bridge for proxied frames. */
  private ensureTauriListeners(): Promise<void> {
    if (this.tauriListenersReady) return this.tauriListenersReady
    this.tauriListenersReady = (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<string>('comfy-ws-message', (ev) => {
        try {
          const msg = JSON.parse(ev.payload)
          if (msg.type && msg.data) this.dispatch(msg as ComfyWSEvent)
        } catch { /* ignore non-JSON messages */ }
      })
      await listen('comfy-ws-closed', () => {
        // Upstream socket died (ComfyUI stopped/restarted) — mirror onclose.
        if (!this._connected) return
        this._connected = false
        this.scheduleReconnect()
      })
    })()
    // If registration itself fails, allow a retry on the next connect()
    this.tauriListenersReady.catch(() => { this.tauriListenersReady = null })
    return this.tauriListenersReady
  }

  /** Web build: raw browser WebSocket (unchanged legacy path). */
  private connectRaw(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectPromise = null
        reject(new Error('WebSocket connect timeout'))
      }, timeoutMs)

      try {
        this.ws = new WebSocket(`${comfyuiWsUrl()}?clientId=${CLIENT_ID}`)

        this.ws.onopen = () => {
          clearTimeout(timer)
          this._connected = true
          this.reconnectDelay = 1000
          this.connectPromise = null
          log.info('[ComfyWS] Connected')
          resolve()
        }

        this.ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data)
            if (msg.type && msg.data) this.dispatch(msg as ComfyWSEvent)
          } catch { /* ignore non-JSON messages */ }
        }

        this.ws.onclose = () => {
          this._connected = false
          this.ws = null
          this.connectPromise = null
          this.scheduleReconnect()
        }

        this.ws.onerror = () => {
          clearTimeout(timer)
          this._connected = false
          this.connectPromise = null
          // CRITICAL: reject so callers don't hang. A WS error fires onerror
          // and we clear the connect timeout above — if we don't reject here,
          // the connect() promise NEVER settles and `await comfyWS.connect()`
          // hangs forever. That's exactly what happened when ComfyUI was
          // started without `--enable-cors-header` (e.g. a user-run / external
          // ComfyUI, or the dev auto-starter): ComfyUI's origin-only CSRF
          // middleware rejects the WebView's cross-origin upgrade, the WS
          // errors, and image/video generation got stuck on "Submitting to
          // ComfyUI…" with no progress and no result. Rejecting lets useCreate
          // fall back to /history polling so the result still appears (it only
          // loses the live progress bar). onclose still fires after this and
          // schedules a reconnect; reject on a settled promise is a no-op.
          reject(new Error('WebSocket connection error'))
        }
      } catch {
        clearTimeout(timer)
        this.connectPromise = null
        reject(new Error('WebSocket creation failed'))
      }
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
      })
    }, this.reconnectDelay)
  }

  /** Hand one frame to everyone listening, and keep it for a late listener. */
  private dispatch(event: ComfyWSEvent) {
    this.buffer.push({ seq: ++this.seq, event })
    if (this.buffer.length > WS_REPLAY_BUFFER) {
      this.buffer.splice(0, this.buffer.length - WS_REPLAY_BUFFER)
    }
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /**
   * A token for "everything from here on", to be handed back to `on`.
   *
   * R16 Befund 1: a render's caller cannot register its listener until the
   * submit has told it which prompt id to filter on, and ComfyUI starts
   * executing the moment the submit lands. Marking before the submit and
   * replaying after it closes that window instead of hoping to win the race.
   */
  mark(): number {
    return this.seq
  }

  /**
   * Listen. With `since` from `mark()`, the frames that arrived in between are
   * handed over, in the order they came in.
   *
   * The replay runs in a microtask, not inline: a caller typically writes
   * `const off = comfyWS.on(...)` and its own teardown closes over `off`, so a
   * replayed completion or error delivered DURING the call would reach a
   * teardown whose `off` is not assigned yet. The microtask also means a
   * listener that is removed again straight away is never replayed to.
   */
  on(listener: ComfyWSListener, since?: number) {
    this.listeners.add(listener)
    if (typeof since === 'number') {
      const held = this.buffer.filter((b) => b.seq > since)
      if (held.length) {
        queueMicrotask(() => {
          if (!this.listeners.has(listener)) return
          for (const b of held) {
            if (!this.listeners.has(listener)) return
            listener(b.event)
          }
        })
      }
    }
    return () => { this.listeners.delete(listener) }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (isTauri()) {
      // Fire-and-forget: abort the Rust-side socket. Rust emits no close
      // event for a requested disconnect, so no reconnect gets scheduled.
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('comfy_ws_disconnect'))
        .catch(() => { /* app teardown — nothing to recover */ })
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
    this._connected = false
    this.connectPromise = null
  }
}

/** Singleton WebSocket client */
export const comfyWS = new ComfyWSClient()
