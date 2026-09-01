import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { mountFatalError } from './lib/fatal-error'
import { installMcpShutdown } from './api/mcp/shutdown'

const rootEl = document.getElementById('root')!

// T-53: external MCP servers are child processes this page owns, and nothing
// took them down when the page went away — a reload orphaned them for the rest
// of the app's life. Wired here, not in a component effect: the listeners
// belong to the page, not to a mount, and they must be standing before
// anything can connect a server. Cheap by construction — `external-client`
// imports the shell plugin lazily inside connect(), so this adds two listeners
// and no Tauri runtime to the boot chunk.
installMcpShutdown()

// Bug D (surfingbird1010): a throw while a persisted store hydrates from corrupt
// data (D1 corrupt chat-settings / D2 migrate throw / D5 locked IndexedDB) fires
// at module-import time — before the React ErrorBoundary can mount. With the
// window starting hidden, that left the app launched-but-invisible. Load the app
// via dynamic import inside a catch so any boot throw renders an actionable
// recovery screen (which also force-shows the window) instead of a blank page.
// The Rust force-show timeout (main.rs setup) is the ultimate net.
async function boot() {
  const [{ default: App }, { ErrorBoundary }] = await Promise.all([
    import('./App.tsx'),
    import('./components/ui/ErrorBoundary'),
  ])
  // H5: load provider API keys from the OS keychain (Win/macOS) before the UI
  // can issue a provider call, migrating any old localStorage key into the
  // vault. Time-boxed so a wedged keychain can never block launch; no-op /
  // localStorage fallback on Linux + the web build.
  try {
    const { useProviderStore } = await import('./stores/providerStore')
    await Promise.race([
      useProviderStore.getState().hydrateProviderKeys(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
  } catch { /* keychain hydration is best-effort */ }
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary root>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}

void boot().catch((err) => mountFatalError(rootEl, err))
