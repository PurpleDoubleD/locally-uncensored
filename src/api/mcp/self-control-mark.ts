// The mark an action of LU's self-control tools leaves under its tool result
// (C60), for the card that stays after the yes. Its own file so the card, the
// tools and the registration can share it without a cycle.

/** The line an action puts under its answer, for the card that stays. */
const ACTION_MARK = /<!-- lu-action (\{.*?\}) -->/

export interface SelfControlAction {
  kind: 'model' | 'service' | 'download'
  title: string
  /** For a model switch: the model before and after, for Undo. */
  from?: string | null
  to?: string | null
}

export function parseSelfControlAction(result: string | null | undefined): SelfControlAction | null {
  const m = typeof result === 'string' ? ACTION_MARK.exec(result) : null
  if (!m) return null
  try {
    const v = JSON.parse(m[1]) as Partial<SelfControlAction>
    return typeof v.kind === 'string' && typeof v.title === 'string' ? (v as SelfControlAction) : null
  } catch {
    return null
  }
}

export const markOf = (a: SelfControlAction) => `<!-- lu-action ${JSON.stringify(a)} -->`
