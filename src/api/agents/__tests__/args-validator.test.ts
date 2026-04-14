import { describe, it, expect } from 'vitest'
import {
  validateToolArgs,
  formatValidationErrors,
  type JsonSchema,
} from '../args-validator'

const strictStringSchema: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'search' },
    maxResults: { type: 'number', description: 'max' },
  },
  required: ['query'],
}

describe('args-validator — validateToolArgs', () => {
  it('accepts empty schema as advisory (valid)', () => {
    const r = validateToolArgs({ whatever: 1 }, undefined as any)
    expect(r.valid).toBe(true)
  })

  it('accepts valid args', () => {
    const r = validateToolArgs({ query: 'hello', maxResults: 5 }, strictStringSchema)
    expect(r.valid).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('reports missing required property', () => {
    const r = validateToolArgs({ maxResults: 5 }, strictStringSchema)
    expect(r.valid).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].path).toBe('query')
    expect(r.errors[0].message).toMatch(/required/)
  })

  it('reports wrong property type', () => {
    const r = validateToolArgs({ query: 42 }, strictStringSchema)
    expect(r.valid).toBe(false)
    expect(r.errors[0].message).toMatch(/string/)
  })

  it('coerces string "5" → number 5 on number field', () => {
    const r = validateToolArgs({ query: 'x', maxResults: '5' }, strictStringSchema)
    expect(r.valid).toBe(true)
    expect(r.coerced?.maxResults).toBe(5)
  })

  it('does not coerce unparseable string → number', () => {
    const r = validateToolArgs({ query: 'x', maxResults: 'five' }, strictStringSchema)
    expect(r.valid).toBe(false)
  })

  it('coerces "true" / "false" → boolean on boolean field', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { recursive: { type: 'boolean' }, path: { type: 'string' } },
      required: ['path'],
    }
    const r = validateToolArgs({ path: 'x', recursive: 'true' }, schema)
    expect(r.valid).toBe(true)
    expect(r.coerced?.recursive).toBe(true)
  })

  it('enforces enum values', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { language: { type: 'string', enum: ['python', 'shell'] } },
      required: [],
    }
    expect(validateToolArgs({ language: 'python' }, schema).valid).toBe(true)
    const bad = validateToolArgs({ language: 'ruby' }, schema)
    expect(bad.valid).toBe(false)
    expect(bad.errors[0].message).toMatch(/one of/)
  })

  it('validates integer type strictly', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    }
    expect(validateToolArgs({ n: 5 }, schema).valid).toBe(true)
    expect(validateToolArgs({ n: 5.5 }, schema).valid).toBe(false)
    // String "5.5" will not coerce to integer.
    expect(validateToolArgs({ n: '5.5' }, schema).valid).toBe(false)
    // String "7" will coerce to integer.
    const r = validateToolArgs({ n: '7' }, schema)
    expect(r.valid).toBe(true)
    expect(r.coerced?.n).toBe(7)
  })

  it('ignores unknown type keywords (advisory-only)', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { x: { type: 'weird-type' as any } },
      required: [],
    }
    expect(validateToolArgs({ x: 'anything' }, schema).valid).toBe(true)
  })

  it('reports all errors, not just the first', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    }
    const r = validateToolArgs({}, schema)
    expect(r.valid).toBe(false)
    expect(r.errors).toHaveLength(2)
  })

  it('handles null/undefined property values as missing', () => {
    const r = validateToolArgs({ query: null }, strictStringSchema)
    expect(r.valid).toBe(false)
  })

  it('does not fail on extra properties', () => {
    const r = validateToolArgs({ query: 'x', extraKey: 42 }, strictStringSchema)
    expect(r.valid).toBe(true)
  })

  it('validates array items shallowly', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    }
    expect(validateToolArgs({ tags: ['a', 'b'] }, schema).valid).toBe(true)
    const bad = validateToolArgs({ tags: ['a', 5] }, schema)
    expect(bad.valid).toBe(false)
    expect(bad.errors[0].path).toMatch(/tags\[1\]/)
  })

  it('coerces single value → one-element array for array-typed params', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    }
    const r = validateToolArgs({ tags: 'only-one' }, schema)
    expect(r.valid).toBe(true)
    expect(r.coerced?.tags).toEqual(['only-one'])
  })
})

describe('args-validator — formatValidationErrors', () => {
  it('returns empty string for no errors', () => {
    expect(formatValidationErrors([])).toBe('')
  })

  it('joins errors with semicolons', () => {
    const out = formatValidationErrors([
      { path: 'query', message: "required property 'query' is missing" },
      { path: 'maxResults', message: 'expected number' },
    ])
    expect(out).toMatch(/query/)
    expect(out).toMatch(/maxResults/)
    expect(out).toContain(';')
  })

  it('omits empty-path prefix', () => {
    const out = formatValidationErrors([{ path: '', message: 'top-level not object' }])
    expect(out).toBe('top-level not object')
  })
})
