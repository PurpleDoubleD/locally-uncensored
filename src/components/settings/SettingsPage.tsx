import { useState, useEffect, useRef, type ReactNode, type ChangeEvent } from 'react'
import { withDetail } from '../../lib/error-text'
// `X` steht hier weiterhin, obwohl der Sprachabschnitt mit seinen Symbolen
// nach ./SpeechSettings.tsx gezogen ist: der Dismiss-Knopf der ComfyUI-Notiz
// traegt ihn neben dem Wort.
import { ArrowLeft, RotateCcw, Sun, Moon, Check, X, Loader2, Shield, ChevronRight, GraduationCap, Lock, Sliders, Plug, Bot, Phone, User, Download, AlertTriangle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { SETTINGS_TAB_RESET_KEYS, type SettingsTab } from '../../lib/settings-reset'
import { armedScopeFor, type ResetArm, type ResetArmScope } from '../../lib/reset-arming'
import { sectionAnchorId, sectionsFor, type SettingsSectionFlags } from './settings-nav'
import { useSettingsStore } from '../../stores/settingsStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useUIStore } from '../../stores/uiStore'
import { SliderControl } from './SliderControl'
import { InlineToggle } from './InlineToggle'
import { SpeechSettings } from './SpeechSettings'
import { LogFileSettings } from './LogFileSettings'
import { PersonaPanel } from '../personas/PersonaPanel'
import { AccountPanel } from '../auth/AccountPanel'
import { useVoiceStore } from '../../stores/voiceStore'
import { downloadSuffix } from '../../lib/formatters'
// Der Satz zum Startfehler kommt fuer beide Oberflaechen aus dieser Stelle
// (Ticket 007). Statisch geladen, weil ihn der Beobachter unten in dem
// Augenblick braucht, in dem ein Start gescheitert ist: eine Meldung darf
// nicht erst darauf warten, dass ein Stueck Programm nachgeladen wird.
import { comfyStartupError, comfyCrashAdvice, comfyStartThrowText, COMFY_START_FAILED } from '../create/experimental/comfyError'

// AS-09: PIPER_VOICES und CLOUD_TTS_VOICES sind mit dem Abschnitt, der sie
// benutzt, nach ./SpeechSettings.tsx gezogen.
import { useAgentModeStore } from '../../stores/agentModeStore'
import { FEATURE_FLAGS } from '../../lib/constants'
import { MemorySettings } from './MemorySettings'
import { ChatBackupSettings } from './ChatBackupSettings'
import { ImportScanSkeleton } from '../layout/ViewSkeletons'
import { LocalApiSettings } from './LocalApiSettings'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import { RemoteAccessDocs } from './RemoteAccessDocs'
import { HardwareSettings } from './HardwareSettings'
import { ChatbotImporter } from '../import/ChatbotImporter'
import { ProviderSettings } from './ProviderConfig'
import { BuiltinEngineSettings } from './BuiltinEngineSettings'
import { MlxMediaSettings } from './MlxMediaSettings'
import { useProviderStore } from '../../stores/providerStore'
import { useComfyInstallStore, comfySectionShouldOpen } from '../../stores/comfyInstallStore'
import { PermissionSettings } from './PermissionSettings'
import { MCPServerSettings } from './MCPServerSettings'
import { WorkflowList } from '../agents/WorkflowList'
import { WorkflowBuilder } from '../agents/WorkflowBuilder'
import { useUpdateStore, isNewerVersion } from '../../stores/updateStore'
import { backendCall, isTauri, isMacOS, openExternal } from '../../api/backend'
import { troubleshootHinweis, type TroubleshootHinweis } from './troubleshoot-message'
import { isMlxImageHost } from '../../api/mlx-image'
import { ArrowUpCircle, KeyRound, RefreshCw } from 'lucide-react'
import { CLOUD_BASE } from '../../api/cloud/config'
import { formatBytes } from '../../lib/formatters'
import { syncCustomModelDir, type CustomModelDirResult } from '../../lib/custom-model-dir'
import { listBundledModels, lastCustomScanDir, lastScanDirs, type ScannedDir } from '../../api/engine'
import { lmStudioModelDir } from '../../api/model-folders'
import {
  luEngineFolderPlaceholder, lmStudioFolderNote, lmStudioFolderPath,
  macOsWillAskForFolder, MACOS_FOLDER_ACCESS_NOTE,
  type LmStudioModelDir,
} from '../../lib/model-storage-rows'
import { CivitaiApiKeySetting } from './CivitaiApiKeySetting'
import { HfTokenSetting } from './HfTokenSetting'
import { HINWEIS_TEXT, PUNKT_FARBE } from '../../lib/hinweis'

// ── User profile picture (Appearance) ───────────────────────────
// Self-contained like HfDownloadPathSetting. Stores the picture as a
// downscaled base64 data URL (≤256px PNG) in settings so persisted state
// stays small. Shows next to the user's messages in chat / code / agent.
// The AI avatar is always the LU monogram and is NOT user-settable.
function AvatarSetting() {
  const userAvatarDataUrl = useSettingsStore((s) => s.settings.userAvatarDataUrl)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const inputRef = useRef<HTMLInputElement>(null)

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        // Downscale to ≤256px (longest edge) so the persisted data URL is small.
        const MAX = 256
        const scale = Math.min(1, MAX / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, w, h)
        updateSettings({ userAvatarDataUrl: canvas.toDataURL('image/png') })
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="flex items-center justify-between pt-2">
      <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Profile picture</span>
      <div className="flex items-center gap-2">
        {userAvatarDataUrl ? (
          <img src={userAvatarDataUrl} alt="" className="w-7 h-7 rounded-md object-cover border border-gray-200 dark:border-white/10" />
        ) : (
          <div className="w-7 h-7 rounded-md bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 flex items-center justify-center">
            <User size={12} className="text-gray-400" />
          </div>
        )}
        <button
          onClick={() => inputRef.current?.click()}
          className="px-2 py-1 rounded text-[0.65rem] bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white hover:bg-gray-300 dark:hover:bg-white/15 transition-colors"
        >
          {userAvatarDataUrl ? 'Change' : 'Upload'}
        </button>
        {userAvatarDataUrl && (
          <button
            onClick={() => updateSettings({ userAvatarDataUrl: '' })}
            className="px-2 py-1 rounded text-[0.65rem] text-gray-500 hover:text-red-400 transition-colors"
          >
            Remove
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={onPick}
        className="hidden"
      />
    </div>
  )
}

// ── Collapsible Section ─────────────────────────────────────────

function Section({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const [animating, setAnimating] = useState(false)
  return (
    // D-S27: `id` + `scroll-mt` machen die Sektion zum Sprungziel der Rail.
    // Der Abstand nach oben haelt den Kopf unter dem klebenden Seitenkopf.
    <div id={sectionAnchorId(title)} className="scroll-mt-16 border-b border-gray-100 dark:border-white/[0.04]">
      <button
        onClick={() => { setOpen(!open); setAnimating(true) }}
        // Ein Aufklapp-Knopf, der seinen Zustand nicht meldet, ist fuer eine
        // Vorlesehilfe ein Knopf ohne Wirkung: sie sagt „Local API, Schalter"
        // und nie, ob der Abschnitt offen ist. Das Kind traegt die Kennung,
        // die der Knopf hier steuert.
        aria-expanded={open}
        aria-controls={`${sectionAnchorId(title)}-body`}
        className="w-full flex items-center justify-between py-2.5 group"
      >
        {/* D-S28: zwoelfmal 11,96px/600 uppercase gray-500 war kein Rang,
            sondern zwoelfmal dieselbe Betonung — und im Dunkelmodus mit
            3.37:1 (gray-500 #6b7280 auf #202020) unter WCAG AA. Der Kopf ist
            jetzt eine echte Ueberschrift auf der Stufe darunter: 0.82rem =
            15,1px bei 18,4px Wurzelmass, Satzstellung statt Versalien,
            17.74:1 hell / 13.16:1 dunkel. Den Rang traegt die Rail. */}
        <span className="text-[0.82rem] font-semibold text-gray-900 dark:text-gray-200 group-hover:text-black dark:group-hover:text-white transition-colors">
          {title}
        </span>
        <ChevronRight size={12} className={`text-gray-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={`${sectionAnchorId(title)}-body`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            onAnimationComplete={() => setAnimating(false)}
            className={animating ? 'overflow-hidden' : 'overflow-visible'}
          >
            <div className="pb-3 space-y-2">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Disclosure ──────────────────────────────────────────────────
// Lightweight nested collapsible for use *inside* a Section (e.g. the
// Remote Access "How it works" docs). Unlike Section it uses sentence-case
// and a smaller chevron so it reads as a sub-item, not a top-level heading.

function Disclosure({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-2 pt-2 border-t border-gray-100 dark:border-white/[0.04]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 group"
      >
        <ChevronRight size={11} className={`text-gray-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        <span className="text-[0.65rem] font-medium text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">
          {label}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pt-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Workflow Section (inline, manages list/builder view) ────────

function WorkflowSection() {
  const [view, setWfView] = useState<'list' | 'builder'>('list')
  const [editingId, setEditingId] = useState<string | undefined>()

  if (view === 'builder') {
    return (
      <WorkflowBuilder
        workflowId={editingId}
        onSave={() => { setWfView('list'); setEditingId(undefined) }}
        onCancel={() => { setWfView('list'); setEditingId(undefined) }}
      />
    )
  }

  return (
    <WorkflowList
      onRun={() => {}}
      onEdit={(id) => { setEditingId(id); setWfView('builder') }}
      onCreate={() => { setEditingId(undefined); setWfView('builder') }}
    />
  )
}

// ── Model Storage (the user's own model folder) ─────────────────
//
// GH #122 (zrmdsxa) + Discord "Read me first" (ever.noob): this folder was a
// download TARGET and nothing else. Models already sitting in it were never
// looked at, and the copy above the field said nothing about that, so the
// Models tab stayed empty beside a folder full of models. It is read now
// (lib/custom-model-dir.ts), and the copy says what it does.

export function HfDownloadPathSetting() {
  const override = useSettingsStore(s => s.settings.hfDownloadPathOverride)
  const [draft, setDraft] = useState(override)
  // Der Ordnerwaehler hat nicht aufgemacht: Stufe (c), der Klick sollte etwas
  // aendern und hat es nicht. Ein Abbruch im Dialog liefert null und ist kein
  // Fehler, hier landet also nur ein echter Fehlschlag.
  const [pickError, setPickError] = useState<string | null>(null)
  const [comfy, setComfy] = useState<CustomModelDirResult | null>(null)
  const [scan, setScan] = useState<ScannedDir | null>(null)
  // The folder LU reads while the field is empty. Row 0 of the listing is the
  // app's own models dir, which is exactly the folder the LU Engine loads
  // from, so the empty field can name it instead of saying "(auto-detect)"
  // and leaving the user to guess.
  const [autoDir, setAutoDir] = useState('')
  /** Typed but not stored yet. Null means there is nothing owed. Declared
   *  before the effect below because that effect asks it. */
  const pendingPath = useRef<string | null>(null)
  // The store value flows back into the box, EXCEPT while the user is in the
  // middle of typing one. A16 counter-check follow-up: with a half typed path
  // owed, a store write from anywhere would have pulled the box back to the
  // stored value under the cursor.
  //
  // Das lief bis 04.09.2026 in einem Effekt und damit NACH dem Zeichnen: der
  // Kasten zeigte eine Bildfolge lang noch den alten Wert und wurde dann
  // ueberschrieben, also zwei Durchlaeufe fuer eine Aenderung. Jetzt wird der
  // Wert waehrend des Renderns nachgezogen, was React fuer genau diesen Fall
  // vorsieht: der Durchlauf wird verworfen und sofort mit dem neuen Wert
  // wiederholt, bevor etwas auf dem Schirm landet.
  const [zuletztGespeichert, setZuletztGespeichert] = useState(override)
  if (zuletztGespeichert !== override) {
    setZuletztGespeichert(override)
    if (pendingPath.current === null) setDraft(override)
  }

  // How the GGUF scan itself fared in that folder. A folder too big to finish
  // within the budget returns a real but partial list, and the only person who
  // can do anything about that is the one who chose the folder.
  //
  // Runs with and without an override since 2.6.8: without one there is no
  // scan verdict to show, but the listing is still the only place the app dir
  // is known, and the placeholder needs it.
  useEffect(() => {
    let alive = true
    void listBundledModels()
      .then(() => {
        if (!alive) return
        setScan(override ? lastCustomScanDir() : null)
        setAutoDir(lastScanDirs()[0]?.path ?? '')
      })
      .catch(() => { if (alive) { setScan(null); setAutoDir('') } })
    return () => { alive = false }
  }, [override])

  // Both directions of the folder: our own GGUF scan reads it on the next
  // model refresh, and the ComfyUI-shaped subfolders in it are handed to
  // ComfyUI. Runs on mount too, so a folder set by an older build reaches
  // ComfyUI without the user having to touch the field again.
  useEffect(() => {
    let alive = true
    void syncCustomModelDir(override).then((res) => { if (alive) setComfy(res) })
    return () => { alive = false }
  }, [override])

  // One line, and only when there is something to say.
  const scanNote = modelDirScanNote(scan?.status)
  // A folder that cannot be read at all has one problem, not two, so the
  // ComfyUI handoff note steps aside for those two verdicts: it would say the
  // same thing in different words. `truncated` is a different matter. The
  // folder IS readable, the walk simply ran out of budget, and what LU hands
  // to ComfyUI is unaffected by that, so both lines belong on screen.
  const scanHidesHandoff =
    scan?.status === 'unreachable' || scan?.status === 'denied' || scan?.status === 'unusable'

  // A16 (A14-2a), Windows counter-check 02.09.: the folder was stored on Enter
  // or on blur and on nothing else. Type a path, walk away to another tab or
  // close Settings, and the value stood in the box while
  // `hfDownloadPathOverride` stayed empty and Installed never changed. The
  // counter-check's first attempt concluded from that the folder was being
  // ignored, which is the reading anyone would reach.
  //
  // The first answer to that was a 600 ms debounce, and the follow-up
  // counter-check showed what it cost. The debounce wrote the TRIMMED value
  // into the store while the field was still being typed in, the effect above
  // pushed the store value straight back into the box, and a path with a space
  // in it lost that space mid word: "C:\Program " became "C:\Program", the
  // cursor jumped to the end, and the next keystrokes produced
  // "C:\ProgramFiles". A half typed path also reached the folder scan, which
  // then hung a red "unreachable" line under a field nobody had finished
  // filling in.
  //
  // So no timer writes anything any more. The field commits on blur, on Enter
  // and when it goes away, and the third of those is what the finding was
  // actually about: walking away from a settings field IS a blur or an
  // unmount, so nothing is lost without a clock having to guess when the user
  // is done.

  /** Store it. Everything that saves goes through here, so clearing the debt
   *  cannot be forgotten on one path. */
  function commit(next: string) {
    pendingPath.current = null
    const store = useSettingsStore.getState()
    if (store.settings.hfDownloadPathOverride === next) return
    store.updateSettings({ hfDownloadPathOverride: next })
    // The Models tab is the surface this setting is about: refresh it now
    // instead of after the next navigation.
    window.dispatchEvent(new CustomEvent('lu-models-refresh'))
  }

  function apply(next: string) {
    setDraft(next)
    commit(next)
  }

  /** One keystroke. Stored verbatim, trailing space and all: it is trimmed at
   *  commit time and not before, so a path that is still being typed keeps the
   *  space the next word needs. */
  function typePath(next: string) {
    setDraft(next)
    pendingPath.current = next
  }

  // Closing Settings or switching tabs unmounts this field. Whatever was owed
  // at that moment is stored, not thrown away.
  useEffect(() => () => {
    const owed = pendingPath.current
    pendingPath.current = null
    if (owed === null) return
    const store = useSettingsStore.getState()
    const trimmed = owed.trim()
    if (store.settings.hfDownloadPathOverride === trimmed) return
    store.updateSettings({ hfDownloadPathOverride: trimmed })
    window.dispatchEvent(new CustomEvent('lu-models-refresh'))
  }, [])

  async function pickFolder() {
    setPickError(null)
    try {
      const chosen = await backendCall<string | null>('pick_folder')
      // Ueber `apply`, nicht am Feld vorbei: das ist der eine Weg, der die
      // offene Tippschuld loescht und die Modellliste anstoesst.
      if (chosen) apply(chosen)
    } catch (e) {
      setPickError(withDetail('The folder picker did not open. Type or paste the path into the field instead.', e))
    }
  }

  return (
    <div className="space-y-2 py-1">
      <p className="t-micro font-semibold text-gray-700 dark:text-gray-300">LU Engine folder</p>
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        LU downloads GGUFs here and reads every <code className="font-mono">.gguf</code> in a folder you set, up to four levels down. Models here run on the LU Engine. Leave it empty and LU uses its own folder, which it reads two levels down.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => typePath(e.target.value)}
          onBlur={() => apply(draft.trim())}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(draft.trim()) }}
          placeholder={luEngineFolderPlaceholder(autoDir)}
          aria-label="LU Engine folder"
          className="flex-1 px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:border-white/20"
        />
        <button
          onClick={pickFolder}
          className="px-2.5 py-1 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors"
        >
          Browse…
        </button>
        {override && (
          <button
            onClick={() => apply('')}
            className="px-2.5 py-1 rounded-md text-[0.6rem] text-gray-500 hover:text-red-400 transition-colors"
          >
            Reset
          </button>
        )}
      </div>
      {/* A14: setting a folder under Desktop, Documents or Downloads makes
          macOS ask for access the first time LU walks it. That is the system
          asking on the user's behalf and nothing here prevents it; the panel
          only stops it from arriving as a surprise from an app that just
          started reading a folder. Shown for the path the user typed as well
          as for one he picked, and only on the Mac. */}
      {macOsWillAskForFolder(draft || override, isMacOS()) && (
        <div data-testid="macos-folder-access-note" className="t-micro leading-relaxed text-gray-500">
          {MACOS_FOLDER_ACCESS_NOTE}
        </div>
      )}
      {/* Jeder der drei Scan-Saetze endet damit, dass der Nutzer den Pfad
          aendern muss, damit seine Modelle vollstaendig auftauchen. Das ist
          kein Nebenbei, also der Fehlerton (lib/hinweis.ts). */}
      {override && scanNote && (
        <div data-testid="model-dir-scan-note" className={`t-micro leading-relaxed ${HINWEIS_TEXT.fehler}`}>
          {scanNote}
        </div>
      )}
      {override && comfy !== null && !scanHidesHandoff && <CustomModelDirNote result={comfy} />}
      {pickError && (
        <p role="alert" className="text-[0.55rem] text-red-500 dark:text-red-400 leading-snug whitespace-pre-line">
          {pickError}
        </p>
      )}
    </div>
  )
}

/**
 * What the folder scan found, in one sentence, or nothing at all.
 *
 * A13, Windows counter-check 2026-09-02: `C:\` as the model folder stayed
 * fully operable and said nothing. Rust had the answer the whole time (the
 * walk has a five second deadline and a 20 000 entry budget per folder and
 * reports `truncated` when it runs out), the panel simply never showed it, and
 * a partial list that looks complete is the kind of thing people debug for an
 * hour.
 *
 * `ok` is silence on purpose: a folder that scanned clean needs no line.
 */
export function modelDirScanNote(status: ScannedDir['status'] | null | undefined): string {
  if (status === 'truncated') {
    return 'This folder is too big to scan completely. Only the first files were read; pick a folder that holds just your models.'
  }
  if (status === 'unreachable') {
    return 'This folder cannot be reached right now (drive disconnected or path missing). Models in it are hidden until it is back.'
  }
  // P3, 7.4: this used to fall into the sentence above, which sent him looking
  // for an unplugged drive while the drive was plugged in and the path was
  // spelled right. Rust reports the reason now, so the panel can name it.
  if (status === 'denied') {
    return 'LU is not allowed to read that folder. The path is there; the account this app runs as has no access to it. Pick a folder your own account owns, or grant this app access to that one.'
  }
  if (status === 'unusable') {
    return 'This path is not a folder LU can read.'
  }
  return ''
}

/**
 * What became of the folder, in one line.
 *
 * A path the OS cannot use, or a drive that is not there, used to be silence:
 * no models, no file, no word about it. And image and video are a different
 * question from chat, because that inventory comes out of ComfyUI's own lists,
 * so LU can only hand ComfyUI the folder. On the Mac it cannot even do that:
 * local media there is MLX and LU never starts a ComfyUI, so promising one
 * would be a lie (Rust answers `unsupported` for that host).
 */
function CustomModelDirNote({ result }: { result: CustomModelDirResult }) {
  // Zwei Toene, kein dritter (lib/hinweis.ts). Die ersten beiden Lagen sind
  // ein Pfad, aus dem nichts gelesen werden kann: da muss jemand ran, also
  // Fehlerton. Die anderen beiden erklaeren nur, was LU an ComfyUI weitergibt,
  // und bleiben ruhig. Frueher trugen die ersten beiden Gelb, was sie
  // zwischen "egal" und "kaputt" haengen liess.
  const cls = "t-micro leading-relaxed"
  if (result.status === 'unusable') {
    return (
      <div className={`${cls} ${HINWEIS_TEXT.fehler}`}>
        That is not a full path, so nothing can be read from it. Use a complete path such as <code className="font-mono">C:\AI\Models</code> or <code className="font-mono">/mnt/models</code>. A leading <code className="font-mono">~</code> is a shell shorthand the app does not expand.
      </div>
    )
  }
  if (result.status === 'unreachable') {
    return (
      <div className={`${cls} ${HINWEIS_TEXT.fehler}`}>
        LU cannot read that folder. Check that the drive is connected and the path is spelled the way the system spells it.
      </div>
    )
  }
  if (result.status === 'denied') {
    return (
      <div className={`${cls} ${HINWEIS_TEXT.fehler}`}>
        LU is not allowed to read that folder. The drive is connected and the path is right; the account this app runs as has no access to it. Pick a folder your own account owns, or grant this app access to that one.
      </div>
    )
  }
  if (result.status === 'unsupported') {
    return (
      <div className={`${cls} ${HINWEIS_TEXT.ruhig}`}>
        Chat models in this folder are read. Image and video on the Mac run on Apple MLX, not ComfyUI, so image models in this folder are not picked up. Install those under Local Media (Apple MLX).
      </div>
    )
  }
  if (result.status === 'unknown') return null
  return (
    <div className={`${cls} ${HINWEIS_TEXT.ruhig}`}>
      {result.folders.length > 0
        ? <>Image and video: LU passes <code className="font-mono">{result.folders.join(', ')}</code> from this folder to ComfyUI. LU re-reads the subfolders every time it starts ComfyUI, so a subfolder you add later arrives with the next start. Only a ComfyUI that LU starts gets them.</>
        : <>Image and video models in this folder stay invisible: ComfyUI lists only its own folders. Name the subfolders like ComfyUI does (<code className="font-mono">checkpoints</code>, <code className="font-mono">loras</code>, <code className="font-mono">vae</code>, …) and LU hands them over the next time it starts ComfyUI.</>}
    </div>
  )
}

// ── Import models from Ollama / LM Studio ──────────────────────
// Discord feedback 2026-08-16: users with existing local models should not
// download them a second time. The backend hard links the GGUF into the app
// models dir, zero copy; Ollama and LM Studio keep working untouched.

// ── Model Storage, row 2: LM Studio's folder ────────────────────
//
// Read-only on purpose. LU does not own this folder and cannot move it, so a
// field here would be a lie with a Browse button on it. What the user needs is
// the answer to "is THIS the folder I was about to set", and that is a path
// and a sentence about who owns it.

export function LmStudioFolderSetting() {
  // null = not asked yet. Distinguished from "not installed" so the row never
  // flashes the wrong verdict for the length of one backend round trip.
  const [dir, setDir] = useState<LmStudioModelDir | null>(null)
  useEffect(() => {
    let alive = true
    void lmStudioModelDir().then((d) => { if (alive) setDir(d) })
    return () => { alive = false }
  }, [])

  const path = lmStudioFolderPath(dir)
  return (
    <div className="space-y-1 py-1 border-t border-white/5 mt-2 pt-2">
      <p className="t-micro font-semibold text-gray-700 dark:text-gray-300">LM Studio folder</p>
      {path && (
        <code data-testid="lmstudio-folder-path" className="block t-micro text-gray-400 font-mono break-all select-text">{path}</code>
      )}
      <div data-testid="lmstudio-folder-note" className="t-micro text-gray-500 leading-relaxed">
        {lmStudioFolderNote(dir)}
      </div>
    </div>
  )
}

// ── Model Storage, row 3: Ollama ────────────────────────────────
//
// No path at all, and that is the point of the row. Ollama keeps its models in
// a content-addressed blob store under names no human picked, so there is
// nothing to set and nothing worth printing; what there IS is a way to link
// those blobs into LU, which is the scan below.

export function ImportLocalModels() {
  const [candidates, setCandidates] = useState<import('../../api/engine').ImportCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function scan() {
    setScanning(true)
    setErrors({})
    try {
      const { listImportableModels } = await import('../../api/engine')
      setCandidates(await listImportableModels())
    } catch (e) {
      setCandidates([])
      setErrors({ scan: String(e) })
    } finally {
      setScanning(false)
    }
  }

  async function doImport(c: import('../../api/engine').ImportCandidate) {
    setBusyPath(c.path)
    setErrors((prev) => { const next = { ...prev }; delete next[c.path]; return next })
    try {
      const { importLocalModel, listBundledModels } = await import('../../api/engine')
      await importLocalModel(c.path, c.name)
      await listBundledModels()
      setCandidates((prev) => prev?.map((x) => x.path === c.path ? { ...x, already_imported: true } : x) ?? prev)
    } catch (e) {
      setErrors((prev) => ({ ...prev, [c.path]: String(e) }))
    } finally {
      setBusyPath(null)
    }
  }

  return (
    <div className="space-y-2 py-1 border-t border-white/5 mt-2 pt-2">
      <p className="t-micro font-semibold text-gray-700 dark:text-gray-300">Ollama</p>
      <div data-testid="ollama-store-note" className="t-micro text-gray-500 leading-relaxed">
        Ollama keeps its own model store. LU pulls Ollama models with <code className="font-mono">ollama pull</code>; a folder cannot be set here.
      </div>
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        Already have models in Ollama or LM Studio? Link them into LU without downloading or copying anything. The file stays where it is; both apps keep working.
      </div>
      <button
        onClick={scan}
        disabled={scanning}
        className="px-2.5 py-1 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors disabled:opacity-50"
      >
        {scanning ? 'Scanning…' : 'Scan for local models'}
      </button>
      {errors.scan && <div className="text-[0.6rem] text-red-400">{errors.scan}</div>}
      {/* Welle 3, Listen-Ladezustand 4 von 4: waehrend des Scans stand hier
          nichts — der Knopf sagte „Scanning…" und darunter blieb es leer, bis
          die Liste da war und den Rest der Sektion nach unten schob. Das
          Skelett haelt den Platz, den die Kandidatenzeilen einnehmen. */}
      {scanning && <ImportScanSkeleton />}
      {candidates !== null && !errors.scan && !scanning && (
        candidates.length === 0 ? (
          <div className="text-[0.6rem] text-gray-500">No importable models found. Looked in the Ollama store and the LM Studio models folder.</div>
        ) : (
          <div className="space-y-1">
            {candidates.map((c) => (
              <div key={c.path}>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[0.65rem] text-gray-700 dark:text-gray-300 font-mono truncate" title={c.path}>{c.name}</span>
                  <span className="text-[0.55rem] text-gray-500 uppercase">{c.source}</span>
                  <span className="text-[0.55rem] text-gray-500">{formatBytes(c.size)}</span>
                  {c.already_imported ? (
                    <span className="text-[0.6rem] text-green-500">Imported</span>
                  ) : (
                    <button
                      onClick={() => doImport(c)}
                      disabled={busyPath === c.path}
                      className="px-2 py-0.5 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors disabled:opacity-50"
                    >
                      {busyPath === c.path ? 'Linking…' : 'Import'}
                    </button>
                  )}
                </div>
                {errors[c.path] && <div className="text-[0.6rem] text-red-400 leading-snug">{errors[c.path]}</div>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

// ── ComfyUI Settings ────────────────────────────────────────────

/**
 * Antwort von `comfyui_status` (`src-tauri/src/commands/process.rs:1989`).
 *
 * Der Typ stand als Ganzes schon da — als der inline notierte Zustandstyp von
 * `useState` eine Zeile weiter unten. Nur der Weg dorthin trug `any`, und der
 * hat zwei Abweichungen zugedeckt, die beide nachgemessen sind:
 *
 *  1. `path` ist auf der Rust-Seite `Option<String>`, kommt also als `null`
 *     an — nicht als `undefined`. Der Zustandstyp sagte `path?: string`; ein
 *     `null` haette dort nie hineingedurft, und `any` hat es hineingelassen.
 *     Beide Lesestellen (`status?.path || ''`) vertragen `null` ohnehin.
 *  2. Der Dev-Server, den der Browser-Modus statt Tauri anspricht, sendet von
 *     den zehn Schluesseln nur sechs (`dev-server/comfy.ts:461`): `stalled`,
 *     `complete`, `port`, `host` und `isLocal` fehlen dort. Deshalb sind sie
 *     hier optional — im Browser sind sie wirklich nicht da.
 */
interface ComfyStatusResponse {
  running: boolean
  found: boolean
  /** Tauri sendet immer; der Dev-Server nur `running`/`starting`/`found`/`path`. */
  starting?: boolean
  stalled?: boolean
  complete?: boolean
  /** `null`, solange kein Pfad gespeichert ist — auch bei `found: true`. */
  path?: string | null
  port?: number
  host?: string
  isLocal?: boolean
}

/** Antwort von `comfyui_last_output` (`process.rs`). Alle vier Schluessel
 *  immer gesetzt; `lines` ist `[]` statt `null`, wenn nichts anliegt. Im
 *  Browser-Modus existiert die Route nicht, der Aufruf wirft dann. */
interface ComfyLastOutput {
  lines: string[]
  exited: boolean
  envBroken: boolean
  /** Der Befund des Installers zu genau diesem Absturz, leer wenn er keinen
   *  hat (Ticket 007). Er sticht den allgemeinen Reparatursatz, siehe
   *  `comfyCrashAdvice`. */
  hint: string
}

export function ComfyUISettings() {
  const [status, setStatus] = useState<ComfyStatusResponse | null>(null)
  // Why the last start attempt did not stick. The button used to swallow this
  // whole (E16): on a box with no ComfyUI python environment, Start answered
  // "started", the panel went back to `Stopped`, and six minutes later there
  // was still no reason anywhere on screen while the traceback sat in our own
  // ring buffer. An error is not allowed to be silence.
  const [startError, setStartError] = useState('')
  const [loading, setLoading] = useState(true)
  const [customPath, setCustomPath] = useState('')
  const [pathError, setPathError] = useState('')
  const [pathSuccess, setPathSuccess] = useState(false)
  const [customPort, setCustomPort] = useState('')
  const [portSuccess, setPortSuccess] = useState(false)
  const [portError, setPortError] = useState('')
  const [customHost, setCustomHost] = useState('')
  const [hostError, setHostError] = useState('')
  const [hostSuccess, setHostSuccess] = useState(false)
  // A13 (Windows counter-check 2026-09-02): install, update and repair used to
  // keep their phase, their log lines and their byte counters in this
  // component. Switching to another settings section threw all of it away
  // while pip kept running, and coming back showed an empty panel. The run now
  // reports into a store that outlives the mount, and this panel is a reader.
  const installPhase = useComfyInstallStore((s) => s.phase)
  const installLogs = useComfyInstallStore((s) => s.logs)
  const installErr = useComfyInstallStore((s) => s.error)
  // #162: size, rate and remaining time in the bracket next to the spinner.
  const installDl = useComfyInstallStore((s) => s.dl)
  const cancelling = useComfyInstallStore((s) => s.cancelling)
  const installNotice = useComfyInstallStore((s) => s.notice)
  // A15 review: every closing line used to be amber, so a repair that simply
  // worked reported itself in the colour of a warning.
  const installNoticeKind = useComfyInstallStore((s) => s.noticeKind)
  const clearInstallNotice = useComfyInstallStore((s) => s.clearNotice)
  // A failed run must not be a dead end. The phase stays `error` until
  // something clears it, and with the state outliving the mount the old escape
  // hatch (leave the section, lose the useState) is gone. So the start buttons
  // stay reachable on `error` too, and the card carries a Dismiss.
  const installIdle = installPhase === 'idle' || installPhase === 'error'

  // Der Beobachter unten liest `running` und `stalled` von hier, statt eine
  // zweite comfyui_status-Schleife aufzumachen: die Abfrage ist eine
  // HTTP-Probe mit 3 s Frist, und sie raeumt nebenbei den Kindhandle ab.
  //
  // Ein Spiegel und nicht der Zustand selbst, weil der Beobachter zwischen
  // zwei Renderdurchgaengen tickt: ein setState waere fuer ihn noch nicht da,
  // und er wuerde auf einer Antwort arbeiten, die schon ueberholt ist.
  // Geschrieben wird er an den zwei Stellen, die ueber diese beiden Felder
  // entscheiden, dem Statuspoll und dem Stop-Knopf.
  const statusNow = useRef<ComfyStatusResponse | null>(null)
  // Zaehlt die Antworten des Backends, damit der Beobachter eine Antwort von
  // NACH dem Startklick von der Aufnahme davor unterscheiden kann.
  const statusTick = useRef(0)
  // Die Generation des laufenden Startversuchs. Ein zweiter Klick, ein Stop
  // und das Ummounten zaehlen sie hoch, und ein Beobachter mit einer alten
  // Nummer sagt nichts mehr.
  const startWatch = useRef(0)
  useEffect(() => () => { startWatch.current += 1 }, [])

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const { backendCall, setComfyPort, setComfyHost } = await import('../../api/backend')
        const s = await backendCall<ComfyStatusResponse>('comfyui_status')
        if (!cancelled) {
          statusNow.current = s
          statusTick.current += 1
          setStatus(s)
          // Mirror backend truth into the frontend URL builder so subsequent
          // fetch() calls hit the right machine immediately, no restart needed.
          if (typeof s?.port === 'number' && s.port > 0) setComfyPort(s.port)
          if (typeof s?.host === 'string' && s.host.trim()) setComfyHost(s.host)
        }
      } catch {
        // Level (a): silent on purpose. This is the 5 s status poll below, and
        // a failed probe simply means the panel keeps showing the last known
        // state until the next tick. Every USER action in this panel (start,
        // stop, install, set port) reports its own failure; a poll that missed
        // one beat is not something to interrupt anyone about.
      }
      if (!cancelled) setLoading(false)
    }
    check()
    const interval = setInterval(check, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  /** Auf den Absturz warten, der nach dem Spawn kommt.
   *
   *  P3: eine ComfyUI-Kopie mit fehlendem Modul starb beim Start, und in der
   *  Oberflaeche kam GAR KEINE Meldung. Rust schaut 2 s zu (process.rs), hier
   *  stand ein einziges setTimeout ueber 6 s, und ComfyUI importiert 20 bis 60
   *  Sekunden lang, bevor es den Port bindet. Wer dazwischen stirbt, ist zu
   *  spaet fuer beide, und danach fragt niemand mehr.
   *
   *  Ein Fenster hochzudrehen haette das nur verschoben. Der Beobachter haengt
   *  jetzt am Startversuch statt an einem Augenblick und hoert auf, sobald
   *  einer dieser Punkte eintritt:
   *
   *  - der Port antwortet (`running`): fertig, keine Meldung,
   *  - der Start haengt so lange, dass Rust ihn `stalled` nennt: die Zeile
   *    unter dem Status uebernimmt, und der Beobachter braucht kein eigenes
   *    Zeitbudget und damit keine zweite Zahl neben COMFY_STARTING_GRACE_SECS,
   *  - der Nutzer drueckt Stop oder noch einmal Start, oder das Panel geht:
   *    die Generation stimmt nicht mehr,
   *  - das Kind ist weg: melden.
   *
   *  `exited` allein reicht nicht als Beweis: es ist auch wahr, wenn LU gar
   *  keinen Prozess haelt, also bei einem adoptierten Waisen und bei einem
   *  entfernten Host. Deshalb zaehlt nur eine Statusantwort, die NACH diesem
   *  Startklick eingetroffen ist. */
  const watchForLateCrash = async (generation: number) => {
    const { backendCall } = await import('../../api/backend')
    const tickAtStart = statusTick.current
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      if (startWatch.current !== generation) return
      // Noch keine frische Statusantwort: `exited` waere jetzt nur die
      // Aufnahme von vor dem Start.
      if (statusTick.current <= tickAtStart) continue
      const s = statusNow.current
      if (s?.running || s?.stalled) return
      let out: ComfyLastOutput | null = null
      try {
        out = await backendCall<ComfyLastOutput>('comfyui_last_output')
      } catch { continue }
      if (startWatch.current !== generation) return
      if (!out?.exited) continue
      // Ticket 007: welcher Satz unter die Ausgabe gehoert, entscheidet
      // comfyCrashAdvice fuer beide Oberflaechen. Vorher stand der
      // allgemeine Satz hier fest verdrahtet, und der konkrete Hinweis
      // aus dem Einordner des Installers erreichte den Kunden nie.
      setStartError(comfyStartupError(COMFY_START_FAILED, out.lines, comfyCrashAdvice(out)))
      return
    }
  }

  const handleStart = async () => {
    setStartError('')
    // Die gruene Zeile eines beendeten Laufs ist keine Aussage mehr ueber das,
    // was gerade passiert. Sie stand im Testbericht neben einem Start, der
    // abgestuerzt war, und sagte weiter "ComfyUI is ready".
    clearInstallNotice()
    const generation = ++startWatch.current
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('start_comfyui')
      setStatus(prev => prev ? { ...prev, starting: true } : null)
      void watchForLateCrash(generation)
    } catch (err) {
      // Hier braucht es keine neue Generation: die Nummer ist eine Zeile
      // weiter oben schon gestiegen, also ist ein Beobachter aus einem
      // frueheren Versuch bereits abgeloest, und fuer diesen hier wurde nie
      // einer gestartet.
      const message = err instanceof Error ? err.message : String(err)
      // P3, 7.2: ein Absturz binnen der zwei Sekunden, die Rust zuschaut, wirft
      // hier heraus. Ein Wurf plant keinen Beobachter, also erreichte der Satz
      // ueber die Visual-C++-Laufzeit den Kunden nur, wenn ComfyUI eine Sekunde
      // laenger durchgehalten hatte. Derselbe Einordner, dieselbe Route, eine
      // Zeile spaeter.
      let out: ComfyLastOutput | null = null
      try {
        const { backendCall } = await import('../../api/backend')
        out = await backendCall<ComfyLastOutput>('comfyui_last_output')
      } catch {
        // Ohne die Ausgabe bleibt es bei dem, was der Wurf selbst sagt. Das
        // ist die Meldung aus `comfy_startup_failure` und die traegt den
        // Traceback bereits.
      }
      setStartError(comfyStartThrowText(message, out))
    }
  }

  // GH #98: rebuild the ComfyUI venv (fresh isolated env, ~2 GB) through the
  // same status contract the installer uses, so the progress card just works.
  const handleRepair = async () => {
    setStartError('')
    await useComfyInstallStore.getState().runRepair()
  }

  // One button for every long run this panel starts. Rust checks the same flag
  // in every step of the installer and of the repair, so the run stops at the
  // next step boundary; until it does, the panel says it is cancelling instead
  // of pretending the click did nothing.
  const handleCancelInstall = () => {
    void useComfyInstallStore.getState().cancel()
  }

  const handleStop = async () => {
    setStartError('')
    // Ohne diese Zeile erfindet der Restart-Knopf einen Absturz: nach einem
    // Stop haelt LU keinen Prozess mehr, comfyui_last_output antwortet
    // `exited: true` mit den Zeilen des vorigen Laufs, und der Ringpuffer wird
    // erst beim naechsten Start geleert.
    startWatch.current += 1
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('stop_comfyui')
      statusNow.current = statusNow.current ? { ...statusNow.current, running: false } : null
      setStatus(prev => prev ? { ...prev, running: false } : null)
    } catch (e) {
      // Level (c): a stop that failed leaves the panel showing "running", which
      // is the truth — but without this line the button reads as a dud. Same
      // channel as the start failure, right under the same pair of buttons.
      setStartError(withDetail('ComfyUI did not stop. It may still be running — try again, or close it in its own window.', e))
    }
  }

  const handleSetPath = async () => {
    if (!customPath.trim()) return
    setPathError('')
    setPathSuccess(false)
    // Die Zeile nennt einen Ordner. Nach dem Wechsel redet sie ueber eine
    // andere Installation als die, die im Feld steht.
    clearInstallNotice()
    try {
      const { backendCall } = await import('../../api/backend')
      await backendCall('set_comfyui_path', { path: customPath.trim() })
      setPathSuccess(true)
      setStatus(prev => prev ? { ...prev, found: true, path: customPath.trim() } : { running: false, found: true, path: customPath.trim() })
      setTimeout(() => setPathSuccess(false), 3000)
    } catch (err) {
      setPathError(err instanceof Error ? err.message : 'Invalid path, main.py not found')
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-[0.65rem] text-gray-500"><Loader2 size={12} className="animate-spin" /> Checking...</div>
  }

  return (
    <div className="space-y-2">
      {/* Status */}
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Status</span>
        <div className="flex items-center gap-1.5">
          {/* Derselbe Punkt wie ueberall (lib/hinweis.ts): laeuft ist gruen,
              antwortet nicht mehr ist rot, alles andere grau. Der Punkt stand
              hier vorher auf Orange, sobald ComfyUI ueberhaupt gefunden war,
              und hat damit ein installiertes, gestopptes ComfyUI wie einen
              Zwischenfall aussehen lassen. */}
          <div className={`w-1.5 h-1.5 rounded-full ${status?.running ? PUNKT_FARBE.an : status?.stalled ? PUNKT_FARBE.kaputt : PUNKT_FARBE.aus}`} />
          <span className="text-[0.65rem] text-gray-500">
            {status?.running ? 'Running'
              : status?.stalled ? 'Not responding'
              : status?.starting ? 'Starting'
              : status?.found ? 'Stopped' : 'Not Installed'}
          </span>
        </div>
      </div>

      {startError && (
        <pre role="alert" className="whitespace-pre-wrap break-words text-[0.55rem] leading-relaxed text-red-400 bg-red-500/[0.06] border border-red-500/20 rounded p-2 max-h-40 overflow-y-auto">
          {startError}
        </pre>
      )}
      {/* Ein Start, der nicht ankommt, ist der Fehlerton und nicht der halbe:
          hier muss jemand ins Protokoll sehen, sonst bleibt ComfyUI stehen. */}
      {status?.stalled && !startError && (
        <p role="alert" className={`text-[0.55rem] ${HINWEIS_TEXT.fehler}`}>
          ComfyUI has been starting for a while without answering on its port. Use Show output below to see what it printed.
        </p>
      )}

      {/* Host - editable (supports remote ComfyUI: Docker, LAN, homelab) */}
      <div className="space-y-1">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Host</span>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={customHost || status?.host || 'localhost'}
            onChange={e => { setCustomHost(e.target.value); setHostError(''); setHostSuccess(false) }}
            placeholder="localhost or server-ip"
            className="flex-1 px-2 py-1 rounded-lg border text-[0.6rem] font-mono bg-transparent border-white/10 text-gray-300 focus:outline-none focus:border-white/25"
          />
          <button
            onClick={async () => {
              const host = customHost.trim()
              if (!host) { setHostError('Host required'); return }
              setHostError('')
              setHostSuccess(false)
              try {
                const { backendCall, setComfyHost } = await import('../../api/backend')
                await backendCall('set_comfyui_host', { host })
                setComfyHost(host)
                setHostSuccess(true)
                setStatus(prev => prev ? { ...prev, host, isLocal: ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host.toLowerCase()) } : null)
                setTimeout(() => setHostSuccess(false), 3000)
              } catch (err) {
                setHostError(err instanceof Error ? err.message : 'Invalid host')
              }
            }}
            disabled={!customHost.trim() || customHost.trim() === status?.host}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
          >
            Set
          </button>
        </div>
        {hostError && <p className="text-[0.55rem] text-red-400">{hostError}</p>}
        {hostSuccess && <p className="text-[0.55rem] text-green-400">Host saved. Restart ComfyUI to apply.</p>}
        {/* Nichts ist kaputt: der Nutzer hat einen fremden Host eingetragen
            und erfaehrt, was LU dort nicht kann. Ruhiger Ton. */}
        {status?.host && !status?.isLocal && (
          <p className={`text-[0.55rem] ${HINWEIS_TEXT.ruhig}`}>Remote ComfyUI, start/stop/install not available from LU. Manage the process on the server.</p>
        )}
      </div>

      {/* Path - editable (LOCAL ONLY: remote ComfyUI manages its own path) */}
      {status?.isLocal !== false && (
      <div className="space-y-1">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Path</span>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={customPath || status?.path || ''}
            onChange={e => { setCustomPath(e.target.value); setPathError(''); setPathSuccess(false) }}
            placeholder="C:\ComfyUI"
            className="flex-1 px-2 py-1 rounded-lg border text-[0.6rem] font-mono bg-transparent border-white/10 text-gray-300 focus:outline-none focus:border-white/25"
          />
          <button
            onClick={handleSetPath}
            disabled={!customPath.trim() || customPath.trim() === status?.path}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
          >
            Connect
          </button>
        </div>
        {pathError && <p className="text-[0.55rem] text-red-400">{pathError}</p>}
        {pathSuccess && <p className="text-[0.55rem] text-green-400">Path set successfully</p>}
      </div>
      )}

      {/* Port - editable */}
      <div className="space-y-1">
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Port</span>
        <div className="flex gap-1.5">
          <input
                aria-label="Port"
            type="number"
            value={customPort || status?.port || 8188}
            onChange={e => { setCustomPort(e.target.value); setPortSuccess(false) }}
            placeholder="8188"
            className="w-24 px-2 py-1 rounded-lg border text-[0.6rem] font-mono bg-transparent border-white/10 text-gray-300 focus:outline-none focus:border-white/25"
          />
          <button
            onClick={async () => {
              const port = parseInt(customPort)
              if (!port || port < 1 || port > 65535) return
              setPortError('')
              try {
                const { backendCall, setComfyPort } = await import('../../api/backend')
                await backendCall('set_comfyui_port', { port })
                setComfyPort(port)
                setPortSuccess(true)
                setTimeout(() => setPortSuccess(false), 3000)
              } catch (e) {
                // Level (c): the port was NOT saved. Without this the button
                // just fails to produce the green "Port saved" line, which is
                // indistinguishable from a slow save.
                setPortError(withDetail('The port was not saved. Pick a free port and try again.', e))
              }
            }}
            disabled={!customPort || parseInt(customPort) === (status?.port || 8188)}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
          >
            Set
          </button>
        </div>
        {portSuccess && <p className="text-[0.55rem] text-green-400">Port saved. Restart ComfyUI to apply.</p>}
        {portError && (
          <p role="alert" className="text-[0.55rem] text-red-500 dark:text-red-400 leading-snug whitespace-pre-line">
            {portError}
          </p>
        )}
      </div>

      {/* Controls, local host only (can't manage a remote process) */}
      {status?.isLocal !== false && (
      <div className="flex items-center gap-1.5">
        {status?.found && !status.running && (
          <button onClick={handleStart} className="px-2 py-1 rounded text-[0.6rem] bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors">
            Start
          </button>
        )}
        {status?.running && (
          <button onClick={handleStop} className="px-2 py-1 rounded text-[0.6rem] bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
            Stop
          </button>
        )}
        {status?.running && (
          <button
            onClick={async () => { await handleStop(); setTimeout(handleStart, 2000) }}
            className="px-2 py-1 rounded text-[0.6rem] bg-white/5 text-gray-400 hover:bg-white/10 transition-colors"
          >
            Restart
          </button>
        )}
        {/* GH #98: a from-source install whose Python env broke (shared system
            Python, dead torch) needs a rebuild, not a re-install — pip reports
            broken packages as already satisfied. Rebuilds ComfyUI/venv.

            Blau, weil es in dieser Knopfreihe noch frei war: Gruen gehoert
            Start, Rot dem Stop, Lila der Installation, Grau dem Rest. Das Gelb,
            das hier stand, war keine Warnung, sondern nur die naechste freie
            Farbe, und es hat den Knopf wie einen Notfall aussehen lassen. */}
        {status?.found && !status?.running && installIdle && (
          <button onClick={handleRepair} title="Rebuild the Python environment in an isolated venv (~2 GB). Models, outputs and custom nodes are left alone." className="px-2 py-1 rounded text-[0.6rem] bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors">
            Repair environment
          </button>
        )}
        {(!status?.found || status?.complete === false) && installIdle && (
          <button
            onClick={() => {
              // andy_38747 (Discord): let the Path field double as the install
              // target so the multi-GB install can land on another drive.
              // Empty field means the backend default (~/ComfyUI). On a carcass
              // re-install with no override, reuse the detected path so the
              // repair happens where the broken install lives.
              void useComfyInstallStore.getState().runInstall(customPath.trim() || status?.path || '')
            }}
            className="px-2 py-1 rounded text-[0.6rem] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
          >
            {status?.complete === false ? 'Re-install ComfyUI' : 'Install ComfyUI'}
          </button>
        )}
        {status?.found && status?.complete !== false && installIdle && (
          // 2.5.8: the specialized local lanes (music / talking character /
          // motion) need node families that ship with current cores — this is
          // the one-click git pull + dependency refresh the lane errors point
          // to. Reuses the installer's status channel and log panel.
          <button
            onClick={() => { void useComfyInstallStore.getState().runUpdate() }}
            className="px-2 py-1 rounded text-[0.6rem] bg-white/5 text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
          >
            Update ComfyUI
          </button>
        )}
        {(!status?.found || status?.complete === false) && installIdle && (
          <p className="w-full t-micro text-gray-600">
            Installs to your home folder by default. Set Path above (e.g. D:\ComfyUI) to install on another drive.
          </p>
        )}
        {installNotice && installPhase === 'idle' && (
          <div className="w-full flex items-start gap-1.5">
            <p
              data-testid="comfy-install-notice"
              data-kind={installNoticeKind}
              // Ein 'warn' entsteht nur dort, wo der Lauf abgebrochen wurde
              // oder etwas nicht benutzt werden konnte, und jeder dieser
              // Saetze endet mit "lauf das nochmal". Das ist der Fehlerton,
              // nicht das Gelb, das frueher hier stand und die Zeile zwischen
              // fertig und kaputt haengen liess.
              className={`flex-1 t-micro leading-relaxed ${
                installNoticeKind === 'warn'
                  ? HINWEIS_TEXT.fehler
                  : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {installNotice}
            </p>
            {/* Review 03.09.: nothing ever put this line away, so one finished
                run kept unfolding the section on every visit for the rest of
                the session.

                A16 (A15-5): the counter-check reported the closing line as
                having no dismiss at all. It had one, a bare 10px X with the
                word only in the tooltip, standing beside a failed run whose
                dismiss is a labelled button reading "Dismiss". One of the two
                is findable and it was not this one. Same control, same word,
                and the X stays as the icon beside it. */}
            <button
              onClick={clearInstallNotice}
              aria-label="Dismiss this message"
              title="Dismiss"
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded border border-white/15 t-micro text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
            >
              <X size={9} /> Dismiss
            </button>
          </div>
        )}
        {installPhase !== 'idle' && (
          <div className="w-full mt-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[0.6rem] text-gray-400">
              {installPhase !== 'error' && <Loader2 size={10} className="animate-spin" />}
              <span>
                {cancelling && installPhase !== 'error'
                  ? 'Cancelling…'
                  : <>
                      {installPhase === 'checking' && 'Checking Python…'}
                      {installPhase === 'python' && 'Installing Python 3.12 (~30 MB)…'}
                      {installPhase === 'comfyui' && `Installing ComfyUI…${downloadSuffix(installDl)}`}
                      {installPhase === 'repair' && `Rebuilding the ComfyUI environment…${downloadSuffix(installDl)}`}
                      {installPhase === 'error' && 'Install failed'}
                    </>}
              </span>
              {installPhase === 'error' && (
                <button
                  onClick={() => useComfyInstallStore.getState().reset()}
                  title="Clear this message"
                  className="ml-auto px-1.5 py-[1px] rounded border border-white/15 t-micro text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
                >
                  Dismiss
                </button>
              )}
              {(installPhase === 'comfyui' || installPhase === 'repair') && (
                <button
                  onClick={handleCancelInstall}
                  disabled={cancelling}
                  title={installPhase === 'repair' ? 'Stop the repair' : 'Stop the ComfyUI install'}
                  className="ml-auto px-1.5 py-[1px] rounded border border-red-500/40 t-micro text-red-500 dark:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
            </div>
            {installLogs.length > 0 && (
              <div className="bg-black/50 rounded p-1.5 max-h-24 overflow-y-auto font-mono text-[0.5rem] text-gray-500 space-y-0.5">
                {installLogs.slice(-6).map((log, i) => <div key={i} className="truncate">{log}</div>)}
              </div>
            )}
            {installErr && <p className="t-micro text-red-400 whitespace-pre-line">{installErr}</p>}
          </div>
        )}
      </div>
      )}
    </div>
  )
}

// ── Coding Agent (v2.5.0) Settings ──────────────────────────────

function CodexAgentSettings() {
  const { settings, updateSettings } = useSettingsStore()
  return (
    <div className="space-y-3">
      <div className="text-[0.6rem] text-gray-500 leading-relaxed pb-1">
        v2.5.0 coding-agent capabilities ported from the companion repo. All
        local-first by default. Cloud usage requires the explicit toggle below.
      </div>

      {/* Architect / Editor split */}
      <InlineToggle
        label="Architect / Editor split"
        enabled={settings.codexArchitectMode}
        onChange={() => updateSettings({ codexArchitectMode: !settings.codexArchitectMode })}
      />
      <div className="space-y-1 pl-1">
        <label className="text-[0.6rem] text-gray-500 block">Architect model</label>
        <input
          type="text"
          value={settings.codexArchitectModel}
          onChange={(e) => updateSettings({ codexArchitectModel: e.target.value })}
          disabled={!settings.codexArchitectMode}
          placeholder="ollama::qwen-coder:32b"
          className="w-full px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:border-white/20 disabled:opacity-40"
        />
        <p className="text-[0.55rem] text-gray-500">Empty = use the active coding agent model.</p>
      </div>
      <InlineToggle
        label="Allow cloud architect models"
        enabled={settings.codexArchitectAllowCloud}
        onChange={() => updateSettings({ codexArchitectAllowCloud: !settings.codexArchitectAllowCloud })}
        // Cloud erlaubt ist kein Fehler, sondern eine Wahl des Nutzers, also
        // der ruhige Ton statt des Gelbs, das hier stand. Gruen bleibt die
        // Aussage "bleibt vollstaendig auf diesem Rechner".
        icon={<Shield size={10} className={settings.codexArchitectAllowCloud ? HINWEIS_TEXT.ruhig : 'text-emerald-500'} />}
      />
      <p className="text-[0.55rem] text-gray-500 leading-relaxed pl-1">
        Off keeps the architect step fully local. On allows third-party
        endpoints (Anthropic, OpenAI, OpenRouter).
      </p>

      {/* Repo-Map */}
      <div className="pt-1.5 border-t border-white/[0.04]" />
      <InlineToggle
        label="Repo-Map injection"
        enabled={settings.codexRepoMapEnabled}
        onChange={() => updateSettings({ codexRepoMapEnabled: !settings.codexRepoMapEnabled })}
      />
      <div className={settings.codexRepoMapEnabled ? '' : 'opacity-40 pointer-events-none'}>
        <SliderControl
          label="Repo-Map top-N files"
          value={settings.codexRepoMapLimit}
          min={1}
          max={200}
          step={1}
          onChange={(v) => updateSettings({ codexRepoMapLimit: v })}
        />
      </div>

      {/* /loop — unlimited by default. The stop button and the loop bar above
          the composer are the brake; a number here is only for people who want
          a hard stop after N passes. */}
      <div className="pt-1.5 border-t border-white/[0.04]" />
      <div className="flex items-center justify-between gap-3 py-1">
        <div className="min-w-0">
          <div className="text-[0.7rem] text-gray-700 dark:text-gray-300">Maximum /loop passes</div>
          <div className="text-[0.6rem] text-gray-500">
            0 means unlimited: the loop keeps checking until it reports done or you stop it.
          </div>
        </div>
        <input
                aria-label="Maximum /loop passes"
          type="number"
          min={0}
          value={settings.loopMaxPasses}
          onChange={(e) => updateSettings({ loopMaxPasses: Math.max(0, parseInt(e.target.value, 10) || 0) })}
          className="w-16 shrink-0 px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/10 bg-transparent text-[0.7rem] text-right text-gray-800 dark:text-gray-200"
        />
      </div>

      {/* Stage + Review */}
      <div className="pt-1.5 border-t border-white/[0.04]" />
      <InlineToggle
        label="Stage file_write changes (review before apply)"
        enabled={settings.codexStageMode}
        onChange={() => updateSettings({ codexStageMode: !settings.codexStageMode })}
      />
      {settings.codexStageMode && (
        <InlineToggle
          label="Auto-apply staged changes when the run finishes (no per-file clicking)"
          enabled={settings.codexAutoApply}
          onChange={() => updateSettings({ codexAutoApply: !settings.codexAutoApply })}
        />
      )}
      <InlineToggle
        label="Code-Review mode (read-only)"
        enabled={settings.codexReviewMode}
        onChange={() => updateSettings({ codexReviewMode: !settings.codexReviewMode })}
      />
      <InlineToggle
        label="Confirm shell & code commands (prevents prompt-injection from auto-running commands)"
        enabled={settings.codexConfirmShell}
        onChange={() => updateSettings({ codexConfirmShell: !settings.codexConfirmShell })}
      />
      {/* Cloud arm of the same gate, an opt-in since David's decision of
          2026-08-22: off by default, a cloud model runs like a local one, and
          Bypass really bypasses. Always shown, because it governs Agent mode
          too, which ignores the Codex-only toggle above. */}
      <InlineToggle
        label="Also confirm shell & code when Agent or Coding runs on an LU Cloud model (off by default, and it asks in Bypass too)"
        enabled={settings.codexCloudConfirmOptIn}
        onChange={() => updateSettings({ codexCloudConfirmOptIn: !settings.codexCloudConfirmOptIn })}
      />
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────

// P5 settings refactor: Top-level tabs replace the previous flat scroll of
// 17 collapsibles. Each tab groups conceptually related Sections so users
// don't have to scan the whole list to find one toggle. Mapping (kept in
// sync with LU-Aufgaben.md / IMPLEMENTATION_NOTES.md):
//
//   General      → Appearance · Generation · Privacy · Onboarding · Updates
//   AI Backends  → Providers · Model Storage · ComfyUI
//   Agent        → Personas · Memory · Agent Permissions ·
//                  Agent Workflows · MCP Servers · Search Provider
//   Voice & Remote → Speech · Remote Access
//
// Tab choice is persisted in localStorage so the user's last-used view
// survives reloads.
const SETTINGS_TAB_KEY = 'lu-settings-tab'
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'general',      label: 'General',      icon: <Sliders size={11} /> },
  { id: 'backends',     label: 'AI Backends',  icon: <Plug size={11} /> },
  { id: 'agent',        label: 'Agent',        icon: <Bot size={11} /> },
  { id: 'voice-remote', label: 'Voice & Remote', icon: <Phone size={11} /> },
]

// GitHub #59 — the old single "Reset to Defaults" button fired silently with
// no confirm and no feedback, so users reported it as "does nothing". Now:
// arm-then-confirm (second click within 4s), per-tab scope, and an explicit
// success line after the reset.
//
// Nebenbefund 2 of the R9 re-measure (2026-08-30) read the first click as a
// dud. Checked and kept as it is: the armed button relabels to "Click again to
// reset <tab>", turns red and goes medium weight, and the first click writes
// nothing at all. That is the same arm-then-confirm the Cloud switch got in
// round 6, and the same reasoning holds here: two clicks on one control is the
// cheapest confirmation there is, no dialog and no mouse travel. The three
// visible signals are pinned by
// src/lib/__tests__/reset-arming-is-visible.test.ts.
function ResetSection({ tab }: { tab: SettingsTab }) {
  const resetSettingsKeys = useSettingsStore((s) => s.resetSettingsKeys)
  const resetSettings = useSettingsStore((s) => s.resetSettings)
  const resetVoiceDefaults = useVoiceStore((s) => s.resetVoiceDefaults)
  const resetPermissions = usePermissionStore((s) => s.resetToDefaults)
  // The arm records the tab it was made on, so "still armed?" is a question
  // that can be answered while rendering. Switching tabs while armed must
  // disarm — otherwise a click armed on General would confirm-fire on Agent —
  // and armedScopeFor() is that rule (src/lib/reset-arming.ts). It replaces a
  // `useEffect(..., [tab])` that disarmed one render too late.
  const [arm, setArm] = useState<ResetArm<SettingsTab>>(null)
  const armed = armedScopeFor(arm, tab)
  const setArmed = (which: ResetArmScope | null) =>
    setArm(which === null ? null : { scope: which, tab })
  const [done, setDone] = useState<string | null>(null)
  const armTimer = useRef<number | null>(null)
  const doneTimer = useRef<number | null>(null)

  const tabLabel = SETTINGS_TABS.find((t) => t.id === tab)?.label ?? 'section'

  useEffect(() => () => {
    if (armTimer.current) window.clearTimeout(armTimer.current)
    if (doneTimer.current) window.clearTimeout(doneTimer.current)
  }, [])

  const handleClick = (which: 'section' | 'all') => {
    if (armed !== which) {
      setArmed(which)
      if (armTimer.current) window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => setArmed(null), 4000)
      return
    }
    if (armTimer.current) window.clearTimeout(armTimer.current)
    setArmed(null)
    if (which === 'all') {
      resetSettings()
      resetVoiceDefaults()
      resetPermissions()
      setDone('All settings restored to defaults')
    } else {
      resetSettingsKeys(SETTINGS_TAB_RESET_KEYS[tab])
      if (tab === 'agent') resetPermissions()
      if (tab === 'voice-remote') resetVoiceDefaults()
      // G20: "Reset AI Backends" only reset settings KEYS and never touched
      // the provider store, so it could not hand the openai slot back to the
      // Built-in Engine once LM Studio had adopted it. Now it restores the
      // shipped slots too (API keys and the cloud account flag are kept).
      if (tab === 'backends') useProviderStore.getState().resetProvidersToDefaults()
      setDone(`${tabLabel} settings restored to defaults`)
    }
    if (doneTimer.current) window.clearTimeout(doneTimer.current)
    doneTimer.current = window.setTimeout(() => setDone(null), 3000)
  }

  return (
    <div className="pt-3 pb-6 space-y-2.5">
      {/* D-S29: die beiden Reset-Aktionen sahen gleich aus — zwei graue
          Textlinks nebeneinander, von denen einer sehr viel mehr loescht.
          Die gefaehrlichere traegt jetzt eine eigene Form (umrandete
          Gefahrfarbe statt Textlink), eine eigene Zeile und einen Satz, der
          den Unterschied benennt — Text UND Kante durch WCAG, also auch
          1.4.11 (3:1) fuer die Umrandung. Vorher stand "Reset all settings"
          im Dunkelmodus auf gray-600, war also ausgerechnet die unlesbarere
          der beiden.

          ZWEITER DURCHGANG (01.09.2026), und er hat den Rest des Befundes
          umgedreht. Die Matrix fuehrte hier eine offene Luecke: „der
          tab-weite Reset-Link steht im Dunkelmodus weiter auf 3.37:1". Diese
          Zahl war aus KLASSENNAMEN gerechnet — gray-500 #6b7280 auf einem
          angenommenen #202020. Im laufenden Fenster (Chromium, Farben aus
          getComputedStyle, oklch ueber eine 1x1-Canvas aufgeloest) steht
          nichts davon:

            Grund unter dem Link  #1e1e1e (die Settings-Pane), nicht #202020
            Ruhe dunkel  gray-500 -> #9ca3af    6.57:1   ✓ AA
            Ruhe hell    gray-500 -> #374151   10.31:1   ✓ AA

          Der Rescue-Layer (index.css:867/873) hebt `.dark .text-gray-500`
          auf gray-400 und `.light .text-gray-500` auf gray-700 — die Luecke
          war zu, bevor dieser Durchgang begann.

          Was NICHT zu war und in keiner Zeile stand: der SCHARFE Zustand
          desselben Knopfs. `text-red-400` ohne hellen Gegenpart, und
          red-400 heisst in Tailwind 4 #ff6467, nicht das #f87171 der
          Rechnungen von damals:

            scharf dunkel #ff6467 auf #1e1e1e   5.77:1   ✓ AA
            scharf hell   #ff6467 auf #ffffff   2.89:1   ✗ unter 4.5:1

          Also genau die Umkehrung des Ausgangsbefundes: gefaehrlich wird der
          Knopf erst mit dem ersten Klick, und ab da war er im Hellmodus der
          unlesbarere. Er traegt jetzt dasselbe Rotpaar wie der Gefahrknopf
          darunter (red-600 hell / red-400 dunkel), kein drittes Rezept;
          dasselbe gilt fuer den Hover, der vorher denselben Fehler machte.

          Die Klassen dieses Knopfs sind woertlich gepinnt, und zwar in einer
          FREMDEN Datei: src/lib/__tests__/reset-arming-is-visible.test.ts.
          Deren Farbzeile ist mitgezogen worden — bewusst, im Bericht
          benannt, und mit demselben Biss wie vorher (voller Literalvergleich
          beider Zweige). */}
      <button
        onClick={() => handleClick('section')}
        className={`flex items-center gap-1.5 text-[0.65rem] transition-colors ${
          armed === 'section' ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-500 hover:text-red-600 dark:hover:text-red-400'
        }`}
      >
        <RotateCcw size={11} />
        {armed === 'section' ? `Click again to reset ${tabLabel}` : `Reset ${tabLabel} to defaults`}
      </button>
      <div className="flex items-start gap-2.5">
        <button
          onClick={() => handleClick('all')}
          className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[0.6rem] transition-colors ${
            armed === 'all'
              ? 'bg-red-600 border-red-600 text-white font-medium'
              : 'border-red-600 text-red-600 hover:bg-red-600/10 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-400/10'
          }`}
        >
          <AlertTriangle size={11} />
          {armed === 'all' ? 'Click again to reset everything' : 'Reset all settings'}
        </button>
        <p className="text-[0.55rem] text-gray-500 dark:text-gray-400 leading-snug pt-1">
          Every tab, not just {tabLabel}.
        </p>
      </div>
      {done && (
        <div className="flex items-center gap-1.5 text-[0.6rem] text-emerald-500">
          <Check size={11} /> {done}
        </div>
      )}
      <div className="text-[0.55rem] text-gray-500 dark:text-gray-600 leading-snug">
        Personas, memories, conversations, workflows and MCP servers are kept.
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { settings, updateSettings } = useSettingsStore()
  // ENG-2 — the expert panel only exists when the openai slot IS the
  // app-managed built-in engine (same gate as the send-path self-heal).
  const builtinManaged = useProviderStore((s) => !!s.providers.openai?.enabled && s.providers.openai?.managed === true)
  const { setView } = useUIStore()
  // Where the navigation that opened this page wanted to land. Read ONCE, at
  // mount, and held for this mount's whole life: `defaultOpen` below is an
  // initial value, so a focus that vanished from the store on the next render
  // would fold the section straight back up (Nebenbefund 3, R8 re-measure).
  const [entryFocus] = useState(() => useUIStore.getState().settingsFocus)
  useEffect(() => { useUIStore.getState().clearSettingsFocus() }, [])
  const [tab, setTab] = useState<SettingsTab>(() => {
    if (entryFocus) return entryFocus.tab
    if (typeof window === 'undefined') return 'general'
    const stored = window.localStorage.getItem(SETTINGS_TAB_KEY)
    return (stored === 'general' || stored === 'backends' || stored === 'agent' || stored === 'voice-remote')
      ? stored
      : 'general'
  })
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Level (a): silent on purpose. This only remembers which tab was open
      // for the next visit. If storage is full or blocked (private window),
      // Settings opens on General next time — a convenience lost, not an
      // action failed, and nothing the user could act on.
      try { window.localStorage.setItem(SETTINGS_TAB_KEY, tab) } catch { /* see above */ }
    }
  }, [tab])


  // D-S27: die Bedingungen, unter denen einzelne Sektionen ueberhaupt
  // erscheinen, stehen ab hier EINMAL — die Rail liest sie ueber
  // sectionsFor(), das JSX weiter unten benutzt dieselben Ausdruecke.
  const sectionFlags: SettingsSectionFlags = {
    gpuPicker: !isMlxImageHost(),
    builtinExpert: builtinManaged,
    comfyui: !isMlxImageHost(),
    agentMode: FEATURE_FLAGS.AGENT_MODE,
    agentWorkflows: FEATURE_FLAGS.AGENT_WORKFLOWS,
    mediaTimeouts: settings.appMode !== 'cloud' && !isMlxImageHost(),
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      {/* D-S27 / D-S48: vorher `max-w-lg mx-auto` — eine 552px-Spalte, die in
          der Fenstermitte schwebte und bei 1600px links und rechts je ~524px
          Leere stehen liess. Die Zeilenlaenge war richtig, die Aufhaengung
          nicht. Jetzt: 200px-Rail links, Inhalt linksbuendig daneben, gedeckelt
          auf 640px (Soll des Audits). Die Rail erscheint ab `lg` (1024px
          Fensterbreite); darunter bleibt die waagerechte Tab-Leiste, weil
          200 + 640 in einem 900px-Fenster mit Sidebar nicht nebeneinander
          passen — und bei 900px sah der Screen laut Audit ohnehin besser aus
          als bei 1600px.

          D-S48, zweiter Durchgang: `justify-center`. Die Spaltenbreite bleibt
          unangetastet — die Zeilenlaenge war laut Audit richtig, und ein
          Inhalt, der mit dem Fenster mitwaechst, waere ein anderer, nicht
          behobener Befund. Falsch war nur die VERTEILUNG des Rests: er stand
          vollstaendig rechts. Gemessen im laufenden Fenster (Chromium,
          Dev-Server auf 5273, Sidebar zu, --ui-scale 1.15, gerenderte px,
          Leerraum zwischen Pane-Rand und erster/letzter Spalte):

            Fenster   vorher links / rechts     nachher links / rechts
             1280 px      36,8 / 231,2            134,0 / 134,0
             1440 px      36,8 / 391,2            214,0 / 214,0
             1920 px      36,8 / 871,2            454,0 / 454,0

          Zentriert wird das PAAR aus Rail und Inhalt, nicht der Inhalt
          allein — sonst haenge die Spalte wieder frei in der Mitte, und
          genau das war D-S27. Sie haengt weiterhin an der Rail, das Paar
          steht jetzt nur mittig im verfuegbaren Raum. Ueberlaufsicher: unter
          `lg` faellt die Rail auf `display:none` und der Inhalt hat
          `min-w-0` — es bleibt kein freier Raum uebrig, den `justify-center`
          verteilen koennte, und die Zeile bricht nicht nach links aus. */}
      <div className="flex justify-center gap-6 px-4 py-4 lg:px-8">
        <nav
          aria-label="Settings sections"
          className="hidden lg:flex w-[200px] shrink-0 flex-col gap-4 sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-y-auto scrollbar-thin"
        >
          <div className="flex items-center gap-2">
            <button onClick={() => setView('chat')} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/5 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors" aria-label="Back to chat">
              <ArrowLeft size={16} />
            </button>
            {/* D-S28: die Spitze der Leiter. 1.15rem = 21,2px bei 18,4px
                Wurzelmass — eine Stufe der 12/13/15/17/21/28-Skala des
                Audits, und endlich groesser als ein Sektionskopf. */}
            <h1 className="text-[1.15rem] font-semibold leading-tight text-gray-900 dark:text-gray-100">Settings</h1>
          </div>

          <div className="flex flex-col gap-0.5">
            {SETTINGS_TABS.map(t => (
              <div key={t.id}>
                {/* D-S30: Zustand und Aktion trugen dieselbe Flaeche
                    (`bg-gray-200 dark:bg-white/10` hier wie am Upload-Knopf).
                    Der ausgewaehlte Tab spricht jetzt die Zustandssprache:
                    Akzentflaeche + Akzentkante links. Aktionen behalten die
                    neutrale graue Flaeche. Gerechnet: die Kante
                    #8b7cf0 auf Weiss 3.37:1 und #a094f8 auf #202020 6.27:1 —
                    beide ueber den 3:1 aus WCAG 1.4.11 fuer Nicht-Text. */}
                <button
                  onClick={() => setTab(t.id)}
                  aria-current={tab === t.id ? 'page' : undefined}
                  className={`w-full inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-md text-[0.7rem] font-medium border-l-2 transition-colors ${
                    tab === t.id
                      ? 'bg-lu-accent-soft border-l-lu-accent-edge dark:border-l-lu-accent text-gray-900 dark:text-white'
                      : 'border-l-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
                {tab === t.id && (
                  <ul className="mt-1 mb-1 ml-[0.6rem] border-l border-gray-200 dark:border-white/[0.08]">
                    {sectionsFor(t.id, sectionFlags).map(title => (
                      <li key={title}>
                        <a
                          href={`#${sectionAnchorId(title)}`}
                          className="block pl-3 pr-1 py-[3px] text-[0.62rem] leading-snug text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                        >
                          {title}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 w-full max-w-[640px]">
        {/* Header — nur unterhalb von `lg`; ab da traegt die Rail Titel und
            Zurueck-Knopf. */}
        <div className="lg:hidden flex items-center gap-2 mb-4">
          <button onClick={() => setView('chat')} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/5 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors">
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-[1.15rem] font-semibold leading-tight text-gray-900 dark:text-gray-100">Settings</h1>
        </div>

        {/* P5: top-level tabs. Sticky so the user can switch tabs from
            anywhere in a long Section without scrolling back up. Ab `lg`
            uebernimmt die Rail diese Aufgabe — zwei gleichzeitig sichtbare
            Navigationen fuer dieselbe Sache waeren genau der Befund, den
            D-S27 beschreibt. */}
        <div className="lg:hidden sticky top-0 z-10 -mx-4 px-4 pb-2 mb-2 bg-white/80 dark:bg-[#202020]/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:supports-[backdrop-filter]:bg-[#202020]/60 border-b border-gray-100 dark:border-white/[0.06]">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin">
            {SETTINGS_TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[0.65rem] font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-lu-accent-soft ring-1 ring-lu-accent-edge dark:ring-lu-accent text-gray-900 dark:text-white'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.04]'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── General tab ──────────────────────────────── */}
        {tab === 'general' && (<>
          <Section title="LU Cloud Account" defaultOpen>
            <AccountPanel />
            {/* Local-mode discovery layer (2.5.8): the locked Create tabs +
                hosted-model rows. The teaser sheet's "Hide Cloud features"
                link flips this off; this is the way back on. */}
            <div className="flex items-center justify-between pt-1">
              <div className="min-w-0 pr-3">
                <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Show Cloud features in Local mode</span>
                <p className="text-[0.6rem] text-gray-500 dark:text-gray-600 leading-snug">
                  Cloud previews on Create tools and model lists, plus Try cloud tags on the tools that run both ways. Never blocks a local flow.
                </p>
              </div>
              <button
                onClick={() => updateSettings({ cloudTeasersEnabled: !settings.cloudTeasersEnabled })}
                className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${
                  settings.cloudTeasersEnabled ? 'bg-violet-500/70' : 'bg-gray-300 dark:bg-white/10'
                }`}
                role="switch"
                aria-checked={settings.cloudTeasersEnabled}
                aria-label="Show Cloud features in Local mode"
              >
                <span
                  className={`absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow transition-all ${
                    settings.cloudTeasersEnabled ? 'left-[16px]' : 'left-[2px]'
                  }`}
                />
              </button>
            </div>
          </Section>
          {/* Keys are minted and revoked on lu-labs.ai only; the desktop app
              never sees the plaintext, so this section just points there. */}
          <Section title="Cloud API Keys">
            <p className="text-[0.6rem] text-gray-500 leading-relaxed">
              Use the chat models of your plan from Aider, LibreChat or any OpenAI-compatible tool.
              Base URL <code className="font-mono select-text text-gray-700 dark:text-gray-300">{CLOUD_BASE}/api/inference/v1</code>, your key as the API key.
              A key spends plan tokens only; it can never read or change the account.
            </p>
            <button
              onClick={() => void openExternal(`${CLOUD_BASE}/account`)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.65rem] font-medium bg-violet-500/15 text-violet-500 dark:text-violet-300 hover:bg-violet-500/25 transition-colors"
            >
              <KeyRound size={11} /> Generate API key on lu-labs.ai
            </button>
          </Section>
          <Section title="Appearance">
            {/* D-S30, zweite Haelfte des Befundes: „Dark" (ein ZUSTAND) und
                „Upload" in AvatarSetting (eine AKTION) trugen beide
                `bg-gray-200 dark:bg-white/10`. Zustand spricht ab hier
                ueberall dieselbe Sprache wie der aktive Tab — Akzentflaeche
                mit Akzentkante — und die neutrale graue Flaeche bleibt den
                Aktionen. */}
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Theme</span>
              <div className="flex gap-1">
                <button
                  onClick={() => updateSettings({ theme: 'light' })}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[0.65rem] transition-colors ${
                    settings.theme === 'light' ? 'bg-lu-accent-soft ring-1 ring-lu-accent-edge dark:ring-lu-accent text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  <Sun size={11} /> Light
                </button>
                <button
                  onClick={() => updateSettings({ theme: 'dark' })}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[0.65rem] transition-colors ${
                    settings.theme === 'dark' ? 'bg-lu-accent-soft ring-1 ring-lu-accent-edge dark:ring-lu-accent text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  <Moon size={11} /> Dark
                </button>
              </div>
            </div>
            <AvatarSetting />
          </Section>

          <Section title="Generation">
            <SliderControl label="Temperature" value={settings.temperature} min={0} max={2} step={0.1} onChange={(v) => updateSettings({ temperature: v })} />
            <SliderControl label="Top P" value={settings.topP} min={0} max={1} step={0.05} onChange={(v) => updateSettings({ topP: v })} />
            <SliderControl label="Top K" value={settings.topK} min={1} max={100} step={1} onChange={(v) => updateSettings({ topK: v })} />
            {/* Die drei Zahlenzeilen dieser Sektion stehen auf der Leiter statt
                in eckigen Klammern (D-T04). Sie taten es nicht, und als 2.6.8
                eine vierte dazukam, hat die Sperrklinke das gefangen — der
                Ausweg war nicht, den Deckel zu heben, sondern die Zeilen zu
                stellen. `.t-micro` ist der schlichte Kleintext der Leiter,
                `.t-mono` ihr Rezept fuer eine Zahl (Ziffernbreite fest, damit
                die Werte untereinander nicht wandern). */}
            <div className="flex items-center justify-between">
              <span className="t-micro text-gray-700 dark:text-gray-400">Max Tokens</span>
              <input
                aria-label="Max Tokens"
                type="number"
                value={settings.maxTokens}
                onChange={(e) => updateSettings({ maxTokens: Math.max(0, parseInt(e.target.value) || 0) })}
                min={0}
                placeholder="0"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 t-mono text-right text-gray-300 focus:outline-none focus:border-white/20"
              />
            </div>
            {/* Bug AA v2.5.0 — Ollama num_ctx override. 0 = use the provider
                default (Ollama default = 2048 on most builds, which silently
                clips RAG / long chats). Bump up to use the model's full
                context window. Ignored by Anthropic / OpenAI providers. */}
            <div className="flex items-center justify-between">
              <span className="t-micro text-gray-700 dark:text-gray-400" title="Forwarded as Ollama num_ctx. 0 = provider default (Ollama defaults to 2048, which clips RAG and long chats). Bump up to use the model's full context. Ignored by cloud providers.">Context window (Ollama)</span>
              <input
                aria-label="Context window (Ollama)"
                type="number"
                value={settings.contextWindowOverride ?? 0}
                onChange={(e) => updateSettings({ contextWindowOverride: Math.max(0, parseInt(e.target.value) || 0) })}
                min={0}
                placeholder="0"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 t-mono text-right text-gray-300 focus:outline-none focus:border-white/20"
              />
            </div>
            <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed pt-0.5">
              0 = let Ollama decide (defaults to 2048). Set to e.g. 8192 or 16384 if RAG / long chats get clipped. Cloud providers ignore this.
            </div>
            {/* 2.6.8 auto-compact. Shown as a percentage and stored as a
                fraction, because the threshold is compared against a ratio
                (compact-trigger.ts). Same shape as the row above — a number
                input whose 0 is the off state — rather than a slider, because
                a slider has no way to express "off" at all. */}
            <div className="flex items-center justify-between">
              <span
                className="t-micro text-gray-700 dark:text-gray-400"
                title="When the conversation fills this much of the window, the model writes a summary of the older turns and those turns stop being sent. 0 = off. The full history stays in the chat either way; only what is sent changes."
              >Auto-compact at</span>
              <div className="flex items-center gap-1">
                <input
                aria-label="Auto-compact at"
                  type="number"
                  value={Math.round((settings.autoCompactThreshold || 0) * 100)}
                  onChange={(e) => {
                    const pct = Math.max(0, Math.min(100, parseInt(e.target.value) || 0))
                    updateSettings({ autoCompactThreshold: pct === 0 ? 0 : pct / 100 })
                  }}
                  min={0}
                  max={100}
                  step={5}
                  placeholder="0"
                  className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 t-mono text-right text-gray-300 focus:outline-none focus:border-white/20"
                />
                <span className="t-mono text-gray-500 w-3">%</span>
              </div>
            </div>
            <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed pt-0.5">
              0 = off. Set 80 to have older turns summarised once the context is 80% full, instead of being dropped without a word. Values under 30 or over 95 count as off. Costs one extra model call each time it fires. You can always run it yourself with <span className="font-mono">/compact</span>.
            </div>

          </Section>

          {/* Bug BB v2.5.0 — BobbyT GPU picker. Lazy-loads the GPU list when
              the section opens via detect_gpus probe (nvidia-smi + rocm-smi +
              lspci/wmic). */}
          {/* Not on macOS: every knob in there is a no-op on Apple Silicon.
              The vendor picker forwards CUDA_VISIBLE_DEVICES / HIP_* /
              ONEAPI_* to Ollama and ComfyUI — none of which exist here (Metal,
              unified memory, and ComfyUI never launches). Showing a dead
              NVIDIA/AMD/Intel selector is worse than showing nothing. */}
          {!isMlxImageHost() && (
            <Section title="Hardware (GPU picker)">
              <HardwareSettings />
            </Section>
          )}

          {/* Feature CC v2.5.0 — MikeS++ chatbot export importer. Parses
              ChatGPT / Claude / Gemini export JSON (or .zip), pre-selects
              every conversation, feeds the chosen ones into the active
              chat's RAG store. */}
          <Section title="Import from other chatbots">
            <ChatbotImporter />
          </Section>

          <Section title="Chat Backup">
            <ChatBackupSettings />
          </Section>

          {/* ComfyUI-only knobs — cloud renders use server-side limits, and the
              Mac's MLX pipeline has its own fixed timeout, so hide there too. */}
          {settings.appMode !== 'cloud' && !isMlxImageHost() && (
          <Section title="Image / Video Generation Timeouts">
            <div className="text-[0.6rem] text-gray-500 dark:text-gray-500 leading-relaxed pb-1.5">
              Maximum minutes a ComfyUI generation can run before LU aborts it. Bump these up if you run on iGPU or CPU only, because a 1024px image on integrated graphics can take 30+ min.
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Image timeout (min)</span>
              <input
                aria-label="Image timeout (min)"
                type="number"
                value={settings.imageGenTimeoutMinutes ?? 20}
                onChange={(e) => updateSettings({ imageGenTimeoutMinutes: Math.min(480, Math.max(1, parseInt(e.target.value) || 20)) })}
                min={1}
                max={480}
                placeholder="20"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-right text-gray-300 font-mono focus:outline-none focus:border-white/20"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">Video timeout (min)</span>
              <input
                aria-label="Video timeout (min)"
                type="number"
                value={settings.videoGenTimeoutMinutes ?? 60}
                onChange={(e) => updateSettings({ videoGenTimeoutMinutes: Math.min(480, Math.max(1, parseInt(e.target.value) || 60)) })}
                min={1}
                max={480}
                placeholder="60"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-right text-gray-300 font-mono focus:outline-none focus:border-white/20"
              />
            </div>
          </Section>
          )}

          <Section title="Privacy">
            {settings.appMode === 'cloud' ? (
              /* Cloud mode: the 100%-local pledge doesn't hold — say so
                 honestly, mirroring the Speech section's cloud copy. */
              <div className="space-y-2 py-1 text-[0.65rem] text-gray-500 dark:text-gray-400 leading-relaxed">
                <div className="flex items-start gap-2">
                  <Lock size={12} className="mt-0.5 shrink-0 text-sky-500" />
                  <div>
                    <p className="text-gray-700 dark:text-gray-300 font-medium mb-0.5">Cloud mode is active.</p>
                    <p>Chat, Create renders and voice run on lu-labs.ai against your LU account and are metered against your credits; generated media and job records are stored with your account. Switch to Local in the header to run everything on your machine, and the 100% local pledge below then applies.</p>
                  </div>
                </div>
                <div className="flex items-start gap-2 pt-1.5">
                  <Shield size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                  <div>
                    <p className="text-gray-700 dark:text-gray-300 font-medium mb-0.5">Local mode: 100% local.</p>
                    <p>In local mode chat, agent runs, and image &amp; video generation all execute on your machine. No telemetry, no analytics, no model pings home. Your local data lives in <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/5 font-mono text-[0.6rem]">%APPDATA%/Locally Uncensored</code> on Windows (or the equivalent on Linux/macOS).</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2 py-1 text-[0.65rem] text-gray-500 dark:text-gray-400 leading-relaxed">
                <div className="flex items-start gap-2">
                  <Lock size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                  <div>
                    <p className="text-gray-700 dark:text-gray-300 font-medium mb-0.5">100% local by default.</p>
                    <p>Chat, agent runs, image &amp; video generation all execute on your machine. No telemetry, no analytics, no model pings home. The only network calls LU makes unless you explicitly opt in are: update checks against GitHub Releases, and cloud provider APIs (OpenAI, Anthropic, etc.) that you configure yourself with your own API keys.</p>
                  </div>
                </div>
                <div className="flex items-start gap-2 pt-1.5">
                  <Shield size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                  <div>
                    <p className="text-gray-700 dark:text-gray-300 font-medium mb-0.5">You own your data.</p>
                    <p>Conversations, memories, and generated media live in <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/5 font-mono text-[0.6rem]">%APPDATA%/Locally Uncensored</code> on Windows (or the equivalent on Linux/macOS). Back up the folder, move it between machines, or delete it. LU writes nothing else.</p>
                  </div>
                </div>
              </div>
            )}
          </Section>

          <Section title="Onboarding">
            <div className="flex items-center justify-between py-1">
              <div className="flex items-start gap-2">
                <GraduationCap size={12} className="mt-0.5 shrink-0 text-gray-500" />
                <div className="text-[0.65rem] text-gray-600 dark:text-gray-400 leading-relaxed">
                  Run the first-launch setup wizard again (hardware scan, recommended models, tool-calling tour).
                </div>
              </div>
              <button
                onClick={async () => {
                  // The line above is what actually re-runs the wizard: AppShell
                  // gates it on settings.onboardingDone, and that store is
                  // persisted, so it survives the reload below. The backend call
                  // only clears the marker FILE, which is read in one place —
                  // the NSIS-update recovery in AppShell, and only when the
                  // store itself was lost.
                  //
                  // Level (a): silent on purpose. The visible action succeeds
                  // either way, and the reload on the next line would wipe any
                  // message before it could be read. A stale marker costs
                  // nothing until a store-loss recovery, which re-writes it.
                  useSettingsStore.getState().updateSettings({ onboardingDone: false })
                  try { await backendCall('set_onboarding_done', { done: false }) } catch { /* see above */ }
                  window.location.reload()
                }}
                className="ml-3 shrink-0 px-2.5 py-1 rounded-md text-[0.6rem] font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors"
              >
                Re-run onboarding
              </button>
            </div>
          </Section>

          <UpdateSection />

          <Section title="Troubleshoot">
            <TroubleshootSection />
          </Section>
        </>)}

        {/* ── AI Backends tab ──────────────────────────── */}
        {tab === 'backends' && (<>
          <Section title="Providers" defaultOpen>
            <ProviderSettings />
          </Section>

          <Section title="Model Storage">
            <HfDownloadPathSetting />
            <LmStudioFolderSetting />
            <ImportLocalModels />
          </Section>

          {/* goonerforporn (Discord #bug-reports, 2026-08-28): the store knew
              the key, the changelog named it, and no component ever set it.
              A14 review 8, Windows follow-up: it then sat directly under the
              Model Storage folder field, two bare text boxes in a row, and a
              tester saved a filesystem path as his API key. A credential and a
              folder do not belong in one list, so the key has a section of its
              own now, and the field says what a key looks like. */}
          <Section title="CivitAI API key">
            <CivitaiApiKeySetting />
          </Section>

          {/* Same reasoning, other hub: the downloader sends this token to
              huggingface.co, and a gated repository's 401 names this field. */}
          <Section title="Hugging Face token">
            <HfTokenSetting />
          </Section>

          {builtinManaged && (
            <Section title="LU Engine (expert)">
              <BuiltinEngineSettings />
            </Section>
          )}

          {/* ComfyUI never runs on the Mac (MLX-only local media) — hide the whole
              panel there so it isn't a dead Install/Start surface. The Mac gets
              the MLX installer in its place; without it a fresh Mac has no way
              to set up local image/video at all (MAC-3). */}
          {!isMlxImageHost() ? (
            // Arriving from the Models page's "Start ComfyUI to see your image
            // models" hint: the Start button it names lives in here, so the
            // section arrives open instead of costing one more click the hint
            // never mentioned.
            // A15: and open as well while an install, an update or a repair is
            // in flight, or while a failure is still on screen. Read without
            // subscribing, because the value is only ever wanted at the moment
            // this Section mounts, which is the moment a section switch brings
            // it back.
            <Section title="ComfyUI (Image & Video)" defaultOpen={entryFocus?.section === 'comfyui' || comfySectionShouldOpen(useComfyInstallStore.getState())}>
              {settings.appMode === 'cloud' && (
                <p className="text-[0.55rem] text-gray-500 leading-snug pb-1">
                  Local mode only. Cloud renders run on lu-labs.ai and never use ComfyUI.
                </p>
              )}
              <ComfyUISettings />
            </Section>
          ) : (
            <Section title="Local Media (Apple MLX)">
              {settings.appMode === 'cloud' && (
                <p className="text-[0.55rem] text-gray-500 leading-snug pb-1">
                  Local mode only. Cloud renders run on lu-labs.ai and never touch these models.
                </p>
              )}
              <MlxMediaSettings />
            </Section>
          )}
        </>)}

        {/* ── Agent tab ─────────────────────────────────── */}
        {tab === 'agent' && (<>
          <Section title="Personas">
            <PersonaPanel />
          </Section>

          <Section title="Memory">
            <MemorySettings />
          </Section>

          {FEATURE_FLAGS.AGENT_MODE && (
            <Section title="Agent Permissions">
              <PermissionSettings />
              <button
                onClick={() => useAgentModeStore.getState().resetTutorial()}
                className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors"
              >
                Reset tutorial
              </button>
            </Section>
          )}


          {FEATURE_FLAGS.AGENT_MODE && (
            <Section title="Sub-agents">
            {/* Die Kappen fuer einen delegierten Agenten. Sie standen bis zum
                03.09.2026 unter General → Generation, neben Temperatur und
                Auto-Compact; eine Persona suchte sie beim Agenten und fand sie
                dort nicht. Der Gegenstand ist auch ein anderer: beim Hauptlauf
                sitzt der Nutzer davor und kann Stop druecken, ein Sub-Agent
                laeuft ohne Zuschauer. Darum sind diese Zahlen klein und darum
                heisst 0 hier "Vorgabe" und nicht "unbegrenzt" —
                Unbegrenztheit soll man an einer unbeaufsichtigten Schleife
                nicht aus Versehen einstellen. */}
            <div className="flex items-center justify-between">
              <span
                className="t-micro text-gray-700 dark:text-gray-400"
                title="How many tool calls one delegated sub-agent may make."
              >
                Sub-agent tool calls
              </span>
              <input
                aria-label="Sub-agent tool calls"
                type="number"
                value={settings.subAgentMaxToolCalls ?? 0}
                onChange={(e) => updateSettings({ subAgentMaxToolCalls: Math.max(0, parseInt(e.target.value) || 0) })}
                min={0}
                placeholder="10"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 t-mono text-right text-gray-300 focus:outline-none focus:border-white/20"
              />
            </div>
            <div className="flex items-center justify-between">
              <span
                className="t-micro text-gray-700 dark:text-gray-400"
                title="How many think-act rounds one delegated sub-agent may run."
              >
                Sub-agent steps
              </span>
              <input
                aria-label="Sub-agent steps"
                type="number"
                value={settings.subAgentMaxIterations ?? 0}
                onChange={(e) => updateSettings({ subAgentMaxIterations: Math.max(0, parseInt(e.target.value) || 0) })}
                min={0}
                placeholder="5"
                className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 t-mono text-right text-gray-300 focus:outline-none focus:border-white/20"
              />
            </div>
            <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed pt-0.5">
              0 = use the defaults (10 calls, 5 steps). A sub-agent runs unattended, so these stay deliberately tight — raise them only for a task you know is long.
            </div>
            </Section>
          )}

          {FEATURE_FLAGS.AGENT_WORKFLOWS && (
            <Section title="Agent Workflows">
              <WorkflowSection />
            </Section>
          )}

          {FEATURE_FLAGS.AGENT_MODE && (
            <Section title="MCP Servers">
              <MCPServerSettings />
            </Section>
          )}

          {FEATURE_FLAGS.AGENT_MODE && (
            <Section title="Coding Agent">
              <CodexAgentSettings />
            </Section>
          )}

          {FEATURE_FLAGS.AGENT_MODE && (
            <Section title="Search Provider">
              <div className="space-y-3">
                <div>
                  <span className="text-[0.6rem] text-gray-500 block mb-1">Provider for Agent web_search</span>
                  <div className="flex gap-1.5">
                    {(['auto', 'brave', 'tavily'] as const).map(p => (
                      <button
                        key={p}
                        onClick={() => updateSettings({ searchProvider: p })}
                        className={`px-2.5 py-1 rounded-md text-[0.6rem] font-medium transition-all ${
                          settings.searchProvider === p
                            ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm border border-gray-200 dark:border-white/15'
                            : 'text-gray-500 hover:text-gray-700 dark:hover:text-white bg-gray-100 dark:bg-white/5'
                        }`}
                      >
                        {p === 'auto' ? 'Auto (SearXNG > DDG)' : p === 'brave' ? 'Brave Search' : 'Tavily'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[0.6rem] text-gray-500 block mb-1">Brave Search API Key</label>
                  <input
                    type="password"
                    value={settings.braveApiKey}
                    onChange={(e) => updateSettings({ braveApiKey: e.target.value })}
                    placeholder="BSA-..."
                    className="w-full px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:border-gray-400 dark:focus:border-white/25"
                  />
                  <span className="text-[0.5rem] text-gray-500 mt-0.5 block">Free tier: 2000 queries/month. Get key at brave.com/search/api</span>
                </div>
                <div>
                  <label className="text-[0.6rem] text-gray-500 block mb-1">Tavily API Key</label>
                  <input
                    type="password"
                    value={settings.tavilyApiKey}
                    onChange={(e) => updateSettings({ tavilyApiKey: e.target.value })}
                    placeholder="tvly-..."
                    className="w-full px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:border-gray-400 dark:focus:border-white/25"
                  />
                  <span className="text-[0.5rem] text-gray-500 mt-0.5 block">AI-optimized search. Free tier: 1000 queries/month. Get key at tavily.com</span>
                </div>
              </div>
            </Section>
          )}
        </>)}

        {/* ── Voice & Remote tab ────────────────────────── */}
        {tab === 'voice-remote' && (<>
          <Section title="Speech" defaultOpen>
            <SpeechSettings />
          </Section>

          <Section title="Remote Access">
            <RemoteAccessSettings />
            {/* §16 — real step-by-step docs (F5/X2 shipped only a 1-line
                blurb). Collapsed by default so the settings stay compact. */}
            <Disclosure label="How it works">
              <RemoteAccessDocs />
            </Disclosure>
          </Section>

          <Section title="Local API">
            <LocalApiSettings />
          </Section>
        </>)}

        {/* ── Reset (GitHub #59: per-tab scope + confirm + feedback) ── */}
        <ResetSection tab={tab} />
        </div>
      </div>
    </div>
  )
}

// ── Update Section ──────────────────────────────────────────────

function UpdateSection() {
  const { currentVersion, latestVersion, updateAvailable, releaseNotes, dismissed, isChecking, autoDownload, downloadStatus, downloadProgress, downloadedBytes, totalBytes, errorMessage, checkForUpdate, downloadUpdate, installAndRestart, clearDismiss, setAutoDownload, openReleasePage } = useUpdateStore()
  // Defensive: only treat the persisted `latestVersion` as actually newer if a
  // semver compare confirms it. Otherwise the binary was updated out-of-band
  // and the persisted value is stale (e.g. localStorage still says 2.3.8 while
  // the binary is now 2.4.1). In that case both `updateAvailable` and the
  // "Latest Version" row should hide so we don't display a confusing inversion.
  const latestIsActuallyNewer = !!(latestVersion && isNewerVersion(latestVersion, currentVersion))
  const displayLatestVersion = latestIsActuallyNewer ? latestVersion : null
  const showUpdate = updateAvailable && latestIsActuallyNewer

  return (
    <Section title="Updates">
      <div className="space-y-3 py-2">
        {/* Current version */}
        <div className="flex items-center justify-between">
          <span className="text-[0.65rem] text-gray-500">Current Version</span>
          <span className="text-[0.65rem] text-gray-300 font-mono">v{currentVersion}</span>
        </div>

        {/* Latest version — only show if it's actually newer than current */}
        {displayLatestVersion && (
          <div className="flex items-center justify-between">
            <span className="text-[0.65rem] text-gray-500">Latest Version</span>
            <span className={`text-[0.65rem] font-mono ${showUpdate ? 'text-emerald-400' : 'text-gray-300'}`}>
              v{displayLatestVersion}
            </span>
          </div>
        )}

        {/* Status. Same pipeline as the header badge: in-app download, then a
            click to restart. openReleasePage survives only as the dev-mode
            fallback, there is no updater outside Tauri. */}
        {showUpdate ? (
          <div className="rounded-lg bg-emerald-500/[0.08] border border-emerald-500/20 p-3">
            <div className="flex items-center gap-2 mb-2">
              <ArrowUpCircle size={14} className="text-emerald-400" />
              <span className="text-[0.65rem] font-medium text-emerald-400">Update available!</span>
            </div>
            {releaseNotes && downloadStatus !== 'downloading' && downloadStatus !== 'downloaded' && (
              <p className="text-[0.55rem] text-gray-500 leading-relaxed mb-2.5 line-clamp-4 whitespace-pre-line">{releaseNotes}</p>
            )}

            {(downloadStatus === 'downloading' || downloadStatus === 'downloaded') && (
              <div className="mb-2.5">
                <div className="w-full h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${downloadStatus === 'downloaded' ? 'bg-emerald-500' : 'bg-blue-500'}`}
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[0.55rem] text-gray-500">
                    {downloadStatus === 'downloaded' ? 'Download complete' : `${downloadProgress}%`}
                  </span>
                  {totalBytes > 0 && (
                    <span className="text-[0.55rem] text-gray-600">
                      {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {downloadStatus === 'error' && errorMessage && (
              <p className="text-[0.6rem] text-red-400/80 leading-relaxed mb-2.5">{errorMessage}</p>
            )}

            <div className="flex gap-2">
              {!isTauri() ? (
                <button
                  onClick={openReleasePage}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                >
                  <Download size={11} /> View Release
                </button>
              ) : downloadStatus === 'idle' ? (
                <button
                  onClick={() => { void downloadUpdate() }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                >
                  <Download size={11} /> Download Update
                </button>
              ) : downloadStatus === 'downloading' ? (
                <span className="flex items-center gap-1.5 px-3 py-1.5 text-[0.6rem] text-blue-400/80">
                  <Loader2 size={11} className="animate-spin" /> Downloading...
                </span>
              ) : downloadStatus === 'downloaded' ? (
                <button
                  onClick={() => { void installAndRestart() }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                >
                  <RefreshCw size={11} /> Restart Now
                </button>
              ) : downloadStatus === 'installing' ? (
                <span className="flex items-center gap-1.5 px-3 py-1.5 text-[0.6rem] text-emerald-400/80">
                  <Loader2 size={11} className="animate-spin" /> Installing...
                </span>
              ) : (
                <button
                  onClick={() => { void downloadUpdate() }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6rem] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                >
                  <RotateCcw size={11} /> Retry
                </button>
              )}
              {dismissed === displayLatestVersion && (
                <button
                  onClick={clearDismiss}
                  className="px-3 py-1.5 rounded-md text-[0.6rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                >
                  Show Badge Again
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[0.6rem] text-gray-600">
            <Check size={12} className="text-emerald-500" />
            You are on the latest version.
          </div>
        )}

        {/* Auto-download. Downloads only — installing always stays a click, so
            the app never restarts under the user's hands. */}
        <label className="flex items-start justify-between gap-3 cursor-pointer">
          <span>
            <span className="block text-[0.65rem] text-gray-300">Download updates automatically</span>
            <span className="block text-[0.55rem] text-gray-600 leading-relaxed">
              Fetches the update in the background so installing is one click. Never restarts on its own.
            </span>
          </span>
          <input
            type="checkbox"
            checked={autoDownload}
            onChange={(e) => setAutoDownload(e.target.checked)}
            className="mt-0.5 accent-emerald-500"
          />
        </label>

        {/* Manual check */}
        <button
          onClick={() => { void checkForUpdate(true) }}
          disabled={isChecking}
          className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
        >
          {isChecking ? 'Checking...' : 'Check for updates'}
        </button>
      </div>
    </Section>
  )
}

// ── B7 Troubleshoot section — one-shot diagnostic probe ───────

interface BackendProbe {
  status: 'ok' | 'unreachable' | 'not_installed' | 'error'
  detail: string
  endpoint: string
}

interface SystemHealthReport {
  version: string
  host: {
    os: string
    os_version: string
    arch: string
    cpu_count: number
    ram_gb: number
    disk_free_gb: number
    // §17: VRAM of the biggest NVIDIA GPU. null on non-NVIDIA boxes / when
    // the nvidia-smi probe fails — rendered as "—".
    vram_total_gb: number | null
    vram_free_gb: number | null
  }
  ollama: BackendProbe
  comfyui: BackendProbe
  lm_studio: BackendProbe
}

function ProbeBadge({ probe }: { probe: BackendProbe }) {
  // "Not running" und "Not installed" sind beide nur ein Nein und tragen
  // deshalb dasselbe Grau; der Unterschied steht im Wort, nicht in der Farbe.
  // Das Gelb, das "Not running" frueher trug, hat einen ausgeschalteten
  // Dienst zu einem halben Fehler gemacht.
  const RUHIG = 'bg-gray-500/15 text-gray-500 border-gray-500/30'
  const colors: Record<BackendProbe['status'], string> = {
    ok: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
    unreachable: RUHIG,
    not_installed: RUHIG,
    error: 'bg-red-500/15 text-red-500 border-red-500/30',
  }
  const labels: Record<BackendProbe['status'], string> = {
    ok: 'Reachable',
    unreachable: 'Not running',
    not_installed: 'Not installed',
    error: 'Error',
  }
  return (
    <span
      className={`text-[0.55rem] px-1.5 py-0.5 rounded border font-medium ${colors[probe.status]}`}
      title={probe.detail || probe.endpoint}
    >
      {labels[probe.status]}
    </span>
  )
}

function TroubleshootSection() {
  const [report, setReport] = useState<SystemHealthReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [hinweis, setHinweis] = useState<TroubleshootHinweis | null>(null)

  const run = async () => {
    setLoading(true)
    setHinweis(null)
    try {
      const r = await backendCall<SystemHealthReport>('system_health', {})
      setReport(r)
    } catch (e) {
      setHinweis(troubleshootHinweis(e, isTauri()))
    } finally {
      setLoading(false)
    }
  }

  // Auto-run on first open so the panel never starts empty.
  useEffect(() => {
    void run()
  }, [])

  return (
    <div className="space-y-3 py-2">
      <p className="text-[0.6rem] text-gray-500 leading-relaxed">
        One-shot probe of the local backends and host facts. Use this when
        the app behaves oddly. Most "model not found" / {isMlxImageHost() ? '"backend doesn\'t respond"' : '"ComfyUI doesn\'t respond"'} issues become obvious here.
      </p>

      {hinweis && (
        <div
          className={`rounded-lg p-2.5 text-[0.65rem] ${
            hinweis.art === 'grenze'
              ? 'bg-white/[0.03] border border-white/[0.08] text-gray-400'
              : 'bg-red-500/[0.08] border border-red-500/20 text-red-400'
          }`}
        >
          <p className="leading-relaxed">{hinweis.titel}</p>
          {hinweis.detail && (
            <p className="mt-1 font-mono t-micro opacity-70 break-all">{hinweis.detail}</p>
          )}
        </div>
      )}

      {/* Audit #01 — where the log file is. Above the probe result because
          "send us the log" is the most common outcome of opening this panel. */}
      <LogFileSettings />

      {report && (
        <div className="space-y-2">
          {/* Backends */}
          <div className="rounded-lg border border-white/[0.06] p-2.5 space-y-2">
            <div className="text-[0.55rem] uppercase tracking-widest text-gray-500">Backends</div>
            <div className="flex items-center justify-between">
              <span className="text-[0.65rem] text-gray-300">Ollama</span>
              <ProbeBadge probe={report.ollama} />
            </div>
            {!isMlxImageHost() && (
              <div className="flex items-center justify-between">
                <span className="text-[0.65rem] text-gray-300">ComfyUI</span>
                <ProbeBadge probe={report.comfyui} />
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[0.65rem] text-gray-300">LM Studio</span>
              <ProbeBadge probe={report.lm_studio} />
            </div>
          </div>

          {/* Host facts */}
          <div className="rounded-lg border border-white/[0.06] p-2.5 space-y-1.5">
            <div className="text-[0.55rem] uppercase tracking-widest text-gray-500">Host</div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">LU version</span>
              <span className="text-gray-300 font-mono">v{report.version}</span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">OS</span>
              <span className="text-gray-300 font-mono">{report.host.os} {report.host.os_version}</span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">Arch / CPUs</span>
              <span className="text-gray-300 font-mono">{report.host.arch} / {report.host.cpu_count}</span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">RAM</span>
              <span className="text-gray-300 font-mono">{report.host.ram_gb} GB</span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">Disk free (home)</span>
              {/* Unter 10 GB passt kein Modell mehr und keine ComfyUI-Umgebung:
                  das ist der Grund, aus dem der Nutzer diese Seite meist
                  aufmacht, also der Fehlerton statt des alten Gelbs. */}
              <span className={`font-mono ${report.host.disk_free_gb < 10 ? HINWEIS_TEXT.fehler : 'text-gray-300'}`}>
                {report.host.disk_free_gb} GB
              </span>
            </div>
            <div className="flex items-center justify-between text-[0.65rem]">
              <span className="text-gray-500">VRAM (GPU)</span>
              <span className="text-gray-300 font-mono">
                {report.host.vram_total_gb != null
                  ? (report.host.vram_free_gb != null
                      ? `${report.host.vram_free_gb} / ${report.host.vram_total_gb} GB free`
                      : `${report.host.vram_total_gb} GB`)
                  : 'not detected'}
              </span>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={run}
        disabled={loading}
        className="w-full px-3 py-1.5 rounded-md text-[0.65rem] font-medium bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-gray-800 dark:text-gray-200 transition-colors disabled:opacity-50"
      >
        {loading ? 'Probing…' : 'Re-probe'}
      </button>
    </div>
  )
}
