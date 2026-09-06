/**
 * Die Kommandopalette „über die VORHANDENEN Aktionen" — Audit Welle 3,
 * Achse 11.
 *
 * Der teuerste Fehler wäre nicht ein hässlicher Dialog, sondern eine Palette,
 * die die Aktionen NACHBAUT: ein zweiter Aufrufweg zu „Neuer Chat", der beim
 * nächsten Umbau von Ctrl+N zurückbleibt. Der Kern dieser Datei ist deshalb
 * ein Identitätsvergleich — `toBe`, nicht `toEqual`, nicht „ruft etwas
 * Ähnliches": das `run` eines Eintrags MUSS dieselbe Funktion sein, die auch
 * an der Taste bzw. am Knopf hängt.
 *
 * Was hier nicht geprüft werden kann: wie die Palette aussieht und ob der
 * Fokus wirklich zurückkommt. Die Testumgebung ist `environment: 'node'`,
 * es gibt kein Dokument. Alles Tastatur-, Rollen- und Fokusverhalten kommt
 * darum aus `ui/Modal` bzw. `ui/dialog-a11y`, die eigene Tests haben; die
 * letzten beiden Blöcke unten belegen nur noch, dass die Palette diesen Weg
 * benutzt und keinen eigenen danebenstellt.
 *
 * Run: npx vitest run src/components/__tests__/kommandopalette-aktionsherkunft.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildCommands,
  matchCommands,
  resolveActiveIndex,
  type Command,
  type CommandContext,
} from '../ui/command-actions'
import { SHORTCUT_ACTIONS, shortcutKeys, type ShortcutId } from '../../hooks/useKeyboardShortcuts'

const SRC = resolve(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

function ctxWith(over: Partial<CommandContext> = {}) {
  const base: CommandContext = {
    shortcuts: SHORTCUT_ACTIONS,
    keysFor: shortcutKeys,
    setView: vi.fn(),
    openCompare: vi.fn(),
    toggleSidebar: vi.fn(),
    setActiveModel: vi.fn(),
    models: [{ name: 'qwen3:4b' }, { name: 'hermes-3' }],
    activeModel: 'hermes-3',
    localViewsAvailable: true,
    quit: vi.fn(),
  }
  return { ...base, ...over }
}

const byId = (cmds: readonly Command[], id: string) => cmds.find(c => c.id === id)

describe('jeder Eintrag hat eine vorhandene Aktion dahinter', () => {
  it('die Kürzel-Einträge SIND die Kürzel-Aktionen, keine Kopie', () => {
    const cmds = buildCommands(ctxWith())
    const pairs: [string, ShortcutId][] = [
      ['new-conversation', 'new-conversation'],
      ['focus-chat-input', 'focus-chat-input'],
      ['export-chat', 'export-chat'],
      ['toggle-theme', 'toggle-theme'],
      ['show-shortcuts', 'show-shortcuts'],
    ]
    for (const [cmdId, shortcutId] of pairs) {
      expect(byId(cmds, cmdId)?.run).toBe(SHORTCUT_ACTIONS[shortcutId])
    }
  })

  it('und sie zeigen die Beschriftung aus DERSELBEN Liste', () => {
    const cmds = buildCommands(ctxWith())
    expect(byId(cmds, 'new-conversation')?.keys).toBe(shortcutKeys('new-conversation'))
    expect(byId(cmds, 'toggle-theme')?.keys).toBe('Ctrl+Shift+D')
  })

  it('Navigation ruft setView der Kopfzeile, mit dem richtigen Ziel', () => {
    const ctx = ctxWith()
    const cmds = buildCommands(ctx)
    for (const [id, view] of [['view-chat', 'chat'], ['view-create', 'create'], ['view-models', 'models'], ['view-benchmark', 'benchmark'], ['view-settings', 'settings']] as const) {
      byId(cmds, id)?.run()
      expect(ctx.setView).toHaveBeenLastCalledWith(view)
    }
  })

  it('Compare ist der gemeinsame openCompare, nicht zwei eigene Zeilen', () => {
    const ctx = ctxWith()
    expect(byId(buildCommands(ctx), 'view-compare')?.run).toBe(ctx.openCompare)
  })

  it('Sidebar ist toggleSidebar des Stores', () => {
    const ctx = ctxWith()
    expect(byId(buildCommands(ctx), 'toggle-sidebar')?.run).toBe(ctx.toggleSidebar)
  })

  it('Modellwechsel ruft setActiveModel mit dem Namen der Karte', () => {
    const ctx = ctxWith()
    byId(buildCommands(ctx), 'model:qwen3:4b')?.run()
    expect(ctx.setActiveModel).toHaveBeenCalledWith('qwen3:4b')
  })

  /**
   * Nachpruefung G4, 04.09.2026: die Zeile hiess
   * "Use openai::Phi-4-mini-instruct-Q4_K_M". `openai::` ist unsere interne
   * Adresse des geteilten Steckplatzes, sie steht an keiner anderen Stelle der
   * Oberflaeche und schiebt den einzigen Teil, den der Nutzer sucht, um elf
   * Zeichen nach rechts.
   */
  it('die Beschriftung nennt das Modell, nicht unsere Steckplatzadresse', () => {
    const ctx = ctxWith({ models: [{ name: 'openai::Phi-4-mini-instruct-Q4_K_M' }] })
    const cmds = buildCommands(ctx)
    const eintrag = byId(cmds, 'model:openai::Phi-4-mini-instruct-Q4_K_M')
    expect(eintrag?.label).toBe('Use Phi-4-mini-instruct-Q4_K_M')
    expect(eintrag?.label).not.toContain('openai::')
    // Die KENNUNG bleibt der volle Name, sonst waeren zwei Backends mit
    // demselben Modell derselbe Eintrag.
    expect(eintrag).toBeDefined()
    // Und geschaltet wird weiter mit dem Speichernamen, nicht mit dem Text.
    eintrag?.run()
    expect(ctx.setActiveModel).toHaveBeenCalledWith('openai::Phi-4-mini-instruct-Q4_K_M')
  })

  it('ein Ollama-Name ohne Praefix bleibt unangetastet', () => {
    // Die Gegenprobe zum Abschneiden: es darf nicht irgendwo mitten im Namen
    // schneiden, sondern nur das Slot-Praefix wegnehmen.
    expect(byId(buildCommands(ctxWith()), 'model:qwen3:4b')?.label).toBe('Use qwen3:4b')
  })

  it('und gesucht wird nach dem, was dasteht', () => {
    const cmds = buildCommands(ctxWith({ models: [{ name: 'openai::Phi-4-mini-instruct-Q4_K_M' }] }))
    expect(matchCommands('phi', cmds).map(c => c.id))
      .toContain('model:openai::Phi-4-mini-instruct-Q4_K_M')
  })

  it('das bereits aktive Modell bekommt keinen Eintrag, der nichts tut', () => {
    const cmds = buildCommands(ctxWith())
    expect(byId(cmds, 'model:hermes-3')).toBeUndefined()
    expect(byId(cmds, 'model:qwen3:4b')).toBeDefined()
  })

  it('Quit ist der Tray-Eintrag — und fehlt, wo es ihn nicht gibt', () => {
    const ctx = ctxWith()
    expect(byId(buildCommands(ctx), 'quit')?.run).toBe(ctx.quit)
    // Im Browser (kein Tauri) gibt es die Backend-Aktion nicht. Ein Eintrag
    // ohne Aktion dahinter wäre eine Attrappe, also gibt es ihn dort nicht.
    expect(byId(buildCommands(ctxWith({ quit: null })), 'quit')).toBeUndefined()
  })

  it('Cloud-Modus zeigt keine Ziele, die die Kopfzeile dort ausblendet', () => {
    const cloud = buildCommands(ctxWith({ localViewsAvailable: false }))
    expect(byId(cloud, 'view-models')).toBeUndefined()
    expect(byId(cloud, 'view-benchmark')).toBeUndefined()
    expect(byId(cloud, 'view-settings')).toBeDefined()
  })

  it('kein Eintrag ohne ausführbares run — nirgends eine Attrappe', () => {
    for (const cmd of buildCommands(ctxWith())) {
      expect(cmd.run).toBeTypeOf('function')
      expect(cmd.label.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('Suche: Teilwort-Treffer, mehrere Wörter, sinnvolle Reihenfolge', () => {
  const cmds = buildCommands(ctxWith())
  const ids = (q: string) => matchCommands(q, cmds).map(c => c.id)

  it('leere Anfrage zeigt alles — bis auf das, was nur gesucht erscheint', () => {
    const shown = matchCommands('', cmds)
    expect(shown.length).toBe(cmds.length - 1)
    expect(shown.some(c => c.id === 'quit')).toBe(false)
  })

  it('Teilwort in der Mitte trifft', () => {
    expect(ids('conversation')).toContain('new-conversation')
    expect(ids('sidebar')).toContain('toggle-sidebar')
  })

  it('mehrere Wörter müssen ALLE treffen', () => {
    expect(ids('toggle dark')).toContain('toggle-theme')
    expect(ids('toggle zzz')).toHaveLength(0)
  })

  it('der Wortanfang steht vor dem Treffer mitten im Wort', () => {
    // „Export chat as Markdown" beginnt mit dem Wort, „Focus chat input" hat
    // es in der Mitte — also kommt Export zuerst.
    const order = ids('export')
    expect(order[0]).toBe('export-chat')
  })

  it('Modellnamen mit Doppelpunkt zerfallen in benutzbare Stücke', () => {
    expect(ids('qwen3')).toContain('model:qwen3:4b')
    expect(ids('4b')).toContain('model:qwen3:4b')
  })

  it('Quit erscheint erst, wenn danach gesucht wird', () => {
    expect(ids('quit')).toContain('quit')
  })

  it('keine Treffer heißt leere Liste, nicht die volle', () => {
    expect(ids('xyzzy')).toHaveLength(0)
  })

  it('Groß/Kleinschreibung ist egal', () => {
    expect(ids('SETTINGS')).toContain('view-settings')
  })
})

describe('die Auswahl zeigt immer auf einen Eintrag, den es wirklich gibt', () => {
  const cmds = (models: { name: string }[]) => buildCommands(ctxWith({ models, activeModel: null }))
  const FIVE = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }]

  it('die Liste schrumpft unter einer gehaltenen Auswahl — kein Griff ins Leere', () => {
    // Der Fall aus der echten App: `buildCommands` haengt an der Modellliste,
    // und die trifft ASYNCHRON ein. Bei offener Palette wird die Liste also
    // laenger oder kuerzer, waehrend der Nutzer schon eine Zeile gewaehlt hat.
    const lang = matchCommands('', cmds(FIVE))
    const gehalten = lang.length - 2
    expect(lang[gehalten]).toBeDefined()

    // Jetzt faellt die Modellliste weg (Moduswechsel, oder sie kam neu).
    const kurz = matchCommands('', cmds([]))
    expect(kurz.length).toBeLessThan(lang.length)
    expect(kurz[gehalten]).toBeUndefined() // ohne Klemmung genau hier der Fehler

    const i = resolveActiveIndex({ active: gehalten, forQuery: '' }, '', kurz.length)

    // Die FOLGE, nicht die Formel: es gibt einen Eintrag, und zwar den, den
    // ein Nutzer nach dem Zusammenschrumpfen unten erwartet.
    expect(kurz[i]).toBeDefined()
    expect(i).toBe(kurz.length - 1)
    expect(kurz[i].label).toBe('Keyboard shortcuts')
  })

  it('auch ein weit ueberzaehliger Index landet auf der letzten Zeile', () => {
    const kurz = matchCommands('', cmds([]))
    const i = resolveActiveIndex({ active: 999, forQuery: '' }, '', kurz.length)
    expect(kurz[i]).toBeDefined()
    expect(i).toBe(kurz.length - 1)
  })

  it('solange die Liste reicht, bleibt die Wahl unangetastet', () => {
    // Die Gegenprobe zur Klemmung: sie darf nicht einfach immer nach unten
    // ziehen, sonst koennte man mit den Pfeiltasten nicht navigieren.
    const lang = matchCommands('', cmds(FIVE))
    expect(resolveActiveIndex({ active: 3, forQuery: '' }, '', lang.length)).toBe(3)
  })

  it('eine leere Trefferliste ergibt 0 statt einer negativen Zahl', () => {
    expect(resolveActiveIndex({ active: 5, forQuery: 'xyzzy' }, 'xyzzy', 0)).toBe(0)
  })
})

describe('eine neue Suchanfrage waehlt den ersten Treffer', () => {
  const cmds = buildCommands(ctxWith())

  // Wichtig fuer die Aussagekraft: die neue Trefferliste muss LAENGER sein als
  // der gehaltene Index. Sonst faengt die Klemmung den Index ohnehin auf 0 ab
  // und der Test wuerde gruen bleiben, auch wenn das Zuruecksetzen fehlt —
  // er wuerde dann etwas anderes pruefen, als sein Name behauptet.

  it('die alte Wahl galt einer anderen Liste und wird nicht mitgeschleppt', () => {
    const vorher = matchCommands('', cmds)
    expect(vorher[2]).toBeDefined()

    const treffer = matchCommands('chat', cmds)
    expect(treffer.length).toBeGreaterThan(2) // sonst beweist der Test nichts

    const i = resolveActiveIndex({ active: 2, forQuery: '' }, 'chat', treffer.length)

    // Die FOLGE: ausgewaehlt ist der erste Treffer der NEUEN Anfrage.
    expect(i).toBe(0)
    expect(treffer[i].label).toBe('Chat')
  })

  it('und beim Loeschen der Anfrage zurueck an den Anfang der vollen Liste', () => {
    const alle = matchCommands('', cmds)
    expect(alle.length).toBeGreaterThan(3)

    const i = resolveActiveIndex({ active: 3, forQuery: 'chat' }, '', alle.length)
    expect(i).toBe(0)
    expect(alle[i].label).toBe('New conversation')
  })

  it('auch von einer Anfrage direkt in die naechste', () => {
    const treffer = matchCommands('to', cmds)
    expect(treffer.length).toBeGreaterThan(2)

    const i = resolveActiveIndex({ active: 2, forQuery: 'chat' }, 'to', treffer.length)
    expect(i).toBe(0)
    expect(treffer[i].label).toBe('Toggle sidebar')
  })

  it('dieselbe Anfrage laesst die Wahl stehen — sonst waere Navigieren unmoeglich', () => {
    const treffer = matchCommands('chat', cmds)
    expect(resolveActiveIndex({ active: 2, forQuery: 'chat' }, 'chat', treffer.length)).toBe(2)
  })
})

describe('die Palette benutzt den Dialog-Hausstandard, statt ihn nachzubauen', () => {
  const palette = read('components', 'ui', 'CommandPalette.tsx')

  it('sie rendert in ui/Modal — dort sitzen Escape, Fokusfalle und Fokusrückgabe', () => {
    expect(palette).toContain("import { Modal } from './Modal'")
    expect(palette).toMatch(/<Modal\b/)
  })

  it('und hat KEINEN eigenen Escape-Pfad und keine eigene Fokusfalle', () => {
    expect(palette).not.toMatch(/key === 'Escape'/)
    expect(palette).not.toMatch(/key === 'Tab'/)
  })

  it('Suchfeld und Liste sind als Combobox ausgezeichnet', () => {
    expect(palette).toContain('role="combobox"')
    expect(palette).toContain('role="listbox"')
    expect(palette).toContain('role="option"')
    expect(palette).toContain('aria-activedescendant')
    // Ohne sichtbaren Titel braucht der Dialog eine Beschriftung.
    expect(palette).toContain('ariaLabel="Command palette"')
  })

  it('Pfeiltasten laufen über dieselbe zyklische Rechnung wie die Fokusfalle', () => {
    expect(palette).toContain("import { nextFocusIndex } from './dialog-a11y'")
  })

  it('sie ist auch wirklich eingehängt', () => {
    expect(read('components', 'layout', 'AppShell.tsx')).toContain('<CommandPalette />')
  })

  it('die Auswahl kommt aus resolveActiveIndex — sonst pruefen die zwei Bloecke darueber ins Leere', () => {
    // QUELLTEXT-Zusicherung, ausdruecklich: dass die Komponente die geprueften
    // Regeln auch BENUTZT, laesst sich ohne DOM nicht als Verhalten zeigen.
    // Die Regeln selbst sind oben als Verhalten geprueft, diese Zeile haelt
    // nur die Verdrahtung fest.
    expect(palette).toContain('resolveActiveIndex(selection, query, shown.length)')
    // Und dass die alte Buchfuehrung nicht heimlich zurueckkommt.
    expect(palette).not.toMatch(/useEffect\(\(\) => \{ setActive\(0\) \}/)
    expect(palette).not.toContain('Math.min(active,')
  })

  it('der Befehl wird NICHT an einen Animationsframe gehängt', () => {
    // Live gemessen (2026-09-01): in einem verdeckten Fenster feuert
    // `requestAnimationFrame` nicht — die Palette ging zu und der Befehl
    // passierte nie. Diese App legt sich beim Schließen in den Tray,
    // „verdeckt" ist hier also der Normalfall und kein Sonderfall.
    // Auf den AUFRUF geprüft, nicht auf das Wort: im Kommentar darüber steht
    // absichtlich, warum hier mal ein Animationsframe stand.
    expect(palette).not.toMatch(/requestAnimationFrame\s*\(/)
    expect(palette).toContain('setTimeout(() => cmd.run(), 0)')
  })
})
