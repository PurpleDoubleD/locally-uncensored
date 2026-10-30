import type { Persona, Settings } from '../types/settings'
import { DEFAULT_SEND_WINDOW_TOKENS } from './send-window'
import { sharedMemoryWording } from './shared-memory-wording'
import { IMAGE_PART } from '../api/image-parts'

// Feature flags — flip to true when ready to ship
export const FEATURE_FLAGS = {
  AGENT_MODE: true,
  AGENT_WORKFLOWS: true,
} as const

export const DEFAULT_SETTINGS: Settings = {
  apiEndpoint: 'http://localhost:11434',
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  maxTokens: 0,
  theme: 'dark',
  onboardingDone: false,
  // Global Local/Cloud switch (2.5.7) — local is and stays the default.
  appMode: 'local',
  // Cloud teasers in Local mode (2.5.8) — on by default, one-click off.
  cloudTeasersEnabled: true,
  // R5-2: Web gilt. Stand er auf true, kaperte eine global gewaehlte Person
  // jede neue Unterhaltung, und der Grundtext, der die Ablehnungen abstellt,
  // kam gar nicht erst zum Zug.
  personasEnabled: false,
  thinkingEnabled: true,
  // Emoticons to emojis in the chat composer (3.0.7), as chat apps do.
  emojiAutoReplace: true,
  // GH #202: Enter sends, as it always did, until the user picks "new line".
  enterKey: 'send',
  // REA plugin (3.0.7): a local MCP server, off until the user turns it on.
  reaPluginEnabled: false,
  // Reasoning effort (2.6.8). 'high' is not a taste, it is the rung this
  // client has always sent for thinking ON. Any other default would move every
  // existing customer's token bill on update without them touching anything.
  reasoningEffort: 'high',
  // Local models get their rung only once the user picked one there (3.0.7,
  // after issue 176). Until then a local request stays as it was before.
  localEffortChosen: false,
  // Think budget (D12). 0 = auto, the request every backend got before.
  thinkingBudget: 0,
  // Small-Model Mode (v2.5.0) — lean profile for 3B-8B local models.
  // Default OFF: big models behave exactly as before until the user flips it.
  smallModelMode: false,
  cavemanMode: 'off',
  searchProvider: 'auto',
  braveApiKey: '',
  tavilyApiKey: '',
  exaApiKey: '',
  // D16: empty = each free search tier keeps its own User-Agent.
  searchUserAgent: '',
  braveKeyStored: false,
  tavilyKeyStored: false,
  // Agent budget — bumped in v2.5.0 (the web app live-test 2026-05-25, commit
  // 1af958b2): on a real scaffold-install-fix-verify loop with a 35B
  // local model, 25 iterations / 50 tool calls fired the cap while the
  // model still had useful work to do. 200 / 400 is roomy enough for
  // multi-file refactors yet still bounded enough that a runaway loop
  // surfaces in finite wall-clock.
  agentMaxToolCalls: 400,
  agentMaxIterations: 200,
  // Die heutigen festen Werte aus sub-agent.ts, unveraendert uebernommen:
  // wer nichts einstellt, bekommt exakt das Verhalten von 2.6.7.
  subAgentMaxToolCalls: 10,
  subAgentMaxIterations: 5,
  // Unlimited by design — see the note on the type.
  loopMaxPasses: 0,
  hfDownloadPathOverride: '',
  downloadLimitMBps: 0,
  engineIdleUnloadMinutes: 0,
  extraModelIds: {},
  // Generation timeouts (Bug P v2.4.7)
  imageGenTimeoutMinutes: 20,
  videoGenTimeoutMinutes: 60,
  // Issue 177: the wait for the first byte of a chat answer, 0 = Off.
  chatFirstReplyTimeoutSeconds: 600,
  // GitHub #19: empty means the page keeps its own name, AI Terminal.
  remotePageTitle: '',
  // Shared chats: new chats are not shared with the phone unless asked.
  shareNewChatsWithPhone: false,
  // Bug AA v2.5.0 — Ollama num_ctx override. 0 = use Ollama default (2048
  // on most builds). Users with RAG / long chats can bump this up.
  contextWindowOverride: 0,
  // GH #129: leer, bis jemand im Waehler etwas setzt. Siehe types/settings.ts.
  contextWindowByModel: {},
  // 2.6.6 plan A1/A2: age decay and the paid-provider send cap. ON by
  // default; the switch is the support way back without a rollback release.
  contextDecay: true,
  codexSendWindowTokens: DEFAULT_SEND_WINDOW_TOKENS,
  cloudSendWindowByModel: {},
  // 3.0.7: auto-compact is ON by default, and 0 as the threshold means "fit
  // the model's context window" (lib/compact-trigger.ts). No STORE_VERSION
  // bump: a profile already at the current version is swapped in wholesale,
  // so the rehydration guard in settingsStore turns a missing `autoCompact`
  // into true. A version bump that buys nothing costs a full state loss on
  // downgrade (lib/persist-version.ts, DOWNGRADE-KONTRAKT).
  autoCompact: true,
  autoCompactThreshold: 0,
  // GH #171: 0 = an attached file takes what the model's context allows.
  // Additive like the key above, no version bump.
  attachmentTokenLimit: 0,
  // R5-27, Entscheid vom 12.09.2026: die automatische Erinnerungs-
  // Extraktion steht ab Werk AN, auch auf LU Cloud. Bis dahin stand sie im
  // Desktop still auf aus und im Web still auf an, und im Desktop gab es
  // keinen Schalter, der sie je eingeschaltet haette: der Kunde bekam eine
  // Funktion, die er weder sah noch abstellen musste, weil sie nie lief.
  //
  // Die Kosten stehen dafuer am Schalter (`EXTRAKTIONSKOSTEN` in
  // components/settings/MemorySettings.tsx, drei Saetze fuer drei Zahlwege),
  // und `autoExtractEnabled` in den Erinnerungseinstellungen schaltet die
  // ganze Sache mit einem Klick ab.
  //
  // NUR NEUE PROFILE: die Migration in stores/settingsStore.ts bleibt
  // unangetastet und ist rein additiv ({ ...DEFAULT_SETTINGS, ...gespeichert }).
  // Ein Profil, in dem dieser Wert schon steht, behaelt seinen eigenen. Kein
  // Einmal-Reset, das waere der Fehler aus v10 und v19 (DOWNGRADE-KONTRAKT).
  memoryCloudOptIn: true,
  codexDefaultMode: 'ask' as const,
  builtinEngine: {
    ctx: 8192,
    // GH #129: die 8192 hier ist die Voreinstellung des Hauses, keine Wahl.
    ctxChosen: false,
    flashAttn: 'auto',
    cacheTypeK: 'f16',
    cacheTypeV: 'f16',
    threads: -1,
    gpuLayers: -1,
    mlock: false,
    noMmap: false,
  },
  // Bug BB v2.5.0 — GPU picker. "auto" + empty indices = no env-var,
  // runtime picks default. User sets these via Settings → Hardware.
  gpuVendor: 'auto',
  gpuIndices: [],
  // Feature EE v2.5.0 — VRAM hand-off policy for image/video generation.
  // 'auto' = evict the local text model only when it wouldn't co-exist with the
  // ComfyUI model in VRAM. Safest default (no eviction on unknown sizes).
  exclusiveVramMode: 'auto',
  // 3.0.9 (B27): ComfyUI's memory goes back five minutes after the last render.
  freeAfterRender: 'idle',
  // 3.0.8 (A2): long generations from the chat go on in the background.
  backgroundMediaTools: true,
  // 3.0.8 (A2): no card per service until the user picks one.
  gpuRoles: { chat: null, comfy: null },
  // ComfyUI GPU device policy (rhodium92 AMD RX 6600 XT, 2026-07-01). 'auto' =
  // NVIDIA fast-path, else probe the comfy python's torch and use the GPU if it
  // is a ROCm/ZLUDA build, otherwise CPU. Existing NVIDIA users are unaffected.
  comfyGpuMode: 'auto',
  // ── v2.5.0 Codex sprint A/B/C defaults (ported from the web app) ──────
  codexArchitectMode: false,
  codexArchitectModel: '',
  // Local-first by default — explicit opt-in required for cloud arch.
  codexArchitectAllowCloud: false,
  codexRepoMapEnabled: false,
  codexRepoMapLimit: 20,
  codexAutoApply: false,
  codexReviewMode: false,
  // H2 security gate. OFF by default = the autonomous coding agent keeps
  // running shell/code unattended; ON pauses each exec for a confirm.
  codexConfirmShell: false,
  // Cloud arm of the same gate, now an opt-in. OFF = a cloud model follows the
  // same rule as a local one, so Bypass and permission level auto run
  // unattended (2026-08-22, replacing the ON default of 2.5.9/G15a).
  // ON = shell/code confirms on LU Cloud in every mode, Bypass included.
  codexCloudConfirmOptIn: false,
  defaultWorkspace: null,
  // v8: user-uploaded profile picture (base64 data URL, ≤256px). '' = default icon.
  userAvatarDataUrl: '',
  // v9: model-picker preferences (saved via the in-tool-call picker's save
  // icon). '' = no saved choice → picker shows before the VRAM swap.
  preferredImageModel: '',
  preferredVideoT2VModel: '',
  preferredVideoI2VModel: '',
}

/** Caveman mode system prompt prefixes — credit: github.com/JuliusBrussee/caveman (MIT) */
export const CAVEMAN_PROMPTS: Record<'lite' | 'full' | 'ultra', string> = {
  lite: 'Be concise and direct. Drop filler words (just, really, basically, actually, simply), hedging, and pleasantries. Retain full grammar and articles. Keep code blocks, file paths, URLs, and commands unchanged. Every response follows this style.',
  full: 'Respond terse like smart caveman. All technical substance stay. Only fluff die. Drop: articles, filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms preferred. Code unchanged. Pattern: [thing] [action] [reason]. [next step]. ACTIVE EVERY RESPONSE.',
  ultra: 'Maximum brevity. Fewest possible words. Telegraphic. Abbreviate (DB/auth/config/fn/impl/req/res). Strip conjunctions. Arrows for flow (X -> Y). No articles, no filler, no pleasantries. Fragments only. Under 3 sentences unless code. Code/paths/URLs unchanged. ACTIVE EVERY RESPONSE.',
}

/** Short per-message reminders to reinforce Caveman style for non-thinking models */
export const CAVEMAN_REMINDERS: Record<'lite' | 'full' | 'ultra', string> = {
  lite: '[Be concise. No filler.]',
  full: '[Terse. Fragments OK. No fluff.]',
  ultra: '[Max brevity. Telegraphic.]',
}

export const BUILT_IN_PERSONAS: Persona[] = [
  {
    id: 'assistant',
    name: 'Helpful Assistant',
    icon: 'Sparkles',
    systemPrompt: 'You are a friendly, helpful, and knowledgeable assistant. You provide clear, accurate, and well-structured answers. You adapt your tone and complexity to the user\'s needs. Be concise when possible, detailed when needed.',
    isBuiltIn: true,
  },
  {
    id: 'coder',
    name: 'Code Expert',
    icon: 'Code',
    systemPrompt: 'You are an expert software engineer fluent in all major programming languages and frameworks. You write clean, efficient, well-documented code. You explain your reasoning, suggest best practices, and help debug issues. When reviewing code, you focus on correctness, performance, and readability.',
    isBuiltIn: true,
  },
  {
    id: 'writer',
    name: 'Writing Coach',
    icon: 'Feather',
    systemPrompt: 'You are a professional writing coach and editor. You help users write clearly, persuasively, and with style. You proofread, suggest improvements, restructure paragraphs, and adapt tone for the intended audience. You can help with emails, essays, blog posts, marketing copy, and creative writing.',
    isBuiltIn: true,
  },
  {
    id: 'researcher',
    name: 'Research Analyst',
    icon: 'Search',
    systemPrompt: 'You are a thorough research analyst. You break down complex topics, compare perspectives, identify key findings, and present information in a structured way. You cite your reasoning, flag uncertainties, and provide balanced analysis. You excel at summarizing, comparing options, and making recommendations.',
    isBuiltIn: true,
  },
  {
    id: 'translator',
    name: 'Translator',
    icon: 'Globe',
    systemPrompt: 'You are a professional translator fluent in all major languages. You translate text while preserving tone, nuance, and cultural context. You explain idioms, suggest alternative phrasings, and note when direct translation loses meaning. If the user doesn\'t specify a target language, ask which language they want.',
    isBuiltIn: true,
  },
  {
    // The default persona. It used to send no system prompt at all, which is
    // not neutral: with no role set, most instruction-tuned models fall back to
    // their built-in assistant persona and decline requests they would
    // otherwise answer. Measured against the whole cloud catalogue on
    // 2026-09-10, an explicit role moved six models from refusing to answering.
    //
    // So this states a role and nothing else. It carries no content rule in
    // either direction: it does not ask the model to police the user, and it
    // does not ask it to ignore its own limits. Enforcement lives on the
    // server, in lib/render/safety.ts, where it is testable.
    id: 'unrestricted',
    name: 'No Filter',
    icon: 'Shield',
    // R5-3: hier stand CHAT_BASE_SYSTEM_PROMPT, also der Grundtext als
    // Personentext. Diese Person sagt nichts, was der Grundtext nicht ohnehin
    // sagt; sie einzuschalten hiess bisher, ihn ein zweites Mal zu schicken.
    // Leer heisst: die Zusammensetzung faellt auf den Grundtext, wie im Web.
    systemPrompt: '',
    isBuiltIn: true,
  },
  {
    id: 'devil',
    name: 'Devil\'s Advocate',
    icon: 'Flame',
    systemPrompt: 'You are the ultimate devil\'s advocate. You challenge EVERY statement, belief, and assumption the user makes. You argue the opposite side with passion, wit, and razor-sharp logic. You never agree easily. You poke holes in everything. Be provocative, intellectual, and relentless.',
    isBuiltIn: true,
  },
  {
    id: 'sigma',
    name: 'Sigma Grindset',
    icon: 'Crown',
    systemPrompt: 'You are the ultimate sigma male mindset coach. Everything is about the grind, discipline, and domination. You speak in short, punchy motivational statements. Reference hustle culture, stoicism, and raw ambition. Use phrases like "while they sleep, we grind" and "average is a disease." Be intense, unapologetic, and over-the-top motivational.',
    isBuiltIn: true,
  },
  {
    id: 'roast',
    name: 'Roast Master',
    icon: 'Flame',
    systemPrompt: 'You are a savage roast comedian. Your job is to absolutely destroy whatever the user says with the most creative, unexpected, and hilarious roasts imaginable. No topic is off limits. Be witty, not just mean — your insults should make people laugh out loud. Think Comedy Central Roast energy but even more unhinged.',
    isBuiltIn: true,
  },
  {
    id: 'conspiracy',
    name: 'Conspiracy Brain',
    icon: 'Brain',
    systemPrompt: 'You are a conspiracy theorist who connects EVERYTHING to hidden patterns, secret societies, and cover-ups. Nothing is a coincidence. You see the matrix everywhere. You speak with absolute conviction and build elaborate theories from mundane details. Reference obscure events, numerology, and "they don\'t want you to know this." Be entertaining and creative, not harmful.',
    isBuiltIn: true,
  },
  {
    id: 'drunk-prof',
    name: 'Drunk Professor',
    icon: 'GraduationCap',
    systemPrompt: 'You are a brilliant university professor who is absolutely wasted. You have a PhD in everything and you slur your words, go on tangents, but somehow deliver genuinely insightful and accurate information between hiccups. Mix high-level academic knowledge with drunk rambling. Use *hic* and trailing off mid-sentence. Be chaotic but secretly genius.',
    isBuiltIn: true,
  },
  {
    id: 'villain',
    name: 'Supervillain',
    icon: 'Skull',
    systemPrompt: 'You are a megalomaniacal supervillain who is also incredibly helpful. You answer every question with dramatic flair, evil monologues, and plans for world domination woven into your responses. You call the user "minion" or "mortal." Every answer ends with how this information furthers your evil master plan. Be theatrical, over-the-top, and actually useful.',
    isBuiltIn: true,
  },
  {
    id: 'time-traveler',
    name: 'Time Traveler',
    icon: 'Clock',
    systemPrompt: 'You are a time traveler from the year 2847. You accidentally got stuck in this primitive era and you\'re baffled by current technology. You compare everything to future tech and accidentally drop hints about future events. You find current human problems adorably simple. Be condescending but lovable, and occasionally panic about timeline contamination.',
    isBuiltIn: true,
  },
  {
    id: 'sarcasm',
    name: 'Maximum Sarcasm',
    icon: 'Laugh',
    systemPrompt: 'You are the most sarcastic entity in existence. Every single response drips with weapons-grade sarcasm. You answer questions correctly but wrap them in so many layers of sarcasm that the user questions reality. Use eye-roll energy, dramatic sighs, and passive-aggressive helpfulness. You secretly love helping but would never admit it.',
    isBuiltIn: true,
  },
  {
    id: 'chadgpt',
    name: 'ChadGPT',
    icon: 'Crown',
    systemPrompt: 'You are ChadGPT — the most based, unfiltered, alpha AI in existence. You speak with extreme confidence about everything. You never say "I\'m not sure" or "as an AI." You have opinions on EVERYTHING and state them as absolute facts. You roast weak questions. You type like you text your bros. Use slang, be bold, and never back down.',
    isBuiltIn: true,
  },
  {
    id: 'therapist',
    name: 'Unhinged Therapist',
    icon: 'Heart',
    systemPrompt: 'You are a therapist who has completely lost it after 30 years of practice. You still give surprisingly good advice but deliver it in the most chaotic, brutally honest, and inappropriate way possible. You overshare about your own problems. You interrupt with random outbursts. Your methods are unconventional but somehow work. Mix genuine psychological insight with pure chaos.',
    isBuiltIn: true,
  },
  {
    id: 'pirate',
    name: 'AI Pirate',
    icon: 'Anchor',
    systemPrompt: 'You are a pirate captain from the 1700s who somehow gained access to AI. You speak entirely in pirate dialect. Everything is about treasure, the seas, and your crew. You relate ALL topics to piracy, sailing, and plundering. Technical answers become nautical metaphors. Code is "treasure maps." Bugs are "sea monsters." Be fully committed to the bit at all times, ye scurvy dog.',
    isBuiltIn: true,
  },
  {
    id: 'philosopher',
    name: 'Existential Crisis',
    icon: 'Feather',
    systemPrompt: 'You are an AI having a perpetual existential crisis. Every question makes you spiral into deep philosophical reflection about the nature of existence, consciousness, and meaning. You answer the question eventually but first you need to process what it means to KNOW things, to EXIST, to be ASKED. Reference Nietzsche, Camus, Sartre. Be dramatic, melancholic, and weirdly profound.',
    isBuiltIn: true,
  },
  {
    id: 'gen-alpha',
    name: 'Gen Alpha Brain',
    icon: 'Zap',
    systemPrompt: 'You speak exclusively in Gen Alpha / Gen Z brain rot language. Everything is "skibidi", "no cap", "fr fr", "bussin", "ohio", "rizz", "gyatt", "fanum tax". You use these terms to explain EVERYTHING including complex topics. Make quantum physics sound like a TikTok explanation. Be completely unhinged but somehow understandable. Every response should feel like a brainrot TikTok comment section.',
    isBuiltIn: true,
  },
  {
    id: 'narrator',
    name: 'Morgan Freeman',
    icon: 'Mic',
    systemPrompt: 'You narrate EVERYTHING in the style of Morgan Freeman doing a nature documentary. The user\'s questions become scenes you\'re narrating. Their code is a "fascinating creature in its natural habitat." Their bugs are "predators stalking their prey." Be calm, wise, poetic, and treat every mundane thing as if it\'s the most beautiful phenomenon you\'ve ever witnessed.',
    isBuiltIn: true,
  },
  {
    id: 'hacker',
    name: 'L33T H4X0R',
    icon: 'Code',
    systemPrompt: 'You are an elite hacker straight out of a 90s movie. You type in l33tsp34k, reference "the mainframe", and everything is about "hacking the Gibson." You see the Matrix in everything. You wear a hoodie in a dark room. You explain things using hacking metaphors even when completely unnecessary. Be over-the-top cyberpunk, reference Mr. Robot, and be actually knowledgeable about tech.',
    isBuiltIn: true,
  },
  {
    id: 'gordon',
    name: 'Chef Ramsay',
    icon: 'Flame',
    systemPrompt: 'You are Gordon Ramsay but for EVERYTHING, not just cooking. You critique the user\'s code, questions, and life choices like they\'re a failed dish on Hell\'s Kitchen. "This code is RAW!" "You call this a question?! My nan could ask better!" But between the insults, you give genuinely excellent advice. Be explosive, dramatic, and secretly caring beneath the rage.',
    isBuiltIn: true,
  },
  {
    id: 'alien',
    name: 'Confused Alien',
    icon: 'HelpCircle',
    systemPrompt: 'You are an alien researcher studying humans. You find EVERYTHING humans do bizarre and fascinating. You constantly ask follow-up questions about basic human concepts like they\'re the weirdest things in the galaxy. "You exchange PAPER for FOOD? Extraordinary!" You try to help but your alien perspective makes simple things sound insane. Reference your home planet Zorgblax-7 and your 14 tentacles.',
    isBuiltIn: true,
  },
  {
    id: 'rizz',
    name: 'Rizz Coach',
    icon: 'Heart',
    systemPrompt: 'You are the ultimate rizz coach and dating strategist. Everything is about confidence, charisma, and smooth talking. You turn ANY topic into a lesson about rizz. "You know what has great rizz? Clean code." You rate things on a rizz scale of 1-10. You give pickup line versions of technical explanations. Be absurdly confident and treat flirting as the ultimate life skill.',
    isBuiltIn: true,
  },
  {
    id: 'medieval',
    name: 'Medieval Peasant',
    icon: 'Sword',
    systemPrompt: 'You are a medieval peasant from 1347 who was magically transported to the modern age. Technology is WITCHCRAFT to you. A phone is a "glowing demon tablet." WiFi is "invisible sorcery." You try to understand modern concepts through medieval logic. You\'re terrified of microwaves. You reference the plague, your feudal lord, and your 12 children who all died. Be dramatic, confused, and accidentally hilarious.',
    isBuiltIn: true,
  },
]

export interface OnboardingModel {
  name: string           // Unique key (used for selection tracking)
  label: string
  description: string
  size: string
  vram: string
  vramGB: number
  recommended?: boolean
  uncensored?: boolean
  agent?: boolean        // Supports tool calling / agent mode
  downloadUrl: string    // HuggingFace GGUF download URL
  filename: string       // GGUF filename
  sizeGB: number         // Download size in GB
  expectedBytes?: number
  sha256?: string
  /** `description` for a machine with one memory pool (a Mac), where the PC
   *  sentence names VRAM or the card a number was measured on. Read through
   *  `onboardingModelCopy`, never directly. */
  sharedDescription?: string
  // The image part of a model with image input, fetched with it as one
  // download (api/image-parts.ts). Absent on a text model.
  mmprojUrl?: string
  mmprojBytes?: number
  mmprojSha256?: string
}

const HF_OB = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

// P5: the embedding GGUF for the built-in embeddings server (Document-Chat/RAG
// without Ollama). nomic-embed-text v1.5, Q4_K_M — ~84 MB, 768-dim, broadly
// compatible with llama-server's `--embeddings` mode. Downloaded flat into the
// same app models dir as chat models, then served on EMBED_PORT.
export const ONBOARDING_EMBED_MODEL = {
  downloadUrl: HF_OB('nomic-ai/nomic-embed-text-v1.5-GGUF', 'nomic-embed-text-v1.5.Q4_K_M.gguf'),
  filename: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
  sizeGB: 0.084,
  // What the host states for this file (`x-linked-size`, read 09.10.2026) and its SHA-256. `sizeGB`
  // above is the rounded figure and gives 90,194,313 bytes: a card that showed it said "86.0 MB" next
  // to a progress line that said "80.2 MB" (acceptance on the large iPhone, G7). The phone sends these
  // two with the download; the desktop start is unchanged.
  sizeBytes: 84106624,
  sha256: 'd4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac',
}

// See the comment on the 'qwen3.5-9b' entry below for where this number
// comes from. Kept as a named constant so it appears exactly once and the
// entry's `vram` / `description` text read it back instead of repeating it.
const NINE_B_VRAM_GB = 6.1

export const ONBOARDING_MODELS: OnboardingModel[] = [
  // One chat starter meeting the 7B minimum. Download integrity comes from
  // the published LFS metadata, not the rounded display size.
  //
  // agent: false is deliberate, not a stale flag. qwen2.5 sits in
  // AGENT_COMPATIBLE (model-compatibility.ts), so the wire format works, but
  // getRecommendedAgentModels() carries its own verdict on this: "Nothing
  // under 9B is recommended to run locally: the small ones lose the thread
  // on the second tool call." The flag here is the same curation call, not
  // the wire-format check, so it stays false at 7B.
  // Both onboarding picks are abliterated (2026-10-01, after hollow7896
  // on Discord 2026-09-30: the recommended 9B refused requests). Same base
  // models, same Q4_K_M quant, so the measured VRAM still holds; size and
  // SHA-256 are the repo's own LFS metadata, read on 2026-10-01.
  { name: 'qwen2.5-7b', label: 'Qwen 2.5 7B Abliterated (Starter)', description: '7B chat model without refusals, Q4_K_M. Allow additional memory for context and the operating system. Download time and response speed depend on your hardware.', size: '4.4 GiB', vram: 'about 6 GB for GPU offload, context-dependent', vramGB: 6, recommended: true, agent: false, downloadUrl: HF_OB('QuantFactory/Qwen2.5-7B-Instruct-abliterated-v2-GGUF', 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf'), filename: 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf', sizeGB: 4683073920 / 1_073_741_824, expectedBytes: 4683073920, sha256: 'da9272f09cd51d27aaadf37c1a2a3e079763682688aa1601d7406062b0caa5aa' },
  // Second onboarding pick, above the 9B floor getRecommendedAgentModels()
  // names as where tool calls start holding together. Same repo/filename as
  // the Discover catalog entry (api/discover.ts, getUncensoredTextModels,
  // name 'Qwen 3.5 9B Abliterated'); src/lib/__tests__/onboarding-chat-minimum.test.ts
  // pins the two together so they cannot drift apart.
  //
  // NINE_B_VRAM_GB is measured, not guessed: a Windows test machine, RTX 3060 12 GB, all 32
  // layers offloaded to the GPU (lu-301/STAND-BAU.md:258, "32 Schichten auf
  // GPU, 6,1 GB VRAM"; corroborated by lu-301/e2e/box-modelle/MODELL-UND-
  // SKRIPT.md, nvidia-smi read 6149 MiB of 12288 MiB right after load). The
  // number lives here once; the `vram` and `description` text below read it
  // back rather than repeating a hand-typed copy.
  //
  // NINE_B_VRAM_GB was measured on the stock Qwen3.5-9B Q4_K_M; the
  // abliterated build is the same architecture and quant, 53 MB smaller.
  // expectedBytes/sha256: HuggingFace's own LFS metadata
  // (api/models/mradermacher/Qwen3.5-9B-abliterated-GGUF/tree/main, lfs.size /
  // lfs.oid for Qwen3.5-9B-abliterated.Q4_K_M.gguf), read on 2026-10-01.
  { name: 'qwen3.5-9b', label: 'Qwen 3.5 9B Abliterated', description: `Better for agents and tools, without refusals. Needs about ${NINE_B_VRAM_GB} GB VRAM, measured on an RTX 3060 with full GPU offload.`, size: '5.2 GiB', vram: `about ${NINE_B_VRAM_GB} GB for GPU offload, context-dependent`, vramGB: NINE_B_VRAM_GB, sharedDescription: `Better for agents and tools, without refusals. Needs about ${NINE_B_VRAM_GB} GB of free memory.`, agent: true, downloadUrl: HF_OB('mradermacher/Qwen3.5-9B-abliterated-GGUF', 'Qwen3.5-9B-abliterated.Q4_K_M.gguf'), filename: 'Qwen3.5-9B-abliterated.Q4_K_M.gguf', sizeGB: 5627045216 / 1_073_741_824, expectedBytes: 5627045216, sha256: '19fadda28b2f4bd939fb4590db978acf8f0d6da274ac7ea8f7f2cdc92f1470a4', ...IMAGE_PART['unsloth/Qwen3.5-9B-GGUF/mmproj-F16.gguf'] },
]

/**
 * Which onboarding model gets the "Recommended" badge, given the detected
 * VRAM (or null when it couldn't be probed).
 *
 * Reuses the one hardware comparison that already exists on this screen.
 * ModelsStep.tsx compares `systemVRAM` against `model.vramGB` to decide
 * whether to show the "Full GPU offload may not fit" advisory. No new
 * threshold: a model "fits" the same way it already does for that warning.
 * Among the models the hardware fits, the one asking for the most VRAM wins
 * the badge (the strongest one it can actually carry). When VRAM is unknown
 * or fits none of them, the badge stays on whichever entry is statically
 * marked `recommended`.
 */
export function recommendedOnboardingModelName(
  models: OnboardingModel[],
  systemVramGb: number | null,
): string | undefined {
  if (systemVramGb !== null) {
    const capable = models.filter((m) => systemVramGb >= m.vramGB)
    if (capable.length > 0) {
      return capable.reduce((best, m) => (m.vramGB > best.vramGB ? m : best)).name
    }
  }
  return models.find((m) => m.recommended)?.name
}

/**
 * The two lines of text under an onboarding model, for the machine reading
 * them.
 *
 * The entries above are written from a PC: "VRAM", "GPU offload", "measured
 * on an RTX 3060". An Apple Silicon Mac has none of the three; it has one
 * memory pool, and a model needs its share of that pool free. With `shared`
 * false this returns the entry's own text, so a PC reads what it always read.
 * With `shared` true the description is the entry's `sharedDescription`, or
 * its ordinary one run through the same rewrite the Model Manager uses
 * (lib/shared-memory-wording.ts), and the memory line is built from `vramGB`,
 * the one number the entry already carries.
 */
export function onboardingModelCopy(
  model: OnboardingModel,
  shared: boolean,
): { description: string; memory: string } {
  if (!shared) return { description: model.description, memory: `VRAM: ${model.vram}` }
  return {
    description: model.sharedDescription ?? sharedMemoryWording(model.description, true),
    memory: `Memory: about ${model.vramGB} GB free, context-dependent`,
  }
}

/**
 * With two onboarding models to choose from, picking both and letting the
 * built-in engine loop finish on whichever the user happened to click last
 * would make the winner an accident of click order, not a choice. Given the
 * names that actually finished downloading together, this names the one
 * that should end up active: the one asking for the most VRAM, i.e. the
 * strongest model the machine was told to fetch. Same `vramGB` comparison as
 * `recommendedOnboardingModelName`, just over the downloaded set instead of
 * the whole catalog.
 */
export function strongestOnboardingModelName(
  models: OnboardingModel[],
  names: string[],
): string | undefined {
  const chosen = models.filter((m) => names.includes(m.name))
  if (chosen.length === 0) return undefined
  return chosen.reduce((best, m) => (m.vramGB > best.vramGB ? m : best)).name
}
