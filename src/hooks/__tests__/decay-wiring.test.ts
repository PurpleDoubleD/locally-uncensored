/**
 * A1/A2/A3 wiring: the two agent loops actually use the builder, in the
 * binding order, and on a COPY.
 *
 * There is no render harness for these hooks in this repo, so the contract is
 * guarded at the source the way host-platform.test.ts guards the prompt. These
 * are the properties that a well-meaning refactor would silently undo, and each
 * one has a price attached: decaying the working array would put shortened
 * results into the store and into the next session; running the budget before
 * the decay would drop whole messages the decay would have made fit; sending
 * `messages` instead of `sendMessages` would keep paying full price while every
 * unit test still passed.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8')
const codex = read('useCodex.ts')
const agent = read('useAgentChat.ts')

describe.each([
  ['useCodex', codex, 'messages', 'sendMessages'],
  ['useAgentChat', agent, 'agentMessages', 'sendMessages'],
])('%s builds the request instead of trimming the history', (_name, source, working, send) => {
  it('calls the request builder', () => {
    expect(source).toMatch(/buildRequestMessages\(/)
  })

  it('no longer calls compactMessages behind the back of the builder', () => {
    expect(source).not.toMatch(/compactMessages\(/)
  })

  it('never assigns the built request back onto the working history', () => {
    // This is the line that would push decayed results into the store.
    expect(source).not.toMatch(new RegExp(`${working}\\s*=\\s*buildRequestMessages`))
    expect(source).not.toMatch(new RegExp(`${working}\\s*=\\s*built\\.messages`))
  })

  it('derives the budget from the effective send window', () => {
    expect(source).toMatch(/effectiveSendWindow\(\{/)
    expect(source).toMatch(/sendWindowTokens: sendWindowFor\(settings, \w+\)/)
    expect(source).toMatch(/capEnabled: decayOn/)
  })

  it('honours the contextDecay notaus', () => {
    expect(source).toMatch(/const decayOn = settings\.contextDecay !== false/)
    expect(source).toMatch(/enabled: decayOn/)
    expect(source).toMatch(/hysteresis: decayOn/)
  })

  it('reports the built size for the token counter', () => {
    expect(source).toMatch(/useSendSizeStore\.getState\(\)\.report\(/)
    expect(source).toMatch(/tokens: built\.promptTokens/)
  })

  it('reports the tool catalog too, or the meter reads low by all of it', () => {
    // The catalog is its own field on the wire, so the message estimate above
    // cannot see it. It is picked after the build, which is why it arrives as
    // a second call instead of riding in the report.
    // useCodex measures it once into a variable since GH #140: its
    // context-overflow retry reads the same number to size the cut.
    const direct = /reportTools\(convId, estimateTokens\(JSON\.stringify\(tools\)\)\)/.test(source)
    const viaVariable = /stepToolsEstimate = estimateTokens\(JSON\.stringify\(tools\)\)/.test(source)
      && /reportTools\(convId, stepToolsEstimate\)/.test(source)
    expect(direct || viaVariable).toBe(true)
  })

  it('leaves a decay row in the tool audit so support can see it', () => {
    expect(source).toMatch(/toolName: 'context_decay'/)
    expect(source).toMatch(/savedChars: built\.savedChars/)
  })

  it('tells the loop guard which reads went out capped', () => {
    expect(source).toMatch(/\{ trimmedReadKeys \}/)
    expect(source).toMatch(/guardKeyOfResult\.set\(/)
    expect(source).toMatch(/keyOf: \(m\) => guardKeyOfResult\.get\(/)
  })

  it('surfaces loop-guard steers and halts as notes in the thread', () => {
    expect(source).toMatch(/Loop guard halted the run/)
    expect(source).toMatch(/Loop guard steered the model/)
  })

  it('sends the built copy, not the working history', () => {
    expect(source).toMatch(new RegExp(`streamProviderTurn\\(provider, modelToUse, ${send}`))
  })
})

describe('useCodex keeps the working history whole for the store', () => {
  it('still persists the hidden tool chain, by identity across trims', () => {
    // 30.09.2026: an index into `messages` pointed at the wrong place once a
    // long run had been trimmed, and the chain lost its ledger.
    expect(codex).toMatch(/const toolHistoryAll = runLog/)
    expect(codex).toMatch(/logRun\(\)\s*\n\s*const beforeTrim = new Set\(messages\)/)
  })

  it('shortens restored tool messages of PREVIOUS turns', () => {
    expect(codex).toMatch(/decayRestoredToolResult\(msg\.content\)/)
    expect(codex).toMatch(/decayRestored && m\.hidden && isToolResult\(msg\)/)
  })

  it('leaves the restore alone when the notaus is off', () => {
    expect(codex).toMatch(/const decayRestored = settings\.contextDecay !== false/)
  })
})

describe('the builder runs before the model call, every step', () => {
  it('useCodex builds inside the iteration loop, ahead of the transports', () => {
    const buildAt = codex.indexOf('const built = buildRequestMessages(stepWindow, {')
    const nativeAt = codex.indexOf("if (strategy === 'native') {")
    expect(buildAt).toBeGreaterThan(-1)
    expect(buildAt).toBeLessThan(nativeAt)
  })

  it('useAgentChat builds ahead of its transports too', () => {
    const buildAt = agent.indexOf('const built = buildRequestMessages(stepWindow, {')
    const nativeAt = agent.indexOf("if (strategy === 'native') {")
    expect(buildAt).toBeGreaterThan(-1)
    expect(buildAt).toBeLessThan(nativeAt)
  })
})

describe('the prompt-transport path does not count its catalog twice', () => {
  it('useCodex zeroes the catalog where the tools become a message', () => {
    // buildHermesToolPrompt writes the catalog INTO messages[0], on the working
    // array as well, so from the next step on the message estimate carries it.
    const promptAt = codex.indexOf('const hermesSystem = buildHermesToolPrompt(')
    const zeroAt = codex.indexOf('reportTools(convId, 0)')
    expect(promptAt).toBeGreaterThan(-1)
    expect(zeroAt).toBeGreaterThan(promptAt)
  })

  it('useAgentChat builds its hermes prompt into the system message up front', () => {
    // Same reason, different shape: there it is already in the first system
    // message, so that loop never reports a catalog at all.
    expect(agent).toMatch(/buildHermesToolPrompt\(hermesToolDefs\)/)
  })
})
