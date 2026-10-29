import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { SamplingControls } from './SamplingControls'
import { Send, Square, Paperclip, X, Brain, Gauge, Terminal, Film, Music } from 'lucide-react'
import { matchAgentCommands, type AgentCommand, type CommandScope } from '../../lib/agent-commands'
import { VoiceButton, type VoiceButtonHandle } from './VoiceButton'
import { ApprovalDialog } from './ApprovalDialog'
import { ComputerQuestionSlot } from '../computer/ComputerQuestion'
import { ComputerNote } from '../computer/ComputerNote'
import { dismissComputerStop } from '../../api/computer-use'
import { useVoiceStore } from '../../stores/voiceStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { composerHint, composerPlaceholder, composerSends, enterKeyMode } from '../../lib/enter-key'
import { isMacOS } from '../../lib/device-kind'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useChatStore } from '../../stores/chatStore'
import { isThinkingCompatible, isVisionCompatible, declaredVision } from '../../lib/model-compatibility'
import { clampEffort, effortChoices, effortLabel, nextEffort, DEFAULT_EFFORT } from '../../lib/effort'
import type { AgentToolCall } from '../../types/agent-mode'
import type { ImageAttachment } from '../../types/chat'
import { loadChatDrafts, newChatKey, storeChatDrafts, type ChatDrafts } from '../../lib/chat-drafts'
import { MAX_CHAT_IMAGES, prepareChatImages } from '../../lib/chat-image-input'
import { blindModelNotice } from '../../lib/chat-attachment-input'
import { chatToolsReach } from '../../lib/chat-tools-reach'
import { isMlxImageHost } from '../../api/mlx-image'
import { FILE_ONLY_TEXT, MAX_CHAT_FILES, TOO_MANY_FILES_MESSAGE, binarySummaryOnlyMessage, isBinaryAttachment, prepareChatFile, type ChatFileInput } from '../../lib/chat-files'
import { fileExtension } from '../../lib/file-magic'
import { ChatFileChip } from './ChatFileChip'
import { COMPOSER_MAX_W } from './composer-width'
import { consumeComposerFocusPending } from '../../hooks/useKeyboardShortcuts'
import { useChatNoticeStore, CHAT_NOTICE_MS } from '../../stores/chatNoticeStore'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'
import { fitTextarea } from '../../lib/fit-textarea'
import { turnOnSend, turnOnType, type EmojiTurn } from '../../lib/emoticons'
import { createActive, createChatLive, createInChatOf, servedWindowOf } from '../../lib/create/chat-switch'
import { useCreateChatReleased } from '../../lib/create/chat-release'
import {
  ATTACH_TOO_LARGE, ATTACH_TOO_MANY, addPendingMedia, mediaKindOf, tooLargeToAttach, type PendingMedia,
} from '../../lib/create/chat-attachments'

interface Props {
  onSend: (content: string, images?: ImageAttachment[], files?: ChatFileInput[], media?: PendingMedia[]) => void
  onStop: () => void
  /** THIS conversation is answering: the slot shows Stop. */
  isGenerating: boolean
  /**
   * THIS conversation's send is queued behind another local run (Runde 4,
   * review-lanes.md Blocker 1+6): the built-in engine runs one slot, so a
   * second local send waits its turn instead of racing the first one for it.
   * Distinct from plain `isGenerating`, where a stream is already flowing;
   * here nothing has started yet, but the composer still shows Stop (the
   * store aborter is registered the moment the run is admitted to the queue,
   * not only once it starts) and a line explains why nothing is happening.
   * Locking based on a DIFFERENT conversation is gone entirely as of this
   * round: each conversation now only answers for its own send, running or
   * queued, never for another one's.
   */
  waitingForLocalLane?: boolean
  pendingApproval?: AgentToolCall | null
  onApprove?: () => void
  onReject?: () => void
  disabled?: boolean
  /**
   * Does a send have a chat model to run on right now? Asked at the moment of
   * sending. Without one the send does not happen and nothing of the draft is
   * touched: the model picker opens and says what is missing. Left out, the
   * rule is simply "a model is picked".
   */
  modelReady?: () => boolean
  /**
   * Which commands this composer offers. Was a boolean meaning
   * "Coding-Agent-only"; since 2.6.8 it is the SCOPE, because the answer
   * stopped being all-or-nothing: plain chat offers /compact and nothing else,
   * while Agent and Coding offer the whole set. Undefined = no menu at all.
   */
  slashCommands?: CommandScope
  /**
   * The model picker, rendered on the right of the action bar (before Send).
   * The header no longer carries it. Each surface passes an upward-opening
   * ModelSelector so the prompt window owns the model choice (web parity).
   */
  composerModel?: ReactNode
  /** Rendered directly above the prompt box (the standing-goal bar). */
  composerAbove?: ReactNode
  /**
   * View-specific action buttons (Docs · Plugins · Tools) shown in the action
   * bar between Think and the model picker. Chat and Code pass different sets.
   */
  composerActions?: ReactNode
  /**
   * Do attached files reach the model's tools here (Agent mode, Code)? Then a
   * file is copied into the working folder on send. Without them (plain chat)
   * a binary only reaches the model as a summary, and the composer says so
   * the moment one is attached (3.0.7, Discord: "attach a ROM").
   */
  filesReachTools?: boolean
  /**
   * Which composer this is, for the draft typed before a chat exists
   * (lib/chat-drafts.ts): Chat and Code each keep their own.
   */
  draftScope?: string
}

/**
 * Files a model cannot read from a summary, but can from the Documents panel
 * (it extracts their text). They still attach; the line above the transcript
 * names the better way.
 */
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'epub', 'pptx', 'xlsx'])

/** How long the synchronous double-fire guard below stays shut. */
const SEND_LOCK_MS = 700

/** The field grows with its text up to this height, then scrolls (matches `max-h-[200px]`). */
const COMPOSER_MAX_PX = 200

/**
 * The double-fire guard's clock read, deliberately OUTSIDE the component.
 *
 * Reading `Date.now()` from a function declared in the component body puts an
 * impure call in the render path as far as React 19 is concerned (`purity`),
 * and the rule is right about where such a read belongs: not in a component,
 * not in a hook. Moving the whole check out here keeps it exactly as
 * synchronous as it was (the point of the guard is that it decides inside the
 * same tick as the second keydown) and makes it a thing that can be reasoned
 * about (and tested) on its own. Returns false when the send must be dropped.
 */
function passSendLock(lock: { current: SendLock }, message: string): boolean {
  const now = Date.now()
  // Only the SAME message is a double fire: both keydowns of one tick read
  // the same field. A different message within the window is a new send.
  // The lock used to hold for any message, and a model that answers in under
  // 700 ms (the engine mock of the how-it-works recordings, a fast cloud
  // model) left the next message in the field with no word why.
  if (now - lock.current.at < SEND_LOCK_MS && lock.current.message === message) return false
  lock.current = { at: now, message }
  return true
}

/** The last accepted send: when, and what it carried (see passSendLock). */
interface SendLock {
  at: number
  message: string
}

export function ChatInput({ onSend, onStop, isGenerating, waitingForLocalLane, pendingApproval, onApprove, onReject, disabled, modelReady, slashCommands, composerModel, composerActions, composerAbove, filesReachTools = false, draftScope = 'chat' }: Props) {
  // What this composer held when its view closed last (lib/chat-drafts.ts):
  // the draft of the open chat goes straight into the field, the rest into
  // `entwuerfe` below. Read once, on mount.
  const [beimOeffnen] = useState(() => {
    const alle = loadChatDrafts()
    const offen = useChatStore.getState().activeConversationId ?? newChatKey(draftScope)
    const eigener = alle[offen]
    delete alle[offen]
    return { alle, eigener }
  })
  const [input, setInput] = useState(beimOeffnen.eigener?.text ?? '')
  const [images, setImages] = useState<ImageAttachment[]>(beimOeffnen.eigener?.bilder ?? [])
  // Files of any other kind (3.0.5). Each entry is a description plus the
  // handle to the bytes; nothing of the file itself is held here.
  const [files, setFiles] = useState<ChatFileInput[]>(beimOeffnen.eigener?.dateien ?? [])
  // Create in chat: with the switch on, a clip or a sound track is an input
  // for an order. It never goes to the model and never into the chat store;
  // the bytes stay here until the message is sent.
  const [media, setMedia] = useState<PendingMedia[]>(beimOeffnen.eigener?.media ?? [])
  const mediaRef = useRef<PendingMedia[]>([])
  mediaRef.current = media
  const [isDragOver, setIsDragOver] = useState(false)
  const [preparingImages, setPreparingImages] = useState(false)
  const [preparingFiles, setPreparingFiles] = useState(false)
  const imageJob = useRef({ busy: false, epoch: 0 })
  const fileJob = useRef({ busy: false })
  const [isVoiceRecording, setIsVoiceRecording] = useState(false)
  const voiceRef = useRef<VoiceButtonHandle>(null)
  // Slash-command autocomplete (v2.5.3). When the input is a lone "/token", show
  // the matching agent commands; ↑/↓ to move, Enter/Tab to pick, Esc to dismiss.
  const [cmdMenu, setCmdMenu] = useState<AgentCommand[]>([])
  const cmdMenuRef = useRef<HTMLDivElement>(null)
  const cmdMenuPlatz = usePopoverPlatz(cmdMenuRef, cmdMenu.length > 0, { bevorzugt: 'oben', abstand: 6, deckel: 256 })
  const [cmdIndex, setCmdIndex] = useState(0)
  /**
   * Ein Entwurf gehoert dem Gespraech, in dem er getippt wurde.
   *
   * Der Composer wird beim Wechsel nicht neu gebaut, also stand der halbe Satz
   * aus dem alten Chat im neuen wieder im Feld, einmal beobachtet am
   * 03.09.2026, mit dem naheliegenden Ausgang: der Satz geht an den falschen
   * Empfaenger. Ihn beim Wechsel einfach zu leeren waere die andere Haelfte
   * desselben Fehlers, nur teurer (Arbeit weg), darum wird er beiseitegelegt
   * und beim Zurueckkommen wieder hingelegt. Bilder und Dateien reisen mit dem
   * Text, sonst hinge die Anlage am falschen Satz.
   *
   * WIE der Wechsel bemerkt wird, ist nicht Geschmack, sondern die Stelle, an
   * der dieser Block zweimal mit React aneinandergeriet. Er stand bis zum
   * 03.09.2026 als Effekt hier, mit zwei Refs davor, und war der einzige rote
   * Punkt von `npm run lint`. In Wahrheit zwei, denn eslint meldet pro
   * Komponente nur den ersten:
   *
   *   1. `react-hooks/refs`, "Cannot access refs during render". Der Stand des
   *      Feldes wurde blank im Renderkoerper in ein Ref geschrieben
   *      (`standRef.current = { input, images }`), damit der Effekt beim
   *      Wechsel noch an die Werte VOR dem Wechsel kam.
   *   2. `react-hooks/set-state-in-effect`. Der Effekt rief `setInput` und
   *      `setImages` direkt auf, also genau die Kaskade, vor der die Regel
   *      warnt: erst ein Commit mit dem alten Entwurf, dann ein zweiter mit
   *      dem neuen.
   *
   * Beide Regeln haben recht, und beide zeigen auf dieselbe Ursache: ein
   * Effekt ist der falsche Ort. React nennt den richtigen selbst ("You Might
   * Not Need an Effect" → Zustand anpassen, wenn sich etwas geaendert hat):
   * der Vergleich mit dem vorigen Wert steht IM Render, und die Anpassung
   * geschieht dort. React laeuft die Komponente sofort noch einmal, bevor es
   * ueberhaupt etwas uebergibt.
   *
   * Damit fallen beide Fehler zusammen mit ihrer Ursache weg. Das Ref fuer den
   * Stand braucht es nicht mehr: im Wechselrender fuehren `input` und `images`
   * noch den alten Entwurf, denn geleert wird erst hier, eine Zeile weiter
   * unten. Das ist derselbe Wert, den das Ref transportiert hat, nur ohne
   * Umweg. Und die Kaskade entfaellt, weil der Wechsel keinen eigenen Commit
   * mehr kostet: das Feld ist schon leer, wenn der neue Chat zum ersten Mal
   * zu sehen ist, statt fuer einen Frame den fremden Satz zu zeigen.
   *
   * Die beiden Refs sind deshalb Zustand geworden. Ein Ref darf im Render
   * nicht gelesen werden (Regel 1), und gelesen werden muessen hier beide.
   */
  const conversationId = useChatStore((s) => s.activeConversationId)
  useEffect(() => {
    const job = imageJob.current
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (state.activeConversationId !== previous.activeConversationId) job.epoch++
    })
    const stop = () => { job.epoch++; unsubscribe() }
    return stop
  }, [])
  const [entwuerfe, setEntwuerfe] = useState<ChatDrafts>(beimOeffnen.alle)
  const [letztesGespraech, setLetztesGespraech] = useState(conversationId)
  // Leaving for Create, Models or Settings unmounts this composer. Everything
  // it holds goes to lib/chat-drafts.ts then, the open chat's draft included,
  // and comes back on the next mount (3.0.8). The ref only carries the last
  // committed values to the cleanup; it is written in an effect, never in
  // render.
  const ablage = useRef({ entwuerfe, input, images, files, media, conversationId, draftScope })
  useEffect(() => {
    ablage.current = { entwuerfe, input, images, files, media, conversationId, draftScope }
  })
  useEffect(() => () => {
    const a = ablage.current
    const offen = a.conversationId ?? newChatKey(a.draftScope)
    storeChatDrafts({ ...a.entwuerfe, [offen]: { text: a.input, bilder: a.images, dateien: a.files, media: a.media } })
  }, [])
  if (letztesGespraech !== conversationId) {
    const vorher = letztesGespraech
    setLetztesGespraech(conversationId)
    if (vorher) {
      const text = input
      const bilder = images
      const dateien = files
      // Der Aktualisierer laeuft unter StrictMode zweimal und muss deshalb
      // beim zweiten Mal dasselbe Ergebnis liefern wie beim ersten. Er
      // rechnet nur aus `bisher`, haengt also an nichts, was er selbst
      // veraendert.
      setEntwuerfe((bisher) => {
        if (text || bilder.length || dateien.length) return { ...bisher, [vorher]: { text, bilder, dateien } }
        if (!(vorher in bisher)) return bisher
        const ohne = { ...bisher }
        delete ohne[vorher]
        return ohne
      })
    }
    // Gelesen wird der Stand VOR dieser Anpassung, und das ist richtig:
    // geschrieben wurde gerade der Schluessel `vorher`, geholt wird
    // `conversationId`, und die beiden sind hier nie dasselbe.
    const zurueck = conversationId ? entwuerfe[conversationId] : undefined
    setInput(zurueck?.text ?? '')
    setImages(zurueck?.bilder ?? [])
    setFiles(zurueck?.dateien ?? [])
    // Clips and sound tracks are bytes of this session and belong to the
    // draft they were picked for; they are not carried across conversations.
    setMedia([])
    setCmdMenu([])
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Text already in the box when dictation started. Interim + final transcripts
  // are written as base + transcript, so streaming chunks REPLACE (not stack)
  // and pre-typed text is never wiped.
  const dictationBaseRef = useRef('')
  const isTranscribing = useVoiceStore((s) => s.isTranscribing)
  const thinkingEnabled = useSettingsStore((s) => s.settings.thinkingEnabled)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  // Emoticons to emojis while typing (lib/emoticons.ts, Settings: Appearance).
  const emojiOn = useSettingsStore((s) => s.settings.emojiAutoReplace) !== false
  // GH #202: whether Enter sends or adds a line.
  const enterMode = enterKeyMode(useSettingsStore((s) => s.settings.enterKey))
  // The last turn, for one Backspace to take back, and the caret it leaves.
  const emojiTurnRef = useRef<EmojiTurn | null>(null)
  const caretRef = useRef<number | null>(null)
  // Cloud mode is a money state: the next Send is billed. It gets drawn here,
  // where the user is typing, not only on the switch in the header corner.
  const cloudMode = useSettingsStore((s) => s.settings.appMode) === 'cloud'
  const activeModel = useModelStore((s) => s.activeModel)
  const activeModelMeta = useModelStore((s) => s.models.find((m) => m.name === s.activeModel))
  // Server-declared capability (LU Cloud carries thinkMode from /models) wins
  // over the local name-heuristic; 'always' renders the toggle locked on.
  const thinkMode = activeModelMeta && 'thinkMode' in activeModelMeta ? activeModelMeta.thinkMode : undefined
  const thinkLockedOn = thinkMode === 'always'
  const canThink = thinkMode ? thinkMode === 'toggle' : isThinkingCompatible(activeModel)
  // Same server-over-heuristic precedence for vision (input_modalities →
  // supportsVision, and the built-in engine's projector-on-disk answer). A
  // declared flag counts in both directions; models without one still fall
  // back to the name heuristic.
  // Reasoning effort. The rungs come from the server catalogue per model, so a
  // model that declares none gets no control at all and behaves as before. The
  // displayed rung is the CLAMPED one, because that is what goes on the wire:
  // showing 'Max' while sending 'high' would be a control that lies.
  const reasoningEffort = useSettingsStore((s) => s.settings.reasoningEffort)
  const effortLevels = activeModelMeta && 'effortLevels' in activeModelMeta ? activeModelMeta.effortLevels : undefined
  const effortDefault = activeModelMeta && 'effortDefault' in activeModelMeta ? activeModelMeta.effortDefault : undefined
  const effortSteps = effortChoices(effortLevels)
  const effortNow = clampEffort(effortLevels, reasoningEffort ?? DEFAULT_EFFORT, effortDefault)
  // 3.0.7, after issue 176: rungs a local server gave us wait for the user's
  // own pick. Until then the request is the one from before 3.0.7 and the
  // button says so with Default instead of naming a rung nobody chose. On a
  // local model the round ends at Default again, so the old behaviour stays
  // one click away.
  const localEffortChosen = useSettingsStore((s) => s.settings.localEffortChosen)
  const effortLocal = !!activeModelMeta && 'effortLocal' in activeModelMeta && activeModelMeta.effortLocal === true
  const effortWaits = effortLocal && localEffortChosen !== true
  const effortText = effortWaits ? 'Default' : effortLabel(effortNow)
  const effortHint = effortWaits
    ? 'Reasoning effort: Default, the model decides. Click to pick a level. Higher effort spends more output tokens.'
    : `Reasoning effort: ${effortLabel(effortNow)}. Click to cycle. Higher effort spends more output tokens.`
  const cycleEffort = () => {
    if (effortWaits) {
      updateSettings({ localEffortChosen: true, reasoningEffort: effortSteps[0] })
    } else if (effortLocal && effortNow === effortSteps[effortSteps.length - 1]) {
      updateSettings({ localEffortChosen: false })
    } else {
      updateSettings({ reasoningEffort: nextEffort(effortLevels, effortNow) })
    }
  }
  // Only while thinking is really happening. 'always' models keep their Think
  // button locked on, so the rung is live there without the button being.
  const thinkingIsOn = thinkLockedOn || (thinkingEnabled && canThink)
  const showEffort = effortSteps.length > 0 && thinkingIsOn
  // Issue 176: a local model whose server takes no rungs shows the control
  // greyed with the reason, the same way the Think budget field does.
  const effortNote = activeModelMeta && 'effortNote' in activeModelMeta ? activeModelMeta.effortNote : undefined
  const showEffortGreyed = !showEffort && !!effortNote && thinkingIsOn
  const serverVision = declaredVision(activeModelMeta)
  const canSeeImages = serverVision !== undefined ? serverVision : isVisionCompatible(activeModel)
  // Is Create in chat on for the next message? Follows the account's release,
  // the mode, the model and the switch (lib/create/chat-switch.ts).
  const createReleased = useCreateChatReleased()
  const servedWindow = useModelStore((s) => servedWindowOf(s.activeModel, s.models))
  const modelReleased = useModelStore((s) => createInChatOf(s.activeModel, s.models))
  const createOn = useSettingsStore((s) => createActive(s.settings, activeModel, createChatLive(s.settings.appMode === 'cloud', createReleased), servedWindow, modelReleased))

  /**
   * Auflage 1 (Review composer, 19.09.2026): `key={conversationId}` weiter
   * unten montiert das Feld beim Gespraechswechsel neu, ein frischer Knoten
   * hat aber nie von selbst Fokus. `useKeyboardShortcuts.ts` setzt die Fahne
   * NUR, wenn der Tastendruck ("new-conversation", Ctrl/Cmd+N) selbst aus
   * diesem Feld kam; ein Wechsel per Sidebar-Klick oder waehrend der Nutzer
   * in einem Suchfeld/Modal tippt, setzt sie nie und stiehlt hier folglich
   * nichts. `consumeComposerFocusPending()` liest und loescht sie in einem
   * Schritt, und das geschieht bewusst HIER im Effekt (nach dem Commit, der
   * Knoten `textareaRef.current` also schon der neue ist), nicht im
   * Renderkoerper oben: ein Verbrauch dort waere ein Seiteneffekt waehrend
   * des Renderns.
   */
  useLayoutEffect(() => {
    if (consumeComposerFocusPending()) {
      textareaRef.current?.focus()
    }
  }, [conversationId])

  // After an emoji turn (or its take-back) the caret stands where the text
  // changed, not at the end React leaves it at. Before paint, so it never
  // jumps.
  useLayoutEffect(() => {
    const at = caretRef.current
    if (at == null || !textareaRef.current) return
    caretRef.current = null
    textareaRef.current.setSelectionRange(at, at)
  }, [input])

  // GH #139: measured on a copy outside the page, and written only when the
  // height really changes, so a key within a line lays out nothing but the
  // field (lib/fit-textarea.ts). Before paint, so a new line and its height
  // show up in the same frame.
  useLayoutEffect(() => {
    if (textareaRef.current) fitTextarea(textareaRef.current, COMPOSER_MAX_PX)
    // conversationId mit in der Abhaengigkeit: `key={conversationId}` unten
    // montiert das Textfeld beim Wechsel neu, der frische Knoten startet aber
    // auf `rows={1}`. Ist der uebernommene Entwurf identisch mit dem der
    // vorigen Unterhaltung (gleicher mehrzeiliger Text), aendert sich `input`
    // nicht, der Effekt liefe ohne diese Zeile also nicht, und die Hoehe
    // bliebe auf einer Zeile stehen statt den Entwurf zu zeigen.
  }, [input, conversationId])

  /**
   * Any file that is not an image (3.0.5). The model cannot read bytes, so
   * the file is read once here and turned into a description (lib/chat-files);
   * the chip below shows it, and nothing of the file is kept in the chat.
   */
  const addOtherFiles = useCallback(async (picked: File[]) => {
    const notices = useChatNoticeStore.getState()
    const job = fileJob.current
    if (job.busy) {
      notices.show('file-attach', 'Still reading the previous files. Add these again in a moment.', 'ruhig', CHAT_NOTICE_MS)
      return
    }
    const slots = MAX_CHAT_FILES - files.length
    if (slots <= 0) {
      notices.show('file-attach', TOO_MANY_FILES_MESSAGE, 'ruhig', CHAT_NOTICE_MS)
      return
    }
    job.busy = true
    const startedIn = conversationId
    setPreparingFiles(true)
    const problems: string[] = picked.length > slots ? [TOO_MANY_FILES_MESSAGE] : []
    const ready: ChatFileInput[] = []
    try {
      for (const file of picked.slice(0, slots)) {
        try {
          ready.push(await prepareChatFile(file))
        } catch (err) {
          problems.push(err instanceof Error ? err.message : 'This file could not be read.')
        }
      }
      // The draft belongs to the conversation it was started in.
      if (useChatStore.getState().activeConversationId !== startedIn) return
      if (ready.length) setFiles((prev) => [...prev, ...ready].slice(0, MAX_CHAT_FILES))
      if (problems.length) notices.show('file-attach', problems[0], 'ruhig', CHAT_NOTICE_MS)
      else notices.dismiss('file-attach')
      // A PDF or Word file attaches like any other, but the model gets far
      // more out of it through the Documents panel (GH #69).
      const isDocument = (name: string) => DOCUMENT_EXTENSIONS.has(fileExtension(name))
      // A binary in plain chat: say what the model gets and where it gets
      // more. A document has its own, better way (below).
      const binaryLine = filesReachTools
        ? null
        : binarySummaryOnlyMessage(ready.map(({ attachment }) => attachment).filter((a) => !isDocument(a.name)))
      if (binaryLine) notices.show('binary-summary-only', binaryLine, 'ruhig', CHAT_NOTICE_MS)
      if (ready.some(({ attachment }) => isDocument(attachment.name))) {
        notices.show(
          'document-belongs-in-docs',
          'The model only gets a summary of this document. To ask about its text, add it in the Documents panel.',
          'ruhig',
          CHAT_NOTICE_MS,
        )
      }
    } finally {
      job.busy = false
      setPreparingFiles(false)
    }
  }, [files.length, conversationId, filesReachTools])

  const addFiles = useCallback(async (picked: FileList | File[]) => {
    const all = Array.from(picked)
    const imageFiles = all.filter(f => f.type.startsWith('image/'))
    // Create on: a clip or a sound track is an input for an order, up to the
    // size the server takes. Checked here, before any upload, so nobody waits
    // for a refusal. With Create off they are files like any other.
    const mediaFiles = createOn ? all.filter(f => !f.type.startsWith('image/') && mediaKindOf(f) !== null) : []
    const otherFiles = all.filter(f => !f.type.startsWith('image/') && !mediaFiles.includes(f))
    if (mediaFiles.length > 0) {
      const notices = useChatNoticeStore.getState()
      const fits: PendingMedia[] = []
      let note = ''
      for (const f of mediaFiles) {
        const kind = mediaKindOf(f)!
        if (tooLargeToAttach(f)) { note = ATTACH_TOO_LARGE; continue }
        fits.push({ kind, mimeType: f.type || (kind === 'video' ? 'video/mp4' : 'audio/mpeg'), name: f.name, size: f.size, blob: f })
      }
      if (fits.length) {
        const next = addPendingMedia(mediaRef.current, fits)
        if (next.dropped) note = ATTACH_TOO_MANY
        setMedia(next.media)
      }
      // The line stands above the thread (ChatNotices), never in the composer.
      if (note) notices.show('file-attach', note, 'ruhig', CHAT_NOTICE_MS)
    }
    if (otherFiles.length > 0) void addOtherFiles(otherFiles)
    if (imageFiles.length === 0) return
    // Die Zeilen zum Bildanhang stehen oben im Verlauf (`ChatNotices`), nie
    // im Eingabekasten: „NICHTS im Prompt-Fenster", 21.09.2026.
    const notices = useChatNoticeStore.getState()
    const job = imageJob.current
    if (job.busy) {
      notices.show('image-attach', 'Still preparing the previous images. Add these again in a moment.', 'ruhig', CHAT_NOTICE_MS)
      return
    }
    const slots = MAX_CHAT_IMAGES - images.length
    if (slots <= 0) {
      notices.show('image-attach', 'You can attach up to five images per message.', 'ruhig', CHAT_NOTICE_MS)
      return
    }
    job.busy = true
    const epoch = job.epoch
    const cancelled = () => job.epoch !== epoch || useChatStore.getState().activeConversationId !== conversationId
    setPreparingImages(true)
    notices.show('image-attach', 'Preparing images…')
    try {
      const result = await prepareChatImages(imageFiles, slots, cancelled)
      if (cancelled()) return
      setImages(prev => [...prev, ...result.images].slice(0, MAX_CHAT_IMAGES))
      const message = result.errors[0] ?? (imageFiles.length > slots
        ? 'You can attach up to five images per message. Extra images were not added.'
        : '')
      if (message) notices.show('image-attach', message, 'ruhig', CHAT_NOTICE_MS)
      else notices.dismiss('image-attach')
    } finally {
      job.busy = false
      setPreparingImages(false)
      if (useChatNoticeStore.getState().notices.some(n => n.id === 'image-attach' && n.text === 'Preparing images…')) {
        useChatNoticeStore.getState().dismiss('image-attach')
      }
    }
  }, [images.length, conversationId, addOtherFiles, createOn])

  /**
   * Ein Bild an einem Modell, das keine sieht.
   *
   * Nicht blockierend (Senden geht weiter), und die Zeile geht von selbst
   * wieder weg, sobald der Anhang weg ist oder das Modell sehen kann. Frueher
   * war das eine Bedingung im Renderkoerper des Composers; sie ist ein Effekt
   * geworden, weil ihr Ziel jetzt eine Etage hoeher gezeichnet wird und ein
   * Speicher kein Render sein darf. gthvidsten, GH Discussion #67.
   */
  useEffect(() => {
    // With Create on, an image is of use without a vision model too (as the
    // template for an order), so the line would be wrong there.
    const blind = images.length > 0 && !!activeModel && !canSeeImages && !createOn
    const speicher = useChatNoticeStore.getState()
    if (!blind) {
      speicher.dismiss('model-cannot-see-images')
      return
    }
    // A12: a model with tools still hands the picture to image_generate /
    // video_generate locally (lib/chat-attachment-input); a Mac's image
    // engine and cloud mode take none from the chat.
    const handsToImageTool = !cloudMode && !isMlxImageHost()
      && chatToolsReach(activeModel, useModelStore.getState().models)
    speicher.show('model-cannot-see-images', blindModelNotice(handsToImageTool))
  }, [images.length, activeModel, canSeeImages, createOn, cloudMode])

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // "Models cannot read binary files" is about the draft of a plain chat. With
  // its binaries taken off the draft, or Agent or Code taking the file into the
  // working folder, it no longer says what will happen, so it goes.
  const removeFile = (index: number) => {
    const left = files.filter((_, i) => i !== index)
    setFiles(left)
    if (!left.some(({ attachment }) => isBinaryAttachment(attachment))) useChatNoticeStore.getState().dismiss('binary-summary-only')
  }
  useEffect(() => {
    if (filesReachTools) useChatNoticeStore.getState().dismiss('binary-summary-only')
  }, [filesReachTools])

  // Write a dictation transcript (interim or final) into the input as
  // base + transcript; the layout effect above sizes the field. NEVER sends,
  // because the user reviews and presses Send (2026-06-06).
  const applyDictation = (text: string) => {
    const base = dictationBaseRef.current
    const sep = base && !/\s$/.test(base) ? ' ' : ''
    setInput(base + sep + text)
  }

  // Synchronous double-fire guard (2026-06-20: "ok generiere jetzt" landed
  // twice in one chat). The `isGenerating` prop and the cleared input only update
  // on the NEXT render, so two Enter keydowns in the same tick (key-repeat / IME
  // / a held Enter) both pass the checks below and send the identical message
  // twice. A short monotonic lock closes that window.
  const sendLockRef = useRef<SendLock>({ at: 0, message: '' })
  const handleSend = () => {
    // Enter ends the last word as a space would, so an emoticon there turns.
    const trimmed = (emojiOn ? turnOnSend(input) : input).trim()
    if (imageJob.current.busy || fileJob.current.busy || (!trimmed && images.length === 0 && files.length === 0 && media.length === 0) || isGenerating || waitingForLocalLane || disabled) return
    // No chat model to answer: the send handlers return without a word in that
    // case, and the lines below would then empty the field and the chips for a
    // message that went nowhere (found in the Windows build of 3.0.5). The
    // draft stays as it is, and the model picker opens with the reason. The
    // Send button and Enter both come through here.
    if (!(modelReady ? modelReady() : !!useModelStore.getState().activeModel)) {
      useUIStore.getState().askForModel()
      return
    }
    // What the message carries, so a double fire is told from a new send.
    const signature = JSON.stringify([trimmed, images.length, files.length, media.length])
    if (!passSendLock(sendLockRef, signature)) return
    // A message is sent: the note about a stop has been seen.
    dismissComputerStop()
    const text = trimmed || (images.length > 0 ? '(image)' : FILE_ONLY_TEXT)
    const pictures = images.length > 0 ? images : undefined
    // The third argument only exists for a message that carries files, so a
    // send without them reaches its handler exactly as it always did.
    // And the fourth only for one that carries a clip or a sound track.
    if (media.length > 0) onSend(trimmed || '(attachment)', pictures, files.length > 0 ? files : undefined, media)
    else if (files.length > 0) onSend(text, pictures, files)
    else onSend(text, pictures)
    // Sent while dictating: the words in the field went out, the take ends
    // here and leaves nothing to fill the emptied field again.
    if (isVoiceRecording) voiceRef.current?.endOnSend()
    setInput('')
    setImages([])
    setFiles([])
    setMedia([])
    setCmdMenu([])
  }

  // Update the input + the slash-command typeahead together. The menu shows
  // what the SURFACE can actually carry out: everything in Agent and Coding,
  // and in plain chat only the commands marked for it (today: /compact).
  // Offering an agent command where there is no tool catalogue would be
  // offering work the surface cannot do.
  const updateInput = (value: string, caret?: number | null) => {
    // The user writes on: the note about a stop has been seen.
    dismissComputerStop()
    // One character typed behind a finished emoticon turns it into its emoji.
    const turn = emojiOn && caret != null && value.length === input.length + 1 ? turnOnType(value, caret) : null
    emojiTurnRef.current = turn
    if (turn) {
      value = turn.after
      caretRef.current = turn.caret
    }
    setInput(value)
    const matches = slashCommands ? matchAgentCommands(value, slashCommands) : []
    setCmdMenu(matches)
    setCmdIndex(0)
  }

  // Fill the input with the chosen command (trailing space so args can follow)
  // and dismiss the menu. The user then types any args and presses Enter.
  const pickCommand = (cmd: AgentCommand) => {
    setInput(`/${cmd.name} `)
    setCmdMenu([])
    setCmdIndex(0)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // A Backspace right after a turn takes it back: the emoticon as typed.
    const turn = emojiTurnRef.current
    const field = textareaRef.current
    if (e.key === 'Backspace' && turn && field && field.value === turn.after
      && field.selectionStart === turn.caret && field.selectionEnd === turn.caret) {
      e.preventDefault()
      emojiTurnRef.current = null
      caretRef.current = turn.caret - (turn.after.length - turn.before.length)
      setInput(turn.before)
      return
    }
    // Slash-command menu navigation takes precedence while it's open.
    if (cmdMenu.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIndex((i) => (i + 1) % cmdMenu.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIndex((i) => (i - 1 + cmdMenu.length) % cmdMenu.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pickCommand(cmdMenu[cmdIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCmdMenu([])
        return
      }
    }
    if (composerSends({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing }, enterMode)) {
      e.preventDefault()
      // While the last words are still being transcribed, Enter waits for
      // them. While recording it sends what the field shows and ends the
      // take, as the Send button does.
      if (isTranscribing) return
      handleSend()
    }
  }

  // Paste handler for clipboard images (Ctrl+V screenshots) and copied files.
  // Pasted TEXT stays a normal paste: only items of kind "file" are taken.
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const pasted = Array.from(items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (pasted.length === 0) return
    e.preventDefault()
    addFiles(pasted)
  }, [addFiles])

  // Drag & Drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer?.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  return (
    <div className={`px-3 pb-2 pt-1 w-full ${COMPOSER_MAX_W} mx-auto`}>
      {/* 19.09.2026, Runde 2 (Nachtrag): ueber dem Eingabefeld steht
          seither GAR KEINE Marke mehr, weder "No credits" noch "No Filter".
          Die Komponente, die sie hier zeigte, ist geloescht, nicht nur
          entkoppelt (siehe flash-hinweis-verschiebt-nichts.test.ts). Das
          Etikett neben dem Agent-Schalter (ChatView.tsx, der Flash-Hinweis)
          und die Modellauswahl selbst (ModelRowMarks in ModelSelector.tsx,
          unveraendert) sind die einzigen Stellen, die diese Aussagen noch
          tragen. */}
      {/* Approval used to live here as a popup over the chat input.
          Per user feedback ("eventuell in den chat einarbeiten") it now
          renders INSIDE the pending tool-call block in MessageList, so
          the approve/reject buttons sit visually attached to the tool
          they belong to. ChatView owns the Enter/Esc keyboard layer. */}

      <div
        // Cloud mode is drawn on the box the user is about to type into, not
        // only on a switch in the far corner of the header (Nebenbefund 4, R5
        // re-measure 2026-08-30: a single stray click moved the app to Cloud
        // and the next question was billed, with nothing in the writing area
        // saying anything had changed).
        data-cloud={cloudMode ? 'on' : undefined}
        className={`relative flex flex-col rounded-lg border transition-colors ${
          isDragOver
            ? 'bg-blue-500/5 border-blue-500/30'
            : cloudMode
              ? 'bg-lu-cloud/[0.04] border-lu-cloud/40 focus-within:border-lu-cloud/70'
              : 'bg-gray-50 dark:bg-white/[0.03] border-gray-200 dark:border-white/[0.06] focus-within:border-gray-400 dark:focus-within:border-white/15'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Slash-command autocomplete, floats above the composer */}
        {cmdMenu.length > 0 && (
          <div ref={cmdMenuRef} style={cmdMenuPlatz.style} className={`absolute left-0 right-0 z-50 overflow-y-auto scrollbar-thin rounded-lg lu-elevated py-1 ${cmdMenuPlatz.nachOben ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}>
            <div className="px-2.5 py-1 flex items-center gap-1 text-[0.5rem] uppercase tracking-widest text-gray-400 dark:text-gray-600">
              <Terminal size={9} /> Agent commands
            </div>
            {cmdMenu.map((cmd, i) => (
              <button
                key={cmd.name}
                onMouseDown={(e) => { e.preventDefault(); pickCommand(cmd) }}
                onMouseEnter={() => setCmdIndex(i)}
                className={`w-full text-left px-2.5 py-1 flex items-baseline gap-2 transition-colors ${
                  i === cmdIndex ? 'bg-gray-100 dark:bg-white/[0.07]' : 'hover:bg-gray-50 dark:hover:bg-white/[0.04]'
                }`}
              >
                <span className="text-[0.72rem] font-medium text-gray-800 dark:text-gray-100 shrink-0">/{cmd.name}</span>
                {cmd.argHint && <span className="t-micro text-gray-400 dark:text-gray-500 shrink-0">{cmd.argHint}</span>}
                <span className="t-micro text-gray-500 dark:text-gray-400 truncate ml-auto">{cmd.summary}</span>
              </button>
            ))}
          </div>
        )}

        {/* The standing goal sits above everything else in the composer, so an
            instruction that steers every turn is never invisible. */}
        {composerAbove}

        {/* G31: the run is STOPPED until this is answered, so the answer has to
            be where the user's eyes already are. The inline buttons on the tool
            block are still there and still the nicer place to decide from, but
            the list does not scroll to them, so on R01c (Mac, 2026-08-07) a run
            sat waiting 7 minutes with nothing but a clock icon far below the
            fold. An approval has no timeout by design, which makes being seen
            the only thing that ends it. */}
        {pendingApproval && onApprove && onReject && (
          <ApprovalDialog toolCall={pendingApproval} onApprove={onApprove} onReject={onReject} />
        )}

        {/* A question of computer control (may LU use this app, may it run
            this action). The owner's one exception to "nothing above the input
            field" (08.10.2026): it stands here, as a surface of its own. */}
        <ComputerQuestionSlot className="mb-1.5" />
        {/* The note of computer control: the second exception (09.10.2026).
            One small line that hangs above this place and takes no room. */}
        <ComputerNote />

        {/* Prompt area: hints, image previews, then the textarea (buttons live
            in the action bar below, web-parity two-row composer). */}
        <div className="px-3 pt-2.5">
          {/* HIER STAND BIS ZUM 21.09.2026 EIN STAPEL HINWEISE, und genau
              darum ging es dem Eigner am echten Windows-Bau: „NICHTS im
              prompt fenster!" Drei Zeilen sind ausgezogen, keine ist
              verlorengegangen:

                Wartezeile der lokalen Spur  -> LocalLaneWaitLine, gezeichnet
                  von ChatView/CodexView als Geschwister UEBER diesem Kasten
                Dokument gehoert in die Ablage (GH #69) -> ChatNotices, oben im Verlauf
                Modell sieht keine Bilder      -> ChatNotices, oben im Verlauf

              Was hier bleibt, ist kein Hinweis: die Bildvorschauen sind der
              Anhang selbst, und die Freigabe ist eine Entscheidung mit zwei
              Knoepfen. */}

          {/* The attachments of this draft, in one row that may wrap: image
              previews, then a chip per file of any other kind (3.0.5). A chip
              IS the attachment (name, detected type, size), not a hint
              about it. */}
          {(images.length > 0 || files.length > 0 || media.length > 0) && (
            <div className="flex gap-1.5 mb-1.5 flex-wrap">
              {images.map((img, i) => (
                <div key={i} className="relative group">
                  <img
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={img.name}
                    className="w-14 h-14 object-cover rounded-lg border border-white/10"
                  />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={8} />
                  </button>
                  <span className="lu-on-dark absolute bottom-0 left-0 right-0 bg-black/60 text-[0.45rem] text-gray-300 text-center rounded-b-lg truncate px-0.5">
                    {img.name}
                  </span>
                </div>
              ))}
              {files.map(({ attachment }, i) => (
                <ChatFileChip
                  key={`${attachment.sha256}-${i}`}
                  file={attachment}
                  testId="composer-file-chip"
                  reachesTools={filesReachTools}
                  onRemove={() => removeFile(i)}
                />
              ))}
              {/* Clips and sound tracks for Create: the same row. */}
              {media.map((clip, i) => (
                <div key={`${clip.name}-${i}`} data-testid="composer-media-chip" className="relative flex h-[var(--control-h-md)] max-w-44 items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 pl-2 pr-6 t-micro text-gray-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-300">
                  {clip.kind === 'video' ? <Film size={11} className="shrink-0 text-gray-400" /> : <Music size={11} className="shrink-0 text-gray-400" />}
                  <span className="truncate">{clip.name}</span>
                  <button
                    onClick={() => setMedia(prev => prev.filter((_, k) => k !== i))}
                    aria-label={`Remove ${clip.name}`}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-800 dark:hover:bg-white/10 dark:hover:text-gray-200"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* `data-lu-composer`: der stabile Erkennungspunkt DIESES Feldes,
              gelesen von `useKeyboardShortcuts.ts` (Ctrl/Cmd+N aus dem
              Composer heraus setzt die Fokusfahne, aus einem Suchfeld nicht).
              Er hiess bis zum 21.09.2026 `data-lu-quiet-focus` und schaltete
              nebenbei den Fokusring ab; beides in einem Attribut war schon
              falsch, als das Attribut an sechs Feldern hing, denn damit
              meldete auch eine Preset-Werkstatt-Textarea „ich bin der
              Composer". Der Fokus ist jetzt eine Regel in index.css, die
              jedes Textfeld der App deckt, und dieses Attribut sagt wieder
              nur das eine, wofuer es gelesen wird.

              `key={conversationId}`: der Gespraechswechsel oben raeumt `input`
              ueber React (den kontrollierten Wert), aber das DOM-Textfeld
              selbst behaelt ohne eigenen Schluessel denselben Knoten, samt
              seiner eigenen Selektion/Cursorposition, ueber den Wechsel
              hinweg. Ein Tastenereignis, das der Browser noch gegen den ALTEN
              Knoten in der Warteschlange hat (eine reale Maus- oder
              CDP-Eingabe, die kurz vor dem Wechsel begann), landet dann an der
              alten Cursorposition MITTEN im gerade abgelegten Entwurf, bevor
              Reacts Leerung ueberhaupt sichtbar wird - genau das Muster aus der
              Box-Messung (BERICHT.md Z2: neuer Text mitten im alten,
              Endstueck haengt hinten dran). Ein neuer Schluessel zwingt einen
              WIRKLICH neuen DOM-Knoten pro Unterhaltung: es gibt dann keinen
              alten Knoten mehr, an dem ein verspaetetes Ereignis noch landen
              koennte. */}
          <textarea
            data-lu-composer
            key={conversationId ?? 'none'}
            ref={textareaRef}
            value={input}
            onChange={(e) => updateInput(e.target.value, e.target.selectionStart)}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setCmdMenu([]), 120)}
            onPaste={handlePaste}
            placeholder={disabled ? "Unavailable" : isDragOver ? "Drop files here..." : isTranscribing ? "Transcribing..." : isVoiceRecording ? "Recording..." : composerPlaceholder(enterMode, isMacOS())}
            disabled={disabled}
            rows={1}
            className="lu-fokus-am-kasten w-full bg-transparent resize-none text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none text-[12px] leading-relaxed max-h-[200px] disabled:opacity-50 scrollbar-thin"
          />
        </div>

        {/* Action bar, attach · voice · think · view actions · model · send.
            Same in Chat, Code and Remote; each surface passes its own
            composerActions + composerModel (2026-07-11, web parity).

            ONE row, always. It used to be `flex-wrap`, and a run starting was
            enough to break it: the Code mode trigger grows by a dot or a
            "then bypass" label the moment a loop is in flight, the row ran out
            of width and the tail (model picker and the Stop button) dropped
            onto a second line. So the composer was a different height standing
            still than it was working, which is what the owner saw as "der Stop
            Knopf oeffnet eine weitere Zeile, alles sieht asymmetrisch aus".
            No wrapping, a fixed-height row, and every control shrink-0 with
            only the middle spacer giving way, das `flex: 0 0 auto` steckt
            seit der Composer-Grammatik im Rezept `.lu-control` (index.css),
            nicht mehr als `shrink-0` an jedem einzelnen Knopf. */}
        {/* Narrow (a phone-wide window, 375 px with the rail open): the row
            had 470 px of controls in 253, and Sampling, the model and Send
            were pushed out past the right edge. Below 26rem the labels of
            Docs, Plugins and Effort shrink to their icons, and Sampling, the
            model and Send move to a second line of their own. That line is
            there by WIDTH alone, never by what is running, so the composer
            still keeps one height while it works (see below). */}
        {/* The query container sits one level out: a container query cannot
            style the container itself, and the row has to wrap. */}
        <div className="@container">
        <div className="flex flex-nowrap items-center gap-1 px-2 py-1.5 min-h-[38px] border-t border-gray-200 dark:border-white/[0.05] @max-[26rem]:flex-wrap">
          {/* Clip button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating || preparingImages || preparingFiles}
            className="lu-control lu-control--icon"
            title={createOn ? 'Attach images, clips, audio or files' : 'Attach images or files'}
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            data-testid="composer-file-input"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
          />

          <VoiceButton
            ref={voiceRef}
            // Streaming dictation: interim chunks arrive while talking, the final
            // transcript replaces them on stop, both via applyDictation, which
            // writes base + transcript and NEVER sends (user presses Send).
            onInterim={applyDictation}
            onTranscript={applyDictation}
            onRecordingChange={(r) => {
              if (r) dictationBaseRef.current = input
              setIsVoiceRecording(r)
            }}
            // The microphone stays free while an answer streams: a take that
            // runs can be stopped, and a new one can be started, as the field
            // takes typing then too. Box run d307-i (15.10.2026): with the
            // button greyed out until the answer ended, a send while
            // dictating still left the microphone out of reach.
          />

          {/* Think toggle ('always'-models render it locked on).
              Der Ein-Zustand kommt aus `aria-pressed`, nicht aus einer
              zweiten Klassenkette: das neutrale Rezept liest ihn und setzt
              den Behaelter. Vorher war Ein ein blaues Pill, dieselbe Farbe,
              die auch der Fokusring traegt, also zwei Bedeutungen auf einer
              Farbe (Audit §4, Chat mit Antwort). */}
          <button
            onClick={() => {
              if (canThink) updateSettings({ thinkingEnabled: !thinkingEnabled })
            }}
            disabled={!canThink && !thinkLockedOn}
            aria-pressed={(thinkingEnabled && canThink) || thinkLockedOn}
            className="lu-control"
            title={
              thinkLockedOn
                ? 'Thinking is always on for this model'
                : canThink
                  ? (thinkingEnabled ? 'Thinking ON' : 'Thinking OFF')
                  : 'Model does not support thinking'
            }
          >
            <Brain size={11} />
            {/* In a narrow composer the icon and the tooltip carry it. */}
            <span className="@max-[30rem]:hidden">Think</span>
          </button>

          {/* Reasoning effort. Same shape and size as the Think button beside
              it, because it is the same kind of statement about the same
              model; a second visual language here would read as a second
              subject. Deshalb dasselbe Rezept und keine eigene Klassenkette:
              hier stand dasselbe blaue Pill, das am Think-Knopf nebenan
              abgebaut wurde, weil es die Farbe des Fokusrings zweitverwendet
              (Audit §4, Composer-Grammatik).

              Der Zustand ist die STUFE, und die steht im Knopf und im
              zugaenglichen Namen. Kein `aria-pressed`: vier Stufen sind kein
              Ein/Aus-Zustand, und „gedrueckt" waere fuer „low" so wahr wie
              fuer „max". Sichtbar ist der Knopf ohnehin nur, solange Denken an
              ist, und der Behaelter am Think-Knopf daneben sagt das bereits. */}
          {showEffort && (
            <button
              data-testid="effort-toggle"
              onClick={cycleEffort}
              aria-label={`Reasoning effort: ${effortText}`}
              className="lu-control"
              title={effortHint}
            >
              <Gauge size={11} />
              <span className="@max-[26rem]:sr-only">{effortText}</span>
            </button>
          )}
          {showEffortGreyed && (
            <button
              data-testid="effort-toggle-unsupported"
              disabled
              aria-label={`Reasoning effort: ${effortNote}`}
              className="lu-control"
              title={`Reasoning effort: ${effortNote}`}
            >
              <Gauge size={11} />
              <span className="@max-[26rem]:sr-only">Effort</span>
            </button>
          )}

          {/* View-specific actions (Docs · Plugins · Tools) */}
          <div className="flex flex-nowrap items-center gap-1 shrink-0">{composerActions}</div>

          {/* Cloud is a money state and it is said here, in words, on the row
              the user looks at while typing. The tinted box around this row
              carries the same message; a colour alone is not a statement
              (Nebenbefund 4, R5 re-measure 2026-08-30). */}
          {cloudMode && (
            <span
              data-testid="composer-cloud-state"
              title="Cloud mode: this message runs on LU's hosted GPUs and is billed to your lu-labs.ai credits. The Cloud switch up in the header turns it off."
              className="flex items-center gap-1 px-1.5 py-1.5 rounded-md shrink-0 t-micro font-medium bg-lu-cloud/15 text-lu-cloud dark:text-lu-cloud-lift border border-lu-cloud/30"
            >
              <img
                src={MONOGRAM}
                alt=""
                width={10}
                height={10}
                draggable={false}
                className={`shrink-0 select-none ${MONOGRAM_INVERT}`}
              />
              <span>Cloud</span>
            </span>
          )}

          <div className="flex-1 min-w-0" />

          {/* The right cluster. `contents` in a wide row, so the controls sit
              in the one row exactly as before; in a narrow one its own full
              width line, right aligned. */}
          <div className="contents @max-[26rem]:flex @max-[26rem]:basis-full @max-[26rem]:min-w-0 @max-[26rem]:items-center @max-[26rem]:justify-end @max-[26rem]:gap-1" data-testid="composer-right-cluster">
          {/* Sampling controls sit next to the picker: same row, collapsed. */}
          <div className="shrink-0"><SamplingControls /></div>

          {/* Model picker, opens upward from the composer. The one control
              that may give way when the row runs out of width (Code tab with
              the explorer open): its name ellipsizes in the middle instead of
              pushing Stop out of the frame. */}
          <div className="min-w-[4rem] shrink">{composerModel}</div>

          {/* Send and Stop are the SAME slot: one fixed 26x26 box at the end of
              the row, never two, never one below the other. Stop replaces Send
              in place while a run is in flight, exactly as the Chat surface has
              always done, and because the box is sized rather than padded the
              row height cannot move between the two states. */}
          {/* Send und Stop hatten hier je ein `whileTap` aus framer-motion,
              zwei von den sechs, die der Audit als „6 von 462" zaehlt. Der
              Druck steht jetzt als eine Regel in index.css und laeuft ueber
              die `transition` von `.lu-control` weich aus; die beiden
              Knoepfe brauchen framer-motion dafuer nicht mehr. */}
          <div className="shrink-0 w-[var(--control-h-sm)] h-[var(--control-h-sm)]" data-testid="composer-send-slot">
            {isGenerating ? (
              <button
                // Called bare: the click event is not an argument of Stop (GH #140).
                onClick={() => onStop()}
                // Neutral, nicht rot: Stop ist der Normalabschluss und die
                // haeufigste Aktion waehrend eines Streams. `data-active`
                // gibt ihm den Behaelter des neutralen Rezepts, damit er
                // auffindbar bleibt, ohne die Fehlerfarbe zu tragen.
                data-active="true"
                className="lu-control lu-control--icon w-full h-full"
                aria-label="Stop generation"
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={preparingImages || preparingFiles || (!input.trim() && images.length === 0 && files.length === 0 && media.length === 0) || isTranscribing || !!waitingForLocalLane}
                className="lu-control lu-control--icon lu-primary w-full h-full"
                aria-label="Send message"
                title={composerHint(enterMode, isMacOS())}
              >
                <Send size={13} />
              </button>
            )}
          </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
