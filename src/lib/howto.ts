// "How it works": one short silent film per area, with ONE line of text under
// it that follows the scene on screen. The films are rendered from the real
// interface (e2e/howto/*.spec.ts); `steps` is the `steps.json` each recording
// writes, so a line and its `from` second always belong to the film they were
// recorded with. Cloud mode only: every line states what the cloud tabs do.

export interface HowtoStep {
  /** Second of the film from which this line is shown. */
  from: number
  text: string
}

export interface HowtoFilm {
  /** File name of the film without extension. */
  id: string
  /** Short name of the film where one topic has several. */
  label?: string
  steps: HowtoStep[]
}

export interface HowtoTopic {
  title: string
  films: HowtoFilm[]
  /** The handbook page on locallyuncensored.com that explains the same thing
   *  in full, as a path ("/guide/agent/"). Opened in the browser on click. */
  guide?: string
}

/** Where the films are loaded from, on click only. The app ships the lines,
 *  not the films: fifteen of them weigh more than half the installer. */
export const HOWTO_VIDEO_BASE = 'https://lu-labs.ai/howto/'

/** The site the handbook pages live on. */
export const HOWTO_GUIDE_BASE = 'https://locallyuncensored.com'

export function howtoGuideUrl(topic: HowtoTopic): string | null {
  return topic.guide ? `${HOWTO_GUIDE_BASE}${topic.guide}` : null
}

export function howtoVideoUrl(film: HowtoFilm): string {
  return `${HOWTO_VIDEO_BASE}${film.id}.mp4`
}

/** The line for a moment of the film: the last step that has started. */
export function howtoLineAt(steps: HowtoStep[], seconds: number): string {
  let line = steps[0]?.text ?? ''
  for (const step of steps) if (seconds >= step.from) line = step.text
  return line
}

const one = (title: string, id: string, steps: HowtoStep[], guide = '/guide/create/'): HowtoTopic => ({ title, films: [{ id, steps }], guide })

export const HOWTO: Record<string, HowtoTopic> = {
  image: one('How Image works', 'image', [
    { from: 0.4, text: 'Advanced settings has "Improve my prompt": your chat model rewrites the prompt before the run.' },
    { from: 3.81, text: 'Seed −1 is random. Set a number to repeat a picture.' },
    { from: 7.8, text: 'Click the picture: the large view shows what you wrote and what was sent to the model.' },
    { from: 11.78, text: 'Hover the picture: the wand is "Edit with mask", the film strip is "Animate this image".' },
  ]),
  edit: one('How Edit works', 'edit', [
    { from: 0.4, text: 'Paint a mask: only the painted area is changed.' },
    { from: 4.8, text: 'Apply the mask, then say what should be there instead.' },
    { from: 9.55, text: 'Some models need no mask. Pick one and the prompt alone is the edit.' },
  ]),
  removebg: one('How Cutout works', 'cutout', [
    { from: 0.3, text: 'Cutout needs no prompt. The result is a PNG with a transparent background.' },
    { from: 3.2, text: '"Add more images" turns one cutout into a list.' },
    { from: 6.48, text: 'One Create runs them all, one after the other.' },
  ]),
  upscale: one('How Enhance works', 'enhance', [
    { from: 0.3, text: 'Enhance needs no prompt. Pick the target: 2K, 4K or 8K.' },
    { from: 4.26, text: 'This tab takes images. For a video, open the clip from your gallery.' },
    { from: 6.84, text: 'Its large view has an "Enhance" button that upscales the clip.' },
  ]),
  eraser: one('How Erase works', 'erase', [
    { from: 0.3, text: 'Erase has no prompt field. Create waits for a mask.' },
    { from: 3.1, text: 'Paint over what should go.' },
    { from: 7.98, text: 'Apply the mask. "Mask ready": now Create removes it.' },
  ]),
  video: one('How Video works', 'video', [
    { from: 0.3, text: 'Write the prompt in present tense: what moves and how, the camera, the light.' },
    { from: 5.18, text: 'The Length choices belong to the model. Another model, other lengths.' },
    { from: 9.54, text: '"Negative" is there only on models that read a negative prompt.' },
    { from: 13.35, text: 'A render that has started cannot be stopped. It finishes and is charged.' },
  ]),
  animate: one('How Animate works', 'animate', [
    { from: 0.4, text: 'Start from a file, or from a picture in your gallery.' },
    { from: 3.58, text: 'The picture decides who and what is in the clip.' },
    { from: 5.88, text: 'The prompt only describes the movement.' },
  ]),
  character: {
    title: 'How Character works',
    guide: '/guide/character-studio/',
    films: [
      {
        id: 'character', label: 'Train and use',
        steps: [
          { from: 0.4, text: '"Train new" needs 4 to 30 photos of one character.' },
          { from: 3.68, text: 'The trigger word is the name you call the character by.' },
          { from: 6.91, text: '"Use character": pick it, then put its trigger word in the prompt.' },
          { from: 13.03, text: 'A trained character can be downloaded as a file.' },
        ],
      },
      {
        id: 'character-cloud-local', label: 'Use locally',
        steps: [
          { from: 0.3, text: "On the cloud character shelf, Use locally saves a Z-Image character into this computer's LoRA folder." },
          { from: 3.48, text: 'A character of another model family stays in LU Cloud, and LU says why.' },
          { from: 6.46, text: 'Once the file is there, LU stops and says so instead of replacing it.' },
          { from: 9.74, text: 'In Local mode, the Use character shelf lists it.' },
          { from: 13.5, text: 'Its delete button asks first, and the file goes to the Recycle Bin.' },
        ],
      },
      {
        id: 'character-frames', label: 'Video frames',
        steps: [
          { from: 0.3, text: 'The large view of a video has Use frames for a character.' },
          { from: 3.66, text: 'LU takes 8 frames spread evenly over the clip. The slider takes 4 to 20.' },
          { from: 6.56, text: 'Untick the frames that do not show the figure.' },
          { from: 10.02, text: 'Then train with the rest in Character Studio, or save them as a character.' },
        ],
      },
    ],
  },
  lipsync: one('How Lipsync works', 'lipsync', [
    { from: 0.4, text: 'The model decides what you add: a portrait, or a clip to resync.' },
    { from: 4.66, text: 'The voice is an audio file, or one the AI makes.' },
    { from: 7.77, text: 'A generated voice: pick a ready one, or describe it.' },
    { from: 14.04, text: 'No length setting here: the clip is as long as the voice.' },
  ]),
  music: one('How Music works', 'music', [
    { from: 0, text: 'The prompt sets the style. Use comma-separated tags.' },
    { from: 3.76, text: 'Open Lyrics to write your own words.' },
    { from: 5.04, text: 'Mark the parts with [Verse], [Chorus] and [Bridge].' },
    { from: 10.5, text: 'No Lyrics button? Then that model writes its own lyrics.' },
  ]),
  extend: one('How Extend works', 'extend', [
    { from: 0.4, text: 'Extend continues a video from your own cloud gallery.' },
    { from: 3.48, text: 'There is no upload here: pick one of your cloud videos.' },
    { from: 6.74, text: 'The prompt says how the clip goes on.' },
  ]),
  motion: one('How Motion works', 'motion', [
    { from: 0.6, text: 'Motion takes two files. First the character image.' },
    { from: 3.38, text: 'Then the driving video: the movement the character copies.' },
    { from: 6.16, text: 'There is no prompt on this tab. The two files are enough to hit Create.' },
  ]),
  code: {
    title: 'How Code works',
    guide: '/guide/code/',
    films: [
      {
        id: 'code-modes', label: 'Modes',
        steps: [
          { from: 0, text: 'Ask confirms commands and lets you review edits before they land.' },
          { from: 6.45, text: 'The edits wait under Pending: apply or reject each file, or all at once.' },
          { from: 10.13, text: 'Plan mode is read only: it writes a plan, then waits for approval.' },
          { from: 13.99, text: 'Approve and run names the mode the plan will run in.' },
        ],
      },
      {
        id: 'code-slash', label: 'Slash commands',
        steps: [
          { from: 0, text: 'Type / at the start of a line to open the agent commands.' },
          { from: 3.57, text: '/loop works, then re-checks again and again; 30s is the pause between passes.' },
          { from: 11.81, text: '/goal sets a goal every following turn will see; /goal clear drops it.' },
          { from: 14.44, text: '/plan works out the steps before changing anything.' },
        ],
      },
    ],
  },
  'character-local': {
    title: 'How Character works',
    guide: '/guide/character-studio/',
    films: [
      {
        id: 'character-local', label: 'Train and use',
        steps: [
          { from: 0.3, text: 'The trigger word is the name you call the character by in the prompt.' },
          { from: 2.98, text: 'Pick how long it trains: Quick, Standard or Thorough.' },
          { from: 6.54, text: 'Under "Use character", pick it: the image model switches to the Z Image model it was trained for.' },
          { from: 9.7, text: 'Pick another model by hand and a red line says so. "Switch model" brings Z Image back.' },
          { from: 14.14, text: 'Advanced settings, Expert, "LoRA stack": the character\'s Strength.' },
        ],
      },
      {
        id: 'character-edit-refs', label: 'In Edit',
        steps: [
          { from: 0.3, text: 'In Edit with Qwen-Image 2.1, the reference strip has a row Trained characters.' },
          { from: 2.1, text: 'A click adds up to three photos the character was trained on, at most 1024 pixels each.' },
          { from: 5.28, text: 'The prompt names them as image 2 to image 4.' },
          { from: 9.27, text: 'A character trained before 3.0.7 kept no photos, so the row leaves it out.' },
        ],
      },
      {
        id: 'character-chat', label: 'In chat',
        steps: [
          { from: 0, text: 'In a local chat, Agent off, ask for a picture and name a character you trained.' },
          { from: 4.21, text: 'The image tool takes the character by name. You approve the call first.' },
          { from: 7.39, text: "LU runs the character's model and LoRA, and its trigger word leads the prompt." },
        ],
      },
    ],
  },
  beginners: one('How the first start works', 'beginners', [
    { from: 1.38, text: 'LU Engine is already selected. It runs on your machine, nothing to install.' },
    { from: 4.46, text: 'Image and video are not needed for chat. Skip them now, install them later in Settings.' },
    { from: 6.64, text: 'Recommended marks the strongest starter your graphics card can carry.' },
    { from: 8.9, text: 'Install waits until the file is complete, then starts the engine on it.' },
    { from: 10.6, text: 'Then type your first message. Your chats stay on your machine.' },
  ], '/guide/beginners/'),
  storage: {
    title: 'How storage works',
    guide: '/guide/storage/',
    films: [
      {
        id: 'storage', label: 'Models',
        steps: [
          { from: 0, text: "The LU Engine folder is where chat models download. Empty means LU's own folder." },
          { from: 2.2, text: "Browse… picks a folder on another drive. Reset goes back to LU's own folder." },
          { from: 5.06, text: 'Scan for local models finds models you already have in Ollama or LM Studio.' },
          { from: 6.74, text: 'Import links the file in, without a download or a copy. Both must be on one drive.' },
          { from: 9.9, text: 'For ComfyUI, type a Path on another drive before Install ComfyUI.' },
        ],
      },
      {
        id: 'python-folder', label: 'Voice and Python',
        steps: [
          { from: 0, text: 'Voice and Python folder holds the voice engine, the read-aloud voices and LU\'s own Python.' },
          { from: 2.3, text: 'Browse… picks a folder. Choosing it moves nothing, what is installed keeps working.' },
          { from: 5.68, text: 'Move to this folder copies the files, checks the copy and starts it once there.' },
          { from: 8.46, text: 'Only then do the old files go to the Recycle Bin. Nothing is deleted for good.' },
          { from: 10.74, text: 'Reset sends new installs to the app data folder again. Moved ones keep working.' },
        ],
      },
    ],
  },
  // P11 (David, 30.10.2026): a GGUF the user already has becomes an LU
  // Engine model, which is what the Neuron tweaker needs. The same three
  // lines stand in the tweaker's empty state, next to the button they name.
  // No film is online yet; until it is, the card shows these lines as a list.
  'gguf-file': one('How to add a GGUF file', 'gguf-file', [
    { from: 0, text: 'Press GGUF file and pick a .gguf chat model on your drive.' },
    { from: 3, text: 'LU links it into the LU Engine folder, without a copy. File and folder must be on one drive.' },
    { from: 6, text: 'It shows up in Neurons and under Models, Installed, where Use starts a chat with it.' },
  ], '/guide/storage/'),
  remote: one('How remote access works', 'remote', [
    { from: 0, text: 'Remote access starts in the Remote tab of the sidebar.' },
    { from: 1.58, text: 'Dispatch splits in two: LAN for your own network, Internet for anywhere.' },
    { from: 3.86, text: 'You pick a working folder, then a LIVE panel shows a QR code and a six-digit passcode.' },
    { from: 7.04, text: 'The QR only carries the address; the passcode is typed on the phone.' },
    { from: 10.02, text: 'Under Settings, Voice & Remote, four permission switches start off and apply to every paired device.' },
  ], '/guide/remote-access-setup/'),
  sandbox: one('How the sandbox works', 'sandbox', [
    { from: 0, text: 'Sandbox is a separate folder under ~/agent-workspace, guarded by the file tool path jail.' },
    { from: 3.08, text: 'It is not a container: commands still run on this computer.' },
    { from: 6.16, text: 'The badge next to Agent shows where it works; a click picks a real folder.' },
    { from: 10.67, text: 'By default each shell command waits for Approve or Reject. Read it: it runs on this computer.' },
    { from: 13.65, text: 'Tools switches a category such as Shell on or off for this chat only.' },
  ], '/guide/agent-sandbox/'),
  'mac-hires': {
    title: 'How Image works on a Mac',
    guide: '/guide/create/',
    films: [
      {
        id: 'mac-hires', label: 'HiRes',
        steps: [
          { from: 0.3, text: 'On a Mac, Native HiRes is there with Qwen-Image 2.1, the image model that also edits.' },
          { from: 4.08, text: 'Turn it on: the finished picture is edited again at the larger size.' },
          { from: 7.06, text: 'Upscale sets the larger size, and the second pass starts at the HiRes denoise.' },
          { from: 9.36, text: 'Create makes the picture, then the HiRes pass. Only the final picture is kept.' },
        ],
      },
      {
        id: 'mac-enhancer', label: 'Prompt enhancer',
        steps: [
          { from: 0.3, text: 'Two Qwen enhancers for Qwen-Image 2.1: one for new pictures, one for edits that also looks at the picture.' },
          { from: 3.98, text: 'With one installed, Improve my prompt can hand your prompt to the Qwen enhancer.' },
          { from: 8.6, text: 'It rewrites on this Mac before the picture starts. Prompt and settings shows both texts.' },
        ],
      },
    ],
  },
  'mac-mask': one('How Edit works on a Mac', 'mac-mask', [
    { from: 0.3, text: 'On a Mac, Qwen-Image 2.1 edits under a mask, or the whole image without one.' },
    { from: 2.9, text: 'Paint the area and apply the mask: only that part is repainted.' },
    { from: 8, text: 'In Expert, Edit strength 1.00 edits from the prompt alone; lower keeps more of the image.' },
    { from: 12.46, text: 'Mask edge feather softens the edge of the mask, up to 64 px.' },
  ], '/guide/create/'),
  'mac-cutout': one('How Cutout works on a Mac', 'mac-cutout', [
    { from: 0.3, text: 'On a Mac, Cutout needs no download: macOS Vision finds the subject.' },
    { from: 4.2, text: 'No prompt: Create cuts it out right on the Mac.' },
    { from: 7.88, text: 'The PNG has a transparent background, and the line under it names macOS Vision.' },
  ], '/guide/create/'),
  'mac-upscale': one('How Enhance works on a Mac', 'mac-upscale', [
    { from: 0.3, text: 'On a Mac, Enhance Image runs SeedVR2 3B: get it under Models, Image.' },
    { from: 3.98, text: 'Then the Enhance tab in Create runs on the Mac.' },
    { from: 7.32, text: 'No prompt, one setting: 2x or 4x, up to 4096 pixels on the longest side.' },
    { from: 9.3, text: 'Create makes it four times larger, and the line under it names SeedVR2 3B.' },
  ], '/guide/create/'),
  'mac-character': {
    title: 'How Character works on a Mac',
    guide: '/guide/character-studio/',
    films: [
      {
        id: 'mac-train', label: 'Train new',
        steps: [
          { from: 0.3, text: 'On a Mac with Z-Image Turbo installed, Train new trains the character on this Mac, from 4 to 100 photos.' },
          { from: 3.18, text: "Under each photo, name what changes, like clothes or place. It goes into that photo's caption." },
          { from: 6.1, text: 'The trigger word is the name you call the character by in a prompt.' },
          { from: 8.5, text: 'Pick the length. Training is slow on a Mac, and the first run downloads a training adapter.' },
          { from: 11.53, text: "The character lands in the Mac's LoRA folder, where Use character finds it." },
        ],
      },
      {
        id: 'mac-character', label: 'Use character',
        steps: [
          { from: 0.3, text: "Use character lists the characters in the Mac's LoRA folder. A pick brings the Z Image model it was trained for." },
          { from: 4.26, text: 'On Video, the clip starts from a picture of the character made on the Mac.' },
          { from: 8.97, text: 'Create makes the character image first: Step 1 of 2.' },
        ],
      },
    ],
  },
  'mac-video': one('How Video works on a Mac', 'mac-video', [
    { from: 0.3, text: "On a Mac, LTX and Wan take a size. The line says what runs on the engine's grid." },
    { from: 4.56, text: "The LoRA stack lists the Mac's LoRA folder. A LoRA turned on goes into the run." },
    { from: 8.42, text: 'With a model that starts from an image, Extend Video runs on the Mac too.' },
    { from: 11.08, text: 'The last frame of your clip is where the next part starts.' },
  ], '/guide/create/'),
  'mac-music': one('How Music works on a Mac', 'mac-music', [
    { from: 0.3, text: 'On a Mac, Music runs ACE-Step 1.5: get it under Models, Music.' },
    { from: 2.78, text: 'Then Music in Create is a local tab. The prompt sets the style, Lyrics takes your words.' },
    { from: 8, text: 'Length runs from 10 seconds to 4 minutes, and the seed sits in the advanced settings.' },
    { from: 12.2, text: 'Create makes the track on this Mac, and it lands in the gallery.' },
  ], '/guide/create/'),
  'dictation': one('How dictation works', 'dictation', [
    { from: 0, text: 'The microphone in the chat box writes what you say into the field while you talk.' },
    { from: 3.88, text: 'Send or Enter ends the recording first and sends what the field shows.' },
    { from: 5.76, text: 'While the answer still runs, the microphone is free for the next take.' },
    { from: 9.42, text: 'Dictation runs on your computer with faster-whisper, set up under Settings, Voice & Remote.' },
  ], '/guide/chat/'),
  'mac-lipsync': one('How Talking Character works on a Mac', 'mac-lipsync', [
    { from: 0.3, text: 'On a Mac, Lipsync (Talking Character) runs on LTX-2.3 Distilled 4-bit. The tab gets its extra 11.3 GB.' },
    { from: 2.58, text: 'Add a portrait and a voice recording. What the voice says is optional and helps the lips.' },
    { from: 6.5, text: 'No settings: the clip follows your voice, up to 10 seconds. It needs a Mac with 24 GB or more.' },
    { from: 8.5, text: 'Create makes the clip on this Mac, which takes minutes per second of clip, and puts it in the gallery.' },
  ], '/guide/create/'),
  'mac-motion': one('How Motion Control works on a Mac', 'mac-motion', [
    { from: 0.3, text: 'On a Mac, Motion runs on LTX-2.3. The tab gets its Motion Control LoRA, about 650 MB.' },
    { from: 3.18, text: 'A start image and a motion clip. LU turns the clip into edges, and the video follows them.' },
    { from: 6.04, text: 'No prompt here. Length is the one setting, 49 frames make 2 seconds.' },
    { from: 7.94, text: 'Create makes the video on this Mac and puts it in the gallery.' },
  ], '/guide/create/'),
  workflows: {
    title: 'How your own workflows work',
    guide: '/guide/create/',
    films: [
      {
        id: 'comfy-workflow', label: 'Import and use',
        steps: [
          { from: 0.3, text: 'The workflow button opens Workflows. It takes a file saved with Save or Export in ComfyUI.' },
          { from: 3.18, text: 'Choose folder imports every .json in it, each with its own line. ComfyUI has to run for this.' },
          { from: 6.16, text: 'Give the workflow the tag its model has. The shared tag pairs the two.' },
          { from: 8.04, text: 'In Advanced settings, pick it under Workflow instead of Auto.' },
          { from: 11.18, text: 'Workflow parameters lists every node with its values. Change one, here the shift.' },
          { from: 13.92, text: 'The change goes into every run of this workflow. Reset goes back to the file.' },
        ],
      },
      {
        id: 'motion-own-workflow', label: 'In Motion Control',
        steps: [
          { from: 0.3, text: 'On Motion Control, Use your own ComfyUI workflow opens Workflows.' },
          { from: 2.28, text: 'Import your Wan 2.2 Animate workflow as ComfyUI saved it.' },
          { from: 5.06, text: 'Give it the tag of your Wan Animate model.' },
          { from: 6.84, text: 'In Advanced settings, pick it under Workflow for the Motion Control model.' },
          { from: 9.98, text: 'LU fills in model, seed, picture and clip, the rest runs as saved. A value you change here goes in too.' },
        ],
      },
    ],
  },
  chats: {
    title: 'How chats work',
    guide: '/guide/chat/',
    films: [
      {
        id: 'chat-branch', label: 'Branch',
        steps: [
          { from: 0, text: 'Regenerate keeps the earlier answer as a version.' },
          { from: 2.28, text: 'The arrows on the answer switch between the versions.' },
          { from: 4.36, text: 'Branch from here starts a new chat with the history up to that message.' },
          { from: 7.24, text: 'Duplicate chat in the chat list makes a full copy, kept versions included.' },
        ],
      },
      {
        id: 'persona-sampling', label: 'Persona',
        steps: [
          { from: 0, text: 'A persona you made has its own sampling values, under Settings, Agent, Personas.' },
          { from: 2.18, text: 'Fill in only what the persona needs. An empty field follows the chat.' },
          { from: 7.6, text: 'In the chat, the Sampling popup lists each speaker with the values that hold for it.' },
          { from: 11.76, text: "A value moved in this popup is the chat's own and wins over the persona." },
        ],
      },
    ],
  },
  'persona-sampling': one('How persona sampling works', 'persona-sampling', [
    { from: 0, text: 'A persona you made has its own sampling values, under Settings, Agent, Personas.' },
    { from: 2.18, text: 'Fill in only what the persona needs. An empty field follows the chat.' },
    { from: 7.6, text: 'In the chat, the Sampling popup lists each speaker with the values that hold for it.' },
    { from: 11.76, text: "A value moved in this popup is the chat's own and wins over the persona." },
  ], '/guide/chat/'),
  agent: one('How Agent works', 'agent', [
    { from: 0, text: 'Turn Agent on at the start of a chat. It first asks where to work.' },
    { from: 3.08, text: 'The workspace is a folder path jail, not a container or virtual machine.' },
    { from: 6.56, text: 'Tools switches tool categories on or off for this chat only.' },
    { from: 12.83, text: 'Before a command runs you approve or reject it; the arrow shows its arguments.' },
  ], '/guide/agent/'),
}

/** The Create tabs whose local lane has a film of its own. Every other film
 *  shows the cloud tabs and stands on the stage in Cloud mode only. */
const LOCAL_STAGE_TOPICS: Record<string, string> = {
  character: 'character-local',
  image: 'workflows',
  motion: 'workflows',
}

/** The same on a Mac, whose local lanes run on MLX and are filmed apart. */
const MAC_STAGE_TOPICS: Record<string, string> = {
  image: 'mac-hires',
  edit: 'mac-mask',
  removebg: 'mac-cutout',
  upscale: 'mac-upscale',
  character: 'mac-character',
  music: 'mac-music',
  video: 'mac-video',
  extend: 'mac-video',
  lipsync: 'mac-lipsync',
  motion: 'mac-motion',
}

/** The film a Create stage offers for this tab and backend, or null. */
export function stageHowtoTopic(intent: string, backend: string, mac = false): string | null {
  const topic = backend === 'cloud' ? intent : (mac ? MAC_STAGE_TOPICS : LOCAL_STAGE_TOPICS)[intent]
  return topic && HOWTO[topic] ? topic : null
}
