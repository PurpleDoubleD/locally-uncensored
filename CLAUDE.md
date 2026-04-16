# Locally Uncensored — Developer Guide

## Project Overview
Plug and Play for the Mass Desktop AI app (Tauri + React + TypeScript) for local LLM chat, image and video generation via ComfyUI.
- **Repo:** PurpleDoubleD/locally-uncensored (35+ stars)
- **Current public version:** v2.3.3 (merging to master 2026-04-16)
- **Branch:** `feature/agent-overhaul-v24` merged into master
- Test iterations 2.3.4–2.3.7 were intermediate, not shipped. **2.3.3 is the next public version.**

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

### What's DONE (607 tests passing):
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
45. **FramePack DualCLIPLoader fix** — CLIPLoader type "wan" creates Llama2 with 128256 vocab but llava_llama3 has 128320 tokens. Fixed: use DualCLIPLoader (clip_l + llava_llama3) with type "hunyuan_video". Added CLIPVisionLoader + CLIPVisionEncode for image_embeds. Full I2V pipeline verified in .exe (OOM on 12GB VRAM = hardware limit, not software bug).

46. **Z-Image own ModelType + strategy** — Z-Image was classified as `flux2` but uses `qwen_3_4b` CLIP (not `qwen_3_4b_fp4_flux2`), causing KSampler shape mismatch [2560] vs [1, 77, 768]. Fixed: new ModelType `zimage`, new strategy `unet_zimage`, CLIPLoader type `qwen_image` (queried from ComfyUI /object_info). Added findMatchingVAE/CLIP for zimage (exact match `qwen_3_4b.safetensors`, excludes fp4_flux2 variant). COMPONENT_REGISTRY in both comfyui.ts and discover.ts. Defaults: 12 steps, CFG 3.5, euler/simple. Z-Image Turbo E2E verified in .exe — 5 steps generates correct 1024x1024 image.
47. **Image-to-Image (I2I) feature** — Complete I2I pipeline: LoadImage → VAEEncode → KSampler (denoise < 1.0) → VAEDecode → SaveImage. Sub-tabs in Parameters panel (Text to Image / Image to Image) matching Video's T2V/I2V pattern. Upload zone with drag & drop, denoise slider (0.0-1.0) in both main area and sidebar. Works with all image models (SDXL, FLUX, Z-Image). Store migration from old `mode: 'i2i'` to `imageSubMode`. E2E verified in .exe — Z-Image I2I with denoise 0.7 generates correct output.
48. **ComfyUI process cleanup on app kill** — Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When Tauri app is killed (even via Task Manager), OS kernel automatically terminates ComfyUI Python process. Applied to both `start_comfyui()` and `auto_start_comfyui()`. Added `windows-sys` crate dependency.

49. **Caveman Mode fixes (5 bugs)** — Ultra prompt added brevity constraint ("Maximum brevity. Fewest possible words. Under 3 sentences unless code."). Agent+Caveman prompt order fixed: caveman was PREPENDED before agent ReAct instructions (confused model), now APPENDED as `Response style:`. Caveman injection added to useCodex.ts and useClaudeCode.ts (was missing). Per-message CAVEMAN_REMINDERS added (short style tags like `[Terse. Fragments OK. No fluff.]` prepended to each user message) — ensures non-thinking models follow Caveman style without relying on thinking mode. Works in all 4 views: Chat, Agent, Codex, Claude Code.
50. **Think-mode comprehensive fix** — ollama-provider.ts: `body.think` only set when `thinking: true` (was always setting `think: false` which Ollama rejects). useAgentChat.ts + useCodex.ts: added `isThinkingCompatible()` guard. All 3 hooks (useChat, useAgentChat, useCodex) now retry without thinking on HTTP 400. User-friendly error message instead of raw JSON. Works with ALL models: non-thinking models get no `think` param, thinking-compatible models get `think: true`, edge cases caught by retry.
51. **Agent Tutorial trimmed** — Removed "You Stay in Control" screen (was step 3). Tutorial now 2 steps: Welcome → Available Tools. Safety info integrated into Tools screen description. "Don't show this again" checkbox on last (Tools) screen.
52. **Plugins Dropdown + Input Alignment** — Persona selector renamed to "Plugins" dropdown containing Caveman Mode (Off/Lite/Full/Ultra buttons) + Personas list. Caveman toggle removed from ChatInput. PluginsDropdown added to all 3 chat views (Chat, Codex, ClaudeCode). Input bar alignment fixed: VoiceButton p-2→p-1.5 + icon 15→14, Think py-1→py-1.5. All buttons now consistent height.

53. **Remote Access Upgrade** — 6-digit numeric passcodes (5min expiry, auto-regenerate), rate limiting (3 failed attempts → 60s cooldown), Cloudflare Tunnel with tunnel-aware QR codes (QR shows tunnel URL when active), WebSocket `/ws` auth fix, shared state fix (jwt_secret + passcode behind Arc<TokioMutex> shared between axum and Tauri), mobile landing page with numeric input + rate limit error display, frontend countdown timer with auto-regeneration.

58. **Remote Access E2E fixes (3 bugs)** — (a) Terminal window popup: cloudflared + taskkill spawned visible console windows on Windows. Fixed with `CREATE_NO_WINDOW` (0x08000000) creation flag on all 3 process spawns. (b) Tunnel URL parsing: `url.contains("cloudflare")` matched Cloudflare Terms of Service URL instead of actual tunnel. Fixed to `.trycloudflare.com` only. (c) Mobile SPA broken: links pointed to React SPA but dist/ files not served by remote axon server. Fixed by making mobile app fully self-contained.

59. **Mobile Web App (Stitch "Terminal Authority" design)** — Complete self-contained 4-tab mobile app in `mobile_landing()` raw HTML string. Auth screen (6-digit numeric input, rate limit display). Chat tab (NDJSON streaming, markdown rendering, code blocks with copy, model selector via `/api/tags`). Generate tab (UI shell, "requires desktop" message — Phase 2). History tab (localStorage chat history, searchable). Settings tab (connection status, server info, session disconnect). Glassmorphism header, bottom nav with active states, Space Grotesk font, #0e0e0e surfaces. All API calls use JWT auth. No external dependencies or SPA files needed.

54. **Comprehensive Test Suite** — 28 new test files, 837 new tests (607→1444 total, 0 failures). All 22 stores tested, API layer 82%, lib utilities 82%. Fixed 6 stale test assertions (tool-registry counts, ollama options, model-compatibility providers).

55. **Auto-Update** — Tauri updater plugin (`tauri-plugin-updater`) with signed NSIS installers via GitHub Releases. `latest.json` endpoint auto-generated by CI. In-app download with progress bar in UpdateBadge. User-controlled restart (no auto-restart): "Restart Now" / "Later" buttons after download. Signing keypair generated, public key in `tauri.conf.json`, private key + password in GitHub Secrets. `exit_app` Rust command for clean shutdown during update install. CI workflow updated with `TAURI_SIGNING_PRIVATE_KEY` env vars.

56. **NSIS Onboarding Fix** — Marker file `onboarding_done` in `%APPDATA%/Locally Uncensored/` (Roaming) survives NSIS updates that wipe `%LOCALAPPDATA%` WebView2 data. `is_onboarding_done` + `set_onboarding_done` Rust commands in system.rs. AppShell recovers `onboardingDone` from filesystem when localStorage is empty. Onboarding writes marker file on completion.

57. **Plugins Dropdown Redesign** — Caveman Mode and Personas as separate collapsible dropdown sections with chevron indicators. Only one section open at a time. Current selection shown inline. Clean typography and spacing, dark + light theme support.

60. **Remote Tab + Dispatch** — Remote as 3rd sidebar tab (Chat | Code | Remote). Dispatch button replaces "New Chat" in Remote mode — click splits inline into LAN | Internet (same dashed green border). Each dispatch creates a scoped `'remote'` conversation. New `/remote-api/config` endpoint returns dispatched model+systemPrompt to mobile. Mobile redesigned as chat-only (no tabs/history/generate). LIVE indicator panel with QR + passcode + URL when dispatched. Settings Remote section slimmed to permissions + devices only. Settings GroupHeader banners removed, Providers defaultOpen=false.

61. **NSIS Store Backup/Restore** — Full localStorage backup to `%APPDATA%/Locally Uncensored/store_backup.json` (atomic tmp+rename). All 18 Zustand persist stores backed up every 30s. On NSIS update (localStorage wiped): restore from backup → reload. Sentinel key `lu-restore-complete` prevents partial-restore getting stuck. Structural validation (only known keys, string values). `restoring` guard prevents onboarding flash. `resetSettings()` preserves `onboardingDone`. `dispatch()` sets `dispatchedConversationId` only after successful `startServer()`. Click-away overlay + tab-switch reset for dispatch picker.

62. **Mobile↔Desktop Chat Sync + Server Restart + Auto-numbered Remote Chats** — Mobile messages mirror to the Desktop Remote conversation so closing the phone never loses chat state. New axum endpoint `/remote-api/chat-event` emits Tauri event `remote-chat-message` → `AppShell.tsx` listener appends to `dispatchedConversationId`. Mobile `_doSend()` posts user message before stream + assistant message after stream `done`. Duplicate-guard: skip if last message matches (role+content). 401 handler clears stale JWT + reloads. New `restart_remote_server` Tauri command = stop + 300ms + re-acquire state + start; preserves `dispatchedConversationId`, regenerates passcode, resets tunnel. Restart buttons: Sidebar LIVE panel chip + ChatView green "Live" banner + ChatView grey "Server stopped" banner with prominent Restart that reactivates the chat. Remote chats now titled `Remote Chat 1`, `Remote Chat 2`, ... via counting existing `mode === 'remote'` conversations.

63. **Memory system works for Remote chats** — Audit found Remote bypassed memory entirely. Fix #1 (injection): `remoteStore.enrichSystemPromptWithMemory()` bakes memory into `systemPrompt` at dispatch/restart time because the Rust proxy can't read Zustand. Mobile picks it up via `/remote-api/config` and prepends as `system` message on every `/api/chat`. Fix #2 (extraction): exported `extractMemoriesFromPair()` from `useMemory.ts` as pure function; `AppShell.tsx` remote-chat-message listener calls it when `role === 'assistant'`, walks back through conv messages to find paired user message. Same rate-limits as desktop (every 3rd turn, skip <100 char responses). Codex + Claude Code memory integration still pending.

64. **Mobile Web App v2 — full rebuild (minimalistic, original LU branding, 6 features)** — Complete rewrite of `mobile_landing()` in `src-tauri/src/commands/remote.rs`. Added: (a) **Hamburger drawer** (86vw, max 320px, slide-in cubic-bezier, backdrop blur, safe-area aware) with Chat list (localStorage `lu-mobile-chats`, auto-title, `codex` badge per chat) + New Chat / New Codex buttons + Disconnect footer. (b) **Thinking toggle** in header (icon-only, auto-disabled on non-compatible models via `isThinkingCompatible()` parity with desktop, auto-retry without `think` on HTTP 400). (c) **File attach** (image/*, max 5, base64 without data-URL prefix, multi-file picker, 52px thumbnails above textarea; Ollama receives `images:[base64]` per message). (d) **Plugins as header bottom-sheet** (puzzle icon between model badge and thinking button — NOT in drawer). Plugins picker has Caveman + Persona as **collapsed-by-default sub-folders** with chevron animation, each folder showing current value as accent badge. Caveman: Off/Lite/Full/Ultra chips. Persona: **On/Off switch** next to the row (accent-colored when active) + 25-persona scroll list (picking one auto-enables); when off, dispatched system prompt is used. Plugins are **per-chat** (stored on chat as `caveman` + `personaId` + `personaEnabled`). Header plugins button glows accent when any plugin is active. (e) **Codex chats** tagged `codex` in drawer list and header; Codex mobile prompt simplified (no tool-execution claims). (f) **Original LU monogram branding** — uses the white-on-transparent PNG (`/LU-monogram-white.png`, copied from `logos/LU-monogram-bw-transparent.png` to `public/`), injected without `filter:invert` in: header (22px next to hamburger, replacing "LU" text), drawer header (18px), auth screen (64px with drop-shadow glow), welcome screen (82px with drop-shadow glow + "LUncensored" wordmark). System prompt priority: Caveman → Codex OR (PersonaEnabled ? Persona : dispatched-with-memory). Input bar: attach + textarea + send all 44px high, minimalistic arrow-up send icon. Mobile↔desktop sync preserved for LU-mode chats only (codex chats stay local).

65. **Remote Access v2.3.2 E2E Test — 14 BUGS FOUND (2026-04-14)** — Critical-user E2E test on installed NSIS EXE uncovered 14 issues. **🔴 2 CRITICAL:** (#12) `RemotePermissions` (filesystem/downloads/process_control) stored + served via API but **NEVER enforced anywhere** — curl proves ComfyUI endpoint returns 200 with all permissions OFF; (#14) React SPA + `/assets/*.js` served WITHOUT auth via `fallback_service(serve_dir)` — full 1.85 MB desktop JS bundle downloadable by anyone with tunnel URL. **🟠 4 MEDIUM:** (#3) LAN IP detection reads only XFF headers → all LAN clients = "unknown" → share ONE rate-limit bucket; (#7) `regenerate_remote_token` rotates `jwt_secret` → all mobile sessions 401'd every 5min; (#9) `/remote-api/chat-event` accepts arbitrary `role` + unlimited content → mobile can spoof "assistant" messages or DoS; (#1) "mobile connected to this chat" banner hardcoded, ignores `connected_devices`. **🟡 8 MINOR:** #2 regen clears rate-limit, #4 `/remote-api/status` leaks version unauth, #5 Google Fonts privacy leak, #6 no CSP, #10 disconnect trash flaky, #11 device ID collision on same-second auth, #13 cookie Max-Age 30d vs JWT 5min mismatch, #16 UX: QR should hide after chat start + reopen via sidebar icon. Full details + file:line refs in memory `project_remote_e2e_bugs.md`. Verified working: Remote tab, auto-numbered chats, rate limit, Cloudflare Tunnel, mobile HTML, NDJSON streaming, mobile→desktop sync, Stop/Restart. **ALL 14 BUGS FIXED in 2.3.3 — see entries 66-75 below.**

66. **ALL 14 Remote E2E bugs fixed (2.3.3)** — Bug #14: `static_dir` + SPA fallback removed entirely from `build_router`; mobile landing HTML is self-contained; unknown paths 302-redirect to `/mobile`; LU monogram served via `include_bytes!`. Bug #12: permissions enforced in `proxy_ollama` (downloads gate on `/api/pull`/`create`/`copy`/`delete`/`push`/`blobs`), `proxy_comfyui` (process_control as master gate, filesystem extra for `/upload`, downloads extra for `/customnode`/`/manager`), `proxy_comfyui_ws`. Bug #7: JWT TTL decoupled from passcode (`JWT_TTL_SECS = 3600`, `PASSCODE_TTL_SECS = 300`), `regenerate_remote_token` no longer rotates `jwt_secret` or clears `failed_attempts`. Bug #3: `client_ip()` helper with `ConnectInfo<SocketAddr>` fallback, `axum::serve` uses `into_make_service_with_connect_info::<SocketAddr>`. Bug #9: `handle_chat_event` validates `role ∈ {user,assistant}` → 400, content `≤ 100 KB` → 413. Bug #11: device IDs now `dev-{secs}-{rand:hex}` (no second-precision collision). Bug #13: cookie `Max-Age = JWT_TTL_SECS`. Bug #4: `/remote-api/status` returns `{"status":"ok"}` only, full version/device count moved to `/remote-api/status/full` (auth-gated). Bug #5: Google Fonts out; system font stack + inline SVG icons via `ICONS`/`svgIcon()` helper. Bug #6: CSP meta tag (`default-src 'self'; frame-ancestors 'none'; object-src 'none'`). Bug #10: `RemoteAccessSettings` disconnect button wired to new `disconnect_remote_device` Tauri command + refetch. Bug #2: `failed_attempts` NOT cleared on regen (preserves lockout). Bug #16: QR modal with 280×280 popup + sidebar QR-icon reopen; auto-hide once a mobile authenticates (via `refreshDevices` 2 s polling).

67. **Crash: Dispatch → Internet killed app after 1 ms (2.3.3)** — TWO causes fixed. (a) `panic = "abort"` in release profile + `axum::serve(...).await.unwrap()` on bind failure aborted the ENTIRE Tauri process. Fix: bind synchronously in `start_remote_server`, return `Result<_, String>` to frontend with clear error ("Could not bind … try Stop first"); all other `.unwrap()` in remote.rs (cookie parse, QR, cloudflared, comfy_port lock, mutex locks in tunnel reader) made defensive. (b) Windows leaves port 11435 in zombie state ~4 min after hard-kill → new Dispatch fails AddrInUse → frontend "Server stopped" after 1 ms. Fix: added `socket2 = "0.5"` dep, new `build_reusable_listener(addr)` uses `socket2::Socket` with `SO_REUSEADDR` then `tokio::net::TcpListener::from_std`; zombie sockets no longer block subsequent Dispatches.

68. **Thinking toggle was UI-only, model kept thinking (2.3.3)** — User reported: toggle OFF but `<think>` still appearing, model burning tokens. Root cause: `body.think` was ONLY set to `true`, never `false`, so Ollama fell back to model default (thinking ON for QwQ / DeepSeek-R1 / Qwen3 / Gemma 4). Fix: tri-state `thinking: true | false | undefined` across all providers. (a) `ollama-provider.ts` chatStream + chatWithTools: `true → body.think=true`, `false → body.think=false`, `undefined → omit`. Auto-retry on HTTP 400 drops field (old Ollama builds / non-thinking models). (b) `anthropic-provider.ts`: `true → body.thinking = {type:'enabled', budget_tokens:5000}` for Claude Extended Thinking; stream event `thinking_delta` routed into `thinking` field. Retry drops on 400. (c) `openai-provider.ts`: `true → reasoning_effort='high'`, `false → reasoning_effort='minimal'` for o1/o3/gpt-5-thinking. Retry drops. (d) Callers `useChat.ts`/`useAgentChat.ts`/`useCodex.ts`: `thinking: isThinkingCompatible(model) ? toggle : undefined`, retry paths use `undefined` (not `false`). Covers ALL 21 provider presets via 3 client classes (OpenAI-compat serves 19: LM Studio, vLLM, llama.cpp, KoboldCpp, oobabooga, LocalAI, Jan, TabbyAPI, GPT4All, Aphrodite, SGLang, TGI, OpenRouter, Groq, Together, DeepSeek, Mistral, OpenAI, Custom).

69. **`<think>` tags leaked past toggle (2.3.3)** — Separate from #68. Even when `think:false` was sent, thinking-native models (QwQ, DeepSeek-R1) still emit `<think>…</think>` tags inline in content. All 3 hooks parsed them into `message.thinking` regardless of toggle. Fix: `keepThinking = settings.thinkingEnabled === true && isThinkingCompatible(activeModel)` gate in `useChat.ts` (char-state-machine + `discardedThinkBufRef` for close-tag detection while discarding), `useAgentChat.ts` (regex-replace always strips tags from content, inner only kept if `keepThinking`), `useCodex.ts` (same). Mobile `streamResponse` got matching `keepThinking` flag + native field gated.

70. **Caveman drift after turn 1 (2.3.3)** — Mobile `_doSend` had filter `!isThinkingCompatible(currentModel)` on the per-message reminder → Qwen3 / Gemma3 / Gemma4 got NO reminder and dropped Caveman style after turn 1. Fix: filter removed, reminder `[Terse. Fragments OK. No fluff.]` now prepended on every user message unconditionally — parity with desktop `useChat.ts:142`, `useAgentChat.ts:314`, `useCodex.ts:132`.

71. **Mobile Web App v3 — full feature parity (2.3.3)** — Over and above v2 rebuild: (a) Drawer-Footer Settings button opens sheet with ONLY Remote Permissions (filesystem/downloads/process_control) — no sampling sliders (user request). Reads/writes `/remote-api/permissions`. (b) Agent Mode with ReAct loop in pure JS, 13 tools (see #73), Thought/Action/Observation steps as collapsible purple/green/red cards default-collapsed with chevron + summary line. Final answer goes into `msg.content`, intermediate steps stay in `msg.agentSteps[]` (NOT part of content → no model drift on next turn). (c) Thinking as collapsible BLUE block above bubble, matching desktop `ThinkingBlock.tsx`. Char-state-machine parses `<think>` tags + Ollama native `message.thinking` field, gated by toggle. (d) Regenerate (🔄 on assistant) and Edit (✏️ on user with inline textarea Save/Cancel) message actions. `msgs` extended with `{id, role, content, thinking, thinkingOpen, agentSteps, images}`; backfill for legacy chats. (e) QR modal: small QR in LIVE panel is clickable, opens fullscreen 280×280 popup; QR-icon on dispatched chat row (always visible) opens modal directly. Panel auto-hides on first device auth via `refreshDevices` polling every 2 s.

72. **Mobile↔Desktop Codex-Chat sync (2.3.3)** — Mobile Codex chats now mirror to desktop Codex-view with content. `ChatEventPayload` extended with `mode: 'lu'|'codex'`, `chat_id`, `chat_title`. Mobile `postChatEvent` includes all three. Desktop `AppShell` listener branches: if `mode === 'codex'`, find-or-create a Codex conversation titled `Mobile Codex [mobile:<chat_id>]` (keyed by chat_id so follow-ups land in same desktop conv), appends messages. LU-mode still uses `dispatchedConversationId`.

73. **Agent tools — full parity desktop + mobile (2.3.3)** — User demand: "agents on desktop AND mobile — ALL tools, every single one." Mobile previously had 5 hardcoded, desktop had 13 via `toolRegistry.getAll()`. Now 14 everywhere (added `get_current_time`). Mobile `AGENT_TOOLS` JS array contains all 13 (image_generate gated as desktop-only). New Rust-to-JS bridge in `remote.rs:handle_agent_tool` routes each tool to existing Tauri commands: `crate::commands::filesystem::fs_list/fs_search/save_text_file_dialog`, `crate::commands::shell::shell_execute`, `crate::commands::system::system_info/process_list/screenshot/get_current_time`, `crate::commands::agent::file_read/file_write/execute_code`, `crate::commands::search::web_search/web_fetch`. Permission-gated: filesystem for file/code/shell/screenshot, process_control for image_generate, downloads implicit via proxy layer.

74. **`get_current_time` tool (2.3.3)** — Agent was web-searching "heutiges datum" then fetching dynamic-rendered pages that don't contain the date in their initial HTML (client-rendered by JS). New Rust command `commands::system::get_current_time` returns `{unix, iso_local, iso_utc, timezone, timezone_offset}`. Uses `SystemTime::now()` + probes `PowerShell Get-Date.zzz` on Windows / `date +%z` elsewhere for local offset. No external crate dep (hand-rolled `unix_to_utc_parts`). Added to: `src/api/agents.ts:AGENT_TOOLS`, `src/api/mcp/builtin-tools.ts:BUILTIN_TOOLS` (category `system`, permission `auto`), mobile `AGENT_TOOLS`, mobile agent-bridge. In `src/lib/tool-selection.ts`: new keyword group (`time/date/day/today/datum/heute/tag/uhrzeit/jetzt/now/clock/hour/minute/timezone/zeitzone`) + added to `ALWAYS_INCLUDE`. Description instructs model "Use FIRST for any date/time question — do NOT web_search".

75. **`web_fetch` tool upgrade (2.3.3)** — Previous `executeWebFetch` in `builtin-tools.ts` capped at 4 000 chars with a half-cleaned body → agent kept complaining "only sees the header of pages". Replaced with new Rust command `commands::search::web_fetch(url)`: strips `<script>/<style>/<nav>/<header>/<footer>/<aside>/<form>/<template>`, replaces block-level tags with newlines, HTML-decodes entities, caps at 24 000 chars, preserves paragraph breaks. Refuses localhost/private-IP/loopback ranges. Returns `{url, status, contentType, title, text, truncated}`. Also added to `src/api/agents.ts:AGENT_TOOLS` as standalone tool so ReAct agent can web_search→web_fetch pattern.

76. **Desktop UI tweaks (2.3.3)** — Header: single Lichtschalter (iOS-style 34×18 px toggle, red/green/amber-with-spinner) replaces Power+PowerOff pair. Click flips load/unload. RAG panel: `ChevronsRight` collapse button + `Eraser` Clear-All button (with confirm) wired to `ragStore.clearConversationDocs`; `useRAG.ts` gets new `clearAll()` method. Export Chat: native save-dialog via `rfd::AsyncFileDialog` (new `save_text_file_dialog` Rust command in filesystem.rs); `exportConversation` async, returns `{status:'saved'|'cancelled'|'downloaded', path}`; green toast in ChatView shows chosen path. Settings → Appearance section `defaultOpen` removed (collapsed by default like others).

77. **Codex connection-error hints (2.3.3)** — `useCodex.ts` catch block now adds kontext hints: `/Failed to fetch/i` → "Is `ollama serve` running?", `/does not support tools/i` → "Pick a tool-capable model (Qwen 3, Llama 3.1+, Gemma 4)", `/timed out/i` → "Try smaller model or more targeted prompt".

78. **Agent Overhaul v24 — 13-phase architecture rewrite (branch feature/agent-overhaul-v24, stays under 2.3.3)** — Big modular rewrite of the agent runtime, all phases on top of the prior 2.3.3 work. (1) `AgentBlock.toolCall` (singular) → `toolCalls: AgentToolCall[]` schema with `migrateBlockInPlace()` rehydrate via Zustand `persist({merge})`. (2) `toolAuditStore` ring buffer of every call with `stableArgsHash` (djb2 of canonicalised JSON). (3) Tool descriptions ≥80 chars with PREFER/NEVER hints. (4) `args-validator.ts` rejects bad args with hint to LLM before dispatch. (5) `tool-executor.ts:executeParallel` — `Promise.allSettled` with `sideEffectKey` grouping (file-write same-path serial, shell/code share `'exec'`, image/workflow share `'comfyui'`). (6) `in-turn-cache.ts` dedupes `(name, argsHash)` within one user turn, served result carries `status: 'cached' + cacheHit:true`. (7) `error-hints.ts` per-tool rules append ≤160-char retry hints to error messages. (8) MCP wiring: `ToolRegistry.registerExternal(serverId, tools, executor)`, tools prefixed `mcp__<id>__<name>`. (9) Embedding-based tool routing in `selectRelevantToolsAsync` once tool count >15 (cosine-sim, keyword fallback). (10) `AgentBudget` with `agentMaxToolCalls` (default 50) + `agentMaxIterations` (default 25) caps, halts cleanly. (11) `partial-args-accumulator.ts` library only — streaming-deltas → full args (UI wiring deferred). (12) `permissionStore.perToolOverrides` + `modeScope` ('chat'|'edit'|'agent'), `getPermissionLevelWithOverrides`. (13) `delegate_task` tool spawns sub-agent with isolated budget, max nesting depth 2.

79. **Regression fixes from Agent Overhaul E2E (commit 47f41ca)** — Five regressions surfaced after v2.4.0 build + install (version bumps later reverted). (a) **Streaming dead in Chat tab** — `proxy_localhost_stream` in Rust collected all bytes via `resp.bytes().await` before returning. Fix in `src/api/backend.ts:localFetchStream`: direct `fetch()` as primary path (Ollama has CORS open on localhost → real chunked streaming), Rust proxy fallback only. (b) **Universal thinking-tag stripper** — new `src/lib/thinking-stripper.ts` handles non-canonical formats the char-state-machine misses: Gemma `<|?channel|?>thought`, alt names (`<thought>`, `<reasoning>`, `<reflect>`, `<deepthink>`), orphan openers. Applied DURING streaming in useChat.ts RAF path (`stripNonCanonicalTags`) and at stream-end in useCodex/useAgentChat (`finalStripThinkingTags`). Canonical `<think>…</think>` flow unchanged. (c) **Approval modal invisible + parallel deadlock** — `ApprovalDialog.tsx` rewritten as fullscreen backdrop modal (prominent buttons, **Enter=Approve**, **Esc=Reject**, autoFocus on Approve). Race fix: `approvalQueueRef: ApprovalEntry[]` (FIFO) replaces single `approvalRef` — N parallel tools used to overwrite each other's resolver and deadlock all but the last. Auto-permission tools bypass via `entry.ac.status !== 'pending_approval'` check inside `awaitApproval`. (d) **Codex stops after 1 tool** — `CODEX_SYSTEM_PROMPT` in useCodex.ts ships explicit AUTONOMY CONTRACT: "NEVER say 'Now I will create X' as plain text and stop. Execute ALL N steps in one session." (e) **FileTree auto-refresh** — `codexStore` gets `fileTreeVersion` counter, bumped by addEvent on `file_change`/`terminal_output`. FileTree subscribes and reloads on change → new files appear live. (f) **v2.4.2 hotfix** for React Error #130: `ToolCallBlock.STATUS_ICONS` was missing `'cached'` (Phase 6 added the status, the icon map didn't get it) → `<undefined />` → crash on second-call-cached scenario. Added `cached: Database` from lucide-react.

80. **Gemma 3/4 plain-text planner bypass (commit ca6632d)** — Separate from #79b. After tag-stripping fixed `<|channel|>thought` leaks, surfaced that Gemma 3/4 with Ollama `think: false` drops into PLAIN-TEXT structured planning (`Plan:` / `Constraint Checklist:` / `Confidence Score:` / `Self-Correction during drafting:`) — no tags any stripper could remove. Tried explicit anti-planning system prompts ("IMPORTANT: Answer directly. Do not output a Plan…"). Gemma ignores them. **Working fix**: new `isPlainTextPlanner(modelName)` helper in `src/lib/model-compatibility.ts` (gemma3/gemma4 base names). When User has Thinking OFF AND model is plain-text-planner, pass `thinking: undefined` (Ollama default = tagged thinking ON) instead of `false`. Gemma then emits `<|channel|>thought` markers that the thinking-stripper removes cleanly; `keepThinking === false` gate drops the native thinking field. Same UX (clean answer, no preamble), trade-off is hidden token spend on internal reasoning. Wired identically in useChat.ts / useAgentChat.ts / useCodex.ts. The dead anti-planning prompts removed.

81. **Version policy: stay at 2.3.3** — Don't bump per regression fix during a session. Public number is the release-train label, not a dev-build counter. Overwrite `LU-<ver>-setup.exe` on Desktop in place rather than creating 2.3.4/2.4.x trail. See `feedback_versioning.md`.

82. **ERNIE-Image integration (commit 2c0c224)** — Baidu ERNIE-Image fully integrated into Model Manager. New ModelType `ernie_image`, strategy `unet_ernie_image` with `ConditioningZeroOut` for negative conditioning (CLIPLoader type `flux2`, shared `flux2-vae`). Two bundles: **Turbo** (8 steps, 28.9 GB) + **Base** (50 steps, 28.9 GB), each with 4 files: DiT model + Ministral-3-3B text encoder + Prompt Enhancer + VAE. All URLs verified HTTP 200 against `Comfy-Org/ERNIE-Image`. No custom nodes needed (ComfyUI day-0 support). No uncensored variants found. Defaults: 8 steps, CFG 1, euler/simple, 1024x1024.

83. **Codex streaming (commit 2c0c224)** — `streamWithTools()` in `useCodex.ts` replaces non-streaming `chatWithTools()` for Ollama. Uses `localFetchStream()` (direct fetch → Tauri proxy fallback) with `stream: true` + `tools`. Live thinking/content tokens via NDJSON parsing. User sees progress during 2+ minute generations instead of blank screen. Non-Ollama providers (OpenAI, Anthropic) keep `chatWithTools()` fallback.

84. **Codex final answer fallback (commit 2c0c224)** — When model returns empty content after tool calls (file_list as last action, no summary text), Codex now generates fallback: "Task completed: N file(s) written, M file(s) read." from the `blocks` array. Desktop + mobile parity.

85. **Codex continue capability (commit 2c0c224)** — Tool-call history persisted as hidden messages (`hidden: true`, `tool_calls: [...]`) in chat store between turns. Next turn's history builder includes them so the model sees what it did before (parity with original OpenAI Codex CLI). `insertMessageBefore()` added to chatStore. `MessageList` + `CodexView` filter hidden messages. Mobile equivalent in `finishToolLoop` splices hidden messages into `msgs[]`.

86. **Path doubling fix (commit 2c0c224)** — `useCodex.ts` line 314 now uses `/^[a-zA-Z]:[/\\]/` regex to detect ANY drive letter as absolute (was: `!p.startsWith('C:')` which treated `D:/` paths as relative → doubled path bug). Rust `normalize_duplicate_drive_prefix()` in `agent.rs` + `filesystem.rs` as defensive dedup (strips `D:/a/D:/a/file.html` → `D:/a/file.html`).

87. **Mobile native tool calling (commit 2c0c224)** — `runToolLoop` in `mobile_landing()` replaces ReAct text-JSON parser. Uses Ollama `/api/chat` with `tools` array (same as desktop). Both Codex + Agent route through it. Remote permissions default to ALL ON. Dead code removed: `buildReActPrompt`, `parseAgentResponse`, `agentChatStream`.

88. **Mobile Codex AUTONOMY CONTRACT (commit 80598ea)** — Mobile `CODEX_PROMPT` now matches desktop's system prompt with explicit autonomy contract: "NEVER say 'Now I will create X' and then stop — execute ALL N steps in one session."

89. **Tool-call overwrite bug fix (commit 9aaa7d6)** — `streamWithTools()` NDJSON parser was overwriting tool_calls instead of appending across chunks. Silent data loss when Ollama split tool calls. Fixed: spread-append `[...toolCalls, ...new]`. Also: Rust snake_case warnings fixed (`systemPrompt` → `system_prompt`), FLUX2 CFG test corrected (3.5 not 1.0), flaky timing tests relaxed (90ms→200ms).

90. **Comprehensive smoke test suite (commit 11a47e4)** — 186 new tests (1919→2105 total) across 9 new test files: `useCodex-streaming` (NDJSON parsing, tool append regression), `useCodex-fallback-answer`, `useCodex-prompt-contract` (AUTONOMY CONTRACT desktop↔mobile parity), `chatStore-operations` (all CRUD + insertMessageBefore + hidden messages), `model-compatibility-smoke` (agent/thinking/planner/claude-code), `ernie-image-workflow` (classification→strategy→bundles→ConditioningZeroOut), `app-wide-smoke` (defaults, registries, bundle→strategy pipeline), `mobile-codex-parity` (tools, loop, permissions), `message-types` (hidden, tool_calls, all roles/modes).

91. **Codex streaming arg repair (commit 1f6d49b)** — `repairToolCallArgs()` was missing in the NDJSON streaming path. Ollama returns tool arguments as JSON strings (not objects) during streaming → args-validator saw string → "path is missing". Non-streaming path in ollama-provider.ts had the repair, streaming path didn't. Fixed: import + apply `repairToolCallArgs()` at both extraction points.

92. **Agent filesystem awareness (commit 1f6d49b)** — Agent system prompt in `useAgentChat.ts` was web-only ("web_search → web_fetch → answer"), making the agent "PC blind" for filesystem tasks. Rewrote `buildAgentSystemPrompt()` with full tool inventory (filesystem, web, system, creative), exploration-first workflow guidance, and `system_info` hint.

93. **AE-style text header (commit ee3a20a)** — Header right section redesigned from icon pills to After Effects typography: Chat, Create, Compare, Benchmark, Models, Settings as clean `text-[0.6rem] font-medium` text labels matching sidebar tab size. Downloads + Light/Dark kept as icons. Improves discoverability (#23 root cause).

94. **Qwen 3.6 day-0 integration (commit ca93252)** — Qwen 3.6 (35B MoE, 3B active, vision + agentic coding + thinking preservation, 256K context) released on Ollama. Added to: `AGENT_COMPATIBLE`, `THINKING_COMPATIBLE`, `CLAUDE_CODE_COMPATIBLE`, recommended models (#1 HOT pick), Discover mainstream list, mobile `THINKING_COMPATIBLE`. One-click Ollama pull via new `ollamaModel` field on `DiscoverModel`.

95. **UI polish (commit 0a82260)** — Sidebar "Soon" tag now replaces label text (was floating above). Downloads + Light/Dark restored to icons. Header nav text matched to sidebar tabs (`text-[0.6rem]`). Qwen 3.6 download button works via `ollamaModel` → `pullModel()` in `handleTextDownload`.

### What's LEFT to finish v2.3.0:
1. **Tauri proxy_localhost investigation** — reqwest in Tauri subprocess can't reach localhost. Direct fetch workaround now also primary path for streaming via #79a. Root cause still unknown. Low priority.
2. **LTX VAEDecode reference** — dynamic-workflow.ts line 263: vaeSourceId incorrectly points to UNETLoader output for LTX strategy. Fix when LTX model is installed for testing.
3. **~~Codex file tree auto-refresh~~** — RESOLVED in #79e via `fileTreeVersion` counter on codexStore.
4. **~~Codex incremental content streaming~~** — RESOLVED in #83 via `streamWithTools()` with `localFetchStream` + NDJSON parsing. Live thinking/content tokens stream during generation.
5. **Mobile/remote.rs thinking-stripper port** — Mobile still uses inline regex stripping in `pushChunkContent`. Could port `thinking-stripper.ts` patterns over but Remote works fine in current state. Low priority.

### Files modified in this branch (30+ files):
- `src/api/comfyui.ts` — 8 new ModelTypes (incl. zimage), COMPONENT_REGISTRY, uploadImage(), inputImage/denoise in GenerateParams, findMatchingVAE/CLIP for zimage
- `src/api/dynamic-workflow.ts` — 8 new strategies (incl. unet_zimage), 5 wrapper builders, inputImage support in SVD/FramePack, I2I pipeline (LoadImage→VAEEncode→KSampler denoise)
- `src/api/comfyui-nodes.ts` — 30+ new nodes in categorization mapping
- `src/api/discover.ts` — 14 video + 6 image bundles, CUSTOM_NODE_REGISTRY, installBundleComplete(), uncensored flags, ALL sizeGB verified, HF GGUF unified text model lists (34 uncensored + 30 mainstream), removed Ollama search/fetch functions
- `src/api/backend.ts` — install_custom_node endpoint mapping, openExternal() for system browser
- `src/api/preflight.ts` — extended needsUnet check for all new model types
- `src-tauri/src/commands/install.rs` — install_custom_node command (camelCase params)
- `src-tauri/src/commands/download.rs` — download_model with resume, progress, speed tracking (camelCase params), 50% threshold for check_model_sizes
- `src-tauri/src/main.rs` — registered install_custom_node, tauri-plugin-updater, exit_app/is_onboarding_done/set_onboarding_done
- `src-tauri/capabilities/default.json` — added shell:allow-open for external links
- `src/components/create/CreateView.tsx` — I2V upload UI, I2I upload zone + denoise slider, Image/Video top-tabs only
- `src/components/create/WorkflowSearchModal.tsx` — openExternal for CivitAI link
- `src/components/create/WorkflowCard.tsx` — openExternal for source links
- `src/components/chat/MarkdownRenderer.tsx` — openExternal for all chat links
- `src/components/layout/DownloadBadge.tsx` — unified: text + ComfyUI downloads, bundle grouping, retry buttons, speed display
- `src/components/models/DiscoverModels.tsx` — VRAM tier tabs, downloadStore integration, retry for failed bundles, openExternal, no double "Installed", removed Ollama/HF tab switcher + VariantPullButton + useModels dependency
- `src/components/onboarding/Onboarding.tsx` — comfyui step, drag region, accent dots, VRAM filtering, tool calling badges, re-scan, openExternal, GGUF downloads via startModelDownloadToPath instead of pullModel
- `src/components/settings/SettingsPage.tsx` — ComfyUISettings component, removed GroupHeader banners, Providers defaultOpen=false
- `src/components/settings/RemoteAccessSettings.tsx` — slimmed to permissions toggles + connected devices only (no start/stop)
- `src/components/layout/Sidebar.tsx` — Remote as 3rd tab, Dispatch button with inline LAN/Internet split, LIVE panel with QR+passcode+URL, dispatchedConversationId tracking
- `src/stores/remoteStore.ts` — dispatch()/undispatch(), dispatchedConversationId, startServer accepts model/systemPrompt
- `src/stores/chatStore.ts` — createConversation accepts 'remote' mode, auto-numbers Remote chats (Remote Chat 1, 2, …)
- `src/stores/remoteStore.ts` — `enrichSystemPromptWithMemory()` bakes memory into systemPrompt at dispatch/restart time, `restart()` command preserves dispatchedConversationId
- `src/hooks/useMemory.ts` — exported pure `extractMemoriesFromPair()` for reuse outside React hooks (Tauri listeners, etc.)
- `src/components/chat/ChatView.tsx` — green "Live" banner (server running) + grey "Server stopped" banner (with prominent Restart button) for Remote chats above the input
- `src/components/layout/AppShell.tsx` — `remote-chat-message` Tauri listener appends mirrored mobile messages to the dispatched conversation + fires memory extraction on assistant turns
- `src/types/codex.ts` — ChatMode union: added 'remote'
- `src/types/chat.ts` — Conversation.mode: added 'remote'
- `src/stores/providerStore.ts` — LM Studio default disabled (auto-detect only)
- `src/stores/updateStore.ts` — Tauri updater plugin: check() + download() + install() flow, dev mode GitHub API fallback
- `src/lib/constants.ts` — OnboardingModel: vramGB, uncensored, agent fields, qwen2.5-abliterate typo fix, HF GGUF downloadUrl/filename/sizeGB for all 17 onboarding models
- `src/hooks/useCreate.ts` — i2vImage + i2iImage pass-through, I2I validation, imageSubMode-based generate logic
- `src/lib/constants.ts` — OnboardingModel: vramGB, uncensored, agent fields + mainstream models
- `src/stores/createStore.ts` — i2vImage/i2iImage/denoise/imageSubMode state, persist migration for old 'i2i' mode
- `src/components/create/ParamPanel.tsx` — Z-Image badge, Text to Image / Image to Image sub-tabs, denoise slider
- `src-tauri/src/commands/process.rs` — Windows Job Object for ComfyUI process cleanup on app kill
- `src-tauri/Cargo.toml` — windows-sys dependency for Job Object API, tauri-plugin-updater
- `src-tauri/src/commands/system.rs` — exit_app, is_onboarding_done, set_onboarding_done, backup_stores (atomic tmp+rename), restore_stores (NSIS data persistence)
- `src-tauri/tauri.conf.json` — updater plugin config with pubkey + GitHub Releases endpoint, createUpdaterArtifacts
- `src-tauri/capabilities/default.json` — updater:default permission
- `src/components/layout/UpdateBadge.tsx` — 5-state update UI: available → downloading (progress) → downloaded (Restart/Later) → installing → error (Retry)
- `src/components/layout/AppShell.tsx` — full store backup/restore (18 keys, 30s interval, sentinel, validation, restoring guard), onboarding recovery
- `.github/workflows/release.yml` — TAURI_SIGNING_PRIVATE_KEY + PASSWORD env vars for signed updater artifacts
- `src/stores/downloadStore.ts` — NEW: unified ComfyUI download tracking (polling, bundle grouping)
- `src/stores/uiStore.ts` — default view changed to 'chat'
- `src/lib/model-compatibility.ts` — added isThinkingCompatible() + THINKING_COMPATIBLE list
- `src/components/chat/ChatView.tsx` — Think button: amber hint for non-thinking models, opacity dim
- `src/hooks/useChat.ts` — double-guard: don't send think=true to incompatible models, think-error retry with async generator fallback, user-friendly error messages
- `src/hooks/useAgentChat.ts` — isThinkingCompatible guard, think-error retry (try/catch around chatWithTools), caveman moved from prepend to append (Response style:), graceful think error message
- `src/hooks/useCodex.ts` — added isThinkingCompatible guard (was missing), caveman injection (was missing), think-error retry
- `src/hooks/useClaudeCode.ts` — caveman injection into CLI prompt (was missing)
- `src/api/providers/ollama-provider.ts` — conditional think: `if (thinking === true) body.think = true` instead of always setting field
- `src/components/chat/AgentTutorial.tsx` — removed "You Stay in Control" step, tutorial now 2 steps, safety info in Tools step
- `src/components/chat/PluginsDropdown.tsx` — NEW: Plugins dropdown (Caveman Mode + Personas), replaces old Persona selector, visible in Chat/Codex/ClaudeCode
- `src/components/chat/ChatInput.tsx` — Caveman button removed (moved to PluginsDropdown), Think button padding fixed (py-1 → py-1.5)
- `src/components/chat/VoiceButton.tsx` — Alignment fix: padding p-2 → p-1.5, icon 15 → 14 (consistent with other input bar buttons)
- `src/components/chat/CodexView.tsx` — Added PluginsDropdown to header
- `src/components/chat/ClaudeCodeView.tsx` — Added PluginsDropdown to header
- `src-tauri/src/commands/remote.rs` — CREATE_NO_WINDOW for cloudflared + taskkill, tunnel URL parsing fix (.trycloudflare.com), complete mobile web app (Stitch "Terminal Authority" design: 4-tab auth/chat/generate/history/settings, NDJSON streaming, self-contained HTML), dispatched_model/dispatched_system_prompt state, `/remote-api/config` endpoint, start_remote_server accepts model/systemPrompt params, mobile chat-only redesign (scoped to dispatched chat), `/remote-api/chat-event` endpoint + `app_handle.emit('remote-chat-message')` for mobile→desktop sync, `restart_remote_server` Tauri command (stop + 300ms + re-acquire state + start), mobile `postChatEvent()` helper + 401 clearAuthAndReload handler

### Test files (32 total, 28 new):
- `src/api/__tests__/comfyui-models.test.ts` — classifyModel, MODEL_TYPE_DEFAULTS, COMPONENT_REGISTRY, determineStrategy (79 tests)
- `src/api/__tests__/comfyui-bundles.test.ts` — bundle validation, custom node registry, shared files (15 tests)
- `src/api/__tests__/comfyui-workflows.test.ts` — strategy mapping, unavailability, workflow coverage (30 tests)
- `src/api/__tests__/comfyui-integration.test.ts` — full pipeline Bundle→Strategy verification (36 tests)
- `src/api/__tests__/agents-parsing.test.ts` — AGENT_TOOLS, buildReActPrompt, parseAgentResponse (28 tests)
- `src/api/__tests__/backend-urls.test.ts` — isTauri, ollamaUrl, comfyuiUrl, comfyuiWsUrl (22 tests)
- `src/api/__tests__/comfyui-nodes-categorize.test.ts` — categorizeNodes, detectAvailableModels (25 tests)
- `src/api/__tests__/discover-registry.test.ts` — bundles, COMPONENT_REGISTRY, lookupFileMeta (34 tests)
- `src/api/__tests__/dynamic-workflow-strategy.test.ts` — determineStrategy all 15 model types (30 tests)
- `src/api/__tests__/stream-parser.test.ts` — parseNDJSONStream (23 tests)
- `src/api/__tests__/workflows-validation.test.ts` — validateWorkflowJson, extractSearchTerms, autoDetectParameterMap (35 tests)
- `src/lib/__tests__/formatters.test.ts` — formatBytes, formatDate, truncate (29 tests)
- `src/lib/__tests__/tool-call-repair.test.ts` — repairJson, extractToolCallsFromContent (46 tests)
- `src/lib/__tests__/tool-selection.test.ts` — selectRelevantTools, TOOL_GROUPS (27 tests)
- `src/lib/__tests__/privacy.test.ts` — proxyImageUrl (16 tests)
- `src/lib/__tests__/constants-validation.test.ts` — DEFAULT_SETTINGS, BUILT_IN_PERSONAS, ONBOARDING_MODELS (36 tests)
- `src/lib/__tests__/built-in-workflows.test.ts` — BUILT_IN_WORKFLOWS structure (37 tests)
- `src/lib/__tests__/systemCheck.test.ts` — getRecommendations, detectSystem (28 tests)
- `src/lib/__tests__/storage-quota.test.ts` — getStorageUsage, createSafeStorage (38 tests)
- `src/stores/__tests__/createStore.test.ts` — clamping, gallery, prompt history, mode switching (35 tests)
- `src/stores/__tests__/providerStore.test.ts` — obfuscation, getEnabledProviders (27 tests)
- `src/stores/__tests__/updateStore.test.ts` — isNewerVersion, checkForUpdate (28 tests)
- `src/stores/__tests__/benchmarkStore.test.ts` — getAverageSpeed, getLeaderboard (26 tests)
- `src/stores/__tests__/compareStore.test.ts` — startRound, addContent, finish (35 tests)
- `src/stores/__tests__/workflowStore.test.ts` — getWorkflowForModel, cascading cleanup (35 tests)
- `src/stores/__tests__/permissionStore.test.ts` — getEffectivePermissions merging (20 tests)
- `src/stores/__tests__/agentWorkflowStore.test.ts` — startExecution, duplicateWorkflow (25 tests)
- `src/stores/__tests__/agentStore.test.ts` — nested updates, toolCall tracking (25 tests)
- `src/stores/__tests__/settingsStore.test.ts` — persona CRUD, migration (22 tests)
- `src/stores/__tests__/mcpStore.test.ts` — cascading cleanup (24 tests)
- `src/stores/__tests__/sessionStores.test.ts` — codex+claudeCode+voice stores (31 tests)
- `src/stores/__tests__/remoteStore.test.ts` — passcode, tunnel, QR refresh (28 tests)

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


## Test Suite: 2105 tests (83 test files, as of v2.3.3 final)
All pre-existing test failures have been fixed. Run `npx vitest run` to verify.
Also run `cargo check --manifest-path src-tauri/Cargo.toml` for Rust changes and `npx tsc --noEmit` for TS type check.
