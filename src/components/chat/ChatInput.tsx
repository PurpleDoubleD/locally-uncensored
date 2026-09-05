import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { Send, Square, Paperclip, X, Brain, Gauge, Terminal } from 'lucide-react'
import { matchAgentCommands, type AgentCommand, type CommandScope } from '../../lib/agent-commands'
import { VoiceButton } from './VoiceButton'
import { ApprovalDialog } from './ApprovalDialog'
import { useVoiceStore } from '../../stores/voiceStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { useChatStore } from '../../stores/chatStore'
import { isThinkingCompatible, isVisionCompatible, declaredVision } from '../../lib/model-compatibility'
import { clampEffort, effortChoices, effortLabel, nextEffort, DEFAULT_EFFORT } from '../../lib/effort'
import type { AgentToolCall } from '../../types/agent-mode'
import type { ImageAttachment } from '../../types/chat'
import { COMPOSER_MAX_W } from './composer-width'
import { Hinweis } from '../ui/Hinweis'
import { HINWEIS_TEXT, HINWEIS_ZEILE } from '../../lib/hinweis'
import { MONOGRAM, MONOGRAM_INVERT } from '../layout/brand'

interface Props {
  onSend: (content: string, images?: ImageAttachment[]) => void
  onStop: () => void
  isGenerating: boolean
  pendingApproval?: AgentToolCall | null
  onApprove?: () => void
  onReject?: () => void
  disabled?: boolean
  /**
   * Which commands this composer offers. Was a boolean meaning
   * "Coding-Agent-only"; since 2.6.8 it is the SCOPE, because the answer
   * stopped being all-or-nothing: plain chat offers /compact and nothing else,
   * while Agent and Coding offer the whole set. Undefined = no menu at all.
   */
  slashCommands?: CommandScope
  /**
   * Open the Documents (RAG) panel. The clip button is images-only; this lets the
   * composer point a user who tried to attach a PDF/doc to the right place
   * (GH #69: a PDF was silently dropped and the model hallucinated it couldn't
   * receive attachments).
   */
  onAttachDocs?: () => void
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
}

/** How long the synchronous double-fire guard below stays shut. */
const SEND_LOCK_MS = 700

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
function passSendLock(lock: { current: number }): boolean {
  const now = Date.now()
  if (now - lock.current < SEND_LOCK_MS) return false
  lock.current = now
  return true
}

function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const base64 = dataUrl.split(',')[1]
      resolve({ data: base64, mimeType: file.type || 'image/png', name: file.name })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function ChatInput({ onSend, onStop, isGenerating, pendingApproval, onApprove, onReject, disabled, slashCommands, onAttachDocs, composerModel, composerActions, composerAbove }: Props) {
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  // Transient hint shown when a non-image file is attached. The clip + drop are
  // images-only; PDFs/Word/text belong in the Documents (RAG) panel (GH #69).
  const [docHint, setDocHint] = useState(false)
  const [isVoiceRecording, setIsVoiceRecording] = useState(false)
  // Slash-command autocomplete (v2.5.3). When the input is a lone "/token", show
  // the matching agent commands; ↑/↓ to move, Enter/Tab to pick, Esc to dismiss.
  const [cmdMenu, setCmdMenu] = useState<AgentCommand[]>([])
  const [cmdIndex, setCmdIndex] = useState(0)
  /**
   * Ein Entwurf gehoert dem Gespraech, in dem er getippt wurde.
   *
   * Der Composer wird beim Wechsel nicht neu gebaut, also stand der halbe Satz
   * aus dem alten Chat im neuen wieder im Feld, einmal beobachtet am
   * 03.09.2026, mit dem naheliegenden Ausgang: der Satz geht an den falschen
   * Empfaenger. Ihn beim Wechsel einfach zu leeren waere die andere Haelfte
   * desselben Fehlers, nur teurer (Arbeit weg), darum wird er beiseitegelegt
   * und beim Zurueckkommen wieder hingelegt. Bilder reisen mit dem Text, sonst
   * hinge die Anlage am falschen Satz.
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
  const [entwuerfe, setEntwuerfe] = useState<Record<string, { text: string; bilder: ImageAttachment[] }>>({})
  const [letztesGespraech, setLetztesGespraech] = useState(conversationId)
  if (letztesGespraech !== conversationId) {
    const vorher = letztesGespraech
    setLetztesGespraech(conversationId)
    if (vorher) {
      const text = input
      const bilder = images
      // Der Aktualisierer laeuft unter StrictMode zweimal und muss deshalb
      // beim zweiten Mal dasselbe Ergebnis liefern wie beim ersten. Er
      // rechnet nur aus `bisher`, haengt also an nichts, was er selbst
      // veraendert.
      setEntwuerfe((bisher) => {
        if (text || bilder.length) return { ...bisher, [vorher]: { text, bilder } }
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
  // Only while thinking is really happening. 'always' models keep their Think
  // button locked on, so the rung is live there without the button being.
  const thinkingIsOn = thinkLockedOn || (thinkingEnabled && canThink)
  const showEffort = effortSteps.length > 0 && thinkingIsOn
  const serverVision = declaredVision(activeModelMeta)
  const canSeeImages = serverVision !== undefined ? serverVision : isVisionCompatible(activeModel)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [input])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const all = Array.from(files)
    const imageFiles = all.filter(f => f.type.startsWith('image/'))
    // A non-image file (PDF, Word, text, …) can't ride along as a chat image,
    // it belongs in the Documents panel (RAG) so the model can actually read it.
    // Silently dropping it made a user think their PDF attached when it didn't,
    // and the model then hallucinated that it "couldn't receive attachments"
    // (GH #69). Surface a hint pointing at the right place instead.
    if (imageFiles.length < all.length) setDocHint(true)
    if (imageFiles.length === 0) return
    const newImages = await Promise.all(imageFiles.map(fileToImageAttachment))
    setImages(prev => [...prev, ...newImages].slice(0, 5)) // max 5 images
  }, [])

  // Auto-dismiss the document hint after a few seconds.
  useEffect(() => {
    if (!docHint) return
    const t = setTimeout(() => setDocHint(false), 8000)
    return () => clearTimeout(t)
  }, [docHint])

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // Write a dictation transcript (interim or final) into the input as
  // base + transcript, then resize the textarea. NEVER sends, because the user
  // reviews and presses Send (David 2026-06-06).
  const applyDictation = (text: string) => {
    const base = dictationBaseRef.current
    const sep = base && !/\s$/.test(base) ? ' ' : ''
    setInput(base + sep + text)
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
      }
    })
  }

  // Synchronous double-fire guard (David 2026-06-20: "ok generiere jetzt" landed
  // twice in one chat). The `isGenerating` prop and the cleared input only update
  // on the NEXT render, so two Enter keydowns in the same tick (key-repeat / IME
  // / a held Enter) both pass the checks below and send the identical message
  // twice. A short monotonic lock closes that window.
  const sendLockRef = useRef(0)
  const handleSend = () => {
    const trimmed = input.trim()
    if ((!trimmed && images.length === 0) || isGenerating || disabled) return
    if (!passSendLock(sendLockRef)) return
    onSend(trimmed || '(image)', images.length > 0 ? images : undefined)
    setInput('')
    setImages([])
    setCmdMenu([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  // Update the input + the slash-command typeahead together. The menu shows
  // what the SURFACE can actually carry out: everything in Agent and Coding,
  // and in plain chat only the commands marked for it (today: /compact).
  // Offering an agent command where there is no tool catalogue would be
  // offering work the surface cannot do.
  const updateInput = (value: string) => {
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isVoiceRecording || isTranscribing) return
      handleSend()
    }
  }

  // Paste handler for clipboard images (Ctrl+V screenshots)
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()
    const files = imageItems.map(item => item.getAsFile()).filter(Boolean) as File[]
    addFiles(files)
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
          <div className="absolute bottom-full left-0 right-0 mb-1.5 z-50 max-h-64 overflow-y-auto scrollbar-thin rounded-lg lu-elevated py-1">
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

        {/* Prompt area: hints, image previews, then the textarea (buttons live
            in the action bar below, web-parity two-row composer). */}
        <div className="px-3 pt-2.5">
          {/* Non-image attach hint (GH #69). The clip is images-only; PDFs, Word,
              and text files go through the Documents panel so the model can read them. */}
          {docHint && (
            // Eine ruhige Zeile statt des gelben Kastens mit dem gelben
            // Knopf darin: der Clip hat nur nicht das genommen, was der
            // Nutzer wollte, kaputt ist dabei nichts. Gebaut aus den
            // Konstanten und nicht aus `<Hinweis>`, weil beide Knoepfe hier
            // `onMouseDown` mit `preventDefault` brauchen: sonst verliert das
            // Textfeld beim Wegklicken den Schreibzeiger.
            <div role="status" className={`${HINWEIS_ZEILE} ${HINWEIS_TEXT.ruhig} mb-1.5 px-1`}>
              <span className="flex-1 min-w-0">
                The clip attaches images. To ask about a PDF, Word, or text file, add it in the Documents panel.
                {onAttachDocs && (
                  <button
                    onMouseDown={(e) => { e.preventDefault(); setDocHint(false); onAttachDocs() }}
                    className="ml-1 underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                  >
                    Open Documents
                  </button>
                )}
              </span>
              <button
                onMouseDown={(e) => { e.preventDefault(); setDocHint(false) }}
                className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
                aria-label="Dismiss"
              >
                <X size={11} />
              </button>
            </div>
          )}

          {/* Image previews */}
          {images.length > 0 && (
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
                  <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[0.45rem] text-gray-300 text-center rounded-b-lg truncate px-0.5">
                    {img.name}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Vision hint: a text-only model can't read the attached image.
              Non-blocking (send still works); the runtime error is also mapped
              to friendly copy. gthvidsten, GH Discussion #67. */}
          {images.length > 0 && activeModel && !canSeeImages && (
            <Hinweis className="mb-1.5 px-1">
              This model can't read images. Switch to a vision model (Gemma 4, LLaVA, Qwen-VL) to use the attachment.
            </Hinweis>
          )}

          {/* `data-lu-quiet-focus`: die EINE Ausnahme vom Fokusring des Hauses.
              Der Kasten um diese Zeile traegt seinen Fokus schon selbst
              (`focus-within:border-*` weiter oben), der Ring lag als zweiter,
              staerkerer Rahmen darin. Die Begruendung samt Messung steht an
              der Regel in index.css; `focus:outline-none` unten allein reicht
              nicht, es verliert gegen sie. */}
          <textarea
            data-lu-quiet-focus
            ref={textareaRef}
            value={input}
            onChange={(e) => updateInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setCmdMenu([]), 120)}
            onPaste={handlePaste}
            placeholder={disabled ? "Unavailable" : isDragOver ? "Drop images here..." : isTranscribing ? "Transcribing..." : isVoiceRecording ? "Recording..." : "Message..."}
            disabled={disabled}
            rows={1}
            className="w-full bg-transparent resize-none text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none text-[12px] leading-relaxed max-h-[200px] disabled:opacity-50 scrollbar-thin"
          />
        </div>

        {/* Action bar, attach · voice · think · view actions · model · send.
            Same in Chat, Code and Remote; each surface passes its own
            composerActions + composerModel (David 2026-07-11, web parity).

            ONE row, always. It used to be `flex-wrap`, and a run starting was
            enough to break it: the Code mode trigger grows by a dot or a
            "then bypass" label the moment a loop is in flight, the row ran out
            of width and the tail (model picker and the Stop button) dropped
            onto a second line. So the composer was a different height standing
            still than it was working, which is what David saw as "der Stop
            Knopf oeffnet eine weitere Zeile, alles sieht asymmetrisch aus".
            No wrapping, a fixed-height row, and every control shrink-0 with
            only the middle spacer giving way, das `flex: 0 0 auto` steckt
            seit der Composer-Grammatik im Rezept `.lu-control` (index.css),
            nicht mehr als `shrink-0` an jedem einzelnen Knopf. */}
        <div className="flex flex-nowrap items-center gap-1 px-2 py-1.5 min-h-[38px] border-t border-gray-200 dark:border-white/[0.05]">
          {/* Clip button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating}
            className="lu-control lu-control--icon"
            title="Attach images. For PDFs and documents use the Documents panel"
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
          />

          <VoiceButton
            // Streaming dictation: interim chunks arrive while talking, the final
            // transcript replaces them on stop, both via applyDictation, which
            // writes base + transcript and NEVER sends (user presses Send).
            onInterim={applyDictation}
            onTranscript={applyDictation}
            onRecordingChange={(r) => {
              if (r) dictationBaseRef.current = input
              setIsVoiceRecording(r)
            }}
            disabled={isGenerating}
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
            <span>Think</span>
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
              onClick={() => updateSettings({ reasoningEffort: nextEffort(effortLevels, effortNow) })}
              aria-label={`Reasoning effort: ${effortLabel(effortNow)}`}
              className="lu-control"
              title={`Reasoning effort: ${effortLabel(effortNow)}. Click to cycle. Higher effort spends more output tokens.`}
            >
              <Gauge size={11} />
              <span>{effortLabel(effortNow)}</span>
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

          {/* Model picker, opens upward from the composer */}
          <div className="shrink-0">{composerModel}</div>

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
                onClick={onStop}
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
                disabled={(!input.trim() && images.length === 0) || isTranscribing}
                className="lu-control lu-control--icon lu-primary w-full h-full"
                aria-label="Send message"
              >
                <Send size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
