import { useChatStore } from '../../stores/chatStore'
import { computeContextFill } from '../../lib/token-usage'
import { useActiveContextWindow } from '../../hooks/useActiveContextWindow'
import { useSendSizeStore } from '../../stores/sendSizeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { shouldAutoCompact, autoCompactHint } from '../../lib/compact-trigger'
import { newestCompaction, isModelVisible } from '../../lib/run-compact-command'
import { formatCount, formatContextWindow } from '../../lib/formatters'

export function TokenCounter() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  // What the agent loops last actually built and sent for this conversation
  // (2.6.6, plan A2). Undefined on a plain chat, where the estimate stands.
  const sent = useSendSizeStore((s) => (activeConversationId ? s.byConv[activeConversationId] : undefined))

  // The denominator is the REAL context window the active model runs with —
  // provider-aware and shared with the Context dropdown so the two never drift
  // (David: "muss immer stimmen"). Ollama = the num_ctx we send; LM Studio =
  // loaded_context_length (what it actually loaded), NOT the model's max.
  const ctx = useActiveContextWindow()
  // MUSS vor dem fruehen `return null` weiter unten stehen. Als dieser Hook
  // dort unten bei seiner Verwendung stand, hatte die Komponente vier Hooks im
  // leeren Chat und fuenf im gefuellten — React 19 wirft dann beim Uebergang
  // „Rendered more hooks than during the previous render", und das ist ein
  // Absturz, kein Warnhinweis. Der Weg dorthin ist alltaeglich: neuer Chat mit
  // einem Cloud-Modell (ContextDropdown rendert die Kinder auch, wenn das
  // Fenster nicht verstellbar ist), erste Nachricht — fertig.
  const autoSchwelle = useSettingsStore((s) => s.settings.autoCompactThreshold)

  const conversation = conversations.find((c) => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // Context fill = what the NEXT request will roughly send, anchored on the
  // newest model-reported usage (real promptTokens include system prompt +
  // tools + RAG + history) plus the visible messages after it. Reasoning
  // (`thinking`) is never resent, so it is never counted — the old
  // conversation-high-water over totalTokens pinned this counter at "16.5k"
  // forever after one looping cloud reasoner burned its whole 16,384-token
  // completion budget, while the next real prompt cost 65 tokens (David,
  // 2026-07-12). An honest dip after compaction beats a sticky wrong maximum.
  // Messages PLUS the tool catalog: both are the request, both are billed, and
  // the catalog is the bigger half of what a fresh coding step costs. Leaving
  // it out made the meter read about 1.700 tokens low on every step of a
  // coding run, worst exactly where it is otherwise near zero.
  const fill = computeContextFill(
    messages,
    sent
      ? { tokens: sent.tokens + sent.toolsTokens, atMessageCount: sent.atMessageCount }
      : undefined,
  )
  const rawUsed = fill.used

  if (!activeConversationId || messages.length === 0) return null

  // Resolved real context window; fall back to the VRAM-safe default only while
  // the provider probe is still in flight (ctx not resolved yet). On a paid
  // provider the denominator is the SEND window, not the model window: a
  // 262k-context model whose steps are capped at 64k would otherwise sit green
  // at 25 percent forever, the red warning would never fire, and every support
  // case would arrive with a healthy meter next to a drained wallet (plan A2,
  // meter honesty).
  const window = ctx.sendWindow > 0 ? ctx.sendWindow : ctx.contextWindow
  const maxTokens = window > 0 ? window : 16384
  // Cap the numerator at the active window: a long chat carried onto a
  // smaller-context model shows "8.0k/8.0k" (full), not "20k/8k".
  const usedTokens = Math.min(rawUsed, maxTokens)
  // "Real" = anchored on a non-estimated model report and shown uncapped.
  const isReal = fill.real && usedTokens === rawUsed

  const ratio = maxTokens > 0 ? usedTokens / maxTokens : 0
  const color = ratio > 0.8 ? 'text-red-400' : ratio > 0.5 ? 'text-amber-400' : 'text-gray-500'
  const barColor = ratio > 0.8 ? 'bg-red-500' : ratio > 0.5 ? 'bg-amber-500' : 'bg-gray-500'

  // Dieselbe Schreibweise wie die Klapplade darunter. Vorher stand hier
  // 8192/1000 und dort 8192/1024, also `8.2k` neben `8K` fuer eine einzige
  // Zahl (Gegenprobe G2, 04.09.2026).
  const formatK = formatContextWindow

  const source = ctx.provider === 'lmstudio'
    ? "LM Studio loaded context"
    : ctx.provider === 'ollama'
      ? 'Ollama num_ctx'
      : ctx.provider === 'builtin'
        ? 'LU Engine loaded context'
        : 'model context'
  const capped = ctx.sendWindow > 0 && ctx.contextWindow > ctx.sendWindow
  const capNote = capped
    ? `. Capped: a step sends at most ${formatCount(maxTokens)} of this model's ${formatCount(ctx.contextWindow)} tokens (Settings, send window), and tool results older than the newest step go out shortened`
    : ''
  const title = fill.source === 'built'
    ? `Last request: ${formatCount(usedTokens)} / ${formatCount(maxTokens)} tokens, the size of the payload actually built for the last step, tool catalog, decay and compaction included${capNote}`
    : isReal
      ? `Context: ${formatCount(usedTokens)} / ${formatCount(maxTokens)} tokens (${source}), anchored on the model's last reported usage (includes system prompt + tools + RAG); reasoning tokens are not context and aren't counted${capNote}`
      : `Estimated: ${formatCount(usedTokens)} / ${formatCount(maxTokens)} tokens (${source}), estimate until the model reports real usage${capNote}`

  // ── Wie weit ist es noch bis zur automatischen Kompaktierung ────────────
  //
  // WARUM UEBERHAUPT: bis hierher stand die Schwelle ausschliesslich in den
  // Einstellungen. Wer sie eingeschaltet hatte, sah im Chat nur den Fuellstand
  // und konnte nicht wissen, ob die naechste Nachricht noch durchgeht oder
  // eine Zusammenfassung ausloest. Die Claude-Code-Desktop-App schreibt genau
  // diesen Satz in ihre Statuszeile, und er ist der Grund, warum dort niemand
  // von einer Kompaktierung ueberrascht wird.
  //
  // WARUM ueber `shouldAutoCompact` und nicht mit einer eigenen Rechnung: die
  // wirksame Schwelle ist NICHT die eingestellte. `shouldAutoCompact` zieht
  // einen Sicherheitsabschlag ab, solange der Fuellstand nur geschaetzt ist —
  // eine hier selbst gerechnete Prozentzahl waere im haeufigsten Fall (kein
  // echter Usage-Report) schlicht die falsche. Dieselbe Funktion zu fragen,
  // die spaeter auch entscheidet, ist der einzige Weg, bei dem Anzeige und
  // Verhalten nicht auseinanderlaufen koennen.
  const sichtbareAnzahl = messages.filter(isModelVisible).length
  const autoUrteil = autoSchwelle
    ? shouldAutoCompact({
        used: rawUsed,
        window: maxTokens,
        source: fill.source,
        real: fill.real,
        // `maxTokens > 0` war immer wahr — auch fuer den 16384er-Notnagel
        // weiter oben, den es nur gibt, solange die Anbieter-Abfrage laeuft.
        // Der Zaehler behauptete damit sekundenlang ein bekanntes Fenster:
        // 14k belegt auf einem 128k-Modell las sich als "triggers on the next
        // message", bis die Antwort kam. `window` ist die Zahl VOR dem
        // Notnagel und damit die ehrliche Auskunft.
        windowIsTrue: window > 0,
        messageCount: sichtbareAnzahl,
        threshold: autoSchwelle,
        lastCompactAtMessageCount: newestCompaction(conversation?.compactions)?.atMessageCount,
      })
    : null
  const autoHinweis = autoCompactHint(autoUrteil)

  // `span`, nicht `div`, und ohne eigenes Padding: seit D-S06 ist dieser
  // Fuellstand die Beschriftung INNERHALB des Kontextfenster-Knopfes
  // (`ContextDropdown`). Ein `div` im `<button>` ist kein gueltiges
  // Phrasing-Content, und das Padding kam sonst zweimal.
  return (
    <span className={`inline-flex items-center gap-1.5 ${color}`} title={autoHinweis ? `${title}. ${autoHinweis}` : title}>
      <span className="relative block w-12 h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
        <span
          className={`block h-full rounded-full transition-[width] duration-[var(--motion-slow)] ${barColor}`}
          style={{ width: `${Math.min(ratio * 100, 100)}%` }}
        />
        {/* Die Marke sitzt auf der WIRKSAMEN Schwelle, derselben, die
            entscheidet. Nur gezeichnet, wenn sie ueberhaupt in den Balken
            faellt — eine Marke am Rand behauptet eine Genauigkeit, die zwei
            Pixel nicht tragen. */}
        {autoUrteil && autoUrteil.effectiveThreshold > 0.02 && autoUrteil.effectiveThreshold < 0.98 && (
          <span
            aria-hidden
            data-testid="auto-compact-mark"
            className="absolute top-0 bottom-0 w-px bg-current opacity-50"
            style={{ left: `${autoUrteil.effectiveThreshold * 100}%` }}
          />
        )}
      </span>
      {/* `font-mono tabular-nums` war dasselbe Rezept, nur an der Call-Site
          buchstabiert. `.lu-hud-num` ist die eine Stelle, an der es steht. */}
      <span className="text-[0.55rem] lu-hud-num">
        {formatK(usedTokens)}/{formatK(maxTokens)}
      </span>
    </span>
  )
}
