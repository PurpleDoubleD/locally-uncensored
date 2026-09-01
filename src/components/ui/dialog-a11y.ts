/**
 * Dialog-Tastaturregeln als reine Funktionen.
 *
 * Die Testumgebung ist `environment: 'node'` — es gibt kein DOM, also lässt
 * sich ein gerendertes Modal nicht anklicken. Alles, was OHNE Dokument
 * entschieden werden kann, liegt deshalb hier und ist als Verhalten testbar:
 * welches Element den Anfangsfokus bekommt, wohin Tab/Shift+Tab laufen,
 * welcher Dialog auf Escape reagiert, wenn mehrere übereinander liegen, und
 * welche Knoten für Screenreader ausgeblendet werden dürfen, ohne den Dialog
 * selbst mit auszublenden.
 *
 * Modal.tsx hält nur noch den DOM-Klebstoff (querySelectorAll, .focus(),
 * addEventListener) — die Entscheidungen fallen alle hier.
 */

/** CSS-Selektor für alles, was grundsätzlich Fokus annehmen kann. */
export const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]'

/**
 * Minimalform eines fokussierbaren Elements — genau das, was die Regeln unten
 * lesen. `HTMLElement` erfüllt sie strukturell, deshalb übergibt der Browser-
 * Code echte Elemente und der Node-Test schlichte Objekte.
 */
export interface FocusableLike {
  readonly tagName?: string
  readonly disabled?: boolean
  readonly textContent?: string | null
  getAttribute(name: string): string | null
}

/**
 * Wörter, die einen Knopf als „macht etwas kaputt" ausweisen. Ein solcher Knopf
 * darf beim Öffnen NIE vorausgewählt sein: wer den Dialog mit der Tastatur
 * öffnet und reflexartig Enter drückt, hat sonst gelöscht.
 * Deutsch + Englisch, weil die Oberfläche gemischt beschriftet ist.
 */
export const DESTRUCTIVE_LABEL =
  /(delete|remove|discard|erase|reset|uninstall|wipe|destroy|overwrite|revoke|l(ö|oe)schen|entfernen|verwerfen|zur(ü|ue)cksetzen|überschreiben)/i

function labelOf(el: FocusableLike): string {
  return [el.getAttribute('aria-label'), el.getAttribute('data-label'), el.textContent]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
}

/** Ist das Element ein zerstörender Knopf? `data-destructive` schlägt Heuristik. */
export function isDestructive(el: FocusableLike): boolean {
  if (el.getAttribute('data-destructive') !== null) return true
  if (el.getAttribute('data-safe') !== null) return false
  return DESTRUCTIVE_LABEL.test(labelOf(el))
}

/** Der X-Knopf des Dialogs selbst — fokussierbar, aber ein armseliger Startpunkt. */
export function isDialogCloseButton(el: FocusableLike): boolean {
  return el.getAttribute('data-dialog-close') !== null
}

/**
 * Ein Link im Fließtext („…siehe Kosinkadink/VideoHelperSuite") ist zwar
 * fokussierbar, aber als Startpunkt falsch: reflexartiges Enter reißt einen
 * Browser auf, statt den Dialog zu bedienen. Er kommt erst dran, wenn es im
 * Dialog gar kein Bedienelement gibt.
 */
export function isInlineLink(el: FocusableLike): boolean {
  return el.tagName?.toUpperCase() === 'A' && el.getAttribute('href') !== null
}

/** Deaktivierte/versteckte Elemente nehmen keinen Fokus an. */
export function isFocusable(el: FocusableLike): boolean {
  if (el.disabled === true) return false
  if (el.getAttribute('disabled') !== null) return false
  if (el.getAttribute('hidden') !== null) return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  if (el.getAttribute('inert') !== null) return false
  const tabindex = el.getAttribute('tabindex')
  if (tabindex !== null && Number(tabindex) < 0) return false
  return true
}

/**
 * Welches Element bekommt beim Öffnen den Fokus?
 *
 * Reihenfolge:
 *  1. ein ausdrückliches `data-autofocus` (der Aufrufer weiß es besser),
 *  2. sonst das erste Bedienelement, das weder Schließen-X noch zerstörend
 *     noch ein Fließtext-Link ist,
 *  3. sonst der erste Fließtext-Link (besser als nichts),
 *  4. sonst das Schließen-X (besser als ein „Löschen" unter dem Finger),
 *  5. sonst gar keins → der Aufrufer fokussiert das Panel selbst.
 *
 * @returns Index in `candidates`, oder -1 für „nimm das Panel".
 */
export function pickInitialFocusIndex(candidates: readonly FocusableLike[]): number {
  const usable = candidates.map(isFocusable)
  const plain = (i: number) => usable[i] && !isDialogCloseButton(candidates[i]) && !isDestructive(candidates[i])

  const explicit = candidates.findIndex((c, i) => usable[i] && c.getAttribute('data-autofocus') !== null)
  if (explicit >= 0) return explicit

  const control = candidates.findIndex((c, i) => plain(i) && !isInlineLink(c))
  if (control >= 0) return control

  const link = candidates.findIndex((_, i) => plain(i))
  if (link >= 0) return link

  const close = candidates.findIndex((c, i) => usable[i] && isDialogCloseButton(c))
  if (close >= 0) return close

  return -1
}

/**
 * Fokus-Falle: wohin springt Tab (bzw. Shift+Tab) als Nächstes?
 *
 * `current` ist der Index des gerade fokussierten Elements oder -1, wenn der
 * Fokus außerhalb der Liste steht (Panel selbst, oder er ist ausgebüxt) — dann
 * holt Tab ihn vorne, Shift+Tab hinten wieder herein.
 *
 * @returns Zielindex, oder -1 wenn es nichts zu fokussieren gibt.
 */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return backwards ? count - 1 : 0
  return backwards ? (current - 1 + count) % count : (current + 1) % count
}

/* ── Escape-Stapel ────────────────────────────────────────────────────────
   Mehrere Modals können gleichzeitig offen sein (Modell löschen → Fehler-
   Dialog). Jeder Dialog hört auf `document`, also würden ohne Stapel ALLE auf
   ein Escape reagieren und der Nutzer verlöre zwei Ebenen auf einen Schlag.
   Nur der zuletzt geöffnete gilt als oberster.
   ──────────────────────────────────────────────────────────────────────── */

const stack: string[] = []

/** Meldet einen Dialog als offen an; er wird damit zum obersten. */
export function openDialog(id: string): void {
  closeDialog(id)
  stack.push(id)
}

/** Meldet einen Dialog ab. Unbekannte IDs sind ein No-op (StrictMode-fest). */
export function closeDialog(id: string): void {
  const i = stack.lastIndexOf(id)
  if (i >= 0) stack.splice(i, 1)
}

/** Nur der oberste Dialog darf auf Escape und Tab reagieren. */
export function isTopDialog(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id
}

/** Momentaufnahme des Stapels, unterste zuerst (Diagnose + Tests). */
export function dialogStack(): readonly string[] {
  return [...stack]
}

/** Nur für Tests: Stapel leeren. */
export function resetDialogStack(): void {
  stack.length = 0
}

/* ── Hintergrund inert ──────────────────────────────────────────────────── */

/**
 * Minimalform eines DOM-Knotens für den Geschwister-Lauf. `Element` erfüllt sie.
 */
export interface TreeNodeLike {
  readonly parentElement: TreeNodeLike | null
  readonly children: ArrayLike<TreeNodeLike>
}

/**
 * Welche Knoten dürfen ausgeblendet werden (`inert` / `aria-hidden`), solange
 * der Dialog offen ist?
 *
 * Der Dialog hängt im normalen React-Baum, NICHT in einem Portal. `aria-hidden`
 * auf `#root` würde ihn deshalb mitverstecken — genau der Fehler, den man in
 * freier Wildbahn ständig sieht. Also werden nur die GESCHWISTER auf dem Pfad
 * vom Dialog bis `stopAt` eingesammelt; kein Vorfahr des Dialogs und der Dialog
 * selbst schon gar nicht.
 *
 * @param node   Wurzelknoten des Dialogs (der Overlay-Container).
 * @param stopAt Oberste Ebene, deren Geschwister noch behandelt werden
 *               (üblicherweise `document.body`); danach wird abgebrochen.
 */
export function backgroundNodesToHide<T extends TreeNodeLike>(node: T, stopAt: TreeNodeLike | null): T[] {
  const out: T[] = []
  let onPath: TreeNodeLike = node
  let parent: TreeNodeLike | null = node.parentElement

  while (parent) {
    const kids = parent.children
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]
      if (child !== onPath) out.push(child as T)
    }
    if (parent === stopAt) break
    onPath = parent
    parent = parent.parentElement
  }

  return out
}
