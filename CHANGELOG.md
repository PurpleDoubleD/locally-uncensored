# Changelog

All notable changes to Locally Uncensored are documented here.

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
