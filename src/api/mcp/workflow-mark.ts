// The mark a workflow install or assignment leaves under its result (C60-S5),
// so the card can show what was done and undo the assignment, also after a
// restart. Pure: the chat UI and the tool registry import it without pulling
// the stores behind the tools.

export const WORKFLOW_MARK = /<!-- lu-workflow (\{.*\}) -->/

export interface WorkflowInstallMark {
  workflowId: string
  name: string
  model?: string
  /** The model's assignment before, to put back with Undo. */
  before?: string
}

export function parseWorkflowMark(result: string | null | undefined): WorkflowInstallMark | null {
  const m = typeof result === 'string' ? WORKFLOW_MARK.exec(result) : null
  if (!m) return null
  try {
    const v = JSON.parse(m[1]) as Partial<WorkflowInstallMark>
    return typeof v.workflowId === 'string' && typeof v.name === 'string' ? v as WorkflowInstallMark : null
  } catch {
    return null
  }
}

