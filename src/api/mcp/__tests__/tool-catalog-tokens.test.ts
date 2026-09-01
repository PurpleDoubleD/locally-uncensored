/**
 * A6 prompt diet: what the tool catalog costs on the wire, measured.
 *
 * The 2.6.6 tool merge (e64654cf) reported 2.887 tokens for the coding-mode
 * catalog, measured on the wire against DeepSeek V4 Flash. That number lived
 * only in a commit message, so the next description edit could give it all back
 * without anything going red. This file is the guard.
 *
 * Two halves, on purpose:
 *
 *   OFFLINE (always runs) pins the serialized SIZE of exactly what useCodex
 *   puts into the request: the coding categories, permission-filtered, run
 *   through gateCreateTools with a plain refactor instruction, serialized in
 *   the OpenAI function shape. Characters, not tokens, because a byte count is
 *   the only thing a machine without a model on it can reproduce.
 *
 *   LIVE (LIVE_TOKENS=1) counts real tokens through a real BPE. It posts the
 *   same string to a local Ollama with `raw: true` (no chat template, so
 *   prompt_eval_count is the tokenizer's verdict on our bytes and nothing
 *   else). Default model is qwen2.5:0.5b: the smallest thing on the box that
 *   carries the 151k Qwen vocabulary the cloud coding models use.
 *
 *     LIVE_TOKENS=1 npx vitest run src/api/mcp/__tests__/tool-catalog-tokens.test.ts
 *     LIVE_TOKENS=1 LU_TOKENIZER_MODEL=qwen2.5-coder:7b npx vitest run ...
 *
 * The ceilings below are the measured numbers plus a small margin, so a
 * description that grows back fails here first.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { toolRegistry, DEFAULT_PERMISSIONS } from '../index'
import { gateCreateTools } from '../../../lib/tool-selection'
import { estimateTokens } from '../../../lib/context-compaction'

/** Mirrors CODEX_CATEGORIES in useCodex.ts (same reason as the sibling tests). */
const CODEX_CATEGORIES = ['filesystem', 'terminal', 'system', 'web', 'image', 'video', 'workflow']

/** The instruction a plain coding step carries. No creative cue, no PR, no fan-out. */
const PLAIN_CODING_ASK = 'fix the failing test in parser.ts and run the suite'

const codingCatalog = () =>
  toolRegistry
    .getAvailableTools(DEFAULT_PERMISSIONS)
    .filter((t) => CODEX_CATEGORIES.includes(t.category))

/** Exactly the object useCodex builds for the request (`tools:` on the wire). */
function wireTools(defs: { name: string; description: string; inputSchema: unknown }[]) {
  return defs.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
}

const codingWire = () => JSON.stringify(wireTools(gateCreateTools(codingCatalog(), PLAIN_CODING_ASK)))
const fullWire = () => JSON.stringify(wireTools(codingCatalog()))

/**
 * Measured 2026-08-21 with qwen2.5:0.5b (Qwen 151k vocabulary) through the
 * live half below, on the same tree before and after the A6 diet:
 *
 *   coding step, gated    before 10.585 chars / 2.422 tokens
 *                         after   7.418 chars / 1.664 tokens   (-31,3 %)
 *   whole coding catalog  before 18.851 chars / 4.296 tokens
 *                         after  16.637 chars / 3.745 tokens   (-12,8 %)
 *
 * ~4,4 chars per token on this text, stable across all four measurements, so
 * the char ceilings and the token ceilings move together.
 *
 * The 2.887 in commit e64654cf is NOT this scale: it was read off the wire
 * against DeepSeek V4 Flash, whose vocabulary is not Qwen's. Same tree, same
 * gate, this harness said 2.422 for that build, so the two scales sit about
 * 1,19 apart and the after-number is worth ~1.980 in the old units.
 *
 * The ceilings carry ~4 percent of headroom for a wording fix; a new paragraph
 * blows through them.
 */
const CODING_CHAR_CEILING = 7600
const CODING_TOKEN_CEILING = 1730
const FULL_CHAR_CEILING = 17000
const FULL_TOKEN_CEILING = 3880

describe('the coding step carries a catalog the diet actually shrank', () => {
  it('the gate really is what a plain coding turn gets', () => {
    // A guard on the guard: if the gate stopped removing the create tools the
    // ceilings below would be measuring a different catalog.
    const gated = gateCreateTools(codingCatalog(), PLAIN_CODING_ASK).map((t) => t.name)
    expect(gated).not.toContain('image_generate')
    expect(gated).not.toContain('video_generate')
    expect(gated).not.toContain('run_workflow')
    expect(gated).toContain('shell_execute')
    expect(gated).toContain('file_edit')
    expect(gated).toContain('todo_write')
  })

  it('pr_resume and delegate_task no longer ride along on a refactor', () => {
    const gated = gateCreateTools(codingCatalog(), PLAIN_CODING_ASK).map((t) => t.name)
    expect(gated).not.toContain('pr_resume')
    expect(gated).not.toContain('delegate_task')
  })

  it('the serialized coding catalog stays under its ceiling', () => {
    expect(codingWire().length).toBeLessThanOrEqual(CODING_CHAR_CEILING)
  })

  it('the ungated coding catalog stays under its ceiling too', () => {
    // The creative turn pays this one, and it is where the shared media
    // settings schema shows up.
    expect(fullWire().length).toBeLessThanOrEqual(FULL_CHAR_CEILING)
  })

  it('the catalog the meter now adds is the bigger half of a first step', () => {
    // The token counter adds estimateTokens(JSON.stringify(tools)) on top of
    // the message estimate (useCodex/useAgentChat reportTools). A fresh coding
    // step's messages are ~732 tokens on this scale, so leaving the catalog out
    // showed under a third of the request. Same estimator the meter uses, so
    // this is the correction itself, not a proxy for it.
    const catalog = estimateTokens(codingWire())
    expect(catalog).toBeGreaterThan(1500)
    expect(catalog).toBeLessThanOrEqual(CODING_CHAR_CEILING / 4 + 1)
  })

  it('the mobile catalog went on the same diet, or it drifts from here', () => {
    // The relay re-declares AGENT_TOOLS inline. tool-description-parity pins
    // them word for word; this one names the cut phrases directly, so a revert
    // on either side is a red test with the reason in it.
    const relay = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'src-tauri', 'src', 'commands', 'remote.rs'),
      'utf8',
    )
    const start = relay.indexOf('var AGENT_TOOLS = [')
    expect(start, 'mobile AGENT_TOOLS not found').toBeGreaterThan(-1)
    const agentTools = relay.slice(start, relay.indexOf('];', start))
    expect(agentTools).not.toMatch(/git add -A && git commit/)
    expect(agentTools).not.toMatch(/gh pr create --title/)
    expect(agentTools).not.toMatch(/sideEffectKey/)
    expect(agentTools).not.toMatch(/Exactly one item should be in_progress/)
  })

  it('no tool description carries a paragraph the system prompt already states', () => {
    // The three sentences the diet moved out of the catalog and left to the
    // prompts (useCodex CODEX_SYSTEM_PROMPT, useAgentChat buildAgentSystemPrompt),
    // pinned by their most distinctive words so they cannot creep back.
    const all = toolRegistry.getAll().map((t) => t.description).join('\n')
    expect(all).not.toMatch(/Exactly one item should be in_progress/i)
    expect(all).not.toMatch(/NEVER mark an item completed/i)
    expect(all).not.toMatch(/sideEffectKey/i)
    expect(all).not.toMatch(/git add -A && git commit/i)
    expect(all).not.toMatch(/gh pr create --title/i)
  })
})

// ── the live half ────────────────────────────────────────────────

const LIVE = process.env.LIVE_TOKENS === '1'
const TOKENIZER_MODEL = process.env.LU_TOKENIZER_MODEL || 'qwen2.5:0.5b'
const OLLAMA = process.env.LU_OLLAMA_URL || 'http://127.0.0.1:11434'

/**
 * Token count of `text` from a real tokenizer. `raw: true` skips the chat
 * template, so prompt_eval_count counts our bytes and nothing else; num_predict
 * has to be 1 rather than 0 because Ollama omits the eval counters when it
 * generates nothing at all.
 */
async function countTokens(text: string): Promise<number> {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TOKENIZER_MODEL,
      prompt: text,
      raw: true,
      stream: false,
      options: { num_predict: 1, num_ctx: 32768, temperature: 0 },
    }),
  })
  if (!res.ok) throw new Error(`tokenizer ${TOKENIZER_MODEL} said ${res.status}`)
  const body = (await res.json()) as { prompt_eval_count?: number }
  if (typeof body.prompt_eval_count !== 'number') throw new Error('no prompt_eval_count in response')
  return body.prompt_eval_count
}

describe.runIf(LIVE)('the same catalog through a real tokenizer', () => {
  it('a plain coding step stays under the token ceiling', async () => {
    const wire = codingWire()
    const tokens = await countTokens(wire)
    // Absichtliche Messausgabe (Lauf nur unter LIVE). Kein Unterdruecken
    // noetig: `no-console` ist in eslint.config.js gar nicht eingeschaltet —
    // gemessen 01.09.2026, 38 console-Aufrufe in src/, alle in api/lib/hooks.
    console.log(`coding step: ${wire.length} chars, ${tokens} tokens (${TOKENIZER_MODEL})`)
    expect(tokens).toBeLessThanOrEqual(CODING_TOKEN_CEILING)
  }, 300000)

  it('the ungated coding catalog stays under its token ceiling', async () => {
    const wire = fullWire()
    const tokens = await countTokens(wire)
    // Absichtliche Messausgabe, siehe oben.
    console.log(`full catalog: ${wire.length} chars, ${tokens} tokens (${TOKENIZER_MODEL})`)
    expect(tokens).toBeLessThanOrEqual(FULL_TOKEN_CEILING)
  }, 300000)
})
