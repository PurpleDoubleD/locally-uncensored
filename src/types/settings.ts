import type { EnterKeyMode } from '../lib/enter-key'
import type { CustomParam } from '../lib/custom-params'
import type { AgentWorkspace } from './agent-workspace'
import type { EffortLevel } from '../lib/effort'

/**
 * The tier `web_search` asks first (src-tauri/src/commands/search_tiers.rs).
 * `auto` runs them all in order; any other one is asked first and Auto
 * follows when it fails. The labels live in lib/search-providers.ts.
 */
export type SearchProvider =
  | 'auto'
  | 'exa'
  | 'you'
  | 'searxng'
  | 'duckduckgo'
  | 'wikipedia'
  | 'brave'
  | 'tavily'

export type CavemanMode = 'off' | 'lite' | 'full' | 'ultra'

export type AppMode = 'local' | 'cloud'

/** Expert tuning for the bundled llama-server. Mirrors Rust `EngineTuning`
 *  (camelCase over IPC); values are whitelisted on the Rust side. */
export interface BuiltinEngineTuning {
  /** `--ctx-size`. 0 = app default (8192). */
  ctx: number
  /**
   * Hat der Nutzer dieses `ctx` selbst gewaehlt?
   *
   * GH #129: die Voreinstellung dieses Feldes IST 8192, also war "vom Nutzer
   * auf 8192 gesetzt" von "nie angefasst" nicht zu unterscheiden, und der
   * Agentendeckel (AGENT_CONTEXT_CAP) hob den Motor trotzdem auf
   * min(ctx_train, 32768). Wer auf einem schwachen Geraet ausdruecklich 8K
   * waehlte, bekam beim Agentenlauf 32K und das Ruckeln, das der Melder
   * beschreibt. Jeder ANDERE Wert war schon vorher als Entscheidung erkennbar,
   * nur dieser eine nicht.
   *
   * Die Marke statt einer Aenderung der Voreinstellung: ein bestehendes Profil
   * traegt die 8192 seit dem ersten Start, und sie nachtraeglich als Wahl zu
   * lesen wuerde jeden Agentenlauf auf 8192 festnageln. Das war genau der
   * Fehler Z36.
   */
  ctxChosen?: boolean
  /** Flash Attention: 'auto' (binary default), 'on', 'off'. */
  flashAttn: 'auto' | 'on' | 'off'
  /** KV-cache quantization for K/V. 'f16' = off. Quantized V needs flash attention. */
  cacheTypeK: 'f16' | 'bf16' | 'q8_0' | 'q4_0'
  cacheTypeV: 'f16' | 'bf16' | 'q8_0' | 'q4_0'
  /** CPU threads for generation. <=0 = auto. */
  threads: number
  /** GPU layers to offload. -1 = all layers, 0 = CPU-only. */
  gpuLayers: number
  /** Pin the model in RAM (`--mlock`). */
  mlock: boolean
  /** Disable mmap (`--no-mmap`): slower load, fewer pageouts. */
  noMmap: boolean
}

export interface Settings {
  apiEndpoint: string
  temperature: number
  topP: number
  topK: number
  maxTokens: number
  theme: 'light' | 'dark'
  onboardingDone: boolean
  /**
   * Global Local/Cloud switch (2.5.7). 'local' = today's app (own hardware,
   * every local provider). 'cloud' = the LU Cloud tier: chat/create/voice run
   * on lu-labs.ai with the signed-in account, local-hardware surfaces hide.
   * The header switch flips it; the CloudGateModal guards the cloud side
   * (login → subscription → closed-beta gate). Persisted: reopen in the mode
   * you left. Auto-falls back to 'local' when the account signs out.
   */
  appMode: AppMode
  /** One-time Cloud onboarding (2026-07-10): the FIRST successful flip
   *  to Cloud shows a short what-changes walkthrough; after that the switch
   *  flips silently. Persisted so it never re-triggers. */
  /** Cloud discovery inside Local mode (2.5.8): locked Upscale/Erase tabs in
   *  Create, hosted-model rows in the chat + Create pickers, each opening a
   *  small "runs on LU Cloud" sheet. Teasers never block a local flow and
   *  never show in cloud mode. Off = Local mode shows zero Cloud surfaces;
   *  the sheet's "Hide Cloud features" link and Settings both flip this. */
  cloudTeasersEnabled: boolean
  /** Master switch for personas. When off, new chats get no persona system
   *  prompt (raw model). Default true. Ported from the web companion. */
  personasEnabled: boolean
  thinkingEnabled: boolean
  /** Emoticons such as :) become emojis while typing in the chat composer
   *  (Chat, Agent, Code; not Create). Default on (lib/emoticons.ts). */
  emojiAutoReplace: boolean
  /** GH #202: what Enter does in the composer and in the edit field of an
   *  earlier message, 'send' (the default) or 'newline' (lib/enter-key.ts). */
  enterKey?: EnterKeyMode
  /** REA, the reverse engineering plugin of the agents (lib/plugins/rea.ts):
   *  on starts its local MCP server. Default off. */
  reaPluginEnabled: boolean
  /**
   * How hard a reasoning model should think (2.6.8). One global rung, the same
   * way thinkingEnabled is one global switch, and it reaches Chat, Agent mode
   * and the Coding Agent alike.
   *
   * It only ever leaves the app for a model whose catalogue entry declares its
   * own rungs (`reasoning_effort_levels`); everything else keeps sending what
   * it sent before. The value is clamped onto the model's ladder in
   * lib/effort.ts, so a wish this model has never heard of cannot become a 400
   * and cannot become "think as hard as you possibly can" either.
   */
  reasoningEffort: EffortLevel
  /**
   * Has the user picked a rung on a LOCAL model himself (3.0.7, after issue
   * 176)? Local servers take effort since 3.0.7, but the global rung above
   * defaults to 'high', and sending that would have changed every local
   * model's thinking without anyone choosing it (gpt-oss reads 'high' in its
   * template where it used to run on its own Medium). So until this is true
   * a local request stays as it was before 3.0.7 and the composer says
   * Default. Set by the effort button on a local model, cleared when the user
   * cycles back to Default.
   */
  localEffortChosen: boolean
  /**
   * Think budget (D12): the most tokens a model may spend on reasoning, 0 for
   * auto. Global like thinkingEnabled, so Chat, Agent mode and the Coding
   * Agent read the same number. Only backends that really take a count get it
   * (lib/think-budget.ts); a profile from before this field reads as 0.
   */
  thinkingBudget?: number
  /**
   * Small-Model Mode (v2.5.0). Evidence-backed lean profile that maximises
   * tool-call reliability + context retention on small local models (3B-8B,
   * e.g. gemma4:e4b, Llama-3.2-3B, Qwen3-8B). When on it flips: a tighter
   * tool cap + embedding-routing (Knob 1), a lean system prompt (Knob 2),
   * tool-output truncation (Knob 3), and aggressive history compaction
   * (Knob 4). It deliberately does NOT lower num_ctx — research found the
   * num_ctx-as-ceiling fear is largely a myth; the real lever is keeping the
   * actual prompt short (see finding_small_model_tool_calling_research).
   * Default false (big models are unaffected). Manual knob, not auto-forced.
   */
  smallModelMode: boolean
  /**
   * Create in chat: the "Create" switch under Plugins. On = create_options and
   * create_order ride along with every message in the cloud chat and in Agent
   * mode; the model decides in context, every order still needs the customer's
   * approval. Off = no Create tools. Optional on purpose: absent means OFF, so
   * no default and no store migration is needed. Cloud mode only, and only for
   * an account the server has released (lib/create/chat-switch.ts).
   */
  createEnabled?: boolean
  cavemanMode: CavemanMode
  searchProvider: SearchProvider
  braveApiKey: string
  tavilyApiKey: string
  /**
   * 3.0.8: the user's own Exa key. Empty or absent = Exa's keyless endpoint.
   * Optional on purpose: a store saved before 3.0.8 lacks it and means
   * keyless, so no migration is needed. Kept in the local settings store
   * only, like the Brave and Tavily keys.
   */
  exaApiKey?: string
  /**
   * D16 (3.0.7): the User-Agent the free search tiers and `web_fetch` send.
   * Empty or absent = the one each of them always sent. Optional on purpose:
   * a store saved before 3.0.7 lacks it and means the default, so no
   * migration is needed. Checked again on
   * the Rust side (`search::custom_user_agent`), where an unusable value
   * falls back to the default instead of failing the request.
   */
  searchUserAgent?: string
  /**
   * True when the key of that provider lies in the keychain instead of in
   * the field above (src/lib/search-keys.ts). The phone stores keys only
   * that way, so the settings and every backup carry this one bit and never
   * the key. The desktop settings page still writes the plain field.
   */
  braveKeyStored: boolean
  tavilyKeyStored: boolean
  // Agent budget (Phase 10 v2.4.0) — hard caps that halt a runaway agent.
  /** Hard cap on tool calls per user turn. 0 = unlimited (not recommended). */
  agentMaxToolCalls: number
  /** Hard cap on ReAct loop iterations per user turn. 0 = unlimited. */
  agentMaxIterations: number
  /**
   * Dieselben zwei Schranken, aber fuer einen delegierten Sub-Agenten.
   *
   * Getrennt von den beiden darueber, und das ist der Punkt: die Kappen des
   * Hauptlaufs (400/200) sind grosszuegig, weil der Nutzer daneben sitzt und
   * Stop druecken kann. Ein Sub-Agent laeuft ohne Zuschauer, in fremdem
   * Auftrag, und seine Kappen sind darum eng (10/5). Beide aus einem Topf zu
   * bedienen hiesse, entweder den Hauptlauf zu fesseln oder die Delegation
   * von der Leine zu lassen.
   *
   * 0 heisst hier NICHT unbegrenzt, sondern "nimm die Vorgabe" — bei einer
   * unbeaufsichtigten Schleife ist Unbegrenztheit kein Wunsch, den man aus
   * Versehen aeussern koennen sollte.
   */
  subAgentMaxToolCalls: number
  subAgentMaxIterations: number
  /**
   * How many passes a `/loop` may run. 0 = unlimited, which is the default:
   * a loop the user asked to keep going should keep going until it is done or
   * they stop it (2026-07-25). The stop button is the brake, not a cap.
   */
  loopMaxPasses: number
  /** Override for the HuggingFace GGUF download directory. Empty = auto-detect from active openai-compat provider (e.g. LM Studio models folder). */
  hfDownloadPathOverride: string
  /** Cap for the model files LU downloads itself, in MB/s, shared by all
   *  downloads at once. 0 = no limit (Discord 2026-09-23). */
  downloadLimitMBps: number
  /** Unload the LU Engine's chat model after this many minutes without a
   *  request (commands/engine_idle.rs), 0 or absent for never (Discord
   *  21.10.2026). Optional: an existing profile has no key and reads as never,
   *  so no store version is spent on it. */
  engineIdleUnloadMinutes?: number
  /** Model ids an OpenAI-compatible server serves but does not list in
   *  /models, by endpoint (lib/extra-model-ids.ts `endpointKey`). GitHub #112. */
  extraModelIds: Record<string, string[]>
  // Generation timeouts (Bug P v2.4.7 — Discord 2026-05-19,
  // Intel UHD CPU-only setup hit the 20-min cap at sampling 9/25 on a 1024px
  // Juggernaut-XL gen).
  /** Image generation timeout in minutes. Default 20. */
  imageGenTimeoutMinutes: number
  /** Video generation timeout in minutes. Default 60. */
  videoGenTimeoutMinutes: number
  /** Seconds a chat waits for the first byte of an answer before it gives
   *  up, 0 = Off. Default 600 (issue 177, lib/chat-reply-timeout.ts). */
  chatFirstReplyTimeoutSeconds: number
  /** GitHub #19: the browser tab name of the Remote Access page on the
   *  phone. Empty keeps "AI Terminal" (lib/remote-page-title.ts). */
  remotePageTitle: string
  /** Shared chats (mobile-docs/remote/CHATS-V1.md): a new chat is shared
   *  with the paired phones from the start. Default off. */
  shareNewChatsWithPhone: boolean
  // Bug AA v2.5.0 — Discord 2026-05-27. Ollama defaults `num_ctx` to
  // 2048, which silently caps RAG payloads and long-turn chats even on
  // models that support way more. This override is forwarded to Ollama
  // chat/chatWithTools as `options.num_ctx`. 0 = use Ollama default
  // (recommended unless you have a specific reason to override). Other
  // providers ignore this field — they manage context themselves.
  /** User-side context-window override (forwarded as Ollama's num_ctx). 0 = auto. */
  contextWindowOverride: number
  /**
   * Die Fensterwahl des Nutzers je Endpunkt UND Modell, in Tokens.
   * Schluessel: `<baseUrl>|<modelId>` (lib/context-source.ts).
   *
   * GH #129: ein eigener OpenAI-kompatibler Server hat kein LU-seitiges
   * Wissen ueber sein Fenster. Wo keine Abfrage antwortet, ist die Wahl des
   * Nutzers die einzige Zahl, die stimmen kann. Je Modell und nicht global,
   * weil `contextWindowOverride` Ollamas num_ctx ist und ein zweites Modell
   * am selben Server ein anderes Fenster hat.
   *
   * Kein STORE_VERSION-Sprung noetig: das migrate im settingsStore mischt
   * additiv, ein fehlender Schluessel liest sich als undefined, und
   * `storedWindow` beantwortet das mit 0 ("Auto").
   */
  contextWindowByModel?: Record<string, number>
  /**
   * Age decay for tool results plus the paid-provider send cap (2.6.6, plan
   * A1/A2). ON is the shipped behaviour: results older than the newest
   * iteration go out head+tail-capped and a step never sends more than
   * codexSendWindowTokens on a paid provider.
   *
   * This is the support way back without a rollback release. If a run halts
   * with "repeated with identical arguments", turning this off restores the
   * 2.6.5 prompt exactly, at 2.6.5 prices.
   */
  contextDecay: boolean
  /**
   * Ceiling for one agent step on a paid provider, in tokens. The effective
   * budget is min(0.8 × model window, this). The model's own context window
   * and num_ctx are untouched, so raising it never breaks a model, it only
   * costs more. Local backends ignore it.
   */
  codexSendWindowTokens: number
  /**
   * Per-model choice of the send window for paid cloud models, keyed by the
   * prefixed model name. Picked in the header's context dropdown; absent
   * means codexSendWindowTokens applies. The model's own window is fixed on a
   * cloud provider, so this is the one context lever there: how much of the
   * conversation each step sends, and pays for.
   */
  cloudSendWindowByModel?: Record<string, number>
  /**
   * Auto-compact on or off. 3.0.7: on by default (owner decision 17.10.2026,
   * "auf Claude-Code-Desktop-Niveau"). Before 3.0.7 the feature was opt-in and
   * a 0 in `autoCompactThreshold` was the off switch; nobody could choose
   * "off" any other way, so a stored 0 means "never chosen" and reads as on.
   * Only a real `false` here is off. The rehydration in settingsStore makes
   * sure a profile without the key arrives as `true`.
   *
   * When it is on, the older part of a conversation is summarised before a
   * turn once the payload nears the window, and the older steps of a long
   * tool run are summarised in the middle of the run the same way
   * (lib/run-compact-midway.ts). The mechanical trim stays underneath both.
   */
  autoCompact: boolean
  /**
   * Auto-compact trigger, as a fraction of the send window. 2.6.8.
   *
   * 0 = fit the model: the threshold follows the context window, earlier on a
   * small window because the summary call and the answer need room there too
   * (adaptiveCompactThreshold in lib/compact-trigger.ts), and only from a 32K
   * model window up (MIN_AUTO_COMPACT_WINDOW, owner decision 18.10.2026). A value in
   * [0.3, 0.95] is a fixed threshold the user chose. Whether the feature runs
   * at all is `autoCompact`, not this number.
   *
   * The manual `/compact` command does NOT consult this. It is the user asking
   * for one compaction on purpose; the threshold governs only the automatic one.
   */
  autoCompactThreshold: number
  /**
   * The most an attached text file may take of one message, in tokens (GH
   * #171). 0 = no limit of its own: the whole file goes out when it fits the
   * model's context next to the conversation and room for the answer, and as
   * much of it as fits otherwise. Either way the chat says what was cut.
   */
  attachmentTokenLimit: number
  /**
   * Auto memory extraction on lu-cloud only with explicit opt-in (2.6.6, plan
   * A7): every extraction is a paid model call. Local and BYOK providers are
   * not gated by this.
   */
  memoryCloudOptIn: boolean
  /**
   * Global default for the coding mode dropdown (2.6.6, plan C1). A
   * conversation without its own remembered mode starts here. Approve-and-run
   * after a plan never inherits bypass implicitly, it falls back to ask.
   */
  codexDefaultMode: 'ask' | 'bypass' | 'plan'
  // Built-in engine expert tuning (2.6.0 Engine-Sweep). Forwarded to the Rust
  // EngineTuning (whitelisted there) on every engine start/swap — Onboarding,
  // Discover, model picker and the post-offload self-heal all inherit it via
  // the api/engine chokepoint. Defaults reproduce the pre-2.6.0 argv exactly.
  /** Expert settings for the bundled llama-server (chat engine only). */
  builtinEngine: BuiltinEngineTuning
  // Phone only (src/mobile). Optional and without a default: absent means
  // off, the desktop never reads them, and they travel with a backup like
  // every other setting. They lived in localStorage of the phone shell before
  // (mobile-docs/geruest-wuensche/models.md, wish 5).
  /** Phone: ask before a model is downloaded on mobile data (E14.5). */
  mobileDownloadWifiOnly?: boolean
  /** Phone: free the loaded model when LU leaves the screen (E13.7). */
  mobileUnloadInBackground?: boolean
  // Bug BB v2.5.0 — Discord 2026-05-26. GPU vendor + indices to
  // forward as CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES /
  // ONEAPI_DEVICE_SELECTOR on next Ollama / ComfyUI spawn. "auto" + empty
  // = no env-var, runtime picks default (pre-v2.5.0 behaviour). Used on
  // multi-vendor / multi-GPU systems (e.g. a user's AMD RX 6800XT + Intel
  // Arc Pro B60 where he wants to pin the Arc).
  /** Selected GPU vendor for env-var family ("auto" | "nvidia" | "amd" | "intel"). */
  gpuVendor: 'auto' | 'nvidia' | 'amd' | 'intel'
  /** Zero-based, vendor-scoped indices of GPUs to expose. Empty = all. */
  gpuIndices: number[]
  // Feature EE v2.5.0 — VRAM hand-off for the image/video generation MCP tool.
  // When the agent generates an image/video via ComfyUI, the local text model
  // and the ComfyUI model both want the GPU. This governs whether LU evicts the
  // resident Ollama text model from VRAM for the duration of the generation
  // (then reloads it afterwards) to avoid an OOM on single-GPU machines.
  //   'auto'   — evict only when (text VRAM + estimated model footprint) won't
  //              fit in total VRAM. Unknown sizes → don't evict (default).
  //   'always' — always evict a resident local text model before generating.
  //   'never'  — never evict (accept a possible OOM; for users who manage VRAM
  //              themselves or run text + image on separate GPUs).
  // Only applies to a LOCAL Ollama text model — cloud/remote models hold no
  // local VRAM and are always skipped.
  /** VRAM exclusivity policy for image/video generation. Default 'auto'. */
  exclusiveVramMode: 'auto' | 'always' | 'never'
  /**
   * B27 (3.0.9): give ComfyUI's memory back after a render
   * (lib/free-after-render). 'idle' (default) after five minutes without a
   * new render, 'now' right after it, 'keep' never. Optional: a profile from
   * before 3.0.9 reads as the default, no store version bump.
   */
  freeAfterRender?: 'idle' | 'now' | 'keep'
  /**
   * A picture or video the chat asked for that takes longer than a few
   * seconds goes on in the background (3.0.8, A2). The turn ends, the chat can
   * be used, and the result appears in the call's own block when it is done.
   * Off: the chat waits for every generation, as before 3.0.8.
   */
  backgroundMediaTools: boolean
  /**
   * Which card each service runs on, for a machine with two or more GPUs
   * (3.0.8, A2). `chat` is the chat engine (LU Engine, Ollama), `comfy` is
   * ComfyUI. null = the card pick above (gpuVendor/gpuIndices) applies, which
   * is what a machine with one card always gets.
   */
  gpuRoles: GpuRoles
  /** ComfyUI GPU device policy (rhodium92 AMD RX 6600 XT, 2026-07-01).
   *  'auto'  — NVIDIA fast-path; on a non-NVIDIA box probe the ComfyUI python's
   *            torch and run on the GPU if it reports one (ROCm/ZLUDA), else CPU.
   *  'cpu'   — always force ComfyUI's --cpu (stable but slow).
   *  'gpu'   — never force --cpu (for DirectML / setups the probe can't confirm).
   *  Desktop-only effect — the web build points at a remote ComfyUI. */
  comfyGpuMode: 'auto' | 'cpu' | 'gpu'
  // ── v2.5.0 Codex sprint A/B/C settings (ported from the web app) ──────
  /**
   * Codex Architect/Editor split. When on, a separate `codexArchitectModel`
   * runs first to produce a structured plan (no tools, plan only); the
   * regular Codex model then applies the plan with tool access. Aider-style
   * — empirically ~30% better edit accuracy on multi-file refactors.
   */
  codexArchitectMode: boolean
  /**
   * Prefixed model name (e.g. `ollama::qwen-coder:32b`) used for the
   * Architect pass when `codexArchitectMode` is true. Empty = fall back to
   * the active Codex model. Local-first by design: the picker only
   * surfaces non-local options when `codexArchitectAllowCloud` is true.
   */
  codexArchitectModel: string
  /**
   * Explicit opt-in to allow third-party cloud endpoints (Anthropic,
   * OpenAI, OpenRouter) as the Architect model. Default false — forces
   * the user to acknowledge that planning steps would leave the machine.
   */
  codexArchitectAllowCloud: boolean
  /**
   * Repo-Map pre-fetch. When on, Codex calls the bridge `repo_map` command
   * before each turn and injects the top-N ranked files (PageRank over the
   * import graph) into the editor system prompt.
   */
  codexRepoMapEnabled: boolean
  /**
   * Top-N cap for the injected repo map. Bigger maps eat more context;
   * 20 is a balanced default for ~5k-file repos. Clamped to bridge's
   * own [1, 200] range.
   */
  codexRepoMapLimit: number
  /**
   * Auto-apply the changes a run staged when it finishes. Whether a run
   * stages at all is its mode's call (Ask stages, Bypass and Plan do not,
   * lib/codex-mode). Every diff is still recorded and visible, but the user is
   * not asked to click Apply per file, so "auto on everything" really means
   * auto (first customer feedback, Morgan 2026-07-26).
   */
  codexAutoApply: boolean
  /**
   * Code-Review mode. When on, Codex runs read-only — every `file_write`
   * and `shell_execute`-style call is blocked with a friendly message and
   * the model is steered into "inline comments only" by a switched system
   * prompt. Use for PR-pre-check runs where you do not want the agent
   * touching anything.
   */
  codexReviewMode: boolean
  /**
   * Confirm shell / code execution in the coding agent (security gate, H2).
   * The coding agent auto-runs tools unattended by design. When this is on,
   * every `shell_execute` / `code_execute` / background-shell call pauses for
   * an explicit confirm first — the mitigation for prompt-injection RCE
   * (a tool result or read file steering the model into running a command).
   * Default OFF preserves the autonomous workflow; file_write is unaffected
   * (it is path-jailed and has its own Stage mode).
   */
  codexConfirmShell: boolean
  /**
   * Opt in to confirming shell/code on LU Cloud models even when
   * `codexConfirmShell` is off. Governs BOTH surfaces (Code tab and Agent
   * mode), and rides on top of Agent's per-tool permission levels.
   *
   * Default OFF (2026-08-22, replacing the ON default this carried as
   * `codexCloudConfirmShell` since 2.5.9 and the G15a decision of 2026-08-07):
   * a cloud model follows the same rule as a local one, so Bypass really
   * bypasses and permission level auto really runs unattended. The user who
   * picks Bypass has made that decision. Turning this on brings the cloud
   * confirm back everywhere, Bypass included: that is what the opt-in is for.
   *
   * The key is new on purpose. Every profile out there has the old key
   * materialised as `true`, so reusing it would need a one-shot reset in the
   * store migration, and R1's downgrade contract forbids one-shot resets while
   * two builds share a profile. A new key with a new default needs no reset.
   */
  codexCloudConfirmOptIn: boolean
  /**
   * Shared default workspace for Codex AND Agent (Underlying refactor —
   * workspace unification). When set, both surfaces resolve relative paths
   * against this folder by default; a per-chat override wins when present.
   * Null = no default — keeps Agent prompting on first chat and Codex
   * falling back to the per-thread cwd.
   */
  defaultWorkspace: AgentWorkspace | null
  /**
   * User profile picture as a base64 data URL (downscaled to ≤256px PNG on
   * upload so it stays small in persisted state). Empty string = show the
   * default user icon. Rendered next to the user's chat / code / agent
   * messages. The AI's avatar is always the LU monogram (not user-settable).
   */
  userAvatarDataUrl: string
  // ── v9 (v2.5.3) — Model-Picker preferences ────────────────────────
  // Saved via the in-tool-call model picker's save icon ("für nächste
  // Prompts übernommen"). '' = nothing saved → the picker shows before the
  // VRAM swap on the next generation. Video keeps two slots because the
  // capability sets are disjoint: SVD/FramePack can't do T2V, Wan 1.3B
  // can't do I2V — one shared slot would silently mismatch.
  /** Preferred ComfyUI checkpoint for image generation ('' = ask). */
  preferredImageModel: string
  /** Preferred text-to-video model ('' = ask). */
  preferredVideoT2VModel: string
  /** Preferred image-to-video model ('' = ask). */
  preferredVideoI2VModel: string
}

export interface Persona {
  id: string
  name: string
  icon: string
  /** For a character card persona: built from the card on import, with the
   *  `{{char}}` / `{{user}}` macros left in. They are filled in when a chat
   *  starts (lib/character-card.ts). */
  systemPrompt: string
  isBuiltIn: boolean
  /** Set when the persona came from a character card (3.0.7). Absent on every
   *  persona from before, which keeps them loading unchanged. */
  card?: CharacterCard
  /** Small picture shown instead of the icon, today only the card's image. */
  imageDataUrl?: string
  /** GH #175: sampling values this persona brings along. Applied wherever the
   *  persona speaks (its chat, or its seat in a group); a chat's own values
   *  from the Sampling popup still win. Absent on every persona from before. */
  sampling?: SamplerValues
  /** GH #198: sampling parameters LU has no field for, sent as typed where
   *  the backend takes them (lib/custom-params.ts). A chat's own row with the
   *  same key wins. Absent on every persona from before. */
  customParams?: CustomParam[]
  /** GH #181: a short reminder sent near the end of the prompt on every turn
   *  this persona speaks (lib/persona-note.ts). Payload only, never stored
   *  in a chat. Absent on every persona from before. */
  note?: string
  /** How many messages from the end the reminder sits, 0 is the latest.
   *  Absent means the default depth. */
  noteDepth?: number
}

/**
 * Sampling values as a chat or a persona sets them (lib/sampling.ts has the
 * rules). Every field is optional: absent means "not set at this level".
 */
export interface SamplerValues {
  temperature?: number
  topP?: number
  maxTokens?: number
  topK?: number
  minP?: number
  repeatPenalty?: number
  presencePenalty?: number
  frequencyPenalty?: number
  /** The DRY sampler's multiplier, 0 is off. Only llama-server and KoboldCpp
   *  read it. */
  dryMultiplier?: number
}

/**
 * The fields of an imported character card that LU keeps. Names follow LU's
 * casing; lib/character-card.ts maps them to and from the card's own
 * snake_case keys.
 */
export interface CharacterCard {
  description: string
  personality: string
  scenario: string
  /** The greeting a new chat opens with. */
  firstMessage: string
  exampleMessages: string
  alternateGreetings: string[]
  /** The card's own system prompt, '' for the standard sentence. */
  systemPrompt: string
  postHistoryInstructions: string
  /** Shown in the persona panel, never sent to the model. */
  creatorNotes: string
  creator?: string
  characterVersion?: string
  tags?: string[]
  /** Kept as is so an export hands the card back with them. */
  extensions?: Record<string, unknown>
}

// Voice settings (sttEnabled, ttsEnabled, ttsVoice, ttsRate, ttsPitch) are
// managed in src/stores/voiceStore.ts via the dedicated Zustand voice store
// with persistence.

/** One card, as the Hardware tab detected it. `index` is vendor-scoped, in the
 *  order the vendor tool lists the cards (nvidia-smi: PCI bus order). */
export interface GpuRef {
  vendor: 'nvidia' | 'amd' | 'intel'
  index: number
  /** The card's name, kept to find it again and for the readout. */
  name: string
}

export interface GpuRoles {
  chat: GpuRef | null
  comfy: GpuRef | null
}
