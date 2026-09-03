import http from 'http'
import type { RouteMount } from './routes'
import { ssrfDeps } from './ssrf'
import { SsrfBlockedError, ssrfSafeGet, SSRF_MAX_HOPS } from '../src/dev/ssrf-fetch'
import { errorText } from '../src/types/json-guards'

/**
 * Die drei Endpunkte, die fremde Bytes durchreichen: der ComfyUI-POST-Proxy
 * und die beiden SSRF-geschützten Proxies für `?url=`. Zusammen, weil sie
 * dieselbe Aufgabe haben (eine Antwort unverändert weitergeben) und dieselbe
 * Fehlerquelle (eine Antwort dabei kaputtmachen).
 */
export function registerProxyRoutes(routes: RouteMount): void {
  // API: ComfyUI POST proxy (workaround for Vite 8 blocking POST via proxy).
  // David 2026-06-16 — konata's "Failed to upload image: HTTP 400" (web build
  // via SSH-tunneled `npm run dev`) reproduced HERE: this proxy used to buffer
  // the body as a STRING (`body += chunk` corrupts binary image bytes) and
  // HARDCODE Content-Type: application/json (strips the multipart/form-data
  // boundary). JSON POSTs (submit/history) survived; the I2V image upload
  // (/upload/image, multipart) reached ComfyUI as garbage → 400. Fix: buffer
  // the raw bytes intact and forward the REAL Content-Type (with its boundary)
  // + Content-Length, so multipart uploads pass through unchanged.
  routes.use('/comfyui', (req, res, next) => {
    if (req.method !== 'POST') return next()
    const targetPath = (req.url || '').replace(/^\/comfyui/, '') || '/'
    const inChunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { inChunks.push(chunk) })
    req.on('end', () => {
      const body = Buffer.concat(inChunks)
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: 8188,
        path: targetPath,
        method: 'POST',
        headers: {
          'Content-Type': (req.headers['content-type'] as string) || 'application/json',
          'Content-Length': body.length,
        },
      }, (proxyRes) => {
        const chunks: Buffer[] = []
        proxyRes.on('data', (c: Buffer) => chunks.push(c))
        proxyRes.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString()
          res.writeHead(proxyRes.statusCode || 500, {
            'Content-Type': proxyRes.headers['content-type'] || 'application/json',
          })
          res.end(responseBody)
        })
      })
      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      })
      proxyReq.write(body)
      proxyReq.end()
    })
  })

  // API: Privacy image proxy — prevents external servers from tracking users
  routes.use('/local-api/proxy-image', (req, res) => {
    const imgUrl = new URL(req.url || '', 'http://localhost').searchParams.get('url')
    if (!imgUrl) { res.writeHead(400); res.end(); return }
    const deny = () => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'blocked by SSRF guard' })) }
    // Wächter auf JEDEM Sprung, Verbindung auf der geprüften Adresse: beides
    // in `ssrfSafeGet` (src/dev/ssrf-fetch.ts), damit es nicht in drei
    // Kopien nebeneinander steht. Hier stand vorher eine von Hand
    // ausgeschriebene Kette, die GENAU EINEN Sprung weit prüfte — der zweite
    // hätte auf 169.254.169.254 zeigen dürfen.
    ssrfSafeGet(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, ssrfDeps)
      .then(({ response }) => {
        res.writeHead(response.statusCode || 200, {
          'Content-Type': response.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        })
        response.pipe(res)
      })
      // 403 nur für eine Sperre, 502 für „nicht erreichbar" — vorher machte
      // dasselbe `.catch(deny)` aus einem toten Bildserver eine
      // Sicherheitsmeldung.
      .catch((err) => {
        if (err instanceof SsrfBlockedError) { deny(); return }
        res.writeHead(502); res.end()
      })
  })

  // API: Proxy download (follows redirects server-side, avoids CORS)
  routes.use('/local-api/proxy-download', (req, res) => {
    const url = new URL(req.url || '', 'http://localhost').searchParams.get('url')
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing url parameter' }))
      return
    }

    // Wächter + Pin + Kette: dieselbe Schleife wie bei proxy-image, siehe
    // src/dev/ssrf-fetch.ts. Die Handschleife, die hier stand, prüfte zwar
    // jeden Sprung, liess aber den Namen beim Verbinden ein zweites Mal
    // auflösen — das Rebind-Fenster.
    ssrfSafeGet(url, { headers: { 'User-Agent': 'LocallyUncensored/1.0' }, maxHops: SSRF_MAX_HOPS }, ssrfDeps)
      .then(({ response }) => {
        // BEFUND, ÄLTER ALS DIESER COMMIT: hier stand
        // `'Content-Length': response.headers['content-length'] || ''`.
        // Antwortet die Gegenstelle chunked (also ohne Content-Length —
        // example.com, jedes Cloudflare-Ziel, jeder Stream), ging ein
        // LEERER Header hinaus, und der Client bricht mit „Parse Error:
        // Empty Content-Length" ab: der Endpunkt lieferte für solche Ziele
        // eine kaputte Antwort mit null Bytes. Nachgemessen am laufenden
        // Dev-Server. Der Header gehört nur gesetzt, wenn es ihn gibt.
        const headers: Record<string, string> = {
          'Content-Type': String(response.headers['content-type'] || 'application/octet-stream'),
        }
        const len = response.headers['content-length']
        if (typeof len === 'string' && len !== '') headers['Content-Length'] = len
        res.writeHead(response.statusCode || 200, headers)
        response.pipe(res)
      })
      .catch((err) => {
        if (err instanceof SsrfBlockedError) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'blocked by SSRF guard' }))
          return
        }
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: errorText(err) || String(err) }))
      })
  })
}
