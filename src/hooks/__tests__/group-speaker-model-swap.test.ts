/**
 * 2.6.7 counter-check, nebenbefund 1b: a group chat with two local models
 * showed two names and ran one model. llama-server holds a single model and
 * answers with it whatever the request's `model` field says, and the round
 * never reloaded between speakers.
 *
 * The cure is a real reload per speaker, announced before the wait. There is
 * no render harness for these hooks in this repo, so the loop's contract is
 * guarded at the source the way chat-budget-wiring.test.ts guards A4; the
 * functions it calls are unit tested in
 * src/api/__tests__/builtin-model-guard.test.ts.
 *
 * Run: npx vitest run src/hooks/__tests__/group-speaker-model-swap.test.ts
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { groupCostHintText } from '../../components/chat/GroupCostHint'

const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', ...p), 'utf8')
const chat = read('useChat.ts')
const groupTurn = chat.slice(chat.indexOf('async function runGroupTurn'), chat.indexOf('export function useChat'))
const groupRound = chat.slice(chat.indexOf('const runGroupRound = useCallback'), chat.indexOf('const sendMessage'))

describe('every speaker gets its own model loaded', () => {
  it('asks whether the engine has to be reloaded and then reloads it', () => {
    expect(groupTurn).toMatch(/await builtinReloadNeeded\(model\)/)
    expect(groupTurn).toMatch(/await ensureBuiltinEngineAlive\(model\)/)
  })

  it('does the reload INSIDE the turn, so speaker two is not answered by speaker one', () => {
    // The whole bug was one load for the whole round. A reload hoisted up into
    // runGroupRound would put it straight back.
    expect(groupRound).not.toMatch(/builtinReloadNeeded|ensureBuiltinEngineAlive/)
    // The round still does nothing but hand each model its own turn, and the
    // turn is where the model is loaded.
    expect(groupRound).toMatch(/for \(const model of models\)/)
    expect(groupRound).toMatch(/await runGroupTurn\(convId, model, models, abort\)/)
  })

  it('reloads BEFORE the provider call, not after', () => {
    expect(groupTurn.indexOf('ensureBuiltinEngineAlive')).toBeLessThan(groupTurn.indexOf('getProviderForModel(model)'))
  })

  it('says what it is waiting for and clears the line again', () => {
    expect(groupTurn).toMatch(/Loading \$\{toLoad\} into the built-in engine for this turn/)
    // The announcement is written before the wait, and taken back after it, so
    // a turn that answers normally shows no leftover status line.
    const hint = groupTurn.indexOf('Loading ${toLoad}')
    const wait = groupTurn.indexOf('await ensureBuiltinEngineAlive')
    expect(hint).toBeLessThan(wait)
    expect(groupTurn.slice(wait)).toMatch(/updateMessageContent\(convId, assistantMessage\.id, ''\)/)
  })

  it('honours Stop while the engine is loading', () => {
    const wait = groupTurn.indexOf('await ensureBuiltinEngineAlive')
    expect(groupTurn.slice(wait)).toMatch(/if \(abort\.signal\.aborted\) return/)
  })

  // Negative control: a cloud or Ollama speaker has nothing to do with our
  // engine, and swapping it under them would be a bug of its own.
  it('only touches the turn of a speaker in the built-in slot', () => {
    expect(groupTurn).toMatch(/if \(providerId === 'openai'\) \{/)
  })

  // Negative control: this is speaker control, not history. The message
  // sequence and the history transformation belong to group-chat.ts.
  it('does not rewrite the history on its way past', () => {
    const block = groupTurn.slice(
      groupTurn.indexOf("if (providerId === 'openai') {"),
      groupTurn.indexOf('const { provider, modelId }'),
    )
    expect(block).not.toMatch(/messages|groupHistory|groupSystemPrompt/)
  })
})

describe('the composer hint tells the truth about local line-ups', () => {
  it('names the reload when two or more speakers share the engine', () => {
    expect(groupCostHintText(2, 2)).toBe(
      '1 round = 2 answers = 2x the cost, and the built-in engine reloads between local speakers',
    )
  })

  // Negative controls: one local speaker reloads nothing, and a line-up of
  // cloud models is unaffected, so neither may grow the sentence.
  it('stays the plain cost line otherwise', () => {
    expect(groupCostHintText(2, 1)).toBe('1 round = 2 answers = 2x the cost')
    expect(groupCostHintText(3, 0)).toBe('1 round = 3 answers = 3x the cost')
    expect(groupCostHintText(4)).toBe('1 round = 4 answers = 4x the cost')
  })

  it('counts only the app-managed engine, never a LAN server in the same slot', () => {
    const source = readFileSync(resolve(__dirname, '..', '..', 'components', 'chat', 'GroupCostHint.tsx'), 'utf8')
    expect(source).toMatch(/managed === true/)
    expect(source).toMatch(/m\.startsWith\('openai::'\)/)
  })
})
