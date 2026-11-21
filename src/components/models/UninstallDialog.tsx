/**
 * C17: one dialog for every uninstall on the Models page.
 *
 * It opens on a request (a bundle from Get new, a row from Installed), reads
 * the disk, and shows the plan of lib/uninstall-plan.ts: every file that goes
 * with its size and place, every file that stays with the reason, and the
 * space that is freed. Only "Uninstall" deletes, and only the files in the
 * list marked to go. "Move to Trash" keeps a way back.
 */
import { getRetiredBundles } from '../../api/model-bundles'
import { useEffect, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { formatBytes } from '../../lib/formatters'
import {
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles,
  checkBundlesOnDisk, comfyModelInfo, deleteComfyModelFile, type ModelBundle,
} from '../../api/discover'
import { bundledModelDeletePlan, deleteBundledModel, stopBundledEngine } from '../../api/engine'
import { refreshComfyModels } from '../../api/comfyui'
import { useDownloadStore } from '../../stores/downloadStore'
import { useModelStore } from '../../stores/modelStore'
import {
  bundleUninstallPlan, bundlesWithFile, engineUninstallPlan, installedFileUninstallPlan, ollamaUninstallPlan,
  type FileOnDisk, type UninstallPlan,
} from '../../lib/uninstall-plan'

export type UninstallRequest =
  | { kind: 'bundle'; bundle: ModelBundle }
  | { kind: 'comfy-file'; name: string }
  | { kind: 'engine'; name: string; path: string; active: boolean }
  | { kind: 'ollama'; name: string; bytes: number }

interface Props {
  request: UninstallRequest | null
  onClose: () => void
  /** After the files are gone: the lists read the disk again. */
  onDone: () => Promise<void> | void
  /** Deletes an Ollama model through the model store. */
  removeOllamaModel?: (name: string) => Promise<void>
}

function allBundles(): ModelBundle[] {
  // The retired H3 records too: one H3 model must not take the encoder the
  // other one on disk still uses.
  return [...getImageBundles(), ...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles(), ...getUpscaleBundles(), ...getRetiredBundles()]
}

/** What the disk says about each file of the given bundles. */
async function filesOnDisk(names: readonly string[]): Promise<Map<string, FileOnDisk | null>> {
  const out = new Map<string, FileOnDisk | null>()
  await Promise.all([...new Set(names)].map(async (n) => {
    try {
      const f = await comfyModelInfo(n)
      out.set(n, { path: f.path, bytes: f.bytes, ownFolder: f.ownFolder, copies: f.copies })
    } catch {
      out.set(n, null)
    }
  }))
  return out
}

export async function buildUninstallPlan(request: UninstallRequest): Promise<UninstallPlan> {
  if (request.kind === 'engine') {
    const { files } = await bundledModelDeletePlan(request.path)
    return engineUninstallPlan(request.name, files)
  }
  if (request.kind === 'ollama') return ollamaUninstallPlan(request.name, request.bytes)
  const bundles = allBundles()
  const { installed } = await checkBundlesOnDisk(bundles)
  if (request.kind === 'bundle') {
    const disk = await filesOnDisk(request.bundle.files.map((f) => f.filename ?? '').filter(Boolean))
    return bundleUninstallPlan(request.bundle, bundles, installed, disk)
  }
  const owners = bundlesWithFile(request.name, bundles)
  const names = [request.name, ...owners.flatMap((b) => b.files.map((f) => f.filename ?? ''))].filter(Boolean)
  const disk = await filesOnDisk(names)
  return installedFileUninstallPlan(request.name, bundles, installed, disk)
}

type Phase =
  | { at: 'reading' }
  | { at: 'plan'; plan: UninstallPlan }
  | { at: 'working'; plan: UninstallPlan }
  | { at: 'done'; plan: UninstallPlan; freed: number; failed: string[]; trashed: boolean }
  | { at: 'error'; message: string }

/** One key per request object, so a new request starts the dialog's inner
 *  part from scratch (reading the disk again) without a reset in an effect. */
const requestKeys = new WeakMap<object, number>()
let nextKey = 1
function keyOf(request: UninstallRequest): number {
  let k = requestKeys.get(request)
  if (!k) { k = nextKey++; requestKeys.set(request, k) }
  return k
}

export function UninstallDialog(props: Props) {
  const { request } = props
  return request ? <UninstallBody key={keyOf(request)} {...props} request={request} /> : null
}

function UninstallBody({ request, onClose, onDone, removeOllamaModel }: Props & { request: UninstallRequest }) {
  const [phase, setPhase] = useState<Phase>({ at: 'reading' })
  const [toTrash, setToTrash] = useState(false)

  useEffect(() => {
    let live = true
    buildUninstallPlan(request)
      .then((plan) => { if (live) setPhase({ at: 'plan', plan }) })
      .catch((e) => { if (live) setPhase({ at: 'error', message: e instanceof Error ? e.message : String(e) }) })
    return () => { live = false }
  }, [request])

  const run = async (plan: UninstallPlan) => {
    setPhase({ at: 'working', plan })
    const failed: string[] = []
    let freed = 0
    const going = plan.files.filter((f) => f.action === 'delete')
    if (plan.kind === 'engine' && request.kind === 'engine') {
      try {
        // The loaded file is locked on Windows: the engine lets go of it first.
        if (request.active) await stopBundledEngine()
        const res = await deleteBundledModel(request.path, { trash: toTrash })
        freed = res.bytes
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e))
      }
    } else if (plan.kind === 'ollama' && removeOllamaModel) {
      try {
        await removeOllamaModel(plan.title)
        freed = plan.freeBytes
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e))
      }
    } else {
      for (const f of going) {
        try {
          const res = await deleteComfyModelFile(f.ref, { trash: toTrash })
          freed += res.bytes || f.bytes
          // Its row in the download list would claim the file is still there.
          useDownloadStore.getState().dismiss(f.ref)
          useModelStore.getState().removeInventoryModel(f.ref)
        } catch (e) {
          failed.push(`${f.label}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      await refreshComfyModels().catch(() => { /* the rescan is best effort */ })
      // The bundle cards of Get new ask the disk again on this event.
      window.dispatchEvent(new CustomEvent('comfyui-model-downloaded'))
    }
    await Promise.resolve(onDone()).catch(() => {})
    setPhase({ at: 'done', plan, freed, failed, trashed: toTrash })
  }

  const title = phase.at === 'plan' || phase.at === 'working' || phase.at === 'done' ? `Uninstall ${phase.plan.title}` : 'Uninstall'

  return (
    <Modal open onClose={() => { if (phase.at !== 'working') onClose() }} title={title} maxWidth="max-w-xl">
      <div data-testid="uninstall-dialog">
        {phase.at === 'reading' && (
          <p className="t-body text-gray-500 dark:text-gray-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Looking for the files of this model…</p>
        )}
        {phase.at === 'error' && (
          <>
            <p role="alert" className="t-body text-red-500 dark:text-red-400">{phase.message}</p>
            <ModalActions><ModalButton onClick={onClose}>Close</ModalButton></ModalActions>
          </>
        )}
        {(phase.at === 'plan' || phase.at === 'working') && (() => {
          const { plan } = phase
          const going = plan.files.filter((f) => f.action === 'delete')
          const kept = plan.files.filter((f) => f.action === 'keep')
          return (
            <>
              {going.length === 0 ? (
                <p className="t-body text-gray-700 dark:text-gray-200">Nothing of this model can be removed here.{kept.length === 0 ? ' Its files are not on this disk.' : ''}</p>
              ) : (
                <p className="t-body text-gray-700 dark:text-gray-200" data-testid="uninstall-summary">
                  {going.length === 1 ? 'This file goes' : `These ${going.length} files go`}, and <span className="font-semibold text-gray-900 dark:text-white tabular-nums">{formatBytes(plan.freeBytes)}</span> {toTrash ? 'move to the Trash' : 'are freed'}:
                </p>
              )}
              <ul className="mt-2 space-y-1 max-h-60 overflow-y-auto scrollbar-thin pr-1" data-testid="uninstall-files">
                {going.map((f) => (
                  <li key={f.ref} className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-white/10" data-testid="uninstall-file-delete">
                    <Trash2 size={12} className="mt-0.5 shrink-0 text-gray-400" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-gray-900 dark:text-gray-100 truncate">{f.label}</span>
                      {f.path && <span className="block t-micro font-mono text-gray-500 dark:text-gray-400 break-all">{f.path}</span>}
                    </span>
                    {f.bytes > 0 && <span className="t-micro tabular-nums text-gray-500 dark:text-gray-400 shrink-0">{formatBytes(f.bytes)}</span>}
                  </li>
                ))}
              </ul>
              {kept.length > 0 && (
                <>
                  <p className="t-micro text-gray-500 dark:text-gray-400 mt-3 mb-1">Stays on the disk:</p>
                  <ul className="space-y-1" data-testid="uninstall-files-kept">
                    {kept.map((f) => (
                      <li key={f.ref} className="px-2.5 py-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.03]" data-testid="uninstall-file-keep">
                        <span className="block text-xs text-gray-700 dark:text-gray-300 truncate">{f.label}{f.bytes > 0 ? ` · ${formatBytes(f.bytes)}` : ''}</span>
                        <span className="block t-micro text-gray-500 dark:text-gray-400">{f.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {plan.note && <p className="t-micro text-gray-600 dark:text-gray-300 mt-3">{plan.note}</p>}
              {plan.kind !== 'ollama' && going.length > 0 && (
                <label className="flex items-center gap-2 mt-3 t-micro text-gray-700 dark:text-gray-200">
                  <input type="checkbox" checked={toTrash} onChange={(e) => setToTrash(e.target.checked)} disabled={phase.at === 'working'} data-testid="uninstall-to-trash" />
                  Move to the Trash instead, so they can be put back. The space is freed when the Trash is emptied.
                </label>
              )}
              <ModalActions>
                <ModalButton variant="quiet" onClick={onClose} disabled={phase.at === 'working'}>Cancel</ModalButton>
                {going.length > 0 && (
                  <ModalButton variant="danger" onClick={() => { void run(plan) }} disabled={phase.at === 'working'} data-testid="uninstall-confirm">
                    {phase.at === 'working' ? 'Uninstalling…' : `Uninstall (${formatBytes(plan.freeBytes)})`}
                  </ModalButton>
                )}
              </ModalActions>
            </>
          )
        })()}
        {phase.at === 'done' && (
          <>
            {phase.failed.length === 0 ? (
              <p className="t-body text-gray-700 dark:text-gray-200" data-testid="uninstall-done">
                {phase.plan.title} is uninstalled. {formatBytes(phase.freed)} {phase.trashed ? 'moved to the Trash.' : 'freed.'}
              </p>
            ) : (
              <>
                <p className="t-body text-gray-700 dark:text-gray-200">{phase.freed > 0 ? `${formatBytes(phase.freed)} ${phase.trashed ? 'moved to the Trash' : 'freed'}, but not everything could go:` : 'Nothing could be removed:'}</p>
                <ul className="mt-2 space-y-1">
                  {phase.failed.map((m) => <li key={m} role="alert" className="t-micro text-red-500 dark:text-red-400 break-words">{m}</li>)}
                </ul>
              </>
            )}
            <ModalActions><ModalButton onClick={onClose}>Close</ModalButton></ModalActions>
          </>
        )}
      </div>
    </Modal>
  )
}
