import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { BETA_FEATURES, BETA_LABEL, betaNote, type BetaFeature } from '../beta'

/**
 * Which features carry the Beta mark, and where.
 *
 * The owner for 3.0.6: what is not finished to the last proof is marked Beta,
 * clearly, where the customer switches it on or meets it first. The list of
 * features is lib/beta.ts; this file holds the places. A feature leaves Beta
 * by deleting its line in lib/beta.ts (the mark then draws nothing), and its
 * places here are cleaned up after that.
 */
const SRC = resolve(__dirname, '../..')

const PLACES: Record<BetaFeature, string[]> = {
  'computer-control': [
    // The head of the small window while LU works on the screen.
    'components/computer/ComputerSurface.tsx',
    // The bar where LU's window stays a window while it works (Linux, macOS).
    'components/computer/ComputerControlHost.tsx',
    // The question of the first use in a chat.
    'components/computer/ComputerChatPermission.tsx',
    // The switch, with the sentence in the open under it.
    'components/settings/PermissionSettings.tsx',
    // "Whole computer" in Voice switches it on: the mark stands on that line.
    'components/voice/VoiceControls.tsx',
  ],
  voice: [
    'components/voice/VoiceSettingsPopup.tsx',
    'components/voice/VoiceView.tsx',
  ],
  'create-in-chat': [
    // Under an order that waits for the OK. Not in the card: that file is the web's.
    'components/chat/create/CreateOrders.tsx',
    // The switch under Plugins.
    'components/chat/PluginsDropdown.tsx',
  ],
  'direct-models': [
    // One mark on the head of the group, none on the rows.
    'components/models/CloudModelPicker.tsx',
  ],
  'style-training': [
    // Next to the Character | Style / concept switch of the local trainer.
    'components/create/experimental/SpecialIntentControls.tsx',
  ],
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') sources(path, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const FILES = sources(SRC).map((path) => ({ file: relative(SRC, path).split('\\').join('/'), text: readFileSync(path, 'utf8') }))

describe('the Beta list', () => {
  it('names exactly the features that ship as Beta', () => {
    expect(Object.keys(BETA_FEATURES).sort()).toEqual(['computer-control', 'create-in-chat', 'direct-models', 'style-training', 'voice'])
  })

  it('says one word, and every sentence starts with it', () => {
    expect(BETA_LABEL).toBe('Beta')
    for (const note of Object.values(BETA_FEATURES)) {
      expect(note.startsWith('Beta: ')).toBe(true)
      expect(note.endsWith('.')).toBe(true)
      // No dashes, no internal names, no promise in numbers.
      expect(note).not.toMatch(/[\u2013\u2014]/)
      expect(note).not.toMatch(/astra/i)
      expect(note).not.toMatch(/%/)
    }
  })

  it('a feature that left the list has no sentence, so its mark draws nothing', () => {
    expect(betaNote('voice')).toBe(BETA_FEATURES.voice)
    expect(betaNote('gone' as BetaFeature)).toBeNull()
  })
})

describe('the places of the Beta mark', () => {
  it('every mark in the app stands at a place named here, and every place has its mark', () => {
    const found: Record<string, string[]> = {}
    for (const { file, text } of FILES) {
      for (const hit of text.matchAll(/<BetaMark feature="([a-z-]+)"/g)) {
        const list = (found[hit[1]] ??= [])
        if (!list.includes(file)) list.push(file)
      }
    }
    for (const list of Object.values(found)) list.sort()
    const wanted = Object.fromEntries(Object.entries(PLACES).map(([feature, files]) => [feature, [...files].sort()]))
    expect(found).toEqual(wanted)
  })

  it('the mark is one component: nobody writes the word or the class by hand', () => {
    const byHand = FILES
      .filter(({ file }) => file !== 'components/ui/BetaMark.tsx')
      .filter(({ text }) => /className="[^"]*\blu-beta\b/.test(text) || />\s*Beta\s*</.test(text))
      .map(({ file }) => file)
    expect(byHand).toEqual([])
  })

  it('nothing of it stands in or over the chat input', () => {
    const input = FILES.find(({ file }) => file === 'components/chat/ChatInput.tsx')!
    expect(input.text).not.toContain('BetaMark')
    expect(input.text).not.toContain('betaNote')
  })

  it('the older words are gone from these features', () => {
    // "Experimental" stood on the Holo screen model until 3.0.6. One word now.
    const old = FILES
      .filter(({ file }) => /^(lib\/(computer|voice)|components\/(computer|voice|chat\/create))\//.test(file)
        || ['components/settings/PermissionSettings.tsx', 'components/chat/PluginsDropdown.tsx', 'components/models/CloudModelPicker.tsx', 'api/discover.ts'].includes(file))
      .filter(({ text }) => /\b(Experimental|Early access|Alpha|Preview)\b(?=[^'"`\n]*['"`<])/.test(text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')))
      .map(({ file }) => file)
    expect(old).toEqual([])
  })
})
