/**
 * "What is new" for the phone (E21). Own texts: the desktop notes talk about
 * things a phone does not have. Filled by strand 5.
 *
 * Only what exists on the phone goes in here. Newest version first. A version
 * without an entry shows no page by itself: an empty sheet is worse than none.
 */
import { storePolicy, type StorePolicy } from '../policy/storePolicy'

export interface MobileReleaseNote {
  version: string
  /** One line under the version. */
  headline?: string
  /** The lines of this build: a feature the store switches close is not announced (see `noteItems`). */
  readonly items: readonly string[]
}

/** One line of a note. A plain text, or a text that belongs to a store switch. */
type NoteItem =
  | string
  | {
      text: string
      /** The line is about a feature that only exists where this switch is on. */
      needs?: 'remoteDesktop' | 'remoteCreate' | 'externalProviders'
      /** The same line for a build that must not speak of prices (switch pricingWords). */
      unpriced?: string
    }

/** Pure: the lines of a note as a build with this policy shows them. */
export function noteItems(items: readonly NoteItem[], policy: Pick<StorePolicy, 'remoteDesktop' | 'remoteCreate' | 'externalProviders' | 'pricingWords'>): string[] {
  const out: string[] = []
  for (const item of items) {
    if (typeof item === 'string') out.push(item)
    else if (item.needs && !policy[item.needs]) continue
    else out.push(!policy.pricingWords && item.unpriced ? item.unpriced : item.text)
  }
  return out
}

function note(version: string, headline: string, items: readonly NoteItem[]): MobileReleaseNote {
  return {
    version,
    headline,
    get items() {
      return noteItems(items, storePolicy())
    },
  }
}

export const MOBILE_RELEASE_NOTES: readonly MobileReleaseNote[] = [
  // 3.0.10 is the next phone app after 3.0.7 (3.0.8 and 3.0.9 shipped none): what came since then.
  note('3.0.10', 'What changed since 3.0.7.', [
    {
      text: 'Chats on your computer: a chat you share there with "Continue on phone" shows up under Remote desktop. Write in it, start a new one in Chat, Agent or Code, and allow or deny its tools from here.',
      needs: 'remoteDesktop',
    },
    { text: 'Create on your computer has all its tools, its gallery under "On my computer", an area to paint for edits and your trained characters.', needs: 'remoteCreate' },
    'On Android the keyboard stays open in the Create prompt, so a prompt that is already there can be changed.',
    'A character training you stop is no longer reported as trained.',
  ]),
  // 3.0.7 is the first version the phone app ships with (the desktop of 3.0.5 and 3.0.6 had no phone app).
  note('3.0.7', 'LU is on your phone.', [
    'Chat with models that run on this phone. No connection needed, and such a chat is not sent to any server.',
    'A model list made for phones. Every model says if it fits this phone before you download it.',
    {
      text: 'LU Cloud for the models that are too large for a phone, with one switch and a price before anything runs.',
      unpriced: 'LU Cloud for the models that are too large for a phone, with one switch.',
    },
    'Create images, video and audio on LU Cloud, with a gallery on this phone.',
    'Attach photos and files, and ask questions about your documents.',
    'Agent mode with web search, memory and workflows.',
    'Dictation and reading aloud through LU Cloud.',
    { text: 'Remote desktop: use the models of your own computer from this phone.', needs: 'remoteDesktop' },
    'Back up all chats to a file, restore them, and import chats from ChatGPT, Claude or Gemini.',
    { text: 'Your own keys: add Anthropic, Groq, OpenRouter or any OpenAI compatible endpoint, and its models show up in the model list.', needs: 'externalProviders' },
    'Light and dark theme, and text that follows the text size of your phone.',
  ]),
]

/** The notes of one version, or undefined when nobody wrote any. */
export function mobileReleaseNoteFor(version: string): MobileReleaseNote | undefined {
  return MOBILE_RELEASE_NOTES.find((note) => note.version === version)
}
