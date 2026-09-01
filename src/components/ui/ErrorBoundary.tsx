import { Component, type ReactNode } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { log } from '../../lib/logger'
import { forceShowWindow, resetSettingsAndReload } from '../../lib/fatal-error'
import { ICON_LG } from './icon-size'

interface Props {
  children: ReactNode
  fallbackClassName?: string
  /**
   * Top-level boundary over the whole app (used in main.tsx): on a render throw
   * it force-shows the initially-hidden Tauri window (so the fallback is seen at
   * all — Bug D) and renders a full-screen, actionable recovery UI (reload /
   * reset settings) instead of the small inline card.
   */
  root?: boolean
  /**
   * Called by the inline "Retry" button *in addition to* clearing the error
   * state. LazyView uses it to throw away the memoized React.lazy payload —
   * without that, a chunk whose import() rejected once stays rejected for the
   * rest of the session and the Retry button would be decoration.
   */
  onRetry?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    log.error('ErrorBoundary caught', { error, componentStack: info.componentStack })
    // Bug D: a render throw above App.tsx's show_window effect would leave the
    // Tauri window hidden forever — force it visible so this UI is actually seen.
    if (this.props.root) forceShowWindow()
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
    this.props.onRetry?.()
  }

  render() {
    if (this.state.hasError) {
      // Bug D: full-screen, actionable recovery UI for the top-level boundary.
      // Inline styles (not Tailwind) so it renders even if a CSS/build problem
      // is part of the failure. Reload retries; Reset clears settings/state
      // (keeps chats & knowledge) — covers a poisoned persisted store.
      if (this.props.root) {
        const overlay: React.CSSProperties = {
          position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 14,
          background: '#171717', color: '#e5e5e5', padding: 24, textAlign: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }
        const btn: React.CSSProperties = {
          cursor: 'pointer', borderRadius: 8, padding: '8px 16px', fontSize: 13,
          border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)',
          color: '#e5e5e5',
        }
        return (
          <div style={overlay}>
            <AlertCircle size={28} color="#f87171" />
            <div style={{ fontSize: 18, fontWeight: 600 }}>LU hit a problem</div>
            <div style={{
              fontSize: 12, color: '#9ca3af', maxWidth: 560, maxHeight: 160, overflow: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'left',
              background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 8,
            }}>
              {this.state.error?.message || 'Unknown error'}
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
              <button style={btn} onClick={() => window.location.reload()}>Reload</button>
              <button style={btn} onClick={resetSettingsAndReload}>Reset settings &amp; reload</button>
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', maxWidth: 520 }}>
              Reset clears app settings (providers, preferences) but keeps your chats &amp; knowledge.
            </div>
          </div>
        )
      }
      return (
        <div className={this.props.fallbackClassName || 'flex flex-col items-center justify-center p-6 gap-3'}>
          <AlertCircle size={ICON_LG} className="text-red-400" />
          <p className="text-sm text-red-400 text-center">Something went wrong</p>
          <p className="text-xs text-gray-500 text-center max-w-[200px] break-words">
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 transition-colors"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
