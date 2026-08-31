/**
 * M7 / Audit W-T2 — Suspense-Fallbacks für die lazy geladenen Top-Level-Views.
 *
 * Regel dieser Datei: jeder Fallback trägt die *Geometrie* seines Views. Ein
 * `null`-Fallback lässt `<main>` auf 0 px zusammenfallen und der ganze Rahmen
 * springt; ein nacktes „Loading…" mittig im Nichts erzeugt denselben Sprung,
 * nur mit Text. Also: gleiche Container-Klassen wie der echte View, gleiche
 * Kopfzeile, gleiche Spalten — nur die Inhalte sind graue Balken.
 *
 * Die Balken sind bewusst keine Attrappen von echten Daten: sie tragen keine
 * Zahlen, keine Namen, keine Zustände. Sie behaupten nichts, sie halten Platz.
 *
 * `aria-busy` + `role="status"` mit einem sr-only-Text, damit die Ladepause
 * für Screenreader nicht stumm bleibt.
 */

function Bar({ className = '' }: { className?: string }) {
  return <div className={`rounded bg-gray-200/70 dark:bg-white/[0.06] ${className}`} />
}

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="h-full animate-pulse">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/** Geometrie von SettingsPage: h-full scroll → max-w-lg, Kopf + Tab-Leiste. */
export function SettingsSkeleton() {
  return (
    <Shell label="Loading settings">
      <div className="h-full overflow-hidden">
        <div className="max-w-lg mx-auto px-4 py-4">
          <div className="flex items-center gap-2 mb-4">
            <Bar className="w-6 h-6 rounded" />
            <Bar className="w-16 h-3" />
          </div>
          <div className="flex items-center gap-1 pb-2 mb-2 border-b border-gray-100 dark:border-white/[0.06]">
            {[64, 58, 72, 54, 66].map((w, i) => (
              <div key={i} className="shrink-0" style={{ width: w }}>
                <Bar className="h-6 rounded-md" />
              </div>
            ))}
          </div>
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-lg border border-gray-200 dark:border-white/[0.06] p-3 space-y-2.5">
                <Bar className="w-24 h-2.5" />
                <Bar className="w-full h-2" />
                <Bar className="w-4/5 h-2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  )
}

/** Geometrie von ModelManager: h-full flex → schmale Kategorie-Schiene + Raster. */
export function ModelManagerSkeleton() {
  return (
    <Shell label="Loading models">
      <div className="h-full flex overflow-hidden">
        <aside className="shrink-0 w-12 lg:w-36 border-r border-gray-200 dark:border-white/[0.06] bg-gray-50/60 dark:bg-white/[0.015] flex flex-col py-3 px-1.5 lg:px-2 gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-2">
              <Bar className="w-[15px] h-[15px] shrink-0" />
              <Bar className="hidden lg:block flex-1 h-2.5" />
            </div>
          ))}
        </aside>
        <div className="flex-1 overflow-hidden px-4 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <Bar className="w-40 h-6 rounded-lg" />
            <Bar className="ml-auto w-24 h-6 rounded-lg" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="rounded-xl border border-gray-200 dark:border-white/[0.06] p-3 space-y-2.5">
                <Bar className="w-3/5 h-3" />
                <Bar className="w-full h-2" />
                <Bar className="w-1/3 h-2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  )
}

/** Geometrie von BenchmarkView: h-full scroll → max-w-2xl, Kopfzeile + Tabelle. */
export function BenchmarkSkeleton() {
  return (
    <Shell label="Loading benchmark">
      <div className="h-full overflow-hidden">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center gap-2 mb-4">
            <Bar className="w-6 h-6" />
            <Bar className="w-4 h-4" />
            <Bar className="w-20 h-3" />
            <Bar className="ml-auto w-20 h-5 rounded-md" />
          </div>
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/[0.06] px-3 py-2.5">
                <Bar className="w-1/3 h-2.5" />
                <Bar className="w-16 h-2.5 ml-auto" />
                <Bar className="w-16 h-2.5" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  )
}

/**
 * Geometrie von CreateExperimental: Spalte aus IntentBar (oben), Bühne
 * (dehnt sich) und Composer (unten).
 */
export function CreateSkeleton() {
  return (
    <Shell label="Loading create">
      <div className="relative h-full w-full flex flex-col bg-white dark:bg-[#141414] overflow-hidden">
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 dark:border-white/[0.06]">
          {[56, 56, 56, 56].map((w, i) => (
            <div key={i} style={{ width: w }}><Bar className="h-6 rounded-md" /></div>
          ))}
        </div>
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <Bar className="w-full max-w-xl h-full max-h-[60%] rounded-xl" />
        </div>
        <div className="shrink-0 px-4 pb-4">
          <Bar className="w-full h-16 rounded-xl" />
        </div>
      </div>
    </Shell>
  )
}

/**
 * Geometrie von Onboarding: Vollbild, zentrierte schmale Karte, Schritt-Punkte
 * oben. Anders als die vier Views oben füllt dieser Fallback den ganzen
 * Bildschirm, weil Onboarding das auch tut (es rendert *vor* dem App-Rahmen).
 * Der Hintergrundton ist der von index.html (#161616) — so bleibt der Übergang
 * vom HTML-Splash zum ersten React-Frame farblich nahtlos.
 */
export function OnboardingSkeleton() {
  return (
    <Shell label="Loading setup">
      <div className="h-screen w-screen flex items-center justify-center p-4 bg-[#161616]">
        <div className="fixed top-10 left-1/2 -translate-x-1/2 flex gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="w-1.5 h-1.5 rounded-full bg-white/15" />
          ))}
        </div>
        <div className="max-w-sm w-full space-y-4 flex flex-col items-center">
          <Bar className="w-40 h-3.5" />
          <Bar className="w-full h-2" />
          <Bar className="w-5/6 h-2" />
          <Bar className="w-28 h-7 rounded-lg mt-2" />
        </div>
      </div>
    </Shell>
  )
}
