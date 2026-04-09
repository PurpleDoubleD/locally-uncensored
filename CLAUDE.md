# Locally Uncensored — Developer Guide

## Project Overview
Plug and Play for the Mass Desktop AI app (Tauri + React + TypeScript) for local LLM chat, image and video generation via ComfyUI.
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
34. **HuggingFace GGUF as single download source** — replaced Ollama pull with HF GGUF for ALL text model downloads. Works with all 23 provider presets. Removed Ollama/HF tab switcher, VariantPullButton, Ollama search. Unified getUncensoredTextModels (34 GGUFs) + getMainstreamTextModels (30 GGUFs). Onboarding uses startModelDownloadToPath instead of pullModel. All 64 URLs verified HTTP 200. Net -238 lines. pullModel() preserved for chat page Ollama pulls.

35. **E2E Image+Video Gen fixes (6 bugs)** — Error handling shows real ComfyUI errors (not generic HTTP 500). Direct fetch fallback when Tauri proxy fails. Legacy builder uses correct FLUX 2 nodes (EmptyFlux2LatentImage + separate negative prompt). Stale localStorage model names auto-reset against current ComfyUI list. Polling heartbeat catches missed WebSocket completion events. ComfyUI critical functions (submit/history/cancel/free) use direct fetch bypassing broken Tauri proxy.
36. **tqdm crash fix confirmed** — TQDM_DISABLE=1 env var in start_comfyui/auto_start_comfyui prevents KSampler [Errno 22] crash. Both image and video KSampler confirmed working in .exe.

37. **Think-Mode guard for non-thinking models** — isThinkingCompatible() in model-compatibility.ts checks if model supports Ollama's `think` parameter. ChatView shows amber hint toast instead of crashing with HTTP 400. useChat.ts double-guards by not sending `think=true` to incompatible models. Supports: QwQ, DeepSeek-R1, Qwen3/3.5, Qwen3-Coder, Gemma3/4. Cloud providers always pass through.

38. **Chat homepage null crash fix** — getProviderIdFromModel(), isThinkingCompatible(), isAgentCompatible() all crashed with "Cannot read properties of null (reading 'split')" when activeModel was null after fresh install. Added null guards to all three functions.
39. **Light Theme contrast fix** — ModelCard model names were invisible in light mode (text-gray-200 on white). Fixed: dark:text-gray-200 text-gray-800. Also fixed ModelManager buttons and ModelCard hover/active states for light theme.
40. **Gemma 4 31B Heretic download URL fix** — llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF repo was deleted (404). Replaced with Stabhappy/gemma-4-31B-it-heretic-Gguf. All 105 download URLs verified HTTP 200/302.
41. **I2V image upload fix** — uploadImage() used localFetch() which only accepts string body, not FormData. FormData was silently corrupted (sent as "[object FormData]") and Content-Type was forced to application/json instead of multipart/form-data. Fixed: use direct fetch() which handles FormData natively.
42. **FramePack workflow node names fix** — Kijai wrapper updated node names: FramePackModelLoader→LoadFramePackModel, removed FramePackEncode (image goes directly to FramePackSampler as start_latent). Updated dynamic-workflow.ts builder, comfyui-nodes.ts categorization, discover.ts CUSTOM_NODE_REGISTRY, and test fixtures.
43. **FramePack workflow validation fix** — base_precision fp8→bf16, sampler unipc→unipc_bh2, added VAEEncode between LoadImage and FramePackSampler (LATENT type required, not IMAGE).
44. **FramePack preflight custom node check** — Added framepack to customNodeModels in preflight.ts. Now checks for LoadFramePackModel + FramePackSampler before generation.

### What's LEFT to finish v2.3.0:
1. **Tauri proxy_localhost investigation** — reqwest in Tauri subprocess can't reach localhost. Direct fetch workaround in place but root cause unknown. Low priority since workaround works. Deferred to next release.
2. **LTX VAEDecode reference** — dynamic-workflow.ts line 263: vaeSourceId incorrectly points to UNETLoader output for LTX strategy. Fix when LTX model is installed for testing.

### Files modified in this branch (30+ files):
- `src/api/comfyui.ts` — 7 new ModelTypes, COMPONENT_REGISTRY, uploadImage(), inputImage in VideoParams
- `src/api/dynamic-workflow.ts` — 7 new strategies, 5 wrapper builders, inputImage support in SVD/FramePack
- `src/api/comfyui-nodes.ts` — 30+ new nodes in categorization mapping
- `src/api/discover.ts` — 14 video + 6 image bundles, CUSTOM_NODE_REGISTRY, installBundleComplete(), uncensored flags, ALL sizeGB verified, HF GGUF unified text model lists (34 uncensored + 30 mainstream), removed Ollama search/fetch functions
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
- `src/components/models/DiscoverModels.tsx` — VRAM tier tabs, downloadStore integration, retry for failed bundles, openExternal, no double "Installed", removed Ollama/HF tab switcher + VariantPullButton + useModels dependency
- `src/components/onboarding/Onboarding.tsx` — comfyui step, drag region, accent dots, VRAM filtering, tool calling badges, re-scan, openExternal, GGUF downloads via startModelDownloadToPath instead of pullModel
- `src/components/settings/SettingsPage.tsx` — ComfyUISettings component
- `src/stores/providerStore.ts` — LM Studio default disabled (auto-detect only)
- `src/stores/updateStore.ts` — openExternal for release page
- `src/lib/constants.ts` — OnboardingModel: vramGB, uncensored, agent fields, qwen2.5-abliterate typo fix, HF GGUF downloadUrl/filename/sizeGB for all 17 onboarding models
- `src/hooks/useCreate.ts` — i2vImage pass-through to workflow builder
- `src/lib/constants.ts` — OnboardingModel: vramGB, uncensored, agent fields + mainstream models
- `src/stores/createStore.ts` — i2vImage state
- `src/stores/downloadStore.ts` — NEW: unified ComfyUI download tracking (polling, bundle grouping)
- `src/stores/uiStore.ts` — default view changed to 'chat'
- `src/lib/model-compatibility.ts` — added isThinkingCompatible() + THINKING_COMPATIBLE list
- `src/components/chat/ChatView.tsx` — Think button: amber hint for non-thinking models, opacity dim
- `src/hooks/useChat.ts` — double-guard: don't send think=true to incompatible models

### Test files (4 new):
- `src/api/__tests__/comfyui-models.test.ts` — classifyModel, MODEL_TYPE_DEFAULTS, COMPONENT_REGISTRY, determineStrategy (79 tests)
- `src/api/__tests__/comfyui-bundles.test.ts` — bundle validation, custom node registry, shared files (15 tests)
- `src/api/__tests__/comfyui-workflows.test.ts` — strategy mapping, unavailability, workflow coverage (30 tests)
- `src/api/__tests__/comfyui-integration.test.ts` — full pipeline Bundle→Strategy verification (36 tests)

## Conventions
- Language: Englisch only
- Commits: descriptive, semantic (`feat:`, `fix:`, `docs:`)
- No emojis in code or UI
- Run `npx vitest run` before committing
- Run `cargo check --manifest-path src-tauri/Cargo.toml` for Rust changes
- UI: Tailwind utility classes, dark mode first, lucide-react icons
- State: Zustand stores in `src/stores/`
- Tauri IPC: `backendCall()` from `src/api/backend.ts`
- Downloads: Use `downloadStore` for all ComfyUI downloads (not component-local state)


## Pre-existing test failures (NOT caused by our changes):
- `tool-registry.test.ts` — counts are outdated (13 tools vs expected 7)
- `provider-ollama.test.ts` — options key always present now (num_gpu: 99)
- `model-compatibility.test.ts` — provider set changed
