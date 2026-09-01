/**
 * Der Käfig-Eingang der fünf `/local-api/fs-*`-Endpunkte.
 *
 * WARUM DIESE DATEI: `fs-read`, `fs-write`, `fs-list`, `fs-search` und
 * `fs-info` haben den Pfad aus dem Request bis zu diesem Commit GAR NICHT
 * geprüft. Jeder von ihnen stand als
 *
 *     isAbsolute(p) ? p : join(os.homedir(), AGENT_WORKSPACE_DIR, p)
 *
 * da — ein absoluter Pfad wurde also wörtlich übernommen (`/etc/passwd`), und
 * ein relativer durfte mit `../../` aus dem Arbeitsordner klettern. `fs-write`
 * schrieb auf diesem Weg auf jeden Pfad, den der Prozess öffnen darf. Im
 * gepackten Build geht dieselbe Operation durch `resolve_path` in
 * `src-tauri/src/commands/filesystem.rs` und wird dort abgelehnt; der
 * Dev-Server war die schwächere Tür in dieselbe Operation.
 *
 * Der Käfig selbst wird hier NICHT neu gebaut — er liegt seit dem
 * `fs-read-bytes`-Port in `src/lib/dev-fs-jail.ts` und ist die Übersetzung von
 * `workspace_root` + `contain_within`. Diese Datei ist nur der eine Eingang:
 * sie liest die drei Felder, die der Käfig braucht, aus dem Request-Körper,
 * damit kein Endpunkt eines davon vergessen kann.
 *
 * DIE FELDNAMEN SIND ABSICHTLICH GENAU DIE DER TAURI-BEFEHLE. `filesystem.rs`
 * deklariert `chatId` und `workingDirectory` (camelCase, `#[allow(
 * non_snake_case)]`) und kennt keine Alternativschreibweise. Eine zusätzliche
 * `working_directory`-Schreibweise hier wäre ein zweiter Weg, die Käfigwurzel
 * zu setzen, den es auf der Rust-Seite nicht gibt — also wieder eine
 * schwächere Tür.
 *
 * REIN WIE ALLES UNTER src/dev: kein `node:*`-Import. `homeDir` kommt vom
 * Aufrufer (`os.homedir()` in vite.config.ts), damit der Test die Wurzel
 * setzen kann, ohne das echte Heimatverzeichnis zu treffen.
 */

import { devResolveWithinJail } from '../lib/dev-fs-jail'
import { bodyString } from './http-body'

/**
 * Der Pfad EINES `/local-api/fs-*`-Requests, aufgelöst und im Käfig — oder ein
 * geworfener `JailEscapeError`, den `withJsonBody` in vite.config.ts als 403
 * beantwortet.
 *
 * Ein fehlendes `path` wird zu `''` und löst damit auf die Käfigwurzel selbst
 * auf, genau wie `resolve_path("")` auf der Rust-Seite: die Endpunkte haben
 * ihre eigene Meldung für „nichts angegeben", und der Käfig ist nicht der Ort,
 * an dem sie erfunden wird.
 */
export function resolveFsRequestPath(body: unknown, homeDir: string): string {
  return devResolveWithinJail({
    path: bodyString(body, 'path') ?? '',
    homeDir,
    chatId: bodyString(body, 'chatId'),
    workingDirectory: bodyString(body, 'workingDirectory'),
  })
}
