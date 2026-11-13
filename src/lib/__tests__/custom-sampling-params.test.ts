/**
 * GH #198: custom sampling parameters as rows of key, type and value, on a
 * persona and on a chat. The chat's row wins over the persona's by key, a
 * key LU sets with its own field is never taken from a row, and in a group
 * every member brings its own persona's rows.
 *
 * Run: npx vitest run src/lib/__tests__/custom-sampling-params.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  cleanCustomParams, customParamProblem, mergeCustomParams, parseCustomParam, resolveCustomParams,
  type CustomParam,
} from '../custom-params'
import { speakerSamplingOptions } from '../chat-persona'
import { speakerSamplingLines } from '../speaker-sampling-lines'
import type { Persona } from '../../types/settings'

const row = (key: string, type: CustomParam['type'], value: string): CustomParam => ({ key, type, value })

/** The examples of the issue, typed as a person would. */
const ISSUE: CustomParam[] = [
  row('dry_base', 'number', '1.75'),
  row('dry_allowed_length', 'number', '4'),
  row('dry_penalty_last_n', 'number', '-1'),
  row('dry_sequence_breakers', 'json', '["\\n", ":", "\\"", "*"]'),
  row('xtc_threshold', 'number', '0.1'),
  row('xtc_probability', 'number', '0.5'),
  row('banned_strings', 'json', '["ministrations", "shivers down"]'),
  row('logit_bias', 'json', '{"128": -100}'),
]

describe('one row', () => {
  it('parses by type', () => {
    expect(parseCustomParam(row('a', 'number', ' 1.75 '))).toEqual({ ok: true, value: 1.75 })
    expect(parseCustomParam(row('a', 'boolean', 'false'))).toEqual({ ok: true, value: false })
    expect(parseCustomParam(row('a', 'string', ' keep spaces '))).toEqual({ ok: true, value: ' keep spaces ' })
    expect(parseCustomParam(row('a', 'json', '{"128": -100}'))).toEqual({ ok: true, value: { '128': -100 } })
  })

  it('says why a row cannot go', () => {
    expect(customParamProblem(row('', 'number', '1'))).toMatch(/name/)
    expect(customParamProblem(row('a b', 'number', '1'))).toMatch(/Letters/)
    expect(customParamProblem(row('x', 'number', 'abc'))).toMatch(/number/)
    expect(customParamProblem(row('x', 'boolean', 'yes'))).toMatch(/true or false/)
    expect(customParamProblem(row('x', 'json', '[1,'))).toMatch(/JSON/)
    for (const fixed of ['temperature', 'top_p', 'max_tokens', 'min_p', 'num_ctx', 'num_predict', 'messages', 'model', 'stream']) {
      expect(customParamProblem(row(fixed, 'number', '1')), fixed).toMatch(/own field/)
    }
    for (const r of ISSUE) expect(customParamProblem(r), r.key).toBeUndefined()
  })
})

describe('the rows in force', () => {
  it('every example of the issue goes out with its typed value', () => {
    expect(resolveCustomParams(ISSUE)).toEqual({
      dry_base: 1.75,
      dry_allowed_length: 4,
      dry_penalty_last_n: -1,
      dry_sequence_breakers: ['\n', ':', '"', '*'],
      xtc_threshold: 0.1,
      xtc_probability: 0.5,
      banned_strings: ['ministrations', 'shivers down'],
      logit_bias: { '128': -100 },
    })
  })

  it('the chat row wins over the persona row with the same key; the rest of both stays', () => {
    const merged = mergeCustomParams([row('dry_base', 'number', '2')], [row('dry_base', 'number', '1.75'), row('xtc_threshold', 'number', '0.1')])
    expect(resolveCustomParams(merged)).toEqual({ dry_base: 2, xtc_threshold: 0.1 })
  })

  it('a broken or fixed row is left out, the others go', () => {
    expect(resolveCustomParams([row('temperature', 'number', '2'), row('x', 'json', '{'), row('ok', 'number', '1')])).toEqual({ ok: 1 })
  })

  it('a stored list is cleaned: wrong shapes dropped, at most 32 rows', () => {
    const many = Array.from({ length: 40 }, (_, i) => row(`k${i}`, 'number', '1'))
    expect(cleanCustomParams([...many, { key: 1 }, null])).toHaveLength(32)
    expect(cleanCustomParams([{ key: 'a', type: 'float', value: '1' }])).toEqual([])
    expect(cleanCustomParams('nope')).toEqual([])
  })
})

const P = (id: string, name: string, customParams?: CustomParam[]): Persona => ({
  id, name, icon: 'User', systemPrompt: `You are ${name}.`, isBuiltIn: false, ...(customParams ? { customParams } : {}),
})
const SETTINGS = { temperature: 0.7, topP: 0.9, maxTokens: 0, topK: 40, personasEnabled: true }

describe('per speaker (chat > persona > nothing)', () => {
  const baron = P('baron', 'Baron', [row('dry_base', 'number', '1.75'), row('xtc_threshold', 'number', '0.1')])
  const walt = P('walt', 'Walt', [row('logit_bias', 'json', '{"128": -100}')])

  it('a plain chat with the persona on gets its rows, the chat row on top', () => {
    const conv = { personaId: 'baron', personaEnabled: true, customParams: [row('dry_base', 'number', '2')] }
    const opts = speakerSamplingOptions(SETTINGS, conv, 'ollama::m', [baron], undefined, true)
    expect(opts.customParams).toEqual({ dry_base: 2, xtc_threshold: 0.1 })
  })

  it('a persona switched off for the chat brings no rows; the chat\'s own still go', () => {
    const conv = { personaId: 'baron', personaEnabled: false, customParams: [row('foo', 'string', 'bar')] }
    expect(speakerSamplingOptions(SETTINGS, conv, 'ollama::m', [baron], undefined, true).customParams).toEqual({ foo: 'bar' })
    expect(speakerSamplingOptions(SETTINGS, { personaId: 'baron', personaEnabled: false }, 'ollama::m', [baron], undefined, true).customParams).toBeUndefined()
  })

  it('in a group each member brings its own persona\'s rows', () => {
    const conv = { groupModels: ['ollama::a', 'ollama::b'], groupPersonas: { 'ollama::a': 'baron', 'ollama::b': 'walt' } }
    expect(speakerSamplingOptions(SETTINGS, conv, 'ollama::a', [baron, walt], undefined, true).customParams).toEqual({ dry_base: 1.75, xtc_threshold: 0.1 })
    expect(speakerSamplingOptions(SETTINGS, conv, 'ollama::b', [baron, walt], undefined, true).customParams).toEqual({ logit_bias: { '128': -100 } })
  })

  it('the popup lines list the rows each member runs on, and mark them not sent on LU Cloud', () => {
    const conv = { groupModels: ['ollama::a', 'lu-cloud::c'], groupPersonas: { 'ollama::a': 'baron', 'lu-cloud::c': 'walt' } }
    const lines = speakerSamplingLines({ settings: SETTINGS, conv, activeModel: null, personas: [baron, walt], activePersonaId: undefined, providers: {} })
    const a = lines.find((l) => l.model === 'ollama::a')!
    const c = lines.find((l) => l.model === 'lu-cloud::c')!
    expect(a.values).toContainEqual({ label: 'dry_base', text: '1.75', sent: true })
    expect(c.values).toContainEqual({ label: 'logit_bias', text: '{"128": -100}', sent: false })
  })
})
