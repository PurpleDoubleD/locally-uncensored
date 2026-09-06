/**
 * Schritt „Documents": das kleine Einbettungsmodell fuer Dokumenten-Chat.
 *
 * Warum es dieses Modul gibt: die fuenf Zustaende dieses Bildschirms (laeuft,
 * fertig, Fehler, Fortschritt, „hat der Nutzer schon eins?") liest nach ihm
 * niemand mehr — er gibt nach aussen nur `setStep('done')`. Er ist damit,
 * neben dem ComfyUI-Schritt, der zweite wirklich geschlossene Schnitt in
 * diesem Assistenten.
 *
 * Die eine Frage, die er NICHT selbst beantworten kann, ist `embedsViaBundled`:
 * ob die Einbettungen ueber den mitgelieferten Server oder ueber Ollama
 * laufen, haengt an der Maschine, die im Backend-Schritt gewaehlt wurde. Die
 * kommt aus `useBackendScan`, und `isReady(ollama)` aus der Installer-Flotte —
 * beides Zustand der Schale, hier nur gelesen.
 *
 * Warum das Warten auf den Download aus `./wait-for-download` kommt und nicht
 * hier steht: der Modellschritt braucht dasselbe, aus demselben Grund (erst
 * wenn die Datei ganz da ist, darf ein Server darauf starten).
 *
 * `step` faehrt als Prop mit: der Effekt, der nach einem vorhandenen
 * Einbettungsmodell sucht, haengt daran und steht hier unveraendert.
 */
import { useState, useEffect } from 'react'
import { Check, Download, ArrowRight, ChevronRight } from 'lucide-react'
import { ONBOARDING_EMBED_MODEL } from '../../lib/constants'
import { useDownloadStore } from '../../stores/downloadStore'
import { detectProviderModelPath, startModelDownloadToPath } from '../../api/discover'
import { pullModelTauri, checkConnection as checkOllama } from '../../api/ollama'
import { startBundledEmbed } from '../../api/engine'
import { backendCall } from '../../api/backend'
import { BUILTIN_BACKEND_ID, classifyOnboardingBackend, resolveOnboardingBackend } from '../../lib/onboarding-backend'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'
import { isReady } from './installer-state'
import { awaitDownloadComplete } from './wait-for-download'
import { isTauri } from './onboarding-host'
import type { Step } from './wizard-steps'
import type { OnboardingSkin } from './onboarding-skin'
import type { BackendScan } from './use-backend-scan'
import type { InstallerFleet } from './use-installer-fleet'

interface EmbeddingsStepProps {
  skin: OnboardingSkin
  scan: BackendScan
  fleet: InstallerFleet
  step: Step
  setStep: (step: Step) => void
}

export function EmbeddingsStep({ skin, scan, fleet, step, setStep }: EmbeddingsStepProps) {
  const { isDark, cardClass, primaryBtn, secondaryBtn } = skin
  const { selectedBackend, detectedBackends } = scan
  const { ollama } = fleet
  const dlStore = useDownloadStore

  // ── nomic-embed-text install state (GH #45, leonsk29 2026-05-23) ─────
  // The Document Chat / RAG feature needs an embedding model. We default
  // to `nomic-embed-text` — small (~274 MB), broadly supported. The step
  // auto-skips when the user already has any embedding model installed
  // (covers LM Studio users who came in via that backend with their own
  // embedding model, and Ollama users who already pulled one).
  const [embeddingsPulling, setEmbeddingsPulling] = useState(false)
  const [embeddingsPulled, setEmbeddingsPulled] = useState(false)
  const [embeddingsError, setEmbeddingsError] = useState<string | null>(null)
  const [embeddingsProgress, setEmbeddingsProgress] = useState<{ completed: number; total: number }>({ completed: 0, total: 0 })
  const [embeddingsAlreadyHave, setEmbeddingsAlreadyHave] = useState<boolean | null>(null)

  // Embeddings route on the CHOSEN backend, not isManagedBuiltinActive():
  // rag.ts only ever queries the bundled embeddings server or Ollama — never
  // an LM-Studio-style /v1/embeddings — so openai-compat backends must take
  // the bundled path too. Branching on isManagedBuiltinActive() dead-ended
  // LM Studio users on a machine that has no Ollama by explicit choice.
  const embedsViaBundled =
    classifyOnboardingBackend(resolveOnboardingBackend(selectedBackend, isReady(ollama), detectedBackends)) !== 'ollama'

  // Probe whether an embedding model is already present. For the built-in
  // engine (P5) and openai-compat backends we scan the app models dir via
  // list_bundled_models; only Ollama lists its pulled models. Either way we
  // match anything with `embed`/`bge`/`nomic` in the name (same heuristic
  // used elsewhere).
  useEffect(() => {
    if (step !== 'embeddings') return
    let cancelled = false
    const isEmbed = (name: string) => {
      const lower = (name || '').toLowerCase()
      return lower.includes('embed') || lower.includes('bge-') || lower.includes('nomic')
    }
    const probe = embedsViaBundled
      ? import('../../api/engine').then(({ listBundledModels }) =>
          listBundledModels().then(models => models.some(m => isEmbed(m.name))))
      : import('../../api/ollama').then(({ listModels }) =>
          listModels().then(models => models.some(m => isEmbed(m.name))))
    probe
      .then(hasEmbedding => { if (!cancelled) setEmbeddingsAlreadyHave(hasEmbedding) })
      .catch(() => { if (!cancelled) setEmbeddingsAlreadyHave(false) })
    return () => { cancelled = true }
  }, [step, embedsViaBundled])

  const handlePullEmbeddings = async () => {
    if (!isTauri) {
      setEmbeddingsError('Embedding install requires the desktop app. Running in a browser preview.')
      return
    }
    setEmbeddingsPulling(true)
    setEmbeddingsError(null)
    setEmbeddingsProgress({ completed: 0, total: 0 })

    // P5: bundled-engine path — download the embedding GGUF flat into the app
    // models dir and boot the embeddings server on it. No Ollama involved, so
    // Document-Chat/RAG works on a fresh install with zero external provider.
    // Taken for the built-in engine AND openai-compat backends (LM Studio
    // etc.) — see embedsViaBundled above.
    if (embedsViaBundled) {
      try {
        const destDir = await detectProviderModelPath(BUILTIN_BACKEND_ID)
        if (!destDir) throw new Error('Could not resolve the LU Engine models folder.')
        const { downloadUrl, filename, sizeGB } = ONBOARDING_EMBED_MODEL
        dlStore.getState().setMeta(filename, downloadUrl, 'gguf', destDir)
        const expectedBytes = sizeGB ? Math.round(sizeGB * 1_073_741_824) : undefined
        await startModelDownloadToPath(downloadUrl, destDir, filename, expectedBytes)
        dlStore.getState().startPolling()
        // Mirror the store's completed/total into the step's progress UI.
        const unsub = useDownloadStore.subscribe(s => {
          const d = s.downloads[filename]
          if (d) setEmbeddingsProgress({ completed: d.progress || 0, total: d.total || 0 })
        })
        try {
          await awaitDownloadComplete(filename)
        } finally {
          unsub()
        }
        await startBundledEmbed(`${destDir}/${filename}`)
        setEmbeddingsPulled(true)
        window.dispatchEvent(new CustomEvent('lu-models-refresh'))
      } catch (e) {
        setEmbeddingsError(`Embedding setup failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setEmbeddingsPulling(false)
      }
      return
    }

    try {
      // Make sure ollama is reachable before kicking off the pull.
      let ok = await checkOllama()
      if (!ok) {
        try { await backendCall('start_ollama') } catch { /* fall through */ }
        for (let i = 0; i < 20 && !ok; i++) {
          await new Promise(r => setTimeout(r, 250))
          ok = await checkOllama()
        }
      }
      if (!ok) {
        setEmbeddingsError('Cannot reach Ollama (localhost:11434). Start Ollama and retry.')
        setEmbeddingsPulling(false)
        return
      }
      const { promise } = pullModelTauri('nomic-embed-text', (p) => {
        setEmbeddingsProgress({ completed: p.completed || 0, total: p.total || 0 })
      })
      await promise
      setEmbeddingsPulled(true)
      // Same refresh event chat/picker components listen on.
      window.dispatchEvent(new CustomEvent('lu-models-refresh'))
    } catch (e) {
      setEmbeddingsError(`Pull failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setEmbeddingsPulling(false)
    }
  }

  return (
    <>
      <div className="text-center mb-2">
        <h2 className="text-base font-semibold mb-1">Document Chat (optional)</h2>
        <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          Drop a PDF, Word doc, or text file into chat and the model can answer questions about it. Needs a small embedding model.
        </p>
      </div>

      {embeddingsAlreadyHave === true && !embeddingsPulled && (
        <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'}`}>
          <div className="flex items-center gap-2 justify-center">
            <Check size={14} className="text-green-400" />
            <span className="text-[0.7rem] font-medium">Embedding model already installed, Document Chat is ready.</span>
          </div>
        </div>
      )}

      {embeddingsAlreadyHave !== true && (
        <div className={`p-3 rounded-lg border ${cardClass}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-[0.7rem] font-medium">nomic-embed-text</p>
              <p className={`text-[0.6rem] mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Standard embedding model from Nomic AI. Used purely on-device to chunk and retrieve your documents, never sent anywhere.
              </p>
              <p className={`text-[0.55rem] mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {embedsViaBundled ? '84 MB · bundled engine, runs on any CPU' : '274 MB · runs on any CPU'}
              </p>
            </div>
          </div>

          {embeddingsPulling && (
            <div className="mt-2.5 space-y-1">
              <ProgressBar progress={embeddingsProgress.total > 0 ? (embeddingsProgress.completed / embeddingsProgress.total) * 100 : 0} />
              <p className={`text-[0.55rem] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {embeddingsProgress.total > 0
                  ? `${formatBytes(embeddingsProgress.completed)} / ${formatBytes(embeddingsProgress.total)}`
                  : 'Starting…'}
              </p>
            </div>
          )}

          {embeddingsPulled && (
            <div className="mt-2.5 flex items-center gap-2 text-[0.65rem] text-green-400">
              <Check size={12} /> Installed. Document Chat is ready.
            </div>
          )}

          {embeddingsError && (
            <p className="text-[0.6rem] text-red-400 mt-2">{embeddingsError}</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {embeddingsAlreadyHave !== true && !embeddingsPulled && !embeddingsPulling && (
          <button onClick={handlePullEmbeddings} className={primaryBtn} style={{ flex: 1 }}>
            <Download size={14} /> Install nomic-embed-text ({embedsViaBundled ? '84 MB' : '274 MB'})
          </button>
        )}
        <button
          onClick={() => setStep('done')}
          disabled={embeddingsPulling}
          className={`${secondaryBtn} ${embeddingsPulling ? 'opacity-40 cursor-not-allowed' : ''}`}
          style={{ flex: embeddingsAlreadyHave === true || embeddingsPulled ? 1 : undefined }}
        >
          {embeddingsAlreadyHave === true || embeddingsPulled ? (
            <>Continue <ArrowRight size={14} /></>
          ) : (
            <>Skip for now <ChevronRight size={14} /></>
          )}
        </button>
      </div>
    </>
  )
}
