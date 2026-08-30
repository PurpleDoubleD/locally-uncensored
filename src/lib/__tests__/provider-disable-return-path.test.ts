/**
 * Nebenbefund 1 of the R9 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r9-nachmessung.md).
 *
 * The measured frame: Settings, AI Backends, the LM Studio card, the red
 * "Disable" button. After the click the card was gone from the list, the only
 * row left was LU Cloud, `activeModel` was null, and the chat model picker
 * said "No models available" with nothing on it to press. The list rendered
 * enabled providers only, so the control that switched a backend off also
 * removed the control that could switch it back on. Ollama sits in the same
 * list and had the same behaviour.
 *
 * The rule under test: a provider the user switched off HERE keeps its row and
 * carries an Enable button, while a slot nobody has touched (fresh Ollama and
 * Anthropic, and the built-in engine after onboarding hands the slot to
 * Ollama) stays out of the list as before.
 *
 * Run: npx vitest run src/lib/__tests__/provider-disable-return-path.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  providerRowIds,
  isReturnableRow,
  noChatBackendEnabled,
} from '../provider-visibility'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

const providerPane = read('src/components/settings/ProviderConfig.tsx')
const modelSelector = read('src/components/models/ModelSelector.tsx')

/** The exact shape the re-measure left behind: LM Studio on the openai slot,
 *  disabled by its own Disable button, LU Cloud the only thing still on. */
const AFTER_DISABLE = {
  ollama: { enabled: false },
  openai: { enabled: false, disabledByUser: true },
  anthropic: { enabled: false },
  'lu-cloud': { enabled: true },
}

describe('THE FIX: a provider the user switched off keeps its row', () => {
  it('the disabled LM Studio slot is still a row', () => {
    expect(providerRowIds(AFTER_DISABLE)).toContain('openai')
  })

  it('and that row is the one that offers the way back', () => {
    expect(isReturnableRow(AFTER_DISABLE.openai)).toBe(true)
  })

  it('Ollama, the other card with the same Disable button, behaves the same', () => {
    const offOllama = { ...AFTER_DISABLE, ollama: { enabled: false, disabledByUser: true } }
    expect(providerRowIds(offOllama)).toContain('ollama')
    expect(isReturnableRow(offOllama.ollama)).toBe(true)
  })

  it('enabling it again clears the mark, so it is a normal row', () => {
    const backOn = { enabled: true, disabledByUser: false }
    expect(isReturnableRow(backOn)).toBe(false)
    expect(providerRowIds({ openai: backOn })).toEqual(['openai'])
  })
})

describe('NEGATIVE CONTROL: slots nobody switched off stay out of the list', () => {
  it('a fresh install lists the built-in engine only', () => {
    const fresh = {
      ollama: { enabled: false },
      openai: { enabled: true },
      anthropic: { enabled: false },
      'lu-cloud': { enabled: false },
    }
    expect(providerRowIds(fresh)).toEqual(['openai'])
  })

  it('onboarding handing the slot to Ollama does not leave a disabled card behind', () => {
    // Onboarding.tsx: picking Ollama writes openai { enabled: false } without
    // the user ever pressing Disable, so no Enable row is owed.
    const afterOnboarding = {
      ollama: { enabled: true },
      openai: { enabled: false },
      anthropic: { enabled: false },
      'lu-cloud': { enabled: false },
    }
    expect(providerRowIds(afterOnboarding)).toEqual(['ollama'])
    expect(isReturnableRow(afterOnboarding.openai)).toBe(false)
  })
})

describe('the picker says WHY it is empty, per mode', () => {
  it('after the disable, local mode has no backend it can list', () => {
    expect(noChatBackendEnabled(AFTER_DISABLE, 'local')).toBe(true)
  })

  it('NEGATIVE CONTROL: the same state in cloud mode has one, LU Cloud', () => {
    expect(noChatBackendEnabled(AFTER_DISABLE, 'cloud')).toBe(false)
  })

  it('NEGATIVE CONTROL: a running local backend is not reported as missing', () => {
    const withEngine = { ...AFTER_DISABLE, openai: { enabled: true } }
    expect(noChatBackendEnabled(withEngine, 'local')).toBe(false)
  })

  it('NEGATIVE CONTROL: local-only backends do not count in cloud mode', () => {
    const localOnly = {
      ollama: { enabled: true },
      openai: { enabled: true },
      'lu-cloud': { enabled: false },
    }
    expect(noChatBackendEnabled(localOnly, 'cloud')).toBe(true)
  })
})

describe('the wiring, so the rule reaches the screen', () => {
  it('the providers pane draws the rule, not the enabled-only filter', () => {
    expect(providerPane).toMatch(/rowIds = providerRowIds\(providers\)/)
    expect(providerPane).toMatch(/\{rowIds\.map\(id => \{/)
  })

  it('the switched-off row carries an Enable button', () => {
    expect(providerPane).toMatch(/if \(isReturnableRow\(config\)\)/)
    expect(providerPane).toMatch(/>\s*Enable\s*<\/button>/)
    expect(providerPane).toMatch(/DISABLED<\/span>/)
  })

  it('Disable marks the off state as the user`s own, Enable clears it', () => {
    expect(providerPane).toMatch(
      /setProviderConfig\(id, \{ enabled: nextEnabled, disabledByUser: !nextEnabled \}\)/,
    )
  })

  it('the picker names the reason and gives a button to Settings', () => {
    expect(modelSelector).toMatch(/No AI backend is enabled/)
    expect(modelSelector).toMatch(
      /openSettingsAt\(\{ tab: 'backends' \}\)[\s\S]{0,300}Open Settings/,
    )
  })
})
