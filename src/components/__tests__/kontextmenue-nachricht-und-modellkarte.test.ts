/**
 * Kontextmenüs auf Nachricht und Modellkarte — Audit Welle 3, Achse 11.
 *
 * Die Regel, um die es geht, ist nicht „es gibt ein Menü", sondern: ein Menü,
 * das dieselbe Aktion anbietet wie ein sichtbarer Knopf, muss sie über
 * DENSELBEN Code auslösen. Zwei Aufrufwege zur selben Aktion sind der Anfang
 * des Musters, an dem dieses Projekt schon mehrfach gelitten hat.
 *
 * Prüfbar gemacht ist das über die Bauform: `buildMessageMenu` und
 * `buildModelCardMenu` bekommen die Handler herein und reichen sie
 * unverändert als `run` weiter — der Identitätsvergleich unten kann also
 * scheitern, sobald jemand im Menü etwas nachbaut. Dazu kommt die Gegenprobe
 * an der Quelle: die sichtbare Leiste liest aus demselben `actions`-Objekt,
 * das ins Menü geht.
 *
 * Was hier NICHT geprüft werden kann: das gerenderte Menü. `environment:
 * 'node'`, kein Dokument, kein Rechtsklick. Escape, Pfeiltasten und
 * Fokusrückgabe von `ui/ContextMenu` sind unten nur als Quelltext belegt;
 * die Rechnung dahinter (`nextFocusIndex`, Dialog-Stapel) hat eigene Tests
 * in `ui/__tests__`.
 *
 * Run: npx vitest run src/components/__tests__/kontextmenue-nachricht-und-modellkarte.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildMessageMenu,
  buildModelCardMenu,
  clampMenuPosition,
  type MenuAction,
  type MessageMenuHandlers,
  type ModelMenuHandlers,
} from '../ui/menu-actions'

const SRC = resolve(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

const byId = (items: readonly MenuAction[], id: string) => items.find(i => i.id === id)

function messageHandlers(over: Partial<MessageMenuHandlers> = {}): MessageMenuHandlers {
  return { copy: vi.fn(), edit: vi.fn(), regenerate: vi.fn(), remove: vi.fn(), ...over }
}

describe('Nachricht: das Menü ruft die Funktionen der Aktionsleiste', () => {
  const state = { copied: false, confirmDelete: false }

  it('jede Aktion ist identisch mit dem Handler des Knopfes', () => {
    const h = messageHandlers()
    const items = buildMessageMenu(h, state)
    expect(byId(items, 'copy')?.run).toBe(h.copy)
    expect(byId(items, 'edit')?.run).toBe(h.edit)
    expect(byId(items, 'regenerate')?.run).toBe(h.regenerate)
    expect(byId(items, 'delete')?.run).toBe(h.remove)
  })

  it('das Menü bietet nichts an, was die Leiste nicht auch zeigt', () => {
    // Eigene Nachricht: kein Regenerate. Genau wie in der Leiste.
    const noRegen = buildMessageMenu(messageHandlers({ regenerate: null }), state)
    expect(byId(noRegen, 'regenerate')).toBeUndefined()
    // Antwort, die (noch) nicht bearbeitbar ist: kein Edit.
    const noEdit = buildMessageMenu(messageHandlers({ edit: null }), state)
    expect(byId(noEdit, 'edit')).toBeUndefined()
    // Kopieren und Löschen kann man immer.
    expect(byId(noEdit, 'copy')).toBeDefined()
    expect(byId(noEdit, 'delete')).toBeDefined()
  })

  it('Löschen ist als zerstörend markiert — nichts anderes ist es', () => {
    const items = buildMessageMenu(messageHandlers(), state)
    expect(byId(items, 'delete')?.destructive).toBe(true)
    for (const item of items) {
      if (item.id !== 'delete') expect(item.destructive).toBeFalsy()
    }
  })

  it('die Beschriftung sagt dasselbe wie der Knopf, auch im Zwischenzustand', () => {
    // Der Löschknopf ist zweistufig (D#81): der erste Klick schärft nur.
    const armed = buildMessageMenu(messageHandlers(), { copied: false, confirmDelete: true })
    expect(byId(armed, 'delete')?.label).toBe('Click again to delete')
    const copied = buildMessageMenu(messageHandlers(), { copied: true, confirmDelete: false })
    expect(byId(copied, 'copy')?.label).toBe('Copied')
  })
})

describe('Modellkarte: das Menü ruft die Prop-Handler der Karte', () => {
  const handlers = (): ModelMenuHandlers => ({ select: vi.fn(), info: vi.fn(), remove: vi.fn() })

  it('Details und Löschen sind identisch mit onInfo/onDelete', () => {
    const h = handlers()
    const items = buildModelCardMenu(h, { isActive: false, canDelete: true })
    expect(byId(items, 'info')?.run).toBe(h.info)
    expect(byId(items, 'delete')?.run).toBe(h.remove)
    expect(byId(items, 'select')?.run).toBe(h.select)
  })

  it('nicht löschbare Modelle bekommen keinen Löschen-Eintrag', () => {
    // Die Karte blendet den Knopf über `canDelete` aus; ein Menü, das ihn
    // trotzdem zeigte, böte eine Aktion an, die es nicht gibt.
    const items = buildModelCardMenu(handlers(), { isActive: false, canDelete: false })
    expect(byId(items, 'delete')).toBeUndefined()
  })

  it('auf der aktiven Karte fehlt „Use this model" — es täte nichts', () => {
    const items = buildModelCardMenu(handlers(), { isActive: true, canDelete: true })
    expect(byId(items, 'select')).toBeUndefined()
    expect(byId(items, 'info')).toBeDefined()
  })
})

describe('Platzierung: das Menü bleibt im Fenster', () => {
  const box = { width: 160, height: 120 }
  const vp = { width: 1000, height: 800 }

  it('normalerweise genau am Zeiger', () => {
    expect(clampMenuPosition(300, 200, box, vp)).toEqual({ left: 300, top: 200 })
  })

  it('am rechten/unteren Rand kippt es vor den Zeiger statt hinauszuragen', () => {
    expect(clampMenuPosition(980, 780, box, vp)).toEqual({ left: 820, top: 660 })
  })

  it('und rutscht nie ins Negative — der Fehler der Sidebar-Fassung', () => {
    // `Math.min(x, innerWidth - 160)` ohne untere Schranke ergibt in einem
    // schmalen Fenster ein negatives `left`, und das Menü hängt links raus.
    const narrow = { width: 120, height: 100 }
    const p = clampMenuPosition(10, 10, box, narrow)
    expect(p.left).toBeGreaterThanOrEqual(0)
    expect(p.top).toBeGreaterThanOrEqual(0)
  })

  it('auch wenn das Menü größer ist als das Fenster', () => {
    const p = clampMenuPosition(50, 50, { width: 400, height: 400 }, { width: 200, height: 200 })
    expect(p.left).toBeGreaterThanOrEqual(0)
    expect(p.top).toBeGreaterThanOrEqual(0)
  })
})

describe('ein Menü, ein Aufrufweg — Gegenprobe an der Quelle', () => {
  it('MessageBubble: Leiste und Menü lesen aus DEMSELBEN actions-Objekt', () => {
    const src = read('components', 'chat', 'MessageBubble.tsx')
    expect(src).toContain('const actions: MessageMenuHandlers = {')
    expect(src).toContain('buildMessageMenu(actions,')
    // Die vier sichtbaren Knöpfe hängen an `actions.*`, nicht mehr an den
    // Handlern direkt — sonst gäbe es wieder zwei Wege zur selben Aktion.
    for (const call of ['onClick={actions.copy}', 'onClick={actions.remove}', 'onClick={actions.edit}', 'onClick={actions.regenerate}']) {
      expect(src).toContain(call)
    }
    // Und die alten Direktaufrufe stehen nicht mehr in der Leiste.
    expect(src).not.toContain('onClick={handleCopy}')
    expect(src).not.toContain('onClick={handleDelete}')
    expect(src).not.toContain('onClick={startEdit}')
  })

  it('MessageBubble: Menü und Leiste stehen unter derselben Bedingung', () => {
    const src = read('components', 'chat', 'MessageBubble.tsx')
    // Während des Streamens und beim Bearbeiten zeigt die Leiste nichts —
    // dann darf auch der Rechtsklick nichts anbieten.
    expect(src).toContain('const actionsAvailable = !isEditing && !isStreaming')
    expect(src).toContain('if (!actionsAvailable) return')
  })

  it('ModelCard: Knöpfe und Menü lesen aus DEMSELBEN actions-Objekt', () => {
    const src = read('components', 'models', 'ModelCard.tsx')
    expect(src).toContain('const actions: ModelMenuHandlers = { select: onSelect, info: onInfo, remove: onDelete }')
    expect(src).toContain('buildModelCardMenu(actions,')
    expect(src).toContain('actions.info()')
    expect(src).toContain('actions.remove()')
    expect(src).toContain('onClick={actions.select}')
  })

  it('beide benutzen dasselbe ui/ContextMenu, nicht je ein eigenes', () => {
    for (const [dir, file] of [['chat', 'MessageBubble.tsx'], ['models', 'ModelCard.tsx']] as const) {
      expect(read('components', dir, file)).toContain("import { ContextMenu } from '../ui/ContextMenu'")
    }
  })
})

describe('ui/ContextMenu folgt dem vorhandenen Muster und schließt seine Lücken', () => {
  const src = read('components', 'ui', 'ContextMenu.tsx')

  it('Aufbau und Rollen wie im einzigen Menü, das es vorher gab', () => {
    expect(src).toContain('role="menu"')
    expect(src).toContain('role="menuitem"')
    expect(src).toContain('aria-label={label}')
    // Overlay fängt Klick UND Rechtsklick ab — genau wie Sidebar.tsx:693.
    expect(src).toContain('onClick={onClose}')
    expect(src).toMatch(/onContextMenu=\{\(e\) => \{ e\.preventDefault\(\); onClose\(\) \}\}/)
  })

  it('Tastatur: Escape, Pfeiltasten, Home/End', () => {
    for (const k of ["case 'Escape':", "case 'ArrowDown':", "case 'ArrowUp':", "case 'Home':", "case 'End':"]) {
      expect(src).toContain(k)
    }
    expect(src).toContain('nextFocusIndex(items.length')
  })

  it('Fokus geht hinein und kommt beim Schließen zurück', () => {
    expect(src).toContain('restoreRef.current')
    expect(src).toContain('if (target && target.isConnected) target.focus()')
  })

  it('der Auslöser wird bei `mousedown` gemerkt, nicht erst beim Mounten', () => {
    // Live gemessen (2026-09-01): das Verschieben des Fokus ist die
    // Default-Aktion von `mousedown` und läuft NACH allen Listenern.
    //   mousedown → activeElement = der Knopf
    //   contextmenu → activeElement = <body>
    // Wer erst beim Mounten `document.activeElement` liest — der Weg, den
    // ui/Modal gehen darf, weil es per Tastatur geöffnet wird — findet den
    // Auslöser nie mehr und lässt den Fokus auf <body> zurück.
    expect(src).toContain("document.addEventListener(\n    'mousedown',")
    expect(src).toContain('lastFocusedBeforePointer')
    // Per Tastatur geöffnet gibt es kein mousedown — dort hat der lebende
    // Fokus Vorrang.
    expect(src).toMatch(/live instanceof HTMLElement && live !== document\.body \? live : lastFocusedBeforePointer/)
  })

  it('Escape trifft nur die oberste Ebene — der Dialog-Stapel des Hauses', () => {
    expect(src).toContain("from './dialog-a11y'")
    expect(src).toContain('isTopDialog(dialogId)')
    expect(src).toContain('openDialog(dialogId)')
  })
})
