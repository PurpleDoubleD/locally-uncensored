/**
 * Which installs the Downloads tray lists (commands/install_jobs.rs).
 *
 * The backend keeps the last status of every install until the app closes, so
 * its list alone would bring back a ComfyUI setup from an hour ago, or one the
 * user already cleared. The rule lives here as a pure function because the repo
 * has no render harness.
 */

export type InstallJobStatus = 'running' | 'cancelling' | 'complete' | 'error' | 'cancelled'

export interface InstallJob {
  id: string
  label: string
  status: InstallJobStatus
  phase: string
  progress: number
  total: number
  speed: number
  canCancel: boolean
  /** Why there is no pause (or no stop) button. Empty once the job is over. */
  note: string
}

export interface JobMemory {
  /** Ids seen running in this session. */
  seen: string[]
  /** Ids whose finished row the user cleared. */
  dismissed: string[]
}

export const isLiveJob = (job: Pick<InstallJob, 'status'>): boolean =>
  job.status === 'running' || job.status === 'cancelling'

/**
 * The rows to show, and what to remember for the next poll.
 *
 *  - A running job always shows, also one the user cleared in an earlier run.
 *  - A finished job shows only when this session watched it run.
 *  - A cleared job stays away until it runs again.
 */
export function visibleJobs(raw: readonly InstallJob[], memory: JobMemory): { jobs: InstallJob[]; memory: JobMemory } {
  const live = raw.filter(isLiveJob).map((j) => j.id)
  const seen = [...new Set([...memory.seen, ...live])]
  const dismissed = memory.dismissed.filter((id) => !live.includes(id))
  const jobs = raw.filter((j) => isLiveJob(j) || (seen.includes(j.id) && !dismissed.includes(j.id)))
  return { jobs, memory: { seen, dismissed } }
}

/** The status line of a row. */
export function jobLine(job: InstallJob): string {
  if (job.status === 'cancelling') return 'Stopping…'
  if (job.status === 'cancelled') return 'Stopped'
  if (job.status === 'complete') return 'Complete'
  if (job.status === 'error') return job.phase || 'The install did not finish.'
  return job.phase || 'Working…'
}
