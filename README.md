<div align="center">

<img src="logos/LU-monogram-bw.png" alt="Locally Uncensored" width="80">

# Locally Uncensored

**The only local AI app that does Chat + Agent Mode + Images + Video — all in one.**

No cloud. No censorship. No data collection. Your AI, your rules.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/PurpleDoubleD/locally-uncensored?style=social)](https://github.com/PurpleDoubleD/locally-uncensored/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/PurpleDoubleD/locally-uncensored)](https://github.com/PurpleDoubleD/locally-uncensored/commits)
[![GitHub Discussions](https://img.shields.io/github/discussions/PurpleDoubleD/locally-uncensored)](https://github.com/PurpleDoubleD/locally-uncensored/discussions)

<img src="docs/demo.gif" alt="Locally Uncensored Demo" width="700">

*Chat with AI personas, generate images, create videos — all running locally on your machine.*

[Getting Started](#-quick-start) · [Portable Download](#-portable--no-install) · [Features](#-features) · [Why This App?](#-why-locally-uncensored) · [Roadmap](#-roadmap) · [Contributing](CONTRIBUTING.md)

</div>

---

### 📸 Screenshots

| Chat with Personas | Image / Video Generation |
|:---:|:---:|
| ![Chat](docs/screenshots/chat_personas_dark.png) | ![Create](docs/screenshots/create_dark.png) |
| **Model Manager** | **Create View with Parameters** |
| ![Models](docs/screenshots/model_manager_dark.png) | ![Create Params](docs/screenshots/create_params_dark.png) |

---

## ❓ Why Locally Uncensored?

Tired of switching between Ollama for chat, ComfyUI for images, and another tool for video? Frustrated with bloated UIs that need Docker and a PhD to set up?

**Locally Uncensored** is the all-in-one solution. One app. One setup. Everything local.

### How it compares

| Feature | Locally Uncensored | Open WebUI | LM Studio | SillyTavern |
|---------|:-:|:-:|:-:|:-:|
| AI Chat | ✅ | ✅ | ✅ | ✅ |
| **Agent Mode (Tool Calling)** | **✅** | ❌ | ❌ | ❌ |
| Image Generation | ✅ | ❌ | ❌ | ❌ |
| Video Generation | ✅ | ❌ | ❌ | ❌ |
| Uncensored by Default | ✅ | ❌ | ❌ | ⚠️ |
| Memory System | ✅ | ❌ | ❌ | ❌ |
| One-Click Setup | ✅ | ❌ (Docker) | ✅ | ❌ (Node.js) |
| 25+ Built-in Personas | ✅ | ❌ | ❌ | ⚠️ (manual) |
| RAG / Document Chat | ✅ | ✅ | ❌ | ❌ |
| Voice (STT + TTS) | ✅ | ⚠️ | ❌ | ❌ |
| Open Source | ✅ | ✅ | ❌ | ✅ |
| 100% Offline | ✅ | ✅ | ✅ | ✅ |

---

## ✨ Features

- **Uncensored AI Chat** — Run abliterated models locally with zero restrictions
- **Agent Mode (Beta)** — Give your AI tools: web search, web fetch, file I/O, code execution, image generation. It chains tools autonomously to answer questions with real data. Best with [Hermes 3](https://ollama.com/library/hermes3).
- **Memory System** — Agent Mode auto-saves tool results. Persistent across sessions. Export/import as .md.
- **Image Generation** — Text-to-image via ComfyUI with full parameter control
- **Video Generation** — Text-to-video with Wan 2.1/2.2, HunyuanVideo, LTX support
- **Document Chat (RAG)** — Upload PDFs, DOCX, or TXT files and chat with your documents
- **Voice Chat** — Talk to your AI with push-to-talk and hear responses with TTS
- **25+ Personas** — From Helpful Assistant to Roast Master, switchable via dropdown
- **Model Manager** — Browse, install, and switch models. HOT badges for recommended models. Variant selector for multi-size downloads.
- **Thinking Display** — See the AI's reasoning in collapsible blocks
- **Linear/Arc UI** — Compact, monochrome, collapsible settings. Premium feel.
- **Privacy First** — Zero tracking. All API calls proxied locally. No analytics.
- **100% Local** — Everything runs on your machine
- **Standalone Desktop App** — Tauri v2 Rust backend. Download the .exe, run it.

## Tech Stack

- **Desktop**: Tauri v2 (Rust backend, standalone .exe — no Node.js required)
- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Framer Motion
- **State**: Zustand with localStorage persistence
- **AI Backend**: Ollama (text), ComfyUI (images/video), faster-whisper (voice)
- **Build**: Vite 8 (dev), Tauri CLI (production)

---

## 🚀 Quick Start

### Windows

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
setup.bat
```

### Linux / macOS

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
chmod +x setup.sh
./setup.sh
```

The setup script automatically:
1. Checks for Node.js 18+, Git, and Ollama
2. Installs missing dependencies
3. Downloads a recommended uncensored AI model (~5.7 GB)
4. Starts the app in your browser

### Manual Installation

**Prerequisites:** [Node.js](https://nodejs.org/) 18+, [Ollama](https://ollama.com/)

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev
```

Open **http://localhost:5173** — the app recommends models on first launch.

### Image & Video Generation

No separate installation needed! When you open the **Create** tab:

1. The app checks for ComfyUI automatically
2. If not found, click **"Install ComfyUI Automatically"** — it clones, installs dependencies, and sets up CUDA in one click
3. Go to **Model Manager → Discover → Image/Video** and click **Install All** on any model bundle
4. Generate images and videos — everything is ready

The entire setup happens inside the app. No terminal commands, no manual config files.

### One-Click Start (Windows)

```batch
start.bat
```

Launches Ollama + ComfyUI + the app in one go.

---

## 📦 Portable / No-Install

**Don't want to install anything?** Download the portable version — just extract and run. No admin rights, no installer, no registry entries.

### Windows (Portable)
1. Go to [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases)
2. Download the `.exe` installer
3. When the installer opens, select **"Install for current user only (portable)"**
4. Choose any folder (e.g., a USB drive) — done!

Alternatively, download the `.msi` for a traditional system-wide install.

### Linux (Portable)
1. Download the `.AppImage` from [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases)
2. `chmod +x Locally-Uncensored_*.AppImage`
3. `./Locally-Uncensored_*.AppImage`

No installation needed — AppImage is portable by design.

### macOS (Portable)
1. Download the `.dmg` from [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases)
2. Drag to any folder (doesn't have to be Applications)
3. Right-click → Open (first time only, to bypass Gatekeeper)

> **Note:** You still need [Ollama](https://ollama.com/) installed for AI chat. The app will guide you through setup on first launch.

---

## 🧠 Model Auto-Detection

The app automatically detects all installed models across all backends — no manual configuration needed:

- **Text models** — Auto-detected from Ollama. On first launch, the app scans your hardware and recommends the best uncensored models for your system.
- **Image models** — Auto-detected from ComfyUI's `models/checkpoints` folder. Drop any checkpoint in there and it shows up instantly.
- **Video models** — Auto-detected from ComfyUI. The app identifies your video backend (Wan 2.1/2.2 or AnimateDiff) and lists available models automatically.

Just install models in the standard locations and the app picks them up.

## 🎭 Recommended Models

### Text (Ollama) — scales to your hardware

| Model | Size | VRAM | Best For |
|-------|------|------|----------|
| **Hermes 3 8B** | 4.3 GB | 6 GB | **Agent Mode** — uncensored + native tool calling |
| **Hermes 3 70B** | 42 GB | 48 GB | **Best Agent** — maximum power |
| Qwen 3.5 Abliterated | 5–18 GB | 6–16 GB | Best overall intelligence |
| Qwen 3 8B Abliterated | 5.2 GB | 6 GB | Fast, great for coding |
| DeepSeek R1 (8B–70B) | 5–42 GB | 6–48 GB | Chain-of-thought reasoning |
| GLM 4.6 9B Abliterated | 6 GB | 8 GB | Strong coding |
| Llama 3.1 8B Abliterated | 5.7 GB | 6 GB | Fastest all-rounder |
| Llama 3.3 70B Abliterated | 42 GB | 48 GB | Maximum intelligence |

### Image (ComfyUI)

| Model | VRAM | Notes |
|-------|------|-------|
| FLUX 2 Klein 4B | 8 GB | Next-gen, fastest FLUX |
| FLUX.1 Dev / Schnell | 8–10 GB | Best text-to-image |
| Juggernaut XL V9 | 6 GB | Best photorealistic SDXL |
| Pony Diffusion V6 XL | 6 GB | Anime/stylized |

### Video (ComfyUI)

| Model | VRAM | Output | Notes |
|-------|------|--------|-------|
| Wan 2.1 T2V 1.3B | 8–10 GB | 480p | Best entry point, fast |
| Wan 2.1 T2V 14B FP8 | 12+ GB | 720p | High quality |
| HunyuanVideo 1.5 FP8 | 12+ GB | 480p | Excellent temporal consistency |
| LTX Video 2.3 22B FP8 | 16+ GB | 480p+ | Latest, fast inference |

---

## ⚙️ Configuration

### Environment Variables

Create a `.env` file (see `.env.example`):

```env
# Path to your ComfyUI installation (optional)
COMFYUI_PATH=/path/to/your/ComfyUI
```

### In-App Settings

- **Temperature** — Controls randomness (0 = deterministic, 1 = creative)
- **Top P / Top K** — Fine-tune token sampling
- **Max Tokens** — Limit response length (0 = unlimited)
- **Theme** — Dark or Light mode

---

## 🗺️ Roadmap

- [x] **RAG / Document Chat** — Upload PDFs and chat with your documents
- [x] **Agent Mode (Beta)** — Tool calling with web search, file I/O, code execution
- [x] **Memory System** — Persistent agent memory with export/import
- [x] **Voice Chat** — STT + TTS with local Whisper
- [ ] **Audio Generation** — Text-to-speech and music generation
- [ ] **Plugin System** — Extend the app with community plugins
- [ ] **Multi-User Mode** — Share your local AI server with your household
- [ ] **Mobile UI** — Responsive layout for phone/tablet access

Have an idea? [Open a discussion](https://github.com/PurpleDoubleD/locally-uncensored/discussions)!

---

## 📁 Project Structure

```
src/
  api/          # Ollama & ComfyUI API clients
  components/   # React components
    chat/       # Chat UI (messages, input, markdown)
    create/     # Image/Video generation UI
    models/     # Model management
    personas/   # Persona selection
    settings/   # App settings
    ui/         # Reusable UI components
  hooks/        # Custom React hooks
  stores/       # Zustand state management
  types/        # TypeScript definitions
  lib/          # Constants & utilities
```

---

## 🖥️ Platform Support

| Platform | Status | Download |
|----------|--------|----------|
| **Windows** (10/11) | ✅ Fully tested | `.exe` / `.msi` |
| **Linux** (Ubuntu 22.04+, Debian, Fedora) | ✅ Fully tested | `.AppImage` / `.deb` |
| **macOS** | 🚧 Community testing | Build from source |

> **Note:** We actively test and support Windows and Linux. macOS builds are provided on a best-effort basis — we don't have Mac hardware for testing. macOS users can build from source (see below) and we welcome community feedback and PRs for Mac-specific issues.

### Build from source (all platforms)
```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev          # Development
npm run tauri build  # Production binary
```

## Contributing

We welcome contributions! Check out the [Contributing Guide](CONTRIBUTING.md) for details on how to get started.

See our [open issues](https://github.com/PurpleDoubleD/locally-uncensored/issues) or the [Roadmap](#-roadmap) for areas where help is needed.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built with privacy in mind. Your data stays on your machine.** 🔒

If you find this useful, consider giving it a ⭐

[Report Bug](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=bug_report.yml) · [Request Feature](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=feature_request.yml) · [Join Discussion](https://github.com/PurpleDoubleD/locally-uncensored/discussions)

</div>
