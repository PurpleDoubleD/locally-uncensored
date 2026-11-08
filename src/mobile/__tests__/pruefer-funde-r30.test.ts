/**
 * Round 30: the findings of the Android check of build 13
 * (mobile-docs/r30/reste.md). One block per finding, each red without its fix.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setStorePresetForTests } from '../policy/storePolicy'
import { MODELS_STRINGS } from '../strings/models'
import { reachableFromMobile, shownTexts } from './scan'
import { allTexts } from './strings-read'

afterEach(() => {
  setStorePresetForTests(null)
})

/**
 * Words that can make a sentence read as unfinished work or name the inside
 * of LU Cloud. Round 28 looked only for "not available ... yet" and
 * "cannot ... yet", so "LU has no graphics acceleration on Android yet" went
 * through. Here every "yet" counts, and every hit needs a reason below.
 */
const PROMISE = /\byet\b|\bfor now\b|\bcoming soon\b|\bthis build\b|\bbuild of LU\b|\bnot built\b|\bGPU fleet\b|\bfleet is not live\b/i

interface Allowed {
  reason: string
  /** File from src, and a piece of each text that may stay. */
  at: Record<string, readonly string[]>
}

const ALLOWED: readonly Allowed[] = [
  {
    reason: 'A state of the user\'s own things: nothing made, saved, sent, chosen or measured so far. "yet" says what the user can still do, not what LU will build later.',
    at: {
      'lib/request-usage.ts': ['No answer in this chat yet, so there is no token count to show.'],
      'mobile/strings/agent.ts': [
        'message not read yet', 'messages not read yet', 'No answer yet.', 'No documents in this chat yet.', 'No memories yet.', 'No passage of this document was used yet.',
        'No prompt yet', 'No question yet', 'No result yet.', 'No steps yet.', 'No title yet', 'No tool chosen yet', 'No workflows yet.', 'Not looked at yet', 'Not synced yet',
        'Nothing changed yet.', 'Nothing sent yet.', 'There are no memories to delete yet.', 'There is not enough in this chat to compact yet.', 'There is nothing to export yet.',
        'This chat has no messages yet',
      ],
      'mobile/strings/chat.ts': [
        'None yet', 'No files in this chat yet.', 'No messages yet', 'No model on this phone reads images yet. Get one from the catalogue', 'No model on this phone yet', 'No model yet.',
        'Nothing heard yet', 'There is nothing to export yet.', 'This chat has no messages yet.',
      ],
      'mobile/strings/create.ts': [
        'No characters yet', 'No clip in your gallery yet.', 'No clips yet.', 'No image in your gallery yet.', 'No images yet.', 'No prompts yet', 'No saved characters yet',
        'No sound in your gallery yet.', 'No sound yet.', 'Nothing added yet.', 'Nothing here yet.', 'Nothing of this kind yet.', 'You have no styles of your own yet.',
      ],
      'mobile/strings/models.ts': ['No model on this phone yet.', 'No model yet. Install one in Models.', 'No results yet.', 'Nothing was downloaded yet.'],
      'mobile/strings/remote.ts': ['No messages yet', 'No remote chats yet', 'Nothing of the answer was saved yet.', 'This message has no answer yet.'],
      'mobile/strings/settings.ts': [
        'not synced yet. Sign out anyway?', 'No model is picked yet.', 'Not allowed yet. LU asks before the first Cloud request.', 'Not measured yet', 'Not run yet',
        'Not written yet since LU was opened', 'There are no chats to back up yet.',
      ],
      'mobile/lib/diagnostics.ts': ['Device figures: not read yet', 'Last speed: not measured yet'],
      'lib/model-slot.ts': ['The document reader is not installed yet.'],
      'lib/platform-text.ts': ['No chat model is on this device yet.', 'has no chat model to load yet.'],
      'lib/video-frames.ts': ['The video has no picture yet. Let it load'],
    },
  },
  {
    reason: 'A state that changes by itself or on the account: saving that LU retries, a plan or credits of the account (the App Store build says these without "yet", round 28 R1), a size or window LU is still reading.',
    at: {
      'mobile/strings/common.ts': ['This chat is not saved yet. Free up space'],
      'mobile/strings/remote.ts': ['This chat is not saved yet. Free up space', 'This setting is not saved yet. Free up space', 'LU could not save this chat yet.', 'LU could not save this setting yet.'],
      'mobile/strings/settings.ts': [
        'LU Cloud is not switched on for this account yet.', 'No active plan found on this account yet.', 'This account has no active plan yet.', 'This account has no credits for LU Cloud yet.',
        'this account has no credits for it yet.',
      ],
      'mobile/strings/chat.ts': ['Your account has no plan with LU Cloud yet.'],
      'mobile/strings/models.ts': ['LU does not know the size of this file yet. It checks the size', 'Loaded, not answering yet'],
      'mobile/strings/agent.ts': ['LU does not know the window of this model yet.'],
      // The Beta mark of the cloud models (mobile/ui/List.tsx, BetaTag "direct-models"): a screen reader reads the
      // desktop's hover sentence. It says what is not measured so far, not what LU builds later.
      'lib/beta.ts': ['How they hold up when many people use them at once is not measured yet.'],
    },
  },
  {
    reason: 'A choice of the user: the step waits for later.',
    at: { 'mobile/strings/models.ts': ['Skip for now'] },
  },
  {
    reason: 'Words LU reads, not words it shows: matchers for an answer of the server or of the native layer.',
    at: {
      'mobile/screens/create/parts/errors.ts': ['coming soon', 'not live yet'],
      'lib/engine-command-availability.ts': ['not available in this build'],
      'api/backend.ts': ['no proxy in this build'],
    },
  },
  {
    reason: 'Text for a model, not for a person: instructions and context an agent or a memory model reads.',
    at: {
      'lib/chat-media-refs.ts': ['This chat has no picture yet: make one with image_generate first'],
      'lib/characters.ts': ['There are no trained characters on this machine yet.'],
      'mobile/remote/remoteAgent.ts': ['Do not stop yet.'],
      'api/agents/ankuendigung.ts': ['You have not called a single tool yet.'],
      'lib/agent-fanout.ts': ['so do NOT start the agents yet.'],
      'lib/staged-overlay.ts': ['NOT on disk yet', 'not on disk yet'],
      'lib/memory-extraction.ts': ['None yet.'],
      'stores/memoryStore.ts': ['No entries yet.'],
      'lib/agent-commands.ts': ['Audit this project'],
    },
  },
  {
    reason: 'Desktop only: the phone loads the file but never takes the path that shows this (ComfyUI, the image and video engine of a Mac, Piper, benchmarks, the slash command /compact, the desktop catalogue and release notes; the phone has its own in strings/release-notes.ts) or it is a log line.',
    at: {
      'lib/render-budget.ts': ['Your card is AMD and LU installs a ROCm PyTorch'],
      'lib/comfy-cpu-banner.ts': ['LU installs AMD\'s own ROCm build of PyTorch'],
      'lib/plugins/rea.ts': ['The REA package is not on this computer yet'],
      'api/comfyui.ts': ['Wan 2.2 VACE Fun needs its own VAE', 'Phantom needs its own subject reference workflow', 'MAGREF needs its own masked reference workflow', 'Reference model, not supported yet'],
      'api/dynamic-workflow.ts': ['needs ComfyUI nodes this install does not have yet', 'Allegro is not supported in this build.', 'CogVideoX is not supported in this build yet.', 'Pyramid Flow is not supported in this build yet.'],
      'api/mcp/builtin-tools.ts': ['No local image model is installed yet.', 'No local video model is installed yet.', 'the local video engine is not set up on this Mac yet'],
      'api/mlx-image.ts': ['The local image engine is not set up on this Mac yet'],
      'api/render-fixup-deps.ts': ['but ComfyUI does not list'],
      'hooks/useVoice.ts': ['Neural TTS (Piper) is not set up yet', 'No Piper voice is fully downloaded yet'],
      'stores/benchmarkStore.ts': ['No benchmark runs recorded yet.'],
      'stores/comfyInstallStore.ts': ['ComfyUI is not set up yet'],
      'lib/run-compact-command.ts': ['Nothing to summarise yet'],
      'api/discover.ts': [
        'lmstudio-community build', 'Even the 2-bit quant is ~370 GB', 'successor to Holo 3.1 for computer control', 'smallest quant. Beta: not yet tested in LU.',
        'largest quant, closest to the original weights. Beta: not yet tested in LU.',
      ],
      'lib/shared-memory-wording.ts': ['Memory not detected yet.'],
      'lib/beta.ts': ['Beta: computer control is new and not proven in every app yet.', 'On a Mac, computer control is not fully tested yet.'],
      'lib/release-notes.ts': [
        'A large model download no longer looks frozen at zero.', 'A preset shelf next to the usual Create tab', 'Models, Image, Get new has', 'Setting an install location for the Character Trainer',
        'Stop, signing out and quitting the app now reach every conversation', 'cloud chat models from that measurement that the catalogue carries today', 'The installer used to stop at our own running engine',
        'Three uncensored models that were missing', 'Voice is a new surface in the main navigation', 'Computer control is in beta: it is new and not proven in every app yet',
        'Speech has a Microphone field', 'the Restart Now button closed the app on Linux', 'When Create runs on ComfyUI, Image, Edit and every video tab have a character chip', 'The Workflows view takes a workflow saved with Save or Export in ComfyUI', 'On your own machine the reference strip takes up to nine images', 'Use locally on the cloud character shelf saves a Z Image character', 'The reference strip in Edit has a Trained characters row', 'local character training has a second setting, Low VRAM', 'The Frames slider ran from 1 to 120 for every local video model', 'With a Wan 2.1 VACE model installed, Animate uses your picture', 'Import from other chatbots takes the .zip', 'Adding KoboldCpp while LM Studio or the LU Engine is on', 'Plugins has a new switch, REA', 'have a Check files button', 'KoboldCpp behind its Ollama API sends no context length', 'A size picked in the context picker is now saved for that model', 'LU estimated every text at four characters per token', 'LU counted a digit at a quarter of a token', 'Signed out, or with an account that cannot use them yet', 'The Mac parts of this release have not been clicked through'],
      'lib/chat-attachments.ts': ['[chat-attachments] attachment write failed'],
      // C60 (3.1.0): reached through the self-control tools (lu_service), which a phone never registers (MOBILE_UNBUILT_TOOLS).
      'lib/local-api.ts': ['none yet'],
    },
  },
  {
    reason: 'Create in chat and computer control: the phone has no order card (lib/create-order-surface.ts, hasCreateOrderSurface is false on the phone, so no create tool and no claim note runs there) and no computer control. The rest is text for a model: tool answers and instructions.',
    at: {
      'lib/create/order.ts': ['There is no trained character yet.', 'This character has no compatible generation model yet.', 'Still with LU Cloud: its answer did not arrive yet.'],
      'lib/create/engine.ts': ['This character has no compatible generation model yet.'],
      'lib/create/handles.ts': ['There is no ${kind} to use yet.', 'There are no results, gallery entries or attachments to use yet.'],
      'lib/create/chat-control.ts': ['Note: no order was created, so there is nothing to approve yet.', 'Note: nothing has been started yet.'],
      'lib/create/chat-tools.ts': ['No results, gallery entries or attachments yet.', 'Nothing has been created yet and no credits'],
      'api/computer-task.ts': ['it is not a window the user approved yet'],
      'lib/computer/executor-format.ts': ['Answer with exactly one JSON object and nothing else'],
    },
  },
  {
    reason: 'Replaced on the phone: mobile/screens/create/parts/errors.ts recognises the desktop sentence and the phone says "LU Cloud cannot make this right now" (round 28, S2).',
    at: { 'hooks/useCloudCreate.ts': ['Cloud rendering is coming soon, the GPU fleet is not live yet.'] },
  },
]

/** Which entries of ALLOWED cover a text of a file. */
function coveredBy(file: string, text: string): string[] {
  const out: string[] = []
  for (const group of ALLOWED) for (const piece of group.at[file] ?? []) if (text.includes(piece)) out.push(`${file}|${piece}`)
  return out
}

describe('N1: no text the phone shows says that something comes later', () => {
  it('the engine page says how the phone computes, without "yet"', () => {
    expect(MODELS_STRINGS.engine.noGraphics).toBe('This phone computes on the processor. On Android, LU runs models without graphics acceleration.')
  })

  it('every hit in the files the phone loads has a reason, and every reason is still needed', () => {
    const files = reachableFromMobile()
    expect(files.length).toBeGreaterThan(200)
    const hits: string[] = []
    const used = new Set<string>()
    for (const file of files) {
      // Developer pages: only in a developer build (platform/detect.ts), never in a store package.
      if (file.rel.startsWith('mobile/dev/')) continue
      for (const text of shownTexts(file)) {
        if (!PROMISE.test(text)) continue
        const by = coveredBy(file.rel, text)
        if (by.length === 0) hits.push(`${file.rel}: ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
        for (const key of by) used.add(key)
      }
    }
    expect(hits).toEqual([])
    const stale = ALLOWED.flatMap((g) => Object.entries(g.at).flatMap(([file, pieces]) => pieces.map((p) => `${file}|${p}`))).filter((key) => !used.has(key))
    expect(stale).toEqual([])
  })

  for (const preset of ['open', 'play', 'appstore'] as const) {
    it(`${preset}: every text of src/mobile/strings as the preset reads it`, async () => {
      setStorePresetForTests(preset)
      const pieces = ALLOWED.flatMap((g) => Object.entries(g.at).filter(([file]) => file.startsWith('mobile/strings/')).flatMap(([, p]) => p))
      const hits = (await allTexts()).filter((t) => PROMISE.test(t.text) && !pieces.some((p) => t.text.includes(p))).map((t) => `${t.path}: ${t.text}`)
      expect(hits).toEqual([])
    })
  }

  it('the rule catches the sentences of rounds 28 and 30', () => {
    for (const text of [
      'This phone computes on the processor. LU has no graphics acceleration on Android yet.',
      "This model's supported lengths are not available yet. Try again in a moment.",
      'On device models are text only for now.',
      'It is not part of this build of LU.',
      'Cloud rendering is coming soon, the GPU fleet is not live yet.',
      'This screen is not built yet.',
    ]) {
      expect(PROMISE.test(text)).toBe(true)
    }
    expect(PROMISE.test('This version of LU does not include Remote desktop.')).toBe(false)
  })
})
