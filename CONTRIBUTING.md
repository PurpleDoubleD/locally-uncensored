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
npm run dev
```

The app runs at `http://localhost:5173` with hot reload.

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
6. Commit with a descriptive message
7. Push and open a PR against `master`

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
