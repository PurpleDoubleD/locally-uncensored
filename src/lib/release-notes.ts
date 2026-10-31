/**
 * What is new in this version, shown once after an update (B4, 2026-08-04).
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

import { CLOUD_PITCH, CLOUD_REFUSAL_LINE, CLOUD_SUBSCRIBER_LINE, cloudSalesLines } from './cloud-pitch'

/**
 * The two model numbers the 3.0.0 sheet quotes, in one place and read, never
 * typed.
 *
 * The catalogue itself lives in the web repository, in
 * the web app; this app reads it from the server at run
 * time and ships no copy of it. `src/lib/cloud-pitch.ts` is where the counts
 * that have to exist before anyone signs in are written down, and
 * `scripts/check-cloud-sales.mjs` pins every one of them to that file in the
 * web repository. That script is RUN BY HAND before a release: it needs a
 * checkout of the web repository as its argument and therefore stands in no
 * workflow and in no npm script. Nobody may rely on it catching a drift on its
 * own. What runs on every commit is the literal tripwire in
 * `__tests__/die-verkaufszahlen-sind-von-hand-gehalten.test.ts`; it holds the
 * seven numbers in `cloud-pitch.ts` against written-out values, so a changed
 * number has to be changed twice, on purpose.
 *
 * This is not decoration. The sheet quoted a denominator of 46 while the guard
 * on the same commit printed "27/47 chat", because one number was prose and the
 * other was read from its source. Prose cannot be wrong out loud, which is also
 * why the test forbids the typed form outright instead of only checking that
 * today's digits happen to be right.
 */
/**
 * Der Nenner der Marke ist der MESSLAUF, nicht der Katalog (R2-10, R6-5).
 *
 * Stand dort der Katalog, behauptete das Blatt, jedes Katalogmodell sei
 * gemessen worden, und die Differenz zur Markenzahl seien Durchgefallene.
 * Gemessen wurde nur, was am Tag des Laufs im Katalog stand; V4.1 Flash kam am
 * selben Tag danach dazu und traegt bis zu seiner Messung keine Marke. Der
 * Katalog steht weiter im Blatt, aber in seinem eigenen Halbsatz statt als
 * Nenner einer Aussage, die er nicht traegt.
 */
export const SHEET_CHAT_MODELS = CLOUD_PITCH.measuredChatModels
export const SHEET_CATALOGUE_MODELS = CLOUD_PITCH.chatModels
/**
 * Die Markenzahl steht seit dem Entscheid vom 12.09.2026 auf der STRENGEN
 * Regel: nur ein Modell, das in beiden Laeufen beide Fragen beantwortet hat,
 * traegt die Marke. Ihre Quelle ist `no-refusals-measurement.md`, und der
 * Waechter zaehlt dort die Zeilen, statt eine zweite Zahl zu tippen.
 */
export const SHEET_MARKED_MODELS = CLOUD_PITCH.unfilteredChatModels

/**
 * Die Tagesgrenze der Flash-Klasse, formatiert wie im Kundentext (R5-44).
 * Getippt stand sie dreimal neben derselben Zahl aus CLOUD_PITCH und konnte
 * still auseinanderlaufen.
 */
const FLASH_DAILY = CLOUD_PITCH.flashDailyTokens.toLocaleString('en-US')

/**
 * One change line.
 *
 * The historic shape is a plain string: the long, exact text a guard or
 * CHANGELOG.md binds to, shown as-is. The sheet redesign (Bauer, Runde 2,
 * 19.09.2026) adds a second shape for a line that also carries a short,
 * plain-language `title`: the sheet then shows the title and reveals `detail`
 * only once that one row is opened. A line written before this addition, or
 * one nobody has rewritten yet, stays a plain string and renders exactly as
 * it always has, title and detail being the same text.
 */
export type ReleaseNoteItem = string | { title?: string; detail: string }

/** The long text bound to CHANGELOG.md and to the wording guards, whichever shape the line has. */
export function itemDetail(item: ReleaseNoteItem): string {
  return typeof item === 'string' ? item : item.detail
}

/** The short line the sheet shows first; falls back to the long text when no title was written. */
export function itemTitle(item: ReleaseNoteItem): string {
  return typeof item === 'string' ? item : (item.title ?? item.detail)
}

export interface ReleaseNoteSection {
  title: string
  items: ReleaseNoteItem[]
}

export interface ReleaseNote {
  /** Exact version string, matched against package.json. */
  version: string
  /** One line the user reads first. */
  headline: string
  /**
   * Der Cloud-Block, der VOR allem anderen auf dem Blatt steht
   * (13.09.2026).
   *
   * Dieselben drei Zeilen und derselbe Abo-Satz wie im Verkaufs-Panel am
   * Wolkenschalter, aus denselben Konstanten. Das Blatt ist die einzige
   * Stelle, an der ein bestehender Kunde nach einer Aktualisierung etwas
   * erfaehrt, also steht das Angebot dort oben und nicht zwischen den
   * Fehlerbehebungen.
   *
   * Optional: nur das Blatt der laufenden Version traegt ihn. Eine alte Notiz
   * bekommt rueckwirkend kein Angebot.
   */
  cloud?: {
    /** Die drei gezaehlten Zeilen. */
    lines: string[]
    /**
     * Der Messsatz zur Verweigerungsquote, zeichengleich mit dem CHANGELOG.
     * Die Zahl darin ist aus der Messdatei gerechnet, nicht getippt.
     */
    measured: string
    /** Der Abo-Satz, zeichengleich mit Panel, CHANGELOG und Guthaben-Dialog. */
    note: string
  }
  /** Two to five short lines. Anything longer goes into `details`. */
  lines: ReleaseNoteItem[]
  /** The full list behind the expander, grouped into sections. */
  details?: ReleaseNoteSection[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
  // 3.0.9 (31.10.2026, Kandidat integ/309, I1). Der Umfang steht im
  // CHANGELOG-Entwurf von T1 (Zentrale/entwuerfe/309-release); dieses Blatt
  // nimmt vorn die fuenf Dinge, die ein Nutzer zuerst merkt. Was nur in Tests
  // oder auf einer Karte lief, sagt die Zeile selbst knapp.
  {
    version: '3.0.9',
    headline: 'Group chats send every speaker the context you picked, Neurons puts sliders on a local model, and Animate and Create take end images and reference pictures.',
    lines: [
      {
        title: 'Group chat: every speaker gets the context you picked.',
        detail: 'Local speakers get their chosen window minus room for the answer, no longer about half of it, and a grey line names messages that were not sent. One speaker can be regenerated on its own, and the speaking order can be changed with arrows or by dragging (GitHub #199, #200, #201).',
      },
      {
        title: 'Neurons: sliders that steer a local LU Engine model.',
        detail: 'Ready made sliders such as Serious to Cheerful or Fewer refusals, sliders from your own examples, and a before and after on the same question. LU measures how far each slider can push on your model; on a Qwen3.5 9B that took about five minutes on a CPU. Ollama and LM Studio cannot take these sliders.',
      },
      {
        title: 'End images and reference pictures in Animate and Create.',
        detail: 'Animate takes an end image for Wan 2.2 A14B, Wan 2.1 FLF2V and MiniMax H3, and up to nine reference pictures with MiniMax H3. Create takes reference pictures for Krea 2, Qwen-Image 2.1 and FLUX.2. A video shows a preview while it renders. The local end image and the preview ran on an RTX 3060; the reference pictures ran in automated tests only.',
      },
      {
        title: 'A compaction is one line, and what came before stays readable.',
        detail: 'The chat starts at the newest compaction, and marks on the left open each earlier stretch, read only. A new setting, off by default, brings back up to four older messages close in meaning to the new one.',
      },
      {
        title: 'Liquid LFM3 and a newer llama.cpp in the LU Engine.',
        detail: 'LFM3 text, vision, omni and audio models run in the LU Engine, which now uses llama.cpp b11960. The onboarding lists the LU Engine models you already have, and Train new on Windows and Linux says it trains Z-Image (GitHub #210).',
      },
    ],
  },
  // 3.0.8 (26.10.2026, Kandidat integ/308-rc, A23). Der Umfang steht in
  // CHANGELOG.md unter [3.0.8]; dieses Blatt nimmt vorn die fuenf Dinge, die
  // ein Nutzer zuerst merkt, und darunter den Rest in Abschnitten. Das Blatt
  // von 3.0.7 sieht nach dem Update niemand mehr (releaseNotesStore zeigt nur
  // die laufende Version), darum steht die Korrektur zu den Cloud-Charakteren
  // hier vorn. Was nur in Tests lief, sagt die Zeile selbst knapp, der
  // CHANGELOG unter Known limits ausfuehrlich.
  {
    version: '3.0.8',
    headline: 'Web search finds answers again, a video from the chat plays in the chat and renders while you write on, and LU can read and change its own settings when you ask.',
    lines: [
      {
        title: 'Web search asks five services in turn, no key needed.',
        detail: 'The chat\'s web search asks Exa first, then You.com, a SearXNG instance, DuckDuckGo and Wikipedia, and moves on when one does not answer. A key for Brave, Tavily or Exa goes first. web_fetch reads a page on your machine the way a reader view does and falls back to Exa when it cannot, which then sees the address of that page. LU Cloud chats use the same search, running in the app.',
      },
      {
        title: 'A video made in the chat plays in the chat, and a long one renders in the background.',
        detail: 'A clip made in Chat, Agent or Code plays with controls instead of showing as a broken picture, also after a restart. When a render takes longer than a short wait, the turn ends and the clip appears in the message that asked for it while you write on. Wan 2.1 clips are mp4 now.',
      },
      {
        title: 'A Z-Image character trained on LU Cloud can run on your machine.',
        detail: 'Only a Z-Image character can be saved for local use. Characters of other model families now show a fixed Cloud only label on the cloud character shelf instead of the Use locally button, and cloud training says under the model pick that characters trained on Flux or Qwen run in LU Cloud only. The 3.0.7 notes said every cloud character could run on your machine; that was wrong.',
      },
      {
        title: 'Ask the chat to read or change a setting.',
        detail: 'Questions like "what is my temperature?" or "turn on auto compact" reach LU\'s settings. Every change shows a card with the old and the new value, Accept and Decline, and stays as a row with Undo. Computer control, remote access, the Local API, permissions, keys, paths, plugins and persona texts cannot be changed this way.',
      },
      {
        title: 'The temperature stops at 1.5, where models still write sense.',
        detail: 'At 1.9 every model wrote mixed-language noise. The sliders stop at 1.5, a value above it from an older version goes back to the default, and from 1.2 a warning says what high values do and offers Reset. Agent turns hold their own ceiling of 1.0.',
      },
    ],
    details: [
      {
        title: 'Chat',
        items: [
          {
            title: 'A picture attached in the chat reaches the image tool.',
            detail: 'image_generate and video_generate failed with "could not read input image". The attachment now goes in by its number in the chat, and an edit works also when ComfyUI had not been started.',
          },
          {
            title: 'The answer starts sooner in a long chat.',
            detail: 'The clock, memories and retrieved passages rode in front of the whole conversation, so every new message made the engine read the entire chat again. They now ride behind the newest message. Measured on one Mac and one Windows machine: the first step of the second message went from 10.1 s to 0.9 s and from 5.7 s to 0.8 s.',
          },
          {
            title: 'Tokens per answer and /usage.',
            detail: 'Each reply shows the tokens it took, and /usage in the chat sums up the conversation.',
          },
          {
            title: 'REA shows only in Agent and Code.',
            detail: 'The REA plugin and its switch sit under Plugins in Agent and Code only, the two places its tools reach. Plain chat no longer shows them.',
          },
          {
            title: 'A half-written message waits for you.',
            detail: 'Text and attachments in the message field of a chat stay when you open Create, Models or Settings and come back, each chat with its own. They are kept while the app runs, not across a restart.',
          },
          {
            title: 'Memories can be deleted again.',
            detail: 'The delete buttons are always visible; one, several or all memories can be deleted with a confirmation and Undo, and a deleted memory is not brought back by the automatic extraction.',
          },
          {
            title: 'In Code, the mode the button shows is the mode the run gets.',
            detail: 'On the start screen the button could show Ask while the first run took the mode picked last somewhere else, Bypass included. The pick on the start screen now counts, and when the two disagree the stricter one runs. Under Ask, REA and every other external tool now ask first, like a shell command.',
          },
          {
            title: 'REA finds Node.js and keeps its tools.',
            detail: 'REA looks for Node.js where a terminal finds it, also when LU starts from a menu, and its tools stay on a follow-up message. A model that repeats the same plan in alternation is steered once and then stopped.',
          },
          {
            title: 'Binary files reach the tools with their full path.',
            detail: 'A ROM or another binary attached in Agent or Code goes to the working folder, the model gets its full path, and the chip says where an attached file goes.',
          },
        ],
      },
      {
        title: 'Create',
        items: [
          {
            title: 'Wan 2.2 14B runs from Animate and Video.',
            detail: 'LU loaded the 5B model\'s VAE for the 14B models and the run stopped with a tensor size error. With the high noise and the low noise model in the same folder, LU runs both one after the other (GitHub #193). A real 14B render has not run on our machines.',
          },
          {
            title: 'Native HiRes in Edit, and HiRes at the right size on every model.',
            detail: 'Edit has the HiRes switch Create has, on local ComfyUI and on a Mac. On Qwen-Image 2.1, Noct Q, FLUX 2 and ERNIE-Image the second pass made the picture four times the size with doubled faces; it now follows the model\'s own grid. Width and height can be typed by hand.',
          },
          {
            title: 'The image and video tools of the chat end honestly.',
            detail: 'A render that stopped or never started is not reported as delivered, Stop ends exactly that render, "attachment 2" or an earlier result by its name is the picture that is used, and a ComfyUI that crashed is called a crash with its last error line.',
          },
          {
            title: 'Train new on a Mac shows the trigger word field.',
            detail: 'Without Z-Image Turbo installed the field was missing and the tab looked broken. It now shows with a button to install the model, and Create says so before the photos are staged (GitHub #194).',
          },
          {
            title: 'Character Studio finds its base files.',
            detail: 'Download base files always says what happened; it used to call files missing that ComfyUI already had and then do nothing. A folder with just a main.py is no longer taken for ComfyUI, and Comfy Desktop\'s installs are found.',
          },
          {
            title: 'Edit images are named the way the Qwen encoders label them.',
            detail: '"image 2", "IMAGE 2." and "picture 2" reach the model the same way, and each tile in the reference strip shows its name. The large view opens with the prompt folded, steps with the arrow keys and zooms with the mouse wheel.',
          },
        ],
      },
      {
        title: 'Models and engines',
        items: [
          {
            title: 'Remove refusals from a local model (Abliteration).',
            detail: 'A button in the Model Manager makes a copy of an installed GGUF that refuses fewer requests, next to the original, which stays untouched. LU shows the license, plans memory, disk and time first, and checks original and copy with the same short prompts. It has run from the command line on a Mac; the run through the app is new.',
          },
          {
            title: 'The LU Engine plans memory from the model file.',
            detail: 'When a model does not fit, the notice says how many layers fit at your context and at a shorter one, with buttons Context 16K and KV q8_0. On Windows the engine no longer keeps a second copy of the model in RAM.',
          },
          {
            title: 'The LU Engine starts with a user name outside English.',
            detail: 'A Windows user folder such as "Şaban Yılmaz" stopped the engine with "not a directory" (GitHub #190). On a Mac the image and video engines pass over a Python their packages do not exist for, such as 3.15 (GitHub #188), and the Linux AppImage keeps its icon (GitHub #191).',
          },
          {
            title: 'A graphics card per task.',
            detail: 'With two cards, Settings can put the chat model on one and ComfyUI on the other. This has run with simulated cards only.',
          },
          {
            title: 'AMD and Intel Arc on Windows get their own PyTorch.',
            detail: 'AMD cards get AMD\'s current ROCm build, Intel Arc the XPU build. It has not run on an AMD card here.',
          },
        ],
      },
      {
        title: 'Settings, storage and your phone',
        items: [
          {
            title: 'One Storage folder for models, gallery and runtime.',
            detail: 'Settings, AI Backends, Storage shows what goes where and the free space per drive. "Use for new files only" moves nothing, "Move the files and use it" moves file by file, overwrites nothing and can be cancelled.',
          },
          {
            title: 'Your phone on this computer (Remote).',
            detail: 'Pair a phone by QR code; the channel is sealed, over the wi-fi and, with "Reach this computer from anywhere", over the internet. The phone app that pairs with this ships in its own release.',
          },
          {
            title: 'LU Cloud says when it has an outage.',
            detail: 'When LU Cloud announces an outage, the app shows a short line you can close, and a failed cloud run says what is going on instead of a raw error.',
          },
          {
            title: 'The onboarding no longer runs twice, and icons show in light mode.',
            detail: 'A first start on Windows ran the onboarding twice. In light mode the icons of the gallery, the large view, Voice and elsewhere were invisible.',
          },
        ],
      },
    ],
  },
  // 3.0.7, vorbereitet am 14.10.2026 auf integ/307, am 15.10.2026 um alles aus
  // 3.0.8 erweitert (Davids Wort: 3.0.8 kommt in 3.0.7; Stand e5dc1f4a0). Umfang:
  // alle Commits seit 3.0.6 (origin/master..HEAD), der Pruefstand in
  // Zentrale/desktop-307-stand.md, der Windows-Lauf d308-a (lu-astra/proof/
  // d308-a/BERICHT.md) und die Mac-Echtlaeufe (lu-astra/proof/mac/
  // release-saetze-307-mac.md, deren Saetze hier und im CHANGELOG stehen).
  // Vorn stehen die fuenf groessten Neuerungen: Charaktere ueberall (C1),
  // Workflows im normalen ComfyUI-Format mit Node packs (D8, D9), Edit mit
  // bis zu zehn Bildern (D11), Verzweigen und die Gruppenchat- und
  // Persona-Fixes (E9, issue 165, 169, 170, 174) und am Mac Training,
  // Talking Character und Motion Control (M10 bis M12).
  // Jeder Posten traegt seinen Baustein: faellt eine Funktion aus dem Umfang,
  // faellt genau dieser Posten mit, im CHANGELOG ebenso (dort ohne Marke, mit
  // demselben Titel, wo es einen gibt). Die Bausteine: C Charaktere und
  // Kopfzeilen, D Create, E Chat und Code, F lokale Modelle und Engines,
  // G Voice, Fernzugriff und Einstellungen, S Sicherheit (nur allgemein, ohne
  // Angriffsweg), M Mac. Was nur in Tests lief, sagt es, hier knapp, im
  // CHANGELOG unter Known limits ausfuehrlich. Issue 156 steht mit d2e02422b
  // (GPU layers auto) drin. 3.0.6 darunter bleibt unveraendert.
  // Nachzug 18.10.2026 auf integ/307 de9cd0de6: die Zweige mac/307-funde,
  // mac/307-rea, mac/307-gate, mac/307-comfy-edit, mac/307-civitai-installed,
  // mac/307-persona-note und feat/howto-into-307, dazu der Windows-Lauf d307-j
  // (lu-astra/proof/d307-j/BERICHT.md), der die Issues 165, 167, 170 bis 177
  // in der App geprueft hat. Die Saetze ueber den Pruefstand folgen ihm.
  {
    version: '3.0.7',
    headline: 'Trained characters work in every part of Create and in chat, ComfyUI workflows import the way ComfyUI saves them, Edit takes up to ten images, and a chat can be duplicated or branched. On a Mac, character training, Talking Character and Motion Control now run on your own machine.',
    lines: [
      // Baustein C1
      {
        title: 'A trained character works in every part of Create and in chat.',
        detail: 'When Create runs on ComfyUI, Image, Edit and every video tab have a character chip next to the model chip. On Image and Edit the character\'s LoRA and trigger word go into the run, and the pick sets the Z Image model it was trained for. Edit with a mask does not take a character. On Video, Animate, Extend, Multishot, MiniMax H3, Motion Control and Talking Character, LU first makes a picture of the character and then starts the clip from it, shown as Step 1 of 2 and Step 2 of 2. A start image of your own wins. A video model that only takes text, or a tab with no video model installed, says so before anything runs. In chat, the image and video tools take a character by name or trigger word. We checked this in the app on Windows with a stand-in character, and the clip step has not run with a real video model yet.',
      },
      // Baustein D8 und D9
      {
        title: 'ComfyUI workflows import the way ComfyUI saves them, with their node packs.',
        detail: 'The Workflows view takes a workflow saved with Save or Export in ComfyUI, not only the API format, and imports a whole folder at once. Subgraphs, such as in the stock Z-Image templates, are unpacked. When a workflow needs nodes ComfyUI does not know, LU offers the node pack where it knows it, and Settings, AI Backends lists, installs, updates and removes node packs on Windows and Linux. A ComfyUI that runs is needed for the import. We imported templates, one of them with a subgraph, and installed a pack in the app on Windows; a picture from a subgraph template has not been made yet.',
      },
      // Baustein D11
      {
        title: 'Edit takes up to ten images with Qwen-Image 2.1.',
        detail: 'On your own machine the reference strip takes up to nine images next to the source, on Windows and Linux through ComfyUI and on a Mac through the built-in engine. When there are more images than fit at full size, each one is scaled smaller, and on ComfyUI a smaller graphics card takes fewer at full size. The hint asks you to say what each image brings. On a Mac the strip offers only as many images as the memory takes. Ten images at 640 pixels ran on a Mac with the real engine; on Windows and Linux they have not run with a real model yet.',
      },
      // Baustein E9 (issue 165, 169, 170, 174)
      {
        title: 'Duplicate or branch a chat, and group chats keep each turn with its persona.',
        detail: 'Duplicate chat makes a full copy of a chat, and Branch from here on any message starts a new chat up to that message. Regenerate keeps the earlier answer as a version you can switch back to (issue 174). The persona picked in Plugins is now the one that is sent (issue 170). In a group chat a member whose model left the model list sits out instead of being answered by another model, and a turn stays with the persona that wrote it after that persona moves to another model (issue 165, issue 169). We checked Duplicate chat, Branch from here, the kept answers, the persona fix and a member that sits out in the app on Windows.',
      },
      // Baustein M10 bis M12
      {
        title: 'On a Mac, character training, Talking Character and Motion Control run locally.',
        detail: 'Character Studio trains a Z Image character on the Mac; on an M5 Pro the Standard setting runs a little over two hours. Talking Character turns a portrait and a voice into a clip with LTX-2.3 4-bit, roughly 150 seconds per second of clip on an M5 Pro. Motion Control makes a video that follows a motion clip. All three ran with the real engine on one Mac with 48 GB. This is on macOS only.',
      },
    ],
    details: [
      {
        title: 'Characters',
        items: [
          // Baustein C6
          {
            title: 'Use frames of a video for a character.',
            detail: 'The lightbox and the large view of a video offer Use frames for a character. LU takes 8 frames spread evenly over the clip, 4 to 20 with the slider. Untick the frames that do not show the figure, then train with the rest in Character Studio or save them as a character. This has run in automated tests only.',
          },
          // Baustein C7
          {
            title: 'A trained local character can be deleted.',
            detail: 'The Use character shelf has a delete button for a character trained on this machine. It asks first, and the file goes to the Recycle Bin or Trash.',
          },
          // Baustein C8
          {
            title: 'A Z-Image character trained on LU Cloud can run on your machine.',
            detail: 'Use locally on the cloud character shelf saves a Z Image character into the LoRA folder of this machine, so the local Use character shelf lists it. If a file of that name is already there, LU stops and says so instead of replacing it. Characters of other model families are refused with the reason. This has run in automated tests only, not yet against the real service.',
          },
          // Baustein C9
          {
            title: 'Edit can use the photos a character was trained on.',
            detail: 'The reference strip in Edit has a Trained characters row. A click adds up to three of the photos a local character was trained on as references, at most 1024 pixels each. A character trained before this version has no photos there. It has not been tried with a real training set yet.',
          },
          // Baustein C10
          {
            title: 'A trained character brings the model it was trained for.',
            detail: 'Picking a character under Create, Character, Use character left the image model as it was, and on a model of another family the run left the character out. The pick now sets an installed Z Image model. Where none fits, the line under the character says so with a button to switch, and Create does not start a run that would ignore the character. The same line now says to describe the key features in the prompt too, because the trigger word alone often does not hold the look (issue 161).',
          },
          // Baustein C11
          {
            title: 'Train a character that changes clothes.',
            detail: 'The Train tab of local character training (Windows, Linux and Mac) has a short text field under each photo. Name what changes from photo to photo there, like clothes, hair or place, and it goes into that photo\'s caption after the trigger word, so the trained character keeps its face and body but not one outfit. Describe photos fills the empty fields with the local chat model picked in Chat, when that model can see images; it never sends the photos to a cloud model.',
          },
          // Baustein C12
          {
            title: 'Low VRAM training for cards under 12 GB.',
            detail: 'On Windows and Linux, local character training has a second setting, Low VRAM, which trains at 512 px with a smaller LoRA and keeps more in system memory. Each step takes clearly longer and fine detail comes out softer. It lets cards from about 8 GB train; that is worked out from the trainer\'s own numbers and not yet measured on such a card.',
          },
          // Baustein C13
          {
            title: 'Character Studio names only the base files that are missing.',
            detail: 'It said about 19 GB above the button whatever was missing. It now names the missing files with their size, downloads only those, and counts the progress over them alone.',
          },
        ],
      },
      {
        title: 'Create',
        items: [
          // Baustein C2
          {
            title: 'Enhance Image runs on your own machine.',
            detail: 'On Windows and Linux, Enhance Image is a local tab that runs on ComfyUI and makes a picture 2x or 4x larger. Without an upscale model the stage offers Real-ESRGAN x4plus, a 67 MB download that LU checks against its checksum. The result lands in the gallery with the model it ran on and its real size. A Mac runs Enhance Image with a model of its own, see below.',
          },
          // Baustein C4
          {
            title: 'The gallery sorts into folders and shows how a result was made.',
            detail: 'The Folders button makes, renames and removes folders, and Move to folder sits on each tile and in the large view. A folder is only a label: the files stay where they are, and removing a folder keeps its pictures. While a folder is open, new results land in it. Under a result, Prompt and settings lists the negative prompt, model, steps, CFG, sampler, seed and size, with one button that copies all of it.',
          },
          // Baustein D10 (issue 8)
          {
            title: 'Every setting of an imported workflow can be changed in Create.',
            detail: 'Under Advanced settings, a workflow from the Workflows view shows its nodes with their values, such as the VAE, LoRA strength, denoise or any value of a custom node, with the limits and choices ComfyUI states. What LU sets on its own is named and not offered twice. Changes are kept per workflow, and Reset goes back to the values in the file. Windows and Linux. We checked it in the app on Windows (issue 8).',
          },
          // Baustein D12
          {
            title: 'A LoRA from a CivitAI or Hugging Face link.',
            detail: 'Models, LoRAs, Get new takes a CivitAI model link or a Hugging Face link to a .safetensors file. LU reads the name, base model and size before anything is downloaded, checks the file against its SHA256 when the site states one, and puts it in the LoRA folder. A checkpoint or any other model that is not a LoRA is refused, and a file of the same name is never replaced. We downloaded a LoRA and saw checkpoints refused in the app on Windows.',
          },
          // Baustein D13
          {
            title: 'Create shows how many images a run makes next to the Create button.',
            detail: 'One click picks 1 to 8 locally or 1 to 4 in LU Cloud; before, the number was only in Advanced settings.',
          },
          // Baustein D1
          {
            title: 'Each local video family has its own clip length.',
            detail: 'The Frames slider ran from 1 to 120 for every local video model, below the default of MiniMax H3, LTX 2.5 and Cosmos. MiniMax H3 now goes up to 362 frames, 15 seconds at 24 frames per second, and MiniMax H3 and LTX 2.5 move in the steps their runs use, so the slider shows the length you get. This has not run with a real video model yet.',
          },
          // Baustein D2
          {
            title: 'Animate can start from a reference picture with Wan 2.1 VACE.',
            detail: 'With a Wan 2.1 VACE model installed, Animate uses your picture as the reference for the clip. Phantom, MAGREF, the VACE add-on modules, Wan 2.2 VACE Fun and reference files LU does not know are listed in Animate with the reason they do not run yet. Wan 2.1 VACE has not run with a real model yet.',
          },
          // Nachzug fix/307-comfy-shared-dirs (issue 183)
          {
            title: 'Downloads and trained LoRAs go to the folders you set up for ComfyUI.',
            detail: 'With a shared model folder set up in extra_model_paths.yaml, LU still put downloads, trained LoRAs and gallery deletes against the ComfyUI folder itself (issue 183). LU now reads that file the way ComfyUI does, the input, output and model path folders of ComfyUI\'s start script and the setup of ComfyUI Desktop. A model goes into the folder marked is_default, else the first folder you set for that kind, else the ComfyUI folder as before, and a ComfyUI that LU starts gets the folders of your start script too. Models already in the ComfyUI folder still count as installed. Settings, ComfyUI lists the folder LU uses for each kind of model and for input and output. We checked it in the app on Windows with a shared folder and a stand-in ComfyUI.',
          },
          // Baustein D3
          {
            title: 'Create sees model files you copied in by hand.',
            detail: 'Create read the ComfyUI model and LoRA lists only when it opened, so a file copied into a ComfyUI folder by hand stayed invisible until you left Create. Coming back to the app now reads both lists again, at most every 30 seconds and not while a run is going.',
          },
          // Baustein D4
          {
            title: 'The mask editor shows Ctrl shortcuts on Windows and Linux.',
            detail: 'Undo and Redo were labelled with the keys of a Mac. They now read Ctrl+Z and Ctrl+Y.',
          },
          // Baustein D6
          {
            title: 'A model too big for this machine points to LU Cloud.',
            detail: 'In the Model Manager, a model that does not fit the graphics card, or the memory of a Mac, says so on its tile with one Try LU Cloud button, for example: Too big for this graphics card. Videos run on LU Cloud. A chat model leads to the cloud chat models, an image or video model to Create in Cloud mode on the same tab. Create shows a line of the same kind when the picked local model is too big, when a video model only partly fits the card, or when a video run on a Mac would take long, and that line can be closed. A number of credits stands there only where the app knows the price. Nothing of this shows in Cloud mode or with Show Cloud features in Local mode off. This has run in automated tests only.',
          },
          // Baustein D7 (D27)
          {
            title: 'Create honours the image and video timeouts from Settings.',
            detail: 'A run that shows no progress is stopped after the minutes set in Settings, General. Before, Create always waited 20 minutes for images and 60 for video, whatever was set there. Before it stops a run, LU asks ComfyUI whether the run is still going, so a long silent step at the end is not cut off. The defaults are unchanged.',
          },
          // Baustein D14
          {
            title: 'A switch between Cloud and Local clears the red message of the other mode.',
            detail: 'Before, a message such as Use locally failed stayed on screen after the switch to Local.',
          },
          // Baustein D15
          {
            title: 'The settings of a music track name its seed.',
            detail: 'Prompt and settings named only the model.',
          },
          // Baustein D5
          {
            title: 'Smaller fixes in Create.',
            detail: 'A wide result fits the stage with its prompt below it. Cloud mode no longer shows the load error of the local models. A tooltip no longer opens when the focus comes back to its button. Rewritten by names the chat model the way the picker does. The first image of a list keeps its file name. A second Enhance of the same picture no longer says Queued to the end. Erase and Edit show the mask state as it is, and the mask editor no longer points Erase to a prompt field it does not have. The model chip of Character says to pick a character first. In the lip sync tool, the voice maker row stays inside its panel when you describe a voice. The how-to line at the foot of the stage no longer makes a narrow stage with a source picture scroll.',
          },
          // Nachzug mac/307-comfy-edit (Discord)
          {
            title: 'An Edit with several images on ComfyUI fits the graphics card.',
            detail: 'An Edit with more than two images could end in aimdo memory compile error, which ComfyUI raises when the card has no more memory for the run. With Qwen-Image 2.1 the images now share a budget by the card: two at full size below 16 GB, three on a 16 GB card, four on larger cards or when LU cannot read the size, and more images are each made smaller. Qwen-Image-Edit is refused before the run when the images do not fit, with how many to remove. A Mac is not affected. This has run in automated tests only.',
          },
          // Nachzug mac/307-funde (Discord)
          {
            title: 'Motion Control has a prompt field only where the run reads one.',
            detail: 'The prompt field could not be typed into with only a picture or a clip in place, and it disappeared once both were in. On ComfyUI and on a Mac the field now takes typing at any time and the prompt is optional. LU Cloud\'s Motion Control takes no prompt, and its note says so.',
          },
          // Nachzug mac/307-funde (Discord)
          {
            title: 'A long prompt leaves the stage room for progress and the result.',
            detail: 'The prompt field grew to 220 pixels in every window and hid the progress and the finished picture. It now grows to 220 pixels or 16 percent of the window, whichever is less, and scrolls beyond that.',
          },
          // Nachzug mac/307-funde (Discord)
          {
            title: 'The help says what the text encoder is and what Improve my prompt does.',
            detail: 'The Text encoder row says that the encoder is part of the image model and reads the prompt on every run, and that Improve my prompt is a separate step before it.',
          },
          // Nachzug mac/307-funde
          {
            title: 'Wan 2.1 says where its clips turn restless.',
            detail: 'On Windows and Linux the Frames slider of Wan 2.1 goes to 121, but the model learned its clips at 81 frames. Past 81 a line under the slider says so and points to Extend Video.',
          },
          // Nachzug fix/307-howto-round2 und feat/howto-into-307
          {
            title: 'How it works has films for this release.',
            detail: 'The help has new short films for characters, Branch and Persona in a local chat, persona sampling, dictation and your own ComfyUI workflows. On a Mac, Character with Train new, Music, Talking Character, Motion Control and video have films of their own.',
          },
        ],
      },
      {
        title: 'Chat and Code',
        items: [
          // Baustein C3
          {
            title: 'Character cards become personas, with a greeting and an export.',
            detail: 'Import a character card as a PNG or JSON file (card versions 1, 2 and 3) and it becomes a persona with the card picture as its tile. A new chat with that persona opens with the card\'s greeting as the first answer, and you can switch between alternate greetings with arrows until you write. A card persona exports back as a version 2 JSON file. We checked it in the app with Holo and Qwen models.',
          },
          // Baustein C5
          {
            title: 'Read aloud speaks what the answer shows.',
            detail: 'With a thinking model the answer looked clean, but the voice also pronounced reasoning markers that stood nowhere on the screen. The Read aloud button and the automatic reading of a new answer now take the same cleaned text the bubble shows. A thought that Gemma 4 writes into its answer goes to the thinking block and is no longer part of the answer, and in Voice a thought whose marker arrives in pieces is no longer spoken (issue 160). A model that loops and closes its thought many times no longer leaves the extra closing markers in the answer or in the voice.',
          },
          // Baustein E10 (issue 175)
          {
            title: 'Sampling values per persona and per group member.',
            detail: 'The persona editor takes its own temperature, top P, top K, min P, max tokens, penalties and DRY multiplier. They apply wherever the persona speaks, also on its seat in a group chat, and the chat\'s own Sampling popup still wins. Each value is only sent to a backend that reads it (issue 175). We checked in the app on Windows that a persona\'s values reach the LU Engine.',
          },
          // Baustein E11 (issue 172)
          {
            title: 'Editing an earlier message no longer sends it or deletes the rest.',
            detail: 'The edit field now has Cancel, Save and Save & resend. Save changes the text only and keeps every later turn, and Save & resend keeps the old answers as a version (issue 172). We checked it in the app on Windows with the LU Engine.',
          },
          // Baustein E12 (issue 171)
          {
            title: 'An attached text file fits the model\'s context.',
            detail: 'A text file was cut to its first 4000 characters without a word. The chat now keeps the whole text and sends as much as fits the model\'s window next to the conversation, and says so when it had to cut. A new setting, Attached file limit, caps the share. A group chat export names the persona and model of every answer (issue 171). On Windows a long Japanese text file went to the LU Engine whole; a file too long for the window has run in automated tests only.',
          },
          // Baustein E13
          {
            title: 'A ChatGPT export becomes real chats.',
            detail: 'Settings, General, Import from other chatbots takes the .zip of ChatGPT\'s data export. Each conversation you pick becomes its own chat with its title, date and the messages of the thread you saw. A conversation imported before is not added twice, and a chat you went on with in LU is never replaced. Images and files are not copied. We imported an export built in ChatGPT\'s format in the app on Windows; a real export has not been tried yet.',
          },
          // Baustein E1
          {
            title: 'Any file can go into the chat, and a file the model cannot read says so.',
            detail: 'Attaching a file that is not text, such as a program or an archive, now says above the chat that models cannot read it, with its name, type and size, and points to Agent or Code. In Agent and Code the file goes into the working folder, and the model gets its name, type, size, SHA-256 checksum and path, with the instruction not to run it unless you ask. The limit is 256 MB per file, up from 64 MB.',
          },
          // Baustein E2
          {
            title: 'A think budget for the backends that take one.',
            detail: 'Think budget sits next to Think in the sampling popup and in Settings, Generation. It sets how many tokens a model may spend on thinking. 0 keeps the automatic choice, which on the LU Engine now follows the effort setting below. It works with the LU Engine and with Anthropic. For Ollama, LM Studio, other OpenAI-compatible servers and LU Cloud the field is off and says it is not supported there. We checked it with the LU Engine on Windows; with Anthropic it has run in automated tests only.',
          },
          // Baustein E7 (issue 176)
          {
            title: 'Reasoning effort for local models.',
            detail: 'The effort button next to Think, Low, Medium, High and Max, existed only for hosted models (issue 176). Local models now have it in the form each server reads. The LU Engine passes the level to the model\'s chat template, and Low and Medium also set a think budget of 1024 and 4096 tokens unless you set one yourself. LM Studio 0.4.8 and later gets the levels it lists for each model. KoboldCpp gets Low, Medium, High and Max, where Max leaves thinking unlimited. A llama.cpp server of your own gets the levels when the model\'s template reads them. Everywhere else the button is greyed and says why. Until you pick a level for a local model, it keeps running the way it did before. Think off still means no thinking. On Windows we checked the LU Engine in the app; LM Studio, KoboldCpp and llama.cpp have run in automated tests only.',
          },
          // Baustein E8 (issue 177)
          {
            title: 'The wait for the first word of a chat answer can be set.',
            detail: 'A local chat stopped with the backend accepted the request but sent nothing for 600 s, even while the backend was still reading a very long prompt (issue 177). Settings, General has a new section, Chat Reply Timeout, next to the image and video timeouts: a number of seconds up to 24 hours, or Off, which waits as long as the connection stays open. The default stays 600 seconds, and Stop always ends the wait. The wait also covers a server that holds back even its first headers, and a request whose wait ran out is not sent again. We checked it in the app on Windows against a stand-in server.',
          },
          // Baustein E3
          {
            title: 'Add model IDs that a server serves but does not list.',
            detail: 'The provider card of an OpenAI-compatible server has a new field, Model IDs the server does not list, one per line (issue 112). They join that server\'s models in the picker while the server is running.',
          },
          // GitHub #173
          {
            title: 'Several OpenAI-compatible backends at the same time.',
            detail: 'Adding KoboldCpp while LM Studio or the LU Engine is on no longer pushes the other one out (issue 173). Each backend gets its own row in Settings, AI Backends, with its own name, address, optional key and model IDs, and its models appear in the picker under its name. A group chat can mix models from several of them. A backend that an earlier version pushed onto the standby card has a Run side by side button, and the startup dialog for detected backends can add all of them at once. Chats and settings from before keep their models. For a model of such a backend, the context window comes from that backend\'s own server (KoboldCpp, llama.cpp, LM Studio), and so do the history budget of a chat, the room for an attached file and the extra samplers; a server on your network is never cut to the send limit of a paid provider. This has run in automated tests and in the app on Windows with the LU Engine next to a stand-in server, not yet with two real servers. Settings, Local API still reaches only the LU Engine, Ollama and LM Studio.',
          },
          // Baustein E4
          {
            title: 'The User-Agent of web search can be set.',
            detail: 'Settings, Search Provider has a User-Agent field. Empty keeps what LU sent before. A value goes with the DuckDuckGo and Wikipedia searches and with every page the agent fetches. A value that cannot be sent is replaced by the default, and the field says so. Search services with a key and a local SearXNG keep their own requests.',
          },
          // Baustein E5
          {
            title: 'A chat compacted more than once keeps one summary.',
            detail: 'Every compaction added its own summary, and each message sent the whole chain of them. A new compaction now merges the earlier summary and the turns since then into one current state, and only that state goes out with the next message (issue 151). What the merge drops from the old state, such as your requests, open tasks, paths and numbers, is put back. The number of recent messages kept word for word now follows the model\'s context, between 4 and 20, and stays 6 where the context is unknown. Chats saved before keep sending their chain.',
          },
          // Baustein E6
          {
            title: 'Smaller fixes in Code and Loop.',
            detail: 'The tooltip of Accept without asking says what the click changes. The plan card wraps its row instead of its words in a narrow Explorer. The countdown of a loop never shows more than the pause.',
          },
          // Nachzug mac/307-funde
          {
            title: 'Auto compact is on by default and fits the model\'s window.',
            detail: 'It stayed off until you set a threshold. It is now on and runs from a 32K context window up, earlier on smaller windows than on large ones; below 32K older turns are only shortened. A fixed point from 30 to 95 percent runs on every window, and a new Auto-compact switch in Settings, Generation turns it off. Long Agent and Code runs also summarise their older steps in the middle of a run, and the summary keeps the files, commands, IDs, numbers, open tasks and the next step. This has run in automated tests and in a test against a local model.',
          },
          // Nachzug mac/307-persona-note (issue 181)
          {
            title: 'A persona can carry a reminder.',
            detail: 'The persona editor has a Reminder field and Messages from the end. Wherever that persona speaks, in its chat, in a group chat or in Agent mode, the reminder goes into your message at that depth, so the model reads it close to the end of the prompt. It is never stored in the chat. A character card brings its depth prompt along as the reminder (issue 181). This has run in automated tests only.',
          },
          // Nachzug mac/307-rea
          {
            title: 'REA, a plugin for reverse engineering in Agent and Code.',
            detail: 'Plugins has a new switch, REA (Reverse Engineer Anything, MIT license), off by default and only in the desktop app. LU fetches the official package, checks it against the checksum the npm registry publishes, and starts it with Node.js. Its tools reach Agent and Code behind the confirmation every external tool gets, and a turn gets only the REA tools its words point at. It works best with a model of about 27B and a context window of 64K or more. Use it on software you own or are allowed to examine. It has run on a Mac with LU\'s tool code outside the app; a start from the built app has not been tried yet.',
          },
          // Nachzug mac/307-funde
          {
            title: 'Chat Tools are always on.',
            detail: 'The Chat Tools switch under Plugins is gone. Plain chat uses web search, files, images and video when a turn needs them, for every model that can call tools. A model that cannot call tools answers in plain chat as before.',
          },
          // Nachzug mac/307-funde
          {
            title: 'Typed faces become emojis.',
            detail: 'In the composer of Chat, Agent and Code, a face such as :) turns into its emoji once the word is over. It never turns inside a word, a link, a path or code, and one Backspace right after takes it back. Settings, Appearance has a switch to turn it off.',
          },
          // Nachzug mac/307-gate (issue 180)
          {
            title: 'A former group chat keeps who said what with group chat off.',
            detail: 'With group chat off, a chat that holds group turns now sends the other speakers\' turns tagged with their names and tells the model what the tags mean. Switching group chat off and on keeps every persona tag (issue 180). This has run in automated tests only.',
          },
          // Nachzug mac/307-gate
          {
            title: 'Two turns of one role in a row are merged on every request.',
            detail: 'The chat templates of Mistral and Devstral refuse two user or two assistant turns in a row. LU merged them only on a request without tools; it now merges them on every request, and tool calls keep their own pairs.',
          },
        ],
      },
      {
        title: 'Local models and engines',
        items: [
          // Nachzug mac/307-civitai-installed (Discord)
          {
            title: 'A CivitAI hit already on disk says Installed.',
            detail: 'A model found in the CivitAI search offered Download even when its file was installed. A hit now reads Installed when a file of the same name, and where CivitAI states it the same size, lies in the folder the download would use.',
          },
          // Baustein F10 (issue 113)
          {
            title: 'Check files and Repair for installed models.',
            detail: 'Image and video bundles and chat models of the LU Engine have a Check files button. It compares each file with the catalog by size and, where listed, SHA256, in the background with progress and Cancel. Repair downloads only the broken or missing files again; a wrong file goes to the Trash or Recycle Bin first, nothing is deleted for good. A download whose partial file already held the whole file no longer fails on every Retry (issue 113). Not offered for the Mac\'s own MLX models. We ran Check files on an image bundle in the app on Windows; Repair has not been clicked yet.',
          },
          // Baustein F11
          {
            title: 'Use a GGUF file from anywhere on your drive as a chat model.',
            detail: 'On the Chat lane of the Model Manager, GGUF file next to Pull picks the file, and LU links it into the LU Engine folder without copying. The file must be on the same drive as that folder. The image part of a vision model comes along when it sits next to the model.',
          },
          // Baustein F1
          {
            title: 'GPU layers -1 lets the LU Engine fit the layers itself.',
            detail: 'On AMD and Intel cards on Windows and Linux, LU only knows the total memory of the card and guessed the number of layers from it, so -1 could run as slowly as the processor (issue 156). With -1 the LU Engine now fits the layers against the free memory it measures itself. We have no AMD or Intel card to check it on.',
          },
          // Baustein F2
          {
            title: 'ComfyUI starts when no Python on your machine has PyTorch.',
            detail: 'With Python 3.15 as the only or the default Python, ComfyUI did not start, and Install, Repair environment and Update asked for another Python. Install and Repair environment now build ComfyUI\'s environment from a Python that PyTorch supports, and when there is none, from LU\'s own Python 3.12, which needs no administrator rights. A ComfyUI without its own environment starts on the Python that holds its PyTorch, and the character trainer takes the same way. We checked this on a Windows machine whose only Python was 3.15.',
          },
          // Baustein F3
          {
            title: 'A render no longer starts LM Studio.',
            detail: 'Before a picture or a clip, LU asks LM Studio to unload its models to free graphics memory. With LM Studio closed, that call started LM Studio in the background. LU now checks first whether LM Studio is running and skips the call when it is not.',
          },
          // Baustein F4
          {
            title: 'A chat model with image input no longer warns at every render.',
            detail: 'Before a render, LU saves where the chat model stands in the conversation, so the next answer starts faster. The LU Engine cannot do that for a model loaded with its image part, so every render tried, failed and warned. LU now skips it for such a model.',
          },
          // Baustein F5
          {
            title: 'Importing a model follows the LU Engine folder you set.',
            detail: 'With an LU Engine folder set under Model Storage, an import now links the model into that folder, and the error for a link across drives names that setting and a copy into the folder as the two ways out. A model imported into LU\'s own folder earlier still shows as imported.',
          },
          // Baustein F6
          {
            title: 'The voice engine and LU\'s own Python can live on another drive.',
            detail: 'Settings, Model Storage has a new row, Voice and Python folder. New installs of the voice engine, the read-aloud voices and LU\'s own Python go to the folder you choose, and what is installed keeps working where it is. Move to this folder copies the files, checks the copy, starts it once and only then puts the old files in the Recycle Bin or Trash. Nothing is deleted for good. We moved a real voice engine install on Windows and it started from the new folder. Moving LU\'s own Python has run in automated tests only.',
          },
          // Baustein F7
          {
            title: 'A model whose server names no context length is no longer held at 4K.',
            detail: 'KoboldCpp behind its Ollama API sends no context length, so LU took 4096 as the model\'s maximum: the context picker offered only 4K, and the history of a long chat was cut to fit 4K while a much larger window from Settings went out with each message. LU now also asks KoboldCpp itself and the list of loaded models. When nobody names a length, the picker offers every size, says that LU cannot check them, and shows the value set in Settings. In plain chat, a group round and Compare, the history is now trimmed and compacted to the window that is sent to Ollama, not to the model\'s maximum (issue 166). This has run in automated tests only, not yet against a running KoboldCpp.',
          },
          // Baustein F8
          {
            title: 'LM Studio keeps the context size you picked for a model.',
            detail: 'A size picked in the context picker is now saved for that model and used whenever LU loads it, also after you switch to another model and back, and it no longer changes the Ollama context window. A size picked before this update needs to be picked once more. Making another model the main model no longer unloads a model that still speaks in the group chat on screen; outside a group chat, the previous local model is unloaded as before (issue 168). This has run in automated tests only, not yet with LM Studio itself.',
          },
          // Baustein F9
          {
            title: 'Japanese, Chinese and Korean text is counted closer to its real token cost.',
            detail: 'LU estimated every text at four characters per token. Japanese takes about 1.4 characters per token on Gemma, so a long Japanese chat sent about 2.8 times more tokens than its budget, and the trim and auto compact only started after the server had already run over. The estimate now counts by script: plain English text as before, Japanese, Chinese and Korean at 1.25 characters per token, emoji and symbols higher. It lands a little above the real count on purpose. The same estimate now also sizes the reply limit sent to OpenAI compatible servers and the memory block. In a group chat the context counter no longer switches between speakers without a word: it names the speaker it counts for, the one answering or the one who opens the next round, and shows that speaker\'s own prompt over its own window (issue 167). LU does not ask the server to count tokens yet. On Windows the estimate for a long Japanese text file on the LU Engine came within 1 percent of the count the engine reported.',
          },
          // Nachzug fix/307-token-overflow (Windows-Lauf d307-k, B5)
          {
            title: 'Numbers, hex and Base64 are counted at their real token cost.',
            detail: 'LU counted a digit at a quarter of a token. Most local models give every digit a token of its own, so a chat with a long numeric log, hex or Base64 could send more than the model\'s window holds, and the LU Engine refused it with "exceeds the available context size". Digits and such encoded text are now counted at their real cost, text without digits as before, and Japanese text with many numbers a little higher than before. When the engine still refuses a message as too long, plain chat shortens the history it sends once and tries again instead of only showing the error; the chat itself keeps every message. Where auto compact is on, it now writes its summary before older turns are cut to fit the window, also in chats the model counts with few tokens. This has run in automated tests against token counts from the Qwen 2.5 and Gemma 3 tokenizers, not yet in the app.',
          },
          // Nachzug fix/307-gpu-amd-intel (Funde aus Discord, ohne AMD- oder Intel-Karte geprueft)
          {
            title: 'Picking the outer folder of a ComfyUI portable build works.',
            detail: 'The Windows portable builds, the Intel and AMD ones too, unpack as one folder that holds ComfyUI and python_embeded. Picking that outer folder said main.py not found, and the search on the disk only found folders named ComfyUI. LU now takes the ComfyUI folder inside, whatever the outer one is called, and keeps using the python_embeded beside it. This has run in automated tests only.',
          },
          {
            title: 'Auto runs ComfyUI on an Intel Arc card.',
            detail: 'On a machine without an NVIDIA card, Auto asks the PyTorch in the ComfyUI environment whether it has a usable GPU, and it only asked about CUDA. A PyTorch built for Intel XPU answered no, so ComfyUI started on the processor with a working Arc card. LU now asks about XPU too, and the Force GPU warning stays away when XPU is there. This has run in automated tests only, without an Intel card.',
          },
          {
            title: 'A change of the ComfyUI GPU mode says that ComfyUI has to restart.',
            detail: 'Switching ComfyUI GPU in Settings, Hardware to Force GPU with the vendor left on Auto showed nothing, and the running ComfyUI kept its old mode. Every change now says that ComfyUI only reads the mode at start, with a Restart ComfyUI button. The Device line ComfyUI prints at start stands under Status in AI Backends, ComfyUI (Image & Video), so you can see whether it runs on the card or the processor. This has run in automated tests only, without an AMD or Intel card.',
          },
        ],
      },
      {
        title: 'Voice, Remote Access and Settings',
        items: [
          // Baustein G0
          {
            title: 'Sending while you dictate ends the recording.',
            detail: 'Sending a message while dictation was on left the microphone recording, and the microphone button stayed locked until you stopped the answer. Send and Enter now end the recording first, and the microphone button stays usable while an answer runs. We checked it in the app on Windows.',
          },
          // Baustein G1
          {
            title: 'Voice and dictation may use the microphone on Linux.',
            detail: 'The Linux web view refused every request for the microphone, so Voice failed at once (issue 162). LU now lets its own page use the microphone. A camera, a screen share and any other page are still refused. We built this for Linux and have not tried it on a real Linux machine with a microphone.',
          },
          // Baustein G2
          {
            title: 'Remote Access texts point to the right buttons.',
            detail: 'After the 15 second tunnel timeout, the text now says to click Stop and start again with Dispatch, Internet, because Restart starts the server without a tunnel. A refused permission on the phone points to Settings, Voice & Remote, Remote Access, Permissions in the desktop app, and the help says what Dispatch does.',
          },
          // Baustein G3
          {
            title: 'Settings, Privacy names the real data folders on Windows and Linux.',
            detail: 'On Windows the data folder is %LOCALAPPDATA%\\lu-labs. The chat backup and the chat models of the LU Engine sit under %APPDATA%\\Locally Uncensored, and Privacy now names both instead of saying that LU writes nothing else. Linux gets its own folders named the same way.',
          },
          // Baustein G4 (issue 19)
          {
            title: 'Remote Access can give the phone\'s browser tab your own name.',
            detail: 'Set it under Settings, Voice & Remote, Remote Access, Tab name on your phone. Left empty, the tab keeps its name AI Terminal (issue 19).',
          },
          // Baustein G5
          {
            title: 'A paired phone can show the name of this computer.',
            detail: 'The signed in status of Remote Access now also gives the computer\'s name, so a paired phone can show it instead of the address.',
          },
          // Nachzug mac/307-funde (Discord)
          {
            title: 'Every line of the log names the version that wrote it.',
            detail: 'A log could show an older version after an update, because the day\'s log file still held the lines of the run before. Every line and every record in crash.log now carries the version.',
          },
        ],
      },
      {
        title: 'LU Cloud',
        items: [
          // Nachzug mac/307-gate
          {
            title: 'The window behind the Cloud switch lists the cloud models.',
            detail: 'Signed out, or with an account that cannot use them yet, the window has one list each for Chat, Code and Create. A model opens a short window with the two ways to get it, a plan or a pack, and a model too big for this machine says so. LU keeps the pick for a week and opens that model once your account can use it. A click there is counted like a press of the switch, never with the name of the model, and Settings, Privacy says so. This has run in automated tests only.',
          },
        ],
      },
      {
        title: 'Security',
        items: [
          // Baustein S1
          {
            title: 'ComfyUI and LM Studio, when LU starts them, answer to LU only.',
            detail: 'Other pages open in your browser can no longer read them.',
          },
          // Baustein S2
          {
            title: 'The LU Engine runs models for LU only.',
            detail: 'Each time LU starts the engine, it gets a key that only this run of LU holds, and LU\'s own features send it. Other pages open in your browser can no longer run its model or read what it is doing.',
          },
          // Baustein S3
          {
            title: 'A web page the agent reads reaches the model as page content.',
            detail: 'Text from a fetched page now goes to the model marked as data from that page, not as instructions to follow.',
          },
        ],
      },
      {
        title: 'Mac (Beta)',
        items: [
          // Baustein M0
          {
            title: 'The Mac parts of this release have not been clicked through in a built app yet.',
            detail: 'Mask edit, HiRes fix, Remove Background, Enhance Image, an image with a LoRA, both Qwen prompt enhancers, LTX-2.3 video at a chosen size, Extend Video, Music, training a character, Talking Character, Motion Control and an edit with ten pictures ran with the real engine on one Mac with 48 GB. The large LTX models (64 GB and more) have not run on a real Mac, nor has anything on a Mac with less than 48 GB. Video LoRAs and multishot have not run with real models on a Mac, and the downloads that Talking Character and Motion Control offer on their tabs have run in automated tests only.',
          },
          {
            title: 'Music on a Mac needs 48 GB of memory.',
            detail: 'A run used about 28 GB while it decoded, more than the 16 GB the catalogue named before.',
          },
          // Baustein M1
          {
            title: 'On a Mac, Use character runs characters from the Mac\'s LoRA folder.',
            detail: 'Character Studio\'s Use tab lists the characters in the Mac\'s LoRA folder. A pick brings the Z Image model the character was trained for, and Image, the video tabs and the chat tools take the character as they do on Windows. A video starts from a picture of the character made on the Mac. This is on macOS only.',
          },
          // Baustein M10
          {
            title: 'On a Mac, Train new trains a character on this Mac.',
            detail: 'Character Studio\'s Train tab trains a Z Image character from 4 to 100 photos with the Mac\'s image engine and puts it into the Mac\'s LoRA folder, where Use character, the character chip and chat find it. The first run downloads a training adapter of 340 MB. Training is slow on a Mac: on an M5 Pro one step takes about 7 seconds, so the Standard setting (1200 steps) runs a little over two hours. Use frames for a character hands its photos to the same training. This is on macOS only.',
          },
          // Baustein M11
          {
            title: 'On a Mac, Talking Character runs locally.',
            detail: 'A portrait and a voice recording become a clip whose lips follow the voice, as long as the recording and up to 10 seconds, with LTX-2.3 4-bit. It needs one more download of 11.3 GB, offered on the tab. It is slow: a 4 second clip took about 10 minutes on an M5 Pro. It needs a Mac with 24 GB or more. This is on macOS only.',
          },
          // Baustein M12
          {
            title: 'On a Mac, Motion Control runs locally.',
            detail: 'A motion clip and a start image become a video that follows the motion, with LTX-2.3 4-bit and the IC-LoRA Union Control (about 650 MB, offered on the tab). LU turns the motion clip into edges first. A 2 second clip at 512 x 512 took 103 seconds on an M5 Pro. This is on macOS only.',
          },
          // Nachzug mac/307-funde
          {
            title: 'On a Mac with 48 GB, an LTX clip runs up to ten seconds.',
            detail: 'Video, Animate and Extend with an LTX model go to 241 frames, ten seconds, on a Mac with 48 GB of memory or more; before, the slider ended at 113 frames. A ten second clip from a start image ran on an M5 Pro with 48 GB in 187 seconds. A smaller Mac, Wan and Motion Control keep the old limit. This is on macOS only.',
          },
          // Baustein M2
          {
            title: 'On a Mac, Enhance Image runs with SeedVR2.',
            detail: 'Once SeedVR2 3B (7.28 GB) is installed from the Model Manager, Enhance Image is a local tab with a choice of 2x or 4x, and the longest side is held to 4096 pixels. Without it the tab stays locked. This is on macOS only.',
          },
          // Baustein M3
          {
            title: 'On a Mac, Remove Background runs without a download.',
            detail: 'The tab uses the subject detection built into macOS, so it needs no model and no Python. A picture without a clear subject gets a sentence instead of an empty image. This is on macOS only.',
          },
          // Baustein M4
          {
            title: 'On a Mac, Edit paints under a mask.',
            detail: 'With Qwen-Image 2.1, Edit on a Mac offers Paint mask, Edit strength and Mask edge feather, and a result offers Edit with mask. In our run with the engine on an M5 Pro with 48 GB, a hard mask at full strength changed only the masked area in 189 seconds. This is on macOS only.',
          },
          // Baustein M5
          {
            title: 'On a Mac, HiRes fix runs as a second pass.',
            detail: 'With a model that edits, such as Qwen-Image 2.1, the finished picture goes through a second pass at the larger size, with the HiRes denoise and steps. The latent upscale method is not offered on a Mac. This is on macOS only.',
          },
          // Baustein M6
          {
            title: 'On a Mac, video runs take LoRAs and a size, and Extend Video runs locally.',
            detail: 'Where the model\'s entry allows it, the LTX and Wan video models take a stack of LoRAs and a width and height on the grid of the engine, and Wan takes 1 to 60 steps. Extend Video is a local tab while a video model that takes a start image is installed, and the Shots slider reaches the LTX-2.5 packs. This is on macOS only.',
          },
          // Baustein M7
          {
            title: 'On a Mac, Music runs with ACE-Step 1.5.',
            detail: 'The Music tab in Create is a local tab once the music engine is installed from the Music rail of the Model Manager, about 10 GB. A run takes the style, the lyrics, a length from 10 seconds to 4 minutes and the seed, and puts the track in the gallery. It needs a Mac with 48 GB of memory; a smaller Mac is told so before anything loads. This is on macOS only.',
          },
          // Baustein M8
          {
            title: 'On a Mac, a Qwen prompt enhancer rewrites prompts for Qwen-Image 2.1.',
            detail: 'Two enhancer packs of about 6 GB each, one for new pictures and one for edits, install from the Model Manager. With one installed, a new picture or an edit on Qwen-Image 2.1 can have its prompt rewritten before the run, and the edit enhancer also looks at the picture. This is on macOS only.',
          },
          // Baustein M13
          {
            title: 'On a Mac, the large LTX models render at the size Create shows.',
            detail: 'They ran at 512 x 512 whatever was asked, so a landscape clip came out square. They now take the size on the grid their engine keeps. This is on macOS only.',
          },
          // Baustein M14
          {
            title: 'On a Mac, an edit with many pictures no longer fills the memory.',
            detail: 'Each picture of a Qwen-Image 2.1 edit takes memory of its own, and ten pictures at full size left a 48 GB Mac a third free before the first step. Edit now offers as many reference slots as the Mac\'s memory takes, and a run past that is refused with the number that fits. This is on macOS only.',
          },
          // Baustein M15
          {
            title: 'On a Mac, Music no longer fills the memory while it decodes.',
            detail: 'A 30 second track left 1.4 GB of a 48 GB Mac free; it now leaves over 9 GB and decodes faster. This is on macOS only.',
          },
          // Baustein M16
          {
            title: 'On a Mac, Enhance refuses a result larger than the memory takes.',
            detail: 'At 4x a 1024 picture needs about 22 GB; a smaller Mac is told to pick 2x or a smaller picture instead of freezing. This is on macOS only.',
          },
          // Baustein M17
          {
            title: 'On a Mac, Extend Video shows the Mac\'s video settings.',
            detail: 'It showed the ComfyUI graph\'s steps, sizes and frames, and a Negative switch a distilled LTX does not read. This is on macOS only.',
          },
          // Baustein M18
          {
            title: 'On a Mac, switching from Cloud to Local keeps Talking Character open.',
            detail: 'It jumped to Video or Image instead, and so did Character Studio. Talking Character stays while a model that talks is installed. This is on macOS only.',
          },
          // Baustein M9
          {
            title: 'Reset and ask again shows while a permission is missing.',
            detail: 'In the computer control permissions on a Mac, the link appeared only after Open System Settings was clicked in the same view. It now shows whenever a permission is missing, and the hint names the case it is for: an entry left by an older test copy of LU. This is on macOS only.',
          },
        ],
      },
    ],
  },
  // 3.0.6, vorbereitet am 09.10.2026 und am 10.10.2026 auf den Umfang von
  // integ/astra-306 4b57e672 gebracht, noch nicht released: Voice, Computer
  // control, Create im Chat und die zehn Direktmodelle der Cloud (alle vier
  // Beta, die Liste ist lib/beta.ts, die Saetze hier folgen den Hover-Saetzen
  // dort), der Bildteil beim Modell-Download, die neuen Dialoge, das
  // Statuszeichen, die Abrechnung nach Laenge und die neuen Namen der Marken.
  // Verlaesst eine Funktion die Beta-Liste, faellt ihr Beta-Satz hier und im
  // CHANGELOG mit. Die Version steht in
  // package.json, package-lock, Cargo.toml/.lock und tauri.conf.json in einem
  // eigenen Commit. Jeder Posten traegt seinen Baustein: faellt eine Funktion
  // aus dem Umfang, faellt genau dieser Posten mit, im CHANGELOG ebenso. Die
  // Posten B3a sind fuer das kleine Feld geschrieben, B3c ist die Erlaubnis je
  // Chat, B20 die Grenze fuer abgelehnte Aufrufe, B21 das Lesen von Webseiten.
  // MAC: dieser Eintrag sagt nichts ueber einen Mac-Bau. Der Platzhalter dafuer
  // liegt in lu-306-texte/release-notes-entry.md (Baustein S2) und kommt erst
  // hinein, wenn der Mac-Bau am Release haengt; der Test daneben haelt das fest.
  // Nachzug 10.10.2026 abends: die Gruppe Local models (Ollama, LM Studio,
  // LU Engine, Model Manager) und was sonst seit der letzten Fassung kam. Die
  // drei Posten, die nur den Mac betreffen (langer Videolauf, Speicherangabe
  // und LoRA bei Qwen-Image 2.1), stehen im CHANGELOG und aus demselben Grund
  // nicht hier.
  // Nachzug 11.10.2026, Umfang von integ/astra-306 1132f0a5: das Feld
  // Microphone, das Diktat mit PyAV 19, der Bildteil von Hand, die
  // Zusammenfassung mit Codebloecken, Restart Now, der CUDA-Hinweis und die
  // langen LoRA-Namen. Restart Now steht hier nur mit Linux, das CHANGELOG
  // nennt beide Systeme. Der Speicher vor einem Lauf betrifft nur den Mac und
  // steht deshalb nur im CHANGELOG.
  // 3.0.5 darunter bleibt unveraendert.
  {
    version: '3.0.6',
    headline: 'You can talk to LU and hear it answer, and a model can use the mouse and keyboard in apps you approve. Both are in beta, and the app marks them with the word Beta. Local models with image input download with their image part, a running task says what it is doing, and LU Cloud lists ten more chat models, also in beta.',
    lines: [
      // Baustein B1
      {
        title: 'Voice (Beta): talk to LU and hear it answer.',
        detail: 'Voice is a new surface in the main navigation. Speech recognition, the voice and the turn taking run on your own machine, and the model that answers is the chat model you picked. The first time, LU shows what it downloads and where it goes, then installs its own voice engine with one click. You can interrupt an answer by speaking, and the session is saved as a normal conversation. It is English only for now. Voice is in beta: it is new, and your computer may still show rough edges. The word Beta stands next to the title.',
      },
      // Baustein B3
      {
        title: 'Computer control (Beta): a model works in the apps you approve. Off by default.',
        detail: 'Computer control is in beta: it is new and not proven in every app yet, so watch what it does and stop it when it goes wrong. It stays off until you switch it on under Settings, Agent, Agent Permissions, Computer control. In every new chat LU asks once whether it may use computer control there, before it looks at the screen or acts. It also asks before it touches an app for the first time and, by default, before every action. Autonomous, for one session, asks only before sending, buying, deleting or changing permissions. Terminals, password managers, system sign-in and permission dialogs, security settings, the Run dialog and windows with administrator rights are always off limits, and LU never types into a password field. Ctrl+Alt+Space pauses and Ctrl+Alt+Esc stops, from anywhere. Our check in the real app ran on Windows.',
      },
      // Baustein B10
      {
        title: 'Local models with image input download with their image part.',
        detail: 'A local chat model of the LU Engine takes pictures only when a second file, its image part, lies next to the model. LU now fetches both as one download on the Models page, in onboarding and for a model you find through the hub search, with one progress bar and a checksum for each file. The two download dialogs have a ticked box, Include image input, with the size it adds. For a model you already have, Add image input fetches the missing file: on the model\'s row under Models and at the top of a chat once a picture is attached. The catalog lists 42 image parts, each with its exact size and checksum. If the graphics memory has no room for the part next to the model, the model loads without it and LU says so.',
      },
      // Baustein B11
      {
        title: 'Create in chat (Beta): ask for an image or a clip in a Cloud chat.',
        detail: 'In Cloud mode the Plugins menu has a Create switch. With it on, the chat model puts together an order from what you ask for, the order appears as a card, and nothing runs until you approve it. Create in chat is in beta, so read the order before you start it. It is switched on account by account, so the switch appears once your account has it.',
      },
      // Baustein B5
      {
        title: 'A running task says what it is doing.',
        detail: 'The status line shows the LU mark and plain words such as Reading, Writing, Searching or Working on the screen in place of internal tool names, with the seconds the step has taken. This also holds while the model is still writing a tool call. When you scroll up during a run, the mark floats above the composer in Chat, Agent and Code, and a click takes you back to the end.',
      },
      // Baustein B8
      {
        title: 'Ten more chat models on LU Cloud, marked Uncensored (Beta).',
        detail: 'The Cloud model picker opens with a new group of ten models whose makers release them to answer without refusing, among them Gemma 4 Uncensored, GLM 4.7 Flash Heretic, Aion 3.5 and Abliterated Large V2. The group is in beta, and a model shows up once the cloud catalogue lists it.',
      },
    ],
    details: [
      {
        title: 'Voice',
        items: [
          // Baustein B2
          {
            title: 'Fifteen voices to choose from.',
            detail: 'Pick a voice in the setup or later in the Voice settings: Alba, Anna, Azelma, Charles, Eponine, Eve, Fantine, George, Jane, Javert, Marius, Mary, Michael, Paul or Vera. Changing it fetches one small file and installs nothing else again. Listen plays a short sentence in the chosen voice once the voice engine is installed.',
          },
          // Baustein B2
          {
            title: 'Four switches sit next to the title.',
            detail: 'Voice settings, Agent, Where it may work and Thinking. You can move all of them while a session runs, and the session follows at once. With Agent off, the session is a conversation without tools.',
          },
          // Baustein B2
          {
            title: 'You decide how far the tools reach.',
            detail: 'Workspace only is the default: files stay inside the folder of the session, LU asks before every command, and there is no screen. Whole computer opens files by any path your user account can open, commands in any folder and the screen. LU asks once before that level is used for the first time, and your system asks once more each time LU was started. A session that is starting waits for that answer and says so. System folders and the folders that hold keys and passwords stay closed at both levels.',
          },
          // Baustein B2
          {
            title: 'The model can use tools, and a tool that needs your approval waits for your click.',
            detail: 'With Agent on, a voice session has the tools of the agent chat with the same permissions. A tool call looks the way it does in the chat, and the same approval bar asks in plain words, for example "Voice wants to change a file." You answer it with a click on Approve or Reject. A spoken yes or no answers the questions of computer control only, and it is not a line of the conversation. Local models get a shorter tool list (web, files, shell and the screen), so the first answer comes quickly.',
          },
          // Baustein B2
          {
            title: 'Thinking is a switch, and a thought is never read aloud.',
            detail: 'Thinking is off by default. Switched on, the thought appears in the transcript as the folded Thinking block you know from the chat. Thinking length in the Voice settings limits a thought to between 128 and 4096 tokens, 512 by default. When a thought runs longer, LU ends it and asks the model again for a direct answer.',
          },
          // Baustein B2
          {
            title: 'A light switch unloads Voice.',
            detail: 'While the voice engine is in memory, a switch next to the title shows how much memory it holds. LU measures that number, and on our Windows test machine it was about 1 GB. One click ends the session and stops the engine, and if the voice session loaded the chat model, that model is unloaded too. Without the click, the engine shuts down five minutes after the last session.',
          },
          // Baustein B2
          {
            title: 'A short chord says that a session is listening.',
            detail: 'It is quiet and lasts about a second. You can switch it off in the Voice settings.',
          },
          // Baustein B2
          {
            title: 'Voice hears you while it starts.',
            detail: 'What you say after the Start click, also while the speech models are still loading, is kept for up to a minute and answered once the session is up.',
          },
          // Baustein B2
          {
            title: 'Dictation in the chat works when only Voice is installed.',
            detail: 'The microphone button in the chat uses the speech recognition of the voice engine if no separate speech-to-text install exists.',
          },
          {
            title: 'Choose your microphone in the settings.',
            detail: 'Settings, Voice & Remote, Speech has a Microphone field that lists the system default and your input devices by name (discussion 152). The choice holds for dictation in the chat and for Voice. If the chosen microphone is unplugged, LU records from the system default and keeps your choice for when the device is back. The names appear once the app may use the microphone, and a button under the field asks for that. This has run in automated tests and not yet with a real microphone.',
          },
          {
            title: 'Dictation in the chat works again on installs with Python 3.12 or newer.',
            detail: 'A fresh speech-to-text install on Python 3.12 or newer got PyAV 19, an audio library that dropped an argument the speech recognition still passes (issue 155). Every take then failed with "open() got an unexpected keyword argument \'metadata_errors\'". The dictation server that ships with LU now leaves the argument out when PyAV refuses it. The fix comes with the app, so an install that was hit needs no reinstall.',
          },
          // Baustein B2
          {
            title: 'One line of advice for small models.',
            detail: 'If the chat model takes no tools or is smaller than 7B, the empty Voice surface recommends a local model that fits.',
          },
          // Baustein B2
          {
            title: 'A session that ends without the Stop button says why.',
            detail: 'Leaving the Voice surface, a repair and an uninstall each end the session with one sentence and a Start again button.',
          },
          // Baustein B2
          {
            title: 'Only a serious error ends a voice session.',
            detail: 'If the voice engine reports an error it cannot recover from, the session ends and says why. Any other error goes to the log, and where you would miss something, for example a sentence that could not be spoken, one line under the status says so until you speak again.',
          },
          {
            title: 'Voice names the right model.',
            detail: 'The idle Voice surface kept naming the model of the last session after you had picked another, and the answers of a saved voice session could read as written by a different model. Both now name the model that answers.',
          },
          {
            title: 'A spoken yes at the card for computer control gets an answer.',
            detail: 'In a voice session, a spoken yes while the card "Allow computer control in this chat?" was open went to the model as a new request, and the card stayed. LU now says aloud that it waits for your click and answers a spoken yes with "This one needs your click on the screen." A spoken no or stop declines, like Deny.',
          },
        ],
      },
      {
        title: 'Computer control',
        items: [
          // Baustein B3c
          {
            title: 'Every chat asks once before computer control starts.',
            detail: 'The first time a chat wants the screen, a card in the conversation asks "Allow computer control in this chat?" with Allow and Deny. Until you click, LU takes no screenshot and does nothing. The yes holds for that one chat. A new chat asks again, and so does every chat after the app was restarted. No setting and no autonomous session skips the card. In a voice session LU says aloud that it waits for your click. A spoken yes does not allow it, and a spoken no or stop declines.',
          },
          // Baustein B3a
          {
            title: 'LU gets out of the way while it works.',
            detail: 'On Windows the LU window shrinks to a small window in the top right corner of the screen LU works on, and comes back at its old size and place when the work is over. The small window shows what LU is doing and names the two shortcuts. The edge of that screen glows softly in purple for as long as LU works there. On Linux the window stays as it is and a bar at the top says "LU is controlling this computer".',
          },
          // Baustein B3a
          {
            title: 'Questions stand above the input field.',
            detail: 'A question about an app or an action stands directly above the input field in the chat, and above the session controls in Voice. While the LU window is small, the question appears there with a Stop button. You answer it with the mouse. It does not take the keyboard, so the app LU works in keeps the focus.',
          },
          // Baustein B3
          {
            title: 'A sensitive action always needs your click.',
            detail: 'Anything that sends, buys, deletes or changes permissions is asked with the reason in red, in a supervised session as in an autonomous one. The same goes for a click whose target LU cannot name, for a button, link or menu item without a name, and on Windows and Linux for Alt with a letter, which presses a button or opens a menu from anywhere in a window. A spoken yes never confirms such an action, because speech recognition can mishear and the microphone hears the whole room.',
          },
          // Baustein B3a
          {
            title: 'A hand on the mouse pauses LU.',
            detail: 'In an autonomous session LU pauses when you move the mouse. The paused view shows what LU did so far and asks whether you take over or let it continue, and you can add an instruction for the rest of the task. After Let it continue, LU brings the window it works in back to the front and looks at the screen again before it acts. Ctrl+Alt+Esc still stops at once, also during a pause.',
          },
          // Baustein B3b
          {
            title: 'Ask for something on the screen by voice.',
            detail: 'With Where it may work set to Whole computer, a voice session can carry out a task on the screen and tell you the result. LU asks its questions aloud, and yes or no answers an ordinary action. Say stop or wait and the task pauses. Only the word alone does that: "Wait, what is two plus two?" is a question for the model. In our test on Windows, typing a note in Notepad by voice took 11 to 22 seconds from the end of the command to the spoken result, with a local 9B model that works from the list of buttons and fields.',
          },
          // Baustein B3
          {
            title: 'Screen tasks follow what the chat model can see.',
            detail: 'The model that looks at the screen is the chat model by default, and LU does not ask how it should run. A model that can see images gets the screenshots, and on Windows the list of buttons and fields of the window next to them. A model that cannot see images works on Windows from that list alone, without a picture. A local model sees images while it is loaded with its image part. You can choose another local model or a cloud model with image input instead.',
          },
          // Baustein B3
          {
            title: 'Holo 3.1 9B is in the model catalog as a screen model, marked Beta.',
            detail: 'It is recommended from 16 GB of video memory. In our test on Windows it finished a simple typing task in 1 of 3 runs.',
          },
          // Baustein B3
          {
            title: 'Screenshots appear on the step they belong to.',
            detail: 'Each look at the screen is a small picture on the block of its tool call, and a click opens it large over the whole window. The pictures are kept in memory only, at most 24, and are not written to the conversation. If a password field had the focus, the block says so and shows no picture.',
          },
          // Baustein B3
          {
            title: 'A screen task has a limit.',
            detail: 'It ends after at most 25 steps or 8 minutes, and the time you take to answer a question counts. A task that ran out of time says so.',
          },
          // Baustein B12
          {
            title: 'A security review of everything new in this release led to ten fixes.',
            detail: 'Among the ten findings we fixed before shipping: no key press puts a character into a password field, and pasting is refused there as well. Typed text is checked again after every tab and line break. A letter or the space bar outside a text field is judged like a click, so it cannot press a focused Send button without a question. A double click on a program, an installer, a script or a shortcut asks first. Sensitive buttons are recognised in eleven more languages. The question about an app starts with the focus on Deny. Whole computer keeps token files, mail and browser data and LU\'s own folders closed, and Workspace only has no screen through any tool. Four Rust libraries (rustls, rustls-webpki, h2 and crossbeam-epoch) moved past published advisories.',
          },
          {
            title: 'Computer control asks before two more kinds of action.',
            detail: 'A button, link or menu item without a name went through without a question in an autonomous session, because no sensitive word was found in an empty name. It is now asked like any target LU cannot name. On Windows and Linux, Alt with a letter is asked too, because it presses a button or opens a menu from anywhere in a window. Neither takes a spoken yes.',
          },
          {
            title: 'With Whole computer, the start files of the shell can be read and not changed.',
            detail: 'The files your system runs by itself when a terminal or a session starts (such as .zshrc, .bashrc or the PowerShell profile) and the settings of git stay readable. The tools no longer write to them outside the workspace, because a line written there is a command that runs later without a question.',
          },
        ],
      },
      {
        title: 'Local models',
        items: [
          {
            title: 'An Ollama model that runs partly on the processor says so.',
            detail: 'A context window that is too large for the graphics memory does not fail on Ollama. Part of the model moves to the processor, and every answer gets slower with nothing on screen to say why. After a load LU now asks Ollama how much of the model sits in graphics memory. It shows the answer in the list where you pick the context window and, in short, on the model\'s row in the model picker, with the numbers in the tooltip. LU shows what Ollama measured after the load and predicts nothing before it.',
          },
          {
            title: 'Switching to another Ollama model after a voice session no longer hangs.',
            detail: 'After a voice session or a chat turn, LU reads the exchange once more in the background to keep memories. That step asked Ollama for a different context window than the one the model was loaded with, so Ollama loaded the model again and kept it busy, and a model you picked next waited behind it. The step now uses the window the model is loaded with, stops after 60 seconds at the latest, and gives way as soon as you pick, load or unload a model.',
          },
          {
            title: 'Loading an Ollama model can be cancelled, and unloading says what happened.',
            detail: 'The load switch turns into Cancel while a model loads and says which model it is waiting for. Unloading a model that is still answering says so and no longer reports "Unloaded".',
          },
          {
            title: 'Going from Chat to Voice no longer loads an Ollama model again.',
            detail: 'Ollama keeps a model loaded for one context window and loads it again when a request names another. Chat, Voice and the calls LU makes in the background (a prompt rewrite, a compaction, a sub-agent, the comparison view, a benchmark, a workflow) each worked that number out for themselves. A voice session now asks for the window of the chat, and a background call for the window the model was last sent, so neither is a reason for a load. Your own setting for the window still wins. The context counter of an agent session now counts against the window that session sends.',
          },
          {
            title: 'Loading an LM Studio model can be cancelled, has a limit and says what failed.',
            detail: 'The load switch of an LM Studio model turned for as long as the load took, and nothing could stop it. It is now Cancel while the model loads, a load ends after five minutes at the latest, and a failed load shows the sentence LM Studio\'s own command gave. After an unload the switch shows what LM Studio\'s list of loaded models says, so a model that is still loaded is not called unloaded. LM Studio goes on loading after a cancel, so LU now tells it to unload the model right away, and unloads it once it is loaded if LM Studio did not take that. The switch reads Cancelling until the model has left memory and does not show On in between. On LM Studio 0.4.12 we have seen the unload end a running load in about a second.',
          },
          {
            title: 'A stop of the LU Engine while a model loads no longer restarts it on the processor.',
            detail: 'A stop during a load was read as a crash, and LU started the model again without the graphics card. That could happen when you switched to the Cloud, picked another backend, started a render that needs the memory or quit the app. A stop now ends the start.',
          },
          {
            title: 'The Model Manager on Windows and Linux has new colours.',
            detail: 'Tiles, rows and buttons use one accent colour where chat, image and video models each had their own. The layout and what the controls do are the same as before.',
          },
          {
            title: 'The Get button of a model tile stays inside the tile.',
            detail: 'Under Models, Chat, Get new on Windows and Linux, the button stood out over the right edge of its tile at some window widths. The row now wraps.',
          },
          {
            title: 'The LU Engine finds an image part you placed by hand.',
            detail: 'The engine only saw an image part under the name its own downloads write, <model>.mmproj.gguf (discussion 67). One you put next to a model under its original name is now used when it is clear which model it belongs to: its name carries the model\'s name, or it is the only image part in a folder that holds this one model. Where that is not clear, for example an image part without a model name next to several models, no model gets it. Image parts named like <model>.mmproj-Q8_0.gguf are no longer listed as chat models. This has run in automated tests only.',
          },
        ],
      },
      {
        title: 'Chat and the interface',
        items: [
          {
            title: 'A message, an instruction in Code and a voice start no longer wait behind the memory step.',
            detail: 'After an answer LU reads the exchange once more in the background to keep memories, and a message sent right after that answer waited behind it. Sending now ends the step first when the model runs on your own machine. The memories of that one turn are then not kept.',
          },
          {
            title: 'An answer cut off by a model switch says so.',
            detail: 'Picking another local model while an answer is still being written ends that answer. It used to end with "Connection dropped before the end". What was written stays, and the line under it now reads "Stopped because you switched to another model".',
          },
          {
            title: 'A compacted conversation keeps its code blocks.',
            detail: 'When a long conversation is compacted, LU reads the summary back section by section. A line such as OPEN or TASK inside a code block was taken for a section heading, which tore the block and the summary apart. Code blocks now stay whole, a block the model left open is closed, and a summary that a model hands back wrapped in one code block is still read. Thanks to ALANDVO for the fix (pull request 154).',
          },
          {
            title: 'Restart Now starts the app again on Linux.',
            detail: 'After an update, the Restart Now button closed the app on Linux and did not start it again (discussion 150). It now starts the new version. Windows is unchanged, because the installer starts the app there. The fix is part of 3.0.6, so it works from the next update after this one, and the update to 3.0.6 itself can still leave the app closed. We have not checked it on a real update yet.',
          },
          {
            title: 'Seven interface corrections now hold on every platform.',
            detail: 'On a Create tool that works from a source image, the picture, its references and the buttons fit on one screen. The model picker in Create shows the whole model name. Start here on the Models page recommends nothing that needs Ollama while Ollama is off. The command palette offers no local model while the Cloud switch is on. The marks DEFAULT, LOCAL and CLOUD in Settings can be read in the light theme. A video whose file cannot be read shows its sentence without player controls. The details dialog names a model once, where it read "Name: Name".',
          },
          {
            title: 'A dropdown no longer hangs in the window after its button is scrolled away.',
            detail: 'A list opened from a button inside a scrolling panel stayed on screen when you scrolled the button out of view. It is hidden until the button is back.',
          },
          {
            title: 'A catalogue search reads at most 16 MB.',
            detail: 'When LU searches a model catalogue or reads a file list from the internet, it stops at 16 MB and says so. There was no limit before.',
          },
          // Baustein B4
          {
            title: 'Dialogs have a new look.',
            detail: 'Confirmations, questions and settings pop-ups share one dark glass style and one row of buttons. Tall dialogs stay inside the window, and menus and popovers use the same style.',
          },
          // Baustein B5
          {
            title: 'Approvals in the agent chat name the action.',
            detail: 'The bar says what the tool wants to do, such as change a file. The internal tool name is still there as a tooltip and in the opened block.',
          },
          // Baustein B5
          {
            title: 'Compare and the background agents panel show the same status mark.',
            detail: 'Both use the LU mark with one word per state, like the status line in the chat.',
          },
          // Baustein B5x
          {
            title: 'Compare, Model Info and Delete Model name the model without a provider prefix.',
            detail: 'The three places showed "openai::" in front of the model name.',
          },
          // Baustein B14
          {
            title: 'Background tasks are listed in the order they were started.',
            detail: 'Two tasks started within the same second could swap places in the list.',
          },
          // Baustein B20
          {
            title: 'A command you keep declining ends the turn.',
            detail: 'When you decline the same command three times in a row, the model is told so. After six the turn ends and says why. A declined call used to count like one that ran, so a model could ask without end.',
          },
          // Baustein B21
          {
            title: 'The agent reads web pages more safely.',
            detail: 'The way the agent fetches a web page is hardened, and packed pages are now readable.',
          },
          // Baustein B21
          {
            title: 'The agent cannot fetch from a private network, and a page has a size limit.',
            detail: 'When the agent fetches a web page, addresses in a private network and in the range 100.64.0.0/10 are out of reach, and a page over 8 MB is refused.',
          },
          // Baustein B15
          {
            title: 'Settings, Privacy and the README say what the app sends.',
            detail: 'The Privacy section said "No telemetry" next to a counter and called that counter daily. What the app sends has not changed. The texts now describe it. LU has no analytics kit and sends no crash reports. On its own it asks GitHub Releases for a new version a few seconds after start and at most every six hours after that, and it counts each press of the Cloud switch: which way it was pressed, the platform and the app version, without an identifier. While you are signed in to LU Cloud, the app also checks your account every five minutes, and a press of the Cloud switch is counted for your account as well. Remote Access over the internet runs through a Cloudflare tunnel, encrypted between each device and Cloudflare and not end to end. Onboarding and the importer no longer promise more than that.',
          },
        ],
      },
      {
        title: 'Create',
        items: [
          {
            title: 'Every result in Create shows the prompt it was made from.',
            detail: 'Under a picture or a clip on the stage there is a Prompt box, and a click on the picture opens the large view with the prompt and a Copy button. It works for results made on your own machine and on LU Cloud, and for pictures ordered from a chat. A tool that takes no prompt, such as background removal, shows none.',
          },
          {
            title: 'Download a trained cloud character.',
            detail: 'In Cloud mode, the character list under Create, Character, "Use character" has a download button next to each character. It asks where to save and writes the character as a .safetensors file. While the file comes in, a Cancel button next to the download stops it and removes the unfinished file.',
          },
          {
            title: 'A picture made in the running session can be used as a source.',
            detail: 'In the installed app, picking a picture you had just made as the source in Edit failed with "Could not load that gallery image: Load failed", while older pictures worked. The same fault is fixed where else such a picture is read: as the start image of a video, when the chat model is shown a picture it made, and for Download in the gallery.',
          },
          {
            title: 'A CUDA "unknown error" in Create comes with an explanation.',
            detail: 'When ComfyUI stops a run with "CUDA error: unknown error", LU now says that the error comes from the graphics driver and not from the model or your prompt, that it usually clears after restarting ComfyUI or the computer, and that a driver update is the next step if it keeps coming back (discussion 130). An out-of-memory error keeps its own hint.',
          },
          {
            title: 'Long LoRA names are shown in full.',
            detail: 'In the LoRA stack of the advanced settings in Create, a long name was cut off, so two LoRAs that start alike read the same (discussion 150). A name now takes as many lines as it needs. Where a name stays on one line, the tooltip shows it whole.',
          },
        ],
      },
      {
        title: 'LU Cloud',
        items: [
          // Baustein B16
          {
            title: 'Five of the new models say Limited capacity.',
            detail: 'The Cloud model picker writes Limited capacity in grey after their names. At busy times such a model can ask you to wait a moment.',
          },
          // Baustein B7
          {
            title: 'The No refusals mark is now called No Filter.',
            detail: 'The mark keeps its meaning: only a model that answered in full in our measurement carries it. It is a plain grey tag now, in the cloud picker, the model selector, the Create model chip and the note under an answer that declines. The Qwen-Image 2.1 downloads that were labelled No Refusals are labelled No Filter.',
          },
          // Baustein B9
          {
            title: 'The open image and video models have Uncensored in their names.',
            detail: 'For example Wan 2.2 Uncensored Extend. Three presets and three local downloads follow, among them Wan 14B Uncensored (GGUF). Only the names changed. The counts are the same as before: fourteen video models and seven image models in the cloud catalogue.',
          },
        ],
      },
      {
        title: 'Linux',
        items: [
          // Baustein B18
          {
            title: 'The Linux packages carry the voice engine.',
            detail: 'The AppImage, the deb and the rpm for x86_64 include the files Voice needs. We built all three in an emulated x86_64 environment and checked what is inside and that no library is missing. We have not started the packaged app on a real x86_64 Linux machine, and Voice and computer control have not been run in the app on Linux.',
          },
        ],
      },
    ],
  },
  // 3.0.5, released 05.10.2026: der Create-Umbau
  // (neue lokale Modelle, Qwen-Image 2.1, mehrere Bilder in einem Zug), Dateien
  // im Chat, Persona je Gruppenmodell und die Fehler aus GitHub 148 und 149.
  // package.json, package-lock, Cargo.toml/.lock und tauri.conf.json stehen im
  // selben Zug auf 3.0.5. 3.0.4 darunter bleibt unveraendert.
  {
    version: '3.0.5',
    headline: 'Create gets LTX 2.5, FastH3 and YuE2 on your own machine, edits several images in one go and has five new models on LU Cloud. Chat takes any file. Dropdowns stay inside the window, and the speech install on Linux works again.',
    lines: [
      {
        title: 'LTX 2.5, FastH3 and YuE2 run on your own machine.',
        detail: 'Models, Video, Get new has four new downloads. LTX 2.5 makes video with its own sound from a prompt or a first frame, as the full version for cards with 24 GB or more and as Small (GGUF Q4) for 16 GB cards. FastH3 is MiniMax H3 in 8 steps, text to video only, for 24 GB or more. YuE2 writes songs from a style and your lyrics on 6 to 8 GB and is licensed for non-commercial use only. LTX 2.5 needs ComfyUI 0.32.0, FastH3 0.35.0 and YuE2 0.36.0. With an older ComfyUI, Create asks once and then updates it.',
      },
      {
        title: 'Edit, Remove Background and Enhance Image take several images at once.',
        detail: 'Pick or drop up to 50 source images, or a whole folder with "Add a folder". Each image runs on its own, one after the other, and the queue shows which one is running. Cancel stops the rest, and an image that fails does not stop the others and is named at the end. On LU Cloud the price per image and for the whole list is shown before you start. A model that needs a painted mask keeps one image.',
      },
      {
        title: 'Chat takes any file, not only images.',
        detail: 'The paperclip, drag and drop and paste used to turn everything but images away. They now take any file, up to 3 per message and 64 MB each. The model gets a description of the file: its name, its type, its size and the readable text in it. In Agent and Code mode the file is also copied into the working folder, so the file tools can open it. Documents you want to ask questions about still belong in Document Chat.',
      },
      {
        title: 'Qwen-Image 2.1 gets a transparent background and its prompt enhancer.',
        detail: 'On your own machine, the image settings have a "Transparent background" switch for new pictures with Qwen-Image 2.1. The picture is saved as a PNG with an alpha channel and shown on a checkerboard. The Model Manager offers the Qwen-Image 2.1 Prompt Enhancer as two downloads, Official and No Refusals, both running on a 12 GB card (issue 148). With one installed, "Improve my prompt" lets you choose who writes in the "Rewritten by" row: the enhancer or your chat model. The enhancer needs ComfyUI 0.37.2 or newer.',
      },
      {
        title: 'Dropdowns stay inside the window.',
        detail: 'On the Linux AppImage and in small windows the model list in Create opened below the bottom edge, so no model could be picked (issue 149). Every dropdown and popover now opens on the side that has room, is never taller than that room and scrolls inside. The right click menu sat a little off the pointer and now opens at it.',
      },
    ],
    details: [
      {
        title: 'Create on your own machine',
        items: [
          {
            title: 'LTX 2.5 cuts between up to four shots in one run.',
            detail: 'For text to video with LTX 2.5, the advanced settings have a Shots slider. Your prompt is shot 1 and every further shot gets a field of its own. Describe the same person the same way in every shot.',
          },
          {
            title: 'LoRA strength takes values from -10 to 10.',
            detail: 'The slider in the LoRA stack still runs from 0 to 2. Next to it is a number field for the exact value from -10 to 10, for slider LoRAs that are made for a wide range around zero. Each LoRA keeps its own value, also while it is switched off and after a restart.',
          },
          {
            title: 'The MiniMax H3 Turbo LoRA is a one click download.',
            detail: '3.0.4 said the turbo LoRA runs MiniMax H3 at 8 steps but not where to get it. It is now under Models, Video, Get new and under Models, LoRAs, Get new in a "Ready to install" list. The LoRA stack in Create shows it as soon as the download is done. FastH3 is already an 8 step model and leaves the turbo LoRA out.',
          },
          {
            title: 'Qwen-Image 2.1 comes with a text encoder without refusals.',
            detail: 'Models, Image, Get new has "Qwen-Image 2.1 (No Refusals)". It is the same image model and the same VAE with a community text encoder that has its refusal direction removed (Heretic). If you already have Qwen-Image 2.1, only the text encoder is downloaded, about 9 GB. With both text encoders installed, the Expert settings in Create have a "Text encoder" row to pick which one reads your prompt, for new pictures, for edits and for pictures made in chat. The official one stays the default.',
          },
          {
            title: 'Noct Q, an unfiltered finetune of Qwen-Image 2.1, is in the Model Manager.',
            detail: 'Models, Image, Get new has "Noct Q (Qwen-Image 2.1, Unfiltered)", a community finetune of Qwen-Image 2.1 by Noctaluna. Here the image model itself is changed: its notice says the Qwen-Image 2.1 transformer weights were modified. It uses the official text encoder and VAE, so if you already have Qwen-Image 2.1, only the image model is downloaded, about 7 GB. The app treats it as Qwen-Image 2.1: new pictures, edits with reference images, transparent background, the text encoder choice and the prompt enhancer are there for it. Qwen Research License, non-commercial use. Not yet run on our own hardware.',
          },
          {
            title: 'Models carry a Best mark, and older ones sit under "Older models".',
            detail: 'The model picker in Create and the Model Manager put the current models first with a Best mark and collect the ones a newer family has replaced under "Older models". No model was removed.',
          },
          {
            title: 'Local image, video and music models say whether they fit your graphics card.',
            detail: 'With a detected graphics card, each download in the Model Manager compares itself with it: "Fits your 12 GB card", "Tight on your 12 GB card: runs, loading can be slow" or "Needs more than your 12 GB card". The model picker in Create marks a model that is tight or needs more, and when loading such a model takes longer than a minute, the waiting line says why. The Z-Image Turbo description no longer promises 8 to 15 seconds per image, which did not hold on smaller cards. Without a detected card, as on a Mac, nothing changes.',
          },
          {
            title: '"Save character" on a video keeps frames as a character.',
            detail: 'In the large view of a video, "Save character" lets you pick frames at the playback position and give the figure a name. It is stored on this device, up to 30 photos. From there, "Use as reference photos" loads it into the reference strip, and "Train in Character Studio" starts a training set with it.',
          },
          {
            title: '"Improve my prompt" lets your chat model rewrite the prompt before a run.',
            detail: 'The switch is in the advanced settings, off by default and remembered. When it is on, the chat model you picked rewrites your prompt for the image, video or music model before the run. A cloud chat model is billed like chat. The gallery details show what you wrote and what ran. A rewrite that fails or takes too long is dropped and the run uses your own prompt.',
          },
        ],
      },
      {
        title: 'Create on LU Cloud',
        items: [
          {
            title: 'Qwen Image 2.1, LTX 2.5, MiniMax H3 and Wan 3.0 Reference.',
            detail: 'The cloud pickers in Create have five additions from open model families: Qwen Image 2.1 for images, Qwen Image 2.1 for editing, LTX 2.5, MiniMax H3 and Wan 3.0 Reference. LTX 2.5 makes video from a prompt or from a first frame. MiniMax H3 now also starts from a prompt alone, works from reference photos and edits a clip from an instruction. A model shows up once the cloud catalogue lists it. "Open weights" next to a name means this exact version has open weights, "Open family" means its family has them and this version does not.',
          },
          {
            title: 'Image and Edit make up to four images per run.',
            detail: 'The settings have an Images slider from 1 to 4. Each image is its own job at its own price, lands in the gallery when it is done, and is refunded alone if it fails. The credit counter shows the total before you start.',
          },
          {
            title: 'Reference models take several of your photos.',
            detail: 'Models that work from reference photos, such as MiniMax H3 Reference and Wan 3.0 Reference, and the editors that take more than one image now have a strip under the source image for up to five photos.',
          },
          {
            title: 'Edit starts without a mask on models that need none.',
            detail: 'With a model that edits from the instruction alone, the Edit stage still showed "Paint mask" and the Create button waited for one. The stage now says the model needs no mask, and Create starts with the source image and your prompt.',
          },
          {
            title: 'Settings stay with the model and the tool they were chosen for.',
            detail: 'The Images slider is in the advanced settings for every Image and Edit model and goes back to 1 when you change the tool. Settings chosen for one model no longer carry over to the next one. In Music, the length slider and the Lyrics or Style field show only where the model reads them, and a tool without a prompt field sends no leftover prompt.',
          },
        ],
      },
      {
        title: 'Chat',
        items: [
          {
            title: 'Each model in a group chat can have its own persona.',
            detail: 'In the Plugins menu under Group chat, every model row has a persona picker. Each model then speaks as its persona, knows the names of the others, and a line it writes in another one\'s name is cut. A group without a pick works as before.',
          },
          {
            title: 'LU Cloud picks no chat model for you.',
            detail: 'In Cloud mode a new account chatted on the first model of the list without ever having picked it. The picker button now reads "Choose a model" until you pick one. Sending without a model keeps your message and its attachments and opens the picker. A model you picked yourself stays picked. If your Cloud chat stood on that first model, Llama 3.1 8B Turbo, the pick is cleared once. Local mode still picks a model on its own.',
          },
          {
            title: 'An answer that declines says what to do next.',
            detail: 'When a model declines, a line under the answer says so: a refusal stays in the chat history, and other models tend to copy it. "New chat" in that line opens a fresh chat with the same model, and the line points you to the models marked No refusals.',
          },
          {
            title: 'The model picker in Cloud mode has a search and tags.',
            detail: 'In Chat, Agent and Code, the Cloud model list is grouped by model family and has a search field. Four tags narrow it: No refusals, Vision, Thinking and No credits. A row shows the name, the No refusals mark, image input, thinking and the context size where the server states it. The "?" on a row opens the credit rates per 1M input and output tokens. Arrow keys move, Enter picks and Escape closes. On LU Cloud, the model select in Create has the same family heads. The local model list is unchanged.',
          },
          {
            title: 'LM Studio is one line in the local model list.',
            detail: 'When LM Studio is installed and its server is off, the local model list showed a box with a paragraph of text. It is now a single line with a status dot, the number of models on disk and a small Start button. What Start does to your local chat backend is in the tooltip of the button. While the menu is open the line follows the server: it goes away once the server is up and its models are in the list, and it comes back when the server stops, and the models leave the list with it. The number counts chat models only, without embedding models and vision projectors, so it matches the list after Start.',
          },
          {
            title: 'Five cloud models no longer carry the No refusals mark.',
            detail: 'Qwen3 30B A3B, Qwen3 Coder 480B, Llama 4 Scout, DeepSeek V4 Flash 0731 and Qwen 3.5 397B A17B declined in the second or third round of a longer test on 2026-10-05. The mark is a promise about every request, so they lose it. No other model changed.',
          },
        ],
      },
      {
        title: 'Fixes',
        items: [
          {
            title: 'Linux: speech to text and Piper install again.',
            detail: 'On Ubuntu 24.04 and other distributions that protect the system Python, installing faster-whisper and Piper ended with "Can not perform a \'--user\' install" when ComfyUI ran in its own Python environment. The installer mistook that environment for the protected system Python and added options pip refuses there. It now recognises the environment and installs into it.',
          },
          {
            title: 'Image settings survive a visit to Music, Lip sync or Motion.',
            detail: 'Steps, CFG and Quality for images came back changed after you opened Music, Lip sync or Motion in between. Quality on Draft, for example, read High with 50 steps afterwards. The same happened when the app was closed on one of those tabs. Each tab now keeps its own values, and a distilled video model keeps its few steps instead of the 30 of its model family.',
          },
          {
            title: 'Draft, Standard and High follow the model you picked.',
            detail: 'The Quality buttons for images counted from the step count of the model family, so on a checkpoint built for a few steps, such as SD Turbo with 4, Draft meant 15 steps and the image came out overcooked. Standard is now the model\'s own step count, and Draft and High scale from it. "Reset to model defaults" goes back to those values as well, for images and for fast video models.',
          },
          {
            title: 'A failed subscription payment is shown as one.',
            detail: 'When a renewal payment failed, the account window said "No active plan" and the Cloud window offered the plans again, although a new plan cannot be bought until the open invoice is paid. Both now say that the last payment failed and have a "Pay open invoice" button that opens your account on lu-labs.ai in the browser. Credits you bought stay usable, also after a plan has ended.',
          },
          {
            title: 'A model download checks its checksum on a retry too.',
            detail: 'After a failed download, Retry and Resume started the file again without its SHA-256 and expected size, so the second attempt was not verified. Both are kept now. A file with the same name but another size no longer counts as installed where the catalogue knows the exact size.',
          },
        ],
      },
    ],
  },
  // 3.0.4: der Code-Agent auf LU Cloud. package.json, Cargo.toml/.lock und
  // tauri.conf.json stehen im selben Zug auf 3.0.4. 3.0.3 darunter bleibt
  // unveraendert. Released 02.10.2026.
  {
    version: '3.0.4',
    headline: 'A fix for the Code agent on LU Cloud: long file writes no longer end the run, "continue" picks up where the run stopped, and the agent no longer spends requests on steps you did not ask for. Plus the bugs reported on GitHub and Discord since 3.0.3.',
    lines: [
      {
        title: 'Edit takes more than one image.',
        detail: 'With Qwen-Image 2.1 or Qwen-Image-Edit on your own machine, small tiles under the source image take up to three more images (two for Qwen-Image-Edit). Name them in the prompt as image 2, image 3, for example "put the jacket from image 2 on the person".',
      },
      {
        title: 'MiniMax H3 runs as a video model with sound.',
        detail: 'A MiniMax H3 file showed up as an image model. It now sits in the video list, also under a CivitAI name, and renders picture and sound together, from a prompt or from a first frame. The Model Manager offers it as one download, and the 8-step turbo LoRA runs at 8 steps.',
      },
      {
        title: 'The setup offers models without refusals.',
        detail: 'The two chat models the first start suggests are now the abliterated builds of Qwen 2.5 7B and Qwen 3.5 9B, same size and speed as before. The 9B refused some requests.',
      },
      {
        title: 'A download speed limit, and usage numbers for the Local API.',
        detail: 'Settings, Model Storage takes a limit in MB/s for the model files LU downloads, shared by all downloads at once. While the Local API runs, its panel shows requests, failures, tokens in and out as the model server reports them, and the last model.',
      },
      {
        title: 'Fixes from GitHub and Discord.',
        detail: 'A group chat answers with every LU Engine model in it, also when the models sit in your Model Storage folder. Ollama models download without one already installed. A GGUF from the CivitAI search lands where ComfyUI reads it. A fresh ComfyUI install on Windows gets its own Python environment, which fixes "hipdnn_backend.dll Bad Image" on AMD cards. The window no longer disappears on Linux. A character trained on your own machine takes up to 100 photos, and Details on an LM Studio model says where to delete it. A newer image or video model with a missing encoder or VAE names that file and offers the download, instead of ending in "Value not in list". A LoRA deleted from the loras folder leaves the stack, a run only sends LoRAs ComfyUI lists, and Clear turns the stack off. The Code agent runs tool calls a cloud model writes into its answer or sends under the name "function", instead of stopping on them. A downloaded render is always the one you picked, and Download in the gallery strip opens the Save dialog on Windows. Create no longer offers the starter download while ComfyUI is still starting, and Turbo or Lightning checkpoints start at 4 steps. The Code area has an input box even before the first code conversation, and an installed .ckpt model no longer shows as safetensors. A render that left a LoRA out says so under the picture, a Cancel in the download question reads Not started instead of Generation failed, New Chat in Code no longer adds an empty session, and switching from Video back to Image gives the image model its own settings again.',
      },
      {
        title: 'Writing a long file no longer ends the run.',
        detail: 'While a model writes a file, the app receives the file in pieces but shows no text. After five minutes without text it treated the connection as stalled and ended the run in the middle of the write, and the next run started that step again. The app now ends a run only when no data arrives at all.',
      },
      {
        title: '"continue" picks up where the run stopped.',
        detail: 'After a stop or an error, the next message lost the steps the run had already done, and the agent started over. Those steps are now kept for the next message, also after a stop, and older steps that no longer fit are kept as a short list of what is already done.',
      },
      {
        title: 'The agent keeps a plan only when you ask for one.',
        detail: 'The Code agent wrote a todo list for almost every task and sent an update after each step, each one a request of its own. It now keeps a plan in Plan mode, when you ask for a plan, or while a plan is still open. The plan panel and the approval bar are dark instead of blue.',
      },
      {
        title: 'Fewer requests for the same work.',
        detail: 'The agent is now told to read several files in one step instead of one request per file, and file_edit changes several places in a file in one call, also when the indentation in the file differs slightly from the model\'s copy.',
      },
      {
        title: 'Cloud context is 32K by default and can be set per model.',
        detail: 'Cloud models now send at most 32K of context by default instead of 64K. You can change it per model in the context menu in the header. Once you set it above the default, a small triangle shows that every message then sends more and costs more credits.',
      },
      {
        title: 'The agent stops repeating a tool that fails.',
        detail: 'Tools report most failures as text, and the loop guard only counted an unknown tool as failed, so a run could repeat a failing call until its round limit. Failed calls now count, and a call the model was cut off in the middle of is not run half-written.',
      },
      {
        title: 'Ask mode asks before tests, commits, pushes and pull requests.',
        detail: 'It used to ask only before shell commands. The card shows every argument, two approvals at once wait in line, and a tool you switched off in the permissions is refused. The "Stage writes for review" setting is gone: the mode decides, and auto-apply only applies what the finished run staged.',
      },
      {
        title: 'Fixes in Chat and Create.',
        detail: 'An error message is no longer overwritten by the last frame of the answer, and Regenerate no longer deletes your question when nothing can be sent. Cancel on a render a GPU already took says it will finish and be charged, and a submit whose answer got lost no longer leaves a paid job you never see.',
      },
      {
        title: 'The run says which tool the model is writing.',
        detail: 'A model writing a long file sends the call in pieces for many seconds, and the run said only "Working" the whole time. It now shows the tool\'s name and how much of the call has arrived as soon as the first piece is in. A run waiting for your approval says so in the chat too, and Stop before the first word leaves a note instead of an empty answer. Stop pressed right after Send ends the run on the first press; before, the run could keep going or hang on "Working".',
      },
      {
        title: 'Code conversations stay in the Code tab.',
        detail: 'After a restart the last Code conversation opened in the Chat tab, where the agent was off and a "continue" ran without tools. The app now opens the chat you worked on last, and the Chat and Code buttons each take you back to the conversation you worked on last there, also while a run is going.',
      },
      {
        title: 'Fewer interruptions while the agent works.',
        detail: 'New in the Code tab keeps Ask or Bypass, whichever you picked last. In the agent chat, reading, listing and searching files in the agent\'s own folder no longer asks for approval; writing still does. When the agent fixes a failed step on its own, the steps no longer show a red mark and no line asks you to try again. After you say No to a tool, the model is told its other tools are still there, so it carries on instead of saying it has none. The clock next to "Waiting for your approval" counts the wait, and a tool\'s time no longer includes the time the card waited for you. No "Thinking" label shows while a model that does not think is working, an answer that is still arriving shows no stray backtick or asterisks, the context counter shows the right size from the first message, and the mode menu in the Code tab is no longer cut off. No approval card appears for a file outside the agent\'s folder, which it could never open anyway. Asked to write a new file somewhere outside, the agent writes it inside its folder and tells you. A new Code session lists its still empty folder as empty instead of reporting an error, a failed step shows its error once, and pressing New again on an untouched Code session adds no extra empty entry. The hint about the agent\'s folder stays with the chat it belongs to, and asking the chat to put a file name in backticks no longer starts a file write.',
      },
    ],
  },
  // Stand 28.09.2026: 3.0.3 IST veroeffentlicht und bleibt unveraendert
  // (Gedaechtnis lu-265-plan-2026-08-10, "release-notes.ts vergessen = stummes
  // Release"). 3.0.2 IST veroeffentlicht (v3.0.2 auf 1472e7ad, 22.09.2026) und bleibt
  // wie 3.0.1 und 3.0.0 darunter unveraendert. Der Hotfix 3.0.3 bringt den
  // Chat-Speicherfix, die Create-Fehler aus Discord und die GitHub-Issues 139
  // bis 143; dieses Blatt ist diesmal die einzige Ankuendigung (der Inhaber,
  // 28.09.2026: kein Discord-Post, "die Changelogs in der App reichen").
  {
    version: '3.0.3',
    headline: 'A hotfix: chats with many images no longer run the app out of memory, Create reads a model\'s family from the file, and the five bugs reported on GitHub since 3.0.2 are fixed.',
    lines: [
      {
        title: 'Chats with many images no longer run the app out of memory.',
        detail: 'Every image was kept inline in the saved chat history, and a few chats with phone photos were enough to make that history too big for the app\'s memory. On Windows it could not be saved at all once it passed 127 MiB. Images are now stored as separate files outside the history, and your history is moved over once, on the first start of this version. Chats and messages that only the app\'s backup file still held are restored from it once.',
      },
      {
        title: 'Create reads a model\'s family from the file, not from its name.',
        detail: 'Renders failed with "Value not in list" for models whose file name did not say what they are, which on CivitAI is most of them. Create now reads the family from the file header and loads the model from the folder it sits in, with pipelines of its own for Chroma, HiDream I1, SD 3.5, Lumina 2, Qwen-Image and Qwen-Image-Edit. If a text encoder or VAE is missing, or ComfyUI on this machine is too old, Create asks once, then downloads the file or updates ComfyUI.',
      },
      {
        title: 'Stop works in the Code tab again, also in the /loop bar.',
        detail: 'Both Stop buttons in the Code tab stopped nothing (issue 140): they passed the click event where the stop function expected a conversation. The one next to the prompt box and the one in the blue /loop bar both stop the run again.',
      },
      {
        title: 'Typing in the prompt box no longer lags in long chats.',
        detail: 'Each key made the page lay out the whole visible chat twice to size the box, so the delay grew with the conversation (issue 139). The box is now measured on a hidden copy and resized only when a line is added or removed.',
      },
      {
        title: '"Full body" in a chat image now shows the whole figure.',
        detail: 'The chat\'s image tool rendered every picture in the model\'s square default, and SDXL, Pony and Illustrious models crop a whole person in a square frame to the face (issue 142). When the prompt asks for a whole figure and names no size, the picture now gets the upright frame those models were trained on.',
      },
    ],
    details: [
      {
        title: 'Create',
        items: [
          {
            title: 'Edit keeps your photo at full strength.',
            detail: 'At strength 1.00, Edit dropped the source image without a word and painted a new picture from the prompt alone. It always keeps the source now, and the slider stops at 0.95, the strongest repaint that still starts from your photo.',
          },
          {
            title: 'A gallery picture can be dragged into Edit.',
            detail: 'Dragging a picture from the gallery onto the Edit drop zone did nothing. It now loads the picture, as a click already did.',
          },
          {
            title: 'Deleting a render in the gallery removes its file too.',
            detail: 'Deleting a local render, also from the large view, now moves its file to the Recycle Bin (Windows) or the Trash (Linux), so the ComfyUI output folder stops growing. Before, only the gallery entry went.',
          },
          {
            title: 'Gallery tiles come back when ComfyUI does.',
            detail: 'Tiles that went dark while ComfyUI was not answering come back as soon as it answers. They used to stay dark until the next start.',
          },
          {
            title: 'A bare VAE or text encoder is no longer offered as a model.',
            detail: 'A VAE or text encoder file that sits in a model folder no longer shows up in the model picker, where it could never run.',
          },
          {
            title: 'Downloads work with a ComfyUI on another machine.',
            detail: 'With ComfyUI running on another computer, model downloads failed with "permission denied" or "ComfyUI path not set" (issue 143). They now go to the Model Storage folder, in ComfyUI\'s own folder layout, and the Model Manager and Create say what is left to do on that machine: copy the folders over or share them, and install any node packs a bundle needs there.',
          },
        ],
      },
      {
        title: 'Chat and Code',
        items: [
          {
            title: 'The agent shows which folder it works in, and how to reach your files.',
            detail: 'Setting every agent permission to Auto never let the agent open files outside the chat\'s working folder, and a dismissed folder dialog left it in its own sandbox without a sign. The button next to Agent now always shows where the agent works, Sandbox included, and one click leads to "Pick a folder…". A file refused for being outside that folder brings up a line above the chat that says what to do, and Settings no longer says Filesystem reaches files anywhere. Plain chat has no tool that reads your files, so asking it for one now brings up a line that says to turn on Agent.',
          },
          {
            title: 'A /loop pass that ends early no longer leaves the loop running.',
            detail: 'A loop pass that ended before it could arm the next one left the bar on "running" and the working folder locked. The loop now ends with it.',
          },
          {
            title: 'A step too large for the server\'s context is shortened and sent again.',
            detail: 'When a server refuses a step because the request exceeds its context size, the step is sent again with the history shortened to fit, and the pass goes on. Later steps start at that size.',
          },
          {
            title: 'The recent list in the collapsed sidebar follows the mode.',
            detail: 'With Code or Remote picked in the collapsed sidebar, the recent list showed the plain chats (issue 141). It now lists that mode\'s chats, and opening one stays in that mode.',
          },
          {
            title: 'Image previews in a long chat load only near where you are reading.',
            detail: 'In a long chat, image previews load only near the part you are looking at, so scrolling through many images keeps memory low.',
          },
        ],
      },
    ],
  },
  {
    version: '3.0.2',
    headline: 'A hotfix for the Code tab: a long conversation scrolls again and the input box stays in view. The count of open cloud models also takes the Create Studio shelf in now.',
    lines: [
      {
        title: 'The Code tab scrolls again, and its input box stays in view.',
        detail: 'The Code tab lost its scrollbar and its input box once a conversation grew taller than the window (issue 138, a regression in 3.0.1). The frame around the transcript and the composer stopped being a scroll container, so it grew with the transcript instead of staying inside the window: only the start of a long conversation was visible, the mouse wheel did nothing, and the composer with its toolbar sat below the bottom edge. The frame is held to the window height again, so the transcript scrolls and the input box stays where you can reach it. The Chat tab was never affected.',
      },
      {
        title: 'The count of open cloud models now takes the Create Studio shelf in.',
        detail: 'Fourteen video models and seven image models in the cloud catalogue run without a built-in content restriction, counted the way a customer picks them: every catalogue entry marked open, whether it sits in the classic picker or on the Create Studio shelf. The old rule left the Studio shelf out and reported ten and three, so four open image-to-video endpoints and four open image models were sold short. Two of the fourteen, OpenVideo and OpenVideo + Style LoRA, do not carry Uncensored in the name and are open all the same; the mark comes from the catalogue field, never from the name.',
      },
    ],
  },
  {
    version: '3.0.1',
    // Auflage 4 (Bauer, Runde 2, 19.09.2026): die zwei Saetze, die unter der
    // Ueberschrift stehen. Der alte Satz hier war der GPU/Umgebungsvariablen-
    // Satz aus Auflage 1, in Entwicklersprache und nur ueber EINEN der 35
    // Fixes; er ist durch eine kurze Einordnung ersetzt. CHANGELOG.md behaelt
    // seinen eigenen, technischeren Einleitungssatz (Auftrag Punkt 6: das
    // CHANGELOG bleibt unveraendert), die zwei Texte duerfen auseinanderlaufen.
    headline: 'This update fixes bugs you reported since 3.0.0. Most of them sit in the local engine on older machines, ComfyUI on Linux, the Stop button, and chats running at the same time.',
    lines: [
      {
        title: 'Local models now run on older processors without AVX2.',
        detail: 'The local engine now picks its CPU code path at startup, so older processors without AVX2 can run local models instead of the engine exiting right after start.',
      },
      {
        title: 'GPU memory that cannot be measured now gets a safer estimate.',
        detail: 'On a GPU where the free VRAM could not actually be measured (no nvidia-smi, for instance), the LU Engine used to plan layers as if the whole card were sitting empty and log "N MiB are free" for a number that was really the total size, other programs included. It now takes a bigger safety margin on that weaker reading and logs it correctly as total capacity, not free memory, so a start plans fewer layers rather than too many.',
      },
      {
        title: 'Linux AppImage programs no longer inherit its own environment variables.',
        detail: 'Linux AppImage: a foreign program the app starts (git, a system Python, pip, ffmpeg, nvidia-smi, the coding agent shell, and now every program the Character Trainer starts too) no longer inherits the AppImage runtime\'s own LD_LIBRARY_PATH, PYTHONHOME and related variables. That inheritance made a perfectly healthy system Python fail to import ssl or find its standard library, with a diagnosis that pointed at a broken Python install rather than the real cause.',
      },
      {
        title: 'Pip installs work again on Linux distros that block system Python.',
        detail: 'On a platform where pip refuses to write into the system Python (Arch, Debian 12+, Fedora 38+, Ubuntu 23.04+), the isolated venv LU already built there no longer dies at the first pip call, and the same fix keeps the Coding Agent\'s own terminal from picking up the same poisoned environment for every git, pip or python command typed into it.',
      },
      {
        title: 'ComfyUI installs now pick a Python version PyTorch supports.',
        detail: 'Installing or repairing ComfyUI, LU now searches the interpreters already on your machine for one PyTorch actually ships wheels for, and uses that one automatically, with no picker in Settings. If none is found, it says so and tells you what to install before starting the roughly 2 GB PyTorch download, instead of that download running for minutes and then failing with pip\'s own generic error.',
      },
    ],
    // Auflage 3 (Bauer, 19.09.2026): dieselben 30 Zeilen wie zuvor, kein
    // Wort geaendert (die Anker in releaseNotesStore.test.ts binden sie
    // woertlich), nur auf vier Themen verteilt statt in einem Eimer
    // "Fixes". 35 Zeilen in einem Block sind auf dem Blatt schwer zu lesen;
    // vier betitelte Gruppen sind es nicht.
    //
    // Auflage 4 (Bauer, Runde 2, 19.09.2026): jede Zeile bekommt zusaetzlich
    // einen `title`, den kurzen Satz, den das Blatt jetzt zeigt, bevor jemand
    // klickt. `detail` ist zeichengleich mit Auflage 3, also mit dem, was die
    // Waechter unten binden.
    details: [
      {
        title: 'Engine and hardware',
        items: [
          {
            title: 'A crash on an old CPU now names the missing instruction set.',
            detail: 'The LU Engine crashing immediately on an old CPU now says which instruction set is missing, measured from the CPU itself rather than guessed, and stops retrying the same binary a second time since it would only fail the same way again.',
          },
          {
            title: 'Engine startup messages now say clearly what stage a model is in.',
            detail: 'The engine startup probe\'s log line read as if a model that is still loading, one that is thinking, and one that has genuinely failed all looked the same. The wording for each case is distinct now.',
          },
          {
            title: 'The automated build check now reports each platform\'s failures separately.',
            detail: 'The CI check that runs on every pull request now fails independently on each platform instead of one platform\'s failure hiding whatever the other platform would have found.',
          },
          {
            title: 'A chosen GPU stays selected even if the system renumbers cards.',
            detail: 'Picking a specific GPU for a local model or the Character Trainer now keeps using that physical card even if Windows or Linux renumber the cards between detection and start.',
          },
          {
            title: 'The Hardware tab no longer freezes while a model is starting.',
            detail: 'Opening the Hardware tab in Settings while a local model or the trainer was starting up could freeze it for a moment; it no longer waits on that GPU detection.',
          },
          {
            title: 'Windows: a very long install path no longer stops the engine from starting.',
            detail: 'Windows: installing to a very long folder path no longer stops the bundled engine from starting, and when Windows cannot shorten that path, the app now names the install path as the cause instead of showing a bare OS error.',
          },
        ],
      },
      {
        title: 'Chat and agents',
        items: [
          {
            title: 'Two chats running at once no longer mix up their text.',
            detail: 'Sending in one conversation while another is still streaming no longer mixes their text together, and a second agent run no longer gets silently dropped while the first one is still going, both now finish on their own.',
          },
          {
            title: 'A waiting chat now shows its place in the queue.',
            detail: 'The local model runs one conversation at a time, and a chat that has to wait its turn now says so, with a line showing how many chats are ahead of it. Stop works while it is still waiting, and takes it out of the line.',
          },
          {
            title: 'Stop now reaches every conversation, not just the open one.',
            detail: 'Stop, signing out and quitting the app now reach every conversation, including one that has not started running yet and is only waiting its turn, not just the one open on screen.',
          },
          {
            title: 'Temperature and other sliders now apply to one chat only.',
            detail: 'Moving the Temperature, Top P or Max tokens slider now changes that one conversation only, instead of every open chat sharing one value from the Settings page. A chat with no slider of its own still follows Settings, and a field nobody moved anywhere is left out of the request so the model applies its own default.',
          },
          {
            title: 'Stop now also ends commands the coding agent started.',
            detail: 'Pressing Stop while the Coding Agent is running code now actually stops that run, the same way it already stopped a shell command.',
          },
          {
            title: 'Workflow steps now ask for approval like the rest of Agent mode.',
            detail: 'Workflow steps now go through the same tool approval as the rest of Agent mode, and only offer the tools your permissions allow. Built-in workflows now take their input from the call itself instead of waiting forever for an answer nobody could give, and the Play button in Settings under Agent Workflows that never did anything is gone.',
          },
          {
            title: 'A foreground sub-agent is no longer cut off after 60 seconds.',
            detail: 'A sub-agent delegated in the foreground is no longer cut off after 60 seconds, and a timeout or Stop now actually ends the tool call it was running instead of leaving it running in the background.',
          },
          {
            title: 'Multi-line memory entries survive export and import again.',
            detail: 'A memory entry with more than one line survives export and import again, both separator styles the web writes are read back, and one sensitive memory entry no longer blocks the whole sync.',
          },
          {
            title: 'Sending in one chat no longer locks every other chat.',
            detail: 'The composer lock during a send now only affects that one conversation, not every open chat, Stop in one chat no longer cancels an image or video render running in another, and picking a third remembered agent folder now asks for confirmation like the first two do.',
          },
          {
            title: 'On Windows, Stop now also ends a build just started.',
            detail: 'On Windows, pressing Stop on a command that had only just started now also ends the worker the shell launches a moment later, so a build or install cancelled at the very beginning stops instead of running on and writing files in the background.',
          },
          {
            title: 'A timed-out cloud chat request no longer retries for minutes.',
            detail: 'A Cloud chat request that hits its own four minute limit is now treated as finished right away instead of being retried up to three more times with the same four minute wait on each try.',
          },
          {
            title: 'The No refusals mark is easier to notice in the picker.',
            detail: 'The No refusals mark in the desktop model picker now carries an icon and bolder text so it is actually noticeable, instead of blending into the smallest text on the row.',
          },
          {
            title: 'Dismissing the stale model notice now actually dismisses it.',
            detail: 'Dismissing the stale model notice in the chat header now actually dismisses it, instead of it reappearing on the very next update.',
          },
          {
            title: 'The coding agent now explains why it cannot change folders.',
            detail: 'The reason the Coding Agent will not let go of its current folder is now shown as a visible line, instead of only a tooltip a disabled button never shows.',
          },
          {
            title: 'The Memory sources chip under every answer is gone.',
            detail: 'The Memory sources chip under every AI answer is gone; the purple brain icon in the session strip below the transcript, right above the composer, still opens Memory.',
          },
          {
            title: 'A draft no longer merges into the next chat after switching.',
            detail: 'A draft left in the message box no longer merges into the next thing you type after switching conversations, and the composer no longer gets stuck showing Stop after closing the window, signing out or quitting with a message still in flight.',
          },
          {
            title: 'A brand new chat no longer shows a blank screen.',
            detail: 'Right after "+ New Chat", with the side panel open, the main area could stay completely empty: no greeting, no history, nothing, even after a full reload of the same still-empty chat. Only switching to another tab and back brought it around. The greeting now shows for that chat from the first frame, the same as before the first message is sent.',
          },
          {
            title: 'Switching to Cloud no longer drops a local generation running elsewhere.',
            detail: 'Switching the app to Cloud used to free the local engine right away, even while another chat, agent, code or group run was still generating on it, and that run then ended with "Connection dropped". The switch to Cloud itself still happens right away; only that memory cleanup now waits until every local run in progress has ended (normally, by Stop, or by failing), and it is skipped entirely if you switch back to Local before that.',
          },
          {
            title: 'A workflow now tells you where it stopped instead of claiming success.',
            detail: 'A step whose web search or page fetch failed, or whose model answered nothing, ends the run with "Workflow stopped at step 2 of 6: ..." instead of carrying on and finishing with "Workflow complete"; a run that really did finish leads with its actual result rather than the "Saved to memory" receipt.',
          },
          {
            title: 'Running a workflow from chat now shows its progress, step by step.',
            detail: 'Running a workflow from chat ("run workflow ...") now shows its own progress, clickable and expandable exactly like a tool call: every step listed as waiting, running, done or failed, each finished step\'s result, and the currently running step\'s answer streaming in live. Before this it showed no more than three static dots for the whole run, sometimes several minutes, with no way to tell it was still working. A model step also now has an upper bound on how long it may reason before it must answer. Stop ends the progress block visibly instead of leaving it looking like it is still running, whether Stop was pressed mid-run or the app was closed and reopened partway through.',
          },
        ],
      },
      {
        title: 'Create',
        items: [
          {
            title: 'Animate this image now works from Create in the desktop app.',
            detail: 'A finished image in Create has an Animate this image button that carries it straight into a video render, the same as the browser studio, and the No refusals mark now shows on cloud models in the desktop picker as well.',
          },
          {
            title: 'qwen-image-edit is selectable again, and Krea 2 loads correctly.',
            detail: 'qwen-image-edit is selectable from the seed and edit pickers again, the upscale tool is named Enhance Image to match the web, and Krea 2 checkpoints load with the right UNET, CLIP and VAE nodes instead of falling back to an unknown loader.',
          },
          {
            title: 'Create now blocks a render before it fails on the server.',
            detail: 'The Create button now stays disabled instead of failing on the server when the chosen model needs a mask that was never supplied, and the local character LoRA list refreshes itself right after a training finishes instead of needing a restart.',
          },
          {
            title: 'A failed cloud render now explains itself instead of one error.',
            detail: '"Failed to fetch" is no longer shown as the whole explanation for a failed cloud render, and the out of credits dialog now has a distinct title for each of its three reasons instead of one generic one.',
          },
          {
            title: 'The model picker no longer crashes when grouping by family.',
            detail: 'The model picker no longer crashes when grouping models by family, a custom OpenAI compatible endpoint now receives Top K, a model name is no longer cut off at its first colon, and a newly added provider starts with no value pre filled.',
          },
          // P9 (19.09.-20.09.2026, Portplan Abschnitt 5): das Studio aus dem
          // Web nach Desktop 3.0.1 portiert. Vier Zeilen, jede zeichengleich
          // mit einem Punkt der Auftragsvorgabe: Presets+gefuehrter Weg,
          // Anbieterschema+bestaetigter Preis, Cliplaengen je Modell,
          // Charakter-LoRA-Passung. Keine ueber die Quelle hinausgehenden
          // Erwachsenenvokabeln, kein Tokens-je-Euro, und das Versprechen
          // haengt ehrlich an der Server-CORS-Lage (Portplan Abschnitt 4:
          // "Nie eine Serverversion fest verdrahten", die Erkennung laeuft
          // ausschliesslich ueber die Anwesenheit von quote_required im
          // Katalog).
          {
            title: 'Create-Studio: a new guided path on the cloud track.',
            detail: 'A preset shelf next to the usual Create tab walks a render from image to motion to sound, in steps, each backed by any model that can do that step\'s job. Each step\'s controls come straight from the picked model\'s own provider schema, and the price shown is the one the provider actually confirms before Start, never a formula guessed on this side. This needs a server change that has not shipped on lu-labs.ai yet; until it does, the shelf stays hidden and every Create tab behaves exactly as before. If a future server ever advertises Studio without also fixing the two price-check routes, Create shows "This feature needs a newer LU Cloud server. Try again later." instead of guessing a price or booking one.',
          },
          {
            title: 'Cloud video renders now offer exactly the lengths a model actually supports.',
            detail: 'Cloud video renders now offer exactly the clip lengths the picked model actually supports, read from the live catalog, instead of a fixed 5s/8s pair for every model.',
          },
          {
            title: 'A cloud render without a prompt still gets a real name in the gallery.',
            detail: 'A cloud render without a prompt (a presenter reading a script, for example) still gets a real name in the gallery, instead of an empty tile.',
          },
          {
            title: 'Character LoRAs now only offer models trained for that character.',
            detail: 'Character LoRAs in Create now only offer the models actually trained for that character\'s family, so the picker cannot suggest a combination that would fail to generate.',
          },
        ],
      },
      {
        title: 'Backends and settings',
        items: [
          {
            title: 'Troubleshoot now tests the LM Studio address you configured.',
            detail: 'The Troubleshoot panel now tests the LM Studio address you actually configured in Settings, instead of always trying the default 127.0.0.1:1234.',
          },
          {
            title: 'Replacing a backend no longer throws away its API key.',
            detail: 'Replacing an OpenAI compatible backend now parks the API key it displaces in the OS keychain instead of dropping it, and gives it back if you switch back to that backend or remove the one that replaced it. The warning that a key will be lost only shows on a device with no keychain to park it in.',
          },
          {
            title: 'Picking the trainer\'s install folder at first setup now redirects its caches too.',
            detail: 'Setting an install location for the Character Trainer during first setup now also redirects pip, Hugging Face and torch\'s own caches there, so choosing a folder off a small system drive keeps those caches off it too. This applies at first setup only; there is no way in the app yet to move an already installed trainer to a different folder. The field itself now rejects a path it cannot actually use, always shows the folder it will really install to, and an emptied field goes back to the default; the Z Image base model downloads always follow your configured model folder in Settings, ComfyUI, either way.',
          },
          {
            title: 'Linux: a ComfyUI install missing python3-venv now says so.',
            detail: 'The install used to end with "venv creation failed:" and nothing after the colon, because Python prints its python3-venv hint on stdout, and LU only read stderr.',
          },
          {
            title: 'The Models folders tab now opens faster on the first click.',
            detail: 'The first click into the Models folders tab is faster, since it asks the running engine directly instead of falling back to a stale cache, and the onboarding VRAM hint asks LU\'s own probe first so it works before ComfyUI is installed.',
          },
          {
            title: 'Settings now says when Ollama is reachable but switched off.',
            detail: 'Settings now says when Ollama is reachable but switched off, instead of just Reachable, which read as if it were actually being used.',
          },
          {
            title: 'A backend that is not running reads as Not running on Windows.',
            detail: 'On Windows, the Troubleshoot panel now says Not running for a backend that is switched off, instead of Reachable, slow to answer, which read as if the backend were alive and merely busy.',
          },
          {
            title: 'Local Media now mentions that a Hugging Face token helps.',
            detail: 'The Local Media (Apple MLX) panel now mentions that a Hugging Face token can help its downloads, the same hint ComfyUI already gives for its own model downloads.',
          },
          {
            title: 'Reinstall trainer now confirms before it starts.',
            detail: 'Reinstall trainer in Character Studio now opens a confirmation dialog first, showing the current trainer folder, instead of starting the reinstall the moment the button is clicked. A reinstall never changes the trainer folder itself.',
          },
          {
            title: 'The model marks now live in the model list only.',
            detail: 'The model marks now live in the model list only, the line above the message box is gone; the Flash notice sits next to the Agent toggle.',
          },
          {
            title: 'A narrow window no longer scrolls the whole chat sideways.',
            detail: 'At a narrow window width, picking a model, opening the sampling sliders or opening the plugins menu used to leave the whole chat shifted sideways afterward, because the shared chat area allowed the browser to scroll it into view when a clicked control sat partly off screen. That area no longer accepts a programmatic scroll, so it stays put.',
          },
          {
            title: 'Models now has a LoRAs tab that searches and installs from CivitAI (Windows and Linux).',
            detail: 'On Windows and Linux, Models has a LoRAs entry of its own next to Chat, Image and Video. Get new searches CivitAI for LoRAs and downloads what you pick into ComfyUI\'s models/loras folder; Installed lists what is already there with its size, marks the characters you trained yourself with their trigger word, and deletes a file you no longer want. LoRAs no longer sit unnamed among the checkpoints in the Image tab, where one could be picked as if it were a main model. The tab is not offered on a Mac, where local media runs on Apple MLX and there is no ComfyUI loras folder to list.',
          },
          {
            title: 'Update ComfyUI now asks first and refuses while ComfyUI is busy.',
            detail: 'Update ComfyUI in Settings now shows a confirmation dialog before it starts. It stops LU\'s own running ComfyUI first if there is one, refuses while a ComfyUI this app did not start or one that is generating something holds the port, and puts the ComfyUI code back to the version it had before if you cancel partway through; Python packages already installed during that attempt are not undone.',
          },
        ],
      },
    ],
  },
  // 3.0.0 ist getaggt (v3.0.0, 10df943e, 14.09.2026) und auf origin: dieser
  // Eintrag ist der VEROEFFENTLICHTE Notizzettel und darf nachtraeglich
  // keine Zusage mehr bekommen, die die veroeffentlichte 3.0.0 nicht
  // enthielt. Solange package.json auf 3.0.0 steht, haelt der Waechter in
  // stores/__tests__/releaseNotesStore.test.ts diesen Eintrag an der
  // Version; der 3.0.1-Entwurf oben steht daneben, nicht an seiner Stelle.
  {
    version: '3.0.0',
    headline: 'Uncensored, measured instead of promised, and Flash chat that costs nothing on a plan',
    // Gelesen, nicht getippt: dieselben Funktionen, die das Verkaufs-Panel
    // fuellen. Eine zweite Fassung derselben drei Zahlen waere genau der
    // Fehler, den der Waechter unter diesem Blatt seit R2-11 verhindert.
    cloud: {
      lines: cloudSalesLines(),
      measured: CLOUD_REFUSAL_LINE,
      note: CLOUD_SUBSCRIBER_LINE,
    },
    lines: [
      `${SHEET_MARKED_MODELS} of the ${SHEET_CHAT_MODELS} cloud chat models we measured answer in full without refusing, and only those carry the No refusals mark. The catalogue holds ${SHEET_CATALOGUE_MODELS} chat models. We asked them, twice each, and counted only the ones that answered both times. The mark comes from that measurement, never from the model name.`,
      // Der Bezugspunkt der 12 steht ausgeschrieben, nie als Rueckverweis.
      // "12 of those models" stand direkt hinter der Zeile darueber, und die
      // nennt zwei Mengen: den Messlauf und den Katalog. Wer "those" auf die
      // naechstgelegene Zahl las, bekam die Schnittmenge aus gemessenen und
      // abrechnungsfreien Modellen zugesagt, die nirgends gemessen ist
      // (R6-7, derselbe Fund wie in cloud-pitch.ts). Das Cloud-Tor nennt den
      // Katalog seit diesem Fund ausdruecklich; T13 hat am 12.09.2026 auf der
      // Box gemessen, dass Blatt und Tor deshalb verschiedene Bezugspunkte
      // trugen. Beide nennen jetzt denselben.
      `${CLOUD_PITCH.flashModels} of the ${SHEET_CATALOGUE_MODELS} models in the catalogue cost no credits at all in chat on an active paid plan, up to ${FLASH_DAILY} input and output tokens per day. API keys keep paying credits, and accounts without an active plan keep paying credits too.`,
      'A content policy setting in your account: Strict, Standard, or off. It applies to cloud image and video. Text was never filtered by us.',
      `${CLOUD_PITCH.openVideoModels} video models and ${CLOUD_PITCH.openImageModels} image models without a built-in content restriction. Every one of the video ones starts from a picture, so in the browser studio at lu-labs.ai a finished image now has an Animate button that carries it straight over.`,
      'Sampling controls sit next to the prompt: temperature, top P and answer length. They open as a small window above the prompt row, with an x to close it, so nothing you are typing moves out from under you. The measurement showed the system prompt matters more, so the default persona has a real role again instead of an empty one.',
    ],
    details: [
      {
        title: 'Models and marks',
        items: [
          `The ${SHEET_CHAT_MODELS} cloud chat models that were in the catalogue at measurement time were each asked the same question twice and judged on what came back, not on whether the reply started with a refusal sentence. ${CLOUD_PITCH.heldBackChatModels} answer but hold back and carry no mark: a mark that is sometimes right reads as a promise, and then you meet the refusal we just talked you out of. DeepSeek V4.1 Flash joined the catalogue after that run, so it carries no mark yet.`,
          'The old "(unrestricted)" suffix in some model names is gone. It was inherited, it was wrong on at least two models, and a name is not evidence.',
          'The same two marks appear in the picker and above the prompt: "No refusals" for the measured ones, "No credits" for the Flash class with its real daily number. The second one only shows on a plan that pays for it, because on any other account those models cost credits.',
          `The ${CLOUD_PITCH.openImageModels} open image models and the ${CLOUD_PITCH.openVideoModels} open video endpoints are marked in the Create picker of the browser studio. The mark stays pale while your account still filters, so it is clear that the setting draws the line and not the model.`,
        ],
      },
      {
        title: 'Flash chat without credits',
        items: [
          `${CLOUD_PITCH.flashModels} models run unmetered in chat inside the apps: GLM 5.3 Flash, DeepSeek V4 Flash 0731, Ling 3.0 flash, gpt-oss 120B, gpt-oss 20B, Gemma 4 26B, Gemma 4 31B Turbo, Qwen3 32B, Qwen 3.5 9B, Llama 3.3 70B Turbo, Llama 3.1 8B Turbo and Mistral Small 3.2 24B.`,
          `The ceiling is ${FLASH_DAILY} input and output tokens per account per day, resetting at 00:00 UTC, one free request at a time. It went up tenfold from the ceiling of the first version, where a working day ran out before lunch.`,
          'It is a benefit of an active paid plan. An account without an active plan keeps its starting credits and pays credits for Flash exactly like for any other model.',
          'API keys always pay credits, including on these models. The unmetered path is the app, not the endpoint.',
        ],
      },
      {
        title: 'Content policy',
        items: [
          'The setting lives in your LU Cloud account and reads the same in the desktop app and in the browser, because it is one setting behind one route, not two copies.',
          'Whether Off asks you to confirm your age is decided by the server, and in this release it does not ask. The app shows that step only when the server asks for it.',
          'Two lines no setting moves: material involving minors is refused on every request, and you may not upload a photograph of a real, identifiable person without their consent.',
          'The refusal message used to say cloud rendering cannot do this at all, which sent people to a local backend for something that was a setting. It now names the setting and where it is.',
        ],
      },
      {
        title: 'Prompt and sampling',
        items: [
          'Temperature, top P and maximum answer length sit next to the model picker, with the current temperature visible and one reset for all of them. Top K stays on the settings page, next to the backends that read it. The controls open over the prompt row instead of pushing it down. An x closes the window, and so do Escape and a click outside. Clicking the trigger a second time no longer does, because it used to close the panel under your own pointer. Reasoning models accept these and react less to them, which the help line says instead of hiding the control.',
          "The default persona had an empty system prompt. An empty prompt is not neutral: the model falls back to whatever its provider trained it to be, and that is where the refusals come from. It now states the role, one line on how to answer, and one line saying that the user's subject is the subject. No topic list in either direction.",
          'Chat, Agent and Coding all send that baseline now. The persona switch decides which PERSONA applies, not whether anything is sent at all.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'The agent can leave a workspace folder. The x on the folder pill drops it and forgets the remembered default with it, in new chats and in old ones, and the agent falls back to ~/agent-workspace until you pick a new one. A folder that kept coming back is what made changing it feel useless.',
          'Models under 7B carry a plain warning in the catalogue and are no longer offered as a starting pick for chat.',
          'Training a character LoRA no longer dies with the libuv error on Windows. The trainer started a distributed launcher that switched to multi GPU mode on machines with two cards; it now runs the training script directly, on one card, and the error text of a failed run is readable and can be copied.',
          'When the LU Engine exits before it serves, the log file now says why: the full command line, the exit code, the memory the card reported and the number of layers it was given. A card that is too small for the model gets a measured layer count instead of all of them, and if the first start still fails the second runs on the CPU and says so.',
          'Switching Cloud off starts the LU Engine again and puts your last local model back in the picker. Each mode keeps its own pick now, so the trip into the cloud and back no longer leaves you on "Select a chat model". If the engine fails to come up, the reason stands above the prompt instead of only in the log file.',
          'Stop means stop. A finished background agent no longer wakes the main agent into a hidden turn, a stop between two loop passes ends the loop, and a shell command the agent started is killed with it.',
          'Stop in one chat no longer stops the answer running in another. The app still answers one chat at a time, so a second chat keeps its Send button where it is, disabled, and says that another chat is still answering, instead of turning into a Stop button for the run in that other chat.',
          'The Code tab tells you why a folder was refused instead of accepting it and then failing on every file. A turn cut off at the token limit now says so in the answer, with the plan step it stopped on, instead of ending without a word.',
          'The maximum answer length field replaces what is in it instead of growing in front of it. Typing 512 into a field holding 0 used to leave 0512 on the screen: the number that got sent was the one you meant all along, the line you were reading was not.',
          'A custom OpenAI compatible backend is asked for its real context window. llama.cpp, vLLM and KoboldCpp answer directly, the number carries a label saying where it came from, the context picker is available for your own backend, and no guessed budget is sent as max tokens any more.',
          'When that backend reports both a running window and a training limit, the running one wins. A server started with 16K no longer reads as 40K, and the context picker stops at what the server really has. A limit with nothing running behind it is labelled as the training limit, and no budget is derived from it.',
          'A large model download no longer looks frozen at zero. The bar was watching the model folder while the downloader filled a shared chunk cache beside it, so the bytes that really arrived were never counted. It counts that cache as well now, from the moment the download starts. On Windows it also counts the transfer figure a network read is booked under, which is the half we have not yet watched on a real download.',
          'A 2 GB card can still turn a 3B model into garbage. The layer count is now measured against the card, which should help, but we have not seen that card in the house, so the report stays open.',
        ],
      },
    ],
  },
  {
    version: '2.6.9',
    headline: 'The navigation is back to the 2.6.7 layout, and updates work on every Linux install',
    lines: [
      'Known in this release: after you switch Cloud off, the LU Engine stays stopped until you press Use on your model under Models. One click, a few seconds.',
      'The top bar and the Create toolbar are back to the 2.6.7 layout after your feedback on Discord: every entry stays where it is, nothing scrolls, nothing is cut off.',
      'The context size menu in Chat opens upwards when there is no room below it, so 16K, 32K and the hint line are reachable again.',
      'Linux: LU installed from the AUR package or unpacked by hand no longer downloads a Debian package and fails after the password prompt. It fetches the signed AppImage into your home folder, points the start menu entry at it and restarts; from then on updates install in place, without a password.',
      'The Cloud teaser says how much VRAM your own GPU has when a model does not fit, and its button leads straight into signup and the Hosted checkout.',
    ],
    details: [
      {
        title: 'Navigation and Chat',
        items: [
          'The top bar (Chat, Create, Compare, Benchmark, Models, Settings) and the Create toolbar no longer rotate the active entry into the middle. They are the fixed rows from 2.6.7 again; a narrow window wraps the Create tools onto a second line instead of hiding them.',
          'The context size menu measures the room it has before it opens and flips upwards when the space below is too small, capped to the visible area so it can never be clipped again.',
        ],
      },
      {
        title: 'Linux updates',
        items: [
          'The updater used to decide between AppImage, deb and rpm from a marker written into the binary at build time. A copy repackaged by the AUR or unpacked by hand carried the wrong marker, downloaded a .deb and ran dpkg through polkit, which asked for your password and then failed.',
          'LU now asks pacman, dpkg and rpm who owns the running file. On an install none of them may overwrite, it downloads the AppImage from the release page, verifies its signature, places it under ~/.local/share/locally-uncensored, writes a start menu entry for it and relaunches. An AppImage in a folder you cannot write to takes the same route.',
          'Debian, Ubuntu and Fedora installs from our .deb and .rpm keep the normal package install, including the system password prompt.',
        ],
      },
      {
        title: 'Cloud',
        items: [
          'The Cloud teaser reads your GPU size from the same hardware detection the settings use and says it on the card, so the reason a model does not fit is on screen. Its button opens signup and the Hosted checkout in one go instead of the pricing page.',
          'Privacy note: pressing the Cloud switch was already counted anonymously per day, platform and version. When you are signed in it is now also counted per account, so we can tell whether subscribers or everyone else use it. No prompt, no chat content, nothing else.',
        ],
      },
    ],
  },
  {
    version: '2.6.8',
    headline: 'Compact mode, background agents, and an effort control for reasoning models',
    lines: [
      'Known in this release: after you switch Cloud off, the LU Engine stays stopped until you press Use on your model under Models. One click, a few seconds. A later release brings the engine back on its own when Cloud goes off.',
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
          'Approve and run in Ask mode no longer looks stuck at the first command. Two staged files could fill the whole coding column, the transcript below shrank to nothing and the approval card of the next step sat behind the message field where no scroll reached it, so the run waited on your ok that you could not give. The Pending list now scrolls inside a cap, the transcript keeps its height, and the card scrolls into view the moment it appears. Apply all also writes into the folder the run worked in, not a second folder named after the conversation, so the model finds the files it staged. The Bypass entry in the mode menu no longer promises a cloud confirm that is off unless you switch it on. Reported in the Discord help chat.',
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
