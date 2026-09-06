import type { AgentWorkspace } from './agent-workspace'
import type { EffortLevel } from '../lib/effort'

export type SearchProvider = 'auto' | 'brave' | 'tavily'

export type CavemanMode = 'off' | 'lite' | 'full' | 'ultra'

export type AppMode = 'local' | 'cloud'

/** Expert tuning for the bundled llama-server. Mirrors Rust `EngineTuning`
 *  (camelCase over IPC); values are whitelisted on the Rust side. */
export interface BuiltinEngineTuning {
  /** `--ctx-size`. 0 = app default (8192). */
  ctx: number
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
  /** One-time Cloud onboarding (David 2026-07-10): the FIRST successful flip
   *  to Cloud shows a short what-changes walkthrough; after that the switch
   *  flips silently. Persisted so it never re-triggers. */
  /** Cloud discovery inside Local mode (2.5.8): locked Upscale/Erase tabs in
   *  Create, hosted-model rows in the chat + Create pickers, each opening a
   *  small "runs on LU Cloud" sheet. Teasers never block a local flow and
   *  never show in cloud mode. Off = Local mode shows zero Cloud surfaces;
   *  the sheet's "Hide Cloud features" link and Settings both flip this. */
  cloudTeasersEnabled: boolean
  /** Master switch for personas. When off, new chats get no persona system
   *  prompt (raw model). Default true. Ported from the uselu web companion. */
  personasEnabled: boolean
  thinkingEnabled: boolean
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
   * Chat-Tools (v2.5.3, David 2026-06-11). When on (default), PLAIN chat can
   * use a curated set of five tools — web_search, web_fetch, file_write,
   * image_generate, video_generate — without the user flipping the full Agent
   * toggle. A lightweight intent detector routes only tool-worthy messages
   * through the agent executor with that restricted allow-list + a chat-style
   * prompt; ordinary conversation stays on the plain path. Off = plain chat is
   * pure text (the pre-v2.5.3 behaviour); the full Agent toggle still works.
   */
  chatToolsEnabled: boolean
  cavemanMode: CavemanMode
  searchProvider: SearchProvider
  braveApiKey: string
  tavilyApiKey: string
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
   * they stop it (David 2026-07-25). The stop button is the brake, not a cap.
   */
  loopMaxPasses: number
  /** Override for the HuggingFace GGUF download directory. Empty = auto-detect from active openai-compat provider (e.g. LM Studio models folder). */
  hfDownloadPathOverride: string
  // Generation timeouts (Bug P v2.4.7 — ake0n_official Discord 2026-05-19,
  // Intel UHD CPU-only setup hit the 20-min cap at sampling 9/25 on a 1024px
  // Juggernaut-XL gen).
  /** Image generation timeout in minutes. Default 20. */
  imageGenTimeoutMinutes: number
  /** Video generation timeout in minutes. Default 60. */
  videoGenTimeoutMinutes: number
  // Bug AA v2.5.0 — Kj103x Discord 2026-05-27. Ollama defaults `num_ctx` to
  // 2048, which silently caps RAG payloads and long-turn chats even on
  // models that support way more. This override is forwarded to Ollama
  // chat/chatWithTools as `options.num_ctx`. 0 = use Ollama default
  // (recommended unless you have a specific reason to override). Other
  // providers ignore this field — they manage context themselves.
  /** User-side context-window override (forwarded as Ollama's num_ctx). 0 = auto. */
  contextWindowOverride: number
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
   * Auto-compact trigger, as a fraction of the send window. 2.6.8.
   *
   * 0 IS THE FEATURE SWITCH, not a tuning value. Owner decision 2026-09-02,
   * "einstellbar sonst aus": auto-compact replaces conversation history with a
   * model's summary of it, and when that summary is wrong the user loses work
   * silently. Nothing fires until someone sets a number here.
   *
   * Valid range [0.3, 0.95]; anything outside — including a stored profile
   * from before this field existed, where it arrives as `undefined` — reads as
   * off. The range and the reading both live in lib/compact-trigger.ts
   * (MIN_THRESHOLD / MAX_THRESHOLD / usableThreshold), so this is a value, not
   * a second rule.
   *
   * The manual `/compact` command does NOT consult this. It is the user asking
   * for one compaction on purpose; the threshold governs only the automatic one.
   */
  autoCompactThreshold: number
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
  // Bug BB v2.5.0 — BobbyT Discord 2026-05-26. GPU vendor + indices to
  // forward as CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES /
  // ONEAPI_DEVICE_SELECTOR on next Ollama / ComfyUI spawn. "auto" + empty
  // = no env-var, runtime picks default (pre-v2.5.0 behaviour). Used on
  // multi-vendor / multi-GPU systems (e.g. BobbyT's AMD RX 6800XT + Intel
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
  /** ComfyUI GPU device policy (rhodium92 AMD RX 6600 XT, 2026-07-01).
   *  'auto'  — NVIDIA fast-path; on a non-NVIDIA box probe the ComfyUI python's
   *            torch and run on the GPU if it reports one (ROCm/ZLUDA), else CPU.
   *  'cpu'   — always force ComfyUI's --cpu (stable but slow).
   *  'gpu'   — never force --cpu (for DirectML / setups the probe can't confirm).
   *  Desktop-only effect — the web build points at a remote ComfyUI. */
  comfyGpuMode: 'auto' | 'cpu' | 'gpu'
  // ── v2.5.0 Codex sprint A/B/C settings (ported from uselu) ──────
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
   * Multi-File Stage-and-Approve. When on, Codex `file_write` calls don't
   * touch the disk — they queue as "pending changes" the user reviews and
   * applies (or rejects) per-file.
   */
  codexStageMode: boolean
  /**
   * Auto-apply staged changes when the run finishes. Only meaningful while
   * codexStageMode is on: every diff is still recorded and visible, but the
   * user is not asked to click Apply per file — "auto on everything" then
   * really means auto (first customer feedback, Morgan 2026-07-26).
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
   * Default OFF (David 2026-08-22, replacing the ON default this carried as
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
  systemPrompt: string
  isBuiltIn: boolean
}

// Voice settings (sttEnabled, ttsEnabled, ttsVoice, ttsRate, ttsPitch) are
// managed in src/stores/voiceStore.ts via the dedicated Zustand voice store
// with persistence.
