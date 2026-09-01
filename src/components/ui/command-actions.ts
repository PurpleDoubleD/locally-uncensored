/**
 * Der Inhalt der Kommandopalette — als reine Funktionen, damit er ohne DOM
 * prüfbar ist (`environment: 'node'`).
 *
 * Das Wort aus dem Audit ist „über die VORHANDENEN Aktionen". Die Palette
 * erfindet deshalb nichts: jeder Eintrag hier bekommt seine Funktion von außen
 * hereingereicht und gibt sie unverändert als `run` weiter. Wo eine Aktion
 * schon ein Tastenkürzel hat, ist es buchstäblich dieselbe Funktion —
 * `SHORTCUT_ACTIONS` aus `hooks/useKeyboardShortcuts.ts`, nicht eine Kopie
 * davon. Der Test belegt das mit `toBe`, nicht mit „tut dasselbe".
 *
 * Woher jeder Eintrag stammt, steht am Eintrag selbst.
 */

import type { ShortcutId } from '../../hooks/useKeyboardShortcuts'
import type { View } from '../../stores/uiStore'

export interface Command {
  readonly id: string
  readonly label: string
  /** Überschrift der Gruppe, in der der Eintrag steht. */
  readonly group: string
  /** Beschriftung des Kürzels, falls es eins gibt (rechte Spalte). */
  readonly keys?: string
  readonly run: () => void
  /**
   * Erst sichtbar, wenn wirklich gesucht wurde. Genau ein Eintrag trägt das:
   * „Quit LU". Er steht sonst in einer Liste, in der man mit Pfeil-hoch und
   * Enter navigiert, und ein versehentliches Beenden ist der einzige Fehler
   * dieser Palette, den man nicht rückgängig machen kann.
   */
  readonly hiddenUntilSearched?: boolean
}

/**
 * Alles, was die Palette braucht, wird hereingereicht — sie greift auf keinen
 * Store selbst zu. Das ist nicht Zeremonie: nur so kann der Test die Herkunft
 * jedes `run` gegen die übergebene Funktion prüfen.
 */
export interface CommandContext {
  /** Die Kürzel-Aktionen SELBST (`SHORTCUT_ACTIONS`), nicht nachgebaut. */
  readonly shortcuts: Readonly<Record<ShortcutId, () => void>>
  /** Beschriftung je Kürzel (`shortcutKeys`), damit es nur eine Liste gibt. */
  readonly keysFor: (id: ShortcutId) => string | undefined
  /** `useUIStore.setView` — die Funktion, die die Kopfzeile ruft. */
  readonly setView: (view: View) => void
  /** Compare ist kein View, sondern Flag + `setView('chat')`
   *  (`stores/compareStore.ts: openCompare`, den auch der Header ruft). */
  readonly openCompare: () => void
  /** `useUIStore.toggleSidebar` — der Hamburger links oben. */
  readonly toggleSidebar: () => void
  /** `useModelStore.setActiveModel` — dieselbe Funktion wie `ModelCard.onSelect`. */
  readonly setActiveModel: (name: string) => void
  /** Installierte Modelle, für je einen „Use …"-Eintrag. */
  readonly models: readonly { readonly name: string }[]
  readonly activeModel: string | null
  /** Cloud-Modus blendet Models/Benchmark aus (`Header.tsx:301`), die Palette
   *  darf dann nicht dorthin führen. */
  readonly localViewsAvailable: boolean
  /** Der zweite Tray-Eintrag (`src-tauri/src/main.rs:502`) über dieselbe
   *  Backend-Aktion wie der Updater (`stores/updateStore.ts:338`).
   *  `null` außerhalb von Tauri — dort gibt es die Aktion nicht, und ein
   *  Eintrag ohne Aktion dahinter wäre eine Attrappe. */
  readonly quit: (() => void) | null
}

const GROUP_CHAT = 'Chat'
const GROUP_VIEW = 'Go to'
const GROUP_MODEL = 'Models'
const GROUP_APP = 'App'

export function buildCommands(ctx: CommandContext): Command[] {
  const withKeys = (id: ShortcutId, label: string, group: string): Command => ({
    id,
    label,
    group,
    keys: ctx.keysFor(id),
    run: ctx.shortcuts[id],
  })

  const out: Command[] = [
    // Die vier Kürzel-Aktionen, die etwas im Chat tun.
    withKeys('new-conversation', 'New conversation', GROUP_CHAT),
    withKeys('focus-chat-input', 'Focus chat input', GROUP_CHAT),
    withKeys('export-chat', 'Export chat as Markdown', GROUP_CHAT),

    // Navigation — dieselben Ziele wie die Kopfzeile (`Header.tsx:287-304`).
    { id: 'view-chat', label: 'Chat', group: GROUP_VIEW, run: () => ctx.setView('chat') },
    { id: 'view-create', label: 'Create', group: GROUP_VIEW, run: () => ctx.setView('create') },
    { id: 'view-compare', label: 'Compare models', group: GROUP_VIEW, run: ctx.openCompare },
  ]

  if (ctx.localViewsAvailable) {
    out.push({ id: 'view-benchmark', label: 'Benchmark', group: GROUP_VIEW, run: () => ctx.setView('benchmark') })
    out.push({ id: 'view-models', label: 'Models', group: GROUP_VIEW, run: () => ctx.setView('models') })
  }
  out.push({ id: 'view-settings', label: 'Settings', group: GROUP_VIEW, run: () => ctx.setView('settings') })
  out.push({ id: 'toggle-sidebar', label: 'Toggle sidebar', group: GROUP_VIEW, run: ctx.toggleSidebar })
  out.push(withKeys('toggle-theme', 'Toggle dark/light mode', GROUP_VIEW))

  // Modellwechsel. Das aktive Modell bekommt keinen Eintrag — er täte nichts.
  for (const m of ctx.models) {
    if (m.name === ctx.activeModel) continue
    out.push({
      id: `model:${m.name}`,
      label: `Use ${m.name}`,
      group: GROUP_MODEL,
      run: () => ctx.setActiveModel(m.name),
    })
  }

  out.push(withKeys('show-shortcuts', 'Keyboard shortcuts', GROUP_APP))
  if (ctx.quit) {
    out.push({ id: 'quit', label: 'Quit LU', group: GROUP_APP, run: ctx.quit, hiddenUntilSearched: true })
  }

  return out
}

/* ── Suche ───────────────────────────────────────────────────────────────── */

/**
 * Teilwort-Treffer, mehrere Wörter erlaubt, kein Fuzzy-Zauber: „tog dark"
 * findet „Toggle dark/light mode", „qwen" findet das Modell. Jedes Wort der
 * Anfrage muss irgendwo treffen; die Reihenfolge richtet sich danach, WIE gut
 * es trifft, und bei Gleichstand bleibt die gebaute Reihenfolge erhalten
 * (die Gruppen also beieinander).
 */
export function matchCommands(query: string, commands: readonly Command[]): Command[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)

  if (tokens.length === 0) return commands.filter(c => !c.hiddenUntilSearched)

  const hits: { cmd: Command; score: number; order: number }[] = []
  commands.forEach((cmd, order) => {
    let score = 0
    for (const t of tokens) {
      const s = scoreToken(t, cmd)
      if (s === 0) return
      score += s
    }
    hits.push({ cmd, score, order })
  })

  hits.sort((a, b) => b.score - a.score || a.order - b.order)
  return hits.map(h => h.cmd)
}

/** Wortgrenzen: alles, was kein Buchstabe und keine Ziffer ist. Modellnamen
 *  wie `qwen3:4b-instruct` zerfallen damit in benutzbare Stücke. */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u

function scoreToken(token: string, cmd: Command): number {
  const label = cmd.label.toLowerCase()
  if (label.startsWith(token)) return 4
  if (label.split(WORD_SPLIT).some(w => w.startsWith(token))) return 3
  if (label.includes(token)) return 2
  if (cmd.group.toLowerCase().includes(token)) return 1
  return 0
}

/* ── Auswahl ─────────────────────────────────────────────────────────────── */

/**
 * Welche Zeile ist ausgewählt — und zu WELCHER Suchanfrage gehört diese Wahl?
 *
 * Das zweite Feld ist der Kern. Ohne es ist `active` ein nackter Index in eine
 * Liste, die sich unter ihm ändert, und die Komponente muss ihn per Ereignis
 * nachpflegen: einmal beim Tippen zurücksetzen, einmal beim Schrumpfen der
 * Liste einfangen. Beides ist Buchführung, die schiefgehen kann, und beides
 * war in `CommandPalette` nur mit einem DOM prüfbar.
 */
export interface Selection {
  readonly active: number
  /** Die Anfrage, für die `active` gewählt wurde. */
  readonly forQuery: string
}

/**
 * Auf welchen Eintrag zeigt die Auswahl JETZT?
 *
 * Zwei Fälle, beide abgeleitet statt nachgepflegt:
 *
 *  (1) Die Anfrage hat gewechselt — die alte Wahl galt einer anderen Liste und
 *      wäre jetzt ein zufälliger Eintrag. Also der erste Treffer.
 *  (2) Gleiche Anfrage, aber die Liste kann trotzdem kürzer geworden sein: die
 *      Modelle treffen ASYNCHRON ein, `buildCommands` liefert also bei
 *      offener Palette plötzlich mehr oder weniger Zeilen. Ein gehaltener
 *      Index zeigt dann ins Leere — `shown[i]` wäre `undefined`, Enter täte
 *      nichts und `aria-activedescendant` zeigte auf eine ID, die es nicht
 *      gibt. Also in die Liste klemmen.
 */
export function resolveActiveIndex(sel: Selection, query: string, count: number): number {
  if (count <= 0) return 0
  if (sel.forQuery !== query) return 0
  return Math.min(Math.max(0, sel.active), count - 1)
}
