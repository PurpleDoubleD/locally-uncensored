/**
 * Install the embedding GGUF for the bundled embeddings server.
 *
 * Onboarding has done this since P5, but Document Chat could not: its only
 * install path was `ollama pull`, which is the wrong shop when the built-in
 * engine is the active backend. Someone who onboarded on the built-in engine
 * and skipped the embeddings step therefore had no way in from the panel.
 *
 * Same model, same destination and the same download store the progress UI
 * renders, so a file started here shows up exactly like an Onboarding one.
 */
import { ONBOARDING_EMBED_MODEL } from '../lib/constants'
import { BUILTIN_BACKEND_ID } from '../lib/onboarding-backend'
import { detectProviderModelPath, startModelDownloadToPath } from './discover'
import { startBundledEmbed } from './engine'
import { useDownloadStore } from '../stores/downloadStore'

export async function installBundledEmbedModel(
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  const destDir = await detectProviderModelPath(BUILTIN_BACKEND_ID)
  if (!destDir) throw new Error('Could not resolve the LU Engine models folder.')

  const { downloadUrl, filename, sizeGB } = ONBOARDING_EMBED_MODEL
  useDownloadStore.getState().setMeta(filename, downloadUrl, 'gguf', destDir)
  await startModelDownloadToPath(
    downloadUrl,
    destDir,
    filename,
    Math.round(sizeGB * 1_073_741_824),
  )
  useDownloadStore.getState().startPolling()

  const unsub = useDownloadStore.subscribe((s) => {
    const d = s.downloads[filename]
    if (d) onProgress?.(d.progress || 0, d.total || 0)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const poll = setInterval(() => {
        const d = useDownloadStore.getState().downloads[filename]
        if (d?.status === 'complete') { clearInterval(poll); resolve() }
        else if (d?.status === 'error') { clearInterval(poll); reject(new Error(d.error || 'Download failed')) }
      }, 500)
    })
  } finally {
    unsub()
  }

  // Boot it right away: the caller is about to embed, and a GGUF on disk with
  // no server behind it is the exact state this whole fix exists to end.
  await startBundledEmbed(`${destDir}/${filename}`)
  window.dispatchEvent(new CustomEvent('lu-models-refresh'))
}
