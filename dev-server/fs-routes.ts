import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, type Dirent } from 'fs'
import os from 'os'
import { join, resolve } from 'path'
import type { RouteMount } from './routes'
import { requirePost, withJsonBody } from './http'
import { bodyFlag, bodyNumber, bodyString } from '../src/dev/http-body'
import { resolveFsRequestPath } from '../src/dev/fs-request-path'
import {
  devResolveWithinJail,
  devWorkspaceRoot,
  effectiveByteCap,
  JailEscapeError,
  namedDepth,
  type DevJailOptions,
} from '../src/lib/dev-fs-jail'
import { errorText } from '../src/types/json-guards'

// ── Der Pfad-Käfig: was er vom Prozess braucht ──────────────────────────────
// `src/lib/dev-fs-jail.ts` ist rein (keine node:*-Importe, siehe Dateikopf
// dort), also kommen die beiden Dinge, die nur der Prozess kennt, von hier:
//
//  • `realPath` — der Symlink-Auflöser. OHNE IHN PRÜFT DER KÄFIG NUR
//    LEXIKALISCH, und ein Symlink im Arbeitsordner, der nach draussen zeigt,
//    führt hinaus (am laufenden Dev-Server nachgestellt: `ln -s /etc <ws>/out`,
//    dann `{"path":"out/hosts"}`). Rust löst an derselben Stelle auf:
//    `resolve_existing_prefix` in filesystem.rs.
//  • `systemDrive` — `%SystemDrive%`, damit die Windows-Sperrlisten
//    (`C:\Windows`, `C:\Users`) auf dem richtigen Laufwerk stehen. Rust liest
//    dieselbe Variable.
//
// Alle sechs Türen (fs-read/-write/-list/-search/-info und fs-read-bytes)
// reichen dieses Objekt durch; dass keine es vergisst, hält
// src/dev/__tests__/dev-server-shape.test.ts fest.
const devJail: DevJailOptions = {
  realPath: (p) => realpathSync(p),
  systemDrive: process.env.SystemDrive,
}

/** One grep hit of /local-api/fs-search: a line number and the (clipped) line. */
interface FsSearchMatch {
  line: number
  text: string
}

/** One file of /local-api/fs-search with the matches found in it. */
interface FsSearchHit {
  file: string
  matches: FsSearchMatch[]
}


/**
 * Die sechs Türen auf die Platte — der Pfad-Käfig.
 *
 * Ein Modul, weil sie EINE Zusicherung teilen: kein Pfad aus einem Request
 * verlässt den Arbeitsordner. Sie einzeln zu legen hiesse, sechsmal daran zu
 * denken; hier steht der Käfig einmal darüber.
 */
export function registerFsRoutes(routes: RouteMount): void {
  // API: FS read — im Käfig (siehe src/dev/fs-request-path.ts)
  routes.use('/local-api/fs-read', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      // BEWUSST VOR dem try: ein Ausbruch ist kein Lesefehler. Er fliegt
      // durch bis zu withJsonBody, das JailEscapeError als 403 beantwortet
      // — der catch unten würde daraus eine 200 mit `error` machen.
      const resolved = resolveFsRequestPath(body, os.homedir(), devJail)
      try {
        const content = readFileSync(resolved, 'utf8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ content, encoding: 'utf8' }))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })

  // API: FS read bytes — base64 payload of ONE file for the Explorer image
  // preview (2.6.6 C3). Parity port of the `fs_read_bytes` Tauri command:
  // SAME jail (workspace root, then containment — see lib/dev-fs-jail) and
  // the SAME 16 MiB ceiling, because a preview is a picture on a 280px
  // panel, not a payload. Deliberately stricter than the fs-read
  // middleware above, which predates the jail and stays as it is.
  routes.use('/local-api/fs-read-bytes', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      const fail = (status: number, error: string) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error }))
      }
      try {
        const filePath = bodyString(body, 'path')
        const chatId = bodyString(body, 'chatId')
        const workingDirectory = bodyString(body, 'workingDirectory')
        const maxBytes = bodyNumber(body, 'maxBytes')
        if (typeof filePath !== 'string' || !filePath) {
          fail(400, 'Missing path')
          return
        }
        const resolved = devResolveWithinJail({
          path: filePath,
          homeDir: os.homedir(),
          chatId,
          workingDirectory,
          ...devJail,
        })
        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
          fail(400, `File not found: ${resolved}`)
          return
        }
        const cap = effectiveByteCap(maxBytes)
        const size = statSync(resolved).size
        if (size > cap) {
          fail(400, `File is too large to preview: ${size} bytes (limit ${cap})`)
          return
        }
        const buf = readFileSync(resolved)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ base64: buf.toString('base64'), bytes: buf.length }))
      } catch (err) {
        fail(err instanceof JailEscapeError ? 403 : 400, String(err instanceof Error ? err.message : err))
      }
    })
  })

  // API: FS write — im Käfig (siehe src/dev/fs-request-path.ts)
  routes.use('/local-api/fs-write', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      // VOR dem try, und hier zählt es am meisten: dieser Endpunkt schrieb
      // auf jeden Pfad, den der Prozess öffnen darf. Ausbruch → 403, und
      // zwar bevor irgendein Verzeichnis angelegt wird.
      const resolved = resolveFsRequestPath(body, os.homedir(), devJail)

      // ── KF-12: ein Schreibvorgang ohne Ziel ────────────────────────────
      // KEIN AUSBRUCH — der Pfad liegt im Käfig. Aber eine Anfrage, die keine
      // Datei nennt, löst auf die KÄFIGWURZEL SELBST auf, und `writeFileSync`
      // macht daraus keine Wurzel, sondern eine DATEI. Live ausgelöst mit
      // `POST /local-api/fs-write {}`: 200 `{"status":"saved"}` und ein
      // 0-Byte `~/<AGENT_WORKSPACE_DIR>/default` — eine Datei da, wo der
      // nächste echte Schreibvorgang einen Ordner braucht. Mit
      // `{"workingDirectory":"<noch-nicht-da>","content":"…"}` bestimmt der
      // Aufrufer sogar Ort UND Inhalt dieser Datei.
      //
      // WARUM AUF DEM AUFGELÖSTEN PFAD UND NICHT AUF DEM STRING: dieselbe
      // Lage hat vier Schreibweisen — kein `path`, `""`, `"."` und
      // `"unterordner/.."`. Rusts Textprüfung `is_workspace_root_path`
      // (filesystem.rs:474) kennt die ersten drei und würde die vierte
      // durchlassen. `resolved` liegt bereits im Käfig, also ist gleiche
      // BESTANDTEIL-TIEFE hier dasselbe wie Gleichheit — und `namedDepth`
      // ist der Zähler, den der Käfig ohnehin benutzt (Groß-/Kleinschreibung
      // und Trennzeichen inklusive). Die Wurzel kommt aus derselben
      // `devWorkspaceRoot`-Funktion wie im Käfig, mit denselben Feldern: ein
      // zweiter AUFRUF, keine zweite Regel.
      //
      // 400 UND NICHT 403: 403 heißt in dieser Datei genau eine Sache —
      // `JailEscapeError`, „der Pfad verlässt den Arbeitsordner". Das tut er
      // hier nicht. 400 ist, was die Geschwister für eine Anfrage ohne
      // brauchbare Angabe schon antworten („Missing path" in fs-read-bytes,
      // „Missing pattern" in fs-search).
      //
      // UND NICHT „die Wurzel als Ordner anlegen": das tut der normale Weg
      // bereits. `{"path":"notiz.txt"}` legt über `mkdirSync(parentDir)`
      // unten `~/<AGENT_WORKSPACE_DIR>/default/` als ORDNER an und schreibt
      // die Datei hinein (nachgemessen). Eine Anfrage ohne Datei hätte davon
      // nichts — sie bekäme nur ein stilles zweites Verhalten.
      const wurzel = devWorkspaceRoot(
        os.homedir(),
        bodyString(body, 'chatId'),
        bodyString(body, 'workingDirectory'),
      )
      if (namedDepth(resolved) === namedDepth(wurzel)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: `Missing path: fs-write writes a FILE inside the workspace, but this request names the workspace root itself (${resolved})`,
        }))
        return
      }

      try {
        const content = bodyString(body, 'content') ?? ''
        const parentDir = resolve(resolved, '..')
        if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
        writeFileSync(resolved, content, 'utf8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'saved', path: resolved }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })

  // API: FS list
  routes.use('/local-api/fs-list', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      // VOR dem try: der catch unten antwortet mit 200 und leerer Liste,
      // was einen Ausbruchsversuch als „leeres Verzeichnis" tarnen würde.
      const resolved = resolveFsRequestPath(body, os.homedir(), devJail)
      try {
        const recursive = bodyFlag(body, 'recursive')
        const entries: Array<{ name: string; path: string; size: number; isDir: boolean; modified: number }> = []
        // `recursive` arrived from the caller (file_list passes the model's
        // flag straight through) and was then ignored, so in dev mode a
        // recursive listing silently came back one level deep. Same limits
        // as the Rust command: depth 5, 500 entries.
        const MAX_ENTRIES = 500
        const MAX_DEPTH = 5
        const walk = (dir: string, depth: number): void => {
          let items: Dirent[]
          try {
            items = readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const item of items) {
            if (entries.length >= MAX_ENTRIES) return
            const fullPath = join(dir, item.name)
            try {
              const stat = statSync(fullPath)
              entries.push({ name: item.name, path: fullPath, size: stat.size, isDir: item.isDirectory(), modified: Math.floor(stat.mtimeMs / 1000) })
            } catch { continue }
            if (recursive && item.isDirectory() && depth < MAX_DEPTH) walk(fullPath, depth + 1)
          }
        }
        walk(resolved, 1)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ entries, count: entries.length }))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ entries: [], count: 0, error: String(err) }))
      }
    })
  })

  // API: FS search (grep-like)
  routes.use('/local-api/fs-search', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      // VOR dem try, aus demselben Grund wie bei fs-list: der catch unten
      // antwortet mit 200 und leerer Trefferliste.
      const resolved = resolveFsRequestPath(body, os.homedir(), devJail)
      try {
        const pattern = bodyString(body, 'pattern')
        if (!pattern) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ results: [], count: 0, error: 'Missing pattern' }))
          return
        }
        const re = new RegExp(pattern)
        const results: FsSearchHit[] = []
        const max = bodyNumber(body, 'max_results') ?? 50

        function walkDir(dir: string, depth: number) {
          if (depth > 5 || results.length >= max) return
          try {
            for (const item of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, item.name)
              if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                walkDir(full, depth + 1)
              } else if (item.isFile()) {
                try {
                  const stat = statSync(full)
                  if (stat.size > 1000000) continue
                  const content = readFileSync(full, 'utf8')
                  const matches: FsSearchMatch[] = []
                  content.split('\n').forEach((line: string, i: number) => {
                    if (re.test(line) && matches.length < 10) {
                      matches.push({ line: i + 1, text: line.slice(0, 200) })
                    }
                  })
                  if (matches.length > 0) results.push({ file: full, matches })
                } catch { /* skip binary */ }
              }
            }
          } catch { /* permission denied */ }
        }
        walkDir(resolved, 0)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ results, count: results.length }))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ results: [], count: 0, error: errorText(err) || String(err) }))
      }
    })
  })

  // API: FS info
  routes.use('/local-api/fs-info', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      const resolved = resolveFsRequestPath(body, os.homedir(), devJail)
      try {
        const stat = statSync(resolved)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          path: resolved, size: stat.size, isDir: stat.isDirectory(), isFile: stat.isFile(),
          modified: Math.floor(stat.mtimeMs / 1000), created: Math.floor(stat.birthtimeMs / 1000),
          readonly: false,
        }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })
}


// ENTFERNT: /local-api/file-read und /local-api/file-write.
//
// Die beiden Endpunkte bedienten die AELTEREN Befehle `file_read` /
// `file_write` und hatten zuletzt keinen Aufrufer mehr: die gleichnamigen
// MODELL-WERKZEUGE in src/api/mcp/builtin-tools.ts fuehren ueber
// `fs_read` / `fs_write` aus, und `backendCall('file_read', …)` kam in
// `src/` nirgends mehr vor — auch nicht ueber einen dynamisch gebildeten
// Befehlsnamen.
//
// Damit blieb nur eine DRITTE Pfadregel neben den beiden anderen: Wurzel
// `~/<AGENT_WORKSPACE_DIR>` OHNE Chat-Slug, `filePath.includes('..')`
// statt des Kaefigs, absolute Pfade von `join()` stillschweigend
// eingefaltet. Die Rust-Befehle gehen an derselben Stelle ueber
// `resolve_agent_path` in den PER-CHAT-Sandkasten — der Dev-Server wich
// also ab, ohne dass jemand den Unterschied je benutzte.
//
// Die Rust-Befehle in src-tauri/src/commands/agent.rs BLEIBEN: die
// Remote-Bruecke `/remote-api/agent-tool` benutzt sie. Nur diese beiden
// Dev-Endpunkte und ihre zwei Registry-Zeilen in src/api/backend.ts sind
// weg. Der Weg auf die Platte fuehrt hier ueber /local-api/fs-read und
// /local-api/fs-write (Kaefig: src/dev/fs-request-path.ts).
