/**
 * Kontextmenü-Modelle und die Geometrie, an der sie hängen — als reine
 * Funktionen, weil die Testumgebung `environment: 'node'` ist und ein
 * gerendertes Menü sich dort nicht anklicken lässt.
 *
 * Der Zweck dieser Datei ist NICHT, Menüs zu beschreiben. Der Zweck ist die
 * Regel „ein Kontextmenü löst seine Aktionen über denselben Code aus wie der
 * sichtbare Knopf". Sie ist hier prüfbar gemacht: `buildMessageMenu` und
 * `buildModelCardMenu` bekommen die Handler HEREIN und reichen sie
 * unverändert als `run` weiter. Sie können also gar nichts nachbauen — und
 * der Test kann das mit einem Identitätsvergleich (`toBe`) belegen, nicht nur
 * mit „ruft irgendwas Ähnliches auf".
 *
 * Vorbild ist das einzige Kontextmenü, das es vor Welle 3 gab
 * (`layout/Sidebar.tsx:690`): Vollflächen-Overlay, `role="menu"` mit
 * `role="menuitem"`-Knöpfen, Escape schließt. Übernommen sind Aufbau und
 * Rollen; ergänzt sind die drei Dinge, die dort fehlen — Pfeiltasten,
 * Fokusrückgabe, und eine Platzierung, die auch nach links/oben ausweicht.
 */

/** Ein Eintrag eines Kontextmenüs. `run` ist die Funktion des Aufrufers,
 *  niemals eine hier gebaute. */
export interface MenuAction {
  readonly id: string
  readonly label: string
  readonly run: () => void
  /** Rot einfärben und beim Öffnen nie vorausgewählt (vgl. `dialog-a11y`). */
  readonly destructive?: boolean
}

/* ── Nachricht ───────────────────────────────────────────────────────────── */

/**
 * Die Aktionen, die die Aktionsleiste unter einer Nachricht schon hat
 * (`chat/MessageBubble.tsx`). Genau diese vier, keine erfundene fünfte.
 * `regenerate` ist `null`, wo die Leiste den Knopf auch nicht zeigt (eigene
 * Nachricht, oder es läuft gerade eine Antwort).
 */
export interface MessageMenuHandlers {
  readonly copy: () => void
  readonly edit: (() => void) | null
  readonly regenerate: (() => void) | null
  readonly remove: () => void
}

export interface MessageMenuState {
  /** Kopieren wurde eben gedrückt — die Leiste zeigt dann einen Haken. */
  readonly copied: boolean
  /** Löschen ist scharf (zweiter Klick löscht wirklich, D#81). */
  readonly confirmDelete: boolean
}

export function buildMessageMenu(h: MessageMenuHandlers, s: MessageMenuState): MenuAction[] {
  const out: MenuAction[] = []
  if (h.edit) out.push({ id: 'edit', label: 'Edit', run: h.edit })
  if (h.regenerate) out.push({ id: 'regenerate', label: 'Regenerate', run: h.regenerate })
  out.push({ id: 'copy', label: s.copied ? 'Copied' : 'Copy text', run: h.copy })
  // Die Beschriftung sagt dasselbe wie der `title` des Knopfes: der erste
  // Aufruf schärft nur, gelöscht wird erst beim zweiten.
  out.push({
    id: 'delete',
    label: s.confirmDelete ? 'Click again to delete' : 'Delete message',
    run: h.remove,
    destructive: true,
  })
  return out
}

/* ── Modellkarte ─────────────────────────────────────────────────────────── */

/**
 * Was die Karte schon kann (`models/ModelCard.tsx`): auswählen (Klick auf die
 * Zeile), Details, Löschen. Der Benchmark-Knopf der Karte fehlt hier bewusst —
 * er ist eine eigene Komponente mit eigenem Zustand (`ModelBenchmark`), und ihn
 * ins Menü zu holen hieße, seinen Klickpfad ein zweites Mal zu schreiben.
 */
export interface ModelMenuHandlers {
  readonly select: () => void
  readonly info: () => void
  readonly remove: () => void
}

export interface ModelMenuState {
  readonly isActive: boolean
  readonly canDelete: boolean
}

export function buildModelCardMenu(h: ModelMenuHandlers, s: ModelMenuState): MenuAction[] {
  const out: MenuAction[] = []
  // Auf der bereits aktiven Karte wäre „Use this model" ein Eintrag, der
  // nichts tut — die Karte zeigt an derselben Stelle ihr ACTIVE-Etikett.
  if (!s.isActive) out.push({ id: 'select', label: 'Use this model', run: h.select })
  out.push({ id: 'info', label: 'Details', run: h.info })
  if (s.canDelete) out.push({ id: 'delete', label: 'Delete model', run: h.remove, destructive: true })
  return out
}

/* ── Platzierung ─────────────────────────────────────────────────────────── */

export interface MenuBox {
  readonly width: number
  readonly height: number
}

export interface MenuPosition {
  readonly left: number
  readonly top: number
}

/**
 * Wohin kommt das Menü, wenn an (x|y) rechtsgeklickt wurde?
 *
 * Die Fassung in `Sidebar.tsx:701` rechnet `Math.min(x, innerWidth - 160)` mit
 * geratenen Maßen und ohne untere Schranke: in einem schmalen Fenster wird
 * daraus ein negatives `left` und das Menü hängt links aus dem Bild. Hier
 * kippt es stattdessen auf die andere Seite des Zeigers — so machen es
 * native Menüs — und wird erst danach in den Rahmen geklemmt.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  box: MenuBox,
  viewport: MenuBox,
  margin = 8,
): MenuPosition {
  return { left: place(x, box.width, viewport.width, margin), top: place(y, box.height, viewport.height, margin) }
}

function place(at: number, size: number, limit: number, margin: number): number {
  // Passt es hinter den Zeiger? Dann dorthin.
  if (at + size + margin <= limit) return Math.max(margin, at)
  // Sonst davor kippen — aber nur, wenn davor mehr Platz ist als dahinter.
  const flipped = at - size
  if (flipped >= margin) return flipped
  // Beides zu eng: an den Rahmen klemmen. `Math.max` steht zuletzt, damit ein
  // Menü, das höher/breiter ist als das Fenster, oben/links anliegt statt
  // hinter dem oberen Rand zu verschwinden.
  return Math.max(margin, limit - size - margin)
}
