# Changelog

All notable changes to Locally Uncensored are documented here.

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
