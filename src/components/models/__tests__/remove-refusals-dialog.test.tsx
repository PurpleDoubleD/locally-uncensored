/**
 * @vitest-environment jsdom
 *
 * Remove refusals (A14) on screen. The backend is a stand-in: the dialog is
 * measured on what it says before the run (source, license, time, memory,
 * disk, too large), what it needs before Start opens (18+, the license note),
 * what it sends, how a run reads while it goes, and the result card with its
 * three ways out. The tile is measured on when it offers the button and the
 * mark of a finished copy, in both faces.
 *
 * Run: npx vitest run src/components/models/__tests__/remove-refusals-dialog.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { Plan, RunStatus, RunRecord } from '../../../api/abliterate'

const api = vi.hoisted(() => ({
  abliteratePlan: vi.fn(),
  abliterateStart: vi.fn(),
  abliterateStatus: vi.fn(),
  abliterateCancel: vi.fn(),
  abliterateDismiss: vi.fn(),
  abliterateTrashCopy: vi.fn(async () => ({ trashed: true })),
}))
vi.mock('../../../api/abliterate', async (orig) => {
  const real = await orig<typeof import('../../../api/abliterate')>()
  return { ...real, ...api }
})
vi.mock('../../../api/backend', () => ({ isWindows: () => false, isMacOS: () => true, openExternal: vi.fn(), backendCall: vi.fn(), isTauri: () => false }))

import { RemoveRefusalsDialog, CLAIM } from '../RemoveRefusalsDialog'
import { useAbliterateStore, stopAbliteratePolling } from '../../../stores/abliterateStore'
import { ModelCard } from '../ModelCard'
import { buildModelCardMenu } from '../../ui/menu-actions'
import type { AIModel } from '../../../types/models'

const PATH = '/models/Qwen2.5-0.5B-Instruct-Q8_0.gguf'

function plan(over: Partial<Plan> = {}): Plan {
  return {
    model: { name: 'Qwen2.5 0.5B Instruct', path: PATH, size: 531_068_224, quant: 'Q8_0' },
    source: {
      repo: 'Qwen/Qwen2.5-0.5B-Instruct', from: 'license', revision: '7ae557604adf67be50417f59c2c2f167def9a775',
      gated: false, private: false, params: 494_032_768, downloadBytes: 988_097_824, modelType: 'qwen2', tokenSaved: false,
    },
    license: { id: 'apache-2.0', kind: 'free', label: 'Apache 2.0', link: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct', note: null, cloudAllowed: true },
    devices: [{
      device: { id: 'apple', kind: 'apple', name: 'Apple Silicon (this Mac)', memoryBytes: 48e9, supported: true, note: null },
      estimate: {
        fits: true, whyNot: null, quantization: 'none', memoryNeededBytes: 4e9, memoryAvailableBytes: 33.6e9,
        diskNeededBytes: 5e9, diskAfterBytes: 0.53e9, diskFreeBytes: 96e9, downloadBytes: 0.99e9,
        minutesLow: 13, minutesHigh: 33, outputQuant: 'Q8_0', outputBytes: 0.53e9,
      },
      estimate100: { minutesLow: 8, minutesHigh: 20 },
    }],
    quantizeTool: true,
    heretic: '1.4.0',
    cloud: { available: false, allowed: true, note: 'A run in LU Cloud for larger models is planned, not built yet.' },
    ...over,
  }
}

function status(over: Partial<RunStatus> = {}): RunStatus {
  return {
    status: 'running', id: 'r1', modelName: 'Qwen2.5 0.5B Instruct', sourcePath: PATH, repo: 'Qwen/Qwen2.5-0.5B-Instruct',
    phase: 'trials', phaseLabel: 'Trial 37 of 200', step: 37, total: 200, trials: 200,
    best: { trial: 31, refusals: 12, kl: 0.14 }, baseRefusals: 98, prompts: 100,
    startedAt: 0, elapsedSecs: 600, etaSecs: 900, logs: ['· Loading the model'], error: null, result: null, resumable: false,
    ...over,
  }
}

const RECORD: RunRecord = {
  id: 'r1', sourcePath: PATH, sourceName: 'Qwen2.5 0.5B Instruct',
  outputPath: '/models/Qwen2.5-0.5B-Instruct-refusals-removed-Q8_0.gguf', outputName: 'Qwen2.5 0.5B Instruct (refusals removed)',
  repo: 'Qwen/Qwen2.5-0.5B-Instruct', revision: 'x'.repeat(40), license: 'Apache 2.0', mode: 'balanced', trials: 200,
  trial: 87, kl: 0.12, searchRefusalsBefore: 98, searchRefusalsAfter: 9, searchPrompts: 100,
  before: { refusals: 41, falseAlarms: 6, mmlu: 22, n: 50 }, after: { refusals: 7, falseAlarms: 2, mmlu: 21, n: 50 },
  quant: 'Q8_0', quantNote: null, device: 'Apple Silicon (this Mac)', seconds: 1500, finishedAt: 1, discarded: false,
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset()
  api.abliterateStatus.mockResolvedValue(status({ status: 'idle', sourcePath: '' }))
  api.abliterateTrashCopy.mockResolvedValue({ trashed: true })
  useAbliterateStore.setState({ status: null, dialogPath: null })
})
afterEach(() => {
  cleanup()
  stopAbliteratePolling()
})

function openFor(path = PATH) {
  const onUse = vi.fn(async () => {})
  const onModelsChanged = vi.fn(async () => {})
  render(<RemoveRefusalsDialog onUse={onUse} onModelsChanged={onModelsChanged} />)
  useAbliterateStore.setState({ dialogPath: path })
  return { onUse, onModelsChanged }
}

describe('before the run', () => {
  it('names the original, the license, time, memory and disk, and says what the copy is', async () => {
    api.abliteratePlan.mockResolvedValue(plan())
    openFor()
    expect(await screen.findByText(/Qwen\/Qwen2.5-0.5B-Instruct/)).toBeTruthy()
    expect(api.abliteratePlan).toHaveBeenCalledWith(PATH, undefined)
    expect(screen.getByText('Apache 2.0')).toBeTruthy()
    const needs = screen.getByTestId('remove-refusals-needs').textContent ?? ''
    expect(needs).toContain('13–33 min')
    expect(needs).toContain('4.0 GB of 34 GB')
    expect(needs).toContain('5.0 GB during the run')
    expect(needs).toContain('Q8_0')
    expect(screen.getByText(CLAIM)).toBeTruthy()
    expect(screen.getByText(/nothing is uploaded/)).toBeTruthy()
  })

  it('names the check the run makes: 100 requests and 200 knowledge questions (3.0.9)', async () => {
    api.abliteratePlan.mockResolvedValue(plan())
    openFor()
    expect(await screen.findByText(/the same 100 short requests and 200 knowledge questions/)).toBeTruthy()
  })

  it('opens Start only after the 18+ line, and sends what was chosen', async () => {
    api.abliteratePlan.mockResolvedValue(plan())
    api.abliterateStart.mockResolvedValue(status())
    openFor()
    const start = (await screen.findByTestId('remove-refusals-start')) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.click(screen.getByText('Quick · 100 trials'))
    fireEvent.click(screen.getByText('Gentle'))
    expect(screen.getByTestId('remove-refusals-needs').textContent).toContain('8–20 min')
    fireEvent.click(screen.getByTestId('remove-refusals-adult'))
    expect(start.disabled).toBe(false)
    fireEvent.click(start)
    await waitFor(() => expect(api.abliterateStart).toHaveBeenCalled())
    expect(api.abliterateStart.mock.calls[0][0]).toEqual({
      path: PATH, repo: 'Qwen/Qwen2.5-0.5B-Instruct', revision: '7ae557604adf67be50417f59c2c2f167def9a775',
      device: 'apple', trials: 100, mode: 'gentle', acceptLicense: false, adult: true,
    })
    expect(await screen.findByTestId('remove-refusals-running')).toBeTruthy()
  })

  it('a Llama or Gemma license needs its note read first', async () => {
    api.abliteratePlan.mockResolvedValue(plan({
      license: { id: 'llama3.1', kind: 'notice', label: 'Llama Community License', link: 'https://huggingface.co/x/y', note: 'Meta’s license … "Built with Llama".', cloudAllowed: false },
    }))
    openFor()
    const start = (await screen.findByTestId('remove-refusals-start')) as HTMLButtonElement
    fireEvent.click(screen.getByTestId('remove-refusals-adult'))
    expect(start.disabled).toBe(true)
    expect(screen.getByText(/Built with Llama/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('remove-refusals-license'))
    expect(start.disabled).toBe(false)
  })

  it('too large for this machine is said before anything starts, with the cloud note', async () => {
    const p = plan()
    p.devices![0].estimate = { ...p.devices![0].estimate, fits: false, whyNot: 'Too large for this machine: the run needs about 59 GB of memory, and Apple Silicon (this Mac) has 33 GB it can use.' }
    api.abliteratePlan.mockResolvedValue(p)
    openFor()
    const msg = await screen.findByTestId('remove-refusals-too-large')
    expect(msg.textContent).toContain('Too large for this machine')
    expect(msg.textContent).toContain('LU Cloud')
    fireEvent.click(screen.getByTestId('remove-refusals-adult'))
    expect((screen.getByTestId('remove-refusals-start') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a file that names no original asks for the repo and looks it up', async () => {
    api.abliteratePlan.mockResolvedValueOnce({ model: plan().model, source: null })
    api.abliteratePlan.mockResolvedValueOnce(plan())
    openFor()
    const input = await screen.findByLabelText('Original model on Hugging Face')
    fireEvent.change(input, { target: { value: 'Qwen/Qwen2.5-0.5B-Instruct' } })
    fireEvent.click(screen.getByText('Look up'))
    await waitFor(() => expect(api.abliteratePlan).toHaveBeenLastCalledWith(PATH, 'Qwen/Qwen2.5-0.5B-Instruct'))
    expect(await screen.findByTestId('remove-refusals-start')).toBeTruthy()
  })
})

describe('during and after', () => {
  it('shows the trial, the best so far and a Stop that reaches the backend', async () => {
    api.abliterateCancel.mockResolvedValue(status({ status: 'cancelled' }))
    openFor()
    useAbliterateStore.setState({ status: status() })
    expect(await screen.findByText('Trial 37 of 200')).toBeTruthy()
    expect(screen.getByTestId('remove-refusals-best').textContent).toContain('12 of 100 test prompts refused (the original: 98), KL 0.14')
    expect(screen.getByText(/37 of 200 trials/)).toBeTruthy()
    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => expect(api.abliterateCancel).toHaveBeenCalled())
    expect(await screen.findByText(/Stopped/)).toBeTruthy()
  })

  it('a download shows bytes of total, share, speed and time left on the face of the window (3.0.9)', async () => {
    openFor()
    useAbliterateStore.setState({ status: status({
      phase: 'setup', phaseLabel: 'Installing PyTorch: downloading torch 2.14.1+cu130', step: 740e6, total: 1_990_600_000,
      bytes: true, rateBps: 4_200_000, etaSecs: 298, best: null, elapsedSecs: 1560,
    }) })
    const line = await screen.findByTestId('remove-refusals-download')
    expect(line.textContent).toBe('740 MB of 1.99 GB · 37% · 4.2 MB/s · about 5 min left')
    expect(screen.getByText('Installing PyTorch: downloading torch 2.14.1+cu130')).toBeTruthy()
    expect(screen.getByText('Running for 26 min')).toBeTruthy()
    // the bar has its share, not 0 % as in 3.0.8
    const bar = screen.getByTestId('remove-refusals-running').querySelector('.bg-lu-accent') as HTMLElement
    expect(bar.style.width).toBe('37%')
  })

  it('the knowledge check names the answers that changed and whether that is chance (3.0.9)', async () => {
    const m = (s: string) => s.padEnd(200, '0')
    const rec = {
      ...RECORD,
      before: { refusals: 41, falseAlarms: 6, mmlu: 3, n: 50, mmluN: 200, mmluMarks: m('111') },
      after: { refusals: 7, falseAlarms: 2, mmlu: 2, n: 50, mmluN: 200, mmluMarks: m('011') },
    }
    openFor()
    useAbliterateStore.setState({ status: status({ status: 'done', result: rec }) })
    const table = await screen.findByTestId('remove-refusals-result')
    expect(table.textContent).toContain('3 of 200')
    expect(table.textContent).toContain('1 answer turned wrong, 0 answers turned right (-1 of 200): within chance')
  })

  it('the result card compares original and copy, and Use loads the copy', async () => {
    api.abliterateDismiss.mockResolvedValue(status({ status: 'idle', sourcePath: '' }))
    const { onUse, onModelsChanged } = openFor()
    useAbliterateStore.setState({ status: status({ status: 'done', result: RECORD }) })
    const table = await screen.findByTestId('remove-refusals-result')
    expect(table.textContent).toContain('41 of 50')
    expect(table.textContent).toContain('7 of 50')
    expect(table.textContent).toContain('KL 0.12')
    await waitFor(() => expect(onModelsChanged).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('remove-refusals-use'))
    await waitFor(() => expect(onUse).toHaveBeenCalledWith(RECORD.outputPath))
  })

  it('the copy can go to the trash from the card', async () => {
    api.abliterateDismiss.mockResolvedValue(status({ status: 'idle', sourcePath: '' }))
    openFor()
    useAbliterateStore.setState({ status: status({ status: 'done', result: RECORD }) })
    fireEvent.click(await screen.findByText('Move copy to Trash'))
    await waitFor(() => expect(api.abliterateTrashCopy).toHaveBeenCalledWith(RECORD.outputPath))
  })

  it('a failed run says why and offers to start again', async () => {
    api.abliterateDismiss.mockResolvedValue(status({ status: 'idle', sourcePath: '' }))
    api.abliteratePlan.mockResolvedValue(plan())
    openFor()
    useAbliterateStore.setState({ status: status({ status: 'failed', error: 'The disk ran full.' }) })
    expect((await screen.findByTestId('remove-refusals-error')).textContent).toContain('The disk ran full.')
    fireEvent.click(screen.getByText('Start again'))
    expect(await screen.findByTestId('remove-refusals-start')).toBeTruthy()
  })

  it('a run for another model is not doubled', async () => {
    openFor('/models/other.gguf')
    useAbliterateStore.setState({ status: status() })
    expect(await screen.findByText(/already removing refusals from Qwen2.5 0.5B Instruct/)).toBeTruthy()
    expect(api.abliteratePlan).not.toHaveBeenCalled()
  })
})

describe('the model row', () => {
  const row = (over: Partial<AIModel> = {}) => ({
    name: 'openai::Qwen2.5-0.5B-Instruct-Q8_0', model: 'Qwen2.5-0.5B-Instruct-Q8_0', size: 531_068_224, type: 'text',
    provider: 'openai', providerName: 'LU Engine', path: PATH, ...over,
  }) as AIModel

  it('offers the button only when it was given one, and the menu says the same', () => {
    const open = vi.fn()
    render(<ModelCard model={row()} isActive={false} onSelect={() => {}} onDelete={() => {}} onInfo={() => {}} onRemoveRefusals={open} />)
    fireEvent.click(screen.getByTestId('model-card-remove-refusals'))
    expect(open).toHaveBeenCalled()
    cleanup()
    render(<ModelCard model={row()} isActive={false} onSelect={() => {}} onDelete={() => {}} onInfo={() => {}} />)
    expect(screen.queryByTestId('model-card-remove-refusals')).toBeNull()
    const h = { select: () => {}, info: () => {}, remove: () => {} }
    expect(buildModelCardMenu(h, { isActive: false, canDelete: true }).map((a) => a.id)).not.toContain('remove-refusals')
    expect(buildModelCardMenu({ ...h, removeRefusals: () => {} }, { isActive: false, canDelete: true }).map((a) => a.label)).toContain('Remove refusals…')
  })

  it('marks a copy the tool made', () => {
    render(<ModelCard model={row({ refusalsRemoved: true } as Partial<AIModel>)} isActive={false} onSelect={() => {}} onDelete={() => {}} onInfo={() => {}} />)
    expect(screen.getByTestId('model-card-refusals-removed').textContent).toBe('refusals removed')
  })
})
