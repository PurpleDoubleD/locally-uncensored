import { useState } from 'react'
import { AlertTriangle, Check, Puzzle, RotateCcw, Workflow, X } from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflowStore'
import { useWorkflowCardStore, type WorkflowCardRequest } from '../../stores/workflowInstallConfirmStore'
import { assignmentState, undoAssignment, type WorkflowInstallMark } from '../../api/mcp/workflow-tools'
import type { InspectReport, Light, NodeClass } from '../../lib/workflow-inspect'

const box = 'mt-1 mb-1.5 max-w-xl rounded-lg border bg-gray-50 dark:bg-white/[0.03]'
const btnYes = 'flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors'
// The strong card's yes: the same quiet grey as No, so neither button pulls the eye.
const btnStrong = 'flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-gray-900 dark:text-gray-100 bg-gray-500/10 hover:bg-gray-500/15 border border-gray-500/40 transition-colors'
const btnNo = 'flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-gray-700 dark:text-gray-300 bg-gray-500/10 hover:bg-gray-500/15 border border-gray-500/20 transition-colors'

// The traffic light in LU's two tones (lib/hinweis.ts, no yellow in the UI):
// green is green, the middle state is a grey ring and says what it means,
// red is red.
const LIGHT_LABEL: Record<Light, string> = { green: 'Green', yellow: 'Review', red: 'Red' }
const LIGHT_DOT: Record<Light, string> = { green: 'bg-emerald-500', yellow: 'border-2 border-gray-500 dark:border-gray-400', red: 'bg-red-500' }
const CLS_LABEL: Record<NodeClass, string> = {
  core: 'ComfyUI core', installed: 'already installed', 'lu-pack': 'LU installs (pinned list)',
  registry: 'you install yourself', unknown: 'unknown', api: 'online API', danger: 'risky',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <p className="t-micro font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</p>
      <div className="t-body text-gray-800 dark:text-gray-200">{children}</div>
    </div>
  )
}

/** The check as the card shows it: drawn from the report's fields, which hold
 *  LU's sentences and cleaned names only, never text of the workflow file. */
export function WorkflowReportView({ report }: { report: InspectReport }) {
  const groups = new Map<NodeClass, string[]>()
  for (const n of report.nodes) groups.set(n.cls, [...(groups.get(n.cls) ?? []), n.count > 1 ? `${n.type} ×${n.count}` : n.type])
  const downloads = report.models.filter((m) => m.state === 'catalog' || m.state === 'download')
  return (
    <div data-testid="workflow-report">
      <Section title="Nodes">
        <ul className="space-y-0.5">
          {[...groups.entries()].map(([cls, types]) => (
            <li key={cls}><span className="text-gray-500 dark:text-gray-400">{CLS_LABEL[cls]}:</span> {types.slice(0, 10).join(', ')}{types.length > 10 ? ` +${types.length - 10}` : ''}</li>
          ))}
        </ul>
        {report.installPacks.length > 0 && (
          <ul className="mt-0.5 space-y-0.5" data-testid="workflow-card-packs">
            {report.installPacks.map((p) => (
              <li key={p.key} className="flex items-center gap-1"><Puzzle size={11} className="shrink-0 text-gray-500 dark:text-gray-400" />
                Installs {p.name} from LU's list{p.commit ? `, commit ${p.commit.slice(0, 8)}` : ''}. Runs its own code in ComfyUI.
              </li>
            ))}
          </ul>
        )}
        {report.userPacks.length > 0 && (
          <p className="mt-0.5 text-gray-600 dark:text-gray-400">Not installed by LU: {report.userPacks.map((p) => p.pack).join(', ')}. Install them yourself in Settings, ComfyUI node packs.</p>
        )}
      </Section>
      {report.models.length > 0 && (
        <Section title="Models">
          <ul className="space-y-0.5" data-testid="workflow-card-models">
            {report.models.map((m) => (
              <li key={m.name}>
                {m.name}{' '}
                <span className="text-gray-500 dark:text-gray-400">
                  {m.state === 'present' ? 'is here'
                    : m.state === 'catalog' ? `downloads from LU's catalog${m.sizeGB ? `, ${m.sizeGB} GB` : ''} to ${m.folder}${m.sha256 ? ', checksum checked' : ', size checked'}`
                      : m.state === 'download' ? `downloads from ${m.host} to ${m.folder}, SHA-256 checked`
                        : m.state === 'missing' ? 'missing, get it yourself'
                          : 'refused'}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Size">
        {report.size.kb} KB, {report.size.nodes} nodes{downloads.length ? `, ${report.size.downloadGB} GB to download` : ''}
        {report.texts.notes > 0 ? `, ${report.texts.notes} notes in the file (not read by the agent)` : ''}
      </Section>
      <Section title="Source and license">
        {report.source.kind}{report.source.host ? `, ${report.source.host}` : ''}{report.source.author ? `, by ${report.source.author}` : ''}
        {report.license.length > 0 ? <ul className="space-y-0.5">{report.license.map((l) => <li key={l}>{l}</li>)}</ul> : <p>No license stated.</p>}
      </Section>
      <Section title="Check">
        <ul className="space-y-0.5" data-testid="workflow-card-reasons">
          {report.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </Section>
    </div>
  )
}

/** Why the card is the strong one, from what the check found. */
function strongNote(r: InspectReport | undefined): string {
  if (!r) return 'Review: read the check before you say yes.'
  const fetches = r.installPacks.length > 0 || r.models.some((m) => m.state === 'catalog' || m.state === 'download')
  return fetches
    ? 'Review: this installs node packs or downloads files. Read the list before you say yes.'
    : 'Review: something this workflow needs is missing or has to be installed by you. Read the check before you say yes.'
}

/** The question in front of an install or an assignment from the chat. Only a
 *  click acts, also in Bypass; a yellow check is the strong card, with no
 *  default button. */
export function WorkflowCardAsk({ req }: { req: WorkflowCardRequest }) {
  const answer = useWorkflowCardStore((s) => s.answer)
  const light = req.report?.light ?? 'green'
  const border = req.strong ? 'border-gray-400 dark:border-white/[0.3]' : 'border-gray-200 dark:border-white/[0.1]'
  return (
    <div role="group" aria-label={req.kind === 'install' ? 'Install a workflow' : 'Assign a workflow'}
      data-testid="workflow-card-ask" data-light={light} data-strong={req.strong ? 'true' : 'false'}
      className={`${box} ${border} px-3 py-2.5`}>
      <div className="flex items-center gap-1.5">
        <Workflow size={13} className="shrink-0 text-gray-500 dark:text-gray-400" />
        <p className="t-body font-medium text-gray-900 dark:text-gray-100">
          {req.kind === 'install' ? 'Install this workflow?' : 'Use this workflow for the model?'}
        </p>
        {req.report && (
          <span className="ml-auto flex items-center gap-1 t-micro text-gray-600 dark:text-gray-300" data-testid="workflow-card-light">
            <span className={`inline-block h-2 w-2 rounded-full ${LIGHT_DOT[light]}`} /> {LIGHT_LABEL[light]}
          </span>
        )}
      </div>
      <p className="mt-1 t-body text-gray-900 dark:text-gray-100">{req.title}</p>
      {req.foreign && (
        <p className="mt-1 flex items-start gap-1 t-micro text-gray-500 dark:text-gray-400" data-testid="workflow-card-foreign">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> This came after the agent read content from elsewhere ({req.foreign}).
        </p>
      )}
      {req.strong && (
        <p className="mt-1 t-micro font-medium text-gray-700 dark:text-gray-300" data-testid="workflow-card-strong">
          {strongNote(req.report)}
        </p>
      )}
      {req.report && <WorkflowReportView report={req.report} />}
      {req.assign && (
        <Section title="Model">
          {req.assign.model} generates with this workflow{req.assign.before ? ` instead of ${req.assign.before}` : ''}, in Create and in the chat.
        </Section>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" data-testid="workflow-card-accept" className={req.strong ? btnStrong : btnYes}
          onClick={(e) => { e.stopPropagation(); answer(req.id, true) }}>
          <Check size={10} /> {req.kind === 'install' ? 'Install' : 'Use it'}
        </button>
        <button type="button" data-testid="workflow-card-decline" className={btnNo}
          onClick={(e) => { e.stopPropagation(); answer(req.id, false) }}>
          <X size={10} /> Decline
        </button>
      </div>
    </div>
  )
}

/** After the yes: what was installed, with Undo for the assignment. The
 *  workflow itself is removed by the user in Create, Workflows. */
export function WorkflowCardDone({ mark }: { mark: WorkflowInstallMark }) {
  useWorkflowStore((s) => s.modelNameAssignments)
  const exists = useWorkflowStore((s) => s.installedWorkflows.some((w) => w.id === mark.workflowId))
  const [confirmMoved, setConfirmMoved] = useState(false)
  const state = assignmentState(mark)
  return (
    <div data-testid="workflow-card-done" data-state={state} className={`${box} border-gray-200 dark:border-white/[0.1] px-3 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1`}>
      <Workflow size={11} className="shrink-0 text-gray-500 dark:text-gray-400" />
      <span className="t-body text-gray-900 dark:text-gray-100">
        {mark.name}{exists ? '' : ' (removed since)'}{mark.model ? <> → <span className="font-medium">{mark.model}</span></> : ''}
      </span>
      {mark.model && state === 'applied' && (
        <button type="button" data-testid="workflow-card-undo" className={btnNo}
          onClick={(e) => { e.stopPropagation(); undoAssignment(mark) }}>
          <RotateCcw size={10} /> Undo assignment
        </button>
      )}
      {mark.model && state === 'undone' && (
        <>
          <span className="t-micro text-gray-500 dark:text-gray-400">Undone</span>
          {exists && (
            <button type="button" data-testid="workflow-card-redo" className={btnNo}
              onClick={(e) => { e.stopPropagation(); useWorkflowStore.getState().assignToModelName(mark.model!, mark.workflowId) }}>
              Apply again
            </button>
          )}
        </>
      )}
      {mark.model && state === 'moved' && (
        confirmMoved ? (
          <button type="button" className={btnNo} onClick={(e) => { e.stopPropagation(); undoAssignment(mark); setConfirmMoved(false) }}>
            <RotateCcw size={10} /> Set back anyway
          </button>
        ) : (
          <>
            <span className="t-micro text-gray-500 dark:text-gray-400">Changed since</span>
            <button type="button" className={btnNo} onClick={(e) => { e.stopPropagation(); setConfirmMoved(true) }}>
              <RotateCcw size={10} /> Undo
            </button>
          </>
        )
      )}
    </div>
  )
}
