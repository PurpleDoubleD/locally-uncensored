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
import { ONBOARDING_MODELS, onboardingModelCopy, recommendedOnboardingModelName, strongestOnboardingModelName, type OnboardingModel } from '../../lib/constants'
import { recommendedOnSharedMemory, sharedMemoryAdvisory, sharedMemoryBudgetGb } from '../../lib/onboarding-shared-memory'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useDownloadStore } from '../../stores/downloadStore'
import { useModelStore } from '../../stores/modelStore'
import { detectProviderModelPath, luEngineDownloadDir, type PlannedDownload } from '../../api/discover'
import { startPlannedDownload } from '../../api/model-download'
import { gbOf, imagePartFileName } from '../../lib/image-part'
import { hfUrlToOllamaRef, hfUrlToLmStudioSubdir } from '../../lib/hf-to-provider'
import { pullModelTauri, checkConnection as checkOllama } from '../../api/ollama'
import { activateBuiltinModel, bundledToAIModels, isEmbeddingGgufName, listBundledModels } from '../../api/engine'
import { LU_ENGINE_NAME } from '../../lib/engine-name'
import { builtinModelNameFromPath } from '../../lib/builtin-model-identity'
import { mayEnableFromWizard } from '../../lib/onboarding-provider-gate'
import { syncOllamaBaseFromRust } from '../../lib/ollama-host-sync'
import { bundledPickerIdForFile } from '../../lib/bundled-download-activation'
import { backendCall, isMacOS } from '../../api/backend'
import { getSystemVRAM } from '../../api/comfyui'
import { getMaxVramGb, getSharedMemoryGb } from '../../lib/hardware'
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

/**
 * The files of one onboarding pick: the model, and its image part when it has
 * one. Same rule as the Models page (planModelDownload): the part lands next
 * to the model under the name the engine looks for, with its own size and
 * digest, and both are filed as one download.
 */
/** One row of "Models you already have": the id the picker uses, the raw
 *  name the composer shows, and the engine that serves it. */
interface InstalledChoice {
  id: string
  label: string
  engine: 'ollama' | 'lu-engine'
}

export function onboardingPlan(model: OnboardingModel): PlannedDownload[] {
  const expectedBytes = model.expectedBytes ?? (model.sizeGB ? Math.round(model.sizeGB * 1_073_741_824) : undefined)
  const plan: PlannedDownload[] = [{ url: model.downloadUrl, filename: model.filename, expectedBytes, sha256: model.sha256 }]
  if (model.mmprojUrl) {
    plan.push({ url: model.mmprojUrl, filename: imagePartFileName(model.filename), expectedBytes: model.mmprojBytes, sha256: model.mmprojSha256 })
  }
  return plan
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
  // entry: the tab switcher hides itself when only one
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

    // Built-in engine only: names that finish downloading in this run, so
    // the strongest of them (not whichever the loop below activates last)
    // can be made active once the whole batch is done. Ollama and LM Studio
    // pick their own active model elsewhere, this loop never calls
    // `setActiveModel` for them.
    const builtinPulledThisRun: string[] = []

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
          const plan = onboardingPlan(model)
          await startPlannedDownload(plan, destDir!, model.label)
          await awaitDownloadComplete(model.filename)
          // The image part is awaited too: an engine started before it lands
          // would bring the model up without image input. A part that fails
          // is not a failed model: the chat works, and the part can be added
          // from the installed model with one click.
          if (plan[1]) {
            try {
              await awaitDownloadComplete(plan[1].filename)
            } catch {
              setDownloadError(`${model.label} is installed, but its image part did not download. You can add it later under Models, Installed.`)
            }
          }
          // Same door as the Models page (lib/bundled-download-activation):
          // the engine path comes from the model list, not from a string glued
          // together here, and the downloaded model is the one the chat uses.
          try {
            const found = await activateBuiltinModel(builtinModelNameFromPath(model.filename))
            if (!found) setDownloadError(`Model downloaded, but the LU Engine did not find ${model.filename} in its model folder.`)
            else { setActiveModel(bundledPickerIdForFile(model.filename)); builtinPulledThisRun.push(name) }
          } catch (e) {
            setDownloadError(`Model downloaded, but the LU Engine failed to start: ${e instanceof Error ? e.message : String(e)}`)
          }
        } else {
          // LM Studio etc.: nest under <user>/<repo>/ so the scanner finds
          // it. A bare .gguf in the model root is silently ignored by LM
          // Studio's library — the second half of the same Discord bug.
          const subdir = hfUrlToLmStudioSubdir(model.downloadUrl)
          const targetDir = subdir ? `${destDir}/${subdir}` : destDir!
          await startPlannedDownload(onboardingPlan(model), targetDir, model.label)
        }
        setPulledModels(prev => [...prev, name])
      } catch (e) {
        setDownloadError(`Download failed for ${model.label}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setPullingModel(null)
    // Two or more built-in models picked at once: the loop above activated
    // each in turn as its download finished, so whatever is active right
    // now is just the last one clicked. Re-activate the strongest of the
    // ones that actually finished, so the choice is "the most capable model
    // downloaded", not "whichever button order happened to be clicked in".
    // The file is already on disk from the loop above, so this is a re-scan,
    // not a second download.
    if (builtinPulledThisRun.length > 1) {
      const strongestName = strongestOnboardingModelName(ONBOARDING_MODELS, builtinPulledThisRun)
      const strongestModel = ONBOARDING_MODELS.find(m => m.name === strongestName)
      if (strongestModel?.filename) {
        try {
          const found = await activateBuiltinModel(builtinModelNameFromPath(strongestModel.filename))
          if (found) setActiveModel(bundledPickerIdForFile(strongestModel.filename))
        } catch { /* leave the last-activated model active; no worse than before this fix */ }
      }
    }
    // Tell the rest of the app the model list changed — Model Manager,
    // Chat picker, etc. listen for this and re-fetch.
    window.dispatchEvent(new CustomEvent('lu-models-refresh'))
    setStep('embeddings')
  }

  // Detect VRAM for a memory advisory. Failed probes leave the model visible
  // with its stated requirements; they never imply that the model will fit.
  //
  // R2-51: `getSystemVRAM` asks the RUNNING ComfyUI's own /system_stats, so
  // the advisory only ever appeared once ComfyUI itself was up, and on this very
  // step, before ComfyUI has necessarily been started, that is most of the
  // time. `getMaxVramGb` (lib/hardware.ts) asks the Rust `detect_gpus` probe
  // instead (nvidia-smi/rocm-smi/lspci/wmic), which works with no engine
  // running at all. ComfyUI's own number stays the fallback for a GPU vendor
  // none of those tools name (0 from getMaxVramGb reads as "unknown", not as
  // "no VRAM"), so a machine ComfyUI can already see is not made to look
  // worse than it is.
  //
  // A Mac is asked differently. It has no card and ComfyUI never runs there,
  // so both probes above answer nothing and the step used to know nothing:
  // the 7B starter on every Mac, no advisory on any. What a model can take
  // on a Mac is a share of the one memory pool, the same budget the Model
  // Manager compares its chat tiles with (lib/onboarding-shared-memory.ts).
  // The pool is `shared_memory_mib` on the Apple entry of `detect_gpus`, with
  // `system_info` as the fallback. On a Mac `systemVRAM` therefore holds
  // that budget, not a card: one piece of state, read two ways (AS-09 counts
  // the `useState` of this folder).
  const sharedMemory = isMacOS()
  useEffect(() => {
    if (isMacOS()) {
      let alive = true
      getSharedMemoryGb()
        .then((pool) => { if (alive) setSystemVRAM(sharedMemoryBudgetGb(pool)) })
        .catch(() => {})
      return () => { alive = false }
    }
    getMaxVramGb().then((v) => {
      if (v > 0) { setSystemVRAM(v); return }
      getSystemVRAM().then((v2) => setSystemVRAM(v2)).catch(() => {})
    }).catch(() => {
      getSystemVRAM().then((v2) => setSystemVRAM(v2)).catch(() => {})
    })
  }, [])

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
  const [installedModels, setInstalledModels] = useState<InstalledChoice[] | null>(null)
  // Ollamas Teil der Liste haengt an Ollamas Schalter. Wer den Anbieter in
  // Settings ausgeschaltet hat, bekommt hier nichts angeboten, was der
  // Assistent nicht einschalten darf: sonst waehlt ein Klick ein Modell, dessen
  // Maschine dunkel bleibt. Erstlauf und frische Ablage tragen die Marke
  // nicht, dort bleibt alles wie vorher.
  //
  // Die GGUFs der LU Engine stehen seit 3.0.9 mit in der Liste, aus derselben
  // Quelle wie Model Manager und Waehler (`list_bundled_models`, App-Ordner
  // plus der eigene Ordner aus Storage). Befund I1 auf der Box, r2 6545eac24:
  // wer nur LU-Engine-Modelle hatte, sah hier nichts davon und bekam den
  // Starter angeboten, als haette er keins.
  const ollamaOffenbarUnerwuenscht = !mayEnableFromWizard(
    useProviderStore(s => s.providers.ollama),
  )
  useEffect(() => {
    if (step !== 'models') return
    let cancelled = false
    // Erst Rusts Ollama-Adresse holen: im eigenen Assistentenfenster stand
    // sonst der Default 11434 in backend.ts (lib/ollama-host-sync.ts).
    const ollamaRows: Promise<InstalledChoice[]> = ollamaOffenbarUnerwuenscht
      ? Promise.resolve([])
      : syncOllamaBaseFromRust()
        .then(() => import('../../api/ollama'))
        .then(({ listModels }) => listModels())
        .then(models => models
          .filter(m => {
            const lower = (m.name || '').toLowerCase()
            return !lower.includes('embed') && !lower.includes('bge-') && !lower.includes('nomic')
          })
          .map(m => ({ id: m.name, label: m.name, engine: 'ollama' as const })))
        .catch(() => [])
    // Eine Antwort ohne Sidecar (Web, Bruecke) ist ein Fehler und heisst hier
    // schlicht: keine eigenen GGUFs.
    const engineRows: Promise<InstalledChoice[]> = Promise.resolve()
      .then(() => listBundledModels())
      .then(models => bundledToAIModels(models.filter(m => !isEmbeddingGgufName(m.name)))
        .map(m => ({ id: m.name, label: m.model, engine: 'lu-engine' as const })))
      .catch(() => [])
    Promise.all([ollamaRows, engineRows]).then(([ollama, engine]) => {
      if (!cancelled) setInstalledModels([...ollama, ...engine])
    })
    return () => { cancelled = true }
  }, [step, ollamaOffenbarUnerwuenscht])

  // EINE Quelle, zwei Leser: die Zahl ist die Laenge der Liste. Vorher waren
  // es zwei Groessen aus derselben Abfrage, und genau so faengt „zwei Pfade,
  // einer gepflegt" an. null = noch nicht geladen, 0 = frisch, >0 = erfahren.
  const existingModelCount = installedModels === null ? null : installedModels.length
  const hatEigeneModelle = existingModelCount !== null && existingModelCount > 0

  // Der Schritt wurde bei `existingModelCount > 0` uebersprungen, und das war
  // der eigentliche Befund: `modelStore.setModels` setzt, wenn keine Wahl
  // vorliegt, den ERSTEN chatfaehigen Eintrag der Liste. Wer uebersprungen
  // wurde, hat also nie gewaehlt und landete trotzdem auf einem Modell: eine
  // Persona auf einem Qwen3-4B, das sie nie angefasst hatte. Der Inhaber
  // 04.09.2026: „modellauswahl muss noch da sein oder nicht? ich denke ja."
  //
  // Was BLEIBT, ist P4 („Nur wenn der User noch gar kein Modell installiert
  // hat. Sonst nirgendwo mehr Empfehlungen"): das Abzeichen unten haengt
  // unveraendert an `=== 0`. Die Empfehlung verschwindet fuer erfahrene
  // Nutzer, die Auswahl nicht. Das ist kein Widerspruch, sondern die
  // Trennlinie zwischen „welches ist gut?" und „welches willst du?".
  const showRecommendedBadge = existingModelCount === 0

  // Which entry the badge sits on: the hardware-aware pick, or the static
  // fallback when VRAM is unknown / fits nothing. See
  // `recommendedOnboardingModelName` for the reused threshold.
  // On a Mac the pick is the strongest model that fits its memory budget.
  const recommendedModelName = sharedMemory
    ? recommendedOnSharedMemory(ONBOARDING_MODELS, systemVRAM)
    : recommendedOnboardingModelName(ONBOARDING_MODELS, systemVRAM)

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
  const eigenesGewaehlt = !!activeModel && (installedModels ?? []).some(m => m.id === activeModel)

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
  const waehleInstalliertes = (choice: InstalledChoice) => {
    // Eine GGUF der LU Engine: die Wahl im Store reicht, denn
    // `modelStore.setActiveModel` startet die Engine auf `openai::<name>`
    // selbst um (derselbe Weg wie der Use-Knopf im Model Manager).
    if (choice.engine === 'lu-engine') { setActiveModel(choice.id); return }
    // Der Guertel zum Hosentraeger oben: einschalten nur, wenn der Nutzer den
    // Anbieter nicht selbst ausgeschaltet hat. Beides zusammen ist EINE Regel,
    // gefragt an der Stelle, die anbietet, und an der, die schreibt.
    if (!mayEnableFromWizard(useProviderStore.getState().providers.ollama)) return
    setProviderConfig('ollama', { enabled: true })
    setActiveModel(choice.id)
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
            {(installedModels ?? []).map((choice) => {
              const gewaehlt = activeModel === choice.id
              return (
                <button
                  key={choice.id}
                  onClick={() => waehleInstalliertes(choice)}
                  className={`flex items-center justify-between gap-2 text-left p-2.5 rounded-lg border transition-colors ${
                    gewaehlt
                      ? isDark ? 'bg-white/10 border-white/30' : 'bg-gray-100 border-gray-900'
                      : isDark ? 'border-white/10 hover:border-white/20' : 'border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <span className="min-w-0 flex flex-col">
                    <span className="t-mono truncate">{choice.label}</span>
                    <span className={`t-micro ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{choice.engine === 'lu-engine' ? LU_ENGINE_NAME : 'Ollama'}</span>
                  </span>
                  {gewaehlt ? (
                    <Check size={14} className="text-green-600 dark:text-green-400 shrink-0" />
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
          // Keep the chat starter visible on small GPUs; explain the memory
          // requirement instead of replacing it with a sub-7B default.
          return true
        }).map((model) => {
          const selected = selectedModels.includes(model.name)
          const pulled = pulledModels.includes(model.name) || (model.filename ? downloads[model.filename]?.status === 'complete' : false)
          // What the card says in words: the PC text as written, or the same
          // facts as a Mac reads them (memory, no card, no VRAM).
          const copy = onboardingModelCopy(model, sharedMemory)
          const advisory = sharedMemory
            ? sharedMemoryAdvisory(model, systemVRAM)
            : systemVRAM !== null && systemVRAM < model.vramGB
              ? 'Full GPU offload may not fit. Use CPU/offload settings or skip local setup.'
              : ''
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
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-[0.7rem]">{model.label}</span>
                    {model.name === recommendedModelName && showRecommendedBadge && (
                      <span className={`text-[0.5rem] px-1 py-0.5 rounded ${isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                        Recommended
                      </span>
                    )}
                    {/* The one place `OnboardingModel.agent` is read. Without
                        this it was a display flag nothing displayed: set on
                        the catalog entries this list is drawn from, but
                        never rendered here, so the only agent hint reaching
                        the user was whatever happened to be written into
                        `description`. */}
                    {model.agent && (
                      <span className={`text-[0.5rem] px-1 py-0.5 rounded ${isDark ? 'bg-purple-500/15 text-purple-300' : 'bg-purple-100 text-purple-700'}`}>
                        Agent-ready
                      </span>
                    )}
                  </div>
                  <p className={`text-[0.6rem] mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{copy.description}</p>
                  {advisory && (
                    <p className="text-xs mt-1 text-gray-500 dark:text-gray-400" data-testid="onboarding-model-advisory">{advisory}</p>
                  )}
                  <p className={`text-[0.55rem] mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    {model.size}{model.mmprojBytes ? ` + ${gbOf(model.mmprojBytes)} GiB image input` : ''} · {copy.memory}
                  </p>
                </div>
                {pulled ? (
                  <Check size={14} className="text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                ) : selected ? (
                  <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 mt-0.5 ${isDark ? 'bg-white' : 'bg-gray-900'}`}>
                    <Check size={10} className={isDark ? 'text-black' : '!text-white'} />
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
