# Locally Uncensored

**Private, local AI chat & media generation. No cloud. No censorship. No data collection.**

A beautiful, feature-rich web app for running uncensored AI models entirely on your own hardware. Chat with abliterated LLMs via Ollama and generate images/videos with ComfyUI — all offline, all private.

---

## Features

- **Uncensored AI Chat** — Run abliterated models locally with full control
- **25+ Personas** — From Helpful Assistant to Roast Master, choose your AI personality
- **Image Generation** — Text-to-image via ComfyUI with full parameter control
- **Video Generation** — Text-to-video support with frame and FPS settings
- **Thinking Display** — See the AI's reasoning process in collapsible blocks
- **Model Manager** — Install, manage, and switch between models with one click
- **Discover Models** — Browse and install uncensored models from the Ollama registry
- **Dark/Light Mode** — Beautiful UI with glassmorphism design
- **100% Local** — Everything runs on your machine, nothing leaves your network
- **Conversation History** — All chats saved locally in your browser

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Framer Motion
- **State**: Zustand with localStorage persistence
- **AI Backend**: Ollama (text), ComfyUI (images/video)
- **Build**: Vite 8

## Quick Start

### One-Command Setup (Windows)

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
setup.bat
```

That's it. The setup script automatically:
1. Installs Node.js, Git, and Ollama (if missing)
2. Installs all dependencies
3. Downloads a recommended uncensored AI model (~5.7 GB)
4. Creates a desktop shortcut
5. Starts the app in your browser

### Manual Installation

**Prerequisites:** [Node.js](https://nodejs.org/) 18+, [Ollama](https://ollama.com/)

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev
```

Open **http://localhost:5173** — the app recommends models on first launch.

### Image/Video Generation (Optional)

1. Install [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
2. Create a `.env` file in the project root:
   ```
   COMFYUI_PATH=C:\path\to\your\ComfyUI
   ```
3. Click **Start ComfyUI** in the Create tab, or start it manually
4. Download image models (e.g., SDXL checkpoints) into ComfyUI's `models/checkpoints` folder

### One-Click Start (Windows)

Use `start.bat` to launch everything together:
```batch
start.bat
```

## Recommended Models

### Text (Ollama)

| Model | Size | VRAM | Best For |
|-------|------|------|----------|
| Llama 3.1 8B Abliterated | 5.7 GB | 6 GB | Fast all-rounder |
| Qwen3 8B Abliterated | 5.2 GB | 6 GB | Coding |
| Mistral Nemo 12B Abliterated | 6.8 GB | 8 GB | Multilingual |
| DeepSeek R1 8B Abliterated | 5 GB | 6 GB | Reasoning |
| Qwen3 14B Abliterated | 9 GB | 12 GB | High intelligence |

### Image (ComfyUI)

| Model | VRAM | Notes |
|-------|------|-------|
| Juggernaut XL V9 | 8 GB | Best photorealistic |
| FLUX.1 Schnell | 10-12 GB | State-of-the-art |
| Pony Diffusion V6 XL | 8 GB | Anime/stylized |

## Configuration

### Environment Variables

Create a `.env` file (see `.env.example`):

```env
# Path to your ComfyUI installation (optional)
COMFYUI_PATH=C:\path\to\your\ComfyUI
```

### In-App Settings

- **Temperature** — Controls randomness (0 = deterministic, 1 = creative)
- **Top P / Top K** — Fine-tune token sampling
- **Max Tokens** — Limit response length (0 = unlimited)
- **Theme** — Dark or Light mode

## Project Structure

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

## Contributing

Contributions are welcome! Feel free to open issues and pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Built with privacy in mind. Your data stays on your machine.**
