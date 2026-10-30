# Contributing to Locally Uncensored

Thanks for your interest in contributing! This project thrives on community input.

## Getting Started

### Prerequisites

- **Node.js** 18+ ([download](https://nodejs.org/))
- **Ollama** ([download](https://ollama.com/)) — for text model testing
- **ComfyUI** (optional) — only needed for image/video gen features
- **Git** (obviously)

### Dev Setup

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
```

You have three dev workflows, depending on what you're working on:

```bash
# Full Tauri dev — hot-reload React + live Rust rebuilds. Use for 95 % of work.
npm run tauri:dev

# Browser-only — no Rust, no Tauri shell. Fast feedback for pure UI tweaks.
# Tauri invokes (backendCall, auto-update, filesystem access) do NOT work here.
npm run dev           # serves at http://localhost:5173

# Production build — emits a signed .exe / .msi / .AppImage / .deb / .rpm into
# src-tauri/target/release/bundle/. Use when you want to test a real installer.
npm run tauri:build
```

Most pull requests only need `npm run tauri:dev`. Thanks to a user for
flagging that these commands weren't spelled out here.

#### The LU Engine (llama-server sidecar)

The built-in engine is a llama.cpp `llama-server` that LU ships next to the
app (Tauri `externalBin`). It is not in git, and without the file the Rust
build stops, because `externalBin` must exist. Two ways to get it:

1. **Build it** (needs CMake and a C++ toolchain, on Windows and Linux also the
   Vulkan SDK):

   ```bash
   scripts/build-llama.sh          # for this machine
   scripts/build-llama.sh --check  # does the built binary start?
   ```

   It writes `src-tauri/bin/lu-llama-server-<triple>[.exe]` (with the other
   sidecars this platform ships, such as the Neuron tweaker's vector tool) and,
   on Windows and Linux, the companion libraries to
   `src-tauri/resources/llama/<triple>/`.
   CI's release build pins the Vulkan SDK version in `release.yml`.

2. **Take it from the latest release**
   ([Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases)):
   install or unpack it, then copy the engine and its libraries to the places
   above, the engine renamed with your target triple
   (`rustc -vV | grep host`):
   - Windows: `lu-llama-server.exe` and `lu-llama-cvector-generator.exe` (the
     Neuron tweaker's tool, a second sidecar on Windows only) from the install
     folder, plus the DLLs the installer puts next to them, the files
     `tauri.windows.conf.json` bundles from `resources/llama/x86_64-pc-windows-msvc/`
     (`ggml-*.dll` and the others in that list).
   - Linux: `./Locally.Uncensored_<version>_amd64.AppImage --appimage-extract`,
     then `squashfs-root/usr/bin/lu-llama-server` and the files in
     `squashfs-root/usr/lib/Locally Uncensored/llama/`.
   - macOS: `lu-llama-server`, `lu-llama-cvector-generator` and
     `lu-llama-quantize` from `Locally Uncensored.app/Contents/MacOS/` (static
     files, no libraries).

CI creates **empty** placeholder files of these names (`ci.yml`, "Stub
llama-server sidecar"), because `cargo check`, `cargo test` and `cargo clippy`
only need the file to exist. Do not copy that step for a build you want to run:
the app builds, but the LU Engine, its embeddings server and the Neuron
tweaker cannot start. LU treats an empty or non-program file as no engine and
says so (GH #207).

#### ComfyUI CORS when you run your own instance

If you already have a ComfyUI running **outside** LU (e.g. a long-lived homelab
instance) and you point `npm run tauri:dev` at it, Vite on `:5173` won't match
ComfyUI's origin check and you'll see `403` on `/prompt` + a console warning:
`request with non matching host and origin localhost:8188 != localhost:5173`.

Start your ComfyUI with:

```bash
python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header "*"
```

LU's own auto-started ComfyUI already passes this flag — you only need it when
you're bringing your own. Thanks to a user for flagging this in Discord.

### Project Structure

```
src/
  api/          # Ollama & ComfyUI API clients
  components/   # React components (chat/, create/, models/, personas/, settings/)
  hooks/        # Custom React hooks
  stores/       # Zustand state management
  types/        # TypeScript definitions
  lib/          # Constants & utilities
```

## Tech Stack

- **React 19** + **TypeScript** — strict mode, functional components only
- **Tailwind CSS 4** — utility-first, glassmorphism UI
- **Zustand** — state management with localStorage persistence
- **Vite 8** — build tool
- **Framer Motion** — animations

## How to Contribute

### Bug Reports

Use the [Bug Report template](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=bug_report.yml). Include:

- Steps to reproduce
- Expected vs actual behavior
- Your OS, browser, GPU info
- Console errors (if any)

### Feature Requests

Use the [Feature Request template](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=feature_request.yml). Describe:

- What problem it solves
- How you'd expect it to work
- Alternatives you've considered

### Pull Requests

1. Fork the repo
2. Create a feature branch from `master`: `git checkout -b feature/your-feature`
3. Make your changes
4. Test locally with `npm run dev`
5. Run type checking: `npx tsc --noEmit`
6. Run the tests: `npm test`, and `cargo test` in `src-tauri` if you touched Rust
7. Commit with a descriptive message
8. Push and open a PR against `master`

### Tests

A change that adds or alters behaviour comes with a test that fails without it: a Vitest test next to the code (`__tests__/`) for the front end, a `#[test]` in the module for Rust, a Playwright spec in `e2e/` for a flow through the UI. A bug fix comes with a test that reproduces the bug. CI (`.github/workflows/ci.yml`) runs all of them on every pull request, together with lint, type check, Clippy, CodeQL and the dependency audit, and a pull request is merged only when they pass.

Security problems are not reported in issues or pull requests: see [SECURITY.md](SECURITY.md).

### Code Style

- **TypeScript strict mode** — no `any` types unless absolutely necessary
- **Functional components** — no class components
- **Named exports** — prefer named over default exports
- **Tailwind** — use utility classes, avoid custom CSS when possible
- **Component files** — one component per file, filename matches component name
- **Hooks** — extract logic into custom hooks in `src/hooks/`

### Commit Messages

Keep them short and descriptive:

```
Add video generation progress bar
Fix persona selection on new chat
Update Ollama API client for v0.5 compatibility
```

No need for conventional commits — just be clear about what changed.

## Areas Where Help is Needed

- **Linux/Mac testing** — setup.sh improvements, OS-specific bugs
- **Model compatibility** — testing with different Ollama models
- **ComfyUI workflows** — new image/video generation workflows
- **Accessibility** — keyboard navigation, screen reader support
- **i18n** — translations for non-English users
- **Documentation** — tutorials, guides, video walkthroughs

## Questions?

Open a thread in [Discussions](https://github.com/PurpleDoubleD/locally-uncensored/discussions) — don't use Issues for questions.

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 License.


## Where to ask

- **Discord:** https://locallyuncensored.com/discord — real-time chat with users and maintainers. Fastest path for questions, design discussions, and coordination on larger PRs.
- **GitHub Discussions:** https://github.com/PurpleDoubleD/locally-uncensored/discussions — threaded, searchable. Good for long-form questions or proposals you want archived.
- **GitHub Issues:** bug reports and well-scoped feature requests only. Anything open-ended → Discord or Discussions first.
