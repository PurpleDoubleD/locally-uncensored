# Changelog

All notable changes to Locally Uncensored are documented here.

## [Unreleased]

## [2.6.8] - 2026-09-03

The compact release. A long conversation folds its older turns into a summary
instead of running out of room, an agent hands work to background agents that
run while you carry on, a reasoning model gets a dial for how much thinking a
reply may pay for, every local model answers on one OpenAI-compatible address,
and the built-in engine has a name of its own, the LU Engine.

### Added

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
  ten minutes of caching; and a run that runs out of memory on the card says
  what to close. Lines from winget stay out of the note under the button.
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

- **LoRA selection in image generation** (#109, ElBiggus). The image track
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

- **Dragging files into the app works again on Windows** (#111, ElBiggus).
  Dropping photos on the Character Studio board did nothing while picking the
  same files through the dialog worked. The window framework had claimed drag
  and drop for itself, so the page never saw the drop. That silently affected
  three places, not just the one that got reported: the training board, the
  chat composer and the RAG panel.
- **Download and install finishes instead of sitting on "Refreshing the model
  list"** (Voxyl AI and Aldrich Ironhart). On Extend Video and Animate Image
  the transfer ran to the end and the card then never moved again. The files
  were on disk the whole time; ComfyUI was still scanning its folders, and
  nothing waited for it. The install now waits for the models to actually show
  up, counts the seconds so you can tell a wait from a hang, restarts the
  engine once if the scan never catches up, and if even that fails it says
  what is wrong instead of freezing.
- **Turning thinking off now turns it off on your own server too** (#112,
  kevinmlynch, who sent the diagnosis and a patch). We asked for the smallest
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
  ElBiggus). Four different places rolled their own random seed and kept the
  number to themselves, so every random run was filed as seed 0 and no image
  you liked could be reproduced. The dice are thrown once per run now, and
  that number reaches the sampler and the gallery. Cloud runs carry their
  seed too, instead of letting the provider roll one nobody learns.
- **Help tooltips are readable again** (#107, ElBiggus). The latent-upscale
  help text was clipped to about two words by the card it sat in. Tooltips
  now float above the whole window, flip away from the screen edge and keep
  pointing at what they explain, everywhere in the app.
- **The Music tab stops printing cloud facts at local users** (#108,
  ElBiggus). Running locally it hid the lyrics box while claiming the model
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
  I-Am-LongXi). Conversation state is saved before an image or video render
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

### New — Delete image/video models from the Model Hub (cpl.sardinas7489, Discord)

- Installed image and video models finally have a trash button. Before, delete existed only for Ollama chat models — a ComfyUI checkpoint that turned out too big for the PC (the report: a 27 GB video model whose render hit the 60-minute timeout) had no way back out of the app and sat on the disk forever. The delete removes the model file (plus a stale resume-partial next to it), rescans ComfyUI and refreshes the list; the path goes through the same traversal-jailed helpers as downloads and refuses anything outside the known model folders.

### New — "Update ComfyUI" from inside the app

- When a specialized lane needs core nodes a user-managed ComfyUI is too old to have, LU can `git pull` + reinstall requirements in place (the same streaming, cancellable, retrying installer the bundle downloads use) instead of leaving a cryptic ComfyUI rejection. Gating stays node-presence based (no brittle version-string parsing). LU-managed ComfyUI installs are always current; a user's own install gets the offer, never a forced update.

### Fixed — Voice: whisper/piper state detection, venv installs, PEP 668 (#77, #78 ElBiggus; joerack Discord)

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

### Fixed — ComfyUI 0.19+ blocks LU's progress + media unless you pass a CORS flag (#75 cinemazverev)

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

- Picking a model that does not support function calling and then using Agent or Code mode (or Chat with tools on) made the hosted inference endpoint answer HTTP 405, which surfaced as an opaque error or an aborted turn with no explanation (a paying user hit exactly this). LU now recognises that case across every OpenAI-compatible backend (LU Cloud / DeepInfra, LM Studio, custom endpoints) and shows a plain "this model does not support tool calling" note that says what to do: turn tools off, or switch to a tool-capable model.
- **LU Cloud now knows up front which models can't do tools.** The `/models` list carries a per-model tool-calling flag, so Agent mode is disabled before you ever send a request on the cloud chat models that lack function calling (Hermes 3, Euryale, MythoMax, Llama 4 Maverick, and friends) — no failed turn required. Plain chatting with those models still works.
- **Every chat model in the dropdown now shows a tools icon at a glance:** a green wrench for models that support tool calling, an amber marker for models that don't (whether the server declared it, or a run proved it). When the server returns its clean "can't run tools / can't read images" reason, LU surfaces that exact line instead of a generic error.

### Fixed — Local Create now frees the chat model from VRAM before rendering

- On a single local GPU, a chat model sitting in VRAM (Ollama / LM Studio / the bundled engine) left ComfyUI fighting for the card — heavy CPU offload at best, a CUDA out-of-memory on the 14B Talking Character lane at worst. A local Create run now releases the chat backends first (they reload lazily on your next message), the same offload the Cloud switch already did, so the render gets the whole GPU. ComfyUI keeps its own checkpoint cached across consecutive Create runs, so back-to-back generations don't pay a reload. (On a large card where both would have fit, this trades a quick chat-model reload for guaranteed headroom — the conservative default for the common 8-12 GB tiers.)

### New — Frame count, resolution and step controls on every Create lane

- **You can finally set frames, resolution and steps in the app** — before, the Video tab only had a Draft/Standard/High quality toggle, and the specialized lanes (Talking Character, Music, Extend) had no generation knobs at all, so a local video ran at the model's full frame count and step count with no way to dial it down. The composer now shows the exact knobs each lane actually consumes: **Quality (steps) + Size + Frames** on every video lane, **Quality (steps)** on the local Music lane (Length was already there), and the existing Quality + Aspect on image lanes. This makes low-VRAM runs practical — drop the steps and frames and a clip that used to be a multi-hour render finishes in minutes.
- **Nothing on screen is a dead control.** The knobs render only where the submit path reads them: locally every lane consumes them; the regular Video/Animate lanes honour them on LU Cloud too; the specialized hosted ops run at fixed server-side settings, so those sliders stay hidden on Cloud rather than pretending to work. On Talking Character the frame count is hidden entirely and labelled "clip length follows your voice", because the lane derives it from the audio.
- **The Size tiers are video-native.** They read the lane's actual video model (Wan S2V / Animate / the picked video model), not the last image model, so a 480p video graph offers 320p/480p/720p rather than image-centric 1024p sizes; dimensions snap to the multiple of 16 the WAN/S2V/VACE VAEs require.

### New — ComfyUI install location is configurable (andy_38747, Discord)

- The Settings → AI Backends → ComfyUI **Path** field now doubles as the install target: put e.g. `D:\ComfyUI` there before pressing **Install ComfyUI** and the multi-GB install (plus all image/video models, which live inside the ComfyUI folder) lands on that drive instead of filling `C:`. Empty field keeps the previous default (home folder). A completed custom-target install is persisted as the active path, so LU finds it after a restart.

### Fixed — Create-tab LoRA picker was a silent no-op (game-master0, Discord #80)

- The Create UI collected selected LoRAs into a `loras` param that **no code ever read** — the workflow builder expects `lora`/`loraStrength`. Selections now reach the builder, for images and video.
- **Video LoRA support**: the LoRA stack is no longer hidden for every video model — it shows for families whose graphs support model-only LoRA loading (WAN, WAN 2.2, Hunyuan, LTX, Mochi, Cosmos). WAN 2.2's dedicated builder gains a guarded `LoraLoaderModelOnly` chain; a plain WAN 2.2 run without LoRAs produces a byte-identical graph to before.

### New — Delete individual chat messages (Discord #81)

- Every message's action bar gains a delete button (two-click confirm within 3 s, works for both user and assistant messages). Pairs with the existing edit/regenerate actions.

### New — LiteLLM provider preset (PR #64, thanks @RheagalFire)

- One-click provider preset pointing at a local LiteLLM proxy (`http://localhost:4000/v1`, OpenAI protocol) — fronts 100+ upstream providers from one endpoint.

### Fixed — Errored bundle downloads can now be cleared (the_mr_pickles, Discord)

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

Minor release. 30+ changes — the headline Codex / Agent sprint (Sprint A / B / C ported from the companion repo `uselu`), eight reporter-facing fixes (B1–B3 + AA + Y + Z), two new pieces of UI (BB — GPU picker, CC — chatbot-export importer), production hardening (B4 / B5), and the autonomy-ceiling bump that turns scaffold→install→fix→verify into a single turn. Bundles all v2.4.9 contents.

### Fixed — Ollama auto-detection persists across launches (B1)

- **Ollama re-enabled state now pins through restart** (cinemazverev). `AppShell.tsx` boot path previously re-ran auto-detect on every launch and reset a user's manually-enabled Ollama back to disabled when the daemon was momentarily unreachable. v2.5.0 records the user's deliberate re-enable in localStorage and treats it as authoritative — auto-detect can only add backends, never remove ones the user explicitly turned on.

### Fixed — Multi-backend modal persists Ollama choice (B2)

- **`BackendSelector.tsx` modal Ollama choice survives modal re-open** (vanja-san). Pre-v2.5.0 picking Ollama in the multi-backend modal, closing it, and re-opening reset the dropdown to "Auto". v2.5.0 reads the previous selection from settings on mount and re-applies it so the user's chosen backend stays sticky across modal opens.

### Fixed — LM Studio per-model load/unload backend (B3)

- **Three new Tauri commands for LM Studio per-model control** (THobbs23): `lmstudio_list_loaded`, `lmstudio_load_model`, `lmstudio_unload_model`. UI integration lands in the next hotfix — the backend half ships now so the LM Studio panel work can build against a stable surface.

### Fixed — Ollama actually uses the context window you set (Bug AA)

- **`num_ctx` now travels from Settings → Ollama on every chat + tool call** (kj103x Discord 2026-05-25/27 thread `1507756765612216411`). Pre-v2.5.0 LU passed `temperature`, `top_p`, `top_k`, and `num_predict` through to `/api/chat` but never `num_ctx`, so Ollama silently defaulted to 2048 regardless of what the user set in the UI. RAG payloads and long-turn chats got clipped on every model regardless of what the loaded model actually supported — kj103x's "VRAM caps at ~5 GB no matter the token limit" symptom. v2.5.0 adds `contextWindowOverride` to `Settings`, a `Context window (Ollama)` input under Settings → Generation, and threads the value through `ChatOptions.contextWindow` in `src/api/providers/ollama-provider.ts` (chatStream + chatWithTools) and `src/lib/ollama-stream-tools.ts` (agent tool loop). Forwarded to all four consumers — `useChat`, `useABCompare`, `useAgentChat`, `workflow-engine`. 0 = let Ollama decide (default, matches pre-v2.5.0 behaviour). Cloud providers ignore the field — they manage context themselves.

### Fixed — Downloaded but invisible (Bug Y, two-layer)

- **`handleTextDownload` now routes by the *active chat provider*, not by which backend happens to be enabled** (Aldrich Ironhart Discord 2026-05-25/26, msg `1508875114215899156`). Pre-v2.5.0 the logic was `useOllamaPath = !lmStudioOn && ollamaOn` — whichever was enabled won. A user chatting on LM Studio who clicked Download in Discover got the file pulled into Ollama's store (or vice versa), invisible to the chat side because the chat picker couldn't see the other backend. v2.5.0 derives the target from `getProviderIdFromModel(activeChatModel)` in `src/components/models/DiscoverModels.tsx`, with the old enabled-wins logic as a fallback for first-launch empty-state users. Ollama-only entries (those with `model.ollamaModel`) now refuse with a clear error when the user is on LM Studio ("Switch the chat picker to an Ollama model first") instead of silently pulling somewhere the user can't see.
- **`isModelFullyInstalled` now also matches LM Studio scanner output** (Y/b). Pre-v2.5.0 the check only looked at `installedModels.filter(m => m.provider === 'ollama')` tags. After a restart, the in-memory `downloads[filename]` flag is gone, so GGUFs that LU itself wrote to LM Studio's scan dir never lit up the INSTALLED badge. v2.5.0 also matches LM Studio entries by filename basename (case-insensitive, with-or-without `.gguf` suffix, with-or-without LM Studio's `<publisher>/<repo>/` prefix), so the badge survives both a restart and a cross-backend download.

### Fixed — Hermes 3 phantom-complete + Hermes 3 repo retarget (Bug Z, leonsk29 GH #48)

- **Pulls that fail without an explicit `{"status":"success"}` no longer flip the badge to "Completed"** (leonsk29 GH #48 2026-05-26). Pre-v2.5.0 `pull_model_stream` in `src-tauri/src/commands/proxy.rs` returned `Ok(())` whenever the byte-stream ended cleanly, even if Ollama never said "success" — and `src/hooks/useModels.ts` swallowed any thrown error from the catch with an empty block. leon's CLI repro on 2026-05-26 confirmed Ollama responds to a broken HF reference (e.g. `bartowski/Hermes-3-Llama-3.1-8B-GGUF` on llama.cpp-incompatible builds) with HTTP 200 + a stream that ends after just `{"status":"pulling manifest"}`. v2.5.0's Rust side now tracks the last status + watches each line for an `error` field, and returns a descriptive `Err` ("pull did not complete: stream ended at \"pulling manifest\". Repo may be incompatible with llama.cpp (try a different GGUF mirror).") when neither success nor explicit error came through. `useModels.ts` now surfaces that string as the card's last status (`Failed: ...`) instead of swallowing it. Cancellation is still distinguished from real errors.
- **Hermes 3 discover entries switched from `bartowski/Hermes-3-Llama-*-GGUF` to `mradermacher/Hermes-3-Llama-*-GGUF`** (Z/b). bartowski's quants for those specific repos return HTTP 400 on current Ollama. mradermacher's GGUFs are llama.cpp-compatible and ship the same Q4_K_M sizes (2 GB / 5 GB / 42 GB for 3.2 3B / 3.1 8B / 3.1 70B respectively). Filename convention also changed (mradermacher uses `.Q4_K_M.gguf`, bartowski uses `-Q4_K_M.gguf`) and the entries reflect that.

### New — Hardware: GPU picker (Bug BB, BobbyT)

- **Settings → Hardware now lists every detected GPU and lets you pin a vendor + indices** (BobbyT Discord 2026-05-26). BobbyT runs AMD RX 6800XT 16 GB + Intel Arc Pro B60 24 GB and wanted to pin the Arc Pro for inference. Pre-v2.5.0 LU had no picker — Ollama and ComfyUI used whatever the driver picked first. v2.5.0 adds `commands::gpu` with `detect_gpus` (probes nvidia-smi / rocm-smi / lspci on Linux / wmic on Windows / system_profiler on macOS), `set_gpu_selection` / `get_gpu_selection` (AppState-backed), and `apply_gpu_env` which forwards the right env-var family on next `start_ollama` / `start_comfyui` spawn: `CUDA_VISIBLE_DEVICES` for NVIDIA, `HIP_VISIBLE_DEVICES + ROCR_VISIBLE_DEVICES` for AMD, `ONEAPI_DEVICE_SELECTOR` (level_zero) for Intel. "Auto" leaves env-vars unset and matches pre-v2.5.0 behaviour. Frontend lives at `src/components/settings/HardwareSettings.tsx`; settings persisted as `gpuVendor` + `gpuIndices` on the existing Settings store. The boot effect in `App.tsx` pushes the persisted pick into AppState at app start so users don't have to open Settings before the first Ollama / ComfyUI spawn.

### New — Chatbot-export importer (Feature CC, MikeS++)

- **Settings → "Import past chatbot conversations" parses ChatGPT, Claude, and Gemini exports** (MikeS++ Discord 2026-05-27). New file picker accepts the official export JSON or the unmodified .zip (JSZip walks for `conversations.json` with a fallback to the largest .json inside). Per-platform parser in `src/lib/parsers/chatbot-export.ts`: ChatGPT's `mapping` tree gets linearised by walking the first child each turn (matches what the user saw in the UI), Claude's `chat_messages` array gets a 1-to-1 markdown render, Gemini's `messages` array (or single-prompt activity fallback) gets the same treatment. Each conversation becomes a synthetic `.md` File and goes through the existing `useRAG.uploadDocument` pipeline — same chunking + embedding flow as a dragged-in document. Imports attach to the active chat's RAG store (per-conversation by design; memory facts stay in the curated memoryStore). Conversations are pre-selected for convenience; the UI surfaces per-conversation checkboxes + Select all / none for cleanup before import. Stays on the user's machine — no upload, no cloud round-trip.

### New — Codex / Agent capabilities (Sprint A / B / C from uselu)

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

### Hardening — Iteration cap bump (uselu live-test 2026-05-25)

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

juliandiggins-stack's queued feature requests are deferred to v2.5.1 since the codex sprint took priority for this release.

## [2.4.9] - 2026-05-25

Sweep release on top of v2.4.8. Five bug fixes (U — GH #47 levoy1; V — Discord kj103x 2026-05-23 #help-chat, split into V/a RAG-persistence and V/b Ollama-orphan; W — Discord nightmare13740 2026-05-23/24 benchmark followup; X — Discord leonsk29 2026-05-24 #general thinking/agent toggles) plus two leonsk29 feature requests (GH #45 + GH #46).

### Fixed — ComfyUI Desktop App detection (Bug U)

- **Onboarding now recognises the ComfyUI Desktop App** (GH #47, levoy1 2026-05-24). Pre-v2.4.9 both auto-detect (`detect_all_comfyui_installs_sync`) and manual entry (`set_comfyui_path`) required `main.py` to be the path's direct child. Levoy1's ComfyUI Desktop App from comfyanonymous (default install `%LOCALAPPDATA%\Programs\ComfyUI`) ships only `ComfyUI.exe` next to the Electron resources — the actual ComfyUI Working Directory with `main.py`, `models/`, `custom_nodes/` is at `~\Documents\ComfyUI` by default (or wherever the desktop installer's picker pointed at, recorded in `%APPDATA%\ComfyUI\config.json`'s `basePath`). v2.4.9 adds a `resolve_comfyui_path` helper that accepts either layout: if the given dir has `main.py` it's a classic install, if it has `ComfyUI.exe` it's the Desktop App and we walk a probe list (`Documents\ComfyUI`, `Documents\ComfyUI\ComfyUI`, `%APPDATA%\ComfyUI` and its `config.json` `basePath` hint, `%LOCALAPPDATA%\ComfyUI`, `%LOCALAPPDATA%\Programs\ComfyUI\resources\ComfyUI`) until we find `main.py`. The auto-scan picks the same hints. When the binary dir is given but no Working Directory is reachable, the error message tells the user exactly which folder we need ("LU needs the ComfyUI Working Directory with main.py, models/, custom_nodes/ — by default `~\Documents\ComfyUI`") instead of the previous bare "main.py not found".

### Fixed — RAG document persistence (Bug V/a)

- **RAG embedding chunks survive an NSIS auto-update / WebView2 data reset** (kj103x Discord 2026-05-23 thread `1507756765612216411`, references GH Discussion #26 as "'fixed' but not really fixed"). v2.3.4 closed the chat-message half (3-leg backup of localStorage → `%APPDATA%\Locally Uncensored\store_backup.json`), but the RAG chunks (embedding vectors stored in IndexedDB at `locally-uncensored-rag → chunks` because 768-float vectors blow past localStorage's quota) were never in the backup pipeline. After an NSIS upgrade or WebView2 data wipe, `documents` (the file-metadata localStorage half of `rag-store`) restored fine but the chunks were lost — every RAG-enabled chat would show the document name and silently return no retrievals. v2.4.9 adds two Tauri commands (`backup_rag_chunks`, `restore_rag_chunks`, same atomic-temp-rename pattern as `backup_stores` to `%APPDATA%\Locally Uncensored\rag_chunks_backup.json`) and two `ragDB.ts` helpers (`exportAllChunks` / `importAllChunks`). The backup triad in `AppShell.tsx` now backs up RAG chunks on a 30 s interval + on `beforeunload`, separate cadence from the existing 5 s chat-snapshot triad because chunk payloads are heavy and change rarely (only on document upload/delete). Restore runs alongside `restore_stores` on cold start AND on warm starts where IndexedDB might be empty while localStorage has the doc metadata — and only imports entries the live store is missing, so a stale backup can't clobber newer in-app activity.

### Fixed — LU-spawned Ollama is killed on shutdown (Bug V/b)

- **Auto-installed `ollama serve` no longer lingers as a 200 MB orphan after LU quits** (same kj103x thread). The Drop impl on `AppState` already killed `comfy_process` and `claude_code_process` on shutdown, but Ollama was never stored — `start_ollama` and `auto_start_ollama` spawned `ollama serve` and discarded the `Child` handle, so quitting LU (tray → Quit) left `ollama.exe` running in the background indefinitely. v2.4.9 adds `ollama_process: Mutex<Option<Child>>` to `AppState`, captures the spawn in both call sites, and adds an Ollama kill leg to `Drop` that mirrors the ComfyUI taskkill `/T /F` pattern (kills the process tree). The pre-spawn tasklist check stays in place so we only ever store a `Child` we ourselves started — a user-managed `ollama serve` that was already running when LU launched is left alone, so quitting LU never kills someone else's Ollama. Hide-to-tray (`X` button) is unaffected: the page stays alive, Ollama keeps serving, no Drop runs until the user explicitly Quits from the tray menu. Same release also upgrades `exit_app` (used by the auto-updater to let NSIS swap the binary) from `std::process::exit(0)` to `app.exit(0)` so the Drop chain actually runs during an update — pre-v2.4.9 hard-exit bypassed every destructor and left both Ollama AND ComfyUI orphaned across upgrades.

### Fixed — Benchmark shows latest run, not running average (Bug W)

- **Per-model benchmark display is the latest session's tok/s, not a session-wide average that drifts as more samples accumulate** (nightmare13740 Discord 2026-05-23/24, Bug M retest). After the v2.4.8 Ollama `eval_count`/`eval_duration` fix, nightmare13740 ran gemma4:e4b ten times and watched the displayed tok/s climb from 15.2 to 17.9 across runs. They thought previous results were affecting new ones — they were, but only because `getAverageSpeed` in `benchmarkStore.ts` averaged every historical entry. Per-run measurements were stable; the UI was showing a drifting mean. v2.4.9 adds `getLatestSpeed(results, modelName)` which groups runs into "sessions" by a 10 s timestamp gap (one Run Benchmark click runs through BENCHMARK_PROMPTS in seconds, the next click is at least seconds later — usually minutes) and returns the mean of the most recent session only. `BenchmarkView.tsx` and `ModelBenchmark.tsx` switch to `getLatestSpeed`; the leaderboard keeps `getLeaderboard`/`getAverageSpeed` since cross-model comparison benefits from averaging out noise. Four new vitest cases pin the session-boundary logic.

### Fixed — Thinking + Agent toggles enable for community-uncensored Gemma 4 (Bug X)

- **`isThinkingCompatible` and `isAgentCompatible` now match dashed-family names (`gemma-4-…`) and multi-segment HF paths (`hf.co/<org>/<repo>:<tag>`)** (leonsk29 Discord #general 2026-05-24). Symptom: leonsk29 reported the Thinking + Agent toggles both grayed out for every Gemma 4 community variant LU's Discover tab pulls (TrevorJS, nohurry, Stabhappy, LiconStudio, huihui-ai) while the official `gemma4:e4b` from Ollama had both enabled. Root cause was a two-stage match failure in `model-compatibility.ts`: (1) the prefix strip was non-greedy (`/^[^/]+\//`), so `hf.co/trevorjs/gemma-4-31b-it-uncensored-gguf:q4_k_m` only lost `hf.co/` and kept `trevorjs/` in front of the family token; (2) the family-dash collapse was anchored to start-of-string, so `gemma-4-…` mid-string never normalized to `gemma4`; (3) the final `.startsWith` couldn't see past the community prefix `huihui-` / `mradermacher/Huihui-` etc. v2.4.9 rewrites `normalizeFamily` to (a) greedy-strip the full path prefix (catches `hf.co/<user>/<repo>:<quant>`), (b) drop GGUF repo cruft (`-gguf`, `-imatrix`, `-max`, `-i1`, `-ud`), (c) drop tuning/variant markers (`-abliterated`, `-uncensored`, `-heretic`, `-instruct`, `-it`, `-chat`, `-base`), (d) drop quant suffixes (`-q\d…`, `-iq\d…`, `-mxfp\d`, `-nvfp\d`, `-bf\d+`), (e) collapse `gemma-4` / `qwen-3` / `llama-3.1` / `glm-4` / `phi-4` to the dash-less family form anywhere they appear, then matches via a new `containsFamily(family, normalized)` regex that requires non-alphanumeric boundaries on both sides so `mistral` doesn't collide with `mistralfork` and `gemma3xyz` stays excluded. Six new test cases pin the leonsk29 cases (TrevorJS, nohurry, Stabhappy, LiconStudio uncensored / heretic / abliterated repos, two-slash `hf.co/<user>/<repo>` shape, Huihui-prefixed community uncensored builds). One previous "by design" limitation in `model-compatibility-planner.test.ts` for `hf.co/<bart>/gemma4-…` is flipped: it should match, that was always the bug.

### Feature — Onboarding suggests `nomic-embed-text` for Document Chat (GH #45)

- **New onboarding step pulls the embedding model needed for Document Chat / RAG** (leonsk29 GH #45). v2.4.9 inserts an `embeddings` step between `models` and `done` in `Onboarding.tsx` STEP_ORDER. The step probes Ollama's installed model list for anything containing `embed`/`bge-`/`nomic` and auto-shows a "✓ Embedding model already installed" card if any are present (covers LM Studio + Ollama users who already have one). Otherwise it offers a one-click Install for `nomic-embed-text` (274 MB, runs on any CPU) with a progress bar and a Skip button. The Tauri Ollama-pull path is reused (`pullModelTauri('nomic-embed-text')`), gated by a `start_ollama` / `checkOllama` retry loop in case the daemon isn't reachable yet.

- **Upgrade-path coverage for users who completed onboarding before v2.4.9.** The new step above only fires for fresh installs — v2.4.8 → v2.4.9 upgraders never hit it. Three additions close that gap:
  - **`useRAG.uploadDocument` no longer uses `window.confirm`** for the embedding-missing case. Instead, the dropped file is queued in `ragStore.embeddingQueuedFiles` and `embeddingInstallPrompt` flips on. `RAGPanel` renders an in-app card with a Download (274 MB) + Cancel pair, matching the rest of the app chrome. After the pull succeeds, queued files replay automatically through the same `uploadDocument` path.
  - **The pull stream now feeds real bytes-level progress** into `ragStore.embeddingPullProgress` via a `setEmbeddingPullProgress({completed, total, status})` setter. `RAGPanel` renders a deterministic progress bar with `formatBytes(completed) / formatBytes(total) · pct%` instead of the pre-v2.4.9 bouncing-icon banner that showed nothing for 30+ seconds while 274 MB pulled in the background. An indeterminate marquee covers the manifest / verification phases where Ollama doesn't emit byte totals.
  - **Opening the Document Chat panel proactively surfaces the install card** when nomic-embed-text is missing. `RAGPanelInner` runs a one-shot `ensureEmbeddingModel` probe on mount and flips `embeddingInstallPrompt` when the model isn't there, so an upgrading user clicks the Docs button → immediately sees "Embedding model needed… [Download] [Cancel]" without having to drop a file first. Cancel hides the card for the open panel; re-opening probes again. Chrome is neutral white/gray (no blue tint) to match the v2.4.8 Q-polish pattern.

### Feature — VRAM filter for text models in Discover (GH #46)

- **VRAM tier sub-filter (Lightweight ≤10 GB, Mid-Range 10–16 GB, High-End >16 GB) on the text tab** (leonsk29 GH #46). Pre-v2.4.9 only image and video bundles had this filter; text models could only be narrowed by Uncensored / Mainstream. v2.4.9 surfaces the same filter chips on the text category in `DiscoverModels.tsx` and applies them to both `getUncensoredTextModels()` and `getMainstreamTextModels()` via each model's `sizeGB` field (Q4 quant ≈ VRAM need for fully-offloaded inference). Cloud / `canPull:false` entries without a `sizeGB` bypass the filter and always show, since "VRAM" is meaningless for them.

### Stability

- `vitest`: **2312 tests** green (previously 2306; +6 across Bug W session boundaries in `stores/__tests__/benchmarkStore.test.ts` and Bug X community-uncensored matching in `api/__tests__/model-compatibility.test.ts`; existing `model-compatibility-planner.test.ts` cases for `stuff-gemma3-mix` + `hf.co/<bart>/gemma4-X` updated to the new permissive-match semantics).
- `cargo test`: **101 passed + 1 ignored** (no changes to the test surface for Bug U / V/b — those land via existing integration paths).
- `tsc --noEmit`: clean. `cargo check`: clean (pre-existing dead-code warnings only).
- No breaking changes; the new IndexedDB backup is purely additive.

### Heads-up

Windows + Linux only — macOS is not part of this build. `#bug-reports` / `#help-*` / GitHub monitored daily for regression reports. Still open from v2.4.8: 0yagizz OpenRouter half (passive, awaiting F12 console).

## [2.4.8] - 2026-05-23

Drop-in hotfix on top of v2.4.6. v2.4.7 was tagged but not separately released, so v2.4.8 ships its six fixes alongside two new ones plus a UX polish: nine changes total since the last public release.

### Fixed — Model Manager

- **Text models in Discover keep their INSTALLED badge after restart** (Bug S — leonsk29 GH #43). Pre-v2.4.8 `isModelFullyInstalled` in `src/components/models/DiscoverModels.tsx` only consulted the in-memory `downloads` store, which is empty after a relaunch. A model installed yesterday looked uninstalled today. v2.4.8 also matches against the provider model list (`useModels().models`) for Ollama tags and for HuggingFace GGUF downloads pulled in via `hf.co/<repo>:<quant>` references, so whatever Ollama and LM Studio actually have on disk surfaces correctly. Session downloads remain a fast-path signal that doesn't wait for a `fetchModels()` round-trip.

- **`canPull:false` text models get a clickable HuggingFace link** (Bug T — leonsk29 GH #44). Curated entries that have a HF page but no GGUF on day-one (Qwen 3.6 27B Samantha, GLM 5.1 754B MoE) render with a green "Available" badge instead of a Download button. Before v2.4.8 there was no UI to open the linked HF page. v2.4.8 adds an external-link icon button next to the Available badge for those entries.

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

Still investigating: OpenRouter half of 0yagizz's report (needs F12 console output to repro).

## [2.4.7] - 2026-05-22

Drop-in hotfix on top of v2.4.6. Five bugs: four user-reported (M — Discord nightmare13740; N — GH #40 juliandiggins-stack; O — Discord 0yagizz; P — Discord ake0n_official; R — GH Discussion #6 silentrunningcaUSA) plus internal hardening on the ComfyUI history-output extractor.

### Fixed — benchmark accuracy

- **Benchmark tok/s now excludes time-to-first-token + stream init** (Bug M — nightmare13740 Discord #help-chat, 2026-05-19). Pre-v2.4.7 `useBenchmark.runBenchmark` started the clock at `performance.now()` before opening the chat stream and used the resulting `totalTime` as the denominator for `tokensPerSec`. On any setup with non-trivial first-token latency (warm-up cost, connection init, ollama model load), the benchmark undercounted generation-phase throughput. nightmare13740's RTX 4070 Laptop 8 GB + gemma4:e4b reproduced the issue cleanly: ollama CLI baseline 30 tok/s, manual chat measurement 23–25 tok/s, pre-v2.4.7 benchmark 12 tok/s. v2.4.7 extracts `computeGenerationTps(tokenCount, totalTime, firstTokenTime)` into `src/stores/benchmarkStore.ts` as a pure helper, subtracts TTFT from the denominator, guards against `generationTime <= 0` for degenerate runs (0-token, 1-token, totalTime ≤ firstTokenTime). `useBenchmark.ts:55` now calls the helper; `timeToFirstToken` continues to surface as its own stat in the benchmark UI so users can compare TTFT and steady-state separately. Seven new vitest cases pin the math: nominal extraction, nightmare's exact 12-vs-24 tok/s reconstruction, zero-token guard, zero-generation-time guard, tiny TTFT relative to totalTime, single-token degenerate case.

  Late-shipping pre-release E2E in the actual release build (not vite-dev) found that the TTFT-subtraction formula alone was not enough. The Tauri Rust proxy (`proxy_localhost_stream`) collects bytes before returning, and WebView2 release-mode also aggregates TCP chunks for short responses. The result: for fast small models, all NDJSON lines arrive in JS within a single millisecond — `firstTokenTime ≈ totalTime`, `generationTimeMs ≈ 0`, formula returns numbers like 685,000 tok/s. To make the fix real for release builds, the Ollama provider now extracts the authoritative `eval_count` (tokens) and `eval_duration` (ns) fields from the server's final `done:true` chunk and forwards them via two new optional fields on `ChatStreamChunk` (`evalCount`, `evalDurationMs`). `useBenchmark` prefers these over JS timing whenever they're set: post-fix Ollama benchmark on this host now shows qwen2.5:0.5b at ~245 tok/s (matches Ollama API baseline 241.5) instead of 685,000. For providers that don't return server-side metrics (LM Studio / OpenAI-compat / vLLM / Anthropic), a sanity fallback kicks in: when `generationTimeMs < 100` and no API metrics, the formula falls back to wall-clock rate (`tokens / totalTime * 1000`) so the displayed number stays sane rather than blowing up to six-figure values. LM Studio q4_k_m benchmark on this host shows 85–136 tok/s via this path (vs the previous absurd readouts).

### Fixed — Windows / ComfyUI install

- **`install_comfyui` + `install_custom_node` now probe `git --version` before clone** (Bug N — juliandiggins-stack GH issue #40, 2026-05-18). The existing spawn-error guard catches a flat "git not on PATH" failure, but it can't tell when a WSL / Linux-mounted git binary is first on PATH on a Windows machine — `git --version` succeeds, the clone *starts*, then dies because the Linux binary can't handle Windows-style target paths. The user ends up with a half-cloned ComfyUI directory and no actionable hint. v2.4.7 adds a tri-state `WindowsGitState` probe (Native / NonNative / Missing) in `src-tauri/src/commands/install.rs`. Native (`git version 2.x.x.windows.y` tag) proceeds silently. Missing blocks the install with a clear "install Git for Windows from https://git-scm.com/download/win and restart LU" hint. NonNative (no `.windows` tag — MSYS git, Cygwin git, or a WSL binary mounted into Windows PATH) surfaces a soft warning into the install panel logs but proceeds, since many MSYS/Cygwin gits actually handle Windows paths fine. Eleven new cargo unit tests pin the classification matrix (Git for Windows, WSL git, MSYS git, broken install, empty stdout, garbage stdout, case-insensitive) plus the install-hint copy (must mention `git-scm.com/download/win`, must mention PATH ordering for the WSL case).

### Fixed — Anthropic custom-proxy provider

- **Anthropic provider no longer double-prefixes `/v1` when the user's baseUrl already ends in `/v1`** (Bug O — 0yagizz Discord 2026-05-18). Pre-v2.4.7 the provider unconditionally appended `/v1/messages` to the configured baseUrl. Users pointing the Anthropic provider at a proxy (claude-relay-server, LiteLLM, opencode-zen) sometimes paste a baseUrl with `/v1` already in the path — the proxy operator pinned the API version in their docs — and got back a silent 404 on `https://proxy.example/v1/v1/messages`. v2.4.7 collapses the second `/v1` via a new `messagesUrl()` helper that drops a trailing `/v1` before appending `/messages`. The default `https://api.anthropic.com` shape still produces the canonical `/v1/messages`, and `https://proxy.example/api-v1` (different non-suffix path that happens to contain "v1") still gets the standard `/v1/messages` append. Five new vitest cases cover both proxy shapes, trailing-slash tolerance, the default Anthropic URL, and the defensive non-suffix-`v1` case. OpenRouter half of 0yagizz's original report is still under investigation pending more F12-console context from the reporter — that path lands in v2.4.8 if it turns out to need a code change rather than a config one.

### Fixed — LM Studio model picker

- **Chat model picker now surfaces a "Start LM Studio Server" hint when LM Studio is installed but its server is off** (Bug Q — wakeywakeynow GH #41, 2026-05-19). Symptom: user has LM Studio installed with models on disk, opens LU's model picker, sees only Ollama models, no clue that LM Studio is missing because its server stopped. Root cause is straightforward: LM Studio's HTTP server doesn't auto-start with the app — the user has to run `lms server start` or click Developer → Start Server in the LM Studio UI. With the server off, LU's openai-compat probe gets no models and silently drops the LM Studio backend from the picker. v2.4.4 added the same hint to onboarding, but onboarding only runs once on first launch — returning users hit a stopped server with no visible signal. v2.4.7 wires the existing `lmstudio_server_status` Tauri command into `ModelSelector`'s dropdown and renders an inline banner with a working "Start LM Studio Server" button when `(lms_present || models_detected) && !running`. The button calls the existing `start_lmstudio_server` Tauri command, polls status for up to ~6 s for the server to bind 1234, then triggers a fresh `fetchModels()` so the LM Studio models appear in the dropdown without an LU restart. Live E2E in release build: with LM Studio server stopped, picker shows the banner with the right on-disk model count ("5 models on disk"). Clicking the button starts the server, the banner replaces itself with the LM Studio models, no app restart required.

### Fixed — image / video timeouts

- **Image and video generation timeouts are now user-configurable** (Bug P — ake0n_official Discord #help-chat, 2026-05-19). Pre-v2.4.7 image gens timed out at a hard-coded 20 min and video at 60 min. That was a sane default for desktop NVIDIA hardware but actively painful for the CPU-only / iGPU edge: ake0n_official's 12th-gen Intel Core + Intel UHD Graphics (128 MB allotment) finished sampling step 9 of 25 on a 1024 px Juggernaut-XL run before the 20-minute cap killed the job mid-sampler, with no way to recover the partial work. v2.4.7 adds `imageGenTimeoutMinutes` and `videoGenTimeoutMinutes` to `types/settings.ts` with defaults 20 and 60 (matching pre-v2.4.7 behavior on fresh installs and via the persisted-store migration), reads them in `useCreate.generate()` with a `Math.max(1, …)` clamp to prevent footguns from a 0-min input, and surfaces both as numeric inputs in `SettingsPage`'s new "Image / Video Generation Timeouts" section with an explanatory blurb naming the iGPU / CPU-only use case directly. Users on slow hardware can now bump both caps as needed (range 1–480 min); fast-GPU users see no change.

  Two release-mode polish items found during pre-ship E2E and folded into the same ship: (1) the inputs now use `value={settings.imageGenTimeoutMinutes ?? 20}` (and `?? 60` for video) so existing v2.4.6 users — whose persisted settings store predates these fields — see the defaults rendered as the field value instead of an empty input. Functionally `useCreate.generate()` already fell back to the defaults via `Math.max(1, settings.imageGenTimeoutMinutes || 20)`, so this is a UX-only patch; the saved timeout was always correct, just invisible on the first Settings visit after upgrade. (2) The `onChange` handler now clamps the upper bound too — `Math.min(480, Math.max(1, …))` — matching the HTML `max=480` attribute that was previously only a browser hint. Typing 999 used to persist as 999; v2.4.7 caps it at 480, so users who blindly type a large number to "disable" the timeout cap at the documented range instead.

### Fixed — ComfyUI output extraction

- **Custom save nodes' outputs now surface in LU's gallery** (Bug R — silentrunningcaUSA GH Discussion #6, 2026-05-20). Pre-v2.4.7 `useCreate.ts` only scraped `nodeOutput.images`, `nodeOutput.gifs`, and `nodeOutput.videos` from each entry in ComfyUI's `/history/{promptId}` payload. That worked for the canonical SaveImage / SaveAnimatedWEBP / VHS_VideoCombine nodes, but every community workflow that uses a non-canonical save node — SaveImageWithMetadata posts under `result`, audio save nodes under `audio`, plenty of CivitAI workflows define their own keys — dropped its file on disk in ComfyUI's `output/` folder and never made it into LU's gallery. silentrunningcaUSA's symptom was exactly that: "I can send a generation request to ComfyUI and I can see the output in ComfyUI itself, but the result never comes back to LU." v2.4.7 extracts the extraction logic into a generic helper `extractComfyOutputFiles(nodeOutput)` in `src/api/comfyui.ts` that scans every key on the node output, accepts any array whose entries have a string `filename`, and fills in safe defaults for `subfolder` (`''`) and `type` (`'output'`) so downstream URL construction still works when a custom node omits them. Wired into all three `useCreate.ts` history-poll sites (WebSocket-branch heartbeat poll, WebSocket-branch completion path, polling-only fallback) so the fix applies regardless of which transport ComfyUI is on. Ten new vitest cases pin canonical-keys, custom-keys, audio, multi-key-on-same-node, missing-subfolder-and-type defaults, non-array values (LATENT, metadata, scalars), invalid array entries (missing filename, non-string filename, null), and the empty/null/undefined input guard.

### Tests

- `vitest`: **2306 passed** (previously 2284, +22 across the v2.4.7 bug fixes — +7 benchmark TPS math in `stores/__tests__/benchmarkStore.test.ts`, +5 Anthropic messages-URL in `api/__tests__/provider-anthropic.test.ts`, +10 ComfyUI output extraction in `api/__tests__/comfyui-models.test.ts`).
- `cargo test --release --bins`: **100 passed + 1 ignored** (previously 89, +11 for `WindowsGitState` classification + install-hint copy in `commands/install.rs`).
- `cargo check --release`: clean (pre-existing dead-code warnings only).
- `tsc --noEmit`: clean.

### Deferred to v2.4.8

- **Bug Q** — wakeywakeynow GH #41 ("LM Studio installed but can't choose any models, worked first time, broken today"). Most plausible root cause is the LM Studio server having been stopped between the two runs (LM Studio closes its server when the desktop app is quit). The "no models — start LM Studio server" hint added in v2.4.4 already surfaces this state, so before landing a code change we want the reporter's F12 console output to confirm whether `listModels()` is timing out, returning empty, or failing auth. Carried into v2.4.8's outreach-then-fix queue rather than guessing at a fix that could regress the path that already works for everyone else.

## [2.4.6] - 2026-05-19

Drop-in hotfix on top of v2.4.5. **One bug**: nightmare13740 (Discord 2026-05-18).

### Fixed — chat throughput on tight VRAM cards

- **Dropped hardcoded `num_gpu: 99` override on every Ollama chat request** (Bug L — nightmare13740 Discord #help-chat, 2026-05-18). The override was added in v2.2.1 (commit `ead5673`, april 2026) on the assumption "all desktop users have 16 GB+ cards, Ollama's auto-detect is too conservative, force max GPU offload." That assumption no longer holds with 2026 laptop GPUs (RTX 4070 Laptop ships with 8 GB) and modern model context windows (Gemma 3/4 advertise 128k native context, which materially expands the KV cache footprint). Symptom on nightmare13740's RTX 4070 Laptop 8 GB + gemma3:4b: ollama CLI without `num_gpu` ran at **30 tok/s** with sane VRAM use; LU's chat hit **6.9 tok/s** with VRAM saturated and 4 GB spilled to system RAM. The forced 99-layer offload exhausted VRAM, the KV cache had nowhere to live except system RAM, and every generated token thrashed across the PCIe bus. v2.4.6 removes the override from all five chat sites — `chatStream`, `chatStreamWithTools`, and `chatWithTools` in `src/api/ollama.ts`, `chatStream` and `chatWithTools` in `src/api/providers/ollama-provider.ts`, the Agent-Mode tool-call body in `src/lib/ollama-stream-tools.ts`, and both Remote-Access JS-template paths (`nativeToolChat` and the main agent loop) in `src-tauri/src/commands/remote.rs`. Ollama now applies its own VRAM-aware layer-placement logic on every request, which is a no-op on cards with headroom (Ollama already maxes layer count when VRAM allows) and restores CLI parity on tight cards.

### Tests

- `vitest`: **2284 passed** (93 files, unchanged count). Rewrote one existing assertion in `provider-ollama.test.ts` ("always includes options with num_gpu" → "v2.4.6 Bug L: NEVER sets num_gpu — Ollama decides layer placement itself") and two assertions in `mobile-parity.test.ts` to lock down the absence of `num_gpu` in the request body.
- `cargo test --release`: **89 passed + 1 ignored** — no Rust unit-test changes (the Rust edits were in JS templates that aren't unit-tested at the Rust layer).
- `cargo check --release`: clean (pre-existing dead-code warnings only).

## [2.4.5] - 2026-05-17

Drop-in hotfix on top of v2.4.4. **Fourteen bugs total**: six user-reported (A — Discord/Reddit; B — GH #38; C — GH Discussion #39; D — Discord; E — GH #32 comment; K — Discord #help-coding-agent) plus eight surfaced during the real-tester Arch live verification sweep (F — `install_custom_node` not venv-aware on PEP 668; G — `install_ollama` Windows-only `.exe` download, plus a refix when the original tarball URL stopped resolving; H — `install_lmstudio` Windows-only; I — `install_python` Windows-only winget; J — `start_comfyui` crashes on non-NVIDIA systems without `--cpu` flag).

### Fixed — image / video creation
- **Video output now actually produces `.mp4` files** (Bug A — miguelkodoatie Discord 14.05., Turbulent_Tomato7559 Reddit 10.05.). v2.4.4 added a warning when ComfyUI lacked `VHS_VideoCombine`, but the fallback to `SaveAnimatedWEBP` still produced an animated `.webp` "image" instead of a video. v2.4.5 turns the warning into a blocking modal with three options: install VHS now (one-click git clone + pip + ComfyUI restart, ~30 s), continue with `.webp`, or cancel. New entry `videohelpersuite` added to `CUSTOM_NODE_REGISTRY` in `src/api/discover.ts`, new `VhsInstallModal` component in `CreateView`, and a Promise-resolver bridge in `createStore.vhsInstallPrompt` so `useCreate.generate()` can await the user's choice. The install path re-builds the workflow after ComfyUI comes back, so the user gets a proper MP4 on the same Generate click instead of having to retry.

### Fixed — onboarding / startup
- **"ComfyUI loading..." now surfaces actionable UI after 60 s** (Bug B — dethlux GH #38). The previous indefinite spinner gave no diagnosis when ComfyUI's process was alive but its web server never responded (CUDA OOM, missing wheels, custom-node import crash). After a 60 s grace period, the banner now shows the elapsed time, an inline log viewer (last 30 lines of `comfyui_status.logs`), a "Kill process" button (calls existing `stop_comfyui` Tauri command), and the existing Restart button — so the user can either fix it from the logs or recover without restarting LU.

### Fixed — chat / Ollama
- **One-click repair for "unable to load model: …blobs/sha256-…" errors** (Bug C — Anson192 GH Discussion #39, RTX 4090). Ollama returns HTTP 500 with that error string when the model's manifest references a blob that isn't on disk (manual deletion, external drive offline at pull time, filesystem corruption). v2.4.5 adds a new `OllamaErrorKind = 'missing-blob'` classification in `src/lib/ollama-errors.ts` with a regex matching `unable to load model[:\s].*blobs[\\/]+sha256-[0-9a-f]+`. The error string carries only the blob hash, so `parseOllamaError` accepts an optional `fallbackModel` argument that `loadModel`, `OllamaProvider.chatStream`, and `OllamaProvider.chatWithTools` now pass through. `Header.tsx` treats missing-blob the same way as stale-manifest — the Lichtschalter's existing one-click "Refresh" button now also repairs missing-blob via `ollama pull <name>`.

### Fixed — context window detection
- **Dynamic context-window detection for LM Studio + Ollama** (Bug K — phantomderp Discord #help-coding-agent, 2026-05-04). Pre-fix LU cached an 8k fallback for unknown OpenAI-compatible models and never asked the server what the model actually supports, so the header showed 8k and the settings slider capped there even when the model could do 32k or 128k. `OpenAIProvider.getContextLength` now cascades: (1) `KNOWN_CONTEXT` table (expanded from 9 to 24 entries: gpt-5, o1/o3, deepseek-r1, llama-3.3, Groq + OpenRouter aliases), (2) `probeContextFromServer` for local backends — first the LM Studio Enhanced API `/api/v0/models/<id>` which returns `max_context_length` + `loaded_context_length` directly, then the generic `/v1/models/<id>` returning `context_window` / `max_model_len` / `n_ctx_train` on vLLM, llama.cpp server, others, (3) `guessContextFromName` heuristic for unknown families (llama-3.x → 131072, qwen2.5 → 32768, deepseek-r1 → 64000, etc.), (4) 8k hard fallback only if all three fail. `listModels` enriches contextLength in parallel via `Promise.all` so dropdowns surface real max context immediately. Cloud URLs skip the probe (no N+1, latency cost not warranted). `OllamaProvider.getContextLength` replaces the single `general.context_length` check with the same cascade pattern: tries `model_info["general.context_length"]` first, then any key ending in `.context_length` (Ollama leaves `general.context_length` empty for qwen2.5 and llama3.x and uses architecture-specific keys like `qwen2.context_length`, `llama.context_length`), then `parameters.num_ctx` (object or Modelfile-style string), then 4096 fallback. +13 new vitest cases (7 OpenAI + 4 Ollama + 3 heuristic + 1 fragile-test rewrite). Live verified on Arch + Host with multiple LM Studio + Ollama models.

### Fixed — Linux / AppImage
- **Arch / Wayland AppImage now actually paints content** (Bug D — emilmjt Discord 11.05.). The "empty window" symptom on Arch is Tauri 2 + webkit2gtk-4.1 silently failing on DMABUF buffer-sharing and DMA-compositing paths on certain Mesa versions (tauri-apps/tauri#9304). `src-tauri/src/main.rs` now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` at startup on Linux, falling back to software composite — same workaround the GNOME and KDE maintainers recommend. Only set when the user hasn't already exported the vars themselves. `tauri.conf.json` also now declares explicit `bundle.linux.deb.depends` and `bundle.linux.rpm.depends` for `webkit2gtk-4.1`, `gtk3`, and `libayatana-appindicator3-1`, and enables `bundleMediaFramework` on AppImage so gstreamer plugins ship inside the AppImage instead of relying on the host distribution.

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
- **PEP 668 protected Pythons (Arch, Debian 12+, Fedora 38+, Ubuntu 23.04+) no longer brick the ComfyUI install** (Bug E — rzgrozt GH #32 comment 2026-05-08). A bare `python -m pip install torch ...` exits with `error: externally-managed-environment` on those distros because the stdlib carries an `EXTERNALLY-MANAGED` marker file. v2.4.5 detects the marker via `sysconfig.get_path('stdlib')`, then runs `python -m venv <ComfyUI>/venv` and uses the venv's Python for every subsequent pip step. New helpers `is_pep668_protected`, `create_comfyui_venv`, and `venv_python_path` live in `src-tauri/src/commands/install.rs` and `src-tauri/src/python.rs`. `process.rs::start_comfyui` and `auto_start_comfyui` mirror the lookup so ComfyUI launches with the venv Python it was installed against — no `ModuleNotFoundError: torch` on first run. When the system Python's `venv` module is missing (some minimal Arch installs), the error now surfaces a one-line fix: `sudo pacman -S python-virtualenv` (or `apt install python3-venv` / `dnf install python3-virtualenv`). `diagnose_pip_error` also catches the externally-managed string directly as a fallback for anyone whose Python somehow bypasses the venv path.

### Tests
- `vitest`: **2284 passed** (93 files) — +7 for `parseOllamaError` missing-blob coverage in `src/lib/__tests__/ollama-errors.test.ts` (Anson192 verbatim error, generic no-fallback-model, forward+back-slash tolerance, Rust-proxy wrapping, chat-style message wording with + without model), +1 smoke test for the new `videohelpersuite` `CUSTOM_NODE_REGISTRY` entry, +13 for Bug K context-window detection across `provider-openai.test.ts` (LM Studio Enhanced API probe, generic `/v1/models/<id>` fallback, heuristic cascade, no-probe for cloud, listModels enrichment) and `provider-ollama.test.ts` (architecture-specific key cascade), +1 fragile 401 test rewrite.
- `cargo test --release`: **89 passed + 1 ignored** — +5 for Bug D (webkit env-var workarounds) + 13 for Bug E (PEP 668 detection, venv path layout, diagnose hints) + 9 for Bug I (`linux_python_install_hint` distro matrix: Arch, Manjaro via `ID_LIKE`, Ubuntu, Debian, Fedora, Rocky via quoted `ID_LIKE="rhel centos fedora"`, openSUSE, unknown fallback, empty input) + 2 for Bug J (`needs_cpu_fallback` macOS short-circuit + determinism) + 8 for Bug G refix (`linux_ollama_install_hint` matching the same distro matrix). Bug D + Bug F + Bug H code-paths cross-platform via cfg gates. Bug E has a `#[ignore]`'d live integration test (`pep668_e2e_live_detect_and_create_venv`) driven against real Arch's `/usr/bin/python` during the 2026-05-17 verification.
- `cargo check --release`: clean (1 dead-code warning on unused `save_binary_file_dialog`, pre-existing).
- `tsc --noEmit`: clean.

### Verification — HARDCORE LIVE E2E (Windows 10 + RTX 3060 Ti + ComfyUI 0.12.0 via Computer-Use)
- **Bug A**: Modal "Install MP4 support?" appears on Generate when `VHS_VideoCombine` missing. **Full install path live-verified** end-to-end: git clone of Kosinkadink/ComfyUI-VideoHelperSuite into `custom_nodes/`, pip install (opencv-python + imageio-ffmpeg), ComfyUI stop+start, reconnect-poll, workflow rebuild, actual Wan-video sampling phase started ("Loading text encoder... 2s"). Cancel path also verified (modal closes cleanly, returns to "Ready to generate").
- **Bug B**: Suspended ComfyUI via `NtSuspendProcess` while user navigates back to Create tab → triggers `useEffect` re-mount, `pollStatus` re-starts, detects ComfyUI down. Live-verified entire UI sequence: (1) "ComfyUI loading (12s)" elapsed-counter banner, (2) switch to actionable "ComfyUI is taking unusually long (86s)" panel after 60s threshold, (3) failure-mode explanation text rendered, (4) "View logs" toggle works (button label flips to "Hide logs"), (5) empty-logs fallback message renders ("No startup logs captured yet — ComfyUI hasn't emitted anything to stdout."), (6) "Kill process" button actually kills the spawned ComfyUI process (verified via PID gone + port 8188 free), (7) state machine transitions cleanly to "ComfyUI not responding" with Retry, (8) Retry click respawns ComfyUI which comes back online.
- **Bug C**: Disabled the qwen2.5:0.5b blob (`sha256-c5396e...`) → triggered LU's startup health scan → banner "Ollama 0.20.7 broke 1 of your model. qwen2.5:0.5b" appeared + inline "stale — refresh? ↻ Refresh" chip next to Lichtschalter. Clicked "Refresh all" → `pullModel` triggered → DownloadBadge showed completion within seconds. Note: Ollama 0.20.7 transforms ALL blob errors (missing OR 0-byte corrupted) into the `"X does not support generate"` pattern, so the new `missing-blob` regex primarily protects users on older Ollama versions (Anson192's exact scenario on RTX 4090). Both error paths route to the same one-click repair UX.
- **Bug D**: Linux webkit env-var function unit-tested cross-platform via 5 cargo tests (sets-both-when-unset, preserves user DMABUF override, preserves user COMPOSITING override, preserves empty-string as explicit unset, idempotent). **LIVE-VERIFIED on REAL Arch Linux + Wayland 2026-05-17**: installed Arch (kernel 7.0.8) in a VirtualBox VM, booted into a headless `sway` session (WLR_BACKENDS=headless, WLR_RENDERER=pixman, WLR_HEADLESS_OUTPUTS=1), built the LU release binary on the guest (`cargo build --release`, 7m 01s), and ran it twice: (a) defaults — `apply_linux_webkit_workarounds()` auto-sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` + `WEBKIT_DISABLE_COMPOSITING_MODE=1`, LU survives + window opens; (b) user override — `WEBKIT_DISABLE_DMABUF_RENDERER=0 WEBKIT_DISABLE_COMPOSITING_MODE=0`, fix respects the override (still works on this particular Mesa setup, would crash on emilmjt-style broken DMABUF stacks). `grim` screenshots captured the actual LU onboarding screen ("Locally Uncensored", "Private, local AI chat. No servers, no tracking, everything stays on your machine.", "Get Started" button, 5-dot pagination) at 1280x800, **742 unique pixel colors** — definitive proof the window is no longer an empty black rectangle. Screenshots at `LU-E2E-Test-Kit/scripts/arch_live_e2e_screenshots/bugd-scenario1-fix-active.png` + `…-bypassed.png`.
- **Bug E**: PEP 668 detection + venv creation unit-tested cross-platform via 13 cargo tests across `install.rs::tests` and `python.rs::tests`. Path-layout tests cover both Windows (`venv/Scripts/python.exe`) and Unix (`venv/bin/python`) layouts. Resolver tests use real tempdirs to verify the `Some(path)` vs `None` gating. Diagnose tests cover Arch's exact `error: externally-managed-environment` string from rzgrozt's report plus the shorter `error: externally-managed` variant and confirm the suggested distro-install commands (`pacman -S python-virtualenv`, `apt install python3-venv`, `dnf install python3-virtualenv`) appear in the user-facing hint. **Plus a HARDCORE LIVE E2E test (`pep668_e2e_live_detect_and_create_venv`, `#[ignore]`'d so it runs on demand) drives the full flow against a real Python install whose stdlib has a real `EXTERNALLY-MANAGED` marker file. The test verifies: (1) `is_pep668_protected` returns true against the marker-planted Python, (2) `create_comfyui_venv` succeeds and produces the venv-Python at `<ComfyUI>/venv/{Scripts|bin}/python(.exe)`, (3) the nested venv's pip runs without inheriting the PEP 668 block (the whole point of the fix), (4) a second `create_comfyui_venv` call is idempotent. Setup + run scripted in `LU-E2E-Test-Kit/scripts/pep668_live_test.ps1`: robocopies the system Python to a writable temp dir, plants the marker in the copy's stdlib (NOT the real system Python — that would wedge every pip on the box), runs cargo with `LU_PEP668_TEST_PYTHON` set, cleans up. Result: all 4 phases passed against Python 3.11.7 + planted marker on 2026-05-17.** **AND — on top of the Windows simulation — Bug E was ALSO live-verified against a REAL Arch Linux ISO booted in a VirtualBox VM on 2026-05-17. The Arch live ISO ships Python 3.14.4 with the actual `/usr/lib/python3.14/EXTERNALLY-MANAGED` marker (multiline Arch text mentioning `pacman -S python-xyz`, identical to what rzgrozt's installer saw). Seven assertions all passed against this real environment: detection logic returns `YES`, `python -m venv` succeeds, venv Python lands at `/tmp/foo/venv/bin/python` (matching the Unix branch of `venv_python_path`), pip inside the venv is unblocked (downloads requests metadata without `externally-managed` error), idempotency holds, and the Rust-side equivalence of the shell probe matches verbatim. See `LU-E2E-Test-Kit/scripts/arch_live_e2e.md` for the full transcript. This live test also uncovered Bug F (separate fix above).**

## [2.4.4] - 2026-05-11

Hotfix sweep covering the v2.4.3 follow-up reports collected on Discord, Reddit, and GitHub Discussions between 2026-05-04 and 2026-05-11. Eight fixes total — six tied to specific Discord/Reddit reporters, one Reddit issue, and one GitHub Discussion (vokurta — RTX 6000 Blackwell, posted the same morning this sweep landed).

### Fixed — onboarding (LM Studio + ComfyUI)
- **LM Studio system-wide install path now detected** (Bug #2 — techx69, Discord 06.05.). `lmstudio_lms_path()` previously only looked under `~/.lmstudio/bin/`, `%LOCALAPPDATA%\Programs\LM Studio\` and `where lms`, so a "for all users" install in `C:\Program Files\LM Studio\` came back as `lms_present: false`. New lookup walks `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, `%PROGRAMW6432%`, plus a Windows registry sweep of `Uninstall\…\InstallLocation` for any subkey whose DisplayName starts with "LM Studio". (`winreg = "0.55"` added to `[target.'cfg(windows)'.dependencies]`.)
- **LM Studio models-on-disk soft-detect.** `lmstudio_server_status` now returns `models_detected` + `model_count` from a bounded walk of `~/.lmstudio/models/` for GGUF files. The onboarding "No local backend detected" branch now flips into the "LM Studio detected" CTA whenever either `lms_present && !running` OR `models_detected && !running` is true — so users with GGUFs but no resolved `lms.exe` (techx69's exact shape) get "LM Studio is installed (N models detected) but its server isn't currently running" instead of being pushed into a 570 MB re-install.
- **Multi-ComfyUI disambiguation in the onboarding ComfyUI step** (Bug #3 — ninjastic2008, Discord 05.05.). New Tauri command `detect_all_comfyui_installs` returns a `Vec<ComfyUIInstall>` with `{ path, complete, has_embedded_python, source }`. The onboarding effect now calls it first; when more than one match exists, the user picks explicitly via a clickable list (each row shows "ready / needs setup" + "found via …" + a "bundles python_embeded" badge). The chosen path is persisted via the existing `set_comfyui_path` command so `start_comfyui` hits it. Single-hit and zero-hit cases keep the previous auto-pick / install-fresh flow.
- **ComfyUI install: Cancel button + disk-pressure pre-flight + ETA** (Bug #1 — techx69, Discord 06.05.). The 45-minute hang case on a 100%-busy drive used to leave the user with no way out. New Tauri command `cancel_comfyui_install` flips a `Arc<AtomicBool>` in `AppState.comfyui_install_cancel`; the install thread polls it between every step and inside the pip retry loop, kills the active git or pip child on cancel, and lands the status in `"cancelled"` so the polling UI clears. Pre-flight uses `sysinfo::Disks` to detect <5 GB free on the target drive and pushes a `⚠`-prefixed warning into the install logs (rendered as a yellow band above the live log card). Progress card now shows a rolling ETA (`download_total - download_progress` / `download_speed`) next to the elapsed timer.
- **PyTorch wheel routing now respects GPU compute capability** (Bug #10 — vokurta, GitHub Discussion #37, 11.05.). `install_comfyui` probes `nvidia-smi --query-gpu=compute_cap` and picks `https://download.pytorch.org/whl/cu128` when any visible GPU reports SM ≥ 12.0 (Blackwell — RTX 50xx, RTX 6000 Pro), `cu121` otherwise. The probe is best-effort; failure falls back to cu121 so existing Ampere/Hopper installs don't regress. Fixes `CUDA error: no kernel image is available for execution on the device` at `CLIPTextEncode` on Blackwell silicon.

### Fixed — chat surface
- **TokenCounter now reflects the Settings `maxTokens` override live** (Bug #4 — phantomderp, Discord 05.05.). The component used to read `getModelMaxTokens(activeModel)` once per model switch and ignore subsequent settings changes, so a slider move from default → 16384 stayed pinned to the model's manifest value (e.g. 8.2k). It now subscribes to `useSettingsStore` so Zustand re-renders on every settings update; the effective ceiling is `settings.maxTokens > 0 ? settings.maxTokens : modelMax`, and the tooltip surfaces both when the user is overriding.
- **DownloadBadge X-button actually cancels the Rust pull stream** (Bug #5 — phantomderp, Discord 05.05.). `modelStore.dismissPull` used to just delete the entry from `activePulls` — Rust's `pull_model_stream` kept emitting `pull-progress` events and the badge respawned within 100 ms while the disk kept writing. The action now aborts the entry's `AbortController` (which fires the existing `cancel` handler installed by `useModels.pullModel`) AND best-effort invokes `cancel_model_pull` directly. Five new unit tests in `src/stores/__tests__/modelStore-dismiss.test.ts` cover abort propagation, Rust invocation, synchronous state removal, the no-op-when-not-present case, and the late-progress-event guard.
- **Agent-Mode hint when a model tries to call tools without the toggle on** (Bug #7 — phantomderp, Discord 04.05.). `MessageBubble` now runs `extractToolCallsFromContent` on every assistant message; when a call is detected, the conversation is in normal (non-agent) mode, AND the active model passes `isAgentCompatible`, an amber banner renders below the message: "This model tried to call a tool, but Agent Mode is off for this chat. Turn it on …" with a one-click Enable Agent button. Previously the user saw the raw JSON dump rendered as Markdown and assumed the model was broken.

### Fixed — image / video creation
- **Workflow-architecture mismatch surfaces a clear install path** (Bug #6 — vvvxxxvvv_80435 Discord 04.05., Turbulent_Tomato7559 Reddit 10.05.). When the active ComfyUI lacks the wrapper nodes for the chosen video model (CogVideoX → `CogVideoXSampler`, FramePack → `FramePackSampler`, Pyramid Flow → `PyramidFlowSampler`, Allegro → community wrapper), `determineStrategy` now returns an `installHint: { pack, url }` alongside the error. The dynamic builder throws a typed `WorkflowUnavailableError` instead of a generic `Error`. `useCreate` recognises that subclass and surfaces the message + install-guide path instead of falling through to the legacy builder (which hits the same `UNETLoader` trap). New helper `checkVideoOutputCapability` lets the Create flow surface a yellow "output will be animated .webp" heads-up when `VHS_VideoCombine` is missing — same root cause as Turbulent_Tomato7559's Reddit report ("videos generate as .webp").

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
- **Remote Access in `npm run dev` now surfaces a clear actionable message instead of a cryptic 404 + JSON.parse stacktrace** — reported on Discord in `#bug-reports` by @phantomderp on v2.4.2: clicking the LAN button printed `POST http://localhost:5173/local-api/start-remote-server [HTTP/1.1 404 Not Found]` and clicking Internet showed an `Error: HTTP 404` toast plus `Uncaught (in promise) SyntaxError: JSON.parse: unexpected character at line 1 column 1 of the JSON data`. Root cause: Remote Access is a Tauri-only feature (a Rust axum server, JWT auth, Cloudflare tunnel binary management, mobile-UI static serve — ~3700 lines in `src-tauri/src/commands/remote.rs`). When v2.4.2 added the corresponding `/local-api/*` paths to `src/api/backend.ts`'s endpoint map, no matching middleware was added to `vite.config.ts`, so dev-mode clicks fell through to vite's default 404 HTML page, which the frontend then tried to JSON.parse. End-user impact: zero — the installed `.exe` routes through Tauri's `invoke()` and works as designed. Developer impact: a confusing dead-end when iterating on the UI from `npm run dev`. Mirroring the entire feature in Node middleware would be a maintenance trap, so we keep dev lean and instead: (1) `Sidebar.handleDispatch` and the `remoteStore.startServer` / `restart` / `startTunnel` actions all check `isTauri()` first and short-circuit with `REMOTE_DEV_MODE_ERROR` — a single source-of-truth string that points at `npm run tauri:dev` (Tauri-aware dev mode where Remote works fully) or the installed app; (2) all 12 Remote-related vite middlewares are stubbed to return `HTTP 501 + { error, devModeOnly: true }` as a backstop in case any future caller bypasses the store guards.

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
- **Carrying forward into next sweep:** AMD video-generation "could not detect model type" + empty-output reports on Threadripper / RX 7900 XTX (vvvxxxvvv on Discord). Internet-Remote feature-request to support `npm run dev`. Beads memory-plugin design (Discussion #34).

## [2.4.2] - 2026-04-26

### Fixed
- **Updates tab no longer shows a stale "Latest Version" after a manual binary upgrade** — reported on Discord by @diimmortalis: "I tried and failed to auto-update from the .deb package in i think 2.3.7, and now the updates tab says `Current Version: 2.4.1 | Latest Version: 2.3.8`." Root cause: zustand's `persist` middleware partializes `latestVersion` into localStorage, so when a user updates the binary out-of-band the persisted "latest" snapshot survives even though it's now older than what they're running. `checkForUpdate()` has a 6h cooldown, so the stale value lingers for hours. Fix: added `onRehydrateStorage` to `updateStore` that compares persisted `latestVersion` against `currentVersion` via the existing `isNewerVersion` helper and resets `latestVersion = null, updateAvailable = false, releaseNotes = null, lastChecked = null` when the persisted snapshot isn't strictly newer. Plus a UI hardening pass in `SettingsPage`'s `UpdateSection`: the "Latest Version" row now only renders when the persisted value really is newer than current, so even a missed rehydration can't display the inversion.
- **Agent toggle now correctly enables for uncensored / abliterated variants of agent-capable bases** — reported by @diimmortalis on Discord with `LEONW24/Qwen3.5-9B-Uncensored:Q4_K_M`. The previous `isAgentCompatible` carried a deliberately narrow allow-list for abliterated/uncensored model names (`['qwen3-coder', 'hermes3', 'hermes-3', 'hermes']`) that over-rejected popular Qwen 3.x, Llama 3.x, Gemma 4, Mistral, and Qwen 2.5 abliterations even though those families retain native tool-calling weights through abliteration. Fix: the abliterated/uncensored branch now strips the `-abliterated` / `-uncensored` / `-instruct` / `-chat` / `:tag` suffixes and checks the remaining base name against the same canonical `AGENT_COMPATIBLE` list as the vanilla path. Three regression tests added in `model-compatibility.test.ts` covering the diimmortalis case + `mannix/llama3.1-8b-abliterated` + `huihui_ai/qwen2.5-abliterated`.
- **CivitAI model search now uses the API key from the Workflow finder + shows a clear empty-state hint** — reported by @diimmortalis: "CivitAI model search doesn't seem to work — i think it's because the api-key was only accepted for the Workflow finder under the Create Tab, but i'm not finding any errors in the console or network tab, just says it's getting back an empty model list." Fix: `searchCivitaiModels(query, type, apiKey?)` in `discover.ts` now appends `&token=<apiKey>` when set and adds `nsfw=true` to surface adult content (matching LU's positioning). The DiscoverModels CivitAI panel reads the same key the Workflow finder writes via `workflowStore.civitaiApiKey`. New `civitaiSearched` state distinguishes "before-first-search" from "search-returned-zero" and renders an empty-state hint — `No matches for "<query>". Try a broader query, or add your CivitAI API key in the Workflow finder for the full catalog.` — instead of leaving the user staring at a silent empty list.
- **Import Workflow now shows a visible success confirmation** — reported by @diimmortalis: "doesn't seem to persist manually entered json, and doesn't document where the file would be stored. There's no feedback or console output when clicking the 'Import' button." The import was actually persisting fine, but the UI cleared the inputs on success and emitted zero feedback, so the click looked like a no-op. Fix: added `importSuccess` state to `WorkflowSearchModal` and an emerald-green confirmation row that reads `Imported "<name>" and assigned to <modelName>.` after a successful URL or JSON paste; auto-clears after 4s.
- **Newly downloaded ComfyUI models surface in the dropdown more reliably** — reported on GitHub Discussion #22 by @Draekzy and @cprovencher-beep. Two timing-related races were stacking: (1) `refreshComfyModels` was single-shot and silently returned `false` if ComfyUI was mid-startup or busy, leaving the cache stale; (2) the `comfyui-model-downloaded` event handler in `useCreate` called `fetchModels()` exactly once, so if ComfyUI's directory scan took longer than the `/api/refresh` round-trip the immediate fetch saw the pre-scan list. Fix: `refreshComfyModels(maxAttempts = 3)` retries with 1s + 2s backoff on transient failure, and the post-download handler now schedules `fetchModels()` immediately + at +2s + at +6s with proper timer cleanup on unmount. Live-traced in DevTools: a single dispatched event now produces 8 `/api/refresh` calls inside 8s, where pre-fix it produced 1. Doesn't address adjacent root causes like file-permission issues (running ComfyUI as admin to access models) or a misconfigured `Settings → ComfyUI → Path` — those are separate problems.

### Carrying forward from master (commit 9eb1329)
- **Remote Access "Server stopped — restart does nothing" silent-failure path is fixed** — reported on issue #29 by @phantomderp13. Internet remote rethrows on failure instead of swallowing the error, orphan tunnels are cleaned up, and the inline error surfaces in the UI.
- **Anti-Virus false-positive groundwork** — reported on issue #33 by @spiritwarri0r. Bundle metadata + signed installer carry forward; v2.4.1 already addressed most ESET / Avast hits.

### Docs
- **Blog correction: SillyTavern image generation** — reported by @diimmortalis. The "Best local AI apps 2026" comparison and the "Locally Uncensored vs SillyTavern" deep-dive both incorrectly listed SillyTavern as having no image generation support. SillyTavern does support image generation through its Stable Diffusion / ComfyUI extension; the table cell + descriptive text now reflect that, while keeping the built-in vs extension distinction honest.

### Tests
- Test suite 2244 → 2246 (+2 regression assertions in `updateStore.test.ts` pinning the diimmortalis 2.3.8/2.4.1 inversion case).
- 3 inverted assertions in `model-compatibility.test.ts` flipped to match the new unified abliterated handling — the previous "abliterated NOT compatible" expectations were encoding the bug, not desired behavior.

### Verification
- `vitest`: 2246 / 2246 green
- `cargo test`: 44 / 44 green
- Built v2.4.2 installer + silent-installed over the prior v2.4.1 binary on a real Windows machine, then reproduced each bug's mechanism in the running app:
  - B1: seeded `latestVersion: '2.3.8'` into localStorage + reloaded — Settings → Updates correctly shows `Current Version: v2.4.2` + "You are on the latest version", no stale row.
  - B2: 7-case assertion table run in DevTools console — diimmortalis's exact model + 3 other abliterated bases all return true, plus 3 negative cases (embedding model + unknown-base abliteration) correctly stay false.
  - B3: searching "flux" in CivitAI panel renders the empty-state hint as designed.
  - B4: pasted ComfyUI JSON twice with different names → both workflows persisted + assigned, visible in the WORKFLOW dropdown.
  - B5: instrumented `window.fetch`, dispatched the download-completed event once, traced 8 `/api/refresh` calls within 8s spanning the immediate / +2s / +6s × 3-attempt-retry pattern.

### Notes
- Drop-in upgrade from v2.4.1. No breaking changes, no localStorage migration. Auto-update prompts on next launch. Existing users roll over automatically.
- We don't claim 100% reliability for any of these — if the symptoms still show up after updating, please drop a note in the matching issue / discussion / Discord thread. We'd rather hear about it.

## [2.4.1] - 2026-04-24

### Fixed
- **CreateTopControls: picker dropdown hardened against any non-array list value** — reported on Discord by @phantomderp on the `#bug-reports` channel: "the web ui crashes when clicking on the model list at the top in the create tab". His workaround was to patch `activeList?.map(...)` in the source, which stopped the crash but "the list doesn't work anymore" because the `.length` branch above still evaluates on undefined. We already did the straightforward fix in v2.3.9 / v2.4.0 (added `imageModelList` / `videoModelList` to `createStore` as runtime-only state, populated by `useCreate.fetchModels`), but there's still a pathological path where the field arrives as something other than an array: stale persisted state from a very old install, Zustand rehydration racing the first render of `CreateTopControls`, a corrupted localStorage entry from an external tool, or simply an old .exe that predates aa31bab. The read site now passes the list through `Array.isArray(rawList) ? rawList : []`, so undefined / null / object / string / number / anything weird all render as the empty-state card instead of taking the app down.

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
- **Linux window can be dragged again** — on Ubuntu 24.04 the title-bar drag threw `Unhandled Promise Rejection: window.start_dragging not allowed. Permissions associated with this command: core:window:allow-start-dragging` and left the window anchored in place (keyboard tiling still worked, so nobody noticed on tile-first setups). Reported on Discord by @diimmortalis. Added `core:window:allow-start-dragging` to `src-tauri/capabilities/default.json`.
- **"Re-run onboarding" actually reruns onboarding now** — first cut of the button deleted the marker file + flipped `settings.onboardingDone` + reloaded, but `AppShell.tsx`'s mount-time "migration" block saw the missing marker and happily wrote it back, dropping the user straight into the main app instead of the wizard. The migration is now gated on `settings.onboardingDone === true` so it only fires for legitimate NSIS-update-after-onboarding scenarios, not for the intentionally-missing marker of a Re-run click. Caught during E2E of the 2.4.0 RC. Regression test in `AppShell-backup-triad.test.ts`.
- **HuggingFace search filename heuristic no longer doubles quant suffixes** — typing "tinyllama Q4" into Model Manager → Discover → Text → (search) returned repos like `hieupt/TinyLlama-1.1B-Chat-v1.0-Q4_K_M-GGUF`, and the client then guessed the inner filename as `TinyLlama-1.1B-Chat-v1.0-Q4_K_M-Q4_K_M.gguf` — doubled tag, guaranteed 404 when you clicked download. Extracted the guess into `deriveQ4FilenameFromRepo()`, added a case-insensitive quant-suffix detector (`Q[0-9]+_K_[MSL]`, `Q[0-9]_[0-9]+`, `IQ[0-9]_[A-Z]+`, `UD-Q/-IQ`, `BF16/FP16/F16/F32`). If the suffix is already in the repo name, the `.gguf` is appended directly; otherwise `-Q4_K_M.gguf` stays as before. Full E2E with a curated model (Gemma 4 E4B @ 4.6 GB) confirmed the Model Storage override path is honored — bytes land in the picked folder, LM Studio's default folder is not touched. 9 new regression tests in `discover-hf-filename.test.ts`.

### Added
- **Settings → Privacy section** — explicit in-app statement of what the app does and doesn't do with your data. Until 2.3.9 this only existed in the README, which meant if you couldn't be bothered to open GitHub you were taking the claim on faith. Now Settings lists: 100% local by default, no telemetry/analytics, only network calls are the GitHub updater and cloud-provider APIs you configure yourself; + where your data lives on disk (`%APPDATA%/Locally Uncensored`).
- **Settings → Onboarding → "Re-run onboarding" button** — once you'd clicked through the first-launch wizard it was gone forever unless you hit "Reset to Defaults" (which wipes every other preference). Now Settings has a dedicated "Onboarding" section with a button that clears the `onboarding_done` marker on disk + resets the in-app flag + reloads. Useful when you want to redo the hardware scan, show the app to a friend, or just re-read the agent-mode tour. The `set_onboarding_done` Rust command now accepts `Option<bool>` so callers can also clear the marker, not only set it.
- **Settings → Model Storage: configurable HuggingFace GGUF download path** — requested in Discord by @diimmortalis (dual-boot Ubuntu user wanting the HF downloads on a shared partition instead of `/home/$USER/locally-uncensored/models`). New `hfDownloadPathOverride` in settings — leave empty to keep the previous auto-detect-from-provider behaviour, or pick a folder via the native picker. `DiscoverModels.tsx` now prefers the override over the auto-detected LM-Studio path. Takes effect immediately without restart.
- **CONTRIBUTING.md — ComfyUI CORS note for contributors bringing their own instance** — LU's auto-started ComfyUI already passes `--enable-cors-header "*"`, but contributors who point `npm run tauri:dev` at their own long-running ComfyUI see a `403` + `request with non matching host and origin localhost:8188 != localhost:5173` warning. Flagged on Discord by @diimmortalis after they self-diagnosed + self-fixed. Docs now spell out the workaround.

### Changed
- Test suite 2205 → 2216 (+11 regression tests: `resetTutorial` flips `tutorialCompleted` back to `false`, AppShell onboarding-marker migration is gated on `onboardingDone`, 9 cases for `deriveQ4FilenameFromRepo` covering Q-tag / IQ-tag / UD- / BF16 / lowercase / mid-string / no-GGUF variants).
- Bumped `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 2.3.9 → 2.4.0 in lockstep.

### Notes
- Drop-in upgrade from v2.3.9. No breaking changes. No localStorage migration. `hfDownloadPathOverride` defaults to empty, which preserves pre-2.4.0 behaviour (auto-detect from the active openai-compat provider).
- Version train: 2.4.0 is a polish release consolidating the 6 non-blocker findings from the internal Ultra E2E sweep + the 2 bug + 1 feature request from Discord community feedback over the 2.3.x cycle. No new headline features — the next headline bump is planned for 2.5.0 (see project roadmap).

## [2.3.9] - 2026-04-23

### Fixed
- **Create view no longer takes down the whole app when no image or video model is installed** — reported on Discord by @figuringitallout on a fresh Windows install. Observable symptom: open Create with an empty ComfyUI `models/` tree, app unresponsive → hard shutdown → a "duplicate" LU process opens. Two layered root causes, both fixed:
  - (1) `classifyModel()` in `src/api/comfyui.ts` used to happily dereference `name.toLowerCase()` without checking `name` first; a stale persisted model string (from a previous install that got deleted) was carried into every Create render path and bubbled through `useCreate.generate`, `ParamPanel`, and the dynamic-workflow builder. Now `classifyModel(name: string | null | undefined)` returns `'unknown'` when `!name`.
  - (2) `src/hooks/useCreate.ts:fetchModels` only cleared the persisted image/video model names when ComfyUI returned a non-empty list. With 0 models, the stale strings stayed alive forever. Now fetchModels explicitly `state.setImageModel('', 'unknown')` + `state.setVideoModel('')` when the corresponding list is empty after the startup-race retries expire.
  - (3) `src/components/create/CreateView.tsx` renders a dedicated empty-state card when `connected === true && modelsLoaded && currentModeModels.length === 0`. The card shows `PackageOpen` icon + "No {image|video} models installed" + a **Go to Model Manager** primary button (calls `useUIStore.getState().setView('models')`) + a **Refresh list** secondary action (calls `fetchModels()`). `OutputDisplay` / `PromptInput` / `ParamPanel` / I2V + I2I uploads / preflight banners all suppress during the empty state so no downstream code can hit the old crash path. The Mode switcher (Image / Video) stays so the user can switch sides and get a matching empty-state.

- **CreateTopControls no longer crashes the Create header toggle + dropdown** — the header-level model picker + ComfyUI Lichtschalter lives at `src/components/create/CreateTopControls.tsx` and used to destructure four fields (`imageModelList`, `videoModelList`, `comfyRunning`, `setComfyRunning`) from `useCreateStore()` that were never added to the store. Clicking the dropdown threw `TypeError: can't access property "length", activeList is undefined`; clicking the Lichtschalter during starting/stopping threw `setComfyRunning is not a function`. Reported on Discord by @diimmortalis (with a precise console-log dump, bless them — Ubuntu 24.04 + `npm run dev`). Fix: the four missing fields are now part of `createStore` as runtime-only (not persisted) state; `useCreate.fetchModels` + `useCreate.checkConnection` mirror their values into the store so the header control always has a live list + the right toggle state.
- **Backend Selector modal no longer spams on repeat** — users with multiple local backends (Ollama + LM Studio, Ollama + vLLM, etc) reported on Discord that the "N local backends detected" modal kept re-appearing every 5-10 seconds, regardless of whether they clicked Skip or Use selected. The pre-existing `sessionStorage` guard wasn't enough in the face of WebView2 reloads (which the backup-restore triad can trigger) or cache evictions. Fix: (1) added a persistent `hideBackendSelector` flag in `providerStore` so the user's opt-out survives reloads; (2) the modal now has a pre-checked "Don't show this again" tickbox; (3) a permanent explanatory line "You can add, remove, or switch backends anytime in **Settings → Providers**" (with the link clickable — it navigates you there); (4) dismissing the modal with the tickbox checked persists the opt-out. Users who want the modal back at some point can uncheck the box before dismissing.
- **LU always starts in the Chat sidebar tab, not Code** — on a fresh install or an NSIS update, the left-sidebar tab (Chat / Code / Remote) could land on Code because `codexStore`'s persist middleware saved `chatMode` between sessions. Newcomers clicking around Code without any conversations got an empty screen. `codexStore` now excludes `chatMode` from `partialize` so the default (`'lu'`) is used on every fresh boot. If a user wants to stay in Codex or Claude Code mid-session, they pick it from the sidebar each time; `workingDirectory` still persists so Codex remembers the last project path.
- Tiny grammar fix in the Create empty-state copy: "Install **an image** model" / "Install **a video** model" (was "Install a image model" in both branches).

### Added
- **CONTRIBUTING.md — Dev Setup now documents all three local dev workflows** (`npm run tauri:dev` for hot-reload with Rust rebuilds, `npm run dev` for browser-only UI work, `npm run tauri:build` for a full NSIS installer). Reported in Discord by @k-wilkinson (sourceodin) as a missing-docs ask. Clarifies that Tauri invokes only resolve under `tauri:dev`.

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
- **llama3.2:1b** — plumbing correct; the 1B model hallucinated a Unix-style `/Users/ddrob/Desktop/tiny.py` path that landed at `C:/Users/ddrob/Desktop/tiny.py` on Windows instead of in the workdir. Model-quality artefact, not a Codex bug. Documented for users on the smallest class of models.

### Changed
- Test suite 2202 → 2202 (full regression) after `tool-call-repair` gained `extractToolCallsWithRanges` + `stripRanges` + `findBalancedBraceEnd` + `findPrecedingOpenBrace`.

### Notes
- Drop-in upgrade from v2.3.7. No breaking changes. No localStorage migration. Existing Codex chats continue to work; new chats benefit from the per-chat workspace isolation now that `chatId` threads through.

## [2.3.7] - 2026-04-22

### Added
- **Configurable Ollama endpoint (remote Ollama + `OLLAMA_HOST` env var support)** — GitHub Issue #31 by @k-wilkinson. The pre-2.3.7 app hardcoded `http://localhost:11434` in four places (the frontend `ollamaUrl()` helper used by every `/tags`/`/chat`/`/show`/`/pull`/`/generate` call, the Vite dev-proxy target, the Ollama provider's dev-mode `apiUrl()`, and the Rust `pull_model_stream` URL), so setting `OLLAMA_HOST=0.0.0.0:11434`, `192.168.1.x:11434` or any non-default port was silently ignored — the app reported "No local backend detected", model dropdowns stayed empty, Settings → Providers → Ollama → Endpoint field had zero effect, and the Test button always said Failed even when `curl` against the configured endpoint returned data. Now all four layers flow from a single `ollama_base` field that reads, in priority order, the persisted GUI value from `%APPDATA%/locally-uncensored/config.json`, the `OLLAMA_HOST` env var at startup (same semantics as Ollama itself), then the default. Accepts bare `host:port`, scheme-less host, or full URL. The Vite dev-proxy target is computed from `OLLAMA_HOST` at server startup so `OLLAMA_HOST=… npm run dev` also just works. The Rust SSRF allow-list in `proxy_localhost` was widened to accept the configured Ollama + ComfyUI hosts (everything else still blocked). 19 regression tests in `backend-urls.test.ts`.

### Fixed
- **`pull_model_stream` Rust command was hardcoded to `http://localhost:11434/api/pull`** — same root cause as Issue #31 but in a second place. Model-pull downloads ignored any user-configured Ollama endpoint. Now reads from `state.ollama_base`.

### Changed
- Test suite 2183 → 2202 green.

### Notes
- Drop-in upgrade from v2.3.6. The default endpoint is still `http://localhost:11434` — existing users see zero behavior change. If you have `OLLAMA_HOST` in your environment (Docker, LAN, homelab) it's now honored; if you've edited Settings → Providers → Ollama → Endpoint that value now actually flows through the app.

## [2.3.6] - 2026-04-21

### Added
- **Configurable ComfyUI host (remote ComfyUI support)** — Settings → ComfyUI → Host. Previously only the port was configurable; the host was hardcoded `localhost`, which meant users running ComfyUI in Docker, on a LAN machine, or on a headless homelab server couldn't point LU at it. The Host field accepts any hostname or IP. When the host resolves to the local machine (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) the Start/Stop/Restart/Install/Path controls stay visible; when it's remote LU hides those controls and shows an amber hint that you manage the Python process on the server yourself. Requested in GitHub Discussion #1 by @ShoaibSajid (desktop LU + Ollama on server-1 + ComfyUI on server-1 docker). The mobile Remote proxy also honors the new host so mobile-dispatched ComfyUI calls reach the configured backend. 17 regression tests in `backend-urls.test.ts`.

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
