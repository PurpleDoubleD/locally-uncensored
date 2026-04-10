<div align="center">

<img src="logos/LU-monogram-bw.png" alt="Locally Uncensored" width="80">

# Locally Uncensored

**Plug & Play Local AI — Chat, Code, Images, Video. All in one.**

No cloud. No censorship. No data collection. Auto-detects 12 local backends. Your AI, your rules.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/PurpleDoubleD/locally-uncensored?style=social)](https://github.com/PurpleDoubleD/locally-uncensored/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/PurpleDoubleD/locally-uncensored)](https://github.com/PurpleDoubleD/locally-uncensored/commits)
[![GitHub Discussions](https://img.shields.io/github/discussions/PurpleDoubleD/locally-uncensored)](https://github.com/PurpleDoubleD/locally-uncensored/discussions)
[![Website](https://img.shields.io/badge/Website-locallyuncensored.com-8b5cf6)](https://locallyuncensored.com)

<img src="docs/demo.gif" alt="Locally Uncensored Demo" width="700">

*Chat with AI, code with Codex, generate images, create videos — all running locally on your machine.*

[Download](#-download) · [Features](#-features) · [Quick Start](#-quick-start) · [Why This App?](#-why-locally-uncensored) · [Roadmap](#-roadmap)

</div>

---

### Screenshots

| Chat with Personas | Image / Video Generation |
|:---:|:---:|
| ![Chat](docs/screenshots/chat_personas_dark.png) | ![Create](docs/screenshots/create_dark.png) |
| **Model Manager** | **Create View with Parameters** |
| ![Models](docs/screenshots/model_manager_dark.png) | ![Create Params](docs/screenshots/create_params_dark.png) |

---

## v2.3.0 — Coming Soon

**ComfyUI Plug & Play, 20 Video/Image Models, Image-to-Image, Z-Image Support**

- **ComfyUI Plug & Play** — Auto-detect, one-click install, auto-start. Zero config image and video generation.
- **20 Model Bundles** — 14 video + 6 image bundles with one-click download (Wan 2.1, HunyuanVideo, FLUX 2, Z-Image, CogVideoX, FramePack, and more).
- **Z-Image Turbo/Base** — Uncensored image model with own strategy and qwen_image CLIP type. 8-15 seconds per image.
- **Image-to-Image (I2I)** — Upload a source image, adjust denoise strength (0.0-1.0), transform with any prompt. Works with all image models.
- **Image-to-Video (I2V)** — SVD and FramePack support with drag & drop image upload.
- **Dynamic Workflow Builder** — Auto-detects installed nodes and builds the correct pipeline for any model type.
- **VRAM-Aware Model Filtering** — Lightweight / Mid-Range / High-End tabs based on GPU VRAM.
- **Unified Download Manager** — Track all downloads (text models, image models, video models) with progress, speed, pause/resume.
- **Process Cleanup** — ComfyUI Python process automatically terminates when app is closed or killed.

---

## v2.2.3 — Latest Release

**Plug & Play Setup, Multi-Provider Overhaul, Codex Agent, MCP Tools**

- **Plug & Play Setup** — First-launch wizard auto-detects 12 local backends (Ollama, LM Studio, vLLM, KoboldCpp, Jan, GPT4All, llama.cpp, LocalAI, text-generation-webui, TabbyAPI, Aphrodite, SGLang). Nothing installed? One-click install links. Re-Scan after install. Zero config.
- **20+ Provider Presets** — Every local and cloud backend pre-configured. Just pick and go.
- **Codex Coding Agent** — Three-tab system (LU | Codex | OpenClaw). Dedicated coding mode with file tree, native folder picker, shell execution, up to 20 iterations per task.
- **13 MCP Tools** — Dynamic tool registry: web_search, web_fetch, file_read, file_write, file_list, file_search, shell_execute, code_execute, system_info, process_list, screenshot, image_generate, run_workflow.
- **Granular Permissions** — 7 categories (web, filesystem, terminal, system, desktop, image, workflow) with blocked/confirm/auto levels. Per-conversation overrides.
- **File Upload + Vision** — Drag & drop, Ctrl+V paste, clip button. Up to 5 images per message. Works across all providers.
- **Thinking Mode** — Provider-agnostic. Native support where available, system prompt fallback for others. Collapsible thinking blocks.
- **Model Load/Unload** — Power icons in header to load/unload models from VRAM.
- **Smart Tool Selection** — Keyword-based filtering saves ~80% of tool-definition tokens.
- **JSON Repair** — Fixes broken JSON from local LLMs (trailing commas, single quotes, missing braces).
- **Native PC Control** — Rust commands for shell, filesystem, system info (async, non-blocking).
- **UI Overhaul** — 15% larger UI, compact message bubbles, monochrome tool blocks, collapsible code blocks, light mode support.

See [Release Notes](https://github.com/PurpleDoubleD/locally-uncensored/releases/tag/v2.2.2).

---

## Why Locally Uncensored?

| Feature | Locally Uncensored | Open WebUI | LM Studio | SillyTavern |
|---------|:-:|:-:|:-:|:-:|
| AI Chat | **Yes** | Yes | Yes | Yes |
| **Coding Agent (Codex)** | **Yes** | No | No | No |
| **13 MCP Agent Tools** | **Yes** | No | No | No |
| **Plug & Play Setup** | **12 Backends** | No | Built-in | No |
| **Multi-Provider** (20+ Presets) | **Yes** | Yes | Yes | No |
| **A/B Model Compare** | **Yes** | No | No | No |
| **Local Benchmark** | **Yes** | No | No | No |
| Image Generation | **Yes** | No | No | No |
| **Image-to-Image** | **Yes** | No | No | No |
| Video Generation | **Yes** | No | No | No |
| **File Upload + Vision** | **Yes** | Yes | Yes | No |
| **Thinking Mode** | **Yes** | No | No | No |
| **Granular Permissions** | **7 Categories** | No | No | No |
| Uncensored by Default | **Yes** | No | No | Partial |
| Memory System | **Yes** | Plugin | No | No |
| Agent Workflows | **Yes** | No | No | No |
| Document Chat (RAG) | **Yes** | Yes | No | No |
| Voice (STT + TTS) | **Yes** | Partial | No | No |
| Open Source | **MIT** | MIT | No | AGPL |
| No Docker | **Yes** | No | Yes | Yes |

---

## Features

### Core
- **Plug & Play Setup** — First-launch wizard auto-detects 12 local backends. Nothing installed? One-click install links for every backend. Re-Scan after install. Zero config needed.
- **Uncensored AI Chat** — Abliterated models with zero restrictions. Streaming + thinking display.
- **Multi-Provider** — 20+ presets. Local: Ollama, LM Studio, vLLM, KoboldCpp, llama.cpp, LocalAI, Jan, TabbyAPI, GPT4All, Aphrodite, SGLang, TGI. Cloud: OpenAI, Anthropic, OpenRouter, Groq, Together, DeepSeek, Mistral. Switch per conversation.
- **Codex Coding Agent** — Reads codebase, writes code, runs shell commands. File tree with native folder picker. Up to 20 tool iterations.
- **Agent Mode** — 13 MCP tools: web search, file I/O, shell, code execution, screenshots, system info. Native + Hermes XML fallback.
- **Image Generation** — FLUX.1, Juggernaut XL, Pony Diffusion via ComfyUI. Full parameter control, no content filter.
- **Video Generation** — Wan 2.1/2.2, HunyuanVideo, LTX Video on your GPU.

### Intelligence
- **Thinking Mode** — Provider-agnostic. See the AI's reasoning before the answer.
- **File Upload + Vision** — Drag & drop, paste, clip button. Vision models analyze images.
- **Granular Permissions** — 7 tool categories, 3 permission levels, per-conversation overrides.
- **Smart Tool Selection** — Reduces tool definitions per request by ~80%. JSON repair for local LLMs.
- **Memory System** — Persistent across conversations. Auto-extraction. Export/import.
- **Agent Workflows** — Multi-step chains. 3 built-in (Research, Summarize URL, Code Review). Visual builder.

### Productivity
- **Model A/B Compare** — Same prompt, two models, side by side. Parallel streaming.
- **Local Benchmark** — One-click benchmark any model. Tokens/sec leaderboard.
- **Document Chat (RAG)** — Upload PDFs, DOCX, TXT. Hybrid search with source citations.
- **Voice Chat** — Push-to-talk STT + sentence-level TTS streaming.
- **20+ Personas** — Pre-built characters. Switch without prompt engineering.
- **Chat Export** — Markdown or JSON. Token counter. Keyboard shortcuts.

### Polish
- **Standalone Desktop App** — Tauri v2 Rust backend. Download .exe, run it.
- **Model Load/Unload** — Power icons in header. Load into VRAM, unload when done.
- **Custom Dark Titlebar** — Frameless window, no native chrome.
- **Linear/Arc UI** — Compact, monochrome. 15% larger for readability.
- **Privacy First** — Zero tracking, all API calls proxied locally.

## Tech Stack

- **Desktop**: Tauri v2 (Rust backend, standalone .exe)
- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Framer Motion
- **State**: Zustand with localStorage persistence
- **AI Backend**: 20+ providers (Ollama, LM Studio, vLLM, KoboldCpp, llama.cpp, LocalAI, Jan, OpenAI, Anthropic, OpenRouter, Groq, and more), ComfyUI, faster-whisper
- **Build**: Vite 8 (dev), Tauri CLI (production)

---

## Download

### Windows
Download the installer from [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases/latest):
- **`.exe`** — NSIS installer (recommended)
- **`.msi`** — Windows Installer

### Linux
- **`.AppImage`** — Portable, no install needed

### macOS
Build from source (see below).

> **Plug & Play:** Just install and launch. The setup wizard auto-detects all 12 supported local backends ([Ollama](https://ollama.com/), [LM Studio](https://lmstudio.ai/), [vLLM](https://github.com/vllm-project/vllm), [KoboldCpp](https://github.com/LostRuins/koboldcpp), llama.cpp, LocalAI, Jan, GPT4All, text-generation-webui, TabbyAPI, Aphrodite, SGLang). Nothing installed yet? The wizard shows one-click install links for every backend.

---

## Quick Start

### From Source

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev
```

### Windows One-Click Setup

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
setup.bat
```

Installs Node.js, Ollama, downloads an uncensored model, launches the app.

### Image & Video Generation

Open the **Create** tab → click **"Install ComfyUI Automatically"**. One click, fully automated.

---

## Recommended Models

### Text (any local backend)

| Model | VRAM | Best For |
|-------|------|----------|
| **Gemma 4 26B MoE** | 8 GB | Vision + native tools. Apache 2.0. Runs like 4B. |
| **Qwen3-Coder 30B** | 16 GB | Best coding agent. 256K context. |
| **Qwen 3.5 Abliterated** | 6-16 GB | Best overall intelligence. |
| Hermes 3 8B | 6 GB | Agent Mode. Uncensored + tool calling. |
| DeepSeek R1 (8B-70B) | 6-48 GB | Chain-of-thought reasoning. |

### Image (ComfyUI)

| Model | VRAM | Notes |
|-------|------|-------|
| FLUX.1 Dev / Schnell | 8-10 GB | Best text-to-image |
| Juggernaut XL V9 | 6 GB | Best photorealistic |

### Video (ComfyUI)

| Model | VRAM | Notes |
|-------|------|-------|
| Wan 2.1 T2V 1.3B | 8-10 GB | Fast entry point |
| Wan 2.1 T2V 14B | 12+ GB | High quality |

---

## Roadmap

- [x] **Plug & Play Setup** (auto-detect 12 local backends, one-click install links)
- [x] Codex Coding Agent
- [x] MCP Tool Registry (13 tools)
- [x] Granular Permissions (7 categories)
- [x] File Upload + Vision
- [x] Thinking Mode (provider-agnostic)
- [x] Model Load/Unload from header
- [x] Multi-Provider (20+ presets: Ollama, LM Studio, vLLM, KoboldCpp, OpenAI, Anthropic, and more)
- [x] Agent Mode + Workflows
- [x] Memory System
- [x] A/B Compare + Local Benchmark
- [x] RAG / Document Chat
- [x] Voice Chat (STT + TTS)
- [ ] OpenClaw Integration
- [ ] Voice Mode (Qwen Omni live voice)
- [ ] Video Upload
- [ ] Create Modes (img2img, upscale, inpainting)
- [ ] Plugin System

---

## Build from Source

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev          # Development
npm run tauri build  # Production binary
```

## Platform Support

| Platform | Status | Download |
|----------|--------|----------|
| **Windows** (10/11) | Fully tested | `.exe` / `.msi` |
| **Linux** (Ubuntu 22.04+) | Fully tested | `.AppImage` |
| **macOS** | Community testing | Build from source |

## Contributing

Check out the [Contributing Guide](CONTRIBUTING.md). See [open issues](https://github.com/PurpleDoubleD/locally-uncensored/issues) or the [Roadmap](#-roadmap).

## License

MIT License — see [LICENSE](LICENSE).

---

<div align="center">

**Your data stays on your machine.**

[Website](https://locallyuncensored.com) · [Report Bug](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=bug_report.yml) · [Request Feature](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=feature_request.yml) · [Discussions](https://github.com/PurpleDoubleD/locally-uncensored/discussions)

</div>
