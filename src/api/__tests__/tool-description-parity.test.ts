/**
 * Phase 3 (v2.4.0) — Tool-description parity test.
 *
 * The mobile web UI (rendered from src-tauri/src/commands/remote.rs::mobile_landing)
 * re-declares the AGENT_TOOLS array inline so the ReAct prompt on mobile lists
 * exactly the same capabilities. This test pins:
 *   - tool NAMES on both sides are the same set
 *   - each tool description is Claude-Code-quality (length + contains at least
 *     one of the recommended hint markers PREFER/NEVER/DO NOT/USE FIRST/Zero)
 *   - required-parameter lists line up
 *
 * If this test fails after a description edit, update BOTH sides together.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type BuiltinTool = {
  name: string
  description: string
  inputSchema: { properties: Record<string, any>; required: string[] }
}

// Import the desktop source of truth. Kept as a `require` to avoid pulling the
// full Tauri backend-call chain through vitest's module graph.
const builtinTools: BuiltinTool[] = (() => {
  // Grep the TS source directly to avoid transitive imports during test import.
  const ts = readFileSync(
    resolve(__dirname, '..', 'mcp', 'builtin-tools.ts'),
    'utf8'
  )
  return parseBuiltinToolsFromTs(ts)
})()

function parseBuiltinToolsFromTs(source: string): BuiltinTool[] {
  const tools: BuiltinTool[] = []
  // Match each entry inside BUILTIN_TOOLS: { name: '…', description: '…' + '…', … }
  const re =
    /\{\s*name:\s*'([^']+)'\s*,\s*description:\s*([\s\S]*?),\s*inputSchema:\s*(\{[\s\S]*?\}),\s*category/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const name = m[1]
    const description = evaluateStringLiteralExpression(m[2])
    const required = extractRequiredArray(m[3])
    const propsList = extractPropertiesNames(m[3])
    tools.push({
      name,
      description,
      inputSchema: {
        properties: Object.fromEntries(propsList.map((p) => [p, {}])),
        required,
      },
    })
  }
  return tools
}

// Handles concatenated string-literal expressions: 'a' + 'b' + "c" etc.
function evaluateStringLiteralExpression(expr: string): string {
  const pieces: string[] = []
  const re = /(['"])((?:\\.|(?!\1).)*?)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(expr)) !== null) {
    pieces.push(
      m[2]
        .replace(/\\\\/g, '\x00') // placeholder so we do not re-process escaped backslashes
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\x00/g, '\\')
    )
  }
  return pieces.join('')
}

function extractRequiredArray(schemaExpr: string): string[] {
  const m = schemaExpr.match(/required:\s*\[([^\]]*)\]/)
  if (!m) return []
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

function extractPropertiesNames(schemaExpr: string): string[] {
  const propsBlock = schemaExpr.match(/properties:\s*\{([\s\S]*?)\}/)
  if (!propsBlock) return []
  return [...propsBlock[1].matchAll(/(\w+):\s*\{/g)].map((x) => x[1])
}

// ─── Mobile extraction ───
interface MobileTool {
  name: string
  description: string
  parameters: { name: string; required: boolean }[]
}

function parseMobileTools(): MobileTool[] {
  const rs = readFileSync(
    resolve(__dirname, '..', '..', '..', 'src-tauri', 'src', 'commands', 'remote.rs'),
    'utf8'
  )
  // Grab the AGENT_TOOLS JS array contents.
  const arrMatch = rs.match(/var AGENT_TOOLS = \[([\s\S]*?)\];/)
  if (!arrMatch) throw new Error('Could not locate mobile AGENT_TOOLS array in remote.rs')
  const body = arrMatch[1]
  // Split into tool object blocks by looking for top-level "{name:" anchors.
  const tools: MobileTool[] = []
  const toolRe = /\{name:'([^']+)',\s*description:'((?:\\.|[^'\\])*)',\s*\n?\s*parameters:\[([^\]]*)\]\}/g
  let m: RegExpExecArray | null
  while ((m = toolRe.exec(body)) !== null) {
    const name = m[1]
    const description = m[2]
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
    const params = parseMobileParams(m[3])
    tools.push({ name, description, parameters: params })
  }
  return tools
}

function parseMobileParams(paramsExpr: string): { name: string; required: boolean }[] {
  const out: { name: string; required: boolean }[] = []
  const paramRe = /\{name:'([^']+)'[^}]*?required:\s*(true|false)[^}]*\}/g
  let m: RegExpExecArray | null
  while ((m = paramRe.exec(paramsExpr)) !== null) {
    out.push({ name: m[1], required: m[2] === 'true' })
  }
  return out
}

const mobileTools = parseMobileTools()

// ─── Tests ───

describe('tool-description-parity — extraction sanity', () => {
  it('parses the desktop BUILTIN_TOOLS list', () => {
    expect(builtinTools.length).toBeGreaterThanOrEqual(13)
  })
  it('parses the mobile AGENT_TOOLS list', () => {
    expect(mobileTools.length).toBeGreaterThanOrEqual(13)
  })
})

// Tools intentionally absent on mobile because their executor relies on
// desktop-only TypeScript code paths. Expanding this set requires wiring
// the Rust /remote-api/agent-tool dispatcher.
//   run_workflow    → needs WorkflowEngine (TS)
//   delegate_task   → needs sub-agent runner with provider access (TS)
const MOBILE_SKIP: ReadonlySet<string> = new Set<string>(['run_workflow', 'delegate_task'])

describe('tool-description-parity — name sets', () => {
  it('desktop and mobile expose the same set of tool names (modulo documented skips)', () => {
    const desktopNames = new Set(builtinTools.map((t) => t.name))
    const mobileNames = new Set(mobileTools.map((t) => t.name))
    const expectedOnMobile = [...desktopNames].filter((n) => !MOBILE_SKIP.has(n))
    const missingFromMobile = expectedOnMobile.filter((n) => !mobileNames.has(n))
    const extraOnMobile = [...mobileNames].filter((n) => !desktopNames.has(n))
    expect(missingFromMobile).toEqual([])
    expect(extraOnMobile).toEqual([])
  })
})

describe('tool-description-parity — description quality', () => {
  const HINT_MARKERS = ['PREFER', 'NEVER', 'DO NOT', 'USE FIRST', 'USE for', 'NOT a', 'NOT for']

  it.each(builtinTools.map((t) => [t.name, t]))(
    'desktop %s has a substantive description',
    (_name, tool) => {
      const desc = (tool as BuiltinTool).description
      // Claude-Code-quality target: 80+ chars.
      expect(desc.length).toBeGreaterThanOrEqual(80)
      // Contains at least one hint marker OR is a zero-arg system tool where
      // "Zero arguments" is itself the hint.
      const hasMarker =
        HINT_MARKERS.some((h) => desc.includes(h)) || /Zero arguments/i.test(desc)
      expect(hasMarker, `expected ${(_name as string)} description to contain a hint marker`).toBe(true)
    }
  )

  it.each(mobileTools.map((t) => [t.name, t]))(
    'mobile %s has a substantive description',
    (_name, tool) => {
      const desc = (tool as MobileTool).description
      expect(desc.length).toBeGreaterThanOrEqual(80)
      const hasMarker =
        HINT_MARKERS.some((h) => desc.includes(h)) || /Zero arguments/i.test(desc)
      expect(hasMarker).toBe(true)
    }
  )
})

describe('tool-description-parity — per-tool parity', () => {
  it('each desktop tool (excluding mobile skips) has a mobile counterpart with matching description', () => {
    const byName = new Map(mobileTools.map((t) => [t.name, t]))
    for (const d of builtinTools) {
      if (MOBILE_SKIP.has(d.name)) continue
      const m = byName.get(d.name)
      expect(m, `mobile AGENT_TOOLS missing ${d.name}`).toBeDefined()
      if (!m) continue
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
      expect(normalize(m.description)).toBe(normalize(d.description))
    }
  })

  it('required parameter names line up desktop ↔ mobile', () => {
    const byName = new Map(mobileTools.map((t) => [t.name, t]))
    for (const d of builtinTools) {
      if (MOBILE_SKIP.has(d.name)) continue
      const m = byName.get(d.name)
      if (!m) continue
      const mobileRequired = m.parameters.filter((p) => p.required).map((p) => p.name).sort()
      const desktopRequired = [...d.inputSchema.required].sort()
      expect(mobileRequired).toEqual(desktopRequired)
    }
  })
})
