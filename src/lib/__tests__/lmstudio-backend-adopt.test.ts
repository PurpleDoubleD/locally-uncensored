/**
 * Round 9 of the 2.6.7 run, Nebenbefund 4 of the R8 re-measure (Windows box,
 * installed build): the chat picker's banner said "Start it to pick LM Studio
 * models here", the button really started the server (port 1234 listening,
 * /v1/models answering with real models), and the picker still offered nothing
 * but the built-in engine and the cloud. Reason: no enabled provider slot
 * pointed at LM Studio, and the picker lists slots.
 *
 * These lock in the decision the click now makes, and the honesty the banner
 * owes before it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  lmStudioSlotUpdate,
  slotPointsAtLmStudio,
  adoptionReplacesBuiltinEngine,
  LM_STUDIO_PRESET,
} from '../lmstudio-backend-adopt'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BUILTIN_SLOT = { enabled: true, baseUrl: 'http://127.0.0.1:8127/v1', managed: true }
const LMS_URL = 'http://localhost:1234/v1'

describe('LM_STUDIO_PRESET', () => {
  it('is the shipped preset, not a second copy of the URL', () => {
    expect(LM_STUDIO_PRESET.id).toBe('lmstudio')
    expect(LM_STUDIO_PRESET.name).toBe('LM Studio')
    expect(LM_STUDIO_PRESET.baseUrl).toBe(LMS_URL)
    expect(LM_STUDIO_PRESET.providerId).toBe('openai')
  })
})

describe('lmStudioSlotUpdate', () => {
  it('takes the slot over from the app-managed built-in engine', () => {
    const update = lmStudioSlotUpdate(BUILTIN_SLOT)
    expect(update).toEqual({
      enabled: true,
      name: 'LM Studio',
      baseUrl: LMS_URL,
      isLocal: true,
      managed: false,
    })
  })

  // The load-bearing field. `managed` left at true keeps useModels on
  // list_bundled_models (isManagedBuiltinActive) while the URL already points
  // at LM Studio, so the picker would STILL show no LM Studio model and the
  // dead end would survive the fix.
  it('clears managed explicitly rather than just omitting it', () => {
    const update = lmStudioSlotUpdate(BUILTIN_SLOT)!
    expect(Object.prototype.hasOwnProperty.call(update, 'managed')).toBe(true)
    expect(update.managed).toBe(false)
  })

  it('only flips enabled when the slot already points at LM Studio', () => {
    expect(lmStudioSlotUpdate({ enabled: false, baseUrl: LMS_URL, managed: false }))
      .toEqual({ enabled: true })
  })

  it('keeps a user label for the same port instead of renaming it', () => {
    const update = lmStudioSlotUpdate({ enabled: false, baseUrl: LMS_URL, managed: false })!
    expect(update.name).toBeUndefined()
    expect(update.baseUrl).toBeUndefined()
  })

  it('has nothing to change when LM Studio already owns the slot and is on', () => {
    expect(lmStudioSlotUpdate({ enabled: true, baseUrl: LMS_URL, managed: false })).toBeNull()
  })

  it('ignores a trailing slash and case when comparing the URL', () => {
    expect(lmStudioSlotUpdate({ enabled: true, baseUrl: 'http://LOCALHOST:1234/v1/', managed: false })).toBeNull()
  })

  it('takes the slot over from another external backend on a different port', () => {
    // vLLM on 8000. The user pressed the LM Studio button, so LM Studio wins.
    const update = lmStudioSlotUpdate({ enabled: true, baseUrl: 'http://localhost:8000/v1', managed: false })!
    expect(update.baseUrl).toBe(LMS_URL)
    expect(update.name).toBe('LM Studio')
  })

  it('never treats an empty slot URL as a match', () => {
    expect(slotPointsAtLmStudio({ enabled: true, baseUrl: '', managed: false })).toBe(false)
    expect(lmStudioSlotUpdate({ enabled: true, baseUrl: '', managed: false })?.baseUrl).toBe(LMS_URL)
  })
})

describe('adoptionReplacesBuiltinEngine', () => {
  it('is true exactly while the managed built-in engine holds the slot', () => {
    expect(adoptionReplacesBuiltinEngine(BUILTIN_SLOT)).toBe(true)
    expect(adoptionReplacesBuiltinEngine({ ...BUILTIN_SLOT, managed: false })).toBe(false)
    expect(adoptionReplacesBuiltinEngine({ enabled: true, baseUrl: LMS_URL })).toBe(false)
  })
})

// The wiring itself. ModelSelector is hook/store/Tauri-heavy and has no render
// harness in this repo (see model-selector-lms.test.ts), so the guard reads the
// source, the same way AppShell-backend-autoenable.test.ts does.
describe('ModelSelector LM Studio banner', () => {
  const src = readFileSync(join(__dirname, '../../components/models/ModelSelector.tsx'), 'utf8')

  it('adopts the openai slot once the server reports running', () => {
    // Pre-fix the running branch called onStarted() and nothing else, which is
    // what left the picker empty.
    expect(src).toMatch(/lmStudioSlotUpdate\(\s*useProviderStore\.getState\(\)\.providers\.openai\s*\)/)
    expect(src).toMatch(/setProviderConfig\('openai',\s*update\)/)
  })

  it('adopts before it refetches, or the refetch reads the old slot', () => {
    const adopt = src.indexOf("setProviderConfig('openai', update)")
    const refetch = src.indexOf('onStarted()', adopt)
    expect(adopt).toBeGreaterThan(-1)
    expect(refetch).toBeGreaterThan(adopt)
  })

  it('says out loud that the built-in engine loses the slot, and names the way back', () => {
    expect(src).toContain('adoptionReplacesBuiltinEngine')
    expect(src).toMatch(/This also makes LM Studio your local chat backend in place of the built-in engine/)
    expect(src).toMatch(/Settings, AI Backends, Providers/)
  })
})
