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
    headline: 'Reasoning models get an effort control, and a downloaded model stays Installed',
    lines: [
      'Reasoning models carry an effort control next to the Think button. Low, Medium or High, and Max on GLM 5.3, decides how many tokens a reply may spend on thinking.',
      'GLM 5.3 (Pro) and GLM 5.3 Flash (Hosted) are in the cloud catalogue, and the cloud model list keeps one fixed order, so a new chat starts on the same model every time instead of a different one on each load.',
      'The side panel folds away, and while it is closed your latest chats sit on the main screen. The note about which model wrote the chat you are reading is a quiet dot on the model picker now instead of a chip in the composer.',
      'The built-in engine moves to a free port when 8127 is taken, and a chat model you downloaded stays visible as Installed with a Use button that starts the engine for it.',
      'AMD on Windows is read from the HIP SDK, the Linux packages name the libraries they need, the ComfyUI installer proves its own environment, your own model folder is read, Document Chat works in Cloud mode, and the prompt history in Create can be cleared.',
    ],
    details: [
      {
        title: 'Local',
        items: [
          'The side panel folds away. While it is closed your latest chats sit on the main screen, and they belong to the panel again the moment you open it.',
          'What the open chat actually ran on stopped taking a chip of its own in the composer row. It is a small dot on the corner of the model picker now, with the full sentence in the picker\'s tooltip, and it is only there when the chat on screen and the pick beside it disagree.',
          'The built-in engine moves to a free port when 8127 is taken or reserved by the system, and it retries the start once after a failure instead of giving up until the next restart. Windows port reservations are marked as researched rather than proven, because no such reservation could be staged here.',
          'A chat model you downloaded stays visible as Installed even while the engine is not running, and its tile carries a Use button that starts the engine and loads that model, instead of showing you a file you cannot reach.',
          'The ComfyUI installer proves that the environment it just built can really import ComfyUI, installs back what is missing, and names a missing Visual C++ runtime instead of ending in a silent crash.',
          'Repair environment runs the same check with a time limit and a Cancel that really cancels, and the trainer setup stopped blaming the network for failures that were never about the network.',
          'The folder you set under Model Storage is read now, not only written to. Every GGUF in it, up to four levels down, appears under Installed and loads from where it lies.',
          'Subfolders named the way ComfyUI names its own, loras or checkpoints, are handed to ComfyUI through its extra model paths the next time it starts, so models on a second drive stop being invisible.',
          'The CivitAI API key has a field again, under Settings, AI Backends, Model Storage. Downloads from the CivitAI search carry the key, and a download CivitAI refuses names the missing setting instead of a bare error number.',
          'AMD on Windows is read from the HIP SDK itself. The only ROCm probe ran rocm-smi, which the Windows SDK does not ship, so an installed ROCm went unseen; LU reads HIP_PATH and hipinfo now and names the card\'s architecture, and an image run that fails names that architecture and get_arch_list instead of a HIP traceback. It is marked as researched rather than proven, because there is no RDNA4 card here.',
          'The Model Manager stopped putting system RAM in the GPU field. ComfyUI reports system memory on a CPU device in a field called vram_total, so a machine with 64 GB of RAM read as if it had 62 GB of video memory.',
          'The Linux packages ask for the libraries the built-in engine links against. The deb and the rpm named the desktop libraries but not libvulkan1 and libgomp1, so on a machine without them the install went through, the engine then died in the loader, and the message blamed your graphics card. The missing library is named now, together with the command that installs it. If you run the AppImage instead, it needs the Vulkan loader (libvulkan1) from your system, because an AppImage cannot carry that one itself.',
          'The Coding Agent\'s working directory can be removed again. There is a Remove button beside the folder picker and one in the header, both are locked while a run is going, and picking a different folder moves the current chat over to it.',
          'The prompt history in Create can be cleared. Every entry has its own remove button, and Clear all at the top of the list wipes the lot after a second click.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'Reasoning models carry an effort control next to the Think button. Low, Medium and High, with Max on GLM 5.3, decide how many tokens a reply may spend on thinking. The rungs come from the server per model, so a model that has only two of them is offered two, and a model with none keeps the plain Think button it always had.',
          'GLM 5.3 (Pro) and GLM 5.3 Flash (Hosted) are in the cloud catalogue.',
          'The cloud model list keeps one fixed order. The upstream provider shuffles its own list on every call, measured three times with three different orders, so a new chat opened on whatever happened to be first that time. The catalogue order decides now, and a new chat starts on the same model every time.',
          'Document Chat works in Cloud mode. Your files are indexed on your own machine and only the passages that match your question travel with the prompt, and if indexing runs on an Ollama you pointed at another machine, the panel says so instead of pretending otherwise.',
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
