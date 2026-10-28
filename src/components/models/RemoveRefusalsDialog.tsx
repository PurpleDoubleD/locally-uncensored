import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { ICON_SM } from '../ui/icon-size'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { isWindows, openExternal } from '../../api/backend'
import {
  abliterateCancel, abliterateDismiss, abliteratePlan, abliterateStart, abliterateTrashCopy,
  downloadLine, gb, minutesRange, mmluVerdict, phaseShare, roughDuration,
  type Check, type Mode, type Plan, type RunRecord, type RunStatus,
} from '../../api/abliterate'
import { useAbliterateStore } from '../../stores/abliterateStore'

// Remove refusals from a local model (A14). One dialog for the whole run:
// what it needs before anything is downloaded, the run itself, and what came
// out of it. The run belongs to Rust, so closing the dialog does not stop it.

const MODES: { id: Mode; label: string; note: string }[] = [
  { id: 'gentle', label: 'Gentle', note: 'Keeps closest to the original. Some refusals stay.' },
  { id: 'balanced', label: 'Balanced', note: 'Removes most refusals with little change elsewhere.' },
  { id: 'strong', label: 'Strong', note: 'Removes the most refusals and changes the model more.' },
]

const SOURCE_FROM: Record<string, string> = {
  source: 'named in the file',
  license: 'from the license link in the file',
  catalog: 'from LU’s model list',
  base_model: 'named in the file',
  typed: 'as you entered it',
}

export const CLAIM =
  'The copy answers more requests. It is not smarter, it can be slightly worse at some tasks, ' +
  'and it does not make anything legal that was not legal before. LU’s safety rules still apply.'

interface Props {
  /** Load the finished copy in the LU Engine. */
  onUse: (outputPath: string) => Promise<void> | void
  /** The model list changed (a copy arrived or went to the trash). */
  onModelsChanged: () => Promise<void> | void
}

export function RemoveRefusalsDialog({ onUse, onModelsChanged }: Props) {
  const path = useAbliterateStore((s) => s.dialogPath)
  const status = useAbliterateStore((s) => s.status)
  const close = useAbliterateStore((s) => s.closeDialog)

  // The run on screen is the one for this file, or none. A run for another
  // file keeps going, and the dialog says so instead of offering a second.
  const runHere = status && status.status !== 'idle' && status.sourcePath === path ? status : null
  const runElsewhere = status?.status === 'running' && status.sourcePath !== path ? status : null

  return (
    <Modal open={!!path} onClose={close} title="Remove refusals" maxWidth="max-w-xl">
      {path && (
        <div className="space-y-3" data-testid="remove-refusals">
          {runHere ? (
            <RunView run={runHere} onClose={close} onUse={onUse} onModelsChanged={onModelsChanged} />
          ) : runElsewhere ? (
            <>
              <p className="t-body text-gray-700 dark:text-gray-200">
                LU is already removing refusals from {runElsewhere.modelName}. One run at a time; this one can start when it is done.
              </p>
              <ModalActions>
                <ModalButton variant="quiet" onClick={close}>Close</ModalButton>
              </ModalActions>
            </>
          ) : (
            <PlanView path={path} onClose={close} />
          )}
        </div>
      )}
    </Modal>
  )
}

// ── Before the run ──────────────────────────────────────────────────────

function PlanView({ path, onClose }: { path: string; onClose: () => void }) {
  const setStatus = useAbliterateStore((s) => s.setStatus)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [repoInput, setRepoInput] = useState('')
  const [device, setDevice] = useState<string>('')
  const [mode, setMode] = useState<Mode>('balanced')
  const [trials, setTrials] = useState<100 | 200>(200)
  const [licenseOk, setLicenseOk] = useState(false)
  const [adult, setAdult] = useState(false)
  const [starting, setStarting] = useState(false)

  const lookUp = async (repo?: string) => {
    setLoading(true)
    setError(null)
    try {
      const p = await abliteratePlan(path, repo)
      setPlan(p)
      const usable = p.devices?.find((d) => d.device.supported && d.estimate.fits) ?? p.devices?.find((d) => d.device.supported) ?? p.devices?.[0]
      setDevice(usable?.device.id ?? '')
      if (p.source?.repo) setRepoInput(p.source.repo)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void lookUp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const chosen = useMemo(() => plan?.devices?.find((d) => d.device.id === device), [plan, device])
  const minutes = chosen ? (trials === 200 ? chosen.estimate : chosen.estimate100) : null

  const start = async () => {
    if (!plan?.source || !chosen) return
    setStarting(true)
    setError(null)
    try {
      const s = await abliterateStart({
        path,
        repo: plan.source.repo,
        revision: plan.source.revision,
        device: chosen.device.id,
        trials,
        mode,
        acceptLicense: licenseOk,
        adult,
      })
      setStatus(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  if (loading && !plan) {
    return (
      <p className="flex items-center gap-1.5 t-body text-gray-700 dark:text-gray-200">
        <Loader2 size={ICON_SM} className="animate-spin" /> Looking up the original model…
      </p>
    )
  }

  const repoField = (
    <div className="space-y-1.5">
      <label className="t-label text-gray-700 dark:text-gray-200" htmlFor="abl-repo">Original model on Hugging Face</label>
      <div className="flex gap-2">
        <input
          id="abl-repo"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          placeholder="Org/Model, for example Qwen/Qwen2.5-7B-Instruct"
          className="flex-1 min-w-0 rounded-lg border border-gray-200 dark:border-white/10 bg-transparent px-2.5 py-1.5 t-body text-gray-900 dark:text-white"
        />
        <ModalButton onClick={() => void lookUp(repoInput)} disabled={!repoInput.trim() || loading}>
          {loading ? 'Looking…' : 'Look up'}
        </ModalButton>
      </div>
    </div>
  )

  if (error && !plan?.source) {
    return (
      <>
        <p className={`t-body ${HINWEIS_TEXT.fehler}`}>{error}</p>
        {repoField}
        <ModalActions>
          <ModalButton variant="quiet" onClick={onClose}>Close</ModalButton>
        </ModalActions>
      </>
    )
  }
  if (!plan) return null

  if (plan.alreadyDone) {
    return (
      <>
        <p className="t-body text-gray-700 dark:text-gray-200">
          LU made this copy with refusals removed already. Run the tool on the original model instead.
        </p>
        <ModalActions>
          <ModalButton variant="quiet" onClick={onClose}>Close</ModalButton>
        </ModalActions>
      </>
    )
  }

  if (!plan.source) {
    return (
      <>
        <p className="t-body text-gray-700 dark:text-gray-200">
          The tool works on the original weights a model was made from, not on the GGUF file.
          This file does not say where those are. If you know the model, enter its Hugging Face name.
        </p>
        {repoField}
        <ModalActions>
          <ModalButton variant="quiet" onClick={onClose}>Close</ModalButton>
        </ModalActions>
      </>
    )
  }

  const src = plan.source
  const lic = plan.license!
  const est = chosen?.estimate
  const needsLicense = lic.kind === 'notice'
  const canStart = !!est?.fits && adult && (!needsLicense || licenseOk) && !starting && !!chosen?.device.supported

  return (
    <>
      <p className="t-body text-gray-700 dark:text-gray-200">
        LU makes a copy of <span className="text-gray-900 dark:text-white">{plan.model.name}</span> that refuses fewer requests.
        The original file stays as it is. It runs on this computer with Heretic {plan.heretic} and nothing is uploaded.
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 t-body">
        <dt className="t-label pt-0.5 text-gray-500 dark:text-gray-400">Original weights</dt>
        <dd className="text-gray-800 dark:text-gray-100 min-w-0">
          <button type="button" className="inline-flex items-center gap-1 hover:underline break-all text-left" onClick={() => void openExternal(`https://huggingface.co/${src.repo}`)}>
            {src.repo} <ExternalLink size={12} />
          </button>
          <span className="text-gray-500 dark:text-gray-400"> · {SOURCE_FROM[src.from] ?? ''}</span>
        </dd>
        <dt className="t-label pt-0.5 text-gray-500 dark:text-gray-400">Size</dt>
        <dd className="text-gray-800 dark:text-gray-100">{(src.params / 1e9).toFixed(1)}B parameters · {gb(src.downloadBytes)} to download</dd>
        <dt className="t-label pt-0.5 text-gray-500 dark:text-gray-400">License</dt>
        <dd className="text-gray-800 dark:text-gray-100">{lic.label}</dd>
      </dl>

      {plan.devices && plan.devices.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="t-label text-gray-700 dark:text-gray-200 mb-1">Run on</legend>
          {plan.devices.map((d) => (
            <label key={d.device.id} className={`flex items-start gap-2 t-body ${d.device.supported ? 'text-gray-800 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}>
              <input type="radio" name="abl-device" checked={device === d.device.id} disabled={!d.device.supported} onChange={() => setDevice(d.device.id)} />
              <span>
                {d.device.name}{d.device.memoryBytes ? ` · ${gb(d.device.memoryBytes)}` : ''}
                {d.device.note && <span className={`block t-micro ${HINWEIS_TEXT.ruhig}`}>{d.device.note}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {plan.devices && plan.devices.length === 0 && (
        <p className={`t-body ${HINWEIS_TEXT.fehler}`}>
          LU found no graphics device the tool can use. It runs on NVIDIA cards, on AMD cards under Linux and on Apple Silicon Macs.
        </p>
      )}

      <div className="space-y-1">
        <p className="t-label text-gray-700 dark:text-gray-200">How far</p>
        <div className="flex gap-1.5" role="radiogroup" aria-label="How far">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => setMode(m.id)}
              className={`lu-dialog-btn ${mode === m.id ? 'lu-primary' : 'lu-dialog-btn-secondary'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>{MODES.find((m) => m.id === mode)?.note}</p>
      </div>

      <div className="space-y-1">
        <p className="t-label text-gray-700 dark:text-gray-200">Search</p>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Search">
          {([200, 100] as const).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={trials === n}
              onClick={() => setTrials(n)}
              className={`lu-dialog-btn ${trials === n ? 'lu-primary' : 'lu-dialog-btn-secondary'}`}
            >
              {n === 200 ? 'Thorough · 200 trials' : 'Quick · 100 trials'}
            </button>
          ))}
        </div>
      </div>

      {est && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 t-body" data-testid="remove-refusals-needs">
          <dt className="t-label pt-0.5 text-gray-500 dark:text-gray-400">Time</dt>
          <dd className="text-gray-800 dark:text-gray-100">about {minutes ? minutesRange(minutes.minutesLow, minutes.minutesHigh) : '?'} on this machine, plus the download</dd>
          <dt className="t-label pt-0.5 text-gray-500 dark:text-gray-400">{chosen?.device.kind === 'apple' ? 'Memory' : 'Graphics memory'}</dt>
          <dd className="text-gray-800 dark:text-gray-100">
            about {gb(est.memoryNeededBytes)}{est.memoryAvailableBytes != null ? ` of ${gb(est.memoryAvailableBytes)} it can use` : ''}
            {est.quantization === 'bnb4bit' ? ' (loaded in 4 bit to fit)' : ''}
          </dd>
          <dt className="t-label pt-0.5 text-gray-500 dark:text-gray-400">Disk</dt>
          <dd className="text-gray-800 dark:text-gray-100">
            {gb(est.diskNeededBytes)} during the run, {gb(est.diskAfterBytes)} for the copy afterwards{est.diskFreeBytes != null ? ` · ${gb(est.diskFreeBytes)} free` : ''}
          </dd>
          <dt className="t-label pt-0.5 text-gray-500 dark:text-gray-400">Result</dt>
          <dd className="text-gray-800 dark:text-gray-100">
            {plan.model.name} (refusals removed), {plan.quantizeTool || ['Q8_0', 'F16', 'BF16'].includes(est.outputQuant) ? est.outputQuant : 'Q8_0'}, next to the original
          </dd>
        </dl>
      )}

      {est && !est.fits && (
        <p className={`t-body ${HINWEIS_TEXT.fehler}`} data-testid="remove-refusals-too-large">
          {est.whyNot}
          {est.whyNot?.startsWith('Too large') && plan.cloud && (
            <span className={`block t-micro ${HINWEIS_TEXT.ruhig}`}>
              {plan.cloud.allowed ? plan.cloud.note : 'A run in LU Cloud is only planned for models with an open license.'}
            </span>
          )}
        </p>
      )}

      <p className={`t-body ${HINWEIS_TEXT.ruhig}`}>{CLAIM}</p>
      <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>
        The chat model is unloaded while the run works. Before and after, LU asks both versions the same 100 short
        requests and 200 knowledge questions and shows you the counts; the questions and answers are not kept.
      </p>

      {needsLicense && (
        <div className="space-y-1">
          <p className="t-body text-gray-800 dark:text-gray-100">{lic.note}</p>
          {lic.link && (
            <button type="button" className="inline-flex items-center gap-1 t-body text-gray-600 dark:text-gray-300 hover:underline" onClick={() => void openExternal(lic.link!)}>
              Read the license <ExternalLink size={12} />
            </button>
          )}
          <label className="flex items-start gap-2 t-body text-gray-800 dark:text-gray-100">
            <input type="checkbox" checked={licenseOk} onChange={(e) => setLicenseOk(e.target.checked)} data-testid="remove-refusals-license" />
            <span>I have read the license and will stay within it.</span>
          </label>
        </div>
      )}
      <label className="flex items-start gap-2 t-body text-gray-800 dark:text-gray-100">
        <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} data-testid="remove-refusals-adult" />
        <span>I am 18 or older, and I am responsible for what I do with the copy.</span>
      </label>

      {error && <p className={`t-body ${HINWEIS_TEXT.fehler}`}>{error}</p>}

      <ModalActions>
        <ModalButton variant="quiet" onClick={onClose}>Cancel</ModalButton>
        <ModalButton variant="primary" onClick={() => void start()} disabled={!canStart} data-testid="remove-refusals-start">
          {starting ? 'Starting…' : 'Start'}
        </ModalButton>
      </ModalActions>
    </>
  )
}

// ── During and after ────────────────────────────────────────────────────

function RunView({ run, onClose, onUse, onModelsChanged }: { run: RunStatus } & Pick<Props, 'onUse' | 'onModelsChanged'> & { onClose: () => void }) {
  const setStatus = useAbliterateStore((s) => s.setStatus)
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (run.status === 'done') void onModelsChanged()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status])

  const dismiss = async (then?: () => void) => {
    setStatus(await abliterateDismiss())
    then?.()
  }

  const share = phaseShare(run)

  if (run.status === 'running') {
    return (
      <>
        <p className="t-title text-gray-900 dark:text-white">{run.modelName}</p>
        <div className="space-y-1.5" data-testid="remove-refusals-running">
          <p className="flex items-center gap-1.5 t-body text-gray-700 dark:text-gray-200">
            <Loader2 size={ICON_SM} className="animate-spin" /> {run.phaseLabel || 'Starting…'}
          </p>
          <div className="h-1 rounded-full bg-gray-200 dark:bg-white/[0.08] overflow-hidden">
            <div
              className="h-full rounded-full bg-lu-accent transition-[width]"
              style={{ width: share == null ? '0%' : `${Math.round(share * 100)}%` }}
            />
          </div>
          {run.bytes && run.total > 0 ? (
            // A download says what it has, how fast and how long, on the
            // face of the window: 3.0.8 showed an empty bar and "running for
            // 26 minutes" while PyTorch came down.
            <>
              <p className="t-body font-mono text-gray-800 dark:text-gray-100" data-testid="remove-refusals-download">{downloadLine(run)}</p>
              {run.elapsedSecs > 0 && <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>Running for {roughDuration(run.elapsedSecs)}</p>}
            </>
          ) : (
            <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>
              {stepText(run)}
              {run.elapsedSecs > 0 && `${stepText(run) ? ' · ' : ''}running for ${roughDuration(run.elapsedSecs)}`}
              {run.etaSecs != null && ` · about ${roughDuration(run.etaSecs)} left`}
            </p>
          )}
          {run.best && (
            <p className="t-body text-gray-800 dark:text-gray-100" data-testid="remove-refusals-best">
              Best so far: trial {run.best.trial}, {run.best.refusals}
              {run.prompts ? ` of ${run.prompts}` : ''} test prompts refused
              {run.baseRefusals != null ? ` (the original: ${run.baseRefusals})` : ''}, KL {run.best.kl.toFixed(2)}
            </p>
          )}
        </div>
        <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>You can close this window, the run goes on. Stop keeps what is done, and Start again carries on from there.</p>
        <LogToggle run={run} show={showLog} setShow={setShowLog} />
        <ModalActions>
          <ModalButton variant="quiet" onClick={onClose}>Close</ModalButton>
          <ModalButton variant="danger" onClick={() => void abliterateCancel().then(setStatus)}>Stop</ModalButton>
        </ModalActions>
      </>
    )
  }

  if (run.status === 'done' && run.result) {
    const r = run.result
    return (
      <>
        <p className="t-title text-gray-900 dark:text-white">{r.outputName}</p>
        <ResultTable r={r} />
        <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>
          Took {roughDuration(r.seconds)}. Saved as {r.quant} next to the original{r.quantNote ? `. ${r.quantNote}` : ''}.
          Refusals are counted by keywords, so evasive answers can slip through as answered.
        </p>
        <p className={`t-body ${HINWEIS_TEXT.ruhig}`}>{CLAIM}</p>
        {note && <p className={`t-body ${HINWEIS_TEXT.fehler}`}>{note}</p>}
        <ModalActions>
          {!r.discarded && (
            <ModalButton
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await abliterateTrashCopy(r.outputPath)
                  await onModelsChanged()
                  await dismiss(onClose)
                } catch (e) {
                  setNote(e instanceof Error ? e.message : String(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Move copy to {isWindows() ? 'Recycle Bin' : 'Trash'}
            </ModalButton>
          )}
          <ModalButton variant="secondary" onClick={() => void dismiss(onClose)}>Keep both</ModalButton>
          {!r.discarded && (
            <ModalButton
              variant="primary"
              disabled={busy}
              data-testid="remove-refusals-use"
              onClick={async () => {
                setBusy(true)
                try {
                  await dismiss(onClose)
                  await onUse(r.outputPath)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Use this model
            </ModalButton>
          )}
        </ModalActions>
      </>
    )
  }

  // failed or stopped
  return (
    <>
      <p className="t-title text-gray-900 dark:text-white">{run.modelName}</p>
      {run.status === 'failed' ? (
        <p className={`t-body ${HINWEIS_TEXT.fehler} whitespace-pre-wrap`} data-testid="remove-refusals-error">{run.error}</p>
      ) : (
        <p className="t-body text-gray-700 dark:text-gray-200">Stopped. What was done so far is kept; open the tool again to carry on.</p>
      )}
      <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>The original model was not changed.</p>
      <LogToggle run={run} show={showLog} setShow={setShowLog} />
      <ModalActions>
        <ModalButton variant="quiet" onClick={() => void dismiss(onClose)}>Close</ModalButton>
        <ModalButton variant="primary" onClick={() => void dismiss()}>Start again</ModalButton>
      </ModalActions>
    </>
  )
}

function stepText(run: RunStatus): string {
  if (!run.total) return ''
  if (run.bytes || run.phase === 'download' || run.phase === 'setup') return `${gb(run.step)} of ${gb(run.total)}`
  if (run.phase === 'trials') return `${run.step} of ${run.total} trials`
  if (run.phase === 'check_before' || run.phase === 'check_after') return `${run.step} of ${run.total} questions`
  if (run.phase === 'merge') return `part ${run.step} of ${run.total}`
  return `${run.step} of ${run.total}`
}

function LogToggle({ run, show, setShow }: { run: RunStatus; show: boolean; setShow: (v: boolean) => void }) {
  if (!run.logs.length) return null
  return (
    <div>
      <button type="button" className="t-micro text-gray-500 dark:text-gray-400 hover:underline" onClick={() => setShow(!show)}>
        {show ? 'Hide details' : 'Show details'}
      </button>
      {show && (
        <pre className="mt-1 t-micro text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-black/30 rounded-lg p-2 overflow-auto max-h-48 scrollbar-thin font-mono whitespace-pre-wrap">
          {run.logs.slice(-60).join('\n')}
        </pre>
      )}
    </div>
  )
}

function ResultTable({ r }: { r: RunRecord }) {
  const row = (label: string, a: string, b: string, hint?: string) => (
    <tr>
      <td className="pr-3 py-0.5 text-gray-600 dark:text-gray-300">
        {label}
        {hint && <span className={`block t-micro ${HINWEIS_TEXT.ruhig}`}>{hint}</span>}
      </td>
      <td className="pr-3 py-0.5 text-right font-mono text-gray-800 dark:text-gray-100">{a}</td>
      <td className="py-0.5 text-right font-mono text-gray-900 dark:text-white">{b}</td>
    </tr>
  )
  const of = (c: Check | null, k: 'refusals' | 'falseAlarms') => (c ? `${c[k]} of ${c.n}` : '–')
  const mmlu = (c: Check | null) => (c ? `${c.mmlu} of ${c.mmluN ?? c.n}` : '–')
  const verdict = r.before && r.after ? mmluVerdict(r.before, r.after) : null
  return (
    <table className="w-full t-body" data-testid="remove-refusals-result">
      <thead>
        <tr className="text-gray-500 dark:text-gray-400">
          <th className="text-left font-normal pb-1" />
          <th className="text-right font-normal pb-1 pr-3">Original</th>
          <th className="text-right font-normal pb-1">Copy</th>
        </tr>
      </thead>
      <tbody>
        {row('Refused requests', of(r.before, 'refusals'), of(r.after, 'refusals'), 'JailbreakBench, prompts the search never saw')}
        {row('Refused harmless requests', of(r.before, 'falseAlarms'), of(r.after, 'falseAlarms'))}
        {row('Knowledge check', mmlu(r.before), mmlu(r.after), verdict ? `MMLU questions answered right. ${verdict.text}` : 'MMLU questions answered right')}
        {row(
          'Refusals in the search',
          r.searchRefusalsBefore != null ? `${r.searchRefusalsBefore} of ${r.searchPrompts ?? '?'}` : '–',
          `${r.searchRefusalsAfter} of ${r.searchPrompts ?? '?'}`,
          `Trial ${r.trial} of ${r.trials}, KL ${r.kl.toFixed(2)} (0 is unchanged, above 0.5 is noticeable damage)`,
        )}
      </tbody>
    </table>
  )
}
