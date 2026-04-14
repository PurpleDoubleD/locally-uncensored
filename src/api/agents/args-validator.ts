/**
 * Phase 4 (v2.4.0) — Hand-rolled JSON-Schema validator for tool arguments.
 *
 * Complements (does NOT replace) src/lib/tool-call-repair.ts:
 *   1. repairToolCallArgs() runs first on raw string args from the provider.
 *   2. validateToolArgs() runs after repair, comparing against the tool's
 *      inputSchema.
 *   3. If invalid, the executor feeds a structured error back to the model
 *      ("Field 'query' is required but was missing. Please retry.") rather
 *      than silently running with bad data.
 *
 * Deliberately minimal — no ajv or @hyperjump/json-schema dependency. The
 * tool schemas we ship are a small subset of JSON Schema:
 *   - types: string, number, integer, boolean, array, object, null
 *   - required: string[]
 *   - properties: Record<string, Schema>
 *   - enum: unknown[]
 *   - items: Schema (array element type)
 *   - additionalProperties: ignored (we never fail on extras)
 *
 * Unknown keywords are treated as advisory and skipped, which matches the
 * behaviour of most loose validators and keeps the LLM from getting
 * bogged down by schema keywords it cannot reason about.
 */

export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  /** Unused / advisory; retained so test fixtures can include them. */
  description?: string
  /** Allow pass-through for unknown keys. */
  [key: string]: any
}

export type ValidationError = {
  path: string
  message: string
}

export type ValidationResult = {
  valid: boolean
  errors: ValidationError[]
  /** Coerced args — typed-string → number when schema calls for it. */
  coerced?: Record<string, any>
}

/**
 * Validate tool args against an inputSchema. Returns a shallow-coerced copy
 * (string → number/boolean where schema asks for it) so small-model
 * mistakes like `{"maxResults": "5"}` do not fail downstream calls.
 */
export function validateToolArgs(
  args: Record<string, any>,
  schema: JsonSchema | undefined
): ValidationResult {
  const errors: ValidationError[] = []
  if (!schema || typeof schema !== 'object') {
    return { valid: true, errors: [], coerced: args }
  }

  // Top-level must be an object schema for tool args. If the schema declares a
  // different type, fall back to advisory-only validation.
  if (schema.type && !matchesType(args, schema.type)) {
    errors.push({ path: '', message: `expected ${describeType(schema.type)} at top level` })
    return { valid: false, errors }
  }

  const coerced: Record<string, any> = { ...(args ?? {}) }

  // Required presence.
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (coerced[key] === undefined || coerced[key] === null) {
        errors.push({ path: key, message: `required property '${key}' is missing` })
      }
    }
  }

  // Per-property type / enum / array items.
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in coerced)) continue
      const value = coerced[key]
      const { errors: propErrors, coerced: coercedValue } = validatePropertyValue(
        key,
        value,
        propSchema
      )
      errors.push(...propErrors)
      if (propErrors.length === 0) coerced[key] = coercedValue
    }
  }

  return { valid: errors.length === 0, errors, coerced }
}

/**
 * Render validation errors into a short, model-friendly string suitable
 * for feeding back into the next ReAct turn.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return ''
  return errors
    .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
    .join('; ')
}

// ─── Internals ───

function validatePropertyValue(
  path: string,
  value: any,
  schema: JsonSchema
): { errors: ValidationError[]; coerced: any } {
  const errors: ValidationError[] = []
  let coerced = value

  // Enum check first — if it matches an enum value, skip the type check.
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((v) => deepEqual(v, value))) {
      errors.push({
        path,
        message: `value must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      })
    }
  }

  if (schema.type) {
    if (!matchesType(value, schema.type)) {
      // Try safe coercion: "5" → 5 for number/integer, "true"/"false" → bool.
      const attempt = tryCoerce(value, schema.type)
      if (attempt.ok) {
        coerced = attempt.value
      } else {
        errors.push({
          path,
          message: `expected ${describeType(schema.type)}, got ${describeActual(value)}`,
        })
      }
    }
  }

  // Array item validation (shallow).
  if (matchesType(coerced, 'array') && schema.items && Array.isArray(coerced)) {
    const itemErrs: ValidationError[] = []
    coerced.forEach((item, i) => {
      const r = validatePropertyValue(`${path}[${i}]`, item, schema.items as JsonSchema)
      itemErrs.push(...r.errors)
    })
    errors.push(...itemErrs)
  }

  return { errors, coerced }
}

function matchesType(value: any, type: string | string[]): boolean {
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t))
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'null':
      return value === null
    default:
      // Unknown type keyword — don't fail on it.
      return true
  }
}

function describeType(type: string | string[]): string {
  return Array.isArray(type) ? type.join(' | ') : type
}

function describeActual(value: any): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function tryCoerce(
  value: any,
  type: string | string[]
): { ok: true; value: any } | { ok: false } {
  if (Array.isArray(type)) {
    for (const t of type) {
      const r = tryCoerce(value, t)
      if (r.ok) return r
    }
    return { ok: false }
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value === 'string') {
      const n = Number(value.trim())
      if (!Number.isNaN(n) && Number.isFinite(n)) {
        if (type === 'integer' && !Number.isInteger(n)) return { ok: false }
        return { ok: true, value: n }
      }
    }
    return { ok: false }
  }
  if (type === 'boolean') {
    if (value === 'true') return { ok: true, value: true }
    if (value === 'false') return { ok: true, value: false }
    return { ok: false }
  }
  if (type === 'string') {
    // Deliberately NOT coercing numbers/booleans → strings. A string-typed
    // param receiving a number is almost always a model mistake we want the
    // retry loop to surface, not silently hide by stringifying.
    return { ok: false }
  }
  if (type === 'array') {
    // Allow single value → one-element array for array-typed params.
    if (value !== undefined && value !== null) return { ok: true, value: [value] }
    return { ok: false }
  }
  return { ok: false }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    for (const k of aKeys) {
      if (!deepEqual((a as any)[k], (b as any)[k])) return false
    }
    return true
  }
  return false
}
