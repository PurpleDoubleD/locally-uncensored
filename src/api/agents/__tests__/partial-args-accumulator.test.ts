import { describe, it, expect } from 'vitest'
import {
  parsePartialJson,
  PartialArgsAccumulator,
  __internal,
} from '../partial-args-accumulator'

describe('partial-args-accumulator — parsePartialJson', () => {
  it('empty buffer → complete=false, partial={}', () => {
    const r = parsePartialJson('')
    expect(r.complete).toBe(false)
    expect(r.partial).toEqual({})
  })

  it('whitespace-only buffer → partial={}', () => {
    expect(parsePartialJson('   \n').partial).toEqual({})
  })

  it('complete valid JSON → complete=true + parsed object', () => {
    const r = parsePartialJson('{"a":1,"b":"x"}')
    expect(r.complete).toBe(true)
    expect(r.partial).toEqual({ a: 1, b: 'x' })
  })

  it('missing closing brace → partial object', () => {
    const r = parsePartialJson('{"a":1,"b":"x"')
    expect(r.complete).toBe(false)
    expect(r.partial).toEqual({ a: 1, b: 'x' })
  })

  it('missing closing bracket in value array → partial with array closed', () => {
    const r = parsePartialJson('{"items":[1,2,3')
    expect(r.complete).toBe(false)
    expect(r.partial).toEqual({ items: [1, 2, 3] })
  })

  it('open string literal mid-value → close the string + partial', () => {
    const r = parsePartialJson('{"q":"hello wor')
    expect(r.complete).toBe(false)
    expect(r.partial.q).toMatch(/^hello wor/)
  })

  it('trailing comma after last value → stripped, partial still returned', () => {
    const r = parsePartialJson('{"a":1,')
    expect(r.complete).toBe(false)
    expect(r.partial).toEqual({ a: 1 })
  })

  it('nested objects partially streamed', () => {
    const r = parsePartialJson('{"outer":{"inner":42')
    expect(r.partial).toEqual({ outer: { inner: 42 } })
  })

  it('broken input that cannot be closed → partial={}', () => {
    const r = parsePartialJson('{"a":@#@invalid')
    expect(r.partial).toEqual({})
  })

  it('array at top level → treated as non-object (returns {})', () => {
    const r = parsePartialJson('[1,2,3]')
    expect(r.partial).toEqual({})
    expect(r.complete).toBe(false)
  })

  it('escaped quotes inside string survive closure', () => {
    // Raw stream: `{"msg":"she said \"hi\"` — the two \" pairs are both
    // escaped, so the string value ends up as `she said "hi"`. Closure
    // appends a `"` + `}` to finalize the JSON.
    const r = parsePartialJson('{"msg":"she said \\"hi\\"')
    expect(r.partial.msg).toBe('she said "hi"')
  })
})

describe('partial-args-accumulator — PartialArgsAccumulator', () => {
  it('appends chunks and reflects them in snapshot', () => {
    const acc = new PartialArgsAccumulator()
    expect(acc.length()).toBe(0)
    acc.push('{"q":"')
    acc.push('hel')
    acc.push('lo"}')
    expect(acc.length()).toBeGreaterThan(0)
    const snap = acc.snapshot()
    expect(snap.complete).toBe(true)
    expect(snap.partial).toEqual({ q: 'hello' })
  })

  it('set() overwrites the buffer', () => {
    const acc = new PartialArgsAccumulator()
    acc.push('{"a":1}')
    acc.set('{"b":2}')
    const snap = acc.snapshot()
    expect(snap.partial).toEqual({ b: 2 })
  })

  it('reset() clears buffer', () => {
    const acc = new PartialArgsAccumulator()
    acc.push('{"a":1}')
    acc.reset()
    expect(acc.length()).toBe(0)
    expect(acc.snapshot().partial).toEqual({})
  })

  it('empty chunk push is a no-op', () => {
    const acc = new PartialArgsAccumulator()
    acc.push('')
    acc.push('{"a":1}')
    expect(acc.length()).toBe(7)
  })
})

describe('partial-args-accumulator — closeOpenStructures (internal)', () => {
  it('closes open strings', () => {
    expect(__internal.closeOpenStructures('{"q":"abc')).toBe('{"q":"abc"}')
  })
  it('closes nested objects + strings', () => {
    expect(__internal.closeOpenStructures('{"a":{"b":"c')).toBe('{"a":{"b":"c"}}')
  })
  it('closes arrays', () => {
    expect(__internal.closeOpenStructures('{"xs":[1,2')).toBe('{"xs":[1,2]}')
  })
  it('strips trailing comma before closing', () => {
    expect(__internal.closeOpenStructures('{"a":1,')).toBe('{"a":1}')
  })
  it('handles escaped backslash before quote correctly', () => {
    expect(__internal.closeOpenStructures('{"p":"C:\\\\x')).toBe('{"p":"C:\\\\x"}')
  })
})
