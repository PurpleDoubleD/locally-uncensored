import https from 'https'
import http from 'http'
import os from 'os'
import { existsSync, createWriteStream, mkdirSync, readFileSync, statSync } from 'fs'
import { join, basename, dirname } from 'path'
import type { RouteMount } from './routes'
import { findComfyUI } from './comfy'
import { assertPublicUrl, ssrfDeps } from './ssrf'
import { requirePost, withJsonBody, failRequest } from './http'
import { createPinnedLookup } from '../src/dev/ssrf-fetch'
import { bodyNumber, bodyRecords, bodyString, parseJsonBody } from '../src/dev/http-body'
import { comfyDestPath, downloadToPathDest, modelDirCandidates } from '../src/dev/model-paths'
import { APP_CONFIG_DIR } from '../src/lib/app-identity'
import { asNumber, asString, errorText, prop } from '../src/types/json-guards'

interface DownloadState {
  progress: number
  total: number
  speed: number
  filename: string
  status: 'connecting' | 'downloading' | 'paused' | 'complete' | 'error'
  error?: string
}

/**
 * Der Download-Manager: eine Karte laufender Downloads und die acht Endpunkte,
 * die sie lesen und schreiben. Zusammen, weil `activeDownloads` der einzige
 * Zustand ist, den sie teilen — und weil ihn niemand sonst anfassen darf.
 */
export function registerDownloadRoutes(routes: RouteMount): void {
  // ─── Model Download Manager ───
  const activeDownloads = new Map<string, DownloadState>()

  function downloadFile(url: string, destPath: string, id: string): Promise<void> {
    return new Promise((promiseResolve, promiseReject) => {
      const filename = basename(destPath)
      activeDownloads.set(id, { progress: 0, total: 0, speed: 0, filename, status: 'connecting' })

      /** Abbruch mit sichtbarem Status — der Fortschritts-Endpunkt liest activeDownloads. */
      const failDownload = (err: unknown) => {
        const error = err instanceof Error ? err : new Error(errorText(err) || String(err))
        const current = activeDownloads.get(id)
        activeDownloads.set(id, {
          progress: current?.progress ?? 0,
          total: current?.total ?? 0,
          speed: 0,
          filename,
          status: 'error',
          error: error.message,
        })
        promiseReject(error)
      }

      const doRequest = async (requestUrl: string, redirectCount = 0) => {
        if (redirectCount > 5) { failDownload(new Error('Too many redirects')); return }

        // SSRF-WÄCHTER, GLEICHE GRENZE WIE RUST.
        //
        // `downloadFile` holte bis zu diesem Commit jede URL, die der
        // Aufrufer angab, und schrieb die Antwort auf die Platte —
        // `http://169.254.169.254/latest/meta-data/` eingeschlossen, zwei
        // Bildschirmseiten unter den Proxies, die genau dagegen geschützt
        // sind. Im gepackten Build geht dieselbe Operation durch
        // `download.rs::download_with_progress`, und die Zeile dort ist
        // `proxy::validate_public_url(url)?` — dieselbe Liste, die
        // `assertPublicUrl` hier abbildet. Kein LAN-Sonderfall: die
        // Rust-Seite hat auch keinen (proxy.rs sperrt 192.168.1.50
        // nachweislich), und ein Sonderfall NUR im Dev-Server wäre wieder
        // die schwächere Tür.
        //
        // JEDER HOP, nicht nur der erste: eine öffentliche URL, die auf
        // 169.254.169.254 weiterleitet, ist der klassische Bypass. Rust
        // benutzt dafür `ssrf_safe_redirect_policy`; hier läuft jede
        // Weiterleitung ohnehin erneut durch diese Funktion.
        //
        // UND AUF DIE GEPRÜFTE ADRESSE, nicht noch einmal auf den Namen:
        // `assertPublicUrl` gibt die freigegebenen Adressen zurück, und
        // `pinned` nagelt die Verbindung darauf fest. Ohne das läge zwischen
        // Prüfung und `proto.get` ein zweites DNS und damit das
        // Rebind-Fenster (Rust: `pinned_client`, proxy.rs:290).
        let pinned: ReturnType<typeof createPinnedLookup>
        try {
          const target = await assertPublicUrl(requestUrl)
          pinned = createPinnedLookup(target.addresses, ssrfDeps.ipFamily)
        } catch (err) {
          failDownload(err)
          return
        }

        // Resume support (issue #51, adhney): if a partial file exists, ask
        // the server for the remaining bytes via Range instead of restarting
        // from 0. Packaged mode (download.rs) already does this; this is the
        // dev-server parity.
        let existingSize = 0
        const headers: Record<string, string> = { 'User-Agent': 'LocallyUncensored/1.1' }
        if (existsSync(destPath)) {
          try {
            existingSize = statSync(destPath).size
            if (existingSize > 0) headers['Range'] = `bytes=${existingSize}-`
          } catch { /* ignore — fall back to a full download */ }
        }

        const proto = requestUrl.startsWith('https') ? https : http
        proto.get(requestUrl, { headers, lookup: pinned }, (response) => {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            // `Location` darf relativ sein (RFC 7231). Vorher ging der
            // rohe Wert zurück in `doRequest`, wo `startsWith('https')`
            // ihn als http las und `http.get('/pfad')` scheiterte; gegen
            // die aktuelle URL aufgelöst ist er eine echte URL, die der
            // Wächter oben lesen kann.
            let next: string
            try {
              next = new URL(response.headers.location, requestUrl).toString()
            } catch {
              failDownload(new Error(`Invalid redirect target: ${response.headers.location}`))
              return
            }
            void doRequest(next, redirectCount + 1).catch(failDownload)
            return
          }
          const isPartial = response.statusCode === 206
          if (response.statusCode !== 200 && !isPartial) {
            activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: `HTTP ${response.statusCode}` })
            promiseReject(new Error(`HTTP ${response.statusCode}`))
            return
          }

          const contentLength = parseInt(response.headers['content-length'] || '0', 10)
          const total = isPartial ? contentLength + existingSize : contentLength
          let downloaded = isPartial ? existingSize : 0
          let lastTime = Date.now()
          let lastBytes = downloaded

          const dir = dirname(destPath)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          const file = createWriteStream(destPath, { flags: isPartial ? 'a' : 'w' })

          activeDownloads.set(id, { progress: downloaded, total, speed: 0, filename, status: 'downloading' })

          response.on('data', (chunk: Buffer) => {
            downloaded += chunk.length
            const now = Date.now()
            const dt = (now - lastTime) / 1000
            if (dt >= 1) {
              const speed = (downloaded - lastBytes) / dt
              lastTime = now
              lastBytes = downloaded
              activeDownloads.set(id, { progress: downloaded, total, speed, filename, status: 'downloading' })
            }
          })

          response.pipe(file)
          file.on('finish', () => {
            file.close()
            activeDownloads.set(id, { progress: total || downloaded, total: total || downloaded, speed: 0, filename, status: 'complete' })
            console.log(`[Download] Complete: ${filename}`)
            promiseResolve()
          })
          file.on('error', (err) => {
            activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: err.message })
            promiseReject(err)
          })
        }).on('error', (err) => {
          activeDownloads.set(id, { ...activeDownloads.get(id)!, status: 'error', error: err.message })
          promiseReject(err)
        })
      }
      // `doRequest` ist async und meldet jeden Abbruch selbst über
      // `failDownload`; der Wurf hier wäre sonst ein unbehandeltes Promise.
      void doRequest(url).catch(failDownload)
    })
  }

  // API: Start a model download
  routes.use('/local-api/download-model', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const url = bodyString(body, 'url')
        const subfolder = bodyString(body, 'subfolder')
        const filename = bodyString(body, 'filename')
        const expectedBytes = bodyNumber(body, 'expectedBytes')
        if (!url || !subfolder || !filename) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing url, subfolder, or filename' }))
          return
        }
        const comfyPath = findComfyUI()
        if (!comfyPath) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'ComfyUI not found' }))
          return
        }
        // SICHERHEITSBEFUND: `subfolder`/`filename` gingen ungeprüft in
        // `join(comfyPath, 'models', …)` und dann in einen echten Schreibvorgang.
        // Der Käfig liegt jetzt in src/dev/model-paths.ts; ein Ausbruch wirft
        // JailEscapeError und wird unten als 403 beantwortet.
        const destPath = comfyDestPath(comfyPath, subfolder, filename, 'separator')
        const destDir = dirname(destPath)

        if (existsSync(destPath)) {
          // Validate file size if expectedBytes provided (catch partial downloads)
          let fileComplete = true
          if (expectedBytes && expectedBytes > 0) {
            try {
              const actual = statSync(destPath).size
              const threshold = expectedBytes * 0.9
              fileComplete = actual >= threshold
              if (!fileComplete) {
                console.log(`[Download] File ${filename} is incomplete: ${actual} bytes vs ${expectedBytes} expected (${Math.round(actual / expectedBytes * 100)}%)`)
              }
            } catch { fileComplete = true }
          }
          if (fileComplete) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'exists', id: filename }))
            return
          }
          // Fall through to re-download incomplete file
        }

        const id = filename
        // Don't restart an in-flight download from 0 if the UI re-fires the
        // start (issue #51, adhney).
        const active = activeDownloads.get(id)
        if (active && (active.status === 'downloading' || active.status === 'connecting')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'started', id }))
          return
        }
        console.log(`[Download] Starting: ${filename} → ${destDir}`)
        downloadFile(url, destPath, id).catch(err => console.error(`[Download] Failed: ${errorText(err)}`))

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'started', id }))
      } catch (err) {
        failRequest(res, err)
      }
    })
  })

  // API: Download progress
  routes.use('/local-api/download-progress', (_req, res) => {
    const downloads: Record<string, DownloadState> = {}
    for (const [id, info] of activeDownloads.entries()) {
      downloads[id] = info
      if (info.status === 'complete' || info.status === 'error') {
        setTimeout(() => activeDownloads.delete(id), 30000)
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(downloads))
  })

  // API: Detect model path for non-Ollama providers (LM Studio, etc.)
  routes.use('/local-api/detect-model-path', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const home = os.homedir()
        // Which backend was asked about used to be read and then thrown
        // away: every provider got LM Studio's directory back, including
        // Ollama and the built-in engine. The dispatch (a mirror of
        // src-tauri/src/commands/download.rs detect_model_path) now lives in
        // src/dev/model-paths.ts next to its test; everything it does not
        // know falls through to the LU fallback dir below, as there.
        const candidates = modelDirCandidates(bodyString(body, 'provider') ?? '')
          .map((segments) => join(home, ...segments))
        const found = candidates.find((p) => existsSync(p))
        if (found) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(found))
        } else {
          // Fallback: create LU models directory (same as Rust backend)
          const fallback = join(home, APP_CONFIG_DIR, 'models')
          try { mkdirSync(fallback, { recursive: true }) } catch { /* der Ordner ist Kuer — der Pfad geht ohnehin zurueck */ }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(fallback))
        }
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(null))
      }
    })
  })

  // API: Check model file sizes (for partial download detection)
  routes.use('/local-api/check-model-sizes', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const home = os.homedir()
        // Prefer the ComfyUI path the app actually persisted (matches the
        // Rust backend); only then fall back to common defaults. Without
        // this the dev stub guessed wrong for non-default installs and
        // reported every curated model "incomplete" → "no image model"
        // (konata-session 2026-06-07).
        let comfyPath = ''
        try {
          const cfgPath = join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_CONFIG_DIR, 'config.json')
          if (existsSync(cfgPath)) {
            const cfg = parseJsonBody(readFileSync(cfgPath, 'utf8'))
            const persisted = cfg.ok ? asString(prop(cfg.value, 'comfyui_path')) : undefined
            if (persisted && existsSync(persisted)) comfyPath = persisted
          }
        } catch { /* ignore — fall through to candidates */ }
        if (!comfyPath) {
          const candidates = [
            join(home, 'ComfyUI'),
            join(home, 'Desktop', 'ComfyUI'),
            'C:\\ComfyUI',
          ]
          comfyPath = candidates.find(p => existsSync(p)) || join(home, 'ComfyUI')
        }
        const results = bodyRecords(body, 'files').map((f) => {
          const filename = asString(f.filename) ?? ''
          const subfolder = asString(f.subfolder) ?? ''
          const expectedBytes = asNumber(f.expectedBytes) ?? 0
          // SICHERHEITSBEFUND: `subfolder`/`filename` gingen ungeprüft in
          // `join(comfyPath, …)`. Ein Ausbruch beantwortet der Eintrag jetzt
          // mit `exists: false`, statt fremde Dateien abzutasten.
          let filePath: string
          try {
            filePath = comfyDestPath(comfyPath, subfolder, filename, 'prefix')
          } catch {
            return { filename, exists: false, actualBytes: 0, complete: false }
          }
          if (existsSync(filePath)) {
            const actual = statSync(filePath).size
            const threshold = expectedBytes > 0 ? expectedBytes * 0.9 : 0
            return { filename, exists: true, actualBytes: actual, complete: expectedBytes === 0 || actual >= threshold }
          }
          return { filename, exists: false, actualBytes: 0, complete: false }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(results))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: errorText(err) || String(err) }))
      }
    })
  })

  // API: Download model to a specific path (for HuggingFace GGUF → LM Studio etc.)
  routes.use('/local-api/download-model-to-path', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const url = bodyString(body, 'url')
        const destDir = bodyString(body, 'destDir', 'dest_dir')
        const filename = bodyString(body, 'filename')
        if (!url || !destDir || !filename) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing url, destDir, or filename' }))
          return
        }
        const expectedBytes = bodyNumber(body, 'expectedBytes')
        // `destDir` ist hier absichtlich frei (das ist der Zweck des
        // Endpunkts: neben eine fremde Installation legen). `filename` ist
        // es nicht mehr — ein `../` darin wird jetzt abgelehnt.
        const destPath = downloadToPathDest(destDir, filename)
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
        if (existsSync(destPath)) {
          let fileComplete = true
          if (expectedBytes && expectedBytes > 0) {
            try {
              const actual = statSync(destPath).size
              fileComplete = actual >= expectedBytes * 0.9
              if (!fileComplete) console.log(`[Download] ${filename} incomplete: ${actual} vs ${expectedBytes} expected`)
            } catch { fileComplete = true }
          }
          if (fileComplete) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'exists', id: filename }))
            return
          }
        }
        const id = filename
        const active = activeDownloads.get(id)
        if (active && (active.status === 'downloading' || active.status === 'connecting')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'started', id }))
          return
        }
        console.log(`[Download] Starting to path: ${filename} → ${destDir}`)
        downloadFile(url, destPath, id).catch(err => console.error(`[Download] Failed: ${errorText(err)}`))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'started', id }))
      } catch (err) {
        failRequest(res, err)
      }
    })
  })

  // API: Pause download (dev mode stub — sets status to paused)
  routes.use('/local-api/pause-download', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      const id = bodyString(body, 'id')
      const dl = id ? activeDownloads.get(id) : undefined
      if (dl) dl.status = 'paused'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'paused' }))
    })
  })

  // API: Cancel download (dev mode stub — removes from map)
  routes.use('/local-api/cancel-download', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      const id = bodyString(body, 'id')
      if (id) activeDownloads.delete(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'cancelled' }))
    })
  })

  // API: Resume download (dev mode stub — restarts download)
  routes.use('/local-api/resume-download', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      const id = bodyString(body, 'id')
      const url = bodyString(body, 'url')
      const subfolder = bodyString(body, 'subfolder')
      if (id && url && subfolder) {
        const comfyPath = findComfyUI()
        if (comfyPath) {
          // SICHERHEITSBEFUND, wie bei /download-model: `subfolder` und `id`
          // bauten den Zielpfad ungeprüft zusammen. `comfyDestPath` wirft
          // statt zu schreiben — withJsonBody macht daraus ein 403.
          const destPath = comfyDestPath(comfyPath, subfolder, id, 'never')
          downloadFile(url, destPath, id).catch(err => console.error(`[Download] Resume failed: ${errorText(err)}`))
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'resuming' }))
    })
  })
}
