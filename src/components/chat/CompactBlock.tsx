import { useState } from 'react'
import { ChevronDown, FoldVertical } from 'lucide-react'
import { summarySections } from '../../lib/compact-summary'
import type { CompactionRecord } from '../../types/chat'

/**
 * Tausender kurz: 18240 → "18.2k". Unter 1000 bleibt die Zahl ganz, denn
 * "0.4k" ist keine Verbesserung gegenueber "412" — es ist dieselbe Laenge mit
 * weniger Information.
 */
function short(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  return `${(n / 1000).toFixed(1)}k`
}

interface Props {
  record: CompactionRecord
}

/**
 * Die Schnittstelle einer Verdichtung, sichtbar im Verlauf.
 *
 * WAS HIER NICHT PASSIERT — und warum das die eigentliche Entscheidung ist:
 * dieser Block LOESCHT NICHTS und VERSTECKT NICHTS. Die Nachrichten oberhalb
 * bleiben stehen, vollstaendig, scrollbar, kopierbar. Verdichtet wird allein
 * die Nutzlast an das Modell.
 *
 * Der naheliegende Entwurf waere gewesen, die ersetzten Turns einzuklappen —
 * er sieht aufgeraeumter aus und ist falsch. Der Nutzer hat diese Turns
 * geschrieben und gelesen; sie wegzuraeumen, weil ein Fenster voll wurde,
 * verwechselt das Gedaechtnis des Modells mit dem des Menschen. Der Verlauf
 * ist das Protokoll, nicht der Puffer. Sichtbar wird darum nur die LINIE: ab
 * hier sieht das Modell die Zusammenfassung statt der Turns darueber.
 *
 * Zugeklappt ist die Voreinstellung, weil die Zusammenfassung fuer das Modell
 * geschrieben ist und nicht fuer den Leser — sie steht bereit, wenn jemand
 * wissen will, WAS behalten wurde, und draengt sich sonst nicht auf. Genau
 * das ist auch die Frage, die nach einer Verdichtung wirklich aufkommt: nicht
 * "ist etwas passiert" (das sagt die Linie), sondern "was hat es sich
 * gemerkt".
 */
export function CompactBlock({ record }: Props) {
  const [open, setOpen] = useState(false)
  const sections = summarySections(record.summary)

  const saved = record.tokensBefore - record.tokensAfter
  const label = `${record.replaced} ${record.replaced === 1 ? 'message' : 'messages'} summarised`

  return (
    <div className="my-3">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex items-center gap-2 w-full text-left"
      >
        <span className="h-px flex-1 bg-gray-200 dark:bg-white/10" />
        <span className="flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded-full border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] group-hover:border-gray-300 dark:group-hover:border-white/20 transition-colors">
          <FoldVertical size={10} className="text-gray-400 dark:text-gray-500 shrink-0" />
          <span className="t-micro text-gray-500 dark:text-gray-400">{label}</span>
          {saved > 0 && (
            <span className="t-mono text-gray-400 dark:text-gray-600">
              {short(record.tokensBefore)} → {short(record.tokensAfter)}
            </span>
          )}
          {record.trigger === 'auto' && (
            <span className="t-micro text-gray-400 dark:text-gray-600">auto</span>
          )}
          <ChevronDown
            size={10}
            className={`text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
        <span className="h-px flex-1 bg-gray-200 dark:bg-white/10" />
      </button>

      {open && (
        <div className="mt-2 rounded border border-gray-200 dark:border-white/10 bg-gray-50/50 dark:bg-white/[0.02] px-3 py-2">
          {sections.length ? (
            <div className="space-y-2">
              {sections.map((s) => (
                <div key={s.heading}>
                  <div className="t-label text-gray-400 dark:text-gray-600">{s.heading}</div>
                  {/* whitespace-pre-wrap: die Zusammenfassung ist Klartext mit
                      eigenen Zeilen und Aufzaehlungen. Sie durch den
                      Markdown-Renderer zu schicken waere falsch — sie kommt
                      aus einem Modell, das gerade NICHT auf Format geprueft
                      wurde, und ein halboffener Codeblock darin wuerde den
                      Rest des Verlaufs mitreissen. */}
                  <div className="t-micro whitespace-pre-wrap text-gray-600 dark:text-gray-300 leading-relaxed">
                    {s.body}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="t-micro text-gray-400 dark:text-gray-600">
              This summary could not be read back.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
