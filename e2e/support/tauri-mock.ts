/* eslint-disable @typescript-eslint/no-explicit-any -- this stub is serialized
   into the browser page and stands in for Tauri's untyped `invoke` bridge; the
   dynamic command args and the `window` globals are `any` by nature. */
/**
 * In-page Tauri bridge mock for the built-in-engine e2e (P3b).
 *
 * Injected with `page.addInitScript` BEFORE the app boots, so
 * `window.__TAURI_INTERNALS__` exists when `isTauri()` (src/api/backend.ts)
 * first runs. Every `invoke()` from `@tauri-apps/api/core` funnels into
 * `__TAURI_INTERNALS__.invoke`, so this router stands in for the whole Rust
 * command surface — no Ollama, no llama-server, no ComfyUI.
 *
 * The interesting part is chat streaming: `proxy_localhost_stream_chunked`
 * receives an `onChunk` Tauri Channel whose `onmessage` the app has already
 * wired to a ReadableStream. We push OpenAI-shaped SSE bytes through it, then
 * an empty chunk (Rust's EOF marker), exactly like the real proxy.
 */

export interface TauriMockOptions {
  /** Assistant text the mocked built-in engine "generates" for the first chat. */
  assistantReply: string
  /** Picker id of the bundled starter model the engine reports as loaded. */
  modelName: string
  /** Shape of the MLX media stack this machine reports. Omit for "set up". */
  mlx?: {
    engineInstalled?: boolean
    videoEngineInstalled?: boolean
    installedImages?: string[]
    installedVideos?: string[]
  }
  /**
   * Which OS the app should believe it is on. `isMacOS()` reads
   * navigator.platform/userAgent, so without this every spec silently inherits
   * the DEV MACHINE's platform — and Mac and Windows disagree about the whole
   * local Create surface (MLX vs ComfyUI). Specs that assert platform
   * behaviour must pin it; the default matches the historical CI target.
   */
  platform?: 'mac' | 'windows'
  /**
   * Deliver `assistantReply` as N separate SSE frames, `replyChunkDelayMs`
   * apart, instead of one. A real engine emits a frame per token, which is what
   * drives the once-per-animation-frame store flush in useChat — the path that
   * caused the 2.6.2 renderer Out of Memory. Omit for the historical
   * single-frame behaviour.
   */
  replyChunks?: number
  /** Gap between streamed frames. Default 0 (same macrotask burst). */
  replyChunkDelayMs?: number
  /**
   * Canned HuggingFace file tree served to `fetch_external` for exactly one
   * repo (the URL resolveHfGgufFiles queries). Lets the sharded-download flow
   * run against a byte-accurate snapshot of the real API with no network.
   */
  hfTree?: { repo: string; entries: Array<{ type: string; path: string; size: number }> }
  /**
   * Scripted agent turns for the Code / Agent ReAct loop. Turn N of the run is
   * answered by entry N; the last entry repeats once the script runs out (so a
   * text-only final entry ends the loop). Without this the mock answers every
   * turn with plain prose, which means the loop stops after one step and no
   * spec can drive the coding agent at all.
   *
   * Tool-call frames go out as OpenAI streaming deltas, the same shape the
   * built-in engine and every openai-compat backend emit, so the provider's
   * own accumulator is what the spec exercises.
   */
  agentTurns?: Array<{
    /** Prose for this turn, streamed as content deltas. */
    text?: string
    /** Tool calls for this turn, streamed as tool_call deltas. */
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  }>
  /** Canned file contents served to fs_read, keyed by path suffix. */
  files?: Record<string, string>
  /**
   * What Ollama's `/api/tags` reports as already installed. Omit for the
   * historical EMPTY answer, which is what makes a box look brand new.
   *
   * This is the difference between a first-time user and a returning one, and
   * the whole app reads it from this one endpoint: the onboarding model step
   * counts it, the model manager lists it, and the chat picker is filled from
   * it. A spec about "the user already has models" therefore cannot fake that
   * state anywhere else without testing a fiction.
   *
   * Order matters to a spec: nothing preselects for the user, so the model
   * store's own fallback takes the FIRST chat-capable entry. A spec that wants
   * to prove a pick really arrived has to pick a different one than that.
   */
  ollamaModels?: string[]
}

export const DEFAULT_ASSISTANT_REPLY = 'PONG_BUILTIN_OK the built-in engine answered.'
export const DEFAULT_MODEL_NAME = 'qwen2.5-0.5b-instruct-q4_k_m'

/**
 * The function body below is serialized and runs in the PAGE context — it must
 * be fully self-contained (no imports, no outer closure references except the
 * single `opts` argument Playwright forwards).
 */
export function tauriMockInit(opts: TauriMockOptions) {
  const w = window as any

  // Pin the platform BEFORE the app reads it. isMacOS() (api/backend.ts) tests
  // navigator.platform then userAgent; leaving them alone makes every spec's
  // verdict depend on whose laptop ran it.
  {
    const mac = opts.platform === 'mac'
    const platform = mac ? 'MacIntel' : 'Win32'
    const ua = mac
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    try {
      Object.defineProperty(navigator, 'platform', { get: () => platform, configurable: true })
      Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true })
    } catch {
      /* a locked-down navigator just means the host platform wins */
    }
  }

  const MODELS_DIR = '/tmp/lu-e2e/models'
  const modelFile = `${opts.modelName}.gguf`
  const modelPath = `${MODELS_DIR}/${modelFile}`

  // Filenames whose download the app kicked off — reported "complete" on the
  // very next `download_progress` poll so `awaitDownloadComplete` resolves fast.
  const startedDownloads = new Set<string>()

  // ENG-1 mirror: the ctx the "engine" is currently running with. Every
  // start/swap derives it from the injected tuning (0 = Rust default 8192),
  // and `bundled_engine_status` reports it back — exactly the loop the token
  // counter and the expert panel rely on.
  let engineCtx = 8192

  // ── MLX media surface (macOS local Create) ──────────────────────
  // Mirrors commands/mlx.rs + video.rs closely enough that specs can drive the
  // real install/generate flows. `opts.mlx` decides what the machine looks
  // like before the spec touches anything: a fresh Mac (nothing installed) or
  // a set-up one. Every install completes after MLX_INSTALL_POLLS polls, so a
  // spec can watch the panel go busy → done without arbitrary waits.
  const MLX_INSTALL_POLLS = 2
  const mlxImageCatalog = [
    { id: 'sd-turbo', name: 'SD Turbo', repo: 'stabilityai/sd-turbo', sizeGB: 2.6, minRamGB: 8, steps: 4, guidance: 0, defaultSize: 512, unfiltered: false, description: 'Fast 512px baseline.' },
    { id: 'realistic-vision-v51', name: 'Realistic Vision V5.1', repo: 'SG161222/Realistic_Vision_V5.1_noVAE', sizeGB: 4.4, minRamGB: 8, steps: 25, guidance: 7, defaultSize: 512, unfiltered: true, description: 'Photoreal, unfiltered.' },
  ]
  const mlxVideoCatalog = [
    { id: 'wan21-t2v-1.3b', name: 'Wan 2.1 T2V 1.3B', family: 'wan_2', repo: 'Wan-AI/Wan2.1-T2V-1.3B', sizeGB: 18, minRamGB: 16, defaultFrames: 33, needsConvert: true, unfiltered: true, description: 'Smallest local video model.' },
  ]
  const mlx = {
    engineInstalled: opts.mlx?.engineInstalled ?? true,
    videoEngineInstalled: opts.mlx?.videoEngineInstalled ?? true,
    images: new Set<string>(opts.mlx?.installedImages ?? ['sd-turbo']),
    videos: new Set<string>(opts.mlx?.installedVideos ?? ['wan21-t2v-1.3b']),
  }
  // One install slot per kind, exactly like the Rust side: null means idle
  // (nothing was ever started), a number counts polls since the install began.
  const slot: Record<'image' | 'imageEngine' | 'video' | 'videoEngine', number | null> = {
    image: null,
    imageEngine: null,
    video: null,
    videoEngine: null,
  }
  let pendingImageId: string | null = null
  let pendingVideoId: string | null = null
  // 1x1 transparent PNG — enough for the gallery to render something real.
  const TINY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  function record(bucket: string, entry: any) {
    ;(w[bucket] = w[bucket] || []).push(entry)
  }
  /** Advance an install slot; report 'complete' once it has been polled enough. */
  function installStatus(key: keyof typeof slot, extra?: Record<string, unknown>) {
    const n = slot[key]
    // Rust semantics: a slot nobody started reads 'idle', and polling it does
    // not advance anything. The download tray probes all four slots at boot
    // (adopt), so a mock that advances on read would install engines by
    // merely being looked at.
    if (n === null) {
      return {
        status: 'idle',
        logs: [] as string[],
        error: null,
        download_progress: 0,
        download_total: 0,
        download_speed: 0,
        ...extra,
      }
    }
    slot[key] = n + 1
    const done = n + 1 >= MLX_INSTALL_POLLS
    return {
      status: done ? 'complete' : 'installing',
      logs: done ? ['download complete', 'ready'] : ['starting…', 'downloading…'],
      error: null,
      download_progress: done ? 100 : 40,
      download_total: 100,
      download_speed: 1024 * 1024,
      ...extra,
    }
  }

  const enc = (s: string) => Array.from(new TextEncoder().encode(s))

  // Ordered OpenAI SSE for one assistant turn, ending with [DONE].
  function chatSse(text: string): string {
    const frame = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        model: opts.modelName,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    return (
      frame({ role: 'assistant' }, null) +
      frame({ content: text }, null) +
      frame({}, 'stop') +
      'data: [DONE]\n\n'
    )
  }

  /** The same turn, split into `n` deliverable pieces. n=1 reproduces chatSse
   *  byte for byte, so specs that do not opt in are unaffected. */
  function chatSseParts(text: string, n: number): string[] {
    if (n <= 1) return [chatSse(text)]
    const frame = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        model: opts.modelName,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    const size = Math.ceil(text.length / n)
    const parts = [frame({ role: 'assistant' }, null)]
    for (let i = 0; i < text.length; i += size) {
      parts.push(frame({ content: text.slice(i, i + size) }, null))
    }
    parts.push(frame({}, 'stop') + 'data: [DONE]\n\n')
    return parts
  }

  /**
   * SSE frames for one scripted agent turn: prose deltas, then tool_call
   * deltas, then the finish frame. Emitting the tool call as DELTAS (id+name
   * first, arguments after) is deliberate — that is what a real backend does,
   * and it is the accumulator in openai-provider that the agent specs need to
   * exercise, not a pre-assembled call.
   */
  function agentTurnSse(turn: { text?: string; toolCalls?: Array<{ name: string; args: any }> }): string[] {
    const frame = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        model: opts.modelName,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    const parts = [frame({ role: 'assistant' }, null)]
    const text = turn.text || ''
    const size = Math.max(1, Math.ceil(text.length / 8))
    for (let i = 0; i < text.length; i += size) {
      parts.push(frame({ content: text.slice(i, i + size) }, null))
    }
    const calls = turn.toolCalls || []
    calls.forEach((c, idx) => {
      parts.push(frame({ tool_calls: [{ index: idx, id: `call_e2e_${idx}`, type: 'function', function: { name: c.name, arguments: '' } }] }, null))
      parts.push(frame({ tool_calls: [{ index: idx, function: { arguments: JSON.stringify(c.args ?? {}) } }] }, null))
    })
    parts.push(frame({}, calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n')
    return parts
  }

  /** Which scripted turn the next model call gets. */
  let agentTurnIndex = 0

  function router(cmd: string, args: any): Promise<any> {
    // The MLX wrappers (api/mlx-image.ts invokeMedia) nest their payload under
    // an `args` key to match the Rust `args: Value` signature — unwrap once so
    // the cases below read the fields the caller actually sent.
    const m = args?.args ?? args ?? {}
    switch (cmd) {
      // ── onboarding / lifecycle markers ────────────────────────────
      case 'is_onboarding_done':
        return Promise.resolve(false)
      case 'set_onboarding_done':
        return Promise.resolve(null)

      // ── model dir + download ──────────────────────────────────────
      case 'detect_model_path':
        return Promise.resolve(MODELS_DIR)
      case 'download_model_to_path': {
        const fn = args?.filename
        if (fn) startedDownloads.add(fn)
        // Recorded so specs can assert the exact URLs, target dir and byte
        // sizes a download kicked off with (sharded sets: one call per part).
        record('__E2E_DL_CALLS__', {
          url: args?.url,
          destDir: args?.destDir,
          filename: fn,
          expectedBytes: args?.expectedBytes,
        })
        return Promise.resolve({ status: 'started', id: `dl-${fn}` })
      }
      case 'download_progress': {
        const out: Record<string, any> = {}
        for (const fn of startedDownloads) {
          out[fn] = { progress: 1, total: 1, speed: 0, filename: fn, status: 'complete' }
        }
        return Promise.resolve(out)
      }
      case 'pause_download':
      case 'cancel_download':
      case 'resume_download':
        return Promise.resolve(null)

      // ── built-in engine lifecycle (engine.rs surface) ─────────────
      case 'start_bundled_engine':
      case 'swap_bundled_model': {
        // Record every launch so specs can assert the settings-injected tuning
        // (api/engine.ts merges settings.builtinEngine into each call).
        ;(w.__E2E_ENGINE_CALLS__ = w.__E2E_ENGINE_CALLS__ || []).push({
          cmd,
          modelPath: args?.modelPath,
          tuning: args?.tuning,
        })
        const t = args?.tuning
        engineCtx = t && typeof t.ctx === 'number' && t.ctx > 0 ? t.ctx : 8192
        return Promise.resolve(8127)
      }
      case 'stop_bundled_engine':
        return Promise.resolve(null)
      case 'bundled_engine_status':
        return Promise.resolve({ running: true, healthy: true, port: 8127, model_path: modelPath, ctx: engineCtx })
      case 'list_bundled_models':
        return Promise.resolve({
          dir: MODELS_DIR,
          // ctx_train mirrors the GGUF-header read (ENG-6c) — 32k, like the
          // real Qwen2.5 starter — so specs can assert the preset cap.
          models: [{ name: opts.modelName, path: modelPath, size: 400 * 1024 * 1024, loaded: true, ctx_train: 32768 }],
        })

      // ── built-in EMBEDDINGS server lifecycle (P5) ─────────────────
      case 'start_bundled_embed':
        return Promise.resolve({ status: 'started', port: 8128, model_path: args?.modelPath })
      case 'stop_bundled_embed':
        return Promise.resolve(null)
      case 'bundled_embed_status':
        return Promise.resolve({ running: true, healthy: true, port: 8128, model_path: `${MODELS_DIR}/nomic.gguf` })

      // ── detection: nothing external is running ────────────────────
      case 'get_ollama_host':
        return Promise.resolve('http://localhost:11434')
      case 'lmstudio_model_context':
        // Real Rust returns a shaped object; a null default here trips
        // useActiveContextWindow (`info.loaded`). Return the "unknown" shape.
        return Promise.resolve({ loaded: null, max: null, state: null })
      case 'comfyui_status':
        // Recorded, not just refused: a Mac spec asserts this stays at zero.
        record('__E2E_COMFY_CALLS__', { cmd })
        return Promise.reject('not running (e2e)')
      case 'start_ollama':
      case 'lmstudio_server_status':
      case 'whisper_status':
      case 'install_tts_status':
      case 'search_status':
        return Promise.reject('not running (e2e)')

      // ── MLX image (commands/mlx.rs) ───────────────────────────────
      case 'mlx_status':
        return Promise.resolve({
          installed: mlx.engineInstalled,
          running: mlx.engineInstalled,
          port: 47712,
          modelLoaded: false,
          modelRepo: null,
          idleSeconds: null,
        })
      case 'mlx_start':
        return Promise.resolve({ ok: true, port: 47712 })
      case 'mlx_unload':
        return Promise.resolve({ ok: true, was_loaded: false, running: true })
      case 'mlx_image_models':
        return Promise.resolve(mlxImageCatalog.map((m) => ({ ...m, installed: mlx.images.has(m.id) })))
      // Rust holds the HF token in memory only, so a spec has to be able to
      // see that the frontend pushed it down, not just that it was stored.
      case 'set_hf_token': {
        const token = String(m?.token ?? '').trim()
        w.__E2E_HF_TOKEN__ = token || null
        record('__E2E_MLX_CALLS__', { cmd, present: !!token })
        return Promise.resolve({ ok: true, present: !!token })
      }
      case 'hf_token_present':
        return Promise.resolve({ present: !!w.__E2E_HF_TOKEN__ })
      case 'install_mlx_diffusion':
        slot.imageEngine = 0
        record('__E2E_MLX_CALLS__', { cmd })
        return Promise.resolve({ ok: true, status: 'installing' })
      case 'install_mlx_diffusion_status': {
        const s = installStatus('imageEngine')
        if (s.status === 'complete') mlx.engineInstalled = true
        return Promise.resolve(s)
      }
      case 'mlx_image_install_model':
        slot.image = 0
        pendingImageId = m?.id ?? null
        record('__E2E_MLX_CALLS__', { cmd, id: m?.id })
        return Promise.resolve({ ok: true, status: 'installing', id: m?.id })
      case 'mlx_image_install_status': {
        const s = installStatus('image')
        if (s.status === 'complete' && pendingImageId) {
          mlx.images.add(pendingImageId)
          pendingImageId = null
        }
        return Promise.resolve(s)
      }
      case 'mlx_image_delete_model':
        mlx.images.delete(m?.id)
        record('__E2E_MLX_CALLS__', { cmd, id: m?.id })
        return Promise.resolve({ ok: true, id: m?.id })
      case 'mlx_generate':
        // The whole point of the Mac Create path: image renders come from
        // here, never from a ComfyUI workflow submit.
        record('__E2E_MLX_CALLS__', {
          cmd,
          prompt: m?.prompt,
          model: m?.model,
          steps: m?.steps,
          seed: m?.seed,
          width: m?.width,
          height: m?.height,
        })
        return Promise.resolve({ image_base64: TINY_PNG, width: m?.width ?? 512, height: m?.height ?? 512 })

      // ── MLX video (commands/video.rs) ─────────────────────────────
      case 'video_status':
        return Promise.resolve({
          available: mlx.videoEngineInstalled,
          appleSilicon: true,
          mlxInstalled: mlx.videoEngineInstalled,
          mlxVersion: mlx.videoEngineInstalled ? '0.4.0' : null,
          pythonBin: '/tmp/lu-e2e/venv/bin/python',
          modelsRoot: '/tmp/lu-e2e/mlx-video',
          outputsRoot: '/tmp/lu-e2e/videos',
          installedModels: [...mlx.videos],
          running: false,
        })
      case 'video_list_models':
        return Promise.resolve(mlxVideoCatalog.map((m) => ({ ...m, installed: mlx.videos.has(m.id) })))
      case 'video_install_mlx':
        slot.videoEngine = 0
        record('__E2E_MLX_CALLS__', { cmd })
        return Promise.resolve({ ok: true, status: 'installing' })
      case 'video_install_mlx_status': {
        const s = installStatus('videoEngine')
        if (s.status === 'complete') mlx.videoEngineInstalled = true
        return Promise.resolve(s)
      }
      case 'video_install_model':
        slot.video = 0
        pendingVideoId = m?.id ?? null
        // The payload is nested under `args` (invokeMedia) — reading args.id
        // here recorded undefined and let an id assertion pass on nothing.
        record('__E2E_MLX_CALLS__', { cmd, id: m?.id })
        return Promise.resolve({ ok: true, status: 'installing', id: m?.id })
      case 'video_install_model_status': {
        const s = installStatus('video')
        if (s.status === 'complete' && pendingVideoId) {
          mlx.videos.add(pendingVideoId)
          pendingVideoId = null
        }
        return Promise.resolve(s)
      }
      case 'video_delete_model':
        mlx.videos.delete(m?.id)
        record('__E2E_MLX_CALLS__', { cmd, id: m?.id })
        return Promise.resolve({ ok: true, id: m?.id })
      case 'video_generate':
        record('__E2E_MLX_CALLS__', { cmd, id: m?.id, prompt: m?.prompt, seconds: m?.seconds })
        return Promise.resolve({ ok: true, jobId: 'e2e-vid', pid: 4242, output: '/tmp/lu-e2e/videos/e2e-vid.mp4' })
      case 'video_progress':
        // Completes on the first poll — specs assert the wiring, not patience.
        return Promise.resolve({ running: false, status: 'complete', logs: ['done'], error: null })
      case 'video_cancel':
        record('__E2E_MLX_CALLS__', { cmd })
        return Promise.resolve({ ok: true })
      case 'read_media_file':
        return Promise.resolve(`data:video/mp4;base64,${TINY_PNG}`)

      // ── chat streaming: drive the onChunk Channel ─────────────────
      case 'proxy_localhost_stream_chunked': {
        // Jeden Chat-Koerper mitschreiben. Eine Persona hat am 03.09.2026 am
        // Netzwerk-Payload gemessen, dass auf Deutsch KEIN `tools`-Feld
        // mitging — Specs koennen das jetzt genauso pruefen, statt sich auf
        // das zu verlassen, was gerade auf dem Schirm steht.
        ;(w.__E2E_CHAT_BODIES__ = w.__E2E_CHAT_BODIES__ || []).push(args?.body ?? '')
        const channel = args?.onChunk
        const script = opts.agentTurns
        const parts = script && script.length
          ? agentTurnSse(script[Math.min(agentTurnIndex++, script.length - 1)])
          : chatSseParts(opts.assistantReply, opts.replyChunks ?? 1)
        const gap = opts.replyChunkDelayMs ?? 0
        // Deliver on a macrotask so the app's `settled` promise is already
        // being awaited, mirroring the async Rust→WebView channel delivery.
        parts.forEach((part, i) => {
          setTimeout(() => {
            try { channel?.onmessage?.(enc(part)) } catch { /* reader gone */ }
          }, i * gap)
        })
        setTimeout(() => {
          try { channel?.onmessage?.([]) } catch { /* reader gone */ } // empty chunk = EOF
        }, parts.length * gap)
        return Promise.resolve(null)
      }
      case 'proxy_localhost_stream':
        ;(w.__E2E_CHAT_BODIES__ = w.__E2E_CHAT_BODIES__ || []).push(args?.body ?? '')
        return Promise.resolve(enc(chatSse(opts.assistantReply)))
      case 'cancel_proxy_stream':
        return Promise.resolve(null)

      // ── generic localhost proxy ───────────────────────────────────
      // Ollama's model list (`/api/tags`) resolves to `opts.ollamaModels`,
      // empty by default, so a fresh box looks fresh (no installed models →
      // the starter recommendation is the one thing on the model step).
      // Resolving here rather than rejecting also stops localFetch from
      // falling through to a direct fetch that could hit a REAL Ollama on the
      // dev machine. Every other probe rejects, so no external backend is
      // ever detected as live.
      case 'proxy_localhost': {
        const url: string = args?.url || ''
        // Record every proxied URL so tests can assert routing (e.g. embeddings
        // hit the bundled server on 8128, never Ollama on 11434).
        ;(w.__E2E_PROXY_URLS__ = w.__E2E_PROXY_URLS__ || []).push(url)

        // P5: bundled embeddings server on 8128 speaks OpenAI /v1/embeddings.
        // Echo one deterministic (content-varying) vector per input so the real
        // RAG code (indexDocument / retrieveContext) runs end to end, no Ollama.
        if (url.includes(':8128') || url.includes('/v1/embeddings')) {
          let inputs: string[] = []
          try {
            const parsed = JSON.parse(args?.body || '{}').input
            inputs = Array.isArray(parsed) ? parsed : [parsed]
          } catch { /* empty */ }
          const data = inputs.map((s: string, index: number) => ({
            index,
            embedding: [(s?.length ?? 0) % 7, (s?.charCodeAt(0) || 0) % 13, 1],
          }))
          return Promise.resolve(JSON.stringify({ object: 'list', data, model: 'nomic-embed-text-v1.5' }))
        }

        if (url.includes('11434') || /\/tags(\?|$)/.test(url)) {
          // Shaped like a real /api/tags entry, not just a name: listModels()
          // spreads the entry through and the pickers read `details` and
          // `capabilities` off it. `tools` is declared so a chosen model is
          // not additionally judged by the family-name fallback.
          const models = (opts.ollamaModels || []).map((name: string) => ({
            name,
            model: name,
            size: 4 * 1024 * 1024 * 1024,
            digest: `e2e-${name}`,
            modified_at: '2026-09-01T00:00:00Z',
            details: {
              parent_model: '', format: 'gguf', family: name.split(':')[0],
              families: [name.split(':')[0]], parameter_size: '4B', quantization_level: 'Q4_K_M',
            },
            capabilities: ['completion', 'tools'],
          }))
          return Promise.resolve(JSON.stringify({ models }))
        }
        return Promise.reject('error sending request: connection refused (e2e)')
      }

      // ── external fetch (HF tree resolve etc.) ────────────────────
      // Serves the canned tree for the one configured repo; every other URL
      // gets JSON null, which callers treat as "API unreachable" and fall
      // back gracefully (resolveHfGgufFiles returns null → guessed file).
      case 'fetch_external': {
        const url: string = args?.url || ''
        const t = opts.hfTree
        if (t && url.includes(`/api/models/${t.repo}/tree/main`)) {
          return Promise.resolve(JSON.stringify(t.entries))
        }
        return Promise.resolve('null')
      }

      // ── LU Cloud keychain session (secret_* → in-memory map) ─────
      // Real keychain semantics: set stores, get returns the stored value
      // (or null), delete removes. Lets the Supabase session survive within
      // a page session and keeps the PKCE verifier separate from it.
      case 'secret_set': {
        ;(w.__E2E_SECRETS__ = w.__E2E_SECRETS__ || {})[args?.account] = args?.value
        return Promise.resolve(null)
      }
      case 'secret_get':
        return Promise.resolve((w.__E2E_SECRETS__ || {})[args?.account] ?? null)
      case 'secret_delete': {
        if (w.__E2E_SECRETS__) delete w.__E2E_SECRETS__[args?.account]
        return Promise.resolve(null)
      }

      // ── agent file/shell tools ────────────────────────────────────
      // Enough of the bridge for the ReAct loop to actually complete a step.
      // Every call is recorded so a spec can assert WHAT the agent ran, which
      // is the only way to prove things like "the second npm test really
      // re-ran after the edit" (audit B1) from the outside.
      case 'fs_read': {
        record('__E2E_TOOL_CALLS__', { cmd, path: m?.path })
        const files = opts.files || {}
        const key = Object.keys(files).find((k) => String(m?.path || '').endsWith(k))
        return Promise.resolve({ content: key ? files[key] : '', encoding: 'utf8' })
      }
      case 'fs_write':
        record('__E2E_TOOL_CALLS__', { cmd, path: m?.path })
        return Promise.resolve({ ok: true, path: m?.path })
      case 'fs_list':
        record('__E2E_TOOL_CALLS__', { cmd, path: m?.path })
        return Promise.resolve({ entries: [] })
      case 'shell_execute':
        record('__E2E_TOOL_CALLS__', { cmd, command: m?.command, timeout: m?.timeout })
        return Promise.resolve({ stdout: 'e2e shell ok', stderr: '', exitCode: 0, timedOut: false })
      case 'repo_map':
        return Promise.resolve({ files: [], count: 0 })

      default:
        // Record system-browser opens so specs can assert redirect targets
        // (pricing CTA, closed-beta link) without leaving the page.
        if (cmd === 'plugin:shell|open') {
          ;(w.__E2E_OPENED_URLS__ = w.__E2E_OPENED_URLS__ || []).push(args?.path)
          return Promise.resolve(null)
        }
        // Tauri plugin channels (event listen/unlisten, window, etc.) and any
        // unmodeled command: resolve benignly so nothing throws on boot.
        if (cmd.startsWith('plugin:')) return Promise.resolve(0)
        return Promise.resolve(null)
    }
  }

  let callbackId = 0
  const callbacks: Record<number, (v: any) => void> = {}

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    // Channel/event construction routes through here.
    transformCallback(cb: (v: any) => void) {
      const id = ++callbackId
      callbacks[id] = cb
      w[`_${id}`] = cb
      return id
    },
    unregisterCallback(id: number) {
      delete callbacks[id]
      delete w[`_${id}`]
    },
    convertFileSrc(path: string) {
      return path
    },
    invoke(cmd: string, args: any) {
      return router(cmd, args)
    },
  }
  // Legacy v1 alias some detection code still probes for.
  w.__TAURI__ = w.__TAURI_INTERNALS__
}
