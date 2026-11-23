/**
 * Strand 1 "chat" of the mobile shell: the chat list C1, the conversation C2
 * with its composer, the model sheet C3, the attach sheet C4, the message
 * sheet C6, the chat menu C7 and the file view C14.
 *
 * The backend is mocked inside the page. `tauriMockInit` (e2e/support) stands
 * in for the native bridge; `chatBackend` below wraps it with what this
 * strand needs to steer: the list of models on the phone, a streamed answer
 * that can be slow, break in the middle or be refused, and a record of what
 * the app handed to the system (clipboard, share sheet, browser, Photos).
 * LU Cloud is mocked at the network (routeCloud); no real request leaves.
 *
 * Screenshots: LU_CHAT_SHOTS=1 npx playwright test --project=mobile chat
 * writes mobile-docs/design/strang-shots/chat/.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { routeCloud } from '../support/cloud-mock'
import { tauriMockInit } from '../support/tauri-mock'
import { CLOUD_PROBE, androidTextZoom, answerCloudProbe, clippedSymbols, declareAdult, screensLoaded, shellUrl, SIZES, watchErrors, type LayoutReport, type OpenOptions } from './support'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(HERE, '../../mobile-docs/design/strang-shots/chat')

const SMALL = 'Qwen2.5-0.5B-Instruct-Q4_K_M'
const VISION = 'Gemma-3-4B-it-Q4_K_M'
/** How the app calls that file: the name of the catalogue, the same in Installed, the model sheet and the chat (round 6, N1). */
const VISION_LABEL = 'Gemma 3 4B'
const REPLY = 'Paris is the capital of France. It lies on the Seine.'
/** What the send path writes into an answer when the server refuses for credits (src/lib/credits-exhausted.ts). */
const OUT_OF_CREDITS = "You're out of credits, so the server refused this request.\n\nPlan credits refill on your renewal date."

interface BackendOptions {
  models: Array<{ name: string; size: number; vision?: boolean }>
  reply: string
  chunks: number
  delay: number
  /** The model the engine holds at the start. null: none, the app has to load one. Default: the first of `models`. */
  loaded?: string | null
  /** How long a start of the engine takes, in milliseconds. */
  startDelay?: number
}

/** Runs inside the page, after tauriMockInit. Everything a test steers hangs on window.__CHAT_E2E__. */
function chatBackend(opts: BackendOptions) {
  /* eslint-disable @typescript-eslint/no-explicit-any -- the stub stands in for the untyped native bridge */
  const w = window as any
  // The logic layer reads the kind of device from the user agent. A phone, not the desktop the mock pins.
  try {
    Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', configurable: true })
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l', configurable: true })
  } catch {
    /* the host user agent then decides */
  }
  const ctl = (w.__CHAT_E2E__ = {
    models: opts.models,
    reply: opts.reply,
    chunks: opts.chunks,
    delay: opts.delay,
    /** ok: the answer streams to its end. break: the connection dies half way. refuse: the engine does not answer. */
    mode: 'ok' as 'ok' | 'break' | 'refuse',
    loaded: opts.loaded === undefined ? (opts.models[0]?.name ?? null) : opts.loaded,
    /** How long a start of the engine takes. While it runs the engine holds nothing. */
    startDelay: opts.startDelay ?? 0,
    /** From the request with this number on (counted from 1) the engine answers with these values. Set before that request exists. */
    slowFrom: null as null | { request: number; chunks: number; delay: number },
    /** What the model thinks before it answers (reasoning_content), and how long one piece of it takes. */
    thinking: '',
    thinkingDelay: 0,
    /** The agent folder of a chat: path inside the folder to content. null: no folder. */
    workspace: null as null | { files: Record<string, string>; canDelete: boolean; listFails: boolean; deleted: string[] },
    listeners: {} as Record<string, number[]>,
    /** What the system refuses, for the toasts that say so. */
    refuse: { copy: false, share: false, save: false, open: false },
    /** The text of a native backup of the stores (restore_stores), null for none. */
    backup: null as string | null,
    /** Fire an event of the native side at every listener of the app. */
    emit(event: string, payload: unknown) {
      for (const id of ctl.listeners[event] ?? []) w[`_${id}`]?.({ event, payload, id })
    },
    copied: [] as string[],
    shared: [] as Array<{ name: string; mime: string; text: string }>,
    saved: [] as Array<{ name: string; target: string }>,
    opened: [] as string[],
    bodies: [] as string[],
    engineStarts: [] as string[],
    cancelled: false,
    /** How often a stream was cancelled. `cancelled` is about the request that runs now and is cleared by the next one. */
    cancels: 0,
    attachments: {} as Record<string, string>,
  })
  const inner = w.__TAURI_INTERNALS__.invoke
  const enc = (s: string) => Array.from(new TextEncoder().encode(s))
  const frame = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-chat-e2e', object: 'chat.completion.chunk', model: 'e2e', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

  w.__TAURI_INTERNALS__.invoke = (cmd: string, args: any) => {
    switch (cmd) {
      case 'list_bundled_models':
        return Promise.resolve({
          dir: '/data/models',
          models: ctl.models.map((m: any) => ({ name: m.name, path: `/data/models/${m.name}.gguf`, size: m.size, loaded: m.name === ctl.loaded, ctx_train: 32768, vision: !!m.vision })),
        })
      case 'start_bundled_engine':
      case 'swap_bundled_model': {
        const file = String(args?.modelPath ?? '')
        ctl.engineStarts.push(file)
        const name = file.replace(/^.*\//, '').replace(/\.gguf$/, '')
        if (!(ctl.startDelay > 0)) {
          ctl.loaded = name
          return inner(cmd, args)
        }
        ctl.loaded = null
        return new Promise((resolve) => {
          setTimeout(() => {
            ctl.loaded = name
            resolve(inner(cmd, args))
          }, ctl.startDelay)
        })
      }
      // What the engine holds, as this file steers it: nothing after the system took the memory back.
      case 'bundled_engine_status':
        return inner(cmd, args).then((status: any) => ({
          ...status,
          running: !!ctl.loaded,
          healthy: !!ctl.loaded,
          model_path: ctl.loaded ? `/data/models/${ctl.loaded}.gguf` : null,
        }))
      case 'plugin:event|listen':
        ;(ctl.listeners[String(args?.event)] ??= []).push(Number(args?.handler))
        return inner(cmd, args)
      // The agent folder of a chat, as the file commands of the app answer for it.
      case 'fs_list': {
        if (!ctl.workspace) return inner(cmd, args)
        if (ctl.workspace.listFails) return Promise.reject('fs_list: the folder cannot be read')
        const root = '/data/workspaces/e2e'
        const entries = [{ name: 'e2e', path: root, isDir: true, size: 0, modified: 0 }]
        Object.keys(ctl.workspace.files).forEach((rel, i) => {
          const parts = rel.split('/')
          for (let d = 1; d < parts.length; d++) {
            const dir = `${root}/${parts.slice(0, d).join('/')}`
            if (!entries.some((e) => e.path === dir)) entries.push({ name: parts[d - 1], path: dir, isDir: true, size: 0, modified: 0 })
          }
          entries.push({ name: parts[parts.length - 1], path: `${root}/${rel}`, isDir: false, size: ctl.workspace!.files[rel].length, modified: 1000 + i })
        })
        return Promise.resolve({ entries })
      }
      case 'fs_read': {
        if (!ctl.workspace) return inner(cmd, args)
        const content = ctl.workspace.files[String(args?.path)]
        if (content === undefined) return Promise.reject('fs_read: no such file')
        return Promise.resolve({ content, encoding: 'utf8', bytes: content.length })
      }
      case 'fs_delete': {
        if (!ctl.workspace) return inner(cmd, args)
        // A build without the command answers nothing at all. Said here: the shared mock knows fs_delete since the
        // rewind of CA U4 (6ba8a3da0) and would answer "deleted".
        if (!ctl.workspace.canDelete) return Promise.resolve(null)
        const rel = String(args?.path)
        if (!(rel in ctl.workspace.files)) return Promise.reject('fs_delete: no such file')
        delete ctl.workspace.files[rel]
        ctl.workspace.deleted.push(rel)
        return Promise.resolve({ deleted: true })
      }
      // Images of sent messages live in a native store, by the hash of their content.
      case 'write_chat_attachment':
        ctl.attachments[String(args?.id)] = String(args?.data ?? '')
        return Promise.resolve(null)
      case 'read_chat_attachment':
        return ctl.attachments[String(args?.id)] ? Promise.resolve(ctl.attachments[String(args?.id)]) : Promise.reject('attachment not found')
      case 'restore_stores':
        return ctl.backup ? Promise.resolve(ctl.backup) : inner(cmd, args)
      // The clipboard goes through the native bridge (plugin lu-native) since round 4, the contract command is the older way.
      case 'plugin:lu-native|clipboard_write_text':
        if (ctl.refuse.copy) return Promise.resolve({ ok: false })
        ctl.copied.push(String(args?.text ?? ''))
        return Promise.resolve({ ok: true })
      case 'copy_text':
        if (ctl.refuse.copy) return Promise.resolve(false)
        ctl.copied.push(String(args?.text ?? ''))
        return Promise.resolve(true)
      case 'share_file': {
        if (ctl.refuse.share) return Promise.reject('share_file: refused by the test')
        let text = ''
        try {
          text = new TextDecoder().decode(Uint8Array.from(atob(String(args?.dataBase64 ?? '')), (c) => c.charCodeAt(0)))
        } catch {
          /* binary */
        }
        ctl.shared.push({ name: String(args?.name), mime: String(args?.mime), text })
        return Promise.resolve({ completed: true })
      }
      case 'save_to_device':
        if (ctl.refuse.save) return Promise.reject('save_to_device: refused by the test')
        ctl.saved.push({ name: String(args?.name), target: String(args?.target) })
        return Promise.resolve({ saved: true, location: 'Photos' })
      // The native bridge opens a link through its plugin on a phone, the contract command is the older way.
      case 'plugin:lu-native|open_external':
      case 'open_external_url':
        if (ctl.refuse.open) return Promise.reject('open_external: refused by the test')
        ctl.opened.push(String(args?.url))
        return Promise.resolve(null)
      case 'cancel_proxy_stream':
        ctl.cancelled = true
        ctl.cancels += 1
        return Promise.resolve(null)
      case 'proxy_localhost_stream_chunked': {
        const url = String(args?.url ?? '')
        if (!url.includes('/chat/completions')) return inner(cmd, args)
        ctl.bodies.push(String(args?.body ?? ''))
        ctl.cancelled = false
        // A test may make the engine slow from a certain request on, decided before that request exists
        // (`ctl.slowFrom = { request, chunks, delay }`, `request` counts from 1). Changing `chunks` and `delay`
        // from outside while requests are on their way is a race: which request it hits depends on the load.
        if (ctl.slowFrom && ctl.bodies.length >= ctl.slowFrom.request) {
          ctl.chunks = ctl.slowFrom.chunks
          ctl.delay = ctl.slowFrom.delay
          ctl.slowFrom = null
        }
        const channel = args?.onChunk
        if (ctl.mode === 'refuse') return Promise.reject(`proxy_localhost_stream_chunked: error sending request for url (${url})`)
        const text: string = ctl.reply
        const size = Math.max(1, Math.ceil(text.length / Math.max(1, ctl.chunks)))
        const parts = [frame({ role: 'assistant' }, null)]
        const thinkingParts = ctl.thinking ? ctl.thinking.match(/.{1,24}/g) ?? [] : []
        for (const piece of thinkingParts) parts.push(frame({ reasoning_content: piece }, null))
        for (let i = 0; i < text.length; i += size) parts.push(frame({ content: text.slice(i, i + size) }, null))
        const stopAt = ctl.mode === 'break' ? Math.ceil(parts.length / 2) : parts.length
        return new Promise((resolve, reject) => {
          let i = 0
          const tick = () => {
            if (ctl.cancelled) {
              try { channel?.onmessage?.([]) } catch { /* reader gone */ }
              resolve(null)
              return
            }
            if (i < stopAt) {
              // The frames after the first are the thoughts, when the model thinks: they may take their own time.
              const thinkingFrame = i >= 1 && i <= thinkingParts.length
              try { channel?.onmessage?.(enc(parts[i++])) } catch { /* reader gone */ }
              setTimeout(tick, thinkingFrame && ctl.thinkingDelay > 0 ? ctl.thinkingDelay : ctl.delay)
              return
            }
            if (ctl.mode === 'break') {
              reject('error decoding response body: connection reset by peer')
              return
            }
            try {
              channel?.onmessage?.(enc(frame({}, 'stop') + 'data: [DONE]\n\n'))
              channel?.onmessage?.([])
            } catch { /* reader gone */ }
            resolve(null)
          }
          setTimeout(tick, ctl.delay)
        })
      }
      default:
        return inner(cmd, args)
    }
  }
}

interface BootOptions extends OpenOptions {
  models?: BackendOptions['models']
  reply?: string
  chunks?: number
  delay?: number
  /** Store preset to look at (developer switch ?store=). */
  store?: 'play' | 'appstore'
  loaded?: string | null
  startDelay?: number
  /** What the engine says about thinking in GET /props (lu.thinking). Left out: it says nothing. */
  engineThinks?: boolean
  /** The model the app was set up with. Default: the small Qwen. */
  modelName?: string
  /** Called for every request the page sends to the port of the engine. */
  onEngineRequest?: (url: string) => void
  /** Runs in the page after the mocked backend is in place: another phone, another answer of the native layer. */
  native?: () => void
}

const TWO_MODELS: BackendOptions['models'] = [
  { name: SMALL, size: 398 * 1024 * 1024 },
  { name: VISION, size: 2490 * 1024 * 1024, vision: true },
]

async function boot(page: Page, options: BootOptions = {}): Promise<void> {
  // The shared bridge mock (e2e/support/tauri-mock.ts) refuses every loopback port but the page's own
  // before the request leaves the page, so nothing reaches a server on the test machine. The engine of
  // the phone lives on 8127 and this file answers that port itself with page.route below. The same
  // arrangement the mock has for the voice loop: keep the request the page had before the mock, and
  // let this one port through to it. Every other loopback port stays refused.
  await page.addInitScript(() => {
    const w = window as unknown as { __LU_E2E_PAGE_FETCH__?: typeof fetch }
    w.__LU_E2E_PAGE_FETCH__ = window.fetch.bind(window)
  })
  await page.addInitScript(tauriMockInit, { assistantReply: 'unused', modelName: options.modelName ?? SMALL })
  await page.addInitScript(() => {
    const w = window as unknown as { __LU_E2E_PAGE_FETCH__?: typeof fetch }
    const pageFetch = w.__LU_E2E_PAGE_FETCH__
    if (!pageFetch) return
    const refusing = window.fetch.bind(window)
    const engine = /^http:\/\/127\.0\.0\.1:8127(?:[/?#]|$)/
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return engine.test(url) ? pageFetch(input, init) : refusing(input, init)
    }
  })
  await page.addInitScript(chatBackend, {
    models: options.models ?? TWO_MODELS,
    reply: options.reply ?? REPLY,
    chunks: options.chunks ?? 6,
    delay: options.delay ?? 10,
    loaded: options.loaded,
    startDelay: options.startDelay,
  })
  if (options.native) await page.addInitScript(options.native)
  // The context figure asks the engine for its window. The mocked bridge has no answer for those probes and the
  // app then asks the port directly; answer there, so nothing reaches a real engine on this machine.
  await page.route('http://127.0.0.1:8127/**', (route) => {
    options.onEngineRequest?.(route.request().url())
    const props = { default_generation_settings: { n_ctx: 4096 }, ...(options.engineThinks === undefined ? {} : { lu: { thinking: options.engineThinks } }) }
    const body = route.request().url().endsWith('/props') ? props : {}
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
  })
  await answerCloudProbe(page)
  if (options.store) await declareAdult(page)
  await page.goto(shellUrl(options) + (options.store ? `&store=${options.store}` : ''))
  await page.getByTestId('m-app').waitFor()
  await screensLoaded(page)
}

/** Read or change what the mocked backend does. */
async function backend<T>(page: Page, fn: (ctl: any) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__CHAT_E2E__)`) as Promise<T>
}

/** A conversation as the chat store keeps it; only what a test sets. */
interface SeedMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  modelId?: string
  finishReason?: string
  notice?: 'info' | 'warn'
  images?: Array<{ data: string; mimeType: string; name: string }>
  files?: Array<{ name: string; size: number; kind: string; sha256: string; summary: string }>
  artifacts?: Array<{ id: string; name: string; content: string; mime: string }>
  sources?: Array<{ documentName: string; chunkIndex: number; preview: string }>
}
interface SeedChat {
  id: string
  title: string
  messages: SeedMessage[]
  /** Minutes before now. */
  ago?: number
}

/** Put chats into the store of the app, through the module graph of the dev server: the same instance the app uses. */
async function seedChats(page: Page, chats: SeedChat[]): Promise<void> {
  await page.evaluate(async (list) => {
    const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
    const now = Date.now()
    const model = 'openai::Qwen2.5-0.5B-Instruct-Q4_K_M'
    const conversations = list.map((chat, n) => {
      const at = now - (chat.ago ?? n + 1) * 60_000
      return {
        id: chat.id,
        title: chat.title,
        model,
        systemPrompt: '',
        createdAt: at - 60_000,
        updatedAt: at,
        messages: chat.messages.map((m, i) => ({ ...m, id: `${chat.id}-m${i}`, modelId: m.role === 'assistant' ? (m.modelId ?? model) : undefined, timestamp: at - 60_000 + i * 1000 })),
      }
    })
    useChatStore.setState({ conversations: [...useChatStore.getState().conversations.filter((c: { id: string }) => !conversations.some((n) => n.id === c.id)), ...conversations] })
  }, chats)
}

/** Open a seeded chat from the list. */
async function openChat(page: Page, id: string): Promise<void> {
  // A page that was just left slides out for a moment (the scaffold animates it) and still counts as visible.
  await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
  if (await page.getByTestId('m-chat-screen').isVisible()) await page.getByTestId('m-page-back').tap()
  await expect(page.locator('.m-page[data-m-exit]')).toHaveCount(0)
  await page.locator(`[data-testid="m-chats-item"][data-m-id="${id}"] [data-testid="m-chats-open"]`).tap()
  await expect(page.getByTestId('m-chat-screen')).toBeVisible()
}

/** A small PNG, made in the page, as bytes for a file chooser and as base64 for a seeded message. */
async function makePng(page: Page, width = 320, height = 240): Promise<string> {
  return page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      const gradient = ctx.createLinearGradient(0, 0, w, h)
      gradient.addColorStop(0, '#2f6fed')
      gradient.addColorStop(1, '#f2a03d')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(w * 0.7, h * 0.35, h * 0.14, 0, Math.PI * 2)
      ctx.fill()
      return canvas.toDataURL('image/png').split(',')[1]
    },
    [width, height],
  )
}

/** Sign in to the mocked LU Cloud the way the account page does, and let the app read the account and the catalogue. */
async function signInCloud(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { supabaseCloud } = await import(/* @vite-ignore */ `${location.origin}/src/api/cloud/supabase.ts`)
    const { probeAccount } = await import(/* @vite-ignore */ `${location.origin}/src/hooks/useCloudAuth.ts`)
    await supabaseCloud().auth.signInWithPassword({ email: 'qa@lu-labs.ai', password: 'e2e-password' })
    await probeAccount()
    window.dispatchEvent(new CustomEvent('lu-models-refresh'))
  })
}

/** The route of the page on top, as the navigation of the shell knows it. */
async function topRoute(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
    const state = nav.getState()
    const stack = state.flow ? state.flowStack : state.stacks[state.tab]
    return stack[stack.length - 1].route as string
  })
}

/** Runs inside the page: a voice of the system that records what it is asked to say and speaks until it is stopped. */
function speechStub() {
  /* eslint-disable @typescript-eslint/no-explicit-any -- stands in for the speech API of the WebView */
  const w = window as any
  const log = (w.__SPEECH__ = { spoken: [] as string[], cancelled: 0, current: null as any })
  w.SpeechSynthesisUtterance = class {
    text: string
    rate = 1
    pitch = 1
    volume = 1
    lang = ''
    voice = null
    onend: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onstart: ((event: unknown) => void) | null = null
    constructor(text: string) {
      this.text = text
    }
    addEventListener() {}
    removeEventListener() {}
  }
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    onvoiceschanged: null,
    // One voice: the door of the shell (src/mobile/lib/speech.ts) counts a WebView without a voice as no voice.
    getVoices: () => [{ name: 'Test Voice', lang: 'en-US', default: true, localService: true, voiceURI: 'test' }],
    speak(utterance: any) {
      log.spoken.push(String(utterance.text))
      log.current = utterance
      synth.speaking = true
    },
    cancel() {
      log.cancelled += 1
      synth.speaking = false
      const utterance = log.current
      log.current = null
      utterance?.onend?.({})
    },
    pause() {},
    resume() {},
    addEventListener() {},
    removeEventListener() {},
  }
  Object.defineProperty(w, 'speechSynthesis', { configurable: true, get: () => synth })
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Runs inside the page: a microphone that hums (or is silent, or is refused), steered through window.__MIC__. */
function microphoneStub() {
  /* eslint-disable @typescript-eslint/no-explicit-any -- stands in for the microphone of the phone */
  const w = window as any
  const mic = (w.__MIC__ = { gain: 0.8, deny: false, opened: 0 })
  const devices: any = navigator.mediaDevices ?? {}
  if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => devices })
  devices.getUserMedia = async () => {
    if (mic.deny) throw new DOMException('Permission denied', 'NotAllowedError')
    mic.opened += 1
    const ctx = new AudioContext()
    await ctx.resume().catch(() => {})
    const tone = ctx.createOscillator()
    tone.frequency.value = 330
    const gain = ctx.createGain()
    gain.gain.value = mic.gain
    const out = ctx.createMediaStreamDestination()
    tone.connect(gain).connect(out)
    tone.start()
    return out.stream
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const LONG_REPLY = Array.from({ length: 40 }, (_, i) => `Sentence ${i + 1} of a long answer about tides and the moon.`).join(' ')

/**
 * Prompt v2 (c19cc0cad): no model chip above the field any more. The model is the first part of the summary on the
 * settings button under the field, and the model sheet is one level down: settings button, then the row "Model".
 */
async function openModelSheet(page: Page): Promise<void> {
  await page.getByTestId('m-chat-options').tap()
  await page.getByTestId('m-options-model').tap()
}

async function waitForModel(page: Page, name = SMALL): Promise<void> {
  await expect(page.getByTestId('m-chat-options')).toContainText(name)
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('m-chat-input').fill(text)
  await page.getByTestId('m-chat-send').tap()
}

const answers = (page: Page) => page.locator('[data-testid="m-chat-message"][data-m-role="assistant"]')
const userMessages = (page: Page) => page.locator('[data-testid="m-chat-message"][data-m-role="user"]')

async function answerDone(page: Page, text: string | RegExp = REPLY): Promise<void> {
  await expect(answers(page).last()).toContainText(text)
  await expect(answers(page).last()).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('m-chat-stop')).toHaveCount(0)
}

/** The reader turns the wheel towards the start of the chat. A real input event: only that ends the following. */
async function readUp(page: Page): Promise<void> {
  const box = (await page.locator('[data-testid="m-chat-screen"] .m-body').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -100_000)
}

const CLEAN = { overflow: [], small: [], pageScrolls: false }

/** Back with the arrow in the header of the page on top (the page below stays mounted). */
async function back(page: Page): Promise<void> {
  await page.getByTestId('m-page-back').last().tap()
}

/**
 * The layout check of e2e/mobile/support.ts, with two more frames that scroll sideways on purpose: a code block
 * (DESIGN.md C2.22, "the block scrolls sideways") and a wide table. It also waits for the press effect of the
 * last tap to end, which shrinks a target for a moment.
 */
async function layout(page: Page): Promise<LayoutReport> {
  await screensLoaded(page)
  return page.evaluate(async () => {
    const settle = async () => {
      const finite = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
      await Promise.all(finite.map((a) => a.finished.catch(() => undefined)))
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    }
    await settle()
    await settle()
    const app = document.querySelector('[data-testid="m-app"]')
    const width = window.innerWidth
    const overflow: string[] = []
    const small: string[] = []
    if (!app) return { overflow: ['no m-app'], small, pageScrolls: false }
    const visible = (el: Element) => {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      return !el.closest('[data-m-hidden], [hidden]')
    }
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 32)}"`
    app.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (!r.width || !visible(el)) return
      if (el.closest('.m-chips, .m-composer-status, .m-sr')) return
      if (el.closest('.m-chat-code pre, .m-chat-table') && !el.matches('.m-chat-code pre, .m-chat-table')) return
      if (r.right > width + 1 || r.left < -1) overflow.push(`${name(el)} ${Math.round(r.left)}..${Math.round(r.right)}`)
    })
    app.querySelectorAll('button, a[href], [role="radio"], [role="switch"], [role="tab"], input, textarea').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (!r.width || !visible(el)) return
      // A link inside a sentence is as wide as its words; its height is what a finger needs.
      const inlineLink = el.tagName === 'A'
      if (r.height < 43.5 || (!inlineLink && r.width < 43.5)) small.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`)
    })
    return { overflow: overflow.slice(0, 8), small: small.slice(0, 8), pageScrolls: document.documentElement.scrollWidth > width + 1 }
  })
}

for (const size of SIZES) {
  test.describe(`chat ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test('new chat, send, the answer streams, copy and regenerate', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { delay: 40 })
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      await expect(page.getByTestId('m-chat-empty')).toBeVisible()
      await waitForModel(page)
      // The shared slot: microphone while empty, Send with text.
      await expect(page.getByTestId('m-chat-mic')).toBeVisible()
      // The microphone is never for a sweep: it records, and with LU Cloud that costs credits (acceptance Android, N9).
      await expect(page.getByTestId('m-chat-mic')).toHaveAttribute('data-m-risk', 'paid')
      await page.getByTestId('m-chat-input').fill('What is the capital of France?')
      await expect(page.getByTestId('m-chat-send')).toBeEnabled()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-send').tap()

      // While it streams: Stop in the slot, the run line in the notice area, no action row yet.
      await expect(page.getByTestId('m-chat-stop')).toBeVisible()
      await expect(answers(page).last()).toHaveAttribute('data-state', 'streaming')
      await expect(page.getByTestId('m-chat-running')).toBeVisible()
      await expect(page.getByTestId('m-chat-copy')).toHaveCount(0)
      await answerDone(page)
      await expect(userMessages(page)).toHaveText(/What is the capital of France\?/)
      await expect(page.getByTestId('m-chat-model-by').last()).toContainText('Qwen2.5-0.5B')
      // The chat got its id and its place in the list.
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lu-mobile-nav') ?? '{}'))).toBeTruthy()
      expect(await layout(page)).toEqual(CLEAN)

      // Copy: the toast only after the system took the text.
      await page.getByTestId('m-chat-copy').tap()
      await expect(page.getByTestId('m-toast-copied')).toHaveText('Copied')
      expect(await backend(page, (ctl) => ctl.copied.at(-1))).toBe(REPLY)

      // Regenerate: a second request, still one answer.
      await backend(page, (ctl) => { ctl.reply = 'The capital of France is Paris.' })
      await page.getByTestId('m-chat-regenerate').tap()
      await answerDone(page, 'The capital of France is Paris.')
      await expect(answers(page)).toHaveCount(1)
      expect(await backend(page, (ctl) => ctl.bodies.length)).toBe(2)

      // Back: the list shows the chat with the first line of the answer.
      await page.getByTestId('m-page-back').tap()
      await expect(page.getByTestId('m-chats-screen')).toBeVisible()
      await expect(page.getByTestId('m-chats-item')).toHaveCount(1)
      await expect(page.getByTestId('m-chats-item')).toContainText('The capital of France is Paris.')
      expect(await layout(page)).toEqual(CLEAN)
      expect(errors()).toEqual([])
    })

    test('stop keeps the part that arrived', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { reply: LONG_REPLY, chunks: 40, delay: 120 })
      await waitForModel(page)
      await send(page, 'Tell me about tides')
      await expect(answers(page).last()).toContainText('Sentence 2')
      await page.getByTestId('m-chat-stop').tap()
      await expect(page.getByTestId('m-chat-stop')).toHaveCount(0)
      await expect(answers(page).last()).toHaveAttribute('data-state', 'done')
      const text = await answers(page).last().getByTestId('m-chat-answer').innerText()
      expect(text).toContain('Sentence 1 ')
      expect(text).not.toContain('Sentence 40')
      // Counted, not the flag: the flag belongs to the request that runs now, and a later request of the app clears
      // it. Since round 21 a phone asks about every turn that says something about the user ("Tell me ..."), where
      // the desktop counter let only every third through (F1), so such a request follows the stopped answer here.
      expect(await backend(page, (ctl) => ctl.cancels)).toBeGreaterThanOrEqual(1)
      // The part stays, the composer is free again, the action row is there.
      await expect(page.getByTestId('m-chat-mic')).toBeVisible()
      await expect(page.getByTestId('m-chat-regenerate')).toBeEnabled()
      await page.waitForTimeout(400)
      expect(await answers(page).last().getByTestId('m-chat-answer').innerText()).toBe(text)
      expect(errors()).toEqual([])
    })

    test('edit a message and send it again, edit an answer, delete a message', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await send(page, 'What is the capital of Franse?')
      await answerDone(page)

      // C6.4 for a message of the user: it moves into the composer.
      await page.getByTestId('m-chat-message-more').tap()
      await expect(page.getByTestId('m-sheet-message')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-message-edit').tap()
      await expect(page.getByTestId('m-sheet-message')).toHaveCount(0)
      await expect(page.getByTestId('m-chat-editing')).toBeVisible()
      // N5: the caret stands behind the old text, so typing continues it.
      await expect
        .poll(() => page.getByTestId('m-chat-input').evaluate((el) => (el as HTMLTextAreaElement).selectionStart === (el as HTMLTextAreaElement).value.length && (el as HTMLTextAreaElement).value.length > 0))
        .toBe(true)
      await expect(page.getByTestId('m-chat-input')).toHaveValue('What is the capital of Franse?')
      await backend(page, (ctl) => { ctl.reply = 'Paris, as before.' })
      await page.getByTestId('m-chat-input').fill('What is the capital of France?')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-send').tap()
      await answerDone(page, 'Paris, as before.')
      await expect(userMessages(page)).toHaveCount(1)
      await expect(userMessages(page)).toContainText('capital of France?')
      await expect(page.getByTestId('m-chat-editing')).toHaveCount(0)
      expect(await backend(page, (ctl) => JSON.parse(ctl.bodies.at(-1)).messages.at(-1).content)).toContain('France?')

      // Cancel an edit: the text that stood in the field before comes back.
      await page.getByTestId('m-chat-input').fill('a draft')
      await page.getByTestId('m-chat-message-more').tap()
      await page.getByTestId('m-chat-message-edit').tap()
      await page.getByTestId('m-chat-edit-cancel').tap()
      await expect(page.getByTestId('m-chat-input')).toHaveValue('a draft')
      await page.getByTestId('m-chat-input').fill('')

      // C6.4 for an answer: the full screen editor with Save and Cancel.
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-edit').tap()
      await expect(page.getByTestId('m-chat-message-edit-screen')).toBeVisible()
      await expect(page.getByTestId('m-chat-edit-save')).toBeDisabled()
      await page.getByTestId('m-chat-edit-field').fill('Paris. Edited by hand.')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-edit-save').tap()
      await expect(page.getByTestId('m-toast-answer-saved')).toBeVisible()
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      await expect(answers(page).last()).toContainText('Paris. Edited by hand.')

      // C6.6 Select text and C6.1 Copy.
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-select').tap()
      await expect(page.getByTestId('m-chat-message-text-screen')).toBeVisible()
      await expect(page.getByTestId('m-chat-text-body')).toHaveText('Paris. Edited by hand.')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-text-copy').tap()
      // The bridge answers a moment later, and nothing on this page waits for it.
      await expect.poll(() => backend(page, (ctl) => ctl.copied.at(-1))).toBe('Paris. Edited by hand.')
      await back(page)

      // C6.5 Share hands the text to the system.
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-share').tap()
      await expect(page.getByTestId('m-sheet-message')).toHaveCount(0)
      expect(await backend(page, (ctl) => ctl.shared.at(-1)?.text)).toBe('Paris. Edited by hand.')

      // C6.7 Delete asks first; "Cancel" keeps the message.
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-delete').tap()
      await expect(page.getByTestId('m-dialog-delete-message')).toBeVisible()
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(answers(page)).toHaveCount(1)
      await page.getByTestId('m-chat-message-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(answers(page)).toHaveCount(0)
      await expect(userMessages(page)).toHaveCount(1)
      await expect(page.getByTestId('m-toast-message-deleted')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('the chat list: search, rename, delete with a question, new chat', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await page.getByTestId('m-page-back').tap()
      await expect(page.getByTestId('m-chats-empty')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await seedChats(page, [
        { id: 'trip', title: 'Trip plan', ago: 3, messages: [{ role: 'user', content: 'Plan three days in Lisbon' }, { role: 'assistant', content: '## Day one\nStart in Alfama and take tram 28.' }] },
        { id: 'tides', title: 'Why the sea moves', ago: 90, messages: [{ role: 'user', content: 'Why are there tides?' }, { role: 'assistant', content: 'The moon pulls the water towards it.' }] },
        { id: 'bread', title: 'Sourdough', ago: 60 * 30, messages: [{ role: 'user', content: 'How long should the dough rest?' }, { role: 'assistant', content: 'About twelve hours in the fridge.' }] },
      ])
      const items = page.getByTestId('m-chats-item')
      await expect(items).toHaveCount(3)
      // Newest first, the second line is the first line of the last answer without its markup.
      await expect(items.first()).toContainText('Trip plan')
      await expect(items.first()).toContainText('Day one')
      await expect(items.first()).not.toContainText('##')
      expect(await layout(page)).toEqual(CLEAN)

      // C1.3: the search reads titles and content.
      await page.getByTestId('m-chats-search').fill('moon')
      await expect(items).toHaveCount(1)
      await expect(items).toContainText('Why the sea moves')
      await page.getByTestId('m-chats-search').fill('zeppelin')
      await expect(page.getByTestId('m-chats-nomatch')).toContainText('No chats match zeppelin.')
      await page.getByTestId('m-chats-nomatch-action').tap()
      await expect(items).toHaveCount(3)
      await expect(page.getByTestId('m-chats-search')).toHaveValue('')

      // C1.5 and C7.1: rename.
      await page.locator('[data-m-id="tides"] [data-testid="m-chats-item-more"]').tap()
      await expect(page.getByTestId('m-sheet-chat-menu')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-menu-rename').tap()
      await expect(page.getByTestId('m-dialog-rename')).toBeVisible()
      await page.getByTestId('m-dialog-field').fill('Tides explained')
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-sheet-chat-menu')).toHaveCount(0)
      await expect(page.locator('[data-m-id="tides"]')).toContainText('Tides explained')
      await expect(page.getByTestId('m-toast-renamed')).toBeVisible()

      // A long press on a row opens the same menu and does not open the chat.
      const row = page.locator('[data-m-id="bread"] [data-testid="m-chats-open"]')
      const box = (await row.boundingBox())!
      await row.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, clientX: box.x + 40, clientY: box.y + 20, bubbles: true })
      await expect(page.getByTestId('m-sheet-chat-menu')).toBeVisible()
      await expect(page.getByTestId('m-chats-screen')).toBeVisible()

      // C7.7: delete asks, the safe answer keeps the chat.
      await page.getByTestId('m-chat-menu-delete').tap()
      await expect(page.getByTestId('m-dialog-delete-chat')).toBeVisible()
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(items).toHaveCount(3)
      await page.getByTestId('m-chat-menu-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(items).toHaveCount(2)
      await expect(page.locator('[data-m-id="bread"]')).toHaveCount(0)
      await expect(page.getByTestId('m-toast-chat-deleted')).toBeVisible()

      // Round 57 (David): the switch has no grey box; the chosen half has full text and a thin accent line under it.
      const look = () =>
        page.evaluate(() => {
          const group = getComputedStyle(document.querySelector('[data-testid="m-chats-segment"]')!)
          const on = document.querySelector('[data-testid="m-chats-segment"] [aria-checked="true"]')!
          const off = document.querySelector('[data-testid="m-chats-segment"] [aria-checked="false"]')!
          return {
            box: group.backgroundColor,
            on: { id: on.getAttribute('data-testid'), bg: getComputedStyle(on).backgroundColor, line: getComputedStyle(on).boxShadow.includes('inset') },
            offLine: getComputedStyle(off).boxShadow,
          }
        })
      expect(await look()).toEqual({ box: 'rgba(0, 0, 0, 0)', on: { id: 'm-chats-segment-phone', bg: 'rgba(0, 0, 0, 0)', line: true }, offLine: 'none' })

      // C1.2: the second segment shows the remote home of strand 6, the list comes back.
      await page.getByTestId('m-chats-segment-remote').tap()
      expect((await look()).on.id).toBe('m-chats-segment-remote')
      await expect(page.getByTestId('m-remote-screen')).toBeVisible()
      await expect(page.getByTestId('m-chats-new')).toHaveCount(0)
      await page.getByTestId('m-chats-segment-phone').tap()
      await expect(items).toHaveCount(2)

      // C1.6 and C1.4.
      await page.getByTestId('m-chats-new').tap()
      await expect(page.getByTestId('m-chat-empty')).toBeVisible()
      await page.getByTestId('m-page-back').tap()
      await page.locator('[data-m-id="trip"] [data-testid="m-chats-open"]').tap()
      await expect(page.getByTestId('m-chat-screen')).toContainText('Trip plan')
      await expect(answers(page)).toContainText('Start in Alfama')

      // Deleting the open chat from its own menu leaves the page.
      await page.getByTestId('m-chat-menu').tap()
      await page.getByTestId('m-chat-menu-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-chats-screen')).toBeVisible()
      await expect(items).toHaveCount(1)
      expect(errors()).toEqual([])
    })

    test('the model sheet: engine models, switching, and the cloud list behind a sign in', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await openModelSheet(page)
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      const local = page.getByTestId('m-chat-model-local')
      await expect(local).toHaveCount(2)
      await expect(local.first()).toContainText('MB')
      await expect(page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${SMALL}"]`)).toHaveAttribute('data-state', 'ready')
      // A tap on the model that is already chosen is an answer too: the sheet closes, nothing is loaded again.
      const startsBefore = await backend(page, (ctl) => ctl.engineStarts.length)
      await page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${SMALL}"]`).tap()
      await expect(page.getByTestId('m-sheet-model')).toHaveCount(0)
      expect(await backend(page, (ctl) => ctl.engineStarts.length)).toBe(startsBefore)
      await openModelSheet(page)
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)

      // The cloud list, signed out: one way forward (C3.9).
      await page.getByTestId('m-chat-model-segment-cloud').tap()
      await expect(page.getByTestId('m-chat-model-signin')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-model-segment-local').tap()

      // C3.2: choose the other model. The sheet closes, the engine gets it, the chip names it.
      await page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${VISION}"]`).tap()
      await expect(page.getByTestId('m-sheet-model')).toHaveCount(0)
      await waitForModel(page, VISION_LABEL)
      await expect.poll(() => backend(page, (ctl) => ctl.engineStarts.at(-1))).toContain(VISION)

      await backend(page, (ctl) => { ctl.reply = 'Answered by the other model.' })
      await send(page, 'Who are you?')
      await answerDone(page, 'Answered by the other model.')
      await expect(page.getByTestId('m-chat-model-by').last()).toContainText(VISION_LABEL)

      // C3.4.
      await openModelSheet(page)
      await page.getByTestId('m-chat-model-get-more').tap()
      await expect(page.getByTestId('m-models-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('attach an image: the model must read images, the chip, the viewer, the sent message', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      const png = Buffer.from(await makePng(page), 'base64')

      // C4 with a model that cannot read images: the rows say so and lead to the models that can.
      await page.getByTestId('m-chat-attach').tap()
      await expect(page.getByTestId('m-sheet-attach')).toBeVisible()
      await expect(page.getByTestId('m-chat-attach-library')).toContainText('The chosen model cannot read images')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-attach-library').tap()
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      await expect(page.getByTestId('m-chat-model-vision-way')).toContainText('Choose a model that reads images below')
      await expect(page.getByTestId('m-chat-model-local-vision')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('m-chat-model-local')).toHaveCount(1)
      await page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${VISION}"]`).tap()
      await waitForModel(page, VISION_LABEL)

      // C4.2: the photo picker of the system.
      await page.getByTestId('m-chat-attach').tap()
      await expect(page.getByTestId('m-chat-attach-library')).toContainText('Up to 5 images')
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('m-chat-attach-library').tap()
      await (await chooser).setFiles({ name: 'harbour.png', mimeType: 'image/png', buffer: png })
      await expect(page.getByTestId('m-sheet-attach')).toHaveCount(0)
      const chip = page.getByTestId('m-chat-attachment')
      await expect(chip).toHaveCount(1)
      await expect(chip).toContainText('harbour.png')
      // An attachment alone makes the message sendable.
      await expect(page.getByTestId('m-chat-send')).toBeEnabled()
      expect(await layout(page)).toEqual(CLEAN)

      // C2.15: the chip opens the preview, the X removes it.
      await page.getByTestId('m-chat-attachment-open').tap()
      await expect(page.getByTestId('m-chat-file-screen')).toBeVisible()
      await expect(page.locator('[data-testid="m-chat-file-screen"] img')).toBeVisible()
      await page.getByTestId('m-viewer-close').tap()
      await page.getByTestId('m-chat-attachment-remove').tap()
      await expect(chip).toHaveCount(0)
      await expect(page.getByTestId('m-chat-mic')).toBeVisible()

      // C4.3: a file.
      await page.getByTestId('m-chat-attach').tap()
      const fileChooser = page.waitForEvent('filechooser')
      await page.getByTestId('m-chat-attach-file').tap()
      await (await fileChooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember the tram ticket.') })
      await expect(chip).toHaveCount(1)
      await expect(chip).toContainText('notes.txt')
      await page.getByTestId('m-chat-attachment-open').tap()
      await expect(page.getByTestId('m-chat-file-text')).toHaveText('Remember the tram ticket.')
      await page.getByTestId('m-viewer-close').tap()
      await page.getByTestId('m-chat-attachment-remove').tap()

      // Attach again and send it with a question.
      await page.getByTestId('m-chat-attach').tap()
      const again = page.waitForEvent('filechooser')
      await page.getByTestId('m-chat-attach-library').tap()
      await (await again).setFiles({ name: 'harbour.png', mimeType: 'image/png', buffer: png })
      await expect(chip).toHaveCount(1)
      await backend(page, (ctl) => { ctl.reply = 'A harbour at sunset.' })
      await send(page, 'What is in this picture?')
      await answerDone(page, 'A harbour at sunset.')
      await expect(chip).toHaveCount(0)
      const image = userMessages(page).getByTestId('m-chat-image')
      await expect(image).toHaveAttribute('data-state', 'ready')
      // The model got the image itself, not only its name.
      expect(await backend(page, (ctl) => ctl.bodies.at(-1))).toContain('image_url')
      expect(await layout(page)).toEqual(CLEAN)

      // C2.32 and C14: full screen, share, save to Photos.
      await image.tap()
      await expect(page.getByTestId('m-chat-file-screen')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-file-save').tap()
      await expect(page.getByTestId('m-toast-saved')).toHaveText('Saved to Photos')
      expect(await backend(page, (ctl) => ctl.saved.at(-1))).toEqual({ name: 'harbour.png', target: 'photos' })
      await page.getByTestId('m-chat-file-share').tap()
      await expect.poll(() => backend(page, (ctl) => ctl.shared.at(-1)?.name)).toBe('harbour.png')
      await expect(page.getByTestId('m-toast-shared')).toBeVisible()
      await page.getByTestId('m-viewer-close').tap()
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()

      // C7.6: the files of the chat.
      await page.getByTestId('m-chat-menu').tap()
      await page.getByTestId('m-chat-menu-files').tap()
      await expect(page.getByTestId('m-chat-menu-file')).toHaveCount(1)
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-menu-file').tap()
      await expect(page.getByTestId('m-chat-file-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('export hands a file to the share sheet, the toast comes after', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await page.getByTestId('m-page-back').tap()
      await seedChats(page, [{ id: 'trip', title: 'Trip plan: Lisbon', messages: [{ role: 'user', content: 'Plan three days in Lisbon' }, { role: 'assistant', content: 'Start in Alfama and take tram 28.' }] }])
      await openChat(page, 'trip')
      await page.getByTestId('m-chat-menu').tap()
      await page.getByTestId('m-chat-menu-export').tap()
      await expect(page.getByTestId('m-sheet-back')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-menu-export-markdown').tap()
      await expect(page.getByTestId('m-toast-export-ready')).toHaveText('Export ready')
      await expect(page.getByTestId('m-sheet-chat-menu')).toHaveCount(0)
      const markdown = await backend(page, (ctl) => ctl.shared.at(-1))
      expect(markdown.name).toBe('Trip_plan_Lisbon.md')
      expect(markdown.mime).toBe('text/markdown')
      expect(markdown.text).toContain('Start in Alfama and take tram 28.')

      await page.getByTestId('m-chat-menu').tap()
      await page.getByTestId('m-chat-menu-export').tap()
      await page.getByTestId('m-chat-menu-export-json').tap()
      await expect.poll(() => backend(page, (ctl) => ctl.shared.at(-1)?.name)).toBe('Trip_plan_Lisbon.json')
      await expect(page.getByTestId('m-toast-export-ready')).toBeVisible()
      await expect(page.getByTestId('m-sheet-chat-menu')).toHaveCount(0)
      const json = await backend(page, (ctl) => ctl.shared.at(-1))
      expect(JSON.parse(json.text).messages).toHaveLength(2)

      // "Save to this phone" writes the file to a folder and the sheet keeps saying where it is (Android M8).
      await page.getByTestId('m-chat-menu').tap()
      await page.getByTestId('m-chat-menu-export').tap()
      await page.getByTestId('m-chat-menu-save-markdown').tap()
      await expect(page.getByTestId('m-chat-menu-save-note')).toContainText('Saved as Trip_plan_Lisbon.md in the folder you picked.')
      expect(await backend(page, (ctl) => ctl.saved.at(-1))).toEqual({ name: 'Trip_plan_Lisbon.md', target: 'files' })
      expect(await layout(page)).toEqual(CLEAN)
      // The system refuses: the sentence says so and names the other way.
      await backend(page, (ctl) => { ctl.refuse.save = true })
      await page.getByTestId('m-chat-menu-save-json').tap()
      await expect(page.getByTestId('m-chat-menu-save-note')).toContainText('could not be written')
      await backend(page, (ctl) => { ctl.refuse.save = false })
      await page.getByTestId('m-sheet-close').tap()

      // The other rows of C7 lead to the pages of strand 2. "Background tasks" is not among them here: the model of
      // this chat runs on the phone, and such a model starts no sub agents (decision of 09.10.2026, e2e in agent.mobile.ts).
      for (const [row, screen] of [['m-chat-menu-compare', 'm-chat-compare-screen'], ['m-chat-menu-documents', 'm-chat-documents-screen']] as const) {
        await page.getByTestId('m-chat-menu').tap()
        await expect(page.getByTestId('m-chat-menu-tasks')).toHaveCount(0)
        await page.getByTestId(row).tap()
        await expect(page.getByTestId(screen)).toBeVisible()
        await back(page)
        await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      }
      expect(errors()).toEqual([])
    })

    test('markdown: a code block copies, a web page previews, a link asks first', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await page.getByTestId('m-page-back').tap()
      await seedChats(page, [
        {
          id: 'md',
          title: 'Markdown',
          messages: [
            { role: 'user', content: 'Show me everything' },
            {
              role: 'assistant',
              content: [
                '# Heading',
                'Some **bold** text and `inline code`, with a [link to the docs](https://example.org/a/very/long/path/that/keeps/going/and/going?with=query&and=more).',
                '',
                '- one',
                '- two',
                '',
                '```python',
                'def a_function_with_a_very_long_name(first_argument, second_argument, third_argument): return first_argument',
                '```',
                '',
                '| Column one | Column two | Column three | Column four |',
                '| --- | --- | --- | --- |',
                '| a long cell value | another long cell value | and a third | and a fourth |',
                '',
                '```html',
                '<!doctype html><html><body><h1>Hello</h1></body></html>',
                '```',
              ].join('\n'),
            },
          ],
        },
      ])
      await openChat(page, 'md')
      const answer = answers(page).last()
      await expect(answer.locator('h1')).toHaveText('Heading')
      await expect(answer.locator('strong')).toHaveText('bold')
      await expect(answer.locator('li')).toHaveCount(2)
      await expect(answer.locator('table')).toBeVisible()
      // Nothing pushes the page wider: code and table scroll inside their own frame.
      expect(await layout(page)).toEqual(CLEAN)
      const codeWidth = await answer.getByTestId('m-chat-code').first().locator('pre').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
      expect(codeWidth.scroll).toBeGreaterThan(codeWidth.client)

      // C2.22.
      await answer.getByTestId('m-chat-code-copy').first().tap()
      await expect(page.getByTestId('m-toast-copied')).toBeVisible()
      expect(await backend(page, (ctl) => ctl.copied.at(-1))).toContain('def a_function_with_a_very_long_name')

      // C2.23: only the web page offers Preview, and it opens C11 with the second block of this message.
      await expect(answer.getByTestId('m-chat-code-preview')).toHaveCount(1)
      await answer.getByTestId('m-chat-code-preview').tap()
      await expect(page.getByTestId('m-chat-preview-screen')).toBeVisible()
      expect(await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('lu-mobile-nav') ?? '{}')))).toContain('md-m1~1')
      // The page of strand 2 found the same block the chat counted: the web page, not the Python block before it.
      await expect(page.getByTestId('m-preview-frame')).toHaveAttribute('srcdoc', /<h1>Hello<\/h1>/)
      await expect(page.getByTestId('m-preview-missing')).toHaveCount(0)
      await page.getByTestId('m-preview-close').tap()
      await expect(page.getByTestId('m-chat-preview-screen')).toHaveCount(0)

      // C2.34: the whole address, then the browser of the system.
      await answer.getByTestId('m-chat-link').tap()
      await expect(page.getByTestId('m-sheet-chat-link')).toBeVisible()
      await expect(page.getByTestId('m-chat-link-url')).toHaveText('https://example.org/a/very/long/path/that/keeps/going/and/going?with=query&and=more')
      expect(await layout(page)).toEqual(CLEAN)
      expect(await backend(page, (ctl) => ctl.opened.length)).toBe(0)
      await page.getByTestId('m-chat-link-open').tap()
      await expect(page.getByTestId('m-sheet-chat-link')).toHaveCount(0)
      expect(await backend(page, (ctl) => ctl.opened)).toEqual(['https://example.org/a/very/long/path/that/keeps/going/and/going?with=query&and=more'])
      expect(errors()).toEqual([])
    })

    test('error: the stream of the model on the phone breaks in the middle', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { reply: LONG_REPLY, chunks: 20, delay: 20 })
      await waitForModel(page)
      await backend(page, (ctl) => { ctl.mode = 'break' })
      await send(page, 'Tell me about tides')
      const box = page.getByTestId('m-chat-error')
      await expect(box).toBeVisible()
      // The model of this test runs on the phone: nothing left it, so the box does not speak of a connection (round 5, N2).
      await expect(box).toContainText('The model on this phone was interrupted')
      await expect(box).toContainText('The part that arrived is kept.')
      await expect(box).not.toContainText(/connection|network/i)
      // The part is still there, without the raw error line.
      await expect(answers(page).last().getByTestId('m-chat-answer')).toContainText('Sentence 1 ')
      await expect(answers(page).last().getByTestId('m-chat-answer')).not.toContainText('Error:')
      await expect(answers(page).last()).toHaveAttribute('data-state', 'error')
      await expect(userMessages(page)).toContainText('Tell me about tides')
      expect(await layout(page)).toEqual(CLEAN)

      // The next step: try again, and it goes through.
      await backend(page, (ctl) => { ctl.mode = 'ok'; ctl.reply = 'The moon pulls the water.' })
      await page.getByTestId('m-chat-error-action').tap()
      await answerDone(page, 'The moon pulls the water.')
      await expect(box).toHaveCount(0)
      expect(errors().filter((e) => !/connection reset/.test(e))).toEqual([])
    })

    test('error: the engine is not ready', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await backend(page, (ctl) => { ctl.mode = 'refuse' })
      await send(page, 'Hello?')
      const box = page.getByTestId('m-chat-error')
      await expect(box).toBeVisible({ timeout: 30_000 })
      await expect(box).toContainText('The on device engine did not answer')
      await expect(box).toContainText('Your message is kept.')
      await expect(box).not.toContainText('proxy_localhost')
      await expect(userMessages(page)).toContainText('Hello?')
      expect(await layout(page)).toEqual(CLEAN)
      // Two ways on: choose a model, or try again.
      await page.getByTestId('m-chat-error-alt').tap()
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      await page.getByTestId('m-sheet-close').tap()
      await backend(page, (ctl) => { ctl.mode = 'ok'; ctl.reply = 'Here I am.' })
      await page.getByTestId('m-chat-error-action').tap()
      await answerDone(page, 'Here I am.')
      expect(errors().filter((e) => !/503|Service Unavailable|not answering/.test(e))).toEqual([])
    })

    test('error: no model is installed', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { models: [] })
      const empty = page.getByTestId('m-chat-empty')
      await expect(empty).toContainText('No model yet.')
      await expect(page.getByTestId('m-chat-options')).toContainText('Choose a model')
      expect(await layout(page)).toEqual(CLEAN)

      // Sending keeps the text and opens the model sheet, which says where models come from.
      await send(page, 'Is anyone there?')
      await expect(page.getByTestId('m-toast-choose-model')).toHaveText('Choose a model first. Your message is kept.')
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      await expect(page.getByTestId('m-chat-model-empty')).toContainText('No model on this phone yet.')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-sheet-close').tap()
      await expect(page.getByTestId('m-chat-input')).toHaveValue('Is anyone there?')

      await page.getByTestId('m-chat-use-cloud').tap()
      await expect(page.getByTestId('m-cloud-screen')).toBeVisible()
      await back(page)
      await page.getByTestId('m-chat-install-model').tap()
      await expect(page.getByTestId('m-models-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('LU Cloud: choose a cloud model, credits run out, the session ends', async ({ page }) => {
      const errors = watchErrors(page)
      await routeCloud(page, { license: 'active', access: true, paidPlan: true })
      let answerWith: 'credits' | 'expired' | 'ok' = 'credits'
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
      await page.route('https://lu-labs.ai/api/inference/v1/chat/completions', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        if (answerWith === 'credits') return route.fulfill({ status: 429, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Monthly credit budget exhausted.', code: 'credits_exhausted' }) })
        if (answerWith === 'expired') return route.fulfill({ status: 401, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Session expired. Sign in again.' }) })
        const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: frame({ role: 'assistant' }, null) + frame({ content: 'Hello from the cloud.' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n' })
      })
      // The anonymous counter of the Cloud switch (settings/parts/cloud-mode.ts). Mocked like all of LU Cloud.
      let switchCounts = 0
      await page.route('https://lu-labs.ai/api/funnel/switch', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        switchCounts += 1
        return route.fulfill({ status: 204, headers: cors })
      })
      await boot(page)
      await waitForModel(page)
      await signInCloud(page)

      // C3.5 to C3.8: the catalogue with search, filters and the price page.
      await openModelSheet(page)
      await page.getByTestId('m-chat-model-segment-cloud').tap()
      const cloudRows = page.locator('[data-testid="m-sheet-model"] [data-testid^="m-chat-model-cloud"]')
      await expect(cloudRows.first()).toBeVisible({ timeout: 20_000 })
      const total = await cloudRows.count()
      expect(total).toBeGreaterThan(1)
      // The catalogue stands in groups, one per family of models, each under its own head.
      const families = page.getByTestId('m-chat-model-family')
      const familyCount = await families.count()
      expect(familyCount).toBeGreaterThan(0)
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-model-search').fill('zzzz')
      await expect(page.getByTestId('m-chat-model-nomatch')).toContainText('No model matches.')
      await page.getByTestId('m-chat-model-nomatch-action').tap()
      await expect(cloudRows).toHaveCount(total)
      await page.getByTestId('m-chat-model-filter-vision').tap()
      await expect(page.getByTestId('m-chat-model-filter-vision')).toHaveAttribute('aria-pressed', 'true')
      await page.getByTestId('m-chat-model-filter-vision').tap()
      await page.getByTestId('m-chat-model-price').first().tap()
      await expect(page.getByTestId('m-chat-model-price-page')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-sheet-back').tap()

      // C3.7 from the local mode: G11 asks, "Stay on device" changes nothing.
      const cheapest = page.getByTestId('m-chat-model-cloud-cheapest')
      const cloudName = (await cheapest.locator('.m-row-title').innerText()).trim()
      await cheapest.tap()
      await expect(page.getByTestId('m-dialog-cloud-switch')).toContainText('Switch to Cloud?')
      await page.getByTestId('m-dialog-cancel').tap()
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      // Yes to the switch: before anything goes to LU Cloud the user agrees once (store duty). "Not now" stays local.
      await cheapest.tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-consent-text')).toContainText('LU Cloud')
      await page.getByTestId('m-consent-decline').tap()
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      await expect(page.getByTestId('m-chat-options').last()).toHaveAttribute('data-m-place', 'local')
      await cheapest.tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await page.getByTestId('m-consent-agree').tap()
      await expect(page.getByTestId('m-sheet-model')).toHaveCount(0)
      await waitForModel(page, cloudName)
      await expect(page.getByTestId('m-chat-options').last()).toHaveAttribute('data-m-place', 'cloud')
      // The model sheet goes through the one door of the mode, so the switch is counted like every other.
      // Review M2: the phone counts anonymously through the native layer only. The count per account,
      // which this route would see, is never sent.
      await page.waitForTimeout(300)
      expect(switchCounts).toBe(0)
      // The consent can be taken back in the settings. The composer then asks again before it sends.
      await page.evaluate(async () => {
        const { revokeAiConsent } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/policy/consent.ts`)
        revokeAiConsent()
      })
      // A message to a cloud model costs credits: Send carries the mark the test frame stops at.
      await page.getByTestId('m-chat-input').fill('x')
      await expect(page.getByTestId('m-chat-send')).toHaveAttribute('data-m-risk', 'paid')
      await page.getByTestId('m-chat-input').fill('')
      expect(await layout(page)).toEqual(CLEAN)

      // Credits are empty: the server says so, the event opens G5, the transcript keeps a box with the next steps.
      // Store policy: before the first send to a cloud model LU asks. "Not now" sends nothing and keeps the text.
      let cloudCalls = 0
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/api/inference/')) cloudCalls += 1
      })
      await send(page, 'Hello cloud')
      await expect(page.getByTestId('m-consent-text')).toContainText('LU Cloud')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-consent-decline').tap()
      await expect(page.getByTestId('m-toast-consent-declined')).toContainText('Nothing was sent')
      await expect(page.getByTestId('m-chat-input')).toHaveValue('Hello cloud')
      await expect(userMessages(page)).toHaveCount(0)
      expect(cloudCalls).toBe(0)
      // Asked again on the next try. Agreed: the message goes out, and LU does not ask a second time.
      await page.getByTestId('m-chat-send').tap()
      await page.getByTestId('m-consent-agree').tap()
      await expect(page.getByTestId('m-sheet-credits')).toBeVisible({ timeout: 20_000 })
      await page.getByTestId('m-sheet-close').tap()
      const box = page.getByTestId('m-chat-error')
      await expect(box).toContainText("You're out of credits")
      await expect(box).toContainText('On device models keep working.')
      await expect(userMessages(page)).toContainText('Hello cloud')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-error-action').tap()
      await expect(page.getByTestId('m-cloud-screen')).toBeVisible()
      await back(page)

      // The session ended: G6 opens, the box says "Please sign in again", the message is still there.
      answerWith = 'expired'
      // Asking a cloud model again costs credits too: the button carries the same mark as Send.
      await expect(page.getByTestId('m-chat-regenerate')).toHaveAttribute('data-m-risk', 'paid')
      await page.getByTestId('m-chat-regenerate').tap()
      await expect(page.getByTestId('m-sheet-session')).toBeVisible({ timeout: 20_000 })
      await page.getByTestId('m-sheet-close').tap()
      await expect(box).toContainText('Please sign in again')
      await expect(box).toContainText('Your message is kept.')
      await expect(userMessages(page)).toContainText('Hello cloud')

      // The way out that always works: an on device model. The mode goes back with the choice.
      await page.getByTestId('m-chat-error-alt').tap()
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      await page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${SMALL}"]`).tap()
      await expect(page.getByTestId('m-toast-back-on-device')).toHaveText('Back on device')
      await waitForModel(page, SMALL)
      await expect(page.getByTestId('m-chat-options').last()).toHaveAttribute('data-m-place', 'local')
      await backend(page, (ctl) => { ctl.reply = 'Back on the phone.' })
      await expect(page.getByTestId('m-chat-regenerate')).not.toHaveAttribute('data-m-risk', 'paid')
      await page.getByTestId('m-chat-regenerate').tap()
      await answerDone(page, 'Back on the phone.')
      await expect(box).toHaveCount(0)
      expect(errors().filter((e) => !/429|401|credit|Session expired/i.test(e))).toEqual([])
    })

    test('store policy: every answer can be reported, a message of the user cannot', async ({ page }) => {
      const errors = watchErrors(page)
      const outside: string[] = []
      page.on('request', (request) => {
        if (/lu-labs\.ai|report/i.test(request.url()) && !request.url().startsWith('http://localhost') && !CLOUD_PROBE.test(request.url())) outside.push(request.url())
      })
      await boot(page)
      await waitForModel(page)
      await send(page, 'Say something')
      await answerDone(page)
      await page.getByTestId('m-chat-message-more').first().tap()
      await expect(page.getByTestId('m-chat-message-copy')).toBeVisible()
      await expect(page.getByTestId('m-chat-message-report')).toHaveCount(0)
      await page.getByTestId('m-sheet-close').tap()

      // One tap from the answer itself, not only behind "More" (store policy: a report button at every answer).
      const direct = page.getByTestId('m-chat-report')
      await expect(direct).toHaveAccessibleName('Report this answer')
      expect(await layout(page)).toEqual(CLEAN)
      await direct.tap()
      await expect(page.getByTestId('m-report-send')).toBeVisible()
      await page.getByTestId('m-sheet-close').tap()
      await expect(page.getByTestId('m-report-send')).toHaveCount(0)

      await page.getByTestId('m-chat-answer-more').tap()
      await expect(page.getByTestId('m-chat-message-report')).toContainText('Report')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-message-report').tap()
      await expect(page.getByTestId('m-report-send')).toBeVisible()
      await expect(page.getByTestId('m-report-intro')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      // The sheet of the scaffold asks for a reason first; the stand in of this strand has none.
      const reason = page.locator('[data-testid^="m-report-reason-"]').first()
      if (await reason.count()) await reason.tap()
      await page.getByTestId('m-report-send').tap()
      await expect(page.locator('[data-testid^="m-toast-report-"]')).toContainText(/Report (saved|sent)/)
      await expect(page.getByTestId('m-report-send')).toHaveCount(0)
      // Nothing left the phone for it.
      expect(outside).toEqual([])
      expect(errors()).toEqual([])
    })

    for (const mode of ['play', 'appstore'] as const) {
      test(`store policy "${mode}": the credits box carries no way to buy`, async ({ page }) => {
        const errors = watchErrors(page)
        await boot(page, { store: mode })
        await waitForModel(page)
        await page.getByTestId('m-page-back').tap()
        await seedChats(page, [
          {
            id: 'spent',
            title: 'Spent',
            messages: [
              { role: 'user', content: 'Hello cloud' },
              { role: 'assistant', modelId: 'lu-cloud::some-model', content: OUT_OF_CREDITS },
            ],
          },
        ])
        await openChat(page, 'spent')
        const box = page.getByTestId('m-chat-error')
        await expect(box).toBeVisible()
        // No button to the plans and no link, in both presets. The way to an on device model stays.
        await expect(page.getByTestId('m-chat-error-action')).toHaveCount(0)
        await expect(box.locator('a')).toHaveCount(0)
        await expect(page.getByTestId('m-chat-error-alt')).toBeVisible()
        if (mode === 'play') {
          // Neutral words, and the one sentence a store allows without a link (strings/policy.ts).
          await expect(box).toContainText('LU Cloud cannot answer right now')
          await expect(box).toContainText('Plans and credits are available on lu-labs.ai.')
          await expect(box).not.toContainText(/out of credits|buy|upgrade/i)
        } else {
          await expect(box).toContainText('LU Cloud cannot answer right now')
          await expect(box).not.toContainText(/credit|plan|buy|upgrade|lu-labs/i)
        }
        await expect(box).toContainText('On device models keep working.')
        expect(await layout(page)).toEqual(CLEAN)
        await page.getByTestId('m-chat-error-alt').tap()
        await expect(page.getByTestId('m-sheet-model')).toBeVisible()
        expect(errors()).toEqual([])
      })
    }

    test('the remaining ways: states of an answer, the sheets and pages behind a message, what is gone', async ({ page }) => {
      const errors = watchErrors(page)
      // A phone whose WebView brings no voice of its own (the usual case on Android).
      await page.addInitScript(() => Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }))
      await boot(page)
      await waitForModel(page)

      // C1.6: the plus in the header of the empty list starts a chat.
      await page.getByTestId('m-page-back').tap()
      await page.getByTestId('m-chats-empty-new').tap()
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      await page.getByTestId('m-page-back').tap()

      await seedChats(page, [
        {
          id: 'a',
          title: 'Links',
          messages: [
            { role: 'user', content: 'Where do I read on?', files: [{ name: 'notes.pdf', size: 20480, kind: 'pdf', sha256: 'abc', summary: 'Two pages about tides.' }] },
            { role: 'assistant', content: 'Read on at [the tide pages](https://example.org/tides).' },
          ],
        },
        { id: 'refused', title: 'Refused', messages: [{ role: 'user', content: 'Do it' }, { role: 'assistant', content: "I'm sorry, but I can't help with that." }] },
        { id: 'cut', title: 'Cut off', messages: [{ role: 'user', content: 'Go on' }, { role: 'assistant', content: 'This answer stops in the', finishReason: 'length' }] },
      ])

      // C2.26: a refusal names its way out, a new chat.
      await openChat(page, 'refused')
      await expect(page.getByTestId('m-chat-refusal')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-refusal-new').tap()
      await expect(page.getByTestId('m-chat-empty')).toBeVisible()
      await page.getByTestId('m-page-back').last().tap()

      // An answer that hit the length limit says so.
      await openChat(page, 'cut')
      await expect(page.getByTestId('m-chat-cut')).toBeVisible()

      // C2.18 and C6.2: read aloud without a voice on this phone explains what it needs.
      await openChat(page, 'a')
      // "Read aloud" is off in the settings at first: no speaker button stands under the answer (Android N10).
      await expect(page.getByTestId('m-chat-answer-actions')).toBeVisible()
      await expect(page.getByTestId('m-chat-speak')).toHaveCount(0)
      // The menu of the message still offers it. This phone has no voice at all, so it names what can read: LU Cloud.
      // It does not send the user to a switch that is locked on such a phone.
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-speak').tap()
      await expect(page.getByTestId('m-chat-voice-gate-text')).toHaveAttribute('data-m-kind', 'speak')
      await expect(page.getByTestId('m-sheet-chat-voice-gate')).toContainText('Read aloud uses LU Cloud')
      await expect(page.getByTestId('m-chat-voice-gate-text')).toContainText('This phone has no voice installed')
      await expect(page.getByTestId('m-chat-voice-gate-settings')).toHaveCount(0)
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-voice-gate-later').tap()

      // A file of an older message: its bytes were never kept, the viewer says what the model was told.
      await page.getByTestId('m-chat-file').tap()
      await expect(page.getByTestId('m-chat-file-info')).toContainText('notes.pdf')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-viewer-close').tap()

      // C2.34: "Not now" closes the question, then copy the address instead of opening it.
      await page.getByTestId('m-chat-link').tap()
      await page.getByTestId('m-chat-link-cancel').tap()
      await expect(page.getByTestId('m-sheet-chat-link')).toHaveCount(0)
      await page.getByTestId('m-chat-link').tap()
      await page.getByTestId('m-chat-link-copy').tap()
      await expect(page.getByTestId('m-toast-copied')).toBeVisible()
      expect(await backend(page, (ctl) => ctl.copied.at(-1))).toBe('https://example.org/tides')
      await expect(page.getByTestId('m-sheet-chat-link')).toHaveCount(0)

      // C6.4 for an answer: "Cancel" leaves it as it was.
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-edit').tap()
      await expect(page.getByTestId('m-chat-edit-field')).toBeVisible()
      await page.getByTestId('m-chat-edit-cancel-page').tap()
      await expect(page.getByTestId('m-chat-edit-field')).toHaveCount(0)
      await expect(answers(page).last()).toContainText('Read on at')

      // A message that is gone: every place that pointed at it says so and leads back.
      const go = (fn: string) => page.evaluate(`import(location.origin + '/src/mobile/nav/index.ts').then(({ nav }) => { ${fn} })`)
      await go(`nav.push('/chat/:id/message/:messageId/edit', { id: 'a', messageId: 'nope' })`)
      await expect(page.getByTestId('m-chat-edit-gone')).toBeVisible()
      await page.getByTestId('m-chat-edit-back').tap()
      await expect(page.getByTestId('m-chat-edit-gone')).toHaveCount(0)
      await go(`nav.push('/chat/:id/message/:messageId/text', { id: 'a', messageId: 'nope' })`)
      await expect(page.getByTestId('m-chat-text-gone')).toBeVisible()
      await page.getByTestId('m-chat-text-back').tap()
      await expect(page.getByTestId('m-chat-text-gone')).toHaveCount(0)
      await go(`nav.openSheet('message', { chatId: 'a', messageId: 'nope' })`)
      await expect(page.getByTestId('m-chat-message-gone')).toBeVisible()
      await page.getByTestId('m-sheet-close').tap()

      // C6.3: regenerate from the sheet.
      await backend(page, (ctl) => { ctl.reply = 'A second try.' })
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-regenerate').tap()
      await answerDone(page, 'A second try.')

      // C4.4: documents of this chat belong to strand 2; the row leads to its page.
      await page.getByTestId('m-chat-attach').tap()
      await page.getByTestId('m-chat-attach-documents').tap()
      await expect(page.getByTestId('m-chat-documents-screen')).toBeVisible()
      await back(page)

      // C4.1: the camera, with a model that reads images.
      await openModelSheet(page)
      await page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${VISION}"]`).tap()
      await waitForModel(page, VISION_LABEL)
      await page.getByTestId('m-chat-attach').tap()
      const camera = page.waitForEvent('filechooser')
      await page.getByTestId('m-chat-attach-photo').tap()
      await (await camera).setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(await makePng(page), 'base64') })
      await expect(page.getByTestId('m-chat-attachment')).toHaveCount(1)
      await page.getByTestId('m-chat-attachment-remove').tap()
      await expect(page.getByTestId('m-chat-attachment')).toHaveCount(0)

      // The engine failed to start: the chat and the model sheet say why, "Dismiss" takes the line away.
      await page.evaluate(async () => {
        const { useLuEngineSwitchStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/luEngineSwitchStore.ts`)
        useLuEngineSwitchStore.getState().announce('Not enough memory for this model.', 'error')
      })
      // Said once: the notice of the engine carries it, with the way to another model. No second box with the same words.
      await expect(page.getByTestId('m-engine-notice-failed')).toContainText('Not enough memory for this model.')
      await expect(page.getByTestId('m-engine-notice-failed')).toHaveCount(1)
      await expect(page.getByTestId('m-chat-engine-error')).toHaveCount(0)
      await expect(page.getByTestId('m-chat-screen').getByText('Not enough memory for this model.')).toHaveCount(1)
      expect(await layout(page)).toEqual(CLEAN)
      await openModelSheet(page)
      await expect(page.getByTestId('m-chat-model-engine-error')).toContainText('Not enough memory for this model.')
      await expect(page.getByTestId('m-chat-model-engine-retry')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-model-engine-dismiss').tap()
      await expect(page.getByTestId('m-chat-model-engine-error')).toHaveCount(0)
      await page.getByTestId('m-sheet-close').tap()
      await expect(page.getByTestId('m-engine-notice-failed')).toHaveCount(0)

      // A chat that is gone.
      await go(`nav.push('/chat/:id', { id: 'no-such-chat' })`)
      await expect(page.getByTestId('m-chat-missing')).toBeVisible()
      await page.getByTestId('m-chat-missing-back').tap()
      await expect(page.getByTestId('m-chat-missing')).toHaveCount(0)
      expect(errors()).toEqual([])
    })

    test('the credits event opens the sheet for it', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu:credits-exhausted', { detail: { reason: 'credits' } })))
      await expect(page.getByTestId('m-sheet-credits')).toBeVisible()
      await page.getByTestId('m-sheet-close').tap()
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
    })

    test('voice without a voice on this phone: dictation and read aloud say what they need', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await page.getByTestId('m-chat-mic').tap()
      await expect(page.getByTestId('m-sheet-chat-voice-gate')).toContainText('Dictation uses LU Cloud')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-voice-gate-later').tap()
      await expect(page.getByTestId('m-sheet-chat-voice-gate')).toHaveCount(0)
      await page.getByTestId('m-chat-mic').tap()
      await page.getByTestId('m-chat-voice-gate-cloud').tap()
      await expect(page.getByTestId('m-cloud-screen')).toBeVisible()
      expect(errors()).toEqual([])
    })

    test('slash commands show above the field, the options and the status chips open their sheets', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      // In a plain chat only /compact does something; /goal and /loop belong to the agent.
      await page.getByTestId('m-chat-input').fill('/')
      const commands = page.getByTestId('m-chat-command')
      await expect(commands).toHaveCount(1)
      await expect(page.getByTestId('m-chat-commands')).toContainText('/compact')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-input').fill('')
      await expect(commands).toHaveCount(0)

      // With the agent on for this chat, the three commands of a phone show.
      await send(page, 'Hello')
      await answerDone(page)
      await page.evaluate(async () => {
        const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
        const { useAgentModeStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/agentModeStore.ts`)
        const id = useChatStore.getState().activeConversationId
        if (id && !useAgentModeStore.getState().isActive(id)) useAgentModeStore.getState().toggleAgentMode(id)
      })
      await page.getByTestId('m-chat-input').fill('/')
      await expect(commands).toHaveCount(3)
      await expect(page.getByTestId('m-chat-commands')).toContainText('/goal')
      await expect(page.getByTestId('m-chat-commands')).toContainText('/loop')
      expect(await layout(page)).toEqual(CLEAN)
      await page.locator('[data-testid="m-chat-command"][data-m-id="goal"]').tap()
      await expect(page.getByTestId('m-chat-input')).toHaveValue('/goal ')
      await expect(commands).toHaveCount(0)
      await page.getByTestId('m-chat-input').fill('')

      await page.getByTestId('m-chat-options').tap()
      await expect(page.getByTestId('m-sheet-chat-options')).toBeVisible()
      await page.getByTestId('m-sheet-close').tap()

      // Prompt v2: the context chip stands above the field only when it wants attention; the window is in the options.
      await expect(page.getByTestId('m-chat-context')).toHaveCount(0)
      await page.getByTestId('m-chat-options').tap()
      await expect(page.getByTestId('m-options-context')).toBeVisible()
      await page.getByTestId('m-sheet-close').tap()
      expect(errors()).toEqual([])
    })

    test('the text field grows to six lines, a long chat keeps its place and offers "Jump to latest"', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { reply: LONG_REPLY, chunks: 30, delay: 60 })
      await waitForModel(page)
      const input = page.getByTestId('m-chat-input')
      const one = (await input.boundingBox())!.height
      await input.fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'))
      const many = await input.evaluate((el) => ({ height: el.getBoundingClientRect().height, scroll: el.scrollHeight }))
      // Prompt v2: the field starts at three lines and grows to about six, so twice the start is more than it takes.
      expect(many.height).toBeGreaterThan(one * 1.5)
      expect(many.scroll).toBeGreaterThan(many.height)
      // The composer stays inside the window, with the send button reachable.
      const sendBox = (await page.getByTestId('m-chat-send').boundingBox())!
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(size.height)
      expect(await layout(page)).toEqual(CLEAN)
      await input.fill('')

      await page.getByTestId('m-page-back').tap()
      await seedChats(page, [{ id: 'long', title: 'Long chat', messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), content: `Message ${i + 1}. ${'Some more words to fill the line. '.repeat(4)}` })) }])
      await openChat(page, 'long')
      const body = page.locator('[data-testid="m-chat-screen"] .m-body')
      const atEnd = () => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
      // A chat opens at its end.
      await expect.poll(atEnd).toBeLessThan(4)
      await expect(page.getByTestId('m-chat-jump')).toHaveCount(0)

      // The reader scrolls up, an answer streams in below: the view stays, "Jump to latest" appears.
      await send(page, 'Tell me more')
      await expect(page.getByTestId('m-chat-stop')).toBeVisible()
      // At the end the view follows the answer from its first word on.
      await expect(answers(page).last()).toContainText('Sentence 3')
      await expect.poll(atEnd).toBeLessThan(4)
      await expect(page.getByTestId('m-chat-jump')).toHaveCount(0)
      await readUp(page)
      await expect(page.getByTestId('m-chat-jump')).toBeVisible()
      // What the reader looks at stays where it is while text arrives below.
      const marker = page.locator('[data-testid="m-chat-message"][data-m-id="long-m2"]')
      // Measured inside the transcript: the notice area above it may gain or lose a line while a run goes.
      const inBody = () => marker.evaluate((el) => el.getBoundingClientRect().top - el.closest('.m-body')!.getBoundingClientRect().top)
      // Messages that were off screen get their real height once after the jump. Wait for that to settle.
      let held = await inBody()
      await expect
        .poll(async () => {
          const before = held
          await page.waitForTimeout(120)
          held = await inBody()
          return Math.abs(held - before)
        })
        .toBeLessThan(1)
      await expect(answers(page).last()).toContainText('Sentence 10')
      expect(Math.abs((await inBody()) - held)).toBeLessThan(2)
      expect(await atEnd()).toBeGreaterThan(200)
      expect(await layout(page)).toEqual(CLEAN)

      // C2.31: back to the end, and from there the view follows the answer again.
      await page.getByTestId('m-chat-jump').tap()
      await expect.poll(atEnd).toBeLessThan(80)
      await expect(page.getByTestId('m-chat-jump')).toHaveCount(0)
      await answerDone(page, 'Sentence 40')
      await expect.poll(atEnd).toBeLessThan(4)
      expect(errors()).toEqual([])
    })

    /* ---------- round 2 ---------- */

    test('the loading line at the largest text: the ring before "Loading" is whole (round 12, F13)', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { loaded: null, startDelay: 6000, fontScale: 200 })
      await waitForModel(page)
      const line = page.getByTestId('m-chat-loading-model')
      await expect(line).toContainText(`Loading ${SMALL}`)
      const box = await line.evaluate((el) => {
        const ring = el.querySelector('.m-ring') as HTMLElement
        const r = ring.getBoundingClientRect()
        // The first thing that clips the line: the dock scrolls inside and hides what leaves it sideways.
        let clip: HTMLElement | null = el.parentElement
        while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement
        const c = (clip ?? document.documentElement).getBoundingClientRect()
        const style = getComputedStyle(ring)
        return { left: r.left, right: r.right, width: r.width, height: r.height, clipLeft: c.left, clipRight: c.right, wants: parseFloat(style.width), text: el.getBoundingClientRect().left }
      })
      expect(box.left).toBeGreaterThanOrEqual(box.clipLeft)
      expect(box.right).toBeLessThanOrEqual(box.clipRight)
      // Round, and as large as it asks to be: a ring that is squeezed by its row is cut as well.
      expect(Math.abs(box.width - box.height)).toBeLessThan(1)
      expect(box.width).toBeGreaterThanOrEqual(box.wants - 1)
      expect(errors()).toEqual([])
    })

    test('a chat that has not started has no menu button, it comes with the first message (round 12, F13)', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      await expect(page.getByTestId('m-chat-options')).toBeVisible()
      await expect(page.getByTestId('m-chat-menu')).toHaveCount(0)
      await send(page, 'Hello')
      await answerDone(page)
      await page.getByTestId('m-chat-menu').tap()
      await expect(page.getByTestId('m-chat-menu-rename')).toBeVisible()
      await expect(page.getByTestId('m-chat-menu-empty')).toHaveCount(0)
      expect(errors()).toEqual([])
    })

    test('the model loads ahead: "Loading" with its name, typing works, a message sent meanwhile waits for the same load', async ({ page }) => {
      const errors = watchErrors(page)
      // Nothing is in memory at the start, and a start of the engine takes a moment.
      await boot(page, { loaded: null, startDelay: 2500 })
      await waitForModel(page)
      const loading = page.getByTestId('m-chat-loading-model')
      await expect(loading).toContainText(`Loading ${SMALL}`)
      await expect(loading).toHaveAttribute('data-m-queued', 'no')
      // Nobody sent anything: the chat was opened, that alone started the load.
      expect(await backend(page, (ctl) => ctl.bodies.length)).toBe(0)
      expect(await backend(page, (ctl) => ctl.engineStarts.length)).toBe(1)
      // The user can type already.
      await page.getByTestId('m-chat-input').fill('What is the capital of France?')
      await expect(page.getByTestId('m-chat-send')).toBeEnabled()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-send').tap()
      // The message is in the chat and waits: the line says so, and no second load was started for it.
      await expect(userMessages(page)).toContainText('capital of France?')
      await expect(loading).toHaveAttribute('data-m-queued', 'yes')
      await expect(loading).toContainText('Your message is sent when the model is ready.')
      expect(await backend(page, (ctl) => ctl.bodies.length)).toBe(0)
      expect(await layout(page)).toEqual(CLEAN)
      await answerDone(page)
      await expect(loading).toHaveCount(0)
      await expect(page.getByTestId('m-chat-not-loaded')).toHaveCount(0)
      expect(await backend(page, (ctl) => ctl.engineStarts.length)).toBe(1)
      expect(await backend(page, (ctl) => ctl.bodies.length)).toBe(1)
      // The model sheet reads the same source: the chosen model is in memory.
      await openModelSheet(page)
      await expect(page.getByTestId('m-chat-model-list')).toHaveAttribute('data-m-loaded', 'yes')
      await expect(page.getByTestId('m-chat-model-loads-later')).toHaveCount(0)
      await page.getByTestId('m-sheet-close').tap()
      expect(errors()).toEqual([])
    })

    test('the system took the memory back: "not loaded" says so, nothing loads by itself, "Load now" loads', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await send(page, 'Hello')
      await answerDone(page)
      await expect(page.getByTestId('m-chat-not-loaded')).toHaveCount(0)
      const startsBefore = await backend(page, (ctl) => ctl.engineStarts.length)

      // The native side unloads the chat model and says so (event lu-engine-memory-unload).
      await backend(page, (ctl) => {
        ctl.loaded = null
        ctl.emit('lu-engine-memory-unload', { level: 'critical', chat: true, embeddings: false, message: 'The model was unloaded because the phone was low on memory. It loads again with your next message.' })
      })
      const line = page.getByTestId('m-chat-not-loaded')
      await expect(line).toContainText(`${SMALL} is not loaded.`)
      await expect(line).toContainText('low on memory')
      await expect(line).toHaveAttribute('data-m-reason', 'memory')
      expect(await layout(page)).toEqual(CLEAN)
      // The sheet of the models says the same.
      await openModelSheet(page)
      await expect(page.getByTestId('m-chat-model-loads-later')).toBeVisible()
      await expect(page.getByTestId('m-chat-model-list')).toHaveAttribute('data-m-loaded', 'no')
      await page.getByTestId('m-sheet-close').tap()
      // Leaving and coming back does not take the memory again behind the back of the system.
      await back(page)
      await page.getByTestId('m-chats-open').first().tap()
      await expect(line).toBeVisible()
      await page.waitForTimeout(600)
      expect(await backend(page, (ctl) => ctl.engineStarts.length)).toBe(startsBefore)

      // "Load now" is the user asking for it.
      await backend(page, (ctl) => { ctl.startDelay = 800 })
      await page.getByTestId('m-chat-load-now').tap()
      await expect(page.getByTestId('m-chat-loading-model')).toContainText(`Loading ${SMALL}`)
      await expect(line).toHaveCount(0)
      await expect(page.getByTestId('m-chat-loading-model')).toHaveCount(0)
      expect(await backend(page, (ctl) => ctl.engineStarts.length)).toBe(startsBefore + 1)
      await expect(line).toHaveCount(0)
      // And the chat answers again.
      await backend(page, (ctl) => { ctl.startDelay = 0; ctl.reply = 'Back again.' })
      await send(page, 'Still there?')
      await answerDone(page, 'Back again.')
      expect(errors()).toEqual([])
    })

    test('the error of an answer is a field of the message; continueReply and sendFromOutside reach the chat from outside', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { reply: LONG_REPLY, chunks: 20, delay: 20 })
      await waitForModel(page)
      await backend(page, (ctl) => { ctl.mode = 'break' })
      await send(page, 'Tell me about tides')
      await expect(page.getByTestId('m-chat-error')).toContainText('The model on this phone was interrupted', { timeout: 30_000 })
      // What the send path wrote: the kind, the reason, and where the answer ends in the text.
      const stored = await page.evaluate(async () => {
        const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
        const chat = useChatStore.getState().conversations[0]
        const last = chat.messages.at(-1)
        return { chatId: chat.id as string, error: last.error, content: last.content as string }
      })
      expect(stored.error.kind).toBe('network')
      expect(stored.error.detail).toContain('connection reset')
      expect(stored.error.at).toBeGreaterThan(0)
      expect(stored.content.slice(stored.error.at)).toContain('Error:')
      // The bubble shows the part that arrived, without the sentence of the error.
      await expect(answers(page).last()).toContainText('Sentence 1 of a long answer')
      await expect(answers(page).last().locator('.m-chat-md')).not.toContainText('connection reset')

      // A message that carries only the field, with a text that names no error, still shows its box.
      await page.evaluate(async (chatId) => {
        const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
        const chat = useChatStore.getState().conversations.find((c: { id: string }) => c.id === chatId)
        const last = chat.messages.at(-1)
        useChatStore.getState().updateMessageContent(chatId, last.id, 'Half an answer.')
        useChatStore.getState().updateMessageError(chatId, last.id, { kind: 'engine', detail: 'out of memory', at: 15 })
      }, stored.chatId)
      await expect(page.getByTestId('m-chat-error')).toContainText('The on device engine did not answer')
      await expect(answers(page).last()).toContainText('Half an answer.')

      // continueReply: the call the resume notice of another strand uses. The page is open, so it answers here.
      await backend(page, (ctl) => { ctl.mode = 'ok'; ctl.reply = 'The whole answer.'; ctl.chunks = 2 })
      const continued = await page.evaluate(async (chatId) => {
        const { continueReply } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/chat/parts/controller.ts`)
        return continueReply(chatId)
      }, stored.chatId)
      expect(continued).toBe('continued')
      await answerDone(page, 'The whole answer.')
      await expect(page.getByTestId('m-chat-error')).toHaveCount(0)
      expect(
        await page.evaluate(async (chatId) => {
          const { continueReply } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/chat/parts/controller.ts`)
          return continueReply(chatId)
        }, stored.chatId),
      ).toBe('nothing')

      // sendFromOutside with the page open: the text goes in as the user.
      await backend(page, (ctl) => { ctl.reply = 'Done from outside.' })
      const sent = await page.evaluate(async (chatId) => {
        const { sendFromOutside } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/chat/parts/controller.ts`)
        return sendFromOutside(chatId, 'Summarise that')
      }, stored.chatId)
      expect(sent).toBe('sent')
      await answerDone(page, 'Done from outside.')
      await expect(userMessages(page).last()).toContainText('Summarise that')

      // From the list, where no page of the chat is there: the chat opens and sends.
      await back(page)
      await expect(page.getByTestId('m-chats-screen')).toBeVisible()
      await backend(page, (ctl) => { ctl.reply = 'Opened and answered.' })
      // The chat opens while the call runs and the history of the page moves with it, which can end an evaluate
      // that still waits (seen on CI, about one run in three): the call starts on its own, its answer is read after.
      await page.evaluate((chatId) => {
        const w = window as unknown as { __luOpened?: string }
        window.setTimeout(async () => {
          const { sendFromOutside } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/chat/parts/controller.ts`)
          w.__luOpened = await sendFromOutside(chatId, 'One more thing')
        }, 0)
      }, stored.chatId)
      await expect.poll(() => page.evaluate(() => (window as unknown as { __luOpened?: string }).__luOpened)).toBe('opened')
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      await answerDone(page, 'Opened and answered.')
      await expect(userMessages(page).last()).toContainText('One more thing')
      expect(errors().filter((e) => !/connection reset|decoding response/i.test(e))).toEqual([])
    })

    for (const thinks of [true, false]) {
      test(`thinking, the engine says ${thinks ? 'this model thinks: the switch is there, the thoughts and their time show' : 'this model does not think: no switch'}`, async ({ page }) => {
        const errors = watchErrors(page)
        await boot(page, { engineThinks: thinks })
        await waitForModel(page)
        // The fact comes from GET /props of the engine and lands on the row of the model.
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const { useModelStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/modelStore.ts`)
              const s = useModelStore.getState()
              return (s.models.find((m: { name: string }) => m.name === s.activeModel) as { thinkMode?: string } | undefined)?.thinkMode ?? null
            }),
          )
          .toBe(thinks ? 'toggle' : 'never')
        await page.getByTestId('m-chat-options').tap()
        await expect(page.getByTestId('m-sheet-chat-options')).toBeVisible()
        if (!thinks) {
          await expect(page.getByTestId('m-options-thinking')).toHaveCount(0)
          await page.getByTestId('m-sheet-close').tap()
          expect(errors()).toEqual([])
          return
        }
        const row = page.getByTestId('m-options-thinking')
        await expect(row).toBeVisible()
        const toggle = page.locator('[data-testid="m-options-thinking"][role="switch"], [data-testid="m-options-thinking"] [role="switch"]')
        if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.tap()
        await expect(toggle).toHaveAttribute('aria-checked', 'true')
        await page.getByTestId('m-sheet-close').tap()

        await backend(page, (ctl) => {
          ctl.thinking = 'The user asks for a capital. France has one capital. It is Paris.'
          ctl.thinkingDelay = 450
        })
        await send(page, 'What is the capital of France?')
        await answerDone(page)
        // reasoning_content is the thinking block, not a part of the answer.
        await expect(page.getByTestId('m-chat-thinking').last()).toBeVisible()
        await expect(answers(page).last().locator('.m-chat-md')).not.toContainText('The user asks for a capital')
        // And the line under the answer says how long it thought.
        await expect(page.getByTestId('m-chat-thought-for')).toHaveText(/^Thought for \d+ s$/)
        const ms = await page.evaluate(async () => {
          const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
          return useChatStore.getState().conversations[0].messages.at(-1).thinkingMs as number
        })
        expect(ms).toBeGreaterThan(800)
        expect(ms).toBeLessThan(10_000)
        expect(await layout(page)).toEqual(CLEAN)
        expect(errors()).toEqual([])
      })
    }

    test('files in this chat list the agent folder too: open, share, delete after a question', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await seedChats(page, [
        { id: 'ws', title: 'Agent wrote files', messages: [{ role: 'user', content: 'Write notes' }, { role: 'assistant', content: 'notes.md written.', artifacts: [{ id: 'art1', name: 'summary.txt', content: 'A summary.', mime: 'text/plain' }] }] },
      ])
      // The folder the agent run of this chat was given, and what it wrote there.
      await page.evaluate(async () => {
        const { useAgentModeStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/agentModeStore.ts`)
        useAgentModeStore.setState({ workspaceSlugs: { ...useAgentModeStore.getState().workspaceSlugs, ws: 'agent-wrote-files-ws' } })
      })
      await backend(page, (ctl) => {
        ctl.workspace = { files: { 'notes.md': '# Notes\n\nTides follow the moon.', 'out/data.csv': 'a,b\n1,2', '.cache/tmp': 'x' }, canDelete: true, listFails: true, deleted: [] }
      })
      await back(page)
      await openChat(page, 'ws')
      // C2.24: a file an answer made opens in the viewer.
      await page.getByTestId('m-chat-artifact').tap()
      await expect(page.getByTestId('m-chat-file-text')).toHaveText('A summary.')
      await expect(page.getByTestId('m-chat-file-delete')).toHaveCount(0)
      await page.getByTestId('m-viewer-close').tap()

      await page.getByTestId('m-chat-menu').tap()
      await page.getByTestId('m-chat-menu-files').tap()
      // The folder cannot be read: the files of the messages still show, and the list says what failed.
      await expect(page.getByTestId('m-chat-menu-file')).toHaveCount(1)
      await expect(page.getByTestId('m-chat-menu-folder-failed')).toContainText('The agent folder could not be read.')
      expect(await layout(page)).toEqual(CLEAN)
      await backend(page, (ctl) => { ctl.workspace.listFails = false })
      await page.getByTestId('m-chat-menu-folder-failed').getByRole('button').tap()
      const rows = page.getByTestId('m-chat-menu-wsfile')
      await expect(rows).toHaveCount(2)
      await expect(rows.first()).toContainText('out/data.csv')
      await expect(rows.first()).toContainText('Written by the agent')
      await expect(rows.last()).toContainText('notes.md')
      expect(await layout(page)).toEqual(CLEAN)

      // Open: the viewer shows the text of the file.
      await rows.last().tap()
      await expect(page.getByTestId('m-chat-file-screen')).toBeVisible()
      await expect(page.getByTestId('m-chat-file-text')).toContainText('Tides follow the moon.')
      expect(await layout(page)).toEqual(CLEAN)
      // Share: the bytes go to the share sheet of the system.
      await page.getByTestId('m-chat-file-share').tap()
      await expect(page.getByTestId('m-toast-shared')).toBeVisible()
      expect(await backend(page, (ctl) => ctl.shared.at(-1))).toMatchObject({ name: 'notes.md', text: '# Notes\n\nTides follow the moon.' })
      // Delete asks first; "Cancel" keeps the file.
      await page.getByTestId('m-chat-file-delete').tap()
      await expect(page.getByTestId('m-dialog-delete-file')).toContainText('Delete notes.md?')
      await page.getByTestId('m-dialog-cancel').tap()
      expect(await backend(page, (ctl) => ctl.workspace.deleted)).toEqual([])
      await page.getByTestId('m-chat-file-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-file-deleted')).toHaveText('File deleted')
      await expect(page.getByTestId('m-chat-file-screen')).toHaveCount(0)
      expect(await backend(page, (ctl) => ctl.workspace.deleted)).toEqual(['notes.md'])
      // The list no longer names it.
      if (!(await page.getByTestId('m-chat-menu-wsfile').first().isVisible().catch(() => false))) {
        await page.getByTestId('m-chat-menu').tap()
        await page.getByTestId('m-chat-menu-files').tap()
      }
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText('out/data.csv')

      // A build that cannot delete says so and takes the button away; the file stays.
      await backend(page, (ctl) => { ctl.workspace.canDelete = false })
      await rows.first().tap()
      await expect(page.getByTestId('m-chat-file-text')).toContainText('a,b')
      await page.getByTestId('m-chat-file-delete').tap()
      await page.getByTestId('m-dialog-confirm').tap()
      await expect(page.getByTestId('m-toast-delete-unavailable')).toContainText('Files of the agent folder cannot be deleted here.')
      await expect(page.getByTestId('m-chat-file-delete')).toHaveCount(0)
      await expect(page.getByTestId('m-chat-file-text')).toContainText('a,b')
      expect(await backend(page, (ctl) => Object.keys(ctl.workspace.files))).toContain('out/data.csv')
      expect(errors().filter((e) => !/fs_list/.test(e))).toEqual([])
    })

    test('the avatar in the bubble of the user; read aloud speaks with the system voice and obeys its switch', async ({ page }) => {
      const errors = watchErrors(page)
      await page.addInitScript(speechStub)
      await boot(page)
      await waitForModel(page)
      await seedChats(page, [{ id: 'a', title: 'Capital', messages: [{ role: 'user', content: 'Capital of France?' }, { role: 'assistant', content: REPLY }] }])
      const avatar = `data:image/png;base64,${await makePng(page, 64, 64)}`
      await back(page)
      await openChat(page, 'a')
      // Without an avatar the bubble stands alone.
      await expect(page.getByTestId('m-chat-user-avatar')).toHaveCount(0)
      await page.evaluate(async (dataUrl) => {
        const { useSettingsStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/settingsStore.ts`)
        useSettingsStore.getState().updateSettings({ userAvatarDataUrl: dataUrl })
      }, avatar)
      await expect(page.getByTestId('m-chat-user-avatar')).toHaveCount(1)
      await expect(page.getByTestId('m-chat-user-avatar')).toHaveAttribute('src', avatar)
      expect(await layout(page)).toEqual(CLEAN)

      // "Read aloud" is off at first: no speaker button under the answer (Android N10). The menu of the
      // message says so and leads to the switch.
      await expect(page.getByTestId('m-chat-answer-actions')).toBeVisible()
      await expect(page.getByTestId('m-chat-speak')).toHaveCount(0)
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-speak').tap()
      await expect(page.getByTestId('m-chat-voice-gate-text')).toHaveAttribute('data-m-kind', 'speak-off')
      await expect(page.getByTestId('m-sheet-chat-voice-gate')).toContainText('Read aloud is switched off')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-voice-gate-settings').tap()
      await expect(page.getByTestId('m-settings-voice-read-aloud')).toBeVisible()
      await page.locator('[data-testid="m-settings-voice-read-aloud"][role="switch"], [data-testid="m-settings-voice-read-aloud"] [role="switch"]').tap()
      // Back from the voice settings is the chat again (Android M4), not the settings overview.
      await back(page)
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      await expect(page.getByTestId('m-settings-voice-screen')).toHaveCount(0)

      // C2.18: the system voice reads, the same button stops it.
      await page.getByTestId('m-chat-speak').tap()
      await expect(page.getByTestId('m-chat-speaking')).toBeVisible()
      await expect.poll(() => page.evaluate<string>("window.__SPEECH__.spoken.join(' ')")).toContain('Paris is the capital of France')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-speaking').tap()
      await expect(page.getByTestId('m-chat-speak')).toBeVisible()
      await expect(page.getByTestId('m-chat-speaking')).toHaveCount(0)
      expect(await page.evaluate<number>('window.__SPEECH__.cancelled')).toBeGreaterThan(0)

      // "Use the system voice" off in the settings: nothing is spoken, the sheet says why and leads to the switch.
      const spokenBefore = await page.evaluate<number>('window.__SPEECH__.spoken.length')
      await page.evaluate(async () => {
        const { useMobilePrefs } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/settings/parts/prefs.ts`)
        useMobilePrefs.getState().setPref('systemVoiceFallback', false)
      })
      // The button goes with the voice. The menu of the message says why and leads to the switch.
      await expect(page.getByTestId('m-chat-speak')).toHaveCount(0)
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-speak').tap()
      await expect(page.getByTestId('m-chat-voice-gate-text')).toHaveAttribute('data-m-kind', 'speak')
      await expect(page.getByTestId('m-chat-voice-gate-text')).toContainText('switched off in Settings, Voice')
      expect(await layout(page)).toEqual(CLEAN)
      expect(await page.evaluate<number>('window.__SPEECH__.spoken.length')).toBe(spokenBefore)
      await page.getByTestId('m-chat-voice-gate-settings').tap()
      expect(await topRoute(page)).toBe('/settings/voice')
      expect(errors()).toEqual([])
    })

    test('dictation: the level of the microphone shows, a failed take can be sent again or discarded, a refused microphone says so', async ({ page }) => {
      const errors = watchErrors(page)
      await routeCloud(page, { license: 'active', access: true, paidPlan: true })
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
      let transcribe: 'fail' | 'ok' = 'fail'
      let takes = 0
      await page.route('https://lu-labs.ai/api/voice/transcribe', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        takes += 1
        if (transcribe === 'fail') return route.fulfill({ status: 500, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'The speech service is busy.' }) })
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello from dictation' }) })
      })
      await page.addInitScript(microphoneStub)
      await boot(page)
      await waitForModel(page)
      await signInCloud(page)

      // M1: the recording goes to LU Cloud, so the consent is asked before the microphone opens.
      // A no records nothing and sends nothing.
      await page.getByTestId('m-chat-mic').tap()
      await expect(page.getByTestId('m-consent-text')).toContainText('voice recordings')
      await page.getByTestId('m-consent-decline').tap()
      await expect(page.getByTestId('m-toast-consent-declined')).toContainText('Nothing was recorded')
      await expect(page.getByTestId('m-chat-dictation')).toHaveCount(0)
      expect(takes).toBe(0)

      // A take with sound: the bars follow the level, and the line knows that it heard something.
      await page.getByTestId('m-chat-mic').tap()
      await page.getByTestId('m-consent-agree').tap()
      const meter = page.getByTestId('m-chat-dictation')
      await expect(meter).toHaveAttribute('data-state', 'recording')
      const level = page.getByTestId('m-chat-dictation-level')
      await expect.poll(async () => Number(await level.getAttribute('data-m-level'))).toBeGreaterThan(6)
      await expect(level).toHaveAttribute('data-m-heard', '')
      await expect(page.getByTestId('m-chat-dictation-quiet')).toHaveCount(0)
      expect(await layout(page)).toEqual(CLEAN)
      await page.waitForTimeout(700)
      await meter.tap()

      // The cloud could not write it down: the take is kept, with two ways on.
      const retry = page.getByTestId('m-chat-dictation-retry')
      await expect(retry).toBeVisible({ timeout: 20_000 })
      expect(await layout(page)).toEqual(CLEAN)
      expect(takes).toBe(1)
      // After the take the level is back at nothing: no meter listens on.
      expect(await page.evaluate(async () => (await import(/* @vite-ignore */ `${location.origin}/src/hooks/useVoice.ts`)).voiceLevel())).toBe(0)
      await page.getByTestId('m-chat-dictation-discard').tap()
      await expect(retry).toHaveCount(0)
      await expect(page.getByTestId('m-chat-input')).toHaveValue('')

      // Again, and this time "Try again" sends the same take once more, without speaking again.
      await page.getByTestId('m-chat-mic').tap()
      await expect(meter).toHaveAttribute('data-state', 'recording')
      await page.waitForTimeout(700)
      await meter.tap()
      await expect(retry).toBeVisible({ timeout: 20_000 })
      transcribe = 'ok'
      await page.getByTestId('m-chat-dictation-retry-action').tap()
      await expect(page.getByTestId('m-chat-input')).toHaveValue('Hello from dictation')
      await expect(retry).toHaveCount(0)
      expect(takes).toBe(3)
      await page.getByTestId('m-chat-input').fill('')

      // A microphone that hears nothing: after three seconds the line says so.
      await page.evaluate('window.__MIC__.gain = 0')
      await page.getByTestId('m-chat-mic').tap()
      await expect(meter).toHaveAttribute('data-state', 'recording')
      await expect(page.getByTestId('m-chat-dictation-quiet')).toHaveText('Nothing heard yet', { timeout: 8000 })
      expect(await layout(page)).toEqual(CLEAN)
      await meter.tap()
      await expect(meter).toHaveCount(0, { timeout: 20_000 })
      if (await retry.isVisible()) await page.getByTestId('m-chat-dictation-discard').tap()
      await page.getByTestId('m-chat-input').fill('')

      // The system refuses the microphone.
      await page.evaluate('window.__MIC__.deny = true')
      await page.getByTestId('m-chat-mic').tap()
      await expect(page.getByTestId('m-toast-mic-denied')).toContainText('LU has no access to the microphone')
      await expect(meter).toHaveCount(0)
      expect(errors().filter((e) => !/500|speech service|transcri|NotAllowed|denied/i.test(e))).toEqual([])
    })

    test('dictation: the line says what LU Cloud answered, by its code (r44)', async ({ page }) => {
      const errors = watchErrors(page)
      await routeCloud(page, { license: 'active', access: true, paidPlan: true })
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
      // The answers of the transcription route, in its own shape.
      let answer: { status: number; body: Record<string, unknown> } = { status: 502, body: { error: 'transcription failed', detail: 'refused' } }
      const sent: string[] = []
      await page.route('https://lu-labs.ai/api/voice/transcribe', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        sent.push(route.request().headers()['content-type'] ?? '')
        return route.fulfill({ status: answer.status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(answer.body) })
      })
      await page.addInitScript(microphoneStub)
      await boot(page)
      await waitForModel(page)
      await signInCloud(page)

      const meter = page.getByTestId('m-chat-dictation')
      const take = async (first = false) => {
        await page.getByTestId('m-chat-mic').tap()
        // M1: the first take asks for the consent before the microphone opens.
        if (first) await page.getByTestId('m-consent-agree').tap()
        await expect(meter).toHaveAttribute('data-state', 'recording')
        await page.waitForTimeout(900)
        await meter.tap()
      }

      // The speech service refused the take: said as that, with the code, kept for one more try.
      await take(true)
      const retry = page.getByTestId('m-chat-dictation-retry')
      await expect(retry).toBeVisible({ timeout: 20_000 })
      await expect(retry).toContainText('The speech service of LU Cloud could not write this recording down (error 502)')
      await expect(retry).not.toContainText('unavailable')
      expect(sent).toEqual(['audio/wav'])
      await page.getByTestId('m-chat-dictation-discard').tap()
      await expect(retry).toHaveCount(0)

      // Too long: no retry button for a take no retry can save, the reason still shows.
      answer = { status: 413, body: { error: 'audio too large (max ~2 minutes)' } }
      await take()
      const said = page.getByTestId('m-chat-dictation-said')
      await expect(said).toContainText('This recording is too long for LU Cloud', { timeout: 20_000 })
      await expect(retry).toHaveCount(0)
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-dictation-dismiss').tap()
      await expect(said).toHaveCount(0)
      expect(errors().filter((e) => !/502|413|speech service|transcri|too large/i.test(e))).toEqual([])
    })

    test('dictation: the line goes by the code of the answer; a 503 is never "switched off", a take that cannot be read is not kept (r44b)', async ({ page }) => {
      const errors = watchErrors(page)
      await routeCloud(page, { license: 'active', access: true, paidPlan: true })
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
      // The answers of the transcription route after the server correction, in its own shape (code plus sentence).
      let answer: { status: number; body: Record<string, unknown> } = { status: 503, body: { error: 'transcription is busy, try again in a moment', code: 'upstream_busy' } }
      await page.route('https://lu-labs.ai/api/voice/transcribe', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        return route.fulfill({ status: answer.status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(answer.body) })
      })
      await page.addInitScript(microphoneStub)
      await boot(page)
      await waitForModel(page)
      await signInCloud(page)

      const meter = page.getByTestId('m-chat-dictation')
      const take = async (first = false) => {
        await page.getByTestId('m-chat-mic').tap()
        if (first) await page.getByTestId('m-consent-agree').tap()
        await expect(meter).toHaveAttribute('data-state', 'recording')
        await page.waitForTimeout(900)
        await meter.tap()
      }
      const retry = page.getByTestId('m-chat-dictation-retry')

      // Busy: kept, retry in a moment.
      await take(true)
      await expect(retry).toBeVisible({ timeout: 20_000 })
      await expect(retry).toContainText('LU Cloud transcription is busy. Your recording is kept, tap retry in a moment.')
      await expect(retry).not.toContainText('switched off')

      // Unavailable: the retry of the same take now gets this answer, still kept.
      answer = { status: 503, body: { error: 'cloud transcription is unavailable right now', code: 'upstream_unavailable' } }
      await page.getByTestId('m-chat-dictation-retry-action').tap()
      await expect(retry).toContainText('on the LU Cloud side, not on your phone', { timeout: 20_000 })
      await expect(retry).toContainText('Your recording is kept')
      await expect(retry).not.toContainText('switched off')
      expect(await layout(page)).toEqual(CLEAN)

      // The answer could not be read: nothing was charged, still kept.
      answer = { status: 502, body: { error: 'transcription failed, try again', code: 'upstream_unreadable' } }
      await page.getByTestId('m-chat-dictation-retry-action').tap()
      await expect(retry).toContainText('LU Cloud could not read the answer. Nothing was charged. Tap retry.', { timeout: 20_000 })
      await page.getByTestId('m-chat-dictation-discard').tap()
      await expect(retry).toHaveCount(0)

      // Could not be read: record again, nothing kept behind a retry.
      answer = { status: 422, body: { error: 'this recording could not be read, record it again', code: 'unsupported_audio' } }
      await take()
      const said = page.getByTestId('m-chat-dictation-said')
      await expect(said).toContainText('This recording could not be read. Record it again.', { timeout: 20_000 })
      await expect(retry).toHaveCount(0)
      await page.getByTestId('m-chat-dictation-dismiss').tap()
      await expect(said).toHaveCount(0)

      // Too short on the server side: the same sentence as the app's own, nothing kept.
      answer = { status: 422, body: { error: 'recording too short, record it again', code: 'audio_too_short' } }
      await take()
      await expect(said).toContainText('The recording was too short to write down.', { timeout: 20_000 })
      await expect(retry).toHaveCount(0)
      await page.getByTestId('m-chat-dictation-dismiss').tap()
      expect(errors().filter((e) => !/502|503|422|transcri|could not be read|too short|busy|unavailable/i.test(e))).toEqual([])
    })

    test('paste an image into the composer; the report names the model as the user sees it', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { store: 'play' })
      await waitForModel(page)
      const png = await makePng(page)
      const paste = (count: number) =>
        page.evaluate(
          ([b64, n]) => {
            const data = new DataTransfer()
            const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0))
            for (let i = 0; i < (n as number); i++) data.items.add(new File([bytes], `pasted-${i + 1}.png`, { type: 'image/png', lastModified: i + 1 }))
            const field = document.querySelector('[data-testid="m-chat-input"]')!
            return field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
          },
          [png, count] as const,
        )
      // A model that cannot read images: nothing is attached, and the toast says what to do.
      await paste(1)
      await expect(page.getByTestId('m-toast-paste-no-vision')).toContainText('This model cannot read images')
      await expect(page.getByTestId('m-chat-attachment')).toHaveCount(0)
      // Text is pasted as always: the composer does not take that paste away from the field.
      const textLeftAlone = await page.evaluate(() => {
        const data = new DataTransfer()
        data.setData('text/plain', 'just words')
        return document.querySelector('[data-testid="m-chat-input"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      expect(textLeftAlone).toBe(true)

      await openModelSheet(page)
      await page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${VISION}"]`).tap()
      await waitForModel(page, VISION_LABEL)
      await paste(2)
      await expect(page.getByTestId('m-toast-pasted')).toHaveText('2 images added from the clipboard')
      await expect(page.getByTestId('m-chat-attachment')).toHaveCount(2)
      await expect(page.getByTestId('m-chat-send')).toBeEnabled()
      expect(await layout(page)).toEqual(CLEAN)
      // More than five: the first ones that fit are taken, the toast names the limit.
      await paste(6)
      await expect(page.getByTestId('m-toast-attach-limit')).toContainText('up to 5 images')
      await expect(page.getByTestId('m-chat-attachment')).toHaveCount(5)
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-input').fill('What is on these?')
      await page.getByTestId('m-chat-send').tap()
      await answerDone(page)
      expect(await backend(page, (ctl) => JSON.stringify(JSON.parse(ctl.bodies.at(-1)).messages.at(-1).content).match(/"type":"image_url"/g)?.length)).toBe(5)

      // The report: the model by the name the app shows, not by the id with the provider in front.
      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-report').tap()
      await expect(page.getByTestId('m-report-send')).toBeVisible()
      await page.locator('[data-testid^="m-report-reason-"]').first().tap()
      await page.getByTestId('m-report-send').tap()
      await expect(page.locator('[data-testid^="m-toast-report-"]')).toContainText(/Report (saved|sent)/)
      const shown = (await page.getByTestId('m-chat-model-by').last().innerText()).trim()
      const reported = await page.evaluate(() => JSON.parse(localStorage.getItem('lu-mobile-report-queue') ?? '[]').at(-1)?.model as string | undefined)
      expect(reported).toBeTruthy()
      expect(reported).not.toContain('::')
      expect(shown).toContain(reported!)
      expect(errors()).toEqual([])
    })

    test('controls that need a state: restore, failed search, notice, compact now, sources, group, a running download', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await back(page)
      await expect(page.getByTestId('m-chats-empty')).toBeVisible()
      await expect(page.getByTestId('m-chats-restore')).toHaveCount(0)

      // C1.7: a backup with chats lies on the phone and the list is empty: the row leads to "Backup and import".
      await backend(page, (ctl) => {
        ctl.backup = JSON.stringify({ 'chat-conversations': JSON.stringify({ state: { conversations: [{ id: 'old-1' }, { id: 'old-2' }] } }) })
      })
      await seedChats(page, [{ id: 'tmp', title: 'Temporary', messages: [{ role: 'user', content: 'x' }] }])
      await expect(page.getByTestId('m-chats-item')).toHaveCount(1)
      await page.evaluate(async () => {
        const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
        useChatStore.getState().deleteConversation('tmp')
      })
      await expect(page.getByTestId('m-chats-restore')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      // Round 57: one quiet link in the middle under the sentence, as wide as its words; "New chat" is the plus in
      // the header, not a second button under it.
      const middle = await page.evaluate(() => {
        const box = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect()
        const link = box('m-chats-restore')
        const title = (document.querySelector('[data-testid="m-chats-empty"] .m-empty-title') as HTMLElement).getBoundingClientRect()
        return { link: link.left + link.width / 2, title: title.left + title.width / 2, width: link.width, height: link.height, view: innerWidth }
      })
      expect(Math.abs(middle.link - middle.title)).toBeLessThan(2)
      expect(Math.abs(middle.link - middle.view / 2)).toBeLessThan(2)
      expect(middle.width).toBeLessThan(middle.view * 0.8)
      expect(middle.height).toBeGreaterThanOrEqual(44)
      await expect(page.getByTestId('m-chats-new')).toHaveCount(0)
      await expect(page.locator('.m-page:not([data-m-hidden]) [data-testid="m-chats-empty-new"]')).toBeVisible()
      await page.getByTestId('m-chats-restore').tap()
      expect(await topRoute(page)).toBe('/settings/data')
      await back(page)
      await page.getByTestId('m-nav-chat').tap()

      const big = 'tides and the moon and the sea and the shore '.repeat(70)
      await seedChats(page, [
        { id: 'src', title: 'With sources', messages: [{ role: 'user', content: 'What does the paper say?' }, { role: 'assistant', content: 'It says the tide follows the moon.', sources: [{ documentName: 'tides.pdf', chunkIndex: 2, preview: 'The tide follows the moon.' }, { documentName: 'tides.pdf', chunkIndex: 7, preview: 'Spring tides come with the full moon.' }] }] },
        { id: 'full', title: 'Nearly full', messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), content: `${i + 1}. ${big}` })) },
      ])
      await openChat(page, 'src')
      // C2.25: the documents an answer used are named under it.
      await expect(page.getByTestId('m-chat-sources')).toContainText('tides.pdf')
      // One row per document with the number of passages, and a tap shows them (acceptance Android 8 GB, B12).
      await expect(page.getByTestId('m-chat-source')).toHaveCount(1)
      await expect(page.getByTestId('m-chat-source')).toContainText('2 passages')
      await page.getByTestId('m-chat-source').tap()
      await expect(page.getByTestId('m-chat-source-passage')).toHaveCount(2)
      await expect(page.getByTestId('m-chat-source-passage').nth(1)).toContainText('Source 2, passage 8 of the document')
      await expect(page.getByTestId('m-chat-source-passage').nth(1)).toContainText('Spring tides come with the full moon.')
      await page.getByTestId('m-chat-source').tap()
      await expect(page.getByTestId('m-chat-source-passage')).toHaveCount(0)

      // The document search failed: "Try again" asks the last question again.
      const before = await backend(page, (ctl) => ctl.bodies.length)
      await page.evaluate(async () => {
        const { useRAGStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/ragStore.ts`)
        useRAGStore.getState().setRetrievalError('The embedding model did not answer.')
      })
      const searchFailed = page.getByTestId('m-chat-retrieval-error')
      await expect(searchFailed).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await backend(page, (ctl) => { ctl.reply = 'Asked again.' })
      await searchFailed.getByRole('button').tap()
      await expect(searchFailed).toHaveCount(0)
      await answerDone(page, 'Asked again.')
      expect(await backend(page, (ctl) => ctl.bodies.length)).toBe(before + 1)

      // A notice of the chat logic: "Dismiss" takes it away.
      await page.evaluate(async () => {
        const { useChatNoticeStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatNoticeStore.ts`)
        useChatNoticeStore.getState().show('e2e-notice', 'The answer was shortened to fit the context.', 'ruhig')
      })
      const notice = page.getByTestId('m-chat-notice-line')
      await expect(notice).toContainText('The answer was shortened')
      expect(await layout(page)).toEqual(CLEAN)
      await notice.getByRole('button').tap()
      await expect(notice).toHaveCount(0)

      // C13: a group chat names what a round costs, and the line opens the page of the group.
      await page.evaluate(async () => {
        const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
        const s = useChatStore.getState()
        useChatStore.setState({
          conversations: s.conversations.map((c: { id: string }) => (c.id === 'src' ? { ...c, groupModels: ['openai::Qwen2.5-0.5B-Instruct-Q4_K_M', 'openai::Gemma-3-4B-it-Q4_K_M'] } : c)),
        })
      })
      await expect(page.getByTestId('m-chat-group-cost')).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-group-cost').tap()
      expect(await topRoute(page)).toBe('/chat/:id/group')
      await back(page)

      // C2.14: from 95 percent of the context "Compact now" sends /compact.
      await openChat(page, 'full')
      const compact = page.getByTestId('m-chat-compact-now')
      await expect(compact).toBeVisible()
      expect(await layout(page)).toEqual(CLEAN)
      await expect(page.getByTestId('m-chat-notice')).toHaveCount(0)
      const bodies = await backend(page, (ctl) => ctl.bodies.length)
      await backend(page, (ctl) => { ctl.reply = 'A short summary of tides.' })
      await compact.tap()
      // The command ran: the chat carries what it did as a notice of its own, and the model was asked for the summary.
      await expect(page.getByTestId('m-chat-notice')).not.toHaveCount(0, { timeout: 30_000 })
      await expect(page.getByTestId('m-chat-notice').first()).toContainText('/compact')
      await expect.poll(() => backend(page, (ctl) => ctl.bodies.length)).toBeGreaterThan(bodies)
      await expect(page.getByTestId('m-chat-notice').last()).not.toContainText('Summarising', { timeout: 30_000 })
      await expect(page.getByTestId('m-chat-stop')).toHaveCount(0, { timeout: 30_000 })

      // C3.3: a running download shows in the model sheet and leads to the downloads of strand 4.
      await page.evaluate(async () => {
        const { useDownloadStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/downloadStore.ts`)
        const row = { progress: 40, total: 100, speed: 0, filename: 'Phi-4-mini-Q4_K_M.gguf', status: 'downloading' }
        useDownloadStore.setState({ downloads: { 'Phi-4-mini-Q4_K_M.gguf': row }, ownRows: { 'Phi-4-mini-Q4_K_M.gguf': row } })
      })
      await openModelSheet(page)
      const download = page.getByTestId('m-chat-model-download')
      // N1: the name of the model, not the name of its file.
      await expect(download).toContainText('Phi-4-mini-Q4_K_M')
      await expect(download).not.toContainText('.gguf')
      await expect(download).toContainText('40')
      expect(await layout(page)).toEqual(CLEAN)
      await download.first().tap()
      expect(await topRoute(page)).toBe('/models/downloads')
      expect(errors()).toEqual([])
    })

    test('LU Cloud in the model sheet: an account without a plan sees the way to the plans, a failed catalogue can be loaded again', async ({ page }) => {
      const errors = watchErrors(page)
      let scenario: 'no-plan' | 'plan' = 'no-plan'
      let catalogue: 'fail' | 'ok' = 'fail'
      await routeCloud(page, { license: 'active', access: true, paidPlan: true })
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
      await page.route('https://lu-labs.ai/api/me', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        if (scenario === 'plan') return route.fallback()
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 'e2e-user-1', email: 'qa@lu-labs.ai' }, license: { status: 'none' }, profile: null }) })
      })
      await page.route('https://lu-labs.ai/api/inference/v1/models', (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        if (catalogue === 'ok') return route.fallback()
        return route.fulfill({ status: 500, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'The catalogue is not available.' }) })
      })
      await boot(page)
      await waitForModel(page)
      await signInCloud(page)

      // C3.10: signed in, no plan.
      await openModelSheet(page)
      await page.getByTestId('m-chat-model-segment-cloud').tap()
      await expect(page.getByTestId('m-chat-model-plans-state')).toBeVisible({ timeout: 20_000 })
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-model-plans').tap()
      await expect(page.getByTestId('m-cloud-screen')).toBeVisible()
      await back(page)

      // With a plan, and a server that does not hand out the catalogue.
      scenario = 'plan'
      await signInCloud(page)
      await openModelSheet(page)
      await page.getByTestId('m-chat-model-segment-cloud').tap()
      await expect(page.getByTestId('m-chat-model-catalog-error')).toBeVisible({ timeout: 30_000 })
      expect(await layout(page)).toEqual(CLEAN)
      catalogue = 'ok'
      await page.getByTestId('m-chat-model-catalog-retry').tap()
      await expect(page.locator('[data-testid="m-sheet-model"] [data-testid^="m-chat-model-cloud"]').first()).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('m-chat-model-catalog-error')).toHaveCount(0)
      expect(errors().filter((e) => !/500|catalogue|Internal Server Error/i.test(e))).toEqual([])
    })

    test('what the system refuses is said: copy, share, export, save, open a link', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      const png = await makePng(page)
      await seedChats(page, [
        {
          id: 'a',
          title: 'Refusals',
          messages: [
            { role: 'user', content: 'Show me', images: [{ data: png, mimeType: 'image/png', name: 'harbour.png' }] },
            { role: 'assistant', content: 'Read [the page](https://example.org/tides) about it.' },
          ],
        },
      ])
      await back(page)
      await openChat(page, 'a')
      await backend(page, (ctl) => { ctl.refuse = { copy: true, share: true, save: true, open: true } })
      // The system refused, and the web way that is asked after it (platform/clipboard.ts) refuses as well.
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('refused by the test')) } })
        document.execCommand = () => false
      })

      await page.getByTestId('m-chat-copy').tap()
      await expect(page.getByTestId('m-toast-copy-failed')).toBeVisible()

      await page.getByTestId('m-chat-answer-more').tap()
      await page.getByTestId('m-chat-message-share').tap()
      await expect(page.getByTestId('m-toast-share-failed')).toBeVisible()
      if (await page.getByTestId('m-sheet-message').isVisible()) await page.getByTestId('m-sheet-close').tap()

      await page.getByTestId('m-chat-menu').tap()
      await page.getByTestId('m-chat-menu-export').tap()
      await page.getByTestId('m-chat-menu-export-markdown').tap()
      await expect(page.getByTestId('m-toast-export-failed')).toBeVisible()
      // The sheet stays, so the other format can be tried.
      await expect(page.getByTestId('m-chat-menu-export-json')).toBeVisible()
      await page.getByTestId('m-sheet-close').tap()

      await page.getByTestId('m-chat-link').tap()
      await page.getByTestId('m-chat-link-open').tap()
      await expect(page.getByTestId('m-toast-link-failed')).toBeVisible()
      if (await page.getByTestId('m-chat-link-cancel').isVisible()) await page.getByTestId('m-chat-link-cancel').tap()

      await page.getByTestId('m-chat-image').first().tap()
      await expect(page.getByTestId('m-chat-file-screen')).toBeVisible()
      await page.getByTestId('m-chat-file-save').tap()
      await expect(page.getByTestId('m-toast-save-failed')).toContainText('could not save the image')
      await page.getByTestId('m-chat-file-share').tap()
      await expect(page.getByTestId('m-toast-share-failed')).toBeVisible()
      // Nothing was handed over, and nothing claims it was.
      expect(await backend(page, (ctl) => [ctl.copied.length, ctl.shared.length, ctl.saved.length, ctl.opened.length])).toEqual([0, 0, 0, 0])
      expect(errors().filter((e) => !/refused by the test/i.test(e))).toEqual([])
    })

    test('nothing is lost: the text and the attachment in the composer are back after the app was ended', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      const png = await makePng(page)
      await openModelSheet(page)
      await page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${VISION}"]`).tap()
      await waitForModel(page, VISION_LABEL)
      await page.getByTestId('m-chat-input').fill('Half a thought about tides')
      // On this phone, with a model of this phone: Send costs nothing and carries no mark.
      await expect(page.getByTestId('m-chat-send')).not.toHaveAttribute('data-m-risk', 'paid')
      await page.evaluate((b64) => {
        const data = new DataTransfer()
        data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'harbour.png', { type: 'image/png' }))
        document.querySelector('[data-testid="m-chat-input"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      }, png)
      await expect(page.getByTestId('m-chat-attachment')).toHaveCount(1)
      // Written a moment after the last change, without anybody pressing anything.
      await expect.poll(() => page.evaluate(() => localStorage.getItem('lu-mobile-chat-drafts') ?? '')).toContain('Half a thought about tides')
      await page.waitForTimeout(700)

      // The system ends the app; the user opens it again.
      await page.reload()
      await page.getByTestId('m-app').waitFor()
      await screensLoaded(page)
      await expect(page.getByTestId('m-chat-input')).toHaveValue('Half a thought about tides')
      const chip = page.getByTestId('m-chat-attachment')
      await expect(chip).toHaveCount(1)
      await expect(chip).toContainText('harbour.png')
      expect(await layout(page)).toEqual(CLEAN)
      // The attachment is the real picture again, not only its name.
      await page.getByTestId('m-chat-attachment-open').tap()
      await expect(page.locator('[data-testid="m-chat-file-screen"] img')).toBeVisible()
      await page.getByTestId('m-viewer-close').tap()

      // Sent, the draft is gone for good: a second restart brings nothing back.
      await waitForModel(page, VISION_LABEL)
      await page.getByTestId('m-chat-send').tap()
      await answerDone(page)
      await expect(page.getByTestId('m-chat-input')).toHaveValue('')
      await expect.poll(() => page.evaluate(() => localStorage.getItem('lu-mobile-chat-drafts'))).toBeNull()
      await page.waitForTimeout(700)
      await page.reload()
      await page.getByTestId('m-app').waitFor()
      await screensLoaded(page)
      await expect(page.getByTestId('m-chat-input')).toHaveValue('')
      await expect(page.getByTestId('m-chat-attachment')).toHaveCount(0)
      expect(errors()).toEqual([])
    })

    test('a model of the catalogue: its readable name everywhere, no Thinking where it does not think, an open chat asks nothing of an engine that is not up', async ({ page }) => {
      const errors = watchErrors(page)
      const SMOL = 'SmolLM2-360M-Instruct-Q4_K_M'
      const QWEN3 = 'Qwen3-0.6B-Q4_K_M'
      const asked: string[] = []
      await boot(page, {
        models: [{ name: SMOL, size: 270_590_880 }, { name: QWEN3, size: 396_705_472 }],
        modelName: SMOL,
        loaded: null,
        startDelay: 7000,
        onEngineRequest: (url) => asked.push(url),
      })
      // The composer names the model the way the catalogue does, not by its file.
      await waitForModel(page, 'SmolLM2 360M')
      await expect(page.getByTestId('m-chat-options')).not.toContainText('Q4_K_M')
      await expect(page.getByTestId('m-chat-loading-model')).toContainText('Loading SmolLM2 360M')
      expect(await layout(page)).toEqual(CLEAN)

      // SmolLM2 does not think: no chip and no switch, before the engine was ever asked.
      await expect(page.getByTestId('m-chat-options')).not.toContainText('Thinking')
      await page.getByTestId('m-chat-options').tap()
      await expect(page.getByTestId('m-sheet-chat-options')).toBeVisible()
      await expect(page.getByTestId('m-options-thinking')).toHaveCount(0)
      await page.getByTestId('m-sheet-close').tap()

      // The chat is open and the engine is still starting: the page asks nothing of its port.
      // (The send path still asks for the window of the model while it loads: that question lives in
      // src/api/providers/openai-provider.ts, see mobile-docs/r2/chat.md, open points.)
      expect(asked).toEqual([])
      await send(page, 'Hello')
      await expect(page.getByTestId('m-chat-loading-model')).toHaveAttribute('data-m-queued', 'yes')
      expect(await backend(page, (ctl) => ctl.loaded)).toBeNull()
      await answerDone(page)
      expect(await backend(page, (ctl) => ctl.engineStarts.length)).toBe(1)
      await expect(page.getByTestId('m-chat-model-by').last()).toHaveText(/SmolLM2 360M/)
      await expect(page.getByTestId('m-chat-model-by').last()).not.toContainText('Instruct')
      await expect(page.getByTestId('m-chat-options')).not.toContainText('Thinking')
      expect(await layout(page)).toEqual(CLEAN)

      // A toast over the text field must not swallow the tap that was meant for the field.
      const focused = await page.evaluate(async () => {
        const { toast } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/ui/index.ts`)
        toast('SmolLM2 360M installed', { testid: 'installed' })
        await new Promise((resolve) => setTimeout(resolve, 100))
        const field = document.querySelector<HTMLTextAreaElement>('[data-testid="m-chat-input"]')!
        field.blur()
        const box = field.getBoundingClientRect()
        const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }
        document.querySelector('[data-testid="m-toast-installed"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...at }))
        return document.activeElement === field
      })
      expect(focused).toBe(true)
      await page.keyboard.type('typed under the toast')
      await expect(page.getByTestId('m-chat-input')).toHaveValue('typed under the toast')
      await page.getByTestId('m-chat-input').fill('')

      // The model sheet uses the same names. Qwen3 thinks: there the switch is offered.
      await openModelSheet(page)
      const local = page.getByTestId('m-chat-model-local')
      await expect(local).toHaveCount(2)
      await expect(local.first()).toContainText('SmolLM2 360M')
      await expect(local.last()).toContainText('Qwen3 0.6B')
      await expect(page.getByTestId('m-chat-model-list')).not.toContainText('Q4_K_M')
      // A download that stopped is not "downloading": the row says so and leads to the downloads.
      await page.evaluate(async () => {
        const { useDownloadStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/downloadStore.ts`)
        const row = { progress: 10, total: 100, speed: 0, filename: 'gemma-3-1b-it-Q4_K_M.gguf', status: 'error', error: 'This download was redirected to an address that is not allowed.' }
        useDownloadStore.setState({ downloads: { 'gemma-3-1b-it-Q4_K_M.gguf': row }, ownRows: { 'gemma-3-1b-it-Q4_K_M.gguf': row } })
      })
      await expect(page.getByTestId('m-chat-model-download')).toContainText('Stopped. Open Downloads to see why.')
      await expect(page.getByTestId('m-chat-model-download')).not.toContainText('% downloaded')
      expect(await layout(page)).toEqual(CLEAN)
      await page.locator(`[data-testid="m-chat-model-local"][data-m-id="openai::${QWEN3}"]`).tap()
      await waitForModel(page, 'Qwen3 0.6B')
      await page.getByTestId('m-chat-options').tap()
      await expect(page.getByTestId('m-options-thinking')).toBeVisible()
      await page.getByTestId('m-sheet-close').tap()
      expect(errors()).toEqual([])
    })
  })
}

/**
 * Runs inside the page: a phone whose storage is full, as check 4 on Android saw it (finding F11).
 * While `lu-e2e-full` is set in the session, a write to the chat store fails with the words of that
 * phone; while `lu-e2e-blind` is set, a read of it fails. Both are read at the moment of the call.
 */
function fullPhone() {
  const flag = (name: string) => {
    try {
      return sessionStorage.getItem(name) === '1'
    } catch {
      return false
    }
  }
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'kv' && flag('lu-e2e-full')) throw new DOMException('Failed to write blobs (IOError)', 'DataError')
    return put.apply(this, args)
  }
  for (const method of ['get', 'count'] as const) {
    const original = IDBObjectStore.prototype[method] as (...args: unknown[]) => IDBRequest
    ;(IDBObjectStore.prototype as unknown as Record<string, unknown>)[method] = function (this: IDBObjectStore, ...args: unknown[]) {
      if (this.name === 'kv' && flag('lu-e2e-blind')) throw new DOMException('Internal error opening backing store for indexedDB.open.', 'UnknownError')
      return original.apply(this, args)
    }
  }
}

/** What IndexedDB holds for the chats, read past the patches above. */
async function storedChatTitles(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open('locally-uncensored-store')
        open.onerror = () => resolve([])
        open.onsuccess = () => {
          const read = open.result.transaction('kv', 'readonly').objectStore('kv').getAll(IDBKeyRange.only('chat-conversations'))
          read.onerror = () => resolve([])
          read.onsuccess = () => {
            try {
              const saved = JSON.parse(String(read.result[0])) as { state: { conversations: Array<{ title: string; messages: unknown[] }> } }
              resolve(saved.state.conversations.map((c) => `${c.title}:${c.messages.length}`))
            } catch {
              resolve([])
            }
          }
        }
      }),
  )
}

test.describe('a phone that is out of storage (check 4 on Android, F11)', () => {
  test.use({ viewport: { width: 360, height: 640 } })

  test('a chat that cannot be saved says so, stays on screen and is saved by itself once there is room', async ({ page }) => {
    await page.addInitScript(fullPhone)
    await boot(page)
    await waitForModel(page)
    await back(page)
    await seedChats(page, [{ id: 'kept', title: 'Kept', messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }] }])
    await expect.poll(() => storedChatTitles(page)).toEqual(['Kept:2'])

    await page.evaluate(() => sessionStorage.setItem('lu-e2e-full', '1'))
    await openChat(page, 'kept')
    await send(page, 'Is this saved?')
    await answerDone(page)
    const notice = page.getByTestId('m-app-storage-not-saved')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Your phone is out of storage. This chat is not saved yet. Free up space, then try again.')
    // The chat is still on screen, and the stored chats are as they were.
    await expect(page.getByTestId('m-chat-screen')).toContainText('Is this saved?')
    expect(await storedChatTitles(page)).toEqual(['Kept:2'])
    // Never the sentence that it is safe.
    await expect(page.locator('[data-testid^="m-toast-storage-slow"]')).toHaveCount(0)
    // "Try again" with the phone still full: the notice stays.
    await page.getByTestId('m-app-storage-retry').tap()
    await expect(notice).toBeVisible()
    expect(await storedChatTitles(page)).toEqual(['Kept:2'])

    // Room again. Nothing is tapped: the app writes the chat by itself.
    await page.evaluate(() => sessionStorage.removeItem('lu-e2e-full'))
    await expect.poll(() => storedChatTitles(page), { timeout: 15_000 }).toEqual(['Kept:4'])
    await expect(notice).toHaveCount(0)
    await expect(page.locator('[data-testid^="m-toast-storage-saved-again"]')).toBeVisible()

    // The way to the storage page.
    await page.evaluate(() => sessionStorage.setItem('lu-e2e-full', '1'))
    await send(page, 'And this?')
    await expect(notice).toBeVisible()
    await page.getByTestId('m-app-storage-manage').tap()
    expect(await topRoute(page)).toBe('/settings/storage')
  })

  test('a start that cannot read the chats shows that, never "no chats" and never the restore offer, and writes nothing over them', async ({ page }) => {
    await page.addInitScript(fullPhone)
    await boot(page)
    await waitForModel(page)
    await back(page)
    await seedChats(page, [
      { id: 'one', title: 'One', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] },
      { id: 'two', title: 'Two', messages: [{ role: 'user', content: 'q' }] },
    ])
    await expect.poll(() => storedChatTitles(page)).toEqual(['One:2', 'Two:1'])
    // A backup with chats lies on the phone: an empty list would offer it.
    await page.addInitScript(() => {
      const ctl = (window as unknown as { __CHAT_E2E__?: { backup: string | null } }).__CHAT_E2E__
      if (ctl) ctl.backup = JSON.stringify({ 'chat-conversations': JSON.stringify({ state: { conversations: [{ id: 'old-1' }] } }) })
    })

    // The next start, with the phone full.
    await page.evaluate(() => sessionStorage.setItem('lu-e2e-blind', '1'))
    await page.reload()
    await page.getByTestId('m-app').waitFor()
    await screensLoaded(page)
    if (await page.getByTestId('m-chat-screen').isVisible()) await back(page)
    const unreadable = page.getByTestId('m-chats-unreadable')
    await expect(unreadable).toBeVisible()
    await expect(unreadable).toContainText('Your chats could not be read')
    await expect(unreadable).toContainText('out of storage')
    await expect(unreadable).toContainText('still on this phone')
    await expect(page.getByTestId('m-chats-empty')).toHaveCount(0)
    await expect(page.getByTestId('m-chats-restore')).toHaveCount(0)
    await expect(page.getByTestId('m-chats-new')).toHaveCount(0)
    expect(await layout(page)).toEqual(CLEAN)
    // Whatever the app wrote meanwhile: the chats on the disk are untouched.
    await page.waitForTimeout(1500)
    expect(await storedChatTitles(page)).toEqual(['One:2', 'Two:1'])

    // The way to the storage page, and back.
    await page.getByTestId('m-chats-unreadable-storage').tap()
    expect(await topRoute(page)).toBe('/settings/storage')
    await back(page)
    await page.getByTestId('m-nav-chat').tap()

    // Room again: "Try again" reads them.
    await page.evaluate(() => sessionStorage.removeItem('lu-e2e-blind'))
    await page.getByTestId('m-chats-unreadable-retry').tap()
    await expect(page.getByTestId('m-chats-item')).toHaveCount(2)
    await expect(page.getByTestId('m-chats-unreadable')).toHaveCount(0)
    expect(await storedChatTitles(page)).toEqual(['One:2', 'Two:1'])
  })
})

test.describe('an answer is never empty without a word (check 4 on Android, F8)', () => {
  test.use({ viewport: { width: 360, height: 640 } })

  test('a run that ends with nothing to show gets the box with "Try again", and an earlier one its sentence', async ({ page }) => {
    const errors = watchErrors(page)
    // The model writes only a token of its template: stored as text, drawn as nothing.
    await boot(page, { reply: '<|im_end|>', chunks: 1 })
    await waitForModel(page)
    await send(page, 'What is 3 times 3?')
    await expect(page.getByTestId('m-chat-stop')).toHaveCount(0)
    const answer = answers(page).last()
    await expect(answer).toHaveAttribute('data-state', 'error')
    await expect(answer.getByTestId('m-chat-error')).toContainText('No answer came back')
    await expect(answer.getByTestId('m-chat-error')).toContainText('The model returned nothing. Try again, or pick another model.')
    await expect(answer.getByTestId('m-chat-error-action')).toBeVisible()
    expect(await layout(page)).toEqual(CLEAN)

    // "Try again" asks the model again, and a real answer takes the place of the empty one.
    await backend(page, (ctl) => {
      ctl.reply = 'Nine.'
    })
    await answer.getByTestId('m-chat-error-action').tap()
    await answerDone(page, 'Nine.')
    await expect(page.getByTestId('m-chat-error')).toHaveCount(0)

    // The same for what is stored: empty text, an empty frame of tags, white space.
    await back(page)
    for (const [id, content] of [['blank', ''], ['frame', '<source></source>'], ['space', ' \n\n ']] as const) {
      await seedChats(page, [{ id, title: `Empty ${id}`, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content }] }])
      await openChat(page, id)
      await expect(answers(page).last()).toHaveAttribute('data-state', 'error')
      await expect(answers(page).last().getByTestId('m-chat-error')).toContainText('No answer came back')
      await back(page)
    }
    // Further up in a chat that went on: no button, but its sentence.
    await seedChats(page, [{ id: 'earlier', title: 'Earlier', messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: '<|im_end|>' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'Hello!' }] }])
    await openChat(page, 'earlier')
    await expect(answers(page).first().getByTestId('m-chat-empty-earlier')).toContainText('The model returned nothing here.')
    await expect(page.getByTestId('m-chat-error')).toHaveCount(0)
    await expect(answers(page).last()).toHaveAttribute('data-state', 'done')
    expect(errors()).toEqual([])
  })
})

test.describe('no control text in front of the reader (check 4 on Android, F3, F4, F12)', () => {
  test.use({ viewport: { width: 360, height: 640 } })

  test('a saved part that begins with a tag of the model shows without it, in the chat, in the list and in the export', async ({ page }) => {
    const errors = watchErrors(page)
    await boot(page)
    await waitForModel(page)
    await back(page)
    const file = { name: 'geheim.txt', size: 89, kind: 'Plain text', sha256: 'ab'.repeat(32), summary: 'The whole text of the file:\nThe secret word is PFLAUMENMUS.' }
    const frame = `What is the secret word?\n\n[Attached file: geheim.txt]\nType: Plain text\nSize: 89.0 B (89 bytes)\nSHA-256: ${file.sha256}\nThe file itself is not available to you in this chat. Only this summary is.\n\n${file.summary}\n[End of attached file: geheim.txt]`
    await seedChats(page, [
      {
        id: 'cut',
        title: 'Lighthouse',
        messages: [
          { role: 'user', content: frame, files: [file] },
          { role: 'assistant', content: '<reminder> I need to clarify - I cannot find information about "Sieben3".', finishReason: 'interrupted' },
        ],
      },
    ])
    // The preview of the list.
    const row = page.locator('[data-testid="m-chats-item"][data-m-id="cut"]')
    await expect(row).toContainText('I need to clarify')
    await expect(row).not.toContainText('reminder')
    // The chat: the part without the tag, the question without the frame, and the box that offers to go on.
    await openChat(page, 'cut')
    const screen = page.getByTestId('m-chat-screen')
    await expect(answers(page).last()).toContainText('I need to clarify - I cannot find information')
    await expect(screen).not.toContainText('<reminder>')
    await expect(screen).not.toContainText('[Attached file:')
    await expect(screen).not.toContainText('not available to you')
    await expect(page.getByTestId('m-chat-error')).toContainText('The part that arrived is kept')

    // The export, as the app writes it.
    const text = await page.evaluate(async () => {
      const { chatExportText } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/chat/parts/adapters/handover.ts`)
      const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
      return chatExportText(useChatStore.getState().conversations.find((c: { id: string }) => c.id === 'cut'), 'markdown') as Promise<string>
    })
    expect(text).toContain('What is the secret word?')
    expect(text).toContain('Attached file: geheim.txt (89.0 B)')
    expect(text).toContain('I need to clarify')
    for (const never of ['<reminder>', '[Attached file:', '[End of attached file:', 'SHA-256', 'not available to you', 'PFLAUMENMUS', 'openai::']) expect(text).not.toContain(never)
    expect(errors()).toEqual([])
  })

  test('the notice after a return never names a saved part where the answer shows none', async ({ page }) => {
    await boot(page)
    await waitForModel(page)
    await back(page)
    await seedChats(page, [
      { id: 'nothing', title: 'Only a token', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '<|im_start|>', finishReason: 'interrupted' }] },
    ])
    const notice = page.getByTestId('m-app-resume')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Nothing of the answer was saved yet')
    await expect(notice).not.toContainText('saved up to that point')
    await expect(page.getByTestId('m-app-resume-open')).toHaveText('Ask again')
    // A part is there: now, and only now, the notice says so.
    await seedChats(page, [
      { id: 'part', title: 'A real part', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Paris is the', finishReason: 'interrupted' }] },
    ])
    await expect(notice).toContainText('The answer is saved up to that point')
  })
})

// Short check on Android, package 8: after a start with the model file gone, the toast with the long sentence lay
// on the send button for seconds, and a tap on Send hit the toast. The chat says that sentence in its own notice
// (with "Pick another model"), so on a page that shows that notice the toast is not shown a second time; on every
// other page it is, and there it lies on no control (rule 5.14).
const FILE_GONE = 'Couldn\'t start the LU Engine with "Qwen3.5-0.8B-Q4_K_M": The model file "Qwen3.5-0.8B-Q4_K_M" is not on this device. It may have been deleted, or the download did not finish. Open Models and download it again, then pick it in the chat.'
for (const size of [{ width: 360, height: 640 }, { width: 320, height: 568 }]) {
  test.describe(`the note about a model that could not start, ${size.width}x${size.height}`, () => {
    test.use({ viewport: size })

    const announce = (page: Page, note: string) =>
      page.evaluate(async (text) => {
        const { useLuEngineSwitchStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/luEngineSwitchStore.ts`)
        useLuEngineSwitchStore.getState().announce(text, 'error')
      }, note)
    const onAControl = (page: Page) =>
      page.evaluate(() => {
        const toast = document.querySelector('[data-testid^="m-toast-"]')?.getBoundingClientRect()
        if (!toast || toast.height === 0) return [] as string[]
        const hit: string[] = []
        for (const el of document.querySelectorAll<HTMLElement>('button, textarea, input, [role="button"], [role="tab"]')) {
          if (el.closest('[data-testid^="m-toast-"], [inert], [data-m-hidden]')) continue
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0 && r.left < toast.right && r.right > toast.left && r.top < toast.bottom && r.bottom > toast.top) hit.push(el.getAttribute('data-testid') ?? el.tagName)
        }
        return hit
      })

    test('in the chat it is the notice of the chat, once, and nothing lies on Send', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.getByTestId('m-chat-input').fill('A question that waits')
      await announce(page, FILE_GONE)
      await expect(page.getByTestId('m-engine-notice-failed')).toContainText('is not on this device')
      await expect(page.getByTestId('m-engine-notice-pick')).toBeVisible()
      // Not a second time as a toast, at no moment of the seconds a toast would stay.
      for (let i = 0; i < 6; i++) {
        expect(await page.locator('[data-testid="m-toast-model-note"]').count(), `toast, look ${i}`).toBe(0)
        const send = page.getByTestId('m-chat-send')
        expect(await send.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }), `Send is free, look ${i}`).toBe(true)
        await page.waitForTimeout(250)
      }
    })

    // Check on Android, package 9: with the keyboard open the box was cut at "... or the download did not".
    test('with the keyboard open the note is one short line in view, and Send stays above the keyboard', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.getByTestId('m-chat-input').fill('A question that waits')
      await announce(page, FILE_GONE)
      const notice = page.getByTestId('m-engine-notice-failed')
      await expect(notice).toContainText('is not on this device')
      await page.getByTestId('m-chat-input').focus()
      const keyboard = { width: size.width, height: size.height === 640 ? 317 : 300 }
      await page.setViewportSize(keyboard)
      await expect(page.locator('html')).toHaveClass(/m-kb-open/)
      await expect(notice).toBeVisible()
      const measured = await page.evaluate(() => {
        const noteEl = document.querySelector('[data-testid="m-engine-notice-failed"]')!
        const lines = noteEl.closest('.m-banners') as HTMLElement
        const note = noteEl.getBoundingClientRect()
        const lineBox = lines.getBoundingClientRect()
        return { scrolls: lines.scrollHeight > lines.clientHeight + 1, noteBottom: note.bottom, lineBottom: lineBox.bottom }
      })
      // Nothing of the line is out of sight: it does not scroll inside its frame. The button comes back with the keyboard gone.
      expect(measured.scrolls).toBe(false)
      expect(measured.noteBottom).toBeLessThanOrEqual(measured.lineBottom + 1)
      const send = (await page.getByTestId('m-chat-send').boundingBox())!
      expect(send.y + send.height).toBeLessThanOrEqual(keyboard.height)
      const field = (await page.getByTestId('m-chat-input').boundingBox())!
      expect(field.y + field.height).toBeLessThanOrEqual(keyboard.height)
    })

    test('on a page without that notice it is a toast, and the toast lies on no control while it shows', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.getByTestId('m-page-back').tap()
      await expect(page.getByTestId('m-chats-screen')).toBeVisible()
      await announce(page, FILE_GONE)
      const toastBox = page.getByTestId('m-toast-model-note')
      await expect(toastBox).toBeVisible()
      for (let i = 0; i < 6; i++) {
        expect(await onAControl(page), `look ${i}`).toEqual([])
        await page.waitForTimeout(250)
      }
    })

    test('a start with the note already there: the chat opens with the notice and Send is free from the first moment', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.getByTestId('m-page-back').tap()
      await announce(page, FILE_GONE)
      await expect(page.getByTestId('m-toast-model-note')).toBeVisible()
      // The user goes into a chat while the toast still shows: it lies on nothing there either.
      await page.getByTestId('m-chats-empty-new').tap()
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      await page.getByTestId('m-chat-input').fill('Hello')
      for (let i = 0; i < 6; i++) {
        expect(await onAControl(page), `look ${i}`).toEqual([])
        await page.waitForTimeout(250)
      }
    })
  })
}

// Short check 7 on Android, E6: the note about a missing model file was there with the keyboard open in 1 of 8
// situations; in the other seven it was folded away until the keyboard closed, and in one Send lay half under the
// keyboard. In every situation the note is read in full with the keyboard open, and Send is whole above it.
for (const lage of [
  { name: '360x640, text 1.0', open: { width: 360, height: 640 }, keyboard: 277, fontScale: undefined },
  { name: '360x640, text 1.3', open: { width: 360, height: 640 }, keyboard: 277, fontScale: 130 },
  { name: '360x640, text 2.0', open: { width: 360, height: 640 }, keyboard: 277, fontScale: 200 },
  { name: '360x640 on its side', open: { width: 640, height: 360 }, keyboard: 101, fontScale: undefined },
  { name: '320x568, text 1.0', open: { width: 320, height: 568 }, keyboard: 228, fontScale: undefined },
  { name: '320x568, text 1.3', open: { width: 320, height: 568 }, keyboard: 228, fontScale: 130 },
  { name: '320x568, text 2.0', open: { width: 320, height: 568 }, keyboard: 228, fontScale: 200 },
  { name: '320x568 on its side', open: { width: 568, height: 320 }, keyboard: 86, fontScale: undefined },
] as const) {
  test.describe(`the missing model file with the keyboard open, ${lage.name}`, () => {
    test.use({ viewport: lage.open })

    test('the note is read in full above the keyboard and Send is whole and free', async ({ page }) => {
      await boot(page, { fontScale: lage.fontScale })
      await waitForModel(page)
      await page.getByTestId('m-chat-input').fill('Hello')
      await page.evaluate(async (text) => {
        const { useLuEngineSwitchStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/luEngineSwitchStore.ts`)
        useLuEngineSwitchStore.getState().announce(text, 'error')
      }, FILE_GONE)
      await page.getByTestId('m-chat-input').focus()
      await page.setViewportSize({ width: lage.open.width, height: lage.keyboard })
      await expect(page.locator('html')).toHaveClass(/m-kb-open/)
      const notice = page.getByTestId('m-engine-notice-failed')
      await expect(notice).toBeVisible()
      await expect(page.locator('[data-testid="m-engine-notice-failed"] .m-note-short')).toBeVisible()
      await page.waitForTimeout(400)
      const m = await page.evaluate((kb) => {
        const el = document.querySelector('[data-testid="m-engine-notice-failed"]') as HTMLElement
        const r = el.getBoundingClientRect()
        // The text is read in full: no element of the note is cut by its own frame or by a scrolling parent.
        let cut = ''
        for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
          const o = getComputedStyle(node)
          if (node !== el && /(auto|scroll|hidden)/.test(o.overflowY)) {
            const f = node.getBoundingClientRect()
            if (node.scrollHeight > node.clientHeight + 1) cut += ` scrolls:${node.className}(${node.scrollHeight}>${node.clientHeight})`
            if (r.top < f.top - 1 || r.bottom > f.bottom + 1) cut += ` outside:${node.className}(${r.top}-${r.bottom} in ${f.top}-${f.bottom})`
          }
        }
        for (const t of el.querySelectorAll<HTMLElement>('*')) {
          const o = getComputedStyle(t)
          if (o.textOverflow === 'ellipsis' && t.scrollWidth > t.clientWidth + 1) cut += ' ellipsis'
        }
        const body = el.textContent ?? ''
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cut, body, kb, room: document.documentElement.dataset.mRoom }
      }, lage.keyboard)
      expect(m.cut, `the note is not cut (room ${m.room})`).toBe('')
      expect(m.top).toBeGreaterThanOrEqual(0)
      expect(m.bottom).toBeLessThanOrEqual(lage.keyboard)
      expect(m.left).toBeGreaterThanOrEqual(0)
      expect(m.right).toBeLessThanOrEqual(lage.open.width)
      expect(m.body).toContain('Model file missing')
      const send = (await page.getByTestId('m-chat-send').boundingBox())!
      expect(send.y).toBeGreaterThanOrEqual(0)
      expect(send.y + send.height, 'Send is whole above the keyboard').toBeLessThanOrEqual(lage.keyboard)
      const field = (await page.getByTestId('m-chat-input').boundingBox())!
      expect(field.y + field.height).toBeLessThanOrEqual(lage.keyboard)
      // Send is reached: the middle of it is Send, nothing lies on it.
      expect(await page.getByTestId('m-chat-send').evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) })).toBe(true)
    })
  })
}

// Check Android package 11, E6 rest: at the text zoom of Android 2.0 (the guard above enlarges the root through the
// address) the short line lay 8 px under the top edge on 320x568 on its side with the keyboard open (86 px seen), and
// without the keyboard the whole notice did not fit: "Pick another model" came only after scrolling inside it.
// Check Android package 15, N1: what that phone gives the WebView between its bars, 320x487 upright and 520x272 on its
// side. There the notice without the keyboard pushed Send (upright) and the field (on its side) under the bottom edge.
const E6_ZOOM_LAGEN: readonly { name: string; open: { width: number; height: number }; keyboard: number | null }[] = [
  { name: '320x568 on its side', open: { width: 568, height: 320 }, keyboard: 86 },
  { name: '320x568 upright', open: { width: 320, height: 568 }, keyboard: 228 },
  { name: '360x640 on its side', open: { width: 640, height: 360 }, keyboard: 101 },
  { name: '360x640 upright', open: { width: 360, height: 640 }, keyboard: null },
  { name: '320x568 upright between the bars', open: { width: 320, height: 487 }, keyboard: null },
  { name: '320x568 on its side between the bars', open: { width: 520, height: 272 }, keyboard: null },
  // Check Android package 16, N1 rest: on its side the phone takes its gesture bar from the width as well, the
  // WebView had 511x272. There the buttons broke into two lines and the field and Send lay half under the bottom
  // edge. 480x272 is narrower still, so the guard does not rest on a few pixels.
  { name: '320x568 on its side between the bars and beside the gesture bar', open: { width: 511, height: 272 }, keyboard: null },
  { name: '320x568 on its side, narrower still', open: { width: 480, height: 272 }, keyboard: null },
]
for (const lage of E6_ZOOM_LAGEN) {
  test.describe(`the missing model file at the text zoom of Android 2.0, ${lage.name}`, () => {
    test.use({ viewport: lage.open })

    const showNote = async (page: Page) => {
      await boot(page, { os: 'android' })
      await waitForModel(page)
      await androidTextZoom(page, 2)
      await page.evaluate(async (text) => {
        const { useLuEngineSwitchStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/luEngineSwitchStore.ts`)
        useLuEngineSwitchStore.getState().announce(text, 'error')
      }, FILE_GONE)
      await expect(page.getByTestId('m-engine-notice-failed')).toBeVisible()
    }
    /** The box of an element as far as it can be seen: inside the window and inside every parent that cuts or scrolls. */
    const seenPart = (el: Element) => {
      const r = el.getBoundingClientRect()
      let top = Math.max(r.top, 0)
      let bottom = Math.min(r.bottom, window.visualViewport?.height ?? innerHeight)
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowY)) {
          const f = node.getBoundingClientRect()
          top = Math.max(top, f.top)
          bottom = Math.min(bottom, f.bottom)
        }
      }
      return { top: r.top, bottom: r.bottom, seenTop: top, seenBottom: bottom }
    }

    test('with the keyboard open the short line is whole in view and Send is whole above the keyboard', async ({ page }) => {
      test.skip(lage.keyboard === null, 'no keyboard height measured for this size')
      const keyboard = lage.keyboard ?? 0
      await showNote(page)
      await page.getByTestId('m-chat-input').fill('Hello')
      await page.getByTestId('m-chat-input').focus()
      await page.setViewportSize({ width: lage.open.width, height: keyboard })
      await expect(page.locator('html')).toHaveClass(/m-kb-open/)
      const line = page.locator('[data-testid="m-engine-notice-failed"] .m-note-short')
      await expect(line).toBeVisible()
      await page.waitForTimeout(400)
      const m = await line.evaluate(seenPart)
      expect(m.top, 'the line starts in view').toBeGreaterThanOrEqual(0)
      expect(m.seenTop).toBeLessThanOrEqual(m.top + 0.5)
      expect(m.seenBottom).toBeGreaterThanOrEqual(m.bottom - 0.5)
      const send = (await page.getByTestId('m-chat-send').boundingBox())!
      expect(send.y).toBeGreaterThanOrEqual(0)
      expect(send.y + send.height, 'Send is whole above the keyboard').toBeLessThanOrEqual(keyboard)
      expect(await page.getByTestId('m-chat-send').evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) })).toBe(true)
    })

    // Check Android package 17, A1: on its side at 511x272 "Ask LU anything" stood between the notice and the composer,
    // its lower half under the composer. What of the greeting is shown is whole in view; what does not fit is not shown.
    test('the greeting of the empty chat is whole in view or not shown, never cut by the composer', async ({ page }) => {
      await showNote(page)
      await page.waitForTimeout(400)
      const dockTop = await page.locator('.m-chat-dock').evaluate((el) => el.getBoundingClientRect().top)
      const parts = page.locator('[data-testid="m-chat-empty"] > :not(.m-empty-mark)')
      const shown: string[] = []
      for (let i = 0; i < (await parts.count()); i++) {
        const part = parts.nth(i)
        if (!(await part.isVisible())) continue
        const m = await part.evaluate(seenPart)
        const what = (await part.textContent())?.slice(0, 20) ?? ''
        shown.push(what)
        expect(m.seenTop, `${what} top`).toBeLessThanOrEqual(m.top + 0.5)
        expect(m.seenBottom, `${what} bottom`).toBeGreaterThanOrEqual(m.bottom - 0.5)
        expect(m.bottom, `${what} above the composer`).toBeLessThanOrEqual(dockTop + 0.5)
      }
      // Where there is room the heading is there: hiding is for the strip that cannot hold it.
      if (lage.open.height >= 640) expect(shown.join(' ')).toContain('Ask LU')
    })

    test('without the keyboard "Pick another model" and "Dismiss" are in view without scrolling', async ({ page }) => {
      await showNote(page)
      await page.waitForTimeout(400)
      for (const id of ['m-engine-notice-pick', 'm-engine-notice-dismiss']) {
        const button = page.getByTestId(id)
        await expect(button).toBeVisible()
        const m = await button.evaluate(seenPart)
        expect(m.seenTop, `${id} top`).toBeLessThanOrEqual(m.top + 0.5)
        expect(m.seenBottom, `${id} bottom`).toBeGreaterThanOrEqual(m.bottom - 0.5)
        expect(await button.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }), `${id} is reached`).toBe(true)
      }
      // What the note says is there to read: the short line at least, the file name when there is room.
      await expect(page.getByTestId('m-engine-notice-failed')).toContainText(/Model file missing|is not on this device/)
      // Check Android package 15, N1: and the field and Send are whole in view and reached as well. Typed, then the
      // keyboard closed (Send shows only with text).
      await page.getByTestId('m-chat-input').fill('Hello')
      await page.getByTestId('m-chat-input').blur()
      await expect(page.locator('html')).not.toHaveClass(/m-kb-open/)
      await page.waitForTimeout(300)
      for (const id of ['m-chat-input', 'm-chat-send']) {
        const el = page.getByTestId(id)
        const m = await el.evaluate(seenPart)
        expect(m.top, `${id} starts in view`).toBeGreaterThanOrEqual(m.seenTop - 0.5)
        expect(m.bottom, `${id} ends in view`).toBeLessThanOrEqual(m.seenBottom + 0.5)
        expect(await el.evaluate((node) => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }), `${id} is reached`).toBe(true)
      }
    })
  })
}

// Check Android package 18, A1 rest: 320x568 upright at the text zoom 1.0 with the note about a missing model file,
// the WebView had 320x487 between the bars. "Ask LU anything" stood half under the composer (3 of 3). Outside little
// room the mark of the greeting was not taken away when it did not fit, it only went invisible and kept its place,
// so it pushed the heading down that the measure had counted without it. Every part of the greeting that shows is
// whole above the composer, with and without the note, and with the note the heading is there.
for (const size of [{ width: 320, height: 487 }, { width: 320, height: 568 }]) {
  for (const withNote of [true, false]) {
    test.describe(`the greeting at the text zoom 1.0, ${size.width}x${size.height} upright, ${withNote ? 'with' : 'without'} the note`, () => {
      test.use({ viewport: size })

      test('what of the greeting shows is whole above the composer, the heading is there', async ({ page }) => {
        await boot(page, { os: 'android' })
        await waitForModel(page)
        if (withNote) {
          await page.evaluate(async (text) => {
            const { useLuEngineSwitchStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/luEngineSwitchStore.ts`)
            useLuEngineSwitchStore.getState().announce(text, 'error')
          }, FILE_GONE)
          await expect(page.getByTestId('m-engine-notice-failed')).toBeVisible()
        }
        await page.waitForTimeout(400)
        const seen = await page.getByTestId('m-chat-empty').evaluate((greeting) => {
          const dockTop = document.querySelector('.m-chat-dock')!.getBoundingClientRect().top
          const body = greeting.closest('.m-body')!.getBoundingClientRect()
          const parts: { what: string; top: number; bottom: number }[] = []
          for (const part of greeting.children) {
            const el = part as HTMLElement
            if (el.offsetHeight === 0 || getComputedStyle(el).visibility === 'hidden') continue
            const r = el.getBoundingClientRect()
            parts.push({ what: el.classList.contains('m-empty-mark') ? 'mark' : (el.textContent ?? '').slice(0, 20), top: r.top, bottom: r.bottom })
          }
          return { dockTop, bodyTop: body.top, parts, room: document.documentElement.getAttribute('data-m-room') }
        })
        expect(seen.room, 'not little room: the case of the report').toBeNull()
        for (const part of seen.parts) {
          expect(part.top, `${part.what} starts in view`).toBeGreaterThanOrEqual(seen.bodyTop - 0.5)
          expect(part.bottom, `${part.what} above the composer`).toBeLessThanOrEqual(seen.dockTop + 0.5)
        }
        expect(seen.parts.map((p) => p.what).join(' ')).toContain('Ask LU')
      })
    })
  }
}

// Check 4 on Android, F9: the field that edits an answer lay partly under the keyboard, upright at the largest
// text and on its side. It follows the rule of the kit for a field of several lines now: under the keyboard it is
// as high as the room above it, and its text scrolls inside.
for (const lage of [
  { name: 'upright, largest text', open: { width: 360, height: 640 }, keyboard: { width: 360, height: 317 }, fontScale: 200 },
  { name: 'on its side', open: { width: 640, height: 360 }, keyboard: { width: 640, height: 101 }, fontScale: undefined },
  { name: 'on its side, largest text', open: { width: 640, height: 360 }, keyboard: { width: 640, height: 101 }, fontScale: 200 },
] as const) {
  test.describe(`editing an answer with the keyboard open, ${lage.name}`, () => {
    test.use({ viewport: lage.open })

    test('the field is whole above the keyboard, its text scrolls inside, and it is as tall as its text again when the keyboard goes', async ({ page }) => {
      await boot(page, { fontScale: lage.fontScale })
      await page.getByTestId('m-page-back').tap()
      const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a longer answer about tides and the moon.`).join('\n\n')
      await seedChats(page, [{ id: 'long', title: 'Tides', messages: [{ role: 'user', content: 'Tell me about tides' }, { role: 'assistant', content: long }] }])
      await page.evaluate(async () => {
        const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
        nav.push('/chat/:id', { id: 'long' })
        nav.push('/chat/:id/message/:messageId/edit', { id: 'long', messageId: 'long-m1' })
      })
      const field = page.getByTestId('m-chat-edit-field')
      await expect(field).toBeVisible()
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)))
      const natural = (await field.boundingBox())!.height
      expect(natural).toBeGreaterThan(lage.keyboard.height)

      await field.focus()
      await page.setViewportSize(lage.keyboard)
      await expect(page.locator('html')).toHaveClass(/m-kb-open/)
      await expect(field).toHaveAttribute('data-m-capped', '')
      await expect
        .poll(async () => {
          const box = (await field.boundingBox())!
          return box.y >= 0 && box.y + box.height <= lage.keyboard.height
        })
        .toBe(true)
      // The text is all there, and scrolls inside the field.
      expect(await field.evaluate((el: HTMLTextAreaElement) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto')).toBe(true)
      // Typing at the end keeps the line with the caret in sight.
      await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length))
      await page.keyboard.type(' END')
      await expect(field).toHaveValue(/ END$/)
      const box = (await field.boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(lage.keyboard.height)

      // The keyboard goes: as tall as its text, the page scrolls.
      await page.setViewportSize(lage.open)
      await expect(page.locator('html')).not.toHaveClass(/m-kb-open/)
      await expect(field).not.toHaveAttribute('data-m-capped', '')
      expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(natural - 1)
    })
  })
}

// Short check of package 10 on iOS, F5: on its side with the keyboard open, the round button to the buttons of the
// page lay over the end of the text of the answer being edited. While the keyboard is open it is not shown there,
// and it is back when the keyboard goes.
test.describe('editing an answer on its side: the round button stays off the text while the keyboard is open', () => {
  test.use({ viewport: { width: 640, height: 360 } })

  test('hidden with the keyboard, back without it', async ({ page }) => {
    await boot(page, { fontScale: 200 })
    await page.getByTestId('m-page-back').tap()
    const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a longer answer about tides and the moon.`).join('\n\n')
    await seedChats(page, [{ id: 'long', title: 'Tides', messages: [{ role: 'user', content: 'Tell me about tides' }, { role: 'assistant', content: long }] }])
    await page.evaluate(async () => {
      const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
      nav.push('/chat/:id', { id: 'long' })
      nav.push('/chat/:id/message/:messageId/edit', { id: 'long', messageId: 'long-m1' })
    })
    const field = page.getByTestId('m-chat-edit-field')
    await expect(field).toBeVisible()
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)))
    await expect(page.getByTestId('m-foot-jump')).toBeVisible()

    await field.focus()
    await page.setViewportSize({ width: 640, height: 101 })
    await expect(page.locator('html')).toHaveClass(/m-kb-open/)
    await expect(page.getByTestId('m-foot-jump')).toBeHidden()

    await page.setViewportSize({ width: 640, height: 360 })
    await expect(page.locator('html')).not.toHaveClass(/m-kb-open/)
    await expect(page.getByTestId('m-foot-jump')).toBeVisible()
  })
})

// Short check of package 10 on iOS, F4: on its side at the largest text, two notices above the chat ("This chat ran
// on X before" and the note about a model that did not start) filled the screen, and no message was in view. The
// notices keep about a quarter of the page there and scroll inside, so the transcript always has a strip.
test.describe('on its side at the largest text, two notices leave the transcript in view', () => {
  test.use({ viewport: { width: 640, height: 360 } })

  test('a message of the chat is in view with the model hint and the note about a model that did not start', async ({ page }) => {
    await boot(page, { fontScale: 200 })
    await page.getByTestId('m-page-back').tap()
    await seedChats(page, [{ id: 'other', title: 'Other model', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.', modelId: `openai::${VISION}` }] }])
    await openChat(page, 'other')
    await expect(page.getByTestId('m-chat-model-hint')).toContainText('This chat ran on')
    await page.evaluate(async (text) => {
      const { useLuEngineSwitchStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/luEngineSwitchStore.ts`)
      useLuEngineSwitchStore.getState().announce(text, 'error')
    }, 'Couldn\'t start the LU Engine with "Qwen3.5-0.8B-Q4_K_M": The model file "Qwen3.5-0.8B-Q4_K_M" is not on this device. It may have been deleted, or the download did not finish. Open Models and download it again, then pick it in the chat.')
    await expect(page.getByTestId('m-engine-notice-failed')).toBeVisible()
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)))
    const m = await page.evaluate(() => {
      const banners = document.querySelector('[data-testid="m-engine-notice-failed"]')!.closest('.m-banners')!.getBoundingClientRect()
      const scroll = document.querySelector('[data-testid="m-chat-message"]')!.closest('.m-chat-scroll')!.getBoundingClientRect()
      const all = [...document.querySelectorAll('[data-testid="m-chat-message"]')]
      const msg = all[all.length - 1]!.getBoundingClientRect()
      const dock = document.querySelector('.m-chat-dock')!.getBoundingClientRect()
      // What is left between the notices and the composer, and how much of the first message is in that strip.
      const strip = dock.top - banners.bottom
      const top = Math.max(msg.top, banners.bottom, scroll.top)
      const bottom = Math.min(msg.bottom, dock.top, scroll.bottom)
      return { banners: banners.height, scroll: strip, dock: dock.height, seen: bottom - top, viewport: innerHeight }
    })
    expect(m.scroll, `transcript strip (banners ${m.banners}, dock ${m.dock}, viewport ${m.viewport})`).toBeGreaterThanOrEqual(60)
    expect(m.seen, 'a message is in view').toBeGreaterThan(20)
  })
})

// Check iOS package 11, N2: on its side at the largest text (iOS enlarges the root, capped at 200 percent) the note
// about a missing model file scrolled inside, "Pick another model" came only after scrolling it, with the hint
// "This chat ran on X before" above it. Round 30 (E6 rest) gave the short line with both buttons wherever room is
// short; this keeps it for the sizes of the iPhone on its side, with the hint of another model in the chat.
for (const lage of [
  { name: 'iPhone SE on its side', viewport: { width: 667, height: 375 } },
  { name: 'iPhone 17 on its side', viewport: { width: 874, height: 402 } },
] as const) {
  test.describe(`the missing model file on its side at the largest text of iOS, ${lage.name}`, () => {
    test.use({ viewport: lage.viewport })

    test('"Pick another model" and "Dismiss" are in view without scrolling, the notices do not scroll, the field is whole', async ({ page }) => {
      await boot(page, { fontScale: 200, os: 'ios' })
      await page.getByTestId('m-page-back').tap()
      await seedChats(page, [{ id: 'other', title: 'Other model', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.', modelId: `openai::${VISION}` }] }])
      await openChat(page, 'other')
      await page.evaluate(async (text) => {
        const { useLuEngineSwitchStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/luEngineSwitchStore.ts`)
        useLuEngineSwitchStore.getState().announce(text, 'error')
      }, FILE_GONE)
      await expect(page.getByTestId('m-engine-notice-failed')).toBeVisible()
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)))
      const room = await page.evaluate(() => document.documentElement.dataset.mRoom)
      expect(room, 'the root is as large as on the iPhone at the largest text').toBeTruthy()
      for (const id of ['m-engine-notice-pick', 'm-engine-notice-dismiss']) {
        const button = page.getByTestId(id)
        await expect(button).toBeVisible()
        const m = await button.evaluate((el) => {
          const r = el.getBoundingClientRect()
          let top = Math.max(r.top, 0)
          let bottom = Math.min(r.bottom, innerHeight)
          for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
            if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowY)) {
              const f = node.getBoundingClientRect()
              top = Math.max(top, f.top)
              bottom = Math.min(bottom, f.bottom)
            }
          }
          return { top: r.top, bottom: r.bottom, seenTop: top, seenBottom: bottom, hit: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }
        })
        expect(m.seenTop, `${id} top (room ${room})`).toBeLessThanOrEqual(m.top + 0.5)
        expect(m.seenBottom, `${id} bottom (room ${room})`).toBeGreaterThanOrEqual(m.bottom - 0.5)
        expect(m.hit, `${id} is reached`).toBe(true)
      }
      const banners = await page.getByTestId('m-engine-notice-failed').evaluate((el) => {
        const box = el.closest('.m-banners') as HTMLElement
        return { scrolls: box.scrollHeight > box.clientHeight + 1, text: el.textContent ?? '' }
      })
      expect(banners.scrolls, 'the notices do not scroll inside').toBe(false)
      expect(banners.text).toMatch(/Model file missing|is not on this device/)
      const field = (await page.getByTestId('m-chat-input').boundingBox())!
      expect(field.y + field.height, 'the text field is whole in the window').toBeLessThanOrEqual(lage.viewport.height)
    })
  })
}

// Short check of package 10 on iOS, scanned PDF: the honest note came after seconds, and for those seconds nothing
// showed that the file was being read. The sheet gives way to the chat at once, and a chip says "Reading <name>"
// until the file is a chip of its own or the note about it comes.
test.describe('a document that takes seconds to read shows a chip while it is read', () => {
  test('the chip stands in the composer, then the note comes and the chip is gone', async ({ page }) => {
    await boot(page)
    await waitForModel(page)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    // The reader of PDFs is loaded when the first one is picked; holding it back stands for a long read.
    let held = 0
    await page.route(/pdfjs-dist.*legacy.*build.*pdf(__mjs\.js|\.mjs)/, async (route) => {
      held += 1
      await gate
      await route.continue()
    })
    await page.getByTestId('m-chat-attach').tap()
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId('m-chat-attach-file').tap()
    await (await chooser).setFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') })
    const reading = page.getByTestId('m-chat-attachment-reading')
    await expect(reading).toHaveCount(1)
    await expect(reading).toContainText('Reading scan.pdf')
    await expect(reading).toBeVisible()
    await expect(page.getByTestId('m-sheet-attach')).toHaveCount(0)
    // The chip stands before the request for the reader has gone out.
    await expect.poll(() => held, { message: 'the reader of PDFs was asked for' }).toBeGreaterThan(0)
    release()
    await expect(reading).toHaveCount(0)
    await expect(page.getByTestId('m-toast-attach-unreadable')).toBeVisible()
  })
})

test.describe('chat, a provider with the own key', () => {
  test('its models are in the model list, and a message goes to its host with its key', async ({ page }) => {
    const KEY = 'gsk_mock_key_for_tests_0123456789'
    // What the settings page saves for Groq: an extra slot of the provider store, switched on.
    await page.addInitScript((key) => {
      if (localStorage.getItem('lu-providers')) return
      const obfuscated = btoa(key.split('').reverse().join(''))
      localStorage.setItem(
        'lu-providers',
        JSON.stringify({
          state: { providers: { 'openai-groq': { id: 'openai-groq', name: 'Groq', enabled: true, baseUrl: 'https://api.groq.com/openai/v1', apiKey: obfuscated, isLocal: false } } },
          version: 1,
        }),
      )
    }, KEY)
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
    const seen: Array<{ path: string; auth: string; model?: string }> = []
    await page.route('https://api.groq.com/**', (route) => {
      const request = route.request()
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      const path = new URL(request.url()).pathname
      const body = request.postDataJSON() as { model?: string } | null
      seen.push({ path, auth: request.headers().authorization ?? '', model: body?.model })
      if (path.endsWith('/models')) {
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ object: 'list', data: [{ id: 'llama-3.3-70b', object: 'model' }, { id: 'qwen-qwq-32b', object: 'model' }] }) })
      }
      const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: frame({ role: 'assistant' }, null) + frame({ content: 'Hello from the provider.' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n' })
    })
    await boot(page)
    await waitForModel(page)

    // C3.11: the rows of the provider, under its own heading, next to the models of this phone.
    await openModelSheet(page)
    const rows = page.locator('[data-testid="m-sheet-model"] [data-testid="m-chat-model-provider"]')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('llama-3.3-70b')
    await expect(rows.first()).toContainText('Groq')
    expect(await layout(page)).toEqual(CLEAN)
    await rows.first().tap()
    await expect(page.getByTestId('m-sheet-model')).toHaveCount(0)
    await waitForModel(page, 'llama-3.3-70b')
    // Not a model of this phone: the settings button names the model and nothing that says it runs here. Prompt v2 has
    // no chip colour for "elsewhere" any more; data-m-place says LU Cloud or not (a provider costs no LU credits).
    await expect(page.getByTestId('m-chat-options')).toHaveAttribute('aria-label', 'Chat settings: llama-3.3-70b')

    await send(page, 'Hello provider')
    await answerDone(page, 'Hello from the provider.')
    const chat = seen.find((entry) => entry.path.endsWith('/chat/completions'))
    expect(chat).toBeTruthy()
    expect(chat?.auth).toBe(`Bearer ${KEY}`)
    expect(chat?.model).toBe('llama-3.3-70b')
    // The engine of the phone was not asked to answer this message.
    expect(await backend(page, (ctl) => ctl.bodies.length)).toBe(0)
    expect(await layout(page)).toEqual(CLEAN)
  })
})

test.describe('chat, a long history', () => {
  test('500 messages render a window of them and scroll without long frames', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = watchErrors(page)
    await boot(page)
    await page.getByTestId('m-page-back').tap()
    const filler = 'Tides rise and fall twice a day because the moon pulls the water. '
    await seedChats(page, [
      {
        id: 'huge',
        title: 'Five hundred',
        messages: Array.from({ length: 500 }, (_, i) =>
          i % 2
            ? { role: 'assistant' as const, content: `**Answer ${i + 1}.** ${filler.repeat(3)}\n\n- point one\n- point two\n\n\`\`\`js\nconst n = ${i}\n\`\`\`` }
            : { role: 'user' as const, content: `Question ${i + 1}. ${filler}` },
        ),
      },
    ])
    const started = Date.now()
    await openChat(page, 'huge')
    const thread = page.getByTestId('m-chat-thread')
    await expect(thread).toHaveAttribute('data-m-count', '500')
    await expect(answers(page).last()).toContainText('Answer 500.')
    const openMs = Date.now() - started
    // Only the end of the chat is in the page.
    expect(Number(await thread.getAttribute('data-m-rendered'))).toBe(60)
    expect(await page.getByTestId('m-chat-message').count()).toBe(60)

    const body = page.locator('[data-testid="m-chat-screen"] .m-body')
    // Scroll through what is rendered and measure the frames.
    const frames = await body.evaluate(async (el) => {
      const gaps: number[] = []
      let last = performance.now()
      const distance = el.scrollHeight - el.clientHeight
      const steps = 90
      for (let i = 0; i <= steps; i++) {
        el.scrollTop = distance - (distance * i) / steps
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        gaps.push(now - last)
        last = now
      }
      gaps.sort((a, b) => a - b)
      return { worst: gaps[gaps.length - 1], p95: gaps[Math.floor(gaps.length * 0.95)], median: gaps[Math.floor(gaps.length / 2)], distance }
    })
    // "Show earlier" adds the next window above and keeps the place.
    // By hand: only a scroll of the reader takes the view off the end of the chat.
    await body.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -500 }))
      el.scrollTo(0, 0)
    })
    const before = await page.getByTestId('m-chat-message').first().getAttribute('data-m-id')
    await page.getByTestId('m-chat-earlier').tap()
    await expect(thread).toHaveAttribute('data-m-rendered', '120')
    const top = await page.locator(`[data-testid="m-chat-message"][data-m-id="${before}"]`).evaluate((el) => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThan(-200)
    expect(top).toBeLessThan(400)

    const report = { messages: 500, rendered: 60, openMs, ...frames }
    console.log(`CHAT_SCROLL_500 ${JSON.stringify(report)}`)
    fs.mkdirSync(path.resolve(HERE, '../../test-results'), { recursive: true })
    fs.writeFileSync(path.resolve(HERE, '../../test-results/chat-scroll-500.json'), JSON.stringify(report, null, 2))
    expect(frames.p95).toBeLessThan(50)
    expect(openMs).toBeLessThan(5000)
    expect(errors()).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* Screenshots of every page and sheet of the strand.                  */
/* Run with LU_CHAT_SHOTS=1; the files go to mobile-docs/design/strang-shots/chat. */
/* ------------------------------------------------------------------ */

const SHOT_VARIANTS = [
  { id: '390-dark', width: 390, height: 844, theme: 'dark' as const, fontScale: undefined },
  { id: '390-light', width: 390, height: 844, theme: 'light' as const, fontScale: undefined },
  { id: '320-light-200', width: 320, height: 568, theme: 'light' as const, fontScale: 200 },
  { id: '844-landscape', width: 844, height: 390, theme: 'dark' as const, fontScale: undefined },
]

const RICH_ANSWER = [
  '## Tides',
  'The moon pulls the sea towards it. **Two bulges** form, one on each side of the planet.',
  '',
  '| Body | Pull on the sea |',
  '|---|---|',
  '| Moon | strong |',
  '| Sun | about half of that |',
  '',
  '```python',
  'def hours_to_next_high_tide(hours_since_last):',
  '    return 12.4 - hours_since_last % 12.4',
  '```',
  '',
  'Read more at [NOAA](https://oceanservice.noaa.gov/education/tutorial_tides/).',
].join('\n')

/**
 * Round 3: what the acceptance on the small iPhone found (iPhone SE, 375 by 667 points).
 *
 * The keyboard of a phone cannot be opened in this browser. What it does to the app can: the visible
 * height shrinks while a text field has the focus (the path of Android with adjustResize in
 * platform/keyboard.ts), and the shell then is as high as what is left above the keyboard.
 */
// Check on Android with 4 GB, F1: 360x640, the notice "LU was closed while answering" above the pages, the
// keyboard open and a text of three lines: the Send button stood 27 of 44 px under the keyboard.
test.describe('the text field stands above the keyboard, also under the notice after a return', () => {
  const THREE_LINES = 'This is a text that is long enough to fill three lines of the field on a narrow phone, yes.'
  const CUT: SeedChat = { id: 'cut', title: 'Trip plan', messages: [{ role: 'user', content: 'Plan my trip' }, { role: 'assistant', content: 'Day one:', finishReason: 'interrupted' }] }
  const OTHER: SeedChat = { id: 'other', title: 'Tides', messages: [{ role: 'user', content: 'Why are there tides?' }, { role: 'assistant', content: 'Because of the moon.' }] }

  for (const phone of [
    { name: '360x640', full: { width: 360, height: 640 }, keyboard: { width: 360, height: 317 } },
    { name: '320x568', full: { width: 320, height: 568 }, keyboard: { width: 320, height: 300 } },
  ]) {
    test.describe(phone.name, () => {
      test.use({ viewport: phone.full })

      test('with the keyboard open the notice folds away and Send, the field and the back button are all in view', async ({ page }) => {
        const errors = watchErrors(page)
        await boot(page)
        await page.getByTestId('m-page-back').tap()
        await seedChats(page, [CUT, OTHER])
        await openChat(page, 'other')
        // The notice is about another chat and stays above this one.
        const notice = page.getByTestId('m-app-resume')
        await expect(notice).toBeVisible()
        await expect(notice).toContainText('It belongs to another chat: Trip plan.')

        await page.getByTestId('m-chat-input').focus()
        await page.setViewportSize(phone.keyboard)
        await expect(page.locator('html')).toHaveClass(/m-kb-open/)
        await page.getByTestId('m-chat-input').fill(THREE_LINES)
        await expect(notice).toBeHidden()

        const visible = phone.keyboard.height
        const send = (await page.getByTestId('m-chat-send').boundingBox())!
        expect(send.y).toBeGreaterThanOrEqual(0)
        expect(send.y + send.height).toBeLessThanOrEqual(visible)
        expect(send.height).toBeGreaterThanOrEqual(44)
        const field = (await page.getByTestId('m-chat-input').boundingBox())!
        expect(field.y).toBeGreaterThanOrEqual(0)
        expect(field.y + field.height).toBeLessThanOrEqual(visible)
        const back = (await page.getByTestId('m-page-back').boundingBox())!
        expect(back.y).toBeGreaterThanOrEqual(0)
        // The tap arrives.
        await page.getByTestId('m-chat-send').tap()
        await expect(userMessages(page).last()).toContainText('long enough to fill three lines')

        // Without the keyboard the notice is back: it was not dismissed.
        await page.getByTestId('m-chat-input').blur()
        await page.setViewportSize(phone.full)
        await expect(page.locator('html')).not.toHaveClass(/m-kb-open/)
        await expect(notice).toBeVisible()
        expect(errors()).toEqual([])
      })
    })
  }
})

// Short check on the iPhone, package 8, B1: at the largest text a new chat with a model dropped its mark by
// rule, although on a tall phone there was room for it above and below the three lines. The mark follows
// the room now: it is there where the greeting with it fits into the free area, and gone where it does not.
test.describe('the mark of a new chat follows the room, not the text size', () => {
  const greeting = (page: Page) =>
    page.getByTestId('m-chat-empty').evaluate((el) => {
      const body = el.closest('.m-body')!
      const mark = el.querySelector<HTMLElement>(':scope > .m-empty-mark')
      const box = el.getBoundingClientRect()
      const room = body.getBoundingClientRect()
      return {
        mark: !!mark && mark.offsetHeight > 0,
        markHeight: mark?.offsetHeight ?? 0,
        above: box.top - room.top,
        below: room.bottom - box.bottom,
        scrolls: body.scrollHeight > body.clientHeight + 1,
        tight: document.documentElement.getAttribute('data-m-room'),
      }
    })

  for (const phone of [
    { name: '402x874 (iPhone 17)', width: 402, height: 874 },
    { name: '390x844', width: 390, height: 844 },
  ]) {
    test.describe(phone.name, () => {
      test.use({ viewport: { width: phone.width, height: phone.height } })
      test('at the largest text the mark is there, the greeting stands in the middle and nothing scrolls', async ({ page }) => {
        const errors = watchErrors(page)
        await boot(page, { fontScale: 200 })
        await waitForModel(page)
        await expect(page.getByTestId('m-chat-empty')).toBeVisible()
        await expect(page.getByTestId('m-chat-empty-model')).toBeVisible()
        await expect.poll(async () => (await greeting(page)).mark).toBe(true)
        const seen = await greeting(page)
        // The rule for little room holds here (that is the case of the report), and the mark stays all the same.
        expect(seen.tight).toBe('tight')
        expect(seen.markHeight).toBe(56)
        expect(seen.scrolls).toBe(false)
        expect(Math.abs(seen.above - seen.below)).toBeLessThanOrEqual(2)
        expect(await layout(page)).toEqual(CLEAN)
        expect(errors()).toEqual([])
      })
    })
  }

  for (const phone of [
    { name: '320x568', width: 320, height: 568 },
    { name: '844x390 on its side', width: 844, height: 390 },
  ]) {
    test.describe(phone.name, () => {
      test.use({ viewport: { width: phone.width, height: phone.height } })
      test('at the largest text the greeting has no room for the mark, and gives it away', async ({ page }) => {
        await boot(page, { fontScale: 200 })
        await waitForModel(page)
        await expect(page.getByTestId('m-chat-empty')).toBeVisible()
        // Give the measurement a moment to settle, then it must still say no.
        await page.waitForTimeout(300)
        const seen = await greeting(page)
        if (seen.mark) {
          // Where it does show, it fits: the greeting is not higher than its room.
          expect(seen.scrolls).toBe(false)
        } else {
          // And where it does not, it would not have fit: less room than the mark is high.
          expect(seen.above + seen.below).toBeLessThan(56 + 8)
        }
      })
    })
  }

  test('at the normal text the mark is there as before', async ({ page }) => {
    await boot(page)
    await waitForModel(page)
    expect((await greeting(page)).mark).toBe(true)
  })
})

// Short check on the iPhone, package 8, F1: the app was ended 0.2 to 0.4 s after Send. The question was in the
// chat and still in the field, because the draft was only written 400 ms after its last change.
test.describe('a sent question does not wait in the storage as a draft', () => {
  const drafts = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('lu-mobile-chat-drafts') ?? '{}') as Record<string, { text: string }>)

  test('new chat and a chat that is there: the draft is gone from the storage with the tap, not a moment later', async ({ page }) => {
    await boot(page, { delay: 400 })
    await waitForModel(page)
    await page.getByTestId('m-chat-input').fill('write a long story about a lighthouse')
    await expect.poll(async () => (await drafts(page)).new?.text).toBe('write a long story about a lighthouse')
    await page.getByTestId('m-chat-send').tap()
    // The page is swapped once the question is on the disk. From then on the storage holds no draft of it.
    await expect(userMessages(page)).toHaveCount(1)
    expect(await drafts(page)).toEqual({})
    await answerDone(page)

    await page.getByTestId('m-chat-input').fill('and one more question')
    await expect.poll(async () => Object.values(await drafts(page)).map((d) => d.text)).toEqual(['and one more question'])
    await page.getByTestId('m-chat-send').tap()
    await expect(userMessages(page)).toHaveCount(2)
    expect(await drafts(page)).toEqual({})
  })
})

// Check on Android with 4 GB, F8: 360x640 at the largest text and 14 chats. "New chat" stood behind the last
// row of the list, seven screens down. It is the main action of the page and stays fixed above the tab bar.
test.describe('the chat list at the largest text keeps "New chat" fixed', () => {
  const MANY: SeedChat[] = Array.from({ length: 14 }, (_, n) => ({
    id: `many-${n}`,
    title: n % 2 ? `What is the capital of country number ${n}? One word.` : `Chat ${n}`,
    ago: n + 1,
    messages: [{ role: 'user', content: 'A question' }, { role: 'assistant', content: 'An answer that is long enough to fill the preview line of the row.' }],
  }))

  for (const phone of [
    { name: '360x640', width: 360, height: 640 },
    { name: '320x568', width: 320, height: 568 },
  ]) {
    for (const fontScale of [100, 130, 200]) {
      test.describe(`${phone.name} at ${fontScale} percent`, () => {
        test.use({ viewport: { width: phone.width, height: phone.height } })

        test('the button is on the first screen with 14 chats, the list scrolls above it', async ({ page }) => {
          const errors = watchErrors(page)
          await boot(page, { fontScale })
          await page.getByTestId('m-page-back').tap()
          await seedChats(page, MANY)
          await expect(page.locator('[data-testid="m-chats-item"]')).toHaveCount(14)
          const screen = page.getByTestId('m-chats-screen')
          await expect(screen).toHaveAttribute('data-m-foot', 'fixed')
          const button = page.getByTestId('m-chats-new')
          await expect(button).toBeInViewport({ ratio: 1 })
          await expect(page.getByTestId('m-foot-jump')).toHaveCount(0)

          const measured = await screen.evaluate((el) => {
            const body = el.querySelector('.m-body')!
            const foot = el.querySelector(':scope > .m-foot')!.getBoundingClientRect()
            const nav = document.querySelector('[data-testid="m-nav"]')?.getBoundingClientRect()
            return { scrolls: body.scrollHeight > body.clientHeight + 40, footBottom: foot.bottom, footTop: foot.top, navTop: nav?.top ?? window.innerHeight, body: body.clientHeight }
          })
          expect(measured.scrolls).toBe(true)
          // Above the tab bar, not on it and not under it.
          expect(measured.footBottom).toBeLessThanOrEqual(measured.navTop + 1)
          // The list keeps room: more than the footer takes.
          expect(measured.body).toBeGreaterThan(measured.footBottom - measured.footTop)

          // Scrolled to the last chat, the button has not moved.
          const before = (await button.boundingBox())!
          await page.locator('[data-testid="m-chats-item"]').last().scrollIntoViewIfNeeded()
          await expect(page.locator('[data-testid="m-chats-item"]').last()).toBeInViewport()
          const after = (await button.boundingBox())!
          expect(after.y).toBe(before.y)
          expect(await layout(page)).toEqual(CLEAN)

          await button.tap()
          await expect(page.getByTestId('m-chat-empty')).toBeVisible()
          expect(errors()).toEqual([])
        })

        // Short check on Android, package 8: the same page without a chat. "New chat" stood inside the empty
        // state, which at the largest text is higher than the page: under the tab bar, 86 px of scrolling away.
        // Since round 57 it is the plus in the header of the empty list, and the page has no footer: the header
        // never scrolls, so the button is on the first screen at every text size.
        test('the button is on the first screen with no chats, without scrolling', async ({ page }) => {
          const errors = watchErrors(page)
          await boot(page, { fontScale })
          await page.getByTestId('m-page-back').tap()
          await expect(page.getByTestId('m-chats-empty')).toBeVisible()
          const screen = page.getByTestId('m-chats-screen')
          await expect(screen).toHaveAttribute('data-m-foot', 'none')
          const button = page.getByTestId('m-chats-empty-new')
          await expect(button).toHaveCount(1)
          await expect(button).toBeInViewport({ ratio: 1 })
          await expect(button).toHaveAccessibleName('New chat')
          const measured = await screen.evaluate((el) => {
            const body = el.querySelector('.m-body')!
            const target = document.querySelector('[data-testid="m-chats-empty-new"]')!.getBoundingClientRect()
            const nav = document.querySelector('[data-testid="m-nav"]')?.getBoundingClientRect()
            return { scrolledBy: body.scrollTop, buttonBottom: target.bottom, navTop: nav?.top ?? window.innerHeight, width: target.width, height: target.height }
          })
          expect(measured.scrolledBy).toBe(0)
          expect(measured.buttonBottom).toBeLessThanOrEqual(measured.navTop + 1)
          expect(measured.width).toBeGreaterThanOrEqual(44)
          expect(measured.height).toBeGreaterThanOrEqual(44)
          // The point of the button is the button: nothing lies on it.
          const hit = await button.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
          })
          expect(hit).toBe(true)
          expect(await layout(page)).toEqual(CLEAN)
          await button.tap()
          await expect(page.getByTestId('m-chat-empty')).toBeVisible()
          expect(errors()).toEqual([])
        })
      })
    }
  }
})

// Android review, N8: a phone on its side, a list of more than one screen. The footer is part of the scrolling
// content there (ui/screen-shape.ts), and "New chat" was reached only by scrolling to the end. The header carries
// the same action now, in view without a scroll.
test.describe('the chat list on its side has "New chat" in the header', () => {
  const MANY: SeedChat[] = Array.from({ length: 20 }, (_, n) => ({
    id: `side-${n}`,
    title: `Chat ${n}`,
    ago: n + 1,
    messages: [{ role: 'user', content: 'A question' }, { role: 'assistant', content: 'An answer that is long enough to fill the preview line of the row.' }],
  }))
  test.use({ viewport: { width: 640, height: 360 } })

  test('the button is in view at the top of a long list, without scrolling, and starts a chat', async ({ page }) => {
    const errors = watchErrors(page)
    await boot(page)
    await page.getByTestId('m-page-back').tap()
    await seedChats(page, MANY)
    await expect(page.locator('[data-testid="m-chats-item"]')).toHaveCount(20)
    await expect(page.getByTestId('m-chats-screen')).toHaveAttribute('data-m-foot', 'scrolls')
    const head = page.getByTestId('m-chats-new-head')
    await expect(head).toBeInViewport({ ratio: 1 })
    const box = (await head.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    await head.tap()
    await expect(page.getByTestId('m-chat-empty')).toBeVisible()
    expect(errors()).toEqual([])
  })
})

// Short check 7 on Android, F2: on its side at the largest text the first view of the chat list had header, tabs and
// search but not one chat row. The bars give way so that at least one whole row is in view without a scroll.
for (const lage of [
  { name: '640x360', size: { width: 640, height: 360 } },
  { name: '568x320', size: { width: 568, height: 320 } },
]) {
  for (const fontScale of [130, 200]) {
    test.describe(`the chat list on its side at text ${fontScale / 100}, ${lage.name}`, () => {
      test.use({ viewport: lage.size })

      test('the first view shows at least one whole chat row that nothing lies on', async ({ page }) => {
        await boot(page, { fontScale })
        await page.getByTestId('m-page-back').tap()
        await seedChats(page, Array.from({ length: 20 }, (_, n) => ({
          id: `f2-${n}`,
          title: `Chat ${n}`,
          ago: n + 1,
          messages: [{ role: 'user', content: 'A question' }, { role: 'assistant', content: 'An answer that is long enough to fill the preview line of the row.' }],
        })))
        await expect(page.locator('[data-testid="m-chats-item"]')).toHaveCount(20)
        await page.waitForTimeout(400)
        const seen = await page.evaluate(() => {
          const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="m-chats-item"]')]
          return rows.filter((row) => {
            const r = row.getBoundingClientRect()
            if (r.top < 0 || r.bottom > innerHeight || r.height === 0) return false
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return !!hit && row.contains(hit)
          }).length
        })
        expect(seen, 'whole rows in the first view').toBeGreaterThanOrEqual(1)
        // New chat is still reached in the same view (N8).
        await expect(page.getByTestId('m-chats-new-head')).toBeInViewport({ ratio: 1 })
      })
    })
  }
}

// Check Android package 11, F2 rest: 320x568 on its side at the text zoom of Android 2.0 still showed no chat row. The
// guard above enlarges the root through the address; Android enlarges the text of the WebView (text-size-adjust), and
// there tabs and search no longer fit in one line. Measured here the way Android does it.
// 520x272 is what that phone gave the WebView on its side (bars of the system on two edges): there the first row began
// at 243 of 272 px.
// Check Android package 15, H3: on the phone the search came out wider than the bar (461 to 439 px; the WebView there
// draws the field wider than Chromium does). 440x272 gives the same in Chromium: a bar narrower than the field.
for (const vp of [{ width: 568, height: 320 }, { width: 520, height: 272 }, { width: 440, height: 272 }]) for (const zoom of [1.3, 2]) {
  test.describe(`the chat list on its side at the text zoom of Android ${zoom}, ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp })

    test('the first view shows at least one whole chat row, and tabs and search share a line', async ({ page }) => {
      await boot(page, { os: 'android' })
      await page.getByTestId('m-page-back').tap()
      await seedChats(page, Array.from({ length: 20 }, (_, n) => ({
        id: `f2z-${n}`,
        title: `Chat ${n}`,
        ago: n + 1,
        messages: [{ role: 'user', content: 'A question' }, { role: 'assistant', content: 'An answer that is long enough to fill the preview line of the row.' }],
      })))
      await expect(page.locator('[data-testid="m-chats-item"]')).toHaveCount(20)
      await androidTextZoom(page, zoom)
      await page.waitForTimeout(400)
      const seen = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="m-chats-item"]')]
        const tools = document.querySelector<HTMLElement>('.m-chat-tools')
        const parts = tools ? [...tools.children].map((c) => c.getBoundingClientRect()) : []
        const bar = tools?.getBoundingClientRect()
        return {
          rows: rows.filter((row) => {
            const r = row.getBoundingClientRect()
            if (r.top < 0 || r.bottom > innerHeight || r.height === 0) return false
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return !!hit && row.contains(hit)
          }).length,
          // One line: every part lies beside the first, none under it.
          oneLine: parts.length >= 2 && parts.every((p) => p.top < parts[0].bottom && p.bottom > parts[0].top),
          // The bar stays inside the window; what does not fit is reached by scrolling it sideways.
          wide: !!bar && bar.right <= innerWidth + 0.5 && (tools!.scrollWidth <= tools!.clientWidth + 1 || getComputedStyle(tools!).overflowX === 'auto'),
        }
      })
      expect(seen.rows, 'whole rows in the first view').toBeGreaterThanOrEqual(1)
      expect(seen.oneLine, 'tabs and search in one line').toBe(true)
      expect(seen.wide, 'nothing sticks out sideways').toBe(true)
      await expect(page.getByTestId('m-chats-new-head')).toBeInViewport({ ratio: 1 })
      // The search is reached in that line: scrolled to its end, the field is whole in view.
      await page.locator('.m-chat-tools').evaluate((el) => { el.scrollLeft = el.scrollWidth })
      await expect(page.getByTestId('m-chats-search')).toBeInViewport({ ratio: 1 })
      // Check Android package 15, H3: in the window is not enough. The field was wider than the bar, and scrolled to the
      // end its first 58 px stayed cut off at the left edge of the bar, next to the navigation ("rch chats").
      await page.waitForTimeout(300)
      const field = await page.getByTestId('m-chats-search').evaluate((el) => {
        const bar = el.closest('.m-chat-tools')!.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        const rail = document.querySelector('[data-testid="m-nav"]')?.getBoundingClientRect()
        const at = (x: number) => { const hit = document.elementFromPoint(x, r.top + r.height / 2); return !!hit && (el.contains(hit) || hit.contains(el)) }
        return { left: r.left, right: r.right, barLeft: bar.left, barRight: bar.right, clearOfRail: !rail || rail.right <= r.left + 0.5 || rail.left >= r.right - 0.5 || rail.bottom <= r.top || rail.top >= r.bottom, startHit: at(r.left + 6), endHit: at(r.right - 6) }
      })
      expect(field.left, 'the search starts inside the bar').toBeGreaterThanOrEqual(field.barLeft - 0.5)
      expect(field.right, 'the search ends inside the bar').toBeLessThanOrEqual(field.barRight + 0.5)
      expect(field.clearOfRail, 'the search is clear of the navigation').toBe(true)
      expect(field.startHit && field.endHit, 'both ends of the search are reached').toBe(true)
    })
  })
}

/*
 * Acceptance row 5.8 on Android, finding F13 (2) of the check with 8 GB: at text size 2.0 "the ring before
 * Loading Qwen3 1.7B is cut on the left". Round 12 looked for it with the font switch of the address and found
 * the ring whole: that switch makes the root larger, which is not what an Android WebView does. Here the text is
 * enlarged the way Android does it (support.ts androidTextZoom). Measured that way the ring is still inside
 * everything that could cut it. What the picture of the report shows is the ring itself: its track was a line of
 * 2 px in 8 percent black, on a ring that grows from 18 to 30 px with the text, so a still picture showed only the
 * quarter that turns, an open arc. The track is now drawn so that it is seen, and the line grows with the ring
 * (styles/components.css .m-ring).
 */
for (const size of [
  { name: '360x640', width: 360, height: 640 },
  { name: '320x568', width: 320, height: 568 },
] as const) {
  test.describe(`the loading line at the text zoom of Android, 200 percent, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    for (const queued of [false, true]) {
      test(`the ring before "Loading" is a whole ring${queued ? ', also with a message waiting' : ''} (row 5.8, F13)`, async ({ page }) => {
        const errors = watchErrors(page)
        await boot(page, { loaded: null, startDelay: 8000, os: 'android' })
        await androidTextZoom(page, 2)
        await waitForModel(page)
        const line = page.getByTestId('m-chat-loading-model')
        await expect(line).toContainText(`Loading ${SMALL}`)
        if (queued) {
          await send(page, 'What is the cargo code of the ship?')
          await expect(line).toHaveAttribute('data-m-queued', 'yes')
        }
        const ring = await line.evaluate((el) => {
          const ringEl = el.querySelector('.m-ring') as HTMLElement
          const style = getComputedStyle(ringEl)
          const alpha = (color: string) => {
            const parts = color.match(/[\d.]+/g)?.map(Number) ?? []
            // "rgb(r g b)" has no fourth number and is opaque; "color(srgb r g b / a)" and "rgba(...)" carry it last.
            return parts.length >= 4 ? parts[parts.length - 1] : 1
          }
          return {
            width: parseFloat(style.width),
            height: parseFloat(style.height),
            line: parseFloat(style.borderLeftWidth),
            track: alpha(style.borderLeftColor),
            head: alpha(style.borderTopColor),
            textSize: parseFloat(getComputedStyle(el).fontSize),
            left: ringEl.offsetLeft,
          }
        })
        // The text really is twice as large, and the ring grew with it up to its cap.
        expect(ring.textSize).toBeGreaterThan(24)
        expect(ring.width).toBe(30)
        expect(ring.height).toBe(30)
        // Nothing cuts it, on any side.
        expect(await clippedSymbols(page)).toEqual([])
        // A ring, not an arc: the track is there to be seen and the line is not thinner than a tenth of the ring.
        expect(ring.head).toBe(1)
        expect(ring.track).toBeGreaterThanOrEqual(0.2)
        expect(ring.line / ring.width).toBeGreaterThanOrEqual(0.1)
        expect(errors()).toEqual([])
      })
    }
  })
}

test.describe('chat, round 3 on the small iPhone', () => {
  const SE = { width: 375, height: 667 }
  /** What stays visible above the keyboard of the iPhone SE, upright and on its side. */
  const SE_KEYBOARD = { width: 375, height: 407 }
  const SE_SIDE = { width: 667, height: 375 }
  const SE_SIDE_KEYBOARD = { width: 667, height: 212 }

  const TALK: SeedChat = {
    id: 'talk',
    title: 'Say hello in five words.',
    messages: Array.from({ length: 8 }, (_, i) => (i % 2 ? { role: 'assistant' as const, content: `Answer ${i}. Hello there, how are you today?` } : { role: 'user' as const, content: `Question ${i}. Say hello in five words.` })),
  }

  async function openTalk(page: Page, options: BootOptions = {}): Promise<void> {
    await boot(page, options)
    await page.getByTestId('m-page-back').tap()
    await seedChats(page, [TALK])
    await openChat(page, 'talk')
    await arrived(page)
  }

  /** The page has slid in: what is measured from here on stands still. */
  const arrived = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)))

  /** Focus the text field and take the height of the keyboard away. */
  async function openKeyboard(page: Page, left: { width: number; height: number }): Promise<void> {
    await page.getByTestId('m-chat-input').focus()
    await page.setViewportSize(left)
    await expect(page.locator('html')).toHaveClass(/m-kb-open/)
  }

  /** LU_R3_SHOTS=<folder> keeps a picture of each state, to look at what the numbers say. */
  const picture = async (page: Page, name: string) => {
    if (process.env.LU_R3_SHOTS) await page.screenshot({ path: path.join(process.env.LU_R3_SHOTS, `${name}.png`) })
  }
  const boxOf = async (page: Page, testid: string) => (await page.getByTestId(testid).boundingBox())!
  const transcriptHeight = (page: Page) => page.locator('[data-testid="m-chat-screen"] .m-body').evaluate((el) => el.getBoundingClientRect().height)

  test.describe('on its side', () => {
    test.use({ viewport: SE_SIDE })
    test('M5: with the keyboard open Send is above the keyboard and sends', async ({ page }) => {
      const errors = watchErrors(page)
      await openTalk(page)
      await openKeyboard(page, SE_SIDE_KEYBOARD)
      await expect(page.locator('html')).toHaveAttribute('data-m-room', 'cramped')
      await page.getByTestId('m-chat-input').fill('quer')
      const sendBox = await boxOf(page, 'm-chat-send')
      expect(sendBox.y).toBeGreaterThanOrEqual(0)
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(SE_SIDE_KEYBOARD.height)
      expect(sendBox.width).toBeGreaterThanOrEqual(44)
      expect(sendBox.height).toBeGreaterThanOrEqual(44)
      // The field is still there and wide enough to type in, and a strip of the transcript too.
      const field = await boxOf(page, 'm-chat-input')
      expect(field.y + field.height).toBeLessThanOrEqual(SE_SIDE_KEYBOARD.height)
      expect(field.width).toBeGreaterThan(300)
      expect(await transcriptHeight(page)).toBeGreaterThan(40)
      await picture(page, 'm5-side-keyboard')
      await page.getByTestId('m-chat-send').tap()
      await expect(userMessages(page).last()).toContainText('quer')
      // Without the keyboard everything is back.
      await page.getByTestId('m-chat-input').blur()
      await page.setViewportSize(SE_SIDE)
      await expect(page.locator('html')).not.toHaveClass(/m-kb-open/)
      await expect(page.getByTestId('m-chat-attach')).toBeVisible()
      await expect(page.getByTestId('m-chat-options')).toBeVisible()
      expect(errors()).toEqual([])
    })
  })

  test.describe('upright', () => {
    test.use({ viewport: SE })

    test('M6: with the keyboard open the chips fold away and the transcript keeps its room', async ({ page }) => {
      await openTalk(page)
      // Prompt v2: nothing warns here, so the status row above the field is empty; the settings button carries the state.
      await expect(page.getByTestId('m-chat-options')).toBeVisible()
      const before = await transcriptHeight(page)
      await openKeyboard(page, SE_KEYBOARD)
      await expect(page.locator('html')).toHaveAttribute('data-m-room', 'tight')
      await expect(page.locator('.m-composer-status--chips')).toBeHidden()
      // More than a third of what is visible is transcript (it was two or three lines).
      expect(await transcriptHeight(page)).toBeGreaterThan(SE_KEYBOARD.height * 0.36)
      expect(before).toBeGreaterThan(SE.height * 0.5)
      // The view stays at the end of the chat: the last answer is what the reader sees, not "Jump to latest".
      await expect(page.getByTestId('m-chat-jump')).toHaveCount(0)
      await expect(answers(page).last()).toBeInViewport()
      await picture(page, 'm6-upright-keyboard')
      const sendBox = await boxOf(page, 'm-chat-mic')
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(SE_KEYBOARD.height)
      expect(await layout(page)).toEqual(CLEAN)
    })


    test('M6: editing a message with the keyboard open leaves transcript too', async ({ page }) => {
      await openTalk(page)
      await page.evaluate(async () => {
        const { useDraftStore } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/chat/parts/logic/drafts.ts`)
        useDraftStore.getState().beginEdit('talk', 'talk-m6', 'Question 6. Say hello in five words. And then say it again in six words, slowly.')
      })
      await expect(page.getByTestId('m-chat-editing')).toBeVisible()
      await openKeyboard(page, SE_KEYBOARD)
      expect(await transcriptHeight(page)).toBeGreaterThan(SE_KEYBOARD.height * 0.25)
      await picture(page, 'm6-editing-keyboard')
      const sendBox = await boxOf(page, 'm-chat-send')
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(SE_KEYBOARD.height)
    })

    test('M6: at the largest text the composer takes a part of the height, with and without the keyboard', async ({ page }) => {
      await openTalk(page, { fontScale: 200 })
      expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeCloseTo(32, 0)
      await expect(page.locator('html')).toHaveAttribute('data-m-room', 'tight')
      // Without the keyboard: the dock is at most about half, the transcript is there.
      const dock = (await page.locator('.m-chat-dock').boundingBox())!
      expect(dock.height).toBeLessThanOrEqual(SE.height * 0.53)
      expect(await transcriptHeight(page)).toBeGreaterThan(SE.height * 0.15)
      await picture(page, 'm6-largest-text')
      // With the keyboard: one row, Send in reach, and still some transcript.
      await openKeyboard(page, SE_KEYBOARD)
      await expect(page.locator('html')).toHaveAttribute('data-m-room', 'cramped')
      await page.getByTestId('m-chat-input').fill('quer')
      const sendBox = await boxOf(page, 'm-chat-send')
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(SE_KEYBOARD.height)
      expect(sendBox.y).toBeGreaterThanOrEqual(0)
      expect(await transcriptHeight(page)).toBeGreaterThan(SE_KEYBOARD.height * 0.2)
      await picture(page, 'm6-largest-text-keyboard')
    })

    test('M7: the note field of the report sheet comes into view when it gets the focus', async ({ page }) => {
      await openTalk(page)
      await page.getByTestId('m-chat-answer-more').last().tap()
      await page.getByTestId('m-chat-message-report').tap()
      await expect(page.getByTestId('m-report-send')).toBeVisible()
      const reason = page.locator('[data-testid^="m-report-reason-"]').first()
      if (await reason.count()) await reason.tap()
      const note = page.getByTestId('m-report-note')
      await note.focus()
      await page.setViewportSize(SE_KEYBOARD)
      await expect(page.locator('html')).toHaveClass(/m-kb-open/)
      // The whole field lies inside the scrolling body of the sheet, above the button and the keyboard.
      await expect
        .poll(async () =>
          note.evaluate((el) => {
            const box = el.getBoundingClientRect()
            const view = el.closest('.m-sheet-body')!.getBoundingClientRect()
            return box.top >= view.top - 1 && box.bottom <= view.bottom + 1 && box.bottom <= window.innerHeight
          }),
        )
        .toBe(true)
      await note.fill('abc')
      await expect(page.getByTestId('m-report-send')).toBeInViewport()
      await picture(page, 'm7-report-note')
    })

    test('M1: while the first model downloads the chat says so, with progress and the way to it', async ({ page }) => {
      await boot(page, { models: [] })
      await expect(page.getByTestId('m-chat-empty')).toContainText('No model yet')
      await page.evaluate(async () => {
        const { useDownloadStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/downloadStore.ts`)
        const file = 'SmolLM2-360M-Instruct-Q4_K_M.gguf'
        const row = { filename: file, progress: 50_000_000, total: 200_000_000, speed: 1_000_000, status: 'downloading' }
        // As the app writes a download it started: in `ownRows` as well. The watch of the models strand asks the
        // native side for its rows once the chat shows this state, and every answer rebuilds `downloads` from
        // `ownRows` plus what the native side reports (stores/downloadStore.ts). A row in `downloads` alone was
        // gone with the first answer: under load that fell between two steps here and "No model yet" was back.
        useDownloadStore.setState({ downloads: { [file]: row }, ownRows: { [file]: row } })
      })
      const empty = page.getByTestId('m-chat-empty')
      await expect(empty).toContainText('SmolLM2 360M is downloading')
      // "Loading" is the word for a model that is taken into memory, not for one on its way (round 9, N13).
      await expect(empty).not.toContainText('Loading SmolLM2 360M')
      await expect(empty).not.toContainText('No model yet')
      await expect(page.getByTestId('m-chat-incoming')).toHaveAttribute('data-m-state', 'downloading')
      await expect(page.getByTestId('m-chat-incoming-progress')).toContainText('25%')
      await picture(page, 'm1-loading-model')
      expect(await layout(page)).toEqual(CLEAN)
      await page.getByTestId('m-chat-show-downloads').tap()
      await expect(page.getByTestId('m-models-downloads-screen')).toBeVisible()
    })

    test('M3: a photo without a model that reads images: the sheet says where such models are', async ({ page }) => {
      await boot(page, { models: [{ name: SMALL, size: 398 * 1024 * 1024 }] })
      await waitForModel(page)
      await page.getByTestId('m-chat-attach').tap()
      await expect(page.getByTestId('m-chat-attach-library')).toContainText('The chosen model cannot read images')
      await page.getByTestId('m-chat-attach-library').tap()
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      const way = page.getByTestId('m-chat-model-vision-way')
      await expect(way).toContainText('The chosen model cannot read images')
      await expect(way).toContainText('On device models read text only. LU Cloud models can read images.')
      // It opens where such models are, not on an empty list.
      await expect(page.getByTestId('m-chat-model-list')).toHaveAttribute('data-m-segment', 'cloud')
      await expect(page.getByTestId('m-sheet-model')).not.toContainText('No model matches')
      await picture(page, 'm3-vision-way')
      // On the list of this phone the line says why it is empty and the button leads on.
      await page.getByTestId('m-chat-model-segment-local').tap()
      await expect(page.getByTestId('m-chat-model-local-vision-none')).toContainText('No model on this phone reads images.')
      await page.getByTestId('m-chat-model-vision-cloud').tap()
      await expect(page.getByTestId('m-chat-model-list')).toHaveAttribute('data-m-segment', 'cloud')
      expect(await layout(page)).toEqual(CLEAN)
    })

    // Check on the iPhone, round 22, N2: "File" opened a menu of iOS first ("Photo Library", "Choose Files"). On an iPhone
    // the row asks the Files app through the native layer. Played here: the picker, and reading the picked file back.
    test('N2: "File" on an iPhone asks the Files app through the native layer, and the page puts no file field in front of it', async ({ page }) => {
      await boot(page, {
        native: () => {
          /* eslint-disable @typescript-eslint/no-explicit-any -- the stub stands in for the untyped native bridge */
          const w = window as any
          Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', configurable: true })
          Object.defineProperty(navigator, 'platform', { get: () => 'iPhone', configurable: true })
          const text = 'Remember the tram ticket.'
          const record = (w.__FILES_E2E__ = { picks: [] as unknown[], reads: [] as unknown[], deleted: [] as string[], fields: 0, answer: 'file' as 'file' | 'closed' })
          const inner = w.__TAURI_INTERNALS__.invoke
          w.__TAURI_INTERNALS__.invoke = (cmd: string, args: any) => {
            if (cmd === 'plugin:lu-native|pick_documents') {
              record.picks.push(args)
              if (record.answer === 'closed') return Promise.resolve({ cancelled: true })
              return Promise.resolve({ cancelled: false, files: [{ path: '/cache/lu-native-tmp/abc/file.ts', name: 'notes.ts', bytes: text.length, mime: '' }], more: false })
            }
            if (cmd === 'plugin:lu-native|read_temp_file') {
              record.reads.push(args)
              return Promise.resolve({ dataBase64: btoa(text), bytes: text.length, totalBytes: text.length, done: true })
            }
            if (cmd === 'plugin:lu-native|delete_temp_file') {
              record.deleted.push(String(args?.path))
              return Promise.resolve(true)
            }
            return inner(cmd, args)
          }
          // A file field that is clicked would be the menu of iOS again.
          const click = HTMLInputElement.prototype.click
          HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
            if (this.type === 'file') record.fields += 1
            return click.call(this)
          }
          /* eslint-enable @typescript-eslint/no-explicit-any */
        },
      })
      await waitForModel(page)
      const files = () => page.evaluate(() => (window as unknown as { __FILES_E2E__: { picks: Array<{ maxFiles?: number }>; reads: Array<{ path?: string }>; deleted: string[]; fields: number } }).__FILES_E2E__)
      const chip = page.getByTestId('m-chat-attachment')

      // Closing the picker: nothing is attached, nothing is said, the sheet stays.
      await page.evaluate(() => { (window as unknown as { __FILES_E2E__: { answer: string } }).__FILES_E2E__.answer = 'closed' })
      await page.getByTestId('m-chat-attach').tap()
      await page.getByTestId('m-chat-attach-file').tap()
      await expect.poll(async () => (await files()).picks.length).toBe(1)
      await expect(page.getByTestId('m-chat-attach-file')).not.toContainText('Preparing')
      await expect(page.locator('[data-testid^="m-toast-"]')).toHaveCount(0)
      await expect(chip).toHaveCount(0)

      // A file, a TypeScript one: the file field of iOS took ".ts" for a video.
      await page.evaluate(() => { (window as unknown as { __FILES_E2E__: { answer: string } }).__FILES_E2E__.answer = 'file' })
      await page.getByTestId('m-chat-attach-file').tap()
      await expect(chip).toHaveCount(1)
      await expect(chip).toContainText('notes.ts')
      const record = await files()
      expect(record.picks).toHaveLength(2)
      expect(record.picks[1].maxFiles).toBe(4)
      expect(record.reads[0].path).toBe('/cache/lu-native-tmp/abc/file.ts')
      expect(record.deleted).toEqual(['/cache/lu-native-tmp/abc/file.ts'])
      expect(record.fields).toBe(0)
      await page.getByTestId('m-chat-attachment-open').tap()
      await expect(page.getByTestId('m-chat-file-text')).toHaveText('Remember the tram ticket.')
    })

    // Check on the iPhone, round 22, N11: without any model the sheet "Model" said "The chosen model cannot read images".
    test('N11: a photo without any model: neither the row nor the sheet "Model" speaks of a chosen model', async ({ page }) => {
      await boot(page, { models: [] })
      await expect(page.getByTestId('m-chat-empty')).toContainText('No model yet')
      await page.getByTestId('m-chat-attach').tap()
      for (const row of ['m-chat-attach-photo', 'm-chat-attach-library']) {
        await expect(page.getByTestId(row)).toContainText('Get a model first. Tap to see the ones that read images.')
        await expect(page.getByTestId(row)).not.toContainText('chosen model')
      }
      await page.getByTestId('m-chat-attach-photo').tap()
      await expect(page.getByTestId('m-sheet-model')).toBeVisible()
      const way = page.getByTestId('m-chat-model-vision-way')
      await expect(way).toContainText('No model on this phone yet')
      await expect(way.locator('[data-m-vision-ask]')).toHaveAttribute('data-m-vision-ask', 'none-installed')
      await expect(page.getByTestId('m-sheet-model')).not.toContainText('The chosen model cannot read images')
      expect(await layout(page)).toEqual(CLEAN)
    })

    test('N11: models are there and none is chosen, and one is chosen that is gone: each has its own sentence', async ({ page }) => {
      await boot(page, { models: [{ name: SMALL, size: 398 * 1024 * 1024 }] })
      await waitForModel(page)
      const choose = (name: string | null) =>
        page.evaluate(async (model) => {
          const { useModelStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/modelStore.ts`)
          useModelStore.setState({ activeModel: model })
        }, name)
      const ask = async (row: string, title: string, state: string) => {
        await page.getByTestId('m-chat-attach').tap()
        await expect(page.getByTestId('m-chat-attach-library')).toContainText(row)
        await page.getByTestId('m-chat-attach-library').tap()
        const way = page.getByTestId('m-chat-model-vision-way')
        await expect(way).toContainText(title)
        await expect(way.locator('[data-m-vision-ask]')).toHaveAttribute('data-m-vision-ask', state)
        await expect(way).not.toContainText('cannot read images')
        await page.getByTestId('m-sheet-close').tap()
        await expect(page.getByTestId('m-sheet-model')).toHaveCount(0)
      }
      await choose(null)
      await ask('Choose a model first. Tap to see the ones that read images.', 'No model is chosen', 'no-model')
      // A model that was chosen and is no longer in the list. Its name sounds like one that reads images: it promises nothing.
      await choose('openai::gemma-3-4b-vision-gone')
      await ask('The chosen model is not available right now. Tap to choose one that reads images.', 'The chosen model is not available right now', 'gone')
    })

    test('M3: "Get more models" opens the catalogue, whatever the Models tab showed last', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.evaluate(async () => {
        const { useModelsView } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/screens/models/parts/view.ts`)
        useModelsView.getState().setSegment('installed')
      })
      await openModelSheet(page)
      await page.getByTestId('m-chat-model-get-more').tap()
      await expect(page.getByTestId('m-models-screen')).toBeVisible()
      await expect(page.getByTestId('m-models-segment-new')).toHaveAttribute('aria-checked', 'true')
    })

    test('M4: "Use personas" on in the settings holds in a new chat, down to the request', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.evaluate(async () => {
        const { useSettingsStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/settingsStore.ts`)
        useSettingsStore.getState().updateSettings({ personasEnabled: true })
        useSettingsStore.getState().setActivePersona('coder')
      })
      await send(page, 'Who are you?')
      await answerDone(page)
      await expect(page.getByTestId('m-chat-options')).toContainText('Code Expert')
      const bodies = await backend(page, (ctl) => ctl.bodies as string[])
      expect(bodies.at(-1)).toContain('You are an expert software engineer')
      // The options say the same, with the name of the persona.
      await page.getByTestId('m-chat-options').tap()
      await expect(page.getByTestId('m-options-persona')).toContainText('Code Expert')
      await page.getByTestId('m-options-persona').tap()
      await expect(page.getByTestId('m-options-persona-switch')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('m-options-persona-switch')).toContainText('On: this chat answers as Code Expert.')
      // Off for this chat: the chip goes and the next request carries no persona.
      await page.getByTestId('m-options-persona-switch').tap()
      await expect(page.getByTestId('m-options-persona-switch')).toContainText('Off: this chat talks to the plain model.')
      await page.getByTestId('m-sheet-close').tap()
      await expect(page.getByTestId('m-chat-options')).not.toContainText('Code Expert')
      await send(page, 'And now?')
      await expect(answers(page)).toHaveCount(2)
      await answerDone(page)
      expect((await backend(page, (ctl) => ctl.bodies as string[])).at(-1)).not.toContain('You are an expert software engineer')
    })

    test('M4: personas off in the settings: a new chat has no persona', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await send(page, 'Who are you?')
      await answerDone(page)
      await expect(page.getByTestId('m-chat-options')).not.toContainText('Code Expert')
      expect((await backend(page, (ctl) => ctl.bodies as string[])).at(-1)).not.toContain('You are an expert software engineer')
    })

    test('Android M3: picking a persona while personas are off turns them on, here and for this chat', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await send(page, 'Who are you?')
      await answerDone(page)
      expect((await backend(page, (ctl) => ctl.bodies as string[])).at(-1)).not.toContain('You are an expert software engineer')
      await page.getByTestId('m-chat-options').tap()
      await page.getByTestId('m-options-persona').tap()
      // The switch is not locked from another page: it works where it stands.
      const toggle = page.getByTestId('m-options-persona-switch')
      await expect(toggle).toBeEnabled()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await page.getByTestId('m-options-persona-coder').tap()
      await expect(page.getByTestId('m-options-persona-coder')).toHaveAttribute('aria-checked', 'true')
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await expect(toggle).toContainText('On: this chat answers as Code Expert.')
      await page.getByTestId('m-sheet-close').tap()
      await expect(page.getByTestId('m-chat-options')).toContainText('Code Expert')
      await send(page, 'And now?')
      await expect(answers(page)).toHaveCount(2)
      await answerDone(page)
      expect((await backend(page, (ctl) => ctl.bodies as string[])).at(-1)).toContain('You are an expert software engineer')
      // One truth: the settings show the same switch as on.
      const globalOn = await page.evaluate(async () => {
        const { useSettingsStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/settingsStore.ts`)
        return useSettingsStore.getState().settings.personasEnabled
      })
      expect(globalOn).toBe(true)
    })

    test('Android M6: a new chat takes a document before its first message', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.getByTestId('m-chat-input').fill('What does the paper say?')
      await page.getByTestId('m-chat-attach').tap()
      const row = page.getByTestId('m-chat-attach-documents')
      await expect(row).toContainText('Add a document first, then ask about it.')
      await row.tap()
      // The chat exists from here on, so the documents page is the real one with its add button.
      await expect(page.getByTestId('m-chat-documents-screen')).toBeVisible()
      await expect(page.getByTestId('m-documents-new')).toHaveCount(0)
      await expect(page.getByTestId('m-documents-add')).toBeEnabled()
      await page.getByTestId('m-chat-documents-screen').getByTestId('m-page-back').tap()
      // Back in the same chat, with what was typed still waiting and nothing sent.
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      await expect(page.getByTestId('m-chat-input')).toHaveValue('What does the paper say?')
      await expect(answers(page)).toHaveCount(0)
      const chats = await page.evaluate(async () => {
        const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
        return useChatStore.getState().conversations.length
      })
      expect(chats).toBe(1)
      await page.getByTestId('m-chat-send').tap()
      await answerDone(page)
      await expect(answers(page)).toHaveCount(1)
    })

    // Small iPhone, K10 (acceptance line 5.9): at the largest text, with a notice above the chat, the greeting of an
    // empty chat lay under the composer: "Ask LU anything" half cut, the line under it not to be seen.
    test('K10: the largest text and a notice above an empty chat, the greeting is whole and above the composer', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page, { fontScale: 200 })
      await waitForModel(page)
      await page.evaluate(async () => {
        const { useRAGStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/ragStore.ts`)
        useRAGStore.getState().setRetrievalError('x')
      })
      await expect(page.getByTestId('m-chat-retrieval-error')).toBeVisible()
      const empty = page.getByTestId('m-chat-empty')
      await expect(empty).toBeVisible()
      // Measured as drawn: the page answers the notice by measuring the greeting in the frame before it is painted
      // (screens/chat/parts/mark-room.ts, a ResizeObserver hides the mark). Measured right after React has put the
      // notice in, before that frame (the browser under load, the whole suite running), the mark still stood and
      // the greeting reached 32 px under the composer, a state no one sees (rounds 31 and 35, red once in a whole
      // run). Two frames: the first is drawn with the notice, the second starts after it.
      const box = await empty.evaluate(async (el) => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const dock = document.querySelector('.m-chat-dock')!.getBoundingClientRect()
        const banners = document.querySelector('.m-banners')?.getBoundingClientRect()
        const parts = [...el.querySelectorAll('.m-empty-title, .m-empty-title ~ *')].filter((n) => (n as HTMLElement).offsetHeight > 0).map((n) => n.getBoundingClientRect())
        return { top: Math.min(...parts.map((r) => r.top)), bottom: Math.max(...parts.map((r) => r.bottom)), dockTop: dock.top, bannersBottom: banners?.bottom ?? 0, n: parts.length }
      })
      expect(box.n).toBeGreaterThan(1)
      expect(box.top).toBeGreaterThanOrEqual(box.bannersBottom - 1)
      expect(box.bottom).toBeLessThanOrEqual(box.dockTop + 1)
      expect(errors()).toEqual([])
    })

    test('Android M9: "Answering" ends with the answer, and learning from it yields to the next question', async ({ page }) => {
      const LONG = 'Paris is the capital of France. It lies on the Seine, has about two million people and is known for the Louvre and the tower.'
      await boot(page, { reply: LONG, chunks: 6, delay: 5 })
      await waitForModel(page)
      const learning = () =>
        page.evaluate(async () => {
          const { useGenerationStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/generationStore.ts`)
          const state = useGenerationStore.getState()
          return [...Object.keys(state.runs), ...Object.keys(state.aborters)].filter((id) => id.endsWith('::memory-extraction')).length
        })
      // Learning looks at every third turn, and on a phone only at a turn in which the user says something about
      // themselves (round 12, F12): a bare question is not learned from.
      for (const [index, question] of ['I live in Paris. One?', 'I live in Paris. Two?'].entries()) {
        await send(page, question)
        await expect(answers(page)).toHaveCount(index + 1)
        await answerDone(page, LONG)
      }
      // The third answer comes as fast as the two before. The request after it, the silent call that learns from
      // the turn, is slow and takes many seconds. Said to the engine before the question is sent, by the number
      // of the request: slowing it down from here after the send hit the third answer itself whenever its
      // request had not left yet (24 seconds for an answer the test gives 15), and came too late for the silent
      // call whenever the answer was already through.
      const before = (await backend(page, (ctl) => ctl.bodies as string[])).length
      await backend(page, (ctl) => { ctl.slowFrom = { request: ctl.bodies.length + 2, chunks: 60, delay: 400 } })
      await send(page, 'I live in Paris. Three?')
      await expect(answers(page)).toHaveCount(3)
      await answerDone(page, LONG)
      // The answer and the silent call after it have left. A slow runner can add a request of its own (seen on CI: one more).
      await expect.poll(async () => (await backend(page, (ctl) => ctl.bodies as string[])).length).toBeGreaterThanOrEqual(before + 2)
      expect(await learning()).toBeGreaterThan(0)
      // The answer is done, so the chat says so: no "Answering", and Send is not Stop.
      await expect(page.getByTestId('m-chat-running')).toHaveCount(0)
      await expect(page.getByTestId('m-chat-stop')).toHaveCount(0)
      // A new question ends the learning at once. The engine stays slow: the learning would run on for many seconds.
      await page.getByTestId('m-chat-input').fill('Four?')
      await page.getByTestId('m-chat-send').tap()
      await expect.poll(learning).toBe(0)
      await expect(answers(page)).toHaveCount(4)
    })

    test('Android M10 and N3: the context chip names itself, and the window says it holds for all chats', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await send(page, 'Hi')
      await answerDone(page)
      // Prompt v2: a chat that fits shows no context chip above the field; the window is named in the options.
      await expect(page.getByTestId('m-chat-context')).toHaveCount(0)
      await page.getByTestId('m-chat-options').tap()
      await expect(page.getByTestId('m-options-context')).toContainText('One size for all chats')
      await page.getByTestId('m-options-context').tap()
      await expect(page.getByTestId('m-options-context-window')).toContainText('Window size for all chats on this phone')
      expect(await layout(page)).toEqual(CLEAN)
    })

    test('Android N7: a message that arrived while another page lay on top is in view on the way back', async ({ page }) => {
      await boot(page)
      await page.getByTestId('m-page-back').tap()
      await seedChats(page, [{ id: 'long', title: 'Long chat', messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), content: `Message ${i + 1}. ${'Some more words to fill the line. '.repeat(3)}` })) }])
      await openChat(page, 'long')
      const body = page.locator('[data-testid="m-chat-screen"] .m-body')
      const atEnd = () => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
      await expect.poll(atEnd).toBeLessThan(4)
      // The reader scrolls up by hand.
      await body.evaluate((el) => {
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -500 }))
        el.scrollTop = 0
      })
      await expect.poll(atEnd).toBeGreaterThan(200)
      // Another page on top, as Compare is. There an answer is kept for this chat.
      await page.evaluate(`import(location.origin + '/src/mobile/nav/index.ts').then(({ nav }) => { nav.push('/chat/:id/documents', { id: 'long' }) })`)
      await expect(page.getByTestId('m-chat-documents-screen')).toBeVisible()
      await page.evaluate(async () => {
        const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
        useChatStore.getState().addMessage('long', { id: 'kept-q', role: 'user', content: 'Kept question', timestamp: Date.now() })
        useChatStore.getState().addMessage('long', { id: 'kept-a', role: 'assistant', content: 'Kept answer from the comparison.', timestamp: Date.now() })
      })
      await page.getByTestId('m-chat-documents-screen').getByTestId('m-page-back').tap()
      await expect(page.getByTestId('m-chat-documents-screen')).toHaveCount(0)
      await expect.poll(atEnd).toBeLessThan(4)
      await expect(answers(page).last()).toBeInViewport()
      await expect(answers(page).last()).toContainText('Kept answer')
    })

    // Round 57 (David): closed and started again, LU is in a new, empty chat with the model of the last chat and
    // the composer; the chat that was open is one step back in the list, and no empty chat was added there.
    test('a cold start opens a new chat with the model choice, the chat that was open waits in the list', async ({ page }) => {
      const errors = watchErrors(page)
      await boot(page)
      await waitForModel(page)
      await back(page)
      await seedChats(page, [{ id: 'open', title: 'Was open', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }] }])
      await openChat(page, 'open')
      await page.waitForTimeout(700)
      for (let start = 0; start < 2; start += 1) {
        await page.reload()
        await page.getByTestId('m-app').waitFor()
        await screensLoaded(page)
        await expect(page.getByTestId('m-chat-screen')).toBeVisible()
        expect(await topRoute(page)).toBe('/chat/:id')
        const empty = page.getByTestId('m-chat-empty')
        await expect(empty).toContainText('Ask LU anything')
        await expect(empty).toContainText('Type below to start.')
        await waitForModel(page)
        await expect(page.getByTestId('m-chat-input')).toHaveValue('')
        expect(await layout(page)).toEqual(CLEAN)
      }
      await back(page)
      await expect(page.getByTestId('m-chats-item')).toHaveCount(1)
      await expect(page.locator('[data-testid="m-chats-item"][data-m-id="open"]')).toBeVisible()
      expect(errors()).toEqual([])
    })

    // Since round 57 the list is flat: the rows run from edge to edge, and their text stands on the line of the
    // search field and the switch above them (N17 was cards narrower than the field).
    test('Android N17: the text of the chat rows stands on the line of the search field and the switch above them', async ({ page }) => {
      await boot(page)
      await page.getByTestId('m-page-back').tap()
      await seedChats(page, [
        { id: 'one', title: 'First chat', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }] },
        { id: 'two', title: 'Second chat', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }] },
      ])
      await expect(page.getByTestId('m-chats-item')).toHaveCount(2)
      const edges = async (selector: string) => {
        const box = (await page.locator(selector).first().boundingBox())!
        return { left: Math.round(box.x), right: Math.round(box.x + box.width) }
      }
      const tools = await edges('[data-testid="m-chats-segment"]')
      const list = await edges('[data-testid="m-chats-list"] .m-group')
      const title = await edges('[data-testid="m-chats-list"] .m-row-title')
      expect(title.left).toBe(tools.left)
      expect(list).toEqual({ left: 0, right: page.viewportSize()!.width })
    })

    test('Android N22: the speed of the answer stands under it, the same figure the diagnostics keep', async ({ page }) => {
      await boot(page, { chunks: 12, delay: 40 })
      await waitForModel(page)
      await send(page, 'How fast are you?')
      await answerDone(page)
      const line = page.getByTestId('m-chat-speed')
      await expect(line).toContainText(/^\d+(\.\d)? tokens per second$/)
      const kept = await page.evaluate(async () => {
        const { lastGenerationSpeed } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/lib/diagnostics.ts`)
        const speed = lastGenerationSpeed()
        return speed ? (speed.tokensPerSecond >= 10 ? speed.tokensPerSecond.toFixed(0) : speed.tokensPerSecond.toFixed(1)) : null
      })
      expect(await line.textContent()).toBe(`${kept} tokens per second`)
      expect(await layout(page)).toEqual(CLEAN)
    })

    test('Android buttons H2: a hard kill in the middle of an answer keeps the part that arrived, and Continue goes on from it', async ({ page }) => {
      await boot(page, { reply: LONG_REPLY, chunks: 40, delay: 250 })
      await waitForModel(page)
      await send(page, 'Tell me about tides')
      await expect(answers(page).last()).toContainText('Sentence 3 ')
      // The record of the running answer is on the disk, written so that a kill cannot take it.
      const record = () =>
        page.evaluate(
          () =>
            new Promise<string>((resolve) => {
              void (async () => {
              // Only look at a database that is there: opening one that is not would create it, empty.
              if (!(await indexedDB.databases()).some((d) => d.name === 'lu-answer-checkpoints')) return resolve('')
              const open = indexedDB.open('lu-answer-checkpoints')
              open.onerror = () => resolve('')
              open.onsuccess = () => {
                const db = open.result
                if (!db.objectStoreNames.contains('answers')) return resolve('')
                const all = db.transaction('answers', 'readonly').objectStore('answers').getAll()
                all.onsuccess = () => resolve((all.result as Array<{ content?: string }>).map((r) => r.content ?? '').join('|'))
                all.onerror = () => resolve('')
              }
              })()
            }),
        )
      await expect.poll(record).toContain('Sentence 3 ')
      // The kill. What it leaves behind on a phone: the history as it was written when the answer began
      // (the later writes sat in a buffer the process took with it), and no goodbye of any kind.
      await page.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            window.addEventListener('pagehide', (event) => event.stopImmediatePropagation(), true)
            document.addEventListener('visibilitychange', (event) => event.stopImmediatePropagation(), true)
            const open = indexedDB.open('locally-uncensored-store')
            open.onerror = () => reject(new Error('no store'))
            open.onsuccess = () => {
              const tx = open.result.transaction('kv', 'readwrite')
              const kv = tx.objectStore('kv')
              const read = kv.get('chat-conversations')
              read.onsuccess = () => {
                const saved = JSON.parse(String(read.result))
                const messages = saved.state.conversations[0].messages
                messages[messages.length - 1].content = ''
                kv.put(JSON.stringify(saved), 'chat-conversations')
              }
              tx.oncomplete = () => {
                // Nothing of this session reaches the disk any more.
                IDBObjectStore.prototype.put = () => {
                  throw new Error('the app was killed')
                }
                resolve()
              }
              tx.onerror = () => reject(tx.error)
            }
          }),
      )
      await page.reload()
      await page.getByTestId('m-app').waitFor()
      await screensLoaded(page)
      await backend(page, (ctl) => { ctl.reply = 'and so the tide turns twice a day.'; ctl.chunks = 4; ctl.delay = 5 })

      // LU opens where it was, in this chat. The answer has its part back and the box under it says what happened.
      await expect(page.getByTestId('m-chat-screen')).toBeVisible()
      // The notice above the pages is for a cut answer in ANOTHER place. With its chat on screen it is done with
      // and leaves the room to the chat (checks on Android with 4 GB, F1 and F7, and on the iPhone, M4).
      await expect(page.getByTestId('m-app-resume')).toHaveCount(0)
      await expect(answers(page).last()).toContainText('Sentence 3 ')
      const cut = page.getByTestId('m-chat-error')
      await expect(cut).toContainText('LU was closed while answering.')
      await expect(cut).toContainText('The part that arrived is kept. Continue goes on from there.')
      await expect(page.getByTestId('m-chat-error-action')).toHaveText('Continue')
      await page.getByTestId('m-chat-error-action').tap()
      // Continue goes on from the part, in the same bubble: no message of the user appears that nobody wrote,
      // and no second answer (acceptance on Android, round 4, N6). The model is given the part and the request.
      const before = await userMessages(page).count()
      await answerDone(page, 'and so the tide turns twice a day.')
      await expect(answers(page)).toHaveCount(1)
      await expect(answers(page).first()).toContainText('Sentence 3 ')
      await expect(answers(page).first()).toContainText('and so the tide turns twice a day.')
      await expect(userMessages(page)).toHaveCount(before)
      await expect(page.getByTestId('m-chat-screen')).not.toContainText('Continue your answer exactly where it stopped')
      // Stored the way it is shown: one answer, and the request is gone from the chat.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const { useChatStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/chatStore.ts`)
            const chat = useChatStore.getState().conversations.find((c: { id: string }) => c.id === useChatStore.getState().activeConversationId)
            return (chat?.messages ?? []).filter((m: { hidden?: boolean }) => !m.hidden).map((m: { role: string }) => m.role).join(',')
          }),
        )
        .toBe('user,assistant')
      // Round 10: the engine of the phone is given the part as the open turn of the assistant and the word to go
      // on inside it. It never reads a request to continue, so it has no new answer to begin.
      const body = (await backend(page, (ctl) => ctl.bodies as string[])).at(-1) ?? ''
      const sent = JSON.parse(body) as { continue_final_message?: boolean; messages: { role: string; content: string }[] }
      expect(sent.continue_final_message).toBe(true)
      expect(sent.messages.at(-1)?.role).toBe('assistant')
      expect(sent.messages.at(-1)?.content).toContain('Sentence 3 of a long answer')
      expect(sent.messages.at(-2)).toMatchObject({ role: 'user', content: 'Tell me about tides' })
      expect(body).not.toContain('Continue your answer exactly where it stopped')
      await expect(page.getByTestId('m-chat-error')).toHaveCount(0)
      await expect(page.getByTestId('m-app-resume')).toHaveCount(0)
    })

    test('M8: "This chat ran on X before" is not shown while X is the active model', async ({ page }) => {
      await boot(page)
      await page.getByTestId('m-page-back').tap()
      await seedChats(page, [
        // A message keeps the bare name of its model, the picker holds the routed one.
        { id: 'same', title: 'Same model', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.', modelId: SMALL }] },
        { id: 'other', title: 'Other model', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.', modelId: `openai::${VISION}` }] },
      ])
      await openChat(page, 'same')
      await waitForModel(page)
      await expect(answers(page).last()).toContainText('Hello.')
      await expect(page.getByTestId('m-chat-model-hint')).toHaveCount(0)
      await openChat(page, 'other')
      await expect(page.getByTestId('m-chat-model-hint')).toContainText('This chat ran on')
    })

    test('H1: between Send and the first word there is no error block, and Stop is in the slot', async ({ page }) => {
      // The engine holds nothing: the send has to load the model first, which takes a while.
      await boot(page, { loaded: null, startDelay: 1500, delay: 30 })
      await waitForModel(page)
      await page.getByTestId('m-chat-input').fill('What is the capital of France?')
      const seen: string[] = []
      await page.exposeFunction('__h1', (state: string) => { seen.push(state) })
      await page.evaluate(() => {
        const look = () => {
          const error = document.querySelector('[data-testid="m-chat-error"]')
          const last = [...document.querySelectorAll('[data-testid="m-chat-message"][data-m-role="assistant"]')].at(-1)
          const tell = (window as unknown as { __h1: (state: string) => void }).__h1
          if (error || last?.getAttribute('data-state') === 'error') tell('error')
        }
        new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true })
      })
      await page.getByTestId('m-chat-send').tap()
      await expect(page.getByTestId('m-chat-stop')).toBeVisible()
      await expect(answers(page).last()).toHaveAttribute('data-state', 'streaming')
      await answerDone(page)
      expect(seen.filter((s) => s === 'error')).toEqual([])
      // The microphone only comes back with the finished answer.
      await expect(page.getByTestId('m-chat-mic')).toBeVisible()
    })

    test('H4: thinking is off on a new phone, and a running thought is shown as it grows', async ({ page }) => {
      await boot(page, { engineThinks: true })
      await waitForModel(page)
      // Off from the start, although the logic layer starts with it on.
      await expect(page.getByTestId('m-chat-options')).not.toContainText('Thinking')
      await page.getByTestId('m-chat-options').tap()
      const toggle = page.locator('[data-testid="m-options-thinking"][role="switch"], [data-testid="m-options-thinking"] [role="switch"]')
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await toggle.tap()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await page.getByTestId('m-sheet-close').tap()

      await backend(page, (ctl) => {
        ctl.thinking = Array.from({ length: 40 }, (_, i) => `Step ${i + 1} of the thought about the dog.`).join(' ')
        ctl.thinkingDelay = 150
        ctl.reply = ''
      })
      await send(page, 'What is my dog called?')
      const fold = page.getByTestId('m-chat-thinking').last()
      // Open by itself while the model thinks, with text that grows.
      await expect(fold).toHaveAttribute('aria-expanded', 'true')
      const body = answers(page).last().locator('.m-ag-thought')
      await expect(body).toContainText('Step 1 of the thought')
      await expect(body).toContainText('Step 6 of the thought')
      await expect(page.getByTestId('m-chat-stop')).toBeVisible()
      await picture(page, 'h4-thinking-live')

      // The model only thought: one tap answers without thinking.
      await expect(page.getByTestId('m-chat-thought-only')).toBeVisible({ timeout: 30_000 })
      await expect(fold).toHaveAttribute('aria-expanded', 'false')
      await backend(page, (ctl) => {
        ctl.thinking = ''
        ctl.reply = 'Your dog is called Bruno.'
      })
      await picture(page, 'h4-thought-only')
      await page.getByTestId('m-chat-answer-no-thinking').tap()
      await expect(page.getByTestId('m-toast-thinking-off')).toBeVisible()
      await answerDone(page, 'Your dog is called Bruno.')
      await expect(page.getByTestId('m-chat-options')).not.toContainText('Thinking')
      const lastBody = (await backend(page, (ctl) => ctl.bodies as string[])).at(-1) ?? ''
      expect(lastBody).toContain('"enable_thinking":false')
      expect(await layout(page)).toEqual(CLEAN)
    })

    test('N3: Stop while the model thinks says that the user stopped it, adds nothing after the tap, and the next answer is its own', async ({ page }) => {
      await boot(page, { engineThinks: true })
      await waitForModel(page)
      await page.getByTestId('m-chat-options').tap()
      const toggle = page.locator('[data-testid="m-options-thinking"][role="switch"], [data-testid="m-options-thinking"] [role="switch"]')
      await toggle.tap()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await page.getByTestId('m-sheet-close').tap()
      await backend(page, (ctl) => {
        ctl.thinking = Array.from({ length: 40 }, (_, i) => `Step ${i + 1} of the thought about the sum.`).join(' ')
        ctl.thinkingDelay = 150
        ctl.reply = '51'
      })
      await send(page, 'What is 17 times 3?')
      const body = answers(page).last().locator('.m-ag-thought')
      await expect(body).toContainText('Step 3 of the thought')
      await page.getByTestId('m-chat-stop').tap()
      const hint = page.getByTestId('m-chat-thought-only')
      await expect(hint).toBeVisible()
      await expect(hint).toHaveAttribute('data-m-stopped', '')
      await expect(hint).toContainText('You stopped it while it was still thinking')
      await expect(hint).not.toContainText('only thought')
      await expect(page.getByTestId('m-chat-error')).toHaveCount(0)
      // Nothing grows after the tap: the thought and the bubble are the same a while later, and "51" never shows.
      const before = await answers(page).last().innerText()
      await page.waitForTimeout(1200)
      expect(await answers(page).last().innerText()).toBe(before)
      await expect(answers(page).last()).not.toContainText('51')
      // The mark is stored with the chat: the sentence is the same after the app was opened again. The start opens
      // a new chat (round 57); the chat is one step back, in the list.
      await page.reload()
      await page.getByTestId('m-app').waitFor()
      await screensLoaded(page)
      await expect(page.getByTestId('m-chat-empty')).toBeVisible()
      await back(page)
      await page.getByTestId('m-chats-open').first().tap()
      await expect(page.getByTestId('m-chat-thought-only')).toContainText('You stopped it while it was still thinking')
      // The next question gets its own answer.
      await backend(page, (ctl) => {
        ctl.thinking = ''
        ctl.reply = 'Madrid'
      })
      await send(page, 'What is the capital of Spain? One word.')
      await answerDone(page, 'Madrid')
      await expect(answers(page).last()).not.toContainText('51')
    })

    test('M9: a memory from the settings is in the request of a new chat', async ({ page }) => {
      await boot(page)
      await waitForModel(page)
      await page.evaluate(async () => {
        const { useMemoryStore } = await import(/* @vite-ignore */ `${location.origin}/src/stores/memoryStore.ts`)
        useMemoryStore.getState().addMemory({ type: 'user', title: 'Mara likes tea', description: '', content: 'Mara likes tea', tags: [], source: 'manual' })
      })
      await send(page, 'Which beverage should I order?')
      await answerDone(page)
      const body = (await backend(page, (ctl) => ctl.bodies as string[])).at(-1) ?? ''
      expect(body).toContain('Mara likes tea')
      expect(body).toContain('remembered_context')
    })
  })
})

test.describe('chat, screenshots', () => {
  test.skip(!process.env.LU_CHAT_SHOTS, 'set LU_CHAT_SHOTS=1 to write the screenshots')

  for (const variant of SHOT_VARIANTS) {
    test.describe(variant.id, () => {
      test.use({ viewport: { width: variant.width, height: variant.height } })

      const shot = async (page: Page, name: string) => {
        await layout(page)
        await page.waitForTimeout(250)
        fs.mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(SHOTS, `${name}--${variant.id}.png`) })
      }
      const closeSheet = async (page: Page) => {
        await page.getByTestId('m-sheet-close').last().tap()
        await page.waitForTimeout(200)
      }

      test('pages and sheets', async ({ page }) => {
        test.setTimeout(180_000)
        await routeCloud(page, { license: 'active', access: true, paidPlan: true })
        await boot(page, { theme: variant.theme, fontScale: variant.fontScale, reply: LONG_REPLY, chunks: 40, delay: 120 })
        await waitForModel(page)
        await shot(page, 'c2-new-chat')

        await page.getByTestId('m-page-back').tap()
        await shot(page, 'c1-empty')

        const png = await makePng(page)
        await seedChats(page, [
          {
            id: 'rich',
            title: 'How tides work',
            ago: 2,
            messages: [
              { role: 'user', content: 'Why are there two high tides a day? Here is the beach I mean.', images: [{ data: png, mimeType: 'image/png', name: 'beach.png' }] },
              { role: 'assistant', content: RICH_ANSWER },
            ],
          },
          { id: 'plain', title: 'Dinner for six, no nuts', ago: 40, messages: [{ role: 'user', content: 'A menu please' }, { role: 'assistant', content: 'Start with a tomato soup, then a risotto with mushrooms.' }] },
          { id: 'longtitle', title: 'A very long title that has to be cut somewhere before the edge of the phone', ago: 200, messages: [{ role: 'user', content: 'A question with a rather long first line that does not fit into the row either' }] },
          { id: 'spent', title: 'Cloud chat without credits', ago: 1500, messages: [{ role: 'user', content: 'Hello cloud' }, { role: 'assistant', modelId: 'lu-cloud::some-model', content: OUT_OF_CREDITS }] },
          { id: 'broken', title: 'Engine did not answer', ago: 3000, messages: [{ role: 'user', content: 'Hello phone' }, { role: 'assistant', content: 'Error: The on device engine is not running.' }] },
          { id: 'dropped', title: 'Connection dropped', ago: 90000, messages: [{ role: 'user', content: 'Tell me a story' }, { role: 'assistant', content: 'Once upon a time there was\n\nError: Failed to fetch' }] },
        ])
        await shot(page, 'c1-list')

        await page.getByTestId('m-chats-search').fill('zzzz')
        await shot(page, 'c1-search-nomatch')
        await page.getByTestId('m-chats-search').fill('tide')
        await shot(page, 'c1-search-match')
        await page.getByTestId('m-chats-search').fill('')

        // C7 with its two sub pages.
        await page.locator('[data-testid="m-chats-item"][data-m-id="rich"] [data-testid="m-chats-item-more"]').tap()
        await shot(page, 'c7-chat-menu')
        await page.getByTestId('m-chat-menu-export').tap()
        await shot(page, 'c7-export')
        await page.getByTestId('m-sheet-back').tap()
        await page.getByTestId('m-chat-menu-files').tap()
        await shot(page, 'c7-files')
        await page.getByTestId('m-sheet-back').tap()
        await page.getByTestId('m-chat-menu-rename').tap()
        await shot(page, 'c7-rename')
        await page.getByTestId('m-dialog-cancel').tap()
        if (await page.getByTestId('m-sheet-close').count()) await closeSheet(page)

        // C2 with markdown, a table, code, an image and a link.
        await openChat(page, 'rich')
        const body = page.locator('[data-testid="m-chat-screen"] .m-body')
        await body.evaluate((el) => el.scrollTo(0, 0))
        // An image loads when it comes into view.
        await expect(page.getByTestId('m-chat-image')).toHaveAttribute('data-state', 'ready')
        await shot(page, 'c2-conversation-top')
        await body.evaluate((el) => el.scrollTo(0, el.scrollHeight))
        await shot(page, 'c2-conversation-end')

        // C6 for an answer and for a message of the user, with the pages behind it.
        await page.getByTestId('m-chat-answer-more').tap()
        await shot(page, 'c6-answer')
        await page.getByTestId('m-chat-message-report').tap()
        await shot(page, 'c6-report')
        await closeSheet(page)
        await page.getByTestId('m-chat-answer-more').tap()
        await page.getByTestId('m-chat-message-select').tap()
        await shot(page, 'text-page')
        await back(page)
        await page.getByTestId('m-chat-answer-more').tap()
        await page.getByTestId('m-chat-message-edit').tap()
        await shot(page, 'message-edit-page')
        await back(page)
        await body.evaluate((el) => el.scrollTo(0, 0))
        await page.getByTestId('m-chat-message-more').first().tap()
        await shot(page, 'c6-user-message')
        await closeSheet(page)

        // C14 and the link question.
        await page.getByTestId('m-chat-image').first().tap()
        await expect(page.getByTestId('m-chat-file-screen')).toBeVisible()
        await shot(page, 'c14-image')
        await page.getByTestId('m-viewer-close').tap()
        await body.evaluate((el) => el.scrollTo(0, el.scrollHeight))
        await page.getByTestId('m-chat-link').first().tap()
        await shot(page, 'c2-link-sheet')
        await page.getByTestId('m-chat-link-cancel').tap()

        // The voice sheet, while this phone has no voice and no cloud.
        await page.getByTestId('m-chat-mic').tap()
        await expect(page.getByTestId('m-chat-voice-gate-later')).toBeVisible()
        await shot(page, 'c2-voice-gate')
        await page.getByTestId('m-chat-voice-gate-later').tap()

        // C3: on device, cloud before and after the sign in, the price page.
        await openModelSheet(page)
        await shot(page, 'c3-local')
        await page.getByTestId('m-chat-model-segment-cloud').tap()
        await expect(page.getByTestId('m-chat-model-signin')).toBeVisible()
        await shot(page, 'c3-cloud-signin')
        await closeSheet(page)
        await signInCloud(page)
        await openModelSheet(page)
        await page.getByTestId('m-chat-model-segment-cloud').tap()
        await expect(page.locator('[data-testid="m-sheet-model"] [data-testid^="m-chat-model-cloud"]').first()).toBeVisible({ timeout: 20_000 })
        await shot(page, 'c3-cloud')
        await page.getByTestId('m-chat-model-price').first().tap()
        await shot(page, 'c3-price')
        await page.getByTestId('m-sheet-back').tap()
        await closeSheet(page)

        // C4 and the consent.
        await page.getByTestId('m-chat-attach').tap()
        await shot(page, 'c4-attach')
        await closeSheet(page)
        await page.evaluate(async () => {
          const { nav } = await import(/* @vite-ignore */ `${location.origin}/src/mobile/nav/index.ts`)
          nav.openSheet('ai-consent')
        })
        await expect(page.getByTestId('m-consent-agree')).toBeVisible()
        await shot(page, 'c2-cloud-consent')
        await page.getByTestId('m-consent-decline').tap()

        // The composer with six lines and more, then an answer that streams.
        await page.getByTestId('m-chat-input').fill(Array.from({ length: 9 }, (_, i) => `Line ${i + 1} of a long message`).join('\n'))
        await shot(page, 'c2-composer-long')
        await send(page, 'Tell me more about spring tides')
        await expect(page.getByTestId('m-chat-stop')).toBeVisible()
        await expect(answers(page).last()).toContainText('Sentence 4')
        await shot(page, 'c2-streaming')
        await readUp(page)
        await expect(page.getByTestId('m-chat-jump')).toBeVisible()
        await shot(page, 'c2-jump-to-latest')
        await page.getByTestId('m-chat-stop').tap()
        await expect(page.getByTestId('m-chat-stop')).toHaveCount(0)
        await body.evaluate((el) => el.scrollTo(0, el.scrollHeight))
        await shot(page, 'c2-stopped')

        // Error states with their next step.
        for (const id of ['spent', 'broken', 'dropped']) {
          await openChat(page, id)
          await expect(page.getByTestId('m-chat-error')).toBeVisible()
          await shot(page, `c2-error-${id}`)
        }
      })

      test('without a model', async ({ page }) => {
        await boot(page, { theme: variant.theme, fontScale: variant.fontScale, models: [] })
        await expect(page.getByTestId('m-chat-empty')).toBeVisible()
        await shot(page, 'c2-no-model')
        await openModelSheet(page)
        await expect(page.getByTestId('m-chat-model-empty')).toBeVisible()
        await shot(page, 'c3-no-model')
      })
    })
  }
})
