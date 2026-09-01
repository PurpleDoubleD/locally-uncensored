/**
 * M7 / Audit W-T2 — Suspense-Fallbacks für die lazy geladenen Top-Level-Views,
 * und seit Welle 3 auch die vier LISTEN-Ladezustände (unterer Teil der Datei).
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

/**
 * Dasselbe für die LISTEN-Skelette weiter unten, nur ohne `h-full`: ein
 * View-Fallback ersetzt eine Fläche und muss sie ausfüllen, ein Listen-
 * Skelett ersetzt eine Liste und darf genau so hoch sein wie die Zeilen,
 * die es ankündigt. `h-full` in einer Flex-Spalte würde es strecken und
 * damit denselben Sprung erzeugen, den es verhindern soll.
 */
function ListShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="animate-pulse">
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
      <div className="relative h-full w-full flex flex-col bg-white dark:bg-lu-canvas overflow-hidden">
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

/* ═══════════════════════════════════════════════════════════════════════
   Die vier LISTEN-Ladezustände (Audit Welle 3: „Skeletons für die vier
   Listen-Ladezustände").

   Was an den vier Stellen stand, war dreimal ein Satz mittig im Nichts
   („Loading models…", „Searching CivitAI…", „Scanning…") und einmal gar
   nichts — der Modellwähler zeigte während des ersten Ladens „No models
   available", also eine FALSCHE Aussage statt einer Ladeanzeige.

   Sie folgen derselben Regel wie die View-Fallbacks oben: die Geometrie der
   Liste, die gleich kommt, nicht ein Kringel in der Mitte. Ein Satz in der
   Mitte lässt den Container auf Textzeilenhöhe zusammenfallen und schiebt
   beim Eintreffen der echten Liste alles darunter weg; ein Skelett in der
   Zeilen-/Kachelgeometrie hält den Platz und der Sprung entfällt.

   Die Zeilenzahlen sind bewusst klein (3–6): ein Skelett soll die Form
   ankündigen, nicht eine Menge behaupten, die dann nicht kommt.

   Die Bewegung kommt aus `animate-pulse` — genau wie oben, und genau
   deshalb: die Regel für „Bewegung reduzieren" in index.css setzt für ALLE
   Animationen `animation-iteration-count: 1`, weil eine auf 120 ms gekürzte
   Endlosschleife sonst mit acht Durchläufen pro Sekunde stroboskopiert. Für
   `.animate-spin` und `.animate-pulse` steht dort die ausdrückliche
   Gegenausnahme (3 s, weiterlaufend), weil ein eingefrorenes Skelett die
   Falschaussage „fertig, aber leer" macht. Ein EIGENES Shimmer-Keyframe
   hier würde diese Ausnahme nicht erben und unter „Bewegung reduzieren"
   nach einem Durchlauf stehenbleiben — deshalb keins.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Geometrie des Modell-Rasters in DiscoverModels: `grid-cols-1 /
 * md:2 / xl:3`, `gap-2.5`, Kachel `rounded-xl border p-3` mit Titelzeile,
 * zwei Blurb-Zeilen und der Fußzeile aus Größen-Pill, Fit-Hinweis und
 * Get-Knopf. Sechs Kacheln, damit bei jeder Spaltenzahl mindestens zwei
 * volle Reihen stehen.
 */
export function ModelGridSkeleton() {
  return (
    <ListShell label="Loading models">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-gray-200 dark:border-white/[0.06] bg-gray-50 dark:bg-white/[0.03] p-3"
          >
            <div className="flex items-start gap-2.5">
              <div className="flex-1 min-w-0 space-y-1.5">
                <Bar className="w-1/2 h-3" />
                <Bar className="w-full h-2" />
                <Bar className="w-4/5 h-2" />
              </div>
              <Bar className="w-4 h-4 shrink-0 rounded-md" />
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <Bar className="w-20 h-4 rounded-md" />
              <Bar className="w-14 h-3" />
              <Bar className="ml-auto w-14 h-5 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </ListShell>
  )
}

/**
 * Geometrie der CivitAI-Trefferliste: `space-y-2`, Zeile aus 56px-Thumbnail,
 * Name/Beschreibung und zwei Aktions-Icons rechts. Drei Zeilen — die Liste
 * ist scrollbegrenzt (`max-h-[50vh]`) und beginnt fast immer kurz.
 */
export function CivitaiResultsSkeleton() {
  return (
    <ListShell label="Searching CivitAI">
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex gap-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10"
          >
            <Bar className="w-14 h-14 rounded-lg shrink-0" />
            <div className="flex-1 min-w-0 space-y-1.5">
              <Bar className="w-2/5 h-3" />
              <Bar className="w-4/5 h-2" />
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Bar className="w-7 h-7 rounded-lg" />
              <Bar className="w-7 h-7 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </ListShell>
  )
}

/**
 * Geometrie der Modellwähler-Liste: Zeile aus Typpunkt, Name und Meta-Badge,
 * `px-2.5 py-[5px] mx-1`. Fünf Zeilen; die Liste ist auf 280px gedeckelt und
 * zeigt selten weniger.
 *
 * Das ist der einzige der vier Zustände, den es vorher GAR NICHT gab: der
 * Wähler ging direkt von „leer" auf „Liste", und weil leer als „No models
 * available" gerendert wird, behauptete das offene Dropdown während des
 * ersten Ladens eine Maschine ohne Modelle. Ein Skelett behauptet nichts.
 */
export function ModelPickerSkeleton() {
  return (
    <ListShell label="Loading model list">
      <div className="py-1">
        {[58, 51, 44, 37, 30].map((w, i) => (
          <div key={i} className="flex items-center gap-2 px-2.5 py-[5px] mx-1">
            <Bar className="w-1 h-1 rounded-full shrink-0" />
            <div style={{ width: `${w}%` }}><Bar className="h-2.5" /></div>
          </div>
        ))}
      </div>
    </ListShell>
  )
}

/**
 * Geometrie der Import-Kandidatenliste in den Einstellungen: `space-y-1`,
 * Zeile aus Dateiname (mono, dehnt sich), Quelle, Größe und Import-Knopf.
 * Drei Zeilen — der Scan findet auf den meisten Rechnern eine Handvoll.
 */
export function ImportScanSkeleton() {
  return (
    <ListShell label="Scanning for local models">
      <div className="space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Bar className="flex-1 h-2.5" />
            <Bar className="w-10 h-2" />
            <Bar className="w-12 h-2" />
            <Bar className="w-12 h-4 rounded-md" />
          </div>
        ))}
      </div>
    </ListShell>
  )
}
