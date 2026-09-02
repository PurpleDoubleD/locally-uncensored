import { useEffect, useRef, useState } from 'react'
import { Bot, Loader2, PanelRightClose, PanelRightOpen, Square, Check, X, ChevronDown } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useChatStore } from '../../stores/chatStore'
import { useAgentTaskStore } from '../../stores/agentTaskStore'
import { isTerminal, taskElapsedSeconds, type AgentTask } from '../../lib/agent-tasks'

/**
 * Die rechte Spalte für Hintergrundagenten.
 *
 * WANN SIE DA IST — die Entscheidung des Nutzers, wörtlich: das Panel ist
 * "nur für Hintergrund-Agenten". Ein gewöhnlicher Agentenlauf bekommt keins.
 * Es erscheint, sobald diese Konversation eine Hintergrundaufgabe hat, und
 * verschwindet wieder, wenn keine mehr da ist. Ein dauerhaft sichtbares
 * leeres Panel wäre eine Spalte, die neunundneunzig Prozent der Zeit nichts
 * sagt und trotzdem Platz nimmt.
 *
 * Der Preis dieser Entscheidung, offen benannt: wer nie delegiert, erfährt
 * nie, dass es das gibt. Das ist hier richtig herum — die Fähigkeit gehört
 * dem Modell, nicht dem Menschen; der Mensch will sie sehen, wenn sie
 * benutzt wird, und nicht als Angebot.
 *
 * Zugeklappt bleibt es eine schmale Leiste mit einem Zähler, damit "es läuft
 * etwas" auch dann sichtbar ist, wenn jemand die Spalte weggeklappt hat.
 */

function statusIcon(t: AgentTask) {
  if (t.status === 'running') return <Loader2 size={10} className="animate-spin text-blue-400 shrink-0" />
  if (t.status === 'done') return <Check size={10} className="text-green-500 shrink-0" />
  if (t.status === 'cancelled') return <Square size={10} className="text-gray-500 shrink-0" />
  return <X size={10} className="text-red-400 shrink-0" />
}

function TaskRow({ task, now }: { task: AgentTask; now: number }) {
  const [open, setOpen] = useState(false)
  const cancel = useAgentTaskStore((s) => s.cancel)
  const fertig = isTerminal(task.status)
  const ergebnis = task.status === 'done' ? task.output : task.error

  return (
    <div className="border-b border-gray-100 dark:border-white/[0.04] last:border-b-0">
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        {statusIcon(task)}
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex-1 min-w-0 text-left group"
          title={task.goal}
        >
          <div className="t-micro text-gray-700 dark:text-gray-300 truncate">{task.goal}</div>
          <div className="t-mono text-gray-400 dark:text-gray-600">
            {taskElapsedSeconds(task, now)}s
            {task.toolCalls > 0 && ` · ${task.toolCalls} ${task.toolCalls === 1 ? 'call' : 'calls'}`}
            {fertig && task.status !== 'done' && ` · ${task.status}`}
          </div>
          {/* Nur waehrend es laeuft. Nach dem Ende ist "zuletzt read_file"
              keine Auskunft mehr, sondern ein stehengebliebener Zeiger — das
              ERGEBNIS steht dann eine Zeile tiefer und ist das, was zaehlt. */}
          {task.status === 'running' && task.activity && (
            <div
              className="t-mono text-blue-500/70 dark:text-blue-400/60 truncate"
              data-testid="agent-task-activity"
            >
              {task.activity}
            </div>
          )}
        </button>
        {task.status === 'running' ? (
          <button
            onClick={() => cancel(task.id)}
            title="Stop this agent"
            data-testid="agent-task-cancel"
            className="p-0.5 rounded text-gray-400 hover:text-red-400 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0"
          >
            <Square size={9} />
          </button>
        ) : ergebnis ? (
          <ChevronDown
            size={10}
            className={`text-gray-400 shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        ) : null}
      </div>
      {open && ergebnis && (
        <div className="px-2 pb-1.5 t-micro whitespace-pre-wrap text-gray-600 dark:text-gray-400 leading-relaxed max-h-48 overflow-y-auto scrollbar-thin">
          {ergebnis}
        </div>
      )}
    </div>
  )
}

export function AgentPanel() {
  const convId = useChatStore((s) => s.activeConversationId)
  const tasks = useAgentTaskStore((s) => (convId ? s.byConv[convId] : undefined))
  const cancelAll = useAgentTaskStore((s) => s.cancelAll)
  const width = useUIStore((s) => s.agentPanelWidth)
  const collapsed = useUIStore((s) => s.agentPanelCollapsed)
  const setWidth = useUIStore((s) => s.setAgentPanelWidth)
  const setCollapsed = useUIStore((s) => s.setAgentPanelCollapsed)

  // Die Laufzeit tickt, solange etwas läuft — und NUR dann. Ein Intervall,
  // das auch bei lauter fertigen Aufgaben weiterläuft, weckt die App jede
  // Sekunde für eine Zahl, die sich nicht mehr ändert.
  const laufend = (tasks ?? []).filter((t) => t.status === 'running').length
  const gescheitert = (tasks ?? []).filter((t) => t.status === 'failed').length

  // ── Eine NEUE Aufgabe klappt das Panel auf ─────────────────────────────
  //
  // Ohne diese acht Zeilen war die ganze Funktion eine 28-Pixel-Leiste: das
  // Panel startet zugeklappt (`agentPanelCollapsed: true`, persistiert), und
  // nichts hat es je wieder geöffnet. Der Nutzer verlangte „auf und zu
  // klappbar sobald aktiviert" — „sobald aktiviert" heißt: es zeigt sich,
  // wenn etwas losläuft.
  //
  // Nur bei einer Kennung, die dieses Panel noch nie gesehen hat, und nur
  // beim ERSTEN Mal je Konversation. Sonst risse es sich bei jeder der fünf
  // Aufgaben eines Fächers wieder auf, nachdem der Nutzer es weggeklappt hat
  // — und eine Spalte, die gegen den Klick zurückkommt, ist schlimmer als
  // eine, die nie erscheint.
  const gesehen = useRef<{ conv: string | null; ids: Set<string> }>({ conv: null, ids: new Set() })
  useEffect(() => {
    if (!convId) return
    if (gesehen.current.conv !== convId) {
      gesehen.current = { conv: convId, ids: new Set((tasks ?? []).map((t) => t.id)) }
      return
    }
    const neu = (tasks ?? []).filter((t) => !gesehen.current.ids.has(t.id))
    neu.forEach((t) => gesehen.current.ids.add(t.id))
    if (neu.some((t) => t.status === 'running')) setCollapsed(false)
  }, [convId, tasks, setCollapsed])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!laufend) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [laufend])

  if (!convId || !tasks?.length) return null

  if (collapsed) {
    return (
      <div className="w-7 shrink-0 flex flex-col items-center py-1 border-l border-gray-200 dark:border-white/[0.04] bg-gray-50 dark:bg-white/[0.01]">
        <button
          onClick={() => setCollapsed(false)}
          title={laufend ? `${laufend} background ${laufend === 1 ? 'agent' : 'agents'} running` : 'Show background agents'}
          data-testid="agent-panel-expand"
          className="p-1 rounded text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        >
          <PanelRightOpen size={12} />
        </button>
        {/* Auch zugeklappt muss "es läuft etwas" sichtbar bleiben — sonst
            versteckt ein Klick die einzige Spur eines Agenten, der gerade
            Werkzeuge auf der Maschine des Nutzers fährt. */}
        {laufend > 0 && (
          <button
            onClick={() => setCollapsed(false)}
            title={`${laufend} running`}
            data-testid="agent-panel-running-badge"
            className="mt-1 flex flex-col items-center text-blue-400"
          >
            <Loader2 size={10} className="animate-spin" />
            <span className="t-mono">{laufend}</span>
          </button>
        )}
        {/* Ein GESCHEITERTER Agent hinterließ auf der Leiste gar nichts: der
            Zähler oben zählt nur laufende. Wer das Panel weggeklappt hatte,
            erfuhr nie, dass eine Aufgabe fehlgeschlagen ist — die Arbeit war
            getan, das Ergebnis war ein Fehler, und niemand sah ihn. */}
        {gescheitert > 0 && (
          <button
            onClick={() => setCollapsed(false)}
            title={`${gescheitert} failed`}
            data-testid="agent-panel-failed-badge"
            className="mt-1 flex flex-col items-center text-red-400"
          >
            <X size={10} />
            <span className="t-mono">{gescheitert}</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="relative shrink-0 flex flex-col border-l border-gray-200 dark:border-white/[0.04] bg-gray-50/50 dark:bg-white/[0.01] min-h-0"
      style={{ width }}
      data-testid="agent-panel"
    >
      <div
        onPointerDown={(e) => {
          e.preventDefault()
          const startX = e.clientX
          const startWidth = width
          // Das Panel steht rechts, nach links ziehen macht es breiter.
          const onMove = (ev: PointerEvent) => setWidth(startWidth + (startX - ev.clientX), window.innerWidth)
          const onUp = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
          }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
        }}
        title="Drag to resize"
        data-testid="agent-panel-resize-handle"
        className="absolute left-0 top-0 h-full w-1 -ml-0.5 z-10 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors"
      />

      <div className="flex items-center gap-1 p-1.5 border-b border-gray-200 dark:border-white/[0.04]">
        <Bot size={11} className="text-gray-500 shrink-0" />
        <span className="t-label text-gray-500 dark:text-gray-400 flex-1">
          Agents{laufend ? ` · ${laufend}` : ''}
        </span>
        {laufend > 0 && (
          <button
            onClick={() => cancelAll(convId)}
            title="Stop every running agent"
            data-testid="agent-panel-stop-all"
            className="p-1 rounded text-gray-400 hover:text-red-400 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0"
          >
            <Square size={10} />
          </button>
        )}
        <button
          onClick={() => setCollapsed(true)}
          title="Hide background agents"
          data-testid="agent-panel-collapse"
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 dark:text-gray-600 transition-colors shrink-0"
        >
          <PanelRightClose size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
        {/* Neueste oben: das Panel beantwortet "was läuft gerade", nicht
            "was lief zuerst". */}
        {[...tasks].reverse().map((t) => (
          <TaskRow key={t.id} task={t} now={now} />
        ))}
      </div>
    </div>
  )
}
