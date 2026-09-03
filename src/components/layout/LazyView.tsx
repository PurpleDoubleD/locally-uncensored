import { Suspense, lazy, useCallback, useState, type ComponentType, type ReactNode } from 'react'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { log } from '../../lib/logger'

/**
 * M7 / Audit W-T2 — Lazy-Grenze für die Top-Level-Views.
 *
 * Warum nicht einfach `lazy()` + `<Suspense>` direkt in AppShell:
 *
 *  1. **Ladefehler.** `React.lazy` merkt sich das Ergebnis der Factory — auch
 *     eine Ablehnung. Ein Chunk, dessen `import()` einmal gescheitert ist
 *     (Offline beim Web-Build, halb geschriebener Cache, abgebrochenes
 *     Update), bliebe für den Rest der Sitzung kaputt. Ohne Fehlergrenze
 *     propagiert der Fehler bis nach oben und die App kippt in die
 *     Root-Recovery — also faktisch weißer Bildschirm für einen Klick auf
 *     „Settings". Deshalb liegt die `<Suspense>`-Grenze *innerhalb* einer
 *     `<ErrorBoundary>`: die fängt den Reject und zeigt die Inline-Karte.
 *
 *  2. **Retry, der wirklich etwas tut.** Der Retry-Knopf der ErrorBoundary
 *     setzt nur ihren eigenen State zurück; die abgelehnte lazy-Payload wäre
 *     immer noch da und würde sofort wieder werfen. `attempt` erzeugt darum
 *     eine frische lazy-Komponente, deren Factory neu geladen wird.
 *
 *  3. **Erster Versuch mit einem Nachschlag.** Ein einzelner verlorener
 *     Chunk-Request ist der häufigste Fall. Die Factory versucht es genau
 *     einmal automatisch nach 300 ms erneut, bevor sie den Fehler an React
 *     durchreicht. Mehr Automatik wäre Rauschen — dann ist der Chunk wirklich
 *     weg und der Nutzer soll es sehen.
 *
 * Bekannte Grenze, ehrlich benannt: Browser cachen einen gescheiterten
 * Modul-Fetch in der Modul-Map. Ein *dauerhaft* kaputter Chunk lässt sich
 * darum weder durch den automatischen Nachschlag noch durch Retry heilen —
 * dafür ist der „Reload"-Weg der Root-Boundary bzw. ein Neustart zuständig.
 * Der Gewinn hier ist, dass die App dabei bedienbar bleibt statt zu erblinden.
 */

type Loader = () => Promise<{ default: ComponentType }>

function withOneRetry(load: Loader): Loader {
  return () =>
    load().catch((err: unknown) => {
      log.warn('LazyView: Chunk-Import fehlgeschlagen, ein Nachschlag', { error: err })
      return new Promise<{ default: ComponentType }>((resolve, reject) => {
        setTimeout(() => { load().then(resolve, reject) }, 300)
      })
    })
}

interface Props {
  /**
   * Muss modul-stabil sein (ein `const` auf Modulebene), sonst wirft jeder
   * Render eine neue lazy-Komponente weg und der View re-mountet endlos.
   */
  load: Loader
  /** Skelett in der Geometrie des Views — nie `null`, nie „Loading…". */
  fallback: ReactNode
}

export function LazyView({ load, fallback }: Props) {
  // Die lazy-Komponente liegt im State, nicht in einem useMemo: der Retry muss
  // eine *frische* Payload erzeugen, und „neu erzeugen" ist ein Zustands-
  // wechsel, keine abgeleitete Rechnung.
  const [View, setView] = useState<ComponentType>(() => lazy(withOneRetry(load)))
  const retry = useCallback(() => { setView(() => lazy(withOneRetry(load))) }, [load])

  return (
    <ErrorBoundary onRetry={retry}>
      <Suspense fallback={fallback}>
        <View />
      </Suspense>
    </ErrorBoundary>
  )
}
