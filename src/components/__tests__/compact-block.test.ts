/**
 * Die Verdichtungslinie und die Ebenen (3.0.9).
 *
 * Bis 3.0.8 stand hier der Waechter „eine Verdichtung blendet nichts aus":
 * MessageList durfte genau zwei Filter haben, und keiner durfte eine
 * Verdichtung lesen. Davids Wunsch vom 27.10. aendert die Regel bewusst: die
 * aktuelle Ansicht beginnt an der neuesten Verdichtung, wie in der Claude-
 * Code-Desktop-App, und jede fruehere liegt eine Ebene tiefer. Was der alte
 * Waechter eigentlich schuetzte, bleibt und steht jetzt schaerfer da: KEINE
 * Nachricht geht verloren. Jede gespeicherte Nachricht steht in mindestens
 * einer Ebene (lib/__tests__/compact-layers.test.ts rechnet das nach), und
 * beide Verlaufsflaechen zeigen die Ebenen-Leiste, ueber die man hinkommt.
 *
 * `CompactBlock` nimmt nur eine Prop und keinen Store, also laeuft er hier
 * ECHT durch `renderToStaticMarkup`. `MessageList` und `CodexView` lassen sich
 * so nicht rendern (Store-Snapshot, speechSynthesis, framer-motion; gemessen
 * am 02.09.2026), darum sind sie am Quelltext gesichert.
 *
 * Die Datei heisst `.test.ts`: `vitest.config.ts` sammelt nur `.test.ts`.
 *
 * Run: npx vitest run src/components/__tests__/compact-block.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolve } from 'node:path'
import { quelldateien, quelltext } from './quelldateien'
import { CompactBlock } from '../chat/CompactBlock'
import { renderCompactSummary, EMPTY_SUMMARY } from '../../lib/compact-summary'
import type { CompactCut } from '../../lib/compact-layers'

const SRC = resolve(__dirname, '..', '..')
const DATEIEN = quelldateien(resolve(SRC, 'components'), { endungen: /\.tsx$/, relativZu: SRC })

/** Eine Zusammenfassung, wie sie wirklich im Datensatz steht. MARKE ist das
 *  Wort, das zugeklappt nirgends auftauchen darf. */
const ZUSAMMENFASSUNG = renderCompactSummary({
  ...EMPTY_SUMMARY,
  task: 'MARKE-TASK: den Audit-Build abnehmen',
  progress: 'MARKE-PROGRESS: zwei Dateien gelesen',
})

const schnitt = (over: Partial<CompactCut> = {}): CompactCut => ({
  key: 'c1',
  before: 29_594,
  after: 18_330,
  trigger: 'auto',
  at: 1_756_000_000_000,
  summary: ZUSAMMENFASSUNG,
  start: { msg: 3, block: 0 },
  end: { msg: 9, block: 0 },
  ...over,
})

const rendern = (cut?: CompactCut): string => renderToStaticMarkup(createElement(CompactBlock, { cut }))

describe('Eine Zeile wie ein Werkzeugaufruf', () => {
  it('waehrend des Laufs: "Compacting conversation…" mit dem Schimmer eines laufenden Werkzeugs', () => {
    const html = rendern()
    expect(html).toContain('Compacting conversation…')
    expect(html).toContain('lu-tool-shimmer')
    expect(html).toContain('data-testid="compact-running"')
  })

  it('danach: "Compacted, 28.9K → 17.9K", in den Einheiten des Zaehlers', () => {
    // Davids Zahlen aus dem REA-Test: 28,9K von 32K, danach 17,9K. Der
    // Zaehler rechnet in 1024er-K (formatContextWindow), die Zeile auch, sonst
    // stuenden zwei verschiedene Zahlen fuer denselben Stand nebeneinander.
    const html = rendern(schnitt())
    expect(html).toContain('Compacted, 28.9K → 17.9K')
    expect(html).not.toContain('lu-tool-shimmer')
  })

  it('kein Logo, kein Kasten: ein Symbol in Werkzeuggroesse und Text', () => {
    const html = rendern(schnitt())
    expect(html.match(/<svg/g)?.length ?? 0).toBeLessThanOrEqual(2)
    expect(html).not.toContain('rounded-full border')
  })

  it('/compact und automatisch sehen gleich aus: der Befehl steht schon als Hinweis im Verlauf', () => {
    expect(rendern(schnitt({ trigger: 'manual' }))).toBe(rendern(schnitt({ trigger: 'auto' })))
  })

  it('eine kaputte Zahl wird zu 0, nicht zu einem Minus', () => {
    expect(rendern(schnitt({ after: -50 }))).toContain('→ 0')
  })
})

describe('Zugeklappt ist die Voreinstellung', () => {
  it('die Zusammenfassung steht nicht im ersten Rendern', () => {
    expect(ZUSAMMENFASSUNG).toContain('MARKE-TASK')
    const html = rendern(schnitt())
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('MARKE-TASK')
    expect(html).not.toContain('MARKE-PROGRESS')
  })

  it('ohne gespeicherte Zusammenfassung (Mitten im Lauf) gibt es nichts aufzuklappen', () => {
    const html = rendern(schnitt({ summary: undefined }))
    expect(html).not.toContain('aria-expanded')
    expect(html).toContain('Compacted, 28.9K → 17.9K')
  })
})

describe('Jede Verlaufsflaeche zeigt Linie und Ebenen', () => {
  /** Eine Verlaufsflaeche haengt am Rollanker und zeigt den Laufanker. Beides
   *  haben heute genau MessageList (Chat, Agent) und CodexView (Code). */
  const verlaeufe = DATEIEN
    .filter(([, inhalt]) => inhalt.includes('useAutoScroll(') && inhalt.includes('<WorkingAnchor'))
    .map(([name]) => name)

  it('beide bekannten Flaechen werden gefunden', () => {
    expect(verlaeufe).toContain('components/chat/MessageList.tsx')
    expect(verlaeufe).toContain('components/chat/CodexView.tsx')
  })

  it('jede rendert ihre Ansicht aus den Ebenen, mit Leiste, Hinweis und laufender Zeile', () => {
    for (const name of verlaeufe) {
      const src = quelltext(DATEIEN, name)
      expect(src, `${name}: Ebenen`).toContain('useCompactLayers(')
      expect(src, `${name}: Leiste`).toContain('<CompactLayerRail view={layers} />')
      expect(src, `${name}: Hinweis oben`).toContain('<CompactLayerBanner view={layers} />')
      expect(src, `${name}: Linie`).toContain("if (item.kind === 'line') return <CompactBlock key={item.cut.key} cut={item.cut} />")
      expect(src, `${name}: laufende Zeile`).toContain('{!readOnly && layers.compacting && <CompactBlock />}')
    }
  })

  it('eine fruehere Ebene ist nur lesbar', () => {
    const liste = quelltext(DATEIEN, 'components/chat/MessageList.tsx')
    expect(liste).toContain('onEdit={!readOnly &&')
    expect(liste).toContain('onRegenerate={!readOnly &&')
    expect(liste).toContain('onBranch={readOnly ? undefined : handleBranch}')
    expect(liste).toContain('pendingApprovalId={readOnly ? null : pendingApprovalId}')
    const code = quelltext(DATEIEN, 'components/chat/CodexView.tsx')
    expect(code).toContain('{!readOnly && <CodexConfirmDialog />}')
    expect(code).toContain('const liveId = readOnly ? undefined : lastMessage?.id')
  })
})
