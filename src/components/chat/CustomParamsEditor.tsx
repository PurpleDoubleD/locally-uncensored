import { Plus, X } from 'lucide-react'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import {
  CUSTOM_PARAM_TYPES, MAX_CUSTOM_PARAMS, customParamProblem,
  type CustomParam, type CustomParamType,
} from '../../lib/custom-params'

/** Accessible name of the list, shared with its tests. */
export const CUSTOM_PARAMS_LABEL = 'Custom parameters'

/** Where the rows go, said once under the list. */
export const CUSTOM_PARAMS_HINT =
  'Sent as typed: top level for OpenAI compatible servers, inside "options" for Ollama. '
  + 'Not sent to Anthropic or LU Cloud.'

const PLACEHOLDER: Record<CustomParamType, string> = {
  string: 'text',
  number: '1.75',
  boolean: 'true',
  json: '["\\n", ":", "\\"", "*"]',
}

/**
 * GH #198: the rows of custom sampling parameters, key, type and value, in
 * the persona editor and in the chat's Sampling popup. Narrow on purpose: the
 * popup is 248 px wide, so the value has a line of its own.
 */
export function CustomParamsEditor({
  rows,
  onChange,
  inherited,
  testId = 'custom-params',
}: {
  rows: readonly CustomParam[]
  onChange: (rows: CustomParam[]) => void
  /** Keys that come from somewhere below (the persona), shown as a line. */
  inherited?: { source: string; rows: readonly CustomParam[] }
  testId?: string
}) {
  const update = (i: number, patch: Partial<CustomParam>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  const add = () => onChange([...rows, { key: '', type: 'number', value: '' }])
  const own = new Set(rows.map((r) => r.key.trim()))
  // Only the persona rows that really go out: a broken or fixed one is not "from" anywhere.
  const below = (inherited?.rows ?? []).filter((r) => !customParamProblem(r) && !own.has(r.key.trim()))

  return (
    <div role="group" aria-label={CUSTOM_PARAMS_LABEL} data-testid={testId} className="space-y-1.5">
      {rows.map((row, i) => {
        const problem = customParamProblem(row)
        return (
          <div key={i} data-testid="custom-param-row" className="space-y-0.5">
            <div className="flex items-center gap-1">
              <input
                value={row.key}
                onChange={(e) => update(i, { key: e.target.value })}
                placeholder="dry_base"
                aria-label="Parameter name"
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-gray-700 bg-transparent px-1 py-0.5 font-mono"
              />
              <select
                value={row.type}
                onChange={(e) => update(i, { type: e.target.value as CustomParamType })}
                aria-label="Parameter type"
                className="w-[4.5rem] shrink-0 rounded border border-gray-700 bg-transparent px-0.5 py-0.5"
              >
                {CUSTOM_PARAM_TYPES.map((t) => (
                  <option key={t} value={t}>{t === 'json' ? 'JSON' : t}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove ${row.key.trim() || 'parameter'}`}
                className="shrink-0 rounded p-0.5 text-gray-500 hover:text-gray-300"
              >
                <X size={11} />
              </button>
            </div>
            {row.type === 'boolean' ? (
              <select
                value={row.value === 'false' ? 'false' : row.value === 'true' ? 'true' : ''}
                onChange={(e) => update(i, { value: e.target.value })}
                aria-label="Parameter value"
                className="w-full rounded border border-gray-700 bg-transparent px-0.5 py-0.5"
              >
                <option value="" disabled>choose</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                value={row.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder={PLACEHOLDER[row.type]}
                aria-label="Parameter value"
                spellCheck={false}
                inputMode={row.type === 'number' ? 'decimal' : undefined}
                className="w-full rounded border border-gray-700 bg-transparent px-1 py-0.5 font-mono"
              />
            )}
            {problem && (
              <p className={HINWEIS_TEXT.fehler} data-testid="custom-param-problem">{problem} Not sent.</p>
            )}
          </div>
        )
      })}
      {below.length > 0 && inherited && (
        <p className="text-gray-500 break-words" data-testid="custom-params-inherited">
          From {inherited.source}: {below.map((r) => r.key.trim()).join(', ')}
        </p>
      )}
      <button
        type="button"
        onClick={add}
        disabled={rows.length >= MAX_CUSTOM_PARAMS}
        data-testid="custom-param-add"
        className="flex items-center gap-1 text-gray-400 hover:text-gray-200 disabled:opacity-40"
      >
        <Plus size={11} /> Add parameter
      </button>
      <p className="text-gray-500">{CUSTOM_PARAMS_HINT}</p>
    </div>
  )
}
