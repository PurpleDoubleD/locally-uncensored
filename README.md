<div align="center">

<img src="logos/LU-monogram-bw.png" alt="Locally Uncensored" width="80">

# Locally Uncensored

**The plug-and-play local AI studio — uncensored chat, image & video generation, and a coding agent. One installer. No cloud.**

Install it like a normal app and you're chatting, generating images, and making videos in minutes. No command line, no Docker, no config files. Auto-detects 12 local backends. Your AI, your hardware, your rules.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![GitHub stars](https://img.shields.io/github/stars/PurpleDoubleD/locally-uncensored?style=social)](https://github.com/PurpleDoubleD/locally-uncensored/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/PurpleDoubleD/locally-uncensored)](https://github.com/PurpleDoubleD/locally-uncensored/commits)
[![GitHub Discussions](https://img.shields.io/github/discussions/PurpleDoubleD/locally-uncensored)](https://github.com/PurpleDoubleD/locally-uncensored/discussions)
[![Discord](https://img.shields.io/discord/1496087522042843146?style=flat-square&logo=discord&label=Discord&color=5865F2)](https://locallyuncensored.com/discord)
[![Website](https://img.shields.io/badge/Website-locallyuncensored.com-8b5cf6)](https://locallyuncensored.com)

<img src="docs/demo.gif" alt="Locally Uncensored Demo" width="700">

*The only desktop app that runs AI chat, image, and video generation — locally, one click, no cloud.*

[Download](#download) · [Quick Start](#quick-start) · [Features](#features) · [Why This App?](#why-locally-uncensored) · [Models](#recommended-models) · [FAQ](#faq)

</div>

---

## What is Locally Uncensored?

Locally Uncensored (LU) is a **free, open-source local AI studio** for Windows and Linux. It combines four things most local-AI tools keep separate — **AI chat, a coding agent, image generation, and video generation** — in one desktop app, and it installs like a normal program: run one installer, let the setup wizard detect (or install) an AI engine, one-click a model, start typing.

- **Uncensored by default** — first-class support for [abliterated models](https://locallyuncensored.com/blog/abliterated-models-guide.html) that answer directly, without refusals or lectures. Mainstream models are in the same menu.
- **100% local and private** — zero telemetry, zero analytics, works fully offline after model download. Cloud providers (OpenAI, Anthropic, OpenRouter, Groq…) are optional and use your own keys.
- **Plug and play** — auto-detects 12 local backends (Ollama, LM Studio, vLLM, KoboldCpp, Jan, llama.cpp, LocalAI, GPT4All, TabbyAPI, Aphrodite, SGLang, TGI). Nothing installed? One click installs the engine for you.
- **Free forever** — AGPL-3.0. The models are open weights. No subscription, no credits, no rate limits.

**New to local AI?** Start with the [5-minute beginner guide](https://locallyuncensored.com/blog/how-to-run-ai-locally.html) — no command line anywhere.

---

### Screenshots

| Chat that draws your images | Built-in image & video studio |
|:---:|:---:|
| ![Chat](docs/screenshots/chat_generate_dark.webp) | ![Create](docs/screenshots/create_gallery_dark.webp) |
| **Coding Agent reviews & fixes** | **Agent Mode builds it for you** |
| ![Coding Agent](docs/screenshots/coding_review_dark.webp) | ![Agent Mode](docs/screenshots/agent_mode_dark.webp) |

---

## Download

Grab the latest release from [**Releases**](https://github.com/PurpleDoubleD/locally-uncensored/releases/latest):

| Platform | File | Status |
|----------|------|--------|
| **Windows 10/11** | `.exe` (NSIS, recommended) or `.msi` | Fully tested, signed auto-update channel |
| **Linux** | `.deb` / `.rpm` / `.AppImage` | Packages on every release |
| macOS | — | Coming soon (source builds via `npm run tauri build`) |

> **Antivirus warning?** Some engines flag unsigned NSIS installers that download other binaries — a **false positive**. The installer is built by GitHub Actions from the public source on `master`, and the auto-update channel is signed against a public minisign key. Verification steps: [SECURITY.md](SECURITY.md#antivirus--browser-false-positives).

**Current release: v2.6.6** (August 2026). Portable-friendly installers for Windows and Linux (no admin rights required), under the short in-app name **LU** by LU Labs. Full history in [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases) and [CHANGELOG.md](CHANGELOG.md).

### What's new in 2.6.5

The self-healing release. Updating works again: the installer closes our own running engine first instead of failing at "Error opening file for writing" and rolling everything back. The image track gained a LoRA section with a Rescan button, so characters you trained and files you dropped in are selectable and stackable. A ComfyUI environment that dies at import is detected and rebuilt into its own venv, with a Repair button in Settings, and fresh setups install a torch build the current core actually accepts. The built-in engine keeps its conversation memory when an image or video render needs the VRAM. Settings, Model Storage, "Scan for local models" links the models Ollama and LM Studio already store, no copying, no re-download. Model downloads no longer freeze at "Refreshing the model list": the install waits, restarts ComfyUI once if needed, and says what is wrong instead of hanging. Also fixed: trainer Cancel really stops the run and frees the GPU, Blackwell cards get the right torch build with a clear preflight, AMD cards show up without the ROCm tools, staged changes apply again and survive a restart, the gallery shows the seed that was really rolled, tooltips are readable everywhere, drag and drop works again on Windows, environment rebuilds show size, speed and time left, and FramePack got its proper VAE back.

### What's new in 2.6.4

Two money fixes from your bug reports. The Cloud switch now really means off: flipping to Local with no local model running used to keep the cloud model silently active and kept billing credits; the send path now refuses any model from the wrong mode. And the music price in the picker follows the length slider live, billing was always per second but the label quoted 1 minute, so a 3 minute song looked three times cheaper than it was. What you see is what you pay.

### What's new in 2.6.3

The reliability release. Agent and Code mode were driven end to end on the shipped build for a week and fixed where they actually broke: runs no longer stall, loop, or invent results, small local models get the tool transport their server really supports (the bundled engine used to swallow tool definitions silently), approvals stay visible, Stop always stops, and the run budget respects what LM Studio actually loaded. New: group chat with 2 to 4 local models answering in turn, an edit pencil on every model answer, one-click chips for the native Wan video sizes with a portrait/landscape flip, native HiRes fix for local image generation (community PR #97 by Kizerfluid), RTX 50 support for character training with a preflight that names a broken environment before the run, and personal API keys so any OpenAI-compatible tool can use your cloud plan. Long chats got a deep memory fix, generated images survive a restart, your own lyrics really get sung, every cloud model shows its price in the picker, and the benchmark measures cost and correctness instead of just speed. Every download is 7 MB smaller.

### What's new in 2.6.2

Custom ComfyUI workflows are back, built on a community PR by Kizerfluid (#94). The workflow button in the Create prompt bar opens a manager popup: import any workflow saved with ComfyUI's Save (API Format), pair it with models through shared tags, and pick it in the Workflow selector under Advanced settings; Auto returns to the built-in graph. Prompt, size, steps and seed are still injected, custom I2V workflows get the source image wired in, and video nodes save to the gallery instead of the temp folder. Also fixed: read aloud on Windows N editions (playback now falls back to codec-free Web Audio), pip errors from a Python built without ssl name the real problem, and ComfyUI model discovery survives one unreadable folder.

### What's new in 2.6.1

Create could not submit anything on setups whose ComfyUI runs the pure Python HTTP parser: the app put the Content-Type header on the wire twice and ComfyUI refused the request with a 400. The header a caller sends now wins, and the same trap is closed for the other headers the HTTP stack derives itself.

### What's new in 2.6.0

The GGUF video release: found by running the shipped build end to end on a real 12 GB card, plus a round of customer reports from Discord and GitHub.

- **GGUF video models generate for the first time.** The catalog offered GGUF video bundles (19 GB downloads) that could never render a clip: the video pipeline only read the loaders that list `.safetensors`. The GGUF loaders are wired in now, the Video lane shows its starter card on an empty model list, and a freshly booted app no longer races its own model list.
- **Video renders finish on 12 GB cards.** After sampling, the video decode ran full-frame next to the resident model, got paged by the Windows driver instead of a clean out-of-memory, and sat at 100% GPU for an hour. Every video decode now runs tiled whenever the installed ComfyUI supports it, which turns that hour into minutes.
- **The render progress bar ticks.** The long phases (model load, frame decode) send no ComfyUI events for minutes, so the bar froze and looked hung while the GPU was working. It now ticks every second with the phase and elapsed time.
- **The Linux AppImage no longer breaks Python installs.** It leaked its bundled libraries into every Python it launched, which broke ComfyUI installs for every AppImage user. Helper processes start clean now.
- **Downloads got honest.** Big model downloads no longer die in a fixed timeout and resume where they stopped, and the Downloads tab shows real per-file progress with proper GB formatting.
- **A pile of reported fixes.** Document chat handles files without punctuation, VRAM above 4 GB is no longer invented, deleting a chat is findable, read-aloud installs its Piper voice correctly, external MCP servers can actually spawn, the built-in engine says what is wrong instead of a proxy error, and the agent got a screenshot tool.
- **LU Cloud grew too:** DeepSeek V4 Flash joined the cloud catalog, and the cloud Edit lane gained Qwen Image Edit, which edits from a plain instruction with no mask needed.

---

## Quick Start

1. **Install** — download the installer and run it. No Docker, no terminal, no config files.
2. **Detect** — the first-launch wizard scans for all 12 supported local backends and offers one-click installs if none are running. ComfyUI (for images/video) is detected or installed the same way.
3. **Run** — pick a model in the Model Manager (hardware-aware recommendations, one-click downloads) and start chatting. Flip to the Coding Agent or the Create tab whenever you like.

Full walkthrough with screenshots: [Getting Started Guide](https://locallyuncensored.com/guide/).

<details>
<summary><strong>Build from source / contribute</strong></summary>

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev          # browser dev-mode (for contributing)
npm run tauri build  # production desktop binary
```

`setup.bat` (Windows) / `setup.sh` (Linux/macOS) bootstrap Node, Git, and Ollama for dev-mode. See the [Contributing Guide](CONTRIBUTING.md).

</details>

---

## Features

### Chat
- **Uncensored AI chat** — abliterated models with the refusal behavior removed from the weights (not a jailbreak). Streaming, thinking display, unlimited history.
- **20+ provider presets** — local: Ollama, LM Studio, vLLM, KoboldCpp, llama.cpp, LocalAI, Jan, TabbyAPI, GPT4All, Aphrodite, SGLang, TGI. Cloud (optional, your keys): OpenAI, Anthropic, OpenRouter, Groq, Together, DeepSeek, Mistral.
- **Thinking Mode** (provider-agnostic), **file upload with vision**, **memory system**, **Document Chat (RAG)** with local embeddings, **voice** (Whisper STT + neural TTS), **25+ personas**, chat import from ChatGPT/Claude/Gemini exports.

### Create — images & video
- **Image generation** via a bundled, auto-managed ComfyUI: FLUX 2 Klein, FLUX.1, Juggernaut XL, Z-Image Turbo (uncensored), ERNIE-Image, SDXL, SD 3.5. Per-model correct defaults — no node graphs, no config. [How it works](https://locallyuncensored.com/blog/easiest-local-ai-image-generator.html).
- **Video generation** with Wan 2.1/2.2, HunyuanVideo 1.5, LTX 2.3, AnimateDiff, Mochi, Cosmos. **Image-to-video** with FramePack F1 on just 6 GB VRAM. **Image-to-image** with denoise control, in a tab now labelled **Edit / Image to Image**.
- **Talking Character, Music, Extend Video and Motion Control run on your own GPU** as normal local lanes, built from core ComfyUI node families. Only Upscale, Erase Object and Character Studio are cloud only. Per-lane frame, size and step controls let you trade quality for speed.
- LoRA picker, VAE override, CLIP-skip, and a local gallery for everything you make. No content filter, no watermark, no credits.

### Code & agents
- **Coding Agent** with Architect mode, repo-map (Aider-style PageRank), a surgical `file_edit` tool that rewrites only the lines you asked for, review-before-apply diffs, test-runner loop, typed git/GitHub tools, multi-repo workspaces, per-project `.lurules`.
- **Agent Mode** — 28 tools + MCP: web search/fetch, file I/O, shell, code execution, screenshots, background tasks, parallel sub-agents. **Granular permissions** (7 categories, 3 levels).
- **Claude Code CLI integration** and universal tool calling — native for supported models, XML fallback for everything else.

### Everywhere
- **Remote access from your phone** with a full mobile web app over LAN or Cloudflare Tunnel: QR pairing, 6-digit passcode, opt-in, visible connection status. Works with non-Ollama backends too (LM Studio, Lemonade, llama.cpp), translated to and from the OpenAI-compatible shape, including streaming, tool calls, vision and reasoning. [Details](https://locallyuncensored.com/blog/local-ai-on-your-phone.html).
- **A/B model compare**, **local benchmark**, hardware-aware model recommendations, model load/unload, auto-update over a signed channel.

---

## Why Locally Uncensored?

| Feature | Locally Uncensored | Open WebUI | LM Studio | Jan | SillyTavern |
|---------|:-:|:-:|:-:|:-:|:-:|
| AI Chat | **Yes** | Yes | Yes | Yes | Yes |
| Image Generation | **Yes** | No | No | No | Via ext. |
| Video Generation | **Yes** | No | No | No | No |
| Image-to-Image / Image-to-Video | **Yes** | No | No | No | No |
| Coding Agent | **Yes** | No | No | No | No |
| Agent Tools + MCP | **28 tools** | No | No | No | No |
| Plug & Play Backend Setup | **12 backends** | No | Built-in | Built-in | No |
| Remote Access (Phone) | **Yes** | Browser | No | No | Browser |
| A/B Compare + Benchmark | **Yes** | No | No | No | No |
| Uncensored by Default | **Yes** | No | No | No | Partial |
| Voice (STT + TTS) | **Yes** | Partial | No | No | Partial |
| Document Chat (RAG) | **Yes** | Yes | No | No | No |
| No Docker Required | **Yes** | No | Yes | Yes | Yes |
| Open Source | **AGPL-3.0** | Open | No | AGPL | AGPL |

Deep dives: [vs LM Studio](https://locallyuncensored.com/blog/locally-uncensored-vs-lm-studio.html) · [vs Jan](https://locallyuncensored.com/blog/locally-uncensored-vs-jan.html) · [vs Open WebUI](https://locallyuncensored.com/blog/locally-uncensored-vs-open-webui.html) · [vs GPT4All](https://locallyuncensored.com/blog/locally-uncensored-vs-gpt4all.html) · [vs Msty](https://locallyuncensored.com/blog/locally-uncensored-vs-msty.html) · [vs KoboldCpp](https://locallyuncensored.com/blog/locally-uncensored-vs-koboldcpp.html) · [vs SillyTavern](https://locallyuncensored.com/blog/locally-uncensored-vs-sillytavern.html) · [LM Studio alternatives](https://locallyuncensored.com/blog/lm-studio-alternatives.html) · [Best local AI apps 2026](https://locallyuncensored.com/blog/best-local-ai-apps-2026.html)

---

## Recommended Models

75+ one-click downloads in the Model Manager, filtered by what your hardware can run. Highlights:

### Text (any local backend)

| Model | VRAM | Best For |
|-------|------|----------|
| **Qwen 3.6 35B MoE** | 24 GB | Vision + agentic coding + thinking. 256K context. Day-0 support. |
| **Qwen 3.5 35B MoE** | 16 GB | Best agentic, SWE-bench leader. |
| **GLM-4.7-Flash IQ2** | 12 GB | Strongest 30B class. Tool calling, 198K context. |
| **Gemma 4 27B / E4B** | 16 / 4 GB | Google flagship — native tools + vision; E4B runs on small GPUs. |
| **GPT-OSS 120B / 20B** | via Ollama | OpenAI's open-weight models. |
| Llama 3.1 8B Abliterated | 6 GB | The classic uncensored starting point. |
| Hermes 3 8B | 6 GB | Uncensored + reliable tool calling for Agent Mode. |
| DeepSeek R1 (8B–70B) | 6–48 GB | Visible chain-of-thought reasoning. |

### Image (ComfyUI, auto-managed)

| Model | VRAM | Notes |
|-------|------|-------|
| FLUX.1 Schnell / Dev | 8–10 GB | Best text-to-image; fast or quality. |
| FLUX 2 Klein 4B | 8–10 GB | Next-gen, fastest FLUX. |
| Juggernaut XL V9 | 6 GB | Best photoreal SDXL — friendliest entry point. |
| Z-Image Turbo | 10–16 GB | Uncensored, 8–15 s per image. |
| ERNIE-Image Turbo | 24 GB | Baidu DiT, 8 steps. |

### Video (ComfyUI, auto-managed)

| Model | VRAM | Notes |
|-------|------|-------|
| Wan 2.1 T2V 1.3B / 14B | 8–10 / 12+ GB | Fast entry point → high quality 720p. |
| FramePack F1 (I2V) | 6 GB | Image-to-video on remarkably low VRAM. |
| LTX 2.3 | 10 GB | Fast text-to-video on modest hardware. |
| HunyuanVideo 1.5 | 12+ GB | Excellent temporal consistency. |
| AnimateDiff Lightning | 6–8 GB | Ultra-fast 4-step animation. |

---

## FAQ

**Is it really free and offline?**
Yes. AGPL-3.0, no account, no telemetry, no usage limits. After the initial model download the local stack works fully offline. Cloud providers are optional and bring-your-own-key.

**What does "uncensored" mean?**
Abliterated models have the trained-in refusal behavior removed from the weights themselves — not a jailbreak, nothing to patch or break. The model answers directly. Combined with local execution, your conversations stay private. [Full guide](https://locallyuncensored.com/blog/abliterated-models-guide.html).

**What hardware do I need?**
Text chat: 8 GB RAM. Fast 8B chat: a GPU with 6 GB VRAM. Image generation: NVIDIA GPU with 8+ GB VRAM. Video: 10–12 GB (image-to-video from 6 GB via FramePack F1). The app recommends models that fit your machine.

**Can it replace ChatGPT or Claude?**
For most chat, writing, and coding: yes, with a good 8–14B local model — private, unlimited, and refusal-free. Frontier cloud models are still stronger on the hardest reasoning; add them via your own API keys if you want both.

**Does remote access leak data?**
No. It's opt-in, passcode-gated, and shows connected devices. LAN traffic never leaves your network; away from home an encrypted Cloudflare tunnel connects phone and PC. No third-party AI server involved.

**macOS?**
Not yet — Windows and Linux today, macOS is on the roadmap. The source builds on macOS via `npm run tauri build` if you want to try.

---

## Roadmap

Everything from plug-and-play backend setup through the coding agent, Agent Mode (28 tools + MCP), image/video generation, remote access, voice, RAG, A/B compare, and signed auto-update has shipped — see [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases) for the full history.

**Next up:**
- [ ] Create-tab polish + new generation features (face-ID / PuLID, cleaner image & video workflow)
- [ ] Upscale + inpainting
- [ ] Voice Mode (live voice conversations)
- [ ] macOS build

---

## Tech Stack

**Tauri v2** (Rust backend, lightweight standalone binary) · **React 19 + TypeScript + Tailwind CSS 4** · **Vite 8** · ComfyUI for media, faster-whisper for STT · 20+ AI provider integrations.

## Community

Join the Discord: **https://locallyuncensored.com/discord** — help channels for chat, image gen, video gen, and the coding agent. Bugs and ideas: [Issues](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=bug_report.yml) · [Discussions](https://github.com/PurpleDoubleD/locally-uncensored/discussions).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

---

<div align="center">

**Your data stays on your machine.**

[Website](https://locallyuncensored.com) · [Beginner Guide](https://locallyuncensored.com/blog/how-to-run-ai-locally.html) · [Blog](https://locallyuncensored.com/blog/) · [Report Bug](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=bug_report.yml) · [Request Feature](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=feature_request.yml)

</div>
