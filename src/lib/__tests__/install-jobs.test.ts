import { describe, expect, it } from 'vitest'
import { jobLine, visibleJobs, type InstallJob, type InstallJobStatus } from '../install-jobs'

const job = (id: string, status: InstallJobStatus, phase = ''): InstallJob => ({
  id, label: id, status, phase, progress: 0, total: 0, speed: 0, canCancel: status === 'running', note: '',
})
const empty = { seen: [], dismissed: [] }

describe('the installs the Downloads tray lists', () => {
  it('shows a running install without anyone registering it', () => {
    expect(visibleJobs([job('trainer', 'running')], empty).jobs.map((j) => j.id)).toEqual(['trainer'])
  })

  it('does not bring back an install that ended before this session watched it', () => {
    expect(visibleJobs([job('comfyui', 'complete')], empty).jobs).toEqual([])
  })

  it('keeps a finished install it watched, so the row survives a change of screen', () => {
    const first = visibleJobs([job('trainer', 'running')], empty)
    const after = visibleJobs([job('trainer', 'complete')], first.memory)
    expect(after.jobs.map((j) => j.status)).toEqual(['complete'])
  })

  it('leaves a cleared row away until the install runs again', () => {
    const cleared = { seen: ['trainer'], dismissed: ['trainer'] }
    expect(visibleJobs([job('trainer', 'error')], cleared).jobs).toEqual([])
    const again = visibleJobs([job('trainer', 'running')], cleared)
    expect(again.jobs).toHaveLength(1)
    expect(again.memory.dismissed).toEqual([])
  })

  it('says what a stopped install is', () => {
    expect(jobLine(job('x', 'cancelling'))).toBe('Stopping…')
    expect(jobLine(job('x', 'cancelled'))).toBe('Stopped')
    expect(jobLine(job('x', 'running', 'Step 3'))).toBe('Step 3')
    expect(jobLine(job('x', 'error'))).toBe('The install did not finish.')
  })
})
