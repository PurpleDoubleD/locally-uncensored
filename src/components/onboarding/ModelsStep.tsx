/**
 * Schritt „Model": ein Modell aussuchen. Entweder eins herunterladen und
 * dorthin schreiben, wo die gewaehlte Maschine es auch findet, oder eins der
 * schon installierten zum aktiven Chatmodell machen.
 *
 * Dieser Bildschirm wird NIE uebersprungen. Er hat es bis zum 04.09.2026
 * getan, sobald `/api/tags` ein chatfaehiges Modell meldete, und genau das
 * war der Fehler: die Wahl fiel dann nicht mehr im Assistenten, sondern in
 * `modelStore.setModels`, das ohne Wahl den ERSTEN Eintrag der Liste nimmt.
 * Der Nutzer stand im Chat vor einem Modell, das er nie angefasst hatte.
 *
 * Warum es dieses Modul gibt: die Auswahl, der laufende Pull, der HF-Pfad,
 * der Fehlertext, die Unterreiter und die VRAM-Schranke sind Zustand, den
 * nach diesem Bildschirm niemand mehr anfasst. Was ihn ueberlebt, ist genau
 * EINE Liste — `pulledModels`, weil der Schlussbildschirm sie zaehlt („2
 * models installed"). Sie liegt deshalb in der Schale und kommt als Prop
 * herein; alles andere bleibt hier.
 *
 * Der Kern des Bildschirms ist nicht die Kachelliste, sondern
 * `handleDownloadSelected`: dieselbe GGUF geht je nach gewaehlter Maschine
 * drei verschiedene Wege (Ollama-Pull, flach in den App-Ordner mit
 * anschliessendem Motorstart, oder `<user>/<repo>/`-Verschachtelung fuer LM
 * Studio). Welche Maschine das ist, weiss der Scan (`useBackendScan`) — nicht
 * dieser Schritt.
 *
 * `step` faehrt als Prop mit: der Effekt, der die installierten Modelle holt,
 * haengt daran. Die WAHL dagegen liegt nicht hier und nicht in der Schale,
 * sondern in `modelStore.activeModel`, also an der Stelle, die der Chat
 * liest.
 */
import { useState, useEffect } from 'react'
import { Check, Download, ChevronRight } from 'lucide-react'
import { ONBOARDING_MODELS } from '../../lib/constants'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useDownloadStore } from '../../stores/downloadStore'
import { useModelStore } from '../../stores/modelStore'
import { detectProviderModelPath, startModelDownloadToPath, luEngineDownloadDir } from '../../api/discover'
import { hfUrlToOllamaRef, hfUrlToLmStudioSubdir } from '../../lib/hf-to-provider'
import { pullModelTauri, checkConnection as checkOllama } from '../../api/ollama'
import { activateBuiltinModel } from '../../api/engine'
import { builtinModelNameFromPath } from '../../lib/builtin-model-identity'
import { bundledPickerIdForFile } from '../../lib/bundled-download-activation'
import { backendCall } from '../../api/backend'
import { getSystemVRAM } from '../../api/comfyui'
import { classifyOnboardingBackend, resolveOnboardingBackend } from '../../lib/onboarding-backend'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'
import { isReady } from './installer-state'
import { awaitDownloadComplete } from './wait-for-download'
import { isTauri } from './onboarding-host'
import type { Step } from './wizard-steps'
import type { OnboardingSkin } from './onboarding-skin'
import type { BackendScan } from './use-backend-scan'
import type { InstallerFleet } from './use-installer-fleet'

interface ModelsStepProps {
  skin: OnboardingSkin
  scan: BackendScan
  fleet: InstallerFleet
  step: Step
  setStep: (step: Step) => void
  /** Ueberlebt diesen Schritt: der Schlussbildschirm zaehlt sie. */
  pulledModels: string[]
  setPulledModels: (update: (prev: string[]) => string[]) => void
}

export function ModelsStep({ skin, scan, fleet, step, setStep, pulledModels, setPulledModels }: ModelsStepProps) {
  const { isDark, cardClass, secondaryBtn } = skin
  const { selectedBackend, detectedBackends } = scan
  const { ollama } = fleet
  const downloads = useDownloadStore(s => s.downloads)
  const dlStore = useDownloadStore

  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [pullingModel, setPullingModel] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [systemVRAM, setSystemVRAM] = useState<number | null>(null)
  // Default the active sub-tab to whichever category actually has entries.
  // The previous fixed 'uncensored' default broke the onboarding starter card
  // entirely once P4 trimmed ONBOARDING_MODELS down to a single mainstream
  // entry (Qwen 2.5 0.5B): the tab switcher hides itself when only one
  // category is populated, but the filter at render time still rejected every
  // mainstream model — leaving the user on an empty list with only "Skip for
  // now". This computed initial value keeps the switcher useful when both
  // categories grow back, while making the single-entry case actually show
  // the entry.
  const initialSubTab: 'uncensored' | 'mainstream' = ONBOARDING_MODELS.some(m => m.uncensored)
    ? 'uncensored'
    : 'mainstream'
  const [modelSubTab, setModelSubTab] = useState<'uncensored' | 'mainstream'>(initialSubTab)

  const toggleModel = (name: string) => {
    setSelectedModels((prev) =>
      prev.includes(name) ? prev.filter((m) => m !== name) : [...prev, name]
    )
  }

  const handleDownloadSelected = async () => {
    setDownloadError(null)
    const providers = useProviderStore.getState().providers

    // Decide which backend the download has to feed. selectedBackend (set in
    // the backends step) is the strongest signal; isReady(ollama) covers the
    // "we just installed Ollama in-app" path; final fallback is the first
    // detected backend, defaulting to ollama. The earlier code wrote a raw
    // .gguf into `~/.ollama/models` regardless — Ollama ignores files placed
    // there directly, which is the root cause of the "downloaded model
    // never appears" bug reported on Discord and GH discussion #35.
    const targetBackend = resolveOnboardingBackend(selectedBackend, isReady(ollama), detectedBackends)
    const kind = classifyOnboardingBackend(targetBackend)
    const useBuiltinPath = kind === 'builtin'
    const useOllamaPath = kind === 'ollama'

    // Sanity-check / auto-start Ollama before pulling. The pull command will
    // otherwise spin in "connecting" with no actionable error if the daemon
    // isn't reachable.
    if (useOllamaPath && isTauri) {
      let ok = await checkOllama()
      if (!ok) {
        try { await backendCall('start_ollama') } catch { /* fall through to retry loop */ }
        for (let i = 0; i < 20 && !ok; i++) {
          await new Promise(r => setTimeout(r, 250))
          ok = await checkOllama()
        }
      }
      if (!ok) {
        setDownloadError('Cannot reach Ollama (localhost:11434). Open the Ollama app or run `ollama serve`, then retry.')
        return
      }
    }

    // Direct-write providers (built-in engine, LM Studio etc.) need a base dir.
    // The built-in engine has a dedicated, app-owned models dir resolved by the
    // Rust side (detect_model_path("builtin")); other OpenAI-compat providers
    // reuse the LM-Studio-style detection / user override.
    let destDir: string | null = null
    if (useBuiltinPath) {
      destDir = await luEngineDownloadDir()
      if (!destDir) {
        setDownloadError('Could not create the LU Engine model folder. Check app permissions and retry.')
        return
      }
    } else if (!useOllamaPath) {
      const settingsOverride = useSettingsStore.getState().settings.hfDownloadPathOverride?.trim() || ''
      // `hfModelPath` stand hier als Zwischenspeicher fuer die Erkennung —
      // ein `useState`, das nur ein zweiter Klick auf „Install" in derselben
      // Sitzung je gelesen haette, um sich EINEN Rust-Aufruf zu sparen. Die
      // Erkennung ist idempotent und billig; der Zustand ist weg (AS-09
      // zaehlt die `useState` des Ordners).
      destDir = settingsOverride || (await detectProviderModelPath(providers.openai?.name || 'LM Studio'))
      if (!destDir) {
        setDownloadError('Could not determine model directory. Please check app permissions, or set a custom path in Settings → Models.')
        return
      }
    }

    for (const name of selectedModels) {
      if (pulledModels.includes(name)) continue
      const model = ONBOARDING_MODELS.find(m => m.name === name)
      if (!model?.downloadUrl || !model?.filename) continue

      setPullingModel(name)
      try {
        if (useOllamaPath) {
          // Ollama: HF URL → `hf.co/<user>/<repo>:<quant>` → /api/pull. Ollama
          // materialises the GGUF into its own blob+manifest store; the file
          // appears in `ollama list` (and therefore in our model manager) the
          // moment the pull finishes — no separate scanner involved.
          const ollamaRef = hfUrlToOllamaRef(model.downloadUrl, model.filename)
          if (!ollamaRef) {
            setDownloadError(`Cannot derive an Ollama reference for ${model.label}. Try LM Studio instead.`)
            continue
          }

          // Seed an entry in the download store so the existing onboarding
          // progress UI keeps working. Translation from PullProgress (Ollama)
          // → DownloadProgress (LU) below.
          dlStore.getState().setMeta(model.filename, model.downloadUrl, 'ollama')
          useDownloadStore.setState(s => ({
            downloads: {
              ...s.downloads,
              [model.filename!]: {
                progress: 0, total: 0, speed: 0,
                filename: model.filename!,
                status: 'connecting',
              },
            },
          }))

          const { promise } = pullModelTauri(ollamaRef, (p) => {
            const total = p.total || 0
            const completed = p.completed || 0
            const status = (p.status || '').toLowerCase()
            const isComplete = status.includes('success') || status === 'complete'
            useDownloadStore.setState(s => ({
              downloads: {
                ...s.downloads,
                [model.filename!]: {
                  progress: completed, total,
                  speed: 0,
                  filename: model.filename!,
                  status: isComplete ? 'complete' : 'downloading',
                },
              },
            }))
          })
          await promise
          // Mark complete in case the final progress event didn't include
          // a "success" status string (Ollama varies between versions).
          useDownloadStore.getState().markComplete(model.filename)
        } else if (useBuiltinPath) {
          // Built-in engine: write the GGUF flat into the app models dir, wait
          // for it to finish, then make it the active model. Unlike LM Studio
          // there's no <user>/<repo> nesting — list_bundled_models scans the
          // dir directly. We await completion here (not fire-and-forget) so the
          // engine starts on a fully-downloaded file and the first chat works.
          dlStore.getState().setMeta(model.filename, model.downloadUrl, 'gguf', destDir!)
          const expectedBytes = model.sizeGB ? Math.round(model.sizeGB * 1_073_741_824) : undefined
          await startModelDownloadToPath(model.downloadUrl, destDir!, model.filename, expectedBytes)
          dlStore.getState().startPolling()
          await awaitDownloadComplete(model.filename)
          // Same door as the Models page (lib/bundled-download-activation):
          // the engine path comes from the model list, not from a string glued
          // together here, and the downloaded model is the one the chat uses.
          try {
            const found = await activateBuiltinModel(builtinModelNameFromPath(model.filename))
            if (!found) setDownloadError(`Model downloaded, but the LU Engine did not find ${model.filename} in its model folder.`)
            else setActiveModel(bundledPickerIdForFile(model.filename))
          } catch (e) {
            setDownloadError(`Model downloaded, but the LU Engine failed to start: ${e instanceof Error ? e.message : String(e)}`)
          }
        } else {
          // LM Studio etc.: nest under <user>/<repo>/ so the scanner finds
          // it. A bare .gguf in the model root is silently ignored by LM
          // Studio's library — the second half of the same Discord bug.
          const subdir = hfUrlToLmStudioSubdir(model.downloadUrl)
          const targetDir = subdir ? `${destDir}/${subdir}` : destDir!
          dlStore.getState().setMeta(model.filename, model.downloadUrl, 'gguf', targetDir)
          const expectedBytes = model.sizeGB ? Math.round(model.sizeGB * 1_073_741_824) : undefined
          await startModelDownloadToPath(model.downloadUrl, targetDir, model.filename, expectedBytes)
          dlStore.getState().startPolling()
        }
        setPulledModels(prev => [...prev, name])
      } catch (e) {
        setDownloadError(`Download failed for ${model.label}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setPullingModel(null)
    // Tell the rest of the app the model list changed — Model Manager,
    // Chat picker, etc. listen for this and re-fetch.
    window.dispatchEvent(new CustomEvent('lu-models-refresh'))
    setStep('embeddings')
  }

  // Detect system VRAM for model filtering.
  //
  // Level (a): silent on purpose. systemVRAM is only ever read as
  // `if (systemVRAM && m.vramGB > systemVRAM) return false`, so a failed
  // probe means the recommendation list is not narrowed — the user sees MORE
  // models, not fewer, and every card still states its own VRAM need. There
  // is no action to offer, and nothing was lost.
  useEffect(() => { getSystemVRAM().then(v => setSystemVRAM(v)).catch(() => {}) }, [])

  // Die CHATFAEHIGEN Modelle, die der Nutzer schon hat, mit Namen und nicht
  // nur als Zahl.
  //
  // Embedding-only models (LM Studio's default `nomic-embed-text-v1.5`,
  // `bge-*`, anything with `embed` in the name) are excluded because they
  // can't drive a chat. Without this filter, a fresh LM Studio install
  // looked like "user already has 1 model", which is exactly the noob trap
  // we're trying to remove.
  //
  // Hier stand vorher eine ZAHL, und daneben ein zweiter Effekt, der bei
  // `> 0` sofort auf den Einbettungsschritt sprang. Die Namen sind der
  // Unterschied zwischen „wir wissen, dass er welche hat" und „er kann eins
  // davon waehlen": ohne sie liesse sich der Schritt gar nicht zeigen.
  const [installedModels, setInstalledModels] = useState<string[] | null>(null)
  useEffect(() => {
    if (step !== 'models') return
    let cancelled = false
    import('../../api/ollama').then(({ listModels }) =>
      listModels()
        .then(models => {
          const chatCapable = models.filter(m => {
            const lower = (m.name || '').toLowerCase()
            return !lower.includes('embed') && !lower.includes('bge-') && !lower.includes('nomic')
          })
          if (!cancelled) setInstalledModels(chatCapable.map(m => m.name))
        })
        .catch(() => { if (!cancelled) setInstalledModels([]) })
    )
    return () => { cancelled = true }
  }, [step])

  // EINE Quelle, zwei Leser: die Zahl ist die Laenge der Liste. Vorher waren
  // es zwei Groessen aus derselben Abfrage, und genau so faengt „zwei Pfade,
  // einer gepflegt" an. null = noch nicht geladen, 0 = frisch, >0 = erfahren.
  const existingModelCount = installedModels === null ? null : installedModels.length
  const hatEigeneModelle = existingModelCount !== null && existingModelCount > 0

  // Der Schritt wurde bei `existingModelCount > 0` uebersprungen, und das war
  // der eigentliche Befund: `modelStore.setModels` setzt, wenn keine Wahl
  // vorliegt, den ERSTEN chatfaehigen Eintrag der Liste. Wer uebersprungen
  // wurde, hat also nie gewaehlt und landete trotzdem auf einem Modell: eine
  // Persona auf einem Qwen3-4B, das sie nie angefasst hatte. David
  // 04.09.2026: „modellauswahl muss noch da sein oder nicht? ich denke ja."
  //
  // Was BLEIBT, ist P4 („Nur wenn der User noch gar kein Modell installiert
  // hat. Sonst nirgendwo mehr Empfehlungen"): das Abzeichen unten haengt
  // unveraendert an `=== 0`. Die Empfehlung verschwindet fuer erfahrene
  // Nutzer, die Auswahl nicht. Das ist kein Widerspruch, sondern die
  // Trennlinie zwischen „welches ist gut?" und „welches willst du?".
  const showRecommendedBadge = existingModelCount === 0

  // Die Wahl steht NICHT hier. Sie steht dort, wo der Chat sie liest, in
  // `modelStore.activeModel`, derselben Stelle, die der Modellknopf des
  // Composers zeigt und aus der der naechste Sendeweg sein Modell nimmt.
  // Ein eigener `useState` daneben waere ein zweiter Wahrheitsort gewesen,
  // der beim Verlassen des Schritts abgeglichen werden muesste; ein
  // Ollama-Name ist ausserdem praefixlos (`prefixModelName`), passt also
  // ohne Umbau in den Store und ueberlebt als Teil von `partialize` den
  // Fensterwechsel vom Assistenten ins Hauptfenster.
  const activeModel = useModelStore(s => s.activeModel)
  const setActiveModel = useModelStore(s => s.setActiveModel)
  const setProviderConfig = useProviderStore(s => s.setProviderConfig)
  const eigenesGewaehlt = !!activeModel && (installedModels ?? []).includes(activeModel)

  /**
   * Ein installiertes Modell waehlen, und zwar so, dass die Wahl im Chat
   * auch ankommt.
   *
   * Die erste Zeile ist der Grund, warum diese Funktion ueberhaupt eine ist
   * und kein blosses `setActiveModel` am Knopf. Der
   * Ollama-Slot steht seit 2.5.7 per Vorgabe auf `enabled: false`
   * (`providerStore.DEFAULT_PROVIDERS`), weil die eingebaute Maschine die
   * Vorgabe ist. Diese Liste kommt aber aus Ollamas `/api/tags`. Ein Modell
   * aus einem dunklen Slot taucht in `fetchModels` nie auf; `setModels`
   * findet die Wahl dann nicht in der Inventarliste, verwirft sie und setzt
   * den ersten Eintrag, den es hat.
   *
   * Genau das ist im ersten gruenen Lauf des Waechters passiert, und es ist
   * derselbe Befund eine Station spaeter: gewaehlt war `llama3.1:8b`, im
   * Modellknopf des Composers stand
   * `Model: qwen2.5-0.5b-instruct-q4_k_m`, also die mitgelieferte GGUF.
   *
   * Die eingebaute Maschine wird dabei NICHT abgeschaltet. Sie ist der Weg
   * zurueck, wenn Ollama gerade nicht laeuft, und zwei helle Slots
   * nebeneinander sind in diesem Assistenten der Normalfall (der
   * Backend-Schritt macht es bei einer bewussten Ollama-Wahl anders, weil
   * dort die PRIMAERE Maschine bestimmt wird, hier ein einzelnes Modell).
   */
  const waehleInstalliertes = (name: string) => {
    setProviderConfig('ollama', { enabled: true })
    setActiveModel(name)
  }

  // GGUF download progress from downloadStore
  const currentModel = pullingModel ? ONBOARDING_MODELS.find(m => m.name === pullingModel) : null
  const currentDownload = currentModel?.filename ? downloads[currentModel.filename] : null
  const isDownloading = !!pullingModel
  const progress =
    currentDownload?.total && currentDownload?.progress
      ? (currentDownload.progress / currentDownload.total) * 100
      : 0

  return (
    <>
      {/* Zwei Ueberschriften fuer zwei Lagen, und der Unterschied ist die
          ganze Aussage dieses Schritts: wer noch nichts hat, sucht einen
          ANFANG; wer schon etwas hat, waehlt aus dem, was da ist. „Starter"
          ueber einer Liste eigener Modelle waere schlicht gelogen. */}
      <div className="text-center mb-3">
        <h2 className="text-base font-semibold mb-1">
          {hatEigeneModelle ? 'Pick your chat model' : 'Pick a starter model'}
        </h2>
        <p className={`text-[0.7rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          {hatEigeneModelle
            ? 'Choose the model LU should open with. You can switch anytime from the picker next to the message box.'
            : 'One small model to get you running. You can browse and install more from the Models tab once you\'re in.'}
        </p>
      </div>

      {/* Die eigenen Modelle. Sie stehen VOR der Downloadliste, weil dieser
          Nutzer nichts herunterladen muss, und ohne jede Wertung
          untereinander: kein „Recommended", keine Sortierung nach unserer
          Meinung, die Reihenfolge ist die des Backends. Angezeigt wird der
          rohe Modellname, denn genau der steht spaeter auch im Knopf des
          Composers; ein geschoenter Name waere ein zweiter Name fuer
          dieselbe Sache. */}
      {hatEigeneModelle && (
        <div className="space-y-1.5">
          <p className={`t-micro ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Models you already have</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[30vh] overflow-y-auto scrollbar-thin pr-1">
            {(installedModels ?? []).map((name) => {
              const gewaehlt = activeModel === name
              return (
                <button
                  key={name}
                  onClick={() => waehleInstalliertes(name)}
                  className={`flex items-center justify-between gap-2 text-left p-2.5 rounded-lg border transition-colors ${
                    gewaehlt
                      ? isDark ? 'bg-white/10 border-white/30' : 'bg-gray-100 border-gray-900'
                      : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <span className="t-mono truncate">{name}</span>
                  {gewaehlt ? (
                    <Check size={14} className="text-green-400 shrink-0" />
                  ) : (
                    <div className={`w-4 h-4 rounded-full border shrink-0 ${isDark ? 'border-white/20' : 'border-gray-300'}`} />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Unfiltered / Mainstream tabs, only meaningful when both
          categories have entries. With the curated single-starter list
          (P4) the tabs are hidden; reintroduce only if the list grows. */}
      {ONBOARDING_MODELS.some(m => m.uncensored) && ONBOARDING_MODELS.some(m => !m.uncensored) && (
        <div className="flex gap-4 justify-center">
          <button onClick={() => setModelSubTab('uncensored')} className={`flex items-center gap-2 transition-all ${modelSubTab === 'uncensored' ? 'opacity-100' : 'opacity-40 hover:opacity-70'}`}>
            <div className={`w-1 h-4 rounded-full ${modelSubTab === 'uncensored' ? 'bg-red-500' : 'bg-red-500/50'}`} />
            <span className="text-[0.65rem] font-semibold uppercase tracking-wider">Unfiltered</span>
          </button>
          <button onClick={() => setModelSubTab('mainstream')} className={`flex items-center gap-2 transition-all ${modelSubTab === 'mainstream' ? 'opacity-100' : 'opacity-40 hover:opacity-70'}`}>
            <div className={`w-1 h-4 rounded-full ${modelSubTab === 'mainstream' ? 'bg-blue-500' : 'bg-blue-500/50'}`} />
            <span className="text-[0.65rem] font-semibold uppercase tracking-wider">Mainstream</span>
          </button>
        </div>
      )}

      {isDownloading && pullingModel && (
        <div className={`p-2.5 rounded-lg border ${cardClass}`}>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[0.7rem]">
              Downloading <span className="font-mono font-medium">{currentModel?.label || pullingModel}</span>...
            </p>
          </div>
          <p className={`text-[0.6rem] mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{currentDownload?.status || 'Starting...'}</p>
          {currentDownload?.total ? (
            <>
              <ProgressBar progress={progress} />
              <p className={`text-[0.55rem] mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {formatBytes(currentDownload.progress)} / {formatBytes(currentDownload.total)}
                {progress > 0 && <span className="ml-1.5 text-blue-400">{Math.round(progress)}%</span>}
              </p>
            </>
          ) : null}
        </div>
      )}
      {downloadError && (
        <p className={`text-[0.65rem] text-red-400 text-center`}>{downloadError}</p>
      )}

      {/* Nur wenn darueber schon eine Liste steht: sonst haette der
          Bildschirm eine Zwischenueberschrift ueber seinem einzigen Inhalt. */}
      {hatEigeneModelle && (
        <p className={`t-micro ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Or install another one</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[50vh] overflow-y-auto scrollbar-thin pr-1">
        {ONBOARDING_MODELS.filter(m => {
          // Filter by tab
          if (modelSubTab === 'uncensored' && !m.uncensored) return false
          if (modelSubTab === 'mainstream' && m.uncensored) return false
          // Filter by VRAM if known
          if (systemVRAM && m.vramGB > systemVRAM) return false
          return true
        }).map((model) => {
          const selected = selectedModels.includes(model.name)
          const pulled = pulledModels.includes(model.name) || (model.filename ? downloads[model.filename]?.status === 'complete' : false)
          return (
            <button
              key={model.name}
              onClick={() => !pulled && !isDownloading && toggleModel(model.name)}
              disabled={pulled || isDownloading}
              className={`text-left p-2.5 rounded-lg border transition-colors ${
                pulled
                  ? isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-300'
                  : selected
                  ? isDark ? 'bg-white/10 border-white/30' : 'bg-gray-100 border-gray-900'
                  : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
              } ${isDownloading ? 'opacity-60' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-[0.7rem]">{model.label}</span>
                    {model.recommended && showRecommendedBadge && (
                      <span className={`text-[0.5rem] px-1 py-0.5 rounded ${isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className={`text-[0.6rem] mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{model.description}</p>
                  <p className={`text-[0.55rem] mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    {model.size} · VRAM: {model.vram}
                  </p>
                </div>
                {pulled ? (
                  <Check size={14} className="text-green-400 shrink-0 mt-0.5" />
                ) : selected ? (
                  <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 mt-0.5 ${isDark ? 'bg-white' : 'bg-gray-900'}`}>
                    <Check size={10} className={isDark ? 'text-black' : 'text-white'} />
                  </div>
                ) : (
                  <div className={`w-4 h-4 rounded border shrink-0 mt-0.5 ${isDark ? 'border-white/20' : 'border-gray-300'}`} />
                )}
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-2 pt-1">
        {selectedModels.length > 0 && !isDownloading ? (
          <button
            onClick={handleDownloadSelected}
            className="lu-primary flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.7rem] transition-all"
          >
            <Download size={14} /> Install {selectedModels.length} model{selectedModels.length > 1 ? 's' : ''}
          </button>
        ) : !isDownloading ? (
          <button
            onClick={() => setStep('embeddings')}
            className={`flex-1 flex items-center justify-center gap-1.5 ${secondaryBtn}`}
          >
            {/* „Skip for now" waere nach einer getroffenen Wahl falsch: es
                gibt nichts mehr zu ueberspringen, der Knopf traegt sie
                weiter. Derselbe Unterschied wie im Einbettungsschritt. */}
            {eigenesGewaehlt ? <>Continue <ChevronRight size={14} /></> : <>Skip for now <ChevronRight size={14} /></>}
          </button>
        ) : null}
      </div>
    </>
  )
}
