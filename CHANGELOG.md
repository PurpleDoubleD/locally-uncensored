# Changelog

All notable changes to Locally Uncensored are documented here.

## [3.0.10] - 2026-11-05

A fix for lost chats. When the chat list came back without its chats, the
next backup replaced the only complete copy in `store_backup.json`, and the
check at launch did not notice the empty list. The bug is in 3.0.8 and 3.0.9.
LU Cloud keeps its open models: seventeen video models and nine image models
in the cloud catalogue.

### Fixed
- A backup whose chat list lost chats keeps the previous backup as
  `store_backup.chats-<time>.json` first (the newest five stay). Images in
  those chats are not cleaned up while an archive points at them.
- The check at launch counts a chat store as there only when it can be read,
  so an empty or unreadable store is restored from the backup again.
- Settings, Chat Backup: "Restore chats from backup" brings back every chat
  the backup files hold that is not in the list. Chats that are there stay as
  they are, and nothing is added twice. "Choose a backup file..." takes a
  `store_backup*.json` from anywhere, and "Import chats" reads one too.
- A note at launch says when the backup holds such chats. It restores
  nothing by itself.

## [3.0.9] - 2026-11-05

A group chat sends every speaker the context you picked, can redo one
speaker and lets you set the speaking order. A compaction is one line in the
chat, and the stretch before it can be read again. Animate takes an end
image and, with MiniMax H3, up to nine reference pictures; Create takes
reference pictures for Krea 2, Qwen-Image 2.1 and FLUX.2. Long local videos
go to 15 seconds without drifting in colour, and a video shows a preview
while it renders. The trainer learns styles, concepts and poses (Beta), and
local training uses the full LoRA strength. Hugging Face's "Use this model"
opens the download in LU. The Linux AppImage starts again without the tray
library. Liquid LFM3 is in, and the LU Engine runs llama.cpp b11960. What
has only run in automated tests is listed under Known limits. LU Cloud
keeps its open models: seventeen video models and nine image models in the
cloud catalogue.

### Added

- **Regenerate one speaker** in a group chat, with the choice to keep later
  answers or regenerate from there; "Regenerate whole round" as its own
  button. (GitHub #199)
- **Speaking order** with arrows and drag, sitting out one round, "Skip
  speaker" and "Stop round" during a round. (GitHub #200)
- **Compaction layers.** The chat starts at the newest compaction; marks on
  the left open each earlier stretch, read only.
- **Recall older messages** (setting, off by default): after a compaction the
  up to four older messages closest in meaning to the new one go back in,
  embedded and searched on this machine. (GitHub #205)
- **HTML preview in the chat**: a sandboxed frame served from 127.0.0.1 with a
  token per page, network only when allowed for that page, never run on its
  own. Desktop only. (Discord)
- **Large text fields and an editor with search** for persona, reminder and
  memory. (GitHub #197)
- **Custom sampling parameters** in the persona and the chat's sampling popup.
  (GitHub #198)
- **Enter key setting**: send, or new line with Ctrl/Cmd+Enter to send.
  (GitHub #202)
- A "?" next to every temperature control.
- "Copy as Markdown" in a message's right-click menu. (Discord)
- **End image in Animate** for Wan 2.2 A14B, Wan 2.1 FLF2V and MiniMax H3
  locally and for the LU Cloud catalogue models that offer it; **up to nine
  reference pictures** for MiniMax H3 reference to video. (Discord)
- **Reference pictures in Create**: Krea 2 style (up to 3), Qwen-Image 2.1 (up
  to 10), FLUX.2 (up to 4). (Discord)
- **Live preview while a video renders.** (Discord)
- **"After a render"** (Settings, Hardware): free ComfyUI's memory after 5
  minutes, right away, or never. (Discord)
- **Prompt assistant** in Create: keywords to a prompt for the picked model.
  (Discord)
- The gallery lists the LoRAs of a picture with their strength. (Discord)
- **LoRA order in Create**: with two or more LoRAs picked, "Order of the
  run" lists them numbered, with ↑/↓ to move one; the order is kept per
  task and model. (Discord)
- **Select several items in the gallery** (desktop): Cmd/Ctrl-click, Shift
  for a range, Cmd/Ctrl+A, Escape to clear. "N selected" and the right-click
  menu move them to a folder, download or delete them; Delete asks first.
  (Discord)
- **Style, concept and pose training** next to characters (Beta). (Discord)
- **Hugging Face "Use this model"** opens a checked download dialog in LU
  (`locallyuncensored://open-model`).
- Remove refusals shows bytes, speed and time left for every download.
- A note with the working range when CFG or a LoRA strength is far off.
  (Discord)
- Details button for the shortened description on image, video and Mac media
  tiles. (Discord)
- Setting "Start ComfyUI when LU starts" (Settings, ComfyUI).
- **Status menu in the menu bar and tray**: with LU Cloud "Signed in", the
  plan, credits left and "Plan & Credits…"; locally the engine, the loaded
  model and its state, memory in use and "Models…"; Open LU and Quit LU.
- **Liquid LFM3**: Text 1.7B, VL 2B, Omni 2B and Audio 2B as GGUF for the LU
  Engine, all four through Ollama 0.40.13 or newer and as MLX builds on a
  Mac, text and pictures in LM Studio (runtime 2.65.1 or newer, else a clear
  note). LFM3 Audio dictates and reads aloud in the chat and the Voice area,
  through the LU Engine or Ollama.

### Changed

- **Group chat context** (GitHub #201): local speakers get their chosen window
  minus room for the answer, no longer about half of it; a grey line names
  messages that were not sent. A long answer earlier in the round goes out
  shortened, not refused.
- **Compaction shows as one line** ("Compacted, 11.6K → 7.1K"), and in an agent
  run as a step.
- **Long local videos up to 15 seconds**, each section held to the first one;
  the colour match stays in YUV.
- Local training uses the full LoRA strength (network alpha equal to the
  rank).
- **ComfyUI is not started without being asked**; LU connects to a running one
  and follows Comfy Desktop on port 8000.
- **Remove refusals checks knowledge with 1000 questions** and judges the
  difference against chance.
- LoRA picks are kept per task and model. (Discord)
- Sampler and scheduler in Create show the names people use (DPM++ 2M SDE,
  Euler a, Karras) with ComfyUI's name beside them; the search finds both
  spellings. (Discord)
- Improve my prompt also rewrites an edit instruction. (Discord)
- A zoomed picture moves with the mouse in the large view. (Discord)
- The prompt enhancer frees the card first, shows its tokens and ends a
  silent job after 3 minutes. (Discord)
- A slow first answer from a partly offloaded Ollama model explains itself and
  names a smaller installed model. (Discord)
- The message field fits 375 px.
- "Continue on phone" says that shared chats show up with the next LU phone
  app; the current phone app and the browser remote cannot show them yet.
  (Discord)
- Updates must carry their version in the signature (Tauri CLI 2.11.5, updater
  2.12.0, requireSignedVersion); vite 8.1.6.
- The LU Engine runs llama.cpp b11960 (v0.8.0) instead of b9949; LU passes
  --load-mode instead of the removed --no-mmap and --mlock.

### Fixed

- **Gallery folders no longer empty themselves.** The gallery kept at most
  200 entries and silently dropped the oldest, sorted ones too, with their
  folder and prompt; the files stayed in the output folder. Pictures in a
  folder are now never removed automatically, the limit of 200 counts only
  unsorted ones, and the gallery says when older unsorted ones were
  removed. "Reset settings & reload" keeps the gallery and its folders.
  Folders and prompts lost before 3.0.9 cannot be brought back. (Discord)
- "Move to folder" in the large view is readable in light mode, and after a
  move the large view goes on to the next picture instead of getting
  stuck. (Discord)
- Typing the name of an existing gallery folder puts the pictures into that
  folder instead of creating a second one with the same name.
- After zooming, the large view shows the picture without stripes at the
  edges, on a solid background.
- The LoRA strength slider runs from -2 to +2 with 0 in the middle; a typed
  value up to ±20 widens the slider. (Discord)
- **The Linux AppImage starts without a loadable tray library** and carries
  the tray libraries again. (GitHub #204, #208)
- **Android: the keyboard no longer closes on Create.**
- **Right-click "Copy text" copies plain text**, as Ctrl+C does. (Discord)
- A local Edit makes as many pictures as the batch size. (Discord)
- 16:9 under the prompt and in Advanced give the same size. (Discord)
- Qwen Image 2.1 Turbo runs its own 8 step schedule. (Discord)
- The ⓘ next to an installed image model did nothing; it now shows type,
  size and folder, and LoRAs have one too. A model or LoRA downloaded from
  now on keeps its Hugging Face or CivitAI page, opened with "Open source
  page". (Discord)
- The Edit strength slider for Qwen-Image edits through ComfyUI is back and
  now takes effect; before, its value never reached the workflow. At 1.0,
  the default, an edit comes out as before. (Discord)
- PyTorch installs with an old pip: before the PyTorch step LU updates a
  pip older than 24 in ComfyUI's environment. (GitHub #211)
- Character trainer setup with an old pip: LU updates a pip older than 24 in
  the trainer environment before PyTorch. Before, Python 3.11.4 and early
  3.12 ended in "The Python in the trainer environment is one the trainer
  cannot use", although the Python was fine. The setup steps and the final
  error now also go to LU's log file. (Discord)
- Character trainer setup with a working Python 3.11 or 3.12 that "does not
  start": on Windows the trainer now starts its Python without PYTHONHOME and
  PYTHONPATH (a leftover of a removed Python can make every one die at start-up),
  and every Python it skips is named in the log with its exit code and error.
- When ComfyUI is not running and a task's model files are already on
  disk, Create says so and offers "Start ComfyUI" instead of a one-time
  download. (GitHub #209)
- A long clip no longer grows brighter section by section.
- Comfy-Org's LTX 2.5 image to video template imports and runs; an own LTX
  2.5 workflow is kept. (GitHub #196)
- A model in two folders is listed once. (Discord)
- MCP servers with uvx start on Windows, and a first start waits while uv or
  npm downloads the server; a Mac LU from the Finder finds uvx and npx.
  (Discord)
- MCP arguments with quotes, ghost servers after a cancelled connect, and an
  Ask First row for external MCP tools.
- REA on Apple Silicon says whether Ghidra's decompiler is built for this Mac.
- An empty placeholder file is not taken for the LU Engine. (GitHub #207)
- The Local API takes bodies up to 32 MB and routes Ollama and LU Engine
  requests to the app's addresses.
- The CivitAI search loads still previews; on Linux the window froze.
  (Discord)
- A Hugging Face search hit without a named quant downloads the largest
  quant that fits in graphics memory with room to spare, not always Q4_K_M,
  and says which one and why. The link dialog marks files that won't fit
  fully. An imatrix file is no longer taken for the model. (GitHub #215)
- Downloading a GGUF chat model no longer fails with "Could not determine
  model directory" when another OpenAI-compatible server is set up in LU.
  A model goes to the LU Engine then, the chat stays on that server and a
  line says why; a real failure names its real reason. (Discord)
- Windows: LU opened only "Could not find the WebView2 Runtime" when that
  runtime was missing for the Windows user. The installer now carries
  Microsoft's WebView2 setup and installs the runtime when it is missing, and
  LU offers it at start, with Microsoft's download page as the fallback.
- A split GGUF set with missing parts is not downloaded; a failed Hugging Face
  search says so; only the newest search writes results.
- Desktop LU Cloud Create checks negative prompt, lyrics and trigger word only
  when the run sends them.
- A new training asks before replacing a character of the same name;
  same-named photos and non-English trigger words are handled.
- A stopped character training on the phone is not reported as trained.
- Train new on Windows and Linux says "Local training uses Z-Image" instead
  of listing image models it does not train on. (GitHub #210)
- The onboarding's "Models you already have" lists LU Engine models too.
- A dismissed update stays dismissed after a restart.
- Settings resets, bounded number fields, Add Provider's Ollama address, the
  onboarding re-run and its Ollama address.
- A broken chat backup, long words in a bubble, a prompt longer than the
  context, Compare without its error, a cleared download coming back,
  external voice failures, narrow windows, unnamed controls.

### Known limits

- The last Create fixes ran on Windows with a real ComfyUI on an RTX 3060: ⓘ
  details for image models and LoRAs, sampler names, the LoRA order (A then
  B and B then A gave different pictures with the same seed), Edit strength
  for Qwen-Image 2.1 (0.4 against 1.0), the pip update before PyTorch,
  "Start ComfyUI" for files already on disk, selecting several gallery items
  with "Move to folder" from the large view, and the gallery keeping 200
  sorted pictures with their prompts after 500 new ones. Not checked there:
  downloads from CivitAI (they need an API key), Download for a gallery
  selection (one save dialog per file), Edit strength on Qwen-Image 2.1
  Turbo and Qwen-Image-Edit 2509/2511, zooming with a touchpad or on a
  portrait picture in the large view, and "Reset settings & reload" keeping
  the gallery, which ran on a Mac only.
- Picking a quant by graphics memory ran on Windows on an RTX 3060 (12 GB)
  and on a Mac with 16 GB simulated; every test download was stopped at the
  start, so no swapped model has been run to the end.
- The note on "Continue on phone" ran on a Mac only.
- The fix for "Could not determine model directory" ran on a Mac only.

- Clicked through on a Mac in builds made like the release. On Windows a
  test build ran on an RTX 3060 (updates, Hugging Face links, image and
  video with ComfyUI, HTML preview, uvx MCP servers, Comfy Desktop on port
  8000, onboarding), the last with the LU Engine of the automated release
  build.
- Long videos ran on one RTX 3060 (Wan 2.2 A14B, 15 and 30 seconds).
- A local end image (Wan 2.2 A14B), the live preview and "After a render"
  ran on an RTX 3060. Reference pictures, the LU Cloud end image and the
  enhancer changes have not run on a real graphics card yet.
- Style training is Beta; a woodcut style was not learned at 600 steps. A
  test figure was not learned at 1200 steps either; real photos were not
  measured.
- The status menu was clicked through on a Mac; on Windows only its memory
  figure was checked, not its entries.
- The AppImage fix ran in Linux containers, not on a desktop with a panel.
  Without a loadable tray library LU starts without the tray and its status
  menu.
- If LU installed your ComfyUI before 3.0.9, it no longer starts by itself
  when LU opens. Turn on "Start ComfyUI when LU starts" in Settings →
  ComfyUI once, or just generate something in Create, which starts it as
  before.
- LFM3 in LM Studio needs runtime 2.65.1 or newer and has not run there.
- The LU Engine b11960 ran on a Mac and on Windows (text, pictures, start on
  an RTX 3060 with Vulkan); Linux in automated tests.
- Recall: plain chat only. Compaction layers in Code: automated tests only.

## [3.0.8] - 2026-10-27

Web search in the chat finds an answer again: LU asks five search services in
turn, needs no key for any of them and reads a page the way a reader view
does. A video made in the chat now plays in the chat, Wan 2.1 clips are mp4
files, and a long video no longer holds the chat: it renders in the
background while you write on. A picture attached in the chat reaches the
image tool. With two graphics cards, chat and ComfyUI can each get their own.
The LU Engine plans a model's memory from the file itself, says what a long
context costs and offers a shorter one with one click, and on Windows it no
longer keeps a second copy of the model in memory. AMD cards on Windows get
AMD's current ROCm build, Intel Arc cards get their own. Memories can be
deleted again, the onboarding no longer runs twice, LU Cloud users see an
outage notice in the app, and icons stay visible in light mode. New tools:
the chat can read and change LU's settings with a confirmation card, the
Model Manager can make a copy of a local model that refuses less, and
Settings, Storage puts models, gallery and runtime in one folder of your
choice. The temperature is held to 1.5, where models still write sense.
What has only run in automated tests is listed under Known limits. LU Cloud
keeps its open models: seventeen video models and nine image models in the
cloud catalogue.

### Added

- **Web search with five services in turn, no key needed.** The chat's
  web_search asks Exa first, then You.com, a SearXNG instance, DuckDuckGo and
  Wikipedia, and moves on when one does not answer or blocks the request.
  DuckDuckGo's bot page is recognised as a failure instead of read as an empty
  result. There is no limit on the number of searches in one answer. Only when
  every service fails does the model read one clear sentence telling it not
  to retry and to answer from what it knows. web_fetch reads a page on your
  machine with a port of Mozilla Readability and falls back to Exa when the
  page cannot be read. Settings lists every service in its order. LU Cloud
  chats use the same search, running in the app. (Discord, the search loop
  since 3.0.7)
- **A long video no longer holds the chat.** When the model starts a video or
  a long image job and it takes longer than a short wait, the turn ends with
  the model's sentence and the clip renders in the background. You can write
  on. When it is done it appears in the message that asked for it, and the
  model learns about it from a note on the next turn. Stop on a later turn
  does not cancel it. A short render stays in the turn as before, and the
  setting can switch the background off. (Discord)
- **A graphics card per task.** With two cards, Settings can put the chat
  model on one and ComfyUI on the other, so a video does not push the chat
  model out of memory. ComfyUI is started with only its card visible, the LU
  Engine with its own device.
- **The LU Engine says what a long context costs.** The start plans layers,
  context and cache from the model file's own header, the way llama.cpp
  counts them, including sliding window and mixture of experts models. When a
  model does not fit, the notice says how many layers fit at your context and
  at a shorter one, for example "With 64K context, 24 of 60 layers fit on the
  graphics card ... With 16K, 30 fit", with buttons Context 16K and KV q8_0.
  A context you set yourself and the cache type are never changed without
  you. A context nobody chose is as much as fits, up to 32K. After each start
  the plan is compared with what llama.cpp reserved, and the next start
  corrects itself.
- **Tokens per answer and /usage.** Each reply shows the tokens it took, and
  /usage in the chat sums up the conversation. (Discord)
- **LoRA stack: search, strength from -20 to 20, copy a name.** The LoRA list
  in Create gets a search field, keeps its place and copies a LoRA's name with
  one click; the strength slider takes -20 to 20. (Discord)
- **"Start with LU" for the Local API.** The Local API can come up on every
  launch of the app. (Discord)
- **Outage notice for LU Cloud.** When LU Cloud announces an outage, the app
  shows a short line you can close, and a failed cloud chat, agent or Create
  run says what is going on instead of a raw error. The check runs only while
  you are signed in.
- **Kimi K3.1 Pro** is in the LU Cloud model list. In the Model Manager Kimi K3
  and K3.1 Pro are listed but cannot be started locally yet.
- **Settings from the chat.** Ask "turn on auto compact" or "what is my
  temperature?" and the model reads or changes the setting. Every change
  shows a card with old and new value, Accept and Decline, also in Bypass,
  and stays as a row with Undo. Computer control, remote access, the Local
  API, permissions, keys, paths, plugins and persona texts cannot be changed
  this way; a few switches only one way (towards the safer value). Sub-agents,
  voice and workflow steps never get these tools.
- **Remove refusals from a local model** (Model Manager, Abliteration). A
  button makes a copy of an installed GGUF that refuses fewer requests, next
  to the original, which stays untouched. LU finds the original weights,
  shows the license (Llama, Gemma and anything not on the open list need
  their note confirmed, 18+ once), plans memory, disk and time before
  anything is downloaded and says when a model is too large for the machine.
  It runs Heretic 1.4.0 (AGPL-3.0-or-later) in an environment of its own,
  quantizes the copy to the original's type and checks both with the same
  150 short prompts. Stop keeps the download and the checkpoint.
- **Storage in one place.** Settings, Storage (was Model Storage) has a
  Storage folder: models of the LU Engine, ComfyUI and voice, the gallery and
  the runtime go there. Check shows what goes where and the free space per
  drive; "Use for new files only" moves nothing, "Move the files and use it"
  moves file by file, overwrites nothing and can be cancelled. (Discord)
- **Native HiRes in Edit**, on local ComfyUI and on a Mac, as in Create.
  (Discord)
- **Your phone on this computer (Remote).** Pair a phone by QR code; the
  channel between them is sealed, over the wi-fi and, when "Reach this
  computer from anywhere" is on, over the internet. Chats can be shared with
  the phone and continued there ("Continue on phone"), a phone's turn follows
  the rights you gave that device, and Create can run on this computer for
  the phone. On Windows LU says when the firewall blocks the wi-fi way and
  allows it on a click. The phone app that uses this ships in its own
  release.
- Binary files such as ROMs reach the tools with their full path, and the
  chip says where an attached file goes. (Discord)
- Docs: which AMD cards run what, and LU on a Linux server without a screen.

### Changed

- **Ask in Code asks before every external tool.** REA and the tools of any
  other MCP server show the same card as a shell command, and No runs
  nothing. Bypass does not ask.

- **A video made in the chat plays in the chat.** It used to show as a broken
  picture called "Generated image" with only a download link. It now plays
  with controls in Chat, Agent and Code, also after the app or ComfyUI
  restarts and after the chat is opened again. (Discord)
- **Wan 2.1 clips are mp4.** Wan 2.1 used to save an animated WebP, a picture
  with no controls and no sound, while the other video models gave mp4. Every
  silent video path now saves mp4 (H.264), in the chat and in Create. Older
  WebP clips in the gallery stay moving pictures.
- **A character trained on LU Cloud says whether it can run on your machine.**
  Only a Z-Image character can be saved for local use. Other characters show
  a fixed Cloud only label instead of Use locally, and cloud training says
  under the model pick that characters trained on Flux or Qwen run in LU Cloud
  only. The 3.0.7 notes said every cloud character could run on your machine;
  that was wrong.
- **The answer starts sooner in a long chat.** The clock, memories and
  retrieved passages used to sit in the system prompt, in front of the whole
  conversation, so every new message made the engine read the entire chat
  again. They now ride behind the newest message. In our measurement the
  first step of the second message went from 10.1 s to 0.9 s on a Mac
  (Qwen3.5-9B) and from 5.7 s to 0.8 s on Windows. While the model reads, the
  status says "Reading the conversation" with its size instead of "Starting".
- **REA shows only in Agent and Code**, the two places its tools reach.
- **A half-written message waits for you.** Text and attachments in the
  message field stay when you open Create, Models or Settings and come back,
  each chat with its own, while the app runs.
- **Voice can search the web without the agent switch** (GitHub #187). Files,
  commands and the screen stay behind the agent switch.
- **The large view in Create** opens with the prompt folded, steps through the
  gallery with the arrows and the arrow keys, and zooms with the mouse wheel.
- **AMD on Windows uses AMD's current ROCm index** with the right package for
  each card (Radeon RX 7000 and 9000, PRO and Ryzen AI chips); Intel Arc cards
  get the XPU build of PyTorch. A setup that runs ComfyUI on DirectML starts
  it on DirectML instead of the processor. Force GPU and the processor notice
  send cards LU serves to Repair environment. Settings, Hardware shows what LU
  installs on this machine. (Discord)
- **Edit images are named the way the Qwen encoders label them**, so "image
  2", "IMAGE 2." and "picture 2" all reach the model the same way, and each
  tile in the reference strip shows its name and adds it to the prompt. A
  measure after a number ("2 m") is a size, not an image reference. (Discord)
- A batch in Edit keeps the image its list was made from as the reference.
  (Discord)
- **Temperature is held to 1.5.** At 1.9 every model wrote mixed-language
  noise. The sliders stop at 1.5, a value above it from an older version goes
  back to the default, from 1.2 a warning says what high values do and offers
  Reset. Agent turns hold their own ceiling of 1.0. (Discord)
- The image and video tools of the chat end honestly: a render that stopped
  or never started is not reported as delivered, Stop ends exactly that
  render, "attachment 2" or an earlier result by its name is the picture
  that is used, and a ComfyUI that crashed is called a crash with its last
  error line. An edit changes what it was asked to.

### Fixed

- **A picture attached in the chat reaches the image tool.** image_generate
  and video_generate failed with "could not read input image image.png (HTTP
  404)". The attachment now goes in by its number in the chat. (Discord)
- **The LU Engine no longer keeps a second copy of the model in memory on
  Windows.** With layers on the graphics card the whole file stayed mapped in
  RAM as well. It now starts without the mapping when layers go to the card;
  on a processor-only start and on Mac and Linux nothing changes. A model that
  is unused can be unloaded. (Discord)
- **Memories can be deleted.** The delete buttons showed only on hover, and
  some Linux desktops report no hover at all. They are always visible now;
  one, several or all memories can be deleted with a confirmation and Undo,
  and a deleted memory is not brought back by the automatic extraction. The
  same for documents. (Discord)
- **The onboarding no longer runs twice on a first start**, on Windows in
  particular.
- **PDFs in the Documents panel work on a Mac.** Every PDF failed with
  "undefined is not a function". A scanned PDF without text now says so.
- The Frames slider above the prompt for MiniMax H3 has the range of the model
  family; it drew three times too wide at 362 frames. (Discord)
- An engine that finds no graphics card says which driver is missing.
  (Discord)
- Workflows & Tags lists only models Create can pick.
- Light mode: icons in the gallery, the large view, the stage, Voice and
  elsewhere are visible again. (Discord)
- Native HiRes on Qwen-Image 2.1, Noct Q, FLUX 2 and ERNIE-Image made the
  picture four times the size with doubled faces; the pass now follows the
  model's own grid. Width and height can be typed by hand. (Discord)
- An attached picture is edited also when ComfyUI was not running yet, and a
  picture earlier in the chat no longer makes a model without eyes refuse
  every later message.
- **Wan 2.2 14B runs from Animate and Video.** LU loaded the 5B model's VAE
  for the 14B models and the run stopped with a tensor size error. With the
  high noise and the low noise model in the same folder, LU runs both one
  after the other like ComfyUI's own template. (GitHub #193)
- Character Studio finds the Z-Image base files in every folder ComfyUI uses,
  and Download base files always says what happened. It used to call files
  missing that ComfyUI already had and then do nothing. (Discord)
- A folder with just a main.py is no longer taken for ComfyUI, and Comfy
  Desktop's installs are found and start from their own environment.
- **The LU Engine starts when the Windows user name has letters outside
  English**, such as "Şaban Yılmaz". The engine stopped with "not a
  directory" for its cache folder. (GitHub #190)
- On a Mac, the image and video engines pass over a Python their packages do
  not exist for yet, such as Homebrew's 3.15, and use one that fits or LU's
  own. A broken environment from such an attempt is built again. (GitHub #188)
- The Linux AppImage's icon link points inside the AppImage instead of at the
  folder it was built in. (GitHub #191)
- On a Mac, Train new shows the trigger word field also before Z-Image Turbo
  is installed, with a button to install it, and Create says so before the
  photos are staged. Before, the field was missing and the tab looked broken.
  (GitHub #194)
- **In Code, the mode the button shows is the mode the run gets.** On the
  start screen, before a coding chat existed, the button showed Ask while the
  first run took the mode picked last anywhere, Bypass included. The pick on
  the start screen now counts, and when the two disagree the stricter one
  runs. (Discord)
- In Agent, switching a tool category off and on again no longer turns "asks"
  into "runs without asking".
- REA keeps its tools on a follow-up message, finds Node.js where a terminal
  finds it (nvm, fnm, mise, Volta and others, and the login shell on Linux)
  and looks twice when it starts with the app. A shortened procedure list
  points at the search that finds the rest. (Discord)
- A model that repeats the same plan in alternation instead of acting is
  steered once with its own words and then stopped. (Discord)

### Security

- SECURITY.md describes how to report a vulnerability, the response times and
  what has been reviewed. There has been no independent audit yet.
- Every push and every release now runs CodeQL, OpenSSF Scorecard and a
  dependency audit (npm and cargo). Each release carries a CycloneDX SBOM and
  a SHA256SUMS.txt.
- Updated dependencies with known vulnerabilities: zip, zstd, rustls,
  rustls-webpki, webpki-root-certs, tokio and others. One accepted exception: the zip
  version inside the updater, which only opens archives whose signature it
  has checked.
- A new page locallyuncensored.com/security/.

### Known limits

- We clicked through a build made like the release on one Windows machine:
  chat, web search, settings, settings from the chat, memory, light mode,
  Storage and the Remote settings. Image and video, the LU Engine with a
  GGUF file and LU Cloud were not part of that run.
- Two graphics cards: the background run and the card picks have run in
  automated tests with simulated cards. A real machine with two cards has not
  run them yet.
- AMD on Windows: the packages were resolved against AMD's real index, and
  the detection was tested with simulated cards, among them a Ryzen system
  with an RX 9070 XT. No AMD card has run it. Whether an integrated GPU counts
  as device 0 is not known.
- The memory plan was checked against llama.cpp for twelve models and in 39
  runs on Windows with an RTX 3060. Linux, a real CUDA engine and a 31B model
  on a card have not run. The Context 16K and KV q8_0 buttons have run in
  automated tests only.
- Web search: the services are free and can limit or change at any time.
  When web_fetch falls back to Exa, Exa sees the address of the page.
- The faster start was measured on one Mac and one Windows machine. Part of
  the 53 seconds one user saw on Windows was not in the engine; the app now
  logs where the first wait goes.
- Kimi K3 and K3.1 Pro do not run in the LU Engine yet; the llama.cpp version
  LU ships cannot load them.
- A character trained on Flux or Qwen in LU Cloud still runs in LU Cloud only.
- Settings from the chat ran with a 9B model on a Mac (change, Undo, a
  locked setting refused) and, reading only, in the built app on Windows. A
  small model may still word its answer oddly after a refusal. The phone app
  does not offer these tools.
- Abliteration: has run end to end from the command line on a Mac; the run
  through the built app is still open. It needs a model's original weights
  from Hugging Face, and the run takes long and needs several times the
  model's size on disk.
- Remote with a phone: pairing, shared chats, approvals on the phone and
  Create from the phone ran with the Android emulator and the iOS simulator
  against a Mac. The phone app that pairs with this is not released yet.
- Wan 2.2 14B: the graph was checked against a real ComfyUI; a real 14B
  render has not run.
- Train new on a Mac without Z-Image Turbo: checked in automated tests; a
  real training run through the built app has not run.
- A Windows user name outside English: the engine and its cache folder ran
  with such a folder on one Windows machine, not with a whole Windows account
  of that name.
- Storage: moving models, gallery and runtime to another drive and back ran
  in the built app on Windows with a small test set. Native HiRes in Edit has
  not run against a real ComfyUI edit or on a Mac yet.

## [3.0.7] - 2026-10-19

Trained characters now work in every part of Create and in chat, and a Mac can
train them too. ComfyUI workflows import in the format ComfyUI saves, with the
node packs they need, Edit takes up to ten images, and a chat can be duplicated
or branched from any message. Group chats and personas got a round of fixes.
Enhance Image runs on your own machine, character cards bring role play to the
chat, and the gallery sorts into folders. On a Mac, Create gains Talking
Character, Motion Control, Music, Enhance Image, Remove Background and masks in
Edit. Auto compact is on by default now, a persona can carry a reminder, and
Agent and Code can take apart apps and files with the REA plugin. Our check in
the real app ran on one Windows machine, and the Mac parts
ran with the real engine on one Mac. What has only run in automated tests is
listed under Known limits. LU Cloud keeps its open models: seventeen video models
and nine image models in the cloud catalogue.

### Added

- **A trained character works in every part of Create and in chat.** When Create
  runs on ComfyUI, Image, Edit and every video tab have a character chip next to
  the model chip. On Image and Edit the character's LoRA and trigger word go
  into the run, and the pick sets the Z Image model it was trained for. Edit
  with a mask does not take a character. On Video, Animate, Extend, Multishot,
  MiniMax H3, Motion Control and Talking Character, LU first makes a picture of
  the character and then starts the clip from it, shown as Step 1 of 2 and Step
  2 of 2. A start image of your own wins. A video model that only takes text, or
  a tab with no video model installed, says so before anything runs. In chat,
  the image and video tools take a character by name or trigger word. We checked
  this in the app on Windows with a stand-in character, and the clip step has
  not run with a real video model yet.
- **ComfyUI workflows import in the regular save format, and from a folder.**
  The Workflows view now takes a workflow saved with Save or Export in ComfyUI,
  not only one saved with Save (API Format). LU reads the node settings from the
  running ComfyUI, so ComfyUI has to be started for this, and the import says so
  when it is not. Reroute and Primitive nodes are resolved, notes are left out,
  bypassed nodes pass their input through and muted nodes are left out.
  Subgraphs are unpacked the way ComfyUI unpacks them when it runs a workflow,
  nested ones and ones used more than once included, so the stock ComfyUI
  templates built on subgraphs (all Z-Image templates among them) can be
  imported. A bypassed or muted subgraph passes its input through or is left out
  as a whole. Workflows with the older group nodes, nodes ComfyUI does not know,
  or settings that do not fit the installed node version are turned down with
  the reason. Choose files picks several at once and Choose folder imports every
  .json in a folder, each file with its own result. On Windows we imported stock
  templates without subgraphs in the app, one by file and several from a folder,
  and made a picture with one of them. The Z-Image Turbo template with its
  subgraph imported in the app too. Subgraphs are checked with automated tests
  on the real Z-Image Turbo and NetaYume Lumina templates, and all 205 subgraph
  templates of the template package unpack without a loose wire. A picture from
  a subgraph template has not been made against ComfyUI yet. (Discussion 124)
- **ComfyUI node packs, managed from LU.** Settings, AI Backends has a new
  section ComfyUI node packs on Windows and Linux. It lists every pack in the
  custom_nodes folder with where it came from, its branch, commit and date, and
  marks packs that are switched off. A pack installs from a link to its
  repository on github.com, gitlab.com or codeberg.org (https only): LU says
  first that a pack is code that runs inside ComfyUI, then clones it and
  installs its requirements.txt into the Python of your ComfyUI, with the log on
  screen. Update pulls the newest version and installs the requirements again; a
  pack LU pins to a tested version stays on it. Remove moves the folder to the
  trash, nothing is deleted for good. Restart ComfyUI loads the change. When an
  imported workflow uses nodes ComfyUI does not know, the Workflows view offers
  the pack for every node LU itself knows the pack of, and names the others with
  the way to the link field. A ComfyUI on another machine is not managed from
  here. On Windows we installed a pack from GitHub in the app, ComfyUI knew its
  nodes after Restart ComfyUI, and Remove put it in the Recycle Bin. Update has
  run in automated tests only. (issue 14, Discussion 72)
- **Every setting of an imported workflow can be changed in Create.** Under
  Advanced settings, a workflow from the Workflows view now shows a list
  "Workflow parameters": each node with its values, such as the VAE, CLIP skip,
  LoRA strength, denoise or any value of a custom node. Numbers keep the limits
  ComfyUI states, lists offer the choices ComfyUI has, switches and text fields
  follow the value. What LU sets on its own (prompt, seed, size, steps, CFG,
  sampler, scheduler, model) is named per node and not offered twice; the VAE
  and text encoder stay on Auto until you pick one. Changes are kept per
  workflow, go into every run, and Reset goes back to the values in the file.
  Nodes fold, and a search finds a setting by name. Built-in workflows are not
  affected. Windows and Linux; a Mac runs no ComfyUI workflows. On Windows we
  changed the denoise of an imported workflow in the app, the run used it, and
  Reset brought back the value of the file (issue 8).
- **Up to ten images in one Edit with Qwen-Image 2.1.** On your own machine the
  reference strip under the source now takes up to nine more images (three
  before), on Windows and Linux through ComfyUI and on a Mac through the
  built-in engine; the model reads ten. The tiles wrap into rows, and the hint
  names them as a range, for example "image 2 to image 10", and from four extra
  images it asks you to say what each one brings, for example "the scarf from
  image 3". With more images than fit at full size, every image is scaled
  smaller so that together they take no more memory than the full size ones
  would. That is four images, and on ComfyUI fewer on a smaller graphics card
  (see Fixed). With four, at a 1024 canvas ten images run at 640 pixels each.
  On ComfyUI the result then comes out at that smaller size too, and the hint
  says so; on a Mac the result keeps the size you set. Qwen-Image-Edit
  2509/2511 stays at three images in all, fewer on a card with less than 16 GB,
  LU Cloud at five photos, and a trained character still brings three of its
  photos. On a Mac the
  strip offers only as many images as its memory takes at the size you set, by
  the same estimate the engine refuses a run with; images already in the strip
  past that stay and are marked not sent. On a Mac, ten images at 640 pixels
  each ran with the real engine in 78 seconds. On Windows and Linux ten images
  have not run with a real model yet. (Discord)
- **Duplicate a chat, branch from a message, and keep earlier answers (issue
  174).** The chat list and its right click menu have Duplicate chat: a full
  copy that opens at once, with its persona, system prompt, group members,
  sampling values, documents and the Agent and Code settings. Every message has
  Branch from here, which starts a new chat with the history up to that message.
  Regenerate, and Save & resend on an edited message, keep the earlier answer as
  a version, and the arrows on the answer switch between them. Duplicate chat is
  not offered in Remote Access. We checked Duplicate chat, Branch from here and
  the kept answers in the app on Windows with the LU Engine.
- **Sampling values per persona and per group member (issue 175).** The persona
  editor takes its own temperature, top P, top K, min P, max tokens, repeat,
  presence and frequency penalty and DRY multiplier. An empty field follows the
  chat. The values apply wherever the persona speaks, in a chat with the persona
  switched on and on its seat in a group chat. Values set in the chat's Sampling
  popup still win. The popup lists each speaker with the values that hold for it
  and marks a value its backend does not read, and each value is only sent to a
  backend that reads it. On Windows we checked in the app that a persona's
  values reach the LU Engine.
- **A ChatGPT export becomes real chats.** Settings, General, Import from other
  chatbots takes the .zip from ChatGPT's data export, or the conversations.json
  inside it, and shows how many conversations it holds. Pick all or some, and
  each one becomes its own chat in the chat list with its title, its original
  date and the messages of the thread you saw, in order. Answers you regenerated
  or edited away stay out, and so do system prompts, reasoning and tool calls.
  Images and files are not copied; a note such as "[Image not included in the
  import: beach.jpg]" marks where they were. A conversation imported before is
  marked "Already imported" and is not added twice; one you went on with in
  ChatGPT since then is marked "Updated since last import" and refreshed. A chat
  you went on with in LU is never replaced: a newer export of it comes in as a
  second chat whose title ends in "(from export)", marked "Continued in LU,
  imports as a separate chat" in the list. Large exports are read in the
  background with progress on screen, so the window stays usable. Adding the
  conversations to the open chat's documents, the only way before, is still
  there as the second button. On Windows we imported an export built in
  ChatGPT's format in the app, with a conversation whose question was edited,
  and a second import added nothing twice. A real export from ChatGPT has not
  been tried yet.
- **A LoRA from a link.** Models, LoRAs, Get new has a field for a CivitAI model
  link (with or without a version, without one LU takes the newest) or a Hugging
  Face link to a .safetensors file. LU reads the file's name, base model (SDXL,
  FLUX, Z-Image, Wan and others) and size from the site before anything is
  downloaded, using your CivitAI key from Settings when one is set. The file
  then downloads with progress and Cancel, is checked against its SHA256 when
  the site states one, and lands in ComfyUI's models/loras folder, on a Mac in
  the LoRA folder of the app. A checkpoint, embedding, VAE or any other model
  that is not a LoRA is refused. A Hugging Face page that does not say LoRA is
  refused too when it is a full diffusers model, a finetune, merge or
  quantization of a base model, or a file above 4 GB. A base model LU does not
  know, a Hugging Face page that does not say it is a LoRA, and on a Mac a LoRA
  for a model the Mac does not run are named before the download, and the button
  then reads Download anyway. A file of the same name in the LoRA folder is
  never replaced. Only https links to civitai.com and huggingface.co are taken.
  On Windows we downloaded a Z Image LoRA from Hugging Face in the app, checked
  against its SHA256, and a CivitAI checkpoint and a Hugging Face base model
  were refused.
- **Check files and Repair for installed models.** Image and video bundles in
  Models, Get new have a Check files button once any of their files is on disk,
  and chat models of the LU Engine have one next to Use. It compares every file
  with the catalog: the size always (the catalog's exact byte count, otherwise
  the size the host states), and the SHA256 where the catalog lists one.
  Checksums are read in the background with progress and a Cancel button, so a
  20 GB file does not hold up the app. Each file reads OK, Missing, Wrong size,
  Checksum mismatch, Incomplete download or Not confirmed (on disk, but nobody
  could name its size). Repair downloads only the broken or missing files again
  through the normal download list; a file that is there but wrong goes to the
  Trash (Recycle Bin on Windows) first, nothing is deleted for good. A chat
  model's image part counts as optional. Not offered for the Mac's own MLX
  models. On Windows we ran Check files on an image bundle in the app: the file
  on disk read OK and Repair was offered for the missing ones, but Repair has
  not been clicked yet. (issue 113)
- **Train a character that changes clothes.** The Train tab of local character
  training (Windows, Linux and Mac) has a short text field under each photo. Name
  what changes from photo to photo there, like clothes, hair or place, and it
  goes into that photo's caption after the trigger word, so the trained
  character keeps its face and body but not one outfit. An empty field keeps
  the caption as it was. Describe photos fills the empty fields with the local
  chat model picked in Chat, when that model can see images; it never sends
  the photos to a cloud model. (Discord)
- **Low VRAM training for cards under 12 GB.** Local character training on
  Windows and Linux has a second setting next to the training length: Normal,
  the 12 GB recipe as before, and Low VRAM, which trains at 512 px instead of
  768 px, keeps 28 of the model's 30 blocks and the saved activations in
  system memory, and trains a smaller LoRA (rank 16 instead of 32). Each step
  takes clearly longer and fine detail comes out softer. A card with less than
  11 GB is pointed at Low VRAM in the tab and in the trainer's own check, and
  Low VRAM lets cards from about 8 GB train. That 8 GB is worked out from the
  trainer's own numbers and not yet measured on such a card. (Discord)
- **Enhance Image runs on your own machine.** On Windows and Linux, Enhance
  Image is a local tab that runs on ComfyUI and makes a picture 2x or 4x larger.
  Without an upscale model the stage offers Real-ESRGAN x4plus, a 67 MB download
  that LU checks against its checksum. The result lands in the gallery with the
  model it ran on and its real size. A Mac runs Enhance Image with a model of
  its own, see below.
- **Character cards become personas, with a greeting and an export.** Import a
  character card as a PNG or JSON file (card versions 1, 2 and 3) and it becomes
  a persona with the card picture as its tile. A new chat with that persona
  opens with the card's greeting as the first answer, and you can switch between
  alternate greetings with arrows until you write. A card persona exports back
  as a version 2 JSON file. We checked it in the app with Holo and Qwen models.
- **The gallery sorts into folders and shows how a result was made.** The
  Folders button makes, renames and removes folders, and Move to folder sits on
  each tile and in the large view. A folder is only a label: the files stay
  where they are, and removing a folder keeps its pictures. While a folder is
  open, new results land in it. Under a result, Prompt and settings lists the
  negative prompt, model, steps, CFG, sampler, seed and size, with one button
  that copies all of it.
- Create shows how many images a run makes right next to the Create button. One
  click picks 1 to 8 locally or 1 to 4 in LU Cloud; before, the number was only
  in Advanced settings.
- Remote Access can carry your own name for the browser tab on the phone (issue
  19). Set it under Settings, Voice & Remote, Remote Access, Tab name on your
  phone. Left empty, the tab keeps its name AI Terminal.
- The Model Manager can use a GGUF file from anywhere on your drive as a chat
  model on the LU Engine. On the Chat lane, press GGUF file next to Pull and
  pick the file. LU links it into the LU Engine folder without copying, so the
  file must be on the same drive as that folder (Settings, AI Backends, Model
  Storage). The image part of a vision model comes along when it sits next to
  the model.
- **Use frames of a video for a character.** The lightbox and the large view of
  a video offer Use frames for a character. LU takes 8 frames spread evenly over
  the clip, 4 to 20 with the slider. Untick the frames that do not show the
  figure, then train with the rest in Character Studio or save them as a
  character. This has run in automated tests only.
- **A trained local character can be deleted.** The Use character shelf has a
  delete button for a character trained on this machine. It asks first, and the
  file goes to the Recycle Bin or Trash.
- **A Z-Image character trained on LU Cloud can run on your machine.** Use locally on
  the cloud character shelf saves a Z Image character into the LoRA folder of
  this machine, so the local Use character shelf lists it. If a file of that
  name is already there, LU stops and says so instead of replacing it.
  Characters of other model families are refused with the reason. This has run
  in automated tests only, not yet against the real service.
- **Edit can use the photos a character was trained on.** The reference strip in
  Edit has a Trained characters row. A click adds up to three of the photos a
  local character was trained on as references, at most 1024 pixels each. A
  character trained before this version has no photos there. It has not been
  tried with a real training set yet.
- **Animate can start from a reference picture with Wan 2.1 VACE.** With a Wan
  2.1 VACE model installed, Animate uses your picture as the reference for the
  clip. Phantom, MAGREF, the VACE add-on modules, Wan 2.2 VACE Fun and reference
  files LU does not know are listed in Animate with the reason they do not run
  yet. Wan 2.1 VACE has not run with a real model yet.
- **Any file can go into the chat, and a file the model cannot read says so.**
  Attaching a file that is not text, such as a program or an archive, now says
  above the chat that models cannot read it, with its name, type and size, and
  points to Agent or Code. In Agent and Code the file goes into the working
  folder, and the model gets its name, type, size, SHA-256 checksum and path,
  with the instruction not to run it unless you ask. The limit is 256 MB per
  file, up from 64 MB.
- **A think budget for the backends that take one.** Think budget sits next to
  Think in the sampling popup and in Settings, Generation. It sets how many
  tokens a model may spend on thinking. 0 keeps the automatic choice, which on
  the LU Engine now follows the effort setting. It works with the LU Engine and with Anthropic. For Ollama, LM Studio, other
  OpenAI-compatible servers and LU Cloud the field is off and says it is not
  supported there. We checked it with the LU Engine on Windows; with Anthropic
  it has run in automated tests only.
- **Add model IDs that a server serves but does not list.** The provider card of
  an OpenAI-compatible server has a new field, Model IDs the server does not
  list, one per line (issue 112). They join that server's models in the picker
  while the server is running.
- **Several OpenAI-compatible backends at the same time.** Adding KoboldCpp
  while LM Studio or the LU Engine is on no longer pushes the other one out
  (issue 173). Each backend gets its own row in Settings, AI Backends, with its
  own name, address, optional key and model IDs, and its models appear in the
  picker under its name. A group chat can mix models from several of them. A
  backend that an earlier version pushed onto the standby card has a Run side
  by side button, and the startup dialog for detected backends can add all of
  them at once. Chats and settings from before keep their models. For a model
  of such a backend, the context window comes from that backend's own server
  (KoboldCpp, llama.cpp, LM Studio), and so do the history budget of a chat, the
  room for an attached file and the extra samplers; a server on your network
  is never cut to the send limit of a paid provider. This has run in automated
  tests and in the app on Windows with the LU Engine next to a stand-in server,
  not yet with two real servers. Settings, Local API
  still reaches only the LU Engine, Ollama and LM Studio.
- **The User-Agent of web search can be set.** Settings, Search Provider has a
  User-Agent field. Empty keeps what LU sent before. A value goes with the
  DuckDuckGo and Wikipedia searches and with every page the agent fetches. A
  value that cannot be sent is replaced by the default, and the field says so.
  Search services with a key and a local SearXNG keep their own requests.
- **The voice engine and LU's own Python can live on another drive.** Settings,
  Model Storage has a new row, Voice and Python folder. New installs of the
  voice engine, the read-aloud voices and LU's own Python go to the folder you
  choose, and what is installed keeps working where it is. Move to this folder
  copies the files, checks the copy, starts it once and only then puts the old
  files in the Recycle Bin or Trash. Nothing is deleted for good. We moved a
  real voice engine install on Windows and it started from the new folder.
  Moving LU's own Python has run in automated tests only.
- **A model too big for this machine points to LU Cloud.** In the Model Manager,
  a model that does not fit the graphics card, or the memory of a Mac, says so
  on its tile with one Try LU Cloud button, for example: Too big for this
  graphics card. Videos run on LU Cloud. A chat model leads to the cloud chat
  models, an image or video model to Create in Cloud mode on the same tab.
  Create shows a line of the same kind when the picked local model is too big,
  when a video model only partly fits the card, or when a video run on a Mac
  would take long, and that line can be closed. A number of credits stands there
  only where the app knows the price. Nothing of this shows in Cloud mode or
  with Show Cloud features in Local mode off. This has run in automated tests
  only.
- **On a Mac, Use character runs characters from the Mac's LoRA folder.**
  Character Studio's Use tab lists the characters in the Mac's LoRA folder. A
  pick brings the Z Image model the character was trained for, and Image, the
  video tabs and the chat tools take the character as they do on Windows. A
  video starts from a picture of the character made on the Mac. This is on macOS
  only.
- **On a Mac, Train new trains a character on this Mac.** Character Studio's
  Train tab trains a Z Image character from 4 to 100 photos with the Mac's image
  engine and puts it into the Mac's LoRA folder, where Use character, the
  character chip and chat find it. The first run downloads a training adapter of
  340 MB. Training is slow on a Mac: on an M5 Pro one step takes about 7
  seconds, so the Standard setting (1200 steps) runs a little over two hours.
  Use frames for a character hands its photos to the same training. It needs a
  Mac with 24 GB of memory or more; on a smaller Mac the tab says so and the run
  does not start. This is on macOS only.
- **On a Mac, Talking Character runs locally.** A portrait and a voice recording
  become a clip whose lips follow the voice, as long as the recording and up to
  10 seconds, with LTX-2.3 4-bit. It needs one more download of 11.3 GB, offered
  on the tab. It is slow: a 4 second clip took about 10 minutes on an M5 Pro,
  roughly 150 seconds per second of clip. It needs a Mac with 24 GB or more.
  This is on macOS only.
- **On a Mac, Motion Control runs locally.** A motion clip and a start image
  become a video that follows the motion, with LTX-2.3 4-bit and the IC-LoRA
  Union Control (about 650 MB, offered on the tab). LU turns the motion clip
  into edges first. A 2 second clip at 512 x 512 took 103 seconds on an M5 Pro.
  This is on macOS only.
- **On a Mac, Enhance Image runs with SeedVR2.** Once SeedVR2 3B (7.28 GB) is
  installed from the Model Manager, Enhance Image is a local tab with a choice
  of 2x or 4x, and the longest side is held to 4096 pixels. Without it the tab
  stays locked. This is on macOS only.
- **On a Mac, Remove Background runs without a download.** The tab uses the
  subject detection built into macOS, so it needs no model and no Python. A
  picture without a clear subject gets a sentence instead of an empty image.
  This is on macOS only.
- **On a Mac, Edit paints under a mask.** With Qwen-Image 2.1, Edit on a Mac
  offers Paint mask, Edit strength and Mask edge feather, and a result offers
  Edit with mask. In our run with the engine on an M5 Pro with 48 GB, a hard
  mask at full strength changed only the masked area in 189 seconds. This is on
  macOS only.
- **On a Mac, HiRes fix runs as a second pass.** With a model that edits, such
  as Qwen-Image 2.1, the finished picture goes through a second pass at the
  larger size, with the HiRes denoise and steps. The latent upscale method is
  not offered on a Mac. This is on macOS only.
- **On a Mac, video runs take LoRAs and a size, and Extend Video runs locally.**
  Where the model's entry allows it, the LTX and Wan video models take a stack
  of LoRAs and a width and height on the grid of the engine, and Wan takes 1 to
  60 steps. Extend Video is a local tab while a video model that takes a start
  image is installed, and the Shots slider reaches the LTX-2.5 packs. This is on
  macOS only.
- **On a Mac with 48 GB, an LTX clip runs up to ten seconds.** The Length slider
  ended at 113 frames, 4.7 seconds, on every model. Video, Animate and Extend
  with an LTX model now go to 241 frames, ten seconds, on a Mac with 48 GB of
  memory or more. A clip of 241 frames at 768 x 512 from a start image ran on
  an M5 Pro with 48 GB in 187 seconds and used at most 23.6 GB. A smaller Mac,
  Wan and Motion Control keep the old limit, since none of them has run that
  long. This is on macOS only.
- **On a Mac, Music runs with ACE-Step 1.5.** The Music tab in Create is a local
  tab once the music engine is installed from the Music rail of the Model
  Manager, about 10 GB. A run takes the style, the lyrics, a length from 10
  seconds to 4 minutes and the seed, and puts the track in the gallery. It needs
  a Mac with 48 GB of memory; a smaller Mac is told so before anything loads.
  This is on macOS only.
- **On a Mac, a Qwen prompt enhancer rewrites prompts for Qwen-Image 2.1.** Two
  enhancer packs of about 6 GB each, one for new pictures and one for edits,
  install from the Model Manager. With one installed, a new picture or an edit
  on Qwen-Image 2.1 can have its prompt rewritten before the run, and the edit
  enhancer also looks at the picture. This is on macOS only.
- **Reasoning effort for local models (issue 176).** The effort button next to
  Think, Low, Medium, High and Max, existed only for hosted models. Local models
  now have it in the form each server reads. The LU Engine passes the level to
  the model's chat template as `reasoning_effort`, and Low and Medium also set a
  think budget of 1024 and 4096 tokens unless you set one yourself; High sets
  none, as before. LM Studio 0.4.8 and later gets `reasoning_effort` with the
  levels it lists for each model. KoboldCpp gets `reasoning_effort` for Low,
  Medium and High, and nothing for Max, which KoboldCpp runs without a limit. A
  llama.cpp server of your own gets the level in the chat template when the
  model's template reads it. Everywhere else the button is greyed and says why.
  Until you pick a level for a local model, it keeps running the way it did
  before. Think off still means no thinking. On Windows we checked the LU Engine
  in the app: without a pick no level is sent, and Low sends low with a think
  budget of 1024 tokens. LM Studio, KoboldCpp and llama.cpp have run in
  automated tests only.
- **The wait for the first word of a chat answer can be set (issue 177).** A
  local chat stopped with "the backend accepted the request but sent nothing for
  600 s", even while the backend was still reading a very long prompt. Settings,
  General has a new section, Chat Reply Timeout, next to the image and video
  timeouts: a number of seconds up to 24 hours, or Off, which waits as long as
  the connection stays open. The default stays 600 seconds, and Stop always ends
  the wait. The wait also covers a server that holds back even its first
  headers, and a request whose wait ran out is not sent again. Progress of the
  prompt reading is not shown yet. We checked it in the app on Windows against
  a stand-in server: at 30 seconds each wait ended once, with or without
  headers, and with 600 seconds or Off the answer came through.
- **Auto compact is on by default and fits the model's window.** It used to stay
  off until you set a threshold. It is now on, and with the threshold at 0 it
  follows the model's context window: it runs from a 32K window up and starts
  earlier on smaller windows than on large ones, because the summary and the
  answer need room too. Below 32K older turns are only shortened, as before. A
  fixed point from 30 to 95 percent runs on every window, and a new Auto-compact
  switch in Settings, Generation turns it off. Long Agent and Code runs now also
  summarise their older steps in the middle of a run: the newest steps stay word
  for word, the request stays as you wrote it, and the chat says each time it
  happened. The summary keeps every file read or changed with its path, the
  commands that ran, IDs and numbers as they were written, the open tasks and
  the next step, and it sees the middle of each tool result, not only its start
  and end.
- **A persona can carry a reminder (issue 181).** The persona editor has a
  Reminder field and Messages from the end, 4 unless you set another number, up
  to 50. On every send where that persona speaks, in its chat, on its seat in a
  group chat and in Agent mode, the reminder goes into your message at that
  depth, so the model reads it close to the end of the prompt. It is only sent,
  never stored in the chat, so an edit applies to the next message. In a group
  chat each member gets the reminder of its own persona. A character card brings
  its depth prompt along as the reminder, and the export writes it back.
- **REA, a plugin for reverse engineering in Agent and Code.** Plugins has a new
  switch, REA (Reverse Engineer Anything, MIT license), off by default and only
  in the desktop app. Switched on, LU fetches the official rea-agents 6.5.0
  package, checks it against the checksum the npm registry publishes, and checks
  it again before every start. REA needs Node.js on this computer, and the row
  says so when none fits. Its tools reach Agent and Code behind the same
  confirmation as every external tool, and a turn gets only the REA tools its
  words point at, so its 207 tools do not fill the context. REA reads
  JavaScript and Electron apps, .NET, Go and Rust programs, Flutter, SQLite and
  WebAssembly by itself; Ghidra, Hopper, JADX and Frida are used where you have
  them, and LU installs none of them. It works best with a model of about 27B
  and a context window of 64K or more. Use it on software you own or are
  allowed to examine. On a Mac, Qwen 3.8 27B on Ollama took a small test app
  apart with REA and wrote a complete answer in 3 minutes 15 seconds. That run
  used LU's tool code outside the app; a start from the built app has not been
  tried yet.
- **Typed faces become emojis.** In the composer of Chat, Agent and Code, a face
  such as :) or :D turns into its emoji once you type a space, a new line or a
  punctuation mark after it, or send. It turns only as a word of its own, never
  inside a word, a link, a path or code, and one Backspace right after takes it
  back. Settings, Appearance has a switch to turn it off. The Create prompts are
  not affected.
- **The window behind the Cloud switch lists the cloud models.** Signed out, or
  with an account that cannot use them yet, the window now has one list each for
  Chat, Code and Create (Image, Video, Edit). A model opens a short window with
  the two ways to get it, a plan or a pack, and a model too big for this machine
  says so. LU keeps the pick for a week and opens that model once your account
  can use it.
- **How it works has films for this release.** The help has new short films for
  characters, Branch and Persona in a local chat, persona sampling, dictation
  and your own ComfyUI workflows on Image and Motion Control. On a Mac, the
  Image film shows the prompt enhancer, and Character with Train new, Music,
  Talking Character, Motion Control and video have films of their own.

### Changed

- **Each local video family has its own clip length.** The Frames slider ran
  from 1 to 120 for every local video model, below the default of MiniMax H3,
  LTX 2.5 and Cosmos. MiniMax H3 now goes up to 362 frames, 15 seconds at 24
  frames per second, and MiniMax H3 and LTX 2.5 move in the steps their runs
  use, so the slider shows the length you get. This has not run with a real
  video model yet.
- **A paired phone can show the name of this computer.** The signed in status of
  Remote Access now also gives the computer's name, cleaned and at most 48
  characters, so a paired phone can show it instead of the address. The open
  status without a key stays as it was.
- **Chat Tools are always on.** The Chat Tools switch under Plugins is gone.
  Plain chat now uses web search, files, images and video when a turn needs
  them, for every model that can call tools, by the same rule Agent and Code go
  by. A model that cannot call tools answers in plain chat as before and keeps
  the hints that point to Agent mode. A stored setting for the old switch, off
  included, is dropped.
- **Wan 2.1 says where its clips turn restless.** On Windows and Linux the
  Frames slider of Wan 2.1 goes to 121, but the model learned its clips at 81
  frames. Past 81 a line under the slider now says so and points to Extend
  Video.
- **A click in the window behind the Cloud switch is counted.** It is counted
  the way a press of the switch already was: that a model, a plan or a pack was
  clicked, with platform and app version, never which model. Settings, Privacy
  says so.

### Fixed

- **Motion Control and Talking Character models show under Installed.** The
  Wan 2.2 Animate Q4 card said Installed, and the Installed tab did not list the
  file. The tab only counted plain video models, so every Wan Animate, Wan VACE
  and Wan S2V file was missing there, while Create's Motion Control and Talking
  Character tabs did list them. They are listed under Video now, and the row
  says which Create tab runs them. Renaming such a file (for example to
  Wan2.1.gguf) made it show up but sent it through the plain video graph,
  which cannot run it; the original name is the right one. We checked it in
  the app on Windows with a placeholder file. (Discord)
- **Searching Get new finds models in both catalogue tabs.** A search only
  looked inside the open tab, so FramePack, filed under Unfiltered, was not
  found from Mainstream. While a search is typed it now covers both. (Discord)
- **A CivitAI hit already on disk says Installed.** A model found in the
  CivitAI search of the Model Manager offered Download even when its file was
  installed, and a click fetched it again. A hit now reads Installed, with no
  download button, when a file of the same name lies in the folder the download
  would use and, where CivitAI states a size, has that size. The same name in
  another folder or with another size still offers Download. (Discord)
- **An Edit with several images on ComfyUI fits the graphics card.** An Edit
  with more than two images could end in "aimdo memory compile error" on the
  KSampler, an error ComfyUI raises when the card has no more memory for the
  run. With Qwen-Image 2.1 the images now share a budget by the size of the
  card: two at full size on a card with less than 16 GB, three on a 16 GB card,
  and four on larger cards or when LU cannot read the size. With more images,
  each one is made smaller. Qwen-Image-Edit scales every image itself, so past
  what the card carries the run is refused before it starts, with the card's
  size and how many images to remove. The reference strip says the same before
  you press Create, and the raw error now comes with a hint about graphics
  memory. A Mac is not affected. (Discord)
- **Motion Control has a prompt field only where the run reads one.** The
  prompt field of Motion Control could not be typed into with only a picture or
  only a clip in place, and it disappeared once both were in. On ComfyUI and on
  a Mac the field now takes typing before and after the inputs are in, the
  prompt is optional, and Create does not wait for it. LU Cloud's Motion Control
  takes no prompt, so there the note above the field says no prompt is needed.
  Motion Control has no negative prompt field. (Discord)
- **A long prompt leaves the stage room for progress and the result.** The
  prompt field grew to 220 pixels in every window, so with a long prompt the
  progress of a run and the finished picture were cut off. It now grows to 220
  pixels or 16 percent of the window, whichever is less, and scrolls beyond
  that; the negative field to 120 pixels or 9 percent. (Discord)
- **The help says what the text encoder is and what Improve my prompt does.**
  The Text encoder row now says that the encoder is part of the image model and
  reads the prompt on every run, and that Improve my prompt is a separate step
  before it. With the prompt enhancer on, the switch says the same in a line
  under it. (Discord)
- **Every line of the log names the version that wrote it.** A log could show
  an older version after an update, because the day's log file still held the
  lines of the run before and only the start line named a version. Every line
  now carries the version, and so does every record in crash.log. The app also
  reads its version from one place. (Discord)
- **A picture made in the chat shows on the desktop.** A current ComfyUI
  refuses the app window's direct load of a picture from ComfyUI, so an image
  made in the chat showed as a broken frame with a link to localhost. The chat
  now fetches it through the app, as Create already did, and the same goes for
  a ComfyUI picture the model repeats in its answer. Checked with tests, not
  yet on a Windows machine with ComfyUI Desktop. (Discord)
- **Your own ComfyUI workflow runs in Motion Control.** Motion Control always
  used LU's own graph, even with a workflow picked for its model. A workflow
  imported in the Workflows window and paired with a Wan Animate model now
  runs there; LU fills in the model, prompt, seed, character picture and
  driving video and leaves everything else as saved. The import reads the
  model from a GGUF loader and the clip from Load Video or Video Helper Suite's
  Load Video, files a Wan Animate graph under that model family, and the
  Workflow picker finds it for a Motion Control model. On Video, Animate and
  Motion Control the workflow button now reads Use your own ComfyUI workflow.
  Checked with tests on QuantStack's Wan 2.2 Animate example workflow, not yet
  in a real run against ComfyUI. (Discord)
- **Read aloud speaks what the answer shows.** With a thinking model the answer
  looked clean, but the voice also pronounced reasoning markers that stood
  nowhere on the screen. The Read aloud button and the automatic reading of a
  new answer now take the same cleaned text the bubble shows. A thought that
  Gemma 4 writes into its answer goes to the thinking block and is no longer
  part of the answer, and in Voice a thought whose marker arrives in pieces is
  no longer spoken (issue 160). A model that loops and closes its thought many
  times no longer leaves the extra closing markers in the answer or in the
  voice.
- **A trained character brings the model it was trained for.** Picking a
  character under Create, Character, Use character left the image model as it
  was, and on a model of another family the run left the character out. The pick
  now sets an installed Z Image model. Where none fits, the line under the
  character says so with a button to switch, and Create does not start a run
  that would ignore the character. The same line now says to describe the key
  features in the prompt too, because the trigger word alone often does not hold
  the look (issue 161).
- **Sending while you dictate ends the recording.** Sending a message while
  dictation was on left the microphone recording, and the microphone button
  stayed locked until you stopped the answer. Send and Enter now end the
  recording first, and the microphone button stays usable while an answer runs.
  We checked it in the app on Windows.
- **Downloads and trained LoRAs go to the folders you set up for ComfyUI
  (issue 183).** LU put every model it downloaded, every LoRA it trained and
  every deleted render against the ComfyUI folder itself, even with a shared
  model folder set up in `extra_model_paths.yaml`. LU now reads that file the
  way ComfyUI does (`base_path`, `is_default`, several folders per kind), the
  folders in ComfyUI's start script (`--input-directory`, `--output-directory`,
  `--extra-model-paths-config`) and the setup of ComfyUI Desktop. A model goes
  into the folder marked `is_default`, else the first folder you set for that
  kind, else the ComfyUI folder as before. A ComfyUI that LU starts gets the
  flags of your start script too. Models already in the ComfyUI folder still
  count as installed. Settings, ComfyUI lists the folder LU uses for each kind
  of model and for input and output. A missing or broken file changes nothing.
  We checked it in the app on Windows with a shared folder and a stand-in
  ComfyUI: a download landed in the shared folder and Settings named it.
- **Create sees model files you copied in by hand.** Create read the ComfyUI
  model and LoRA lists only when it opened, so a file copied into a ComfyUI
  folder by hand stayed invisible until you left Create. Coming back to the app
  now reads both lists again, at most every 30 seconds and not while a run is
  going.
- **The mask editor shows Ctrl shortcuts on Windows and Linux.** Undo and Redo
  were labelled with the keys of a Mac. They now read Ctrl+Z and Ctrl+Y.
- **Smaller fixes in Create.** A wide result fits the stage with its prompt
  below it. Cloud mode no longer shows the load error of the local models. A
  tooltip no longer opens when the focus comes back to its button. Rewritten by
  names the chat model the way the picker does. The first image of a list keeps
  its file name. A second Enhance of the same picture no longer says Queued to
  the end when ComfyUI takes it from its cache. Erase and Edit show the mask
  state as it is, and the mask editor no longer points Erase to a prompt field
  it does not have. The model chip of Character says to pick a character first.
  In the lip sync tool, the voice maker row stays inside its panel when you
  describe a voice. Motion Control with a workflow of your own no longer shows
  steps, size and length sliders the run does not read, and its Workflow
  parameters list lets you change the steps, CFG, sampler, scheduler and
  prompts it really runs with. A local training with too few photos names the
  local limit of 100 photos, not the cloud's 30. Motion Control and Talking
  Character no longer take a negative prompt typed on another tab, since they
  have no field for it, and no longer offer a LoRA stack their graphs do not
  read. A workflow of your own run from Motion Control saves its clip where
  the gallery finds it, not in ComfyUI's temp folder. The how-to line at the
  foot of the stage no longer makes a narrow stage with a source picture scroll.
- **Smaller fixes in Chat.** A second message sent right after a fast answer
  goes out instead of staying in the field without a word. An open, empty chat
  that is the only one no longer says No chats yet.
- **Character Studio names only the base files that are missing.** It said about
  19 GB above the button whatever was missing. It now names the missing files
  with their size, downloads only those, and counts the progress over them
  alone.
- **Create honours the image and video timeouts from Settings.** A run that
  shows no progress is stopped after the minutes set in Settings, General;
  before, it always waited 20 minutes for images and 60 for video. Before it
  stops a run, LU now asks ComfyUI whether the run is still going, so a long
  step that reports nothing, such as the decode at the end, is not cut off, and
  the message says 1 minute instead of 1 minutes. The defaults are unchanged. We
  checked it in the app on Windows with the limit at 1 minute.
- **Editing an earlier message no longer sends it or deletes the rest (issue
  172).** The check mark of an edit resent the message at once and deleted every
  later message for good, also with no model loaded. The edit field now has
  Cancel, Save and Save & resend. Save changes the text only and keeps every
  later turn. Enter saves, and Ctrl or Cmd with Enter resends. Save & resend
  keeps the old answers as a version. We checked Save, Enter and Save & resend
  in the app on Windows with the LU Engine.
- **The persona picked in Plugins is the one that is sent (issue 170).** A chat
  kept a copy of the persona that was active when it was made, while the Plugins
  menu showed and changed only the pick for new chats. The menu said one persona
  and the request carried another. A chat now remembers its persona, a pick in
  Plugins changes the open chat, and chat, group chat, Agent and Voice all send
  what the menu shows. Older chats keep their saved prompt. We checked it in
  the app on Windows with the LU Engine.
- **Group chats keep track of who is in them and who spoke (issue 165, issue
  169).** A member whose model is no longer in the model list stayed in the
  group unseen, kept its turn, and its request was answered by whatever model
  was loaded. It now sits out until its model is listed again, and the group
  menu shows it as unavailable with a remove button. A server that lists the
  same model twice, such as KoboldCpp in Ollama mode, gives one row. A turn now
  carries the persona it was written as, so after a persona moves to another
  model its older turns still count as its own. On Windows we checked in the
  app that a member whose server stopped sits out once LU has read the model
  list again; until then it keeps its turn and shows that server's error under
  its own name, and no other model answers for it.
- **A former group chat keeps who said what with group chat off (issue 180).**
  With group chat off, a chat that holds group turns now sends the other
  speakers' turns tagged with their names, as the group does, and tells the
  model what the tags mean. New turns there record who wrote them, the chat's
  persona or the model, so switching group chat back on hands them to no one
  else. Switching group chat off and on keeps every persona tag.
- **Two turns of one role in a row are merged on every request.** The chat
  templates of Mistral and Devstral refuse two user or two assistant turns in a
  row. LU merged such turns only on a request without tools, and most requests
  carry tools now. Two plain turns of one role are now merged on every request,
  in order and with their speaker tags; tool calls and their results keep their
  own pairs.
- **An attached text file fits the model's context (issue 171).** A text file
  was cut to its first 4000 characters when it was attached, without a word. The
  chat now keeps the whole text, up to about a million characters, and at send
  time gives the model the whole file when it fits next to the conversation,
  otherwise as much of its start as fits. The model is told how much it got, and
  you see a line above the chat and a mark on the file. A new setting, Attached
  file limit, caps the share in tokens. A group chat export now names the
  persona and model of every answer instead of Assistant. On Windows a
  Japanese text file of about 30,000 characters went to the LU Engine whole in
  the app; a file too long for the window has run in automated tests only.
- **A chat compacted more than once keeps one summary.** Every compaction added
  its own summary, and each message sent the whole chain of them. A new
  compaction now merges the earlier summary and the turns since then into one
  current state, and only that state goes out with the next message (issue 151).
  What the merge drops from the old state, such as your requests, open tasks,
  paths and numbers, is put back. The number of recent messages kept word for
  word now follows the model's context, between 4 and 20, and stays 6 where the
  context is unknown. Chats saved before keep sending their chain.
- **Numbers, hex and Base64 are counted at their real token cost.** LU counted a
  digit at a quarter of a token. Most local models give every digit a token of
  its own, so a chat with a long numeric log, hex or Base64 could send more than
  the model's window holds, and the LU Engine refused it with "exceeds the
  available context size". Digits and such encoded text are now counted at their
  real cost, text without digits as before, and Japanese text with many numbers
  a little higher than before. When the engine still refuses a message as too
  long, plain chat shortens the history it sends once and tries again instead of
  only showing the error; the chat itself keeps every message. Where auto
  compact is on, it now writes its summary before older turns are cut to fit the
  window, also in chats the model counts with few tokens. This has run in
  automated tests against token counts from the Qwen 2.5 and Gemma 3 tokenizers,
  not yet in the app.
- **Smaller fixes in Code and Loop.** The tooltip of Accept without asking says
  what the click changes. The plan card wraps its row instead of its words in a
  narrow Explorer. The countdown of a loop never shows more than the pause.
- **GPU layers -1 lets the LU Engine fit the layers itself.** On AMD and Intel
  cards on Windows and Linux, LU only knows the total memory of the card and
  guessed the number of layers from it, so -1 could run as slowly as the
  processor (issue 156). With -1 the LU Engine now fits the layers against the
  free memory it measures itself. On an NVIDIA card through the same Vulkan
  engine, -1 put every layer on the card. We have no AMD or Intel card to check
  it on.
- **Unreadable answers on older graphics cards first lose Flash Attention, not
  the card.** When the LU Engine answers in garbage, LU restarts it. For cards
  without matrix cores (for example AMD RX 5000 and 6000 on Linux, GTX 10
  series) the first step is to turn Flash Attention off and keep the card. The
  engine never says whether a card has matrix cores, so this step was never
  taken on Windows and Linux and every such card went straight to the
  processor. LU now tries Flash Attention off first and moves to the processor
  only when that does not help (issue 156). We checked the restart order with
  tests, not on a card that produces garbage.
- **ComfyUI starts when no Python on your machine has PyTorch.** With Python
  3.15 as the only or the default Python, ComfyUI did not start, and Install,
  Repair environment and Update asked for another Python. Install and Repair
  environment now build ComfyUI's environment from a Python that PyTorch
  supports, and when there is none, from LU's own Python 3.12, which needs no
  administrator rights. A ComfyUI without its own environment starts on the
  Python that holds its PyTorch, and the character trainer takes the same way.
  We checked this on a Windows machine whose only Python was 3.15.
- **A render no longer starts LM Studio.** Before a picture or a clip, LU asks
  LM Studio to unload its models to free graphics memory. With LM Studio closed,
  that call started LM Studio in the background. LU now checks first whether LM
  Studio is running and skips the call when it is not.
- **A chat model with image input no longer warns at every render.** Before a
  render, LU saves where the chat model stands in the conversation, so the next
  answer starts faster. The LU Engine cannot do that for a model loaded with its
  image part, so every render tried, failed and warned. LU now skips it for such
  a model.
- **Importing a model follows the LU Engine folder you set.** With an LU Engine
  folder set under Model Storage, an import now links the model into that
  folder, and the error for a link across drives names that setting and a copy
  into the folder as the two ways out. A model imported into LU's own folder
  earlier still shows as imported.
- **Voice and dictation may use the microphone on Linux.** The Linux web view
  refused every request for the microphone, so Voice failed at once (issue 162).
  LU now lets its own page use the microphone. A camera, a screen share and any
  other page are still refused. On Linux, the message after a refused
  microphone now points to the sound settings instead of a privacy switch Linux
  does not have. We checked it in a Linux web view with a simulated microphone:
  without the change the request was refused with the error from the report,
  with it the sound arrived, and another page was still refused. We have not
  tried it on a Linux desktop with a real microphone.
- **Remote Access texts point to the right buttons.** After the 15 second tunnel
  timeout, the text now says to click Stop and start again with Dispatch,
  Internet, because Restart starts the server without a tunnel. A refused
  permission on the phone points to Settings, Voice & Remote, Remote Access,
  Permissions in the desktop app, and the help says what Dispatch does.
- **Settings, Privacy names the real data folders on Windows and Linux.** On
  Windows the data folder is `%LOCALAPPDATA%\lu-labs`. The chat backup and the
  chat models of the LU Engine sit under `%APPDATA%\Locally Uncensored`, and
  Privacy now names both instead of saying that LU writes nothing else. Linux
  gets its own folders named the same way.
- **A download that already held the whole file no longer fails on every
  Retry.** When the partial file was already complete (the app ended right after
  the last byte, or moving the finished file into place failed), every Retry
  failed with HTTP 416. The partial now goes to the Trash or Recycle Bin and the
  file downloads again from the start. A shared text encoder or VAE in this
  state used to put Retry on every bundle that needs it (issue 113).
- **A switch between Cloud and Local clears the red message of the other mode.**
  Before, a message such as Use locally failed stayed on screen after the switch
  to Local. We checked it in the app on Windows.
- **A model whose server names no context length is no longer held at 4K.**
  KoboldCpp behind its Ollama API sends no context length, so LU took 4096 as
  the model's maximum: the context picker offered only 4K, and the history of a
  long chat was cut to fit 4K while a much larger window from Settings went out
  with each message. LU now also asks KoboldCpp itself and the list of loaded
  models. When nobody names a length, the picker offers every size, says that
  LU cannot check them, and shows the value set in Settings. In plain chat, a
  group round and Compare, the history is now trimmed and compacted to the
  window that is sent to Ollama, not to the model's maximum (issue 166). We
  tested this with recorded server answers, not yet against a running KoboldCpp.
- **LM Studio keeps the context size you picked for a model.** A size picked in
  the context picker is now saved for that model and used whenever LU loads it,
  also after you switch to another model and back, and it no longer changes the
  Ollama context window. A size picked before this update needs to be picked
  once more. Making another model the main model no longer unloads a model that
  still speaks in the group chat on screen; outside a group chat, the previous
  local model is unloaded as before (issue 168). We tested this with a stand in
  for LM Studio, not yet with LM Studio itself.
- **Japanese, Chinese and Korean text is counted closer to its real token
  cost.** LU estimated every text at four characters per token. Japanese takes
  about 1.4 characters per token on Gemma, so a long Japanese chat sent about
  2.8 times more tokens than its budget (41K to 43K real tokens for a 16K
  budget), and the trim and auto compact only started after the server had
  already run over. The estimate now counts by script: plain English text
  exactly as before, Japanese, Chinese and Korean at 1.25 characters per
  token, other scripts, emoji and symbols higher. It lands a little above the real count on
  purpose. The same estimate now also sizes the reply limit sent to OpenAI
  compatible servers, the memory block and the cut of long tool results. In a
  group chat the context counter no longer switches between speakers without a
  word: it names the speaker it counts for, the one answering or the one who
  opens the next round, and shows that speaker's own prompt over its own window
  (issue 167). LU does not ask the server to count tokens yet. On Windows a
  long Japanese text file on the LU Engine was estimated at 22,486 tokens in the
  app, where the engine reported 22,383; the old rule would have said 7,724.
- **Reset and ask again shows while a permission is missing.** In the computer
  control permissions on a Mac, the link appeared only after Open System
  Settings was clicked in the same view. It now shows whenever a permission is
  missing, and the hint names the case it is for: an entry left by an older test
  copy of LU. This is on macOS only.
- **On a Mac, switching from Cloud to Local keeps Talking Character and
  Character Studio open.** It jumped to Video or Image instead. Talking
  Character stays while a model that talks is installed. This is on macOS only.
- **On a Mac, the large LTX models render at the size Create shows.** They ran
  at 512 x 512 whatever was asked, so a landscape clip came out square. They now
  take the size on the grid their engine keeps. This is on macOS only.
- **On a Mac, an edit with many pictures no longer fills the memory.** Each
  picture of a Qwen-Image 2.1 edit takes memory of its own, and ten pictures at
  full size left a 48 GB Mac a third free before the first step. Edit now offers
  as many reference slots as the Mac's memory takes, and a run past that is
  refused with the number that fits. This is on macOS only.
- **On a Mac, Music no longer fills the memory while it decodes.** A 30 second
  track left 1.4 GB of a 48 GB Mac free; it now leaves over 9 GB and decodes
  faster. This is on macOS only.
- **On a Mac, Enhance refuses a result larger than the memory takes.** At 4x a
  1024 picture needs about 22 GB; a smaller Mac is told to pick 2x or a smaller
  picture instead of freezing. This is on macOS only.
- **On a Mac, Extend Video shows the Mac's video settings.** It showed the
  ComfyUI graph's steps, sizes and frames, and a Negative switch a distilled LTX
  does not read. This is on macOS only.
- **The settings of a music track name its seed.** Prompt and settings named
  only the model.

- **Picking the outer folder of a ComfyUI portable build works.** The Windows
  portable builds, the Intel and AMD ones too, unpack as one folder that holds
  ComfyUI and python_embeded. Picking that outer folder said "main.py not
  found", and the search on the disk only found folders named ComfyUI. LU now
  takes the ComfyUI folder inside, whatever the outer one is called, and keeps
  using the python_embeded beside it. We checked this in automated tests with
  test folders; a real portable install on Windows has not been picked yet.
  (Discord)

- **Auto runs ComfyUI on an Intel Arc card.** On a machine without an NVIDIA
  card, Auto asks the PyTorch in the ComfyUI environment whether it has a
  usable GPU, and it only asked about CUDA. A PyTorch built for Intel XPU
  answered no, so ComfyUI started with --cpu on a working Arc card. LU now asks
  about XPU too. With Force GPU, the warning about a PyTorch without a GPU is
  no longer shown when XPU is there, and it says how an Arc card gets the XPU
  build. We checked this in automated tests without an Intel card. (Discord)

- **A change of the ComfyUI GPU mode says that ComfyUI has to restart.** In
  Settings, Hardware, switching ComfyUI GPU to Force GPU with the vendor left
  on Auto showed nothing, and the running ComfyUI kept the mode it was started
  with. Every change of the mode now says that ComfyUI only reads it at start,
  with a Restart ComfyUI button. The Device line ComfyUI prints at start, such
  as Device: xpu:0 or Device: cpu, now stands under Status in AI Backends,
  ComfyUI (Image & Video), so you can see what it runs on. We checked this in
  automated tests without an AMD or Intel card. (Discord)

### Security

- **ComfyUI and LM Studio, when LU starts them, answer to LU only.** Other pages
  open in your browser can no longer read them.
- **The LU Engine runs models for LU only.** Each time LU starts the engine, it
  gets a key that only this run of LU holds, and LU's own features send it.
  Other pages open in your browser can no longer run its model or read what it
  is doing.
- **A web page the agent reads reaches the model as page content.** Text from a
  fetched page now goes to the model marked as data from that page, not as
  instructions to follow.

### Known limits

- Our check in the real app ran on one Windows machine with an NVIDIA card. For
  characters it used a stand-in LoRA, so how well a real character keeps its
  face has not been checked, and step 2 of a character video has not run with a
  real video model.
- In the app on Windows we checked the workflow import, Workflow parameters,
  node packs, a LoRA from a link, the ChatGPT import, the timeouts, images per
  run, the tab name for the phone and a GGUF file from the drive. One template
  with a subgraph imported there. A picture from a subgraph template, Update of
  a node pack, a real ChatGPT export and Edit with ten images on Windows and
  Linux have run in automated tests only.
- A second run in the app on Windows checked Duplicate chat, Branch from here,
  the kept answers, Save and Save & resend of an edit, the persona fix from
  Plugins, sampling values per persona, a long Japanese text file and its token
  count with the LU Engine (issues 167 and 170 to 175). Two backends side by
  side and a group member that sits out were checked with the LU Engine and a
  stand-in server, not with two real servers (issues 165 and 173). Check files
  ran on one image bundle; Repair has not been clicked. Issue 169, a text file
  too long for the window, the per photo text and Low VRAM for training, and the
  name of this computer for a paired phone have run in automated tests only.
  Low VRAM has not been measured on a card with 8 GB.
- Use frames for a character, the Trained characters row in Edit with a real
  training set, and Use locally against LU Cloud have run in automated tests
  only.
- The clip lengths per video family and Wan 2.1 VACE in Animate have not run
  with a real video model. Phantom, MAGREF and Wan 2.2 VACE Fun are listed in
  Animate but do not run yet.
- The think budget ran against a real LU Engine on Windows; with Anthropic it
  has run in automated tests only. Moving the voice engine to another folder ran
  on Windows with a real install; moving LU's own Python has run in automated
  tests only.
- The microphone fix for Linux was built for Linux and has not been tried on a
  real machine. GPU layers -1 on AMD and Intel cards has not been checked on
  such a card.
- Character cards were checked with Holo and Qwen models, not with Gemma.
- Reasoning effort for local models (issue 176) ran in the app on Windows with
  the LU Engine, and the Chat Reply Timeout (issue 177) with a stand-in server.
  Neither has run against a real LM Studio, KoboldCpp or llama.cpp server. The
  effort level is one setting for all models, not one per model, and there is
  no separate None level; Think off is that.
- A second compaction right after a few short turns now ends before it asks the
  model. That has run in automated tests only. Auto compact by default and the
  summary in the middle of Agent and Code runs have run in automated tests and
  in a test against a local model, not yet in a long session in the app.
- The persona reminder (issue 181), the former group chat with group chat off
  (issue 180), the merged turns for Mistral and Devstral, Chat Tools always on,
  typed faces as emojis, the model lists behind the Cloud switch and Installed
  on a CivitAI hit have run in automated tests only.
- REA has run on a Mac with LU's tool code outside the app, with Qwen 3.8 27B
  and Qwen 3.5 9B on Ollama. Only the 27B model wrote a complete answer. A start
  from the built app, Windows and Linux, and cloud models have not been tried.
- The image budget by graphics card for an Edit on ComfyUI has run in automated
  tests only, not on a card with less than 16 GB. So have the Motion Control
  prompt field and the prompt field that leaves the stage room.
- Local characters use the Z Image family. Training on a Mac has run with 10
  photos and 100 steps on one Mac with 48 GB; the Standard and Thorough
  settings, Macs with less memory and stopping a training in the middle have
  not.
- A local Enhance result in the gallery can list steps and CFG that the enhance
  run did not use.
- The LU Cloud line on a model too big for this machine, in the Model Manager
  and in Create, has run in automated tests only. Create has no time estimate
  for a video run on a PC, so there the line follows the card verdict and names
  no time.
- The Mac parts of this release have run in automated tests and have not been
  clicked through in a built app yet. Mask edit, HiRes fix, Remove Background,
  Enhance Image, an image with a LoRA, both Qwen prompt enhancers, LTX-2.3 video
  at a chosen size, Extend Video, Music, training a character, Talking
  Character, Motion Control and an edit with ten pictures ran with the real
  engine on one Mac with 48 GB. The large LTX models (64 GB and more) have not
  run on a real Mac, nor has anything on a Mac with less than 48 GB. Video LoRAs
  and multishot have not run with real models on a Mac, and the downloads that
  Talking Character and Motion Control offer on their tabs have run in automated
  tests only. Ten seconds of LTX ran on one Mac with 48 GB, from a start image.
- Music on a Mac needs 48 GB of memory. A run used about 28 GB while it
  decoded, more than the 16 GB the catalogue named before.

## [3.0.6] - 2026-10-11

You can talk to LU and hear it answer, and a model can use the mouse and
keyboard in apps you approve. Local models with image input download with their
image part, a chat on LU Cloud can order images and clips, dialogs have a new
look, a running task says what it is doing, and LU Cloud lists ten more chat
models. Voice, computer control, Create in chat and the ten new models are in
beta. The app marks each of them with the word Beta, and hovering the mark says
what that means. The limits we know are listed below. Our check of Voice and
computer control in the real app ran on Windows. On a Mac, Voice has been tried
by hand in the app, and computer control is in the app but not fully tested
yet.

### Added

- **Voice (Beta): talk to LU and hear it answer.** Voice is a new surface in
  the main navigation. Speech recognition, the voice and the turn taking run on
  your own machine, and the model that answers is the chat model you picked.
  The first time, LU shows what it downloads and where it goes, then installs
  its own voice engine with one click. You can interrupt an answer by speaking,
  and the session is saved as a normal conversation. It is English only for
  now. Voice is in beta: it is new, and your computer may still show rough
  edges. Our check in the real app ran on Windows, and on a Mac Voice has been
  tried by hand in the app. The word Beta stands next to the title.
- **Fifteen voices to choose from.** Pick a voice in the setup or later in the
  Voice settings: Alba, Anna, Azelma, Charles, Eponine, Eve, Fantine, George,
  Jane, Javert, Marius, Mary, Michael, Paul or Vera. Changing it fetches one
  small file and installs nothing else again. Listen plays a short sentence in
  the chosen voice once the voice engine is installed.
- **Four switches sit next to the title.** Voice settings, Agent, Where it may
  work and Thinking. You can move all of them while a session runs, and the
  session follows at once. With Agent off, the session is a conversation
  without tools.
- **You decide how far the tools reach.** Workspace only is the default: files
  stay inside the folder of the session, LU asks before every command, and
  there is no screen. Whole computer opens files by any path your user account
  can open, commands in any folder and the screen. LU asks once before that
  level is used for the first time, and your system asks once more each time LU
  was started. A session that is starting waits for that answer and says so.
  System folders and the folders that hold keys and passwords stay closed at
  both levels.
- **The model can use tools, and a tool that needs your approval waits for your
  click.** With Agent on, a voice session has the tools of the agent chat with
  the same permissions. A tool call looks the way it does in the chat, and the
  same approval bar asks in plain words, for example "Voice wants to change a
  file." You answer it with a click on Approve or Reject. A spoken yes or no
  answers the questions of computer control only, and it is not a line of the
  conversation. Local models get a shorter tool list (web, files, shell and the
  screen), so the first answer comes quickly.
- **Thinking is a switch, and a thought is never read aloud.** Thinking is off
  by default. Switched on, the thought appears in the transcript as the folded
  Thinking block you know from the chat. Thinking length in the Voice settings
  limits a thought to between 128 and 4096 tokens, 512 by default. When a
  thought runs longer, LU ends it and asks the model again for a direct answer.
- **A light switch unloads Voice.** While the voice engine is in memory, a
  switch next to the title shows how much memory it holds. LU measures that
  number, and on our Windows test machine it was about 1 GB. One click ends the
  session and stops the engine, and if the voice session loaded the chat model,
  that model is unloaded too. Without the click, the engine shuts down five
  minutes after the last session.
- **A short chord says that a session is listening.** It is quiet and lasts
  about a second. You can switch it off in the Voice settings.
- **Voice hears you while it starts.** What you say after the Start click, also
  while the speech models are still loading, is kept for up to a minute and
  answered once the session is up.
- **Dictation in the chat works when only Voice is installed.** The microphone
  button in the chat uses the speech recognition of the voice engine if no
  separate speech-to-text install exists.
- **One line of advice for small models.** If the chat model takes no tools or
  is smaller than 7B, the empty Voice surface recommends a local model that
  fits.
- **A session that ends without the Stop button says why.** Leaving the Voice
  surface, a repair and an uninstall each end the session with one sentence and
  a Start again button.
- **Only a serious error ends a voice session.** If the voice engine reports an
  error it cannot recover from, the session ends and says why. Any other error
  goes to the log, and where you would miss something, for example a sentence
  that could not be spoken, one line under the status says so until you speak
  again.
- **Computer control (Beta): a model works in the apps you approve. Off by
  default.** Computer control is in beta: it is new and not proven in every app
  yet, so watch what it does and stop it when it goes wrong. It stays off until
  you switch it on under Settings, Agent, Agent Permissions, Computer control.
  In every new chat LU asks once whether it may use computer control there,
  before it looks at the screen or acts. It also asks before it touches an app
  for the first time and, by default, before every action. Autonomous, for one
  session, asks only before sending, buying, deleting or changing permissions.
  Terminals, password managers, system sign-in and permission dialogs, security
  settings, the Run dialog and windows with administrator rights are always off
  limits, and LU never types into a password field. Ctrl+Alt+Space pauses and
  Ctrl+Alt+Esc stops, from anywhere. Our check in the real app ran on Windows.
  On a Mac it is in the app but not fully tested yet.
- **Every chat asks once before computer control starts.** The first time a
  chat wants the screen, a card in the conversation asks "Allow computer
  control in this chat?" with Allow and Deny. Until you click, LU takes no
  screenshot and does nothing. The yes holds for that one chat. A new chat asks
  again, and so does every chat after the app was restarted. No setting and no
  autonomous session skips the card. In a voice session LU says aloud that it
  waits for your click. A spoken yes does not allow it, and a spoken no or stop
  declines.
- **LU gets out of the way while it works.** On Windows the LU window shrinks
  to a small window in the top right corner of the screen LU works on, and
  comes back at its old size and place when the work is over. The small window
  shows what LU is doing and names the two shortcuts. The edge of that screen
  glows softly in purple for as long as LU works there. On Linux the window
  stays as it is and a bar at the top says "LU is controlling this computer".
- **Questions stand above the input field.** A question about an app or an
  action stands directly above the input field in the chat, and above the
  session controls in Voice. While the LU window is small, the question appears
  there with a Stop button. You answer it with the mouse. It does not take the
  keyboard, so the app LU works in keeps the focus.
- **A sensitive action always needs your click.** Anything that sends, buys,
  deletes or changes permissions is asked with the reason in red, in a
  supervised session as in an autonomous one. The same goes for a click whose
  target LU cannot name, for a button, link or menu item without a name, and
  on Windows and Linux for Alt with a letter, which presses a button or opens a
  menu from anywhere in a window. A spoken yes never confirms such an action,
  because speech recognition can mishear and the microphone hears the whole
  room.
- **A hand on the mouse pauses LU.** In an autonomous session LU pauses when
  you move the mouse. The paused view shows what LU did so far and asks whether
  you take over or let it continue, and you can add an instruction for the rest
  of the task. After Let it continue, LU brings the window it works in back to
  the front and looks at the screen again before it acts. Ctrl+Alt+Esc still
  stops at once, also during a pause.
- **Ask for something on the screen by voice.** With Where it may work set to
  Whole computer, a voice session can carry out a task on the screen and tell
  you the result. LU asks its questions aloud, and yes or no answers an
  ordinary action. Say stop or wait and the task pauses. Only the word alone
  does that: "Wait, what is two plus two?" is a question for the model. In our
  test on Windows, typing a note in Notepad by voice took 11 to 22 seconds from
  the end of the command to the spoken result, with a local 9B model that works
  from the list of buttons and fields.
- **Screen tasks follow what the chat model can see.** The model that looks at
  the screen is the chat model by default, and LU does not ask how it should
  run. A model that can see images gets the screenshots, and on Windows the
  list of buttons and fields of the window next to them. A model that cannot
  see images works on Windows from that list alone, without a picture. A local
  model sees images while it is loaded with its image part. You can choose
  another local model or a cloud model with image input instead.
- **Holo 3.1 9B is in the model catalog as a screen model, marked Beta.** It is
  recommended from 16 GB of video memory. In our test on Windows it finished a
  simple typing task in 1 of 3 runs.
- **Screenshots appear on the step they belong to.** Each look at the screen is
  a small picture on the block of its tool call, and a click opens it large
  over the whole window. The pictures are kept in memory only, at most 24, and
  are not written to the conversation. If a password field had the focus, the
  block says so and shows no picture.
- **A screen task has a limit.** It ends after at most 25 steps or 8 minutes,
  and the time you take to answer a question counts. A task that ran out of
  time says so.
- **Local models with image input download with their image part.** A local
  chat model of the LU Engine takes pictures only when a second file, its image
  part, lies next to the model. LU now fetches both as one download on the
  Models page, in onboarding and for a model you find through the hub search,
  with one progress bar and a checksum for each file. The two download dialogs
  have a ticked box, Include image input, with the size it adds. For a model
  you already have, Add image input fetches the missing file: on the model's
  row under Models and at the top of a chat once a picture is attached. The
  catalog lists 42 image parts, each with its exact size and checksum. If the
  graphics memory has no room for the part next to the model, the model loads
  without it and LU says so.
- **Create in chat (Beta): ask for an image or a clip in a Cloud chat.** In
  Cloud mode the Plugins menu has a Create switch. With it on, the chat model
  puts together an order from what you ask for, the order appears as a card,
  and nothing runs until you approve it. It is in beta, so read the order
  before you start it, and the switch appears once your account has it.
- **Ten more chat models on LU Cloud, marked Uncensored (Beta).** The Cloud
  model picker opens with a new group of ten models whose makers release them
  to answer without refusing, among them Gemma 4 Uncensored, GLM 4.7 Flash
  Heretic, Aion 3.5 and Abliterated Large V2. A model shows up once the cloud
  catalogue lists it.
- **Five of the new models say Limited capacity.** The Cloud model picker
  writes Limited capacity in grey after their names. At busy times such a
  model can ask you to wait a moment.
- **A build for Macs with Apple Silicon (Beta).** This release is prepared for
  a Mac build: Apple Silicon, macOS 14 or newer, no Intel Macs. The `.dmg` is
  attached to the release only after the Mac build has passed its own checks,
  so it can arrive later than the Windows and Linux installers. If the release
  page lists no `.dmg`, there is no Mac build yet. On a Mac, chat runs on local
  models through the bundled server with Metal, and Create makes images and
  video on the Mac itself, without ComfyUI. On an M5 Pro with 48 GB,
  DreamShaper XL Turbo made an image in 33 seconds and Qwen-Image 2.1 Turbo in
  38, and LTX-2.3 Distilled 4-bit made a clip of two seconds at 768x512 with
  sound in 64 seconds. The Mac build is in beta: the app has run on that one
  Mac only.
- **The Linux packages carry the voice engine.** The AppImage, the deb and the
  rpm for x86_64 include the files Voice needs. We built all three in an
  emulated x86_64 environment and checked what is inside and that no library is
  missing. We have not started the packaged app on a real x86_64 Linux machine,
  and Voice and computer control have not been run in the app on Linux.

- **Every result in Create shows the prompt it was made from.** Under a picture
  or a clip on the stage there is a Prompt box, and a click on the picture
  opens the large view with the prompt and a Copy button. It works for results
  made on your own machine and on LU Cloud, and for pictures ordered from a
  chat. A tool that takes no prompt, such as background removal, shows none.
- **Download a trained cloud character.** In Cloud mode, the character list
  under Create, Character, "Use character" has a download button next to each
  character. It asks where to save and writes the character as a .safetensors
  file. While the file comes in, a Cancel button next to the download stops it
  and removes the unfinished file. We have tested the download and the cancel
  against a stand-in for the service and not yet against the real one.
- **An Ollama model that runs partly on the processor says so.** A context
  window that is too large for the graphics memory does not fail on Ollama.
  Part of the model moves to the processor, and every answer gets slower with
  nothing on screen to say why. After a load LU now asks Ollama how much of the
  model sits in graphics memory. It shows the answer in the list where you pick
  the context window and, in short, on the model's row in the model picker,
  with the numbers in the tooltip. LU shows what Ollama measured after the load
  and predicts nothing before it.
- **On a Mac, a long local video run is announced and shows its steps.** Where
  we timed a model on a real run, Create says before the start how long a clip
  of the chosen length takes, once that is ten minutes or more, for example
  "about 38 minutes on an M5 Pro with 48 GB, and longer on a smaller Mac". Two
  models carry such a time, Wan 2.1 T2V 1.3B and LTX-2.3 4-bit. During the run
  the line under the bar names the step and the time left, for example "Step
  36/50, about 11 min left", and the bar follows the steps. A run that reports
  its steps is no longer cut off after sixty minutes. It goes on while a new
  step arrives within twenty minutes, for up to four hours. This is on macOS
  only.
- **Choose your microphone in the settings (discussion 152).** Settings, Voice
  & Remote, Speech has a Microphone field that lists the system default and
  your input devices by name. The choice holds for dictation in the chat and
  for Voice. If the chosen microphone is unplugged, LU records from the system
  default and keeps your choice for when the device is back. The names appear
  once the app may use the microphone, and a button under the field asks for
  that. This has run in automated tests and not yet with a real microphone.

### Changed

- **A running task says what it is doing.** The status line shows the LU mark
  and plain words such as Reading, Writing, Searching or Working on the screen
  in place of internal tool names, with the seconds the step has taken. This
  also holds while the model is still writing a tool call. When you scroll up
  during a run, the mark floats above the composer in Chat, Agent and Code, and
  a click takes you back to the end.
- **Dialogs have a new look.** Confirmations, questions and settings pop-ups
  share one dark glass style and one row of buttons. Tall dialogs stay inside
  the window, and menus and popovers use the same style.
- **The Model Manager on Windows and Linux has the colours of the Mac build.**
  Tiles, rows and buttons use one accent colour where chat, image and video
  models each had their own. The layout and what the controls do are the same
  as before.
- **Approvals in the agent chat name the action.** The bar says what the tool
  wants to do, such as change a file. The internal tool name is still there as
  a tooltip and in the opened block.
- **Compare and the background agents panel show the same status mark.** Both
  use the LU mark with one word per state, like the status line in the chat.
- **The No refusals mark is now called No Filter.** The mark keeps its meaning:
  only a model that answered in full in our measurement carries it. It is a
  plain grey tag now, in the cloud picker, the model selector, the Create model
  chip and the note under an answer that declines. The Qwen-Image 2.1 downloads
  that were labelled No Refusals are labelled No Filter.
- **The open image and video models have Uncensored in their names.** For
  example Wan 2.2 Uncensored Extend. Three presets and three local downloads
  follow, among them Wan 14B Uncensored (GGUF). Only the names changed. The
  counts are the same as before: fourteen video models and seven image models
  in the cloud catalogue.
- **Settings, Privacy and the README say what the app sends.** The Privacy
  section said "No telemetry" next to a counter and called that counter daily.
  What the app sends has not changed. The texts now describe it. LU has no
  analytics kit and sends no crash reports. On its own it asks GitHub Releases
  for a new version a few seconds after start and at most every six hours after
  that, and it counts each press of the Cloud switch: which way it was pressed,
  the platform and the app version, without an identifier. While you are signed
  in to LU Cloud, the app also checks your account every five minutes, and a
  press of the Cloud switch is counted for your account as well. Remote Access
  over the internet runs through a Cloudflare tunnel, encrypted between each
  device and Cloudflare and not end to end. Onboarding and the importer no
  longer promise more than that.
- **The agent cannot fetch from a private network, and a page has a size
  limit.** When the agent fetches a web page, addresses in a private network
  and in the range 100.64.0.0/10 are out of reach, and a page over 8 MB is
  refused.

### Fixed

- **Compare, Model Info and Delete Model name the model without a provider
  prefix.** The three places showed "openai::" in front of the model name.
- **Background tasks are listed in the order they were started.** Two tasks
  started within the same second could swap places in the list.
- **A command you keep declining ends the turn.** When you decline the same
  command three times in a row, the model is told so. After six the turn ends
  and says why. A declined call used to count like one that ran, so a model
  could ask without end.

- **Switching to another Ollama model after a voice session no longer hangs.**
  After a voice session or a chat turn, LU reads the exchange once more in the
  background to keep memories. That step asked Ollama for a different context
  window than the one the model was loaded with, so Ollama loaded the model
  again and kept it busy, and a model you picked next waited behind it with
  nothing on screen. The step now uses the window the model is loaded with,
  stops after 60 seconds at the latest, and gives way as soon as you pick, load
  or unload a model.
- **Loading an Ollama model can be cancelled, and unloading says what
  happened.** The load switch turns into Cancel while a model loads and says
  which model it is waiting for. Unloading a model that is still answering
  says so and no longer reports "Unloaded". We tested both against a stand-in
  for Ollama and not yet against a real one.
- **Going from Chat to Voice no longer loads an Ollama model again.** Ollama
  keeps a model loaded for one context window and loads it again when a request
  names another. Chat, Voice and the calls LU makes in the background (a prompt
  rewrite, a compaction, a sub-agent, the comparison view, a benchmark, a
  workflow) each worked that number out for themselves. A voice session now
  asks for the window of the chat, and a background call for the window the
  model was last sent, so neither is a reason for a load. Your own setting for
  the window still wins. The context counter of an agent session now counts
  against the window that session sends.
- **A message, an instruction in Code and a voice start no longer wait behind
  the memory step.** After an answer LU reads the exchange once more in the
  background to keep memories, and a message sent right after that answer
  waited behind it. Sending now ends the step first when the model runs on your
  own machine. The memories of that one turn are then not kept.
- **Loading an LM Studio model can be cancelled, has a limit and says what
  failed.** The load switch of an LM Studio model turned for as long as the
  load took, and nothing could stop it. It is now Cancel while the model loads,
  a load ends after five minutes at the latest, and a failed load shows the
  sentence LM Studio's own command gave. After an unload the switch shows what
  LM Studio's list of loaded models says, so a model that is still loaded is
  not called unloaded. LM Studio goes on loading after a
  cancel, so LU now tells it to unload the model right away, and unloads it
  once it is loaded if LM Studio did not take that. The switch reads
  Cancelling until the model has left memory and does not show On in between.
  On LM Studio 0.4.12 we have seen the unload end a running load in about a
  second.
- **A stop of the LU Engine while a model loads no longer restarts it on the
  processor.** A stop during a load was read as a crash, and LU started the
  model again without the graphics card. That could happen when you switched to
  the Cloud, picked another backend, started a render that needs the memory or
  quit the app. A stop now ends the start.
- **An answer cut off by a model switch says so.** Picking another local model
  while an answer is still being written ends that answer. It used to end with
  "Connection dropped before the end". What was written stays, and the line
  under it now reads "Stopped because you switched to another model".
- **A picture made in the running session can be used as a source.** In the
  installed app, picking a picture you had just made as the source in Edit
  failed with "Could not load that gallery image: Load failed", while older
  pictures worked. The same fault is fixed where else such a picture is read:
  as the start image of a video, when the chat model is shown a picture it
  made, and for Download in the gallery.
- **Seven interface corrections now hold on every platform.** They were made
  for the Mac build first, and Windows and Linux follow. On a Create tool that
  works from a source image, the picture, its references and the buttons fit on
  one screen. The model picker in Create shows the whole model name. Start here
  on the Models page recommends nothing that needs Ollama while Ollama is off.
  The command palette offers no local model while the Cloud switch is on. The
  marks DEFAULT, LOCAL and CLOUD in Settings can be read in the light theme. A
  video whose file cannot be read shows its sentence without player controls.
  The details dialog names a model once, where it read "Name: Name".
- **Voice names the right model.** The idle Voice surface kept naming the model
  of the last session after you had picked another, and the answers of a saved
  voice session could read as written by a different model. Both now name the
  model that answers.
- **A spoken yes at the card for computer control gets an answer.** In a voice
  session, a spoken yes while the card "Allow computer control in this chat?"
  was open went to the model as a new request, and the card stayed. LU now says
  aloud that it waits for your click and answers a spoken yes with "This one
  needs your click on the screen." A spoken no or stop declines, like Deny.
- **A dropdown no longer hangs in the window after its button is scrolled
  away.** A list opened from a button inside a scrolling panel stayed on screen
  when you scrolled the button out of view. It is hidden until the button is
  back.
- **The Get button of a model tile stays inside the tile.** Under Models, Chat,
  Get new on Windows and Linux, the button stood out over the right edge of its
  tile at some window widths. The row now wraps.
- **On a Mac, Qwen-Image 2.1 asks for the memory it needs, and a LoRA is
  handled as in ComfyUI.** The 8-bit and Turbo versions of Qwen-Image 2.1 asked
  for 32 GB. Their runs on our 48 GB Mac peaked at 10.3 and 14.9 GB, so both
  now ask for 24 GB. We have not run either on a Mac with 24 GB. A Qwen-Image
  2.1 LoRA that carries its own alpha ran at the full strength that was set.
  The strength now counts alpha divided by rank, as it does in ComfyUI, and a
  LoRA whose layers carry different alphas says on its row that it runs in
  full. Delete in the LoRA list removed the file for good and now moves it to
  the Trash. This is on macOS only.
- **Dictation in the chat works again on installs with Python 3.12 or newer
  (issue 155).** A fresh speech-to-text install on Python 3.12 or newer got
  PyAV 19, an audio library that dropped an argument the speech recognition
  still passes. Every take then failed with "open() got an unexpected keyword
  argument 'metadata_errors'". The dictation server that ships with LU now
  leaves the argument out when PyAV refuses it. The fix comes with the app, so
  an install that was hit needs no reinstall.
- **Restart Now starts the app again on macOS and Linux (discussion 150).**
  After an update, the Restart Now button closed the app on macOS and Linux and
  did not start it again. It now starts the new version. Windows is unchanged,
  because the installer starts the app there. The fix is part of 3.0.6, so it
  works from the next update after this one, and the update to 3.0.6 itself can
  still leave the app closed on those two systems. We have not checked it on a
  real update yet.
- **A CUDA "unknown error" in Create comes with an explanation (discussion
  130).** When ComfyUI stops a run with "CUDA error: unknown error", LU now
  says that the error comes from the graphics driver and not from the model or
  your prompt, that it usually clears after restarting ComfyUI or the computer,
  and that a driver update is the next step if it keeps coming back. An
  out-of-memory error keeps its own hint.
- **The LU Engine finds an image part you placed by hand (discussion 67).** The
  engine only saw an image part under the name its own downloads write,
  `<model>.mmproj.gguf`. One you put next to a model under its original name is
  now used when it is clear which model it belongs to: its name carries the
  model's name, or it is the only image part in a folder that holds this one
  model. Where that is not clear, for example an image part without a model
  name next to several models, no model gets it. Image parts named like
  `<model>.mmproj-Q8_0.gguf` are no longer listed as chat models. This has run
  in automated tests only.
- **On a Mac, a picture or video run takes the chat model out of memory
  first.** A local run in Create started with the chat model still loaded, and
  a Mac has one pool of memory for both. With a 23 GB chat model loaded, one
  picture took longer on our 48 GB Mac and macOS moved memory to disk while
  it ran. Create now unloads
  the chat model before the run, shows "Freeing memory..." while it does, and
  brings the model back when the run is over, as it already did on Windows and
  Linux. This is on macOS only.
- **Long LoRA names are shown in full (discussion 150).** In the LoRA stack of
  the advanced settings in Create, a long name was cut off, so two LoRAs that
  start alike read the same. A name now takes as many lines as it needs. Where
  a name stays on one line, the tooltip shows it whole.
- **A compacted conversation keeps its code blocks.** When a long conversation
  is compacted, LU reads the summary back section by section. A line such as
  OPEN or TASK inside a code block was taken for a section heading, which tore
  the block and the summary apart. Code blocks now stay whole, a block the
  model left open is closed, and a summary that a model hands back wrapped in
  one code block is still read. Thanks to ALANDVO for the fix (pull request
  154).

### Security

- **A security review of everything new in this release led to ten fixes.**
  Among the ten findings we fixed before shipping: no key press puts a
  character into a password field, and pasting is refused there as well. Typed
  text is checked again after every tab and line break. A letter or the space
  bar outside a text field is judged like a click, so it cannot press a focused
  Send button without a question. A double click on a program, an installer, a
  script or a shortcut asks first. Sensitive buttons are recognised in eleven
  more languages. The question about an app starts with the focus on Deny.
  Whole computer keeps token files, mail and browser data and LU's own folders
  closed, and Workspace only has no screen through any tool. Four Rust
  libraries (rustls, rustls-webpki, h2 and crossbeam-epoch) moved past
  published advisories.
- **The agent reads web pages more safely.** The way the agent fetches a web
  page is hardened, and packed pages are now readable.
- **Computer control asks before two more kinds of action.** A button, link or
  menu item without a name went through without a question in an autonomous
  session, because no sensitive word was found in an empty name. It is now
  asked like any target LU cannot name. On Windows and Linux, Alt with a letter
  is asked too, because it presses a button or opens a menu from anywhere in a
  window. Neither takes a spoken yes.
- **With Whole computer, the start files of the shell can be read and not
  changed.** The files your system runs by itself when a terminal or a session
  starts (such as `.zshrc`, `.bashrc` or the PowerShell profile) and the
  settings of git stay readable. The tools no longer write to them outside the
  workspace, because a line written there is a command that runs later without
  a question.
- **A catalogue search reads at most 16 MB.** When LU searches a model
  catalogue or reads a file list from the internet, it stops at 16 MB and says
  so. There was no limit before.

### Known limits

- Voice, computer control, Create in chat and the ten new chat models are in
  beta. They can still change, and this list names what we have not tested.
- Voice is English only, and the voices are fixed.
- Voice is shown in local mode only. With the Cloud switch on it is hidden,
  because LU Cloud has no voice service yet.
- Speaking while LU speaks relies on the echo cancellation of the system. With
  loud speakers and no headset the first words of an interruption can be quiet
  or missing.
- The first voice session after setup or after a restart takes much longer to
  start than later ones: 23 to 63 seconds cold against about one second warm in
  our Windows tests.
- For the first six seconds after the Start click, a voice that reaches the
  microphone only faintly is turned down. A headset is not affected.
- Computer control works in the foreground with the real pointer. There is no
  background mode.
- The list of buttons and fields and the autonomous mode exist on Windows only.
  On Linux and macOS LU cannot name what a click would press, so every click
  there is asked as a sensitive action.
- Small local models misjudge when a screen task is finished. A task can end as
  stopped although the work is done.
- Holo 3.1 9B does not fit next to a 9B chat model on a 12 GB card.
- Text on the screen can try to give the model instructions. LU marks what it
  reads from the screen as untrusted and asks before sensitive actions. For
  anything that matters, stay in the supervised mode.
- The words LU reads on a button to tell a sensitive action from an ordinary
  one are a list. A wording the list does not know is not recognised. A button
  without any name is asked about.
- Voice and computer control have not been run in the app on Linux. Computer
  control needs an X11 session there. The x86_64 packages were built and
  inspected in an emulated environment and have not been started on a real
  machine by us.
- Voice and computer control were checked point by point in the real app on one
  Windows 10 machine. Eight corrections and the ten security fixes made after
  that check have run in automated tests only and have not been checked again
  in a real window.
- The question at the first use of computer control in a chat ran in the app on
  Windows, in the chat and in Voice. In the Code tab and after a restart of the
  app it has run in automated tests only.
- A model that can see images works from the screenshot and the list of buttons
  and fields on Windows. We compared that with the list alone on two tasks
  only, three runs each. Both ways finished all six runs, and the runs with the
  picture took 497 seconds against 381.
- The 11 to 22 seconds for a note by voice were measured before the question in
  every new chat existed. In a new chat your click on Allow comes on top.
- The changes to how the agent fetches a web page have run in automated tests.
  We have not tried them on a live page in the app.
- The later changes to loading and switching models have run in automated
  tests, against stand-ins for LM Studio and Ollama: cancelling an LM Studio
  load, the one context window for Ollama, the note about the processor, and
  sending past the memory step. We have not checked them against the real
  programs in the app. The same holds for the two new questions of computer
  control and for the start files of the shell.
- Of the ways to stop the LU Engine during a load, quitting the app was checked
  against the real engine on a Mac. The Cloud switch and a change of backend
  have run in automated tests only.
- The note about a model on the processor exists for Ollama only, and only
  after a load.
- A chat turn and an agent turn on the same Ollama model still send two
  different context windows, so going from Chat to Agent can load the model
  again.
- The ten new chat models are new in LU Cloud and can still change.
- Create in chat is switched on account by account. It has not run yet in
  the installed app against the live service.
- The Mac build is in beta. The app has run on one Mac only, an M5 Pro with 48
  GB on macOS 26. It has not run on macOS 14 or 15, and not on a Mac with 16 or
  24 GB.
- On a Mac, Voice has been tried by hand in the app. It did not go through the
  point by point check the Windows app got. Computer control is in the app on
  a Mac but not fully tested yet, and the app says so at its switch.
- Not confirmed on macOS: Remote Access and the automatic update. The update
  has never run there, because there is no older Mac version to update from.
- Create on a Mac does not use ComfyUI. Most video models in the Mac catalog
  are marked "Experimental: not yet tested in LU".
- The microphone field, the image part placed by hand and the freeing of memory
  before a run on a Mac have run in automated tests only. The microphone field
  has not been tried with a real microphone.
- Restart Now on macOS and Linux has not run on a real update. It works from
  the first update after 3.0.6.
- The Windows installers of this release are not code signed, so SmartScreen
  and some antivirus engines can warn about them. SECURITY.md says how to check
  a download.

## [3.0.5] - 2026-10-05

Create runs LTX 2.5, FastH3 and YuE2 on your own machine, edits several images
in one go and has five new models on LU Cloud. Chat takes any file, and each
model in a group chat can have its own persona. Dropdowns stay inside the
window, and the speech install on Linux works again.
The open-model counts from 3.0.2 still hold: fourteen video models and seven
image models in the cloud catalogue.

### Added

- **LTX 2.5, FastH3 and YuE2 run on your own machine.** Models, Video, Get new
  has four new downloads. LTX 2.5 makes video with its own sound from a prompt
  or a first frame, as the full version for cards with 24 GB or more and as
  Small (GGUF Q4) for 16 GB cards. FastH3 is MiniMax H3 in 8 steps, text to
  video only, for 24 GB or more. YuE2 writes songs from a style and your
  lyrics on 6 to 8 GB and is licensed for non-commercial use only. LTX 2.5
  needs ComfyUI 0.32.0, FastH3 0.35.0 and YuE2 0.36.0. With an older ComfyUI,
  Create asks once and then updates it.
- **LTX 2.5 cuts between up to four shots in one run.** For text to video with
  LTX 2.5, the advanced settings have a Shots slider. Your prompt is shot 1
  and every further shot gets a field of its own. Describe the same person the
  same way in every shot.
- **Qwen-Image 2.1 gets a transparent background and its prompt enhancer.** On
  your own machine, the image settings have a "Transparent background" switch
  for new pictures with Qwen-Image 2.1. The picture is saved as a PNG with an
  alpha channel and shown on a checkerboard. The Model Manager offers the
  Qwen-Image 2.1 Prompt Enhancer as two downloads, Official and No Refusals,
  both running on a 12 GB card (issue 148). With one installed, "Improve my
  prompt" lets you choose who writes in the "Rewritten by" row: the enhancer or
  your chat model. The enhancer needs ComfyUI 0.37.2 or newer.
- **Qwen-Image 2.1 comes with a text encoder without refusals.** Models,
  Image, Get new has "Qwen-Image 2.1 (No Refusals)". It is the same image
  model and the same VAE with a community text encoder that has its refusal
  direction removed (Heretic). If you already have Qwen-Image 2.1, only the
  text encoder is downloaded, about 9 GB. With both text encoders installed,
  the Expert settings in Create have a "Text encoder" row to pick which one
  reads your prompt, for new pictures, for edits and for pictures made in
  chat. The official one stays the default.
- **Noct Q, an unfiltered finetune of Qwen-Image 2.1, is in the Model
  Manager.** Models, Image, Get new has "Noct Q (Qwen-Image 2.1,
  Unfiltered)", a community finetune of Qwen-Image 2.1 by Noctaluna. Here
  the image model itself is changed: its notice says the Qwen-Image 2.1
  transformer weights were modified. It uses the official text encoder and
  VAE, so if you already have Qwen-Image 2.1, only the image model is
  downloaded, about 7 GB. The app treats it as Qwen-Image 2.1: new pictures,
  edits with reference images, transparent background, the text encoder
  choice and the prompt enhancer are there for it. Qwen Research License,
  non-commercial use. Not yet run on our own hardware.
- **"Improve my prompt" lets your chat model rewrite the prompt before a
  run.** The switch is in the advanced settings, off by default and
  remembered. When it is on, the chat model you picked rewrites your prompt
  for the image, video or music model before the run. A cloud chat model is
  billed like chat. The gallery details show what you wrote and what ran. A
  rewrite that fails or takes too long is dropped and the run uses your own
  prompt.
- **Edit, Remove Background and Enhance Image take several images at once.**
  Pick or drop up to 50 source images, or a whole folder with "Add a folder".
  Each image runs on its own, one after the other, and the queue shows which
  one is running. Cancel stops the rest, and an image that fails does not stop
  the others and is named at the end. On LU Cloud the price per image and for
  the whole list is shown before you start. A model that needs a painted mask
  keeps one image.
- **"Save character" on a video keeps frames as a character.** In the large
  view of a video, "Save character" lets you pick frames at the playback
  position and give the figure a name. It is stored on this device, up to 30
  photos. From there, "Use as reference photos" loads it into the reference
  strip, and "Train in Character Studio" starts a training set with it.
- **LoRA strength takes values from -10 to 10.** The slider in the LoRA stack
  still runs from 0 to 2. Next to it is a number field for the exact value
  from -10 to 10, for slider LoRAs that are made for a wide range around zero.
  Each LoRA keeps its own value, also while it is switched off and after a
  restart.
- **The MiniMax H3 Turbo LoRA is a one click download.** 3.0.4 said the turbo
  LoRA runs MiniMax H3 at 8 steps but not where to get it. It is now under
  Models, Video, Get new and under Models, LoRAs, Get new in a "Ready to
  install" list. The LoRA stack in Create shows it as soon as the download is
  done. FastH3 is already an 8 step model and leaves the turbo LoRA out.
- **Models carry a Best mark, and older ones sit under "Older models".** The
  model picker in Create and the Model Manager put the current models first
  with a Best mark and collect the ones a newer family has replaced under
  "Older models". No model was removed.
- **Local image, video and music models say whether they fit your graphics
  card.** With a detected graphics card, each download in the Model Manager
  compares itself with it: "Fits your 12 GB card", "Tight on your 12 GB card:
  runs, loading can be slow" or "Needs more than your 12 GB card". The
  model picker in Create marks a model that is tight or needs more, and when
  loading such a model takes longer than a minute, the waiting line says why.
  The Z-Image Turbo description no longer promises 8 to 15 seconds per image,
  which did not hold on smaller cards. Without a detected card, as on a Mac,
  nothing changes.
- **LU Cloud: Qwen Image 2.1, LTX 2.5, MiniMax H3 and Wan 3.0 Reference.** The
  cloud pickers in Create have five additions from open model families: Qwen
  Image 2.1 for images, Qwen Image 2.1 for editing, LTX 2.5, MiniMax H3 and
  Wan 3.0 Reference. LTX 2.5 makes video from a prompt or from a first frame.
  MiniMax H3 now also starts from a prompt alone, works from reference photos
  and edits a clip from an instruction. A model shows up once the cloud
  catalogue lists it. "Open weights" next to a name means this exact version
  has open weights, "Open family" means its family has them and this version
  does not.
- **LU Cloud: Image and Edit make up to four images per run.** The settings
  have an Images slider from 1 to 4. Each image is its own job at its own
  price, lands in the gallery when it is done, and is refunded alone if it
  fails. The credit counter shows the total before you start.
- **LU Cloud: reference models take several of your photos.** Models that work
  from reference photos, such as MiniMax H3 Reference and Wan 3.0 Reference,
  and the editors that take more than one image now have a strip under the
  source image for up to five photos.
- **Chat takes any file, not only images.** The paperclip, drag and drop and
  paste used to turn everything but images away. They now take any file, up to
  3 per message and 64 MB each. The model gets a description of the file: its
  name, its type, its size and the readable text in it. In Agent and Code mode
  the file is also copied into the working folder, so the file tools can open
  it. Documents you want to ask questions about still belong in Document Chat.
- **Each model in a group chat can have its own persona.** In the Plugins menu
  under Group chat, every model row has a persona picker. Each model then
  speaks as its persona, knows the names of the others, and a line it writes
  in another one's name is cut. A group without a pick works as before.
- **An answer that declines says what to do next.** When a model declines, a
  line under the answer says so: a refusal stays in the chat history, and
  other models tend to copy it. "New chat" in that line opens a fresh chat
  with the same model, and the line points you to the models marked No
  refusals.
- **The model picker in Cloud mode has a search and tags.** In Chat, Agent and
  Code, the Cloud model list is grouped by model family and has a search
  field. Four tags narrow it: No refusals, Vision, Thinking and No credits. A
  row shows the name, the No refusals mark, image input, thinking and the
  context size where the server states it. The "?" on a row opens the credit
  rates per 1M input and output tokens. Arrow keys move, Enter picks and
  Escape closes. On LU Cloud, the model select in Create has the same family
  heads. The local model list is unchanged.
- **LM Studio is one line in the local model list.** When LM Studio is
  installed and its server is off, the local model list showed a box with a
  paragraph of text. It is now a single line with a status dot, the number of
  models on disk and a small Start button. What Start does to your local chat
  backend is in the tooltip of the button. While the menu is open the line
  follows the server: it goes away once the server is up and its models are in
  the list, and it comes back when the server stops, and the models leave the
  list with it. The number counts chat models only, without embedding models
  and vision projectors, so it matches the list after Start.

### Changed

- **Five cloud models no longer carry the No refusals mark.** Qwen3 30B A3B,
  Qwen3 Coder 480B, Llama 4 Scout, DeepSeek V4 Flash 0731 and Qwen 3.5 397B
  A17B declined in the second or third round of a longer test on 2026-10-05.
  19 of the 46 cloud chat models we measured answer in full without refusing,
  and only those carry the No refusals mark.

### Fixed

- **LU Cloud picks no chat model for you.** In Cloud mode a new account
  chatted on the first model of the list without ever having picked it. The
  picker button now reads "Choose a model" until you pick one. Sending without
  a model keeps your message and its attachments and opens the picker. A model
  you picked yourself stays picked. If your Cloud chat stood on that first
  model, Llama 3.1 8B Turbo, the pick is cleared once. Local mode still picks
  a model on its own.
- **Dropdowns stay inside the window.** On the Linux AppImage and in small
  windows the model list in Create opened below the bottom edge, so no model
  could be picked (issue 149). Every dropdown and popover now opens on the
  side that has room, is never taller than that room and scrolls inside. The
  right click menu sat a little off the pointer and now opens at it.
- **Linux: speech to text and Piper install again.** On Ubuntu 24.04 and other
  distributions that protect the system Python, installing faster-whisper and
  Piper ended with "Can not perform a '--user' install" when ComfyUI ran in
  its own Python environment. The installer mistook that environment for the
  protected system Python and added options pip refuses there. It now
  recognises the environment and installs into it.
- **LU Cloud: Edit starts without a mask on models that need none.** With a
  model that edits from the instruction alone, the Edit stage still showed
  "Paint mask" and the Create button waited for one. The stage now says the
  model needs no mask, and Create starts with the source image and your
  prompt.
- **LU Cloud: settings stay with the model and the tool they were chosen
  for.** The Images slider is in the advanced settings for every Image and
  Edit model and goes back to 1 when you change the tool. Settings chosen for
  one model no longer carry over to the next one. In Music, the length slider
  and the Lyrics or Style field show only where the model reads them, and a
  tool without a prompt field sends no leftover prompt.
- **Image settings survive a visit to Music, Lip sync or Motion.** Steps, CFG
  and Quality for images came back changed after you opened Music, Lip sync or
  Motion in between. Quality on Draft, for example, read High with 50 steps
  afterwards. The same happened when the app was closed on one of those tabs.
  Each tab now keeps its own values, and a distilled video model keeps its few
  steps instead of the 30 of its model family.
- **Draft, Standard and High follow the model you picked.** The Quality
  buttons for images counted from the step count of the model family, so on a
  checkpoint built for a few steps, such as SD Turbo with 4, Draft meant 15
  steps and the image came out overcooked. Standard is now the model's own
  step count, and Draft and High scale from it. "Reset to model defaults" goes
  back to those values as well, for images and for fast video models.
- **A failed subscription payment is shown as one.** When a renewal payment
  failed, the account window said "No active plan" and the Cloud window
  offered the plans again, although a new plan cannot be bought until the open
  invoice is paid. Both now say that the last payment failed and have a "Pay
  open invoice" button that opens your account on lu-labs.ai in the browser.
  Credits you bought stay usable, also after a plan has ended.
- **A model download checks its checksum on a retry too.** After a failed
  download, Retry and Resume started the file again without its SHA-256 and
  expected size, so the second attempt was not verified. Both are kept now. A
  file with the same name but another size no longer counts as installed where
  the catalogue knows the exact size.

## [3.0.4] - 2026-10-02

A fix for the Code agent and the agent in chat on LU Cloud. Long file writes
no longer end the run, "continue" picks up where a run stopped, and the agent
no longer spends requests on steps nobody asked for. The open-model counts
from 3.0.2 still hold: fourteen video models and seven image models in the
cloud catalogue. It also fixes the bugs reported on GitHub and Discord since
3.0.3, and Edit in Create can now take more than one image.

### Added

- **Edit takes more than one image.** With Qwen-Image 2.1 or Qwen-Image-Edit
  on your own machine, small tiles under the source image take up to three
  more images (two for Qwen-Image-Edit). Name them in the prompt as image 2,
  image 3, for example "put the jacket from image 2 on the person". Asked on
  GitHub (issue 144) and in Discord.
- **MiniMax H3 runs as a video model with sound.** A MiniMax H3 file showed up
  as an image model. It now sits in the video list, also under a CivitAI name,
  and renders picture and sound together, from a prompt or from a first frame.
  The Model Manager offers it as one download with its text encoder and both
  decoders. With the 8-step turbo LoRA in the stack it runs 8 steps, as the
  official template does.
- **A download speed limit.** Settings, Model Storage takes a limit in MB/s
  for the model files LU downloads itself, shared by all downloads at once.
  0 means no limit. Ollama pulls and installs are not limited.
- **The Local API shows what went through it.** While it runs, Settings,
  Local API shows the requests and failures, the requests running now,
  tokens in and out as the model server reports them, and the last model,
  counted since the API started and kept in memory only.

### Fixed

- **A group chat answers with every LU Engine model in it.** When the models
  sat in the folder set under Settings, Model Storage, only the loaded one
  answered. The others got "The LU Engine has X loaded" instead of the engine
  switching to them.
- **Ollama models download without one already installed.** The Download
  button asked you to pick an Ollama model in the chat first, which is not
  possible before the first download.
- **A GGUF from the CivitAI search lands where ComfyUI reads it.** It went to
  the checkpoints folder, so the download finished and the model never showed
  up. It now goes to diffusion_models, and the ComfyUI-GGUF nodes are installed
  with it when they are missing.
- **ComfyUI installs into its own Python environment on Windows.** A fresh
  install could put PyTorch into the system Python, where an AMD card failed
  with "hipdnn_backend.dll Bad Image". Every new install now gets its own
  environment in the ComfyUI folder.
- **The window no longer disappears on Linux.** On Bazzite and other Linux
  systems with an AMD card the main window could vanish, under Wayland and
  X11. The window is no longer transparent on Linux (issue 145).
- **A chat model from LM Studio says where it is deleted.** Its row has no
  bin, because LM Studio offers no way to delete a model from outside, and
  Details showed nothing. Details now says to delete it in LM Studio under
  My Models, and does the same for other local servers.
- **The Code area always has an input box.** With no code conversation open
  it showed "Type below to start." over nothing; the first instruction can now
  be typed right there.
- **Turbo checkpoints start at a few steps.** SD-Turbo, SDXL-Turbo,
  Lightning, Hyper-SD and LCM checkpoints start at 4 steps and CFG 1 instead
  of the family's 25 steps.
- **Installed models show their real file format.** Every ComfyUI file that
  was not a .gguf was labelled "safetensors", a .ckpt motion module too; the
  list now reads the file ending.
- **Local API counts say what they count.** "Requests" is now "Model
  requests", since listing the models is not counted.
- **A render says when it left a LoRA out.** The "Skipping LoRA" line was
  gone a second later; the result now keeps it under the picture. Character
  Studio LoRAs say "Z-Image only" before you tick them, and the strength
  slider shows its number.
- **A no to a download is not a failure.** Cancel in the "One more file is
  needed" question now reads "Not started." with the reason, instead of
  "Generation failed".
- **One message while ComfyUI starts.** The red "ComfyUI is not running" no
  longer stands next to "ComfyUI is starting up."
- **Back from Video, the image model gets its own settings.** Image, Edit
  and the other image modes only switched the mode, so an image model could
  render with the video model's steps, sampler and size (sd_turbo after
  MiniMax H3: 20 steps at 1344x768, several plates instead of one).
- **New Chat in Code works like New.** The sidebar button added an empty
  "Coding Agent" on every click and reset Bypass to Ask; it now reuses an
  untouched session and keeps your mode.
- **No download offer while ComfyUI is starting.** Right after launch the
  Create stage could offer the 6.5 GB starter download while ComfyUI was still
  coming up and the models were already on disk. It now waits.
- **A downloaded render is the render you picked.** After a gallery delete,
  ComfyUI could give the next render with the same prompt the freed file name,
  and downloading the older entry then saved the newer picture. Every run now
  writes its own file names. Download in the gallery strip also did nothing on
  Windows; it now opens the same Save dialog as the result view.
- **The Code agent runs calls a cloud model writes in unusual shapes.** A call
  named "function" with a to-do list came back "Unknown tool: function", and
  calls written into the answer as `!function_call:{"call": ...}` were never
  picked up on LU Cloud, so the run stopped and the model kept retrying. Both
  now reach their tool; a call that fits several tools is answered with what to
  send instead (issue 147).
- **A LoRA deleted from the loras folder leaves the stack.** Its pick stayed
  saved, the stack said "2 active" with nothing ticked, and every run sent it
  until ComfyUI refused with "Value not in list". Rescan and every connect now
  drop picks whose file is gone, a run leaves out anything ComfyUI does not
  list, a Character Studio character (a Z-Image LoRA) only goes to Z-Image
  models, and Clear turns the whole stack off (issue 146).
- **A missing encoder or VAE no longer ends in "Value not in list".** When a
  Qwen-Image 2.1, MiniMax H3 or other newer model was missing one of its files,
  Create tried the old checkpoint graph and ComfyUI answered with
  "CheckpointLoaderSimple: Value not in list". Create now names the missing file
  and offers to download it.
- **Installing the MLX engine in a browser dev build says what is wrong.** It
  said "Unknown backend command". It now says that the engine install needs the
  desktop app (issue 135).

- **Writing a long file no longer ends the run.** While a model writes a file,
  the app receives the file in pieces but has no text to show. After five
  minutes without text it treated the connection as stalled and ended the run
  in the middle of the write, and the next run started that step again. The
  app now ends a run only when no data arrives at all for a minute. While a
  model is still working, the server sends a short signal every 15 seconds.
- **"continue" picks up where the run stopped.** After a stop or an error, the
  next message lost the steps the run had already done, and the agent started
  over. The steps of a run are now kept for the next message, also after a
  stop or an error. Older steps that no longer fit into the context are kept
  as a short list of what is already done, instead of being dropped.
- **The agent keeps a plan only when you ask for one.** The Code agent wrote a
  todo list for almost every task and sent an update after each step, each one
  a request of its own. It now keeps a plan in Plan mode, when you ask for a
  plan, or while a plan is still open. The plan panel, the approval bar and the
  file explorer are dark instead of blue.
- **The run says which tool the model is writing.** A model writing a long
  file sends the call in pieces for many seconds, and the run said only
  "Working" the whole time. It now shows the tool's name and how much of the
  call has arrived, for example "Preparing file_write 3 kB", as soon as the
  first piece is in. A run that waits for your approval says so in the
  chat too, and Stop before the first word leaves a short note instead of an
  empty answer. Stop pressed right after Send ends the run on the first
  press; before, the run could keep going or hang on "Working".
- **Code conversations stay in the Code tab.** After a restart the last Code
  conversation opened in the Chat tab, where the agent was off and a
  "continue" ran without tools. The app now opens the chat you worked on last,
  and the Chat and Code buttons each take you back to the conversation you
  worked on last there, also while a run is going.
- **Fewer interruptions while the agent works.** New in the Code tab keeps Ask
  or Bypass, whichever you picked last. In the agent chat, reading, listing and
  searching files in the agent's own folder no longer asks for approval;
  writing still does. When the agent fixes a failed step on its own, the steps
  no longer show a red mark and no line asks you to try again. After you say
  No to a tool, the model is told its other tools are still there, so it
  carries on instead of saying it has none. The clock next to "Waiting for
  your approval" counts the wait, and a tool's time no longer includes the
  time the card waited for you. No "Thinking" label shows while a model that
  does not think is working, an answer that is still arriving shows no stray
  backtick or asterisks, the context counter shows the right size from the
  first message, and the mode menu in the Code tab is no longer cut off. No
  approval card appears for a file outside the agent's folder, which it could
  never open anyway. Asked to write a new file somewhere outside, the agent
  writes it inside its folder and tells you. A new Code session lists its
  still empty folder as empty instead of reporting an error,
  a failed step shows its error once, and pressing New again on an untouched
  Code session adds no extra empty entry. The hint about the agent's folder
  stays with the chat it belongs to, and asking the chat to put a file name in
  backticks no longer starts a file write.
- **The agent stops repeating a tool that fails.** Tools report most failures
  as text, and the loop guard only counted an unknown tool as failed, so a run
  could repeat a failing call until its round limit. Failed calls now count. A
  failure is no longer served again from the cache within the same run, and a
  call the model was cut off in the middle of is not run half-written.
- **Ask mode asks before tests, commits, pushes and pull requests.** It used to
  ask only before shell commands. The approval card shows every argument. Two
  approvals at once wait in line instead of the second one rejecting the first,
  and the end of a run no longer rejects a question from a background
  sub-agent. A tool you switched off in the tool permissions is refused instead
  of offered for approval.
- **Pending changes are written only when you mean it.** A change you reject
  during "Apply all" is no longer written. Auto-apply follows the mode and
  applies only the changes of the run that just finished. A file that is not
  UTF-8 text is no longer shown as a new file and then overwritten.
- **Chat keeps its error messages.** An error, or the note for an empty answer,
  was sometimes overwritten by the last frame of the answer. Regenerate and Edit
  no longer delete your question when the message cannot be sent.
- **Create tells you what happened to a render.** Cancel on a render that a GPU
  already took now says that it will finish and be charged, and the result
  still lands in your gallery. A submit whose answer got lost is sent again with
  the same request id instead of leaving a paid job you never see. The preset
  workshop can generate again after a failed step and after Try again.
- **The free Flash allowance lasts as long as on the web.** The app asked LU
  Cloud to hold room for 32K answer tokens on every request, so a stopped Flash
  request used four times as much of the daily allowance as the same request
  on the web. LU Cloud now sizes the answer itself.
- **Smaller fixes in Chat, Agent and Code.** The Working clock counts from the
  start of the run, also after you switch tabs. The answer header names the
  model the way the model picker does. Cloud models no longer show "Loading
  model". Code blocks no longer show a light band behind every line. An
  approval card that appears at the bottom scrolls into view. In a narrow
  window the Code tab keeps its header on one line and the Stop button inside
  the prompt box. Diffs of new files no longer count an empty last line, and
  the file name shows once.

### Changed

- **The setup offers models without refusals.** The two chat models the
  first start suggests are now the abliterated builds of Qwen 2.5 7B and
  Qwen 3.5 9B, same size and speed as before. The 9B refused some requests
  (Discord).
- **A character trained on your own machine takes up to 100 photos.** The limit
  was 30 everywhere. Cloud training keeps 30 and says how many photos to
  remove (issue 121).
- **Fewer requests for the same work.** The agent is now told to read several
  files in one step instead of one request per file. file_edit changes several
  places in a file in one call, all or nothing, can replace every occurrence of
  a string, and still finds the place when the indentation in the file differs
  slightly from the model's copy.
- **The "Stage writes for review" setting is gone.** The mode decides whether
  writes wait for review (Ask mode does). The auto-apply switch is always shown
  and applies what Ask mode staged when the run finishes.
- **Cloud context is 32K by default and can be set per model.** Cloud models
  now send at most 32K of context by default instead of 64K. You can change it
  per model in the context menu in the header. Once you set it above the
  default, a small triangle shows that every message then sends more and costs
  more credits.

## [3.0.3] - 2026-09-28

A hotfix for chats with many images, which could run the app out of memory,
for Create with models it could not place by their file name, and for the five
bugs reported on GitHub since 3.0.2. The open-model counts from 3.0.2 still
hold: fourteen video models and seven image models in the cloud catalogue.

### Fixed

- **Chats with many images no longer run the app out of memory.** Every image
  was kept inline in the saved chat history, and a few chats with phone photos
  were enough to make that history too big for the app's memory. On Windows the
  history could not be saved at all once it passed 127 MiB, so newer chats
  could end up only in the app's backup file. Images are now stored as separate
  files outside the history. An existing history is moved over once, on the
  first start of this version, and chats or messages that only the backup file
  still held are restored from it once. In a long chat, image previews load
  only near the part you are looking at.
- **Create reads a model's family from the file, not from its name.** Renders
  failed with "Value not in list" for models whose file name did not say what
  they are, which on CivitAI is most of them, because a name Create could not
  place went to the checkpoint loader. Create now reads the family from the
  file header (only the header, not the weights) and loads the model from the
  folder it actually sits in. Chroma, HiDream I1, SD 3.5, Lumina 2, Qwen-Image
  and Qwen-Image-Edit get pipelines of their own. If the model needs a text
  encoder or VAE that is not on disk, Create asks once and downloads it. If
  ComfyUI on this machine is too old for the model, Create asks once and
  updates it. Before, the run ended with a pointer to the Model Manager. A bare
  VAE or text encoder file in a model folder no longer shows up as a model.
- **Edit keeps your photo at full strength.** At strength 1.00, Edit dropped
  the source image without a word and painted a new picture from the prompt
  alone. It always keeps the source now, and the slider stops at 0.95, the
  strongest repaint that still starts from your photo.
- **Deleting a render in the gallery removes its file too.** Deleting a local
  render, also from the large view, now moves the file to the Recycle Bin
  (Windows) or the Trash (Linux), so the ComfyUI output folder stops growing.
  Before, only the gallery entry went. Dragging a picture from the gallery onto
  the Edit drop zone now loads it, as a click already did. Tiles that went dark
  while ComfyUI was not answering come back as soon as it answers; they used to
  stay dark until the next start.
- **The agent shows which folder it works in, and how to reach your files.**
  Setting every agent permission to Auto never let the agent open files
  outside the chat's working folder, and nothing said so: a dismissed folder
  dialog left the agent in its own sandbox without a sign. The button next to
  Agent now always shows where the agent works, Sandbox included, and one click
  leads to "Pick a folder…". When a file is refused because it is outside that
  folder, a line above the chat says what to do, and the model gets the same
  hint. Plain chat has no tool that reads your files, and asking it for one
  used to end with the model saying it cannot. It now brings up a line that
  says to turn on Agent. In Settings, Filesystem no longer claims to reach
  files anywhere.
- **Typing in the prompt box no longer lags in long chats** (issue 139). Each
  key made the page lay out the whole visible chat twice to size the box, so
  the delay grew with the conversation. The box is now measured on a hidden
  copy and resized only when a line is added or removed. This covers the Chat
  and Code tabs and the Create prompt field.
- **Stop works in the Code tab again, also in the /loop bar** (issue 140).
  Both Stop buttons passed the click event where the stop function expected a
  conversation, so they stopped nothing. A loop pass that ends early no longer
  leaves the bar on "running" with the working folder locked. When a server
  refuses a step because the request exceeds its context size, the step is
  sent again with the history shortened to fit, and the pass goes on. Later
  steps start at that size.
- **The recent list in the collapsed sidebar follows the mode** (issue 141).
  With Code or Remote picked, it listed the plain chats. It now lists that
  mode's chats, and opening one stays in that mode.
- **"Full body" in a chat image shows the whole figure** (issue 142). The
  chat's image tool rendered every picture in the model's square default, and
  SDXL, Pony and Illustrious models crop a whole person in a square frame to
  the face. When the prompt asks for a whole figure and names no size, the
  picture now gets the upright frame those models were trained on.
- **Model downloads work with ComfyUI on another machine** (issue 143). With
  ComfyUI running on another computer, downloads failed with "permission
  denied" or "ComfyUI path not set". They now go to the Model Storage folder,
  in ComfyUI's own folder layout. The Model Manager and Create say where the
  files are and what is left to do on the other machine: copy the folders over
  or share them, and install any node packs a bundle needs there.

## [3.0.2] - 2026-09-22

A hotfix for the Code tab, where a conversation taller than the window lost its
scrollbar and its input box. The count of open models in the cloud catalogue
also takes the Create Studio endpoints in now, fourteen video and seven image.

### Fixed

- **The Code tab lost its scrollbar and its input box once a conversation grew
  taller than the window** (issue 138, a regression in 3.0.1). The outer frame
  around the transcript and the composer stopped being a scroll container in
  3.0.1, so it grew with the transcript instead of staying inside the window:
  only the start of a long conversation was visible, the mouse wheel did
  nothing, and the composer with its toolbar sat below the bottom edge. The
  frame is held to the window height again, so the transcript scrolls and the
  input box stays in view. The Chat tab was never affected.

### Changed

- **The count of open models now takes the Create Studio endpoints in.**
  Fourteen video models and seven image models in the cloud catalogue run
  without a built-in content restriction, counted the way a customer picks
  them: every catalogue entry marked open, whether it sits in the classic
  picker or on the Create Studio shelf. The old rule left the Studio shelf out
  and reported ten and three, so four open image-to-video endpoints and four
  open image models were sold short. Two of the fourteen, OpenVideo and
  OpenVideo + Style LoRA, do not carry Uncensored in the name and are open all the
  same; the mark comes from the catalogue field, never from the name. An entry
  that is the same endpoint under a second name is counted once, and the
  extend tools stay out because they continue a clip instead of making one.

## [3.0.1] - 2026-09-18

A GPU without a measured free reading gets a safer plan, and Linux/AppImage
installs stop losing environment variables to it.

### Added

- **Create-Studio, a new guided path on the cloud track.** A preset shelf next
  to the usual Create tab walks a render from image to motion to sound, in
  steps, each backed by any model that can do that step's job. Each step's
  controls come straight from the picked model's own provider schema, and the
  price shown is the one the provider actually confirms before Start, never a
  formula guessed on this side. The server side on lu-labs.ai shipped with
  this release, so the shelf shows up in Cloud mode. If a future server ever advertises
  Studio without also fixing the two price-check routes, Create shows "This
  feature needs a newer LU Cloud server. Try again later." instead of
  guessing a price or booking one.
- **Qwen-Image 2.1 is downloadable in the Model Manager and runs locally on
  Windows and Linux.** One model does both jobs: write a prompt to generate a
  picture, or add a reference image plus a prompt to edit one, with no mask to
  paint. It appears in the Generate picker and the Edit picker like every other
  installed image model. The bundle pulls three files (about 16 GB together)
  and needs ComfyUI 0.37.0 or newer for the encode node it runs on; an older
  ComfyUI is told which version to update to before anything is built. Not in
  this release: more than one reference image at a time, and painted masks,
  which this model's encode node cannot take. The weights carry the Qwen
  Research License, which allows research and evaluation but not commercial
  use, and the bundle says so with a link before you download it.
- **Cloud video renders now offer exactly the clip lengths the picked model
  actually supports**, read from the live catalog, instead of a fixed 5s/8s
  pair for every model.
- **A cloud render without a prompt (a presenter reading a script, for
  example) still gets a real name in the gallery**, instead of an empty tile.
- **Models now has a LoRAs tab of its own on Windows and Linux.** Get new
  searches CivitAI for LoRAs and downloads what you pick into ComfyUI's
  `models/loras` folder; Installed lists what is there with its size, marks a
  character you trained yourself with its trigger word, and deletes a file you
  no longer want. LoRAs no longer sit unnamed among the checkpoints in the
  Image tab. Not offered on a Mac, where local media runs on Apple MLX and
  there is no ComfyUI `models/loras` folder to list.
- **Character LoRAs in Create now only offer the models actually trained for
  that character's family**, so the picker cannot suggest a combination that
  would fail to generate.

### Fixed

- **The local engine now picks its CPU code path at startup**, so older
  processors without AVX2 can run local models instead of the engine exiting
  right after start.
- **A GPU whose free VRAM could not actually be measured** (no nvidia-smi, for
  instance) used to be planned as if the whole card were sitting empty, and the
  log line said "N MiB are free" for a number that was really the total size,
  other programs included. It now takes a bigger safety margin on that weaker
  reading and logs it correctly as total capacity, not free memory, so a start
  plans fewer layers rather than too many.
- **Linux AppImage stops leaking its own runtime into every program LU
  starts.** git, a system Python, pip, ffmpeg, nvidia-smi, the coding agent
  shell and every program the Character Trainer starts no longer inherit the
  AppImage runtime's own LD_LIBRARY_PATH, PYTHONHOME and related variables.
  That inheritance made a perfectly healthy system Python fail to import ssl or
  find its standard library, with a diagnosis that pointed at a broken Python
  install rather than the real cause.
- **A platform where pip refuses to write into the system Python** (Arch,
  Debian 12+, Fedora 38+, Ubuntu 23.04+) no longer kills the isolated venv LU
  already built there at the first pip call, and the same fix keeps the Coding
  Agent's own terminal from picking up the same poisoned environment for every
  git, pip or python command typed into it.
- **Installing or repairing ComfyUI now searches the interpreters already on
  your machine** for one PyTorch actually ships wheels for, and uses that one
  automatically, with no picker in Settings. If none is found, it says so and
  tells you what to install before starting the roughly 2 GB PyTorch download,
  instead of that download running for minutes and then failing with pip's own
  generic error.
- **Linux: a ComfyUI install missing python3-venv now says so.** The install
  used to end with "venv creation failed:" and nothing after the colon,
  because Python prints its python3-venv hint on stdout, and LU only read
  stderr.
- **Windows: installing to a very long folder path no longer stops the
  bundled engine from starting, and when Windows cannot shorten that path,
  the app now names the install path as the cause instead of showing a bare
  OS error.**
- **The LU Engine crashing immediately on an old CPU now says which instruction
  set is missing**, measured from the CPU itself rather than guessed, and stops
  retrying the same binary a second time since it would only fail the same way
  again.
- **The engine startup probe's log line no longer treats a model that is still
  loading, one that is thinking and one that has genuinely failed as the same
  thing.** The wording for each case is distinct now.
- **The CI check that runs on every pull request now fails independently on
  each platform** instead of one platform's failure hiding whatever the other
  platform would have found.
- **Sending in one conversation while another is still streaming no longer
  mixes their text together**, and a second agent run no longer gets silently
  dropped while the first one is still going; both now finish on their own.
- **The local model runs one conversation at a time**, and a chat that has to
  wait its turn now says so, with a line showing how many chats are ahead of
  it. Stop works while it is still waiting, and takes it out of the line.
- **Stop, signing out and quitting the app now reach every conversation**,
  including one that has not started running yet and is only waiting its turn,
  not just the one open on screen.
- **Moving the Temperature, Top P or Max tokens slider now changes that one
  conversation only**, instead of every open chat sharing one value from the
  Settings page. A chat with no slider of its own still follows Settings, and a
  field nobody moved anywhere is left out of the request so the model applies
  its own default.
- **Pressing Stop while the Coding Agent is running code now actually stops
  that run**, the same way it already stopped a shell command.
- **Workflow steps now go through the same tool approval as the rest of Agent
  mode, and only offer the tools your permissions allow.** Built-in workflows
  now take their input from the call itself instead of waiting forever for an
  answer nobody could give, and the Play button in Settings under Agent
  Workflows that never did anything is gone.
- **A sub-agent delegated in the foreground is no longer cut off after 60
  seconds**, and a timeout or Stop now actually ends the tool call it was
  running instead of leaving it running in the background.
- **The Troubleshoot panel now tests the LM Studio address you actually
  configured in Settings**, instead of always trying the default
  127.0.0.1:1234.
- **Picking a specific GPU for a local model or the Character Trainer now keeps
  using that physical card** even if Windows or Linux renumber the cards
  between detection and start.
- **Opening the Hardware tab in Settings while a local model or the trainer was
  starting up could freeze it for a moment**; it no longer waits on that GPU
  detection.
- **Replacing an OpenAI compatible backend now parks the API key it displaces
  in the OS keychain instead of dropping it**, and gives it back if you switch
  back to that backend or remove the one that replaced it. The warning that a
  key will be lost only shows on a device with no keychain to park it in.
- **Setting an install location for the Character Trainer during first setup
  now also redirects pip, Hugging Face and torch's own caches there**, so
  choosing a folder off a small system drive keeps those caches off it too.
  This applies at first setup only; there is no way in the app yet to move an
  already installed trainer to a different folder. The field itself now
  rejects a path it cannot actually use, always shows the folder it will
  really install to, and an emptied field goes back to the default; the Z Image
  base model downloads always follow your configured model folder in Settings,
  ComfyUI, either way.
- **A finished image in Create has an Animate this image button** that carries
  it straight into a video render, the same as the browser studio, and the No
  refusals mark now shows on cloud models in the desktop picker as well.
- **qwen-image-edit is selectable from the seed and edit pickers again**, the
  upscale tool is named Enhance Image to match the web, and Krea 2 checkpoints
  load with the right UNET, CLIP and VAE nodes instead of falling back to an
  unknown loader.
- **The Create button now stays disabled instead of failing on the server**
  when the chosen model needs a mask that was never supplied, and the local
  character LoRA list refreshes itself right after a training finishes instead
  of needing a restart.
- **"Failed to fetch" is no longer shown as the whole explanation for a failed
  cloud render**, and the out of credits dialog now has a distinct title for
  each of its three reasons instead of one generic one.
- **The model picker no longer crashes when grouping models by family**, a
  custom OpenAI compatible endpoint now receives Top K, a model name is no
  longer cut off at its first colon, and a newly added provider starts with no
  value pre filled.
- **A memory entry with more than one line survives export and import again**,
  both separator styles the web writes are read back, and one sensitive memory
  entry no longer blocks the whole sync.
- **The composer lock during a send now only affects that one conversation**,
  not every open chat, Stop in one chat no longer cancels an image or video
  render running in another, and picking a third remembered agent folder now
  asks for confirmation like the first two do.
- **The first click into the Models folders tab is faster**, since it asks the
  running engine directly instead of falling back to a stale cache, and the
  onboarding VRAM hint asks LU's own probe first so it works before ComfyUI is
  installed.
- **Settings now says when Ollama is reachable but switched off**, instead of
  just Reachable, which read as if it were actually being used.
- **On Windows, the Troubleshoot panel now says Not running for a backend that
  is switched off**, instead of Reachable, slow to answer, which read as if the
  backend were alive and merely busy.
- **On Windows, pressing Stop on a command that had only just started now also
  ends the worker the shell launches a moment later**, so a build or install
  cancelled at the very beginning stops instead of running on and writing files
  in the background.
- **A Cloud chat request that hits its own four minute limit is now treated as
  finished right away** instead of being retried up to three more times with
  the same four minute wait on each try.
- **The Local Media (Apple MLX) panel now mentions that a Hugging Face token
  can help its downloads**, the same hint ComfyUI already gives for its own
  model downloads.
- **The No refusals mark in the desktop model picker now carries an icon and
  bolder text** so it is actually noticeable, instead of blending into the
  smallest text on the row.
- **Dismissing the stale model notice in the chat header now actually
  dismisses it**, instead of it reappearing on the very next update.
- **The reason the Coding Agent will not let go of its current folder is now
  shown as a visible line**, instead of only a tooltip a disabled button never
  shows.
- **The "Memory sources" chip under every AI answer is gone.** The purple
  brain icon in the session strip below the transcript, right above the
  composer, still opens Memory, so repeating it under each reply only added
  clutter.
- **A draft left in the message box no longer merges into the next thing you
  type after switching conversations**, and the composer no longer gets stuck
  showing Stop after closing the window, signing out or quitting with a
  message still in flight.
- **Switching the app to Cloud no longer drops a local generation running
  elsewhere.** It used to free the local engine right away, even while
  another chat, agent, code or group run was still
  generating on it, and that run then ended with "Connection dropped". The
  switch to Cloud itself still happens right away; only that memory cleanup
  now waits until every local run in progress has ended (normally, by Stop, or
  by failing), and it is skipped entirely if you switch back to Local before
  that.
- **A workflow now tells you where it stopped instead of claiming success.**
  A step whose web search or page fetch failed, or whose model answered
  nothing, ends the run with "Workflow stopped at step 2 of 6: ..." instead
  of carrying on and finishing with "Workflow complete"; a run that really
  did finish leads with its actual result rather than the "Saved to memory"
  receipt.
- **Reinstall trainer in Character Studio now opens a confirmation dialog
  first**, showing the current trainer folder, instead of starting the
  reinstall the moment the button is clicked. A reinstall never changes the
  trainer folder itself.
- **The model marks now live in the model list only**, the line above the
  message box is gone; the Flash notice sits next to the Agent toggle.
- **At a narrow window width, picking a model or opening the sampling or
  plugins popups no longer shifts the whole chat sideways.** The shared chat
  area allowed the browser to scroll it into view when a clicked control sat
  partly off screen. That area no longer accepts a programmatic scroll, so it
  stays put.
- **A brand new chat no longer shows a blank screen.** Right after "+ New
  Chat", with the side panel open, the main area could stay completely empty:
  no greeting, no history, nothing, even after a full reload of the same
  still-empty chat. Only switching to another tab and back brought it
  around. The greeting now shows for that chat from the first frame, the
  same as before the first message is sent.
- **Update ComfyUI in Settings now asks before it starts.** It stops LU's own
  running ComfyUI first if there is one, refuses while a ComfyUI this app did
  not start or one that is generating something holds the port, and puts the
  ComfyUI code back to the version it had before if you cancel partway
  through; Python packages already installed during that attempt are not
  undone.
- **Running a workflow from chat ("run workflow ...") now shows its own
  progress**, clickable and expandable exactly like a tool call: every step
  listed as waiting, running, done or failed, each finished step's result, and
  the currently running step's answer streaming in live. Before this it showed
  no more than three static dots for the whole run, sometimes several minutes,
  with no way to tell it was still working. A model step also now has an
  upper bound on how long it may reason before it must answer. Stop ends the
  progress block visibly instead of leaving it looking like it is still
  running, whether Stop was pressed mid-run or the app was closed and
  reopened partway through.

## [3.0.0] - 2026-09-13

**Cloud: 24 chat models with no refusals, 10 open video models, 3 open image
models. We measured refusals in 5% of answers. Subscribers get about 1.5x more
credits per euro and 500,000 free Flash tokens a day. Start at
lu-labs.ai/pricing.**

Measured instead of promised, and Flash chat that costs nothing on an active
plan. Every cloud chat model was asked the same question twice, only the ones
that answered in full carry a mark, your account has a content policy setting
of its own, and the sampling controls sit next to the prompt.

**Known in this release:** a 2 GB card can still turn a small model into
garbage. The layer count is measured against the card now, and the engine reads
its own first answer and restarts itself if it looks wrong. That should help,
but no such card exists in the house, so the report stays open.

### Added

- **A "No refusals" mark that comes from a measurement.** 24 of the 46 cloud
  chat models we measured answer in full without refusing, and only those carry
  the No refusals mark. Each model was asked the same question twice and judged
  on what came back, not on whether the reply started with a refusal sentence.
  The catalogue holds 47 chat models; the one that joined after the run carries
  no mark until it is measured. The mark sits in the model picker and above the
  prompt, and it never comes from the model name.
- **A Flash class that costs nothing inside the apps.** 12 of the 47 models in
  the catalogue cost no credits at all in chat on an active paid plan, up to
  500,000 input and output tokens per day. API keys keep paying credits, and
  accounts without an active plan keep paying credits too. The ceiling resets at
  00:00 UTC, one free request runs at a time, and the picker marks those models
  with "No credits".
- **A content policy setting in your account:** Strict, Standard, or off. It
  applies to cloud image and video. The setting reads the same in the desktop
  app and in the browser because it is one setting behind one route, not two
  copies.
- **Ten video models and three image models without a built-in content
  restriction.** Every one of the video ones starts from a picture, so in the
  browser studio a finished image has an Animate button that carries it straight
  over.
- **Sampling controls next to the model picker:** temperature, top P and answer
  length. They open as a small window above the prompt row, with an x to close
  it, so nothing you are typing moves out from under you; Escape and a click
  beside it close it too. The current temperature is visible on the closed
  button, and one reset covers all of them. A help line says that reasoning
  models accept these and react less to them, instead of hiding the control. Top
  K stays on the settings page, next to the backends that read it.
- **The context window of a custom OpenAI-compatible backend is asked for, not
  guessed.** The number carries a label saying where it came from, the context
  picker is available for your own backend, and no guessed budget is sent as a
  maximum answer length any more.
- **A beginner handbook on locallyuncensored.com:** a hub plus ten chapters,
  from what it is and installing through chat, agent, code, create, cloud,
  settings and a glossary. Every fact in it comes from the code.

### Changed

- **The default persona has a real role again.** It used to be an empty system
  prompt, and an empty prompt is not neutral: the model falls back to whatever it
  was trained to be. It now states the role and nothing else, no content rule in
  either direction, and Chat, Agent and Coding all send that same baseline.
- **The old "(unrestricted)" suffix is gone from model names.** It was
  inherited, it was wrong on at least two models, and a name is not evidence.
- **The Cloud switch says what it is for, with real numbers.** Hovering it gives
  three lines in a fixed order: 24 of the 46 chat models we measured answer
  without refusing, 12 of the 47 in the catalogue cost no credits at all in chat
  up to 500,000 tokens a day on an active paid plan, and 47 chat, 10 image and 11
  video models run on our GPUs. Every number is tied to its source by a test, so
  the switch cannot promise a number the catalogue no longer has.
- **Your memories are two separate collections now,** one on this machine and
  one on your signed-in account, and they stay apart. A memory can be marked
  sensitive and is then left out of requests to a model, a memory can carry a
  project so it is only used inside it, and an answer shows which memories it
  used. Syncing the account collection stays off until you tick two boxes that
  are never ticked for you, nothing syncs in the background, and a sync run can
  be cancelled. Marking a memory sensitive does not remove copies that already
  went to the cloud, and the panel says so.
- **Remote Access starts, stops and restarts in order.** The commands no longer
  overlap, stopping withdraws access straight away, and a changed memory
  invalidates the sessions that were built on it.
- **The package descriptions say what the app needs and what it does on the
  network**, instead of promising a zero-setup, device-only install.
- **The refusal message for cloud media names the setting and where to find
  it.** It used to say hosted rendering cannot do this at all, which sent people
  to a local backend for something that was a setting.
- **Models under 7B carry a plain warning in the catalogue** and are no longer
  offered as a starting pick for chat.
- **The pricing page lists the credit packs before the plans.**
- **locallyuncensored.com no longer promises a Mac build**, and two
  documentation pages give the video model count of the current catalogue.

### Fixed

- **Every start checks for updates again, and the sentence about being up to
  date carries its date.** The check on startup ran into the six-hour cap and
  was swallowed on a machine that was already current, so someone who restarts
  the app often never got an automatic check at all. The tester started LU three
  times in a row and nothing went out. Startup now forces a check once the last
  one is more than fifteen minutes old, and the settings panel prints "Last
  checked 3m ago" next to the sentence about being up to date, so you can see
  whether anyone looked.
- **The Dismiss button on the stale model banner tells the truth.** It used to
  say the notice would come back on the next launch, and it has not worked that
  way since 2.5.9. It now reads "Dismiss. It comes back only when a different
  model goes stale.", which is what the code does.
- **Training a character LoRA no longer dies with the libuv error on Windows.**
  The trainer started a distributed launcher that switched to multi-GPU mode on
  machines with two cards; it now runs the training script directly, on one
  card. The error text of a failed run is readable, scrollable and can be
  copied.
- **When the engine exits before it serves, the log file says why:** the full
  command line, the exit code, the memory the card reported and the number of
  layers it was given. A card that is too small for the model gets a measured
  layer count instead of all of them, and if the first start still fails the
  second runs on the processor and says so, in the status line and in the engine
  details.
- **The engine checks its own first answer and restarts itself if it is
  garbage.** Right after the health probe it answers one fixed question on this
  machine only, and a classifier judges the shape of the reply. If it looks
  wrong the engine restarts, and the app says which step it took.
- **Stop means stop.** A finished background agent no longer wakes the main
  agent into a hidden turn, a stop between two loop passes ends the loop, and a
  shell command the agent started is killed with it.
- **The agent can leave a workspace folder.** The x on the folder pill drops it
  and forgets the remembered default with it, in new chats and in old ones, and
  the agent falls back to ~/agent-workspace until you pick a new one. That is
  what made changing the folder feel useless before. Remembered folders are
  checked before they are used, the folder lock names Stop as the way out and
  only holds during a real run, and one folder is one entry in the list.
- **The Code tab says why a folder was refused** instead of accepting it and
  then failing on every file. A turn cut off at the token limit now says so in
  the answer, with the plan step it stopped on, instead of ending without a
  word, and the Agent tab reports a cut-off turn the same way.
- **The Expert section in Create is hidden when it has nothing to show** for the
  current lane, instead of being shown empty, and in local mode it keeps its
  controls.
- **The MLX image install that finished at the promised size with two empty
  folders: the fix is in the source, not in this release.** The installer reads
  the file list and the required set from the repository itself, spots missing,
  empty, stale and truncated files, refetches only the broken one and checks it.
  This is GitHub 127. MLX runs on macOS only, and 3.0.0 builds Windows and
  Linux, so no download from this release carries it.
- **The Get button asks the running image backend where its models go**, so a
  download lands in the folder the picker actually reads, including installs
  that were started with their own base directory.
- **Repairing the image backend proves the start instead of claiming it.** After
  the packages it runs the card through one real operation and then the
  backend's own quick test, and a failure reports the real error line rather
  than success.
- **The refusal when a model site needs an API key points at the right screen**,
  naming the exact settings section that holds the key field.
- **A LAN OpenAI slot is no longer treated as a paid provider**, so its answers
  are not capped as if they cost money.
- **Linux: the window workarounds only run under Wayland now**, X11 is left
  alone, and the console names the off switch for each one. A local copy of the
  window library on the system is preferred over the bundled one.
- **The runaway question mark output from the local engine has a stop.**
- **A visible notice that personas travel from PC to phone and not back**, and
  workspace security wording that describes the real boundary instead of a
  stronger one.
- **One typographic dash removed from shipped interface text**, plus two small
  English fixes: the button text in the Local API panel, and the Remote Access
  help text, which said three switches where there are four.

## [2.6.9] - 2026-09-08

### Fixed

- **The update works on Arch, and on every other Linux install the built-in
  updater could not reach.** LU from the AUR package `locally-uncensored-bin`
  is our Debian package unpacked into `/usr`, and the updater could not tell
  the two apart: it downloaded a `.deb` and ran `dpkg` on a system that has no
  `dpkg`, so the password prompt arrived and the install failed right after the
  password was typed. LU now asks the package managers on the machine who owns
  the running file. Where the answer means the updater cannot install anything
  (a package manager owns the files, nothing owns them, or the AppImage sits in
  a folder you cannot write to), Download and Restart do the work themselves: a
  signed AppImage lands in your own data folder, the start menu entry points at
  it, and LU starts again from there. After that, updates are the usual one
  click. Reported by a customer on Arch.
- **The top navigation and the Create toolbar are back to the 2.6.7 layout
  after feedback on Discord: entries stay where they are.** 2.6.8 turned both
  rows into a wheel that scrolled the selected entry into the middle, so every
  click moved the other tools somewhere else and the ones at the edge were cut
  off. All six views and all twelve Create tools are back to fixed positions,
  fully readable, and the Create row wraps onto a second line in a narrow
  window instead of hiding anything.
- **The Context menu in the chat opens in full instead of being cut off.** It
  always opened downwards, and its button moved to the bottom of the window in
  2.6.8, so half the list ran past the edge of the panel and the largest sizes
  could not be picked. It now measures the room it has and opens upwards when
  the space below is too small, scrolling inside its own box on a short window.

## [2.6.8] - 2026-09-03

The compact release. A long conversation folds its older turns into a summary
instead of running out of room, an agent hands work to background agents that
run while you carry on, a reasoning model gets a dial for how much thinking a
reply may pay for, every local model answers on one OpenAI-compatible address,
and the built-in engine has a name of its own, the LU Engine.

**Known in this release:** after you switch Cloud off, the LU Engine stays stopped until you press Use on your model under Models. One click, a few seconds. A later release brings the engine back on its own when Cloud goes off.

### Added

- **The Cloud switch counts its presses anonymously.** Which way it was
  pressed (gate, armed, into Cloud, back to Local), platform and app version
  go into a daily count on lu-labs.ai, nothing else. It tells us whether
  anyone finds the switch; local mode stays silent otherwise, and the privacy
  text in Settings names the one call.

- **Compact mode.** Type /compact and the older turns of the conversation are
  folded into a summary while the recent ones stay as they are; a few words
  after the command say what the summary should focus on. The chat model
  writes the summary itself, in the language of the conversation, and it is
  told never to translate, round or reformat a value. A block in the
  transcript shows how many messages were summarised and how many tokens every
  following request saves, the full conversation stays on disk, and a second
  compaction keeps the first one instead of dropping the start of the chat.
  Auto-compact is opt-in and off by default: set a percentage under Settings,
  General, Generation and the older turns are summarised once the context is
  that full, with a note in the transcript every time it fires. On a thinking
  model the summary is written with thinking off, because with it on the whole
  budget went into the thinking channel and no summary came out.
- **Background agents.** In Agent and Code mode the agent can delegate a self-
  contained task to a sub-agent that works in the background while the main
  run goes on. A panel on the right lists the running agents, and when one
  finishes the main agent is woken and continues with the result, whether the
  chat runs on a cloud model or a local one. Delegating asks no question of
  its own: a sub-agent inherits the permissions of the run that started it,
  every tool call it makes still passes the same gate as the main run, and a
  read-only run stays read-only. A sub-agent that hits its step cap or is
  cancelled hands back what it gathered on the way, marked as raw material
  rather than an answer. The caps have their own section under Settings,
  Agent, Sub-agents.
- **An effort control beside the Think button** on a reasoning model. Low,
  Medium and High, with Max on GLM 5.3, set how many tokens a reply may spend
  on thinking. The steps come from the server for each model, so a model that
  offers two shows two, and a model with none keeps the plain Think button it
  always had.
- **GLM 5.3 (Pro) and GLM 5.3 Flash (Hosted)** in the cloud catalogue.
- **A Local API.** Settings, Local API starts an OpenAI-compatible server on
  your machine, port 8129 by default, that lists every local model from the LU
  Engine, Ollama and LM Studio under one address and streams the answers
  through, so any tool that talks to OpenAI can talk to your own machine. It
  listens on localhost unless you allow the LAN, always asks for a token, and
  the browser origins that may call it are an allow list that starts empty. A
  tool on that API can also ask which LU tools this machine has, behind the
  same token.
- **A command palette on Ctrl+K** over the actions the app already has: the
  views, the keyboard shortcuts, switching models, the side panel, and Quit
  once you search for it. Right-click menus follow one pattern across the app.
- **First-run setup runs in a small window of its own,** centred by the
  operating system, and the main window appears the moment setup is done.
- **Three uncensored models that were missing:** Qwen 3.8 27B Heretic, Gemma 4
  12B Heretic and Qwen3-VL 8B Abliterated, the first uncensored image
  understanding that fits an 8 GB card. GLM 5.3 is in the local catalogue in
  the one variant the LU Engine can open; the Flash files carry an
  architecture llama.cpp does not read yet, so they wait. A catalogue check
  now reads the file header of every entry so that a model the engine cannot
  open never gets listed again, and Hunyuan 3 295B left the list for that
  reason.
- **The collapsed side panel is an icon rail** with a way back rather than a
  gap, the chat column can be dragged wider, and a chat title is shown in full
  instead of cut at 30 characters.
- **Document Chat works in Cloud mode.** Your files are indexed on your own
  machine and only the passages that match your question travel with the
  prompt. If indexing runs on an Ollama you pointed at another machine, the
  panel says so.
- **The side panel folds away**, and while it is closed your latest chats sit
  on the main screen. They belong to the panel again the moment you open it.
- **A Use button on an Installed tile.** It starts the LU Engine and loads that
  model, rather than leaving you with a file you cannot reach.
- **OrcaRouter's Qwen 3.8 27B Uncensored, and a Hugging Face token that
  model downloads use.** The six uncensored 27B rows in the Model Manager now
  come from OrcaRouter's abliteration (bartowski's ungated GGUF requant of it,
  vision projector included), and Ollama users get OrcaRouter's own tag with
  the projector inside. OrcaRouter's original GGUF repo is gated on Hugging
  Face and answers HTTP 401 to anyone without an accepted licence and a token.
  A download that runs into that now says so and names the fix instead of
  "trying again cannot help": accept the licence on the repo page, put a
  Hugging Face token under Settings, AI Backends, Hugging Face token, and
  start the download again. That field exists on Windows and Linux now (it
  lived only inside the Mac media panel), and the token goes to
  huggingface.co with every model download, which also lifts the throttle
  the hub puts on anonymous downloads.
- **The Coding Agent's working directory can be removed again.** There is a
  Remove button beside the folder picker and one in the header, both locked
  while a run is going, and picking a different folder moves the current chat
  over to it.
- **The prompt history in Create can be cleared.** Every entry has its own
  remove button, and Clear all at the top of the list wipes the lot after a
  second click.
- **The CivitAI API key has a field again**, under Settings, AI Backends,
  Model Storage. Downloads from the CivitAI search carry the key, and a
  download CivitAI refuses names the missing setting instead of a bare error
  number.
- **Settings shows the port the LU Engine actually runs on**, and the Model
  Storage folder says when it could not be read or was too big to scan.
- **A ComfyUI install or repair can be cancelled from Settings**, and it keeps
  showing its progress while you look at other settings.

### Changed

- **The built-in engine goes by LU Engine.** Same engine, same models, same
  folder; only the name in Settings, in the model list and in the messages
  changed.
- **Model Storage names the backend each folder belongs to.** It used to be one
  field labelled "(auto-detect)" over a paragraph naming all three backends at
  once. There are three rows now: the LU Engine folder you set, with the folder
  that is actually being read spelled out while the field is empty; the LM
  Studio folder, read only, or a sentence saying LM Studio is not installed;
  and Ollama, which keeps its own store and has no folder to set.
- **The cloud model list keeps one fixed order.** The upstream provider
  shuffles its own list on every call, measured three times and returned in
  three different orders, so a new chat opened on whatever happened to be
  first. The catalogue order decides now.
- **The model the open chat ran on lost its chip in the composer row.** It is a
  small dot on the corner of the model picker, the full sentence sits in the
  picker tooltip, and the dot only appears when the chat on screen and the pick
  beside it disagree.
- **On the Mac, picking a model folder under Desktop, Documents or Downloads
  says up front that macOS will ask once for access to it**, instead of letting
  that dialog arrive out of nowhere on the first scan.
- **LU starts MCP servers through npx and uvx only.** The app window used to
  be allowed to launch node, python, deno, bun, docker and the package
  managers as well. Each of those takes a one line script or hands out the
  whole disk, so any scripting bug anywhere in the window was code execution
  on your machine. A server set to run through another launcher is named
  before the start, with the two launchers that work and the option of
  starting the server yourself and connecting by URL, and the message has a
  button that takes you to the entry.
- **One scale for the whole app.** It was rendered in four at once, an 18.4 px
  root and three separate zoom factors, so a corner radius in Chat came in
  five sizes. The light theme got the contrast fixes it was missing, the focus
  ring passes the contrast rule on every background, the cursor blinks while a
  reply streams, and Copy says that it copied.
- **The tabs at the top and the tool row in Create scroll instead of
  wrapping.** The entry you picked sits in the middle, the ones beside it fade
  towards the edges, and a click slides your pick to the centre.
- **A run on a local model waits for the card instead of fighting for it.**
  Two local runs on one card swap memory back and forth and both end up slower
  than one, so a second local run queues and starts when the first is done.
  Cloud runs start at once.

### Fixed

- **The prompt box sits in the middle of what belongs to it.** Clicking into
  the message field no longer draws a thick violet ring around the text line;
  the soft violet border around the whole box in Cloud mode stays. The row
  with Agent, context, memory and export lines up with the box instead of the
  chat edge, the transcript may reach 40% past the box on each side, the
  "Ask LU anything" landing in Code sits in the middle of the screen, the
  Quality and Aspect row in Create (and Edit strength and the rest) is
  centred over the box, and the Create subcategory row has a little air to
  the main tabs.
- **A ComfyUI that will not start names the cause.** A missing Visual C++
  runtime, or a graphics driver older than the PyTorch that was installed,
  used to arrive as "the Python environment looks broken" next to a Repair
  button, and neither of those lives in the folder Repair rebuilds. The
  message now says which of the two it is, and LU no longer starts a repair
  that cannot fix it. Reported on Discord as ticket 0007.
- **Every Python step LU starts now runs with UTF-8 output.** One step out of
  eight did before, so on a Windows account whose name falls outside the
  English alphabet, a single character in a path was enough to end an install
  or a probe partway through. Reported on Discord as ticket 0003.
- **AMD cards on Linux report their memory size without ROCm installed.** LU
  read AMD memory only through rocm-smi, which comes with the ROCm developer
  packages rather than with the driver, so the card was found and its size was
  not. The size comes from the kernel now. An integrated AMD chip is
  deliberately left out, because the number it reports there is the fixed
  carve-out rather than what it can actually use. This reading has now been
  measured on a rented AMD Instinct card, where the kernel number and the
  number ComfyUI reports for itself are the same number.
- **An AMD compute card shows up at all now, and with its name.** A card built
  without a display output reports itself to the system as a processing
  accelerator rather than as graphics, and LU accepted only the three graphics
  classes, so an AMD Instinct was missing from the hardware list entirely.
  rocm-smi also names its columns differently from one version to the next, so
  the card that was found came out as "AMD GPU" and its gfx target was thrown
  away, although rocm-smi prints it in a column of its own. Measured on a
  rented AMD Instinct MI325X: the card is listed with its name, its gfx target
  and 255.7 GiB, PyTorch installs from the ROCm channel LU picks, and Create
  rendered an image, a video, a song, a 4x upscale and a cutout on it.
- **When ComfyUI does fall back to the processor, the reason it names is the
  real one.** The only line in the output panel read "No NVIDIA driver
  detected", which is the wrong hardware to name in front of someone holding
  an AMD card: what actually decided it was the PyTorch inside that ComfyUI
  environment reporting no usable card. The line says that now, it says
  something different when the check did not answer at all, and it names the
  switch when you chose Force CPU yourself.
- **German phrasing reaches the chat tools.** Plain chat offers its tools only
  when it recognises what you asked for, and its German half misread two
  common cases. The filler word "mal", which turns up in most casual German
  sentences, was read as the command to paint, so ordinary questions were sent
  to image generation. And no German word for the internet was on any list, so
  a request like "schau im Netz nach" matched nothing and the model answered
  from memory instead of looking anything up. Both are fixed, along with two
  smaller gaps in the German verb lists.

- **The LU Engine moves to a free port when 8127 is taken** or reserved by the
  system, and after a start that fails it retries once instead of giving up
  until the next restart. The next start begins at 8127 again rather than
  staying on the port it had to move to. Windows port reservations are marked
  as researched rather than proven, because no such reservation could be staged
  here.
- **A chat model you downloaded stays visible as Installed** even while the
  engine is not running, and it becomes the active chat model the moment the
  download is done. Measured on the Windows box on 2026-09-05: the download
  started the engine on the new file, but the picker still named the previous
  model, so the first message would have swapped the engine straight back,
  and a Use click restarted the engine on the same file because the path the
  frontend had glued together did not match the one the engine lists. The
  download now goes through the picker's own activation, so the path comes
  from the model list, the picker follows, and the engine starts once. The
  Installed search also answers to catalogue spelling now, so "Llama 3.2 3B
  Abliterated" finds Llama-3.2-3B-Instruct-abliterated.Q4_K_M.
- **A running LM Studio stays in the model picker** after the chat has moved to
  the LU Engine. Its models keep their own heading, and picking one hands the
  local slot back to LM Studio with a line that says so. The way back is one
  click, the same as the way out.
- **The folder you set under Model Storage is read now, not only written to.**
  Every GGUF in it, up to four levels down, appears under Installed and loads
  from where it lies, whichever backend is serving your chat. On a machine
  running Ollama, a GGUF in that folder was found on disk and then listed
  nowhere.
- **Subfolders named the way ComfyUI names its own**, loras or checkpoints, go
  to ComfyUI through its extra model paths at the next start, so models on a
  second drive show up there.
- **The ComfyUI installer checks that the environment it just built can import
  ComfyUI**, installs what is missing, and names a missing Visual C++ runtime
  instead of ending in a silent crash.
- **Repair environment runs the same check with a time limit and a Cancel
  button that stops it**, and the trainer setup stopped blaming the network for
  failures that had nothing to do with the network.
- **Character Studio sets itself up on a machine whose Python is too new.**
  The trainer needs Python 3.10 to 3.12 and LU built its environment from
  whatever Python was newest, so a machine with 3.14 failed at step 4 of 4 on
  every update since August, and 2.6.7 called it a network problem. The setup
  now picks a Python from that range on its own, installs 3.12 on Windows when
  there is none, rebuilds an environment that was built from the wrong one,
  and the failure text under the button is no longer cut after one line.
  Discord ticket 0004.
- **The local trainer no longer hands out instructions.** Every dead end on
  the way from Set up trainer to a finished character either fixes itself or
  says exactly what is wrong: the trainer source arrives as an archive, so no
  git is needed on the machine; the drive is checked for room before the first
  byte instead of after 2.5 GB; a download that breaks off is retried twice; a
  PyTorch whose Windows runtime library is missing gets the Visual C++ runtime
  installed by LU instead of a link; the setup proves that PyTorch loads
  before it calls the environment ready; a card below 12 GB is told so before
  ten minutes of caching; the local chat model is paused for the run and
  comes back afterwards, so it no longer squats the memory the recipe needs;
  and a run that still runs out of memory on the card says what to close.
  The step counter moves with every training step instead of once per epoch
  (it used to sit on 0 for twenty minutes), and the base-file download keeps
  showing its progress when you leave the tab and come back. Lines from winget
  stay out of the note under the button.
- **AMD on Windows is read from the HIP SDK itself.** The only ROCm probe ran
  rocm-smi, which the Windows SDK does not ship, so an installed ROCm went
  unseen. LU reads HIP_PATH and hipinfo now and names the card architecture,
  and an image run that fails names that architecture and get_arch_list instead
  of a HIP traceback. Marked as researched rather than proven, because there is
  no RDNA4 card here.
- **The Model Manager stopped putting system RAM in the GPU field.** ComfyUI
  reports system memory on a CPU device in a field called vram_total, so a
  machine with 64 GB of RAM read as if it had 62 GB of video memory.
- **The Linux packages ask for the libraries the LU Engine links against.** The
  deb and the rpm named the desktop libraries but not libvulkan1 and libgomp1,
  so on a machine without them the install went through, the engine died in the
  loader, and the message blamed your graphics card. The missing library is
  named now, together with the command that installs it. The AppImage needs the
  Vulkan loader from your system as well, because an AppImage cannot carry that
  one itself.
- **On the Mac, LU stopped searching your whole home folder for a ComfyUI it
  never runs there.** That search touched the Desktop and Music folders, so
  macOS asked for access to Apple Music and to the Desktop at first launch, and
  the window sat on LOADING while the search ran. On Windows and Linux the same
  search moved off the main thread, so a slow disk no longer freezes the
  window.
- **Error messages from Windows arrive in English**, and a ComfyUI
  requirements.txt that cannot be used is named instead of silently skipped.
- **Character training no longer stops at the first step on a Windows machine
  with more than one GPU.** torch asked for libuv, which the Windows wheels do
  not carry, and the run died with "use_libuv was requested but PyTorch was
  build without libuv support". LU now sets USE_LIBUV=0 for every trainer
  process on Windows. Reported in GitHub #121; nobody here has two GPUs, so
  this is the documented torch workaround rather than a measured fix.
- **Coming from 2.6.7 you find your conversation list open, as you left it.**
  A fresh install now starts with the panel closed, an update inherited that
  at first, and every existing chat sat behind an unlabelled icon button.
- **Chat works without a mouse.** The conversation list is a real list you can
  tab through and open with Enter, a dialog closes on Escape and keeps the
  focus inside while it is open, a preselected button is never the destructive
  one, Escape closes every overlay, and animation follows the reduced-motion
  setting of your system.
- **The read-only commands tell the model what it may still run.** /review,
  /plan, /diff and the others said the model had no shell at all, while the
  inspection commands, git status, git log, git diff and the like, were
  allowed the whole time, which left /review unable to find the changes it was
  asked to review.
- **The Memory section reads its own Markdown export again.** Since 2.5.9 the
  export wrote a comma between title and body while the import still looked
  for a dash, so an exported file came back with half a raw line as the title
  and the tags, source and date gone.
- **A model you did not pick is announced.** When a provider goes away and the
  model you had chosen goes with it, the app falls back to the first entry it
  finds and says so in the status line above the message field. A click on a
  model that is still loading says what it is waiting for.
- **A click on a file the LU Engine cannot open no longer costs you the engine
  that is running.** The first bytes of the file are read before anything is
  stopped, and a file without the GGUF mark is named and left alone instead of
  taking down a healthy engine for two failed attempts.
- **Updates no longer leave the previous frontend behind.** On a machine that
  has been updating since April this frees around 130 MB and a thousand files.

## [2.6.7] - 2026-08-31

The repair release. Every fix went back to a fresh tester who did not know what
had been changed, driving the real installed build on Windows, and whatever
they broke went into the next round. That loop ran seventeen times.

### Added

- **A ComfyUI that dies while the app is running restarts itself.** Three
  attempts with a growing pause between them, and the render that triggered it
  carries on afterwards. A ComfyUI on a foreign host, a missing installation
  and an environment broken at import each get their own sentence instead,
  because none of those is ours to restart.
- **An idle app notices that ComfyUI is gone.** It used to sit silent for as
  long as you left it and heal only at the next render. A quiet line now
  appears within about half a minute: a ComfyUI the app started restarts with
  your next render, a remote one does not, and the line says so without
  promising a rescue.
- **A cold ComfyUI start explains itself.** Once the loading phase passes
  twelve seconds a line tells you the model is going into memory. Warm runs and
  small checkpoints never see it.
- **A test button under Settings, AI Backends** checks the built-in engine end
  to end, repairs what it can and then reports what it found.

### Fixed

- **The very first render after starting the app shows its loading texts
  again.** The websocket was connected after the job had already been
  submitted, and that first connect costs up to five seconds, so every phase
  message in that window was lost. On the test machine that meant 74 seconds of
  model loading with nothing on screen but Queued.
- **Sampling is only claimed once ComfyUI is really sampling.** The sampler's
  executing event arrives before the work starts and the app read it as step
  one, so the progress line ran forty seconds ahead of reality.
- **A still image gets an honest decode line.** It used to announce that frames
  were being decoded and call that the last long stretch. A picture has no
  frames, and on measurement it is the shortest phase of the render.
- **The loading line stopped promising a warm cache.** Measured on a large
  model, a warm run took 22 seconds against 23 cold, because ComfyUI unloads
  after every render.
- **A dismissed cross origin warning stays dismissed.** The bar came back after
  every single image because nothing remembered the click. It is now tied to
  the host and ComfyUI version that caused it and survives a restart.
- **The render watchdog stopped throwing away work that was still running.** It
  asks ComfyUI whether the job is still queued before calling five quiet
  minutes a hang, allows more time while a first checkpoint is loading, and
  gives a render in its final steps another minute.
- **A render on the processor leaves the chat engine where it is.** ComfyUI
  started with the CPU flag touches no video memory, so unloading and reloading
  the chat model around every picture cost a wait for nothing.
- **The CPU notice names the reason it is actually there:** Force CPU with the
  way back, no usable card, or an AMD card without ROCm. AMD help stopped
  showing up on NVIDIA machines.
- **A downloaded model shows up as installed** (#113). A bundle counted as
  installed as soon as a neighbouring bundle had brought one shared file along.
  Every file is checked now, and after a download the app keeps looking in the
  background for a full minute instead of giving up after four seconds.
- **The Installed inventory names every ComfyUI folder**, not only checkpoints
  and diffusion models. LoRAs, VAEs, text encoders, CLIP vision, ControlNet,
  upscalers, embeddings and style models were invisible.
- **Your own file stops disappearing behind a catalogue price.** A model whose
  catalogue entry lists 16 GB was thrown away as a partial download when the
  file on disk was smaller. Pickers still filter, the inventory never does.
- **The counters stopped reporting a zero they had not counted**, and a deleted
  model disappears from the list immediately instead of standing there for
  another ten seconds.
- **The built-in engine starts on a fresh installation** (#118). Text downloads
  picked their destination from the model you were chatting with, and a fresh
  install has none, so the file landed where the engine never looks. An engine
  that cannot start now says why in under a second instead of timing out.
- **Adding your own provider no longer erases the built-in engine.** It kept
  the same slot, so the card vanished without a trace. The built-in engine now
  waits in standby with a labelled way back, and Disable on whichever provider
  holds the slot hands it over.
- **A disabled provider keeps its card and an Enable button**, and a provider
  you added can be removed from the interface. Until now the only ways out were
  Disable or a full reset.
- **The LM Studio button in the picker sets the provider up.** It started a
  server that nothing was configured to ask, so the model list stayed empty.
- **Hints point at controls that exist.** Four of them named a power button on
  Create, a gear icon and other things that were never there. Open Settings now
  lands in the right tab with the right section already open.
- **The LU Cloud row shows the same five models every time** and names how many
  more there are. The order was whatever arrived first from the server.
- **Thinking reaches the engine.** The switch was set, the engine never saw it,
  and no bubble appeared. The signal now goes out on every path, including
  group chat, workflows, A/B compare, the benchmark and the phone relay.
- **Local models with strict chat templates stopped failing.** Tool results and
  repeated roles broke templates that refuse anything but a clean alternation,
  which is where a long chat or a group round from turn two would die. The
  system prompt reaches the engine first and in one piece.
- **Every answer records the model that wrote it**, so an old conversation
  stops claiming a model it never ran on. Your pick also survives a restart.
- **One stray click can no longer move the app into the cloud and bill you for
  it.** Going into the cloud takes a second click within six seconds, going
  back out stays a single click, and the composer shows which side you are on.
- **The engine refuses a request that names a model it is not holding**, and
  group chat loads each speaker's model before that speaker's turn.
- **An agent workspace folder follows the chat, not its title**, so an
  automatic rename no longer loses the folder.
- **AMD cards on Windows are detected again.** The check ran through wmic,
  which Microsoft removed in the August 2026 update, so on a current Windows
  the app believed there was no AMD card at all. It reads the registry now,
  with wmic left as a fallback.
- **Windows with an RDNA3, RDNA3.5 or RDNA4 card gets AMD's own ROCm wheel
  channel** instead of processor wheels and a recommendation for the frozen
  DirectML build. Marked as researched rather than proven, because we have no
  such card here.
- **On Linux, AMD cards the wheels do not cover stay on the processor build
  honestly.** They used to pass detection, report a working device and then
  crash on the first kernel. The trainer refuses on them with a reason instead
  of starting a run that cannot finish.
- **Cards from Turing up use the cu130 channel** with cu126 as the fallback,
  checked live before it is chosen.
- **The Debian and Ubuntu package stopped fighting llama.cpp over a file name**
  (#120). The engine ships as lu-llama-server, so both packages can be
  installed in either order.
- **Updating no longer risks your chats.** The app waits for open chat writes
  before handing over to the installer, saves a fresh copy at that moment, and
  keeps three rotating backups instead of one.
- **Closing the window gives the video memory back.** The cross hides the app
  by design, but the engine sat there holding its model. After a short grace
  period it unloads and comes back on its own when you use it again.
- **The engine dies with the app on Windows.** A crash used to leave it behind
  holding several gigabytes of video memory, and every restart leaked a handle.
  A crash also leaves a witness file now.
- **Voice input says what actually went wrong.** A dead transcription server
  reloads its model by itself and reports honestly if it cannot, refusals reach
  you in their own words, and the microphone hint no longer blames a setting
  the app had switched off itself.
- **Error messages are English on a non English system.** Windows writes its
  error text in the system language and we were passing it through. The number
  stays, the text is ours.
- **A very long hosted conversation is trimmed to fit instead of refused.** The
  system prompt and the newest turns are kept, tool call pairs are never split,
  and only if the provider still refuses does a clear message with the code
  context_exceeded appear.

### Security

- **The model size check stopped following file names it was given.** A name
  like an absolute path made the check look at that file and answer whether it
  exists and how large it is, so a hostile or intercepted ComfyUI had an
  existence and size oracle for arbitrary paths on the machine. Names now run
  through the same filter the delete path uses, a rejected name gets the
  ordinary not found answer, and the app never touches the disk for it. Nested
  names such as `sdxl/pony.safetensors` keep working.

## [2.6.6] - 2026-08-22

The release that makes an agent or coding run cost less to do the same work.
The agent carries 15 tools instead of 31, sends far less context per step, and
tells you honestly what a step costs. The Code view got a mode menu, a plan
panel, a real file explorer and a prompt box that stops moving.

### Added

- **A mode menu in the Code composer.** Ask permissions, Bypass permissions or
  Plan mode, chosen per conversation with a global default in Settings. Bypass
  bypasses on a cloud model too, and a setting brings the cloud shell confirm
  back for anyone who wants it. Plan mode explores
  read only and stops for your yes; Approve and run then carries the whole plan
  out in the same run and never lands in Bypass on its own, showing the mode it
  will run in and the real commands first.
- **A file explorer in the Code view.** A real tree you expand folder by folder
  and widen by dragging its edge, with the width kept across a restart. Click a
  file to preview it: code with highlighting, images inline, HTML in a sandboxed
  frame with scripts off until you ask. node_modules, .git, target and dist stay
  out of the way.
- **Plugins in the Code header.** The Plugins picker left the prompt box and
  sits next to New as an icon with its name in the tooltip, so the action bar
  fits on one row.
- **Prompt caching for your own Anthropic key.** Requests carry cache markers on
  the system block, the last tool and the last stable message, so a repeated
  request reads from the cache instead of paying for the whole prompt again.
- **Qwen 3.8 in the Model Manager, with working vision.** The viral uncensored
  27B, the huihui abliterated 27B, the official 27B in Unsloth's dynamic quants,
  a 9B distill for small cards, and the two Ollama tags. A vision GGUF keeps its
  image tower in a separate mmproj file, so a catalog entry can now carry one:
  the download writes it next to the model as `<model>.mmproj.gguf` and the
  built-in engine starts llama-server with `--mmproj`. Ollama tags bring their
  own projector layer. The 9B distill is listed as text only, because its repo
  ships no projector.

### Changed

- **Agent and Code mode send far less context per step.** Older tool results are
  trimmed out of what goes upstream while the newest step is kept in full, the
  amount sent on a paid step is capped, and the stable half of the prompt stays
  put so the upstream cache keeps working across a long run. The coding tool
  catalog is leaner too. A setting turns the trimming off if a run ever
  misbehaves.
- **The plan moved into the right panel**, live above the file explorer, instead
  of sitting over the composer.
- **Plain chat, group chat and A/B compare cap the history they send to paid
  models**, so a long conversation stops getting more expensive without you
  noticing. A group round still bills once per model, and the composer says so.
- **The credits meter counts against the send cap**, not the whole model window,
  so its warning fires before a paid step gets expensive rather than after.
- **The agent works with 15 tools instead of 31.** Sixteen single purpose tools
  folded into the terminal tool, which now runs scripts through standard input,
  runs a job in the background, and summarises a test run, a git status or a
  commit. The retired names still work: calling one runs the right thing and
  says what to call next time, so nothing already learned stopped working.
  Measured on the wire the catalogue per step dropped from 6431 to 5118 tokens,
  and to 2887 in coding mode.
- **The Code prompt box is one row and stays one row.** The action bar no longer
  wraps onto a second line, and Send and Stop share one fixed slot, so starting
  a run no longer changes the height of the box you are typing in.
- **Nothing about plans sits at the prompt box any more**, on Chat, Agent or
  Code. The plan and the Approve and run card live in the panel beside the
  conversation, and the app checks every composer for itself so a plan cannot
  creep back in later.
- **An interrupted run keeps its plan.** The plan lives with the conversation
  and survives a restart, so the following turn is told how far it got and what
  the next open step is, instead of being asked to rediscover its own plan in a
  history that no longer holds it. A new message that clearly points elsewhere
  still wins.

### Fixed

- **An agent run stopped firing a hidden memory step on every round.** The
  automatic memory step on LU Cloud now runs only if you turn it on, and then on
  the cheapest capable model rather than the one you are chatting with.
- **Old images stop riding along.** A follow up in the same conversation no
  longer re-attaches pictures from many messages back on every later step where
  nothing looks at them.
- **A wiped chat database is restored instead of overwritten.** A hard crash can
  leave the browser engine discarding the whole chat store while everything else
  comes back, and the restore only ever looked at the other half. The app now
  restores the chats from its own backup on the next start, and the backup
  merges with what it already held rather than writing an empty snapshot over
  the good copy seconds after every launch.
- **A hosted chat past the message limit shrinks its request instead of dying.**
  Plain chat sends the whole conversation every turn, so once a conversation
  crossed the server's message count limit every further turn was refused and
  the chat was a permanent dead end. The client now halves the history it sends
  and retries when the server refuses on count, without touching the stored
  conversation.
- **Browser voice recording reaches the transcriber.** The recorded audio was
  refused as the wrong body type before the handler ever saw it, and both voice
  requests went out without the header every other call sends. The content type
  rule now has one carve out for the audio endpoint and stays strict everywhere
  else.
- **An invented link is caught by the app.** A URL in an agent answer that
  appears nowhere in what the model was shown cannot have come from a tool. The
  bubble labels it as unverified, and after a real tool success the agent gets
  one steer to look it up properly or take it back.
- **The trim notice stops planting a system message mid conversation.** Strict
  chat templates refuse a system message that is not the first one and the run
  died with "System message must be at the beginning", which is why it only ever
  happened once a chat had grown long. The notice now rides inside user
  material, and repeated trims no longer stack notices.
- **The built in engine grows to the context the run budgets for.** An agent
  turn carries the tool catalogue and outgrew the engine's 8192 start default,
  which no per request option can raise. The engine is now restarted at the
  smaller of the model's trained context and the agent ceiling before the run
  budget is read.
- **The engine's KV save follows the tokens, not slot zero.** The save asks the
  engine which slot really holds the conversation instead of always writing the
  first one, so the saved state is the history and not a husk.
- **A render evicts with manners.** The Create, music and video lanes now save
  the engine state and bring Ollama, LM Studio and the built in engine back warm
  after the render, instead of killing them and leaving the next chat turn to a
  cold start.
- **The LoRA trainer plans for an AMD card.** The trainer decided its
  environment from nvidia-smi alone and read that probe's silence as no GPU, so
  an AMD box got CUDA wheels that import fine, see no device and die in step 1.
  The wheel channel is now planned per vendor: ROCm on Linux, and a refusal
  before the clone and the 2.5 GB on Windows and macOS, where no such wheel
  exists.
- **A bundle card reads its own downloads** (#113). Video bundles share files, so one
  failed attempt on a shared file put a Retry button on every card and hid
  bundles that were complete on disk. The disk verdict is asked first now.
- **A finished download waits for ComfyUI in the Model Manager too.** A large
  file lands before ComfyUI's own scan has picked it up, so the model was simply
  absent from the Installed tab and every picker until a manual reload.
- **The credits meter counts the tool list it is sending.** That list rides
  beside the messages rather than inside them, so the estimate never saw it: a
  first coding step read 732 tokens against about 2.600 actually sent, and the
  gap was widest exactly where the meter otherwise sits near zero.
- **The meter stopped counting the run's own tool chain twice.** The hidden
  chain is written back at the end of a run and spliced in ahead of the
  assistant message, so everything already measured was added a second time and
  the first step of a fresh chat read as double its real size.
- **Agent, coding, delegated and phone runs are told what machine they are on
  and what the time is**, so none of them spends a step finding out. On a run
  started from your phone that sentence describes the machine doing the work
  rather than the phone in your hand.
- **Error messages are English again on a non English Windows.** Windows words
  its own errors in the system language and we passed that straight through, so
  a German machine showed a half translated failure in an English app. Every
  message the app writes now names the problem in English and keeps the error
  number, across the proxy, file operations, downloads, the engine, the
  installers and the shell. Output from a program we run keeps its own words but
  is labelled as that instead of standing in for our message, and a test fails
  any new code that hands the operating system's wording to the user.
- **A model imported from LM Studio brings its vision file along**, so vision
  survives the import instead of quietly disappearing, and projector files stop
  being offered as chat models in their own right.
- **Source pin tests read the same bytes on a CRLF checkout**, so a Windows
  clone can report the suite honestly.

## [2.6.5] - 2026-08-16

The release that makes updating possible again, plus the work you already
started surviving that update, and the Create tab telling the truth about
what it is doing.

### Added

- **LoRA selection in image generation** (#109). The image track
  has a LoRA section with a Rescan button. Characters trained in Character
  Studio and files dropped into the LoRA folder are selectable and
  stackable.
- **Bring your existing models along.** Settings, Model Storage, "Scan for
  local models" finds the models Ollama and LM Studio already store and
  links them into the app without copying, so the disk pays once and both
  apps keep working. Ollama's blob files are resolved to real model names.
- **Environment rebuilds show their work.** The rebuilding spinner reports
  download size, rate and time left instead of spinning silently.

### Fixed

- **Dragging files into the app works again on Windows** (#111).
  Dropping photos on the Character Studio board did nothing while picking the
  same files through the dialog worked. The window framework had claimed drag
  and drop for itself, so the page never saw the drop. That silently affected
  three places, not just the one that got reported: the training board, the
  chat composer and the RAG panel.
- **Download and install finishes instead of sitting on "Refreshing the model
  list"** (Two users). On Extend Video and Animate Image
  the transfer ran to the end and the card then never moved again. The files
  were on disk the whole time; ComfyUI was still scanning its folders, and
  nothing waited for it. The install now waits for the models to actually show
  up, counts the seconds so you can tell a wait from a hang, restarts the
  engine once if the scan never catches up, and if even that fails it says
  what is wrong instead of freezing.
- **Turning thinking off now turns it off on your own server too** (#112,
A user, who sent the diagnosis and a patch). We asked for the smallest
  amount of reasoning the OpenAI API allows, which some servers read as the
  largest, so the switch did the opposite of what it says. LU Cloud was never
  affected. The value walks down until the server accepts it, and how far it
  had to walk is remembered per model, so this costs one request and not one
  per message.
- **The update no longer trips over our own engine.** The installer stopped
  at a locked `llama-server.exe` and rolled back, which meant an app that
  could not be updated at all, every time, until you killed the process by
  hand. The installer shuts the engine down first. This one blocks every
  later update, so it is the reason to install this build.
- **An approved change actually lands, or says exactly why it cannot.** The
  approval queue deduplicated on a raw path, the drift guard could only ever
  reject, and the plan bar lied about progress. Approvals also survive a
  restart now, which matters because installing an update is a restart: work
  waiting for your yes is no longer thrown away by the thing meant to rescue
  it.
- **A request the model server refuses ends the run at once with the reason**,
  instead of being retried twice while the run still looks alive.
- **The trainer repairs its own environment** instead of refusing to start,
  and FramePack gets back the VAE it was trained with, so image-to-video
  stops producing mush.
- **An AMD card shows up without the ROCm command line tools installed.**
- **The benchmark has a brake.** A model that goes off script can no longer
  wedge the run, and the board says what it is actually ranking (#106).
- **The gallery reports the seed you actually rendered with** (#110,
A user). Four different places rolled their own random seed and kept the
  number to themselves, so every random run was filed as seed 0 and no image
  you liked could be reproduced. The dice are thrown once per run now, and
  that number reaches the sampler and the gallery. Cloud runs carry their
  seed too, instead of letting the provider roll one nobody learns.
- **Help tooltips are readable again** (#107). The latent-upscale
  help text was clipped to about two words by the card it sat in. Tooltips
  now float above the whole window, flip away from the screen edge and keep
  pointing at what they explain, everywhere in the app.
- **The Music tab stops printing cloud facts at local users** (#108,
A user). Running locally it hid the lyrics box while claiming the model
  writes its own lyrics, described a box that was not on screen, implied more
  music models were downloadable, and said the length slider bills per second
  on a machine where nothing is billed. It also offered width and height for
  audio. All of that is gone: local music always takes your lyrics, and the
  Music tab has no canvas.
- **A ComfyUI environment that dies at import heals itself** (#98,
  kryptoxide and joel). The broken environment is detected and rebuilt into
  its own venv automatically, and Settings has a Repair button for doing it
  by hand.
- **The built-in engine keeps its memory across renders** (#85,
A user). Conversation state is saved before an image or video render
  takes the VRAM and restored after, measured 2.3 s warm against 62 s cold,
  instead of the chat starting over.
- **Fresh ComfyUI setups install a torch the current core accepts.** The
  environment builder rode a torch index frozen at 2.5.1 while current
  ComfyUI needs 2.6 or newer, so a fresh setup or repair on a normal NVIDIA
  card died at import. Non-Blackwell cards now ride the living cu126
  channel; Blackwell keeps cu128.

### Changed

- **A coding step stops paying for the image and video generators.** Cloud
  coding runs carried the image, video and workflow tools on every single
  step, whether or not the task had anything to do with them, which is about a
  third of the tool budget on the surface that bills per token. They now
  appear exactly when the request asks for them, which is what local models
  have always done. Ask for a hero image and they are back.
- **A build is not a decision.** Release builds land as prereleases and
  become the update everyone gets only after they have been verified.

## [2.6.4] - 2026-08-09

Two money fixes, straight from bug-reports: what the app shows is what you
pay, and the Cloud switch really means off.

### Fixed

- **Cloud off means cloud off.** Flipping the switch to Local while no local
  model was installed or running silently kept the cloud model active, and
  chats kept billing credits. The send path now refuses any model from the
  wrong mode, and the selection clears instead of lying, so the picker asks
  for a real local model.
- **The music price follows the length slider.** The model picker quoted a
  fixed 1 minute price while billing runs per second, so a 3 minute song
  cost three times the shown number. The price next to each music model now
  updates live as you move the length slider: what you see is what you pay.

## [2.6.3] - 2026-08-08

The reliability release: a week of driving the shipped app end to end through
Agent and Code mode and fixing what actually broke, plus the fixes customers
reported since 2.6.2.

### Fixed

- **Agent runs survive.** Variants of the same failing command are detected
  and steered instead of looping, a reasoning-only round continues the run, a
  completion claim is checked against the plan before the app agrees with it,
  approvals survive view switches and never scroll out of sight, Stop cancels
  a running local render, and a finished approval can no longer leave a
  zombie run behind.
- **Small local models drive tools truthfully.** Every surface asks the
  server which transport a model takes: LM Studio answers per model, a
  llama.cpp server per instance, and both are consulted at send time. The
  bundled engine used to accept a native tools payload, silently drop it, and
  let the model narrate a fictional run with zero real tool calls.
- **The run budget respects what LM Studio actually loaded**, so a model
  JIT-loaded below its maximum stops dying on server-truncated prompts.
- **A generated image fed back to a text-only model no longer ends the run.**
  The loop swaps its own attachment for a text note and carries on.
- **Long chats got a deep memory fix.** Streaming no longer rewrites the
  whole history once per animation frame, and generated images survive a
  restart instead of pointing at dead blob URLs.
- **The credits meter tells the truth** about video and training budgets, and
  the Create button can never invite a run the chip is already refusing.
- Read aloud survives the strict content security policy (#77), a ComfyUI
  that dies at startup says why (#98), AMD on Linux gets the ROCm answer
  instead of ZLUDA, screen capture gets a deadline, sending a message pins
  the chat to the bottom, and visible thinking streams in a compact window on
  every transport.

### Added

- **Personal API keys for the cloud plan.** Mint up to five keys in the
  account settings on lu-labs.ai and point Aider or any OpenAI-compatible
  tool at the inference endpoint; a key spends plan tokens only and can
  never read or change the account.
- **Group chat.** Pick two to four models in the Plugins dropdown and they
  answer in turn inside one conversation, each seeing what the others said,
  every answer labeled with its model.
- **Edit the model's answer.** Every assistant message has a pencil next to
  regenerate: fix a detail in place and the conversation continues from the
  corrected text, no resend.
- **Wan-native video sizes.** One-click 480p (832x480 and 720x480) and 720p
  chips, a portrait/landscape flip, and ratio chips (16:9, 9:16, 4:3, 3:4,
  1:1) that keep your pixel budget.
- **Your own lyrics really get sung.** The lyrics box only appears on the
  music model that accepts lyrics, a how-to next to it explains section
  markers, and bare lines are wrapped so they are sung instead of hummed.
- **Character training supports RTX 50 cards.** The trainer routes PyTorch
  wheels by GPU generation (Blackwell gets cu128), and every run starts with
  a preflight that names a broken environment in plain words instead of
  dying mid-training with a raw CUDA error.
- **The remote page's browser tab reads "AI Terminal"** so a bystander
  learns nothing from a glance.
- **Native HiRes fix** for local image generation, contributed by Kizerfluid
  (#97), refining at denoise 0.5 so the composition survives the second pass.
- **The benchmark measures cost and correctness**, not just speed: think-token
  share, cut-off detection, and an expected-answer check per prompt.
- **Every cloud model shows its price** in the picker, and the meter says how
  many more runs the balance buys.
- **A whats-new sheet once per version**, and a shorter path to cloud; the
  bundled video teasers are gone, which makes every download 7 MB smaller.
- The agent opens folders and starts programs through the shell and is told
  which OS it runs on, so it stops guessing.

## [2.6.2] - 2026-08-02

Custom workflows are back, built on community code: Kizerfluid's PR (#94)
brought the store, the import path and the I2V input injection, and the
surface around it was rebuilt into the Create design. Plus two fixes straight
from today's reports.

### Added

- **Bring your own ComfyUI workflows.** The workflow button in the Create
  prompt bar (marked with a dot until first opened) opens a manager popup:
  import a workflow saved with ComfyUI's Save (API Format), by file or pasted
  JSON, then pair it with models through shared tags. Tag the workflow, tag a
  model on the Models view, and the Workflow selector under Advanced settings
  offers it for every matching model; Auto returns to the built-in graph.
  A How it works guide lives next to the popup's close button. Prompt, size,
  steps and seed are still injected into custom graphs, custom I2V workflows
  get the source image wired in, and a VHS_VideoCombine node is switched to
  save mode so clips land in the gallery. Thanks to Kizerfluid for the
  foundation (#94).

### Fixed

- **Read aloud on Windows N editions.** On Windows without the Media Feature
  Pack, every Piper playback failed with "neural audio playback failed" even
  though the voice was installed and fine (#77): the audio element decodes
  through the OS media stack that N editions do not have. Playback now falls
  back to Web Audio with hand-decoded PCM, which needs no system codec at all.
- **ComfyUI installs with a broken Python name the real problem.** When pip
  says the ssl module is unavailable, the interpreter itself was built
  without ssl, and the previous antivirus/clock hint pointed the wrong way.
  The install error now says exactly that, with the one-liner to check and
  the package-manager route to fix it.
- **ComfyUI model discovery survives a failing folder.** Image and video
  model listing are probed independently now, so one unreadable folder costs
  that lane instead of emptying the whole list.

## [2.6.1] - 2026-08-02

A one-bug release, reported the night 2.6.0 went out.

### Fixed

- **Create could not submit anything on some setups.** 2.6.0 started forwarding caller headers through the localhost proxy so a keyed OpenAI-compatible backend would stop answering 401. The proxy also sets its own `Content-Type` when a request carries a body, and the HTTP client appends headers instead of replacing them, so every Create submit went out with the header twice. ComfyUI answers that with `Duplicate 'Content-Type' header found.` and a 400, but only when its aiohttp runs the pure Python parser. The C parser accepts the duplicate, which is why every run here passed while Create was dead for the reporter (#95). The caller's own value wins now, and the default is only filled in when the caller sends none. The same trap for `Content-Length`, `Host`, `Transfer-Encoding` and `Connection` is closed as well, while `Authorization` still rides along, which is what the forwarding was for.
## [2.6.0] - 2026-08-02

The GGUF video release. Most of it came out of running the shipped build end to end on a real 12 GB card and fixing what broke, plus a round of customer reports from Discord and GitHub.

### Fixed

- **GGUF video models can generate for the first time.** The catalog offered GGUF video bundles (19 GB downloads), but the video pipeline only read the two ComfyUI loaders that list `.safetensors`, so an installed GGUF quant could never render a clip. The GGUF loaders are wired in now, the Video lane shows its starter card on an empty model list instead of a blank pane, and a freshly booted app no longer races its own model list when a persisted pick loads slower than the first click (it says the models are still loading and asks for a second try).
- **Video decode finishes on 12 GB cards.** After sampling, the VAE decode of a video ran full-frame next to the resident UNet, got paged by the Windows driver instead of a clean OOM, and sat at 100% GPU for an hour without finishing. Every video decode now runs tiled whenever the installed ComfyUI has the tiled node, which turns that hour into minutes. Image decodes are untouched.
- **The render progress bar ticks.** Progress only repainted on ComfyUI events, and the long stretches (model load, frame decode) send none for minutes, so the bar froze on one label and looked hung while the GPU was at 100%. A one second ticker now keeps the phase label and elapsed time moving between events, and GGUF loads show the loading phase too.
- **The Linux AppImage no longer breaks Python installs.** The AppImage exported its bundled libraries into every child process, so any Python it launched linked against AppImage libs and broke, which made ComfyUI installs fail for every AppImage user. Helper processes start with a clean environment now.
- **Document chat works on documents without punctuation.** The chunker assumed sentence boundaries exist; a transcript or log with none produced a single unusable chunk and the chat failed.
- **VRAM is no longer invented above 4 GB.** The fallback probe reported a made-up number on cards the primary probe could not read, which steered model recommendations wrong.
- **Big model downloads survive.** Large catalog downloads no longer die in a fixed timeout, and an interrupted download resumes where it stopped instead of starting over.
- **Deleting a chat is findable again**, read aloud installs its Piper voice correctly, the built-in engine handles the LM Studio path end to end, and the Downloads tab shows real per-file progress with proper GB formatting at full width.

### Added

- **DeepSeek V4 Flash in LU Cloud** (Pro and Max catalog), served through the same server-driven catalog as the rest, so it reaches installed apps without an update.
- **Qwen Image Edit in the cloud Edit lane** (web studio): instruction-based editing, describe the change and it edits the whole frame, no mask needed. The masked flux-dev inpaint stays.
- **A screenshot tool for the agent**, and Character Studio training and generation on local hardware.

## [2.5.9] - 2026-07-26

A correctness release. Most of it is things that looked like they worked and did not.

### Security

- **The coding agent could be talked into running commands you never approved.** Two paths, both found in this release's security pass and both reachable without a confirmation dialog. First, the helper that wraps text before it goes into a shell escaped for Linux only, while the agent runs PowerShell on Windows, so a crafted commit message or PR title broke out of its quotes and the rest ran as commands. Second, the "continue this PR" tool accepted almost anything as an owner or repo name and pasted it straight into a shell, so a link like `github.com/a/b;<command>/pull/1` ran that command. Either one could be triggered by a poisoned file, PR comment or search result that the agent read, without you typing anything. Quoting now follows the shell that actually runs, PR links are checked against the characters GitHub itself permits, and both are pinned by tests using the exact payloads.

### Fixed

- **Setting up a local lane shows you what it is doing, and you can stop it.** Hitting "Download & install" on Motion Control, Music, Lipsync or Extend gave you a spinner and nothing else: no size, no percentage, no speed, nothing in the Downloads tray, and no way to cancel. The card now names the file and counts it up, the download appears in the tray like any other, and there is a Cancel that really stops the transfer.
- **A dropped connection during a model download no longer throws the download away.** It failed with the raw text "Stream error: error decoding response body" and stopped there, even though what had already arrived was still on disk. A file that fails now retries by itself, and each retry continues from where the last one stopped instead of starting at zero.
- **The setup card stopped asking for things you already gave it.** Motion Control kept saying "add a character image and a driving dance/pose video above" while both were loaded and the render was already running.
- **The Downloads tray closes itself again.** It opens on its own when a download starts, then sat over the app reading "No active downloads" once the download finished or was cancelled.
- **Auto-approve now works on cloud models.** "Confirm shell & code commands" is off by default, which is how you tell the coding agent to stop asking. On an LU Cloud model it did nothing at all: the confirm dialog was hard-wired on and the switch had no effect. Confirming on a cloud model is still the right default, so it stays the default, but it is now a switch you own: turn the main confirm off and a second option appears for cloud models specifically.
- **A failed image no longer counts as a delivered one.** When ComfyUI returned a 400 or a 500, the image tool handed the error text back as if it were a result. LU then treated it exactly like a picture: it burned the turn's image budget so the model could not retry, wrote the error into long-term memory, and told the model "the image is now displayed to the user" right next to the error saying it was not. Models believed that line, and the rest of the conversation was built on a picture that never existed. Failures are now marked as failures everywhere, and instead of "Task completed: 1 failed" you get the actual reason and a way to retry.
- **Read-aloud reaches the Piper voice you picked.** A cold-start probe could cache a false result for the whole session, so every read-aloud silently fell back to a Windows SAPI voice no matter which Piper voice was selected.
- **The Edit tab says what it is.** It is now "Edit / Image to Image", with wording that makes plain image-to-image (source image, no mask) obvious instead of hiding it behind a name that sounded like touch-ups.
- **Image generation is no longer locked to Ask on desktop, and Video generation has a permission row at all.** Both settings existed in the agent but not in the UI.
- **The image and video tools now see GGUF models.** They read only the two ComfyUI loaders that list `.safetensors`, so a GGUF quant was invisible to them. Since several catalogue bundles ship as GGUF, you could install one from the Model Manager, watch it finish, ask for a picture and be told nothing was installed.
- **Error messages quote model names that actually exist.** The "no video model" message sent people looking for "Wan 2.1 — 1.3B", which the Model Manager calls "Wan 2.1 · 1.3B (Lightweight)". Same for SVD.

### Changed

- **Three video models are gone: CogVideoX (both), Pyramid Flow.** They could never run. Their pipelines were built against ComfyUI node names that no version of the wrappers we pointed you at actually registers, so every generation came back as an error, and the install check looked for an invented node too, which is why a correct install was told to go install what it already had. Between them they offered 46 GB of downloads for that. Wan 2.1 and 2.2, LTX, SVD, FramePack, Hunyuan, Mochi and Cosmos are unaffected. Allegro is closed for the same reason. If you already downloaded a CogVideoX model, nothing is deleted from your disk, it simply is not offered any more.
- **Cloud renders are kept for seven days.** Cloud mode now says so once, in Create, with a download reminder, so the limit is stated up front instead of surprising you later. Download what you want to keep. Trained characters on your shelf are not on that clock.
- **Nothing says COMING SOON any more, because nothing was.** AnimateDiff v3, Mochi and Cosmos sat behind a dimmed "COMING SOON" cover while their own download buttons worked fine underneath. The badge came from a flag somebody forgot to set, not from anything being unfinished. Every model in the catalogue downloads, installs and generates.
- **The interface lost its em-dashes.** Labels, tooltips, errors and onboarding text now read the way the rest of LU is written.

### Coding agent

Rebuilt in the places that were quietly costing you turns:

- A surgical `file_edit` tool that changes the lines you asked for, instead of rewriting whole files.
- Verify loops no longer serve stale shell, test and read results from the same turn.
- Context compaction stopped truncating code you had just read to 80 characters.
- `num_ctx` is no longer pinned to 8192, so a 32k model gets its context.
- The tool router stopped sending "search", "current" and "latest" to the web when you meant the codebase.
- Diffs show deletions, `.lurules` actually loads, and stage-and-approve applies in a real folder instead of failing silently.
- Sub-agents no longer collide on tool call ids, which produced a cloud 400 whenever a turn used the same tool twice.
- Plus: `run_tests` auto-detect, encoding flags, atomic writes, parallel git safety, the iteration cap, and the embedding cache keyed by model.

### Remote

- **Non-Ollama backends work over remote access.** The remote bridge forwarded everything to Ollama, so a desktop running LM Studio, Lemonade or llama.cpp answered a phone with an empty model list and a 400 on chat. The server now translates between the phone's Ollama-shaped requests and an OpenAI-compatible backend, including streaming, tool calls, vision and reasoning.
- The remote-access guide no longer promises image generation over remote. Create stays on the desktop for now.

## [2.5.8] - 2026-07-19

Community fix release: works through every open GitHub issue plus the actionable Discord reports since 2.5.7. (Releases 2.5.1–2.5.7 were documented in their GitHub release notes and are not backfilled here.)

### New — Model Manager rebuilt from scratch ("Model Hub")

- **The Models area is a different place now.** A labeled category rail (Chat · Image · Video, plus an Installed count) replaces the cryptic icon toggles; models render as clean cards — model NAME first, one short plain-English line, size pill and capability icons with tooltips — instead of the old description-first text rows. Every function of the old manager is preserved: downloads with pause/retry/clear, bundle installs with custom nodes, CivitAI search with the `.red` mirror, HuggingFace catalog search, the Unfiltered/Mainstream split, install detection across Ollama and LM Studio, and the ComfyUI-down hints.
- **Quant variants collapse into one card with a size picker.** Seven `Qwen 3.6 27B` rows are now one card with a "Q4_K_M · 16 GB ▾" selector; same for GLM 4.7 Flash, the 35B MoEs, Gemma 4 12B and friends. The picker recommends the best size for your GPU and marks what's already installed.
- **The app now tells you what runs on YOUR PC.** GPU + RAM are detected up front (nvidia-smi/rocm-smi/wmic — no ComfyUI needed anymore) and every card carries an honest fit hint: green "runs on your PC", amber "tight fit", red "too big for your GPU" — plus a one-tap "Fits my PC" filter and a "Start here" strip with picks for your hardware. Nothing is ever hidden or blocked by the hint.
- Size filters got human names (Tiny/Small/Medium/Big — same 4/10/20 GB buckets as before), the search field is always visible, and the full technical description of every model lives one ⓘ tap away.

### New — Catalog refresh (May–July 2026): 27 verified additions, 2 GB to 371 GB

- **Unfiltered:** DavidAU's Qwen 3.6 40B "Deckard" Heretic (the top uncensored release of mid-2026) and 27B Heretic finetune, huihui's abliterated Qwen 3.6 27B / 35B-MoE-Opus / Gemma 4 12B / Agents-A1 / Qwythos 9B (Claude-Mythos distill), the Heretic pass on Ornith 1.0 35B, TheDrummer's Rocinante XL 16B and Cydonia 24B for roleplay, and for big rigs: huihui's abliterated DeepSeek V4-Flash (600K+ downloads, single 154 GB file) and GLM 5.2 (multi-part).
- **Mainstream:** Ornith 1.0 9B + 35B (the coding-agent hit of June, 2M+ downloads), Agents-A1 35B + 4B, LFM 2.5 8B MoE, IBM Granite 4.1 8B, MiniCPM-V 4.6 (vision in 2 GB via Ollama), Nemotron 3 Nano 4B + Omni 30B, the Qwen 3.5 9B DeepSeek-V4 distill, Mistral Medium 3.5 128B, DeepSeek V4-Flash, Hunyuan 3 295B, GLM 5.2 and Kimi K2.7-Code (1T).
- Every direct-download entry was verified against the live HuggingFace file listing (exact repo, filename, byte size) before shipping; multi-part monsters go through the existing part-count + total-size confirmation gate. Circulating "Llama 5" and "Qwen 4" release claims were checked against the live Meta/Qwen HF orgs and are fabrications — not added.

### New — Four of the Create categories now run on your own GPU, not only LU Cloud

- **Talking Character, Music, Extend Video and Motion Control each grew a full local lane.** In Local mode they build a ComfyUI graph from core node families (no proprietary endpoint) and run on your card; in Cloud mode they still submit to the hosted models. Each is a normal Local tab now — only the genuinely hosted-only tools (Upscale, Erase Object, Character Studio) keep a cloud badge in Local mode. The Cloud discovery popups are a one-time onboarding: they appear once, then never again (the choice persists across updates).
- **Music** runs ACE-Step in ComfyUI core (`TextEncodeAceStepAudio` → `EmptyAceStepLatentAudio` → `KSampler` → `VAEDecodeAudio` → `SaveAudio`), from ~4 GB. The result is a real audio tile with an inline player — audio outputs are now typed as audio (they used to inherit the tab's image/video type and refuse to play). The builder pins the sampling recipe per checkpoint: ACE-Step 1.5 turbo is a ~10-step, cfg 1 distill — running it on generic image-model settings (50 steps, cfg 5) produces near-silent noise, so the lane enforces the turbo recipe and samples every ACE checkpoint on euler/simple.
- **Talking Character** runs Wan 2.2 S2V (`WanSoundImageToVideo` + a wav2vec2 audio encoder) from a portrait plus a voice — upload a clip or make one with the in-app TTS. The clip length follows your audio.
- **Extend Video** continues a clip you already have: it extracts the last frame locally and feeds the regular image-to-video path, so it uses the same video models as Animate.
- **Motion Control** drives your character from a dance/pose video: DWPose (controlnet_aux) reads the skeleton out of the driving clip and Wan VACE/Animate re-renders your character following it. The pose pack installs from the in-lane card and needs a ComfyUI restart to register — the installer performs that restart itself now. Without a GPU onnxruntime DWPose falls back to CPU pose extraction: slower, but it works.
- **Character Studio stays on LU Cloud for now.** Local character training needs a whole trainer runtime (managed venv, base model files, a long GPU run) that 2.5.8 does not ship — rather than strand users on a half-built lane, training runs hosted and the trained character comes back to your shelf as usual.
- **Honest about hardware:** the audience is every tier, and the copy says so. The heavy 14B video lanes (S2V, Animate) are genuinely slow on a 12 GB card even at low step counts — the new per-lane Frame/Size/Step controls (below) let you trade quality for speed. Where a lane needs a node pack the box lacks, it escalates with an actionable message rather than failing silently.

### Changed — One Cloud popup at start, then quiet

- App start shows a single LU Cloud popup with two choices: **"Sign in or create account"** opens the normal login/plans gate, and an equally visible **"I don't want an account"** closes it AND switches the whole Cloud discovery layer off (picker teaser rows, tap sheets) — after that tap, nothing pitches Cloud again. Settings can re-enable the discovery layer. The choice survives updates (it rides the store backup that outlives installer wipes).
- Cloud copy no longer calls LU Cloud a closed beta — the beta is fully open. The old "Max plan (closed beta)" lines in the Create teasers and the beta wall in the gate are gone.

### Fixed — Node pack installs died on Windows system Python (Motion install card stuck)

- On python.org installs under `Program Files`, site-packages is admin-only: the first node pack whose requirements pull a NEW wheel (the pose extractor for Motion Control) failed with a permission error and stranded the install card — while packs whose dependencies were already present sailed through, which is why this survived earlier install testing. pip now retries the same install into the per-user site automatically (same interpreter imports from there, no admin needed). This is the Windows twin of the Linux PEP 668 `--user` escape elsewhere in this release.
- **Starting ComfyUI twice could leave an untrackable twin owning the port.** `start_comfyui` only probed the port to decide "already running" — but a booting ComfyUI imports for 20-60 s before it binds the port, so opening a Create tab during that window spawned a second copy and overwrote the tracked process handle. The first copy then won the port bind and became a zombie LU could never stop: every install's restart killed only the tracked twin, the zombie kept serving the stale node list, and the install card span forever with no error (the exact reported chain). The start command now recognises a tracked child that is still booting and reports `starting` instead of spawning; `stop_comfyui` additionally reaps the child before returning so the port is provably free for the restart. Verified end-to-end: pose-extractor card → install → automatic restart → node registered → card cleared in 70 s.
- If ComfyUI is running outside LU (your own terminal/script), LU cannot restart it to register a freshly installed node pack — the old process keeps serving the stale node list. Instead of polling a misleading 40 seconds, the restart now waits until LU's own engine is provably down and only then blames an external engine, with the real fix in the message: restart your ComfyUI yourself, then come back.

### New — Delete image/video models from the Model Hub (Discord)

- Installed image and video models finally have a trash button. Before, delete existed only for Ollama chat models — a ComfyUI checkpoint that turned out too big for the PC (the report: a 27 GB video model whose render hit the 60-minute timeout) had no way back out of the app and sat on the disk forever. The delete removes the model file (plus a stale resume-partial next to it), rescans ComfyUI and refreshes the list; the path goes through the same traversal-jailed helpers as downloads and refuses anything outside the known model folders.

### New — "Update ComfyUI" from inside the app

- When a specialized lane needs core nodes a user-managed ComfyUI is too old to have, LU can `git pull` + reinstall requirements in place (the same streaming, cancellable, retrying installer the bundle downloads use) instead of leaving a cryptic ComfyUI rejection. Gating stays node-presence based (no brittle version-string parsing). LU-managed ComfyUI installs are always current; a user's own install gets the offer, never a forced update.

### Fixed — Voice: whisper/piper state detection, venv installs, PEP 668 (#77, #78; Discord)

- **Whisper badge no longer resets to "not installed" after every relaunch.** `whisper_status` only reported a *running* server process; after a restart the process is gone, so the UI showed red even though the install was fine. It now also probes the installed `faster_whisper` package on disk.
- **Transcription lazy-start now uses the same Python that the installer targeted.** `transcribe` spawned `state.python_bin` (system Python) while `install_whisper` had installed into the LU-resolved interpreter — on setups where those differ, a completed install was invisible at runtime.
- **TTS status now recognises any downloaded piper voice**, not just the default `en_US-lessac-medium`. Users who picked a different voice were silently dropped to the OS fallback voice because `tts_status` reported piper "not ready".
- **Voice picker no longer bricks the selection when a voice download fails** — the new voice is only committed after the download succeeds.
- **Read-aloud on WebView2 no longer stops after the first sentence.** `speakStreaming` queued one utterance per sentence; WebView2's speech synthesis regularly stalled at the chain's first hand-off. Speech now uses a single utterance plus a `resume()` keep-alive interval.
- **Linux PEP 668 (Arch, Debian 12+, Fedora 38+): whisper/piper installs no longer die with `externally-managed-environment`.** The voice installers now detect the marker and pass `--break-system-packages --user`, matching platform reality on distros that lock the system Python. No-op on Windows/macOS/venvs.

### New — Auto-read responses, off by default

- Settings → Voice gains **"Auto-read new responses"** (visible once read-aloud is enabled). Completed assistant turns are spoken automatically. This intentionally returns a feature removed on 2026-06-07 — back then it fired unconditionally; now it's an explicit opt-in that defaults to OFF, and the main toggle is relabelled "Enable read-aloud" to stop implying it auto-reads.

### Fixed — Agent workspace jail rejected `\\?\`-prefixed roots (#79 DarkLordCmd; thecakeisnaoh)

- On Windows, a workspace whose stored root carried the `\\?\` verbatim prefix (common when a path came from a native picker or long-path handling) failed every file operation with "path escapes the workspace". The jail normalised the *candidate* path but compared it against the *raw* root — the asymmetry made the root never match itself. Both sides now go through one normaliser (case-fold, slash-fold, verbatim/UNC strip); the error message now includes both the workspace root and the requested path so future reports are diagnosable. Four new regression tests cover the `\\?\` cases.

### Fixed — ComfyUI 0.19+ blocks LU's progress + media unless you pass a CORS flag (#75)

- ComfyUI 0.19.0 (April 2026) added an origin-check middleware that returns 403 for every cross-site request — including the desktop WebView's requests from `http://tauri.localhost` to a **user-managed** ComfyUI (LU-spawned ComfyUI always passed `--enable-cors-header`, so it was never affected). Control-plane HTTP already went through the Rust proxy and kept working; what broke was the live progress WebSocket and direct `<img>`/`<video>` gallery loads.
- **Live progress now flows through a Rust-side WebSocket proxy** (`comfy_ws_connect`) whose client handshake carries no browser Origin, so it passes the middleware on any ComfyUI. The web build keeps the raw WebSocket.
- **Gallery/lightbox media that fails to load direct now falls back to fetching the bytes through the Rust proxy** and displays a blob. Trade-off stated plainly: the fallback holds the whole file in memory and video loses HTTP-Range seeking — fine for short clips, noted in code.
- **When the fallback engages, the Create tab shows a short dismissible banner with a one-click fix.** "Let me do it for you!" restarts the user-managed ComfyUI under LU's management (which always passes the CORS flag), restoring direct loads and native progress — guarded against firing mid-generation. If LU doesn't know the install's folder (or the host is remote), the banner explains the manual route instead: add `--enable-cors-header http://tauri.localhost` to the launch script. (Community threads suggested `--allow-origin` — that flag does not exist — or `--listen 0.0.0.0`, which needlessly exposes ComfyUI to the LAN.)

### Fixed — Remote ComfyUI host: gallery/preview media never displayed (#82 rx422)

- With Settings → ComfyUI **Host** pointed at another machine (LAN/Docker/homelab — an explicitly supported setup), generation worked but every thumbnail/preview showed "the local engine isn't reachable": the WebView's CSP intentionally pins `img-src`/`media-src` to localhost, so direct loads from a remote host are always blocked. The proxied-blob fallback above now covers this case too — media re-fetches through the Rust proxy (which knows the configured host) and displays normally, verified live against a remote host (thumbnails, fullscreen, video, and live progress via the WS proxy).
- The CORS banner no longer appears for remote hosts — the flag hint would be wrong there (no ComfyUI flag can un-block the WebView's own CSP), the proxied path is simply the normal mode for remote setups.

### Fixed — Local image-to-video (Animate) was missing from the Create tab

- The redesigned Create surface had marked **Animate Image** cloud-only, silently dropping the local I2V lane the old Create tab always had (and clearing its state on every switch to local). The intent is back for the local backend, with the full submit path (source image → ComfyUI upload → workflow) reconnected.
- **Every video family core ComfyUI can animate is wired**, schema-driven from the live `/object_info`: WAN 2.1 i2v (`WanImageToVideo`), Hunyuan i2v (`HunyuanImageToVideo`), LTX (`LTXVImgToVideo`), Cosmos (`CosmosImageToVideoLatent`) on the main builder path — WAN 2.2 TI2V, SVD and FramePack already animated via their dedicated builders. Mochi (t2v-only) and a ComfyUI missing the family's node reject with an actionable message instead of silently ignoring the source image.
- **The model picker only offers models that can actually do the op**: Animate lists i2v-capable models (explicit `i2v`/`ti2v` tags, SVD, FramePack, LTX, Cosmos Video2World), Video lists t2v-capable ones — SVD/FramePack drop out there, dual models (WAN 2.2 TI2V, LTX) stay in both. Same gating in the chat model-picker card.

### Fixed — A model without tool calling now fails with a clear message, not a raw error

- Picking a model that does not support function calling and then using Agent or Code mode (or Chat with tools on) made the hosted inference endpoint answer HTTP 405, which surfaced as an opaque error or an aborted turn with no explanation (a paying user hit exactly this). LU now recognises that case across every OpenAI-compatible backend (LU Cloud / the upstream, LM Studio, custom endpoints) and shows a plain "this model does not support tool calling" note that says what to do: turn tools off, or switch to a tool-capable model.
- **LU Cloud now knows up front which models can't do tools.** The `/models` list carries a per-model tool-calling flag, so Agent mode is disabled before you ever send a request on the cloud chat models that lack function calling (Hermes 3, Euryale, MythoMax, Llama 4 Maverick, and friends) — no failed turn required. Plain chatting with those models still works.
- **Every chat model in the dropdown now shows a tools icon at a glance:** a green wrench for models that support tool calling, an amber marker for models that don't (whether the server declared it, or a run proved it). When the server returns its clean "can't run tools / can't read images" reason, LU surfaces that exact line instead of a generic error.

### Fixed — Local Create now frees the chat model from VRAM before rendering

- On a single local GPU, a chat model sitting in VRAM (Ollama / LM Studio / the bundled engine) left ComfyUI fighting for the card — heavy CPU offload at best, a CUDA out-of-memory on the 14B Talking Character lane at worst. A local Create run now releases the chat backends first (they reload lazily on your next message), the same offload the Cloud switch already did, so the render gets the whole GPU. ComfyUI keeps its own checkpoint cached across consecutive Create runs, so back-to-back generations don't pay a reload. (On a large card where both would have fit, this trades a quick chat-model reload for guaranteed headroom — the conservative default for the common 8-12 GB tiers.)

### New — Frame count, resolution and step controls on every Create lane

- **You can finally set frames, resolution and steps in the app** — before, the Video tab only had a Draft/Standard/High quality toggle, and the specialized lanes (Talking Character, Music, Extend) had no generation knobs at all, so a local video ran at the model's full frame count and step count with no way to dial it down. The composer now shows the exact knobs each lane actually consumes: **Quality (steps) + Size + Frames** on every video lane, **Quality (steps)** on the local Music lane (Length was already there), and the existing Quality + Aspect on image lanes. This makes low-VRAM runs practical — drop the steps and frames and a clip that used to be a multi-hour render finishes in minutes.
- **Nothing on screen is a dead control.** The knobs render only where the submit path reads them: locally every lane consumes them; the regular Video/Animate lanes honour them on LU Cloud too; the specialized hosted ops run at fixed server-side settings, so those sliders stay hidden on Cloud rather than pretending to work. On Talking Character the frame count is hidden entirely and labelled "clip length follows your voice", because the lane derives it from the audio.
- **The Size tiers are video-native.** They read the lane's actual video model (Wan S2V / Animate / the picked video model), not the last image model, so a 480p video graph offers 320p/480p/720p rather than image-centric 1024p sizes; dimensions snap to the multiple of 16 the WAN/S2V/VACE VAEs require.

### New — ComfyUI install location is configurable (Discord)

- The Settings → AI Backends → ComfyUI **Path** field now doubles as the install target: put e.g. `D:\ComfyUI` there before pressing **Install ComfyUI** and the multi-GB install (plus all image/video models, which live inside the ComfyUI folder) lands on that drive instead of filling `C:`. Empty field keeps the previous default (home folder). A completed custom-target install is persisted as the active path, so LU finds it after a restart.

### Fixed — Create-tab LoRA picker was a silent no-op (Discord #80)

- The Create UI collected selected LoRAs into a `loras` param that **no code ever read** — the workflow builder expects `lora`/`loraStrength`. Selections now reach the builder, for images and video.
- **Video LoRA support**: the LoRA stack is no longer hidden for every video model — it shows for families whose graphs support model-only LoRA loading (WAN, WAN 2.2, Hunyuan, LTX, Mochi, Cosmos). WAN 2.2's dedicated builder gains a guarded `LoraLoaderModelOnly` chain; a plain WAN 2.2 run without LoRAs produces a byte-identical graph to before.

### New — Delete individual chat messages (Discord #81)

- Every message's action bar gains a delete button (two-click confirm within 3 s, works for both user and assistant messages). Pairs with the existing edit/regenerate actions.

### New — LiteLLM provider preset (PR #64, thanks @RheagalFire)

- One-click provider preset pointing at a local LiteLLM proxy (`http://localhost:4000/v1`, OpenAI protocol) — fronts 100+ upstream providers from one endpoint.

### Fixed — Errored bundle downloads can now be cleared (Discord)

- A failed bundle download left the card stuck on "Retry" with no way to dismiss the error state. A new **Clear** button resets the bundle back to installable.

### Fixed — Flash-Attention parity on auto-start (#74 follow-up)

- `--use-flash-attention` was only applied when ComfyUI was started manually from the UI; the boot auto-start path ignored the (positive) flash-attn probe. Both paths now behave identically. The orphaned `check_flash_attention` command (its UI nudge was removed in 2.5.7) is deleted.

### Fixed — Chat model dropdown was unreadable in light mode

- The model picker popover kept a hardcoded dark panel in both themes, but the light theme remaps text colours to dark — so in light mode the model names, section headers and the LM Studio hint rendered as dark text on the dark panel and were effectively invisible. The panel, its borders, the active/hover tints and the error/hint colours are now theme-aware, so the dropdown is a clean light surface in light mode and unchanged in dark. (Missed during the Model Hub redesign.)

### Stability

- `vitest`: **3372 tests** green. `cargo test`: **197 passed**. `cargo check`: clean (3 pre-existing dead-code warnings only). Frontend production build: clean.
- New settings field `autoReadAloud` defaults to `false`; store migrations are additive — no breaking changes.
- `offload_local_models` gained an optional `include_comfyui` flag (defaults true — the Cloud switch still releases everything); a local Create run passes `false` so it frees only the chat backends and keeps ComfyUI's checkpoint cached.

## [2.5.0] - 2026-05-28

Minor release. 30+ changes — the headline Codex / Agent sprint (Sprint A / B / C ported from the companion repo `the web app`), eight reporter-facing fixes (B1–B3 + AA + Y + Z), two new pieces of UI (BB — GPU picker, CC — chatbot-export importer), production hardening (B4 / B5), and the autonomy-ceiling bump that turns scaffold→install→fix→verify into a single turn. Bundles all v2.4.9 contents.

### Fixed — Ollama auto-detection persists across launches (B1)

- **Ollama re-enabled state now pins through restart**. `AppShell.tsx` boot path previously re-ran auto-detect on every launch and reset a user's manually-enabled Ollama back to disabled when the daemon was momentarily unreachable. v2.5.0 records the user's deliberate re-enable in localStorage and treats it as authoritative — auto-detect can only add backends, never remove ones the user explicitly turned on.

### Fixed — Multi-backend modal persists Ollama choice (B2)

- **`BackendSelector.tsx` modal Ollama choice survives modal re-open**. Pre-v2.5.0 picking Ollama in the multi-backend modal, closing it, and re-opening reset the dropdown to "Auto". v2.5.0 reads the previous selection from settings on mount and re-applies it so the user's chosen backend stays sticky across modal opens.

### Fixed — LM Studio per-model load/unload backend (B3)

- **Three new Tauri commands for LM Studio per-model control** (THobbs23): `lmstudio_list_loaded`, `lmstudio_load_model`, `lmstudio_unload_model`. UI integration lands in the next hotfix — the backend half ships now so the LM Studio panel work can build against a stable surface.

### Fixed — Ollama actually uses the context window you set (Bug AA)

- **`num_ctx` now travels from Settings → Ollama on every chat + tool call** (Discord 2026-05-25/27 thread `1507756765612216411`). Pre-v2.5.0 LU passed `temperature`, `top_p`, `top_k`, and `num_predict` through to `/api/chat` but never `num_ctx`, so Ollama silently defaulted to 2048 regardless of what the user set in the UI. RAG payloads and long-turn chats got clipped on every model regardless of what the loaded model actually supported — a user's "VRAM caps at ~5 GB no matter the token limit" symptom. v2.5.0 adds `contextWindowOverride` to `Settings`, a `Context window (Ollama)` input under Settings → Generation, and threads the value through `ChatOptions.contextWindow` in `src/api/providers/ollama-provider.ts` (chatStream + chatWithTools) and `src/lib/ollama-stream-tools.ts` (agent tool loop). Forwarded to all four consumers — `useChat`, `useABCompare`, `useAgentChat`, `workflow-engine`. 0 = let Ollama decide (default, matches pre-v2.5.0 behaviour). Cloud providers ignore the field — they manage context themselves.

### Fixed — Downloaded but invisible (Bug Y, two-layer)

- **`handleTextDownload` now routes by the *active chat provider*, not by which backend happens to be enabled** (a user Discord 2026-05-25/26, msg `1508875114215899156`). Pre-v2.5.0 the logic was `useOllamaPath = !lmStudioOn && ollamaOn` — whichever was enabled won. A user chatting on LM Studio who clicked Download in Discover got the file pulled into Ollama's store (or vice versa), invisible to the chat side because the chat picker couldn't see the other backend. v2.5.0 derives the target from `getProviderIdFromModel(activeChatModel)` in `src/components/models/DiscoverModels.tsx`, with the old enabled-wins logic as a fallback for first-launch empty-state users. Ollama-only entries (those with `model.ollamaModel`) now refuse with a clear error when the user is on LM Studio ("Switch the chat picker to an Ollama model first") instead of silently pulling somewhere the user can't see.
- **`isModelFullyInstalled` now also matches LM Studio scanner output** (Y/b). Pre-v2.5.0 the check only looked at `installedModels.filter(m => m.provider === 'ollama')` tags. After a restart, the in-memory `downloads[filename]` flag is gone, so GGUFs that LU itself wrote to LM Studio's scan dir never lit up the INSTALLED badge. v2.5.0 also matches LM Studio entries by filename basename (case-insensitive, with-or-without `.gguf` suffix, with-or-without LM Studio's `<publisher>/<repo>/` prefix), so the badge survives both a restart and a cross-backend download.

### Fixed — Hermes 3 phantom-complete + Hermes 3 repo retarget (Bug Z, GH #48)

- **Pulls that fail without an explicit `{"status":"success"}` no longer flip the badge to "Completed"** (GH #48 2026-05-26). Pre-v2.5.0 `pull_model_stream` in `src-tauri/src/commands/proxy.rs` returned `Ok(())` whenever the byte-stream ended cleanly, even if Ollama never said "success" — and `src/hooks/useModels.ts` swallowed any thrown error from the catch with an empty block. leon's CLI repro on 2026-05-26 confirmed Ollama responds to a broken HF reference (e.g. `bartowski/Hermes-3-Llama-3.1-8B-GGUF` on llama.cpp-incompatible builds) with HTTP 200 + a stream that ends after just `{"status":"pulling manifest"}`. v2.5.0's Rust side now tracks the last status + watches each line for an `error` field, and returns a descriptive `Err` ("pull did not complete: stream ended at \"pulling manifest\". Repo may be incompatible with llama.cpp (try a different GGUF mirror).") when neither success nor explicit error came through. `useModels.ts` now surfaces that string as the card's last status (`Failed: ...`) instead of swallowing it. Cancellation is still distinguished from real errors.
- **Hermes 3 discover entries switched from `bartowski/Hermes-3-Llama-*-GGUF` to `mradermacher/Hermes-3-Llama-*-GGUF`** (Z/b). bartowski's quants for those specific repos return HTTP 400 on current Ollama. mradermacher's GGUFs are llama.cpp-compatible and ship the same Q4_K_M sizes (2 GB / 5 GB / 42 GB for 3.2 3B / 3.1 8B / 3.1 70B respectively). Filename convention also changed (mradermacher uses `.Q4_K_M.gguf`, bartowski uses `-Q4_K_M.gguf`) and the entries reflect that.

### New — Hardware: GPU picker (Bug BB)

- **Settings → Hardware now lists every detected GPU and lets you pin a vendor + indices** (Discord 2026-05-26). A user runs AMD RX 6800XT 16 GB + Intel Arc Pro B60 24 GB and wanted to pin the Arc Pro for inference. Pre-v2.5.0 LU had no picker — Ollama and ComfyUI used whatever the driver picked first. v2.5.0 adds `commands::gpu` with `detect_gpus` (probes nvidia-smi / rocm-smi / lspci on Linux / wmic on Windows / system_profiler on macOS), `set_gpu_selection` / `get_gpu_selection` (AppState-backed), and `apply_gpu_env` which forwards the right env-var family on next `start_ollama` / `start_comfyui` spawn: `CUDA_VISIBLE_DEVICES` for NVIDIA, `HIP_VISIBLE_DEVICES + ROCR_VISIBLE_DEVICES` for AMD, `ONEAPI_DEVICE_SELECTOR` (level_zero) for Intel. "Auto" leaves env-vars unset and matches pre-v2.5.0 behaviour. Frontend lives at `src/components/settings/HardwareSettings.tsx`; settings persisted as `gpuVendor` + `gpuIndices` on the existing Settings store. The boot effect in `App.tsx` pushes the persisted pick into AppState at app start so users don't have to open Settings before the first Ollama / ComfyUI spawn.

### New — Chatbot-export importer (Feature CC, MikeS++)

- **Settings → "Import past chatbot conversations" parses ChatGPT, Claude, and Gemini exports** (MikeS++ Discord 2026-05-27). New file picker accepts the official export JSON or the unmodified .zip (JSZip walks for `conversations.json` with a fallback to the largest .json inside). Per-platform parser in `src/lib/parsers/chatbot-export.ts`: ChatGPT's `mapping` tree gets linearised by walking the first child each turn (matches what the user saw in the UI), Claude's `chat_messages` array gets a 1-to-1 markdown render, Gemini's `messages` array (or single-prompt activity fallback) gets the same treatment. Each conversation becomes a synthetic `.md` File and goes through the existing `useRAG.uploadDocument` pipeline — same chunking + embedding flow as a dragged-in document. Imports attach to the active chat's RAG store (per-conversation by design; memory facts stay in the curated memoryStore). Conversations are pre-selected for convenience; the UI surfaces per-conversation checkboxes + Select all / none for cleanup before import. Stays on the user's machine — no upload, no cloud round-trip.

### New — Codex / Agent capabilities (Sprint A / B / C from the web app)

- **Architect / Editor split** (Sprint A #1). A separate "architect" model produces a structured plan with no tool access; the regular Codex model then applies the plan with tool access. Aider-style — empirically ~30 % better edit accuracy on multi-file refactors. Settings: `codexArchitectMode`, `codexArchitectModel`, `codexArchitectAllowCloud` (local-first by default; explicit opt-in to leave the machine).
- **Repo-Map injection (Aider PageRank)** (Sprint A #2). The bridge ranks repo files by import-graph PageRank and injects the top-N entries into the editor system prompt. Default top-N is 20, clamped to bridge's [1, 200] range. Settings: `codexRepoMapEnabled`, `codexRepoMapLimit`.
- **Multi-File Stage-and-Approve** (Sprint A #3). When `codexStageMode` is on, every `file_write` queues as a pending change the user reviews and applies (or rejects) per-file instead of touching disk directly.
- **Test-Driven Loop (`run_tests` tool)** (Sprint B). New typed tool lets the agent invoke the project's test runner, watch failures, and iterate on a fix.
- **Typed git + gh tools** (Sprint B). Six new typed tools — `git_status`, `git_commit`, `git_push`, `git_log`, `git_diff`, `gh_pr_create` — replace the previous shell-wrapped patterns.
- **Code-Review mode** (Sprint B). Toggle (`codexReviewMode`) puts the agent into read-only: every `file_write` and `shell_execute`-style call is blocked with a friendly message and the system prompt is switched to "inline comments only". For PR pre-checks where you don't want the agent touching anything.
- **Long-running background shell tasks** (Sprint B). Four new tools — `shell_execute_background`, `shell_task_status`, `shell_task_kill`, `shell_task_list` — let the agent kick off long jobs (dev servers, multi-minute builds) without blocking its turn.
- **Multi-Repo Agent** (Sprint C #8). Per-chat workspaces, with the Agent surface able to hold multiple workspaces in parallel and switch between them.
- **`.lurules` per-repo configuration**. Per-repo rules file lets a project pin its own agent conventions without leaking into other repos.
- **`pr_resume`**. Resume an in-flight pull-request workflow from where it stopped — agent rehydrates the PR context instead of starting over.
- **`project_init`** (System-Wide Setup). Scaffolds a new project — directory layout, README stub, language-appropriate gitignore, optional CI starter.
- **Parallel sub-agents**. Sub-agent spawn now runs branches concurrently instead of sequentially.
- **Diff rendering for `file_write`**. The agent surface shows a real diff for every `file_write` proposal rather than the previous "wrote N bytes" line.
- **Per-chat workspace picker for Agent**. Workspace unification: Agent and Codex now share the same workspace concept and the same picker dialog.

### Hardening — Production logging + console-log strip (B4 / B5)

- **Structured logger with key-substring redaction** (B4, `src/lib/logger.ts`). Replaces ad-hoc `console.log` calls in production paths. Any object key containing `token` / `key` / `secret` / `password` / `auth` is redacted before emit so log lines pasted into bug reports never accidentally leak credentials.
- **`console.log` stripped from production builds** (B5). `vite.config.ts` adds `esbuild.pure: ['console.log', 'console.debug']` so DCE drops the calls in `vite build` output. Errors and warnings remain — only the noisy debug-level calls go.

### Hardening — Iteration cap bump (the web app live-test 2026-05-25)

- **`agentMaxIterations` 25 → 200; `agentMaxToolCalls` 50 → 400.** Real scaffold→install→fix→verify loops on a 35B local model hit the previous 25/50 caps mid-useful-work. The new caps are roomy enough for multi-file refactors yet still bounded enough that a runaway loop surfaces in finite wall-clock. Existing v2.4.9 settings auto-migrate (the persisted store keeps your customised values; only fresh installs see the new defaults).

### Stability

- `vitest`: **2501 tests** green (previously 2312; +189 across the new bg_tasks, repo_map, architect-split, stage-mode, code-review-mode, logger, .lurules, pr_resume, project_init paths plus AA num_ctx forwarding (+2) and CC parser (+11)).
- `cargo test`: **122 passed** (previously 100; +22 across `bg_tasks`, `repo_map`, and `gpu` modules).
- `tsc --noEmit`: clean. `cargo check`: clean (pre-existing dead-code warnings only).
- No breaking changes; the new settings fields (`contextWindowOverride`, `gpuVendor`, `gpuIndices`) auto-default to no-op values and the iteration cap bump is purely upward.

### Heads-up

Windows + Linux only — macOS is not part of this build. `#bug-reports` / `#help-*` / GitHub monitored daily for regression reports.

If you had a custom HuggingFace download path set, double-check it after first launch — v2.5.0 introduces the GPU picker which adds new env-vars at spawn time, and on some setups Ollama / ComfyUI need a manual restart for the change to take effect.

The chatbot importer attaches to the **active chat's** RAG store. Open or create a conversation before importing if you want a separate bucket per export.

a user's queued feature requests are deferred to v2.5.1 since the codex sprint took priority for this release.

## [2.4.9] - 2026-05-25

Sweep release on top of v2.4.8. Five bug fixes (U — GH #47; V — Discord 2026-05-23 #help-chat, split into V/a RAG-persistence and V/b Ollama-orphan; W — Discord 2026-05-23/24 benchmark followup; X — Discord 2026-05-24 #general thinking/agent toggles) plus two a user feature requests (GH #45 + GH #46).

### Fixed — ComfyUI Desktop App detection (Bug U)

- **Onboarding now recognises the ComfyUI Desktop App** (GH #47 2026-05-24). Pre-v2.4.9 both auto-detect (`detect_all_comfyui_installs_sync`) and manual entry (`set_comfyui_path`) required `main.py` to be the path's direct child. a user's ComfyUI Desktop App from comfyanonymous (default install `%LOCALAPPDATA%\Programs\ComfyUI`) ships only `ComfyUI.exe` next to the Electron resources — the actual ComfyUI Working Directory with `main.py`, `models/`, `custom_nodes/` is at `~\Documents\ComfyUI` by default (or wherever the desktop installer's picker pointed at, recorded in `%APPDATA%\ComfyUI\config.json`'s `basePath`). v2.4.9 adds a `resolve_comfyui_path` helper that accepts either layout: if the given dir has `main.py` it's a classic install, if it has `ComfyUI.exe` it's the Desktop App and we walk a probe list (`Documents\ComfyUI`, `Documents\ComfyUI\ComfyUI`, `%APPDATA%\ComfyUI` and its `config.json` `basePath` hint, `%LOCALAPPDATA%\ComfyUI`, `%LOCALAPPDATA%\Programs\ComfyUI\resources\ComfyUI`) until we find `main.py`. The auto-scan picks the same hints. When the binary dir is given but no Working Directory is reachable, the error message tells the user exactly which folder we need ("LU needs the ComfyUI Working Directory with main.py, models/, custom_nodes/ — by default `~\Documents\ComfyUI`") instead of the previous bare "main.py not found".

### Fixed — RAG document persistence (Bug V/a)

- **RAG embedding chunks survive an NSIS auto-update / WebView2 data reset** (Discord 2026-05-23 thread `1507756765612216411`, references GH Discussion #26 as "'fixed' but not really fixed"). v2.3.4 closed the chat-message half (3-leg backup of localStorage → `%APPDATA%\Locally Uncensored\store_backup.json`), but the RAG chunks (embedding vectors stored in IndexedDB at `locally-uncensored-rag → chunks` because 768-float vectors blow past localStorage's quota) were never in the backup pipeline. After an NSIS upgrade or WebView2 data wipe, `documents` (the file-metadata localStorage half of `rag-store`) restored fine but the chunks were lost — every RAG-enabled chat would show the document name and silently return no retrievals. v2.4.9 adds two Tauri commands (`backup_rag_chunks`, `restore_rag_chunks`, same atomic-temp-rename pattern as `backup_stores` to `%APPDATA%\Locally Uncensored\rag_chunks_backup.json`) and two `ragDB.ts` helpers (`exportAllChunks` / `importAllChunks`). The backup triad in `AppShell.tsx` now backs up RAG chunks on a 30 s interval + on `beforeunload`, separate cadence from the existing 5 s chat-snapshot triad because chunk payloads are heavy and change rarely (only on document upload/delete). Restore runs alongside `restore_stores` on cold start AND on warm starts where IndexedDB might be empty while localStorage has the doc metadata — and only imports entries the live store is missing, so a stale backup can't clobber newer in-app activity.

### Fixed — LU-spawned Ollama is killed on shutdown (Bug V/b)

- **Auto-installed `ollama serve` no longer lingers as a 200 MB orphan after LU quits** (same thread). The Drop impl on `AppState` already killed `comfy_process` and `claude_code_process` on shutdown, but Ollama was never stored — `start_ollama` and `auto_start_ollama` spawned `ollama serve` and discarded the `Child` handle, so quitting LU (tray → Quit) left `ollama.exe` running in the background indefinitely. v2.4.9 adds `ollama_process: Mutex<Option<Child>>` to `AppState`, captures the spawn in both call sites, and adds an Ollama kill leg to `Drop` that mirrors the ComfyUI taskkill `/T /F` pattern (kills the process tree). The pre-spawn tasklist check stays in place so we only ever store a `Child` we ourselves started — a user-managed `ollama serve` that was already running when LU launched is left alone, so quitting LU never kills someone else's Ollama. Hide-to-tray (`X` button) is unaffected: the page stays alive, Ollama keeps serving, no Drop runs until the user explicitly Quits from the tray menu. Same release also upgrades `exit_app` (used by the auto-updater to let NSIS swap the binary) from `std::process::exit(0)` to `app.exit(0)` so the Drop chain actually runs during an update — pre-v2.4.9 hard-exit bypassed every destructor and left both Ollama AND ComfyUI orphaned across upgrades.

### Fixed — Benchmark shows latest run, not running average (Bug W)

- **Per-model benchmark display is the latest session's tok/s, not a session-wide average that drifts as more samples accumulate** (Discord 2026-05-23/24, Bug M retest). After the v2.4.8 Ollama `eval_count`/`eval_duration` fix, a user ran gemma4:e4b ten times and watched the displayed tok/s climb from 15.2 to 17.9 across runs. They thought previous results were affecting new ones — they were, but only because `getAverageSpeed` in `benchmarkStore.ts` averaged every historical entry. Per-run measurements were stable; the UI was showing a drifting mean. v2.4.9 adds `getLatestSpeed(results, modelName)` which groups runs into "sessions" by a 10 s timestamp gap (one Run Benchmark click runs through BENCHMARK_PROMPTS in seconds, the next click is at least seconds later — usually minutes) and returns the mean of the most recent session only. `BenchmarkView.tsx` and `ModelBenchmark.tsx` switch to `getLatestSpeed`; the leaderboard keeps `getLeaderboard`/`getAverageSpeed` since cross-model comparison benefits from averaging out noise. Four new vitest cases pin the session-boundary logic.

### Fixed — Thinking + Agent toggles enable for community-uncensored Gemma 4 (Bug X)

- **`isThinkingCompatible` and `isAgentCompatible` now match dashed-family names (`gemma-4-…`) and multi-segment HF paths (`hf.co/<org>/<repo>:<tag>`)** (Discord #general 2026-05-24). Symptom: A user reported the Thinking + Agent toggles both grayed out for every Gemma 4 community variant LU's Discover tab pulls (TrevorJS, nohurry, Stabhappy, LiconStudio, huihui-ai) while the official `gemma4:e4b` from Ollama had both enabled. Root cause was a two-stage match failure in `model-compatibility.ts`: (1) the prefix strip was non-greedy (`/^[^/]+\//`), so `hf.co/trevorjs/gemma-4-31b-it-uncensored-gguf:q4_k_m` only lost `hf.co/` and kept `trevorjs/` in front of the family token; (2) the family-dash collapse was anchored to start-of-string, so `gemma-4-…` mid-string never normalized to `gemma4`; (3) the final `.startsWith` couldn't see past the community prefix `huihui-` / `mradermacher/Huihui-` etc. v2.4.9 rewrites `normalizeFamily` to (a) greedy-strip the full path prefix (catches `hf.co/<user>/<repo>:<quant>`), (b) drop GGUF repo cruft (`-gguf`, `-imatrix`, `-max`, `-i1`, `-ud`), (c) drop tuning/variant markers (`-abliterated`, `-uncensored`, `-heretic`, `-instruct`, `-it`, `-chat`, `-base`), (d) drop quant suffixes (`-q\d…`, `-iq\d…`, `-mxfp\d`, `-nvfp\d`, `-bf\d+`), (e) collapse `gemma-4` / `qwen-3` / `llama-3.1` / `glm-4` / `phi-4` to the dash-less family form anywhere they appear, then matches via a new `containsFamily(family, normalized)` regex that requires non-alphanumeric boundaries on both sides so `mistral` doesn't collide with `mistralfork` and `gemma3xyz` stays excluded. Six new test cases pin the cases (TrevorJS, nohurry, Stabhappy, LiconStudio uncensored / heretic / abliterated repos, two-slash `hf.co/<user>/<repo>` shape, Huihui-prefixed community uncensored builds). One previous "by design" limitation in `model-compatibility-planner.test.ts` for `hf.co/<bart>/gemma4-…` is flipped: it should match, that was always the bug.

### Feature — Onboarding suggests `nomic-embed-text` for Document Chat (GH #45)

- **New onboarding step pulls the embedding model needed for Document Chat / RAG** (GH #45). v2.4.9 inserts an `embeddings` step between `models` and `done` in `Onboarding.tsx` STEP_ORDER. The step probes Ollama's installed model list for anything containing `embed`/`bge-`/`nomic` and auto-shows a "✓ Embedding model already installed" card if any are present (covers LM Studio + Ollama users who already have one). Otherwise it offers a one-click Install for `nomic-embed-text` (274 MB, runs on any CPU) with a progress bar and a Skip button. The Tauri Ollama-pull path is reused (`pullModelTauri('nomic-embed-text')`), gated by a `start_ollama` / `checkOllama` retry loop in case the daemon isn't reachable yet.

- **Upgrade-path coverage for users who completed onboarding before v2.4.9.** The new step above only fires for fresh installs — v2.4.8 → v2.4.9 upgraders never hit it. Three additions close that gap:
  - **`useRAG.uploadDocument` no longer uses `window.confirm`** for the embedding-missing case. Instead, the dropped file is queued in `ragStore.embeddingQueuedFiles` and `embeddingInstallPrompt` flips on. `RAGPanel` renders an in-app card with a Download (274 MB) + Cancel pair, matching the rest of the app chrome. After the pull succeeds, queued files replay automatically through the same `uploadDocument` path.
  - **The pull stream now feeds real bytes-level progress** into `ragStore.embeddingPullProgress` via a `setEmbeddingPullProgress({completed, total, status})` setter. `RAGPanel` renders a deterministic progress bar with `formatBytes(completed) / formatBytes(total) · pct%` instead of the pre-v2.4.9 bouncing-icon banner that showed nothing for 30+ seconds while 274 MB pulled in the background. An indeterminate marquee covers the manifest / verification phases where Ollama doesn't emit byte totals.
  - **Opening the Document Chat panel proactively surfaces the install card** when nomic-embed-text is missing. `RAGPanelInner` runs a one-shot `ensureEmbeddingModel` probe on mount and flips `embeddingInstallPrompt` when the model isn't there, so an upgrading user clicks the Docs button → immediately sees "Embedding model needed… [Download] [Cancel]" without having to drop a file first. Cancel hides the card for the open panel; re-opening probes again. Chrome is neutral white/gray (no blue tint) to match the v2.4.8 Q-polish pattern.

### Feature — VRAM filter for text models in Discover (GH #46)

- **VRAM tier sub-filter (Lightweight ≤10 GB, Mid-Range 10–16 GB, High-End >16 GB) on the text tab** (GH #46). Pre-v2.4.9 only image and video bundles had this filter; text models could only be narrowed by Uncensored / Mainstream. v2.4.9 surfaces the same filter chips on the text category in `DiscoverModels.tsx` and applies them to both `getUncensoredTextModels()` and `getMainstreamTextModels()` via each model's `sizeGB` field (Q4 quant ≈ VRAM need for fully-offloaded inference). Cloud / `canPull:false` entries without a `sizeGB` bypass the filter and always show, since "VRAM" is meaningless for them.

### Stability

- `vitest`: **2312 tests** green (previously 2306; +6 across Bug W session boundaries in `stores/__tests__/benchmarkStore.test.ts` and Bug X community-uncensored matching in `api/__tests__/model-compatibility.test.ts`; existing `model-compatibility-planner.test.ts` cases for `stuff-gemma3-mix` + `hf.co/<bart>/gemma4-X` updated to the new permissive-match semantics).
- `cargo test`: **101 passed + 1 ignored** (no changes to the test surface for Bug U / V/b — those land via existing integration paths).
- `tsc --noEmit`: clean. `cargo check`: clean (pre-existing dead-code warnings only).
- No breaking changes; the new IndexedDB backup is purely additive.

### Heads-up

Windows + Linux only — macOS is not part of this build. `#bug-reports` / `#help-*` / GitHub monitored daily for regression reports. Still open from v2.4.8: the OpenRouter half of a user report (passive, awaiting F12 console).

## [2.4.8] - 2026-05-23

Drop-in hotfix on top of v2.4.6. v2.4.7 was tagged but not separately released, so v2.4.8 ships its six fixes alongside two new ones plus a UX polish: nine changes total since the last public release.

### Fixed — Model Manager

- **Text models in Discover keep their INSTALLED badge after restart** (Bug S — GH #43). Pre-v2.4.8 `isModelFullyInstalled` in `src/components/models/DiscoverModels.tsx` only consulted the in-memory `downloads` store, which is empty after a relaunch. A model installed yesterday looked uninstalled today. v2.4.8 also matches against the provider model list (`useModels().models`) for Ollama tags and for HuggingFace GGUF downloads pulled in via `hf.co/<repo>:<quant>` references, so whatever Ollama and LM Studio actually have on disk surfaces correctly. Session downloads remain a fast-path signal that doesn't wait for a `fetchModels()` round-trip.

- **`canPull:false` text models get a clickable HuggingFace link** (Bug T — GH #44). Curated entries that have a HF page but no GGUF on day-one (Qwen 3.6 27B Samantha, GLM 5.1 754B MoE) render with a green "Available" badge instead of a Download button. Before v2.4.8 there was no UI to open the linked HF page. v2.4.8 adds an external-link icon button next to the Available badge for those entries.

### Fixed — LM Studio server-off banner UX polish

- **Dismiss-able with neutral chrome** (Bug Q polish). The v2.4.7 LM Studio server-off banner in the model picker was painted amber/gold and clashed with the surrounding dropdown. v2.4.8 switches to neutral `bg-white/[0.03]` + `text-gray-300/200` and adds a small X in the top-right to dismiss. The dismiss flag lives at module-scope (not React state) so it survives the dropdown unmount/remount cycle inside one LU run, but is not persisted to localStorage — the hint reappears on the next launch if the user forgot to start the LM Studio server.

### Included from v2.4.7 (which never shipped as its own release)

All six v2.4.7 fixes ride along — see the [2.4.7] section below for full detail. Brief recap:

- **Bug M** — Benchmark tok/s now matches actual chat throughput. Ollama path prefers server-reported `eval_count` / `eval_duration`; OpenAI-compat falls back to wall-clock when streaming is buffered.
- **Bug N** — `install_comfyui` + `install_custom_node` probe `git --version` before clone and surface a "Install Git for Windows" hint when missing or non-native.
- **Bug O** — Anthropic provider's `messagesUrl()` collapses a trailing `/v1` so proxy users with `https://proxy.example/v1` baseUrl no longer get `…/v1/v1/messages`.
- **Bug P** — Image / video generation timeouts now configurable in Settings (defaults 20 min image / 60 min video, range 1–480 min).
- **Bug Q** — Chat model picker shows "Start LM Studio Server" banner when LM Studio is installed but its HTTP server is off.
- **Bug R** — Custom ComfyUI save nodes' outputs now surface in LU's gallery (generic extractor accepts any keyed array of file-shaped objects).

### Stability

- `vitest`: **2306 tests** green.
- `cargo test --release`: **100 passed + 1 ignored** (incl. live `git_probe_live_on_this_host`).
- `tsc --noEmit`: clean. `cargo check`: clean (pre-existing dead-code warnings only).
- No breaking changes, no localStorage migration — upgrade in place.

### Heads-up

v2.4.8 is a Windows + Linux release; macOS is not part of this build. `#bug-reports` / `#help-*` / GitHub will be monitored daily for regression reports.

Still investigating: OpenRouter half of a user's report (needs F12 console output to repro).

## [2.4.7] - 2026-05-22

Drop-in hotfix on top of v2.4.6. Five bugs: four user-reported (M — Discord; N — GH #40; O — Discord; P — Discord; R — GH Discussion #6) plus internal hardening on the ComfyUI history-output extractor.

### Fixed — benchmark accuracy

- **Benchmark tok/s now excludes time-to-first-token + stream init** (Bug M — Discord #help-chat, 2026-05-19). Pre-v2.4.7 `useBenchmark.runBenchmark` started the clock at `performance.now()` before opening the chat stream and used the resulting `totalTime` as the denominator for `tokensPerSec`. On any setup with non-trivial first-token latency (warm-up cost, connection init, ollama model load), the benchmark undercounted generation-phase throughput. a user's RTX 4070 Laptop 8 GB + gemma4:e4b reproduced the issue cleanly: ollama CLI baseline 30 tok/s, manual chat measurement 23–25 tok/s, pre-v2.4.7 benchmark 12 tok/s. v2.4.7 extracts `computeGenerationTps(tokenCount, totalTime, firstTokenTime)` into `src/stores/benchmarkStore.ts` as a pure helper, subtracts TTFT from the denominator, guards against `generationTime <= 0` for degenerate runs (0-token, 1-token, totalTime ≤ firstTokenTime). `useBenchmark.ts:55` now calls the helper; `timeToFirstToken` continues to surface as its own stat in the benchmark UI so users can compare TTFT and steady-state separately. Seven new vitest cases pin the math: nominal extraction, nightmare's exact 12-vs-24 tok/s reconstruction, zero-token guard, zero-generation-time guard, tiny TTFT relative to totalTime, single-token degenerate case.

  Late-shipping pre-release E2E in the actual release build (not vite-dev) found that the TTFT-subtraction formula alone was not enough. The Tauri Rust proxy (`proxy_localhost_stream`) collects bytes before returning, and WebView2 release-mode also aggregates TCP chunks for short responses. The result: for fast small models, all NDJSON lines arrive in JS within a single millisecond — `firstTokenTime ≈ totalTime`, `generationTimeMs ≈ 0`, formula returns numbers like 685,000 tok/s. To make the fix real for release builds, the Ollama provider now extracts the authoritative `eval_count` (tokens) and `eval_duration` (ns) fields from the server's final `done:true` chunk and forwards them via two new optional fields on `ChatStreamChunk` (`evalCount`, `evalDurationMs`). `useBenchmark` prefers these over JS timing whenever they're set: post-fix Ollama benchmark on this host now shows qwen2.5:0.5b at ~245 tok/s (matches Ollama API baseline 241.5) instead of 685,000. For providers that don't return server-side metrics (LM Studio / OpenAI-compat / vLLM / Anthropic), a sanity fallback kicks in: when `generationTimeMs < 100` and no API metrics, the formula falls back to wall-clock rate (`tokens / totalTime * 1000`) so the displayed number stays sane rather than blowing up to six-figure values. LM Studio q4_k_m benchmark on this host shows 85–136 tok/s via this path (vs the previous absurd readouts).

### Fixed — Windows / ComfyUI install

- **`install_comfyui` + `install_custom_node` now probe `git --version` before clone** (Bug N — GH issue #40, 2026-05-18). The existing spawn-error guard catches a flat "git not on PATH" failure, but it can't tell when a WSL / Linux-mounted git binary is first on PATH on a Windows machine — `git --version` succeeds, the clone *starts*, then dies because the Linux binary can't handle Windows-style target paths. The user ends up with a half-cloned ComfyUI directory and no actionable hint. v2.4.7 adds a tri-state `WindowsGitState` probe (Native / NonNative / Missing) in `src-tauri/src/commands/install.rs`. Native (`git version 2.x.x.windows.y` tag) proceeds silently. Missing blocks the install with a clear "install Git for Windows from https://git-scm.com/download/win and restart LU" hint. NonNative (no `.windows` tag — MSYS git, Cygwin git, or a WSL binary mounted into Windows PATH) surfaces a soft warning into the install panel logs but proceeds, since many MSYS/Cygwin gits actually handle Windows paths fine. Eleven new cargo unit tests pin the classification matrix (Git for Windows, WSL git, MSYS git, broken install, empty stdout, garbage stdout, case-insensitive) plus the install-hint copy (must mention `git-scm.com/download/win`, must mention PATH ordering for the WSL case).

### Fixed — Anthropic custom-proxy provider

- **Anthropic provider no longer double-prefixes `/v1` when the user's baseUrl already ends in `/v1`** (Bug O — Discord 2026-05-18). Pre-v2.4.7 the provider unconditionally appended `/v1/messages` to the configured baseUrl. Users pointing the Anthropic provider at a proxy (claude-relay-server, LiteLLM, opencode-zen) sometimes paste a baseUrl with `/v1` already in the path — the proxy operator pinned the API version in their docs — and got back a silent 404 on `https://proxy.example/v1/v1/messages`. v2.4.7 collapses the second `/v1` via a new `messagesUrl()` helper that drops a trailing `/v1` before appending `/messages`. The default `https://api.anthropic.com` shape still produces the canonical `/v1/messages`, and `https://proxy.example/api-v1` (different non-suffix path that happens to contain "v1") still gets the standard `/v1/messages` append. Five new vitest cases cover both proxy shapes, trailing-slash tolerance, the default Anthropic URL, and the defensive non-suffix-`v1` case. OpenRouter half of a user's original report is still under investigation pending more F12-console context from the reporter — that path lands in v2.4.8 if it turns out to need a code change rather than a config one.

### Fixed — LM Studio model picker

- **Chat model picker now surfaces a "Start LM Studio Server" hint when LM Studio is installed but its server is off** (Bug Q — GH #41, 2026-05-19). Symptom: user has LM Studio installed with models on disk, opens LU's model picker, sees only Ollama models, no clue that LM Studio is missing because its server stopped. Root cause is straightforward: LM Studio's HTTP server doesn't auto-start with the app — the user has to run `lms server start` or click Developer → Start Server in the LM Studio UI. With the server off, LU's openai-compat probe gets no models and silently drops the LM Studio backend from the picker. v2.4.4 added the same hint to onboarding, but onboarding only runs once on first launch — returning users hit a stopped server with no visible signal. v2.4.7 wires the existing `lmstudio_server_status` Tauri command into `ModelSelector`'s dropdown and renders an inline banner with a working "Start LM Studio Server" button when `(lms_present || models_detected) && !running`. The button calls the existing `start_lmstudio_server` Tauri command, polls status for up to ~6 s for the server to bind 1234, then triggers a fresh `fetchModels()` so the LM Studio models appear in the dropdown without an LU restart. Live E2E in release build: with LM Studio server stopped, picker shows the banner with the right on-disk model count ("5 models on disk"). Clicking the button starts the server, the banner replaces itself with the LM Studio models, no app restart required.

### Fixed — image / video timeouts

- **Image and video generation timeouts are now user-configurable** (Bug P — Discord #help-chat, 2026-05-19). Pre-v2.4.7 image gens timed out at a hard-coded 20 min and video at 60 min. That was a sane default for desktop NVIDIA hardware but actively painful for the CPU-only / iGPU edge: a user's 12th-gen Intel Core + Intel UHD Graphics (128 MB allotment) finished sampling step 9 of 25 on a 1024 px Juggernaut-XL run before the 20-minute cap killed the job mid-sampler, with no way to recover the partial work. v2.4.7 adds `imageGenTimeoutMinutes` and `videoGenTimeoutMinutes` to `types/settings.ts` with defaults 20 and 60 (matching pre-v2.4.7 behavior on fresh installs and via the persisted-store migration), reads them in `useCreate.generate()` with a `Math.max(1, …)` clamp to prevent footguns from a 0-min input, and surfaces both as numeric inputs in `SettingsPage`'s new "Image / Video Generation Timeouts" section with an explanatory blurb naming the iGPU / CPU-only use case directly. Users on slow hardware can now bump both caps as needed (range 1–480 min); fast-GPU users see no change.

  Two release-mode polish items found during pre-ship E2E and folded into the same ship: (1) the inputs now use `value={settings.imageGenTimeoutMinutes ?? 20}` (and `?? 60` for video) so existing v2.4.6 users — whose persisted settings store predates these fields — see the defaults rendered as the field value instead of an empty input. Functionally `useCreate.generate()` already fell back to the defaults via `Math.max(1, settings.imageGenTimeoutMinutes || 20)`, so this is a UX-only patch; the saved timeout was always correct, just invisible on the first Settings visit after upgrade. (2) The `onChange` handler now clamps the upper bound too — `Math.min(480, Math.max(1, …))` — matching the HTML `max=480` attribute that was previously only a browser hint. Typing 999 used to persist as 999; v2.4.7 caps it at 480, so users who blindly type a large number to "disable" the timeout cap at the documented range instead.

### Fixed — ComfyUI output extraction

- **Custom save nodes' outputs now surface in LU's gallery** (Bug R — GH Discussion #6, 2026-05-20). Pre-v2.4.7 `useCreate.ts` only scraped `nodeOutput.images`, `nodeOutput.gifs`, and `nodeOutput.videos` from each entry in ComfyUI's `/history/{promptId}` payload. That worked for the canonical SaveImage / SaveAnimatedWEBP / VHS_VideoCombine nodes, but every community workflow that uses a non-canonical save node — SaveImageWithMetadata posts under `result`, audio save nodes under `audio`, plenty of CivitAI workflows define their own keys — dropped its file on disk in ComfyUI's `output/` folder and never made it into LU's gallery. a user's symptom was exactly that: "I can send a generation request to ComfyUI and I can see the output in ComfyUI itself, but the result never comes back to LU." v2.4.7 extracts the extraction logic into a generic helper `extractComfyOutputFiles(nodeOutput)` in `src/api/comfyui.ts` that scans every key on the node output, accepts any array whose entries have a string `filename`, and fills in safe defaults for `subfolder` (`''`) and `type` (`'output'`) so downstream URL construction still works when a custom node omits them. Wired into all three `useCreate.ts` history-poll sites (WebSocket-branch heartbeat poll, WebSocket-branch completion path, polling-only fallback) so the fix applies regardless of which transport ComfyUI is on. Ten new vitest cases pin canonical-keys, custom-keys, audio, multi-key-on-same-node, missing-subfolder-and-type defaults, non-array values (LATENT, metadata, scalars), invalid array entries (missing filename, non-string filename, null), and the empty/null/undefined input guard.

### Tests

- `vitest`: **2306 passed** (previously 2284, +22 across the v2.4.7 bug fixes — +7 benchmark TPS math in `stores/__tests__/benchmarkStore.test.ts`, +5 Anthropic messages-URL in `api/__tests__/provider-anthropic.test.ts`, +10 ComfyUI output extraction in `api/__tests__/comfyui-models.test.ts`).
- `cargo test --release --bins`: **100 passed + 1 ignored** (previously 89, +11 for `WindowsGitState` classification + install-hint copy in `commands/install.rs`).
- `cargo check --release`: clean (pre-existing dead-code warnings only).
- `tsc --noEmit`: clean.

### Deferred to v2.4.8

- **Bug Q** — GH #41 ("LM Studio installed but can't choose any models, worked first time, broken today"). Most plausible root cause is the LM Studio server having been stopped between the two runs (LM Studio closes its server when the desktop app is quit). The "no models — start LM Studio server" hint added in v2.4.4 already surfaces this state, so before landing a code change we want the reporter's F12 console output to confirm whether `listModels()` is timing out, returning empty, or failing auth. Carried into v2.4.8's outreach-then-fix queue rather than guessing at a fix that could regress the path that already works for everyone else.

## [2.4.6] - 2026-05-19

Drop-in hotfix on top of v2.4.5. **One bug**: A user (Discord 2026-05-18).

### Fixed — chat throughput on tight VRAM cards

- **Dropped hardcoded `num_gpu: 99` override on every Ollama chat request** (Bug L — Discord #help-chat, 2026-05-18). The override was added in v2.2.1 (commit `ead5673`, april 2026) on the assumption "all desktop users have 16 GB+ cards, Ollama's auto-detect is too conservative, force max GPU offload." That assumption no longer holds with 2026 laptop GPUs (RTX 4070 Laptop ships with 8 GB) and modern model context windows (Gemma 3/4 advertise 128k native context, which materially expands the KV cache footprint). Symptom on a user's RTX 4070 Laptop 8 GB + gemma3:4b: ollama CLI without `num_gpu` ran at **30 tok/s** with sane VRAM use; LU's chat hit **6.9 tok/s** with VRAM saturated and 4 GB spilled to system RAM. The forced 99-layer offload exhausted VRAM, the KV cache had nowhere to live except system RAM, and every generated token thrashed across the PCIe bus. v2.4.6 removes the override from all five chat sites — `chatStream`, `chatStreamWithTools`, and `chatWithTools` in `src/api/ollama.ts`, `chatStream` and `chatWithTools` in `src/api/providers/ollama-provider.ts`, the Agent-Mode tool-call body in `src/lib/ollama-stream-tools.ts`, and both Remote-Access JS-template paths (`nativeToolChat` and the main agent loop) in `src-tauri/src/commands/remote.rs`. Ollama now applies its own VRAM-aware layer-placement logic on every request, which is a no-op on cards with headroom (Ollama already maxes layer count when VRAM allows) and restores CLI parity on tight cards.

### Tests

- `vitest`: **2284 passed** (93 files, unchanged count). Rewrote one existing assertion in `provider-ollama.test.ts` ("always includes options with num_gpu" → "v2.4.6 Bug L: NEVER sets num_gpu — Ollama decides layer placement itself") and two assertions in `mobile-parity.test.ts` to lock down the absence of `num_gpu` in the request body.
- `cargo test --release`: **89 passed + 1 ignored** — no Rust unit-test changes (the Rust edits were in JS templates that aren't unit-tested at the Rust layer).
- `cargo check --release`: clean (pre-existing dead-code warnings only).

## [2.4.5] - 2026-05-17

Drop-in hotfix on top of v2.4.4. **Fourteen bugs total**: six user-reported (A — Discord/Reddit; B — GH #38; C — GH Discussion #39; D — Discord; E — GH #32 comment; K — Discord #help-coding-agent) plus eight surfaced during the real-tester Arch live verification sweep (F — `install_custom_node` not venv-aware on PEP 668; G — `install_ollama` Windows-only `.exe` download, plus a refix when the original tarball URL stopped resolving; H — `install_lmstudio` Windows-only; I — `install_python` Windows-only winget; J — `start_comfyui` crashes on non-NVIDIA systems without `--cpu` flag).

### Fixed — image / video creation
- **Video output now actually produces `.mp4` files** (Bug A — Discord 14.05. Reddit 10.05.). v2.4.4 added a warning when ComfyUI lacked `VHS_VideoCombine`, but the fallback to `SaveAnimatedWEBP` still produced an animated `.webp` "image" instead of a video. v2.4.5 turns the warning into a blocking modal with three options: install VHS now (one-click git clone + pip + ComfyUI restart, ~30 s), continue with `.webp`, or cancel. New entry `videohelpersuite` added to `CUSTOM_NODE_REGISTRY` in `src/api/discover.ts`, new `VhsInstallModal` component in `CreateView`, and a Promise-resolver bridge in `createStore.vhsInstallPrompt` so `useCreate.generate()` can await the user's choice. The install path re-builds the workflow after ComfyUI comes back, so the user gets a proper MP4 on the same Generate click instead of having to retry.

### Fixed — onboarding / startup
- **"ComfyUI loading..." now surfaces actionable UI after 60 s** (Bug B — GH #38). The previous indefinite spinner gave no diagnosis when ComfyUI's process was alive but its web server never responded (CUDA OOM, missing wheels, custom-node import crash). After a 60 s grace period, the banner now shows the elapsed time, an inline log viewer (last 30 lines of `comfyui_status.logs`), a "Kill process" button (calls existing `stop_comfyui` Tauri command), and the existing Restart button — so the user can either fix it from the logs or recover without restarting LU.

### Fixed — chat / Ollama
- **One-click repair for "unable to load model: …blobs/sha256-…" errors** (Bug C — GH Discussion #39, RTX 4090). Ollama returns HTTP 500 with that error string when the model's manifest references a blob that isn't on disk (manual deletion, external drive offline at pull time, filesystem corruption). v2.4.5 adds a new `OllamaErrorKind = 'missing-blob'` classification in `src/lib/ollama-errors.ts` with a regex matching `unable to load model[:\s].*blobs[\\/]+sha256-[0-9a-f]+`. The error string carries only the blob hash, so `parseOllamaError` accepts an optional `fallbackModel` argument that `loadModel`, `OllamaProvider.chatStream`, and `OllamaProvider.chatWithTools` now pass through. `Header.tsx` treats missing-blob the same way as stale-manifest — the Lichtschalter's existing one-click "Refresh" button now also repairs missing-blob via `ollama pull <name>`.

### Fixed — context window detection
- **Dynamic context-window detection for LM Studio + Ollama** (Bug K — Discord #help-coding-agent, 2026-05-04). Pre-fix LU cached an 8k fallback for unknown OpenAI-compatible models and never asked the server what the model actually supports, so the header showed 8k and the settings slider capped there even when the model could do 32k or 128k. `OpenAIProvider.getContextLength` now cascades: (1) `KNOWN_CONTEXT` table (expanded from 9 to 24 entries: gpt-5, o1/o3, deepseek-r1, llama-3.3, Groq + OpenRouter aliases), (2) `probeContextFromServer` for local backends — first the LM Studio Enhanced API `/api/v0/models/<id>` which returns `max_context_length` + `loaded_context_length` directly, then the generic `/v1/models/<id>` returning `context_window` / `max_model_len` / `n_ctx_train` on vLLM, llama.cpp server, others, (3) `guessContextFromName` heuristic for unknown families (llama-3.x → 131072, qwen2.5 → 32768, deepseek-r1 → 64000, etc.), (4) 8k hard fallback only if all three fail. `listModels` enriches contextLength in parallel via `Promise.all` so dropdowns surface real max context immediately. Cloud URLs skip the probe (no N+1, latency cost not warranted). `OllamaProvider.getContextLength` replaces the single `general.context_length` check with the same cascade pattern: tries `model_info["general.context_length"]` first, then any key ending in `.context_length` (Ollama leaves `general.context_length` empty for qwen2.5 and llama3.x and uses architecture-specific keys like `qwen2.context_length`, `llama.context_length`), then `parameters.num_ctx` (object or Modelfile-style string), then 4096 fallback. +13 new vitest cases (7 OpenAI + 4 Ollama + 3 heuristic + 1 fragile-test rewrite). Live verified on Arch + Host with multiple LM Studio + Ollama models.

### Fixed — Linux / AppImage
- **Arch / Wayland AppImage now actually paints content** (Bug D — Discord 11.05.). The "empty window" symptom on Arch is Tauri 2 + webkit2gtk-4.1 silently failing on DMABUF buffer-sharing and DMA-compositing paths on certain Mesa versions (tauri-apps/tauri#9304). `src-tauri/src/main.rs` now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` at startup on Linux, falling back to software composite — same workaround the GNOME and KDE maintainers recommend. Only set when the user hasn't already exported the vars themselves. `tauri.conf.json` also now declares explicit `bundle.linux.deb.depends` and `bundle.linux.rpm.depends` for `webkit2gtk-4.1`, `gtk3`, and `libayatana-appindicator3-1`, and enables `bundleMediaFramework` on AppImage so gstreamer plugins ship inside the AppImage instead of relying on the host distribution.

### Fixed — Linux / ComfyUI runtime
- **`start_comfyui` + `auto_start_comfyui` pass `--cpu` on non-NVIDIA systems** (Bug J — discovered during 2026-05-17 Arch real-tester sweep). ComfyUI 0.21.x's `main.py` calls `get_torch_device()` → `torch.cuda.current_device()` unconditionally during import. On every Linux system without an NVIDIA driver (AMD ROCm setups, Intel Arc, pure CPU boxes, any user who hasn't installed `nvidia` yet), `torch.cuda._lazy_init()` raises `RuntimeError: Found no NVIDIA driver on your system` and `main.py` crashes before binding port 8188. The user then sees LU stuck on "ComfyUI loading…" (Bug B's 60-s panel surfaces this correctly, but the underlying spawn-then-crash burns time on every restart). New helper `process::needs_cpu_fallback()` probes `nvidia-smi`; when it's absent (and we're not on macOS, where PyTorch uses MPS and never touches cuda APIs), both ComfyUI spawn paths append `--cpu` to the argv. Live-verified on Arch VirtualBox VM 2026-05-17: pre-fix, `main.py` crashed with the verbatim `Found no NVIDIA driver` traceback; post-fix, ComfyUI 0.21.1 started cleanly in CPU mode and answered `/system_stats` after 15 s. Note: AMD/Intel users CURRENTLY downgrade to CPU too — a follow-up will probe `rocm-smi` and Intel XPU devices to pick the right backend, but the safe default is "no crash."

### Fixed — Linux / Ollama install
- **`install_ollama` now has a proper Linux path** (Bug G — discovered during 2026-05-17 Arch real-tester sweep, then refixed when live testing caught a broken tarball URL the same evening). Pre-fix: `install_ollama` unconditionally downloaded `https://ollama.com/download/OllamaSetup.exe` (a Windows NSIS installer) and tried to execute it with `/S`. On Linux that fails with `Exec format error`; on macOS with the same binary-format mismatch. The user got a cryptic install failure with no actionable path. v2.4.5 dispatches by `target_os`: Windows keeps the existing NSIS flow; **macOS** surfaces a clear pointer at https://ollama.com/download/mac (auto-installing a code-signed `.app` past Gatekeeper from a Tauri process is brittle); **Linux** uses a distro-package hint path. The original v2.4.5 fix tried to download `https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64` from GitHub releases, but live testing on a real Arch VM caught that this URL stopped resolving in late 2025 — Ollama removed the raw amd64 binary asset and now ships `ollama-linux-amd64.tar.zst`, a 2–3 GB tarball with bundled CUDA libs that is too large for a click-to-install button. The refix instead checks if `ollama` is already on `$PATH` (e.g. via `pacman -S ollama` on Arch) and if so spawns `ollama serve` directly + waits for the API; otherwise it surfaces a distro-specific install command via the new `linux_ollama_install_hint(os_release)` helper that parses `/etc/os-release` ID + ID_LIKE tokens and routes to: `sudo pacman -S ollama` (Arch family), `sudo apt install ollama` for Debian 12+ / Ubuntu 23.10+ or `curl -fsSL https://ollama.com/install.sh | sh` (Debian family), `curl -fsSL https://ollama.com/install.sh | sh` (RHEL family), `sudo zypper install ollama` Tumbleweed or install.sh (SUSE family), install.sh or manual download (unknown). Both `install_ollama` and `wait_for_ollama_ready()` reuse the existing startup probe. 8 new cargo unit tests cover the full distro matrix.

### Fixed — Linux + macOS / LM Studio install
- **`install_lmstudio` no longer tries to run a Windows installer on Linux + macOS** (Bug H — discovered during 2026-05-17 Arch real-tester sweep). Pre-fix: `install_lmstudio` unconditionally downloaded `LMStudioSetup.exe` and tried `/S`. Same `Exec format error` on Linux + macOS as Bug G. LM Studio's Linux distribution is an AppImage whose URL rotates with every release (no stable string to mirror) and macOS distributes a code-signed `.app`. v2.4.5 surfaces a clear download pointer at `https://lmstudio.ai/download` for both non-Windows platforms with platform-specific install instructions (AppImage `chmod +x` for Linux, drag to `/Applications` for macOS). Windows path unchanged.

### Fixed — Linux + macOS / Python install
- **`install_python` no longer invokes Windows-only `winget` on Linux + macOS** (Bug I — discovered during 2026-05-17 Arch real-tester sweep). Pre-fix: `install_python` unconditionally called `Command::new("winget")` which on Linux/macOS fails with `winget: command not found`. In practice Python is virtually always pre-installed on Linux (base group on Arch, default on Debian/Ubuntu/Fedora) so the button rarely fires, but the failure path is unhelpful when it does. v2.4.5 detects the distro family from `/etc/os-release` (parses `ID` + `ID_LIKE` tokens correctly across quoted multi-value formats) and surfaces a distro-specific install command: `sudo pacman -S python python-pip` for Arch/Manjaro/EndeavourOS/Garuda; `sudo apt install python3 python3-pip python3-venv` for Debian/Ubuntu/Mint/Pop!/elementary; `sudo dnf install python3 python3-pip` for Fedora/RHEL/CentOS/Rocky/AlmaLinux; `sudo zypper install python3 python3-pip` for openSUSE/SLES. macOS suggests `brew install python` or python.org. Generic fallback for unknown distros points at "your distro's package manager." Tested via 9 cargo unit tests covering the full distro matrix including quoted-multi-value `ID_LIKE="rhel centos fedora"` format that Rocky uses.

### Fixed — Linux / custom-node install
- **`install_custom_node` now uses the ComfyUI venv when present** (Bug F — discovered during Arch live verification 2026-05-17). The `install_custom_node` Tauri command (used by Bug A's VHS install path among others) used to call pip against `state.python_bin` (the system Python). On Arch and other PEP 668 distros the requirements install would silently fail with `error: externally-managed-environment` — and since the function did `let _ = pip.output()` and ignored the exit code, the user got a "installed" status while the requirements never actually landed. The next workflow build then crashed with `ModuleNotFoundError`. `install_custom_node` now (1) resolves `<ComfyUI>/venv` via the shared `resolve_comfyui_venv_python()` helper from `src-tauri/src/python.rs`, falling back to `state.python_bin` only when no venv exists, and (2) captures pip's exit status + stderr and runs them through `diagnose_pip_error` so PEP 668 / connection / disk-full / etc. surface actionable messages. This bug only fired on PEP 668 distros (Arch / Debian 12+ / Fedora 38+ / Ubuntu 23.04+) when the user installed ComfyUI through LU's installer (which creates the venv) and then tried to install any custom node afterwards. **LIVE-VERIFIED on REAL Arch 2026-05-17**: in the installed-Arch VM, simulated Bug E's outcome by creating `<ComfyUI>/venv`, then ran the EXACT pip flow `install_custom_node` would issue. (a) venv-python path: `requests>=2.0` installed cleanly into the venv's site-packages, `python -c "import requests; print(requests.__version__)"` returned `2.34.2`; (b) system-python path (what the pre-fix code would have done): pip exited with `error: externally-managed-environment` + Arch's verbatim "If you believe this is a mistake, please contact your Python installation or OS distribution provider … See PEP 668 for the detailed specification" message. Both legs proven empirically.

### Fixed — Linux / ComfyUI install
- **PEP 668 protected Pythons (Arch, Debian 12+, Fedora 38+, Ubuntu 23.04+) no longer brick the ComfyUI install** (Bug E — GH #32 comment 2026-05-08). A bare `python -m pip install torch ...` exits with `error: externally-managed-environment` on those distros because the stdlib carries an `EXTERNALLY-MANAGED` marker file. v2.4.5 detects the marker via `sysconfig.get_path('stdlib')`, then runs `python -m venv <ComfyUI>/venv` and uses the venv's Python for every subsequent pip step. New helpers `is_pep668_protected`, `create_comfyui_venv`, and `venv_python_path` live in `src-tauri/src/commands/install.rs` and `src-tauri/src/python.rs`. `process.rs::start_comfyui` and `auto_start_comfyui` mirror the lookup so ComfyUI launches with the venv Python it was installed against — no `ModuleNotFoundError: torch` on first run. When the system Python's `venv` module is missing (some minimal Arch installs), the error now surfaces a one-line fix: `sudo pacman -S python-virtualenv` (or `apt install python3-venv` / `dnf install python3-virtualenv`). `diagnose_pip_error` also catches the externally-managed string directly as a fallback for anyone whose Python somehow bypasses the venv path.

### Tests
- `vitest`: **2284 passed** (93 files) — +7 for `parseOllamaError` missing-blob coverage in `src/lib/__tests__/ollama-errors.test.ts` (a user verbatim error, generic no-fallback-model, forward+back-slash tolerance, Rust-proxy wrapping, chat-style message wording with + without model), +1 smoke test for the new `videohelpersuite` `CUSTOM_NODE_REGISTRY` entry, +13 for Bug K context-window detection across `provider-openai.test.ts` (LM Studio Enhanced API probe, generic `/v1/models/<id>` fallback, heuristic cascade, no-probe for cloud, listModels enrichment) and `provider-ollama.test.ts` (architecture-specific key cascade), +1 fragile 401 test rewrite.
- `cargo test --release`: **89 passed + 1 ignored** — +5 for Bug D (webkit env-var workarounds) + 13 for Bug E (PEP 668 detection, venv path layout, diagnose hints) + 9 for Bug I (`linux_python_install_hint` distro matrix: Arch, Manjaro via `ID_LIKE`, Ubuntu, Debian, Fedora, Rocky via quoted `ID_LIKE="rhel centos fedora"`, openSUSE, unknown fallback, empty input) + 2 for Bug J (`needs_cpu_fallback` macOS short-circuit + determinism) + 8 for Bug G refix (`linux_ollama_install_hint` matching the same distro matrix). Bug D + Bug F + Bug H code-paths cross-platform via cfg gates. Bug E has a `#[ignore]`'d live integration test (`pep668_e2e_live_detect_and_create_venv`) driven against real Arch's `/usr/bin/python` during the 2026-05-17 verification.
- `cargo check --release`: clean (1 dead-code warning on unused `save_binary_file_dialog`, pre-existing).
- `tsc --noEmit`: clean.

### Verification — HARDCORE LIVE E2E (Windows 10 + RTX 3060 Ti + ComfyUI 0.12.0 via Computer-Use)
- **Bug A**: Modal "Install MP4 support?" appears on Generate when `VHS_VideoCombine` missing. **Full install path live-verified** end-to-end: git clone of Kosinkadink/ComfyUI-VideoHelperSuite into `custom_nodes/`, pip install (opencv-python + imageio-ffmpeg), ComfyUI stop+start, reconnect-poll, workflow rebuild, actual Wan-video sampling phase started ("Loading text encoder... 2s"). Cancel path also verified (modal closes cleanly, returns to "Ready to generate").
- **Bug B**: Suspended ComfyUI via `NtSuspendProcess` while user navigates back to Create tab → triggers `useEffect` re-mount, `pollStatus` re-starts, detects ComfyUI down. Live-verified entire UI sequence: (1) "ComfyUI loading (12s)" elapsed-counter banner, (2) switch to actionable "ComfyUI is taking unusually long (86s)" panel after 60s threshold, (3) failure-mode explanation text rendered, (4) "View logs" toggle works (button label flips to "Hide logs"), (5) empty-logs fallback message renders ("No startup logs captured yet — ComfyUI hasn't emitted anything to stdout."), (6) "Kill process" button actually kills the spawned ComfyUI process (verified via PID gone + port 8188 free), (7) state machine transitions cleanly to "ComfyUI not responding" with Retry, (8) Retry click respawns ComfyUI which comes back online.
- **Bug C**: Disabled the qwen2.5:0.5b blob (`sha256-c5396e...`) → triggered LU's startup health scan → banner "Ollama 0.20.7 broke 1 of your model. qwen2.5:0.5b" appeared + inline "stale — refresh? ↻ Refresh" chip next to Lichtschalter. Clicked "Refresh all" → `pullModel` triggered → DownloadBadge showed completion within seconds. Note: Ollama 0.20.7 transforms ALL blob errors (missing OR 0-byte corrupted) into the `"X does not support generate"` pattern, so the new `missing-blob` regex primarily protects users on older Ollama versions (a user's exact scenario on RTX 4090). Both error paths route to the same one-click repair UX.
- **Bug D**: Linux webkit env-var function unit-tested cross-platform via 5 cargo tests (sets-both-when-unset, preserves user DMABUF override, preserves user COMPOSITING override, preserves empty-string as explicit unset, idempotent). **LIVE-VERIFIED on REAL Arch Linux + Wayland 2026-05-17**: installed Arch (kernel 7.0.8) in a VirtualBox VM, booted into a headless `sway` session (WLR_BACKENDS=headless, WLR_RENDERER=pixman, WLR_HEADLESS_OUTPUTS=1), built the LU release binary on the guest (`cargo build --release`, 7m 01s), and ran it twice: (a) defaults — `apply_linux_webkit_workarounds()` auto-sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` + `WEBKIT_DISABLE_COMPOSITING_MODE=1`, LU survives + window opens; (b) user override — `WEBKIT_DISABLE_DMABUF_RENDERER=0 WEBKIT_DISABLE_COMPOSITING_MODE=0`, fix respects the override (still works on this particular Mesa setup, would crash on a user-style broken DMABUF stacks). `grim` screenshots captured the actual LU onboarding screen ("Locally Uncensored", "Private, local AI chat. No servers, no tracking, everything stays on your machine.", "Get Started" button, 5-dot pagination) at 1280x800, **742 unique pixel colors** — definitive proof the window is no longer an empty black rectangle. Screenshots at `LU-E2E-Test-Kit/scripts/arch_live_e2e_screenshots/bugd-scenario1-fix-active.png` + `…-bypassed.png`.
- **Bug E**: PEP 668 detection + venv creation unit-tested cross-platform via 13 cargo tests across `install.rs::tests` and `python.rs::tests`. Path-layout tests cover both Windows (`venv/Scripts/python.exe`) and Unix (`venv/bin/python`) layouts. Resolver tests use real tempdirs to verify the `Some(path)` vs `None` gating. Diagnose tests cover Arch's exact `error: externally-managed-environment` string from a user's report plus the shorter `error: externally-managed` variant and confirm the suggested distro-install commands (`pacman -S python-virtualenv`, `apt install python3-venv`, `dnf install python3-virtualenv`) appear in the user-facing hint. **Plus a HARDCORE LIVE E2E test (`pep668_e2e_live_detect_and_create_venv`, `#[ignore]`'d so it runs on demand) drives the full flow against a real Python install whose stdlib has a real `EXTERNALLY-MANAGED` marker file. The test verifies: (1) `is_pep668_protected` returns true against the marker-planted Python, (2) `create_comfyui_venv` succeeds and produces the venv-Python at `<ComfyUI>/venv/{Scripts|bin}/python(.exe)`, (3) the nested venv's pip runs without inheriting the PEP 668 block (the whole point of the fix), (4) a second `create_comfyui_venv` call is idempotent. Setup + run scripted in `LU-E2E-Test-Kit/scripts/pep668_live_test.ps1`: robocopies the system Python to a writable temp dir, plants the marker in the copy's stdlib (NOT the real system Python — that would wedge every pip on the box), runs cargo with `LU_PEP668_TEST_PYTHON` set, cleans up. Result: all 4 phases passed against Python 3.11.7 + planted marker on 2026-05-17.** **AND — on top of the Windows simulation — Bug E was ALSO live-verified against a REAL Arch Linux ISO booted in a VirtualBox VM on 2026-05-17. The Arch live ISO ships Python 3.14.4 with the actual `/usr/lib/python3.14/EXTERNALLY-MANAGED` marker (multiline Arch text mentioning `pacman -S python-xyz`, identical to what a user's installer saw). Seven assertions all passed against this real environment: detection logic returns `YES`, `python -m venv` succeeds, venv Python lands at `/tmp/foo/venv/bin/python` (matching the Unix branch of `venv_python_path`), pip inside the venv is unblocked (downloads requests metadata without `externally-managed` error), idempotency holds, and the Rust-side equivalence of the shell probe matches verbatim. See `LU-E2E-Test-Kit/scripts/arch_live_e2e.md` for the full transcript. This live test also uncovered Bug F (separate fix above).**

## [2.4.4] - 2026-05-11

Hotfix sweep covering the v2.4.3 follow-up reports collected on Discord, Reddit, and GitHub Discussions between 2026-05-04 and 2026-05-11. Eight fixes total — six tied to specific Discord/Reddit reporters, one Reddit issue, and one GitHub Discussion (a user — RTX 6000 Blackwell, posted the same morning this sweep landed).

### Fixed — onboarding (LM Studio + ComfyUI)
- **LM Studio system-wide install path now detected** (Bug #2 —, Discord 06.05.). `lmstudio_lms_path()` previously only looked under `~/.lmstudio/bin/`, `%LOCALAPPDATA%\Programs\LM Studio\` and `where lms`, so a "for all users" install in `C:\Program Files\LM Studio\` came back as `lms_present: false`. New lookup walks `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, `%PROGRAMW6432%`, plus a Windows registry sweep of `Uninstall\…\InstallLocation` for any subkey whose DisplayName starts with "LM Studio". (`winreg = "0.55"` added to `[target.'cfg(windows)'.dependencies]`.)
- **LM Studio models-on-disk soft-detect.** `lmstudio_server_status` now returns `models_detected` + `model_count` from a bounded walk of `~/.lmstudio/models/` for GGUF files. The onboarding "No local backend detected" branch now flips into the "LM Studio detected" CTA whenever either `lms_present && !running` OR `models_detected && !running` is true — so users with GGUFs but no resolved `lms.exe` (a user's exact shape) get "LM Studio is installed (N models detected) but its server isn't currently running" instead of being pushed into a 570 MB re-install.
- **Multi-ComfyUI disambiguation in the onboarding ComfyUI step** (Bug #3 —, Discord 05.05.). New Tauri command `detect_all_comfyui_installs` returns a `Vec<ComfyUIInstall>` with `{ path, complete, has_embedded_python, source }`. The onboarding effect now calls it first; when more than one match exists, the user picks explicitly via a clickable list (each row shows "ready / needs setup" + "found via …" + a "bundles python_embeded" badge). The chosen path is persisted via the existing `set_comfyui_path` command so `start_comfyui` hits it. Single-hit and zero-hit cases keep the previous auto-pick / install-fresh flow.
- **ComfyUI install: Cancel button + disk-pressure pre-flight + ETA** (Bug #1 —, Discord 06.05.). The 45-minute hang case on a 100%-busy drive used to leave the user with no way out. New Tauri command `cancel_comfyui_install` flips a `Arc<AtomicBool>` in `AppState.comfyui_install_cancel`; the install thread polls it between every step and inside the pip retry loop, kills the active git or pip child on cancel, and lands the status in `"cancelled"` so the polling UI clears. Pre-flight uses `sysinfo::Disks` to detect <5 GB free on the target drive and pushes a `⚠`-prefixed warning into the install logs (rendered as a yellow band above the live log card). Progress card now shows a rolling ETA (`download_total - download_progress` / `download_speed`) next to the elapsed timer.
- **PyTorch wheel routing now respects GPU compute capability** (Bug #10 —, GitHub Discussion #37, 11.05.). `install_comfyui` probes `nvidia-smi --query-gpu=compute_cap` and picks `https://download.pytorch.org/whl/cu128` when any visible GPU reports SM ≥ 12.0 (Blackwell — RTX 50xx, RTX 6000 Pro), `cu121` otherwise. The probe is best-effort; failure falls back to cu121 so existing Ampere/Hopper installs don't regress. Fixes `CUDA error: no kernel image is available for execution on the device` at `CLIPTextEncode` on Blackwell silicon.

### Fixed — chat surface
- **TokenCounter now reflects the Settings `maxTokens` override live** (Bug #4 —, Discord 05.05.). The component used to read `getModelMaxTokens(activeModel)` once per model switch and ignore subsequent settings changes, so a slider move from default → 16384 stayed pinned to the model's manifest value (e.g. 8.2k). It now subscribes to `useSettingsStore` so Zustand re-renders on every settings update; the effective ceiling is `settings.maxTokens > 0 ? settings.maxTokens : modelMax`, and the tooltip surfaces both when the user is overriding.
- **DownloadBadge X-button actually cancels the Rust pull stream** (Bug #5 —, Discord 05.05.). `modelStore.dismissPull` used to just delete the entry from `activePulls` — Rust's `pull_model_stream` kept emitting `pull-progress` events and the badge respawned within 100 ms while the disk kept writing. The action now aborts the entry's `AbortController` (which fires the existing `cancel` handler installed by `useModels.pullModel`) AND best-effort invokes `cancel_model_pull` directly. Five new unit tests in `src/stores/__tests__/modelStore-dismiss.test.ts` cover abort propagation, Rust invocation, synchronous state removal, the no-op-when-not-present case, and the late-progress-event guard.
- **Agent-Mode hint when a model tries to call tools without the toggle on** (Bug #7 —, Discord 04.05.). `MessageBubble` now runs `extractToolCallsFromContent` on every assistant message; when a call is detected, the conversation is in normal (non-agent) mode, AND the active model passes `isAgentCompatible`, an amber banner renders below the message: "This model tried to call a tool, but Agent Mode is off for this chat. Turn it on …" with a one-click Enable Agent button. Previously the user saw the raw JSON dump rendered as Markdown and assumed the model was broken.

### Fixed — image / video creation
- **Workflow-architecture mismatch surfaces a clear install path** (Bug #6 — Discord 04.05. Reddit 10.05.). When the active ComfyUI lacks the wrapper nodes for the chosen video model (CogVideoX → `CogVideoXSampler`, FramePack → `FramePackSampler`, Pyramid Flow → `PyramidFlowSampler`, Allegro → community wrapper), `determineStrategy` now returns an `installHint: { pack, url }` alongside the error. The dynamic builder throws a typed `WorkflowUnavailableError` instead of a generic `Error`. `useCreate` recognises that subclass and surfaces the message + install-guide path instead of falling through to the legacy builder (which hits the same `UNETLoader` trap). New helper `checkVideoOutputCapability` lets the Create flow surface a yellow "output will be animated .webp" heads-up when `VHS_VideoCombine` is missing — same root cause as a user's Reddit report ("videos generate as .webp").

### Tests
- `vitest`: 93 files / 2264 tests green (was 92 / 2254 — +5 for Bug #5 cancel propagation in `modelStore-dismiss.test.ts`, +5 for Bug #6 install-hint coverage in `dynamic-workflow-strategy.test.ts`).
- `cargo test --release`: 52 passed (was 44 — +8 for Bug #10 `parse_compute_cap_output` covering Ampere SM 8.6, Ada SM 8.9, Hopper SM 9.0, Blackwell SM 12.0, multi-GPU pick-highest, blank/empty/unparseable edges).
- `cargo check`: clean (1 dead-code warning on unused `save_binary_file_dialog`, pre-existing).
- `tsc --noEmit`: clean.

### Verification
- See `LU-E2E-Test-Kit/docs/03-E2E-TEST-PLAN.md` for the per-bug repro recipes used to validate this sweep on Windows 10 + RTX-class hardware.
- Phase 1 Live-E2E (`test-results-2026-05-11.md`): 5/8 bugs verified live via Computer-Use (#2, #3, #4, #5, #7). Performance regression discovered + fixed during Phase 1 (`detect_all_comfyui_installs` made async via `tokio::task::spawn_blocking` after the initial sync version blocked the UI for 30+ s on a typical home directory).
- Phase 2 Re-Verification (`test-results-2026-05-11-phase2.md`): same 5 live bugs re-confirmed in both configured-state and complete-fresh-state runs (AppData + WebView2 user-data dir renamed aside, fresh launch, full onboarding walk-through). 3 remaining bugs (#1 ComfyUI install cancel, #6 wrapper-installed workflows, #10 Blackwell wheels) are code + unit-test verified — invasive to validate live without Blackwell silicon, a slow disk, or CogVideoX wrapper nodes installed.

## [2.4.3] - 2026-05-04

### Fixed — LM Studio onboarding plug-and-play
- **Pre-bootstrap `lms.exe` path lookup** — on a freshly-installed LM Studio the `lms` CLI lives at `%LOCALAPPDATA%\Programs\LM Studio\resources\app\.webpack\lms.exe` until the GUI has been launched once. `lmstudio_lms_path()` now uses a three-stage lookup: (1) `~/.lmstudio/bin/lms.exe` (post-bootstrap), (2) the pre-bootstrap webpack path above, (3) `PATH`. Before this, the in-app `install_lmstudio` flow on a true-fresh box died with "lms not found" because the bootstrap step couldn't locate the binary it needed to bootstrap.
- **Two-pass GUI bootstrap dance** — `install_lmstudio` now runs `lms bootstrap`, and if `~/.lmstudio/bin/lms.exe` is still missing afterward it launches the LM Studio GUI minimally, polls up to 30 s for `~/.lmstudio/` to populate, then retries the bootstrap. The server-start step re-resolves the path after the dance. End-user-visible effect: no more "open LM Studio once and come back" instructions on a fresh install.
- **Skip download when LM Studio is already installed** — `install_lmstudio` pre-checks via `lmstudio_lms_path().is_some()` and short-circuits the 570 MB download + installer step, jumping straight to bootstrap + server start. Plus a further short-circuit to "complete" if `already_installed && server_running`. Stops a re-download from happening every time someone toggles the server on.
- **Onboarding "LM Studio offline → start server" card** — `runDetection` now calls `lmstudio_server_status` after `detectLocalBackends` returns. When `lms_present && !running` the Backends step flips into a `lmstudioOfflineDetected` state: headline becomes "LM Studio detected", the primary button reads "Start LM Studio server" and styles as primary, and the Ollama-install button hides. Same `install_lmstudio` Tauri command (with the skip-download short-circuit above) handles the click.
- **Settings → AI Backends inline "Start Server" button** — `ProviderConfig.tsx` calls `lmstudio_server_status` on mount and after each Test click. When the provider is the `lmstudio` preset, `lms_present && !running` and the connection isn't already 'connected', a green inline `▶ Start Server` button renders between Disable and the status pill. Click runs `start_lmstudio_server`, polls up to 30 s on `running`, then re-tests the connection (status dot flips red → green in ~8 s).
- **Actionable runtime hint for "No LM Runtime found"** — `openai-provider.ts::parseError` now matches LM Studio's raw API error via `/no\s+lm\s+runtime\s+found/i` and replaces the assistant message with a 3-step "Open LM Studio → Discover → Runtimes → llama.cpp (CPU)" instruction. Sets `code='lmstudio_runtime_missing'` for future UI branches. Three vitest unit tests in `provider-openai.test.ts` cover detection, case-insensitivity, and no false-positive on other 400-class errors.

### Fixed — onboarding & picker
- **Models step recommended-starter card now unblocked on a truly-fresh install** — the `modelSubTab` initial value is computed from `ONBOARDING_MODELS.some(m => m.uncensored)`. With the v2.4.0 P4 trim that left only Qwen 2.5 0.5B (mainstream), the tab now starts on `'mainstream'` instead of `'uncensored'`, so the Qwen card actually renders. Previously the Models step looked empty on a fresh install — diagnosed in sweep #3 as an `existingModelCount` issue, which was the wrong root cause; sweep #4 found the real one.
- **Embedding-only models filtered from `existingModelCount`** — `listModels` results now run through an `embed`/`bge-`/`nomic` filter (same pattern as `scanInstalledModels`). LM Studio's default `text-embedding-nomic-embed-text-v1.5` no longer counts toward "user already has a model installed" and no longer pollutes the chat-model picker.

### Fixed — theme & UI polish
- **Dark theme from frame 1** — `<html class="dark">` set in `index.html` plus inline `#0a0a0a` body background, `useLayoutEffect` in `AppShell` to apply theme synchronously before paint, and the onboarding theme step removed entirely (5 step indicators instead of 6). Light theme remains available in Settings → General → Appearance. Resolves a "is from build to build different, should be black always" report — first-paint flash is gone, theme is consistent across builds.
- **XP-style scrollbar arrows removed from chat input** — `.scrollbar-thin::-webkit-scrollbar-button` (all `:start/:end/:vertical/:horizontal` permutations) set to `display:none, width:0, height:0`. The chat input `<textarea>` carries `.scrollbar-thin`. Result: clean 6 px thumb, no decorative arrow chrome.

### Fixed — HF model search (carry-over from quiet sweep)
- **HF search no longer crashes the dropdown on repo-path queries** — `baseName` ReferenceError that fired when the query contained a `/` (e.g. `bartowski/Llama-3.1`) caused the dropdown to render zero hits with a console error. Path-aware parser now extracts the file name correctly.
- **HF search is case-insensitive** — query and candidate names both `toLowerCase()`-normalized before matching, so `qwen` and `Qwen` return the same set.
- **Picker resets when the selected model is no longer in the list** — instead of locking on a dead choice, the picker drops the selection back to the placeholder when its current model isn't present in the freshly-fetched list.

### Fixed — Remote Access dev-mode (carries forward from `[Unreleased]` block)
- **Remote Access in `npm run dev` now surfaces a clear actionable message instead of a cryptic 404 + JSON.parse stacktrace** — reported on Discord in `#bug-reports` by a user on v2.4.2: clicking the LAN button printed `POST http://localhost:5173/local-api/start-remote-server [HTTP/1.1 404 Not Found]` and clicking Internet showed an `Error: HTTP 404` toast plus `Uncaught (in promise) SyntaxError: JSON.parse: unexpected character at line 1 column 1 of the JSON data`. Root cause: Remote Access is a Tauri-only feature (a Rust axum server, JWT auth, Cloudflare tunnel binary management, mobile-UI static serve — ~3700 lines in `src-tauri/src/commands/remote.rs`). When v2.4.2 added the corresponding `/local-api/*` paths to `src/api/backend.ts`'s endpoint map, no matching middleware was added to `vite.config.ts`, so dev-mode clicks fell through to vite's default 404 HTML page, which the frontend then tried to JSON.parse. End-user impact: zero — the installed `.exe` routes through Tauri's `invoke()` and works as designed. Developer impact: a confusing dead-end when iterating on the UI from `npm run dev`. Mirroring the entire feature in Node middleware would be a maintenance trap, so we keep dev lean and instead: (1) `Sidebar.handleDispatch` and the `remoteStore.startServer` / `restart` / `startTunnel` actions all check `isTauri()` first and short-circuit with `REMOTE_DEV_MODE_ERROR` — a single source-of-truth string that points at `npm run tauri:dev` (Tauri-aware dev mode where Remote works fully) or the installed app; (2) all 12 Remote-related vite middlewares are stubbed to return `HTTP 501 + { error, devModeOnly: true }` as a backstop in case any future caller bypasses the store guards.

### Tests
- `vitest`: 2254 / 2254 green (+3 new tests for the LM-Studio runtime-missing rewrite, +5 from the carried-forward Remote dev-mode short-circuit set, +2 adjusted constants-validation cases).
- `cargo test`: 44 / 44 green (Rust unit tests).
- `tsc --noEmit`: clean.
- `cargo check`: clean (one pre-existing dead-code warning on `save_binary_file_dialog`, unrelated to this sweep).

### Verification
- **Fresh-fresh-box live trace.** LM Studio uninstall (`Remove-Item $LOCALAPPDATA\Programs\"LM Studio"`) + `~/.lmstudio` purge + LU AppData reset → onboarding shows "No local backend detected" → click "Or install LM Studio" → silent install → "Bootstrapping `lms` CLI" log proves `lmstudio_lms_path()` found the pre-bootstrap path (because `~/.lmstudio/bin/` did not exist yet) → Pass-2 GUI flash proves `lmstudio_gui_exe()` populated `~/.lmstudio/` → "Starting LM Studio server..." → "LM Studio is ready (server on :1234)". Total ~1:35 including the download. Sweep-#3 code died at the `lms.exe not found` step.
- **Skip-download path.** With LM Studio already installed: `install_lmstudio` log shows "LM Studio is already installed — skipping download. Bootstrapping CLI and starting server…", server up at `:1234` in 8 s, zero MB downloaded.
- **Onboarding offline-detection card.** AppData reset → Backends step shows the new "LM Studio detected" headline + "is installed but its server isn't currently running…" paragraph + primary button "Start LM Studio server". Ollama-install button hidden.
- **Models step starter card.** Qwen 2.5 0.5B card visible with "Recommended" badge, "0.4 GB · VRAM: 1 GB". Pre-fix the step rendered with only "Skip for now".
- **GGUF download path.** File lands at `~/.lmstudio/models/bartowski/Qwen2.5-0.5B-Instruct-GGUF/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` (379.4 MB).
- **Picker filters embeddings.** With LM Studio's default embedding model present, only `qwen2.5-0.5b-instruct (LM Studio)` shows in the chat picker.
- **End-to-end inference.** Chat prompt "Hello! Reply with exactly: pong" via LM Studio :1234 + Qwen 2.5 0.5B → "Pong!" (20/8.2k tokens). Full pipe: LU → Rust proxy → LM Studio → Qwen → back.
- **Settings inline Start-Server button.** With server stopped: Settings → AI Backends → LM Studio expand → green ▶ Start Server button renders → click → "Connected" in 8 s.
- **Theme dark from frame 1.** Post-AppData-reset launch: dark from frame 1, 5 step indicators (was 6), Welcome → Backends direct, no white flash.
- **Scrollbar visual.** 20-line test input → 6 px thumb, no arrow buttons. Zoom-verified.

### Notes
- Drop-in upgrade from v2.4.2. No breaking changes, no localStorage migration. Auto-update prompts on next launch.
- **Heads-up — extra-active first week.** Build environment for this release was different from usual. CI ships the same x64 + Linux installers as always, but to catch anything that slipped through the live-test pass: `#bug-reports` / `#help-*` / GitHub will be checked daily for the next ~5 days. If something behaves off after updating, please drop a note — fix turnaround should be fast (a v2.4.4 hotfix lands the same way auto-update did v2.4.3).
- **Carrying forward into next sweep:** AMD video-generation "could not detect model type" + empty-output reports on Threadripper / RX 7900 XTX (a user on Discord). Internet-Remote feature-request to support `npm run dev`. Beads memory-plugin design (Discussion #34).

## [2.4.2] - 2026-04-26

### Fixed
- **Updates tab no longer shows a stale "Latest Version" after a manual binary upgrade** — reported on Discord by a user: "I tried and failed to auto-update from the .deb package in i think 2.3.7, and now the updates tab says `Current Version: 2.4.1 | Latest Version: 2.3.8`." Root cause: zustand's `persist` middleware partializes `latestVersion` into localStorage, so when a user updates the binary out-of-band the persisted "latest" snapshot survives even though it's now older than what they're running. `checkForUpdate()` has a 6h cooldown, so the stale value lingers for hours. Fix: added `onRehydrateStorage` to `updateStore` that compares persisted `latestVersion` against `currentVersion` via the existing `isNewerVersion` helper and resets `latestVersion = null, updateAvailable = false, releaseNotes = null, lastChecked = null` when the persisted snapshot isn't strictly newer. Plus a UI hardening pass in `SettingsPage`'s `UpdateSection`: the "Latest Version" row now only renders when the persisted value really is newer than current, so even a missed rehydration can't display the inversion.
- **Agent toggle now correctly enables for uncensored / abliterated variants of agent-capable bases** — reported by a user on Discord with `LEONW24/Qwen3.5-9B-Uncensored:Q4_K_M`. The previous `isAgentCompatible` carried a deliberately narrow allow-list for abliterated/uncensored model names (`['qwen3-coder', 'hermes3', 'hermes-3', 'hermes']`) that over-rejected popular Qwen 3.x, Llama 3.x, Gemma 4, Mistral, and Qwen 2.5 abliterations even though those families retain native tool-calling weights through abliteration. Fix: the abliterated/uncensored branch now strips the `-abliterated` / `-uncensored` / `-instruct` / `-chat` / `:tag` suffixes and checks the remaining base name against the same canonical `AGENT_COMPATIBLE` list as the vanilla path. Three regression tests added in `model-compatibility.test.ts` covering the case + `mannix/llama3.1-8b-abliterated` + `huihui_ai/qwen2.5-abliterated`.
- **CivitAI model search now uses the API key from the Workflow finder + shows a clear empty-state hint** — reported by a user: "CivitAI model search doesn't seem to work — i think it's because the api-key was only accepted for the Workflow finder under the Create Tab, but i'm not finding any errors in the console or network tab, just says it's getting back an empty model list." Fix: `searchCivitaiModels(query, type, apiKey?)` in `discover.ts` now appends `&token=<apiKey>` when set and adds `nsfw=true` to surface adult content (matching LU's positioning). The DiscoverModels CivitAI panel reads the same key the Workflow finder writes via `workflowStore.civitaiApiKey`. New `civitaiSearched` state distinguishes "before-first-search" from "search-returned-zero" and renders an empty-state hint — `No matches for "<query>". Try a broader query, or add your CivitAI API key in the Workflow finder for the full catalog.` — instead of leaving the user staring at a silent empty list.
- **Import Workflow now shows a visible success confirmation** — reported by a user: "doesn't seem to persist manually entered json, and doesn't document where the file would be stored. There's no feedback or console output when clicking the 'Import' button." The import was actually persisting fine, but the UI cleared the inputs on success and emitted zero feedback, so the click looked like a no-op. Fix: added `importSuccess` state to `WorkflowSearchModal` and an emerald-green confirmation row that reads `Imported "<name>" and assigned to <modelName>.` after a successful URL or JSON paste; auto-clears after 4s.
- **Newly downloaded ComfyUI models surface in the dropdown more reliably** — reported on GitHub Discussion #22 by two users. Two timing-related races were stacking: (1) `refreshComfyModels` was single-shot and silently returned `false` if ComfyUI was mid-startup or busy, leaving the cache stale; (2) the `comfyui-model-downloaded` event handler in `useCreate` called `fetchModels()` exactly once, so if ComfyUI's directory scan took longer than the `/api/refresh` round-trip the immediate fetch saw the pre-scan list. Fix: `refreshComfyModels(maxAttempts = 3)` retries with 1s + 2s backoff on transient failure, and the post-download handler now schedules `fetchModels()` immediately + at +2s + at +6s with proper timer cleanup on unmount. Live-traced in DevTools: a single dispatched event now produces 8 `/api/refresh` calls inside 8s, where pre-fix it produced 1. Doesn't address adjacent root causes like file-permission issues (running ComfyUI as admin to access models) or a misconfigured `Settings → ComfyUI → Path` — those are separate problems.

### Carrying forward from master (commit 9eb1329)
- **Remote Access "Server stopped — restart does nothing" silent-failure path is fixed** — reported on issue #29 by a user. Internet remote rethrows on failure instead of swallowing the error, orphan tunnels are cleaned up, and the inline error surfaces in the UI.
- **Anti-Virus false-positive groundwork** — reported on issue #33 by a user. Bundle metadata + signed installer carry forward; v2.4.1 already addressed most ESET / Avast hits.

### Docs
- **Blog correction: SillyTavern image generation** — reported by a user. The "Best local AI apps 2026" comparison and the "Locally Uncensored vs SillyTavern" deep-dive both incorrectly listed SillyTavern as having no image generation support. SillyTavern does support image generation through its Stable Diffusion / ComfyUI extension; the table cell + descriptive text now reflect that, while keeping the built-in vs extension distinction honest.

### Tests
- Test suite 2244 → 2246 (+2 regression assertions in `updateStore.test.ts` pinning the a user 2.3.8/2.4.1 inversion case).
- 3 inverted assertions in `model-compatibility.test.ts` flipped to match the new unified abliterated handling — the previous "abliterated NOT compatible" expectations were encoding the bug, not desired behavior.

### Verification
- `vitest`: 2246 / 2246 green
- `cargo test`: 44 / 44 green
- Built v2.4.2 installer + silent-installed over the prior v2.4.1 binary on a real Windows machine, then reproduced each bug's mechanism in the running app:
  - B1: seeded `latestVersion: '2.3.8'` into localStorage + reloaded — Settings → Updates correctly shows `Current Version: v2.4.2` + "You are on the latest version", no stale row.
  - B2: 7-case assertion table run in DevTools console — a user's exact model + 3 other abliterated bases all return true, plus 3 negative cases (embedding model + unknown-base abliteration) correctly stay false.
  - B3: searching "flux" in CivitAI panel renders the empty-state hint as designed.
  - B4: pasted ComfyUI JSON twice with different names → both workflows persisted + assigned, visible in the WORKFLOW dropdown.
  - B5: instrumented `window.fetch`, dispatched the download-completed event once, traced 8 `/api/refresh` calls within 8s spanning the immediate / +2s / +6s × 3-attempt-retry pattern.

### Notes
- Drop-in upgrade from v2.4.1. No breaking changes, no localStorage migration. Auto-update prompts on next launch. Existing users roll over automatically.
- We don't claim 100% reliability for any of these — if the symptoms still show up after updating, please drop a note in the matching issue / discussion / Discord thread. We'd rather hear about it.

## [2.4.1] - 2026-04-24

### Fixed
- **CreateTopControls: picker dropdown hardened against any non-array list value** — reported on Discord by a user on the `#bug-reports` channel: "the web ui crashes when clicking on the model list at the top in the create tab". His workaround was to patch `activeList?.map(...)` in the source, which stopped the crash but "the list doesn't work anymore" because the `.length` branch above still evaluates on undefined. We already did the straightforward fix in v2.3.9 / v2.4.0 (added `imageModelList` / `videoModelList` to `createStore` as runtime-only state, populated by `useCreate.fetchModels`), but there's still a pathological path where the field arrives as something other than an array: stale persisted state from a very old install, Zustand rehydration racing the first render of `CreateTopControls`, a corrupted localStorage entry from an external tool, or simply an old .exe that predates aa31bab. The read site now passes the list through `Array.isArray(rawList) ? rawList : []`, so undefined / null / object / string / number / anything weird all render as the empty-state card instead of taking the app down.

### Tests
- Test suite 2216 → 2226 (+7 regression tests in `createStore.test.ts` — new "activeList fallback contract (mirrors CreateTopControls)" describe block covers undefined / null / object-with-wrong-shape / string / real-populated-array cases, plus a `.length && .map never throw on the fallback` guard).

### Verification
- `vitest`: 2226 / 2226 green
- `tsc --noEmit`: clean
- Bundled JS contains the fix (grep-confirmed `Array.isArray(h)?h:[]` in the minified `index-*.js`)
- Dev-preview E2E: injected undefined / null / `{}` / `"corrupted"` / `42` / populated-array into the store and clicked the picker — zero errors across all six scenarios
- Installed-binary E2E, happy-path: Ollama + ComfyUI running with 3 image + 3 video models — picker shows all 6 models, no crash in either mode
- Installed-binary E2E, true fresh-user simulation: Ollama folder renamed, ComfyUI folder renamed, LU AppData wiped — picker shows "Start ComfyUI to load models" empty-state, no crash in either mode; Chat / Create / Compare / Benchmark / Models / Settings all load cleanly from fresh install

### Notes
- Drop-in upgrade from v2.4.0. No breaking changes, no localStorage migration. Existing users auto-update on next launch.
- Single-file behavior fix + tests — no new features, no dependency bumps. If you were already on v2.4.0 with working model lists, you won't see a behavior change.

## [2.4.0] - 2026-04-23

### Fixed
- **Double-launch no longer spawns a second LU process** — clicking the shortcut twice (or "Run" in the NSIS installer after install) used to produce two `locally-uncensored.exe` PIDs. Both triads wrote to `%APPDATA%/Locally Uncensored/store_backup.json` racing each other, occasionally overwriting a just-flushed backup mid-write. Fixed with `tauri-plugin-single-instance`: the 2nd launch now focuses + un-minimizes the existing window instead of creating a new process. Found during the internal 2.3.9 Ultra E2E pass.
- **Settings → Agent Permissions → "Reset tutorial" button actually resets the tutorial now** — the onClick called `setTutorialCompleted()` which unconditionally sets `tutorialCompleted: true`. Clicking it on a fresh install silently *skipped* the tour, and clicking it after seeing the tour did nothing at all. Added a new `resetTutorial()` action in `agentModeStore` that sets `tutorialCompleted: false`, wired the button to it, added a regression test in `stores.test.ts`.
- **Discover tab no longer shows the HuggingFace download path twice** — both the section subtitle and a second `<p>` below the download grid rendered "Saves to: …" / "Downloads save to: …". Removed the duplicate.
- **Linux window can be dragged again** — on Ubuntu 24.04 the title-bar drag threw `Unhandled Promise Rejection: window.start_dragging not allowed. Permissions associated with this command: core:window:allow-start-dragging` and left the window anchored in place (keyboard tiling still worked, so nobody noticed on tile-first setups). Reported on Discord by a user. Added `core:window:allow-start-dragging` to `src-tauri/capabilities/default.json`.
- **"Re-run onboarding" actually reruns onboarding now** — first cut of the button deleted the marker file + flipped `settings.onboardingDone` + reloaded, but `AppShell.tsx`'s mount-time "migration" block saw the missing marker and happily wrote it back, dropping the user straight into the main app instead of the wizard. The migration is now gated on `settings.onboardingDone === true` so it only fires for legitimate NSIS-update-after-onboarding scenarios, not for the intentionally-missing marker of a Re-run click. Caught during E2E of the 2.4.0 RC. Regression test in `AppShell-backup-triad.test.ts`.
- **HuggingFace search filename heuristic no longer doubles quant suffixes** — typing "tinyllama Q4" into Model Manager → Discover → Text → (search) returned repos like `hieupt/TinyLlama-1.1B-Chat-v1.0-Q4_K_M-GGUF`, and the client then guessed the inner filename as `TinyLlama-1.1B-Chat-v1.0-Q4_K_M-Q4_K_M.gguf` — doubled tag, guaranteed 404 when you clicked download. Extracted the guess into `deriveQ4FilenameFromRepo()`, added a case-insensitive quant-suffix detector (`Q[0-9]+_K_[MSL]`, `Q[0-9]_[0-9]+`, `IQ[0-9]_[A-Z]+`, `UD-Q/-IQ`, `BF16/FP16/F16/F32`). If the suffix is already in the repo name, the `.gguf` is appended directly; otherwise `-Q4_K_M.gguf` stays as before. Full E2E with a curated model (Gemma 4 E4B @ 4.6 GB) confirmed the Model Storage override path is honored — bytes land in the picked folder, LM Studio's default folder is not touched. 9 new regression tests in `discover-hf-filename.test.ts`.

### Added
- **Settings → Privacy section** — explicit in-app statement of what the app does and doesn't do with your data. Until 2.3.9 this only existed in the README, which meant if you couldn't be bothered to open GitHub you were taking the claim on faith. Now Settings lists: 100% local by default, no telemetry/analytics, only network calls are the GitHub updater and cloud-provider APIs you configure yourself; + where your data lives on disk (`%APPDATA%/Locally Uncensored`).
- **Settings → Onboarding → "Re-run onboarding" button** — once you'd clicked through the first-launch wizard it was gone forever unless you hit "Reset to Defaults" (which wipes every other preference). Now Settings has a dedicated "Onboarding" section with a button that clears the `onboarding_done` marker on disk + resets the in-app flag + reloads. Useful when you want to redo the hardware scan, show the app to a friend, or just re-read the agent-mode tour. The `set_onboarding_done` Rust command now accepts `Option<bool>` so callers can also clear the marker, not only set it.
- **Settings → Model Storage: configurable HuggingFace GGUF download path** — requested in Discord by a user (dual-boot Ubuntu user wanting the HF downloads on a shared partition instead of `/home/$USER/locally-uncensored/models`). New `hfDownloadPathOverride` in settings — leave empty to keep the previous auto-detect-from-provider behaviour, or pick a folder via the native picker. `DiscoverModels.tsx` now prefers the override over the auto-detected LM-Studio path. Takes effect immediately without restart.
- **CONTRIBUTING.md — ComfyUI CORS note for contributors bringing their own instance** — LU's auto-started ComfyUI already passes `--enable-cors-header "*"`, but contributors who point `npm run tauri:dev` at their own long-running ComfyUI see a `403` + `request with non matching host and origin localhost:8188 != localhost:5173` warning. Flagged on Discord by a user after they self-diagnosed + self-fixed. Docs now spell out the workaround.

### Changed
- Test suite 2205 → 2216 (+11 regression tests: `resetTutorial` flips `tutorialCompleted` back to `false`, AppShell onboarding-marker migration is gated on `onboardingDone`, 9 cases for `deriveQ4FilenameFromRepo` covering Q-tag / IQ-tag / UD- / BF16 / lowercase / mid-string / no-GGUF variants).
- Bumped `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 2.3.9 → 2.4.0 in lockstep.

### Notes
- Drop-in upgrade from v2.3.9. No breaking changes. No localStorage migration. `hfDownloadPathOverride` defaults to empty, which preserves pre-2.4.0 behaviour (auto-detect from the active openai-compat provider).
- Version train: 2.4.0 is a polish release consolidating the 6 non-blocker findings from the internal Ultra E2E sweep + the 2 bug + 1 feature request from Discord community feedback over the 2.3.x cycle. No new headline features — the next headline bump is planned for 2.5.0 (see project roadmap).

## [2.3.9] - 2026-04-23

### Fixed
- **Create view no longer takes down the whole app when no image or video model is installed** — reported on Discord by a user on a fresh Windows install. Observable symptom: open Create with an empty ComfyUI `models/` tree, app unresponsive → hard shutdown → a "duplicate" LU process opens. Two layered root causes, both fixed:
  - (1) `classifyModel()` in `src/api/comfyui.ts` used to happily dereference `name.toLowerCase()` without checking `name` first; a stale persisted model string (from a previous install that got deleted) was carried into every Create render path and bubbled through `useCreate.generate`, `ParamPanel`, and the dynamic-workflow builder. Now `classifyModel(name: string | null | undefined)` returns `'unknown'` when `!name`.
  - (2) `src/hooks/useCreate.ts:fetchModels` only cleared the persisted image/video model names when ComfyUI returned a non-empty list. With 0 models, the stale strings stayed alive forever. Now fetchModels explicitly `state.setImageModel('', 'unknown')` + `state.setVideoModel('')` when the corresponding list is empty after the startup-race retries expire.
  - (3) `src/components/create/CreateView.tsx` renders a dedicated empty-state card when `connected === true && modelsLoaded && currentModeModels.length === 0`. The card shows `PackageOpen` icon + "No {image|video} models installed" + a **Go to Model Manager** primary button (calls `useUIStore.getState().setView('models')`) + a **Refresh list** secondary action (calls `fetchModels()`). `OutputDisplay` / `PromptInput` / `ParamPanel` / I2V + I2I uploads / preflight banners all suppress during the empty state so no downstream code can hit the old crash path. The Mode switcher (Image / Video) stays so the user can switch sides and get a matching empty-state.

- **CreateTopControls no longer crashes the Create header toggle + dropdown** — the header-level model picker + ComfyUI Lichtschalter lives at `src/components/create/CreateTopControls.tsx` and used to destructure four fields (`imageModelList`, `videoModelList`, `comfyRunning`, `setComfyRunning`) from `useCreateStore()` that were never added to the store. Clicking the dropdown threw `TypeError: can't access property "length", activeList is undefined`; clicking the Lichtschalter during starting/stopping threw `setComfyRunning is not a function`. Reported on Discord by a user (with a precise console-log dump, bless them — Ubuntu 24.04 + `npm run dev`). Fix: the four missing fields are now part of `createStore` as runtime-only (not persisted) state; `useCreate.fetchModels` + `useCreate.checkConnection` mirror their values into the store so the header control always has a live list + the right toggle state.
- **Backend Selector modal no longer spams on repeat** — users with multiple local backends (Ollama + LM Studio, Ollama + vLLM, etc) reported on Discord that the "N local backends detected" modal kept re-appearing every 5-10 seconds, regardless of whether they clicked Skip or Use selected. The pre-existing `sessionStorage` guard wasn't enough in the face of WebView2 reloads (which the backup-restore triad can trigger) or cache evictions. Fix: (1) added a persistent `hideBackendSelector` flag in `providerStore` so the user's opt-out survives reloads; (2) the modal now has a pre-checked "Don't show this again" tickbox; (3) a permanent explanatory line "You can add, remove, or switch backends anytime in **Settings → Providers**" (with the link clickable — it navigates you there); (4) dismissing the modal with the tickbox checked persists the opt-out. Users who want the modal back at some point can uncheck the box before dismissing.
- **LU always starts in the Chat sidebar tab, not Code** — on a fresh install or an NSIS update, the left-sidebar tab (Chat / Code / Remote) could land on Code because `codexStore`'s persist middleware saved `chatMode` between sessions. Newcomers clicking around Code without any conversations got an empty screen. `codexStore` now excludes `chatMode` from `partialize` so the default (`'lu'`) is used on every fresh boot. If a user wants to stay in Codex or Claude Code mid-session, they pick it from the sidebar each time; `workingDirectory` still persists so Codex remembers the last project path.
- Tiny grammar fix in the Create empty-state copy: "Install **an image** model" / "Install **a video** model" (was "Install a image model" in both branches).

### Added
- **CONTRIBUTING.md — Dev Setup now documents all three local dev workflows** (`npm run tauri:dev` for hot-reload with Rust rebuilds, `npm run dev` for browser-only UI work, `npm run tauri:build` for a full NSIS installer). Reported in Discord by a user as a missing-docs ask. Clarifies that Tauri invokes only resolve under `tauri:dev`.

### Changed
- Bumped `package.json` 2.3.7 → 2.3.9 (was lagging behind `src-tauri/tauri.conf.json`). Bumped `src-tauri/Cargo.toml` 2.3.7 → 2.3.9 (also lagging). Website + download URLs + schema.org metadata updated to 2.3.9.
- Test suite 2202 → 2204 (+2 regression tests: `classifyModel` null-safety + `chatMode` default-on-boot).

### Notes
- Drop-in upgrade from v2.3.8. No breaking changes. No localStorage migration.
- v2.3.8's "Codex is still evolving" caveat still applies — this release does not advance that feature; it only hardens the Create view and refreshes dev docs.

## [2.3.8] - 2026-04-22

> **Note on Codex:** several Codex plumbing bugs are fixed below, but Codex is still an actively-evolving feature and is not yet treated as production-finished. This section is a developer-facing technical changelog. The user-facing release announcements (GitHub Release notes, README, Discord) intentionally describe this as internal plumbing + UX polish rather than a Codex milestone.

### Fixed
- **Codex `file_write` now actually lands on disk in the expected folder** — the built-in tool executors (`fs_read`, `fs_write`, `fs_list`, `fs_search`, `shell_execute`, `execute_code`) in `src/api/mcp/builtin-tools.ts` never threaded the active chat-id through to Rust even though `agent-context.ts` was designed for exactly that. The documented per-chat workspace isolation (`~/agent-workspace/<chatId>/`) silently fell through to a shared `default/` fallback whenever the model emitted a relative path, and no per-chat isolation ever happened. Now every executor reads `getActiveChatId()` and spreads it into the `backendCall` payload so Rust's `resolve_path()` / `resolve_agent_path()` can route relative paths into the right per-chat folder. `src/api/agents.ts:executeTool` also now returns the real `data.path` from Rust's `{status:"saved", path:…}` response instead of a hard-coded `"File written successfully"` string that masked write failures behind a green ✓ in the UI.
- **Codex chat bubble no longer floods with raw `{"name":"file_write", "arguments":{…}}` JSON objects for models that emit tool calls as content** — qwen2.5-coder:3b and similar small coder models put the tool call in the `content` field instead of the native `tool_calls` array. The pre-2.3.8 extractor caught the call but left the raw JSON visible in the chat, and the narrative around it ("I'm about to verify…" + ```python fence echoing the file content) was concatenated onto `fullContent` every iteration — a 4-iteration task rendered as four stacked JSON blobs with four duplicated paragraphs. Fix: new `stripRanges()` helper uses the `[startIdx, endIdx]` positions the balanced-brace extractor already computes to remove the exact tool-call substrings (not a greedy regex that fails on nested braces), and an `extractedFromContent` flag drops the residual narrative entirely so qwen's Codex UI now looks identical to gemma4's.
- **Balanced-brace JSON extractor replaces the greedy `\{[^}]*\}` regex** — the old regex failed on any JSON with nested braces OR string values containing `{` (e.g. Python f-strings `f'Hello, {name}!'` emitted by qwen2.5-coder). Replaced with a locate-header-then-balance scanner that respects string escapes. Fixes `extractToolCallsFromContent` for any code that uses f-strings or dict literals in string values.
- **Arg-validator error-hint now lists the exact missing fields with types and what the model actually sent** — pre-2.3.8 the generic "Re-issue the tool call with valid arguments matching the tool schema" hint meant small models (hermes3:8b, qwen2.5-coder:3b) kept retrying the same malformed call. Now the hint looks like `file_write requires {path: string, content: string}. You sent {command}. Retry with all required fields present.` — concrete enough that small models actually self-correct.

### Added
- **Context compaction in Codex** — long multi-tool turns used to blow past 8K-context local models' windows; Codex now mirrors Agent Mode's `compactMessages(…, Math.floor(maxCtx * 0.8))` call before each sampling pass, summarising older turns while keeping recent messages intact.
- **Memory injection + extraction in Codex** — Codex was the only chat surface that ignored the memory system. It now reads `useMemoryStore.getState().getMemoriesForPrompt(instruction, contextTokens)` into the system prompt at dispatch time, and runs `extractMemoriesFromPair()` after the turn lands. Parity with Chat + Agent Mode.
- **`CODEX_CATEGORIES` tool-scope filter** — Codex now filters `toolRegistry.getAll()` to the `filesystem | terminal | system | web` categories before passing tools to the model. The pre-2.3.8 code had the constant defined but never used, so small models were getting confused by `image_generate`, `screenshot`, `run_workflow`, and `process_list` showing up next to `file_write` and emitting tool calls with the wrong argument shape (confirmed repro: hermes3:8b calling `file_write({command: "python -m unittest …"})` when both shell_execute and file_write were in scope). The filter narrows the blade.
- **Codex iter cap raised 20 → 50** — large refactors across 10+ files legitimately need more than 20 tool calls. Budget still caps via `agentMaxToolCalls` / `agentMaxIterations` (defaults 50 / 25 from settings).
- **Family grouping in ModelSelector dropdown** — models are now grouped by family header (QWEN / GEMMA / LLAMA / HERMES / PHI / DOLPHIN / MISTRAL / DEEPSEEK / …) in the Codex/Chat/Code dropdown, with a subscribe effect that re-fetches the list when any provider's `enabled`/`baseUrl` changes so users don't have to open Model Manager to see newly-enabled providers.

### E2E verified
5 tool-capable Ollama models, each in a fresh Codex chat, writing to `C:\Users\<user>\Desktop\<test-folder>\`:
- **gemma4:e4b** — both simple (`file_write hello.py`) and a real Codex-style task ("build cli.py with argparse add/list/clear + test_cli.py with 4 unittest tests + run `python -m unittest test_cli.py` and report") succeeded end-to-end. Full trace: `file_write cli.py (2556B)` → `file_write test_cli.py (3759B)` → `shell_execute python -m unittest test_cli.py` → real output `....\nRan 4 tests in 1.612s\nOK` → final summary. 3 clean tool blocks in the UI, single final answer, Memory badge fired on extraction.
- **qwen2.5-coder:3b** — after the `stripRanges` + `extractedFromContent` fix, chat UI is visually identical to gemma4's (tool blocks + single summary, zero raw JSON).
- **hermes3:8b** — clean native tool-call flow.
- **llama3.1:8b** — clean native tool-call flow (freshly pulled for this verification).
- **llama3.2:1b** — plumbing correct; the 1B model hallucinated a Unix-style `/Users/alice/Desktop/tiny.py` path that landed at `C:/Users/alice/Desktop/tiny.py` on Windows instead of in the workdir. Model-quality artefact, not a Codex bug. Documented for users on the smallest class of models.

### Changed
- Test suite 2202 → 2202 (full regression) after `tool-call-repair` gained `extractToolCallsWithRanges` + `stripRanges` + `findBalancedBraceEnd` + `findPrecedingOpenBrace`.

### Notes
- Drop-in upgrade from v2.3.7. No breaking changes. No localStorage migration. Existing Codex chats continue to work; new chats benefit from the per-chat workspace isolation now that `chatId` threads through.

## [2.3.7] - 2026-04-22

### Added
- **Configurable Ollama endpoint (remote Ollama + `OLLAMA_HOST` env var support)** — GitHub Issue #31 by a user. The pre-2.3.7 app hardcoded `http://localhost:11434` in four places (the frontend `ollamaUrl()` helper used by every `/tags`/`/chat`/`/show`/`/pull`/`/generate` call, the Vite dev-proxy target, the Ollama provider's dev-mode `apiUrl()`, and the Rust `pull_model_stream` URL), so setting `OLLAMA_HOST=0.0.0.0:11434`, `192.168.1.x:11434` or any non-default port was silently ignored — the app reported "No local backend detected", model dropdowns stayed empty, Settings → Providers → Ollama → Endpoint field had zero effect, and the Test button always said Failed even when `curl` against the configured endpoint returned data. Now all four layers flow from a single `ollama_base` field that reads, in priority order, the persisted GUI value from `%APPDATA%/locally-uncensored/config.json`, the `OLLAMA_HOST` env var at startup (same semantics as Ollama itself), then the default. Accepts bare `host:port`, scheme-less host, or full URL. The Vite dev-proxy target is computed from `OLLAMA_HOST` at server startup so `OLLAMA_HOST=… npm run dev` also just works. The Rust SSRF allow-list in `proxy_localhost` was widened to accept the configured Ollama + ComfyUI hosts (everything else still blocked). 19 regression tests in `backend-urls.test.ts`.

### Fixed
- **`pull_model_stream` Rust command was hardcoded to `http://localhost:11434/api/pull`** — same root cause as Issue #31 but in a second place. Model-pull downloads ignored any user-configured Ollama endpoint. Now reads from `state.ollama_base`.

### Changed
- Test suite 2183 → 2202 green.

### Notes
- Drop-in upgrade from v2.3.6. The default endpoint is still `http://localhost:11434` — existing users see zero behavior change. If you have `OLLAMA_HOST` in your environment (Docker, LAN, homelab) it's now honored; if you've edited Settings → Providers → Ollama → Endpoint that value now actually flows through the app.

## [2.3.6] - 2026-04-21

### Added
- **Configurable ComfyUI host (remote ComfyUI support)** — Settings → ComfyUI → Host. Previously only the port was configurable; the host was hardcoded `localhost`, which meant users running ComfyUI in Docker, on a LAN machine, or on a headless homelab server couldn't point LU at it. The Host field accepts any hostname or IP. When the host resolves to the local machine (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) the Start/Stop/Restart/Install/Path controls stay visible; when it's remote LU hides those controls and shows an amber hint that you manage the Python process on the server yourself. Requested in GitHub Discussion #1 by a user (desktop LU + Ollama on server-1 + ComfyUI on server-1 docker). The mobile Remote proxy also honors the new host so mobile-dispatched ComfyUI calls reach the configured backend. 17 regression tests in `backend-urls.test.ts`.

### Fixed
- **ComfyUI port now actually persists across restarts** — pre-existing bug: `set_comfyui_port` wrote `comfyui_port` to `%APPDATA%/locally-uncensored/config.json`, but `AppState::new()` never read it back on startup. Users who set a custom port (e.g. because 8188 was taken) got their change reverted to 8188 on the next launch. New `load_comfy_config_values()` helper runs at startup and applies persisted port + host. Bundled with the host feature since they share the same config-load path.
- **OpenAI-compat local backends (LM Studio, vLLM, llama.cpp server, KoboldCpp, oobabooga, Jan, GPT4All, Aphrodite, SGLang, TGI, LocalAI, TabbyAPI) can actually be reached from LU's Tauri webview** — `openai-provider.ts` used plain `fetch()` for `/v1/models`, `/v1/chat/completions`, and `checkConnection`, which CORS-blocks localhost requests inside the Tauri WebView (only Ollama had CORS open). The "Test" button in Settings → Providers always showed **Failed** and models never appeared in the dropdown even when the backend was obviously reachable via curl. Fix: each HTTP call now picks `localFetch`/`localFetchStream` when the provider baseUrl hostname is local (`localhost`/`127.0.0.1`/`::1`/`0.0.0.0`), which routes through the Rust proxy with a direct-fetch fallback. Cloud endpoints (OpenAI proper, OpenRouter, Groq, Together, DeepSeek, Mistral, etc.) skip the proxy since they don't have the localhost CORS issue. Surfaced during v2.3.6 live E2E against a real LM Studio server on :1234; the Djoks auto-detection fix (v2.3.5) was detecting + pre-enabling the provider correctly, but the actual /v1/* calls were silently CORS-rejected.

### Changed
- Test suite 2166 → 2183 green (+17 regression tests for `setComfyHost` / `isComfyLocal` / `comfyuiUrl` / `comfyuiWsUrl` with custom hosts).

### Notes
- Drop-in upgrade from v2.3.5. No breaking changes. The default host is still `localhost` — existing users see zero behavior change unless they explicitly switch to a remote host.

## [2.3.5] - 2026-04-21

### Fixed
- **LM Studio (and other openai-compat backends) now show up when Ollama is also running** — `AppShell`'s post-onboarding detection only auto-enabled a backend when exactly one was detected. With two or more (the very common Ollama + LM Studio setup) it showed the `BackendSelector` modal but pre-enabled nothing. Users who dismissed the modal saw zero LM Studio models in the chat dropdown even though LM Studio was clearly running — looked from the outside like "LU doesn't recognize my models". Reported via Discord `#help-chat` on 2026-04-21. Fix: the first non-Ollama detected backend is always pre-enabled (Ollama is left untouched since it has its own provider slot); the selector stays as an educational picker so you can change which openai-compat backend is primary. Reproduced live with a mock LM Studio endpoint on port 1234 with Ollama also running, verified the fix against the same setup on the release binary. Five regression tests in `AppShell-backend-autoenable.test.ts`.
- **No more terminal flashes on Windows when LU kills subprocesses** — two Windows-branch `Command::new` spawns were missing `CREATE_NO_WINDOW`: the `taskkill` calls in `AppState::Drop` that tear down ComfyUI + Claude Code process trees on LU shutdown, and the `docker pull` / `docker run` in `search.rs` that installs SearXNG. Both briefly flashed a console window at the user. Now 100% of Windows-branch subprocess spawns carry the flag. LU itself never spawns LM Studio (only talks HTTP to a user-run instance), so the "no terminal when using LM Studio" guarantee was already true on that path; this tightens the peripheral surface.
- **`setup.bat` / `setup.ps1` / `setup.sh` no longer mislead end-users into dev mode** — the scripts launched `npm run dev` (Vite + browser), which has fewer features than the installed Tauri app and produced confusing `[vite] http proxy error: /system_stats ECONNREFUSED` when ComfyUI wasn't installed yet. Reported via GitHub issue #30. Fix: all three setup scripts now start with a clear dev-mode banner, a link to the installer in Releases, and a one-key prompt to continue or exit. The README's "Windows One-Click Setup" section was also reframed as "For Contributors — Dev-Mode Setup" with an explicit pointer to the installer for end-users.

### Changed
- Test suite 2161 → 2166 green (+5 regression tests for the backend-autoenable fix).

### Notes
- Drop-in upgrade from v2.3.4. No breaking changes. No localStorage migration. Everything from v2.3.4 (chat-history persistence, Ollama 0.21 compat, Codex loop guard, stop-button fast-path, stale-chip fix, 12-backend auto-detect, Mobile Remote, Codex streaming, Agent Mode rewrite, ERNIE-Image, Qwen 3.6, 75+ one-click model downloads) still applies.

## [2.3.4] - 2026-04-20

### Fixed
- **Chat history now survives updates** — `isTauri()` was checking the v1 global `window.__TAURI__`, but Tauri 2 renamed it to `window.__TAURI_INTERNALS__`. Inside the packaged `.exe` every Tauri-only backend command (`backup_stores`, `restore_stores`, `set_onboarding_done`, ComfyUI manager, whisper, process control) silently fell through to the dev-mode fetch path and no-op'd. Fix: dual-global check + 100 ms × 50-tick polling loop that waits for the Tauri global to appear before arming the backup triad (required because `withGlobalTauri: true` sets the global asynchronously on slow cold-starts). Full destructive wipe+restore roundtrip live-verified on the release binary.
- **Backup cadence tightened** — safety-net interval 30 s → 5 s; added event-driven debounced backup on every chat mutation (1 s after the last message); added `beforeunload` sync flush for graceful quits. All three legs run unconditionally with a `__ts` marker so the snapshot is always non-empty.
- **Ollama 0.21 / 0.20.7 compatibility** — auto-upgraded Ollama rejects pre-existing models with `HTTP 404 model not found` on `/api/show` when the on-disk manifest lacks the `capabilities` field. New `modelHealthStore` + top-of-app `StaleModelsBanner` + Header Lichtschalter chip detect stale models and offer a one-click re-pull that verifies the fix before clearing the warning. Error parser tolerates 400/404/Rust-proxy-wrapped-500 forms.
- **Stale-chip state leak** — switching from a stale model to a fresh one now clears the red toggle and the inline chip immediately; switching between two different stale models re-pins correctly.
- **Codex infinite-loop guard** — small 3 B coder models (qwen2.5-coder:3b, llama3.2:1b) could loop forever repeating the same `file_write + shell_execute` batch when a test failed. Codex now tracks per-iteration batch signatures and halts after two consecutive identical batches with "same tool sequence repeated N× — try a larger model".
- **Stop button instant** — `abort.signal.aborted` checked at the top of the `for await` chat stream and the NDJSON reader loop; `reader.cancel()` on abort. No more 30–60 s of thinking-token leak after clicking Stop on a Gemma-4 response.
- **`isHtmlSnippet` export missing** — 19 failing CodeBlock tests fixed.
- **Create view crashed silently in browser bundle** — `comfyui.getKnownFileSizes` used CommonJS `require('../api/discover')` which Vite/Rolldown can't resolve. Replaced with dynamic `import()`.
- **flux2 CFG scale test regression** — test asserted 3.5 (Z-Image default); corrected to 1.0 (flux2 default).

### Changed
- Test suite 2105 → 2161 green (+56 regression tests covering backup triad, Codex loop detection, `__TAURI_INTERNALS__` detection, stale-manifest parsing).

### Notes
- No breaking changes. Existing chats and settings survive the upgrade via the now-working restore path.
- Existing `phi4:14b`, `dolphin3:8b`, and other pre-0.15 Ollama models will show in the stale banner. Click "Refresh all" to re-pull; manifests will be regenerated with the new `capabilities` field.

## [2.2.1] - 2026-04-04

### Fixed
- **Model unloading broken** — unload button and automatic unload on model switch silently failed (missing `prompt` field in Ollama `/generate` call), causing models to stay in RAM indefinitely
- **No GPU offloading** — models ran entirely on CPU/RAM instead of GPU; added `num_gpu: 99` to all Ollama chat calls so layers are offloaded to GPU automatically (Ollama splits between GPU and CPU if VRAM is insufficient)
- **Silent error swallowing** — unload errors were caught and discarded with `.catch(() => {})`; now logged to console for debugging

## [1.9.0] - 2026-04-03

### Added
- **Agent Mode (Beta)** — AI can use tools: web_search, web_fetch, file_read, file_write, code_execute, image_generate
- **Two-phase search** — web_search finds URLs, web_fetch reads actual page content for accurate answers
- **Tool approval system** — safe tools auto-execute, dangerous tools require user confirmation
- **Live tool-call blocks** — inline status with expandable arguments and results
- **Agent onboarding tutorial** — 4-step walkthrough for first-time users
- **Memory system** — auto-saves tool results, keyword search, category filters, export/import as .md
- **Context compaction** — automatic message compression to prevent context window overflow
- **Model auto-fix** — abliterated models get tool-calling template restored via Ollama Modelfile
- **Hermes XML fallback** — prompt-based tool calling for models without native support
- **Persona dropdown** — quick persona switching in chat top bar
- **Variant selector** — dropdown for multi-size model downloads in Discover
- **HOT/AGENT badges** — recommended models highlighted in Model Manager
- **web_fetch tool** — fetches URLs and extracts readable text content (HTML → text)

### Changed
- **UI redesign (Linear/Arc style)** — compact header, collapsible settings, list-view models, minimal borders
- **Sidebar** — narrower, minimal hover states, smaller text
- **Settings** — collapsible sections, inline sliders, compact toggles
- **Model Manager** — list layout instead of card grid
- **Start screen** — clean LU logo only, smooth transition to chat
- **Header** — renamed to LUncensored, removed old Agents tab
- **Tool call display** — inline colored text instead of colored boxes

### Fixed
- DuckDuckGo search snippet truncation (regex now captures full HTML content)
- DDG URL extraction from redirect wrappers
- Context window exhaustion after many tool calls ("Failed to fetch" error)

### Removed
- Old standalone Agent View (replaced by in-chat Agent Mode)

---

## [1.5.5] - 2026-04-02

### Added
- **Zero-Config Model Experience**: Auto-detect model type, apply optimal defaults (steps, CFG, sampler, size)
- **Pre-flight Validation**: Check VAE/CLIP/nodes before generation with direct download buttons on errors
- **VRAM-Based Recommendations**: Detect GPU VRAM via ComfyUI, sort bundles by fit ("Fits your GPU" / "Needs more VRAM" badges)
- **2026 State-of-the-Art Models**: Updated bundles with FLUX 2 Klein 4B, LTX Video 2.3 22B, curated text models (GLM 4.6, Qwen 3)
- **Download Manager**: Pause, cancel, and resume model downloads (CancellationToken + HTTP Range headers)
- **TTS Auto-Speak**: Chat responses read aloud when TTS is enabled in settings
- **6 Complete Model Bundles** — one-click download with all required files:
  - Image: Juggernaut XL V9, FLUX.1 schnell FP8, FLUX.1 dev FP8
  - Video: Wan 2.1 1.3B, Wan 2.1 14B FP8, HunyuanVideo 1.5 T2V FP8
- **RAG IndexedDB Persistence**: Chunk embeddings survive page reload (no more data loss)
- **ErrorBoundary** around RAG panel (prevents white page on errors)
- **Splash Screen**: LU logo on startup, window shows only after React renders (no blank screen)
- **CI/CD Pipeline**: GitHub Actions workflow for PR validation
- **Accessibility**: aria-label on 48 icon-only buttons across 16 components
- **LU Monogram Branding**: New logo across app icon, favicon, social preview, README

### Fixed
- **Tauri .exe fully working**: CORS proxy through Rust, Ollama /api prefix, CSP for IPC, download ID sync, ComfyUI auto-start deadlock
- **RAG Document Chat**: React 19 infinite loop fix (useShallow for Zustand persist), detailed error messages (Ollama down, model missing, empty file)
- **CLIP/VAE fallback**: Descriptive error with download instructions instead of silently using wrong model
- **RAG BM25**: Proper IDF calculation using document frequency across all chunks
- **Agent image_generate**: Actually calls ComfyUI via dynamic workflow builder (was returning stub)
- **Whisper check**: isSpeechRecognitionSupported() checks if Whisper is actually running
- **Chat history**: Filter empty assistant messages before sending to LLM
- **ComfyUI path discovery**: Deep scan (depth 7), auto-detect from running process, manual path input
- **Model Manager**: Show diffusion_models alongside checkpoints
- **Python discovery**: Improved binary detection (AppData, Conda, version check)
- **Startup**: Whisper loads in background thread (no blocking), terminal windows hidden in release

### Changed
- Enhanced model classification (15+ known community models) with component registry
- Landing page: 3x3 model grid with latest models, updated FAQ
- All landing page images converted to WebP with `<picture>` fallback + width/height for CLS
- DevTools only in debug builds
- Removed console.warn from production code, fixed unused imports
- Cleaned repo: removed internal files (logo concepts, marketing assets, dev drafts)

## [1.3.0] - 2026-03-31

### Added
- **RAG Document Chat**: Upload PDF, DOCX, or TXT files to chat with your documents
  - Hybrid search (vector + BM25 keyword matching) for better retrieval
  - Confidence score display with color-coded badges
  - Ollama context window warning when model has insufficient context
  - Automatic embedding model download (nomic-embed-text)
  - Per-conversation RAG toggle and source citations
- **Standalone Desktop App**: Full Tauri v2 Rust backend — .exe runs without Node.js or dev server
  - 15 Rust commands replacing Vite middleware (process management, downloads, search, agents, voice)
  - Frontend auto-detects Tauri vs browser and routes accordingly
  - Ollama, ComfyUI, and Whisper auto-start on app launch
  - Clean process shutdown on app exit
- **Voice Integration**: Talk to your AI and hear responses
  - Persistent Whisper server loads model once (~2.5 min), then transcribes in ~2s
  - Push-to-talk microphone button with local faster-whisper (100% offline, no cloud)
  - Text-to-speech on any assistant message with sentence-level streaming
  - Voice settings (voice selection, rate, pitch)
  - Auto-send transcribed text option
- **AI Agents**: Autonomous task execution with local tools
  - ReAct-style reasoning loop with 5 built-in tools
  - Web search, file read/write, Python code execution, image generation
  - User approval required for destructive actions
  - Task breakdown visualization and color-coded execution log
  - Robust JSON parsing with 4-tier fallback and error recovery

### Fixed
- Cross-platform Python detection for code execution (Windows Store alias handling)
- Web search now falls back to Brave Search when DuckDuckGo returns CAPTCHA
- ComfyUI auto-discovery now scans up to 4 levels deep (finds nested installs with spaces in path)
- Ollama/ComfyUI spawn no longer opens extra console windows on Windows
- Whisper transcription no longer times out (was re-loading 145MB model on every request)


## [1.0.2] - 2026-03-25

### Fixed
- Complete Create tab rewrite — resolved all 55 known issues
- Persona icons now show diverse set of avatars
- Logo navigation works correctly
- Video display rendering fixed

## [1.0.1] - 2026-03-25

### Fixed
- Image and video model auto-detection now works reliably
- FLUX workflow generation fixed
- ComfyUI integration: auto-start, auto-stop, live status indicator
- Personas load correctly on new chat sessions
- Light mode text contrast improved
- Video backend display fixed

## [1.0.0] - 2026-03-24

### Added
- **AI Chat** via Ollama with streaming responses
- **Image Generation** via ComfyUI (SDXL, FLUX, Pony checkpoints)
- **Video Generation** via ComfyUI (Wan 2.1/2.2, AnimateDiff)
- **25+ Built-in Personas** — from Helpful Assistant to creative characters
- **Model Manager** — browse, install, switch, and delete models
- **Discover Models** — find and install models from Ollama registry
- **Thinking Display** — collapsible reasoning blocks
- **Dark/Light Mode** with glassmorphism UI
- **Conversation History** — saved locally in browser
- **Model Auto-Detection** — finds all installed models automatically
- **One-Click Setup** — `setup.bat` installs everything on Windows
- **Hardware Detection** — recommends models based on your GPU/RAM
