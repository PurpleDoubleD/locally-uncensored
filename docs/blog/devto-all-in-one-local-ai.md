---
title: "The All-in-One Local AI App: Chat + Images + Video Without the Cloud"
published: false
description: "Stop switching between Ollama, ComfyUI, and five browser tabs. Locally Uncensored is a single desktop app for AI chat, image generation, and video creation — 100% local, zero telemetry, no cloud required."
tags: ai, opensource, privacy, selfhosted
cover_image: https://raw.githubusercontent.com/PurpleDoubleD/locally-uncensored/master/docs/screenshots/create_dark.jpg
canonical_url: https://github.com/PurpleDoubleD/locally-uncensored
---

There's a point in every local AI enthusiast's journey where you realize you're juggling too many tools. Ollama for chat. ComfyUI for images (if you can get it working). Some other tool for video. A separate app for voice transcription. And none of them talk to each other.

You end up with five terminal windows, three browser tabs, and a growing suspicion that this shouldn't be this hard.

That's why I built **Locally Uncensored** — a single desktop app that does AI chat, image generation, and video creation. Everything runs on your machine. Nothing touches the cloud. No Docker required. You download a .exe, double-click it, and you're done.

## The Problem: Death by a Thousand Tabs

If you're running local AI today, your workflow probably looks something like this:

1. Open a terminal, run `ollama serve`
2. Open another terminal, navigate to your ComfyUI folder, activate the venv, run `python main.py`
3. Open a browser tab for whatever chat UI you're using
4. Open another browser tab for ComfyUI's node editor
5. Realize you need a different model, open yet another tab to download it
6. Wait, which folder does this model go in? `checkpoints`? `diffusion_models`? `unet`?
7. The chat UI doesn't know about your image models. The image UI doesn't know about your chat models. Nothing is connected.

This isn't a workflow. It's a chore list.

And that's before we talk about privacy. Many "local" AI tools still phone home. They load fonts from Google CDN, pull scripts from third-party servers, send analytics data, or check for updates through services that log your IP. "Local" often just means "the inference is local."

## The Solution: One App, Everything Local

Locally Uncensored combines everything into a single app with three main views:

**Chat** — Talk to AI using models from Ollama. 25+ built-in personas (Helpful Assistant, Creative Writer, Code Expert, Roast Master, and more). Full markdown rendering with syntax highlighting. Collapsible "thinking" blocks that show the AI's reasoning chain. Conversation history saved locally.

**Create** — Generate images and videos using ComfyUI as the backend. Pick a model, type a prompt, adjust parameters, hit generate. The app auto-detects your installed models (checkpoints, diffusion models, VAEs) and builds the right workflow for your hardware. No node editing required.

**Models** — Browse, install, and manage all your AI models in one place. Search CivitAI directly from the app. Download models with pause/resume support. One-click installation of curated model bundles. The app puts files in the right folders automatically.

Everything runs through a native desktop app built with Tauri (Rust backend) and React. No browser, no terminal, no Docker, no Node.js runtime. Just a standalone binary.

## How It Compares

Here's an honest comparison with the tools most people are using:

| Feature | Locally Uncensored | Open WebUI | LM Studio | SillyTavern |
|---------|:--:|:--:|:--:|:--:|
| AI Chat | Yes | Yes | Yes | Yes |
| Image Generation | Yes | No | No | No |
| Video Generation | Yes | No | No | No |
| Uncensored by Default | Yes | No | No | Partial |
| One-Click Setup | Yes | No (Docker) | Yes | No (Node.js) |
| 25+ Built-in Personas | Yes | No | No | Manual |
| CivitAI Marketplace | Yes | No | No | No |
| Dynamic Workflow Builder | Yes | No | No | No |
| Document Chat (RAG) | Yes | Yes | No | No |
| Voice (STT + TTS) | Yes | Partial | No | No |
| AI Agents | Yes | No | No | No |
| Portable / No-Install | Yes | No | Yes | No |
| No Docker Required | Yes | No | Yes | Yes |
| 100% Offline Capable | Yes | Yes | Yes | Yes |
| Open Source | Yes (MIT) | Yes | No | Yes |
| Zero Telemetry | Yes | Yes | Unknown | Yes |

The key differentiator: Locally Uncensored is the only open-source tool that combines text, image, and video generation in one interface. Others do one thing well but force you to context-switch for everything else.

## What You Can Actually Do With It

### Chat with 25+ Personas

The app ships with over 25 personas, each with a distinct personality and system prompt. You're not stuck with a generic assistant. Pick the Coding Expert for programming help, the Creative Writer for stories, the Debate Champion for arguments, or the Roast Master if you want to be insulted by an AI. Each persona adjusts the AI's behavior, tone, and approach.

You can use any Ollama-compatible model. The app recommends uncensored/abliterated models on first launch based on your hardware:

| Model | Size | VRAM | Best For |
|-------|------|------|----------|
| Llama 3.1 8B Abliterated | 5.7 GB | 6 GB | Fast all-rounder |
| Qwen3 8B Abliterated | 5.2 GB | 6 GB | Coding |
| Mistral Nemo 12B Abliterated | 6.8 GB | 8 GB | Multilingual |
| DeepSeek R1 8B Abliterated | 5 GB | 6 GB | Reasoning |
| Qwen3 14B Abliterated | 9 GB | 12 GB | High intelligence |

### Generate Images Without Node Graphs

ComfyUI is powerful but intimidating. Its node-based editor is designed for experts who want total control. Most people just want to type a prompt and get an image.

Locally Uncensored wraps ComfyUI with a clean UI: prompt box, model selector, parameter sliders (steps, CFG, resolution), and a generate button. Behind the scenes, the app queries ComfyUI's available nodes and dynamically builds the optimal workflow for your model type. It knows whether you're running SDXL, Flux, or Pony Diffusion and constructs the correct pipeline automatically.

No node wiring. No workflow JSON files. No "which custom nodes do I need?" Just results.

### Create Videos from Text

Video generation works the same way. The app supports Wan 2.1/2.2 and AnimateDiff models. Select a video model, type a prompt, set your parameters, and generate. The app detects which video backend you have and constructs the workflow.

| Model | VRAM | Output | Notes |
|-------|------|--------|-------|
| Wan 2.1 T2V 1.3B | 8-10 GB | 480p WEBP | Built-in nodes, no extras |
| Wan 2.2 T2V 14B (FP8) | 10-12 GB | 480-720p | Higher quality |
| AnimateDiff v3 + SD1.5 | 6-8 GB | MP4 | Requires AnimateDiff nodes |

### Browse and Install Models from CivitAI

The Model Marketplace lets you search CivitAI directly from the app. Find a model you like, click Install, and it downloads to the correct ComfyUI subfolder automatically. No more guessing whether a file goes in `checkpoints`, `diffusion_models`, `vae`, or `text_encoders`.

Downloads support pause, resume, and cancellation. Models are often 2-10 GB, so the download manager tracks progress and speed in real-time. If your connection drops, resume from where you left off.

### Model Bundles: One Click, Full Setup

For new users, the Model Manager includes curated bundles. Click "Install All" on an image or video bundle and it downloads every model you need — checkpoint, VAE, text encoders, the works — to the right folders. You go from "I just installed the app" to "I'm generating images" in one click.

### Upload Documents, Chat with Your Files

The RAG (Retrieval-Augmented Generation) feature lets you upload PDFs, DOCX, or TXT files and ask questions about them. The app chunks your documents, creates embeddings locally, and uses them to ground the AI's responses in your actual data. No files leave your machine.

### Talk to Your AI

Push-to-talk voice input using faster-whisper (a local speech-to-text engine). Speak your prompt, see the live transcription, and get a response. Text-to-speech reads the AI's reply back to you. The entire voice pipeline runs locally — no Google, no Azure, no API keys.

## The Privacy Angle

"Local AI" tools often aren't as local as they claim. Here's what Locally Uncensored actually does:

**Zero external tracking.** No Google Fonts (all fonts are bundled). No CDN scripts. No analytics. No telemetry. No update checks that log your IP.

**All API calls proxied locally.** Every request to CivitAI, Ollama's model registry, or any external service goes through the Rust backend. The WebView never directly contacts external servers. This means your browser fingerprint, cookies, and session data are never exposed.

**No accounts. No sign-in.** There's nothing to sign up for. No usage limits. No "free tier." No email capture. Download, run, use.

**Data stays on disk.** Conversations are saved in your browser's localStorage. Models live in standard Ollama and ComfyUI directories. Settings are stored in your OS config folder. Everything is in files you control.

**Open source under MIT.** You can audit every line of code. The Rust backend is ~500 lines across a handful of files. There's nowhere to hide a tracking pixel.

This isn't privacy as a marketing checkbox. It's privacy as an architectural decision. The app was designed from day one to never need the internet after initial setup (model downloads aside).

## Getting Started

### Option 1: Download the Desktop App (Recommended)

1. Go to [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases)
2. Download the installer for your platform (.exe for Windows, .AppImage for Linux, .dmg for macOS)
3. Install [Ollama](https://ollama.com/) if you don't have it
4. Launch Locally Uncensored — it auto-starts Ollama and guides you through setup

### Option 2: Run from Source

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev
```

Open `http://localhost:5173`. The app recommends models on first launch.

### Setting Up Image/Video Generation

1. Open the **Create** tab
2. If ComfyUI isn't found, click **"Install ComfyUI Automatically"** — it clones the repo, installs dependencies, and sets up CUDA
3. Go to **Models > Discover** and install a model bundle
4. Generate

The entire ComfyUI setup happens inside the app. No terminal commands required.

## What's Coming Next

The roadmap includes:

- Audio generation (text-to-speech, music)
- Plugin system for community extensions
- Custom persona creator
- Multi-user mode for sharing your AI server at home
- Mobile-responsive layout
- Export/import for backups

## Why Not Just Use ChatGPT?

You absolutely can. ChatGPT is excellent. But:

- Your conversations are stored on OpenAI's servers
- You're subject to content policies and censorship
- It costs money beyond the free tier
- You need an internet connection
- You can't control the model or its behavior at a system level

Local AI gives you complete control. You pick the model. You set the rules. You own the data. And with abliterated/uncensored models, there are no artificial restrictions on what you can ask or generate.

Locally Uncensored makes that accessible to people who don't want to be sysadmins. You don't need to know what a virtual environment is, or what port ComfyUI runs on, or how to write a ComfyUI workflow. You just need a GPU and an internet connection for the initial downloads.

## Try It

The project is open source under MIT: [github.com/PurpleDoubleD/locally-uncensored](https://github.com/PurpleDoubleD/locally-uncensored)

Windows, Linux, and macOS builds are available on the [Releases page](https://github.com/PurpleDoubleD/locally-uncensored/releases).

If you find it useful, a star on GitHub helps others discover it. If you hit a bug or have an idea, open an issue or join the [Discussions](https://github.com/PurpleDoubleD/locally-uncensored/discussions).

Your AI, your machine, your rules.

---

*Built by [David](https://github.com/PurpleDoubleD). Questions? Comments? Drop them below or open a GitHub discussion.*
