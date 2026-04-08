# Locally Uncensored — Developer Guide

## Project Overview
Desktop AI app (Tauri + React + TypeScript) for local LLM chat, image and video generation via ComfyUI.
- **Repo:** PurpleDoubleD/locally-uncensored (35+ stars)
- **Current version:** v2.2.3 (released 2026-04-05)
- **Active branch:** `full-comfyui-fix` — v2.3.0 ComfyUI Plug & Play feature (DO NOT PUSH until ready)

## Tech Stack
- **Frontend:** React 19, Zustand, Tailwind CSS 4, Framer Motion, Vite 8
- **Backend:** Tauri 2 (Rust), tokio, reqwest
- **Testing:** Vitest 4, pattern `src/**/__tests__/**/*.test.ts`, node environment
- **Build:** `npm run dev` (frontend), `npm run tauri:dev` (full app)

## Key Architecture
```
src/api/comfyui.ts          — Model classification, ComfyUI API, workflow builders, uploadImage()
src/api/dynamic-workflow.ts — Strategy detection + dynamic workflow building (14 strategies)
src/api/comfyui-nodes.ts    — Node discovery + categorization from ComfyUI /object_info
src/api/discover.ts         — Model bundles (14 video, 6 image), CUSTOM_NODE_REGISTRY, downloads
src/api/preflight.ts        — Pre-generation validation (VAE/CLIP/node checks)
src/api/backend.ts          — Tauri IPC abstraction (backendCall, localFetch, comfyuiUrl)
src/api/workflows.ts        — Workflow validation, format conversion, parameter injection
src/stores/downloadStore.ts — Unified download tracking (Zustand) for ComfyUI model downloads
src-tauri/src/commands/      — Rust commands: install, process, download, proxy, etc.
```

## Current Work: v2.3.0 (branch: full-comfyui-fix)

### What's DONE (601 tests passing):
1. **7 new ModelTypes:** mochi, cosmos, cogvideo, svd, framepack, pyramidflow, allegro
2. **7 new WorkflowStrategies** with complete node chains for each model
3. **14 video bundles + 6 image bundles** in discover.ts with HuggingFace URLs
4. **CUSTOM_NODE_REGISTRY** — 5 custom node repos (AnimateDiff, CogVideoX, FramePack, PyramidFlow, Allegro)
5. **install_custom_node** Rust command — git clone + pip install into ComfyUI/custom_nodes/
6. **Onboarding 'comfyui' step** — auto-detect, one-click install, re-scan button, manual path input
7. **Onboarding polish** — window drag region + controls, accent dots (Agent Tutorial style), step indicator dots, tool calling badges, hardware-aware model filtering (VRAM), uncensored/mainstream tabs
8. **Settings ComfyUI section** — status indicator (Running/Stopped/Not Installed), start/stop/restart, install button
9. **Preflight** — all 15 ModelTypes handled (needsUnet check covers all new types)
10. **I2V Image Upload UI** — drag & drop in CreateView for SVD/FramePack, uploadImage() to ComfyUI, filename passed to workflow builders
11. **Unified downloadStore** — Zustand store replaces component-local polling, tracks all ComfyUI downloads globally
12. **DownloadBadge unified** — shows text + image + video downloads, grouped by bundle name with sub-file progress
13. **VRAM tier filter tabs** — All / Lightweight / Mid-Range / High-End for video bundles
14. **installBundleComplete()** — one-click: custom nodes + all model files + ComfyUI restart
15. **isInstalled fix** — exact name match (was: base-name comparison, caused Gemma 4 variant bug)
16. **Default view = chat homepage** (Startseite with LU logo), not Model Manager
17. **6 uncensored video bundles** (Wan 2.1 x2, HunyuanVideo, CogVideoX x2, FramePack)
18. **LTX bug fixed** — workflow was 'wan' instead of 'ltx'
19. **Text model download UX complete** — Ollama pull with streaming progress, HF GGUF with auto-fallback path, both tracked in unified DownloadBadge
20. **isInstalled prefix-match** — Ollama models without tag (hermes3) match installed variants (hermes3:8b)
21. **All 3 download flows Tauri-verified** — Ollama pull (events), HF GGUF (invoke), ComfyUI bundles (invoke) — all arg mappings, command registrations, progress polling confirmed

22. **Tauri .exe download fix (camelCase)** — Rust commands used snake_case params but JS sent camelCase. Downloads silently failed in .exe, worked in dev. Fixed: download_model, download_model_to_path, install_custom_node all use camelCase params now.
23. **Retry button for failed downloads** — per-file retry in DownloadBadge + bundle-level retry in DiscoverModels. Only retries failed files, not completed ones.
24. **Download speed display** — MB/s shown per file and per bundle in DownloadBadge
25. **External links open system browser** — all `target="_blank"` links replaced with `openExternal()` via Tauri shell plugin. Added `shell:allow-open` capability.
26. **Bundle installed detection fixed** — error files no longer count as "complete", bundleStatuses refresh after download, 50% threshold for check_model_sizes (sizeGB values are estimates)
27. **LM Studio not auto-started** — openai provider default changed to `enabled: false`, only activated if detectLocalBackends finds it
28. **Download polling race fix** — first download after app restart now shows immediately (min 5 poll cycles before auto-stop)
29. **All 20 bundle file sizes verified** — 13 files had wrong sizeGB values (up to 95% off), all corrected against real Content-Length
30. **Mochi missing T5-XXL** — text encoder was completely missing from bundle, model would fail at CLIPLoader. Added as 3rd file.
31. **AnimateDiff v3 wrong file** — was downloading adapter (97 MB) instead of motion model (1.6 GB). Fixed URL to v3_sd15_mm.ckpt
32. **Onboarding typo** — `qwen2.5-abliterated` doesn't exist on Ollama, fixed to `qwen2.5-abliterate`
33. **All 30 Ollama models verified**, all 24 HF GGUF URLs verified, all 20 ComfyUI bundle URLs verified

### What's LEFT to finish v2.3.0:
1. **Tauri .exe E2E** — run the built .exe (not dev server), test all 3 download flows end-to-end in production mode
2. **HuggingFace as primary download source** — replace Ollama-only text downloads with HF GGUF for all providers (LM Studio compatibility). Auto-detect provider model directory.

### What was FIXED (download overhaul):
1. **install_custom_node camelCase bug** — Tauri 2 expects camelCase args (repoUrl/nodeName), was sending snake_case. Fixed in discover.ts + vite.config.ts
2. **installBundleComplete per-file error handling** — single file failure no longer stops all downloads. Each file has independent try/catch
3. **"exists" status tracking** — files already on disk now properly marked as complete in downloadStore via comfyui-download-exists event
4. **Download UI consolidated** — removed duplicate progress display from DiscoverModels, all downloads exclusively shown in DownloadBadge (header)
5. **AnimateDiff subfolder bug** — models_dir() now routes custom_nodes/ paths to ComfyUI root instead of models/
6. **Broken URLs fixed** — Pony Diffusion (401) replaced with DreamShaper XL Turbo, SigCLIP (404) fixed filename
7. **Image bundle workflow types** — all were 'wan', now correctly sdxl/flux/flux2
8. **Dev-mode endpoints added** — detect_model_path + download_model_to_path for HF GGUF downloads
9. **All 38 ComfyUI URLs verified HTTP 200, all 24 HF GGUF URLs verified, all 29 Ollama models exist**
10. **All 19 bundles tested in live app — 0 errors, all files confirmed on disk**
11. **setHfModels runtime error** — handleRefresh() called undefined setHfModels(). Fixed: HF refresh now clears search + re-detects model path
12. **Dev-mode detect-model-path fallback** — returned null without LM Studio. Now falls back to ~/locally-uncensored/models/ (parity with Rust)
13. **isInstalled prefix-match for Ollama** — `hermes3` now matches installed `hermes3:8b`. Was: exact match only, never showed INSTALLED badge
14. **pullModel fetchModels error isolation** — fetchModels() error after completePull() no longer swallows the entire success path
15. **Partial download "exists" bug** — files only partially downloaded (e.g. 36 MB of 10 GB) were falsely reported as complete. Added expectedBytes size validation (>= 90% threshold) to download_model, download_model_to_path (Rust) and dev-server. Incomplete files now get re-downloaded with resume.
16. **Double-click guard on bundle install** — clicking Install twice no longer starts duplicate downloads
17. **handleRefresh race condition** — loading flag was cleared before async detectProviderModelPath resolved
18. **Dev-mode fetchModels try-catch** — pullModel completion in dev mode could crash if Ollama stopped during fetchModels

### Files modified in this branch (30+ files):
- `src/api/comfyui.ts` — 7 new ModelTypes, COMPONENT_REGISTRY, uploadImage(), inputImage in VideoParams
- `src/api/dynamic-workflow.ts` — 7 new strategies, 5 wrapper builders, inputImage support in SVD/FramePack
- `src/api/comfyui-nodes.ts` — 30+ new nodes in categorization mapping
- `src/api/discover.ts` — 14 video + 6 image bundles, CUSTOM_NODE_REGISTRY, installBundleComplete(), uncensored flags, ALL sizeGB verified
- `src/api/backend.ts` — install_custom_node endpoint mapping, openExternal() for system browser
- `src/api/preflight.ts` — extended needsUnet check for all new model types
- `src-tauri/src/commands/install.rs` — install_custom_node command (camelCase params)
- `src-tauri/src/commands/download.rs` — download_model with resume, progress, speed tracking (camelCase params), 50% threshold for check_model_sizes
- `src-tauri/src/main.rs` — registered install_custom_node
- `src-tauri/capabilities/default.json` — added shell:allow-open for external links
- `src/components/create/CreateView.tsx` — I2V upload UI (drag & drop, preview, replace/remove)
- `src/components/create/WorkflowSearchModal.tsx` — openExternal for CivitAI link
- `src/components/create/WorkflowCard.tsx` — openExternal for source links
- `src/components/chat/MarkdownRenderer.tsx` — openExternal for all chat links
- `src/components/layout/DownloadBadge.tsx` — unified: text + ComfyUI downloads, bundle grouping, retry buttons, speed display
- `src/components/models/DiscoverModels.tsx` — VRAM tier tabs, downloadStore integration, retry for failed bundles, openExternal, no double "Installed"
- `src/components/onboarding/Onboarding.tsx` — comfyui step, drag region, accent dots, VRAM filtering, tool calling badges, re-scan, openExternal
- `src/components/settings/SettingsPage.tsx` — ComfyUISettings component
- `src/stores/providerStore.ts` — LM Studio default disabled (auto-detect only)
- `src/stores/updateStore.ts` — openExternal for release page
- `src/lib/constants.ts` — OnboardingModel: vramGB, uncensored, agent fields, qwen2.5-abliterate typo fix
- `src/hooks/useCreate.ts` — i2vImage pass-through to workflow builder
- `src/lib/constants.ts` — OnboardingModel: vramGB, uncensored, agent fields + mainstream models
- `src/stores/createStore.ts` — i2vImage state
- `src/stores/downloadStore.ts` — NEW: unified ComfyUI download tracking (polling, bundle grouping)
- `src/stores/uiStore.ts` — default view changed to 'chat'

### Test files (4 new):
- `src/api/__tests__/comfyui-models.test.ts` — classifyModel, MODEL_TYPE_DEFAULTS, COMPONENT_REGISTRY, determineStrategy (79 tests)
- `src/api/__tests__/comfyui-bundles.test.ts` — bundle validation, custom node registry, shared files (15 tests)
- `src/api/__tests__/comfyui-workflows.test.ts` — strategy mapping, unavailability, workflow coverage (30 tests)
- `src/api/__tests__/comfyui-integration.test.ts` — full pipeline Bundle→Strategy verification (36 tests)

## Conventions
- Language: German comments welcome, code in English
- Commits: descriptive, semantic (`feat:`, `fix:`, `docs:`)
- No emojis in code or UI
- Run `npx vitest run` before committing
- Run `cargo check --manifest-path src-tauri/Cargo.toml` for Rust changes
- UI: Tailwind utility classes, dark mode first, lucide-react icons
- State: Zustand stores in `src/stores/`
- Tauri IPC: `backendCall()` from `src/api/backend.ts`
- Downloads: Use `downloadStore` for all ComfyUI downloads (not component-local state)

## Reference Docs (on Desktop)
- `C:\Users\ddrob\Desktop\LU_UPDATE_PLAN.md` — Full v2.3.0 plan
- `C:\Users\ddrob\Desktop\LU_VIDEO_MODELS_WORKFLOW_RESEARCH.md` — Detailed node chains for all 16 models

## Pre-existing test failures (NOT caused by our changes):
- `tool-registry.test.ts` — counts are outdated (13 tools vs expected 7)
- `provider-ollama.test.ts` — options key always present now (num_gpu: 99)
- `model-compatibility.test.ts` — provider set changed
