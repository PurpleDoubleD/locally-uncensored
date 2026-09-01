import { describe, it, expect } from 'vitest'
import { parseLooseToolCalls, stripMatchedCalls, stripToolCallText, canonicalToolName } from '../loose-tool-parse'

const KNOWN = ['image_generate', 'video_generate', 'web_search', 'file_write']

describe('parseLooseToolCalls — function-call syntax', () => {
  it('extracts the exact prose call qwen2.5-coder wrote live', () => {
    const r = parseLooseToolCalls('image_generate(prompt="a small red cube on a wooden table")', KNOWN)
    expect(r.calls).toEqual([{ name: 'image_generate', arguments: { prompt: 'a small red cube on a wooden table' } }])
    expect(r.matched.length).toBe(1)
  })

  it('parses multiple kwargs incl. numbers + single quotes', () => {
    const r = parseLooseToolCalls("image_generate(prompt='a red cube', denoise=0.6, steps=20)", KNOWN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'a red cube', denoise: 0.6, steps: 20 } })
  })

  it('parses colon-style args', () => {
    const r = parseLooseToolCalls('image_generate(prompt: "sunset over hills")', KNOWN)
    expect(r.calls[0].arguments).toEqual({ prompt: 'sunset over hills' })
  })

  it('maps a single positional string to prompt', () => {
    const r = parseLooseToolCalls('image_generate("a lighthouse at dusk")', KNOWN)
    expect(r.calls[0].arguments).toEqual({ prompt: 'a lighthouse at dusk' })
  })

  it('parses video_generate with inputImage for image→video chaining', () => {
    const r = parseLooseToolCalls('video_generate(inputImage="locally_uncensored_00084_.png", prompt="gentle zoom")', KNOWN)
    expect(r.calls[0]).toEqual({
      name: 'video_generate',
      arguments: { inputImage: 'locally_uncensored_00084_.png', prompt: 'gentle zoom' },
    })
  })

  it('finds the call even inside a fenced code block', () => {
    const r = parseLooseToolCalls('Sure!\n```\nimage_generate(prompt="a fox")\n```', KNOWN)
    expect(r.calls[0].arguments).toEqual({ prompt: 'a fox' })
  })
})

describe('parseLooseToolCalls — JSON object syntax', () => {
  it('extracts {"name","arguments"}', () => {
    const r = parseLooseToolCalls('{"name": "image_generate", "arguments": {"prompt": "x"}}', KNOWN)
    expect(r.calls).toEqual([{ name: 'image_generate', arguments: { prompt: 'x' } }])
  })

  it('extracts a fenced ```json blob with {"tool","parameters"}', () => {
    const txt = 'Here:\n```json\n{"tool": "image_generate", "parameters": {"prompt": "a cat"}}\n```'
    const r = parseLooseToolCalls(txt, KNOWN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'a cat' } })
  })

  it('tolerates trailing commas (repairJson)', () => {
    const r = parseLooseToolCalls('{"name":"image_generate","arguments":{"prompt":"x",}}', KNOWN)
    expect(r.calls[0].name).toBe('image_generate')
  })
})

describe('parseLooseToolCalls — Hermes tags in content', () => {
  it('extracts a <tool_call> tag the model put in its answer', () => {
    const r = parseLooseToolCalls('<tool_call>\n{"name": "image_generate", "arguments": {"prompt": "y"}}\n</tool_call>', KNOWN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'y' } })
    expect(r.matched.some((s) => s.includes('<tool_call>'))).toBe(true)
  })
})

describe('parseLooseToolCalls — safety (no false positives)', () => {
  it('ignores unknown tool names', () => {
    expect(parseLooseToolCalls('do_something(x=1)', KNOWN).calls).toEqual([])
  })

  it('ignores a tool NAME mentioned in prose with no call', () => {
    expect(parseLooseToolCalls('You can use the image_generate tool to make pictures.', KNOWN).calls).toEqual([])
  })

  it('ignores empty parens (image_generate())', () => {
    expect(parseLooseToolCalls('Call image_generate() to start.', KNOWN).calls).toEqual([])
  })

  it('returns nothing for ordinary prose', () => {
    expect(parseLooseToolCalls('The cube is small and red, sitting on oak.', KNOWN).calls).toEqual([])
  })

  it('dedupes the same call found by two patterns', () => {
    const txt = 'image_generate(prompt="z") and also {"name":"image_generate","arguments":{"prompt":"z"}}'
    const r = parseLooseToolCalls(txt, KNOWN)
    expect(r.calls.length).toBe(1)
  })
})

describe('canonicalToolName — map near-miss tool names', () => {
  const KN = ['image_generate', 'video_generate', 'web_search', 'web_fetch', 'file_read']

  it('maps the exact miss gemma4 emitted live (video_generation → video_generate)', () => {
    expect(canonicalToolName('video_generation', KN)).toBe('video_generate')
  })

  it('maps common generate_* / *_generation aliases', () => {
    expect(canonicalToolName('image_generation', KN)).toBe('image_generate')
    expect(canonicalToolName('generate_video', KN)).toBe('video_generate')
    expect(canonicalToolName('generate_image', KN)).toBe('image_generate')
  })

  it('is punctuation/casing-insensitive (video-generate, VideoGenerate)', () => {
    expect(canonicalToolName('video-generate', KN)).toBe('video_generate')
    expect(canonicalToolName('VideoGenerate', KN)).toBe('video_generate')
  })

  it('passes exact names through unchanged', () => {
    expect(canonicalToolName('image_generate', KN)).toBe('image_generate')
  })

  it('leaves a genuinely unknown tool unchanged (still errors downstream)', () => {
    expect(canonicalToolName('teleport', KN)).toBe('teleport')
  })

  // Live on the ship exe, 2026-07-24: gpt-oss through LU Cloud sent the
  // recipient as `file_edit<|channel|>commentary`. Every write tool call came
  // back "Unknown tool" and the model spent a minute retrying the same name.
  describe('harmony control tokens welded onto the name', () => {
    const CODE = ['file_read', 'file_write', 'file_edit', 'shell_execute']

    it('recovers the exact name that failed live', () => {
      expect(canonicalToolName('file_edit<|channel|>commentary', CODE)).toBe('file_edit')
    })

    it('recovers other tools carrying the same marker', () => {
      expect(canonicalToolName('file_write<|channel|>commentary', CODE)).toBe('file_write')
      expect(canonicalToolName('shell_execute<|channel|>analysis', CODE)).toBe('shell_execute')
    })

    it('strips the harmony recipient namespace', () => {
      expect(canonicalToolName('functions.file_edit', CODE)).toBe('file_edit')
      expect(canonicalToolName('functions.file_edit<|channel|>commentary', CODE)).toBe('file_edit')
    })

    it('tolerates surrounding whitespace and a trailing call arrow', () => {
      expect(canonicalToolName('  file_edit ', CODE)).toBe('file_edit')
      expect(canonicalToolName('file_edit<|constrain|>json', CODE)).toBe('file_edit')
    })

    // The cut can only SHORTEN a name, so it can never turn one registered
    // tool into a different one, and an unknown stem still errors.
    it('does not invent a tool out of noise', () => {
      expect(canonicalToolName('<|channel|>commentary', CODE)).toBe('<|channel|>commentary')
      expect(canonicalToolName('teleport<|channel|>commentary', CODE)).toBe('teleport<|channel|>commentary')
    })

    it('keeps a dotted name intact when the full name is the registered one', () => {
      const mcp = ['mcp.server.do_thing']
      expect(canonicalToolName('mcp.server.do_thing', mcp)).toBe('mcp.server.do_thing')
    })
  })

  it('never maps an alias to a tool that is not registered', () => {
    expect(canonicalToolName('video_generation', ['image_generate'])).toBe('video_generation')
  })
})

describe('stripMatchedCalls', () => {
  it('removes the recognized call snippet from the prose', () => {
    const txt = 'Okay, generating now: image_generate(prompt="a red cube")'
    const r = parseLooseToolCalls(txt, KNOWN)
    const stripped = stripMatchedCalls(txt, r.matched)
    expect(stripped).not.toContain('image_generate(prompt=')
    expect(stripped.toLowerCase()).toContain('okay')
  })
})

describe('stripToolCallText — keep raw tool-call JSON out of the visible bubble', () => {
  it('strips a bare {"name","arguments"} object, keeps the prose (David 2026-06-04 leak)', () => {
    const txt = 'Hier ist dein Bild.\n{ "name": "image_generate", "arguments": { "prompt": "eine katze" } }'
    const out = stripToolCallText(txt, KNOWN)
    expect(out).toContain('Hier ist dein Bild.')
    expect(out).not.toContain('"name"')
    expect(out).not.toContain('image_generate')
  })

  it('strips a fenced ```json tool call but keeps surrounding prose', () => {
    const txt = 'Okay:\n```json\n{ "name": "image_generate", "arguments": { "prompt": "a cat" } }\n```'
    const out = stripToolCallText(txt, KNOWN)
    expect(out).not.toContain('image_generate')
    expect(out.toLowerCase()).toContain('okay')
  })

  it('strips function-call syntax echoed alongside a native call', () => {
    const out = stripToolCallText('Generating now image_generate(prompt="a fox")', KNOWN)
    expect(out).not.toContain('image_generate(')
  })

  it('leaves ordinary prose untouched', () => {
    expect(stripToolCallText('The cube is small and red.', KNOWN)).toBe('The cube is small and red.')
  })

  it('keeps a non-tool JSON object (no known tool name) intact', () => {
    const out = stripToolCallText('Result: {"foo": 1, "bar": 2}', KNOWN)
    expect(out).toContain('foo')
  })

  it('returns empty when the content is ONLY a tool call', () => {
    expect(stripToolCallText('{ "name": "video_generate", "arguments": { "seconds": 4 } }', KNOWN)).toBe('')
  })
})

// ── New small-model formats (2026-06-06): Phi-4 et al. emit calls the original
// three patterns missed. Each case below is grounded in a live observation or a
// known small-model tool-call template, so the parser is the safety net that
// makes them work without a model swap. ────────────────────────────────────
describe('parseLooseToolCalls — bracket / space-brace form (Phi-4 live)', () => {
  const KN = ['file_read', 'file_write', 'file_list', 'image_generate']

  it('extracts the EXACT bracket call Phi-4-mini wrote live: [file_read {"path":"/package.json"}]', () => {
    const r = parseLooseToolCalls('[file_read {"path": "/package.json"}]', KN)
    expect(r.calls).toEqual([{ name: 'file_read', arguments: { path: '/package.json' } }])
    expect(r.matched.length).toBe(1)
  })

  it('extracts a space-brace call without brackets: file_list {"path":"."}', () => {
    const r = parseLooseToolCalls('I will list files. file_list {"path": "."}', KN)
    expect(r.calls[0]).toEqual({ name: 'file_list', arguments: { path: '.' } })
  })

  it('unwraps an arguments wrapper inside the brace', () => {
    const r = parseLooseToolCalls('[image_generate {"arguments": {"prompt": "a cat"}}]', KN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'a cat' } })
  })

  it('ignores an empty brace (file_read {}) — not a usable call', () => {
    expect(parseLooseToolCalls('file_read {}', KN).calls).toEqual([])
  })

  it('ignores a non-JSON brace in prose (file_list {the current folder})', () => {
    expect(parseLooseToolCalls('use file_list {the current folder}', KN).calls).toEqual([])
  })

  it('ignores an unknown tool in bracket form ([calculate {…}] — LU has no calculate)', () => {
    expect(parseLooseToolCalls('[calculate {"a": 1}]', KN).calls).toEqual([])
  })
})

describe('parseLooseToolCalls — Phi-4 special-token wrapper', () => {
  const KN = ['file_list', 'file_read']

  it('extracts the JSON object inside <|tool_call|>…<|/tool_call|>', () => {
    const txt = '<|tool_call|>{"name": "file_list", "arguments": {"path": "."}}<|/tool_call|>'
    const r = parseLooseToolCalls(txt, KN)
    expect(r.calls[0]).toEqual({ name: 'file_list', arguments: { path: '.' } })
  })

  it('stripToolCallText removes the <|tool_call|> tokens from the visible bubble', () => {
    const txt = 'Listing now.<|tool_call|>{"name":"file_list","arguments":{"path":"."}}<|/tool_call|>'
    const out = stripToolCallText(txt, KN)
    expect(out).not.toContain('<|tool_call|>')
    expect(out).not.toContain('file_list')
    expect(out.toLowerCase()).toContain('listing now')
  })
})

describe('parseLooseToolCalls — nested function object + string args (OpenAI/Phi shapes)', () => {
  const KN = ['file_write', 'image_generate']

  it('unwraps {"function":{"name","arguments"}}', () => {
    const txt = '{"function": {"name": "image_generate", "arguments": {"prompt": "x"}}}'
    const r = parseLooseToolCalls(txt, KN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'x' } })
  })

  it('repairs args that arrive as a JSON STRING', () => {
    const txt = '{"name": "file_write", "arguments": "{\\"path\\": \\"a.txt\\", \\"content\\": \\"hi\\"}"}'
    const r = parseLooseToolCalls(txt, KN)
    expect(r.calls[0]).toEqual({ name: 'file_write', arguments: { path: 'a.txt', content: 'hi' } })
  })

  // Fehler 3: derselbe String-Argumente-Fall, aber ueber die HERMES-Schiene.
  // parseJsonObjectCalls hat die JSON-Zeichenkette selbst repariert, der
  // <tool_call>-Pfad nicht — dort ging `arguments` als STRING an den Executor,
  // der `args.path` liest. Ergebnis: "path is required", obwohl das Modell den
  // Pfad geschickt hatte, und der Agent probierte denselben Aufruf erneut.
  it('repairs string args that arrive inside a <tool_call> tag', () => {
    const txt = '<tool_call>{"name": "file_write", "arguments": "{\\"path\\": \\"a.txt\\", \\"content\\": \\"hi\\"}"}</tool_call>'
    const r = parseLooseToolCalls(txt, KN)
    expect(r.calls[0]).toEqual({ name: 'file_write', arguments: { path: 'a.txt', content: 'hi' } })
  })

  it('accepts the name carried by a tool_call key', () => {
    const txt = '{"tool_call": "image_generate", "arguments": {"prompt": "y"}}'
    const r = parseLooseToolCalls(txt, KN)
    expect(r.calls[0]).toEqual({ name: 'image_generate', arguments: { prompt: 'y' } })
  })
})

describe('stripToolCallText — leftover Hermes tags', () => {
  const KN = ['file_list', 'file_read', 'web_search']

  // Live Agent run, ship exe 2026-07-25. stripToolCallTags only removes matched
  // PAIRS, so an unclosed `<tool_call>` survived every stripper and reached the
  // bubble, where the renderer ate the `<t` and the user saw `ool_call>`.
  it('removes an UNCLOSED opening tag', () => {
    expect(stripToolCallText('Let me look.\n<tool_call>', KN)).toBe('Let me look.')
  })

  it('removes a stray closing tag', () => {
    expect(stripToolCallText('</tool_call>\nDone.', KN)).toBe('Done.')
  })

  it('still removes the piped and bracketed spellings', () => {
    expect(stripToolCallText('<|tool_call|>x', KN)).toBe('x')
    expect(stripToolCallText('[TOOL_CALLS]x', KN)).toBe('x')
  })

  it('leaves ordinary prose about tool calls alone', () => {
    const prose = 'the tool call failed, try again'
    expect(stripToolCallText(prose, KN)).toBe(prose)
  })

  // Captured from the wire, ship exe 2026-07-25. Qwen3-32B on LU Cloud put
  // `</think>\n\nool_call>` in its content next to a valid native tool_calls
  // array: the provider's harmony parser had already eaten the `<t`, so every
  // pattern anchored on `<` missed the remainder and the user saw `ool_call>`.
  it('removes a TRUNCATED tag the provider mangled before we ever saw it', () => {
    expect(stripToolCallText('I will look at it.\nool_call>', KN)).toBe('I will look at it.')
    expect(stripToolCallText('ool_call>', KN)).toBe('')
    expect(stripToolCallText('ool_calls>', KN)).toBe('')
  })

  it('only strips the fragment when it is the whole line', () => {
    // Anchored per line, so a sentence that happens to contain the characters
    // is never touched.
    const prose = 'the log said ool_call> which is odd'
    expect(stripToolCallText(prose, KN)).toBe(prose)
  })

  // Captured on the ship exe 2026-07-25 (Agent, qwen2.5-coder:14b): asked for
  // two tools in one step, the model emitted them natively AND echoed both as
  // one ```json ARRAY. The two objects were stripped by range and the user was
  // left with a "notes" block containing nothing but `[`, a comma and `]`.
  it('leaves no empty husk when an echoed call ARRAY is stripped', () => {
    const echoed = 'Running both now.\n\n```json\n[\n  {"name": "run_tests", "arguments": {}},\n  {"name": "shell_execute", "arguments": {"command": "echo hi"}}\n]\n```'
    expect(stripToolCallText(echoed, KN)).toBe('Running both now.')
  })

  it('never drops a fence that still carries real content', () => {
    const code = 'Here is the patch:\n\n```js\nconst a = 1\n```'
    expect(stripToolCallText(code, KN)).toContain('const a = 1')
  })
})

// ── Code inside the arguments (2026-07-28) ──────────────────────────
//
// The brace scanners counted braces inside JSON STRINGS as structure. A
// file_write whose content holds a regex, a half-open CSS block or a stray
// closing brace therefore either vanished (no candidate — the model believes
// it wrote the file, nothing happened) or was cut one brace early, so the
// arguments arrived wrong. Small local models writing code is the single most
// common use of this loose path.
describe('parseLooseToolCalls — braces inside the content string', () => {
  it('keeps the call when the content holds a lone opening brace', () => {
    const text = '{"name":"file_write","arguments":{"path":"a.js","content":"const re = /\\\\{/"}}'
    const r = parseLooseToolCalls(text, KNOWN)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].name).toBe('file_write')
    expect(r.calls[0].arguments.path).toBe('a.js')
  })

  it('keeps the call when the content holds a lone closing brace', () => {
    const text = '{"name":"file_write","arguments":{"path":"a.js","content":"} // end of block"}}'
    const r = parseLooseToolCalls(text, KNOWN)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].arguments.content).toBe('} // end of block')
  })

  it('keeps an unfinished CSS block intact', () => {
    const text = '{"name":"file_write","arguments":{"path":"a.css","content":"a { color: red"}}'
    const r = parseLooseToolCalls(text, KNOWN)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].arguments.content).toBe('a { color: red')
  })

  it('handles the bare-name form with deeply nested arguments', () => {
    const text = 'file_write {"path":"cfg.json","content":"{\\"a\\":{\\"b\\":{\\"c\\":1}}}"}'
    const r = parseLooseToolCalls(text, KNOWN)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].arguments.path).toBe('cfg.json')
    expect(r.matched[0]).toContain('file_write')
  })
})
