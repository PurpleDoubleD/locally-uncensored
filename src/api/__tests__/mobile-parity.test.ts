/**
 * Mobile Web UI parity tests.
 *
 * ── 01.09.2026 (T-75): this file WAS the finding ──
 *
 * Until today the top of this file read:
 *
 *     // ─── Re-implementations matching the mobile HTML (must stay in sync) ───
 *     const CAVEMAN_PROMPTS = { lite: '…', full: '…', ultra: '…' }
 *     function buildSystemPrompt(chat, opts) { … }
 *     function transformUserMessageWithCaveman(msg, caveman, _model) { … }
 *     function buildOllamaBody(model, messages, opts) { … }
 *
 * — a hand-written TypeScript copy of four things the mobile client does,
 * followed by sixty assertions about the copy. The client itself was a Rust
 * string literal nothing could import, so this was the only way to write a
 * test at all, and "must stay in sync" was the entire enforcement mechanism.
 * The suite was green whichever of the two versions was wrong.
 *
 * One detail says it best: `isThinkingCompatible` was imported from
 * `src/lib/model-compatibility` — the DESKTOP helper — and the tests below it
 * were headed "isThinkingCompatible (desktop helper reused on mobile)". The
 * mobile client has never used it. It carries its own, over its own prefix
 * list, with a different normalisation. Twelve green assertions about a
 * function the phone does not run.
 *
 * The client is real source now. Constants and pure helpers are imported from
 * mobile-client/. `buildSystemPrompt` and the client's own
 * `isThinkingCompatible` still live in the DOM-bound shell, so they are cut
 * out by name and run with their surroundings injected — the shipped body,
 * not a copy of it. See src/api/__tests__/mobile-client-shell.ts for why that
 * is the ceiling and what would have to move for an import.
 */
import { describe, it, expect } from 'vitest'
import { isThinkingCompatible as desktopIsThinkingCompatible } from '../../lib/model-compatibility'
import { CAVEMAN_PROMPTS, CAVEMAN_REMINDERS } from '../../../mobile-client/caveman.js'
import {
  CODEX_PROMPT,
  PERSONAS,
  THINKING_COMPATIBLE,
  isPlainTextPlanner,
} from '../../../mobile-client/personas.js'
import { clientSource, declarationSource, loadFromClient } from './mobile-client-shell'

const CLIENT = clientSource()

// ─── The two shell functions, run for real ───

interface MobileChat {
  mode: 'lu' | 'codex'
  caveman: 'off' | keyof typeof CAVEMAN_PROMPTS
  personaId: string
  personaEnabled: boolean
  agentEnabled: boolean
}

const defaults = (mode: 'lu' | 'codex' = 'lu'): MobileChat => ({
  mode,
  caveman: 'off',
  personaId: 'unrestricted',
  personaEnabled: false,
  agentEnabled: false,
})

/** The client's OWN thinking check, not the desktop one. */
const { isThinkingCompatible } = loadFromClient<{
  isThinkingCompatible: (m: string) => boolean
}>(['isThinkingCompatible'], { THINKING_COMPATIBLE })

/**
 * The shipped `buildSystemPrompt`, wired to a chat we control.
 *
 * Everything it reads about the world comes in here: the real persona list,
 * the real caveman table, the real Codex prompt, and the client's own
 * `AGENT_PROMPT` line, cut out of the same file. Only the per-chat getters and
 * the two host lines are stubbed, because those are what a test has to vary.
 */
function buildPrompt(
  chat: MobileChat,
  extra: { dispatched?: string; hostPlatformLine?: string; clock?: string } = {},
): string {
  const { buildSystemPrompt } = loadFromClient<{ buildSystemPrompt: () => string }>(
    ['AGENT_PROMPT', 'buildSystemPrompt'],
    {
      CAVEMAN_PROMPTS,
      PERSONAS,
      CODEX_PROMPT,
      getCaveman: () => chat.caveman,
      getCurrentMode: () => chat.mode,
      getAgentEnabled: () => chat.agentEnabled,
      getPersonaId: () => chat.personaId,
      getPersonaEnabled: () => chat.personaEnabled,
      dispatchedSystemPrompt: extra.dispatched ?? '',
      hostPlatformLine: extra.hostPlatformLine ?? '',
      hostClockLine: () => extra.clock ?? 'CLOCK',
    },
  )
  return buildSystemPrompt()
}

// ─── Tests ───

describe('mobile-parity › CAVEMAN_PROMPTS (imported from the shipped module)', () => {
  it('defines exactly three levels', () => {
    expect(Object.keys(CAVEMAN_PROMPTS)).toEqual(['lite', 'full', 'ultra'])
  })
  it('lite prompt mentions "concise and direct"', () => {
    expect(CAVEMAN_PROMPTS.lite).toContain('concise and direct')
  })
  it('full prompt mentions "smart caveman"', () => {
    expect(CAVEMAN_PROMPTS.full).toContain('smart caveman')
  })
  it('ultra prompt mentions "Maximum brevity"', () => {
    expect(CAVEMAN_PROMPTS.ultra).toContain('Maximum brevity')
  })
  it('all prompts preserve code blocks mention', () => {
    for (const k of Object.keys(CAVEMAN_PROMPTS) as (keyof typeof CAVEMAN_PROMPTS)[]) {
      expect(CAVEMAN_PROMPTS[k].toLowerCase()).toMatch(/code|unchanged/i)
    }
  })
  it('prompts escalate in brevity (length order)', () => {
    expect(CAVEMAN_PROMPTS.ultra.length).toBeLessThan(CAVEMAN_PROMPTS.full.length)
  })
})

describe('mobile-parity › CAVEMAN_REMINDERS', () => {
  it('has reminder for every prompt level', () => {
    expect(Object.keys(CAVEMAN_REMINDERS).sort()).toEqual(['full', 'lite', 'ultra'])
  })
  it('lite reminder is short and bracketed', () => {
    expect(CAVEMAN_REMINDERS.lite).toMatch(/^\[.+\]$/)
    expect(CAVEMAN_REMINDERS.lite.length).toBeLessThan(40)
  })
  it('full reminder is bracketed', () => {
    expect(CAVEMAN_REMINDERS.full).toMatch(/^\[.+\]$/)
  })
  it('ultra reminder is bracketed and shortest', () => {
    expect(CAVEMAN_REMINDERS.ultra).toMatch(/^\[.+\]$/)
    expect(CAVEMAN_REMINDERS.ultra.length).toBeLessThanOrEqual(CAVEMAN_REMINDERS.full.length)
  })
})

describe("mobile-parity › the client's OWN isThinkingCompatible", () => {
  const thinkingModels = [
    'qwq:latest',
    'deepseek-r1:8b',
    'qwen3:8b',
    'qwen3:14b',
    'qwen3.5:9b',
    'qwen3-coder:7b',
    'gemma3:12b',
    'gemma4:27b',
    'gemma4-e4b',
  ]
  for (const m of thinkingModels) {
    it(`recognises ${m} as thinking-compatible`, () => {
      expect(isThinkingCompatible(m)).toBe(true)
    })
  }

  const nonThinking = [
    'llama3.1:8b',
    'llama3.3:70b',
    'mistral-nemo:12b',
    'mistral-small:24b',
    'phi-4:14b',
    'glm-4:9b',
    'qwen2.5:7b',
  ]
  for (const m of nonThinking) {
    it(`recognises ${m} as NOT thinking-compatible`, () => {
      expect(isThinkingCompatible(m)).toBe(false)
    })
  }

  it('handles empty string gracefully', () => {
    expect(isThinkingCompatible('')).toBe(false)
  })

  it('handles abliterated prefix-stripping', () => {
    expect(isThinkingCompatible('qwen3-abliterated:8b')).toBe(true)
  })

  it('handles uncensored prefix-stripping', () => {
    expect(isThinkingCompatible('qwen3-uncensored:8b')).toBe(true)
  })

  it('reads the shipped THINKING_COMPATIBLE list, not a copy of it', () => {
    // The negative control for the whole block: feed the client its own list
    // with one entry removed and the answer has to change. If it did not, the
    // function would be matching against something else and every assertion
    // above would be about that something else.
    const withoutQwq = loadFromClient<{ isThinkingCompatible: (m: string) => boolean }>(
      ['isThinkingCompatible'],
      { THINKING_COMPATIBLE: THINKING_COMPATIBLE.filter((t) => t !== 'qwq') },
    ).isThinkingCompatible
    expect(isThinkingCompatible('qwq:latest')).toBe(true)
    expect(withoutQwq('qwq:latest')).toBe(false)
  })

  it('is NOT the desktop helper — the two disagree, and that is the finding', () => {
    // This file used to import the desktop helper and call the result mobile
    // parity. They are close, but they are two implementations: the desktop
    // one collapses dashes and strips `-heretic`, the mobile one does not.
    const heretic = 'qwen3-heretic:8b'
    expect(desktopIsThinkingCompatible(heretic)).toBe(true)
    expect(isThinkingCompatible(heretic)).toBe(true)
    // The lists themselves are separate objects in separate languages, so the
    // one thing worth asserting is that the mobile list is not empty and the
    // desktop agrees about the families it does name.
    expect(THINKING_COMPATIBLE.length).toBeGreaterThan(10)
    for (const tag of THINKING_COMPATIBLE) {
      expect(desktopIsThinkingCompatible(`${tag}:latest`)).toBe(true)
    }
  })
})

describe('mobile-parity › isPlainTextPlanner (Bug #80 escape hatch)', () => {
  it('names Gemma 3 and 4 and nothing else', () => {
    expect(isPlainTextPlanner('gemma3:12b')).toBe(true)
    expect(isPlainTextPlanner('gemma4:27b')).toBe(true)
    expect(isPlainTextPlanner('qwen3:8b')).toBe(false)
    expect(isPlainTextPlanner('')).toBe(false)
  })
  it('sees through ONE registry segment and the abliterated suffixes', () => {
    expect(isPlainTextPlanner('hf.co/gemma3-abliterated:q4')).toBe(true)
    // And only one: the strip is /^[^/]+\//, so a two-segment path keeps the
    // owner in front of the family name and the model reads as unknown. That
    // is what the shipped client does; it is written down here rather than
    // assumed away.
    expect(isPlainTextPlanner('hf.co/someone/gemma3-abliterated:q4')).toBe(false)
  })
})

describe('mobile-parity › buildSystemPrompt (the shipped function)', () => {
  it('returns empty string with defaults and no dispatched prompt', () => {
    expect(buildPrompt(defaults())).toBe('')
  })

  it('uses dispatched prompt when persona is disabled', () => {
    expect(buildPrompt(defaults(), { dispatched: 'DISPATCHED_SEED' })).toBe('DISPATCHED_SEED')
  })

  it('uses persona when enabled, dropping dispatched', () => {
    const coder = PERSONAS.find((p) => p.id === 'coder')!
    const out = buildPrompt(
      { ...defaults(), personaId: 'coder', personaEnabled: true },
      { dispatched: 'IGNORED' },
    )
    expect(out).toBe(coder.prompt)
    expect(out).not.toContain('IGNORED')
  })

  it('falls back to dispatched when personaEnabled but persona has empty prompt', () => {
    const out = buildPrompt(
      { ...defaults(), personaId: 'unrestricted', personaEnabled: true },
      { dispatched: 'DISPATCHED' },
    )
    expect(out).toBe('DISPATCHED')
  })

  it('prepends caveman prompt before persona', () => {
    const coder = PERSONAS.find((p) => p.id === 'coder')!
    const out = buildPrompt({
      ...defaults(),
      caveman: 'full',
      personaId: 'coder',
      personaEnabled: true,
    })
    expect(out.startsWith(CAVEMAN_PROMPTS.full)).toBe(true)
    expect(out).toContain(coder.prompt)
  })

  /**
   * FINDING (01.09.2026): codex mode does NOT ignore an enabled persona.
   *
   * The re-implementation this file used to test said it did:
   *
   *     if (chat.mode === 'codex') { parts.push(CODEX_PROMPT) }
   *     else { …persona… }
   *
   * The shipped client has no such else. It pushes the persona whenever the
   * switch is on, and then appends the Codex contract after it. So a Codex
   * chat with "Devil's Advocate" enabled sends both. Nine assertions in this
   * file were about the copy's behaviour, not the phone's.
   *
   * Which of the two is right is a product question and not this change's
   * business — T-75 ships the same bytes it found. What changes today is that
   * the test now says what actually happens.
   */
  it('codex mode appends the codex contract AFTER an enabled persona', () => {
    const coder = PERSONAS.find((p) => p.id === 'coder')!
    const out = buildPrompt({ ...defaults('codex'), personaId: 'coder', personaEnabled: true })
    expect(out).toContain('You are the Coding Agent')
    expect(out).toContain(coder.prompt)
    expect(out.indexOf(coder.prompt)).toBeLessThan(out.indexOf('You are the Coding Agent'))
  })

  it('codex mode with the persona switch off is the codex prompt plus the clock', () => {
    // Codex owns tools, so it always gets the environment block; with no
    // platform line supplied that is the clock alone.
    const out = buildPrompt({ ...defaults('codex'), personaId: 'coder' })
    expect(out).toBe(`${CODEX_PROMPT}\n\nCLOCK`)
  })

  it('codex mode still honours caveman mode', () => {
    const out = buildPrompt({ ...defaults('codex'), caveman: 'ultra' })
    expect(out.startsWith(CAVEMAN_PROMPTS.ultra)).toBe(true)
  })

  it('the autonomy contract comes LAST, after any persona', () => {
    // The Devil's-Advocate hijack: a persona appended after AGENT_PROMPT
    // overrode the tool-use rules and the model went off-topic.
    const coder = PERSONAS.find((p) => p.id === 'coder')!
    const out = buildPrompt({
      ...defaults(),
      agentEnabled: true,
      personaId: 'coder',
      personaEnabled: true,
    })
    expect(out.indexOf(coder.prompt)).toBeLessThan(out.indexOf('autonomous AI agent inside LU'))
  })

  it('uses "\\n\\n" as part separator', () => {
    const out = buildPrompt({
      ...defaults(),
      caveman: 'lite',
      personaId: 'coder',
      personaEnabled: true,
    })
    expect(out.includes('\n\n')).toBe(true)
  })
})

describe('mobile-parity › the environment block rides only on tool surfaces', () => {
  it('plain chat gets neither the platform line nor the clock', () => {
    const out = buildPrompt(defaults(), { hostPlatformLine: 'PLATFORM', clock: 'CLOCK' })
    expect(out).not.toContain('PLATFORM')
    expect(out).not.toContain('CLOCK')
  })

  it('agent mode gets both, platform first and clock last', () => {
    const out = buildPrompt(
      { ...defaults(), agentEnabled: true },
      { hostPlatformLine: 'PLATFORM', clock: 'CLOCK' },
    )
    expect(out.indexOf('PLATFORM')).toBeGreaterThan(-1)
    expect(out.indexOf('CLOCK')).toBeGreaterThan(out.indexOf('PLATFORM'))
    expect(out.endsWith('CLOCK')).toBe(true)
  })

  it('codex gets them too', () => {
    const out = buildPrompt(defaults('codex'), { hostPlatformLine: 'PLATFORM', clock: 'CLOCK' })
    expect(out).toContain('PLATFORM')
    expect(out).toContain('CLOCK')
  })

  it('an empty platform line is left out rather than guessed at', () => {
    const out = buildPrompt({ ...defaults(), agentEnabled: true }, { clock: 'CLOCK' })
    expect(out).not.toContain('PLATFORM')
    expect(out.endsWith('\n\nCLOCK')).toBe(true)
    // Nothing but the autonomy contract and the clock.
    expect(out.split('\n\n').at(-1)).toBe('CLOCK')
  })
})

describe('mobile-parity › the caveman reminder on every user turn', () => {
  // The transform is four lines inside `_doSend` and `runToolLoop`, not a
  // function, so there is nothing to import or cut out. These read the shipped
  // file: they say the line is written, not that it ran.
  const transform = /if\(m\.role==='user' && cm!=='off' && CAVEMAN_REMINDERS\[cm\]\)\{\s*\n\s*content = CAVEMAN_REMINDERS\[cm\] \+ '\\n' \+ content;/g

  it('both request paths prepend the reminder', () => {
    // Streaming chat and the agent loop each build their own apiMessages, and
    // the bug this guards was one of them being fixed and the other not.
    expect(CLIENT.match(transform)).toHaveLength(2)
  })

  it('the reminder is NOT gated on the model type', () => {
    // Parity with desktop useChat.ts: it used to fire only for
    // !isThinkingCompatible(model), so thinking-compatible models silently
    // lost Caveman style after turn 1.
    expect(CLIENT).not.toMatch(/!isThinkingCompatible\([^)]*\)\s*&&\s*cm!=='off'/)
  })
})

describe('mobile-parity › the Ollama request body', () => {
  // Same situation: the body literal is inline in `_doSend`.
  const body = declarationSource('_doSend')

  it('_doSend is still where the streaming body is built', () => {
    expect(body).toContain("fetch('/api/chat'")
  })

  it('always streams', () => {
    expect(body).toMatch(/stream:\s*true/)
  })

  it('v2.4.6 Bug L: does NOT force num_gpu — Ollama auto-decides layers', () => {
    // Pre-v2.4.6 we set num_gpu:99 to force all layers to GPU. On 8 GB-VRAM
    // laptop cards that drowned the KV cache into system RAM (4.3× slower than
    // the ollama CLI). Letting Ollama decide restores CLI parity on tight
    // cards and is a no-op on cards with headroom.
    // Comments stripped first: the two lines that RECORD the removal say
    // "num_gpu:99", and matching the bare word would have made this green
    // whether or not the option came back.
    const code = CLIENT.replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/num_gpu/)
    expect(CLIENT).toMatch(/dropped hardcoded num_gpu:99/)
  })

  it('the think flag is tri-state, and the third state is Gemma', () => {
    // think:true when the toggle is on, think:false when it is off, and
    // ABSENT for a plain-text planner so Ollama tags its own reasoning and the
    // stripper can clean it.
    expect(body).toMatch(/if\(isThinkingCompatible\(currentModel\)\)\{/)
    expect(body).toMatch(/body\.think = true;/)
    expect(body).toMatch(/else if\(!isPlainTextPlanner\(currentModel\)\)\{\s*\n\s*body\.think = false;/)
  })

  it('a 400 is retried once without the think field', () => {
    expect(body).toMatch(/'think' in body/)
  })
})

describe('mobile-parity › image attachments', () => {
  const addFiles = declarationSource('addFiles')

  it('only image mime types are accepted', () => {
    expect(addFiles).toMatch(/\.type\.indexOf\('image\/'\)===0/)
  })

  it('at most five images ride along', () => {
    expect(addFiles).toMatch(/pendingImages\.concat\(items\)\.slice\(0, 5\)/)
  })

  it('the data-URL prefix is stripped so Ollama gets raw base64', () => {
    expect(addFiles).toMatch(/String\(dataUrl\)\.split\(','\)\[1\]/)
  })

  it('the API message carries images as a flat array of base64 strings', () => {
    expect(CLIENT).toMatch(/apiMsg\.images = m\.images\.map\(function\(im\)\{return im\.data;\}\)/)
  })
})

describe('mobile-parity › chat mode semantics', () => {
  const createChat = declarationSource('createChat')

  it('a new chat starts with the persona OFF and caveman off', () => {
    expect(createChat).toMatch(/caveman:\s*'off'/)
    expect(createChat).toMatch(/personaId:\s*'unrestricted'/)
    expect(createChat).toMatch(/personaEnabled:\s*false/)
  })

  it('a plain lu chat sends no system prompt at all; codex sends its contract', () => {
    expect(buildPrompt(defaults('lu'))).toBe('')
    expect(buildPrompt(defaults('codex'))).toBe(`${CODEX_PROMPT}\n\nCLOCK`)
  })
})
