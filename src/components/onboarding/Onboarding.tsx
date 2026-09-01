/**
 * Der Assistent beim ersten Start — die SCHALE.
 *
 * ── Warum diese Datei nur noch die Schale ist (W-T3) ──────────────────────
 *
 * Hier standen 1909 Zeilen: sechs Bildschirme, vier Installationsablaeufe,
 * drei Download-Wege und der Fensterrahmen, alles in einer Funktion. Die
 * Zerlegung folgt NICHT der Bildschirmfolge und nicht der Zeilenzahl, sondern
 * der Frage, welcher Zustand ueber einen Bildschirm hinaus gelesen wird:
 *
 *   ./use-backend-scan.ts    Der Scan und die gewaehlte Maschine. FUENF
 *                            Bildschirme lesen ihn, zwei schreiben ihn —
 *                            also gehoert er ueber die Schritte, nicht in
 *                            einen von ihnen.
 *   ./use-installer-fleet.ts Die vier Installer und ihr EINER Takt. Sie
 *                            verteilen sich auf zwei Bildschirme, teilen
 *                            aber eine Uhr (AS-09); eine Zerlegung „pro
 *                            Schritt" haette daraus wieder zwei Uhren
 *                            gemacht.
 *   ./onboarding-skin.ts     Die zwei Knopf-Behandlungen und die zwei
 *                            Flaechen. Fuenf Dateien zeichnen sie; fuenf
 *                            Kopien waeren fuenf Rezepte (D-S36).
 *   ./wait-for-download.ts   Das Einzige, was sich Modell- und
 *                            Einbettungsschritt teilen: erst wenn die Datei
 *                            ganz da ist, darf ein Server darauf starten.
 *   ./onboarding-host.ts     Desktop-Fenster oder Browser-Vorschau. Drei
 *                            Dateien fragen; das Praedikat steht einmal.
 *
 * Was danach uebrig blieb, ist genau das, was ein Assistent ist: welcher
 * Bildschirm gerade dran ist, was der Nutzer bis hierher gewaehlt hat, der
 * Fensterrahmen, der Fortschrittsanzeiger — und die zwei Bildschirme, die
 * keinen eigenen Zustand haben (Willkommen, Fertig). Die vier
 * ARBEITSSCHRITTE liegen je in einer eigenen Datei:
 * ./BackendsStep.tsx · ./ComfyStep.tsx · ./ModelsStep.tsx ·
 * ./EmbeddingsStep.tsx.
 *
 * Die `motion.div` samt Schluessel und Ein-/Ausblendung bleibt hier, um jeden
 * Schritt herum: der UEBERGANG zwischen Bildschirmen gehoert dem Assistenten,
 * nicht dem Bildschirm. Die Schritte liefern ein Fragment — das DOM ist
 * dadurch dasselbe wie vorher, `space-y-*` der Karte greift unveraendert.
 *
 * ── Die zwei Weichen, die hier bleiben mussten ────────────────────────────
 *
 * `nextStepAfterBackends` und `selectBackendAndContinue` sehen aus wie
 * Backend-Schritt und sind es nicht: die erste entscheidet, welcher
 * Bildschirm als naechster kommt, die zweite schreibt den Provider-Store und
 * ruft dann die erste. Beides ist Routenwahl des Assistenten.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Minus, Square, X as XIcon, ArrowRight } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { PROVIDER_PRESETS } from '../../api/providers/types'
import { ICON_SM } from '../ui/icon-size'
import { isMacOS, backendCall } from '../../api/backend'
import { BUILTIN_BACKEND_ID } from '../../lib/onboarding-backend'
import { version as currentVersion } from '../../../package.json'
import { useReleaseNotesStore } from '../../stores/releaseNotesStore'
import { wizardProgress, workStepsFor, type Step } from './wizard-steps'
import { onboardingSkin } from './onboarding-skin'
import { useBackendScan } from './use-backend-scan'
import { useInstallerFleet } from './use-installer-fleet'
import { isTauri } from './onboarding-host'
import { BackendsStep } from './BackendsStep'
import { ComfyStep } from './ComfyStep'
import { ModelsStep } from './ModelsStep'
import { EmbeddingsStep } from './EmbeddingsStep'


// Bug (h): the dedicated 'theme' onboarding step was removed because users
// kept ending up on Light by accident, and the project standard is "dark
// always". Light mode stays available in Settings → General → Appearance
// for users who explicitly want it; we just don't push them through the
// choice on first launch anymore.
// Added 'embeddings' step (GH #45, leonsk29 2026-05-23): suggests pulling
// `nomic-embed-text` (~274 MB) before completing onboarding so Document
// Chat / RAG works out of the box. The step shows a Skip button and
// auto-skips entirely when the user already has any embedding model on disk.
// D-S35: `Step` und die Schrittfolge liegen jetzt in ./wizard-steps.ts —
// zusammen mit der Unterscheidung zwischen einem Bildschirm und einem
// Arbeitsschritt, die dieser Datei bisher fehlte. Der Typ wird hier
// re-exportiert, damit die 60 Fundstellen unten unveraendert bleiben.

export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome')
  // Ueberlebt den Modellschritt: der Schlussbildschirm zaehlt, was
  // heruntergeladen wurde. Deshalb steht die Liste hier und nicht dort.
  const [pulledModels, setPulledModels] = useState<string[]>([])
  const { settings, updateSettings } = useSettingsStore()
  const { setProviderConfig } = useProviderStore()

  const isDark = settings.theme === 'dark'
  const skin = onboardingSkin(isDark)
  const { bgClass, primaryBtn } = skin

  // Der geteilte Kern: welche Maschine gefunden und welche gewaehlt wurde,
  // und die vier Installer mit ihrem einen Takt.
  const scan = useBackendScan()
  const fleet = useInstallerFleet()
  const { selectedBackend, detectedBackends, runDetection } = scan

  const finish = () => {
    updateSettings({ onboardingDone: true })
    // B4: a brand new install must NOT be greeted by "what is new in 2.6.3"
    // right after setting the app up for the first time. Stamping the current
    // version here silently is what separates a fresh install from an upgrade:
    // an upgrade never runs this wizard, so its flag stays null and it gets the
    // notes. This is the ONLY place that stamps without showing anything.
    useReleaseNotesStore.getState().markNotesSeen(currentVersion)
    // Persist to filesystem so NSIS updates don't reset onboarding.
    //
    // Level (a): silent on purpose. updateSettings() above is what actually
    // ends the wizard, and it is persisted. This only writes the recovery
    // marker, which AppShell re-writes on any later boot where it is missing
    // (the migration next to `is_onboarding_done`). So a failure here heals
    // itself, and reporting it would put an error on the last screen of a
    // setup that succeeded.
    if (isTauri) backendCall('set_onboarding_done').catch(() => {})
  }

  // Hard rule: on macOS, local image/video generation is Apple MLX only —
  // ComfyUI never runs there (see isMlxImageHost() / the image_generate +
  // video_generate MLX routing in api/mcp/builtin-tools.ts). The ComfyUI
  // wizard step would just auto-detect/install a backend that can't start on
  // this platform, so skip straight to the model picker. MLX models are
  // managed from Models → Discover after onboarding, same as any other
  // model — no dedicated onboarding step for them.
  const nextStepAfterBackends = (): Step => (isMacOS() ? 'models' : 'comfyui')

  // Commit the chosen backend to the provider store and advance to ComfyUI
  // (or straight to the model picker on macOS — see nextStepAfterBackends).
  // Built-in (default) reasserts the managed OpenAI-slot config; a detected
  // Ollama takes over the primary slot (managed built-in disabled) so there
  // aren't two defaults; other OpenAI-compat backends fill the openai slot.
  const selectBackendAndContinue = () => {
    if (selectedBackend === BUILTIN_BACKEND_ID) {
      setProviderConfig('openai', {
        enabled: true, name: 'Built-in Engine',
        baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true,
      })
    } else if (selectedBackend === 'ollama') {
      setProviderConfig('ollama', { enabled: true })
      setProviderConfig('openai', { enabled: false, managed: false })
    } else {
      const backend = detectedBackends.find(b => b.id === selectedBackend)
      const preset = backend && PROVIDER_PRESETS.find(p => p.id === backend.id)
      if (backend && preset && preset.providerId !== 'ollama') {
        setProviderConfig('openai', {
          enabled: true, name: backend.name, baseUrl: backend.baseUrl,
          isLocal: true, managed: false,
        })
      }
    }
    setStep(nextStepAfterBackends())
  }

  const handleMinimize = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().minimize() }
  const handleMaximize = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().toggleMaximize() }
  const handleClose = async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); getCurrentWindow().close() }
  const winBtn = 'inline-flex items-center justify-center w-[46px] h-8 transition-colors text-gray-400 hover:text-gray-200'

  // D-S35: Mac ueberspringt 'comfyui' (siehe nextStepAfterBackends). Der
  // Anzeiger zaehlt ausserdem nur noch die ARBEITSSCHRITTE — Willkommen ist
  // ein Titelbild, Fertig eine Bestaetigung. Die Rechnung dazu steht in
  // ./wizard-steps.ts und ist dort geprueft.
  const workSteps = workStepsFor(isMacOS())
  const progressNow = wizardProgress(step, isMacOS())

  return (
    // D-S38: vorher `items-center` auf einem h-screen-Kasten PLUS ein
    // `fixed top-10`-Anzeiger. Die Punkte klebten damit an der Titelleiste
    // (y=46), der Inhalt hing in der Fenstermitte (y=340) — 294px Niemandsland
    // dazwischen, und die Punkte lasen als Teil des Fensterrahmens statt als
    // Teil des Assistenten. Jetzt steht der Anzeiger IM Fluss, direkt ueber
    // der Karte, und der Abstand ist der `gap` einer Spalte statt der Rest
    // einer Zentrierung.
    <div className={`h-screen w-screen flex flex-col items-center justify-center gap-5 p-4 ${bgClass}`}>
      {/* Drag region + window controls */}
      {isTauri && (
        <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-50 flex items-center justify-end select-none">
          <button onClick={handleMinimize} className={winBtn} aria-label="Minimize"><Minus size={ICON_SM} /></button>
          <button onClick={handleMaximize} className={winBtn} aria-label="Maximize"><Square size={ICON_SM} /></button>
          <button onClick={handleClose} className={`${winBtn} hover:bg-red-500 hover:text-white`} aria-label="Close"><XIcon size={ICON_SM} /></button>
        </div>
      )}

      {/* Step indicator — Punkte UND Text. Sechs anonyme Punkte konnten die
          Frage „wie viele noch?" nicht beantworten; „Step 2 of 4 · Model"
          kann es. Die Hoehe ist fest, damit ein Schrittwechsel die Karte
          darunter nicht verschiebt. */}
      <div className="h-8 flex flex-col items-center justify-end gap-1.5" aria-live="polite">
        {progressNow && (<>
          <div className="flex gap-1.5">
            {workSteps.map((s, i) => (
              <div key={s.step} className={`w-1.5 h-1.5 rounded-full transition-colors ${i < progressNow.filled ? (isDark ? 'bg-white' : 'bg-gray-900') : (isDark ? 'bg-white/15' : 'bg-gray-300')}`} />
            ))}
          </div>
          <p className={`text-[0.6rem] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{progressNow.caption}</p>
        </>)}
      </div>

      <AnimatePresence mode="wait">
        {/* Step 1: Welcome */}
        {step === 'welcome' && (
          <motion.div
            key="welcome"
            className="max-w-sm w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            {/* D-S37: war `text-base` = 1rem — die Willkommens-Ueberschrift
                der App genau so gross wie ein Settings-Label. Soll laut Audit
                28px/34px/600.
                Warum `1.5rem` und keine feste px-Zahl: die 28px des Audits
                sind eine MESSUNG am gerenderten Fenster, und das Wurzelmass
                der App wird gerade umgestellt (D-A3, anderes Paket). Beide
                Regime ergeben fuer 1.5rem dasselbe, weil 18,4 = 16 × 1,15:
                  alt   1.5 × 18,4px                = 27,6 gerenderte px
                  neu   1.5 × 16px × --ui-scale 1,15 = 27,6 gerenderte px
                Zeilenhoehe 1,21 → 33,4px (Soll 34). Eine px-Angabe waere im
                neuen Regime durch `zoom` auf 32,2px gelaufen.
                Der Zusatz „by LU Labs" bleibt eine Stufe kleiner, damit die
                Groesse dem Namen gehoert und nicht der ganzen Zeile. */}
            <h1 className="text-[1.5rem] leading-[1.21] font-semibold tracking-tight">
              LU <span className="text-[12px] font-normal opacity-60 align-middle">by LU Labs</span>
            </h1>
            <p className={`text-[12px] leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Private, local AI chat that works right away. No extra software to install. No servers, no tracking, everything stays on your machine.
            </p>
            <button
              onClick={() => {
                setStep('backends')
                runDetection()
              }}
              className={primaryBtn}
            >
              Get Started <ArrowRight size={14} />
            </button>
          </motion.div>
        )}

        {/* Step 2 (theme picker) was removed in Bug (h). Light mode is
            still available in Settings → General → Appearance for users
            who want it explicitly. */}

        {/* Step 3: Backend Detection */}
        {step === 'backends' && (
          <motion.div
            key="backends"
            className="max-w-md w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <BackendsStep
              skin={skin}
              scan={scan}
              fleet={fleet}
              setStep={setStep}
              nextStepAfterBackends={nextStepAfterBackends}
              selectBackendAndContinue={selectBackendAndContinue}
            />
          </motion.div>
        )}

        {/* Step 4: ComfyUI Setup */}
        {step === 'comfyui' && (
          <motion.div
            key="comfyui"
            className="max-w-md w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <ComfyStep skin={skin} fleet={fleet} step={step} setStep={setStep} />
          </motion.div>
        )}

        {/* Step 5: Models (HuggingFace GGUF downloads) */}
        {step === 'models' && (
          <motion.div
            key="models"
            className="max-w-xl w-full space-y-3"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <ModelsStep
              skin={skin}
              scan={scan}
              fleet={fleet}
              step={step}
              setStep={setStep}
              pulledModels={pulledModels}
              setPulledModels={setPulledModels}
            />
          </motion.div>
        )}

        {/* Step 5: Embeddings (GH #45, Document Chat / RAG) */}
        {step === 'embeddings' && (
          <motion.div
            key="embeddings"
            className="max-w-md w-full space-y-3"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <EmbeddingsStep skin={skin} scan={scan} fleet={fleet} step={step} setStep={setStep} />
          </motion.div>
        )}

        {/* Step 6: Done */}
        {step === 'done' && (
          <motion.div
            key="done"
            className="max-w-sm w-full text-center space-y-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="w-3 h-3 rounded-full bg-green-400 mx-auto" />
            <h2 className="text-base font-semibold">You're all set!</h2>
            <p className={`text-[12px] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {pulledModels.length > 0
                ? `${pulledModels.length} model${pulledModels.length > 1 ? 's' : ''} installed. You're ready to go.`
                : selectedBackend === BUILTIN_BACKEND_ID
                ? 'The built-in engine is ready. Install a model anytime from the Models tab.'
                : detectedBackends.length > 0
                ? `Connected to ${detectedBackends.find(b => b.id === selectedBackend)?.name || detectedBackends[0].name}. You're ready to go.`
                : 'You can configure backends and install models anytime from Settings and the Models tab.'}
            </p>
            <button onClick={finish} className={primaryBtn}>
              Get Started <ArrowRight size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
