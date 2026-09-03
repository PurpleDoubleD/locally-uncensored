/**
 * Modal-Bedienbarkeit: Anfangsfokus, Fokus-Falle, Escape-Stapel (Audit Welle 2)
 *
 * ui/Modal war optisch ein Dialog, für Tastatur und Screenreader aber keiner:
 * kein Escape, keine Fokus-Falle, keine Rolle. Wer die Maus nicht benutzt, kam
 * aus dem Ding nicht wieder heraus.
 *
 * Die Testumgebung ist `environment: 'node'` — kein DOM, also lässt sich das
 * gerenderte Modal nicht anklicken. Deshalb sind die ENTSCHEIDUNGEN aus dem
 * DOM-Klebstoff herausgezogen (src/components/ui/dialog-a11y.ts) und werden
 * hier als Verhalten geprüft, nicht als Quelltext gepinnt.
 *
 * Run: npx vitest run src/components/ui/__tests__/dialog-a11y.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  backgroundNodesToHide,
  closeDialog,
  dialogStack,
  isDestructive,
  isTopDialog,
  nextFocusIndex,
  openDialog,
  pickInitialFocusIndex,
  resetDialogStack,
  type FocusableLike,
  type TreeNodeLike,
} from '../dialog-a11y'

/** Baut ein Element-Double in der Minimalform, die die Regeln lesen. */
function el(spec: { tag?: string; text?: string; disabled?: boolean } & Record<string, unknown>): FocusableLike {
  const { tag = 'BUTTON', text = '', disabled, ...attrs } = spec
  return {
    tagName: tag,
    textContent: text,
    ...(disabled === undefined ? {} : { disabled }),
    getAttribute: (name: string) => (name in attrs ? String(attrs[name]) : null),
  }
}

const closeX = el({ tag: 'BUTTON', text: '', 'data-dialog-close': '', 'aria-label': 'Close' })

describe('Anfangsfokus — welches Element ist der sinnvolle Startpunkt', () => {
  it('wählt im Löschen-Dialog "Cancel", nicht das X und nicht "Delete"', () => {
    // Die reale Kette aus ModelManager: X, Cancel, Delete.
    const items = [closeX, el({ text: 'Cancel' }), el({ text: 'Delete' })]
    expect(pickInitialFocusIndex(items)).toBe(1)
  })

  it('setzt den Fokus NIE auf einen zerstörenden Knopf, auch wenn er der einzige echte ist', () => {
    const items = [closeX, el({ text: 'Delete model' })]
    // Lieber das X als ein "Löschen" unter dem reflexartigen Enter.
    expect(pickInitialFocusIndex(items)).toBe(0)
  })

  it('erkennt die deutsche Beschriftung genauso', () => {
    const items = [closeX, el({ text: 'Abbrechen' }), el({ text: 'Löschen' })]
    expect(pickInitialFocusIndex(items)).toBe(1)
    expect(isDestructive(el({ text: 'Löschen' }))).toBe(true)
    expect(isDestructive(el({ text: 'Zurücksetzen' }))).toBe(true)
  })

  it('lässt sich per data-destructive korrigieren, wenn die Beschriftung harmlos klingt', () => {
    const items = [closeX, el({ text: 'OK', 'data-destructive': '' }), el({ text: 'Später' })]
    expect(pickInitialFocusIndex(items)).toBe(2)
  })

  it('lässt sich per data-safe entschärfen, wenn die Heuristik danebenliegt', () => {
    // "Reset filters" löscht keine Daten — der Dialog darf dort starten.
    const items = [closeX, el({ text: 'Reset filters', 'data-safe': '' })]
    expect(pickInitialFocusIndex(items)).toBe(1)
  })

  it('gibt data-autofocus den Vorrang vor der Heuristik', () => {
    const items = [closeX, el({ text: 'Cancel' }), el({ text: 'Install', 'data-autofocus': '' })]
    expect(pickInitialFocusIndex(items)).toBe(2)
  })

  it('landet im Eingabefeld, wenn der Dialog eines hat (Pull Model)', () => {
    const items = [closeX, el({ tag: 'INPUT', text: '' }), el({ text: 'Pull' })]
    expect(pickInitialFocusIndex(items)).toBe(1)
  })

  it('überspringt einen Fließtext-Link zugunsten des ersten Bedienelements', () => {
    // VHS-Dialog: erst ein Link auf das GitHub-Repo, dann die Knöpfe. Enter
    // soll den Dialog bedienen, nicht einen Browser aufreißen.
    const items = [
      closeX,
      el({ tag: 'A', href: 'https://github.com/…', text: 'VideoHelperSuite' }),
      el({ text: 'Install VHS_VideoCombine + continue' }),
    ]
    expect(pickInitialFocusIndex(items)).toBe(2)
  })

  it('nimmt den Link doch, wenn es gar kein Bedienelement gibt', () => {
    const items = [closeX, el({ tag: 'A', href: 'https://x', text: 'Mehr erfahren' })]
    expect(pickInitialFocusIndex(items)).toBe(1)
  })

  it('überspringt deaktivierte und ausgeblendete Elemente', () => {
    const items = [
      closeX,
      el({ text: 'Weiter', disabled: true }),
      el({ text: 'Später', hidden: '' }),
      el({ text: 'Jetzt nicht', 'aria-hidden': 'true' }),
      el({ text: 'Fertig' }),
    ]
    expect(pickInitialFocusIndex(items)).toBe(4)
  })

  it('überspringt tabindex="-1" (programmatisch fokussierbar, aber nicht in der Tab-Kette)', () => {
    const items = [closeX, el({ text: 'Panel', tabindex: '-1' }), el({ text: 'Weiter' })]
    expect(pickInitialFocusIndex(items)).toBe(2)
  })

  it('meldet -1, wenn nichts fokussierbar ist — dann bekommt das Panel den Fokus', () => {
    expect(pickInitialFocusIndex([])).toBe(-1)
    expect(pickInitialFocusIndex([el({ text: 'Delete' })])).toBe(-1)
  })
})

describe('Fokus-Falle — Tab läuft im Dialog im Kreis', () => {
  it('Tab geht ein Element weiter', () => {
    expect(nextFocusIndex(4, 1, false)).toBe(2)
  })

  it('Tab am letzten Element springt zurück auf das erste (kein Ausbruch)', () => {
    expect(nextFocusIndex(4, 3, false)).toBe(0)
  })

  it('Shift+Tab am ersten Element springt ans Ende', () => {
    expect(nextFocusIndex(4, 0, true)).toBe(3)
  })

  it('Shift+Tab geht ein Element zurück', () => {
    expect(nextFocusIndex(4, 2, true)).toBe(1)
  })

  it('holt einen ausgebüxten Fokus zurück: Tab vorne herein, Shift+Tab hinten', () => {
    expect(nextFocusIndex(4, -1, false)).toBe(0)
    expect(nextFocusIndex(4, -1, true)).toBe(3)
  })

  it('behandelt einen verschwundenen Fokus (Index außerhalb) wie „außerhalb"', () => {
    expect(nextFocusIndex(3, 99, false)).toBe(0)
    expect(nextFocusIndex(3, 99, true)).toBe(2)
  })

  it('bleibt bei einem einzigen Element auf diesem stehen', () => {
    expect(nextFocusIndex(1, 0, false)).toBe(0)
    expect(nextFocusIndex(1, 0, true)).toBe(0)
  })

  it('meldet -1 für einen Dialog ohne fokussierbaren Inhalt', () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1)
    expect(nextFocusIndex(0, 0, true)).toBe(-1)
  })
})

describe('Escape-Stapel — Escape schließt das oberste Modal, nicht alle', () => {
  beforeEach(resetDialogStack)

  it('ein einzelner Dialog ist der oberste', () => {
    openDialog('a')
    expect(isTopDialog('a')).toBe(true)
  })

  it('bei zwei Dialogen reagiert nur der zuletzt geöffnete', () => {
    openDialog('a')
    openDialog('b')
    expect(isTopDialog('b')).toBe(true)
    expect(isTopDialog('a')).toBe(false)
  })

  it('nach dem Schließen des obersten ist der darunter wieder dran', () => {
    openDialog('a')
    openDialog('b')
    closeDialog('b')
    expect(isTopDialog('a')).toBe(true)
  })

  it('das Schließen eines mittleren Dialogs ändert nichts am obersten', () => {
    openDialog('a')
    openDialog('b')
    openDialog('c')
    closeDialog('b')
    expect(isTopDialog('c')).toBe(true)
    expect(dialogStack()).toEqual(['a', 'c'])
  })

  it('zweimaliges Anmelden derselben ID legt sie nicht doppelt ab (StrictMode)', () => {
    openDialog('a')
    openDialog('a')
    expect(dialogStack()).toEqual(['a'])
    closeDialog('a')
    expect(dialogStack()).toEqual([])
  })

  it('das erneute Anmelden hebt einen Dialog nach oben', () => {
    openDialog('a')
    openDialog('b')
    openDialog('a')
    expect(isTopDialog('a')).toBe(true)
  })

  it('ein unbekanntes Abmelden ist ein No-op', () => {
    openDialog('a')
    closeDialog('unbekannt')
    expect(dialogStack()).toEqual(['a'])
  })

  it('ohne offenen Dialog ist niemand oberster', () => {
    expect(isTopDialog('a')).toBe(false)
  })
})

describe('Hintergrund inert — ohne den Dialog selbst mitzuverstecken', () => {
  interface FakeNode extends TreeNodeLike {
    name: string
    parentElement: FakeNode | null
    children: FakeNode[]
  }

  function node(name: string, children: FakeNode[] = []): FakeNode {
    const n: FakeNode = { name, parentElement: null, children }
    for (const c of children) c.parentElement = n
    return n
  }

  const names = (ns: FakeNode[]) => ns.map((n) => n.name).sort()

  it('sammelt die Geschwister auf dem Weg nach oben ein, aber keinen Vorfahren', () => {
    const dialog = node('dialog')
    const sidebar = node('sidebar')
    const main = node('main', [node('chat'), dialog])
    const root = node('root', [sidebar, main])
    const body = node('body', [root, node('portal-root')])

    const hidden = backgroundNodesToHide(dialog, body)

    expect(names(hidden)).toEqual(['chat', 'portal-root', 'sidebar'])
    // Der Dialog selbst und seine Vorfahren dürfen NIE dabei sein — genau der
    // Fehler, den `aria-hidden` auf #root produziert.
    for (const forbidden of ['dialog', 'main', 'root', 'body']) {
      expect(names(hidden)).not.toContain(forbidden)
    }
  })

  it('hört bei stopAt auf und fasst dessen Vorfahren nicht mehr an', () => {
    const dialog = node('dialog')
    const root = node('root', [node('sidebar'), dialog])
    const body = node('body', [root, node('script')])
    node('html', [node('head'), body])

    const hidden = backgroundNodesToHide(dialog, root)

    expect(names(hidden)).toEqual(['sidebar'])
    expect(names(hidden)).not.toContain('script')
    expect(names(hidden)).not.toContain('head')
  })

  it('kommt mit einem Dialog direkt unter stopAt zurecht', () => {
    const dialog = node('dialog')
    const body = node('body', [node('root'), dialog])

    expect(names(backgroundNodesToHide(dialog, body))).toEqual(['root'])
  })

  it('liefert nichts, wenn der Dialog gar nicht eingehängt ist', () => {
    expect(backgroundNodesToHide(node('dialog'), null)).toEqual([])
  })
})
