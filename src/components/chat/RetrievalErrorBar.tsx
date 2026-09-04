/**
 * "Your documents were not searched for that message."
 *
 * Review S4: retrieval failures were logged and nothing else. The user kept a
 * green Docs badge, got an answer, and had no way to know the answer had never
 * seen the PDF. This is the composer-side half of the statement; the RAG panel
 * carries the same sentence for whoever has it open.
 *
 * Ton `fehler`: die Antwort daneben ist ohne die Dokumente entstanden, da muss
 * jemand hinsehen. Die Zeile war vorher ein gelber Kasten mit Fuellung, Rahmen
 * und eigenem Kreuz, also die Bauform einer Warnung ohne deren Farbe. Jetzt
 * traegt die Farbe die Dringlichkeit und `<Hinweis>` die Form, das Kreuz
 * inbegriffen. Begruendung in `lib/hinweis.ts`.
 */
import { AlertTriangle } from 'lucide-react'
import { Hinweis } from '../ui/Hinweis'
import { useRAGStore } from '../../stores/ragStore'

export function RetrievalErrorBar() {
  const message = useRAGStore((s) => s.retrievalError)
  if (!message) return null
  return (
    <div data-testid="retrieval-error-bar" className="mx-3 mb-1.5">
      <Hinweis
        ton="fehler"
        icon={<AlertTriangle size={11} className="shrink-0 mt-0.5" />}
        onDismiss={() => useRAGStore.getState().setRetrievalError(null)}
      >
        {message}
      </Hinweis>
    </div>
  )
}
