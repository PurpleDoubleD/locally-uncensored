# Changelog

All notable changes to Locally Uncensored are documented here.

## [2.3.8] - 2026-04-22

> **Note on Codex:** several Codex plumbing bugs are fixed below, but Codex is still an actively-evolving feature and is not yet treated as production-finished. This section is a developer-facing technical changelog. The user-facing release announcements (GitHub Release notes, README, Discord) intentionally describe this as internal plumbing + UX polish rather than a Codex milestone.

### Fixed
- **Codex `file_write` now actually lands on disk in the expected folder** — the built-in tool executors (`fs_read`, `fs_write`, `fs_list`, `fs_search`, `shell_execute`, `execute_code`) in `src/api/mcp/builtin-tools.ts` never threaded the active chat-id through to Rust even though `agent-context.ts` was designed for exactly that. The documented per-chat workspace isolation (`~/agent-workspace/<chatId>/`) silently fell through to a shared `default/` fallback whenever the model emitted a relative path, and no per-chat isolation ever happened. Now every executor reads `getActiveChatId()` and spreads it into the `backendCall` payload so Rust's `resolve_path()` / `resolve_agent_path()` can route relative paths into the right per-chat folder. `src/api/agents.ts:executeTool` also now returns the real `data.path` from Rust's `{status:"saved", path:…}` response instead of a hard-coded `"File written successfully"` string that masked write failures behind a green ✓ in the UI.
- **Codex chat bubble no longer floods with raw `{"name":"file_write", "arguments":{…}}` JSON objects for models that emit tool calls as content** — qwen2.5-coder:3b and similar small coder models put the tool call in the `content` field instead of the native `tool_calls` array. The pre-2.3.8 extractor caught the call but left the raw JSON visible in the chat, and the narrative around it ("I'm about to verify…" + ```python fence echoing the file content) was concatenated onto `fullContent` every iteration — a 4-iteration task rendered as four stacked JSON blobs with four duplicated paragraphs. Fix: new `stripRanges()` helper uses the `[startIdx, endIdx]` positions the balanced-brace extractor already computes to remove the exact tool-call substrings (not a greedy regex that fails on nested braces), and an `extractedFromContent` flag drops the residual narrative entirely so qwen's Codex UI now looks identical to gemma4's.
- **Balanced-brace JSON extractor replaces the greedy `\{[^}]*\}` regex** — the old regex failed on any JSON with nested braces OR string values containing `{` (e.g. Python f-strings `f'Hello, {name}!'` emitted by qwen2.5-coder). Replaced with a locate-header-then-balance scanner that respects string escapes. Fixes `extractToolCallsFromContent` for any code that uses f-strings or dict literals in string values.
- **Arg-validator error-hint now lists the exact missing fields with types and what the model actually sent** — pre-2.3.8 the generic "Re-issue the tool call with valid arguments matching the tool schema" hint meant small models (hermes3:8b, qwen2.5-coder:3b) kept retrying the same malformed call. Now the hint looks like `file_write requires {path: string, content: string}. You sent {command}. Retry with all required fields present.` — concrete enough that small models actually self-correct.

### Added
- **Context compaction in Codex** — long multi-tool turns used to blow past 8K-context local models' windows; Codex now mirrors Agent Mode's `compactMessages(…, Math.floor(maxCtx * 0.8))` call before each sampling pass, summarising older turns while keeping recent messages intact.
- **Memory injection + extraction in Codex** — Codex was the only chat surface that ignored the memory system. It now reads `useMemoryStore.getState().getMemoriesForPrompt(instruction, contextTokens)` into the system prompt at dispatch time, and runs `extractMemoriesFromPair()` after the turn lands. Parity with Chat + Agent Mode.
- **`CODEX_CATEGORIES` tool-scope filter** — Codex now filters `toolRegistry.getAll()` to the `filesystem | terminal | system | web` categories before passing tools to the model. The pre-2.3.8 code had the constant defined but never used, so small models were getting confused by `image_generate`, `screenshot`, `run_workflow`, and `process_list` showing up next to `file_write` and emitting tool calls with the wrong argument shape (confirmed repro: hermes3:8b calling `file_write({command: "python -m unittest …"})` when both shell_execute and file_write were in scope). The filter narrows the blade.
- **Codex iter cap raised 20 → 50** — large refactors across 10+ files legitimately need more than 20 tool calls. Budget still caps via `agentMaxToolCalls` / `agentMaxIterations` (defaults 50 / 25 from settings).
- **Family grouping in ModelSelector dropdown** — models are now grouped by family header (QWEN / GEMMA / LLAMA / HERMES / PHI / DOLPHIN / MISTRAL / DEEPSEEK / …) in the Codex/Chat/Code dropdown, with a subscribe effect that re-fetches the list when any provider's `enabled`/`baseUrl` changes so users don't have to open Model Manager to see newly-enabled providers.

### E2E verified
5 tool-capable Ollama models, each in a fresh Codex chat, writing to `C:\Users\<user>\Desktop\<test-folder>\`:
- **gemma4:e4b** — both simple (`file_write hello.py`) and a real Codex-style task ("build cli.py with argparse add/list/clear + test_cli.py with 4 unittest tests + run `python -m unittest test_cli.py` and report") succeeded end-to-end. Full trace: `file_write cli.py (2556B)` → `file_write test_cli.py (3759B)` → `shell_execute python -m unittest test_cli.py` → real output `....\nRan 4 tests in 1.612s\nOK` → final summary. 3 clean tool blocks in the UI, single final answer, Memory badge fired on extraction.
- **qwen2.5-coder:3b** — after the `stripRanges` + `extractedFromContent` fix, chat UI is visually identical to gemma4's (tool blocks + single summary, zero raw JSON).
- **hermes3:8b** — clean native tool-call flow.
- **llama3.1:8b** — clean native tool-call flow (freshly pulled for this verification).
- **llama3.2:1b** — plumbing correct; the 1B model hallucinated a Unix-style `/Users/ddrob/Desktop/tiny.py` path that landed at `C:/Users/ddrob/Desktop/tiny.py` on Windows instead of in the workdir. Model-quality artefact, not a Codex bug. Documented for users on the smallest class of models.

### Changed
- Test suite 2202 → 2202 (full regression) after `tool-call-repair` gained `extractToolCallsWithRanges` + `stripRanges` + `findBalancedBraceEnd` + `findPrecedingOpenBrace`.

### Notes
- Drop-in upgrade from v2.3.7. No breaking changes. No localStorage migration. Existing Codex chats continue to work; new chats benefit from the per-chat workspace isolation now that `chatId` threads through.

## [2.3.7] - 2026-04-22

### Added
- **Configurable Ollama endpoint (remote Ollama + `OLLAMA_HOST` env var support)** — GitHub Issue #31 by @k-wilkinson. The pre-2.3.7 app hardcoded `http://localhost:11434` in four places (the frontend `ollamaUrl()` helper used by every `/tags`/`/chat`/`/show`/`/pull`/`/generate` call, the Vite dev-proxy target, the Ollama provider's dev-mode `apiUrl()`, and the Rust `pull_model_stream` URL), so setting `OLLAMA_HOST=0.0.0.0:11434`, `192.168.1.x:11434` or any non-default port was silently ignored — the app reported "No local backend detected", model dropdowns stayed empty, Settings → Providers → Ollama → Endpoint field had zero effect, and the Test button always said Failed even when `curl` against the configured endpoint returned data. Now all four layers flow from a single `ollama_base` field that reads, in priority order, the persisted GUI value from `%APPDATA%/locally-uncensored/config.json`, the `OLLAMA_HOST` env var at startup (same semantics as Ollama itself), then the default. Accepts bare `host:port`, scheme-less host, or full URL. The Vite dev-proxy target is computed from `OLLAMA_HOST` at server startup so `OLLAMA_HOST=… npm run dev` also just works. The Rust SSRF allow-list in `proxy_localhost` was widened to accept the configured Ollama + ComfyUI hosts (everything else still blocked). 19 regression tests in `backend-urls.test.ts`.

### Fixed
- **`pull_model_stream` Rust command was hardcoded to `http://localhost:11434/api/pull`** — same root cause as Issue #31 but in a second place. Model-pull downloads ignored any user-configured Ollama endpoint. Now reads from `state.ollama_base`.

### Changed
- Test suite 2183 → 2202 green.

### Notes
- Drop-in upgrade from v2.3.6. The default endpoint is still `http://localhost:11434` — existing users see zero behavior change. If you have `OLLAMA_HOST` in your environment (Docker, LAN, homelab) it's now honored; if you've edited Settings → Providers → Ollama → Endpoint that value now actually flows through the app.

## [2.3.6] - 2026-04-21

### Added
- **Configurable ComfyUI host (remote ComfyUI support)** — Settings → ComfyUI → Host. Previously only the port was configurable; the host was hardcoded `localhost`, which meant users running ComfyUI in Docker, on a LAN machine, or on a headless homelab server couldn't point LU at it. The Host field accepts any hostname or IP. When the host resolves to the local machine (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) the Start/Stop/Restart/Install/Path controls stay visible; when it's remote LU hides those controls and shows an amber hint that you manage the Python process on the server yourself. Requested in GitHub Discussion #1 by @ShoaibSajid (desktop LU + Ollama on server-1 + ComfyUI on server-1 docker). The mobile Remote proxy also honors the new host so mobile-dispatched ComfyUI calls reach the configured backend. 17 regression tests in `backend-urls.test.ts`.

### Fixed
- **ComfyUI port now actually persists across restarts** — pre-existing bug: `set_comfyui_port` wrote `comfyui_port` to `%APPDATA%/locally-uncensored/config.json`, but `AppState::new()` never read it back on startup. Users who set a custom port (e.g. because 8188 was taken) got their change reverted to 8188 on the next launch. New `load_comfy_config_values()` helper runs at startup and applies persisted port + host. Bundled with the host feature since they share the same config-load path.
- **OpenAI-compat local backends (LM Studio, vLLM, llama.cpp server, KoboldCpp, oobabooga, Jan, GPT4All, Aphrodite, SGLang, TGI, LocalAI, TabbyAPI) can actually be reached from LU's Tauri webview** — `openai-provider.ts` used plain `fetch()` for `/v1/models`, `/v1/chat/completions`, and `checkConnection`, which CORS-blocks localhost requests inside the Tauri WebView (only Ollama had CORS open). The "Test" button in Settings → Providers always showed **Failed** and models never appeared in the dropdown even when the backend was obviously reachable via curl. Fix: each HTTP call now picks `localFetch`/`localFetchStream` when the provider baseUrl hostname is local (`localhost`/`127.0.0.1`/`::1`/`0.0.0.0`), which routes through the Rust proxy with a direct-fetch fallback. Cloud endpoints (OpenAI proper, OpenRouter, Groq, Together, DeepSeek, Mistral, etc.) skip the proxy since they don't have the localhost CORS issue. Surfaced during v2.3.6 live E2E against a real LM Studio server on :1234; the Djoks auto-detection fix (v2.3.5) was detecting + pre-enabling the provider correctly, but the actual /v1/* calls were silently CORS-rejected.

### Changed
- Test suite 2166 → 2183 green (+17 regression tests for `setComfyHost` / `isComfyLocal` / `comfyuiUrl` / `comfyuiWsUrl` with custom hosts).

### Notes
- Drop-in upgrade from v2.3.5. No breaking changes. The default host is still `localhost` — existing users see zero behavior change unless they explicitly switch to a remote host.

## [2.3.5] - 2026-04-21

### Fixed
- **LM Studio (and other openai-compat backends) now show up when Ollama is also running** — `AppShell`'s post-onboarding detection only auto-enabled a backend when exactly one was detected. With two or more (the very common Ollama + LM Studio setup) it showed the `BackendSelector` modal but pre-enabled nothing. Users who dismissed the modal saw zero LM Studio models in the chat dropdown even though LM Studio was clearly running — looked from the outside like "LU doesn't recognize my models". Reported via Discord `#help-chat` on 2026-04-21. Fix: the first non-Ollama detected backend is always pre-enabled (Ollama is left untouched since it has its own provider slot); the selector stays as an educational picker so you can change which openai-compat backend is primary. Reproduced live with a mock LM Studio endpoint on port 1234 with Ollama also running, verified the fix against the same setup on the release binary. Five regression tests in `AppShell-backend-autoenable.test.ts`.
- **No more terminal flashes on Windows when LU kills subprocesses** — two Windows-branch `Command::new` spawns were missing `CREATE_NO_WINDOW`: the `taskkill` calls in `AppState::Drop` that tear down ComfyUI + Claude Code process trees on LU shutdown, and the `docker pull` / `docker run` in `search.rs` that installs SearXNG. Both briefly flashed a console window at the user. Now 100% of Windows-branch subprocess spawns carry the flag. LU itself never spawns LM Studio (only talks HTTP to a user-run instance), so the "no terminal when using LM Studio" guarantee was already true on that path; this tightens the peripheral surface.
- **`setup.bat` / `setup.ps1` / `setup.sh` no longer mislead end-users into dev mode** — the scripts launched `npm run dev` (Vite + browser), which has fewer features than the installed Tauri app and produced confusing `[vite] http proxy error: /system_stats ECONNREFUSED` when ComfyUI wasn't installed yet. Reported via GitHub issue #30. Fix: all three setup scripts now start with a clear dev-mode banner, a link to the installer in Releases, and a one-key prompt to continue or exit. The README's "Windows One-Click Setup" section was also reframed as "For Contributors — Dev-Mode Setup" with an explicit pointer to the installer for end-users.

### Changed
- Test suite 2161 → 2166 green (+5 regression tests for the backend-autoenable fix).

### Notes
- Drop-in upgrade from v2.3.4. No breaking changes. No localStorage migration. Everything from v2.3.4 (chat-history persistence, Ollama 0.21 compat, Codex loop guard, stop-button fast-path, stale-chip fix, 12-backend auto-detect, Mobile Remote, Codex streaming, Agent Mode rewrite, ERNIE-Image, Qwen 3.6, 75+ one-click model downloads) still applies.

## [2.3.4] - 2026-04-20

### Fixed
- **Chat history now survives updates** — `isTauri()` was checking the v1 global `window.__TAURI__`, but Tauri 2 renamed it to `window.__TAURI_INTERNALS__`. Inside the packaged `.exe` every Tauri-only backend command (`backup_stores`, `restore_stores`, `set_onboarding_done`, ComfyUI manager, whisper, process control) silently fell through to the dev-mode fetch path and no-op'd. Fix: dual-global check + 100 ms × 50-tick polling loop that waits for the Tauri global to appear before arming the backup triad (required because `withGlobalTauri: true` sets the global asynchronously on slow cold-starts). Full destructive wipe+restore roundtrip live-verified on the release binary.
- **Backup cadence tightened** — safety-net interval 30 s → 5 s; added event-driven debounced backup on every chat mutation (1 s after the last message); added `beforeunload` sync flush for graceful quits. All three legs run unconditionally with a `__ts` marker so the snapshot is always non-empty.
- **Ollama 0.21 / 0.20.7 compatibility** — auto-upgraded Ollama rejects pre-existing models with `HTTP 404 model not found` on `/api/show` when the on-disk manifest lacks the `capabilities` field. New `modelHealthStore` + top-of-app `StaleModelsBanner` + Header Lichtschalter chip detect stale models and offer a one-click re-pull that verifies the fix before clearing the warning. Error parser tolerates 400/404/Rust-proxy-wrapped-500 forms.
- **Stale-chip state leak** — switching from a stale model to a fresh one now clears the red toggle and the inline chip immediately; switching between two different stale models re-pins correctly.
- **Codex infinite-loop guard** — small 3 B coder models (qwen2.5-coder:3b, llama3.2:1b) could loop forever repeating the same `file_write + shell_execute` batch when a test failed. Codex now tracks per-iteration batch signatures and halts after two consecutive identical batches with "same tool sequence repeated N× — try a larger model".
- **Stop button instant** — `abort.signal.aborted` checked at the top of the `for await` chat stream and the NDJSON reader loop; `reader.cancel()` on abort. No more 30–60 s of thinking-token leak after clicking Stop on a Gemma-4 response.
- **`isHtmlSnippet` export missing** — 19 failing CodeBlock tests fixed.
- **Create view crashed silently in browser bundle** — `comfyui.getKnownFileSizes` used CommonJS `require('../api/discover')` which Vite/Rolldown can't resolve. Replaced with dynamic `import()`.
- **flux2 CFG scale test regression** — test asserted 3.5 (Z-Image default); corrected to 1.0 (flux2 default).

### Changed
- Test suite 2105 → 2161 green (+56 regression tests covering backup triad, Codex loop detection, `__TAURI_INTERNALS__` detection, stale-manifest parsing).

### Notes
- No breaking changes. Existing chats and settings survive the upgrade via the now-working restore path.
- Existing `phi4:14b`, `dolphin3:8b`, and other pre-0.15 Ollama models will show in the stale banner. Click "Refresh all" to re-pull; manifests will be regenerated with the new `capabilities` field.

## [2.2.1] - 2026-04-04

### Fixed
- **Model unloading broken** — unload button and automatic unload on model switch silently failed (missing `prompt` field in Ollama `/generate` call), causing models to stay in RAM indefinitely
- **No GPU offloading** — models ran entirely on CPU/RAM instead of GPU; added `num_gpu: 99` to all Ollama chat calls so layers are offloaded to GPU automatically (Ollama splits between GPU and CPU if VRAM is insufficient)
- **Silent error swallowing** — unload errors were caught and discarded with `.catch(() => {})`; now logged to console for debugging

## [1.9.0] - 2026-04-03

### Added
- **Agent Mode (Beta)** — AI can use tools: web_search, web_fetch, file_read, file_write, code_execute, image_generate
- **Two-phase search** — web_search finds URLs, web_fetch reads actual page content for accurate answers
- **Tool approval system** — safe tools auto-execute, dangerous tools require user confirmation
- **Live tool-call blocks** — inline status with expandable arguments and results
- **Agent onboarding tutorial** — 4-step walkthrough for first-time users
- **Memory system** — auto-saves tool results, keyword search, category filters, export/import as .md
- **Context compaction** — automatic message compression to prevent context window overflow
- **Model auto-fix** — abliterated models get tool-calling template restored via Ollama Modelfile
- **Hermes XML fallback** — prompt-based tool calling for models without native support
- **Persona dropdown** — quick persona switching in chat top bar
- **Variant selector** — dropdown for multi-size model downloads in Discover
- **HOT/AGENT badges** — recommended models highlighted in Model Manager
- **web_fetch tool** — fetches URLs and extracts readable text content (HTML → text)

### Changed
- **UI redesign (Linear/Arc style)** — compact header, collapsible settings, list-view models, minimal borders
- **Sidebar** — narrower, minimal hover states, smaller text
- **Settings** — collapsible sections, inline sliders, compact toggles
- **Model Manager** — list layout instead of card grid
- **Start screen** — clean LU logo only, smooth transition to chat
- **Header** — renamed to LUncensored, removed old Agents tab
- **Tool call display** — inline colored text instead of colored boxes

### Fixed
- DuckDuckGo search snippet truncation (regex now captures full HTML content)
- DDG URL extraction from redirect wrappers
- Context window exhaustion after many tool calls ("Failed to fetch" error)

### Removed
- Old standalone Agent View (replaced by in-chat Agent Mode)

---

## [1.5.5] - 2026-04-02

### Added
- **Zero-Config Model Experience**: Auto-detect model type, apply optimal defaults (steps, CFG, sampler, size)
- **Pre-flight Validation**: Check VAE/CLIP/nodes before generation with direct download buttons on errors
- **VRAM-Based Recommendations**: Detect GPU VRAM via ComfyUI, sort bundles by fit ("Fits your GPU" / "Needs more VRAM" badges)
- **2026 State-of-the-Art Models**: Updated bundles with FLUX 2 Klein 4B, LTX Video 2.3 22B, curated text models (GLM 4.6, Qwen 3)
- **Download Manager**: Pause, cancel, and resume model downloads (CancellationToken + HTTP Range headers)
- **TTS Auto-Speak**: Chat responses read aloud when TTS is enabled in settings
- **6 Complete Model Bundles** — one-click download with all required files:
  - Image: Juggernaut XL V9, FLUX.1 schnell FP8, FLUX.1 dev FP8
  - Video: Wan 2.1 1.3B, Wan 2.1 14B FP8, HunyuanVideo 1.5 T2V FP8
- **RAG IndexedDB Persistence**: Chunk embeddings survive page reload (no more data loss)
- **ErrorBoundary** around RAG panel (prevents white page on errors)
- **Splash Screen**: LU logo on startup, window shows only after React renders (no blank screen)
- **CI/CD Pipeline**: GitHub Actions workflow for PR validation
- **Accessibility**: aria-label on 48 icon-only buttons across 16 components
- **LU Monogram Branding**: New logo across app icon, favicon, social preview, README

### Fixed
- **Tauri .exe fully working**: CORS proxy through Rust, Ollama /api prefix, CSP for IPC, download ID sync, ComfyUI auto-start deadlock
- **RAG Document Chat**: React 19 infinite loop fix (useShallow for Zustand persist), detailed error messages (Ollama down, model missing, empty file)
- **CLIP/VAE fallback**: Descriptive error with download instructions instead of silently using wrong model
- **RAG BM25**: Proper IDF calculation using document frequency across all chunks
- **Agent image_generate**: Actually calls ComfyUI via dynamic workflow builder (was returning stub)
- **Whisper check**: isSpeechRecognitionSupported() checks if Whisper is actually running
- **Chat history**: Filter empty assistant messages before sending to LLM
- **ComfyUI path discovery**: Deep scan (depth 7), auto-detect from running process, manual path input
- **Model Manager**: Show diffusion_models alongside checkpoints
- **Python discovery**: Improved binary detection (AppData, Conda, version check)
- **Startup**: Whisper loads in background thread (no blocking), terminal windows hidden in release

### Changed
- Enhanced model classification (15+ known community models) with component registry
- Landing page: 3x3 model grid with latest models, updated FAQ
- All landing page images converted to WebP with `<picture>` fallback + width/height for CLS
- DevTools only in debug builds
- Removed console.warn from production code, fixed unused imports
- Cleaned repo: removed internal files (logo concepts, marketing assets, dev drafts)

## [1.3.0] - 2026-03-31

### Added
- **RAG Document Chat**: Upload PDF, DOCX, or TXT files to chat with your documents
  - Hybrid search (vector + BM25 keyword matching) for better retrieval
  - Confidence score display with color-coded badges
  - Ollama context window warning when model has insufficient context
  - Automatic embedding model download (nomic-embed-text)
  - Per-conversation RAG toggle and source citations
- **Standalone Desktop App**: Full Tauri v2 Rust backend — .exe runs without Node.js or dev server
  - 15 Rust commands replacing Vite middleware (process management, downloads, search, agents, voice)
  - Frontend auto-detects Tauri vs browser and routes accordingly
  - Ollama, ComfyUI, and Whisper auto-start on app launch
  - Clean process shutdown on app exit
- **Voice Integration**: Talk to your AI and hear responses
  - Persistent Whisper server loads model once (~2.5 min), then transcribes in ~2s
  - Push-to-talk microphone button with local faster-whisper (100% offline, no cloud)
  - Text-to-speech on any assistant message with sentence-level streaming
  - Voice settings (voice selection, rate, pitch)
  - Auto-send transcribed text option
- **AI Agents**: Autonomous task execution with local tools
  - ReAct-style reasoning loop with 5 built-in tools
  - Web search, file read/write, Python code execution, image generation
  - User approval required for destructive actions
  - Task breakdown visualization and color-coded execution log
  - Robust JSON parsing with 4-tier fallback and error recovery

### Fixed
- Cross-platform Python detection for code execution (Windows Store alias handling)
- Web search now falls back to Brave Search when DuckDuckGo returns CAPTCHA
- ComfyUI auto-discovery now scans up to 4 levels deep (finds nested installs with spaces in path)
- Ollama/ComfyUI spawn no longer opens extra console windows on Windows
- Whisper transcription no longer times out (was re-loading 145MB model on every request)


## [1.0.2] - 2026-03-25

### Fixed
- Complete Create tab rewrite — resolved all 55 known issues
- Persona icons now show diverse set of avatars
- Logo navigation works correctly
- Video display rendering fixed

## [1.0.1] - 2026-03-25

### Fixed
- Image and video model auto-detection now works reliably
- FLUX workflow generation fixed
- ComfyUI integration: auto-start, auto-stop, live status indicator
- Personas load correctly on new chat sessions
- Light mode text contrast improved
- Video backend display fixed

## [1.0.0] - 2026-03-24

### Added
- **AI Chat** via Ollama with streaming responses
- **Image Generation** via ComfyUI (SDXL, FLUX, Pony checkpoints)
- **Video Generation** via ComfyUI (Wan 2.1/2.2, AnimateDiff)
- **25+ Built-in Personas** — from Helpful Assistant to creative characters
- **Model Manager** — browse, install, switch, and delete models
- **Discover Models** — find and install models from Ollama registry
- **Thinking Display** — collapsible reasoning blocks
- **Dark/Light Mode** with glassmorphism UI
- **Conversation History** — saved locally in browser
- **Model Auto-Detection** — finds all installed models automatically
- **One-Click Setup** — `setup.bat` installs everything on Windows
- **Hardware Detection** — recommends models based on your GPU/RAM
