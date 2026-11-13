/**
 * Task 215: the environment block has to reach the prompt that actually ships.
 *
 * 2.6.6 gave the coding and agent loops two lines: a platform sentence that
 * says which machine the agent stands on and which shell shell_execute opens,
 * and a clock line that replaced the retired clock tool. Both were proven as
 * functions, and the position of the clock was proven by reading the source.
 * Nobody ever built a prompt and looked inside it. A builder that stops
 * interpolating the line is a silent loss: the prompt still renders, the run
 * still works, and the model quietly goes back to guessing `explorer` on a Mac
 * and spending a step on `uname`.
 *
 * So these tests render. They call the builders that ship and read the string
 * that comes out.
 *
 * The split they check is plan A5. The platform sentence reads the same on
 * every turn and belongs in the stable head, where an upstream prefix cache can
 * match it. The clock changes every minute and belongs at the very end, because
 * a cache matches from byte 0 and stops at the first difference: a timestamp
 * near the top re-prices the whole prompt on every single turn.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildAgentSystemPrompt, buildAgentSystemPromptLean } from '../../hooks/useAgentChat'
import { buildSubAgentSystemPrompt } from '../../api/agents/sub-agent'
import { platformPromptLine, hostClockLine } from '../host-platform'

const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', '..', ...p), 'utf8')

const AT_NOON = new Date('2026-08-21T12:00:00Z')
const TWO_MINUTES_LATER = new Date('2026-08-21T12:02:00Z')

describe('the agent prompt renders the platform sentence', () => {
  it('the full prompt carries it verbatim', () => {
    const built = buildAgentSystemPrompt('', 'file_read, file_write, shell_execute')
    expect(built).toContain(platformPromptLine())
  })

  it('the lean prompt for small models carries it too', () => {
    // The models that need the sentence most are the ones with the least room,
    // so the lean prompt is the last place it may be cut.
    const built = buildAgentSystemPromptLean('', 'file_read, file_write')
    expect(built).toContain(platformPromptLine())
  })

  it('a persona does not push the sentence out', () => {
    const built = buildAgentSystemPrompt('You are a pirate.', 'file_read')
    expect(built).toContain(platformPromptLine())
    expect(built).toContain('You are a pirate.')
  })

  it('the clock is NOT baked into the builder, the loop appends it last', () => {
    // If the clock ever moved in here it would sit ahead of the roster, the
    // persona, the memory block and the retrieval chunks, which is the exact
    // arrangement A5 removed.
    const built = buildAgentSystemPrompt('', 'file_read')
    expect(built).not.toContain('Date and time at the start of this run')
  })

  it('the loop still sends it, in the turn note behind the newest message (A7)', () => {
    const agent = read('hooks', 'useAgentChat.ts')
    expect(agent).toMatch(/clock: hostClockLine\(\)/)
    expect(agent).not.toContain('agentSystemPrompt += `\\n\\n${hostClockLine()}`')
  })
})

describe('the coding loop renders the platform sentence into its head', () => {
  // useCodex builds its prompt across ~250 lines inside the hook, so there is
  // no function to call here. HONEST LIMIT: this half is a source pin, not a
  // render. The render above covers the agent surface, which shares the same
  // helper, so a broken helper is caught either way.
  const codex = read('hooks', 'useCodex.ts')

  it('the platform sentence is interpolated into the stable head', () => {
    expect(codex).toContain('${platformPromptLine()}')
    const platformAt = codex.indexOf('${platformPromptLine()}')
    const clockAt = codex.indexOf('systemPrompt += `\\n\\n${hostClockLine()}`')
    expect(platformAt).toBeGreaterThan(-1)
    expect(clockAt).toBeGreaterThan(platformAt)
  })
})

describe('the sub-agent prompt carries both halves', () => {
  it('the platform sentence is in the built prompt', () => {
    expect(buildSubAgentSystemPrompt()).toContain(platformPromptLine())
  })

  it('the clock line is in the built prompt', () => {
    const built = buildSubAgentSystemPrompt(platformPromptLine('macos'), hostClockLine(AT_NOON))
    expect(built).toContain(hostClockLine(AT_NOON))
    expect(built).toContain('August 2026')
  })

  it('the clock is the last thing the model reads', () => {
    const clock = hostClockLine(AT_NOON)
    const built = buildSubAgentSystemPrompt(platformPromptLine('linux'), clock)
    expect(built.endsWith(clock)).toBe(true)
  })

  it('the platform sentence comes before the clock', () => {
    const platform = platformPromptLine('windows')
    const built = buildSubAgentSystemPrompt(platform, hostClockLine(AT_NOON))
    expect(built.indexOf(platform)).toBeLessThan(built.indexOf('Date and time'))
  })

  it('two delegations two minutes apart share a byte-identical head', () => {
    const platform = platformPromptLine('macos')
    const a = buildSubAgentSystemPrompt(platform, hostClockLine(AT_NOON))
    const b = buildSubAgentSystemPrompt(platform, hostClockLine(TWO_MINUTES_LATER))
    expect(a).not.toBe(b)
    const head = a.slice(0, a.indexOf('Date and time'))
    expect(b.startsWith(head)).toBe(true)
    // The whole of the role text and the platform sentence is in that head,
    // so the only cache miss a new minute costs is the closing line.
    expect(head).toContain('focused sub-agent')
    expect(head).toContain(platform)
  })

  it('the role text a sub-agent had before is still the thing it reads first', () => {
    const built = buildSubAgentSystemPrompt()
    expect(built.startsWith('You are a focused sub-agent.')).toBe(true)
    expect(built).toContain('Do NOT attempt to call delegate_task')
  })

  it('the runner sends the built prompt, not a literal of its own', () => {
    // A second copy of the role text inside defaultSubAgentRunner would render
    // fine and carry neither line, which is exactly the bug this closes.
    const sub = read('api', 'agents', 'sub-agent.ts')
    const runnerAt = sub.indexOf('export async function defaultSubAgentRunner')
    expect(runnerAt).toBeGreaterThan(-1)
    const runner = sub.slice(runnerAt)
    // CA K3: on the prompt transport the tool block follows the same prompt.
    expect(runner).toMatch(/content: promptTransport\s*\?\s*`\$\{buildSubAgentSystemPrompt\(\)\}[^`]*`\s*:\s*buildSubAgentSystemPrompt\(\),/)
    expect(runner).not.toContain("'You are a focused sub-agent.")
  })
})
