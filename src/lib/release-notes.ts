/**
 * What is new in this version, shown once after an update (B4, David 2026-08-04).
 *
 * New models land weekly and the catalogue is server-driven, so a shipped build
 * gains capability without anyone noticing. This is the one place that tells the
 * user what changed, once per version, and then never again.
 *
 * The rule that keeps it honest: a version with NO entry here shows NO popup.
 * An empty sheet is worse than no sheet, and a release whose notes nobody wrote
 * should simply stay quiet rather than greet the user with a headline and
 * nothing under it.
 *
 * `lines` is the short read on the sheet. `details` sits behind the Show all
 * changes expander, grouped into sections (Local, Cloud), and may be long.
 */

export interface ReleaseNoteSection {
  title: string
  items: string[]
}

export interface ReleaseNote {
  /** Exact version string, matched against package.json. */
  version: string
  /** One line the user reads first. */
  headline: string
  /** Two to five short lines. Anything longer goes into `details`. */
  lines: string[]
  /** The full list behind the expander, grouped into sections. */
  details?: ReleaseNoteSection[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '2.6.8',
    headline: 'Compact mode, background agents, and an effort control for reasoning models',
    lines: [
      'Compact mode: type /compact and the older part of a long conversation is folded into a summary the chat model writes itself, so the chat keeps going instead of running out of room. Auto-compact stays off until you switch it on under Settings.',
      'Background agents in Agent and Code mode: the agent hands a self-contained task to a sub-agent that works while you carry on, a panel on the right shows what is running, and the main agent picks the result up on its own. Cloud and local models alike.',
      'Reasoning models have an effort control next to the Think button: Low, Medium or High, and Max on GLM 5.3. The setting decides how many tokens a reply may spend on thinking.',
      'A Local API: one OpenAI-compatible address on your machine for every local model, with the LU Engine, Ollama and LM Studio behind it, a token in front of it, and off until you start it under Settings.',
      'The built-in engine goes by LU Engine now, moves to a free port when 8127 is taken, and a downloaded chat model stays Installed with a Use button. GLM 5.3 (Pro) and GLM 5.3 Flash (Hosted) are in the cloud catalogue, Document Chat works in Cloud mode, and the full list below covers AMD, ComfyUI, Model Storage and the Linux packages.',
    ],
    details: [
      {
        title: 'Chat, Agent and Code',
        items: [
          'Compact mode. /compact folds the older turns of a conversation into a summary and keeps the recent ones as they are; a few words after the command say what the summary should focus on. The chat model writes the summary itself, in the language of the conversation, and it is told never to translate, round or reformat a value. A block in the transcript shows how many messages were summarised and how many tokens every following request saves, the full conversation stays on disk, and a second compaction keeps the first one instead of dropping the start of the chat.',
          'Auto-compact is opt-in and off by default. Set a percentage under Settings, General, Generation, 80 for example, and the older turns are summarised once the context is that full, instead of being dropped without a word. Every automatic compaction announces itself in the transcript. On a thinking model the summary is written with thinking off, because with it on the whole budget went into the thinking channel and no summary came out at all.',
          'Background agents. In Agent and Code mode the agent can delegate a self-contained task to a sub-agent that works in the background while the main run goes on. The panel on the right lists the running agents, and when one finishes the main agent is woken and continues with the result, whether the chat runs on a cloud model or a local one. Delegating asks no question of its own: a sub-agent inherits the permissions of the run that started it, every tool call it makes still passes the same gate as the main run, and a read-only run stays read-only.',
          'A sub-agent that hits its step cap or is cancelled hands back what it gathered on the way, marked as raw material rather than an answer, and counts its failed lookups instead of quoting them. The caps for sub-agents have a section of their own under Settings, Agent, Sub-agents.',
          'Local API. Settings, Local API starts an OpenAI-compatible server on your machine, port 8129 by default, that lists every local model from the LU Engine, Ollama and LM Studio under one address and streams the answers through, so any tool that talks to OpenAI can talk to your own machine. It listens on localhost unless you allow the LAN, always asks for a token, and the browser origins that may call it are an allow list that starts empty. A tool on that API can also ask which LU tools this machine has, behind the same token.',
          'Ctrl+K opens a command palette over the actions the app already has: the views, the keyboard shortcuts, switching models, the side panel, and Quit once you search for it. Right-click menus follow one pattern across the app.',
          'First-run setup runs in a small window of its own, centred by the operating system, and the main window appears the moment setup is done.',
          'The side panel folds away. While it is closed your latest chats sit on the main screen, and they belong to the panel again the moment you open it. The collapsed panel is an icon rail with a way back rather than a gap, the chat column can be dragged wider, and a chat title is shown in full instead of cut at 30 characters.',
          'Which model the open chat ran on no longer takes a chip of its own in the composer row. It is a small dot on the corner of the model picker now, the full sentence sits in the picker tooltip, and the dot is only there when the chat on screen and the pick beside it disagree.',
          'Coming from 2.6.7 you find your conversation list open, as you left it. A fresh install now starts with the panel closed, an update inherited that at first, and every existing chat sat behind an unlabelled icon button.',
          'Chat works without a mouse. The conversation list is a real list you can tab through and open with Enter, a dialog closes on Escape and keeps the focus inside while it is open, a preselected button is never the destructive one, Escape closes every overlay, and animation follows the reduced-motion setting of your system.',
          'One scale for the whole app. It was rendered in four at once, an 18.4 px root and three separate zoom factors, so a corner radius in Chat came in five sizes. The light theme got the contrast fixes it was missing, the focus ring passes the contrast rule on every background, the cursor blinks while a reply streams, and Copy says that it copied.',
          'The tabs at the top and the tool row in Create scroll instead of wrapping. The entry you picked sits in the middle, the ones beside it fade towards the edges, and a click slides your pick to the centre. On a narrow window the Create row used to break onto a second line and shove the stage below it down by 36 pixels. It stays one line now.',
          'A run on a local model waits for the card instead of fighting for it. Two local runs on one card swap memory back and forth and both end up slower than one, so a second local run queues and starts when the first is done. Cloud runs start at once.',
          '/review, /plan, /diff and the other read-only commands tell the model which inspection commands it may still run, git status, git log, git diff and the like, instead of claiming it has no shell at all, which left /review unable to find the changes it was asked to review.',
          'LU starts MCP servers through npx and uvx only. The app window used to be allowed to launch node, python, deno, bun, docker and the package managers as well. Each of those takes a one line script (node -e, python -c) or hands out the whole disk (docker run -v /:/host), so any scripting bug anywhere in the window was code execution on your machine. If a server of yours is set to run one of them, LU names it and says what it can run instead.',
          'A server set to run through node, python or another launcher is named before the start, with the two launchers that work and the option of starting the server yourself and connecting by URL, and the message has a button that takes you to the entry.',
          'The Memory section reads its own Markdown export again. Since 2.5.9 the export wrote a comma between title and body while the import still looked for a dash, so an exported file came back with half a raw line as the title and the tags, source and date gone.',
          'German phrasing reaches the chat tools. Plain chat offers its tools only when it recognises what you asked for, and its German half misread two common cases. The filler word "mal", which turns up in most casual German sentences, was read as the command to paint, so ordinary questions were sent to image generation. And no German word for the internet was on any list, so a request like "schau im Netz nach" matched nothing and the model answered from memory instead of looking anything up. Both are fixed, along with two smaller gaps in the German verb lists.',
          'When a provider goes away and the model you had chosen goes with it, the app falls back to the first entry it finds and says so in the status line above the message field, instead of switching in silence. A click on a model that is still loading says what it is waiting for.',
          'Updates no longer leave the previous frontend behind. On a machine that has been updating since April this frees around 130 MB and a thousand files.',
        ],
      },
      {
        title: 'Local',
        items: [
          'The built-in engine goes by LU Engine now. It is the same engine with the same models in the same folder; only the name in Settings, in the model list and in the messages changed.',
          'An LU Engine model can be deleted from the Installed list. The rows had Bench and Details and no bin, and Details asked Ollama about a file Ollama had never seen, so a model LU downloaded could neither be removed nor found. Each row has a bin now, the confirmation names the file it removes, a split model goes as one, Details shows the file and its size, and the loaded model is taken out of the engine first. Reported in the Discord help chat.',
          'The LU Engine moves to a free port when 8127 is taken or reserved by the system, and after a start that fails it retries once instead of giving up until the next restart. The next start begins at 8127 again rather than staying on the port it had to move to. Windows port reservations are marked as researched rather than proven, because no such reservation could be staged here.',
          'A chat model you downloaded stays visible as Installed even while the engine is not running, and its tile has a Use button that starts the engine and loads that model, rather than leaving you with a file you cannot reach. The model you just downloaded also becomes the active chat model, so the first message goes to it instead of swapping the engine back to the previous one, and the engine starts on it once rather than twice.',
          'A running LM Studio stays in the model picker after the chat has moved to the LU Engine. Its models keep their own heading in the list, and picking one hands the local slot back to LM Studio, with a line that says so. The way back is one click, the same as the way out.',
          'A click on a file the LU Engine cannot open no longer costs you the engine that is running. The first bytes of the file are read before anything is stopped, and a file without the GGUF mark is named and left alone instead of taking down a healthy engine for two failed attempts.',
          'The uncensored Qwen 3.8 27B rows come from OrcaRouter\'s abliteration now, bartowski\'s ungated GGUF requant with the vision projector, and Ollama gets OrcaRouter\'s own tag. A gated Hugging Face repo used to end in "trying again cannot help"; the download now says that the repo needs an accepted licence and a Hugging Face token, and names the field: Settings, AI Backends, Hugging Face token. The field exists on Windows and Linux now, and the token goes to huggingface.co with every model download.',
          'Three uncensored models that were missing: Qwen 3.8 27B Heretic, Gemma 4 12B Heretic and Qwen3-VL 8B Abliterated, the first uncensored image understanding that fits an 8 GB card. GLM 5.3 is in the local catalogue in the one variant the LU Engine can open; the Flash files carry an architecture llama.cpp does not read yet, so they wait, and a catalogue check now reads the file header of every entry so that a model the engine cannot open never gets listed again. Hunyuan 3 295B left the list for that reason.',
          'The folder you set under Model Storage is read now, not only written to. Every GGUF in it, up to four levels down, appears under Installed and loads from where it lies, whichever backend is serving your chat: on a machine running Ollama, a GGUF in that folder was found on disk and then listed nowhere. Its tile has a Use button that hands the chat to the LU Engine and says so in one line, and your Ollama models never leave the picker, so you go back by clicking one of them.',
          'Model Storage says which backend each folder belongs to. It used to be one field labelled "(auto-detect)" over a paragraph that named all three backends at once, so you could not tell which backend you were setting a folder for. There are three named rows now: the LU Engine folder you set, with the folder that is actually being read spelled out while the field is empty; the LM Studio folder, read only, or a plain sentence that LM Studio is not installed; and Ollama, which keeps its own store and has no folder to set.',
          'The CivitAI API key has a field again, under Settings, AI Backends, Model Storage. Downloads from the CivitAI search carry the key, and a download CivitAI refuses names the missing setting instead of a bare error number.',
          'Subfolders named the way ComfyUI names its own, loras or checkpoints, go to ComfyUI through its extra model paths at the next start, so models on a second drive show up there.',
          'On the Mac, picking a model folder under Desktop, Documents or Downloads says up front that macOS will ask once for access to it, instead of letting that dialog arrive out of nowhere on the first scan.',
          'The ComfyUI installer checks that the environment it just built can import ComfyUI, installs what is missing, and names a missing Visual C++ runtime instead of ending in a silent crash.',
          'Repair environment runs the same check with a time limit and a Cancel button that stops it, and the trainer setup stopped blaming the network for failures that had nothing to do with the network.',
          'Character Studio sets itself up on a machine whose Python is too new. The trainer needs Python 3.10 to 3.12, and LU built its environment from whatever Python was newest, so a machine with 3.14 failed at the last step on every update since August. The setup now picks a Python from that range by itself, installs 3.12 on Windows if there is none, and rebuilds an environment that came from the wrong one. The failure text under the button also stopped being cut after one line. Reported in Discord ticket 0004.',
          'The local trainer no longer hands out instructions. On the way from Set up trainer to a finished character every dead end fixes itself or names its cause: the trainer source comes as an archive and needs no git on the machine, the drive is checked for room before the first byte, a download that breaks off is retried twice, a missing Windows runtime library for PyTorch is installed by LU through winget instead of a link to microsoft.com, the setup proves that PyTorch loads before it calls the environment ready, a card with less than 12 GB hears that before ten minutes of caching, the local chat model is paused for the run and comes back afterwards instead of squatting the memory the recipe needs, and a run that still runs out of memory on the card says what to close. The step counter moves with every training step instead of once per epoch, the base-file download keeps showing its progress when you leave the tab and come back, winget output stays out of the note under the button, and a Stop pressed in the first seconds of a run, while the card is still being freed or the environment checked, now stops the run instead of hiding it: the chat model only comes back once the trainer is really gone.',
          'A ComfyUI that will not start names the cause. A missing Visual C++ runtime, or a graphics driver older than the PyTorch that was installed, used to arrive as "the Python environment looks broken" next to a Repair button, and neither of those lives in the folder Repair rebuilds. The message now says which of the two it is, and LU no longer starts a repair that cannot fix it.',
          'AMD on Windows is read from the HIP SDK itself. The only ROCm probe ran rocm-smi, which the Windows SDK does not ship, so an installed ROCm went unseen. LU reads HIP_PATH and hipinfo now and names the card architecture, and an image run that fails names that architecture and get_arch_list instead of a HIP traceback. This is marked as researched rather than proven, because there is no RDNA4 card here.',
          'The Model Manager stopped putting system RAM in the GPU field. ComfyUI reports system memory on a CPU device in a field called vram_total, so a machine with 64 GB of RAM read as if it had 62 GB of video memory.',
          'AMD cards on Linux report their memory size without ROCm installed. LU read AMD memory only through rocm-smi, which comes with the ROCm developer packages rather than with the driver, so the card was found and its size was not. The size comes from the kernel now. An integrated AMD chip is deliberately left out, because the number it reports there is the fixed carve-out rather than what it can actually use. This reading has now been measured on a rented AMD Instinct card, where the kernel number and the number ComfyUI reports for itself are the same number.',
          'An AMD compute card shows up at all now, and it shows up with its name. A card built without a display output reports itself to the system as a processing accelerator rather than as graphics, and LU accepted only the three graphics classes, so an AMD Instinct was missing from the hardware list entirely. rocm-smi also names its columns differently from one version to the next, so the card that was found came out as "AMD GPU" and its gfx target was thrown away, although rocm-smi prints it in a column of its own. Measured on a rented AMD Instinct MI325X: the card is listed with its name, its gfx target and 255.7 GiB, PyTorch installs from the ROCm channel LU picks, and Create rendered an image, a video, a song, a 4x upscale and a cutout on it.',
          'When ComfyUI does fall back to the processor, the reason it names is the real one. The only line in the output panel read "No NVIDIA driver detected", which is the wrong hardware to name in front of someone holding an AMD card: what actually decided it was the PyTorch inside that ComfyUI environment reporting no usable card. The line says that now, it says something different when the check did not answer at all, and it names the switch when you chose Force CPU yourself.',
          'The Linux packages ask for the libraries the LU Engine links against. The deb and the rpm named the desktop libraries but not libvulkan1 and libgomp1, so on a machine without them the install went through, the engine died in the loader, and the message blamed your graphics card. The missing library is named now, together with the command that installs it. The AppImage needs the Vulkan loader (libvulkan1) from your system as well, because an AppImage cannot carry that one itself.',
          'On the Mac, LU stopped searching your whole home folder for a ComfyUI it never runs there. That search touched the Desktop and Music folders, so macOS asked for access to Apple Music and to the Desktop at first launch, and the window sat on LOADING while the search ran. On Windows and Linux the same search moved off the main thread, so a slow disk no longer freezes the window.',
          'Settings shows the port the LU Engine actually runs on, and the Model Storage folder says when it could not be read or was too big to scan. A ComfyUI install or repair can be cancelled from Settings, and it keeps showing its progress while you look at other settings.',
          'Error messages from Windows arrive in English, and a ComfyUI requirements.txt that cannot be used is named instead of silently skipped.',
          'Every Python step LU starts now runs with UTF-8 output. One step out of eight did before, so on a Windows account whose name falls outside the English alphabet, a single character in a path could end an install or a probe partway through.',
          'The Coding Agent\'s working directory can be removed again. There is a Remove button beside the folder picker and one in the header, both are locked while a run is going, and picking a different folder moves the current chat over to it.',
          'The prompt history in Create can be cleared. Every entry has its own remove button, and Clear all at the top of the list wipes the lot after a second click.',
          'Character training no longer stops at the first step on a Windows machine with more than one GPU. torch asked for libuv, which the Windows wheels do not carry, and the run died with "use_libuv was requested but PyTorch was build without libuv support". LU now sets USE_LIBUV=0 for every trainer process on Windows. Reported in GitHub #121; nobody here has two GPUs, so this is the documented torch workaround rather than a measured fix.',
          'Clicking into the message field no longer draws a thick violet ring around the text line; the soft border around the whole box in Cloud mode stays. The Agent, context, memory and export row lines up with the box, the transcript may reach past it on both sides, the Code landing sits in the middle of the screen, and the Quality and Aspect row in Create is centred over the box.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'A reasoning model gets an effort control beside its Think button. Low, Medium and High, with Max on GLM 5.3, set how many tokens a reply may spend on thinking. The steps come from the server for each model, so a model that offers only two shows two, and a model with none keeps the plain Think button it always had.',
          'GLM 5.3 (Pro) and GLM 5.3 Flash (Hosted) are in the cloud catalogue.',
          'The Cloud switch counts its presses anonymously: which way it was pressed, platform and app version go into a daily count on lu-labs.ai, nothing else, so we learn whether anyone finds the switch. Local mode stays silent otherwise, and Settings says so.',
          'The cloud model list keeps one fixed order. The upstream provider shuffles its own list on every call, measured three times and returned in three different orders, so a new chat opened on whatever happened to be first. The catalogue order decides now, and a new chat starts on the same model every time.',
          'Document Chat works in Cloud mode. Your files are indexed on your own machine and only the passages that match your question travel with the prompt. If indexing runs on an Ollama you pointed at another machine, the panel says so.',
        ],
      },
    ],
  },
  {
    version: '2.6.7',
    headline: 'Create says what a render is really doing, and a dead ComfyUI comes back on its own',
    lines: [
      'Create tells you what a render is actually doing. The loading texts show up on the very first render after a start instead of disappearing behind a silent Queued, Sampling is only claimed once ComfyUI is really sampling, and a still image stopped announcing that it is decoding frames it never had.',
      'A ComfyUI that dies while the app is running restarts itself, three attempts with a growing pause between them, and the render that triggered it carries on afterwards. An app left idle now says within about half a minute that ComfyUI is gone, and it only promises a restart for a ComfyUI it started itself.',
      'A downloaded model shows up as installed again. The list used to call a bundle installed as soon as a neighbouring bundle had brought one shared file along, so a card could say Installed while its own main model was missing. Every file is checked now, and after a download the app keeps checking in the background for a full minute instead of giving up after four seconds.',
      'The built-in engine starts on a fresh installation. Text downloads used to pick their destination based on the model you were chatting with, and a fresh install has none, so the file landed where the engine never looks. The download goes to the right place now, models that already went missing are found again, and an engine that cannot start says why in under a second instead of timing out.',
      'Updating no longer risks your chats. The app waits for open chat writes before restarting into an update, saves a fresh copy of your conversations at the handover, and keeps three rotating backups instead of one.',
      'Local models with strict chat templates stopped failing with the system message error. However the conversation was assembled, the system prompt reaches the engine first and in one piece now.',
      'Thinking reaches the engine again, on every surface from group chat to the phone relay, and every answer records the model that wrote it, so an old conversation stops claiming a model it never ran on. One stray click can no longer move the app into the cloud and bill you for it either: going in takes a second click within six seconds, going back out stays a single click.',
      'The first load of a big image model is no longer mistaken for a hang, voice input failures name the real reason instead of blaming your microphone, AMD cards on Windows are detected again after Microsoft removed wmic, AMD cards on Linux get real ROCm builds of PyTorch, newer NVIDIA cards ride the cu130 channel, and the Linux package stopped colliding with Debian\'s own llama.cpp.',
    ],
    details: [
      {
        title: 'Local',
        items: [
          'The very first render after starting the app shows its loading texts again. The websocket was connected only after the job had been submitted, and that first connect costs up to five seconds, so every phase message in that window was lost. On the test machine that meant 74 seconds of model loading with nothing on screen but Queued.',
          'Sampling is claimed only once ComfyUI reports a step. The sampler announces itself before the work starts and the app read that as step one, so the progress line ran about forty seconds ahead of the render. That early event now says the model is loading, a still image gets a decode line that fits a picture instead of frames it never had, and the loading line stopped promising that later renders reuse the loaded model: measured on a large model a warm run took 22 seconds against 23 cold, because ComfyUI unloads after every render.',
          'A ComfyUI the app started itself and that dies mid session is restarted on its own, three attempts with a growing pause between them, and the render that triggered it carries on afterwards. A ComfyUI on another host, a missing installation and an environment broken at import each get their own sentence instead, because none of those is ours to restart.',
          'An idle app notices within about half a minute that ComfyUI is gone and says what will happen next, instead of sitting silent for as long as you leave it and healing only at the next render. A cold start explains itself too: once the loading phase passes twelve seconds a line says the model is going into memory, and warm runs and small checkpoints never see it.',
          'A cross origin warning you dismissed stays dismissed. The yellow bar came back after every single image because nothing remembered the click, and it is now tied to the host and ComfyUI version that raised it and survives a restart of the app.',
          'The CPU notice names the reason it is there: one text for Force CPU including the way back, one for no usable card, one for an AMD card without ROCm, and AMD advice stopped appearing on NVIDIA machines. A render on the processor also leaves the chat engine loaded, because ComfyUI started with the CPU flag touches no video memory.',
          'A bundle counts as installed only when ComfyUI can see the bundle\'s own main model. Seven video bundles share one text encoder and six share one VAE, and any one of them used to vouch for all the others.',
          'The Install button reports that the files are on disk and hands the final verdict to a background check with a full minute of patience, so a slow ComfyUI start stops turning fresh downloads into accusations.',
          'The error for a GGUF file that ComfyUI cannot list names the missing ComfyUI-GGUF package instead of pointing at the model folder.',
          'The Installed inventory names every ComfyUI folder, not only checkpoints and diffusion models. LoRAs, VAEs, text encoders, CLIP vision, ControlNet, upscalers, embeddings and style models were invisible in it.',
          'Your own file stops disappearing behind a catalogue size. A model whose catalogue entry lists 16 GB was thrown away as a partial download when the file on your disk was smaller, even when it was a perfectly good different build. Pickers still filter, the inventory never does. A deleted model also leaves the list immediately, and a cold start no longer reports an Installed count of zero that it never counted.',
          'Text downloads pick their destination by what will serve them: with no active local model the built-in engine wins. The model scanner also looks two levels deep, so a file an earlier version put in the wrong place is found and used instead of downloaded again.',
          'The engine start watches the port and the child process. A start that dies immediately is reported immediately, with the engine\'s own error text and a hint that fits the cause, after one clean retry.',
          'A test button under AI Backends checks the built-in engine end to end, repairs what it can, and then reports what it found.',
          'Adding your own provider no longer erases the built-in engine. It took the same slot and the card vanished without a trace, so the engine now waits in standby with a labelled way back, and Disable on whichever provider holds the slot hands it over instead of leaving both sides wrong. A disabled provider keeps its card and an Enable button, and a provider you added can be removed from the interface, where the only ways out used to be Disable or a full reset.',
          'The LM Studio button in the picker sets the provider up instead of starting a server that nothing was configured to ask, and it says beforehand what it replaces and how to get back. Hints point at controls that exist as well: four of them named buttons and icons that were never in the interface, and Open Settings lands in the right tab with the right section already open.',
          'Thinking reaches the engine. The switch was set, the engine never saw it and no bubble appeared, and the signal now goes out on every path, including group chat, workflows, A/B compare, the benchmark and the phone relay. It was proven on the wire in both positions.',
          'Every answer records the model that wrote it and the chat reads that instead of your current selection, the engine refuses a request that names a model it is not holding, and group chat loads each speaker\'s model before that speaker\'s turn instead of answering everything from whatever was loaded.',
          'Moving the app into the cloud takes a second click within six seconds, because the switch sits next to the model picker and one stray click used to be enough to start billing you. Going back out stays a single click, and the composer shows which side you are on.',
          'System prompts are normalised right before a request leaves for a local or OpenAI compatible engine: everything system moves to the front and is merged in order. An already correct conversation passes through untouched so prompt caches stay warm.',
          'The update waits up to ten seconds for pending chat writes, then saves a snapshot of your conversations before handing over to the installer. Backups rotate through three slots, and the newest one that actually has content is restored if the database is lost. The backup file is written safely, so a crash in the middle of writing cannot destroy the previous good copy.',
          'The render watchdog asks ComfyUI whether the job is still queued before calling five quiet minutes a hang, waits longer while a first checkpoint load is running, and gives a render in its final steps one extra minute instead of throwing it away.',
          'A refused transcription shows the refusal\'s own words. Whisper not available and model still loading reach you as they are instead of a generic microphone hint.',
          'AMD cards on Windows are detected again. The check ran through wmic, which Microsoft removed in the August 2026 update, so on a current Windows the app believed there was no AMD card at all. It reads the registry now and keeps wmic as a fallback.',
          'Windows with an RDNA3, RDNA3.5 or RDNA4 card is pointed at AMD\'s own ROCm wheel channel instead of processor wheels and the frozen DirectML build. The channel is AMD\'s published one and is marked as researched rather than proven, because we have no such card here. On Linux, AMD cards the wheels do not cover stay on the processor build honestly: they used to pass detection, report a working device and then crash on the first kernel, so the trainer refuses on them with a reason instead of starting a run that cannot finish.',
          'An AMD card on Linux gets ROCm wheels of PyTorch, newest channel first with fallbacks, shared by the trainer and ComfyUI. On Windows the message says what works there instead of offering a channel that does not exist.',
          'Cards from Turing up use the cu130 channel with cu126 as fallback, and the channel is checked live before it is chosen.',
          'The Linux .deb ships its engine as lu-llama-server, so it stops conflicting with Debian\'s llama.cpp-tools over a file name. The Windows installer cleans up the old name from earlier versions.',
          'Closing the window gives the video memory back. The cross hides the app by design, but the engine sat there holding its model, and after a short grace period it now unloads the same way it does on a cloud switch and comes back on its own when you use it again. On Windows the engine also dies with the app: a crash used to leave it behind holding several gigabytes of video memory and leaked a handle on every restart, and a crash now leaves a witness file too.',
          'Error messages are English on a non English system. Windows writes its error text in the system language and we were passing it through, so a German or French machine showed a half translated failure in an English app. The number stays, the text is ours.',
          'The model size check stopped following file names it was handed. A name shaped like an absolute path made the check look at that file and answer whether it exists and how large it is, so a hostile or intercepted ComfyUI had an existence and size oracle for arbitrary paths on your machine. Names run through the same filter the delete path uses now, a rejected name gets the ordinary not found answer, and nested names like sdxl/pony.safetensors keep working.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'A very long hosted conversation is trimmed to fit instead of refused as too many messages. The system prompt and the newest turns are kept, tool call pairs are never split, and only when the provider still refuses does a clear message with code context_exceeded appear.',
        ],
      },
    ],
  },
  {
    version: '2.6.6',
    headline: 'Agent and Code mode do the same work for fewer credits',
    lines: [
      'Agent and Code mode send far less context on every step, so every step costs fewer credits. Old tool results shrink as the run goes on, the amount sent per step is capped, and the stable part of the prompt stays put so the upstream cache keeps paying off. The agent also carries 15 tools instead of 31, so the list it sends with every single step is a fraction of what it was.',
      'A run no longer quietly re-reads and re-sends the same big files forever, and an agent run stopped firing a hidden memory step on every single round. Same result, smaller bill, and the long runs are where you feel it.',
      'Plain chat, group chat and A/B compare now cap how much history they send to paid models, so a long conversation stops getting more expensive without you noticing. A group round still costs one bill per model, and the composer says so.',
      'Anthropic models sent with your own key now use prompt caching, so a follow up on the same conversation is cheaper than starting it cold.',
      'The Code view grew a mode menu per conversation (Ask, Bypass, Plan mode), the plan moved into the right panel, and a real file explorer arrived that you can widen and preview files in without leaving the app. The prompt box is one quiet row again in both states, Plugins moved up to the header, and nothing about plans crowds the composer on any surface any more.',
      'The credits meter tells the truth on a coding step. It now counts the tool list the step actually sends, and it stopped counting the run\'s own tool chain twice, so the number you see is the number you pay.',
      'A plan survives an interrupted run. Say continue and the agent picks up the next open step instead of hunting for its own plan in the history, where on a long run it was no longer there to find.',
      'Your chats survive a hard crash: a wiped chat database is restored from the app\'s own backup instead of the backup overwriting the good copy. A long hosted chat that hits the message limit shrinks its request and keeps going instead of refusing every further turn, browser voice recording reaches the transcriber again, and a link an agent made up is labelled as unverified.',
      'Qwen 3.8 is in the model list, uncensored builds included, and it can look at pictures: the separate vision file is downloaded next to the model and the built in engine starts with it, so a downloaded Qwen 3.8 sees images instead of quietly ignoring them. A model imported from LM Studio brings its vision file along too.',
    ],
    details: [
      {
        title: 'Local',
        items: [
          'Agent and Code runs trim older tool results out of what they send upstream. The newest step is always kept in full, so the model never edits against something it can no longer see, and a setting turns the whole thing off if a run ever misbehaves.',
          'The context sent on a paid step is capped, and the meter now counts against that cap instead of the whole model window, so the warning fires before a step gets expensive rather than after.',
          'The stable half of the prompt no longer changes every step. The minute clock and everything else that moves each turn sit at the end now, so the upstream cache survives a long run instead of going cold on a timestamp.',
          'The agent works with 15 tools instead of 31. Sixteen single purpose tools folded into the terminal tool, which now runs scripts through standard input, runs a job in the background and summarises a test run, a git status or a commit for you. The retired names still work: calling one runs the right thing and tells you what to call next time, so nothing you or a model already knew stopped working.',
          'The coding tool catalog is leaner: the git and gh cookbook, paragraphs the system prompt already states, and the PR and delegate tools all left the every-step budget, and the image and video tools share one settings schema.',
          'A mode menu in the Code composer picks Ask permissions, Bypass permissions or Plan mode per conversation, with a global default in Settings. Bypass bypasses on a cloud model too, and a setting brings the cloud shell confirm back for anyone who wants it.',
          'Plan mode explores read only, writes the plan, then stops for your yes. Approve and run carries the whole plan out in the same run and never lands in Bypass on its own: the button shows the mode it will run in, and it shows you the real commands first.',
          'The plan moved out of the prompt box into the right panel, live under the tree and the file preview. Nothing about plans is at the prompt box any more on any of the three surfaces, and the app now checks that for itself so it cannot creep back.',
          'The Code prompt box is one row and stays one row. Plugins moved to the header next to New as an icon with the name in its tooltip, the action bar no longer wraps onto a second line, and Send and Stop share one fixed slot, so starting a run does not change the height of the box you are typing in.',
          'An interrupted run keeps its plan. The plan lives with the conversation and survives a restart, so a following turn is told how far it got and what the next open step is. A new message that clearly points somewhere else still wins.',
          'The credits meter counts the tool list a step sends. That list rides beside the messages rather than inside them, so it used to be missing from the estimate entirely: a first coding step read about 732 tokens against roughly 2.600 actually sent. It also stopped adding the run\'s own tool chain a second time, which made the first step of a fresh chat read as double its real size.',
          'Agent runs, coding runs, delegated sub tasks and runs started from your phone are all told which system they are on and what the time is, so none of them spends a step asking. On the phone that sentence describes the machine doing the work, not the phone in your hand.',
          'Error messages are English again on a non English Windows. Windows writes its own error text in the system language, and we were passing it straight through, so a German or French machine showed a half translated failure in an English app. Every message the app writes now says what went wrong in English and keeps the error number. Output from an installer we run stays in its own words, but it is labelled as that instead of standing in for our message.',
          'The file explorer is a real tree you expand folder by folder, widen by dragging its edge, with the width remembered across a restart. Click a file to preview it: code with highlighting, images inline, HTML in a sandboxed frame with scripts off until you ask. node_modules, .git, target and dist stay out of the way.',
          'A follow up in the same conversation stops re-attaching images from many messages back, so old pictures no longer ride along on every later step where nothing looks at them.',
          'A chat database wiped by a hard crash is restored from the app\'s own backup on the next start, and the backup now merges with what it already held instead of overwriting it. Three things had to go wrong at once for chats to be lost for good, and the app was finishing that job itself seconds after every launch.',
          'Browser voice recording reaches the transcriber again. The recorded audio was refused as the wrong body type before the handler ever saw it, and the request went out without the header every other call sends.',
          'A link in an agent answer that no tool ever returned is labelled as unverified in the bubble, and after a real tool success the agent is asked once to look it up properly or take it back.',
          'A long run\'s trim notice no longer plants a system message in the middle of the conversation, which strict chat templates refuse outright. That is the crash that only ever showed up once a chat had grown long.',
          'The built in engine is restarted at the context an agent or coding run actually budgets for, instead of staying at its 8192 default while the prompt quietly overflowed it.',
          'The engine\'s saved conversation cache follows the slot that really holds the tokens instead of always writing slot zero, and a render in Create, music or video now saves that state and brings every backend back warm afterwards instead of leaving the next chat turn to a cold start.',
          'The LoRA trainer plans for an AMD card instead of reading a silent nvidia-smi as no GPU at all. On Linux it installs the ROCm build; on Windows and macOS it refuses before the clone and the 2.5 GB, because there is no wheel to install there.',
          'A bundle card in the Model Manager reads its own download state instead of its neighbours\' (GitHub 113). Video bundles share files, so one failed attempt used to put a Retry button on every card and hide bundles that were complete on disk.',
          'A finished download in the Model Manager waits for ComfyUI to list the file before announcing it, so a model stops being missing from the Installed tab and every picker until you reload by hand.',
          'Qwen 3.8 joined the Model Manager: the viral uncensored 27B, the huihui abliterated 27B, the official 27B in Unsloth\'s dynamic quants, a 9B distill for small cards, and the two Ollama tags. Every 27B entry is a vision model, so its projector file is downloaded next to the model and the built in engine is started with it. The 9B distill is listed as text only, because its repo ships no projector.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'Anthropic models sent with your own key carry prompt caching markers on the system block, the last tool and the last stable message, so a repeated request reads from the cache instead of paying for the whole prompt again.',
          'The automatic memory step on LU Cloud only runs if you turn it on, and then on the cheapest capable model rather than the one you are chatting with, and at most every third turn. It used to run on the model you were chatting with, on every single round, whether you wanted it or not.',
          'Group chat and A/B compare cap the history they send per model, the same as a normal chat, instead of sending the full shared thread to every model on every round.',
          'A hosted chat that has grown past the server\'s message limit shrinks the request it sends and retries, instead of refusing every further turn. Before this, one long conversation was a permanent dead end and every new message only made the payload the server had just refused longer.',
        ],
      },
    ],
  },
  {
    version: '2.6.5',
    headline: 'Updating works again, and the work you started survives it',
    lines: [
      'The installer used to stop at our own running engine and roll the whole update back, so the app could not be updated at all without killing the process by hand. That is fixed, and it is the reason to install this build.',
      'In Code mode an approved change actually lands now, or says exactly why it cannot, and anything still waiting for your yes survives a restart. Installing an update is a restart, so this used to throw away the work it was meant to rescue.',
      'Create tells the truth about what it is doing: Download and install finishes instead of freezing on "Refreshing the model list", the gallery reports the seed you really rendered with, help tooltips are readable, and the Music tab stops quoting cloud prices at local users.',
      'Dropping files into the app works again on Windows, the trainer repairs its own environment, FramePack stops producing mush, and an AMD card shows up without the ROCm tools installed.',
      'Your own LoRAs are selectable in image generation, a broken ComfyUI Python environment rebuilds itself instead of showing a wall of errors, and a conversation with the built in engine survives a render that needs the video memory.',
      'Models you already have in Ollama or LM Studio come along with one click and no re-download, and the ComfyUI environment now installs a torch its current core actually accepts.',
    ],
    details: [
      {
        title: 'Local',
        items: [
          'The installer shuts our engine down before writing, instead of rolling the update back at a locked llama-server.exe.',
          'An approved change lands, or names the conflict. Changes waiting for approval are kept across a restart, and the plan bar no longer claims to be finished while writes are still queued.',
          'A request the model server refuses ends the run at once with the reason, instead of being retried twice while the run looks alive.',
          'Dragging files onto the Character Studio board, the chat composer or the RAG panel works again on Windows.',
          'Download and install waits for ComfyUI to actually list the new model, counts the seconds, restarts the engine once if the scan stalls, and explains itself if that still does not help.',
          'The LoRA section in image generation is always there on lanes that support it. Empty, it names the folder to drop files into and offers Rescan, so a LoRA added while the app runs shows up without a restart. Characters from the trainer land there by themselves.',
          'A ComfyUI Python environment that dies at import is recognised as broken and rebuilt into its own venv, from Create automatically and from Settings with Repair environment. Re-running the installer never fixed this, because pip saw every package as already there.',
          'A chat with the built in engine survives an image or video render. The engine used to be left out of the memory juggling entirely, and a restart meant re-reading the whole conversation. Its state is now parked on disk and restored afterwards.',
          'Character training repairs its own environment instead of refusing to start, and FramePack got back the VAE it was trained with.',
          'Cancel in Character Studio stops the training itself, not just the launcher above it. The two processes holding the card at full load used to keep running until they were killed by hand.',
          'A repair that cannot finish says why in one sentence, a full disk for example, and stops reporting the environment as ready.',
          'The starter bundle offered on a lane is one that lane can actually run, and its card stays up until the last file has landed, so nothing is pickable while it is still downloading.',
          'A release that was withdrawn stops being advertised as an available update.',
          'An AMD card is listed even without the ROCm command line tools, and says plainly what could not be verified.',
          'The gallery reports the seed the image was really made with, so a run can be repeated.',
          'Help tooltips float above the window instead of being clipped to two words, everywhere in the app.',
          'The Music tab in local mode has no canvas, no per-second billing line, and always takes your lyrics.',
          'The benchmark has a brake for a model that goes off script, and the board says what it ranks.',
          'Settings, Model Storage, Scan for local models finds the GGUFs that Ollama and LM Studio already store and links them into the Built-in Engine without copying, so the disk pays once and both apps keep working.',
          'The ComfyUI environment installs torch from the living cu126 channel. The frozen cu121 channel stops at torch 2.5.1, which the current ComfyUI core rejects at import, so a fresh setup or a repair used to build an environment that could not start. Blackwell cards keep cu128.',
          'While an environment rebuilds, the spinner reports what is downloading, how big it is, how fast it moves and how long is left, instead of sitting silent for minutes.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'Turning thinking off now turns it off on servers you configure yourself, not just here.',
          'Running out of credits says so immediately and offers the top up, instead of retrying a request that cannot succeed.',
          'A coding step no longer carries the image and video generators unless the task asks for them, which is about a third of the tool budget on every step.',
        ],
      },
    ],
  },
  {
    version: '2.6.4',
    headline: 'What you see is what you pay',
    lines: [
      'Cloud off means cloud off: with no local model running, the switch used to keep the cloud model silently active and chats kept billing credits. The app now refuses any model from the wrong mode.',
      'The music price in the picker follows the length slider live. Billing was always per second, but the label quoted 1 minute, so a 3 minute song looked three times cheaper than it was.',
    ],
  },
  {
    version: '2.6.3',
    headline: 'Agent runs you can trust, and a lighter, faster app',
    lines: [
      'Agent and Code mode got a deep reliability pass: runs no longer stall, loop, or invent results, small local models drive tools properly, and Stop always stops.',
      'New: group chat with 2 to 4 local models, editable model answers, Wan native video sizes, HiRes fix, and RTX 50 support for character training.',
      'Cloud: personal API keys for the OpenAI compatible endpoint, your own lyrics really get sung, and every model shows its price up front.',
      'Long chats got a deep memory fix, streaming stays smooth, and generated images survive a restart.',
    ],
    details: [
      {
        title: 'Local',
        items: [
          'Agent and Code runs no longer stall, loop, or invent results, and Stop always stops.',
          'A thinking-only round continues the run instead of ending it.',
          'Thinking streams in a small window between the steps, in order, and the plan bar stays out of the chat history.',
          'Small local models drive tools properly, including LM Studio and other OpenAI compatible local servers.',
          'The agent knows your OS and shell, and opens folders and starts programs on request.',
          'The agent context window sizes itself to what your server actually loaded.',
          'Group chat: pick 2 to 4 local models, they answer in turn in one conversation, every answer labeled.',
          'Edit any model answer in place; the conversation continues from your correction.',
          'Wan native video sizes: 480p in both orientations, a portrait or landscape flip, and ratio chips that keep the pixel budget.',
          'Native HiRes fix for local image generation.',
          'Character training supports RTX 50 cards, and a broken trainer environment says so before the run starts.',
          'A ComfyUI that dies at startup shows the real reason instead of reinstalling in a loop.',
          'Read aloud plays again; our own security policy had blocked it.',
          'The benchmark measures cost and correctness, and answers that were cut off are marked, in the benchmark and in chat.',
          'Long chats got a deep memory fix, generated images survive a restart, and the remote tab is named AI Terminal.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'Personal API keys: mint keys in the account settings on lu-labs.ai and use your plan from Aider or any OpenAI compatible tool.',
          'Your own lyrics really get sung, with a how-to next to the lyrics box.',
          'Every cloud model shows its price up front in the picker.',
          'The credits meter counts video and training budgets truthfully.',
        ],
      },
    ],
  },
]

/** The note for a version, or undefined when nobody wrote one. */
export function releaseNoteFor(version: string): ReleaseNote | undefined {
  return RELEASE_NOTES.find((n) => n.version === version)
}
