import './index.css'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import { ICON_STROKE_PX } from './components/ui/icon-size'
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
/**
 * Welcher Baum in diesem Fenster steht. `index.html` lädt seit dem eigenen
 * Onboarding-Fenster in zwei Webviews; die Antwort kommt aus dem Fensterlabel
 * und steht einmal, in lib/host-window.ts.
 */
async function treeForThisWindow(): Promise<ReactNode> {
  const { hostWindow, awaitOnboardingHandover } = await import('./lib/host-window')

  // Das kleine Fenster bekommt den kleinsten Baum, der den Assistenten trägt
  // (OnboardingWindow.tsx) — nicht App, nicht AppShell, keine Keychain-
  // Hydration: nichts, das beim Schließen des Fensters mittendrin stürbe.
  if (hostWindow === 'onboarding') {
    const { OnboardingWindow } = await import('./components/onboarding/OnboardingWindow')
    return <OnboardingWindow />
  }

  // Das Hauptfenster wartet, solange das Onboarding drüben läuft — und zwar
  // VOR dem ersten Store-Import, damit es nachher frisch aus localStorage
  // liest, was der Assistent geschrieben hat. Ohne Onboarding-Fenster löst
  // das sofort auf.
  await awaitOnboardingHandover()

  const { default: App } = await import('./App.tsx')
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
  return <App />
}

async function boot() {
  const [tree, { ErrorBoundary }] = await Promise.all([
    treeForThisWindow(),
    import('./components/ui/ErrorBoundary'),
  ])
  // Die optische Korrektur der Icon-Leiter, einmal fuer die ganze App — und
  // seit den zwei Fenstern hier, ueber BEIDEN Baeumen, statt in AppShell.
  //
  // lucide skaliert seinen 24er-Strich mit der Groesse: `2 * size / 24`. Bei
  // den 19 Groessen, die diese App setzt (siehe `ui/icon-size.ts`), heisst
  // das 0,67px Strich bei size=8 und 1,67px bei size=20 — Faktor 2,5
  // zwischen zwei Icons in derselben Zeile, und keiner der beiden Werte liegt
  // auf einem Geraetepixel. `absoluteStrokeWidth` dreht die Rechnung um
  // (`strokeWidth * 24 / size`) und haelt die GESEHENE Staerke konstant auf
  // ICON_STROKE_PX = 1 CSS-Pixel: ein Geraetepixel bei 1x, zwei bei 2x.
  //
  // Warum hier und nicht an 668 Call-Sites: es ist dieselbe Entscheidung wie
  // bei `.lu-control` und beim Fokusring — ein Rezept an der Wurzel, das die
  // Call-Sites nichts dazuschreiben laesst. Und warum ueber der Verzweigung:
  // sonst truege ausgerechnet der erste Bildschirm der App (der Assistent im
  // kleinen Fenster) die Korrektur nicht.
  //
  // Kosten: keine. `useLucideContext()` ruft jedes lucide-Icon ohnehin schon
  // auf, der Wert ist in `LucideProvider` memoisiert und haengt hier an zwei
  // Konstanten — es gibt keinen Render, den es vorher nicht auch gab.
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary root>
        <LucideProvider absoluteStrokeWidth strokeWidth={ICON_STROKE_PX}>
          {tree}
        </LucideProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}

void boot().catch((err) => mountFatalError(rootEl, err))
