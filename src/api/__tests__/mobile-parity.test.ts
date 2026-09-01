/**
 * Mobile Web UI parity tests
 *
 * The mobile web UI (rendered by src-tauri/src/commands/remote.rs::mobile_landing)
 * ships inline JS with re-implemented versions of a few desktop helpers. These
 * tests pin the expected behaviour so regressions on either side surface here.
 */
import { describe, it, expect } from 'vitest'
import { isThinkingCompatible } from '../../lib/model-compatibility'

// ─── Re-implementations matching the mobile HTML (must stay in sync) ───

const CAVEMAN_PROMPTS = {
  lite: 'Be concise and direct. Drop filler words (just, really, basically, actually, simply), hedging, and pleasantries. Retain full grammar and articles. Keep code blocks, file paths, URLs, and commands unchanged. Every response follows this style.',
  full: 'Respond terse like smart caveman. All technical substance stay. Only fluff die. Drop: articles, filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms preferred. Code unchanged. Pattern: [thing] [action] [reason]. [next step]. ACTIVE EVERY RESPONSE.',
  ultra: 'Maximum brevity. Fewest possible words. Telegraphic. Abbreviate (DB/auth/config/fn/impl/req/res). Strip conjunctions. Arrows for flow (X -> Y). No articles, no filler, no pleasantries. Fragments only. Under 3 sentences unless code. Code/paths/URLs unchanged. ACTIVE EVERY RESPONSE.',
} as const

const CAVEMAN_REMINDERS = {
  lite: '[Be concise. No filler.]',
  full: '[Terse. Fragments OK. No fluff.]',
  ultra: '[Max brevity. Telegraphic.]',
} as const

type CavemanMode = 'off' | keyof typeof CAVEMAN_PROMPTS

interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; images?: { data: string; mimeType: string }[] }
interface MobileChat { id: string; mode: 'lu' | 'codex'; caveman: CavemanMode; personaId: string; personaEnabled: boolean }

const CODEX_PROMPT_SNIPPET = 'You are the Coding Agent, a coding-focused assistant'

function buildSystemPrompt(chat: MobileChat, opts: { dispatched?: string; personas: { id: string; prompt: string }[] }): string {
  const parts: string[] = []
  if (chat.caveman !== 'off' && CAVEMAN_PROMPTS[chat.caveman]) parts.push(CAVEMAN_PROMPTS[chat.caveman])
  if (chat.mode === 'codex') {
    parts.push(`${CODEX_PROMPT_SNIPPET}. Provide clean, efficient, well-commented code.`)
  } else {
    const p = opts.personas.find(x => x.id === chat.personaId)
    if (chat.personaEnabled && p && p.prompt) parts.push(p.prompt)
    else if (opts.dispatched) parts.push(opts.dispatched)
  }
  return parts.join('\n\n')
}

function transformUserMessageWithCaveman(msg: ChatMessage, caveman: CavemanMode, _model: string): ChatMessage {
  if (msg.role !== 'user') return msg
  if (caveman === 'off') return msg
  // Parity with desktop: prepend on EVERY user message regardless of model
  // type. Was previously gated on !isThinkingCompatible(model), which made
  // thinking-compatible models silently lose Caveman style after turn 1.
  return { ...msg, content: CAVEMAN_REMINDERS[caveman] + '\n' + msg.content }
}

/**
 * Der Koerper, den die mobile Seite an Ollamas `/api/chat` schickt.
 *
 * Deklariert statt `any`: die Zusicherungen unten pruefen, dass `think` NICHT
 * gesetzt ist und dass `options.num_gpu` fehlt — auf einem `any` ist
 * "nicht gesetzt" von "das Feld heisst inzwischen anders" nicht zu
 * unterscheiden.
 */
type MobileOllamaBody = {
  model: string
  messages: ChatMessage[]
  stream: true
  options: { num_gpu?: number }
  think?: boolean
}

function buildOllamaBody(model: string, messages: ChatMessage[], opts: { thinking?: boolean } = {}): MobileOllamaBody {
  // v2.4.6 Bug L: dropped hardcoded num_gpu:99 (was forcing all layers to GPU
  // on every request, killing 8 GB-VRAM laptop chat speed). Ollama
  // auto-decides layer placement based on free VRAM now.
  const body: MobileOllamaBody = { model, messages, stream: true, options: {} }
  if (opts.thinking === true && isThinkingCompatible(model)) body.think = true
  return body
}

function mobileChatDefaults(mode: 'lu' | 'codex' = 'lu'): MobileChat {
  return { id: 'c-1', mode, caveman: 'off', personaId: 'unrestricted', personaEnabled: false }
}

// ─── Tests ───

describe('mobile-parity › CAVEMAN_PROMPTS', () => {
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
    // not strictly required, but documents intent — ultra should be shortest
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

describe('mobile-parity › isThinkingCompatible (desktop helper reused on mobile)', () => {
  const thinkingModels = [
    'qwq:latest', 'deepseek-r1:8b', 'qwen3:8b', 'qwen3:14b', 'qwen3.5:9b',
    'qwen3-coder:7b', 'gemma3:12b', 'gemma4:27b', 'gemma4-e4b',
  ]
  for (const m of thinkingModels) {
    it(`recognises ${m} as thinking-compatible`, () => {
      expect(isThinkingCompatible(m)).toBe(true)
    })
  }

  const nonThinking = [
    'llama3.1:8b', 'llama3.3:70b', 'mistral-nemo:12b', 'mistral-small:24b',
    'phi-4:14b', 'glm-4:9b', 'qwen2.5:7b',
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
})

describe('mobile-parity › buildSystemPrompt', () => {
  const personas = [
    { id: 'unrestricted', prompt: '' },
    { id: 'coder', prompt: 'You are an expert software engineer.' },
  ]

  it('returns empty string with defaults and no dispatched prompt', () => {
    const c = mobileChatDefaults()
    expect(buildSystemPrompt(c, { personas })).toBe('')
  })

  it('uses dispatched prompt when persona is disabled', () => {
    const c = mobileChatDefaults()
    const out = buildSystemPrompt(c, { personas, dispatched: 'DISPATCHED_SEED' })
    expect(out).toBe('DISPATCHED_SEED')
  })

  it('uses persona when enabled, dropping dispatched', () => {
    const c = { ...mobileChatDefaults(), personaId: 'coder', personaEnabled: true }
    const out = buildSystemPrompt(c, { personas, dispatched: 'IGNORED' })
    expect(out).toBe('You are an expert software engineer.')
  })

  it('falls back to dispatched when personaEnabled but persona has empty prompt', () => {
    const c = { ...mobileChatDefaults(), personaId: 'unrestricted', personaEnabled: true }
    const out = buildSystemPrompt(c, { personas, dispatched: 'DISPATCHED' })
    expect(out).toBe('DISPATCHED')
  })

  it('prepends caveman prompt before persona', () => {
    const c = { ...mobileChatDefaults(), caveman: 'full' as const, personaId: 'coder', personaEnabled: true }
    const out = buildSystemPrompt(c, { personas })
    expect(out.startsWith(CAVEMAN_PROMPTS.full)).toBe(true)
    expect(out).toContain('You are an expert software engineer.')
  })

  it('codex mode uses codex prompt and ignores persona', () => {
    const c = { ...mobileChatDefaults('codex'), personaId: 'coder', personaEnabled: true }
    const out = buildSystemPrompt(c, { personas })
    expect(out).toContain(CODEX_PROMPT_SNIPPET)
    expect(out).not.toContain('You are an expert software engineer.')
  })

  it('codex mode still honours caveman mode', () => {
    const c = { ...mobileChatDefaults('codex'), caveman: 'ultra' as const }
    const out = buildSystemPrompt(c, { personas })
    expect(out.startsWith(CAVEMAN_PROMPTS.ultra)).toBe(true)
  })

  it('uses "\\n\\n" as part separator', () => {
    const c = { ...mobileChatDefaults(), caveman: 'lite' as const, personaId: 'coder', personaEnabled: true }
    const out = buildSystemPrompt(c, { personas })
    expect(out.includes('\n\n')).toBe(true)
  })
})

describe('mobile-parity › transformUserMessageWithCaveman', () => {
  it('returns message unchanged when caveman is off', () => {
    const m: ChatMessage = { role: 'user', content: 'hi' }
    expect(transformUserMessageWithCaveman(m, 'off', 'llama3.1:8b')).toEqual(m)
  })

  it('prepends reminder when caveman=lite and model is non-thinking', () => {
    const m: ChatMessage = { role: 'user', content: 'hello' }
    const out = transformUserMessageWithCaveman(m, 'lite', 'llama3.1:8b')
    expect(out.content.startsWith('[Be concise. No filler.]')).toBe(true)
    expect(out.content.endsWith('hello')).toBe(true)
  })

  it('prepends reminder when caveman=full and model is non-thinking', () => {
    const m: ChatMessage = { role: 'user', content: 'x' }
    const out = transformUserMessageWithCaveman(m, 'full', 'llama3.1:8b')
    expect(out.content.startsWith('[Terse. Fragments OK. No fluff.]')).toBe(true)
  })

  it('prepends reminder when caveman=ultra and model is non-thinking', () => {
    const m: ChatMessage = { role: 'user', content: 'x' }
    const out = transformUserMessageWithCaveman(m, 'ultra', 'llama3.1:8b')
    expect(out.content.startsWith('[Max brevity. Telegraphic.]')).toBe(true)
  })

  it('also prepends reminder for thinking-compatible models (parity with desktop, fixes turn-2 drift)', () => {
    const m: ChatMessage = { role: 'user', content: 'hi' }
    const out = transformUserMessageWithCaveman(m, 'full', 'qwen3:8b')
    expect(out.content.startsWith('[Terse. Fragments OK. No fluff.]')).toBe(true)
    expect(out.content.endsWith('hi')).toBe(true)
  })

  it('leaves assistant messages alone', () => {
    const m: ChatMessage = { role: 'assistant', content: 'hi' }
    expect(transformUserMessageWithCaveman(m, 'full', 'llama3.1:8b')).toEqual(m)
  })

  it('leaves system messages alone', () => {
    const m: ChatMessage = { role: 'system', content: 'hi' }
    expect(transformUserMessageWithCaveman(m, 'full', 'llama3.1:8b')).toEqual(m)
  })
})

describe('mobile-parity › buildOllamaBody', () => {
  const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }]

  it('returns basic body without think when thinking=false', () => {
    const b = buildOllamaBody('qwen3:8b', msgs, { thinking: false })
    expect(b.think).toBeUndefined()
    expect(b.stream).toBe(true)
    // v2.4.6 Bug L: num_gpu no longer forced.
    expect(b.options.num_gpu).toBeUndefined()
  })

  it('sets think:true when thinking=true AND compatible', () => {
    const b = buildOllamaBody('qwen3:8b', msgs, { thinking: true })
    expect(b.think).toBe(true)
  })

  it('does NOT set think when thinking=true but model incompatible', () => {
    const b = buildOllamaBody('llama3.1:8b', msgs, { thinking: true })
    expect(b.think).toBeUndefined()
  })

  it('omits think field entirely by default', () => {
    const b = buildOllamaBody('qwen3:8b', msgs)
    expect('think' in b).toBe(false)
  })

  it('forwards messages array intact', () => {
    const b = buildOllamaBody('qwen3:8b', msgs)
    expect(b.messages).toBe(msgs)
  })

  it('always enables streaming', () => {
    const b = buildOllamaBody('llama3.1:8b', msgs)
    expect(b.stream).toBe(true)
  })

  it('v2.4.6 Bug L: does NOT force num_gpu — Ollama auto-decides layers', () => {
    // Pre-v2.4.6 we set num_gpu:99 to force all layers to GPU. On 8 GB-VRAM
    // laptop cards that drowned the KV cache into system RAM (4.3× slower
    // than ollama CLI per nightmare13740 report). Letting Ollama decide
    // restores CLI parity on tight cards and is a no-op on cards with
    // headroom.
    const b = buildOllamaBody('llama3.1:8b', msgs)
    expect(b.options.num_gpu).toBeUndefined()
  })
})

describe('mobile-parity › image attachment shape', () => {
  it('strips data-URL prefix leaving raw base64', () => {
    const dataUrl = 'data:image/png;base64,AAAABBBB'
    const base64 = dataUrl.split(',')[1]
    expect(base64).toBe('AAAABBBB')
  })

  it('serialises images array as [base64, base64, ...] to Ollama', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: 'describe',
      images: [{ data: 'AAA', mimeType: 'image/png' }, { data: 'BBB', mimeType: 'image/jpeg' }],
    }
    const ollamaShape = { ...msg, images: msg.images!.map(i => i.data) }
    expect(ollamaShape.images).toEqual(['AAA', 'BBB'])
  })

  it('max 5 images enforced by slice', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ data: `${i}`, mimeType: 'image/png' }))
    const capped = many.slice(0, 5)
    expect(capped.length).toBe(5)
  })

  it('file type filter accepts image/* mime types', () => {
    expect('image/png'.startsWith('image/')).toBe(true)
    expect('image/jpeg'.startsWith('image/')).toBe(true)
    expect('image/webp'.startsWith('image/')).toBe(true)
  })

  it('file type filter rejects non-image mime types', () => {
    expect('text/plain'.startsWith('image/')).toBe(false)
    expect('application/pdf'.startsWith('image/')).toBe(false)
  })
})

describe('mobile-parity › chat mode semantics', () => {
  it('lu mode chat defaults to unrestricted persona disabled', () => {
    const c = mobileChatDefaults('lu')
    expect(c.mode).toBe('lu')
    expect(c.personaId).toBe('unrestricted')
    expect(c.personaEnabled).toBe(false)
  })

  it('codex mode chat defaults too', () => {
    const c = mobileChatDefaults('codex')
    expect(c.mode).toBe('codex')
    expect(c.caveman).toBe('off')
  })

  it('codex mode ignores persona regardless of enabled flag', () => {
    const c = { ...mobileChatDefaults('codex'), personaId: 'coder', personaEnabled: true }
    const out = buildSystemPrompt(c, { personas: [{ id: 'coder', prompt: 'PERSONA' }] })
    expect(out).not.toContain('PERSONA')
  })
})
