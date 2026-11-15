import './index.css'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import { ICON_STROKE_PX } from './components/ui/icon-size'
import { mountFatalError } from './lib/fatal-error'
import { installMcpShutdown } from './api/mcp/shutdown'
import { installBackgroundShutdown } from './lib/background-shutdown'
import { isMobileHost } from './lib/mobile-host'

const rootEl = document.getElementById('root')!

// A phone or tablet gets the mobile shell (src/mobile), everything else the
// desktop shell. Decided once; see lib/mobile-host.ts.
const mobileHost = isMobileHost()

// T-53: external MCP servers are child processes this page owns, and nothing
// took them down when the page went away — a reload orphaned them for the rest
// of the app's life. Wired here, not in a component effect: the listeners
// belong to the page, not to a mount, and they must be standing before
// anything can connect a server. Cheap by construction — `external-client`
// imports the shell plugin lazily inside connect(), so this adds two listeners
// and no Tauri runtime to the boot chunk.
// Not on a phone: there are no MCP child processes there, and the mobile
// shell has its own lifecycle (src/mobile/platform/lifecycle.ts).
if (!mobileHost) installMcpShutdown()

// B1 Nachbesserung 1 (3.0.1): "Stop heisst Stop" gilt auch fuer App beenden,
// Fenster schliessen und Netzabbruch, nicht nur fuer den Stop-Knopf. Wired
// here for the same reason installMcpShutdown is: the listeners belong to
// the page's whole lifetime, not to a component mount.
// Not on a phone, for the same reason as above: `beforeunload` and the tray
// event this listens to do not come there.
if (!mobileHost) installBackgroundShutdown()

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
  // The one way into src/mobile, and the only import of it in the desktop
  // code. It stands before everything else, so App, AppShell and their
  // desktop effects (backend probes, second window, shortcuts) never load on
  // a phone, and the mobile shell never loads on a desktop.
  //
  // The first half of the condition is a constant of the build and has to
  // stand here literally. Only a build that names the phone
  // (VITE_LU_BUILD_TARGET=mobile: the Android and iOS builds, the dev server
  // of `npm run dev:mobile`, the Playwright project `mobile`) keeps the
  // branch. In every other build, and that is every desktop build because
  // none of them sets the variable, it is `false`, the branch is dead, and
  // the bundler leaves the whole mobile shell out of the package. Routed
  // through a named constant from another module the bundler keeps the
  // import (measured). The same variable is the lock in lib/mobile-host.ts.
  if (import.meta.env.VITE_LU_BUILD_TARGET === 'mobile' && mobileHost) {
    const { bootMobile } = await import('./mobile/boot')
    return bootMobile()
  }
  // A developer who asks for the mobile shell on a server that does not carry
  // it gets told why the desktop loads instead.
  if (import.meta.env.DEV && import.meta.env.VITE_LU_BUILD_TARGET !== 'mobile' && new URLSearchParams(window.location.search).get('mobile') === '1') {
    console.warn('[lu] ?mobile=1 needs a server that carries the mobile shell. Start it with: npm run dev:mobile')
  }

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
  // W33: loaded only now. It reaches persisted stores (logger, settings), and
  // nothing of that may load in the main window before the onboarding has
  // handed over (main-laedt-vor-der-uebergabe-keinen-store.test.ts).
  const TextMenu = mobileHost ? null : (await import('./components/ui/TextContextMenu')).TextContextMenu
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
          {/* W33: no web view menu on a right click in a release build, in
              both windows (the onboarding assistant is the first one a new
              user sees). Not on a phone: a long press there is its own. */}
          {TextMenu && <TextMenu />}
        </LucideProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}

// An Android web view below the floor the app is built for shows its own
// notice ("Update Android System WebView", public/webview-check.js, which runs
// before this file). The app does not start under it. Never set on a desktop.
if (!(window as unknown as { __LU_WEBVIEW_TOO_OLD__?: boolean }).__LU_WEBVIEW_TOO_OLD__) {
  void boot().catch((err) => mountFatalError(rootEl, err))
}
