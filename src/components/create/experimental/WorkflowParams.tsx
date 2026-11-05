// Every value of an imported ComfyUI workflow, editable in Create (GitHub
// wish #8). The list itself comes from api/workflow-params.ts; this file only
// draws it, keeps the search and the open nodes, and writes the user's values
// into workflowStore.paramOverrides, which useCreate hands to the run.
//
// Built-in LU workflows never come here: this list is only drawn for a
// workflow from the workflow manager (installedWorkflows).

import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import type { ModelType } from '../../../api/comfyui'
import type { ComfyApiGraph } from '../../../types/comfy-graph'
import type { WorkflowTemplate } from '../../../types/workflows'
import type { ComfyNodeDefs } from '../../../api/comfy-ui-format'
import { loadNodeDefs } from '../../../api/workflow-import'
import {
  listWorkflowParams, workflowNodeTypes,
  type ParamValue, type WorkflowParamField, type WorkflowParamNode, type WorkflowRunPath,
} from '../../../api/workflow-params'
import { workflowOptionText } from '../../../lib/sampler-names'
import { useWorkflowStore } from '../../../stores/workflowStore'
import { baseFieldClass, label } from './SchemaControl'
import { cn } from '../ui/cn'

// ── Node definitions, once per set of node types while the app runs ──

const defsCache = new Map<string, ComfyNodeDefs>()

/** Test seam: the cache is module state. */
export function __clearWorkflowParamDefsForTests(): void {
  defsCache.clear()
}

/** `undefined` while loading, `null` when ComfyUI did not answer. */
function useNodeDefs(graph: ComfyApiGraph): ComfyNodeDefs | null | undefined {
  const types = useMemo(() => workflowNodeTypes(graph).sort(), [graph])
  const key = types.join('\n')
  const [answer, setAnswer] = useState<{ key: string; defs: ComfyNodeDefs | null } | null>(null)
  const cached = defsCache.get(key)

  useEffect(() => {
    if (defsCache.has(key)) return
    let alive = true
    void loadNodeDefs(types).then((defs) => {
      if (defs) defsCache.set(key, defs)
      if (alive) setAnswer({ key, defs })
    })
    return () => { alive = false }
  }, [key, types])

  if (cached) return cached
  return answer?.key === key ? answer.defs : undefined
}

// ── Search ──

function fieldMatches(field: WorkflowParamField, q: string): boolean {
  return field.inputKey.toLowerCase().includes(q) || label(field.inputKey).toLowerCase().includes(q)
}

/** The nodes and fields a search leaves; a node whose name matches keeps all. */
function filterNodes(nodes: WorkflowParamNode[], query: string): WorkflowParamNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const out: WorkflowParamNode[] = []
  for (const node of nodes) {
    if (node.title.toLowerCase().includes(q) || node.classType.toLowerCase().includes(q)) {
      out.push(node)
      continue
    }
    const fields = node.fields.filter((f) => fieldMatches(f, q))
    const setByLu = node.setByLu.filter((n) => n.toLowerCase().includes(q))
    if (fields.length > 0 || setByLu.length > 0) out.push({ ...node, fields, setByLu })
  }
  return out
}

// ── One field ──

function NumberInput({ field, value, onChange, id }: {
  field: WorkflowParamField & { control: { kind: 'number' } }
  value: number
  onChange: (v: number | undefined) => void
  id: string
}) {
  // A draft while typing, so "0." or an empty field does not snap back. It
  // remembers the value it belongs to: once the value changes from outside
  // (Reset), the draft is stale and the value shows again.
  const [draft, setDraft] = useState<{ text: string; base: number } | null>(null)
  const { min, max, integer, step } = field.control
  const fits = (n: number) => Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)
    && (!integer || Number.isInteger(n))
  return (
    <input
      id={id}
      type="number"
      className={cn(baseFieldClass, 'lu-hud-num')}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : 'any')}
      value={draft && draft.base === value ? draft.text : String(value)}
      onChange={(e) => {
        const text = e.target.value
        const n = Number(text)
        const ok = text.trim() !== '' && fits(n)
        setDraft({ text, base: ok ? n : value })
        if (ok) onChange(n)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

function FieldControl({ field, value, onChange, id }: {
  field: WorkflowParamField
  value: ParamValue | undefined
  onChange: (v: ParamValue | undefined) => void
  id: string
}) {
  const c = field.control
  if (c.kind === 'toggle') {
    return (
      <input id={id} type="checkbox" className="accent-lu-accent" checked={value === true}
        onChange={(e) => onChange(e.target.checked)} />
    )
  }
  if (c.kind === 'number') {
    return <NumberInput id={id} field={{ ...field, control: c }} value={typeof value === 'number' ? value : Number(field.fileValue)} onChange={onChange} />
  }
  if (c.kind === 'select') {
    return (
      <select id={id} className={cn(baseFieldClass, 'cursor-pointer')} value={value === undefined ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value
          if (v === '') return onChange(undefined)
          onChange(typeof field.fileValue === 'number' && Number.isFinite(Number(v)) ? Number(v) : v)
        }}>
        {field.autoByLu && <option value="">Auto (LU picks a match)</option>}
        {c.options.map((o) => <option key={o} value={o}>{workflowOptionText(field.inputKey, o)}</option>)}
      </select>
    )
  }
  const text = typeof value === 'string' ? value : value === undefined ? '' : String(value)
  return c.multiline ? (
    <textarea id={id} rows={3} value={text} onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-[var(--radius-control)] border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 t-control text-gray-200 outline-none transition-colors focus:border-white/25" />
  ) : (
    <input id={id} type="text" className={baseFieldClass} value={text} placeholder={field.autoByLu ? 'Auto (LU picks a match)' : undefined}
      onChange={(e) => onChange(e.target.value === '' && field.autoByLu ? undefined : e.target.value)} />
  )
}

function FieldRow({ workflowId, field, override }: {
  workflowId: string
  field: WorkflowParamField
  override: ParamValue | undefined
}) {
  const setOverride = useWorkflowStore((s) => s.setParamOverride)
  const changed = override !== undefined
  // An auto field without a choice shows "Auto": LU replaces the file value.
  const shown = changed ? override : field.autoByLu ? undefined : field.fileValue
  const id = `wfp-${workflowId}-${field.nodeId}-${field.inputKey}`
  const write = (v: ParamValue | undefined) => {
    // Back on the file value means no override at all, so Reset has nothing to keep.
    const same = v !== undefined && !field.autoByLu && v === field.fileValue
    setOverride(workflowId, field.nodeId, field.inputKey, same ? undefined : v)
  }
  const toggle = field.control.kind === 'toggle'
  return (
    <div className={cn(toggle ? 'flex items-center justify-between gap-2' : 'space-y-1')} data-testid={`wf-param-${field.nodeId}-${field.inputKey}`}>
      <label htmlFor={id} title={field.inputKey} className="flex items-center gap-1.5 t-control text-gray-400">
        {label(field.inputKey)}
        {changed && <span className="h-1.5 w-1.5 rounded-full bg-lu-accent" aria-label="changed" title="Changed from the workflow file" />}
      </label>
      <FieldControl id={id} field={field} value={shown} onChange={write} />
    </div>
  )
}

// ── The list ──

/** `path`: how the run fills this workflow. Motion Control ('lane') sets
 *  fewer values than a normal run, so more of them are editable here. */
export function WorkflowParams({ workflow, path = 'workflow' }: { workflow: WorkflowTemplate; path?: WorkflowRunPath }) {
  const overrides = useWorkflowStore((s) => s.paramOverrides[workflow.id])
  const reset = useWorkflowStore((s) => s.resetParamOverrides)
  const defs = useNodeDefs(workflow.workflow)
  const nodes = useMemo(
    () => listWorkflowParams(workflow.workflow, workflow.parameterMap, defs ?? null, path),
    [workflow.workflow, workflow.parameterMap, defs, path],
  )
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const shown = filterNodes(nodes, query)
  const searching = query.trim() !== ''

  const changedIn = (node: WorkflowParamNode) =>
    node.fields.filter((f) => overrides?.[f.nodeId]?.[f.inputKey] !== undefined).length
  const changedTotal = nodes.reduce((sum, n) => sum + changedIn(n), 0)

  const toggle = (nodeId: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    return next
  })

  if (nodes.length === 0) return null

  return (
    <section aria-label="Workflow parameters" className="mt-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap t-label text-gray-500">
          <SlidersHorizontal size={12} className="shrink-0" />
          Workflow parameters
        </span>
        {/* How many values differ shows on each node; here only Reset, the
            drawer is too narrow for a count next to the heading. */}
        <button type="button" disabled={changedTotal === 0} onClick={() => reset(workflow.id)}
          title={changedTotal > 0
            ? `Back to the values in the workflow file (${changedTotal} changed)`
            : 'Nothing changed from the workflow file'}
          className="inline-flex shrink-0 items-center gap-1 t-control text-gray-500 transition-colors hover:text-gray-300 disabled:opacity-40 disabled:hover:text-gray-500">
          <RotateCcw size={11} />
          Reset
        </button>
      </div>

      <div className="relative">
        <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
        <input type="search" aria-label="Search workflow parameters" placeholder="Search by name"
          className={cn(baseFieldClass, 'pl-7')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {defs === null && (
        <p className="t-body text-gray-500">
          ComfyUI is not answering, so the lists and limits of each setting are missing. Values can still be typed in.
        </p>
      )}

      {shown.length === 0 && <p className="t-body text-gray-500">No parameter matches this search.</p>}

      <ul className="space-y-1">
        {shown.map((node) => {
          const isOpen = searching || open.has(node.nodeId)
          const changed = changedIn(node)
          return (
            <li key={node.nodeId} className="rounded-[var(--radius-control)] border border-white/[0.06]">
              <button type="button" aria-expanded={isOpen} onClick={() => toggle(node.nodeId)}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]">
                <ChevronRight size={12} className={cn('shrink-0 text-gray-500 transition-transform', isOpen && 'rotate-90')} />
                <span className="min-w-0 flex-1 truncate t-control text-gray-300" title={`${node.title} (${node.classType}, node ${node.nodeId})`}>
                  {node.title}
                  {node.title !== node.classType && <span className="ml-1 text-gray-600">{node.classType}</span>}
                </span>
                {changed > 0 && <span className="t-mono text-lu-accent">{changed} changed</span>}
              </button>
              {isOpen && (
                <div className="space-y-2 px-2 pb-2">
                  {node.fields.map((field) => (
                    <FieldRow key={field.inputKey} workflowId={workflow.id} field={field}
                      override={overrides?.[field.nodeId]?.[field.inputKey]} />
                  ))}
                  {node.setByLu.length > 0 && (
                    <p className="t-body text-gray-600">Set by LU: {node.setByLu.join(', ')}</p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The list for the workflow Create will run with this model, if any. */
export function ActiveWorkflowParams({ modelName, modelType, path }: {
  modelName: string
  modelType: ModelType
  path?: WorkflowRunPath
}) {
  const workflow = useWorkflowStore((s) => s.getWorkflowForModel(modelName, modelType))
  if (!workflow) return null
  return <WorkflowParams key={workflow.id} workflow={workflow} path={path} />
}
