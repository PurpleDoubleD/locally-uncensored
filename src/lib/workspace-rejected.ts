/**
 * Der Satz fuer einen Arbeitsordner, den die Rust-Seite nicht annimmt.
 *
 * Seit 2.6.8 prueft `validate_workspace_root` (src-tauri/.../filesystem.rs)
 * jeden gesetzten Ordner gegen eine Verbotsliste: $HOME genau, `/`, `/etc`,
 * `/usr`, `~/.ssh`, `C:\Windows` und Geschwister. Auf v2.6.7 gab es diese
 * Pruefung nicht, dort nahm der Fernauftrag jeden nicht-leeren Pfad.
 *
 * Bis zum 04.09.2026 fing die Oberflaeche die Ablehnung mit einem leeren
 * `catch` und schickte den Auftrag trotzdem los. Der Satz hier ist die eine
 * Haelfte der Reparatur, die andere steht im Aufrufer: eine alte Bindung wird
 * geraeumt, statt stehen zu bleiben.
 *
 * Er ist eine eigene Funktion und keine Zeichenkette im Aufrufer, damit sein
 * Wortlaut pruefbar ist. Ohne Renderer im Testlauf waere er sonst die einzige
 * Stelle dieser Reparatur, die niemand messen kann.
 */
export function workspaceRejectedMessage(pfad: string, fehler: unknown): string {
  // `backendCall` wirft nicht immer ein Error. Ein roher String muss genauso
  // durchkommen wie eine Message, sonst steht am Ende "undefined" im Satz.
  const grund =
    fehler instanceof Error ? fehler.message
      : typeof fehler === 'string' ? fehler
        : String(fehler)
  return (
    `Cannot use "${pfad}" as the workspace: ${grund}. `
    + `Nothing was started, and no folder is bound to the remote session. `
    + `Pick a project folder instead of a system or home directory.`
  )
}
