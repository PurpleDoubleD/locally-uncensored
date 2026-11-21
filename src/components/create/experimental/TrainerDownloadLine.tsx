// The trainer setup in one line above its button: before the start what it
// will load and how big that is, while it runs what it does and a Stop. The
// same job is a row in the Downloads tray, so it stays reachable from anywhere.
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { trainerPlanLine, trainerSetupPlan, type TrainerSetupPlan } from '../../../api/trainer'
import { isLiveJob, jobLine } from '../../../lib/install-jobs'
import { useInstallJobsStore } from '../../../stores/installJobsStore'

export function TrainerDownloadLine() {
  const job = useInstallJobsStore((s) => s.jobs.find((j) => j.id === 'trainer' || j.id === 'trainer-repair'))
  const stopping = useInstallJobsStore((s) => !!job && s.stopping.includes(job.id))
  const live = !!job && isLiveJob(job)
  const [plan, setPlan] = useState<TrainerSetupPlan | null>(null)

  // Asked again when a run ends: a stopped setup needs less, or a repair.
  useEffect(() => {
    if (live) return
    let alive = true
    trainerSetupPlan().then((p) => { if (alive) setPlan(p) }).catch(() => { if (alive) setPlan(null) })
    return () => { alive = false }
  }, [live])

  if (job && live) {
    return (
      <div className="flex items-center justify-center gap-2 max-w-full" data-testid="trainer-download-line">
        <span className="t-label text-gray-500 truncate" title={job.phase}>{stopping ? 'Stopping…' : jobLine(job)}</span>
        {job.canCancel && !stopping && (
          <button
            type="button"
            onClick={() => void useInstallJobsStore.getState().cancel(job.id)}
            className="inline-flex items-center gap-1 shrink-0 t-label text-gray-400 hover:text-gray-200 transition-colors"
            data-testid="trainer-download-stop"
          >
            <X size={12} />Stop
          </button>
        )}
      </div>
    )
  }
  const line = plan ? trainerPlanLine(plan) : null
  if (!line) return null
  return <p className="t-label text-gray-500 text-center" data-testid="trainer-download-line">{line}</p>
}
