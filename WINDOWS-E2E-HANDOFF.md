# LU 2.5.7 — Windows E2E Handoff & Test Plan

**Purpose.** Launch is **Windows + Cloud first** (macOS follows ~1–2 weeks later). This
document lets a Windows coding agent **build** LU 2.5.7 from the bundled source and then
**test every single function end‑to‑end** — the same coverage that was driven live on the
Mac. Each function is proven **individually**; "Create / Media" is *not* one collective
checkmark.

Branch in the bundle: **`release/2.5.7-merged`**. Everything below is committed there.

---

## 0. What you received

- `lu-2.5.7-windows.bundle` — a git bundle of the full repo + history at `release/2.5.7-merged`.
- This file (also committed inside the bundle at repo root).

Restore it:

```powershell
git clone lu-2.5.7-windows.bundle lu
cd lu
git checkout release/2.5.7-merged
git log --oneline -8        # sanity: HEAD should be the "windows-handoff" commits
```

---

## 1. Build on Windows

**Prerequisites**
- **Rust** (stable, *MSVC* toolchain): `rustup default stable-x86_64-pc-windows-msvc`
- **Visual Studio Build Tools** (MSVC v143 + Windows 10/11 SDK) — for the Rust/Tauri native build
- **Node 20+** and npm
- **WebView2 runtime** (present on Win 11 by default; on Win 10 install "Evergreen" WebView2)
- **Vulkan SDK** (LunarG) — required to build the built‑in inference sidecar (llama.cpp, Vulkan backend)
- **CMake** + **Git** (build-llama.sh clones + cmake-builds llama.cpp)
- A **bash** (Git‑Bash) to run `scripts/build-llama.sh`

**Steps**

```bash
npm install

# 1) Build the built-in engine sidecar (REQUIRED — the Tauri build hard-fails if the
#    sidecar exe is missing; copy_binaries only checks that the file EXISTS).
#    Pinned llama.cpp tag is b9949 (see scripts/build-llama.sh). Needs Vulkan SDK.
bash scripts/build-llama.sh x86_64-pc-windows-msvc
#    -> produces src-tauri/bin/lu-llama-server-x86_64-pc-windows-msvc.exe
#       (the lu- prefix is deliberate, see GitHub #120: Debian owns /usr/bin/llama-server)

# 2) Build the app (NSIS installer).
npm run tauri:build
#    -> src-tauri/target/release/bundle/nsis/*-setup.exe
```

**If the Vulkan sidecar build is flaky / blocks you:** you can unblock the app build by
dropping a stub so `copy_binaries` passes, then fix the real sidecar after:
```bash
# emergency stub ONLY to get the app to build; built-in engine won't run until real build lands
printf '' > src-tauri/bin/lu-llama-server-x86_64-pc-windows-msvc.exe
```
(There is also a dedicated CI lane `.github/workflows/sidecar-windows.yml` that does the full
Vulkan build + boot smoke — usable once the branch is pushed.)

**Windows naming (deliberate, do not "fix"):** `src-tauri/tauri.windows.conf.json` overrides
`productName` back to **"Locally Uncensored"** for this one release (installer dir / Start‑menu /
registry keys), while the in‑app window title is **"LU"**. This avoids a duplicate install +
orphaned shortcuts. The NSIS rename‑migration to "LU" is scheduled for **2.5.8**. Expected NSIS
artifact name: `Locally.Uncensored_2.5.7_x64-setup.exe`.

---

## 2. Passwordless rebuild/test loop (important for an agent)

A rebuilt app gets a fresh signature, so Windows Credential Manager would prompt for a
password on the first keychain read after **every** rebuild — which stalls an unattended
loop. Disable the keychain **for testing only**:

```powershell
setx LU_NO_KEYCHAIN 1          # env var …
# …or drop a marker file:
type nul > %USERPROFILE%\.lu-no-keychain
```

Effect (`src-tauri/src/commands/secret.rs`): the secret commands report the keychain as
unavailable, so the cloud session + provider keys fall back to localStorage and **no password
prompt** appears. A shipped build never sets this.

**Caveat:** with no‑keychain, cloud starts **logged out** after a fresh build. Log in **once**
(§E) — the session then lives in localStorage and survives further rebuilds.

---

## 3. Test method

- Prove **each** function individually and **verify the real result** (play the video, expand
  the image, read the file on disk) — never a collective "media works".
- **Spend as little as possible** on paid cloud renders: cheapest model, **Draft** quality,
  **shortest** length. Cloud media meters credits; watch the credits meter move.
- Record **GREEN / RED** per function with the concrete evidence (what you saw).
- Local media on Windows runs on **ComfyUI** (NVIDIA/Vulkan) — this is expected on Windows
  (unlike Mac, where ComfyUI is being dropped). If a local op needs a one‑time model/node
  download, that download is part of the test.

Legend below: **[Mac✓]** = already proven green on macOS in the campaign, so you know the
expected behavior; **[Win‑new]** = Windows‑specific path that was never exercised on Mac.

---

## 4. E2E function checklist

### A. First run / onboarding
1. Install the NSIS build, launch. **Expected:** window titled **LU**, onboarding/launcher
   appears, no crash. Local features work with no account. [Mac✓]
2. Confirm the global **Local / Cloud** switch is present (header). Default **Local**.

### B. Built‑in engine — local text chat  [Win‑new: Vulkan sidecar]
1. Chat tab, Local mode, model = **Built‑in Engine** (`127.0.0.1:8127/v1`, managed).
2. Send "Two plus two?". **Expected:** streamed answer "4"; the `lu-llama-server.exe` sidecar
   is running (Task Manager). This is the Windows Vulkan sidecar — first real HW test.

### C. Local text chat — Ollama & LM Studio (if installed)
1. If Ollama present: pick an Ollama model, send a prompt → streamed reply.
2. Settings → AI Backends → **LM Studio**: Start, load a model, chat. (Optional if not installed.)

### D. Import / provider settings
1. Settings → General → **Import from other chatbots** (file import opens).
2. Settings → AI Backends → **Add provider**, **Model Storage** path shown.
3. Settings → General → **Hardware (GPU picker)**: vendor radio (Auto/NVIDIA/AMD/Intel),
   **Detected GPUs** lists the real Windows GPU, **Re‑detect** works. [Mac✓ on Mac showed Apple GPU]

### E. Cloud account — login (Max‑only gate)
1. Settings → General → **LU Cloud Account** (or the Cloud switch → gate modal).
2. **Email + password** login. Then sign out, test **Google** and **GitHub** (open system
   browser → 127.0.0.1 loopback → returns to app). **Expected:** logged in; a non‑Max account
   hits the "part of the Max plan" gate with a **View plans** link. [Mac✓ email path]
3. After login, flip the header switch to **Cloud**. Local models offload (§O).

### F. Cloud chat + Think  [Mac✓]
1. Cloud mode, model **Qwen3 30B A3B** (or cheapest Think‑capable). Toggle **Think** on.
2. Trick question ("I have 10 apples, eat all but 9, how many left?" → **9**). **Expected:**
   a visible "Thinking" block + correct answer, no `inference upstream error`. (Bug 4 + Bug 5
   already fixed: multi‑turn tool chat + max_tokens clamp.)
3. Send a 2nd and 3rd follow‑up in the SAME chat with tool history → still green (Bug 4).

### G. Cloud media — prove EACH op individually (cheapest / Draft / shortest)
Watch the credits meter move for each.
1. **Image gen** — Flux Schnell, Draft, 1:1, simple prompt → new prompt‑true image (~‑300). [Mac✓]
2. **Video T2V (#80)** — cheapest T2V (Wan‑2.2‑Fast), shortest → clip **plays** in lightbox. [Mac✓]
3. **Image Edit (#81)** — pick a result, mask a region, prompt an edit → edited image.
   ⚠️ **Bug A fix under test:** mask now travels as a `data:` URL (was `blob:` → 415). Verify
   NO "unsupported image format" error. **[verify live after login]**
4. **Animate i2v (#82)** — "Animate image" on a still → short clip plays. [Mac✓]
5. **Remove Background (#83)** — cloud removebg on an image → clean cutout (transparent bg). [Mac✓]
6. **Eraser (#84)** — mask an object, erase → object gone. ⚠️ same Bug‑A mask path. **[verify live]**
7. **Upscale Image (#85)** — 2K target → larger image returns. [Mac✓]
8. **Upscale Video (#86)** — "Enhance" a clip → higher‑res clip plays. [Mac✓]

### H. Local media — ComfyUI  [Win‑new — expected to WORK on Windows]
1. Local mode, Create → **Image** (SD 1.5 via ComfyUI). Draft → generated image.
2. Create → **Remove Background** (local ComfyUI‑RMBG, ~300 MB one‑time). **On Windows with
   NVIDIA the `onnxruntime-gpu` wheel exists**, so the node install that FAILS on macOS should
   **succeed** here → real cutout. (This is exactly why Mac is deferred to MLX.)
3. Create → **Video** (local T2V) if a local video model is installed.

### I. Voice
1. **TTS** (no mic): speaker icon under an assistant reply → audible playback, icon cycles
   idle→playing→idle. [Mac✓ TTS]
2. **STT** (needs mic): dictation button → speak → transcript appears. Whisper is **lazy** —
   the `whisper_server` starts on first STT, not at app launch. ⚠️ **UTF‑8 panic fix under test:**
   dictate a German sentence with umlauts (ä/ö/ü) — must NOT crash (was `&transcript[..80]`
   byte‑slice → panic on a multibyte boundary; now char‑safe).

### J. Code agent — multi‑file task  [Mac✓ cloud]
1. Code tab, pick a scratch workspace folder. Ask it to create + run a small multi‑file program
   (e.g. fizzbuzz + test). **Expected:** files written on disk, test passes; tool calls
   (`file_search`, `file_write`, shell) show green. Test both Local and Cloud model.
2. ⚠️ **UTF‑8 panic fix under test:** run a code‑agent `file_search` for a term in a file that
   contains umlauts — must NOT crash (`filesystem.rs` `fs_search` byte‑slice → now char‑safe).

### K. Agent tools + MCP  [Mac✓]
1. Cloud chat, enable Chat Tools, prompt "use your web search tool" → `web_search ✓` + answer,
   no upstream error.
2. Add an MCP server (Settings → Agent → MCP Servers) and exercise one tool (optional).

### L. Plugins / composer controls  [Mac✓ UI]
1. Composer **Plugins** picker (web/file/image/video toggles, personas). 2. **Think** toggle.
3. **Advanced** drawer (params). 4. **Docs** attach button.

### M. Docs / RAG (local)  [Mac✓]
1. Local mode, Composer **Docs** → upload a small text file with invented facts → embedded
   (nomic‑embed‑text via Ollama; needs Ollama). 2. Toggle Document‑Chat **on**, ask about a fact →
   correct answer + "Retrieved Chunks" with source + score. Toggle **off** → model denies knowledge.

### N. Export / import + backup
1. Settings → General → **Chat Backup → Export all chats** → native save dialog → valid JSON
   on disk (`{app,kind:"chat-export",version,count,conversations[]}`). [Mac✓]
2. Per‑chat **Export** (.md / .json). 3. **Import chats** round‑trips.
4. Settings → General → **Image/Video timeouts** editable; **Appearance** theme Light/Dark +
   **Avatar upload**. [Mac✓]

### O. Offload behavior  [Mac✓]
1. Local model loaded → flip to **Cloud** → local models evicted (Ollama `ps` empty, ComfyUI
   freed, whisper stopped, LM Studio unloaded). 2. Back to **Local** + chat → model **lazy**
   reloads. (No proactive load on start.)

### P. Model Manager
1. Models tab: **download / install per model** (text via Ollama; image/video via ComfyUI
   `/object_info`). Verify a real download completes + the model becomes selectable.
   ⚠️ David's concern: confirm **each** model actually downloads/installs, not just the first.
2. **CivitAI** search (if present). 3. **LM Studio** start/stop.

### Q. Update flow (do last)
1. Install **2.5.6** first, then update to this **2.5.7** in place. **Expected:** same install
   dir, shortcuts intact, chats preserved (STORE_KEYS), title now "LU". NSIS override keeps the
   "Locally Uncensored" installer identity for this release.

---

## 5. Known watch‑outs
- **Bug‑A (cloud Edit/Eraser mask)** fix is included but was **never live‑verified** (Mac build
  was logged out). First real proof happens in §G.3/§G.6 after login.
- **Local RMBG / any ComfyUI custom node** with `onnxruntime-gpu` or `decord` deps: fine on
  Windows‑NVIDIA (wheels exist); these are the packages that have **no macOS‑arm wheel** — the
  reason Mac local media is moving to MLX and is deferred.
- **Sidecar** is not committed (`src-tauri/bin/.gitignore`); it MUST be built (§1) or the Tauri
  build fails.
- Branch is **not pushed** — CI Windows lanes have not run yet; this build is the first real one.

## 6. Fixes included in this bundle (since 597ba0c)
- Crash safety: `agent.rs` / `whisper.rs` `SystemTime.unwrap()` → `unwrap_or(0)`.
- **UTF‑8 panic fixes** (crash on German umlauts under `panic=abort`): `filesystem.rs` fs_search
  and `whisper.rs` transcript log — byte‑slice → `.chars().take(n)`.
- `MemorySettings` Add‑Memory: inline "required" feedback + disabled Save (was silent no‑op).
- Create `#88`: gallery never auto‑displays; Stage starts empty, fills only on explicit pick.
- **Bug‑A**: `MaskEditor` emits a `data:` URL; `useCloudCreate`/`dataUrlToBlob` guard + test.
- `secret.rs`: `LU_NO_KEYCHAIN` test flag (§2).

Gates on this tree: `cargo check` clean · app‑tsc **331 = baseline (0 new)** · vitest 5/5.
