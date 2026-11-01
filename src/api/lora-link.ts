/**
 * A LoRA from a pasted link: ask the host about it, then hand it to the
 * download path every other model file takes (progress, cancel, sha256 check
 * in Rust, `comfyui-model-downloaded` when it lands, which makes the LoRA
 * lists read their folder again).
 *
 * The rules live in `lib/lora-link.ts`. This module only fetches and starts.
 */
import { fetchExternal } from './backend'
import { startModelDownload, startModelDownloadToPath } from './discover'
import { useDownloadStore } from '../stores/downloadStore'
import { useModelSourceStore } from '../stores/modelSourceStore'
import {
  civitaiLoraFromModel,
  civitaiLoraFromVersionAnswer,
  hfLoraFromAnswers,
  hfTreeFolder,
  parseLoraLink,
  type LoraLinkInfo,
  type LoraLinkResult,
} from '../lib/lora-link'

/** `fetchExternal` in the app; tests pass stored answers. The second argument
 *  is the CivitAI key, which Rust sends as a header to a CivitAI host only. */
export type FetchText = (url: string, authToken?: string | null) => Promise<string>

export interface ResolveOptions {
  /** The CivitAI key from Settings, or nothing. Never put into a URL. */
  civitaiKey?: string | null
  /** civitai.com, or the mirror the user picked in the CivitAI search. */
  civitaiHost?: string
  fetchText?: FetchText
}

/** What a failed request says, with nothing of the request in it but the
 *  status. The URLs carry no key, but the sentence does not need them either. */
function requestError(host: 'CivitAI' | 'Hugging Face', err: unknown, keySet: boolean): string {
  const text = err instanceof Error ? err.message : String(err)
  const status = /HTTP (\d{3})/.exec(text)?.[1]
  if (status === '404') return `${host} does not know this ${host === 'CivitAI' ? 'model' : 'file'}. Check the link.`
  if (status === '401' || status === '403') {
    if (host === 'CivitAI') {
      return keySet
        ? 'CivitAI refused the request with your key. Check the key under Settings, AI Backends, CivitAI API key.'
        : 'CivitAI wants a key for this model. Set one under Settings, AI Backends, CivitAI API key.'
    }
    return 'Hugging Face refused the request. The repository may be gated or private: accept its terms on Hugging Face first.'
  }
  if (status === '429') return `${host} is limiting requests right now. Try again in a minute.`
  if (status) return `${host} answered with HTTP ${status}. Try again later.`
  return `${host} could not be reached. Check the internet connection and try again.`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Reads a pasted link and asks its host what is behind it. Never throws. */
export async function resolveLoraLink(input: string, opts: ResolveOptions = {}): Promise<LoraLinkResult> {
  const parsed = parseLoraLink(input)
  if (!parsed.ok) return parsed
  const fetchText = opts.fetchText ?? fetchExternal
  const ref = parsed.ref

  if (ref.kind === 'civitai') {
    const host = opts.civitaiHost || 'civitai.com'
    const key = opts.civitaiKey?.trim() || null
    const url = ref.versionId !== undefined && ref.modelId === undefined
      ? `https://${host}/api/v1/model-versions/${ref.versionId}`
      : `https://${host}/api/v1/models/${ref.modelId}`
    let text: string
    try {
      text = await fetchText(url, key)
    } catch (err) {
      return { ok: false, error: requestError('CivitAI', err, !!key) }
    }
    const answer = parseJson(text)
    if (answer === undefined) return { ok: false, error: 'CivitAI sent an answer LU cannot read. Try again later.' }
    return ref.modelId === undefined
      ? civitaiLoraFromVersionAnswer(answer, host)
      : civitaiLoraFromModel(answer, ref.versionId, host)
  }

  const repo = ref.repo.split('/').map(encodeURIComponent).join('/')
  const folder = hfTreeFolder(ref.path)
  const treeUrl = `https://huggingface.co/api/models/${repo}/tree/${encodeURIComponent(ref.rev)}${folder ? `/${folder.split('/').map(encodeURIComponent).join('/')}` : ''}`
  let infoText: string
  try {
    infoText = await fetchText(`https://huggingface.co/api/models/${repo}`, null)
  } catch (err) {
    return { ok: false, error: requestError('Hugging Face', err, false) }
  }
  const info = parseJson(infoText)
  if (info === undefined) return { ok: false, error: 'Hugging Face sent an answer LU cannot read. Try again later.' }
  // The folder listing gives size and digest. Without it the file still
  // downloads, only unchecked: a page that answers is enough to go on.
  let tree: unknown = null
  try {
    tree = parseJson(await fetchText(treeUrl, null)) ?? null
  } catch (err) {
    const msg = requestError('Hugging Face', err, false)
    if (/does not know/.test(msg)) return { ok: false, error: 'This file is not in the Hugging Face repository. Check the link.' }
    tree = null
  }
  return hfLoraFromAnswers(ref, info, tree)
}

/**
 * Starts the download. `destDir` is the Mac's LoRA folder; without it the
 * file goes to ComfyUI's models/loras. The record in the download store
 * carries the digest and size, so Retry and Resume check the same file.
 */
export async function startLoraLinkDownload(info: LoraLinkInfo, destDir?: string): Promise<void> {
  const store = useDownloadStore.getState()
  const extra = { expectedBytes: info.sizeBytes, sha256: info.sha256 }
  store.setMeta(info.filename, info.downloadUrl, 'loras', destDir, extra)
  // D1: the page the link pointed at, for Details in Models.
  useModelSourceStore.getState().record(info.filename, info.pageUrl)
  const answer = destDir
    ? await startModelDownloadToPath(info.downloadUrl, destDir, info.filename, info.sizeBytes, info.sha256)
    : await startModelDownload(info.downloadUrl, 'loras', info.filename, info.sizeBytes, info.sha256)
  if (answer?.status === 'exists') {
    // On disk already and the host confirmed the size: no transfer, so no
    // row would ever appear for the panel to follow.
    useDownloadStore.getState().markComplete(info.filename)
    return
  }
  if (answer?.status === 'error') throw new Error(answer.error || `${info.filename} could not be started.`)
  useDownloadStore.getState().startPolling()
}
