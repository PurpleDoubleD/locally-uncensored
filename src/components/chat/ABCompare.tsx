import { useState, useRef, useEffect, useMemo } from 'react'
import { useCompareStore } from '../../stores/compareStore'
import { useModels } from '../../hooks/useModels'
import { useABCompare } from '../../hooks/useABCompare'
import { MarkdownRenderer } from './MarkdownRenderer'
import { stripModelNoise } from '../../lib/strip-model-noise'
import { ArrowLeft, Send, Square, Zap, Clock, Hash } from 'lucide-react'

export function ABCompare() {
  const {
    modelA, modelB, messagesA, messagesB,
    statsA, statsB, isStreamingA, isStreamingB,
    setModelA, setModelB, setComparing, reset,
  } = useCompareStore()
  // appMode-filtered view (useModels choke point) — the raw store keeps the
  // full list, which leaked paid lu-cloud models into Local mode (and local
  // models into Cloud mode) in the Compare pickers.
  const { models } = useModels()
  const textModels = models.filter(m => m.type === 'text')
  const { sendCompare, stopCompare } = useABCompare()
  const [input, setInput] = useState('')
  const scrollRefA = useRef<HTMLDivElement>(null)
  const scrollRefB = useRef<HTMLDivElement>(null)
  const isStreaming = isStreamingA || isStreamingB

  // Auto-scroll during streaming
  useEffect(() => {
    if (isStreamingA && scrollRefA.current) {
      scrollRefA.current.scrollTop = scrollRefA.current.scrollHeight
    }
  }, [messagesA, isStreamingA])

  useEffect(() => {
    if (isStreamingB && scrollRefB.current) {
      scrollRefB.current.scrollTop = scrollRefB.current.scrollHeight
    }
  }, [messagesB, isStreamingB])

  const handleSend = () => {
    if (!input.trim() || isStreaming) return
    sendCompare(input)
    setInput('')
  }

  // Cleaned assistant text per pane. Memoised on a length signature because
  // both panes stream at once and the strip would otherwise re-run its whole
  // regex set over every message on every token.
  const sig = (ms: typeof messagesA) => ms.reduce((n, m) => n + (m.content || '').length, 0) + ':' + ms.length
  const sigA = sig(messagesA), sigB = sig(messagesB)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cleanA = useMemo(() => new Map(messagesA.map((m) => [m.id, stripModelNoise(m.content || '')])), [sigA])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cleanB = useMemo(() => new Map(messagesB.map((m) => [m.id, stripModelNoise(m.content || '')])), [sigB])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-3 justify-self-start">
          <button
            onClick={() => { setComparing(false); reset() }}
            className="p-1 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={14} />
          </button>

          <span className="text-[0.7rem] font-semibold text-white">
            A/B Compare
          </span>
        </div>

        {/* Model selectors */}
        <div className="flex items-center justify-center gap-3 justify-self-center">
          <select
            value={modelA}
            onChange={(e) => setModelA(e.target.value)}
            className="px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30 t-micro text-red-300 focus:outline-none"
          >
            <option value="">Model A</option>
            {textModels.map(m => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
          <span className="t-micro text-gray-500 font-bold">VS</span>
          <select
            value={modelB}
            onChange={(e) => setModelB(e.target.value)}
            className="px-2 py-1 rounded-lg bg-blue-500/10 border border-blue-500/30 t-micro text-blue-300 focus:outline-none"
          >
            <option value="">Model B</option>
            {textModels.map(m => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
        </div>
        <div className="justify-self-end" />
      </div>

      {/* Split view */}
      <div className="flex-1 flex min-h-0">
        {/* Model A column */}
        <div className="flex-1 flex flex-col border-r border-white/5">
          <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
            <span className="t-micro font-medium text-red-400">{modelA || 'Select Model A'}</span>
            {statsA && (
              <div className="flex items-center gap-2 text-[0.5rem] text-gray-500 lu-hud-num">
                <span className="flex items-center gap-0.5"><Zap size={8} />{statsA.tokensPerSec.toFixed(1)} t/s</span>
                <span className="flex items-center gap-0.5"><Clock size={8} />{(statsA.timeMs / 1000).toFixed(1)}s</span>
                <span className="flex items-center gap-0.5"><Hash size={8} />{statsA.tokens}</span>
              </div>
            )}
          </div>
          <div ref={scrollRefA} className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
            {messagesA.map(msg => (
              <div key={msg.id} className={`text-[0.7rem] ${msg.role === 'user' ? 'text-gray-400 italic' : 'text-gray-200'}`}>
                {msg.role === 'assistant' ? (
                  <MarkdownRenderer content={cleanA.get(msg.id) || (isStreamingA ? '...' : '')} />
                ) : (
                  <p>{msg.content}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Model B column */}
        <div className="flex-1 flex flex-col">
          <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
            <span className="t-micro font-medium text-blue-400">{modelB || 'Select Model B'}</span>
            {statsB && (
              <div className="flex items-center gap-2 text-[0.5rem] text-gray-500 lu-hud-num">
                <span className="flex items-center gap-0.5"><Zap size={8} />{statsB.tokensPerSec.toFixed(1)} t/s</span>
                <span className="flex items-center gap-0.5"><Clock size={8} />{(statsB.timeMs / 1000).toFixed(1)}s</span>
                <span className="flex items-center gap-0.5"><Hash size={8} />{statsB.tokens}</span>
              </div>
            )}
          </div>
          <div ref={scrollRefB} className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
            {messagesB.map(msg => (
              <div key={msg.id} className={`text-[0.7rem] ${msg.role === 'user' ? 'text-gray-400 italic' : 'text-gray-200'}`}>
                {msg.role === 'assistant' ? (
                  <MarkdownRenderer content={cleanB.get(msg.id) || (isStreamingB ? '...' : '')} />
                ) : (
                  <p>{msg.content}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-white/5">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder={modelA && modelB ? 'Same prompt, two models...' : 'Select both models first'}
            disabled={!modelA || !modelB || isStreaming}
            className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-[0.7rem] text-white placeholder-gray-500 focus:outline-none focus:border-white/25 disabled:opacity-40"
          />
          {isStreaming ? (
            <button onClick={stopCompare} className="px-3 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors">
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || !modelA || !modelB}
              className="px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 transition-colors disabled:opacity-30"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
