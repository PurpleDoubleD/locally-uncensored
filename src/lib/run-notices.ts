/**
 * Lines a tool wants the USER to see in the run, not only the model (C59
 * A6/A7: "Saved to memory: …", "Skill proposed: …"). The executor files them
 * by conversation; the agent loops take them after a batch and show them as
 * a block in the run. Nothing persists here.
 */
const pending = new Map<string, string[]>()

export function pushRunNotice(convId: string | null | undefined, text: string): void {
  if (!convId || !text) return
  pending.set(convId, [...(pending.get(convId) ?? []), text])
}

export function takeRunNotices(convId: string | null | undefined): string[] {
  if (!convId) return []
  const out = pending.get(convId) ?? []
  pending.delete(convId)
  return out
}
