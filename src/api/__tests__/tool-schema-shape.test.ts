/**
 * Schema-shape guard for every registered tool, on every transport (2026-08-05).
 *
 * The owner's bar: a tool is only finished when its schema arrives intact on every
 * transport, for every model and every provider. The parity test compares
 * desktop against mobile and the roster test compares prompt against registry.
 * Neither one ever asks the simpler question: is the schema itself something
 * all four transports can carry?
 *
 * The four paths are `openai` (built-in engine, LM Studio, llama.cpp, vLLM,
 * KoboldCpp, Jan, LocalAI, TabbyAPI, LiteLLM, text-generation-webui), `ollama`,
 * `anthropic` and `lu-cloud`. Three of them forward `inputSchema` verbatim as
 * `parameters`; Anthropic renames it to `input_schema`. So a schema defect is
 * never a one-provider defect: it lands on all of them at once, and on the
 * Hermes prompt path on top, where the schema is JSON-stringified into the
 * system prompt and a model with no native tool channel reads it as prose.
 *
 * These are the invariants the strictest consumer in the chain enforces:
 * Anthropic and the OpenAI function API both reject a name outside
 * [a-zA-Z0-9_-]{1,64}, both want a top-level object, and every one of them
 * silently gives the model a parameter it cannot guess when a property has no
 * description or no type.
 */
import { describe, it, expect } from 'vitest'
import { toolRegistry } from '../mcp'
import type { JSONSchemaProp, MCPToolDefinition } from '../mcp/types'

/** Every tool, regardless of permission: a blocked category still ships a schema. */
const TOOLS: MCPToolDefinition[] = toolRegistry.getAll()

/** The permission map that hides nothing, so the transport checks see everything. */
const ALL_ALLOWED = {
  filesystem: 'auto', terminal: 'auto', desktop: 'auto', web: 'auto',
  system: 'auto', image: 'auto', video: 'auto', workflow: 'auto', mcp: 'auto',
} as const

/** JSON-Schema types every one of the four transports understands. */
const KNOWN_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

/** Walk a property tree, yielding [path, prop] for the property and everything under it. */
function walk(path: string, prop: JSONSchemaProp): [string, JSONSchemaProp][] {
  const out: [string, JSONSchemaProp][] = [[path, prop]]
  if (prop.items) out.push(...walk(`${path}[]`, prop.items))
  if (prop.properties) {
    for (const [k, v] of Object.entries(prop.properties)) out.push(...walk(`${path}.${k}`, v))
  }
  if (prop.additionalProperties && typeof prop.additionalProperties === 'object') {
    out.push(...walk(`${path}.*`, prop.additionalProperties))
  }
  return out
}

function everyProp(tool: MCPToolDefinition): [string, JSONSchemaProp][] {
  return Object.entries(tool.inputSchema.properties).flatMap(([k, v]) => walk(`${tool.name}.${k}`, v))
}

const typesOf = (p: JSONSchemaProp): string[] => (Array.isArray(p.type) ? p.type : [p.type])

describe('the registry parsed, so the rest of this file means something', () => {
  it('has the tools we expect to audit', () => {
    // 15 since the 2.6.6 merge folded the typed shell wrappers away.
    expect(TOOLS.length).toBeGreaterThan(12)
    expect(TOOLS.map((t) => t.name)).toContain('todo_write')
  })
})

describe('tool names survive the strictest provider', () => {
  it('every name matches what Anthropic and OpenAI both accept', () => {
    // Both reject anything else outright with a 400, which would take down the
    // whole request, not just the one tool.
    const bad = TOOLS.filter((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)).map((t) => t.name)
    expect(bad).toEqual([])
  })

  it('no two tools share a name', () => {
    const seen = new Set<string>()
    const dupes = TOOLS.map((t) => t.name).filter((n) => (seen.has(n) ? true : (seen.add(n), false)))
    expect(dupes).toEqual([])
  })

  it('every tool carries a description a model can act on', () => {
    // An empty description on the Hermes path leaves the model a bare name.
    const thin = TOOLS.filter((t) => (t.description ?? '').trim().length < 20).map((t) => t.name)
    expect(thin).toEqual([])
  })
})

describe('the top level of every schema is what the transports expect', () => {
  it('is an object schema with a properties map', () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type, `${t.name}: top-level type`).toBe('object')
      expect(typeof t.inputSchema.properties, `${t.name}: properties`).toBe('object')
      expect(Array.isArray(t.inputSchema.properties), `${t.name}: properties is a map`).toBe(false)
    }
  })

  it('required names only properties that exist', () => {
    // A required key with no property is a promise the model cannot keep: it
    // has no type and no description to work from, so it guesses or omits.
    for (const t of TOOLS) {
      const props = Object.keys(t.inputSchema.properties)
      const missing = (t.inputSchema.required ?? []).filter((r) => !props.includes(r))
      expect(missing, `${t.name}: required names unknown properties`).toEqual([])
    }
  })

  it('required has no duplicates', () => {
    for (const t of TOOLS) {
      const req = t.inputSchema.required ?? []
      expect(new Set(req).size, `${t.name}: duplicate entry in required`).toBe(req.length)
    }
  })
})

describe('every property, however deep, is usable by a model', () => {
  it('declares a type the transports know', () => {
    const bad: string[] = []
    for (const t of TOOLS) {
      for (const [path, p] of everyProp(t)) {
        const types = typesOf(p)
        if (types.length === 0 || types.some((ty) => !KNOWN_TYPES.has(ty))) bad.push(`${path}: ${JSON.stringify(p.type)}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('every NAMED property carries a description, at every depth', () => {
    // The nested case is the one that rots unnoticed: a top-level parameter gets
    // reviewed, a field inside an array item does not, and on the prompt path
    // that field is all the model has to go on.
    //
    // An array's ITEM schema is exempt, and that is not a loophole: `files[]`
    // and `todos[]` are not names the model ever writes. The array above them
    // is described, and an item that is an object still has each of its own
    // fields checked here. Requiring prose on the item itself would only buy
    // "an entry of the list".
    const bare: string[] = []
    for (const t of TOOLS) {
      for (const [path, p] of everyProp(t)) {
        if (path.endsWith('[]')) continue
        if (!(p.description ?? '').trim()) bare.push(path)
      }
    }
    expect(bare).toEqual([])
  })

  it('an array property says what its items are', () => {
    // Without `items` the validator's per-item walk has nothing to check and the
    // model has nothing to build, so it sends an array of whatever it guessed.
    const bad: string[] = []
    for (const t of TOOLS) {
      for (const [path, p] of everyProp(t)) {
        if (typesOf(p).includes('array') && !p.items) bad.push(path)
      }
    }
    expect(bad).toEqual([])
  })

  it('an enum is a non-empty list that matches its own declared type', () => {
    const bad: string[] = []
    for (const t of TOOLS) {
      for (const [path, p] of everyProp(t)) {
        if (!p.enum) continue
        if (!Array.isArray(p.enum) || p.enum.length === 0) { bad.push(`${path}: empty enum`); continue }
        if (typesOf(p).includes('string') && p.enum.some((v) => typeof v !== 'string')) {
          bad.push(`${path}: non-string value in a string enum`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('a nested required list names fields that exist', () => {
    // Same failure as at the top level, one level down, where nothing looks.
    const bad: string[] = []
    for (const t of TOOLS) {
      for (const [path, p] of everyProp(t)) {
        if (!p.required) continue
        const keys = Object.keys(p.properties ?? {})
        for (const r of p.required) if (!keys.includes(r)) bad.push(`${path}.${r}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('a default value fits the type it defaults', () => {
    const bad: string[] = []
    for (const t of TOOLS) {
      for (const [path, p] of everyProp(t)) {
        if (p.default === undefined) continue
        const types = typesOf(p)
        const actual = Array.isArray(p.default) ? 'array' : p.default === null ? 'null' : typeof p.default
        const fits = types.some((ty) =>
          ty === actual || ((ty === 'integer' || ty === 'number') && actual === 'number'))
        if (!fits) bad.push(`${path}: default ${JSON.stringify(p.default)} against ${JSON.stringify(p.type)}`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('the schema survives serialization, which is what the prompt path does', () => {
  it('round-trips through JSON unchanged', () => {
    // buildHermesToolPrompt stringifies the schema into the system prompt. An
    // undefined, a function or a cyclic value would vanish silently there while
    // the native transports still carried it, so the same tool would have two
    // different contracts depending on the model.
    for (const t of TOOLS) {
      const round = JSON.parse(JSON.stringify(t.inputSchema))
      expect(round, `${t.name}: schema is not plain JSON`).toEqual(t.inputSchema)
    }
  })

  it('no schema text can close a Hermes fence', () => {
    // Tool definitions go into the prompt inside <tools>. A description or an
    // enum value carrying a closing marker would end the block early.
    for (const t of TOOLS) {
      const blob = `${t.description}\n${JSON.stringify(t.inputSchema)}`
      expect(blob, `${t.name}: schema text contains a tool marker`).not.toMatch(/<\/?(tools|tool_call|tool_response)\b/i)
    }
  })
})

describe('all four transports carry the same schema', () => {
  const ollama = toolRegistry.toOllamaTools(ALL_ALLOWED)
  const openai = toolRegistry.toOpenAITools(ALL_ALLOWED)
  const hermes = toolRegistry.toHermesToolDefs(ALL_ALLOWED)

  it('offers the same tools on each', () => {
    const names = (xs: { name?: string; function?: { name: string } }[]) =>
      xs.map((x) => x.name ?? x.function!.name).sort()
    expect(names(ollama)).toEqual(names(openai))
    expect(names(hermes)).toEqual(names(openai))
  })

  it('hands each one the schema unflattened, nesting included', () => {
    // The one mapping that renames rather than forwards is Anthropic
    // (input_schema: t.function.parameters), and it reads the OpenAI shape, so
    // proving the OpenAI shape is intact proves the Anthropic one too.
    for (const t of TOOLS) {
      const o = openai.find((x) => x.function.name === t.name)!
      const l = ollama.find((x) => x.function.name === t.name)!
      const h = hermes.find((x) => x.name === t.name)!
      expect(o.function.parameters, `${t.name}: openai`).toEqual(t.inputSchema)
      expect(l.function.parameters, `${t.name}: ollama`).toEqual(t.inputSchema)
      expect(h.parameters, `${t.name}: hermes`).toEqual(t.inputSchema)
    }
  })

  it('the tool with the deepest schema really is nested, so the check above bites', () => {
    // A guard on the guard: if every schema were flat, every equality above
    // would pass for the wrong reason.
    const deepest = TOOLS.filter((t) =>
      Object.values(t.inputSchema.properties).some((p) => p.items?.properties || p.properties))
    expect(deepest.map((t) => t.name)).toContain('todo_write')
  })
})
