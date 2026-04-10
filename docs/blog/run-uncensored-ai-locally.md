---
title: "How to Run Uncensored AI Locally: Chat, Images & Video in One App"
description: "A practical guide to running uncensored AI on your own hardware. Learn about abliterated models, set up Locally Uncensored with Ollama and ComfyUI, and generate text, images, and video — all offline."
date: 2025-03-29
tags: [ai, local-ai, ollama, comfyui, uncensored-ai, llm, stable-diffusion, open-source]
canonical_url: https://purpledoubled.github.io/locally-uncensored/blog/run-uncensored-ai-locally
cover_image: https://raw.githubusercontent.com/PurpleDoubleD/locally-uncensored/master/docs/social-preview.png
published: true
---

# How to Run Uncensored AI Locally: Chat, Images & Video in One App

If you've spent any time with ChatGPT, Midjourney, or other cloud AI services, you've run into the walls. The "I can't help with that" responses. The content policies that treat every request like a potential crime. The nagging feeling that your conversations are being logged, reviewed, and used to train the next model.

There's a better way. You can **run uncensored AI locally** on your own hardware — chat, image generation, and video creation — without sending a single byte to the cloud.

This guide walks through how to do exactly that using [Locally Uncensored](https://purpledoubled.github.io/locally-uncensored/), an open-source desktop app that combines Ollama and ComfyUI into a single interface.

## Why Run AI Locally?

Let's skip the philosophical debates and talk about the practical reasons developers are moving to local AI:

**Privacy is non-negotiable.** Every prompt you send to OpenAI or Anthropic is stored on their servers. Even if you trust these companies today, policies change. Running locally means your conversations about proprietary code, personal projects, or creative writing never leave your machine.

**No content restrictions.** Cloud AI providers filter outputs aggressively. This isn't just about NSFW content — it affects legitimate use cases too. Writers working on fiction with complex themes, security researchers analyzing vulnerabilities, medical professionals discussing symptoms — all get hit by the same blunt content filters. Local models don't have these restrictions.

**No rate limits, no subscriptions.** Once you download a model, it's yours. Run it 24/7 if you want. No API keys, no $20/month subscriptions, no "you've reached your limit" messages at 2am when you're deep in a coding session.

**Offline capability.** Your AI stack works on a plane, in a cabin with no internet, or during your ISP's inevitable outage. Models run on your GPU (or CPU if you're patient), fully offline.

**Reproducibility and control.** You choose the exact model version, quantization level, and parameters. No silent model swaps or behavior changes like what happens when cloud providers update their models behind the scenes.

## What is Abliteration?

You'll see the term "abliterated" models thrown around in the local AI community, and it's worth understanding what it actually means.

Most open-weight models like Llama 3.1 ship with safety training baked in — a process called RLHF (Reinforcement Learning from Human Feedback) that teaches the model to refuse certain requests. Abliteration is a technique that surgically removes these refusal behaviors without destroying the model's general capabilities.

The process works by identifying the specific neural network directions (in the residual stream) that correspond to "I can't help with that" style refusals, then orthogonalizing them out. The result is a model that responds to all requests straightforwardly, without the trained-in refusal patterns.

This isn't jailbreaking — it's a permanent modification to the model weights. An abliterated Llama 3.1 8B is just as capable at coding, analysis, and conversation as the original. It just doesn't refuse requests.

Common abliterated models you can run locally:

- **Llama 3.1 8B Abliterated** — the go-to starting point, 5.7 GB, runs on 6 GB VRAM
- **Mistral Nemo 12B Abliterated** — stronger multilingual support, 6.8 GB
- **Qwen 3 Abliterated** — excellent for reasoning tasks and CJK languages
- **DeepSeek R1** — chain-of-thought reasoning with visible thinking process

These models are hosted on Hugging Face and Ollama's registry, freely downloadable.

## Setting Up Locally Uncensored (Step by Step)

[Locally Uncensored](https://github.com/PurpleDoubleD/locally-uncensored) is a **local AI app** that wraps Ollama (for chat) and ComfyUI (for image/video generation) into one clean interface. Think of it as what you'd get if you combined Open WebUI and ComfyUI into a single app, then made it actually easy to set up.

Here's how to get it running:

### Prerequisites

- A computer running Windows, macOS, or Linux
- 8 GB RAM minimum (16 GB recommended)
- For image generation: NVIDIA GPU with 8+ GB VRAM
- For video generation: 10-12 GB VRAM recommended

### Step 1: Clone the Repository

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
```

### Step 2: Run the Setup Script

**Windows:**
```bash
setup.bat
```

**macOS / Linux:**
```bash
chmod +x setup.sh
./setup.sh
```

The setup script handles everything automatically:
- Checks for Node.js and installs it if missing
- Checks for Ollama and installs it if missing
- Downloads a recommended abliterated chat model (~5.7 GB)
- Installs npm dependencies
- Launches the app in your default browser

### Step 3: Start Chatting

The app opens at `localhost:5173`. You'll see 25+ built-in personas ready to go — from a helpful coding assistant to creative writing characters. Pick one, or just start typing in the default chat.

### Step 4: Enable Image Generation (Optional)

Click the **Create** tab, then click **Install ComfyUI**. The app downloads and configures ComfyUI automatically — no manual node installation, no workflow files to hunt down. Once installed, you can generate images with models like FLUX.1 Schnell, Juggernaut XL, or any SDXL checkpoint.

### Step 5: Enable Video Generation (Optional)

With ComfyUI installed, you can also generate video using Wan 2.1 text-to-video. The app handles the ComfyUI workflow behind the scenes — you just type a prompt and hit generate. No node graph editing required.

The entire setup takes under 5 minutes (plus model download time, which depends on your internet speed).

## Supported Models

One of the advantages of Locally Uncensored is that it auto-detects models across both Ollama and ComfyUI. Here's what's supported:

### Chat Models (via Ollama)

Any model in the Ollama registry works. The app's model manager lets you browse and install them with one click:

| Model | Size | Best For |
|-------|------|----------|
| Llama 3.1 8B Abliterated | 5.7 GB | General purpose, coding, conversation |
| Mistral Nemo 12B | 6.8 GB | Multilingual, longer context |
| Qwen 3 8B | 5.2 GB | Reasoning, CJK languages |
| DeepSeek R1 8B | 5.4 GB | Chain-of-thought analysis |

### Image Models (via ComfyUI)

| Model | VRAM | Best For |
|-------|------|----------|
| FLUX.1 Schnell | 10-12 GB | Best quality, excellent prompt following |
| Juggernaut XL V9 | 8 GB | Photorealistic portraits and scenes |
| Stable Diffusion XL | 8 GB | Good general purpose |
| Pony Diffusion V6 | 8 GB | Stylized and anime content |

### Video Models (via ComfyUI)

| Model | VRAM | Best For |
|-------|------|----------|
| Wan 2.1 T2V | 8-10 GB | Text-to-video generation |
| AnimateDiff | 8 GB | Animate existing images |

## How It Compares to Alternatives

Let's be honest about the landscape. There are good tools out there, and the right choice depends on what you need.

**Open WebUI** is the most popular Ollama frontend. It's well-built, has a large community, and handles chat well. But it requires Docker, only does text chat, and doesn't touch image or video generation. If all you need is a ChatGPT-like interface for local models, Open WebUI is solid. If you want the full **ollama ComfyUI combined** experience — chat plus image and video generation — it doesn't cover that.

**LM Studio** has the best UX for downloading and running models. It's polished, easy to use, and doesn't require Ollama at all (it has its own inference engine). The downsides: it's closed source, chat-only, and doesn't support image or video generation.

**SillyTavern** is purpose-built for roleplay and character-based chat. It has deep character customization that Locally Uncensored doesn't match. But it's chat-only, has a steeper setup curve, and doesn't integrate with ComfyUI.

**ComfyUI** itself is incredibly powerful for image and video generation, but it's a node-based workflow tool — not something you'd use for casual text-to-image generation. The learning curve is steep. Locally Uncensored uses ComfyUI as a backend but hides the complexity behind a simple prompt-and-generate interface.

**Where Locally Uncensored fits:** it's the only **local AI app** that combines uncensored chat, image generation, and video generation in one interface. It's not the best at any single task — Open WebUI has more chat features, ComfyUI has more image generation options — but it's the only tool where you can chat with an AI, generate an image from the conversation, and create a video clip, all without switching apps.

## FAQ

### What does "uncensored" actually mean in this context?

It means the AI models used don't have artificial content restrictions. They respond to all requests without refusals or disclaimers. This is achieved through abliterated model weights, not through prompt injection or jailbreaking. The models are structurally modified to remove refusal behavior.

### Is this legal?

Yes. Running open-weight AI models locally is completely legal. The models used (Llama 3.1, Mistral, Qwen, etc.) are released under permissive licenses that allow local use. You're responsible for what you do with the outputs, just like with any tool.

### Can I run this without an NVIDIA GPU?

For chat: absolutely. Ollama supports CPU inference, and Apple Silicon Macs get GPU acceleration via Metal. Chat models run fine on CPU, just slower. For image and video generation: you need an NVIDIA GPU with CUDA support (or an AMD GPU with ROCm on Linux). ComfyUI doesn't support CPU-only generation in any practical way.

### How much disk space do I need?

A minimal setup (one chat model) needs about 6 GB. If you add image generation models, plan for 15-25 GB depending on which checkpoints you download. Video models add another 8-10 GB. Everything is downloaded incrementally — start with chat and add generation models later.

### Can I use my own custom Ollama models or ComfyUI checkpoints?

Yes. The app auto-detects any model installed in Ollama and any checkpoint placed in ComfyUI's model directory. There's no lock-in to specific model sources.

### Does it phone home or collect telemetry?

No. Zero telemetry, zero analytics, zero network requests beyond what Ollama and ComfyUI need for their initial installation. Once set up, the entire stack runs on localhost. The code is AGPL-3.0 licensed and fully auditable on [GitHub](https://github.com/PurpleDoubleD/locally-uncensored).

### How is this different from just running Ollama + ComfyUI separately?

You absolutely can run them separately — many people do. Locally Uncensored saves you the hassle of maintaining two separate tools, switching between browser tabs, and manually configuring ComfyUI workflows. It's a convenience layer that ties everything together with a unified UI, built-in personas, and one-click model management.

## Getting Started

The fastest path from zero to **running uncensored local AI**:

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
# Windows: setup.bat | macOS/Linux: ./setup.sh
```

That's it. The setup script handles everything else.

Check out the [landing page](https://purpledoubled.github.io/locally-uncensored/) for screenshots and feature details, or go straight to the [GitHub repo](https://github.com/PurpleDoubleD/locally-uncensored) to browse the source.

If you run into issues or have feature requests, the [GitHub Discussions](https://github.com/PurpleDoubleD/locally-uncensored/discussions) page is the place.

---

*Locally Uncensored is AGPL-3.0 licensed and free to use. Built by [PurpleDoubleD](https://github.com/PurpleDoubleD).*
