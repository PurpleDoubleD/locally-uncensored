/**
 * The Details dialog of a CivitAI hit.
 *
 * C18 (T1, 30.10.2026): the description was cut to 120 characters when the
 * hit was read, so the trigger words, the recommended settings and the
 * warnings the author wrote were nowhere in the app. The whole text stands
 * here now, as plain paragraphs (never CivitAI's HTML).
 *
 * C21 (Discord, 31.10. and 01.11.2026): Download always took the newest
 * version and its first file. A LoRA for another base model, an older version
 * that worked better, or the fp16 file instead of the fp32 one could not be
 * had. Here every version and its model files can be picked, with size and
 * CivitAI's own words for the precision.
 */
import { useMemo, useState } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { formatBytes, formatCount } from '../../lib/formatters'
import { openExternal } from '../../api/backend'
import type { CivitAIModelResult, CivitaiFileChoice, CivitaiVersionChoice } from '../../api/discover'

interface Props {
  hit: CivitAIModelResult | null
  onClose: () => void
  /** Starts the download of the picked file. */
  onDownload: (version: CivitaiVersionChoice, file: CivitaiFileChoice) => void
}

/** "fp16 · pruned · SafeTensor", from what CivitAI says about the file. */
export function civitaiFileWords(f: CivitaiFileChoice): string {
  return [f.fp, f.size, f.format].filter(Boolean).join(' · ')
}

export function CivitaiHitDetails({ hit, onClose, onDownload }: Props) {
  return (
    <Modal open={!!hit} onClose={onClose} title={hit?.name ?? 'Details'} maxWidth="max-w-2xl">
      {hit && <Body key={hit.id} hit={hit} onClose={onClose} onDownload={onDownload} />}
    </Modal>
  )
}

function Body({ hit, onClose, onDownload }: { hit: CivitAIModelResult; onClose: () => void; onDownload: Props['onDownload'] }) {
  const versions = useMemo(() => hit.versions ?? [], [hit.versions])
  const [versionId, setVersionId] = useState<number | undefined>(() => hit.versionId ?? versions[0]?.id)
  const version = versions.find((v) => v.id === versionId) ?? versions[0]
  // The file the default download takes: the primary one, else the first.
  const defaultFile = (v: CivitaiVersionChoice | undefined) => v?.files.find((f) => f.primary)?.name ?? v?.files[0]?.name
  const [fileName, setFileName] = useState<string | undefined>(() => defaultFile(version))
  const file = version?.files.find((f) => f.name === fileName) ?? version?.files[0]

  return (
    <div className="space-y-3" data-testid="civitai-details">
      <div className="flex items-center gap-2 flex-wrap t-micro text-gray-500 dark:text-gray-400">
        <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5">{hit.type === 'LORA' ? 'LoRA' : hit.type}</span>
        {hit.creator && <span>by {hit.creator}</span>}
        {hit.stats && <span>{formatCount(hit.stats.downloads)} downloads</span>}
      </div>

      {hit.fullDescription ? (
        <div
          className="t-body leading-relaxed text-gray-700 dark:text-gray-200 whitespace-pre-line max-h-64 overflow-y-auto scrollbar-thin pr-1"
          data-testid="civitai-full-description"
        >
          {hit.fullDescription}
        </div>
      ) : (
        <p className="t-micro text-gray-500 dark:text-gray-400">The author wrote no description.</p>
      )}

      {versions.length > 0 && version && (
        <div className="space-y-2 pt-1">
          <label className="flex items-center gap-2 t-label text-gray-700 dark:text-gray-200">
            Version
            <select
              className="lu-control"
              value={version.id}
              onChange={(e) => {
                const next = versions.find((v) => v.id === Number(e.target.value))
                setVersionId(next?.id)
                setFileName(defaultFile(next))
              }}
              data-testid="civitai-version"
            >
              {versions.map((v, i) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.baseModel ? ` · ${v.baseModel}` : ''}{v.published ? ` · ${v.published}` : ''}{i === 0 ? ' (newest)' : ''}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="space-y-1" data-testid="civitai-files">
            <legend className="t-micro text-gray-500 dark:text-gray-400 mb-1">
              {version.files.length > 1 ? 'Files of this version. Pick the one you want.' : 'File of this version'}
            </legend>
            {version.files.map((f) => (
              <label
                key={f.name}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-white/10 cursor-pointer has-[:checked]:border-gray-400 dark:has-[:checked]:border-white/30"
              >
                <input type="radio" name={`civitai-file-${hit.id}`} checked={file?.name === f.name} onChange={() => setFileName(f.name)} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-xs text-gray-900 dark:text-gray-100 font-mono">{f.name}</span>
                  <span className="block t-micro text-gray-500 dark:text-gray-400">
                    {[civitaiFileWords(f), f.primary ? 'default' : ''].filter(Boolean).join(' · ') || 'model file'}
                  </span>
                </span>
                {f.sizeBytes ? <span className="t-micro tabular-nums text-gray-500 dark:text-gray-400 shrink-0">{formatBytes(f.sizeBytes)}</span> : null}
              </label>
            ))}
          </fieldset>
        </div>
      )}
      {versions.length === 0 && (
        <p className="t-micro text-gray-500 dark:text-gray-400">CivitAI lists no safetensors or GGUF file for this model, so LU offers no file choice for it.</p>
      )}

      <ModalActions>
        <ModalButton variant="quiet" onClick={() => openExternal(hit.sourceUrl)}>
          <ExternalLink size={12} className="inline mr-1" /> View on CivitAI
        </ModalButton>
        {version && file && (
          <ModalButton
            variant="primary"
            data-testid="civitai-download-picked"
            onClick={() => { onDownload(version, file); onClose() }}
          >
            <Download size={12} className="inline mr-1" /> Download {file.sizeBytes ? `(${formatBytes(file.sizeBytes)})` : ''}
          </ModalButton>
        )}
      </ModalActions>
    </div>
  )
}
