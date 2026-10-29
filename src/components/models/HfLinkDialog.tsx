import { useEffect, useState } from 'react'
import { fetchExternal } from '../../api/backend'
import { selectGgufFromTree, type HfTreeEntry } from '../../api/discover'
import type { DiscoverModel } from '../../api/model-bundles'
import {
  choiceForFile, defaultChoice, ggufChoicesFromTree, hfRepoPage, hfTreeApi, incompleteLabel, linkModel, sizeLabel,
  type HfLinkChoice, type HfModelLink,
} from '../../lib/hf-link'
import { log } from '../../lib/logger'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { useArmedAfter } from '../remote/RemotePairPrompt'

type Load =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; entries: HfTreeEntry[]; choices: HfLinkChoice[] }

interface Props {
  link: HfModelLink
  onCancel: () => void
  /** The user said yes. The entry goes through the same download as a card. */
  onConfirm: (model: DiscoverModel) => void
}

/**
 * The question a `locallyuncensored://open-model` link asks in Models,
 * Discover: this repository, this file, this size, download? Nothing starts
 * before the button, and the button waits a second after the question
 * changes, so a link fired while the user was clicking elsewhere cannot catch
 * that click.
 */
export function HfLinkDialog({ link, onCancel, onConfirm }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [picked, setPicked] = useState<string | null>(null)

  useEffect(() => {
    // A new link remounts the dialog (DiscoverModels keys it by the link),
    // so the state starts at loading without a reset here.
    let gone = false
    void (async () => {
      try {
        const entries = JSON.parse(await fetchExternal(hfTreeApi(link.repo))) as unknown
        if (gone) return
        if (!Array.isArray(entries)) {
          setLoad({ state: 'failed', message: 'Hugging Face has no public model repository under this name.' })
          return
        }
        const choices = ggufChoicesFromTree(entries)
        if (choices.length === 0) {
          setLoad({ state: 'failed', message: 'This repository has no GGUF model file. Locally Uncensored runs GGUF models.' })
          return
        }
        const named = link.file ? choiceForFile(choices, link.file) : defaultChoice(choices)
        if (!named) {
          setLoad({ state: 'failed', message: 'The repository has no model file under the name the link gives.' })
          return
        }
        setPicked(named.path)
        setLoad({ state: 'ready', entries: entries as HfTreeEntry[], choices })
      } catch (e) {
        log.warn('[hf-link] repository tree failed', { repo: link.repo, err: e })
        if (!gone) setLoad({ state: 'failed', message: 'Hugging Face could not be reached, or the repository is private or gated.' })
      }
    })()
    return () => { gone = true }
  }, [link.repo, link.file])

  const choice = load.state === 'ready' ? load.choices.find((c) => c.path === picked) ?? null : null
  const resolution = load.state === 'ready' && choice ? selectGgufFromTree(load.entries, link.repo, undefined, choice.path) : null
  const model = resolution ? linkModel(link.repo, resolution) : null
  const armed = useArmedAfter(`${link.repo}|${link.file ?? ''}|${picked ?? ''}|${load.state}`)

  return (
    <Modal open onClose={onCancel} title="Download from Hugging Face">
      <div className="space-y-3" data-testid="hf-link-dialog">
        <p className="t-body text-gray-700 dark:text-gray-200">
          <span className="t-mono break-all font-semibold text-gray-900 dark:text-white" data-testid="hf-link-repo">{link.repo}</span>
        </p>
        {load.state === 'loading' && <p className="t-micro text-gray-500">Reading the repository…</p>}
        {load.state === 'failed' && (
          <p role="alert" className="t-body text-gray-700 dark:text-gray-200" data-testid="hf-link-failed">{load.message}</p>
        )}
        {load.state === 'ready' && (
          <>
            {link.file ? null : (
              <label className="block t-micro text-gray-500">
                File
                <select
                  className="mt-1 w-full t-mono text-[0.72rem] rounded border border-gray-300 dark:border-white/15 bg-transparent p-1"
                  value={picked ?? ''}
                  onChange={(e) => setPicked(e.target.value)}
                  data-testid="hf-link-file-select"
                >
                  {load.choices.map((c) => (
                    <option key={c.path} value={c.path} disabled={!!c.incomplete}>
                      {c.path} · {c.quant ?? 'GGUF'} · {sizeLabel(c.bytes)}{c.incomplete ? ` · ${incompleteLabel(c.incomplete)}` : c.parts > 1 ? ` · ${c.parts} parts` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {choice && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 t-micro" data-testid="hf-link-facts">
                <dt className="text-gray-500">File</dt>
                <dd className="t-mono break-all text-gray-800 dark:text-gray-100" data-testid="hf-link-file">{choice.path}</dd>
                <dt className="text-gray-500">Quant</dt>
                <dd className="text-gray-800 dark:text-gray-100" data-testid="hf-link-quant">{choice.quant ?? 'not in the name'}</dd>
                <dt className="text-gray-500">Size</dt>
                <dd className="text-gray-800 dark:text-gray-100" data-testid="hf-link-size">
                  {sizeLabel(choice.bytes)}{choice.parts > 1 ? ` in ${choice.parts} parts` : ''}
                </dd>
                {choice.incomplete && (
                  <>
                    <dt className="text-gray-500">Parts</dt>
                    <dd role="alert" className="text-gray-800 dark:text-gray-100" data-testid="hf-link-incomplete">
                      Only {choice.incomplete.have} of {choice.incomplete.of} parts are on Hugging Face yet, and the model loads only with all of them. Try again later.
                    </dd>
                  </>
                )}
                {resolution?.imagePart && (
                  <>
                    <dt className="text-gray-500">Image input</dt>
                    <dd className="text-gray-800 dark:text-gray-100">
                      comes along{resolution.imagePart.sizeBytes ? ` (${sizeLabel(resolution.imagePart.sizeBytes)})` : ''}
                    </dd>
                  </>
                )}
              </dl>
            )}
            <p className="t-micro text-gray-500">
              From <span className="t-mono">{hfRepoPage(link.repo)}</span>. Check the model card and its license before you use it.
            </p>
          </>
        )}
        <ModalActions>
          <ModalButton variant="quiet" onClick={onCancel}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            disabled={!model || !armed || !!choice?.incomplete}
            onClick={() => { if (model) onConfirm(model) }}
          >
            {choice ? `Download (${sizeLabel(choice.bytes)})` : 'Download'}
          </ModalButton>
        </ModalActions>
      </div>
    </Modal>
  )
}
